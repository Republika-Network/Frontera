import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import { PAYMENT_REFUND_REFUSALS, type PaymentExecutionRequest, type PaymentRailResult } from '../../features/payment-runtime/index.js';
import { isAuthorityStateFreshnessError } from '../authority-state-freshness/index.js';
import type { ExecutionOutcomeReader } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionState } from '../execution-resolution-store/contracts.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import type { ExecutionResolutionReader } from '../execution-resolution-store/resolution-store.js';
import { isPaymentSettlementStoreError } from '../payment-settlement/errors.js';
import {
  createInMemoryPaymentRefundLedger,
  createPaymentRefundService,
  createSqlitePaymentRefundLedger,
  type PaymentRefundLedger,
  type PaymentRefundService,
  type PaymentSettlementService,
} from '../payment-settlement/index.js';
import { boundaryFor, closeAllWitnesses, startWitness } from './core07-freshness-fixture.js';
import { ALLOWED_INTENT, DENIED_ACTOR, identityFor } from './governed-action-support.js';
import { BINDING, GOVERNED_ACCOUNT, IDENTITY, NOW, ORG, TEST_ASSETS, governed, payment, paymentWorld, resolveByP12, scratchDirectory, settlementHarness, type PaymentWorld } from './pay05-settlement-support.js';

/**
 * PAY-05 — refunds (F1 – F12, C6 – C8).
 *
 * A refund is a NEW governed payment, explicitly linked to a settled original
 * and bounded by its refundable balance — never a deletion, reversal, rewrite,
 * negative amount or P7 release of the original, and never authorized by the
 * original's settlement.
 *
 * In this world the refund flows from the same governed account to the
 * original payer's refund beneficiary under the trusted counterparty mapping
 * (`payer-refunds-0001`); the fixture Kernel governs one account, so the
 * mapping names it — the mapping is trusted composition, not an inference.
 */

const scratch = scratchDirectory('aoc-pay05-refunds-');
after(async () => {
  await closeAllWitnesses();
  scratch.cleanup();
});

const BENEFICIARY = { kind: 'account', reference: 'payer-refunds-0001' } as const;
const ENVELOPE = { assertedContext: ALLOWED_INTENT.assertedContext };

interface RefundWorld extends PaymentWorld {
  readonly settlements: PaymentSettlementService;
  readonly service: PaymentRefundService;
  readonly ledger: PaymentRefundLedger;
  readonly originalExecutionId: string;
  readonly railBehaviour: { next?: ((request: PaymentExecutionRequest) => PaymentRailResult) | undefined };
}

async function refundWorld(options: { readonly ledger?: PaymentRefundLedger; readonly original?: string; readonly settle?: boolean } = {}): Promise<RefundWorld> {
  const railBehaviour: RefundWorld['railBehaviour'] = {};
  const pw = paymentWorld({
    behaviour: (request) => {
      const scripted = railBehaviour.next;
      return scripted !== undefined ? scripted(request as PaymentExecutionRequest) : { status: 'completed', externalReference: `ref-${request.executionId.slice(-12)}` };
    },
  });
  const original = await pw.world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: options.original ?? '100', unit: 'USD' } })));
  assert.equal(original.status, 'executed', JSON.stringify(original));
  const harness = settlementHarness(pw.world);
  if (options.settle !== false) assert.equal((await harness.service.verifySettlement({ organizationId: ORG, executionId: original.executionId! })).outcome, 'settled');
  const ledger = options.ledger ?? createInMemoryPaymentRefundLedger({ now: () => NOW });
  const service = createPaymentRefundService({
    organizationId: ORG,
    settlements: harness.service,
    ledger,
    counterparties: ({ original: settled }) => (settled.payment.destination.reference === 'vendor-4471' ? { source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY } : undefined),
    binding: BINDING,
    assets: TEST_ASSETS,
    orchestrator: pw.world.orchestrator,
    governance: pw.world.rawStore,
    outcomes: pw.world.outcomes,
    resolutions: harness.resolutions,
    ...(ledger.providerKind === 'memory' ? { allowVolatileLedger: true as const } : {}),
  });
  return { ...pw, settlements: harness.service, service, ledger, originalExecutionId: original.executionId!, railBehaviour };
}

function refund(world: RefundWorld, value: string, refundKey: string, unit = 'USD') {
  return world.service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey, amount: { value, unit }, envelope: ENVELOPE });
}

