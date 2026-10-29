import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import {
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS,
  SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION,
  SovereignStatusHistoryStoreError,
  openSqliteStatusHighWaterMarkStore,
} from '../sovereign-status-history/index.js';
import type { SovereignStatusHighWaterMark, SovereignStatusHistoryKey, SqliteStatusHighWaterMarkStore, StatusHistoryBootstrapEvidenceDraft } from '../sovereign-status-history/index.js';

// FV-P4C-2A — the durable status high-water-mark store, exercised directly with
// synthetic marks. The end-to-end chain through the real freshness gate is
// tests/fv-p4c2a-sqlite-status-history.e2e.test.mjs.

const NAMESPACE = 'receiver:test';
const KEY = Object.freeze({ sovereignAssetId: 'sa:test-asset-1', issuer: 'did:example:registrant' });
const D = (c: string) => c.repeat(64);

function mark(overrides: Partial<SovereignStatusHighWaterMark> = {}): SovereignStatusHighWaterMark {
  return {
    sovereignAssetId: KEY.sovereignAssetId,
    issuer: KEY.issuer,
    sequence: 1,
    statusDigest: D('1'),
    issuedAt: '2026-10-28T11:50:00.000000001Z',
    currentTermsDigest: D('a'),
    timeFloor: '2026-10-28T11:50:00.000000001Z',
    withdrawn: false,
    retiredTermsDigests: [],
    continuity: 'verified',
    conflict: false,
    anchoredAt: '2026-10-28T12:00:00Z',
    ...overrides,
  };
}

let requestCounter = 0;

/** A synthetic bootstrap evidence draft for `next`, as the FV-P4C-2B1 coordinator would record it. */
function draftFor(store: SqliteStatusHighWaterMarkStore, key: SovereignStatusHistoryKey, next: SovereignStatusHighWaterMark, operation: 'establish' | 'reanchor' = 'establish'): StatusHistoryBootstrapEvidenceDraft {
  requestCounter += 1;
  return {
    schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
    operationId: 'op:test',
    requestId: `req:test-${requestCounter}`,
    namespace: store.namespace,
    sovereignAssetId: key.sovereignAssetId,
    issuer: key.issuer,
    operation,
    purpose: operation === 'establish' ? 'initial-trust-anchor' : 'continuity-restoration',
    bindingDigest: D('e'),
    operatorRef: 'operator:test',
    authorityRef: 'authority:test',
    sources: [{ sourceClass: 'issuer-status-channel', sourceRef: 'source:test', observedAt: next.anchoredAt }],
    status: { sequence: next.sequence, statusDigest: next.statusDigest },
    evaluationTime: next.anchoredAt,
    result: 'committed',
    classification: 'host-recorded-unsigned',
  };
}

/** Creates a history the only way the store allows: with bootstrap evidence. */
async function seed(store: SqliteStatusHighWaterMarkStore, key: SovereignStatusHistoryKey, next: SovereignStatusHighWaterMark): Promise<boolean> {
  return (await store.compareAndSetWithEvidence(key, null, next, draftFor(store, key, next))) !== false;
}

async function withDirectory<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2a-'));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function created(dir: string, options: { busyTimeoutMs?: number } = {}): Promise<{ path: string; store: SqliteStatusHighWaterMarkStore }> {
  const path = join(dir, 'history.sqlite');
  const store = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE, create: true, ...options });
  return { path, store };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SovereignStatusHistoryStoreError && error.code === code);
}

/** A raw connection, as an operator or attacker with file access would have. */
function raw(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('busy_timeout = 2000');
  return db;
}

