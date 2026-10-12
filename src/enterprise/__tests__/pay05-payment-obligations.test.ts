import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ObligationLifecycleService, type ObligationCorrelation, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import { createInMemoryObligationDischargeStore } from '../obligation-discharge/in-memory-obligation-discharge-store.js';
import { createObligationDischargeRecorder, createStoredObligationDischargeProvider } from '../obligation-discharge/recorder.js';
import type { ObligationDischargeStore } from '../obligation-discharge/contracts.js';
import { createPaymentObligationDischarger, paymentObligationReference, type PaymentObligationDischarger, type PaymentObligationRegistry } from '../payment-settlement/index.js';
import { IDENTITY, ORG, finalityAuthority, governed, payment, paymentWorld, settlementHarness, type SettlementHarness } from './pay05-settlement-support.js';
import type { GovernedWorld } from './governed-action-support.js';

/**
 * PAY-05 — settlement-verified payment obligations through CORE-04 (O1 – O12,
 * C4, C5). CORE-04's own pieces decide the state: its recorder writes, its
 * store keeps, its source registry classifies, its lifecycle service derives.
 * PAY-05 contributes one observation — "the expected payment reached funds
 * finality; reference = its receipt" — and nothing else.
 */

const PAYMENT_OBLIGATION = 'payment.settled';
const SOURCES: readonly ObligationDischargeSource[] = [
  { id: 'payment-settlement', kind: 'provider_adapter', name: 'Settlement-verified payment', verificationClass: 'independent' },
  { id: 'payer-statement', kind: 'request', name: 'The payer says it paid', verificationClass: 'self_reported' },
];
const LIFECYCLE = new ObligationLifecycleService({ declaration: { requirements: [{ obligationType: PAYMENT_OBLIGATION, blocking: true }] }, sources: SOURCES });
const WRITER = { system: true, actorId: 'service:payment-settlement' } as const;
const RECORDED_AT = '2026-01-01T01:00:00.000Z';
/** The bridge observes after every earlier report and no later than the recorder's clock. */
let bridgeClock = Date.parse('2026-01-01T00:30:00.000Z');
const bridgeNow = (): string => new Date((bridgeClock += 1000)).toISOString();

const ORDER_A: ObligationCorrelation = { requestId: 'req-release-order-a', action: 'release-goods', resourceScope: 'order-1001' };
const ORDER_B: ObligationCorrelation = { requestId: 'req-release-order-b', action: 'release-goods', resourceScope: 'order-1002' };
/** An order priced in EUR: the same number in another asset is another payment. */
const ORDER_EUR: ObligationCorrelation = { requestId: 'req-release-order-eur', action: 'release-goods', resourceScope: 'order-1003' };
/** What each order's payment obligation expects — trusted, payment-specific configuration. */
const EXPECTED = { amount: { value: '100', unit: 'USD' }, destination: { kind: 'account', reference: 'vendor-4471' } } as const;
const same = (left: ObligationCorrelation, right: ObligationCorrelation): boolean => left.requestId === right.requestId && left.action === right.action && left.resourceScope === right.resourceScope;
const registry: PaymentObligationRegistry = ({ correlation, obligationType }) => {
  if (obligationType !== PAYMENT_OBLIGATION) return undefined;
  if (same(correlation, ORDER_A) || same(correlation, ORDER_B)) return EXPECTED;
  if (same(correlation, ORDER_EUR)) return { ...EXPECTED, amount: { value: '100', unit: 'EUR' } };
  return undefined;
};

interface ObligationWorld {
  readonly world: GovernedWorld;
  readonly settlement: SettlementHarness;
  readonly store: ObligationDischargeStore;
  readonly bridge: PaymentObligationDischarger;
  state(correlation: ObligationCorrelation): Promise<string>;
}

function obligationWorld(options: { readonly sourceId?: string; readonly authority?: ReturnType<typeof finalityAuthority> } = {}): ObligationWorld {
  const { world } = paymentWorld();
  const settlement = settlementHarness(world, options.authority !== undefined ? { authority: options.authority } : {});
  const store = createInMemoryObligationDischargeStore({ organizationId: ORG });
  const recorder = createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => RECORDED_AT });
  const bridge = createPaymentObligationDischarger({ settlements: settlement.service, registry, recorder, discharges: store, sourceId: options.sourceId ?? 'payment-settlement', writer: WRITER, now: bridgeNow });
  const provider = createStoredObligationDischargeProvider(store, ORG);
  return {
    world,
    settlement,
    store,
    bridge,
    async state(correlation) {
      const { observations } = await provider.resolveObligationDischarges({ obligationTypes: [PAYMENT_OBLIGATION], correlation, actorId: 'actor', trustDomainId: 'td', organizationId: ORG, at: RECORDED_AT });
      const resolution = LIFECYCLE.resolve(observations, correlation, RECORDED_AT);
      return resolution.obligations[0]!.state;
    },
  };
}

