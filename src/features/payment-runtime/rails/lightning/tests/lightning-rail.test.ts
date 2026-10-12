import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PaymentExecutionRequest, PaymentRailResult } from '../../../domain/index.js';
import { LightningRailConfigurationError, createLightningInvoiceBook, createLightningRail, createLightningRailConfiguration, lightningDestinationOf, type LightningRail } from '../index.js';
import {
  BTC_ASSET,
  GOVERNED_ACCOUNT,
  TEST_NOW_MS,
  TEST_NOW_SECONDS,
  btc,
  createInMemoryLightningInterlock,
  createSimulatedLightningNode,
  testRailConfiguration,
  testRailConfigurationInput,
  type InMemoryLightningInterlock,
  type SimulatedInvoice,
  type SimulatedLightningNode,
} from './lightning-test-fixtures.js';

/**
 * PAY-06 — the Lightning rail against a deterministic, LND-shaped simulated
 * node: P11 certainty (P11-LN-1 … 8), invoice binding (B11-4, 6, 12 – 15),
 * fee caps, no retry, and what is logged.
 */

interface Harness {
  readonly rail: LightningRail;
  readonly node: SimulatedLightningNode;
  readonly interlock: InMemoryLightningInterlock;
  readonly book: ReturnType<typeof createLightningInvoiceBook>;
  readonly logs: { level: string; event: string; fields: unknown }[];
  now: number;
}

async function harness(options: { readonly configuration?: Parameters<typeof testRailConfiguration>[0] } = {}): Promise<Harness> {
  const node = await createSimulatedLightningNode();
  const interlock = createInMemoryLightningInterlock();
  const book = createLightningInvoiceBook();
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const h: Harness = {
    node,
    interlock,
    book,
    logs,
    now: TEST_NOW_MS,
    rail: undefined as unknown as LightningRail,
  };
  (h as { rail: LightningRail }).rail = createLightningRail({
    configuration: testRailConfiguration(options.configuration),
    node,
    invoices: book,
    interlock,
    now: () => h.now,
    logger: { info: (event, fields) => logs.push({ level: 'info', event, fields }), warn: (event, fields) => logs.push({ level: 'warn', event, fields }) },
  });
  return h;
}

let executions = 0;
function requestFor(invoice: SimulatedInvoice, overrides: Partial<PaymentExecutionRequest> = {}): PaymentExecutionRequest {
  executions += 1;
  return Object.freeze({
    executionId: `exec-ln-${executions}`,
    requestId: `req-${executions}`,
    decisionId: `dec-${executions}`,
    grantId: `grant-${executions}`,
    notAfter: '2026-10-12T01:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: lightningDestinationOf(invoice.payee, invoice.paymentHash),
    amount: { value: btc(invoice.amountMsat), unit: BTC_ASSET },
    purpose: 'vendor-payment',
    rail: 'lightning-btc',
    ...overrides,
  });
}

async function registered(h: Harness, label: string, input: Partial<Parameters<SimulatedLightningNode['registerInvoice']>[0]> = {}): Promise<SimulatedInvoice> {
  const invoice = await h.node.registerInvoice({ label, amountMsat: 2_500_000n, ...input });
  h.book.register(invoice.paymentHash, invoice.invoice);
  return invoice;
}

function notCompleted(result: PaymentRailResult, detail: string, reason?: string): void {
  assert.equal(result.status, 'not-completed', JSON.stringify(result));
  assert.equal(result.status === 'not-completed' && result.detail, detail);
  if (reason !== undefined) assert.equal(result.status === 'not-completed' && result.reason, reason);
}

