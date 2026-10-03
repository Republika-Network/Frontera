import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { GovernanceRecord } from '../governance-store/contracts.js';
import {
  EVIDENCE_STORE_LIST_LIMIT,
  EVIDENCE_STORE_SCHEMA_VERSION,
  buildEvidenceBundle,
  createInMemoryEvidenceStore,
  createSqliteEvidenceStore,
  evidenceBundleRowDigest,
  getDisclosurePolicy,
  type EvidenceBundle,
  type EvidenceStore,
} from '../evidence/index.js';

/**
 * ASSURE-01 — the durable Evidence Bundle Store: restart persistence, no
 * overwrite, immutable content, forward-only lifecycle, tenant scoping,
 * bounded reads, schema guard, integrity verification on read, concurrency,
 * close/health. The in-memory provider is held to the same lifecycle contract.
 */

const historical = JSON.parse(readFileSync('src/enterprise/__tests__/fixtures/pre-assure-01/v1-bundles.json', 'utf8')) as { record: GovernanceRecord };
const ORG = 'org-historical';
const ORG_SCOPE = { system: false, organizationId: ORG } as const;
const OTHER_SCOPE = { system: false, organizationId: 'org-other' } as const;

const directories: string[] = [];
const stores: EvidenceStore[] = [];
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function dir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-assure01-store-'));
  directories.push(directory);
  return directory;
}

let counter = 0;
function bundle(level = 'AUDITOR', record: GovernanceRecord = historical.record): EvidenceBundle {
  counter += 1;
  return buildEvidenceBundle(record, getDisclosurePolicy(level), { now: () => '2026-10-03T00:00:00.000Z', nextId: () => `evidence-bundle-store-${counter}` });
}

async function open(path: string) {
  const store = await createSqliteEvidenceStore(path, { now: () => new Date().toISOString() });
  stores.push(store);
  return store;
}