describe('FV-P4C-2A durable status history — lifecycle', () => {
  it('1–2. a fresh database holds no history: schema creation is not a bootstrap', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      assert.equal(await store.read(KEY), undefined);
      assert.equal(store.namespace, NAMESPACE);
      store.close();
      const db = raw(path);
      assert.deepEqual(db.prepare('SELECT schema_version, namespace, created_rows FROM sovereign_status_history_meta').get(), { schema_version: SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION, namespace: NAMESPACE, created_rows: 0 });
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      db.close();
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    });
  });

  it('3–6. a trusted first write is read back, survives close and reopen, and a new instance sees it', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      assert.equal(await seed(store, KEY, mark()), true);
      const first = await store.read(KEY);
      assert.deepEqual(first, { revision: 1, mark: mark() });
      assert.equal(Object.isFrozen(first), true);
      store.close();
      const reopened = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      assert.deepEqual(await reopened.read(KEY), first, 'byte-for-byte the same history, nanoseconds included');
      assert.equal(await reopened.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2'), issuedAt: '2026-10-28T11:52:00Z', timeFloor: '2026-10-28T11:52:00Z' })), true);
      reopened.close();
      const third = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      assert.equal((await third.read(KEY))!.revision, 2);
      third.close();
    });
  });

  it('31/35. a missing file, an existing file on create, another namespace, :memory: and junk paths are refused', async () => {
    await withDirectory(async (dir) => {
      await rejectsWith(openSqliteStatusHighWaterMarkStore(join(dir, 'absent.sqlite'), { namespace: NAMESPACE }), 'OPEN_REFUSED');
      assert.equal(existsSync(join(dir, 'absent.sqlite')), false, 'a missing history is never created implicitly');
      const { path, store } = await created(dir);
      store.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE, create: true }), 'OPEN_REFUSED');
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: 'receiver:other' }), 'OPEN_REFUSED');
      for (const bad of [':memory:', '', '   ', `${dir}/x\0y`]) await rejectsWith(openSqliteStatusHighWaterMarkStore(bad, { namespace: NAMESPACE, create: true }), 'OPEN_REFUSED');
      for (const options of [{ namespace: '' }, { namespace: ' padded' }, { namespace: NAMESPACE, busyTimeoutMs: -1 }, { namespace: NAMESPACE, busyTimeoutMs: 60_001 }, { namespace: NAMESPACE, create: 'yes' }]) {
        await rejectsWith(openSqliteStatusHighWaterMarkStore(join(dir, 'other.sqlite'), options as never), 'OPEN_REFUSED');
      }
      const junk = join(dir, 'junk.sqlite');
      writeFileSync(junk, 'not a database at all');
      await rejectsWith(openSqliteStatusHighWaterMarkStore(junk, { namespace: NAMESPACE }), 'OPEN_REFUSED');
      const empty = join(dir, 'empty.sqlite');
      new Database(empty).close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(empty, { namespace: NAMESPACE }), 'OPEN_REFUSED');
    });
  });

  it('create never initializes over an existing file, even an empty SQLite database', async () => {
    await withDirectory(async (dir) => {
      const empty = join(dir, 'empty.sqlite');
      new Database(empty).close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(empty, { namespace: NAMESPACE, create: true }), 'OPEN_REFUSED');
      const db = raw(empty);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get(), { n: 0 }, 'nothing was written into it');
      db.close();
    });
  });

  it('a file whose pages fail the integrity check is refused', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      for (let i = 0; i < 200; i += 1) await seed(store, { sovereignAssetId: `sa:asset-${i}`, issuer: KEY.issuer }, mark({ sovereignAssetId: `sa:asset-${i}` }));
      store.close();
      const db = raw(path);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('journal_mode = DELETE');
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      const pages = db.pragma('page_count', { simple: true }) as number;
      db.close();
      // Overwrite the b-tree header of the last page, leaving the schema page intact.
      const fd = openSync(path, 'r+');
      writeSync(fd, Buffer.alloc(12, 0xff), 0, 12, pageSize * (pages - 1));
      closeSync(fd);
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }), 'OPEN_REFUSED');
    });
  });

  it('30. a history recorded under another schema version is refused', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      store.close();
      const db = raw(path);
      db.exec('DROP TRIGGER sovereign_status_history_meta_fixed');
      db.prepare("UPDATE sovereign_status_history_meta SET schema_version = 'frontera.sovereign-status-history.v1'").run();
      db.exec(`CREATE TRIGGER sovereign_status_history_meta_fixed BEFORE UPDATE ON sovereign_status_history_meta WHEN 1 BEGIN SELECT RAISE(ABORT, 'x'); END;`);
      db.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }), 'OPEN_REFUSED');
    });
  });

  it('a file missing an integrity trigger, or carrying an extra one, is refused', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      store.close();
      const db = raw(path);
      db.exec('DROP TRIGGER sovereign_status_history_never_deleted');
      db.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }), 'OPEN_REFUSED');
      const again = raw(path);
      again.exec(`CREATE TRIGGER sovereign_status_history_never_deleted BEFORE DELETE ON sovereign_status_history BEGIN SELECT RAISE(ABORT, 'x'); END;`);
      again.exec(`CREATE TRIGGER sneaky AFTER UPDATE ON sovereign_status_history BEGIN UPDATE sovereign_status_history SET conflict = 0; END;`);
      again.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }), 'OPEN_REFUSED');
    });
  });

  it('a closed store refuses every operation', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      store.close();
      store.close();
      await rejectsWith(store.read(KEY), 'CLOSED');
      await rejectsWith(seed(store, KEY, mark()), 'CLOSED');
    });
  });
});

