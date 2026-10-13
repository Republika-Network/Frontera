import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, createPaymentRailExecutionAdapter, validatePaymentIntent, type PaymentFinalityQuery, type PaymentIntent } from '../../features/payment-runtime/index.js';
import {
  btcDecimalOfMsat,
  createLightningInvoiceBook,
  createLightningRail,
  createLightningRailConfiguration,
  decodeBolt11Invoice,
  lightningDestinationOf,
  type LightningNodePort,
  type LightningRailConfiguration,
} from '../../features/payment-runtime/rails/lightning/index.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { LIGHTNING_FINALITY_AUTHORITY_ID, LIGHTNING_FINALITY_METHOD, createLightningFinalityAuthority } from '../lightning-payment-rail/lightning-finality-authority.js';
import { LIGHTNING_RESOLUTION_AUTHORITY_ID, createLightningResolutionAuthority } from '../lightning-payment-rail/lightning-resolution-authority.js';
import { LndRestNodeError, createLndRestLightningNode, createLndRestLightningNodeReader } from '../lightning-payment-rail/lnd-rest-node.js';
import { createSqliteLightningPaymentInterlock, type DurableLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { createInMemoryPaymentSettlementStore, createPaymentSettlementService, verifyPaymentReceipt } from '../payment-settlement/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, ORG, buildGovernedWorld, monetaryAuthority } from './governed-action-support.js';
import { boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * PAY-06 — real Lightning qualification on regtest (opt-in).
 *
 *   FRONTERA_LIGHTNING_REGTEST_PAY06=1 FRONTERA_LIGHTNING_REGTEST_DIR=<dir> node --test …
 *   (after `node scripts/pay06/lightning-regtest.mjs up` with the same FRONTERA_LIGHTNING_REGTEST_DIR)
 *
 * Real LND v0.20.5 nodes on real Bitcoin Core regtest: alice is Frontera's
 * payer node (REST, pinned TLS, narrowly baked macaroons), carol routes and
 * charges a fee, bob is an independent payee whose invoices — plain and hold —
 * are created by bob's own `lncli`, never by Frontera. Every node semantic is
 * real: BOLT11 from LND, `DecodePayReq`, `SendPaymentV2` with `fee_limit_msat`,
 * HTLCs held by a real hold invoice, `TrackPaymentV2` after a restart, real
 * preimages. Regtest only: no mainnet, no real funds.
 */

const ENABLED = process.env.FRONTERA_LIGHTNING_REGTEST_PAY06 === '1';
const STATE_DIR = process.env.FRONTERA_LIGHTNING_REGTEST_DIR ?? '';

interface RegtestState {
  readonly network: 'regtest';
  readonly alice: { readonly endpoint: string; readonly identity: string };
  readonly bob: { readonly identity: string };
  readonly carol: { readonly endpoint?: string; readonly identity: string; readonly fee: { readonly baseMsat: number; readonly ppm: number } };
  readonly files: { readonly certificate: string; readonly payerMacaroon: string; readonly readerMacaroon: string; readonly carolCertificate?: string; readonly carolReaderMacaroon?: string };
}

const made: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

const ACTION = ALLOWED_INTENT.action;
const ACCOUNT = ALLOWED_INTENT.resource;
const BTC = 'net:BTC';
const BINDING = createPaymentGovernanceBinding({ action: ACTION });
const ASSETS = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: BTC, scale: 11 }]);
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
  profiles: [{ profileId: 'governed-payment', version: 1, owner: ORG, provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' }, actionClass: 'payment', resourceClass: 'governed-account', parameters: PAYMENT_PROFILE_PARAMETERS, materialFacts: [], relevantPolicies: [] }],
});

/** bob's own node, operated outside Frontera. */
function bob(args: readonly string[]): Record<string, unknown> {
  return JSON.parse(execFileSync('docker', ['exec', 'frontera-pay06-bob', 'lncli', '--network=regtest', ...args], { encoding: 'utf8', timeout: 60_000 })) as Record<string, unknown>;
}

function state(): RegtestState {
  return JSON.parse(readFileSync(join(STATE_DIR, 'regtest.json'), 'utf8')) as RegtestState;
}

interface RegtestWorld {
  readonly world: ReturnType<typeof buildGovernedWorld>;
  readonly configuration: LightningRailConfiguration;
  readonly book: ReturnType<typeof createLightningInvoiceBook>;
  readonly sends: { count: number };
  readonly witness: StartedWitness;
  readonly paths: { readonly interlock: string; readonly outcomes: string; readonly resolutions: string };
  interlock: DurableLightningPaymentInterlock;
  outcomes: Awaited<ReturnType<typeof createSqliteExecutionOutcomeStore>>;
}