async function pay(w: ObligationWorld, overrides: Record<string, unknown> = {}, settle = true): Promise<string> {
  const result = await w.world.orchestrator.govern(IDENTITY, governed(payment({ reference: paymentObligationReference(ORDER_A, PAYMENT_OBLIGATION), ...overrides })));
  assert.equal(result.status, 'executed', JSON.stringify(result));
  if (settle) assert.equal((await w.settlement.service.verifySettlement({ organizationId: ORG, executionId: result.executionId! })).outcome, 'settled');
  return result.executionId!;
}

const discharge = (w: ObligationWorld, executionId: string, correlation: ObligationCorrelation = ORDER_A) => w.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation, obligationType: PAYMENT_OBLIGATION }, executionId });

describe('PAY-05 O1 – O12 — a payment obligation is verified only by the exact payment’s canonical settlement', () => {
  it('O1: no settlement at all → nothing recorded; the obligation stays required', async () => {
    const w = obligationWorld();
    assert.deepEqual(await discharge(w, 'aoc.exec:never-paid'), { outcome: 'not-settled' });
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('O2: the exact payment, P11 completed only (not settled) → not verified', async () => {
    const w = obligationWorld();
    const executionId = await pay(w, {}, false);
    assert.deepEqual(await discharge(w, executionId), { outcome: 'not-settled' });
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('O3: the exact payment, settled → an independent settlement source reports it → CORE-04 derives verified', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const result = await discharge(w, executionId);
    assert.equal(result.outcome, 'recorded', JSON.stringify(result));
    if (result.outcome !== 'recorded') return;
    assert.equal(result.discharge.sourceId, 'payment-settlement');
    assert.equal(result.discharge.outcome, 'discharged', 'PAY-05 reports an observation; it never names a state');
    assert.equal(result.discharge.reference, result.receiptId);
    assert.equal((await w.settlement.service.receipt({ organizationId: ORG, executionId }))?.receiptId, result.receiptId);
    assert.equal(await w.state(ORDER_A), 'verified');
  });

  it('O4: a receipt of another payment (not made for this obligation) → mismatch; nothing recorded', async () => {
    const w = obligationWorld();
    const executionId = await pay(w, { reference: 'INV-SOMETHING-ELSE' });
    assert.deepEqual(await discharge(w, executionId), { outcome: 'mismatch', field: 'reference' });
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('O5: the wrong amount → mismatch', async () => {
    const w = obligationWorld();
    assert.deepEqual(await discharge(w, await pay(w, { amount: { value: '99.99', unit: 'USD' } })), { outcome: 'mismatch', field: 'amount' });
  });

  it('O6: the wrong asset — even the same number — → mismatch', async () => {
    const w = obligationWorld();
    const executionId = await pay(w, { reference: paymentObligationReference(ORDER_EUR, PAYMENT_OBLIGATION) });
    assert.deepEqual(await discharge(w, executionId, ORDER_EUR), { outcome: 'mismatch', field: 'asset' }, '100 USD does not pay 100 EUR');
    assert.equal(await w.state(ORDER_EUR), 'required');
  });

  it('O7: the wrong beneficiary → mismatch', async () => {
    const w = obligationWorld();
    assert.deepEqual(await discharge(w, await pay(w, { destination: { kind: 'account', reference: 'vendor-9999' } })), { outcome: 'mismatch', field: 'destination' });
  });

  it('O8: the right payment presented for a different decision correlation → mismatch (reference derived from the other obligation)', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    assert.deepEqual(await discharge(w, executionId, { ...ORDER_A, resourceScope: 'order-other' }), { outcome: 'not-a-payment-obligation' }, 'an obligation the registry does not know');
    assert.deepEqual(await discharge(w, executionId, ORDER_B), { outcome: 'mismatch', field: 'reference' });
    assert.equal(await w.state(ORDER_B), 'required');
  });

  it('O9 / C5: the same receipt again for the same obligation is idempotent — no second report', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const first = await discharge(w, executionId);
    assert.equal(first.outcome, 'recorded');
    for (let index = 0; index < 3; index += 1) assert.deepEqual(await discharge(w, executionId), { outcome: 'already-recorded', receiptId: (first as { receiptId: string }).receiptId });
    assert.equal((await w.store.read(ORG, ORDER_A)).length, 1);
    assert.equal(await w.state(ORDER_A), 'verified');
  });

  it('O10: a receipt that satisfied obligation A presented for obligation B (same amount, same beneficiary) → refused; B stays required', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    assert.equal((await discharge(w, executionId)).outcome, 'recorded');
    assert.deepEqual(await discharge(w, executionId, ORDER_B), { outcome: 'mismatch', field: 'reference' });
    assert.equal(await w.state(ORDER_A), 'verified');
    assert.equal(await w.state(ORDER_B), 'required', 'a receipt is not a bearer authorization');
  });

  it('O11: a caller self-report — directly, or even a real settlement reported through a self-reported source — is discharged at most, never verified', async () => {
    const w = obligationWorld();
    const recorder = createObligationDischargeRecorder({ store: w.store, sources: SOURCES, organizationId: ORG, now: () => RECORDED_AT });
    await recorder.record(WRITER, { correlation: ORDER_A, obligationType: PAYMENT_OBLIGATION, sourceId: 'payer-statement', outcome: 'discharged', observedAt: '2026-01-01T00:00:00.000Z', reference: 'trust-me-i-paid' });
    assert.equal(await w.state(ORDER_A), 'discharged');
    const misconfigured = obligationWorld({ sourceId: 'payer-statement' });
    const executionId = await pay(misconfigured);
    assert.equal((await discharge(misconfigured, executionId)).outcome, 'recorded');
    assert.equal(await misconfigured.state(ORDER_A), 'discharged', 'CORE-04 — never PAY-05 — decides what a source is worth');
  });

  it('O12: the finality authority is unavailable → the payment is not settled → the obligation remains unsatisfied', async () => {
    const w = obligationWorld({ authority: finalityAuthority(() => Promise.reject(new Error('unavailable'))) });
    const result = await w.world.orchestrator.govern(IDENTITY, governed(payment({ reference: paymentObligationReference(ORDER_A, PAYMENT_OBLIGATION) })));
    assert.equal((await w.settlement.service.verifySettlement({ organizationId: ORG, executionId: result.executionId! })).outcome, 'authority-unavailable');
    assert.deepEqual(await discharge(w, result.executionId!), { outcome: 'not-settled' });
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('a settled refund never discharges a payment obligation; an obligation the registry does not know is not a payment obligation', async () => {
    const w = obligationWorld();
    const refund = await pay(w, { purpose: 'refund' });
    assert.deepEqual(await discharge(w, refund), { outcome: 'mismatch', field: 'purpose' });
    const executionId = await pay(w);
    assert.deepEqual(await w.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation: ORDER_A, obligationType: 'change.approval' }, executionId }), { outcome: 'not-a-payment-obligation' });
  });

  it('C4: a crash after settlement and receipt, before the discharge — a later call records it exactly once', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const failing = createPaymentObligationDischarger({
      settlements: w.settlement.service,
      registry,
      recorder: { record: async () => { throw new Error('crashed before the write'); } },
      discharges: w.store,
      sourceId: 'payment-settlement',
      writer: WRITER,
      now: bridgeNow,
    });
    assert.deepEqual(await failing.dischargeObligation({ organizationId: ORG, obligation: { correlation: ORDER_A, obligationType: PAYMENT_OBLIGATION }, executionId }), { outcome: 'discharge-unrecorded' });
    assert.equal(await w.state(ORDER_A), 'required');
    assert.equal((await discharge(w, executionId)).outcome, 'recorded');
    assert.equal((await discharge(w, executionId)).outcome, 'already-recorded');
    assert.equal(await w.state(ORDER_A), 'verified');
  });

  it('self-review: a self-report recorded after the settlement was verified never blocks the independent discharge', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const recorder = createObligationDischargeRecorder({ store: w.store, sources: SOURCES, organizationId: ORG, now: () => RECORDED_AT });
    // Recorded after verification and before the bridge runs (the settlement's own instant is earlier still).
    await recorder.record(WRITER, { correlation: ORDER_A, obligationType: PAYMENT_OBLIGATION, sourceId: 'payer-statement', outcome: 'discharged', observedAt: new Date(bridgeClock + 500).toISOString(), reference: 'i-paid' });
    assert.equal(await w.state(ORDER_A), 'discharged');
    assert.equal((await discharge(w, executionId)).outcome, 'recorded');
    assert.equal(await w.state(ORDER_A), 'verified');
  });

  it('the derived obligation reference is a governed token, unique per obligation instance', () => {
    const a = paymentObligationReference(ORDER_A, PAYMENT_OBLIGATION);
    assert.match(a, /^payobl-[0-9a-f]{64}$/);
    assert.notEqual(a, paymentObligationReference(ORDER_B, PAYMENT_OBLIGATION));
    assert.notEqual(a, paymentObligationReference(ORDER_A, 'payment.deposit'));
    assert.equal(a, paymentObligationReference({ ...ORDER_A }, PAYMENT_OBLIGATION), 'deterministic');
  });
});