describe('PAY-05 F1 – F5 — a refund is a new governed payment against a settled original', () => {
  it('F1: a refund of a payment that is not settled (P11 completed only) is refused; nothing is reserved or governed', async () => {
    const world = await refundWorld({ settle: false });
    const kernelBefore = world.world.kernelRequests.length;
    assert.deepEqual(await refund(world, '10', 'refund-1'), { outcome: 'original-not-settled' });
    assert.equal(world.world.kernelRequests.length, kernelBefore);
    assert.equal(world.rail.callCount, 1);
  });

  it('F2: a valid refund is governed through the existing path as its own payment — its own request, decision, grant, P11 — with purpose refund', async () => {
    const world = await refundWorld();
    const kernelBefore = world.world.kernelRequests.length;
    const result = await refund(world, '30', 'refund-1');
    assert.equal(result.outcome, 'governed', JSON.stringify(result));
    if (result.outcome !== 'governed') return;
    assert.equal(result.result.status, 'executed');
    assert.equal(world.world.kernelRequests.length, kernelBefore + 1, 'the Kernel decided the refund');
    assert.notEqual(result.result.requestId, (await world.world.outcomes.read({ organizationId: ORG }, world.originalExecutionId))?.attempt.requestId);
    const sent = world.rail.requests[1]!;
    assert.equal(sent.purpose, 'refund');
    assert.deepEqual(sent.destination, BENEFICIARY);
    assert.deepEqual(sent.amount, { value: '30', unit: 'USD' });
    assert.equal(sent.reference, `refund-${result.refundOperationId.slice('payment-refund:'.length)}`, 'a reference derived from the refund operation, not the original');
    assert.deepEqual(result.balance.remaining, { value: '70', unit: 'USD' });
  });

  it('F3: settlement does not authorize a refund — a principal without authority is denied by the Kernel, nothing is sent, and the denial later releases the reservation', async () => {
    const world = await refundWorld();
    const result = await world.service.requestRefund(identityFor({ actorId: DENIED_ACTOR }), { originalExecutionId: world.originalExecutionId, refundKey: 'refund-denied', amount: { value: '40', unit: 'USD' }, envelope: ENVELOPE });
    assert.equal(result.outcome, 'governed');
    if (result.outcome !== 'governed') return;
    assert.equal(result.result.status, 'denied', JSON.stringify(result.result));
    assert.equal(world.rail.callCount, 1, 'no refund reached the rail');
    assert.equal((await world.ledger.readBalance(ORG, (await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }))!.settlementId, { value: '100', unit: 'USD' })).remaining.value, '60', 'counted until proven not to move money');
    const reconciled = await world.service.reconcileRefund(result.refundOperationId);
    assert.equal(reconciled.outcome, 'released');
    assert.equal(reconciled.outcome === 'released' && reconciled.basis, 'decision-denied');
    assert.equal((await world.service.refundBalance(world.originalExecutionId))?.balance.remaining.value, '100');
  });

  it('F4: a refund larger than the original settled amount is refused before governance', async () => {
    const world = await refundWorld();
    const kernelBefore = world.world.kernelRequests.length;
    const result = await refund(world, '100.01', 'refund-big');
    assert.deepEqual(result.outcome === 'refused' && result.refusal, PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE);
    assert.equal(world.world.kernelRequests.length, kernelBefore);
  });

  it('F5: a refund in another asset is refused (no FX)', async () => {
    const world = await refundWorld();
    const result = await refund(world, '10', 'refund-eur', 'EUR');
    assert.deepEqual(result.outcome === 'refused' && result.refusal, PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_ASSET_MISMATCH);
    assert.equal(world.rail.callCount, 1);
  });

  it('a negative, zero or non-canonical refund amount is refused; a refund of a refund is not offered; an unmapped counterparty refuses', async () => {
    const world = await refundWorld();
    for (const value of ['-5', '0', '1e1']) assert.equal((await refund(world, value, `refund-bad-${value}`)).outcome, 'refused', value);
    const first = await refund(world, '10', 'refund-of-refund-source');
    assert.equal(first.outcome === 'governed' && first.result.status, 'executed');
    if (first.outcome !== 'governed') return;
    assert.equal((await world.settlements.verifySettlement({ organizationId: ORG, executionId: first.result.executionId! })).outcome, 'settled');
    assert.deepEqual(await world.service.requestRefund(IDENTITY, { originalExecutionId: first.result.executionId!, refundKey: 'nested', amount: { value: '1', unit: 'USD' }, envelope: ENVELOPE }), { outcome: 'original-is-refund' });
    const other = await world.world.orchestrator.govern(IDENTITY, governed(payment({ destination: { kind: 'account', reference: 'vendor-0000' } })));
    assert.equal((await world.settlements.verifySettlement({ organizationId: ORG, executionId: other.executionId! })).outcome, 'settled');
    assert.deepEqual(await world.service.requestRefund(IDENTITY, { originalExecutionId: other.executionId!, refundKey: 'unmapped', amount: { value: '1', unit: 'USD' }, envelope: ENVELOPE }), { outcome: 'counterparty-unresolved' });
  });

  it('a caller-supplied original reference is never trusted: an unknown execution, another organization, garbage — all not settled', async () => {
    const world = await refundWorld();
    for (const originalExecutionId of ['aoc.exec:does-not-exist', '', 'x y', world.originalExecutionId + 'x']) {
      assert.deepEqual(await world.service.requestRefund(IDENTITY, { originalExecutionId, refundKey: 'k', amount: { value: '1', unit: 'USD' }, envelope: ENVELOPE }), { outcome: 'original-not-settled' });
    }
  });
});

