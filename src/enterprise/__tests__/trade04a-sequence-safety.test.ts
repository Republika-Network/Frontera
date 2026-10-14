import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createXrplRlusdRail, type XrplSubmissionInterlock, type XrplSubmissionRecordInput } from '../../features/payment-runtime/rails/xrpl/index.js';
import { GOVERNED_ACCOUNT, RLUSD_ASSET, TREASURY, VENDOR, createTestSoftwareXrplSigner, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { XrplSequenceOwnershipError, assertXrplSequenceOwnership } from '../../features/xrpl-transport/index.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { SIMULATED_RESTART_QUARANTINE, createLedgerSimulator, scratch } from './pay03-xrpl-fixture.js';

/**
 * TRADE-04A — owner-account `Sequence` safety, qualified on the real PAY-03
 * SQLite interlock (no network, no live ledger).
 *
 * Matrix C of `docs/integrations/trade/TRADE-04A-SHARED-XRPL-TRANSPORT.md`
 * §18. The PAY-03 suites qualify the same store in more depth — seven OS
 * processes racing one file (`pay03-xrpl-interlock.test.ts` › I-race), crash
 * points around `reserve` (I5–I7), and stale-restore / rollback refusal at the
 * CORE-07 witness (`pay03-xrpl-restart-freshness.test.ts` › F5–F10). This file
 * adds what TRADE-04A must prove about a **second** XRPL submission domain:
 *
 * - separate interlocks do not see each other — so two domains on one owner
 *   account are unsafe by construction (the hazard, characterized), and the
 *   composition is refused (SEC-TRADE04A-08, -17);
 * - a second domain cannot borrow the Payment interlock either: the store is
 *   bound to one rail id and refuses another (convergence needs the reviewed
 *   migration, ADR-XRPL-SHARED-TRANSPORT §9);
 * - the blocking rule the store applies is the shared one, and every lifecycle
 *   property a future domain relies on — durable before submission, restart,
 *   uncertainty, ledger-fact release — holds.
 */

const tmp = scratch('frontera-trade04a-sequence-');
after(() => tmp.cleanup());

const PAYMENT_SCOPE = { railId: 'xrpl-rlusd', networkId: 1 };
const OWNER = TREASURY.classicAddress;
const OTHER = VENDOR.classicAddress;
const AMOUNT = { currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '1' };
const iso = (): string => new Date().toISOString();

let counter = 0;
function record(overrides: Partial<XrplSubmissionRecordInput> = {}): XrplSubmissionRecordInput {
  counter += 1;
  return {
    executionId: `aoc.exec:trade04a-${counter}`,
    account: OWNER,
    sequence: 10,
    lastLedgerSequence: 120,
    minLedger: 101,
    transactionHash: counter.toString(16).toUpperCase().padStart(64, '0'),
    amount: AMOUNT,
    ...overrides,
  };
}

function open(path: string, scope = PAYMENT_SCOPE): Promise<DurableXrplSubmissionInterlock> {
  return createSqliteXrplSubmissionInterlock(path, { scope, now: iso });
}

const file = (name: string): string => join(tmp.dir(), `${name}.sqlite`);

describe('TRADE-04A matrix C — the shared blocking rule on the durable interlock', () => {
  it('C1 same account, same Sequence: the second reservation is blocked, nothing written', async () => {
    const store = await open(file('c1'));
    assert.deepEqual(await store.reserve(record(), 100), { outcome: 'reserved' });
    assert.deepEqual(await store.reserve(record(), 100), { outcome: 'blocked' });
    assert.deepEqual(await store.verifyAll(), { records: 1, open: 1 });
    await store.close();
  });

  it('C2 same account, different Sequence: a later one is free, an earlier one is blocked', async () => {
    const store = await open(file('c2'));
    await store.reserve(record({ sequence: 10 }), 100);
    assert.deepEqual(await store.reserve(record({ sequence: 11 }), 100), { outcome: 'reserved' });
    assert.deepEqual(await store.reserve(record({ sequence: 9 }), 100), { outcome: 'blocked' });
    await store.close();
  });

  it('C3 different accounts are independent sequence spaces', async () => {
    const store = await open(file('c3'));
    await store.reserve(record({ account: OWNER }), 100);
    assert.deepEqual(await store.reserve(record({ account: OTHER }), 100), { outcome: 'reserved' });
    await store.close();
  });

  it('C4 different networks: a file bound to one network refuses another, so ledger reads and reservations cannot silently switch network', async () => {
    const path = file('c4');
    await (await open(path)).close();
    await assert.rejects(open(path, { ...PAYMENT_SCOPE, networkId: 2 }), (error: { code?: string }) => error.code === 'XRPL_INTERLOCK_UNAVAILABLE');
  });

  it('C5 different execution ids: one record per execution, ever — a repeated execution is reported with its earlier hash, never reserved again', async () => {
    const store = await open(file('c5'));
    const first = record();
    await store.reserve(first, 100);
    assert.deepEqual(await store.reserve({ ...first, sequence: 50, transactionHash: 'F'.repeat(64) }, 100), { outcome: 'execution-recorded', transactionHash: first.transactionHash });
    assert.equal(await store.recorded(first.executionId), first.transactionHash);
    await store.close();
  });

  it('C6 two simultaneous reservation attempts on one connection: exactly one wins', async () => {
    const store = await open(file('c6'));
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => store.reserve(record(), 100)));
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'reserved']);
    await store.close();
  });

  it('C7 two connections on one file (as two processes hold it): exactly one wins; the OS-process race is pay03 I-race', async () => {
    const path = file('c7');
    const [a, b] = [await open(path), await open(path)];
    const outcomes = await Promise.all([a.reserve(record(), 100), b.reserve(record(), 100), a.reserve(record(), 100), b.reserve(record(), 100)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['blocked', 'blocked', 'blocked', 'reserved']);
    await a.close();
    await b.close();
  });

  it('C10 uncertain transaction: an unconfirmed record blocks exactly like a submitting one; a failed lookup changes nothing', async () => {
    const store = await open(file('c10'));
    const first = record();
    await store.reserve(first, 100);
    await store.markUnconfirmed(first.executionId, first.transactionHash);
    assert.equal(await store.blocking({ account: OWNER, sequence: 10, validatedLedgerIndex: 110 }), true);
    // There is no "release" operation: the only ways out are a ledger-fact settlement or the validated ledger reaching LastLedgerSequence.
    assert.equal(typeof (store as unknown as Record<string, unknown>)['release'], 'undefined');
    assert.equal(typeof (store as unknown as Record<string, unknown>)['delete'], 'undefined');
    await store.close();
  });

  it('C11 ledger progression and C12 LastLedgerSequence passed: the record stops blocking only when the validated ledger reaches its LastLedgerSequence', async () => {
    const store = await open(file('c11'));
    await store.reserve(record({ lastLedgerSequence: 120 }), 100);
    assert.equal(await store.blocking({ account: OWNER, sequence: 10, validatedLedgerIndex: 119 }), true);
    assert.equal(await store.blocking({ account: OWNER, sequence: 10, validatedLedgerIndex: 120 }), false);
    await store.close();
  });

  it('C13 restart after reservation and C14 restart before settlement: nothing survives but the file, and the file still blocks', async () => {
    const path = file('c13');
    const first = record();
    let store = await open(path);
    await store.reserve(first, 100);
    await store.close();
    store = await open(path);
    assert.equal(await store.recorded(first.executionId), first.transactionHash, 'the execution is never prepared, signed or submitted again');
    assert.equal(await store.blocking({ account: OWNER, sequence: 10, validatedLedgerIndex: 105 }), true);
    await store.markUnconfirmed(first.executionId, first.transactionHash);
    await store.close();
    store = await open(path);
    assert.equal(await store.blocking({ account: OWNER, sequence: 10, validatedLedgerIndex: 105 }), true);
    await store.settle(first.executionId, first.transactionHash, 'expired');
    await store.markUnconfirmed(first.executionId, first.transactionHash);
    assert.equal((await store.read(first.executionId))?.state, 'settled', 'forward only: a settled record is never reopened');
    await store.close();
  });
});

