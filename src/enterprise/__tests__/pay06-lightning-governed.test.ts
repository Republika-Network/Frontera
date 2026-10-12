import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObligationLifecycleService, type ObligationCorrelation, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentFinalityQuery,
  type PaymentIntent,
} from '../../features/payment-runtime/index.js';
import { createLightningInvoiceBook, createLightningRail, lightningDestinationOf, readOnlyLightningNode, type LightningNodeReader, type LightningRail } from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, TEST_NOW_MS, btc, createSimulatedLightningNode, testPreimage, testRailConfiguration, type SimulatedInvoice, type SimulatedLightningNode } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { LIGHTNING_FINALITY_AUTHORITY_ID, LIGHTNING_FINALITY_METHOD, createLightningFinalityAuthority } from '../lightning-payment-rail/lightning-finality-authority.js';
import { LIGHTNING_RESOLUTION_AUTHORITY_ID, createLightningResolutionAuthority } from '../lightning-payment-rail/lightning-resolution-authority.js';
import { createSqliteLightningPaymentInterlock, type DurableLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { createInMemoryObligationDischargeStore } from '../obligation-discharge/in-memory-obligation-discharge-store.js';
import { createObligationDischargeRecorder, createStoredObligationDischargeProvider } from '../obligation-discharge/recorder.js';
import {
  createInMemoryPaymentSettlementStore,
  createPaymentObligationDischarger,
  createPaymentSettlementService,
  createSqlitePaymentSettlementStore,
  paymentObligationReference,
  verifyPaymentReceipt,
  type PaymentSettlementStore,
} from '../payment-settlement/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, ORG, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';
import { boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * PAY-06 — the exit proofs: the SAME Frontera CORE, unchanged, governs
 * Lightning. A canonical `PaymentIntent` in BTC to a Lightning destination
 * compiles through PAY-01, is decided and granted by the unchanged spine
 * (Kernel, policy, P10 ceiling, grant, P7, write-ahead claim), and reaches the
 * Lightning rail only through PAY-01's bridge; P11 records the node's
 * certainty, P12 resolves uncertainty through the read-only Lightning
 * authority, and PAY-05 settles only on a verified preimage — producing the
 * generic, deterministic receipt.
 *
 * Below the bridge: the real rail, the real durable interlock anchored at a
 * real CORE-07 witness, and a deterministic simulated node with LND's
 * semantics (counted sends). A real LND regtest run is
 * `pay06-lightning-regtest.test.ts` (opt-in).
 */

const made: string[] = [];
const dir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay06-governed-'));
  made.push(directory);
  return directory;
};
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

const ACTION = ALLOWED_INTENT.action;
const ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: ACTION });
const ASSETS = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: BTC_ASSET, scale: 11 }]);
const CONFIGURATION = testRailConfiguration({ sourceAccounts: [ACCOUNT] });
const AMOUNT_MSAT = 2_500_000n;
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
  profiles: [
    {
      profileId: 'governed-payment',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' },
      actionClass: 'payment',
      resourceClass: 'governed-account',
      parameters: PAYMENT_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
});

interface LightningWorld {
  readonly world: GovernedWorld;
  readonly node: SimulatedLightningNode;
  readonly book: ReturnType<typeof createLightningInvoiceBook>;
  readonly rail: LightningRail;
  readonly witness: StartedWitness;
  readonly paths: { readonly interlock: string; readonly outcomes: string; readonly resolutions: string; readonly settlements: string };
  interlock: DurableLightningPaymentInterlock;
  outcomes: ExecutionOutcomeStore;
}

const clock = (): string => new Date().toISOString();

async function lightningWorld(options: { readonly lifetime?: string; readonly ceiling?: string } = {}): Promise<LightningWorld> {
  const directory = dir();
  const paths = { interlock: join(directory, 'interlock.sqlite'), outcomes: join(directory, 'outcomes.sqlite'), resolutions: join(directory, 'resolutions.sqlite'), settlements: join(directory, 'settlements.sqlite') };
  const witness = await startWitness();
  const node = await createSimulatedLightningNode();
  const book = createLightningInvoiceBook();
  const interlock = await createSqliteLightningPaymentInterlock(paths.interlock, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: clock, freshness: { boundary: await boundaryFor(witness, ORG) } });
  const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
  const rail = createLightningRail({ configuration: CONFIGURATION, node, invoices: book, interlock, now: () => TEST_NOW_MS });
  const world = buildGovernedWorld({
    monetary: { assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) },
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority(options.ceiling ?? '1', options.lifetime ?? '100', BTC_ASSET),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
    executionOutcomes: outcomes,
  });
  return { world, node, book, rail, witness, paths, interlock, outcomes };
}