describe('PAY-05 F6 – F12 — partial refunds, concurrency, uncertainty, immutability, rollback', () => {
  it('F6 / F10 / F11: two partial refunds (30, then 70) both settle with their own receipts; a third over the limit is refused; the original stays 100 settled, receipt unchanged', async () => {
    const world = await refundWorld();
    const originalReceipt = await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId });
    const r1 = await refund(world, '30', 'refund-1');
    const r2 = await refund(world, '70', 'refund-2');
    const r3 = await refund(world, '0.01', 'refund-3');
    assert.equal(r1.outcome === 'governed' && r1.result.status, 'executed');
    assert.equal(r2.outcome === 'governed' && r2.result.status, 'executed');
    assert.deepEqual(r3.outcome === 'refused' && r3.refusal, PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE);
    assert.equal(world.rail.callCount, 3, 'the original and two refunds; never the third');
    const receipts = [];
    for (const r of [r1, r2]) {
      if (r.outcome !== 'governed') continue;
      const settled = await world.settlements.verifySettlement({ organizationId: ORG, executionId: r.result.executionId! });
      assert.equal(settled.outcome, 'settled');
      if (settled.outcome === 'settled') {
        assert.equal(settled.settlement.payment.purpose, 'refund');
        receipts.push(settled.receipt.receiptId);
      }
    }
    assert.equal(new Set([...receipts, originalReceipt?.receiptId]).size, 3, 'every settled refund has its own receipt');
    assert.deepEqual(await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }), originalReceipt, 'F11: the original receipt is immutable');
    const balance = await world.service.refundBalance(world.originalExecutionId);
    assert.deepEqual(balance?.original.payment.amount, { value: '100', unit: 'USD' }, 'the original is still 100 settled');
    assert.deepEqual(balance?.balance.counted, { value: '100', unit: 'USD' });
    assert.deepEqual(balance?.balance.remaining, { value: '0', unit: 'USD' });
  });

  it('F7: concurrent refunds that together exceed the balance — at most the allowable total is ever reserved or sent', async () => {
    const world = await refundWorld();
    const results = await Promise.all(['a', 'b', 'c'].map((key) => refund(world, '60', `refund-race-${key}`)));
    assert.equal(results.filter((result) => result.outcome === 'governed').length, 1, JSON.stringify(results.map((result) => result.outcome)));
    assert.equal(results.filter((result) => result.outcome === 'refused').length, 2);
    assert.equal(world.rail.callCount, 2);
  });

  it('idempotency: the same refund key replays the same refund (no second payment); the same key with another amount is a conflict', async () => {
    const world = await refundWorld();
    const first = await refund(world, '25', 'refund-same');
    const again = await refund(world, '25', 'refund-same');
    assert.equal(first.outcome === 'governed' && again.outcome === 'governed', true);
    if (first.outcome === 'governed' && again.outcome === 'governed') {
      assert.equal(again.reservation, 'existing');
      assert.equal(again.result.status === 'executed' && again.result.replayed, true);
      assert.equal(again.result.executionId, first.result.executionId);
    }
    assert.equal(world.rail.callCount, 2);
    assert.deepEqual(await refund(world, '26', 'refund-same'), { outcome: 'conflict' });
  });

  it('another principal under the same refund key is a separate refund operation — each counts against the one balance', async () => {
    const world = await refundWorld();
    const mine = await refund(world, '60', 'shared-key');
    const theirs = await world.service.requestRefund(identityFor({ principalId: 'principal-other' }), { originalExecutionId: world.originalExecutionId, refundKey: 'shared-key', amount: { value: '60', unit: 'USD' }, envelope: ENVELOPE });
    assert.equal(mine.outcome, 'governed');
    assert.deepEqual(theirs.outcome === 'refused' && theirs.refusal, PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE, 'never the same reservation, never a second payment under it');
  });

  it('F8 / C7: an unconfirmed refund does NOT restore the balance; replaying it never resends', async () => {
    const world = await refundWorld();
    world.railBehaviour.next = () => ({ status: 'unconfirmed', externalReference: 'ref-refund-uncertain' });
    const uncertain = await refund(world, '50', 'refund-uncertain');
    assert.equal(uncertain.outcome === 'governed' && uncertain.result.status, 'execution_unconfirmed');
    if (uncertain.outcome !== 'governed') return;
    assert.deepEqual(await world.service.reconcileRefund(uncertain.refundOperationId), { outcome: 'refund-pending' });
    assert.equal((await world.service.refundBalance(world.originalExecutionId))?.balance.remaining.value, '50');
    const replay = await refund(world, '50', 'refund-uncertain');
    assert.equal(replay.outcome === 'governed' && replay.result.status, 'execution_unconfirmed');
    assert.equal(world.rail.callCount, 2, 'no automatic retry of an uncertain refund');
    assert.deepEqual((await refund(world, '50.01', 'refund-on-top')).outcome, 'refused');
  });

  it('F9: when P12 proves the refund did not complete, the reservation is released and that balance becomes refundable again — under a new refund key', async () => {
    const world = await refundWorld();
    world.railBehaviour.next = () => ({ status: 'unconfirmed' });
    const uncertain = await refund(world, '80', 'refund-p12');
    assert.equal(uncertain.outcome, 'governed');
    if (uncertain.outcome !== 'governed') return;
    world.railBehaviour.next = undefined;
    // P12 resolves the refund's execution as not completed (an authority's definitive answer).
    const { createInMemoryExecutionResolutionStore } = await import('../execution-resolution-store/in-memory-execution-resolution-store.js');
    const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
    await resolveByP12(world.world, resolutions, uncertain.result.executionId!, { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
    const reconciler = createPaymentRefundService({
      organizationId: ORG,
      settlements: world.settlements,
      ledger: world.ledger,
      counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
      binding: BINDING,
      assets: TEST_ASSETS,
      orchestrator: world.world.orchestrator,
      governance: world.world.rawStore,
      outcomes: world.world.outcomes,
      resolutions,
      allowVolatileLedger: true,
    });
    const released = await reconciler.reconcileRefund(uncertain.refundOperationId);
    assert.equal(released.outcome === 'released' && released.basis, 'resolution-confirmed-not-completed');
    assert.equal((await reconciler.refundBalance(world.originalExecutionId))?.balance.remaining.value, '100');
    assert.deepEqual(await reconciler.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-p12', amount: { value: '80', unit: 'USD' }, envelope: ENVELOPE }), { outcome: 'closed', refundOperationId: uncertain.refundOperationId }, 'a released operation is closed; it never governs again');
    const fresh = await reconciler.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-p12-second', amount: { value: '80', unit: 'USD' }, envelope: ENVELOPE });
    assert.equal(fresh.outcome === 'governed' && fresh.result.status, 'executed');
  });

  it('a refund the provider definitively refused releases on its P11 observation', async () => {
    const world = await refundWorld();
    world.railBehaviour.next = () => ({ status: 'not-completed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
    const failed = await refund(world, '90', 'refund-rejected');
    assert.equal(failed.outcome === 'governed' && failed.result.status, 'execution_failed');
    if (failed.outcome !== 'governed') return;
    const released = await world.service.reconcileRefund(failed.refundOperationId);
    assert.equal(released.outcome === 'released' && released.basis, 'provider-confirmed-not-completed');
    assert.deepEqual(await world.service.reconcileRefund(failed.refundOperationId), { outcome: 'already-released', reservation: (released as { reservation: unknown }).reservation });
  });

  it('a completed refund stays counted (its money left)', async () => {
    const world = await refundWorld();
    const done = await refund(world, '45', 'refund-done');
    assert.equal(done.outcome, 'governed');
    if (done.outcome !== 'governed') return;
    assert.deepEqual(await world.service.reconcileRefund(done.refundOperationId), { outcome: 'refund-completed', refundExecutionId: done.result.executionId });
    assert.equal((await world.service.refundBalance(world.originalExecutionId))?.balance.remaining.value, '55');
  });

  it('C6: a crash after the reservation and before governance — the reservation stays counted; the same refund key later governs it exactly once', async () => {
    const world = await refundWorld();
    const crashing = createPaymentRefundService({
      organizationId: ORG,
      settlements: world.settlements,
      ledger: world.ledger,
      counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
      binding: BINDING,
      assets: TEST_ASSETS,
      orchestrator: { govern: async () => { throw new Error('process crashed before governance'); } },
      governance: world.world.rawStore,
      outcomes: world.world.outcomes,
      resolutions: settlementHarness(world.world).resolutions,
      allowVolatileLedger: true,
    });
    await assert.rejects(crashing.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-crash', amount: { value: '40', unit: 'USD' }, envelope: ENVELOPE }));
    assert.equal((await world.service.refundBalance(world.originalExecutionId))?.balance.remaining.value, '60', 'conservatively counted');
    assert.deepEqual(await world.service.reconcileRefund((await import('../payment-settlement/index.js')).paymentRefundOperationId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, originalSettlementId: (await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }))!.settlementId, refundKey: 'refund-crash' })), { outcome: 'refund-pending' }, 'never decided: not provably unmoved');
    const resumed = await refund(world, '40', 'refund-crash');
    assert.equal(resumed.outcome === 'governed' && resumed.reservation, 'existing');
    assert.equal(resumed.outcome === 'governed' && resumed.result.status, 'executed');
    assert.equal(world.rail.callCount, 2, 'governed exactly once');
  });

  it('refunds never touch the original: its P11 record and settlement are byte-identical after refunds', async () => {
    const world = await refundWorld();
    const p11 = await world.world.outcomes.read({ organizationId: ORG }, world.originalExecutionId);
    const settled = await world.settlements.readSettlement({ organizationId: ORG, executionId: world.originalExecutionId });
    await refund(world, '30', 'r1');
    await refund(world, '20', 'r2');
    assert.deepEqual(await world.world.outcomes.read({ organizationId: ORG }, world.originalExecutionId), p11);
    assert.deepEqual(await world.settlements.readSettlement({ organizationId: ORG, executionId: world.originalExecutionId }), settled);
  });

  it('a volatile refund accounting is refused unless composed on purpose for tests', async () => {
    const world = await refundWorld();
    assert.throws(
      () =>
        createPaymentRefundService({
          organizationId: ORG,
          settlements: world.settlements,
          ledger: createInMemoryPaymentRefundLedger({ now: () => NOW }),
          counterparties: () => undefined,
          binding: BINDING,
          assets: TEST_ASSETS,
          orchestrator: world.world.orchestrator,
          governance: world.world.rawStore,
          outcomes: world.world.outcomes,
          resolutions: settlementHarness(world.world).resolutions,
        }),
      /volatile/,
    );
  });
});