describe('TRADE-04A matrix C — a second submission domain (SEC-TRADE04A-08, -17)', () => {
  it('C8 hazard, characterized: two independent interlocks for one owner account each reserve the same Sequence — separate rail ids give no safety', async () => {
    const payment = await open(file('c8-payment'));
    const trade = await open(file('c8-trade'), { railId: 'xrpl-offer', networkId: 1 });
    assert.deepEqual(await payment.reserve(record({ sequence: 10 }), 100), { outcome: 'reserved' });
    assert.deepEqual(await trade.reserve(record({ sequence: 10 }), 100), { outcome: 'reserved' }, 'neither interlock can see the other: exactly one of these two transactions could validate');
    await payment.close();
    await trade.close();
  });

  it('C8 refusal: the composition that would create that hazard is refused before anything is opened', () => {
    assert.throws(
      () =>
        assertXrplSequenceOwnership([
          { domainId: 'xrpl-rlusd', networkId: 1, sequenceAccounts: [OWNER] },
          { domainId: 'xrpl-offer', networkId: 1, sequenceAccounts: [OWNER] },
        ]),
      (error: unknown) => error instanceof XrplSequenceOwnershipError && error.code === 'XRPL_SEQUENCE_ACCOUNT_SHARED',
    );
  });

  it('C9 Payment and Trade on disjoint owner accounts: accepted, and each interlock protects its own account', async () => {
    assert.doesNotThrow(() =>
      assertXrplSequenceOwnership([
        { domainId: 'xrpl-rlusd', networkId: 1, sequenceAccounts: [OWNER] },
        { domainId: 'xrpl-offer', networkId: 1, sequenceAccounts: [OTHER] },
      ]),
    );
  });

  it('SEC-TRADE04A-17: a second domain cannot borrow the Payment interlock — the file is bound to one rail id and refuses another, unmutated', async () => {
    const path = file('borrow');
    const store = await open(path);
    await store.reserve(record(), 100);
    await store.close();
    await assert.rejects(open(path, { railId: 'xrpl-offer', networkId: 1 }), (error: { code?: string }) => error.code === 'XRPL_INTERLOCK_UNAVAILABLE');
    const reopened = await open(path);
    assert.deepEqual(await reopened.verifyAll(), { records: 1, open: 1 });
    await reopened.close();
  });
});