async function invoiceFor(lw: LightningWorld, label: string, input: Partial<Parameters<SimulatedLightningNode['registerInvoice']>[0]> = {}): Promise<SimulatedInvoice> {
  const invoice = await lw.node.registerInvoice({ label, amountMsat: AMOUNT_MSAT, ...input });
  lw.book.register(invoice.paymentHash, invoice.invoice);
  return invoice;
}

function intentFor(invoice: SimulatedInvoice, overrides: Record<string, unknown> = {}): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: ACCOUNT },
      destination: lightningDestinationOf(invoice.payee, invoice.paymentHash),
      amount: { value: btc(invoice.amountMsat), unit: BTC_ASSET },
      purpose: 'vendor-payment',
      reference: 'INV-LN-1',
      rail: 'lightning-btc',
      idempotencyKey: `ln-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { intent: PaymentIntent }).intent;
}

async function govern(lw: LightningWorld, invoice: SimulatedInvoice, overrides: Record<string, unknown> = {}) {
  return lw.world.orchestrator.govern(IDENTITY, compilePaymentIntent(intentFor(invoice, overrides), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
}

function settlementService(lw: LightningWorld, resolutions: ExecutionResolutionStore, store: PaymentSettlementStore = createInMemoryPaymentSettlementStore({ now: () => NOW }), reader: LightningNodeReader = lw.node) {
  const authority = createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(reader), interlock: lw.interlock });
  return createPaymentSettlementService({
    outcomes: lw.outcomes,
    resolutions,
    governance: lw.world.rawStore,
    payments: [BINDING],
    store,
    authorities: [authority],
    selectAuthority: (context) => (context.railId === CONFIGURATION.railId || context.rail === CONFIGURATION.railId ? LIGHTNING_FINALITY_AUTHORITY_ID : 'none'),
    now: () => NOW,
  });
}

function reconciliation(lw: LightningWorld, resolutions: ExecutionResolutionStore, reader: LightningNodeReader = lw.node) {
  const authority = createLightningResolutionAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(reader), interlock: lw.interlock });
  return createExecutionReconciliationService({
    outcomes: lw.outcomes,
    resolutions,
    composition: snapshotResolutionAuthorities([authority], () => LIGHTNING_RESOLUTION_AUTHORITY_ID, 'test'),
    claimed: async () => true,
    now: () => NOW,
  });
}

/** The P11 initial observation's certainty and handle, whatever its kind. */
const observed = (record: { readonly terminal?: { readonly observation: unknown } } | undefined): { readonly certainty?: string; readonly providerRef?: string } | undefined => record?.terminal?.observation as { readonly certainty?: string; readonly providerRef?: string } | undefined;

const show = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));

describe('PAY-06 EXIT PROOF A — success: governed BTC payment → one node payment → P11 → preimage finality → settled → deterministic receipt', () => {
  it('the unchanged spine governs Lightning end to end; settlement only after the verified preimage', async () => {
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, 'exit-a');
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'executed', show(result));
    assert.equal(lw.node.calls.sendPayment, 1, 'ONE logical node payment');
    const record = await lw.outcomes.read({ organizationId: ORG }, result.executionId!);
    assert.equal(observed(record)?.certainty, 'confirmed-completed');
    assert.equal(observed(record)?.providerRef, invoice.paymentHash, 'P11 holds the payment hash, never the preimage');

    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const service = settlementService(lw, resolutions);
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'status', state: 'awaiting-finality' }, 'P11 completed is NOT settled (SET-LN-1)');
    const sendsBefore = lw.node.calls.sendPayment;
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', show(settled));
    if (settled.outcome !== 'settled') return;
    assert.equal(lw.node.calls.sendPayment, sendsBefore, 'the finality authority sent nothing (SET-LN-11)');
    const finality = settled.settlement.finality;
    assert.equal(finality.authorityId, LIGHTNING_FINALITY_AUTHORITY_ID);
    assert.equal(finality.method, LIGHTNING_FINALITY_METHOD);
    assert.equal(finality.providerRef, invoice.paymentHash);
    assert.equal(finality.finalizedAt, undefined, 'no payer-node clock in canonical evidence');
    const facts = Object.fromEntries(finality.facts.map((fact) => [fact.name, fact.value]));
    assert.deepEqual(Object.keys(facts).sort(), ['lightning.amount-msat', 'lightning.fee-limit-msat', 'lightning.fee-msat', 'lightning.invoice-digest', 'lightning.network', 'lightning.payee-node', 'lightning.payer-node', 'lightning.payment-hash', 'lightning.preimage-commitment']);
    assert.equal(facts['lightning.payment-hash'], invoice.paymentHash);
    assert.equal(facts['lightning.payer-node'], lw.node.identity, 'the evidence names the payer node bound before the send');
    assert.equal(facts['lightning.amount-msat'], '2500000');
    assert.equal(facts['lightning.fee-msat'], '1000', 'the actual routing fee, recorded as a bounded accounting fact');
    assert.equal(facts['lightning.fee-limit-msat'], '25000');
    assert.equal(settled.settlement.railId, 'lightning-btc');
    assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });
    assert.equal(settled.receipt.format, 'frontera.payment-receipt.v1', 'the generic PAY-05 receipt — no Lightning receipt type');
    const everything = show({ settled, record });
    assert.equal(everything.includes(invoice.preimage), false, 'the preimage is never recorded or disclosed');
    assert.equal(everything.includes(invoice.invoice), false, 'the invoice text is never recorded');
    await lw.interlock.close();
  });

  it('SET-LN-8 / SET-LN-9 deterministic reconstruction: the settlement store lost, the process restarted → the same content digest and the same receipt digest', async () => {
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, 'exit-a-det');
    const result = await govern(lw, invoice);
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    let store = await createSqlitePaymentSettlementStore(lw.paths.settlements, { now: clock });
    const first = await settlementService(lw, resolutions, store).verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(first.outcome, 'settled');
    if (first.outcome !== 'settled') return;
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${lw.paths.settlements}${suffix}`, { force: true });
    // Restart: new interlock connection, new authority, new store file.
    await lw.interlock.close();
    lw.interlock = await createSqliteLightningPaymentInterlock(lw.paths.interlock, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: clock, freshness: { boundary: await boundaryFor(lw.witness, ORG) } });
    store = await createSqlitePaymentSettlementStore(lw.paths.settlements, { now: () => '2027-01-01T00:00:00.000Z' });
    const rebuilt = await settlementService(lw, resolutions, store).verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(rebuilt.outcome, 'settled');
    if (rebuilt.outcome !== 'settled') return;
    assert.equal(rebuilt.settlement.contentDigest, first.settlement.contentDigest);
    assert.equal(rebuilt.receipt.receiptDigest, first.receipt.receiptDigest);
    assert.equal(rebuilt.settlement.finality.proofDigest, first.settlement.finality.proofDigest);
    assert.equal(lw.node.calls.sendPayment, 1);
    await store.close();
    await lw.interlock.close();
  });
});