describe('PAY-05 F7 / F12 — durable, CORE-07-anchored refund accounting', () => {
  it('F7 (durable): two ledger connections racing over one file and one witness — at most the allowable total is reserved', async () => {
    const witness = await startWitness();
    const dir = scratch.dir();
    const path = join(dir, 'refunds.sqlite');
    const first = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const second = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const world = await refundWorld({ ledger: first });
    const settlementId = (await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }))!.settlementId;
    const base = { organizationId: ORG, principalId: 'principal-pmfreak', originalSettlementId: settlementId, originalExecutionId: world.originalExecutionId, originalReceiptId: 'payment-receipt:x', originalAmount: { value: '100', unit: 'USD' }, amount: { value: '60', unit: 'USD' } };
    const results = await Promise.all([
      first.reserve({ ...base, refundKey: 'race-1', refundRequestId: 'req-race-1' }),
      second.reserve({ ...base, refundKey: 'race-2', refundRequestId: 'req-race-2' }),
      first.reserve({ ...base, refundKey: 'race-3', refundRequestId: 'req-race-3' }),
      second.reserve({ ...base, refundKey: 'race-4', refundRequestId: 'req-race-4' }),
    ]);
    assert.equal(results.filter((result) => result.outcome === 'reserved').length, 1, JSON.stringify(results.map((result) => result.outcome)));
    assert.equal(results.filter((result) => result.outcome === 'refused').length, 3);
    assert.equal((await first.readBalance(ORG, settlementId, { value: '100', unit: 'USD' })).remaining.value, '40');
    assert.equal((await second.readBalance(ORG, settlementId, { value: '100', unit: 'USD' })).remaining.value, '40');
    await first.close();
    await second.close();
  });

  it('F12: a stale restore of the refund accounting cannot recreate refundable balance — refused at open by the witness', async () => {
    const witness = await startWitness();
    const dir = scratch.dir();
    const path = join(dir, 'refunds.sqlite');
    const backup = join(dir, 'refunds.before.sqlite');
    let ledger = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    await ledger.close();
    copyFileSync(path, backup);
    ledger = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const world = await refundWorld({ ledger });
    const r1 = await refund(world, '90', 'refund-before-restore');
    assert.equal(r1.outcome === 'governed' && r1.result.status, 'executed');
    await ledger.close();

    // The operator restores yesterday's refund file: the 90 refunded would read as refundable again.
    copyFileSync(backup, path);
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    await assert.rejects(
      createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }),
      (error) => isAuthorityStateFreshnessError(error) && error.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED',
    );
    // A lost file (an empty one) is refused too: the witness holds the slot beyond genesis.
    rmSync(path);
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    await assert.rejects(createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }), (error) => isAuthorityStateFreshnessError(error));
    assert.equal(world.rail.callCount, 2, 'no second refund ever reached the rail');
  });

  it('the refund accounting is never opened without its witness, and refuses while the witness is unreachable', async () => {
    const dir = scratch.dir();
    await assert.rejects(createSqlitePaymentRefundLedger(join(dir, 'refunds.sqlite'), { now: () => NOW, freshness: undefined as never }), /never opened without its freshness boundary/);
    const witness = await startWitness();
    const ledger = await createSqlitePaymentRefundLedger(join(dir, 'refunds.sqlite'), { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    await witness.close();
    await assert.rejects(
      ledger.reserve({ organizationId: ORG, principalId: 'p', refundKey: 'k', originalSettlementId: 'payment-settlement:x', originalExecutionId: 'e', originalReceiptId: 'payment-receipt:x', originalAmount: { value: '100', unit: 'USD' }, amount: { value: '1', unit: 'USD' }, refundRequestId: 'r' }),
      (error) => isAuthorityStateFreshnessError(error),
      'no reservation, so no refund, without the witness',
    );
    await ledger.close();
  });

  it('a tampered refund entry is corrupt — refused, never repaired', async () => {
    const witness = await startWitness();
    const dir = scratch.dir();
    const path = join(dir, 'refunds.sqlite');
    const ledger = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    await ledger.reserve({ organizationId: ORG, principalId: 'p', refundKey: 'k', originalSettlementId: 'payment-settlement:x', originalExecutionId: 'e', originalReceiptId: 'payment-receipt:x', originalAmount: { value: '100', unit: 'USD' }, amount: { value: '90', unit: 'USD' }, refundRequestId: 'r' });
    await ledger.close();
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path);
    assert.throws(() => db.prepare('DELETE FROM payment_refund_entries').run(), /append-only/);
    db.exec('DROP TRIGGER payment_refund_entries_append_only_update');
    const row = db.prepare('SELECT entry_json FROM payment_refund_entries').get() as { entry_json: string };
    db.prepare('UPDATE payment_refund_entries SET entry_json = ?').run(row.entry_json.replace('"value":"90"', '"value":"9"'));
    db.close();
    await assert.rejects(createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }), /failed verification/);
  });
});