describe('FV-P4C-2A durable status history — compare-and-set', () => {
  it('19–21. insert only when absent, update only at the exact revision, never blind', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      assert.equal(await store.compareAndSet(KEY, 1, mark()), false, 'no row: an expected revision cannot match');
      assert.equal(await seed(store, KEY, mark()), true);
      assert.equal(await seed(store, KEY, mark({ statusDigest: D('9') })), false, 'an existing history is never overwritten by an insert');
      await rejectsWith(store.compareAndSet(KEY, null, mark({ sovereignAssetId: 'sa:other' }) as never), 'INVALID_WRITE');
      await rejectsWith(store.compareAndSet({ sovereignAssetId: 'sa:other', issuer: KEY.issuer }, null, mark({ sovereignAssetId: 'sa:other' })), 'INVALID_WRITE');
      await rejectsWith(store.compareAndSet(KEY, 1, mark({ anchoredAt: '2026-10-28T12:30:00Z' })), 'INVALID_WRITE');
      const next = mark({ sequence: 2, statusDigest: D('2') });
      assert.equal(await store.compareAndSet(KEY, 2, next), false, 'a revision that does not exist yet');
      assert.equal(await store.compareAndSet(KEY, 1, next), true);
      assert.equal(await store.compareAndSet(KEY, 1, mark({ sequence: 3, statusDigest: D('3') })), false, 'a stale revision');
      assert.deepEqual(await store.read(KEY), { revision: 2, mark: next });
      store.close();
    });
  });

  it('the store itself refuses every downgrade, whatever the caller', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      const head = mark({ sequence: 5, statusDigest: D('5'), withdrawn: true, currentTermsDigest: null, conflict: true, retiredTermsDigests: [D('a'), D('b')], timeFloor: '2026-10-28T11:55:00Z', issuedAt: '2026-10-28T11:55:00Z' });
      await seed(store, KEY, head);
      const downgrades: Array<[string, Partial<SovereignStatusHighWaterMark>]> = [
        ['lower sequence', { sequence: 4 }],
        ['reopen withdrawal', { withdrawn: false }],
        ['clear conflict', { conflict: false }],
        ['forget retired terms', { retiredTermsDigests: [D('a')] }],
        ['time floor back', { timeFloor: '2026-10-28T11:54:59.999999999Z', issuedAt: '2026-10-28T11:54:00Z' }],
      ];
      for (const [label, change] of downgrades) await rejectsWith(store.compareAndSet(KEY, 1, { ...head, ...change }), 'DOWNGRADE').then(() => undefined, (e) => assert.fail(`${label}: ${String(e)}`));
      assert.deepEqual(await store.read(KEY), { revision: 1, mark: head });
      store.close();
    });
  });

  it('malformed writes are refused before any SQL runs', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      const cases: unknown[] = [
        { ...mark(), extra: 1 },
        { ...mark(), sequence: Number.MAX_SAFE_INTEGER + 1 },
        { ...mark(), sequence: 1.5 },
        { ...mark(), statusDigest: 'X'.repeat(64) },
        { ...mark(), timeFloor: '2026-10-28T11:00:00Z' },
        { ...mark(), issuedAt: '2026-02-30T00:00:00Z' },
        { ...mark(), retiredTermsDigests: [D('b'), D('a')] },
        { ...mark(), retiredTermsDigests: [D('a'), D('a')] },
        { ...mark(), retiredTermsDigests: Array.from({ length: SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS + 1 }, (_, i) => i.toString(16).padStart(64, '0')) },
        { ...mark(), continuity: 'maybe' },
        { ...mark(), conflict: 0 },
        { ...mark(), sovereignAssetId: 'sa:another' },
        null,
      ];
      for (const [index, next] of cases.entries()) await rejectsWith(store.compareAndSetWithEvidence(KEY, null, next as SovereignStatusHighWaterMark, draftFor(store, KEY, mark())), 'INVALID_WRITE').catch((e) => assert.fail(`case ${index}: ${String(e)}`));
      await rejectsWith(seed(store, { sovereignAssetId: '', issuer: KEY.issuer }, mark()), 'INVALID_WRITE');
      await rejectsWith(store.compareAndSet(KEY, 0, mark()), 'INVALID_WRITE');
      assert.equal(await store.read(KEY), undefined);
      // The maximum is accepted, not truncated.
      const max = Array.from({ length: SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS }, (_, i) => i.toString(16).padStart(64, '0'));
      assert.equal(await seed(store, KEY, mark({ retiredTermsDigests: max })), true);
      assert.equal((await store.read(KEY))!.mark.retiredTermsDigests.length, SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS);
      store.close();
    });
  });

  it('36/39. issuers are separate histories, and stored rows are deterministic', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      const other = { sovereignAssetId: KEY.sovereignAssetId, issuer: 'did:example:other' };
      await seed(store, KEY, mark());
      await seed(store, other, mark({ issuer: other.issuer, conflict: true }));
      assert.equal((await store.read(KEY))!.mark.conflict, false);
      assert.equal((await store.read(other))!.mark.conflict, true);
      store.close();
      const db = raw(path);
      const row = db.prepare('SELECT retired_terms_digests, withdrawn, conflict FROM sovereign_status_history WHERE issuer = ?').get(KEY.issuer);
      assert.deepEqual(row, { retired_terms_digests: '[]', withdrawn: 0, conflict: 0 });
      db.close();
    });
  });

  it('37/38. namespaces are separate files, each pinned, with no cross-tenant leakage', async () => {
    await withDirectory(async (dir) => {
      const a = await openSqliteStatusHighWaterMarkStore(join(dir, 'a.sqlite'), { namespace: 'tenant:a', create: true });
      const b = await openSqliteStatusHighWaterMarkStore(join(dir, 'b.sqlite'), { namespace: 'tenant:b', create: true });
      await seed(a, KEY, mark({ conflict: true }));
      assert.equal(await b.read(KEY), undefined);
      a.close();
      b.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(join(dir, 'a.sqlite'), { namespace: 'tenant:b' }), 'OPEN_REFUSED');
    });
  });
});

