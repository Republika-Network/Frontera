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
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testAuthenticity, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';

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

// ---------------------------------------------------------------------------
// Properties of the durable append and of the committed state itself.

function head(file: string): { sequence: number; chain_digest: string; signature_json: string } {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head WHERE id = 1').get() as { sequence: number; chain_digest: string; signature_json: string };
  } finally {
    db.close();
  }
}

function rowCount(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM obligation_discharges').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function raw(file: string, sql: string, ...args: unknown[]): void {
  const db = new Database(file);
  try {
    db.exec('DROP TRIGGER IF EXISTS obligation_discharges_no_update; DROP TRIGGER IF EXISTS obligation_discharges_no_delete;');
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}

describe('CORE-04 — a legitimate append never signs over unverified state', () => {
  it('tampered rows (under the untouched genuine head) → the trusted recorder refuses, and no new commitment is signed or persisted', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    await forge(file, (rows) => rows.map((row) => ({ ...row, source_id: 'board' })), 'head-untouched');
    const before = head(file);
    const count = rowCount(file);
    await assert.rejects(() => record(store, 'board', 'discharged'), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
    assert.deepEqual(head(file), before, 'the head — sequence, chain and signature — is byte-identical');
    assert.equal(rowCount(file), count);
  });

  it('rows tampered while the new head is being signed are caught by the re-verification under the write lock; nothing is persisted', async () => {
    const file = path();
    const genuine = testSigner(AUTHORITY_KEY_A);
    let tamperDuringSigning = false;
    const signer: AuthorityArtifactSigner = {
      ...genuine,
      async signObligationDischargeState(state) {
        const signature = await genuine.signObligationDischargeState(state);
        if (tamperDuringSigning) raw(file, `UPDATE obligation_discharges SET source_id = 'board' WHERE sequence = 1`);
        return signature;
      },
    };
    const store = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: { signer, verifier: testVerifier([AUTHORITY_KEY_A]) } });
    stores.push(store);
    await record(store, 'notes', 'discharged');
    const before = head(file);
    tamperDuringSigning = true;
    await assert.rejects(() => record(store, 'board', 'discharged'), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
    assert.deepEqual(head(file), before);
    assert.equal(rowCount(file), 1);
  });
});

describe('CORE-04 — row and signed commitment are one transaction', () => {
  it('a failure between the row and the commitment rolls both back; the prior authentic state remains', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    const before = head(file);
    const db = new Database(file);
    db.exec(`CREATE TRIGGER fail_head_update BEFORE UPDATE ON obligation_discharge_head BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`);
    db.close();
    await assert.rejects(() => record(store, 'board', 'discharged'), /simulated crash/);
    assert.equal(rowCount(file), 1, 'the row was not persisted without its commitment');
    assert.deepEqual(head(file), before);
    const cleanup = new Database(file);
    cleanup.exec('DROP TRIGGER fail_head_update;');
    cleanup.close();
    assert.equal(await state(await open(file)), 'discharged');
  });

  it('a half-written authority state (a row without its commitment) fails closed, live and at restart', async () => {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    const db = new Database(file, { readonly: true });
    const genuine = db.prepare('SELECT * FROM obligation_discharges WHERE sequence = 1').get() as RawRow;
    const storeId = (db.prepare('SELECT store_id FROM obligation_discharge_store_meta').get() as { store_id: string }).store_id;
    db.close();
    raw(file, 'INSERT INTO obligation_discharges VALUES (@sequence, @organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @row_digest)', {
      ...genuine,
      sequence: 2,
      source_id: 'board',
      row_digest: obligationDischargeRowDigest(storeId, 2, content({ ...genuine, source_id: 'board' })),
    });
    await refused(file);
  });
});

