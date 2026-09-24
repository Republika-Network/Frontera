import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { deriveGovernedActionRequestId } from '../governed-action/identifiers.js';
import {
  MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX,
  createInMemoryMppBusinessOperationStore,
  createSqliteMppBusinessOperationStore,
  isMppBusinessOperationStoreError,
  type MppBusinessOperationStore,
} from '../mpp-business-operation-store/index.js';
import { computeContentDigest } from '../mpp-challenge/protocol.js';
import { chargeRequest, encodeJcs, storeEntry as entry, type StoreTerms as Terms } from './mpp-challenge-support.js';

/**
 * P13 — the MPP business-operation store, held to one contract in memory and
 * in SQLite: one operation per (organization, principal, businessOperationId),
 * same semantics idempotent, different semantics a conflict, append-only
 * challenge history in store-assigned sequence, verify-first reads, and
 * corruption that is never read as "no previous operation".
 */

const ORG = 'org-a';
const PRINCIPAL = 'principal-a';
const AT = '2026-09-24T12:00:00.000Z';
const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-mpp-bop-'));
  directories.push(directory);
  return join(directory, 'mpp-business-operations.sqlite');
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.parse(AT) + (tick += 1)).toISOString();
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return isMppBusinessOperationStoreError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

const A = { organizationId: ORG };

const PROVIDERS: readonly (readonly [string, () => Promise<MppBusinessOperationStore>])[] = [
  ['memory', async () => createInMemoryMppBusinessOperationStore({ now: clock() })],
  ['sqlite', async () => createSqliteMppBusinessOperationStore(freshPath(), { now: clock() })],
];