describe('FV-P4C-2A durable status history — a raw writer and corruption', () => {
  it('the triggers refuse deletion and backward updates even from a raw connection', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark({ conflict: true, withdrawn: true, retiredTermsDigests: [D('b')] }));
      store.close();
      const db = raw(path);
      const attempts = [
        'DELETE FROM sovereign_status_history',
        'UPDATE sovereign_status_history SET conflict = 0, revision = revision + 1',
        'UPDATE sovereign_status_history SET withdrawn = 0, revision = revision + 1',
        'UPDATE sovereign_status_history SET sequence = 0, revision = revision + 1',
        `UPDATE sovereign_status_history SET retired_terms_digests = '[]', revision = revision + 1`,
        'UPDATE sovereign_status_history SET revision = 1',
        "UPDATE sovereign_status_history SET issuer = 'did:example:moved', revision = revision + 1",
        'DELETE FROM sovereign_status_history_meta',
        'UPDATE sovereign_status_history_meta SET created_rows = 0',
        "UPDATE sovereign_status_history_meta SET namespace = 'tenant:other', created_rows = created_rows + 1",
      ];
      for (const sql of attempts) assert.throws(() => db.prepare(sql).run(), /RAISE|history|identity|never|forward|fixed/i, sql);
      db.close();
      const reopened = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      assert.equal((await reopened.read(KEY))!.mark.conflict, true);
      reopened.close();
    });
  });

  it('28/29. a corrupt row or malformed retired terms is refused, never defaulted', async () => {
    const corruptions = [
      "status_digest = 'not-a-digest'",
      "retired_terms_digests = '[1,2]'",
      `retired_terms_digests = '["${D('b')}","${D('a')}"]'`,
      "retired_terms_digests = '{}'",
      'withdrawn = 7',
      "continuity = 'maybe'",
      "time_floor = 'yesterday'",
      'sequence = 0',
    ];
    for (const corruption of corruptions) {
      await withDirectory(async (dir) => {
        const { path, store } = await created(dir);
        await seed(store, KEY, mark({ retiredTermsDigests: [D('b')] }));
        const db = raw(path);
        db.pragma('ignore_check_constraints = ON');
        db.exec('DROP TRIGGER sovereign_status_history_forward_only');
        db.exec(`UPDATE sovereign_status_history SET ${corruption}`);
        db.close();
        await rejectsWith(store.read(KEY), 'INTEGRITY').catch((e) => assert.fail(`${corruption}: ${String(e)}`));
        await rejectsWith(store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2'), retiredTermsDigests: [D('b')] })), 'INTEGRITY');
        store.close();
      });
    }
  });

  it('a deleted row in a history that recorded it is refused, not read as uninitialized', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark({ conflict: true }));
      const db = raw(path);
      db.exec('DROP TRIGGER sovereign_status_history_never_deleted');
      db.exec('DELETE FROM sovereign_status_history');
      db.close();
      await rejectsWith(store.read(KEY), 'INTEGRITY');
      await rejectsWith(seed(store, KEY, mark()), 'INTEGRITY');
      store.close();
    });
  });

  it('LIMIT: a whole-file restore of an older copy is not detectable here', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      store.close();
      const copy = join(dir, 'snapshot.sqlite');
      const db = raw(path);
      db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
      db.close();
      const live = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      await live.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2'), withdrawn: true, currentTermsDigest: null }));
      live.close();
      const restored = await openSqliteStatusHighWaterMarkStore(copy, { namespace: NAMESPACE });
      assert.equal((await restored.read(KEY))!.mark.withdrawn, false, 'the restored copy forgot the withdrawal: an external anchor is needed (FV-P4C-2B)');
      restored.close();
    });
  });
});