describe('PAY-06 rail — P11 certainty mapping (P11-LN)', () => {
  it('P11-LN-1 success with a valid preimage → completed, ref = payment hash; one send, the trusted cap on it', async () => {
    const h = await harness();
    const invoice = await registered(h, 'p11-1');
    const result = await h.rail.execute(requestFor(invoice));
    assert.deepEqual(result, { status: 'completed', externalReference: invoice.paymentHash });
    assert.equal(h.node.calls.sendPayment, 1);
    const sent = h.node.sends[0];
    assert.equal(sent?.feeLimitMsat, 25_000n, '1% of 2 500 000 msat (below the 50 000 msat absolute cap)');
    assert.equal(sent?.amountMsat, 2_500_000n);
    assert.equal(sent?.timeoutSeconds, 30);
    assert.equal(h.interlock.records.length, 1, 'reserved before the send');
  });

  it('P11-LN-2 terminal node failure → not-completed PROVIDER_REJECTED (definitive), ref = payment hash', async () => {
    const h = await harness();
    h.node.behaviour = 'fail';
    const invoice = await registered(h, 'p11-2');
    const result = await h.rail.execute(requestFor(invoice));
    assert.deepEqual(result, { status: 'not-completed', reason: 'PROVIDER_REJECTED', externalReference: invoice.paymentHash, detail: 'lightning-incorrect-payment-details' });
  });

  it('P11-LN-3 in flight (a held HTLC) → unconfirmed — never failed', async () => {
    const h = await harness();
    h.node.behaviour = 'hold';
    const invoice = await registered(h, 'p11-3');
    assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'unconfirmed', externalReference: invoice.paymentHash, detail: 'lightning-payment-in-flight' });
  });

  it('P11-LN-4 the node never answers (RPC deadline) → unconfirmed, bounded by the rail’s own deadline', async () => {
    const h = await harness({ configuration: { paymentTimeoutSeconds: 5, finalityGraceMs: 1_000, requestTimeoutMs: 500 } });
    h.node.behaviour = 'hang';
    const invoice = await registered(h, 'p11-4');
    const started = Date.now();
    assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'unconfirmed', externalReference: invoice.paymentHash, detail: 'lightning-send-outcome-unknown' });
    assert.ok(Date.now() - started < 10_000);
  });

  it('P11-LN-5 disconnect after the node accepted → unconfirmed; the payment did settle (P12 will see it)', async () => {
    const h = await harness();
    h.node.behaviour = 'disconnect-after-accept';
    const invoice = await registered(h, 'p11-5');
    assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'unconfirmed', externalReference: invoice.paymentHash, detail: 'lightning-send-outcome-unknown' });
    assert.equal(h.node.payment(invoice.paymentHash)?.state, 'succeeded');
    assert.equal(h.node.calls.sendPayment, 1);
  });

  it('P11-LN-6 a malformed or inconsistent node answer → unconfirmed, never completed', async () => {
    for (const [behaviour, detail] of [
      ['garbage', 'lightning-node-answer-unreadable'],
      ['wrong-preimage', 'lightning-preimage-mismatch'],
      ['other-amount', 'lightning-delivered-amount-mismatch'],
    ] as const) {
      const h = await harness();
      h.node.behaviour = behaviour;
      const invoice = await registered(h, `p11-6-${behaviour}`);
      assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'unconfirmed', externalReference: invoice.paymentHash, detail }, behaviour);
    }
  });

  it('P11-LN-7 fee cap: a route dearer than the cap is a terminal no-route (the node never spends above it); a node that reports a fee above the cap is never success', async () => {
    const h = await harness();
    const invoice = await registered(h, 'p11-7', { routeFeeMsat: 30_000n });
    assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'not-completed', reason: 'PROVIDER_REJECTED', externalReference: invoice.paymentHash, detail: 'lightning-no-route' });
    assert.equal(h.node.sends[0]?.feeLimitMsat, 25_000n, 'the cap was on the send — enforced before any HTLC, not only checked afterwards');
    const lying = await harness();
    lying.node.behaviour = 'overpay-fee';
    const other = await registered(lying, 'p11-7b');
    assert.deepEqual(await lying.rail.execute(requestFor(other)), { status: 'unconfirmed', externalReference: other.paymentHash, detail: 'lightning-fee-bound-violated' });
  });

  it('P11-LN-8 no retry: whatever the first answer, the same execution never sends again', async () => {
    for (const behaviour of ['succeed', 'fail', 'hold', 'disconnect-after-accept', 'garbage'] as const) {
      const h = await harness();
      h.node.behaviour = behaviour;
      const invoice = await registered(h, `p11-8-${behaviour}`);
      const request = requestFor(invoice);
      await h.rail.execute(request);
      h.node.behaviour = 'succeed';
      const again = await h.rail.execute(request);
      assert.deepEqual(again, { status: 'unconfirmed', externalReference: invoice.paymentHash, detail: 'lightning-execution-previously-initiated' }, behaviour);
      assert.equal(h.node.calls.sendPayment, 1, `${behaviour}: one send, ever`);
    }
  });

  it('a request that provably never left the process → not-completed PROVIDER_UNAVAILABLE (and the hash stays bound)', async () => {
    const h = await harness();
    h.node.behaviour = 'not-attempted';
    const invoice = await registered(h, 'not-attempted');
    assert.deepEqual(await h.rail.execute(requestFor(invoice)), { status: 'not-completed', reason: 'PROVIDER_UNAVAILABLE', externalReference: invoice.paymentHash, detail: 'lightning-send-not-attempted' });
    // Another execution can never take the same invoice afterwards.
    notCompleted(await h.rail.execute(requestFor(invoice)), 'lightning-payment-hash-reserved');
    assert.equal(h.node.calls.sendPayment, 1);
  });
});