// ── PAY-05 hardening ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A reconciler over the same world and ledger, reading P11 and P12 through the given readers. */
function reconcilerOver(world: RefundWorld, readers: { readonly outcomes?: ExecutionOutcomeReader; readonly resolutions: ExecutionResolutionReader }): PaymentRefundService {
  return createPaymentRefundService({
    organizationId: ORG,
    settlements: world.settlements,
    ledger: world.ledger,
    counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
    binding: BINDING,
    assets: TEST_ASSETS,
    orchestrator: world.world.orchestrator,
    governance: world.world.rawStore,
    outcomes: readers.outcomes ?? world.world.outcomes,
    resolutions: readers.resolutions,
    ...(world.ledger.providerKind === 'memory' ? { allowVolatileLedger: true as const } : {}),
  });
}

const remaining = async (world: RefundWorld): Promise<string | undefined> => (await world.service.refundBalance(world.originalExecutionId))?.balance.remaining.value;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

/**
 * An unconfirmed refund of 80 (P11 observation A) and the real P12 state that resolves it as not completed, bound to
 * A — the canonical, valid case every RREL variant below perturbs one binding of.
 */
async function unconfirmedRefundWithP12(): Promise<{ readonly world: RefundWorld; readonly refundOperationId: string; readonly executionId: string; readonly state: ExecutionResolutionState }> {
  const world = await refundWorld();
  world.railBehaviour.next = () => ({ status: 'unconfirmed', externalReference: 'ref-refund-a' });
  const uncertain = await refund(world, '80', 'refund-rrel');
  assert.equal(uncertain.outcome === 'governed' && uncertain.result.status, 'execution_unconfirmed');
  if (uncertain.outcome !== 'governed') throw new Error('unreachable');
  world.railBehaviour.next = undefined;
  const executionId = uncertain.result.executionId!;
  const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
  await resolveByP12(world.world, resolutions, executionId, { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
  const state = await resolutions.read({ organizationId: ORG }, executionId);
  assert.equal(state?.resolution?.basisObservationDigest, (await world.world.outcomes.read({ organizationId: ORG }, executionId))?.terminal?.observationDigest, 'the real resolution is bound to observation A');
  return { world, refundOperationId: uncertain.refundOperationId, executionId, state: state! };
}

const fixed = (state: ExecutionResolutionState | undefined): ExecutionResolutionReader => ({ read: async () => state });

describe('PAY-05 hardening RREL-1 – RREL-6 — a refund is released only on the canonical P12 binding', () => {
  it('RREL-1: P11 unconfirmed observation A + P12 confirmed-not-completed bound to A → released; the balance returns', async () => {
    const { world, refundOperationId, state } = await unconfirmedRefundWithP12();
    assert.equal(await remaining(world), '20');
    const released = await reconcilerOver(world, { resolutions: fixed(state) }).reconcileRefund(refundOperationId);
    assert.equal(released.outcome === 'released' && released.basis, 'resolution-confirmed-not-completed');
    assert.equal(released.outcome === 'released' && released.reservation.release?.basisReference, state.resolution!.resolutionDigest);
    assert.equal(await remaining(world), '100');
  });

  it('RREL-2: P11 now holds observation B, P12 is bound to the OLD observation A → not released; the balance stays consumed', async () => {
    const { world, refundOperationId, executionId, state } = await unconfirmedRefundWithP12();
    const observationB: ExecutionOutcomeReader = {
      read: async (context, id) => {
        const record = await world.world.outcomes.read(context, id);
        return id === executionId && record?.terminal !== undefined ? { ...record, terminal: { ...record.terminal, observationDigest: OTHER_DIGEST } } : record;
      },
    };
    assert.equal(await remaining(world), '20');
    assert.deepEqual(await reconcilerOver(world, { outcomes: observationB, resolutions: fixed(state) }).reconcileRefund(refundOperationId), { outcome: 'basis-unavailable' });
    assert.equal(await remaining(world), '20');
  });

  it('RREL-3: the same attempt digest with a wrong basisObservationDigest → not released', async () => {
    const { world, refundOperationId, state } = await unconfirmedRefundWithP12();
    for (const resolution of [{ ...state.resolution!, basisObservationDigest: OTHER_DIGEST }, (({ basisObservationDigest: _dropped, ...rest }) => rest)(state.resolution!)]) {
      assert.deepEqual(await reconcilerOver(world, { resolutions: fixed({ ...state, resolution }) }).reconcileRefund(refundOperationId), { outcome: 'basis-unavailable' });
      assert.equal(await remaining(world), '20');
    }
  });

  it('RREL-4: valid resolution content with a missing or different binding → not released', async () => {
    const { world, refundOperationId, state } = await unconfirmedRefundWithP12();
    for (const broken of [
      { resolution: state.resolution! },
      { binding: { ...state.binding!, bindingDigest: OTHER_DIGEST }, resolution: state.resolution! },
      { binding: { ...state.binding!, attemptDigest: OTHER_DIGEST }, resolution: state.resolution! },
      { binding: { ...state.binding!, authorityId: 'test.other' }, resolution: state.resolution! },
      { ...state, resolution: { ...state.resolution!, attemptDigest: OTHER_DIGEST } },
      { ...state, resolution: { ...state.resolution!, providerRef: 'ref-refund-other' } },
    ] as ExecutionResolutionState[]) {
      assert.deepEqual(await reconcilerOver(world, { resolutions: fixed(broken) }).reconcileRefund(refundOperationId), { outcome: 'basis-unavailable' }, JSON.stringify(Object.keys(broken)));
      assert.equal(await remaining(world), '20');
    }
  });

  it('RREL-5: the current P11 is confirmed-completed; a stale P12 not-completed is never consulted → refund-completed, no release', async () => {
    const world = await refundWorld();
    const done = await refund(world, '45', 'refund-completed-p11');
    assert.equal(done.outcome === 'governed' && done.result.status, 'executed');
    if (done.outcome !== 'governed') return;
    const outcome = await world.world.outcomes.read({ organizationId: ORG }, done.result.executionId!);
    let consulted = 0;
    const stale: ExecutionResolutionReader = {
      read: async () => {
        consulted += 1;
        return { resolution: { attemptDigest: outcome!.attempt.attemptDigest, basisObservationDigest: outcome!.terminal!.observationDigest, certainty: 'confirmed-not-completed', resolutionDigest: OTHER_DIGEST } } as unknown as ExecutionResolutionState;
      },
    };
    assert.equal(await remaining(world), '55');
    assert.deepEqual(await reconcilerOver(world, { resolutions: stale }).reconcileRefund(done.refundOperationId), { outcome: 'refund-completed', refundExecutionId: done.result.executionId });
    assert.equal(consulted, 0);
    assert.equal(await remaining(world), '55');
  });

  it('RREL-6: an inconsistent P12 state never releases — the refundable balance stays consumed and a new refund over it is refused', async () => {
    const { world, refundOperationId, state } = await unconfirmedRefundWithP12();
    const inconsistent = reconcilerOver(world, { resolutions: fixed({ ...state, resolution: { ...state.resolution!, basisObservationDigest: OTHER_DIGEST } }) });
    for (const _attempt of [1, 2, 3]) assert.deepEqual(await inconsistent.reconcileRefund(refundOperationId), { outcome: 'basis-unavailable' });
    assert.equal((await world.ledger.readOperation(ORG, refundOperationId))?.release, undefined);
    assert.equal(await remaining(world), '20');
    const over = await refund(world, '20.01', 'refund-over-stale');
    assert.deepEqual(over.outcome === 'refused' && over.refusal, PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE);
  });
});

describe('PAY-05 hardening COMP-1 – COMP-4 — the refund is compiled before any balance is reserved', () => {
  /** The world's ledger and orchestrator, observed: every reserve and govern, in order. */
  type Orchestrator = Parameters<typeof createPaymentRefundService>[0]['orchestrator'];
  function observed(world: RefundWorld, orchestrator: Orchestrator = world.world.orchestrator): { readonly service: PaymentRefundService; readonly calls: string[] } {
    const calls: string[] = [];
    const ledger: PaymentRefundLedger = { ...world.ledger, reserve: (input) => (calls.push('reserve'), world.ledger.reserve(input)) };
    const service = createPaymentRefundService({
      organizationId: ORG,
      settlements: world.settlements,
      ledger,
      counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
      binding: BINDING,
      assets: TEST_ASSETS,
      orchestrator: { govern: (identity, intent) => (calls.push('govern'), orchestrator.govern(identity, intent)) },
      governance: world.world.rawStore,
      outcomes: world.world.outcomes,
      resolutions: settlementHarness(world.world).resolutions,
      allowVolatileLedger: true,
    });
    return { service, calls };
  }

  it('COMP-1: a malformed envelope throws before anything is reserved — zero reservations, nothing governed, the key stays usable', async () => {
    const world = await refundWorld();
    const { service, calls } = observed(world);
    const kernelBefore = world.world.kernelRequests.length;
    for (const envelope of ['not-an-envelope', 42, { assertedContext: ALLOWED_INTENT.assertedContext, unexpected: true }]) {
      await assert.rejects(service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-comp', amount: { value: '60', unit: 'USD' }, envelope: envelope as never }));
    }
    assert.deepEqual(calls, [], 'never reserved, never governed');
    assert.equal(world.world.kernelRequests.length, kernelBefore);
    assert.equal(await remaining(world), '100', 'nothing stranded');
    const valid = await service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-comp', amount: { value: '60', unit: 'USD' }, envelope: ENVELOPE });
    assert.equal(valid.outcome === 'governed' && valid.reservation, 'reserved', 'the same key is fresh: it was never reserved');
  });

  it('COMP-2: an invalid compile-time assertedContext throws before anything is reserved', async () => {
    const world = await refundWorld();
    const { service, calls } = observed(world);
    for (const assertedContext of [['not', 'an', 'object'], 'text', null]) {
      await assert.rejects(service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-comp-2', amount: { value: '60', unit: 'USD' }, envelope: { assertedContext } as never }));
    }
    assert.deepEqual(calls, []);
    assert.equal(await remaining(world), '100');
  });

  it('COMP-3: a valid compile reserves, then governs exactly once — in that order', async () => {
    const world = await refundWorld();
    const { service, calls } = observed(world);
    const result = await service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-comp-3', amount: { value: '30', unit: 'USD' }, envelope: ENVELOPE });
    assert.equal(result.outcome === 'governed' && result.result.status, 'executed');
    assert.deepEqual(calls, ['reserve', 'govern']);
    assert.equal(world.rail.callCount, 2);
  });

  it('COMP-4: a crash after the reservation and before governance stays conservatively reserved (no automatic release)', async () => {
    const world = await refundWorld();
    const { service, calls } = observed(world, { govern: async () => { throw new Error('process crashed before governance'); } });
    await assert.rejects(service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-comp-4', amount: { value: '40', unit: 'USD' }, envelope: ENVELOPE }));
    assert.deepEqual(calls, ['reserve', 'govern']);
    assert.equal(await remaining(world), '60');
    const operation = (await world.ledger.readOperation(ORG, (await import('../payment-settlement/index.js')).paymentRefundOperationId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, originalSettlementId: (await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }))!.settlementId, refundKey: 'refund-comp-4' })))!;
    assert.deepEqual(await world.service.reconcileRefund(operation.refundOperationId), { outcome: 'refund-pending' });
    assert.equal(await remaining(world), '60');
  });
});

describe('PAY-05 hardening LEDGER-TAMPER — local integrity is re-proven under a witnessed, cached head', () => {
  type Entry = Record<string, unknown> & { amount?: { value: string; unit: string } };

  /**
   * A durable, witnessed ledger with history: refund 80 executed (seq 1), refund 10 provider-rejected (seq 2) and
   * released on that basis (seq 3), refund 5 executed (seq 4, the tail). Remaining 15. Read once, so this process has
   * verified and cached the head. Then one row is rewritten underneath it — its entry_digest, chain_digest and the
   * digests embedded in entry_json all kept, key columns rewritten consistently with the new content.
   */
  async function tampered(rewrite: (entries: Map<number, Entry>, ids: { readonly tail: string }) => { readonly sequence: number; readonly entry: Entry }) {
    const witness = await startWitness();
    const path = join(scratch.dir(), 'refunds.sqlite');
    const ledger = await createSqlitePaymentRefundLedger(path, { now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const world = await refundWorld({ ledger });
    assert.equal((await refund(world, '80', 'refund-80')).outcome, 'governed');
    world.railBehaviour.next = () => ({ status: 'not-completed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
    const rejected = await refund(world, '10', 'refund-10');
    world.railBehaviour.next = undefined;
    assert.equal(rejected.outcome === 'governed' && (await world.service.reconcileRefund(rejected.refundOperationId)).outcome, 'released');
    const tail = await refund(world, '5', 'refund-5');
    assert.equal(tail.outcome === 'governed' && tail.result.status, 'executed');
    assert.equal(await remaining(world), '15', 'read once: the verified head is cached');
    assert.equal((await ledger.verifyAll()).entries, 4);
    assert.equal(await remaining(world), '15');

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path);
    db.exec('DROP TRIGGER payment_refund_entries_append_only_update');
    const rows = db.prepare('SELECT sequence, entry_json, entry_digest, chain_digest FROM payment_refund_entries ORDER BY sequence').all() as { sequence: number; entry_json: string; entry_digest: string; chain_digest: string }[];
    const entries = new Map(rows.map((row) => [row.sequence, JSON.parse(row.entry_json) as Entry]));
    const { sequence, entry } = rewrite(entries, { tail: (tail as { refundOperationId: string }).refundOperationId });
    const before = rows.find((row) => row.sequence === sequence)!;
    db.prepare('UPDATE payment_refund_entries SET entry_json = ?, refund_operation_id = ?, original_settlement_id = ? WHERE sequence = ?').run(JSON.stringify(entry), entry['refundOperationId'], entry['kind'] === 'reserve' ? entry['originalSettlementId'] : null, sequence);
    const after = db.prepare('SELECT entry_digest, chain_digest FROM payment_refund_entries WHERE sequence = ?').get(sequence) as { entry_digest: string; chain_digest: string };
    db.close();
    assert.deepEqual(after, { entry_digest: before.entry_digest, chain_digest: before.chain_digest }, 'every digest string preserved');
    assert.equal(entry['entryDigest'], before.entry_digest);
    return { world, ledger, rejected, witness };
  }

  async function assertRefused(context: Awaited<ReturnType<typeof tampered>>): Promise<void> {
    const { world, ledger, rejected } = context;
    const corrupt = (error: unknown): boolean => isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_CORRUPT';
    const kernelBefore = world.world.kernelRequests.length;
    const railBefore = world.rail.callCount;
    await assert.rejects(world.service.refundBalance(world.originalExecutionId), corrupt, 'never a balance read from rewritten content');
    const settlementId = (await world.settlements.receipt({ organizationId: ORG, executionId: world.originalExecutionId }))!.settlementId;
    await assert.rejects(ledger.readBalance(ORG, settlementId, { value: '100', unit: 'USD' }), corrupt);
    await assert.rejects(ledger.readOperation(ORG, (rejected as { refundOperationId: string }).refundOperationId), corrupt);
    assert.deepEqual(await refund(world, '50', 'refund-after-tamper'), { outcome: 'accounting-unavailable' });
    assert.deepEqual(await world.service.reconcileRefund((rejected as { refundOperationId: string }).refundOperationId), { outcome: 'basis-unavailable' });
    assert.equal(world.world.kernelRequests.length, kernelBefore, 'zero new refund governance after corruption is detected');
    assert.equal(world.rail.callCount, railBefore);
    await assert.rejects(ledger.verifyAll(), corrupt);
    await ledger.close();
  }

  it('LEDGER-TAMPER-1: a historical reservation amount rewritten 80 → 20 under the cached head is corruption, not balance 75', async () => {
    await assertRefused(await tampered((entries) => ({ sequence: 1, entry: { ...entries.get(1)!, amount: { unit: 'USD', value: '20' } } })));
  });

  it('LEDGER-TAMPER-2: a historical reservation principal rewritten is corruption', async () => {
    await assertRefused(await tampered((entries) => ({ sequence: 1, entry: { ...entries.get(1)!, principalId: 'principal-other' } })));
  });

  it('LEDGER-TAMPER-3: a historical reservation moved to another original settlement (key column rewritten consistently) is corruption', async () => {
    await assertRefused(await tampered((entries) => ({ sequence: 1, entry: { ...entries.get(1)!, originalSettlementId: 'payment-settlement:elsewhere' } })));
  });

  it('LEDGER-TAMPER-4: release content rewritten — its basis, or the operation it releases (key column too) — is corruption', async () => {
    await assertRefused(await tampered((entries) => ({ sequence: 3, entry: { ...entries.get(3)!, basis: 'decision-denied' } })));
    await assertRefused(await tampered((entries, ids) => ({ sequence: 3, entry: { ...entries.get(3)!, refundOperationId: ids.tail } })));
  });

  it('LEDGER-TAMPER-5: the cached tail row rewritten (amount 5 → 1) is corruption', async () => {
    await assertRefused(await tampered((entries) => ({ sequence: 4, entry: { ...entries.get(4)!, amount: { unit: 'USD', value: '1' } } })));
  });

  it('freshness and integrity are two layers: the witness still holds the same head after the rewrite — only recomputation catches it', async () => {
    const context = await tampered((entries) => ({ sequence: 1, entry: { ...entries.get(1)!, amount: { unit: 'USD', value: '20' } } }));
    // The witnessed head (sequence, chain digest) is unchanged by the rewrite: CORE-07 alone would accept it.
    const status = await context.ledger.health();
    assert.equal(status.freshness, 'ready', 'CORE-07 sees nothing wrong — the rewrite preserved every digest string');
    await assertRefused(context);
  });
});

describe('PAY-05 hardening self-review — an unavailable basis is never an authoritative refusal', () => {
  function serviceWith(world: RefundWorld, overrides: Partial<Parameters<typeof createPaymentRefundService>[0]>): PaymentRefundService {
    return createPaymentRefundService({
      organizationId: ORG,
      settlements: world.settlements,
      ledger: world.ledger,
      counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
      binding: BINDING,
      assets: TEST_ASSETS,
      orchestrator: world.world.orchestrator,
      governance: world.world.rawStore,
      outcomes: world.world.outcomes,
      resolutions: settlementHarness(world.world).resolutions,
      allowVolatileLedger: true,
      ...overrides,
    });
  }
  const ask = (service: PaymentRefundService, world: RefundWorld) => service.requestRefund(IDENTITY, { originalExecutionId: world.originalExecutionId, refundKey: 'refund-unavailable', amount: { value: '10', unit: 'USD' }, envelope: ENVELOPE });

  it('the original settlement unreadable (basis-unavailable, or a throw) → basis-unavailable, not original-not-settled; nothing reserved or governed', async () => {
    const world = await refundWorld();
    const kernelBefore = world.world.kernelRequests.length;
    for (const settlements of [
      { readSettlement: async () => ({ outcome: 'basis-unavailable' as const, reason: 'outcome-unreadable' as never }) },
      { readSettlement: async () => { throw new Error('store offline'); } },
    ]) {
      assert.deepEqual(await ask(serviceWith(world, { settlements }), world), { outcome: 'basis-unavailable' });
    }
    assert.equal(world.world.kernelRequests.length, kernelBefore);
    assert.equal(await remaining(world), '100');
  });

  it('the counterparty mapping throws → basis-unavailable; answering none → counterparty-unresolved', async () => {
    const world = await refundWorld();
    assert.deepEqual(await ask(serviceWith(world, { counterparties: () => { throw new Error('mapping offline'); } }), world), { outcome: 'basis-unavailable' });
    assert.deepEqual(await ask(serviceWith(world, { counterparties: () => undefined }), world), { outcome: 'counterparty-unresolved' });
    assert.equal(await remaining(world), '100');
  });
});