describe('FV-P4C-2B1 bootstrap evidence ledger', () => {
  it('a history and its evidence commit together, and the store fills in the transition it replaced', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      const first = await store.compareAndSetWithEvidence(KEY, null, mark(), draftFor(store, KEY, mark()));
      assert.notEqual(first, false);
      if (first === false) return;
      assert.equal(first.reason, 'ESTABLISHED');
      assert.equal(first.previous, null);
      assert.deepEqual(first.next, { revision: 1, sequence: 1, statusDigest: D('1') });
      const reanchored = mark({ sequence: 4, statusDigest: D('4'), anchoredAt: '2026-10-28T12:30:00Z', continuity: 'verified' });
      const second = await store.compareAndSetWithEvidence(KEY, 1, reanchored, draftFor(store, KEY, reanchored, 'reanchor'));
      assert.notEqual(second, false);
      if (second === false) return;
      assert.equal(second.reason, 'REESTABLISHED');
      assert.deepEqual(second.previous, { revision: 1, sequence: 1, statusDigest: D('1') });
      assert.deepEqual((await store.readBootstrapEvidence(KEY)).map((e) => e.requestId), [first.requestId, second.requestId]);
      assert.equal(await store.hasBootstrapRequest(first.requestId), true);
      assert.equal(await store.hasBootstrapRequest('req:never'), false);
      store.close();
    });
  });

  it('a request id is recorded once; a mismatched or mis-scoped draft writes nothing', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      const draft = draftFor(store, KEY, mark());
      assert.notEqual(await store.compareAndSetWithEvidence(KEY, null, mark(), draft), false);
      const other = { sovereignAssetId: 'sa:other', issuer: KEY.issuer };
      await rejectsWith(store.compareAndSetWithEvidence(other, null, mark({ sovereignAssetId: 'sa:other' }), { ...draft, sovereignAssetId: 'sa:other' }), 'INVALID_WRITE');
      const fresh = (overrides: Record<string, unknown>) => ({ ...draftFor(store, other, mark({ sovereignAssetId: 'sa:other' })), ...overrides }) as StatusHistoryBootstrapEvidenceDraft;
      for (const [label, bad] of [
        ['wrong namespace', fresh({ namespace: 'receiver:other' })],
        ['wrong asset', fresh({ sovereignAssetId: KEY.sovereignAssetId })],
        ['wrong operation', fresh({ operation: 'reanchor', purpose: 'continuity-restoration' })],
        ['wrong status', fresh({ status: { sequence: 2, statusDigest: D('2') } })],
        ['wrong instant', fresh({ evaluationTime: '2026-10-28T12:00:00.000000001Z' })],
        ['secret source', fresh({ sources: [{ sourceClass: 'issuer-status-channel', sourceRef: 'https://x.example/doc#key=abc', observedAt: '2026-10-28T12:00:00Z' }] })],
        ['extra field', fresh({ approved: true })],
        ['unknown schema', fresh({ schemaVersion: 'frontera.sovereign-status-bootstrap-evidence/2' })],
      ] as const) {
        await assert.rejects(store.compareAndSetWithEvidence(other, null, mark({ sovereignAssetId: 'sa:other' }), bad), SovereignStatusHistoryStoreError, label);
      }
      assert.equal(await store.read(other), undefined, 'nothing was written');
      assert.equal((await store.readBootstrapEvidence(other)).length, 0);
      store.close();
    });
  });

  it('a conflicted history is never re-anchored by the store, whatever the evidence', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      await seed(store, KEY, mark());
      await store.compareAndSet(KEY, 1, mark({ conflict: true }));
      const reanchored = mark({ conflict: false, sequence: 2, statusDigest: D('2'), anchoredAt: '2026-10-28T12:30:00Z' });
      await rejectsWith(store.compareAndSetWithEvidence(KEY, 2, reanchored, draftFor(store, KEY, reanchored, 'reanchor')), 'DOWNGRADE');
      const kept = mark({ conflict: true, sequence: 2, statusDigest: D('2'), anchoredAt: '2026-10-28T12:30:00Z' });
      await rejectsWith(store.compareAndSetWithEvidence(KEY, 2, kept, draftFor(store, KEY, kept, 'reanchor')), 'DOWNGRADE');
      assert.equal((await store.read(KEY))!.mark.conflict, true);
      store.close();
    });
  });

  it('R2: a history whose evidence is missing, tampered or does not match its anchor is refused', async () => {
    const tamper = [
      'DELETE FROM sovereign_status_bootstrap_evidence',
      `UPDATE sovereign_status_bootstrap_evidence SET record = json_set(record, '$.authorityRef', 'authority:forged')`,
      `UPDATE sovereign_status_bootstrap_evidence SET anchored_at = '2026-10-28T13:00:00Z', record = json_set(record, '$.evaluationTime', '2026-10-28T13:00:00Z')`,
      `UPDATE sovereign_status_bootstrap_evidence SET record = json_set(record, '$.namespace', 'receiver:other')`,
    ];
    for (const sql of tamper) {
      await withDirectory(async (dir) => {
        const { path, store } = await created(dir);
        await seed(store, KEY, mark());
        const db = raw(path);
        db.exec('DROP TRIGGER sovereign_status_bootstrap_evidence_never_deleted');
        db.exec('DROP TRIGGER sovereign_status_bootstrap_evidence_never_updated');
        db.exec(sql);
        db.close();
        if (sql.includes('authorityRef')) {
          // A well-formed but forged authority reference is not detectable by the store: evidence is unsigned.
          assert.equal((await store.readBootstrapEvidence(KEY))[0]!.authorityRef, 'authority:forged');
        } else {
          await rejectsWith(store.read(KEY), 'INTEGRITY').catch((e) => assert.fail(`${sql}: ${String(e)}`));
          await rejectsWith(store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), 'INTEGRITY');
        }
        store.close();
      });
    }
  });

  it('the evidence ledger refuses deletion and rewriting from a raw connection', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      store.close();
      const db = raw(path);
      assert.throws(() => db.prepare('DELETE FROM sovereign_status_bootstrap_evidence').run(), /permanent/);
      assert.throws(() => db.prepare(`UPDATE sovereign_status_bootstrap_evidence SET request_id = 'req:other'`).run(), /permanent/);
      db.close();
    });
  });

  it('a bootstrap followed by ordinary advances stays readable and verifiable after a reopen', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark({ sequence: 5, statusDigest: D('5') }));
      await store.compareAndSet(KEY, 1, mark({ sequence: 6, statusDigest: D('6') }));
      await store.compareAndSet(KEY, 2, mark({ sequence: 7, statusDigest: D('7') }));
      store.close();
      const reopened = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      assert.deepEqual(await reopened.read(KEY), { revision: 3, mark: mark({ sequence: 7, statusDigest: D('7') }) });
      const [evidence] = await reopened.readBootstrapEvidence(KEY);
      assert.deepEqual(evidence!.next, { revision: 1, sequence: 5, statusDigest: D('5') }, 'the record keeps the transition it described');
      assert.equal(await reopened.compareAndSet(KEY, 3, mark({ sequence: 8, statusDigest: D('8') })), true);
      reopened.close();
    });
  });

  it('a v1 history file is refused and never rewritten or replaced', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      store.close();
      const db = raw(path);
      db.exec('DROP TRIGGER sovereign_status_history_meta_fixed');
      db.prepare("UPDATE sovereign_status_history_meta SET schema_version = 'frontera.sovereign-status-history.v1'").run();
      db.close();
      const before = readFileSync(path);
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }), 'OPEN_REFUSED');
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE, create: true }), 'OPEN_REFUSED');
      assert.deepEqual(readFileSync(path), before, 'the refused file is left exactly as it was');
    });
  });

  it('a lost race writes neither the mark nor the evidence', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      const other = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      const results = await Promise.all([
        store.compareAndSetWithEvidence(KEY, null, mark(), draftFor(store, KEY, mark())),
        other.compareAndSetWithEvidence(KEY, null, mark({ statusDigest: D('7') }), draftFor(other, KEY, mark({ statusDigest: D('7') }))),
      ]);
      assert.equal(results.filter((r) => r !== false).length, 1);
      assert.equal((await store.readBootstrapEvidence(KEY)).length, 1);
      other.close();
      store.close();
    });
  });
});