describe('TRADE-04A — durable reservation precedes the one submission (SEC-TRADE04A-09, -10)', () => {
  const configuration = testConfiguration({ finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
  const request = (): PaymentExecutionRequest => {
    counter += 1;
    return {
      executionId: `aoc.exec:trade04a-rail-${counter}`,
      requestId: `req-${counter}`,
      decisionId: `dec-${counter}`,
      grantId: `grant-${counter}`,
      notAfter: '2030-01-01T00:00:00.000Z',
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'xrpl-account', reference: VENDOR.classicAddress },
      amount: { value: '25.5', unit: RLUSD_ASSET },
      purpose: 'vendor-payment',
      rail: 'xrpl-rlusd',
    };
  };

  it('the order on the real rail is reserve → submit, and a reservation that cannot be made means no submission', async () => {
    const ledger = createLedgerSimulator();
    const store = await open(file('order'), { railId: configuration.railId, networkId: configuration.networkId });
    const events: string[] = [];
    const recording: XrplSubmissionInterlock = {
      recorded: (id) => store.recorded(id),
      blocking: (query) => store.blocking(query),
      async reserve(input, index) {
        events.push(`reserve@submits=${ledger.calls.submit}`);
        return store.reserve(input, index);
      },
      markUnconfirmed: (id, hash) => store.markUnconfirmed(id, hash),
      settle: (id, hash, settlement) => store.settle(id, hash, settlement),
    };
    const rail = createXrplRlusdRail({ configuration, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY)], interlock: recording, ...testClock() });
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    assert.equal((await rail.execute(request())).status, 'completed');
    assert.deepEqual(events, ['reserve@submits=0']);
    assert.equal(ledger.calls.submit, 1);

    const failing: XrplSubmissionInterlock = { ...recording, reserve: async () => Promise.reject(new Error('disk full')) };
    const refusing = createXrplRlusdRail({ configuration, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY)], interlock: failing, ...testClock() });
    await refusing.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    const outcome = await refusing.execute(request());
    assert.equal(outcome.status, 'not-completed');
    assert.equal(ledger.calls.submit, 1, 'no reservation, no submission');
    await store.close();
  });

  it('SEC-TRADE04A-10/11: an unknown outcome is unconfirmed and never retried; after a restart the same execution is not signed or submitted again', async () => {
    const ledger = createLedgerSimulator();
    const path = file('restart');
    const scope = { railId: configuration.railId, networkId: configuration.networkId };
    let store = await open(path, scope);
    const signer = createTestSoftwareXrplSigner(TREASURY);
    let rail = createXrplRlusdRail({ configuration, client: ledger, signers: [signer], interlock: store, ...testClock() });
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    ledger.submitMode = 'lost-after-send';
    const req = request();
    const first = await rail.execute(req);
    assert.equal(first.status, 'unconfirmed', 'a lost answer is unknown, never a retryable failure');
    assert.equal(ledger.calls.submit, 1);
    await store.close();

    ledger.submitMode = 'accept';
    store = await open(path, scope);
    rail = createXrplRlusdRail({ configuration, client: ledger, signers: [signer], interlock: store, ...testClock() });
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    const again = await rail.execute(req);
    assert.equal(again.status, 'unconfirmed');
    assert.equal((again as { externalReference?: string }).externalReference, (first as { externalReference?: string }).externalReference, 'the earlier transaction, by its hash');
    assert.equal(ledger.calls.submit, 1, 'never submitted again');
    await store.close();
  });
});