describe('PAY-06 rail — invoice binding (refused before anything is sent)', () => {
  it('B11-4 an expired invoice — or one expiring inside the safety margin — is never sent', async () => {
    const h = await harness();
    const expired = await registered(h, 'expired', { timestamp: TEST_NOW_SECONDS - 4000, expirySeconds: 3600 });
    notCompleted(await h.rail.execute(requestFor(expired)), 'lightning-invoice-expired', 'PROVIDER_REJECTED');
    const marginal = await registered(h, 'marginal', { timestamp: TEST_NOW_SECONDS - 100, expirySeconds: 130 });
    notCompleted(await h.rail.execute(requestFor(marginal)), 'lightning-invoice-expired');
    assert.equal(h.node.calls.sendPayment, 0);
    assert.equal(h.node.calls.nodeInfo, 0, 'refused before the node was even consulted');
  });

  it('an invoice that expires while the node is being read is refused after the reservation, before the send', async () => {
    const h = await harness();
    const invoice = await registered(h, 'aging', { timestamp: TEST_NOW_SECONDS - 100, expirySeconds: 300 });
    const decode = h.node.decodeInvoice.bind(h.node);
    (h.node as { decodeInvoice: typeof decode }).decodeInvoice = async (text, timeout) => {
      h.now += 200_000;
      return decode(text, timeout);
    };
    notCompleted(await h.rail.execute(requestFor(invoice)), 'lightning-invoice-expired');
    assert.equal(h.node.calls.sendPayment, 0);
  });

  it('an invoice timestamped in the future beyond the skew is refused', async () => {
    const h = await harness();
    notCompleted(await h.rail.execute(requestFor(await registered(h, 'future', { timestamp: TEST_NOW_SECONDS + 3600 }))), 'lightning-invoice-timestamp-in-future');
  });

  it('B11-3 an invoice for another network is refused', async () => {
    const h = await harness();
    notCompleted(await h.rail.execute(requestFor(await registered(h, 'testnet-invoice', { network: 'testnet' }))), 'lightning-invoice-network-mismatch');
  });

  it('B11-6 / MONEY-9 the governed amount and the invoice amount must be exactly equal — no tolerance either way', async () => {
    const h = await harness();
    const invoice = await registered(h, 'amount');
    for (const msat of [2_499_999n, 2_500_001n, 25_000_000n]) notCompleted(await h.rail.execute(requestFor(invoice, { amount: { value: btc(msat), unit: BTC_ASSET } })), 'lightning-invoice-amount-mismatch');
    assert.equal(h.node.calls.sendPayment, 0);
  });

  it('B11-12 an amountless invoice is refused (PAY-06 pays amount-bearing invoices only)', async () => {
    const h = await harness();
    const invoice = await h.node.registerInvoice({ label: 'amountless', amountMsat: 2_500_000n });
    const { buildInvoice } = await import('./lightning-test-fixtures.js');
    h.book.register(invoice.paymentHash, await buildInvoice({ hrpAmount: '', paymentHash: invoice.paymentHash, payeeKeyLabel: 'payee-node' }));
    notCompleted(await h.rail.execute(requestFor(invoice)), 'lightning-invoice-amountless');
  });

  it('B11-13 the invoice must be signed by the governed payee: another payee’s invoice for the same hash is refused', async () => {
    const h = await harness();
    const invoice = await registered(h, 'payee', { payeeKeyLabel: 'mallory-node' });
    const { testNodeKey } = await import('./lightning-test-fixtures.js');
    const governed = lightningDestinationOf(await testNodeKey('payee-node'), invoice.paymentHash);
    notCompleted(await h.rail.execute(requestFor(invoice, { destination: governed })), 'lightning-invoice-payee-mismatch');
  });

  it('the trusted invoice source cannot redirect a payment: a different hash under the governed one is refused', async () => {
    const h = await harness();
    const real = await registered(h, 'real');
    const other = await h.node.registerInvoice({ label: 'other', amountMsat: 2_500_000n });
    const book = createLightningInvoiceBook();
    book.register(real.paymentHash, other.invoice);
    const rail = createLightningRail({ configuration: testRailConfiguration(), node: h.node, invoices: book, interlock: createInMemoryLightningInterlock(), now: () => TEST_NOW_MS });
    notCompleted(await rail.execute(requestFor(real)), 'lightning-invoice-payment-hash-mismatch');
  });

  it('B11-14 same payment hash, different execution → refused before the send, even for the same amount', async () => {
    const h = await harness();
    const invoice = await registered(h, 'shared');
    assert.equal((await h.rail.execute(requestFor(invoice))).status, 'completed');
    notCompleted(await h.rail.execute(requestFor(invoice)), 'lightning-payment-hash-reserved');
    assert.equal(h.node.calls.sendPayment, 1);
  });

  it('B11-15 same execution, different invoice → conflict: the recorded binding stands, nothing is sent or rewritten', async () => {
    const h = await harness();
    h.node.behaviour = 'hold';
    const first = await registered(h, 'first');
    const second = await registered(h, 'second');
    const request = requestFor(first);
    await h.rail.execute(request);
    const rebound = await h.rail.execute({ ...request, destination: lightningDestinationOf(second.payee, second.paymentHash) });
    assert.deepEqual(rebound, { status: 'unconfirmed', externalReference: first.paymentHash, detail: 'lightning-execution-invoice-conflict' });
    assert.equal(h.node.calls.sendPayment, 1);
    assert.equal(h.interlock.records.length, 1);
    assert.equal(h.interlock.records[0]?.paymentHash, first.paymentHash);
  });

  it('MONEY-10 / asset: only the trusted BTC asset rides this rail; unmapped sources and non-Lightning destinations are refused', async () => {
    const h = await harness();
    const invoice = await registered(h, 'asset');
    notCompleted(await h.rail.execute(requestFor(invoice, { amount: { value: '25', unit: 'USD' } })), 'lightning-asset-unsupported');
    notCompleted(await h.rail.execute(requestFor(invoice, { source: { accountId: 'someone-else' } })), 'lightning-source-unmapped');
    notCompleted(await h.rail.execute(requestFor(invoice, { destination: { kind: 'account', reference: 'vendor-1' } })), 'lightning-destination-invalid');
    assert.equal(h.node.calls.nodeInfo + h.node.calls.sendPayment, 0);
  });

  it('a CLTV delta above the trusted maximum is refused', async () => {
    const h = await harness({ configuration: { maximumFinalCltvExpiryDelta: 30 } });
    notCompleted(await h.rail.execute(requestFor(await registered(h, 'cltv'))), 'lightning-invoice-cltv-unsupported');
  });

  it('the node must be on the configured network, must not be the payee, and must decode the invoice exactly as Frontera does', async () => {
    const wrongNetwork = await harness();
    wrongNetwork.node.network = 'testnet';
    notCompleted(await wrongNetwork.rail.execute(requestFor(await registered(wrongNetwork, 'node-net', { network: 'regtest' }))), 'lightning-node-network-mismatch');

    const self = await harness();
    const invoice = await registered(self, 'self', { payeeKeyLabel: 'payer-node' });
    notCompleted(await self.rail.execute(requestFor(invoice)), 'lightning-node-self-payment');

    const differential = await harness();
    const other = await registered(differential, 'differential');
    differential.node.decodeOverride = () => ({ payee: other.payee, paymentHash: other.paymentHash, amountMsat: other.amountMsat + 1n });
    notCompleted(await differential.rail.execute(requestFor(other)), 'lightning-node-invoice-disagreement');

    const down = await harness();
    down.node.unreachable = true;
    notCompleted(await down.rail.execute(requestFor(await registered(down, 'down'))), 'lightning-node-unavailable', 'PROVIDER_UNAVAILABLE');
    for (const h of [wrongNetwork, self, differential, down]) assert.equal(h.node.calls.sendPayment, 0);
  });

  it('an interlock that cannot read or write refuses the payment: nothing is sent without a durable reservation', async () => {
    for (const failure of ['recorded', 'reserve'] as const) {
      const h = await harness();
      h.interlock.failNext = failure;
      notCompleted(await h.rail.execute(requestFor(await registered(h, `il-${failure}`))), 'lightning-interlock-unavailable');
      assert.equal(h.node.calls.sendPayment, 0);
    }
  });

  it('an unavailable or throwing invoice source refuses the payment', async () => {
    const h = await harness();
    const invoice = await h.node.registerInvoice({ label: 'unknown', amountMsat: 2_500_000n });
    notCompleted(await h.rail.execute(requestFor(invoice)), 'lightning-invoice-unavailable');
    const throwing = createLightningRail({ configuration: testRailConfiguration(), node: h.node, invoices: { invoiceFor: async () => Promise.reject(new Error('down')) }, interlock: createInMemoryLightningInterlock(), now: () => TEST_NOW_MS });
    notCompleted(await throwing.execute(requestFor(invoice)), 'lightning-invoice-unavailable');
  });
});