for (const [provider, open] of PROVIDERS) {
  describe(`P13 business-operation store (${provider}) — §70 / §118 one operation, same semantics idempotent, different a conflict`, () => {
    it('creates once, then returns the same operation unchanged — never re-dated', async () => {
      const store = await open();
      const first = await store.record(A, entry());
      assert.equal(first.operationOutcome, 'created');
      assert.equal(first.challengeOutcome, 'appended');
      assert.equal(first.challenge.challengeSequence, 1);
      const again = await store.record(A, { ...entry(), operation: { ...entry().operation, createdAt: '2026-09-24T13:00:00.000Z' } });
      assert.equal(again.operationOutcome, 'existing');
      assert.equal(again.challengeOutcome, 'existing');
      assert.deepEqual(again.operation, first.operation);
      assert.equal(again.operation.createdAt, AT);
      await store.close();
    });

    const mutations: readonly (readonly [string, Terms])[] = [
      ['amount 10 → 10.01', { value: '10.01' }],
      ['asset USD → USDC', { unit: 'USDC' }],
      ['counterparty merchant-a → merchant-b', { counterparty: 'merchant-b' }],
      ['resource', { resource: 'resource-report-2' }],
      ['action', { action: 'payment.other' }],
      ['protected request body digest', { httpMethod: 'POST', contentDigest: computeContentDigest('body-b') }],
      ['external id', { externalId: 'order-2' }],
      ['protected request method', { httpMethod: 'DELETE' }],
    ];
    for (const [label, terms] of mutations) {
      it(`conflicts on ${label}; the first operation stands and nothing is written`, async () => {
        const store = await open();
        await store.record(A, entry({ httpMethod: terms.contentDigest !== undefined ? 'POST' : 'GET', ...(terms.contentDigest !== undefined ? { contentDigest: computeContentDigest('body-a') } : {}) }));
        assert.equal(await code(store.record(A, entry(terms, { id: 'ch-2' }))), 'MPP_BUSINESS_OPERATION_CONFLICT');
        const state = await store.readOperation(A, PRINCIPAL, 'op-1');
        assert.equal(state?.challenges.length, 1, 'the conflicting challenge was not appended');
        await store.close();
      });
    }

    it('refuses an input whose semantic digest, key or request id does not derive from its terms', async () => {
      const store = await open();
      const base = entry();
      assert.equal(await code(store.record(A, { ...base, operation: { ...base.operation, amount: { value: '11', unit: 'USD' } } })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID');
      assert.equal(await code(store.record(A, { ...base, operation: { ...base.operation, governedIdempotencyKey: 'op-1' } })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID');
      assert.equal(await code(store.record(A, { ...base, operation: { ...base.operation, governedRequestId: 'aoc.gar:forged' } })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID');
      assert.equal(await code(store.record(A, { ...base, challenge: { ...base.challenge, challengeDigest: base.operation.businessSemanticDigest } })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID');
      assert.equal(await code(store.record(A, { ...base, operation: { ...base.operation, amount: { value: 10, unit: 'USD' } as never } })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID', 'a number amount is never accepted');
      assert.equal(await code(store.record(A, { ...base, operation: { ...base.operation, status: 'paid' } as never })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID', 'no outcome column exists');
      assert.equal(await code(store.record(A, { ...base, challenge: { ...base.challenge, credential: 'secret' } as never })), 'MPP_BUSINESS_OPERATION_INPUT_INVALID', 'no credential column exists');
      assert.equal(await store.readOperation(A, PRINCIPAL, 'op-1'), undefined);
      await store.close();
    });
  });

  describe(`P13 business-operation store (${provider}) — §71 / §72 / §73 append-only challenge history`, () => {
    it('appends refreshed challenges in store-assigned sequence; the same challenge is idempotent; the latest is the highest sequence', async () => {
      const store = await open();
      await store.record(A, entry({}, { id: 'ch-a', expires: '2026-09-24T12:05:00Z' }));
      const refreshed = await store.record(A, entry({}, { id: 'ch-b', expires: '2026-09-24T12:10:00Z', opaque: encodeJcs({ pi: 'pi_2' }) }));
      assert.equal(refreshed.operationOutcome, 'existing');
      assert.equal(refreshed.challenge.challengeSequence, 2);
      const replayed = await store.record(A, entry({}, { id: 'ch-a', expires: '2026-09-24T12:05:00Z' }));
      assert.equal(replayed.challengeOutcome, 'existing');
      assert.equal(replayed.challenge.challengeSequence, 1);
      const described = await store.record(A, entry({}, { id: 'ch-a', expires: '2026-09-24T12:05:00Z', description: 'different words' }));
      assert.equal(described.challengeOutcome, 'existing', 'description is not security-significant');
      const state = await store.readOperation(A, PRINCIPAL, 'op-1');
      assert.deepEqual(state?.challenges.map((challenge) => challenge.id), ['ch-a', 'ch-b']);
      const byRequest = await store.readByGovernedRequestId(A, entry().operation.governedRequestId);
      assert.equal(byRequest?.latestChallenge.id, 'ch-b');
      assert.equal(byRequest?.latestChallenge.opaque, encodeJcs({ pi: 'pi_2' }));
      await store.close();
    });

    it(`refuses a ${String(MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX + 1)}th distinct challenge without evicting any`, async () => {
      const store = await open();
      for (let index = 0; index < MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX; index += 1) await store.record(A, entry({}, { id: `ch-${String(index)}` }));
      assert.equal(await code(store.record(A, entry({}, { id: 'one-too-many' }))), 'MPP_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL');
      assert.equal((await store.readOperation(A, PRINCIPAL, 'op-1'))?.challenges.length, MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX);
      await store.close();
    });

    it('§112 the same challenge under two business operations is two operations — no global challenge dedupe', async () => {
      const store = await open();
      await store.record(A, entry({ businessOperationId: 'op-1' }, { id: 'same' }));
      const second = await store.record(A, entry({ businessOperationId: 'op-2' }, { id: 'same' }));
      assert.equal(second.operationOutcome, 'created');
      assert.notEqual(second.operation.governedRequestId, entry({ businessOperationId: 'op-1' }).operation.governedRequestId);
      await store.close();
    });
  });

  describe(`P13 business-operation store (${provider}) — §191 / §192 / §217 tenant and principal isolation`, () => {
    it('the same businessOperationId under two principals is two operations with two request ids', async () => {
      const store = await open();
      const a = await store.record(A, entry({ principalId: 'principal-a' }));
      const b = await store.record(A, entry({ principalId: 'principal-b', value: '11' }));
      assert.equal(b.operationOutcome, 'created', 'principal B cannot be pre-claimed by principal A');
      assert.notEqual(a.operation.governedRequestId, b.operation.governedRequestId);
      await store.close();
    });

    it('another organization reads nothing and writes nothing; the same text in two organizations never collides', async () => {
      const store = await open();
      await store.record(A, entry());
      const other = { organizationId: 'org-b' };
      assert.equal(await store.readOperation(other, PRINCIPAL, 'op-1'), undefined);
      assert.equal(await store.readByGovernedRequestId(other, entry().operation.governedRequestId), undefined);
      assert.equal(await code(store.record(other, entry())), 'MPP_BUSINESS_OPERATION_TENANT_VIOLATION');
      const inB = await store.record(other, entry({ organizationId: 'org-b' }));
      assert.equal(inB.operationOutcome, 'created');
      assert.notEqual(inB.operation.governedRequestId, entry().operation.governedRequestId);
      assert.equal(await code(store.readOperation({ organizationId: ORG, system: true } as never, PRINCIPAL, 'op-1')), 'MPP_BUSINESS_OPERATION_TENANT_VIOLATION');
      await store.close();
    });
  });

  describe(`P13 business-operation store (${provider}) — §137 / §193 exact money`, () => {
    it('9007199254740993.01 survives the store byte for byte', async () => {
      const store = await open();
      await store.record(A, entry({ value: '9007199254740993.01' }));
      const state = await store.readOperation(A, PRINCIPAL, 'op-1');
      assert.equal(state?.operation.amount.value, '9007199254740993.01');
      assert.equal(typeof state?.operation.amount.value, 'string');
      await store.close();
    });
  });
}

describe('P13 business-operation store (sqlite) — §116 / §117 / §119 / §120 durability, immutability and corruption', () => {
  it('WAL, synchronous FULL, and an unknown schema version refused before anything is created', async () => {
    const path = freshPath();
    const store = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    await store.close();
    const db = new Database(path);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.prepare(`INSERT INTO mpp_business_operation_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.mpp-business-operation-store.schema.v9', 'current', ?)`).run(AT);
    db.close();
    assert.equal(await code(createSqliteMppBusinessOperationStore(path, { now: clock() })), 'MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE');

    const future = freshPath();
    const raw = new Database(future);
    raw.exec(`CREATE TABLE mpp_business_operation_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
    raw.prepare(`INSERT INTO mpp_business_operation_store_versions (schema_version, migration_state, recorded_at) VALUES ('future', 'current', ?)`).run(AT);
    raw.close();
    assert.equal(await code(createSqliteMppBusinessOperationStore(future, { now: clock() })), 'MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE');
    const check = new Database(future, { readonly: true });
    assert.equal(check.prepare(`SELECT name FROM sqlite_master WHERE name = 'mpp_business_operations'`).get(), undefined, 'the unknown file was not mutated');
    check.close();
    assert.equal(MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, 'aoc.mpp-business-operation-store.schema.v1');
  });

  it('triggers refuse UPDATE and DELETE on both tables', async () => {
    const path = freshPath();
    const store = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    await store.record(A, entry());
    await store.close();
    const db = new Database(path);
    for (const statement of [
      `UPDATE mpp_business_operations SET amount_value = '11'`,
      `DELETE FROM mpp_business_operations`,
      `UPDATE mpp_challenge_instances SET expires = '2099-01-01T00:00:00Z'`,
      `DELETE FROM mpp_challenge_instances`,
    ]) {
      assert.throws(() => db.exec(statement), /immutable/, statement);
    }
    db.close();
  });

  it('§136 / §194 / §195 restart: the operation, its challenge and its request binding survive; a refreshed challenge appends after restart', async () => {
    const path = freshPath();
    const first = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    const created = await first.record(A, entry({ value: '9007199254740993.01' }, { id: 'ch-a' }));
    await first.close();
    const reopened = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    const before = await reopened.readByGovernedRequestId(A, created.operation.governedRequestId);
    assert.deepEqual(before?.operation, created.operation);
    assert.deepEqual(before?.latestChallenge, created.challenge);
    const refreshed = await reopened.record(A, entry({ value: '9007199254740993.01' }, { id: 'ch-b', expires: '2026-09-24T12:10:00Z' }));
    assert.equal(refreshed.operationOutcome, 'existing');
    assert.equal(refreshed.operation.governedRequestId, created.operation.governedRequestId);
    assert.equal(refreshed.operation.governedIdempotencyKey, created.operation.governedIdempotencyKey);
    const after = await reopened.readByGovernedRequestId(A, created.operation.governedRequestId);
    assert.equal(after?.latestChallenge.id, 'ch-b');
    assert.deepEqual((await reopened.readOperation(A, PRINCIPAL, 'op-1'))?.challenges.map((challenge) => challenge.id), ['ch-a', 'ch-b'], 'challenge A remains auditable');
    assert.equal(created.operation.governedRequestId, deriveGovernedActionRequestId({ organizationId: ORG, principalId: PRINCIPAL, idempotencyKey: created.operation.governedIdempotencyKey }));
    await reopened.close();
  });

  /** Rewrites one column behind the store's back: triggers dropped, the edit made, triggers left dropped. */
  function tamper(path: string, sql: string): void {
    const db = new Database(path);
    for (const name of ['mpp_business_operations_append_only_update', 'mpp_challenge_instances_append_only_update', 'mpp_business_operations_append_only_delete', 'mpp_challenge_instances_append_only_delete']) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(sql);
    db.close();
  }

  const tamperings: readonly (readonly [string, string])[] = [
    ['the operation amount', `UPDATE mpp_business_operations SET amount_value = '1'`],
    ['the operation counterparty', `UPDATE mpp_business_operations SET counterparty = 'merchant-b'`],
    ['the operation record digest', `UPDATE mpp_business_operations SET record_digest = 'sha256:${'0'.repeat(64)}'`],
    ['a challenge request', `UPDATE mpp_challenge_instances SET request = '${encodeJcs(chargeRequest({ amount: '1' }))}'`],
    ['a challenge sequence (to hide or reorder it)', `UPDATE mpp_challenge_instances SET challenge_sequence = 7`],
    ['a challenge expiry', `UPDATE mpp_challenge_instances SET expires = '2099-01-01T00:00:00Z'`],
    ['a challenge semantic digest (re-pointing it)', `UPDATE mpp_challenge_instances SET business_semantic_digest = 'sha256:${'1'.repeat(64)}'`],
    // An integer written into a TEXT column is coerced back to the same text by SQLite affinity; a BLOB is not text.
    ['the amount as a non-text value', `UPDATE mpp_business_operations SET amount_value = X'3130'`],
    ['the amount as a non-canonical decimal', `UPDATE mpp_business_operations SET amount_value = 10.0`],
    ['every challenge deleted', `DELETE FROM mpp_challenge_instances`],
  ];
  for (const [label, sql] of tamperings) {
    it(`§120 / §121 tampering with ${label} is corruption — never "no previous operation", never a second operation`, async () => {
      const path = freshPath();
      const store = await createSqliteMppBusinessOperationStore(path, { now: clock() });
      await store.record(A, entry());
      await store.close();
      tamper(path, sql);
      const reopened = await createSqliteMppBusinessOperationStore(path, { now: clock() });
      assert.equal(await code(reopened.readOperation(A, PRINCIPAL, 'op-1')), 'MPP_BUSINESS_OPERATION_CORRUPT');
      assert.equal(await code(reopened.readByGovernedRequestId(A, entry().operation.governedRequestId)), 'MPP_BUSINESS_OPERATION_CORRUPT');
      assert.equal(await code(reopened.record(A, entry({}, { id: 'ch-new' }))), 'MPP_BUSINESS_OPERATION_CORRUPT', 'a write over corrupt state is refused');
      await reopened.close();
    });
  }

  it('a deleted operation row with its challenges left behind is corruption, not absence', async () => {
    const path = freshPath();
    const store = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    await store.record(A, entry());
    await store.close();
    tamper(path, `DELETE FROM mpp_business_operations`);
    const reopened = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    assert.equal(await code(reopened.record(A, entry())), 'MPP_BUSINESS_OPERATION_CORRUPT');
    await reopened.close();
  });

  it('persists no secret-shaped column: the schema has no credential, authorization, key, signature, wallet or status column', async () => {
    const path = freshPath();
    const store = await createSqliteMppBusinessOperationStore(path, { now: clock() });
    await store.close();
    const db = new Database(path, { readonly: true });
    const columns = ['mpp_business_operations', 'mpp_challenge_instances'].flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
    db.close();
    for (const column of columns) assert.equal(/credential|authorization|secret|private|signature|wallet|token|cookie|status|paid|settle|outcome|url/i.test(column), false, column);
  });
});