function lndOptions(s: RegtestState, macaroon: 'payer' | 'reader') {
  return { endpoint: s.alice.endpoint, tlsCertificatePem: readFileSync(s.files.certificate, 'utf8'), macaroonHex: readFileSync(macaroon === 'payer' ? s.files.payerMacaroon : s.files.readerMacaroon, 'utf8').trim() };
}

/** A read-only adapter against carol — another real node on the same network, never a payer Frontera composes (R7). */
function carolOptions(s: RegtestState) {
  return { endpoint: s.carol.endpoint ?? '', tlsCertificatePem: readFileSync(s.files.carolCertificate ?? '', 'utf8'), macaroonHex: readFileSync(s.files.carolReaderMacaroon ?? '', 'utf8').trim() };
}

async function regtestWorld(fees: { readonly maximumFeeMsat?: string; readonly maximumFeePpm?: number }, timing: { readonly paymentTimeoutSeconds?: number } = {}): Promise<RegtestWorld> {
  const s = state();
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay06-regtest-run-'));
  made.push(directory);
  const paths = { interlock: join(directory, 'interlock.sqlite'), outcomes: join(directory, 'outcomes.sqlite'), resolutions: join(directory, 'resolutions.sqlite') };
  const configuration = createLightningRailConfiguration({
    network: 'regtest',
    asset: { paymentAsset: BTC, scale: 11 },
    sourceAccounts: [ACCOUNT],
    fees,
    paymentTimeoutSeconds: timing.paymentTimeoutSeconds ?? 30,
    requestTimeoutMs: 10_000,
    finalityGraceMs: 15_000,
  });
  const witness = await startWitness();
  const interlock = await createSqliteLightningPaymentInterlock(paths.interlock, { scope: { railId: configuration.railId, network: 'regtest' }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
  const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
  const sends = { count: 0 };
  const lnd = createLndRestLightningNode(lndOptions(s, 'payer'));
  // Counts what reaches the node's one money-moving operation.
  const node: LightningNodePort = { ...lnd, sendPayment: (instruction) => ((sends.count += 1), lnd.sendPayment(instruction)) };
  const book = createLightningInvoiceBook();
  const rail = createLightningRail({ configuration, node, invoices: book, interlock });
  const world = buildGovernedWorld({
    monetary: { assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) },
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority('1', '100', BTC),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
    executionOutcomes: outcomes,
  });
  return { world, configuration, book, sends, witness, paths, interlock, outcomes };
}

async function bobInvoice(rw: RegtestWorld, amountSat: number, hold?: { readonly preimage: Buffer }): Promise<{ readonly invoice: string; readonly paymentHash: string; readonly amountMsat: bigint }> {
  let invoice: string;
  let paymentHash: string;
  if (hold === undefined) {
    const added = bob(['addinvoice', `--amt=${amountSat}`, '--memo=pay06 regtest', '--expiry=600']);
    invoice = String(added['payment_request']);
    paymentHash = String(added['r_hash']);
  } else {
    paymentHash = createHash('sha256').update(hold.preimage).digest('hex');
    invoice = String(bob(['addholdinvoice', paymentHash, `--amt=${amountSat}`, '--memo=pay06 regtest hold', '--expiry=600'])['payment_request']);
  }
  rw.book.register(paymentHash, invoice);
  return { invoice, paymentHash, amountMsat: BigInt(amountSat) * 1000n };
}

async function govern(rw: RegtestWorld, invoice: { readonly paymentHash: string; readonly amountMsat: bigint }) {
  const validation = validatePaymentIntent(
    { source: { accountId: ACCOUNT }, destination: lightningDestinationOf(state().bob.identity, invoice.paymentHash), amount: { value: btcDecimalOfMsat(invoice.amountMsat)!, unit: BTC }, purpose: 'vendor-payment', rail: 'lightning-btc', idempotencyKey: `regtest-${randomBytes(6).toString('hex')}` },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return rw.world.orchestrator.govern(IDENTITY, compilePaymentIntent((validation as { intent: PaymentIntent }).intent, BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
}

function settlement(rw: RegtestWorld, resolutions: Awaited<ReturnType<typeof createSqliteExecutionResolutionStore>>) {
  return createPaymentSettlementService({
    outcomes: rw.outcomes,
    resolutions,
    governance: rw.world.rawStore,
    payments: [BINDING],
    store: createInMemoryPaymentSettlementStore({ now: () => NOW }),
    authorities: [createLightningFinalityAuthority({ configuration: rw.configuration, node: createLndRestLightningNodeReader(lndOptions(state(), 'reader')), interlock: rw.interlock })],
    selectAuthority: () => LIGHTNING_FINALITY_AUTHORITY_ID,
    now: () => NOW,
  });
}

function p12(rw: RegtestWorld, resolutions: Awaited<ReturnType<typeof createSqliteExecutionResolutionStore>>) {
  return createExecutionReconciliationService({
    outcomes: rw.outcomes,
    resolutions,
    composition: snapshotResolutionAuthorities([createLightningResolutionAuthority({ configuration: rw.configuration, node: createLndRestLightningNodeReader(lndOptions(state(), 'reader')), interlock: rw.interlock })], () => LIGHTNING_RESOLUTION_AUTHORITY_ID, 'test'),
    claimed: async () => true,
    now: () => NOW,
  });
}

const facts = (record: { readonly finality: { readonly facts: readonly { readonly name: string; readonly value: string }[] } }) => Object.fromEntries(record.finality.facts.map((fact) => [fact.name, fact.value]));

describe('PAY-06 regtest — real LND, real BOLT11, real HTLCs (opt-in)', { skip: !ENABLED || !existsSync(join(STATE_DIR, 'regtest.json')) ? 'set FRONTERA_LIGHTNING_REGTEST_PAY06=1 and FRONTERA_LIGHTNING_REGTEST_DIR after `node scripts/pay06/lightning-regtest.mjs up`' : false }, () => {
  it('R0 Frontera’s strict decoder reads LND’s real invoices exactly as LND does; the read-only macaroon cannot send (node-enforced)', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 });
    const invoice = await bobInvoice(rw, 1000);
    const decoded = await decodeBolt11Invoice(invoice.invoice);
    assert.equal(decoded.valid, true, decoded.valid ? '' : decoded.refusal);
    assert.equal(decoded.valid && decoded.invoice.payee, state().bob.identity);
    assert.equal(decoded.valid && decoded.invoice.paymentHash, invoice.paymentHash);
    assert.equal(decoded.valid && decoded.invoice.network, 'regtest');
    const reader = createLndRestLightningNodeReader(lndOptions(state(), 'reader'));
    assert.deepEqual(await reader.decodeInvoice(decoded.valid ? decoded.invoice.canonical : '', 10_000), { payee: state().bob.identity, paymentHash: invoice.paymentHash, amountMsat: 1_000_000n });
    // The reader macaroon cannot move money, even through a full node port.
    const misused = createLndRestLightningNode(lndOptions(state(), 'reader'));
    await assert.rejects(misused.sendPayment({ invoice: invoice.invoice, paymentHash: invoice.paymentHash, amountMsat: 1_000_000n, feeLimitMsat: 0n, timeoutSeconds: 10, deadlineMs: 15_000 }), LndRestNodeError);
    assert.equal(bob(['lookupinvoice', invoice.paymentHash])['state'], 'OPEN', 'nothing was paid with the read-only credential');
    await rw.interlock.close();
  });

  it('R1 EXIT A — governed BTC payment → one real LND payment routed through carol → P11 completed → preimage finality → settled → receipt', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 });
    const invoice = await bobInvoice(rw, 250_000);
    const result = await govern(rw, invoice);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(rw.sends.count, 1);
    assert.equal(bob(['lookupinvoice', invoice.paymentHash])['state'], 'SETTLED', 'bob received it');
    const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
    const service = settlement(rw, resolutions);
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'status', state: 'awaiting-finality' });
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    if (settled.outcome !== 'settled') return;
    assert.equal(settled.settlement.finality.method, LIGHTNING_FINALITY_METHOD);
    const f = facts(settled.settlement);
    assert.equal(f['lightning.payment-hash'], invoice.paymentHash);
    assert.equal(f['lightning.amount-msat'], '250000000');
    assert.equal(f['lightning.payer-node'], state().alice.identity, 'the payer node bound before the send: alice');
    assert.equal((await rw.interlock.read(result.executionId!))?.payerNodeId, state().alice.identity);
    const fee = BigInt(f['lightning.fee-msat'] ?? '-1');
    assert.equal(fee, BigInt(state().carol.fee.baseMsat) + (250_000_000n * BigInt(state().carol.fee.ppm)) / 1_000_000n, 'carol’s real routing fee');
    assert.ok(fee <= 300_000n, 'within the trusted cap');
    assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });
    console.log(`PAY-06 regtest R1: execution ${result.executionId} payment ${invoice.paymentHash} fee ${fee} msat settlement ${settled.settlement.settlementId} receipt ${settled.receipt.receiptId}`);
    await rw.interlock.close();
  });

  it('R2 EXIT D — a trusted cap below carol’s fee: LND never spends above it; the payment never completes (failed, or a capped shard in flight → P12 not completed); no retry with a higher fee', async () => {
    const cap = 25_000n;
    const rw = await regtestWorld({ maximumFeePpm: 100 }, { paymentTimeoutSeconds: 10 });
    const invoice = await bobInvoice(rw, 250_000);
    const result = await govern(rw, invoice);
    // Real LND semantics: with no whole route inside the cap it either fails the payment outright (no-route / timeout),
    // or — the invoice allows multi-part payments — sends one shard whose own fee fits and keeps it in flight until the
    // payee's MPP timeout fails it. Never success; P11 is definitive or unconfirmed accordingly.
    assert.ok(result.status === 'execution_failed' || result.status === 'execution_unconfirmed', JSON.stringify(result));
    assert.equal(rw.sends.count, 1, 'one send, never retried with a higher fee');
    const reader = createLndRestLightningNodeReader(lndOptions(state(), 'reader'));
    let status: unknown;
    for (let read = 0; read < 120; read += 1) {
      status = await reader.paymentStatus(invoice.paymentHash, 10_000);
      if ((status as { state?: string }).state === 'failed') break;
      await new Promise((done) => setTimeout(done, 1_000));
    }
    assert.equal((status as { state?: string }).state, 'failed', JSON.stringify(status));
    assert.equal(bob(['lookupinvoice', invoice.paymentHash])['state'], 'OPEN', 'bob was never paid');
    // Operator view of the node's own record: no HTLC ever carried more fee than the trusted cap.
    const payments = JSON.parse(execFileSync('docker', ['exec', 'frontera-pay06-alice', 'lncli', '--network=regtest', 'listpayments', '--include_incomplete'], { encoding: 'utf8' })) as { payments: { payment_hash: string; htlcs?: { route?: { total_fees_msat?: string } }[] }[] };
    const record = payments.payments.find((payment) => payment.payment_hash === invoice.paymentHash);
    for (const htlc of record?.htlcs ?? []) assert.ok(BigInt(htlc.route?.total_fees_msat ?? '0') <= cap, 'an HTLC above the cap');
    if (result.status === 'execution_unconfirmed') {
      const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
      const reconciliation = p12(rw, resolutions);
      await reconciliation.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
      const resolved = await reconciliation.reconcile({ organizationId: ORG, executionId: result.executionId! });
      assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-not-completed', JSON.stringify(resolved));
    }
    console.log(`PAY-06 regtest R2: ${result.status}; LND ${JSON.stringify(status)}; HTLC fees ${JSON.stringify((record?.htlcs ?? []).map((htlc) => htlc.route?.total_fees_msat))} ≤ cap ${cap}`);
    await rw.interlock.close();
  });

  it('R3 EXIT B — a real held HTLC: P11 unconfirmed, no resend; restart; P12 unresolved while in flight; bob settles; P12 resolves completed; finality; one send', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 }, { paymentTimeoutSeconds: 8 });
    const preimage = randomBytes(32);
    const invoice = await bobInvoice(rw, 100_000, { preimage });
    const result = await govern(rw, invoice);
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    assert.equal(rw.sends.count, 1);
    assert.equal(bob(['lookupinvoice', invoice.paymentHash])['state'], 'ACCEPTED', 'bob holds the HTLC');
    // Restart: the interlock and P11 reopened from their files; new P12 and finality authorities with the read-only macaroon.
    await rw.interlock.close();
    await rw.outcomes.close();
    rw.interlock = await createSqliteLightningPaymentInterlock(rw.paths.interlock, { scope: { railId: rw.configuration.railId, network: 'regtest' }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(rw.witness, ORG) } });
    rw.outcomes = await createSqliteExecutionOutcomeStore(rw.paths.outcomes, { now: () => NOW });
    const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
    const reconciliation = p12(rw, resolutions);
    await reconciliation.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    assert.deepEqual(await reconciliation.reconcile({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'unresolved' }, 'in flight: no resolution');
    bob(['settleinvoice', preimage.toString('hex')]);
    let resolved: Awaited<ReturnType<typeof reconciliation.reconcile>> = { outcome: 'unresolved' };
    for (let read = 0; read < 20 && resolved.outcome !== 'resolved'; read += 1) {
      resolved = await reconciliation.reconcile({ organizationId: ORG, executionId: result.executionId! });
      if (resolved.outcome !== 'resolved') await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-completed', JSON.stringify(resolved));
    const settled = await settlement(rw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    assert.equal(settled.outcome === 'settled' && settled.settlement.basis.kind, 'resolution-confirmed-completed');
    assert.equal(rw.sends.count, 1, 'ONE node send in total');
    console.log(`PAY-06 regtest R3: execution ${result.executionId} unconfirmed → P12 confirmed-completed → settled ${settled.outcome === 'settled' ? settled.settlement.settlementId : ''}`);
    await rw.interlock.close();
  });

  it('R4 EXIT C — bob cancels the invoice: LND reports a terminal failure → P11 confirmed-not-completed; no settlement; no retry', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 });
    const invoice = await bobInvoice(rw, 50_000);
    bob(['cancelinvoice', invoice.paymentHash]);
    const result = await govern(rw, invoice);
    assert.equal(result.status, 'execution_failed', JSON.stringify(result));
    assert.equal(rw.sends.count, 1);
    const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
    assert.deepEqual(await settlement(rw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'not-eligible', state: 'not-settleable' });
    await rw.interlock.close();
  });

  it('R5 P12-LN-2 — a held HTLC that bob cancels: unconfirmed → P12 confirmed-not-completed', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 }, { paymentTimeoutSeconds: 8 });
    const preimage = randomBytes(32);
    const invoice = await bobInvoice(rw, 60_000, { preimage });
    const result = await govern(rw, invoice);
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    bob(['cancelinvoice', invoice.paymentHash]);
    const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
    const reconciliation = p12(rw, resolutions);
    await reconciliation.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    let resolved: Awaited<ReturnType<typeof reconciliation.reconcile>> = { outcome: 'unresolved' };
    for (let read = 0; read < 20 && resolved.outcome !== 'resolved'; read += 1) {
      resolved = await reconciliation.reconcile({ organizationId: ORG, executionId: result.executionId! });
      if (resolved.outcome !== 'resolved') await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-not-completed', JSON.stringify(resolved));
    assert.equal(rw.sends.count, 1);
    await rw.interlock.close();
  });

  it('R6 the same invoice under a second governed execution fails closed before LND; LND itself refuses a duplicate of a paid hash (defence in depth only)', async () => {
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 });
    const invoice = await bobInvoice(rw, 20_000);
    assert.equal((await govern(rw, invoice)).status, 'executed');
    assert.equal((await govern(rw, invoice)).status, 'execution_failed');
    assert.equal(rw.sends.count, 1, 'the second execution never reached the node');
    const lnd = createLndRestLightningNode(lndOptions(state(), 'payer'));
    await assert.rejects(lnd.sendPayment({ invoice: invoice.invoice, paymentHash: invoice.paymentHash, amountMsat: invoice.amountMsat, feeLimitMsat: 300_000n, timeoutSeconds: 10, deadlineMs: 15_000 }), LndRestNodeError, 'LND: invoice is already paid');
    await rw.interlock.close();
  });
  it('R7 payer identity — alice pays a held HTLC; carol (a real second node, same network) fails HER OWN attempt at the same invoice: a reader against carol proves nothing — P12 unresolved, finality not-final; alice resolves and settles; one send', async () => {
    const s = state();
    assert.ok(s.carol.endpoint !== undefined && s.files.carolCertificate !== undefined, 'regtest state from a run of the current lightning-regtest.mjs (carol read-only access)');
    const rw = await regtestWorld({ maximumFeeMsat: '300000', maximumFeePpm: 2000 }, { paymentTimeoutSeconds: 8 });
    const preimage = randomBytes(32);
    const invoice = await bobInvoice(rw, 70_000, { preimage });
    const result = await govern(rw, invoice);
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    const executionId = result.executionId!;
    assert.equal(rw.sends.count, 1);
    assert.equal(bob(['lookupinvoice', invoice.paymentHash])['state'], 'ACCEPTED', 'bob holds alice’s HTLC');
    // PAYER-1, live: the reservation names alice — the node whose nodeInfo the rail verified, and the node that sent.
    assert.equal((await rw.interlock.read(executionId))?.payerNodeId, s.alice.identity);

    // carol, operated outside Frontera, tries to pay the SAME invoice herself; bob refuses her HTLC (the set is accepted).
    try {
      execFileSync('docker', ['exec', 'frontera-pay06-carol', 'lncli', '--network=regtest', 'payinvoice', '--force', '--timeout=20s', '--json', invoice.invoice], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // lncli exits non-zero for a failed payment; carol's own record is read below.
    }
    const carolReader = createLndRestLightningNodeReader(carolOptions(s));
    assert.deepEqual(await carolReader.nodeInfo(10_000), { network: 'regtest', identity: s.carol.identity }, 'carol: same network, another identity');
    const carolStatus = await carolReader.paymentStatus(invoice.paymentHash, 10_000);
    assert.equal((carolStatus as { state?: string }).state, 'failed', `carol's own attempt is a real terminal failure for the same hash: ${JSON.stringify(carolStatus)}`);
    const aliceStatus = await createLndRestLightningNodeReader(lndOptions(s, 'reader')).paymentStatus(invoice.paymentHash, 10_000);
    assert.equal((aliceStatus as { state?: string }).state, 'in-flight', 'while alice’s payment is still in flight');

    // P12 through carol: unresolved — her FAILED is about her own attempt (before PAY-06 hardening: confirmed-not-completed).
    const resolutions = await createSqliteExecutionResolutionStore(rw.paths.resolutions, { now: () => NOW });
    const viaCarol = createExecutionReconciliationService({
      outcomes: rw.outcomes,
      resolutions,
      composition: snapshotResolutionAuthorities([createLightningResolutionAuthority({ configuration: rw.configuration, node: carolReader, interlock: rw.interlock })], () => LIGHTNING_RESOLUTION_AUTHORITY_ID, 'test'),
      claimed: async () => true,
      now: () => NOW,
    });
    await viaCarol.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID });
    assert.deepEqual(await viaCarol.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' }, 'carol cannot fail alice’s payment');
    assert.equal((await resolutions.read({ organizationId: ORG }, executionId))?.resolution, undefined);

    // bob settles alice's HTLC; carol's record stays FAILED.
    bob(['settleinvoice', preimage.toString('hex')]);
    const finalityQuery: PaymentFinalityQuery = {
      organizationId: ORG,
      executionId,
      requestId: 'req',
      decisionId: 'dec',
      basis: 'resolution-confirmed-completed',
      railId: rw.configuration.railId,
      providerRef: invoice.paymentHash,
      payment: { source: { accountId: ACCOUNT }, destination: lightningDestinationOf(s.bob.identity, invoice.paymentHash), amount: { value: btcDecimalOfMsat(invoice.amountMsat)!, unit: BTC }, purpose: 'vendor-payment' },
    };
    // Finality through carol: not-final — never contradicted by her failure (before PAY-06 hardening: contradicted, lightning.payment-failed).
    assert.deepEqual(await createLightningFinalityAuthority({ configuration: rw.configuration, node: carolReader, interlock: rw.interlock }).verifyFinality(finalityQuery), { outcome: 'not-final' });
    assert.deepEqual(await viaCarol.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' }, 'still nothing from carol after the settle');

    // alice, the bound payer: P12 resolves completed, finality settles, the evidence names alice.
    const reconciliation = p12(rw, resolutions);
    let resolved: Awaited<ReturnType<typeof reconciliation.reconcile>> = { outcome: 'unresolved' };
    for (let read = 0; read < 20 && resolved.outcome !== 'resolved'; read += 1) {
      resolved = await reconciliation.reconcile({ organizationId: ORG, executionId });
      if (resolved.outcome !== 'resolved') await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(resolved.outcome === 'resolved' && resolved.resolution.certainty, 'confirmed-completed', JSON.stringify(resolved));
    const settled = await settlement(rw, resolutions).verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    if (settled.outcome !== 'settled') return;
    assert.equal(facts(settled.settlement)['lightning.payer-node'], s.alice.identity);
    assert.equal(rw.sends.count, 1, 'ONE node send in total; carol’s attempt is not Frontera’s');
    console.log(`PAY-06 regtest R7: alice ${s.alice.identity.slice(0, 12)}… in flight; carol ${s.carol.identity.slice(0, 12)}… ${JSON.stringify(carolStatus)} → P12 via carol unresolved, finality via carol not-final; alice → confirmed-completed → settled`);
    await rw.interlock.close();
  });
});