describe('PAY-06 rail — composition, logging, readiness', () => {
  it('the rail is never composed without an interlock, a node with sendPayment, or a validated configuration', async () => {
    const node = await createSimulatedLightningNode();
    const base = { configuration: testRailConfiguration(), node, invoices: createLightningInvoiceBook(), interlock: createInMemoryLightningInterlock() };
    assert.throws(() => createLightningRail({ ...base, interlock: undefined as never }), LightningRailConfigurationError);
    assert.throws(() => createLightningRail({ ...base, node: { ...node, sendPayment: undefined } as never }), LightningRailConfigurationError);
    assert.throws(() => createLightningRail({ ...base, configuration: { ...testRailConfiguration() } }), LightningRailConfigurationError, 'a copy is not a validated configuration');
  });

  it('network configuration fails closed: no default, mainnet only with allowMainnet: true', () => {
    assert.throws(() => createLightningRailConfiguration(testRailConfigurationInput({ network: undefined as never })), /no default/);
    assert.throws(() => createLightningRailConfiguration(testRailConfigurationInput({ network: 'mainnet' })), /allowMainnet/);
    assert.throws(() => createLightningRailConfiguration(testRailConfigurationInput({ network: 'mainnet', allowMainnet: 'yes' as never })), /allowMainnet/);
    assert.equal(createLightningRailConfiguration(testRailConfigurationInput({ network: 'mainnet', allowMainnet: true })).network, 'mainnet');
    assert.throws(() => createLightningRailConfiguration(testRailConfigurationInput({ fees: {} })), /no unbounded fee/);
    assert.throws(() => createLightningRailConfiguration(testRailConfigurationInput({ asset: { paymentAsset: BTC_ASSET, scale: 12 } })), /at most 11/);
  });

  it('logs carry the execution id, the payment hash and a detail token — never an invoice, preimage, amount or node key', async () => {
    const h = await harness();
    const invoice = await registered(h, 'logging');
    await h.rail.execute(requestFor(invoice));
    const text = JSON.stringify(h.logs);
    assert.ok(h.logs.length > 0);
    for (const secret of [invoice.invoice, invoice.preimage, invoice.payee, h.node.identity, '2500000', btc(invoice.amountMsat)]) assert.equal(text.includes(secret), false, 'a log leaked a payment detail');
  });

  it('readiness reads the node only — it never initiates a payment', async () => {
    const h = await harness();
    assert.deepEqual(await h.rail.readiness(), { status: 'ready', network: 'regtest' });
    h.node.network = 'testnet';
    assert.deepEqual(await h.rail.readiness(), { status: 'unavailable', detail: 'lightning-node-network-mismatch' });
    h.node.unreachable = true;
    assert.deepEqual(await h.rail.readiness(), { status: 'unavailable', detail: 'lightning-node-unavailable' });
    assert.equal(h.node.calls.sendPayment, 0);
  });

  it('concurrent executions of one invoice in one process: exactly one reaches the node', async () => {
    const h = await harness();
    h.node.behaviour = 'hold';
    const invoice = await registered(h, 'race');
    const results = await Promise.all([1, 2, 3, 4].map(() => h.rail.execute(requestFor(invoice))));
    assert.equal(h.node.calls.sendPayment, 1);
    assert.equal(results.filter((result) => result.status === 'unconfirmed').length, 1);
    assert.equal(results.filter((result) => result.status === 'not-completed').length, 3);
  });
});