describe('PAY-05 hardening OBREG-1 – OBREG-5 — a registry outage is unavailability, never "not a payment obligation"', () => {
  /** The bridge composed over one world with a scripted registry, and a recorder that counts CORE-04 writes. */
  function withRegistry(w: ObligationWorld, scripted: PaymentObligationRegistry): { readonly bridge: PaymentObligationDischarger; readonly writes: () => number } {
    const recorder = createObligationDischargeRecorder({ store: w.store, sources: SOURCES, organizationId: ORG, now: () => RECORDED_AT });
    let writes = 0;
    const counting = { record: (...args: Parameters<typeof recorder.record>) => ((writes += 1), recorder.record(...args)) };
    const bridge = createPaymentObligationDischarger({ settlements: w.settlement.service, registry: scripted, recorder: counting, discharges: w.store, sourceId: 'payment-settlement', writer: WRITER, now: bridgeNow });
    return { bridge, writes: () => writes };
  }
  const ask = (bridge: PaymentObligationDischarger, executionId: string) => bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation: ORDER_A, obligationType: PAYMENT_OBLIGATION }, executionId });

  it('OBREG-1: the registry answers undefined (successfully) → not-a-payment-obligation; nothing written', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const { bridge, writes } = withRegistry(w, () => undefined);
    assert.deepEqual(await ask(bridge, executionId), { outcome: 'not-a-payment-obligation' });
    assert.equal(writes(), 0);
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('OBREG-2 / OBREG-5: the registry throws → basis-unavailable; zero CORE-04 writes; the obligation stays required', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const { bridge, writes } = withRegistry(w, () => {
      throw new Error('order system unreachable');
    });
    assert.deepEqual(await ask(bridge, executionId), { outcome: 'basis-unavailable' });
    assert.equal(writes(), 0);
    assert.deepEqual(await w.store.read(ORG, ORDER_A), []);
    assert.equal(await w.state(ORDER_A), 'required');
  });

  it('OBREG-3 / OBREG-5: the registry rejects its Promise → basis-unavailable; zero CORE-04 writes', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    const { bridge, writes } = withRegistry(w, async () => Promise.reject(new Error('database outage')));
    assert.deepEqual(await ask(bridge, executionId), { outcome: 'basis-unavailable' });
    assert.equal(writes(), 0);
    assert.deepEqual(await w.store.read(ORG, ORDER_A), []);
  });

  it('a registry answer outside the contract (not undefined, not an expectation) is unavailability too — never a negative fact', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    for (const answer of [null, 'yes', { amount: { value: '1e2', unit: 'USD' }, destination: EXPECTED.destination }, { amount: EXPECTED.amount }]) {
      const { bridge, writes } = withRegistry(w, () => answer as never);
      assert.deepEqual(await ask(bridge, executionId), { outcome: 'basis-unavailable' }, JSON.stringify(answer));
      assert.equal(writes(), 0);
    }
  });

  it('OBREG-4: the registry fails once and succeeds later — the caller’s explicit retry records the discharge exactly once', async () => {
    const w = obligationWorld();
    const executionId = await pay(w);
    let calls = 0;
    const { bridge, writes } = withRegistry(w, async (query) => {
      calls += 1;
      if (calls === 1) throw new Error('transient outage');
      return registry(query);
    });
    assert.deepEqual(await ask(bridge, executionId), { outcome: 'basis-unavailable' });
    assert.equal(await w.state(ORDER_A), 'required');
    assert.equal((await ask(bridge, executionId)).outcome, 'recorded');
    assert.equal((await ask(bridge, executionId)).outcome, 'already-recorded');
    assert.equal(writes(), 1);
    assert.equal(calls, 3, 'asked only when the caller asked — no automatic retry');
    assert.equal(await w.state(ORDER_A), 'verified', 'CORE-04 still decides: an independent source verifies');
  });
});