describe('PAY-06 EXIT PROOF B — uncertain: in-flight HTLC → RPC/disconnect → P11 unconfirmed → no resend → restart → P12 → finality → settled', () => {
  it('a held HTLC: unconfirmed, capacity held, no retry; after a restart P12 reads the same payment hash, waits while in flight, resolves completed once the payee settles; one send in total', async () => {
    const lw = await lightningWorld();
    lw.node.behaviour = 'hold';
    const invoice = await invoiceFor(lw, 'exit-b');
    const intent = compilePaymentIntent(intentFor(invoice), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext });
    const result = await lw.world.orchestrator.govern(IDENTITY, intent);
    assert.equal(result.status, 'execution_unconfirmed', show(result));
    const executionId = result.executionId!;
    assert.equal(observed(await lw.outcomes.read({ organizationId: ORG }, executionId))?.certainty, 'unconfirmed');

    // The same governed request replays its recorded outcome: the rail is not invoked again.
    const replay = await lw.world.orchestrator.govern(IDENTITY, intent);
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.equal(replay.executionId, executionId);
    // A NEW governed request for the same invoice reaches the rail and fails closed before the node (payment hash reserved).
    const second = await govern(lw, invoice);
    assert.equal(second.status, 'execution_failed');
    assert.equal(lw.node.calls.sendPayment, 1, 'neither reached the node: no retry, no second payment');

    // ── restart: every component rebuilt over the durable files ──
    await lw.interlock.close();
    await lw.outcomes.close();
    lw.interlock = await createSqliteLightningPaymentInterlock(lw.paths.interlock, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: clock, freshness: { boundary: await boundaryFor(lw.witness, ORG) } });
    lw.outcomes = await createSqliteExecutionOutcomeStore(lw.paths.outcomes, { now: () => NOW });
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const p12 = reconciliation(lw, resolutions);
    assert.ok(['bound', 'existing'].includes((await p12.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID })).outcome));

    // P12-LN-3: still in flight → no resolution recorded.
    assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' });
    assert.equal(await resolutions.read({ organizationId: ORG }, executionId).then((state) => state?.resolution), undefined);
    assert.deepEqual(await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-eligible', state: 'execution-uncertain' });

    // The payee releases the preimage; P12-LN-1 resolves completed, bound to the attempt and the observation (P12-LN-6).
    lw.node.settleHeld(invoice.paymentHash);
    const resolved = await p12.reconcile({ organizationId: ORG, executionId });
    assert.equal(resolved.outcome, 'resolved', show(resolved));
    if (resolved.outcome !== 'resolved') return;
    const p11 = await lw.outcomes.read({ organizationId: ORG }, executionId);
    assert.equal(resolved.resolution.certainty, 'confirmed-completed');
    assert.equal(resolved.resolution.authorityId, LIGHTNING_RESOLUTION_AUTHORITY_ID);
    assert.equal(resolved.resolution.providerRef, invoice.paymentHash);
    assert.equal(resolved.resolution.attemptDigest, p11?.attempt.attemptDigest);
    assert.equal(resolved.resolution.basisObservationDigest, p11?.terminal?.observationDigest);

    const settled = await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled', show(settled));
    assert.equal(settled.outcome === 'settled' && settled.settlement.basis.kind, 'resolution-confirmed-completed', 'SET-LN-10');
    assert.equal(lw.node.calls.sendPayment, 1, 'P12 and finality sent nothing: ONE node send, in total (P12-LN-8)');
    await lw.interlock.close();
  });

  it('P11-LN-5 governed: the node accepted, the connection dropped → unconfirmed; P12 resolves completed from the node; one send', async () => {
    const lw = await lightningWorld();
    lw.node.behaviour = 'disconnect-after-accept';
    const invoice = await invoiceFor(lw, 'exit-b-disconnect');
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'execution_unconfirmed', show(result));
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const p12 = reconciliation(lw, resolutions);
    await p12.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    assert.equal((await p12.reconcile({ organizationId: ORG, executionId: result.executionId! })).outcome, 'resolved');
    assert.equal((await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! })).outcome, 'settled');
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('P12-LN-2 unconfirmed → the payee cancels → P12 resolves confirmed-not-completed; P7 capacity is released by P12, never by the timeout', async () => {
    const lw = await lightningWorld({ lifetime: btc(AMOUNT_MSAT) });
    lw.node.behaviour = 'hold';
    const invoice = await invoiceFor(lw, 'p12-cancel');
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'execution_unconfirmed');
    // Capacity is held while uncertain: a second payment of the whole lifetime limit is not allowed.
    lw.node.behaviour = 'succeed';
    const blocked = await govern(lw, await invoiceFor(lw, 'p12-cancel-next'));
    assert.notEqual(blocked.status, 'executed', 'the timeout never released capacity');
    lw.node.cancelHeld(invoice.paymentHash);
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const p12 = reconciliation(lw, resolutions);
    await p12.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    const resolved = await p12.reconcile({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-not-completed', show(resolved));
    assert.deepEqual(await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'not-eligible', state: 'not-settleable' });
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('P12-LN-4 / P12-LN-5 node unavailable, or an answer for another payment hash → unresolved, nothing recorded', async () => {
    const lw = await lightningWorld();
    lw.node.behaviour = 'hold';
    const invoice = await invoiceFor(lw, 'p12-unavailable');
    const result = await govern(lw, invoice);
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const p12 = reconciliation(lw, resolutions);
    await p12.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    lw.node.unreachable = true;
    assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'unresolved' });
    lw.node.unreachable = false;
    const other = testPreimage('someone-else');
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: other.paymentHash, preimage: other.preimage, amountMsat: AMOUNT_MSAT, feeMsat: 0n });
    assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'unresolved' });
    lw.node.statusOverride = () => ({ state: 'not-found' });
    assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'unresolved' }, 'absence at the node is never evidence');
    assert.equal((await resolutions.read({ organizationId: ORG }, result.executionId!))?.resolution, undefined);
    await lw.interlock.close();
  });
});