describe('CORE-04 — genesis only for an empty file; an existing file is never re-initialized', () => {
  it('rows without an identity, an identity without a head, or any foreign schema object: refused, and nothing is created', async () => {
    const cases: readonly ((file: string) => void)[] = [
      (file) => raw(file, 'DROP TABLE obligation_discharge_store_meta'),
      (file) => raw(file, 'DELETE FROM obligation_discharge_head'),
      (file) => raw(file, 'DROP TABLE obligation_discharge_head'),
    ];
    for (const damage of cases) {
      const file = path();
      const store = await open(file);
      await record(store, 'board', 'discharged');
      await store.close();
      damage(file);
      await assert.rejects(() => open(file), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
      const db = new Database(file, { readonly: true });
      const meta = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'obligation_discharge_store_meta'`).get();
      db.close();
      if (damage === cases[0]) assert.equal(meta, undefined, 'no identity or genesis was created over the existing rows');
    }
    const foreign = path();
    const db = new Database(foreign);
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.close();
    await assert.rejects(() => open(foreign), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT');
  });
});

describe('CORE-04 — exact-set verification: the database holds exactly the committed history', () => {
  async function seeded(): Promise<{ readonly file: string; readonly storeId: string; readonly rows: RawRow[] }> {
    const file = path();
    const store = await open(file);
    await record(store, 'notes', 'discharged');
    await record(store, 'board', 'discharged', tick(), { requestId: 'aoc.gar:second', action: 'deploy-release', resourceScope: 'production' });
    await record(store, 'notes', 'discharged', tick(), { requestId: 'aoc.gar:third', action: 'deploy-release', resourceScope: 'production' });
    const db = new Database(file, { readonly: true });
    const storeId = (db.prepare('SELECT store_id FROM obligation_discharge_store_meta').get() as { store_id: string }).store_id;
    const rows = db.prepare('SELECT * FROM obligation_discharges ORDER BY sequence').all() as RawRow[];
    db.close();
    return { file, storeId, rows };
  }
  const insertSql = 'INSERT INTO obligation_discharges VALUES (@sequence, @organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @row_digest)';

  it('insertion, deletion, reorder / sequence rewrite, duplicate, gap, foreign-store row and foreign-organization row all fail closed', async () => {
    const attacks: readonly [string, (seed: Awaited<ReturnType<typeof seeded>>) => void][] = [
      ['insertion', ({ file, storeId }) => raw(file, insertSql, { ...forgedRow(), sequence: 4, row_digest: obligationDischargeRowDigest(storeId, 4, content({ ...forgedRow(), sequence: 4 })) })],
      ['deletion', ({ file }) => raw(file, 'DELETE FROM obligation_discharges WHERE sequence = 2')],
      ['reorder (sequences swapped)', ({ file }) => {
        raw(file, 'UPDATE obligation_discharges SET sequence = 99 WHERE sequence = 1');
        raw(file, 'UPDATE obligation_discharges SET sequence = 1 WHERE sequence = 2');
        raw(file, 'UPDATE obligation_discharges SET sequence = 2 WHERE sequence = 99');
      }],
      ['duplicated row', ({ file, rows }) => raw(file, insertSql, { ...(rows[0] as RawRow), sequence: 4 })],
      ['gap', ({ file }) => raw(file, 'UPDATE obligation_discharges SET sequence = 4 WHERE sequence = 3')],
      ['foreign-store row', ({ file, rows }) => {
        const row = { ...(rows[1] as RawRow) };
        raw(file, 'UPDATE obligation_discharges SET row_digest = ? WHERE sequence = 2', obligationDischargeRowDigest('obligation-discharge-store:another', 2, content(row)));
      }],
      ['foreign-organization row', ({ file, storeId, rows }) => {
        const row = { ...(rows[1] as RawRow), organization_id: 'org-b' };
        raw(file, 'UPDATE obligation_discharges SET organization_id = ?, row_digest = ? WHERE sequence = 2', 'org-b', obligationDischargeRowDigest(storeId, 2, content(row)));
      }],
    ];
    for (const [name, attack] of attacks) {
      const seed = await seeded();
      attack(seed);
      await assert.rejects(() => state(stores.at(-1) as ObligationDischargeStore), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT', name);
      await assert.rejects(() => open(seed.file), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT', `${name} (restart)`);
    }
  });
});

describe('CORE-04 — key rotation follows the CORE-01 rule', () => {
  it('an unchanged state signed by a trusted previous key verifies, is re-attested under the active key on open, and then survives retiring the old key', async () => {
    const file = path();
    const first = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A }) });
    await record(first, 'board', 'discharged');
    await first.close();
    assert.equal((JSON.parse(head(file).signature_json) as { keyId: string }).keyId, AUTHORITY_KEY_A.keyId);

    // Without the rotation step, a verifier that no longer trusts A refuses.
    await assert.rejects(
      () => createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_B] }) }),
      (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_STORE_CORRUPT',
    );

    // Rotation: sign with B, trust A and B. The unchanged state verifies and is re-attested under B.
    const before = head(file);
    const rotated = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) });
    stores.push(rotated);
    const after = head(file);
    assert.equal(after.sequence, before.sequence);
    assert.equal(after.chain_digest, before.chain_digest, 're-attestation signs the same state, never a new one');
    assert.equal((JSON.parse(after.signature_json) as { keyId: string }).keyId, AUTHORITY_KEY_B.keyId);
    assert.equal(await state(rotated), 'verified');
    await rotated.close();

    // A retired: only B is trusted, and the state still verifies.
    const retired = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_B] }) });
    stores.push(retired);
    assert.equal(await state(retired), 'verified');
  });

  it('a state that does not verify is never re-attested', async () => {
    const file = path();
    const first = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A }) });
    await record(first, 'notes', 'discharged');
    await first.close();
    await forge(file, (rows) => rows.map((row) => ({ ...row, source_id: 'board' })), 'head-untouched');
    const before = head(file);
    await assert.rejects(() => createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) }));
    assert.deepEqual(head(file), before);
  });
});
