import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { derivePaymentBusinessOperationKey, derivePaymentBusinessOperationRequestId } from '../payment-protocol-ingress/business-operation.js';
import { createInMemoryPaymentBusinessOperationStore } from '../payment-protocol-ingress/in-memory-payment-business-operation-store.js';
import { createSqlitePaymentBusinessOperationStore } from '../payment-protocol-ingress/sqlite-payment-business-operation-store.js';
import { PAYMENT_CHALLENGES_PER_OPERATION_MAX, type PaymentBusinessOperationStore } from '../payment-protocol-ingress/store-contracts.js';
import { isPaymentBusinessOperationStoreError } from '../payment-protocol-ingress/store-errors.js';
import { buildPaymentBusinessOperationRecord } from '../payment-protocol-ingress/store-integrity.js';
import { STORE_ORG, STORE_PRINCIPAL, storeEntry } from './pay04-protocol-support.js';

/**
 * PAY-04 layers D and F — the payment business-operation store, both
 * implementations, held to one contract: one operation per scope, one
 * operation per challenge identity, immutable rows, verify-first reads, fail
 * closed — and, for SQLite, durability across restart, refusal of tampered
 * or foreign-schema files, and no secret column.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-pay04-bop-'));
  directories.push(directory);
  return join(directory, 'payment-business-operations.sqlite');
}

let tick = 0;
const clock = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isPaymentBusinessOperationStoreError(error) ? error.code : `error:${String(error)}`;
  }
}

const ctx = { organizationId: STORE_ORG };

const implementations: readonly { readonly name: string; readonly open: () => Promise<PaymentBusinessOperationStore> }[] = [
  { name: 'memory', open: async () => createInMemoryPaymentBusinessOperationStore({ now: clock }) },
  { name: 'sqlite', open: () => createSqlitePaymentBusinessOperationStore(freshPath(), { now: clock }) },
];

for (const { name, open } of implementations) {
  describe(`PAY-04 D (${name}) — business-operation idempotency`, () => {
    it('I1: same operation, identical terms, same challenge → one operation, one challenge, existing/existing', async () => {
      const store = await open();
      const first = await store.record(ctx, storeEntry());
      const second = await store.record(ctx, storeEntry());
      assert.deepEqual([first.operationOutcome, first.challengeOutcome, second.operationOutcome, second.challengeOutcome], ['created', 'appended', 'existing', 'existing']);
      assert.equal(second.operation.recordDigest, first.operation.recordDigest, 'never re-dated');
      const state = await store.readOperation(ctx, STORE_PRINCIPAL, 'bop-1');
      assert.equal(state?.challenges.length, 1);
      await store.close();
    });

    it('I6 / M28 / M31: a refreshed challenge with the same semantics is history under the same operation, never a new one', async () => {
      const store = await open();
      await store.record(ctx, storeEntry({}, { id: 'ch-a', expires: '2026-09-24T12:05:00Z' }));
      const refreshed = await store.record(ctx, storeEntry({}, { id: 'ch-b', expires: '2026-09-24T12:10:00Z' }));
      const again = await store.record(ctx, storeEntry({}, { id: 'ch-c' }));
      assert.deepEqual([refreshed.operationOutcome, refreshed.challengeOutcome, refreshed.challenge.challengeSequence], ['existing', 'appended', 2]);
      assert.equal(again.challenge.challengeSequence, 3);
      assert.equal(again.operation.governedRequestId, derivePaymentBusinessOperationRequestId({ organizationId: STORE_ORG, principalId: STORE_PRINCIPAL, businessOperationId: 'bop-1' }));
      const state = await store.readOperation(ctx, STORE_PRINCIPAL, 'bop-1');
      assert.deepEqual(state?.challenges.map((challenge) => challenge.fields['id']), ['ch-a', 'ch-b', 'ch-c']);
      const latest = await store.readByGovernedRequestId(ctx, again.operation.governedRequestId);
      assert.equal(latest?.latestChallenge.fields['id'], 'ch-c');
      await store.close();
    });

    for (const [label, changed] of [
      ['I2 amount', { value: '11' }],
      ['I3 asset', { unit: 'EUR' }],
      ['I4 destination', { destination: 'vendor-9999' }],
      ['I5 protected resource', { target: 'merchant:report-43' }],
      ['I5 protected body', { contentDigest: `sha-256=:${Buffer.alloc(32, 9).toString('base64')}:` }],
    ] as const) {
      it(`${label} / M27: same operation, changed terms → conflict; the original stands, nothing written`, async () => {
        const store = await open();
        await store.record(ctx, storeEntry());
        assert.equal(await code(store.record(ctx, storeEntry(changed, { id: 'ch-2' }))), 'PAYMENT_BUSINESS_OPERATION_CONFLICT');
        const state = await store.readOperation(ctx, STORE_PRINCIPAL, 'bop-1');
        assert.equal(state?.operation.terms.amount.value, '10');
        assert.equal(state?.challenges.length, 1);
        await store.close();
      });
    }

    it('M30: the same challenge under a different business operation is refused — one challenge pays for one operation', async () => {
      const store = await open();
      await store.record(ctx, storeEntry({ businessOperationId: 'bop-1' }, { id: 'ch-shared' }));
      assert.equal(await code(store.record(ctx, storeEntry({ businessOperationId: 'bop-2' }, { id: 'ch-shared' }))), 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT');
      assert.equal(await code(store.record(ctx, storeEntry({ businessOperationId: 'bop-3', principalId: 'principal-b' }, { id: 'ch-shared' }))), 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT', 'across principals too');
      assert.equal(await store.readOperation(ctx, STORE_PRINCIPAL, 'bop-2'), undefined, 'the refused operation was not created');
      // Another organization is another namespace.
      assert.equal((await store.record({ organizationId: 'org-b' }, storeEntry({ organizationId: 'org-b' }, { id: 'ch-shared' }))).operationOutcome, 'created');
      await store.close();
    });

    it('a challenge identity re-presented with different exact fields is a conflict, not a new instance', async () => {
      const store = await open();
      await store.record(ctx, storeEntry({}, { id: 'ch-1', expires: '2026-09-24T12:05:00Z' }));
      assert.equal(await code(store.record(ctx, storeEntry({}, { id: 'ch-1', expires: '2026-09-24T12:09:00Z' }))), 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT');
      await store.close();
    });

    it('scope: principals and organizations never share an operation', async () => {
      const store = await open();
      const a = await store.record(ctx, storeEntry({}, { id: 'x1' }));
      const b = await store.record(ctx, storeEntry({ principalId: 'principal-b', value: '99' }, { id: 'x2' }));
      assert.equal(b.operationOutcome, 'created');
      assert.notEqual(a.operation.governedRequestId, b.operation.governedRequestId);
      assert.equal(await code(store.readOperation({ organizationId: 'org-b' }, STORE_PRINCIPAL, 'bop-1')), 'ok');
      assert.equal(await store.readOperation({ organizationId: 'org-b' }, STORE_PRINCIPAL, 'bop-1'), undefined);
      assert.equal(await code(store.record({ organizationId: 'org-b' }, storeEntry())), 'PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION');
      assert.equal(await code(store.readOperation({ organizationId: STORE_ORG, system: true } as never, STORE_PRINCIPAL, 'bop-1')), 'PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION');
      await store.close();
    });

    it('a full challenge history refuses a further challenge without evicting one', async () => {
      const store = await open();
      for (let index = 0; index < PAYMENT_CHALLENGES_PER_OPERATION_MAX; index += 1) await store.record(ctx, storeEntry({}, { id: `ch-${index}` }));
      assert.equal(await code(store.record(ctx, storeEntry({}, { id: 'one-more' }))), 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL');
      assert.equal((await store.readOperation(ctx, STORE_PRINCIPAL, 'bop-1'))?.challenges.length, PAYMENT_CHALLENGES_PER_OPERATION_MAX);
      await store.close();
    });

    it('refuses an input whose digests or derivations do not recompute — a caller cannot store a key its scope does not derive', async () => {
      const store = await open();
      const entry = storeEntry();
      const forged = [
        { ...entry, operation: { ...entry.operation, governedIdempotencyKey: 'pay-key-1' } },
        { ...entry, operation: { ...entry.operation, governedRequestId: derivePaymentBusinessOperationRequestId({ organizationId: STORE_ORG, principalId: STORE_PRINCIPAL, businessOperationId: 'other' }) } },
        { ...entry, operation: { ...entry.operation, terms: { ...entry.operation.terms, amount: { value: '11', unit: 'USD' } } } },
        { ...entry, operation: { ...entry.operation, terms: { ...entry.operation.terms, amount: { value: 10, unit: 'USD' } } } },
        { ...entry, operation: { ...entry.operation, status: 'retry-requested' } },
        { ...entry, challenge: { ...entry.challenge, fields: { ...entry.challenge.fields, id: 'other' } } },
        { ...entry, challenge: { ...entry.challenge, fields: { ...entry.challenge.fields, credential: 'secret' } } },
        { ...entry, challenge: { ...entry.challenge, businessOperationId: 'bop-2' } },
      ];
      for (const input of forged) assert.equal(await code(store.record(ctx, input as never)), 'PAYMENT_BUSINESS_OPERATION_INPUT_INVALID');
      assert.equal(derivePaymentBusinessOperationKey({ organizationId: STORE_ORG, principalId: STORE_PRINCIPAL, businessOperationId: 'bop-1' }), entry.operation.governedIdempotencyKey);
      await store.close();
    });
  });
}

describe('PAY-04 F (sqlite) — durability, restart, tamper and schema', () => {
  it('I10 / M36: a restart preserves the operation identity and history; a refresh after restart appends', async () => {
    const path = freshPath();
    const first = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    const created = await first.record(ctx, storeEntry({}, { id: 'before' }));
    await first.close();
    const reopened = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    const after = await reopened.record(ctx, storeEntry({}, { id: 'after' }));
    assert.deepEqual([after.operationOutcome, after.challenge.challengeSequence], ['existing', 2]);
    assert.equal(after.operation.governedRequestId, created.operation.governedRequestId);
    assert.equal(await code(reopened.record(ctx, storeEntry({ value: '11' }, { id: 'later' }))), 'PAYMENT_BUSINESS_OPERATION_CONFLICT', 'conflicts survive a restart');
    assert.deepEqual(await reopened.verifyAll(), { operations: 1, challenges: 2 });
    await reopened.close();
  });

  it('rows are immutable: UPDATE and DELETE are refused by triggers', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await store.record(ctx, storeEntry());
    await store.close();
    const db = new Database(path);
    try {
      assert.throws(() => db.prepare(`UPDATE payment_business_operations SET amount_value = '1'`).run(), /immutable/);
      assert.throws(() => db.prepare(`DELETE FROM payment_business_operations`).run(), /immutable/);
      assert.throws(() => db.prepare(`UPDATE payment_protocol_challenges SET fields = '{}'`).run(), /immutable/);
      assert.throws(() => db.prepare(`DELETE FROM payment_protocol_challenges`).run(), /immutable/);
    } finally {
      db.close();
    }
  });

  it('a tampered row is corrupt — refused at open and on read, never repaired and never read as absent', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await store.record(ctx, storeEntry());
    await store.close();
    const db = new Database(path);
    db.exec(`DROP TRIGGER payment_business_operations_append_only_update; UPDATE payment_business_operations SET amount_value = '1';`);
    db.close();
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(path, { now: clock })), 'PAYMENT_BUSINESS_OPERATION_CORRUPT');
  });

  it('a consistently re-sealed row whose governed key its scope does not derive is corrupt — derivations are recomputed, not trusted', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    const recorded = await store.record(ctx, storeEntry());
    await store.close();
    // A privileged writer re-seals the row: a foreign governed key, and a record digest recomputed over it.
    const forged = buildPaymentBusinessOperationRecord({ ...storeEntry().operation, governedIdempotencyKey: 'pay-key-chosen-by-writer' }, recorded.operation.recordedAt);
    const db = new Database(path);
    db.exec(`DROP TRIGGER payment_business_operations_append_only_update;`);
    db.prepare(`UPDATE payment_business_operations SET governed_idempotency_key = ?, record_digest = ?`).run(forged.governedIdempotencyKey, forged.recordDigest);
    db.close();
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(path, { now: clock })), 'PAYMENT_BUSINESS_OPERATION_CORRUPT');
  });

  it('an orphan challenge row is corrupt', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await store.record(ctx, storeEntry());
    await store.close();
    const db = new Database(path);
    db.exec(`DROP TRIGGER payment_business_operations_append_only_delete; DELETE FROM payment_business_operations;`);
    db.close();
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(path, { now: clock })), 'PAYMENT_BUSINESS_OPERATION_CORRUPT');
  });

  it('a file under another schema version, or tables with no version, is refused unopened and unmutated', async () => {
    const foreign = freshPath();
    const db = new Database(foreign);
    db.exec(`CREATE TABLE payment_business_operation_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);
      INSERT INTO payment_business_operation_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.payment-business-operation-store.schema.v2', 'current', 'x');`);
    db.close();
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(foreign, { now: clock })), 'PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE');
    const check = new Database(foreign, { readonly: true });
    assert.equal(check.prepare(`SELECT name FROM sqlite_master WHERE name = 'payment_business_operations'`).get(), undefined, 'nothing was created in it');
    check.close();

    const unversioned = freshPath();
    const raw = new Database(unversioned);
    raw.exec(`CREATE TABLE payment_business_operations (x TEXT)`);
    raw.close();
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(unversioned, { now: clock })), 'PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE');
    writeFileSync(join(unversioned, '..', 'not-a-db.sqlite'), 'not sqlite');
    assert.equal(await code(createSqlitePaymentBusinessOperationStore(join(unversioned, '..', 'not-a-db.sqlite'), { now: clock })), 'PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE');
  });

  it('M38: no credential, secret, status or retry column exists; money is TEXT; challenge fields hold public challenge data only', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await store.record(ctx, storeEntry());
    await store.close();
    const db = new Database(path, { readonly: true });
    try {
      const columns = ['payment_business_operations', 'payment_protocol_challenges'].flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).map((column) => ({ table, ...column })));
      for (const column of columns) assert.equal(/secret|password|credential|token|key_material|private|seed|signature|status|outcome|retry|paid|settled|authoriz/i.test(column.name), false, `${column.table}.${column.name}`);
      assert.equal(columns.find((column) => column.name === 'amount_value')?.type, 'TEXT');
      const row = db.prepare(`SELECT amount_value, typeof(amount_value) AS kind FROM payment_business_operations`).get() as { amount_value: unknown; kind: string };
      assert.deepEqual(row, { amount_value: '10', kind: 'text' });
    } finally {
      db.close();
    }
  });

  it('I11 / M35 (unanchored store level): restoring an older copy loses history — the derived identity of every operation is unchanged (the anchored store refuses the copy: pay04-rollback-safety.test.ts)', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await store.record(ctx, storeEntry({}, { id: 'a' }));
    await store.close();
    const backup = `${path}.backup`;
    copyFileSync(path, backup);
    const later = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    await later.record(ctx, storeEntry({}, { id: 'b' }));
    await later.record(ctx, storeEntry({ businessOperationId: 'bop-2' }, { id: 'c' }));
    await later.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    copyFileSync(backup, path);
    const restored = await createSqlitePaymentBusinessOperationStore(path, { now: clock });
    assert.equal(await restored.readOperation(ctx, STORE_PRINCIPAL, 'bop-2'), undefined, 'the stale copy forgot bop-2');
    // Re-presenting it records it again — under the same derived governed key and request id it always had.
    const again = await restored.record(ctx, storeEntry({ businessOperationId: 'bop-2' }, { id: 'c' }));
    assert.equal(again.operationOutcome, 'created');
    assert.equal(again.operation.governedIdempotencyKey, derivePaymentBusinessOperationKey({ organizationId: STORE_ORG, principalId: STORE_PRINCIPAL, businessOperationId: 'bop-2' }));
    await restored.close();
  });
});