describe('PAY-06 EXIT PROOF C — definitive failure: terminal node failure → P11 confirmed-not-completed → no settlement, no receipt, no retry', () => {
  it('the node fails the payment terminally; P7 releases on the definitive non-completion; the same execution is never resent', async () => {
    const lw = await lightningWorld({ lifetime: btc(AMOUNT_MSAT) });
    lw.node.behaviour = 'fail';
    const invoice = await invoiceFor(lw, 'exit-c');
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'execution_failed', show(result));
    const record = await lw.outcomes.read({ organizationId: ORG }, result.executionId!);
    assert.equal(observed(record)?.certainty, 'confirmed-not-completed');
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const service = settlementService(lw, resolutions);
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'not-eligible', state: 'not-settleable' });
    assert.equal(await service.receipt({ organizationId: ORG, executionId: result.executionId! }), undefined);
    // P7: the definitive failure released the capacity — a new payment of the whole lifetime limit proceeds.
    lw.node.behaviour = 'succeed';
    const next = await govern(lw, await invoiceFor(lw, 'exit-c-next'));
    assert.equal(next.status, 'executed', show(next));
    assert.equal(lw.node.calls.sendPayment, 2, 'one send for the failed payment, one for the new one — no resend');
    await lw.interlock.close();
  });
});