describe('FV-P4C-2A durable status history — failures, locks and read-only', () => {
  it('26/27/34. a failure inside the transaction rolls everything back', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      const db = raw(path);
      // Fail the bookkeeping half of an insert: the row must not survive without it.
      db.exec(`CREATE TRIGGER inject_meta BEFORE UPDATE ON sovereign_status_history_meta BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;`);
      await rejectsWith(seed(store, KEY, mark()), 'DATABASE');
      assert.deepEqual(db.prepare('SELECT (SELECT COUNT(*) FROM sovereign_status_history) AS n, (SELECT COUNT(*) FROM sovereign_status_bootstrap_evidence) AS e, created_rows FROM sovereign_status_history_meta').get(), { n: 0, e: 0, created_rows: 0 });
      db.exec('DROP TRIGGER inject_meta');
      assert.equal(await seed(store, KEY, mark()), true);
      // Fail an update mid-transaction: the stored mark is unchanged.
      db.exec(`CREATE TRIGGER inject_update BEFORE UPDATE ON sovereign_status_history BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
      await rejectsWith(store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), 'DATABASE');
      db.exec('DROP TRIGGER inject_update');
      assert.deepEqual(await store.read(KEY), { revision: 1, mark: mark() });
      assert.equal(await store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), true);
      db.close();
      store.close();
    });
  });

  it('32. a write lock held elsewhere makes a write fail after the bounded timeout, never succeed silently', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir, { busyTimeoutMs: 100 });
      await seed(store, KEY, mark());
      const holder = raw(path);
      holder.exec('BEGIN IMMEDIATE');
      const started = process.hrtime.bigint();
      await rejectsWith(store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), 'DATABASE');
      assert.ok(process.hrtime.bigint() - started < 5_000_000_000n, 'bounded wait');
      assert.deepEqual(await store.read(KEY), { revision: 1, mark: mark() }, 'WAL readers still see the committed state');
      holder.exec('ROLLBACK');
      holder.close();
      assert.equal(await store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), true);
      store.close();
    });
  });

  it('33. a read-only store reads and refuses every write; a read-only file fails closed', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      store.close();
      const reader = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE, readOnly: true });
      assert.equal((await reader.read(KEY))!.revision, 1);
      await rejectsWith(reader.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })), 'READ_ONLY');
      reader.close();
      await rejectsWith(openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE, create: true, readOnly: true }), 'OPEN_REFUSED');
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o444);
        chmodSync(dir, 0o555);
        try {
          const opened = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE }).catch((error: unknown) => error);
          if (opened instanceof SovereignStatusHistoryStoreError) {
            assert.equal(opened.code, 'OPEN_REFUSED');
          } else {
            const live = opened as SqliteStatusHighWaterMarkStore;
            await assert.rejects(live.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: D('2') })));
            live.close();
          }
        } finally {
          chmodSync(dir, 0o755);
        }
      }
    });
  });
});

describe('FV-P4C-2A durable status history — concurrency', () => {
  it('22/23. concurrent writers on one store: exactly one wins each revision', async () => {
    await withDirectory(async (dir) => {
      const { store } = await created(dir);
      await seed(store, KEY, mark());
      const results = await Promise.all(Array.from({ length: 50 }, (_, i) => store.compareAndSet(KEY, 1, mark({ sequence: 2, statusDigest: (i + 16).toString(16).padStart(64, '0') }))));
      assert.equal(results.filter(Boolean).length, 1);
      const identical = mark({ sequence: 3, statusDigest: D('3') });
      const same = await Promise.all(Array.from({ length: 20 }, () => store.compareAndSet(KEY, 2, identical)));
      assert.equal(same.filter(Boolean).length, 1, 'even identical writes commit once');
      assert.equal((await store.read(KEY))!.revision, 3);
      store.close();
    });
  });

  it('24. independent connections to the same file serialize on it', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      const others = await Promise.all(Array.from({ length: 4 }, () => openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE })));
      const all = [store, ...others];
      for (let revision = 1; revision <= 10; revision += 1) {
        const outcomes = await Promise.all(all.map((s, i) => s.compareAndSet(KEY, revision, mark({ sequence: revision + 1, statusDigest: (revision * 16 + i + 1).toString(16).padStart(64, '0') }))));
        assert.equal(outcomes.filter(Boolean).length, 1, `revision ${revision}`);
        for (const s of all) assert.equal((await s.read(KEY))!.revision, revision + 1, 'a committed write is visible to every connection');
      }
      for (const s of all) s.close();
    });
  });

  it('25. separate processes on the same file: exactly one wins each revision, nothing is lost', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      store.close();
      const script = join(dir, 'writer.cjs');
      writeFileSync(script, WRITER_SCRIPT);
      const adapter = join(__dirname, '..', 'sovereign-status-history', 'index.js');
      for (let revision = 1; revision <= 5; revision += 1) {
        const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => runNode(script, [adapter, path, NAMESPACE, 'cas', String(revision), String(i)])));
        assert.equal(outcomes.filter((out) => out.trim() === 'true').length, 1, `revision ${revision}: ${outcomes.join(',')}`);
      }
      const check = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
      assert.equal((await check.read(KEY))!.revision, 6);
      check.close();
    });
  });
});

describe('FV-P4C-2A durable status history — crash consistency', () => {
  it('a writer killed at arbitrary points leaves a valid, forward-only history', async () => {
    await withDirectory(async (dir) => {
      const { path, store } = await created(dir);
      await seed(store, KEY, mark());
      store.close();
      const script = join(dir, 'writer.cjs');
      writeFileSync(script, WRITER_SCRIPT);
      const adapter = join(__dirname, '..', 'sovereign-status-history', 'index.js');
      let previous = 1;
      for (let round = 0; round < 8; round += 1) {
        const child = spawn(process.execPath, [script, adapter, path, NAMESPACE, 'loop', '0', String(round)], { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, 150 + ((round * 37) % 120)));
        child.kill('SIGKILL');
        await new Promise((resolve) => child.on('exit', resolve));
        const reopened = await openSqliteStatusHighWaterMarkStore(path, { namespace: NAMESPACE });
        const entry = (await reopened.read(KEY))!;
        assert.ok(entry.revision >= previous, `round ${round}: revision never goes back`);
        assert.equal(entry.mark.sequence, entry.revision, 'every committed write is whole: sequence and revision advanced together');
        previous = entry.revision;
        reopened.close();
      }
      const db = raw(path);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      db.close();
      assert.ok(previous > 1, 'the writer committed before being killed');
    });
  });
});

/**
 * A separate process using the compiled adapter. `cas <revision> <id>` makes
 * one attempt and prints its result; `loop` advances the sequence until killed.
 */
const WRITER_SCRIPT = `
const [adapterPath, path, namespace, mode, revisionText, id] = process.argv.slice(2);
const { openSqliteStatusHighWaterMarkStore } = require(adapterPath);
const KEY = { sovereignAssetId: 'sa:test-asset-1', issuer: 'did:example:registrant' };
const mark = (sequence, digestSeed) => ({
  sovereignAssetId: KEY.sovereignAssetId, issuer: KEY.issuer, sequence,
  statusDigest: digestSeed.toString(16).padStart(64, '0'),
  issuedAt: '2026-10-28T11:50:00.000000001Z', currentTermsDigest: 'a'.repeat(64), timeFloor: '2026-10-28T11:50:00.000000001Z',
  withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: '2026-10-28T12:00:00Z',
});
(async () => {
  const store = await openSqliteStatusHighWaterMarkStore(path, { namespace, busyTimeoutMs: 10000 });
  if (mode === 'cas') {
    const revision = Number(revisionText);
    process.stdout.write(String(await store.compareAndSet(KEY, revision, mark(revision + 1, revision * 100 + Number(id) + 1))));
    store.close();
    return;
  }
  for (;;) {
    const entry = await store.read(KEY);
    await store.compareAndSet(KEY, entry.revision, mark(entry.revision + 1, entry.revision + 1000));
  }
})().catch((error) => { process.stderr.write(String(error)); process.exit(2); });
`;

function runNode(script: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`writer exited ${code}: ${err}`))));
  });
}
