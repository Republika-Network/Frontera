import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { ObligationLifecycleService, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import {
  ObligationDischargeError,
  createObligationDischargeRecorder,
  createSqliteObligationDischargeStore,
  createStoredObligationDischargeProvider,
  nextObligationDischargeChainDigest,
  obligationDischargeGenesisDigest,
  obligationDischargeRowDigest,
  type ObligationDischargeRowContent,
  type ObligationDischargeStore,
} from '../obligation-discharge/index.js';
import { AUTHORITY_KEY_UNTRUSTED, testAuthenticity, testSigner } from './authority-authenticity-fixture.js';

/**
 * CORE-04 — a database-only writer cannot manufacture obligation satisfaction.
 *
 * The attacker here has direct write access to the discharge store's SQLite
 * file and every algorithm in this repository: the row serialization, the row
 * digest, the chain, the head format. It does **not** hold the deployment's
 * authority signing key (it may sign with a key of its own). Every attack is
 * judged by the one authoritative read the provider performs before issuance
 * (`store.read`, through `createStoredObligationDischargeProvider` and the
 * unchanged obligation lifecycle), and by `open`, which verifies the same state
 * before the store is handed to anything.
 */

const ORG = 'org-a';
const NOW = '2026-09-28T12:00:00.000Z';
const SOURCES: readonly ObligationDischargeSource[] = [
  { id: 'board', kind: 'approval_runtime', name: 'Board', verificationClass: 'independent' },
  { id: 'notes', kind: 'internal_store', name: 'Notes', verificationClass: 'self_reported' },
];
const CORRELATION = { requestId: 'aoc.gar:target', action: 'deploy-release', resourceScope: 'production' } as const;
const WRITER = { system: true, actorId: 'operator:board-sync' } as const;
const lifecycle = new ObligationLifecycleService({ sources: SOURCES, declaration: { requirements: [{ obligationType: 'change.approval', blocking: true }] } });

const directories: string[] = [];
const stores: ObligationDischargeStore[] = [];
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-discharge-auth-'));
  directories.push(dir);
  return join(dir, 'obligation-discharges.sqlite');
}

async function open(file: string, organizationId = ORG): Promise<ObligationDischargeStore> {
  const store = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId, authenticity: testAuthenticity() });
  stores.push(store);
  return store;
}

/** The obligation's state as the pre-issuance read sees it. */
async function state(store: ObligationDischargeStore, correlation = CORRELATION): Promise<string> {
  const provider = createStoredObligationDischargeProvider(store, ORG);
  const { observations } = await provider.resolveObligationDischarges({ obligationTypes: ['change.approval'], correlation, actorId: 'a', trustDomainId: 't', organizationId: ORG, at: NOW });
  return lifecycle.resolve(observations, correlation, NOW).obligations[0]?.state ?? 'none';
}

let clock = Date.parse(NOW) - 3_600_000;
const tick = (): string => new Date((clock += 1000)).toISOString();

async function record(store: ObligationDischargeStore, sourceId: string, outcome: 'discharged' | 'waived', observedAt = tick(), correlation: { readonly requestId: string; readonly action: string; readonly resourceScope: string } = CORRELATION): Promise<void> {
  await createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => NOW }).record(WRITER, { correlation, obligationType: 'change.approval', sourceId, outcome, observedAt });
}

// ---------------------------------------------------------------------------
// The attacker's toolkit: raw SQL plus every algorithm the repository ships.

interface RawRow {
  sequence: number;
  organization_id: string;
  request_id: string;
  action: string;
  resource_scope: string;
  obligation_type: string;
  source_id: string;
  outcome: string;
  observed_at: string;
  reference: string | null;
  subject_id: string | null;
  recorded_by: string;
  recorded_at: string;
  row_digest: string;
}