describe('PAY-06 EXIT PROOF D — fee limit: a route dearer than the trusted cap never spends above it, and is never retried with a higher fee', () => {
  it('route fee > cap → terminal no-route, nothing spent; route fee ≤ cap → succeeds, the fee recorded as a bounded fact', async () => {
    const lw = await lightningWorld();
    const expensive = await invoiceFor(lw, 'exit-d-expensive', { routeFeeMsat: 30_000n });
    const refused = await govern(lw, expensive);
    assert.equal(refused.status, 'execution_failed', show(refused));
    assert.equal(lw.node.calls.sendPayment, 1);
    assert.equal(lw.node.sends[0]?.feeLimitMsat, 25_000n, 'the cap travelled with the one send — enforced before any HTLC');
    assert.equal(lw.node.payment(expensive.paymentHash)?.state, 'failed');
    const cheap = await invoiceFor(lw, 'exit-d-cheap', { routeFeeMsat: 24_999n });
    const paid = await govern(lw, cheap);
    assert.equal(paid.status, 'executed');
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const settled = await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId: paid.executionId! });
    assert.equal(settled.outcome === 'settled' && settled.settlement.finality.facts.find((fact) => fact.name === 'lightning.fee-msat')?.value, '24999');
    assert.equal(lw.node.calls.sendPayment, 2, 'no retry of the refused payment');
    await lw.interlock.close();
  });
});

describe('PAY-06 settlement matrix (SET-LN-3 … SET-LN-7)', () => {
  async function completed() {
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, `set-${Math.random().toString(36).slice(2)}`);
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'executed');
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    return { lw, invoice, executionId: result.executionId!, service: settlementService(lw, resolutions) };
  }

  it('SET-LN-3 a malformed preimage (not 32 bytes of hex) → not final, nothing recorded', async () => {
    const { lw, invoice, executionId, service } = await completed();
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: 'zz'.repeat(32), amountMsat: AMOUNT_MSAT, feeMsat: 1000n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: invoice.preimage.slice(0, 62), amountMsat: AMOUNT_MSAT, feeMsat: 1000n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' });
    await lw.interlock.close();
  });

  it('SET-LN-4 a well-formed preimage that does not hash to the payment hash → contradicted, nothing recorded', async () => {
    const { lw, invoice, executionId, service } = await completed();
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: testPreimage('forged').preimage, amountMsat: AMOUNT_MSAT, feeMsat: 1000n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'lightning.preimage-mismatch' });
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' });
    await lw.interlock.close();
  });

  it('SET-LN-5 an answer about another payment hash → not final; SET-LN-6 another delivered amount → contradicted; a fee above the cap → contradicted', async () => {
    const { lw, invoice, executionId, service } = await completed();
    const other = testPreimage('set-ln-5-other');
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: other.paymentHash, preimage: other.preimage, amountMsat: AMOUNT_MSAT, feeMsat: 1000n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: invoice.preimage, amountMsat: AMOUNT_MSAT + 1n, feeMsat: 1000n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'lightning.amount-mismatch' });
    lw.node.statusOverride = () => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: invoice.preimage, amountMsat: AMOUNT_MSAT, feeMsat: 25_001n });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'lightning.fee-bound-exceeded' });
    lw.node.statusOverride = () => ({ state: 'failed', paymentHash: invoice.paymentHash, failure: 'no-route' });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'lightning.payment-failed' });
    lw.node.statusOverride = () => ({ state: 'in-flight', paymentHash: invoice.paymentHash });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    lw.node.network = 'testnet';
    delete lw.node.statusOverride;
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' }, 'a node on another network proves nothing');
    await lw.interlock.close();
  });

  it('SET-LN-7 the authority refuses a query whose payee, payment hash, amount, source or handle disagrees with the reservation — not final', async () => {
    const { lw, invoice, executionId } = await completed();
    const authority = createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(lw.node), interlock: lw.interlock });
    const base: PaymentFinalityQuery = {
      organizationId: ORG,
      executionId,
      requestId: 'req',
      decisionId: 'dec',
      basis: 'provider-confirmed-completed',
      railId: 'lightning-btc',
      providerRef: invoice.paymentHash,
      payment: { source: { accountId: ACCOUNT }, destination: lightningDestinationOf(invoice.payee, invoice.paymentHash), amount: { value: btc(AMOUNT_MSAT), unit: BTC_ASSET }, purpose: 'vendor-payment' },
    };
    assert.equal((await authority.verifyFinality(base)).outcome, 'final', 'control');
    const { testNodeKey } = await import('../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js');
    const variants: PaymentFinalityQuery[] = [
      { ...base, payment: { ...base.payment, destination: lightningDestinationOf(await testNodeKey('mallory-node'), invoice.paymentHash) } },
      { ...base, payment: { ...base.payment, destination: lightningDestinationOf(invoice.payee, testPreimage('other').paymentHash) } },
      { ...base, payment: { ...base.payment, amount: { value: btc(AMOUNT_MSAT + 1n), unit: BTC_ASSET } } },
      { ...base, payment: { ...base.payment, amount: { value: btc(AMOUNT_MSAT), unit: 'USD' } } },
      { ...base, payment: { ...base.payment, source: { accountId: 'another-account' } } },
      { ...base, providerRef: testPreimage('other').paymentHash },
      { ...base, railId: 'xrpl-rlusd' },
      { ...base, executionId: 'aoc.exec:unknown' },
    ];
    for (const query of variants) assert.deepEqual(await authority.verifyFinality(query), { outcome: 'not-final' }, show(query));
    await lw.interlock.close();
  });
});