function withDb<T>(path: string, run: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe('ASSURE-01 durable Evidence Bundle Store', () => {
  it('a stored bundle survives a reopen byte for byte, with its lifecycle', async () => {
    const path = join(dir(), 'evidence-bundles.sqlite');
    const first = await open(path);
    const stored = bundle();
    await first.store(stored, { organizationId: ORG });
    await first.markVerified(stored.bundleId);
    await first.close();
    const second = await open(path);
    const read = await second.getByBundleId(ORG_SCOPE, stored.bundleId);
    assert.deepEqual(read?.bundle, stored);
    assert.equal(read?.state, 'VERIFIED');
    assert.equal((await second.verifyAll()).bundles, 1);
  });

  it('never overwrites: the same bundle id is refused, the first stands', async () => {
    const store = await open(join(dir(), 'e.sqlite'));
    const stored = bundle();
    await store.store(stored, { organizationId: ORG });
    await assert.rejects(store.store(stored, { organizationId: ORG }), { code: 'EVIDENCE_BUNDLE_ALREADY_EXISTS' });
    const forged = { ...stored, createdAt: '2027-01-01T00:00:00.000Z' };
    await assert.rejects(store.store(forged, { organizationId: ORG }), { code: 'EVIDENCE_VALIDATION_ERROR' }, 'a bundle that does not match its own digest is never stored');
  });

  it('two connections racing to store the same id: exactly one wins', async () => {
    const path = join(dir(), 'e.sqlite');
    const [a, b] = [await open(path), await open(path)];
    const stored = bundle();
    const results = await Promise.allSettled([a.store(stored, { organizationId: ORG }), b.store(stored, { organizationId: ORG })]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await a.listByEvaluationId(ORG_SCOPE, stored.source.evaluationId)).length, 1);
  });

  it('content is immutable: SQL refuses an update or delete; a rewrite behind dropped triggers is refused on read, never repaired', async () => {
    const path = join(dir(), 'e.sqlite');
    const store = await open(path);
    const stored = bundle();
    await store.store(stored, { organizationId: ORG });
    withDb(path, (db) => {
      assert.throws(() => db.prepare(`UPDATE evidence_bundles SET bundle_json = '{}'`).run(), /immutable/);
      assert.throws(() => db.prepare(`DELETE FROM evidence_bundles`).run(), /never deleted/);
      assert.throws(() => db.prepare(`UPDATE evidence_bundles SET organization_id = 'org-other'`).run(), /immutable/);
    });
    withDb(path, (db) => {
      db.exec('DROP TRIGGER evidence_bundles_content_immutable');
      const tampered = JSON.stringify({ ...stored, evidence: { ...stored.evidence, status: 'denied' } });
      db.prepare('UPDATE evidence_bundles SET bundle_json = ?').run(tampered);
    });
    await assert.rejects(store.getByBundleId(ORG_SCOPE, stored.bundleId), (error: { code?: string; details?: { check?: string } }) => error.code === 'EVIDENCE_STORE_CORRUPT' && error.details?.check === 'row-digest');
    await assert.rejects(store.verifyAll(), { code: 'EVIDENCE_STORE_CORRUPT' });
  });

  it('the row digest and the bundle’s own digest are both checked: re-sealing one is not enough', async () => {
    const path = join(dir(), 'e.sqlite');
    const store = await open(path);
    const stored = bundle();
    await store.store(stored, { organizationId: ORG });
    withDb(path, (db) => {
      db.exec('DROP TRIGGER evidence_bundles_content_immutable');
      db.prepare('UPDATE evidence_bundles SET organization_id = ?').run('org-other');
    });
    await assert.rejects(store.getByBundleId({ system: true }, stored.bundleId), { code: 'EVIDENCE_STORE_CORRUPT' }, 'moving a bundle to another tenant breaks its row digest');
  });

  it('a rewritten bundle whose row digest is re-sealed still fails the bundle’s own digest', async () => {
    const path = join(dir(), 'e.sqlite');
    const store = await open(path);
    const stored = bundle();
    await store.store(stored, { organizationId: ORG });
    withDb(path, (db) => {
      db.exec('DROP TRIGGER evidence_bundles_content_immutable');
      const row = db.prepare('SELECT * FROM evidence_bundles').get() as Record<string, string | null>;
      const tamperedJson = JSON.stringify({ ...stored, evidence: { ...stored.evidence, status: 'denied' } });
      const rowDigest = evidenceBundleRowDigest({
        bundleId: String(row['bundle_id']),
        organizationId: row['organization_id'] ?? null,
        evaluationId: String(row['evaluation_id']),
        decisionId: String(row['decision_id']),
        requestId: String(row['request_id']),
        bundleVersion: String(row['bundle_version']),
        bundleJson: tamperedJson,
        bundleDigest: String(row['bundle_digest']),
        storedAt: String(row['stored_at']),
      });
      db.prepare('UPDATE evidence_bundles SET bundle_json = ?, row_digest = ?').run(tamperedJson, rowDigest);
    });
    await assert.rejects(store.getByBundleId(ORG_SCOPE, stored.bundleId), (error: { code?: string; details?: { check?: string } }) => error.code === 'EVIDENCE_STORE_CORRUPT' && error.details?.check === 'bundle-digest');
  });

  it('the lifecycle moves forward only; SUPERSEDED is terminal; supersession never touches the old bundle’s content', async () => {
    const path = join(dir(), 'e.sqlite');
    const store = await open(path);
    const older = bundle();
    const newer = bundle();
    await store.store(older, { organizationId: ORG });
    assert.equal((await store.markExported(older.bundleId)).state, 'EXPORTED');
    assert.equal((await store.markVerified(older.bundleId)).state, 'EXPORTED', 'backwards is a no-op');
    await store.store(newer, { organizationId: ORG, supersedes: [older.bundleId] });
    const superseded = await store.getByBundleId(ORG_SCOPE, older.bundleId);
    assert.equal(superseded?.state, 'SUPERSEDED');
    assert.equal(superseded?.supersededBy, newer.bundleId);
    assert.deepEqual(superseded?.bundle, older, 'not one byte of the superseded bundle changed');
    assert.equal((await store.markVerified(older.bundleId)).state, 'SUPERSEDED', 'terminal');
    assert.equal((await store.supersede(older.bundleId, older.bundleId)).supersededBy, newer.bundleId, 'the first supersession stands');
    withDb(path, (db) => assert.throws(() => db.prepare(`UPDATE evidence_bundles SET state = 'GENERATED', superseded_by = NULL WHERE bundle_id = ?`).run(older.bundleId), /forward only/));
    withDb(path, (db) => {
      db.exec('DROP TRIGGER evidence_bundles_lifecycle_forward_only');
      db.prepare(`UPDATE evidence_bundles SET state = 'VERIFIED', superseded_by = NULL WHERE bundle_id = ?`).run(older.bundleId);
    });
    await assert.rejects(store.getByBundleId(ORG_SCOPE, older.bundleId), (error: { code?: string; details?: { check?: string } }) => error.code === 'EVIDENCE_STORE_CORRUPT' && error.details?.check === 'lifecycle-log', 'a lifecycle rolled back behind the triggers disagrees with its own log');
  });

  it('two builds racing for the same request and policy leave exactly one active bundle', async () => {
    const path = join(dir(), 'e.sqlite');
    const [a, b] = [await open(path), await open(path)];
    const first = bundle();
    const second = bundle();
    await Promise.all([a.store(first, { organizationId: ORG, supersedeActive: true }), b.store(second, { organizationId: ORG, supersedeActive: true })]);
    const active = (await a.listByRequestId(ORG_SCOPE, first.source.requestId)).filter((record) => record.state !== 'SUPERSEDED');
    assert.deepEqual(active.map((record) => record.bundle.bundleId), [second.bundleId], 'the later store superseded the earlier inside its own transaction');
    const memory = createInMemoryEvidenceStore();
    const m1 = bundle();
    const m2 = bundle();
    await memory.store(m1, { organizationId: ORG, supersedeActive: true });
    await memory.store(m2, { organizationId: ORG, supersedeActive: true });
    assert.equal((await memory.getByBundleId(ORG_SCOPE, m1.bundleId))?.state, 'SUPERSEDED');
  });

  it('a bundle may only supersede one of the same organization and request', async () => {
    const store = await open(join(dir(), 'e.sqlite'));
    const foreign = bundle();
    await store.store(foreign, { organizationId: 'org-other' });
    await assert.rejects(store.store(bundle(), { organizationId: ORG, supersedes: [foreign.bundleId] }), { code: 'EVIDENCE_ACCESS_SCOPE_VIOLATION' });
    assert.equal((await store.getByBundleId({ system: true }, foreign.bundleId))?.state, 'GENERATED', 'the refused store changed nothing');
  });

  it('tenant scope comes from the owning organization, not from what the bundle discloses', async () => {
    const store = await open(join(dir(), 'e.sqlite'));
    const hidden = bundle('PUBLIC');
    assert.equal(hidden.source.organizationId, undefined, 'PUBLIC hides the organization');
    await store.store(hidden, { organizationId: ORG });
    assert.ok((await store.getByBundleId(ORG_SCOPE, hidden.bundleId)) !== null, 'its own organization reads it');
    assert.equal(await store.getByBundleId(OTHER_SCOPE, hidden.bundleId), null);
    assert.deepEqual(await store.listByRequestId(OTHER_SCOPE, hidden.source.requestId), []);
    await assert.rejects(store.getByBundleId({ system: false }, hidden.bundleId), { code: 'EVIDENCE_TENANT_SCOPE_REQUIRED' });
  });

  it(`every list is bounded to the newest ${EVIDENCE_STORE_LIST_LIMIT}`, async () => {
    const store = await open(join(dir(), 'e.sqlite'));
    const ids: string[] = [];
    for (let index = 0; index < EVIDENCE_STORE_LIST_LIMIT + 5; index += 1) {
      const next = bundle();
      ids.push(next.bundleId);
      await store.store(next, { organizationId: ORG });
    }
    const listed = await store.listByEvaluationId(ORG_SCOPE, historical.record.evaluation.evaluationId);
    assert.equal(listed.length, EVIDENCE_STORE_LIST_LIMIT);
    assert.deepEqual(listed.map((record) => record.bundle.bundleId), ids.slice(-EVIDENCE_STORE_LIST_LIMIT));
    assert.equal((await store.listByRequestId(ORG_SCOPE, historical.record.request.requestId)).length, EVIDENCE_STORE_LIST_LIMIT);
    assert.equal((await store.listByDecisionId(ORG_SCOPE, historical.record.evaluation.decisionId)).length, EVIDENCE_STORE_LIST_LIMIT);
  });

  it('schema guard: an unknown schema version, or bundle rows without a version record, are refused unopened', async () => {
    const path = join(dir(), 'e.sqlite');
    const store = await open(path);
    await store.close();
    withDb(path, (db) => db.prepare(`INSERT INTO evidence_bundle_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.evidence-bundle-store.schema.v99', 'current', 'x')`).run());
    await assert.rejects(createSqliteEvidenceStore(path, { now: () => 'x' }), { code: 'EVIDENCE_STORE_UNAVAILABLE' });
    const emptied = join(dir(), 'emptied.sqlite');
    const seeded = await open(emptied);
    await seeded.store(bundle(), { organizationId: ORG });
    await seeded.close();
    withDb(emptied, (db) => db.exec('DELETE FROM evidence_bundle_store_versions'));
    await assert.rejects(createSqliteEvidenceStore(emptied, { now: () => 'x' }), { code: 'EVIDENCE_STORE_UNAVAILABLE' }, 'rows with an emptied version record are refused, never re-stamped');
    const orphan = join(dir(), 'orphan.sqlite');
    withDb(orphan, (db) => db.exec('CREATE TABLE evidence_bundles (bundle_id TEXT)'));
    await assert.rejects(createSqliteEvidenceStore(orphan, { now: () => 'x' }), { code: 'EVIDENCE_STORE_UNAVAILABLE' });
  });

  it('health and close: healthy while open, unhealthy and unusable after close, close idempotent', async () => {
    const store = await open(join(dir(), 'e.sqlite'));
    assert.deepEqual(
      (({ status, readable, writable, schemaVersion }) => ({ status, readable, writable, schemaVersion }))(await store.health()),
      { status: 'healthy', readable: true, writable: true, schemaVersion: EVIDENCE_STORE_SCHEMA_VERSION },
    );
    await store.close();
    await store.close();
    assert.equal((await store.health()).status, 'unhealthy');
    await assert.rejects(store.store(bundle(), { organizationId: ORG }), { code: 'EVIDENCE_STORE_UNAVAILABLE' });
  });
});

describe('ASSURE-01 in-memory Evidence Bundle Store — the same lifecycle contract', () => {
  it('forward-only, terminal supersession, owner-scoped reads', async () => {
    const store = createInMemoryEvidenceStore();
    const older = bundle('PUBLIC');
    const newer = bundle('PUBLIC');
    await store.store(older, { organizationId: ORG });
    await store.markExported(older.bundleId);
    assert.equal((await store.markVerified(older.bundleId)).state, 'EXPORTED');
    await store.store(newer, { organizationId: ORG, supersedes: [older.bundleId] });
    assert.equal((await store.markVerified(older.bundleId)).state, 'SUPERSEDED');
    assert.deepEqual((await store.getByBundleId(ORG_SCOPE, older.bundleId))?.bundle, older, 'supersession never touches content');
    assert.equal(await store.getByBundleId(OTHER_SCOPE, older.bundleId), null);
    await assert.rejects(store.store(older, { organizationId: ORG }), { code: 'EVIDENCE_BUNDLE_ALREADY_EXISTS' });
  });
});