function content(row: RawRow): ObligationDischargeRowContent {
  return {
    organizationId: row.organization_id,
    correlation: { requestId: row.request_id, action: row.action, resourceScope: row.resource_scope },
    obligationType: row.obligation_type,
    sourceId: row.source_id,
    outcome: row.outcome,
    observedAt: row.observed_at,
    ...(row.reference !== null ? { reference: row.reference } : {}),
    ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

/**
 * Rewrites the whole store to `rows`, recomputing every row digest, the chain
 * and the head exactly as the application would — and then either keeps the
 * genuine head signature, or signs the forged head with the attacker's own key.
 */
async function forge(file: string, edit: (rows: RawRow[]) => RawRow[], signature: 'keep' | 'attacker-key' | 'head-untouched' = 'attacker-key'): Promise<void> {
  const db = new Database(file);
  try {
    const meta = db.prepare('SELECT store_id, organization_id FROM obligation_discharge_store_meta WHERE id = 1').get() as { store_id: string; organization_id: string };
    const head = db.prepare('SELECT signature_json FROM obligation_discharge_head WHERE id = 1').get() as { signature_json: string };
    const rows = edit((db.prepare('SELECT * FROM obligation_discharges ORDER BY sequence').all() as RawRow[]).map((row) => ({ ...row })));
    let chain = obligationDischargeGenesisDigest(meta.store_id, meta.organization_id);
    rows.forEach((row, index) => {
      row.sequence = index + 1;
      row.row_digest = obligationDischargeRowDigest(meta.store_id, row.sequence, content(row));
      chain = nextObligationDischargeChainDigest(chain, row.row_digest);
    });
    const forgedSignature =
      signature !== 'attacker-key'
        ? head.signature_json
        : JSON.stringify(await testSigner(AUTHORITY_KEY_UNTRUSTED).signObligationDischargeState({ storeId: meta.store_id, organizationId: meta.organization_id, sequence: rows.length, chainDigest: chain }));
    db.exec('DROP TRIGGER IF EXISTS obligation_discharges_no_update; DROP TRIGGER IF EXISTS obligation_discharges_no_delete;');
    db.transaction(() => {
      db.prepare('DELETE FROM obligation_discharges').run();
      const insert = db.prepare(
        'INSERT INTO obligation_discharges VALUES (@sequence, @organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @row_digest)',
      );
      for (const row of rows) insert.run(row);
      if (signature !== 'head-untouched') db.prepare('UPDATE obligation_discharge_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(rows.length, chain, forgedSignature);
    })();
  } finally {
    db.close();
  }
}

const forgedRow = (overrides: Partial<RawRow> = {}): RawRow => ({
  sequence: 0,
  organization_id: ORG,
  request_id: CORRELATION.requestId,
  action: CORRELATION.action,
  resource_scope: CORRELATION.resourceScope,
  obligation_type: 'change.approval',
  source_id: 'board',
  outcome: 'discharged',
  observed_at: NOW,
  reference: 'FORGED-1',
  subject_id: null,
  recorded_by: 'attacker',
  recorded_at: NOW,
  row_digest: '',
  ...overrides,
});

async function refused(file: string, reopen = true): Promise<void> {
  // The live read: a running Host's pre-issuance check.
  const live = stores.at(-1);
  if (live !== undefined) await assert.rejects(() => state(live), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
  // And a restart: the store is refused before it is handed to anything.
  if (reopen) await assert.rejects(() => open(file), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
}

describe('CORE-04 — the obligation discharge store is authenticated, not merely consistent', () => {
  it('legitimate reports verify, across restart; the genesis state is signed', async () => {
    const file = path();
    const store = await open(file);
    assert.equal(store.kind, 'durable-authenticated');
    assert.equal(await state(store), 'required');
    await record(store, 'board', 'discharged');
    assert.equal(await state(store), 'verified');
    await store.close();
    assert.equal(await state(await open(file)), 'verified');
  });

  it('forged independent discharge inserted with every unkeyed digest recomputed — with the old signature, or the attacker’s own key — is refused', async () => {
    for (const signature of ['keep', 'attacker-key'] as const) {
      const file = path();
      const store = await open(file);
      assert.equal(await state(store), 'required');
      await forge(file, (rows) => [...rows, forgedRow()], signature);
      await refused(file);
    }
  });

  it('a self-reported discharge rewritten into an independent one (source identity changed), all digests recomputed, is refused', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    assert.equal(await state(store), 'discharged');
    await forge(file, (rows) => rows.map((row) => ({ ...row, source_id: 'board' })));
    await refused(file);
  });

  it('a pending/self-reported row turned into a waiver is refused', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    await forge(file, (rows) => rows.map((row) => ({ ...row, outcome: 'waived', source_id: 'board' })));
    await refused(file);
  });

  it('a genuine discharge copied to another decision (requestId), action or resource is refused', async () => {
    for (const overrides of [{ request_id: 'aoc.gar:other' }, { action: 'other-action' }, { resource_scope: 'other-resource' }]) {
      const file = path();
      const store = await open(file);
      await record(store, 'board', 'discharged', tick(), { requestId: 'aoc.gar:source', action: 'deploy-release', resourceScope: 'production' });
      assert.equal(await state(store), 'required');
      await forge(file, (rows) => [...rows, { ...(rows[0] as RawRow), request_id: CORRELATION.requestId, action: CORRELATION.action, resource_scope: CORRELATION.resourceScope, ...overrides }]);
      await refused(file);
    }
  });

  it('a genuine signed discharge and head copied from another store (same key, same organization) are refused: the head is bound to its store', async () => {
    const source = path();
    const donor = await open(source);
    await record(donor, 'board', 'discharged');
    await donor.close();
    const target = path();
    const victim = await open(target);
    assert.equal(await state(victim), 'required');
    const from = new Database(source, { readonly: true });
    const donorRows = from.prepare('SELECT * FROM obligation_discharges').all() as RawRow[];
    const donorHead = from.prepare('SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head').get() as { sequence: number; chain_digest: string; signature_json: string };
    from.close();
    const to = new Database(target);
    to.exec('DROP TRIGGER IF EXISTS obligation_discharges_no_update;');
    const insert = to.prepare('INSERT INTO obligation_discharges VALUES (@sequence, @organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @row_digest)');
    for (const row of donorRows) insert.run(row);
    to.prepare('UPDATE obligation_discharge_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(donorHead.sequence, donorHead.chain_digest, donorHead.signature_json);
    to.close();
    await refused(target);
  });

  it('a store is bound to its organization: another organization’s store is refused at open, and a row re-labelled to another organization is refused', async () => {
    const foreign = path();
    await (await open(foreign, 'org-b')).close();
    await assert.rejects(() => open(foreign, ORG), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
    const file = path();
    const store = await open(file);
    await record(store, 'board', 'discharged');
    await forge(file, (rows) => rows.map((row) => ({ ...row, organization_id: 'org-b' })), 'keep');
    await refused(file);
  });

  it('deleting a genuine row is refused — set completeness is committed (a self-reported discharge deleted so a later independent waiver would apply)', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged', '2026-09-28T11:00:00.000Z');
    await record(store, 'board', 'waived', '2026-09-28T11:30:00.000Z');
    assert.equal(await state(store), 'discharged', 'the lifecycle refuses discharged → waived: the obligation stays unsatisfied');
    for (const signature of ['keep', 'attacker-key'] as const) {
      const copy = path();
      const db = new Database(file, { readonly: true });
      await db.backup(copy);
      db.close();
      const replica = await open(copy);
      assert.equal(await state(replica), 'discharged');
      await forge(copy, (rows) => rows.filter((row) => row.source_id !== 'notes'), signature);
      await refused(copy);
    }
  });

  it('rows rewritten underneath the genuine, untouched signed head — every row digest recomputed, same count — are refused by the chain', async () => {
    const edits: readonly ((rows: RawRow[]) => RawRow[])[] = [
      (rows) => rows.map((row) => ({ ...row, source_id: 'board' })),
      (rows) => rows.map((row) => ({ ...row, outcome: 'waived', source_id: 'board' })),
      (rows) => rows.map((row) => ({ ...row, request_id: 'aoc.gar:elsewhere' })),
      (rows) => [...rows].reverse(),
    ];
    for (const edit of edits) {
      const file = path();
      const store = await open(file);
      await record(store, 'notes', 'discharged');
      await record(store, 'notes', 'discharged', tick(), { requestId: 'aoc.gar:second', action: 'deploy-release', resourceScope: 'production' });
      await forge(file, edit, 'head-untouched');
      await refused(file);
    }
  });

  it('the unauthenticated v1 format is never upgraded into trusted authority', async () => {
    const file = path();
    const db = new Database(file);
    db.exec(`CREATE TABLE obligation_discharge_store_versions (id INTEGER PRIMARY KEY, schema_version INTEGER, recorded_at TEXT); INSERT INTO obligation_discharge_store_versions VALUES (1, 1, '${NOW}');`);
    db.close();
    await assert.rejects(() => open(file), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_UNSUPPORTED');
  });

  it('there is no unauthenticated durable mode', async () => {
    await assert.rejects(
      () => createSqliteObligationDischargeStore(path(), { now: () => NOW, organizationId: ORG, authenticity: undefined as never }),
      (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_UNSUPPORTED',
    );
  });

  it('rollback: an older genuine signed state restored under a running process is refused; after a restart it is accepted — CORE-07’s residual, stated', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    const db = new Database(file);
    const olderHead = db.prepare('SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head').get() as { sequence: number; chain_digest: string; signature_json: string };
    db.close();
    await record(store, 'board', 'discharged');
    assert.equal(await state(store), 'verified');
    const rollback = new Database(file);
    rollback.exec('DROP TRIGGER IF EXISTS obligation_discharges_no_delete;');
    rollback.prepare('DELETE FROM obligation_discharges WHERE sequence = 2').run();
    rollback.prepare('UPDATE obligation_discharge_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(olderHead.sequence, olderHead.chain_digest, olderHead.signature_json);
    rollback.close();
    await assert.rejects(() => state(store), (error: unknown) => error instanceof ObligationDischargeError && /regressed/.test(error.message));
    // A fresh process has no witness: the older, genuine state verifies.
    // Detecting that is CORE-07's. What CORE-04 does guarantee is that a
    // rollback can only remove reports and can never *manufacture*
    // satisfaction: reports are recorded in strictly increasing observation
    // time, so every committed prefix is a lifecycle prefix, and a satisfied
    // obligation is terminal (see the next test).
    assert.equal(await state(await open(file)), 'discharged');
  });

  it('reports are recorded in strictly increasing observation time per obligation, so no committed prefix can be satisfied when the whole is not', async () => {
    const store = await open(path());
    await record(store, 'board', 'waived', '2026-09-28T11:30:00.000Z');
    for (const observedAt of ['2026-09-28T11:00:00.000Z', '2026-09-28T11:30:00.000Z']) {
      await assert.rejects(() => record(store, 'notes', 'discharged', observedAt), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_INVALID');
    }
    assert.equal(await state(store), 'waived');
    // Another decision's reports are independent of this one's order.
    await record(store, 'notes', 'discharged', '2026-09-28T11:00:00.000Z', { requestId: 'aoc.gar:other', action: 'deploy-release', resourceScope: 'production' });
  });
});