describe('PAY-06 EXIT PROOF E — a CORE-04 payment obligation verified by a Lightning settlement', () => {
  it('required → the exact Lightning payment made for the obligation → preimage finality → independent discharge → CORE-04 verified; a self-report alone never verifies', async () => {
    const PAYMENT_OBLIGATION = 'payment.settled';
    const SOURCES: readonly ObligationDischargeSource[] = [
      { id: 'payment-settlement', kind: 'provider_adapter', name: 'Settlement-verified payment', verificationClass: 'independent' },
      { id: 'payer-statement', kind: 'request', name: 'The payer says it paid', verificationClass: 'self_reported' },
    ];
    const lifecycle = new ObligationLifecycleService({ declaration: { requirements: [{ obligationType: PAYMENT_OBLIGATION, blocking: true }] }, sources: SOURCES });
    const order: ObligationCorrelation = { requestId: 'req-release-ln-order', action: 'release-goods', resourceScope: 'order-ln-1' };
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, 'exit-e');
    const expected = { amount: { value: btc(AMOUNT_MSAT), unit: BTC_ASSET }, destination: lightningDestinationOf(invoice.payee, invoice.paymentHash) };
    const store = createInMemoryObligationDischargeStore({ organizationId: ORG });
    const recordedAt = '2026-01-01T01:00:00.000Z';
    let bridgeClock = Date.parse('2026-01-01T00:30:00.000Z');
    const recorder = createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => recordedAt });
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    const service = settlementService(lw, resolutions);
    const bridge = createPaymentObligationDischarger({
      settlements: service,
      registry: ({ correlation, obligationType }) => (obligationType === PAYMENT_OBLIGATION && correlation.requestId === order.requestId && correlation.resourceScope === order.resourceScope ? expected : undefined),
      recorder,
      discharges: store,
      sourceId: 'payment-settlement',
      writer: { system: true, actorId: 'service:payment-settlement' },
      now: () => new Date((bridgeClock += 1000)).toISOString(),
    });
    const provider = createStoredObligationDischargeProvider(store, ORG);
    const state = async (): Promise<string> => {
      const { observations } = await provider.resolveObligationDischarges({ obligationTypes: [PAYMENT_OBLIGATION], correlation: order, actorId: 'actor', trustDomainId: 'td', organizationId: ORG, at: recordedAt });
      return lifecycle.resolve(observations, order, recordedAt).obligations[0]!.state;
    };
    assert.equal(await state(), 'required');
    const result = await govern(lw, invoice, { reference: paymentObligationReference(order, PAYMENT_OBLIGATION) });
    assert.equal(result.status, 'executed', show(result));
    assert.deepEqual(await bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation: order, obligationType: PAYMENT_OBLIGATION }, executionId: result.executionId! }), { outcome: 'not-settled' }, 'P11 completed alone discharges nothing');
    assert.equal((await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! })).outcome, 'settled');
    const discharged = await bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation: order, obligationType: PAYMENT_OBLIGATION }, executionId: result.executionId! });
    assert.equal(discharged.outcome, 'recorded', show(discharged));
    assert.equal(await state(), 'verified');
    assert.equal(lw.node.calls.sendPayment, 1, 'no extra payment');
    await lw.interlock.close();
  });
});

describe('PAY-06 — governed binding regressions', () => {
  it('B11-14 governed: a second governed payment for an invoice already paid fails closed before the node, even for the same amount', async () => {
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, 'governed-dup');
    assert.equal((await govern(lw, invoice)).status, 'executed');
    const again = await govern(lw, invoice);
    assert.equal(again.status, 'execution_failed');
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('a denied (over-ceiling) Lightning payment never reaches the rail: P10 governs BTC exactly as every other asset', async () => {
    const lw = await lightningWorld({ ceiling: '0.00001' });
    const result = await govern(lw, await invoiceFor(lw, 'over-ceiling'));
    assert.notEqual(result.status, 'executed');
    assert.equal(lw.node.calls.nodeInfo + lw.node.calls.sendPayment, 0, 'nothing below the bridge was touched');
    await lw.interlock.close();
  });
});

describe('PAY-06 payer-node binding — only the node that paid can establish P12 or finality (PAYER-2 … PAYER-7, PAYER-11, PAYER-12)', () => {
  /** Another node on the SAME network, answering for the same payment hash — its own attempt at the same invoice. */
  async function otherNode(answer: (invoice: SimulatedInvoice) => unknown, invoice: SimulatedInvoice): Promise<SimulatedLightningNode> {
    const nodeB = await createSimulatedLightningNode({ identityLabel: 'payer-node-B' });
    assert.equal(nodeB.network, lw0Network);
    nodeB.statusOverride = () => answer(invoice);
    return nodeB;
  }
  const lw0Network = CONFIGURATION.network;
  const succeededFor = (invoice: SimulatedInvoice) => ({ state: 'succeeded', paymentHash: invoice.paymentHash, preimage: invoice.preimage, amountMsat: AMOUNT_MSAT, feeMsat: 1000n });
  const failedFor = (invoice: SimulatedInvoice) => ({ state: 'failed', paymentHash: invoice.paymentHash, failure: 'incorrect-payment-details' });

  async function uncertain(label: string) {
    const lw = await lightningWorld();
    lw.node.behaviour = 'hold';
    const invoice = await invoiceFor(lw, label);
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'execution_unconfirmed', show(result));
    assert.equal((await lw.interlock.read(result.executionId!))?.payerNodeId, lw.node.identity);
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    return { lw, invoice, executionId: result.executionId!, resolutions };
  }

  async function completedPayment(label: string) {
    const lw = await lightningWorld();
    const invoice = await invoiceFor(lw, label);
    const result = await govern(lw, invoice);
    assert.equal(result.status, 'executed', show(result));
    const resolutions = await createSqliteExecutionResolutionStore(lw.paths.resolutions, { now: () => NOW });
    return { lw, invoice, executionId: result.executionId!, resolutions };
  }

  it('PAYER-2 / PAYER-3 same network, node B reports SUCCEEDED (a valid preimage) or FAILED for the same payment hash → P12 unresolved, nothing recorded, no send', async () => {
    const { lw, invoice, executionId, resolutions } = await uncertain('payer-2');
    for (const answer of [succeededFor, failedFor]) {
      const nodeB = await otherNode(answer, invoice);
      const p12 = reconciliation(lw, resolutions, nodeB);
      assert.ok(['bound', 'existing'].includes((await p12.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID })).outcome));
      assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' }, `node B's ${String((answer(invoice) as { state: string }).state)} proves nothing about A's payment`);
      assert.equal(nodeB.calls.sendPayment, 0);
    }
    assert.equal((await resolutions.read({ organizationId: ORG }, executionId))?.resolution, undefined, 'no resolution recorded from another node');
    // A's payment is still in flight — the case where a borrowed "failed" would have released capacity for a payment that can still settle.
    assert.equal(lw.node.payment(invoice.paymentHash)?.state, 'in-flight');
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('PAYER-2 (authority level) the P12 table: same payer resolves; a different payer — succeeded, failed, in flight, not found, malformed — is always unresolved', async () => {
    const { lw, invoice, executionId } = await uncertain('payer-2-table');
    const query = { organizationId: ORG, executionId, providerRef: invoice.paymentHash, amount: { value: btc(AMOUNT_MSAT), unit: BTC_ASSET } } as never;
    const authorityOver = (reader: LightningNodeReader) => createLightningResolutionAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(reader), interlock: lw.interlock });
    for (const answer of [succeededFor, failedFor, (i: SimulatedInvoice) => ({ state: 'in-flight', paymentHash: i.paymentHash }), () => ({ state: 'not-found' }), () => ({ state: 'succeeded', weird: true })]) {
      assert.deepEqual(await authorityOver(await otherNode(answer, invoice)).resolve(query), { outcome: 'unresolved' });
    }
    lw.node.statusOverride = () => failedFor(invoice);
    assert.equal(((await authorityOver(lw.node).resolve(query)) as { certainty?: string }).certainty, 'confirmed-not-completed', 'control: the payer itself can fail it');
    lw.node.statusOverride = () => succeededFor(invoice);
    assert.equal(((await authorityOver(lw.node).resolve(query)) as { certainty?: string }).certainty, 'confirmed-completed', 'control: the payer itself can complete it');
    await lw.interlock.close();
  });

  it('PAYER-4 / PAYER-5 same network, node B reports SUCCEEDED with a valid preimage → NOT final; FAILED → NOT final (never contradicted); malformed → not final', async () => {
    const { lw, invoice, executionId, resolutions } = await completedPayment('payer-4');
    for (const answer of [succeededFor, failedFor, () => ({ state: 'succeeded', weird: true })]) {
      const nodeB = await otherNode(answer, invoice);
      assert.deepEqual(await settlementService(lw, resolutions, undefined, nodeB).verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    }
    assert.deepEqual(await settlementService(lw, resolutions).readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' }, 'nothing recorded from another node');
    // Control: the payer's own answers still settle, and still contradict.
    lw.node.statusOverride = () => failedFor(invoice);
    assert.deepEqual(await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'lightning.payment-failed' }, 'same payer + failed while completed → contradicted, as defined');
    delete lw.node.statusOverride;
    assert.equal((await settlementService(lw, resolutions).verifySettlement({ organizationId: ORG, executionId })).outcome, 'settled');
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('PAYER-6 / PAYER-7 restart with the reader still pointing at node A: P12 resolves and settlement completes; one send', async () => {
    const { lw, invoice, executionId } = await uncertain('payer-6');
    await lw.interlock.close();
    await lw.outcomes.close();
    lw.interlock = await createSqliteLightningPaymentInterlock(lw.paths.interlock, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: clock, freshness: { boundary: await boundaryFor(lw.witness, ORG) } });
    lw.outcomes = await createSqliteExecutionOutcomeStore(lw.paths.outcomes, { now: () => NOW });
    const resolutions = await createSqliteExecutionResolutionStore(`${lw.paths.resolutions}-restart`, { now: () => NOW });
    assert.equal((await lw.interlock.read(executionId))?.payerNodeId, lw.node.identity, 'the payer survived the restart');
    lw.node.settleHeld(invoice.paymentHash);
    // A fresh reader object for node A — the same node identity, a new composition.
    const readerA = readOnlyLightningNode(lw.node);
    const p12 = reconciliation(lw, resolutions, readerA);
    await p12.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    const resolved = await p12.reconcile({ organizationId: ORG, executionId });
    assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-completed', show(resolved));
    const settled = await settlementService(lw, resolutions, undefined, readerA).verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled', show(settled));
    assert.equal(settled.outcome === 'settled' && settled.settlement.finality.facts.find((fact) => fact.name === 'lightning.payer-node')?.value, lw.node.identity);
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });

  it('PAYER-11 the same payer identity on another network → P12 unresolved and not final', async () => {
    const { lw, invoice, executionId, resolutions } = await uncertain('payer-11');
    lw.node.settleHeld(invoice.paymentHash);
    lw.node.network = 'testnet';
    const p12 = reconciliation(lw, resolutions);
    await p12.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    assert.deepEqual(await p12.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' });
    const finality = createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(lw.node), interlock: lw.interlock });
    const query: PaymentFinalityQuery = { organizationId: ORG, executionId, requestId: 'req', decisionId: 'dec', basis: 'resolution-confirmed-completed', railId: CONFIGURATION.railId, providerRef: invoice.paymentHash, payment: { source: { accountId: ACCOUNT }, destination: lightningDestinationOf(invoice.payee, invoice.paymentHash), amount: { value: btc(AMOUNT_MSAT), unit: BTC_ASSET }, purpose: 'vendor-payment' } };
    assert.deepEqual(await finality.verifyFinality(query), { outcome: 'not-final' });
    lw.node.network = 'regtest';
    assert.equal((await finality.verifyFinality(query)).outcome, 'final', 'control');
    await lw.interlock.close();
  });

  it('PAYER-12 the same network but a malformed node identity (garbage, upper-case spelling of the payer’s key, missing) → unresolved and not final', async () => {
    const { lw, invoice, executionId } = await uncertain('payer-12');
    lw.node.settleHeld(invoice.paymentHash);
    const query: PaymentFinalityQuery = { organizationId: ORG, executionId, requestId: 'req', decisionId: 'dec', basis: 'resolution-confirmed-completed', railId: CONFIGURATION.railId, providerRef: invoice.paymentHash, payment: { source: { accountId: ACCOUNT }, destination: lightningDestinationOf(invoice.payee, invoice.paymentHash), amount: { value: btc(AMOUNT_MSAT), unit: BTC_ASSET }, purpose: 'vendor-payment' } };
    for (const identity of ['zz', lw.node.identity.toUpperCase(), `${lw.node.identity}00`, undefined]) {
      const reader: LightningNodeReader = { nodeInfo: async () => ({ network: 'regtest', ...(identity !== undefined ? { identity } : {}) }), decodeInvoice: lw.node.decodeInvoice, paymentStatus: (hash, timeout) => lw.node.paymentStatus(hash, timeout) };
      const p12 = createLightningResolutionAuthority({ configuration: CONFIGURATION, node: reader, interlock: lw.interlock });
      assert.deepEqual(await p12.resolve({ organizationId: ORG, executionId, providerRef: invoice.paymentHash } as never), { outcome: 'unresolved' }, String(identity));
      const finality = createLightningFinalityAuthority({ configuration: CONFIGURATION, node: reader, interlock: lw.interlock });
      assert.deepEqual(await finality.verifyFinality(query), { outcome: 'not-final' }, String(identity));
    }
    // A reservation whose payer is malformed (an interlock that is not the verified store) proves nothing either.
    const record = await lw.interlock.read(executionId);
    const forged = { read: async () => ({ ...record!, payerNodeId: 'not-a-node-key' }) };
    assert.deepEqual(await createLightningResolutionAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(lw.node), interlock: forged }).resolve({ organizationId: ORG, executionId, providerRef: invoice.paymentHash } as never), { outcome: 'unresolved' });
    assert.deepEqual(await createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(lw.node), interlock: forged }).verifyFinality(query), { outcome: 'not-final' });
    assert.equal(lw.node.calls.sendPayment, 1);
    await lw.interlock.close();
  });
});
