import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentIntent,
} from '../../features/payment-runtime/index.js';
import { XRPL_FINALITY_CONTRADICTIONS, createXrplRlusdRail, type XrplRlusdRailConfiguration } from '../../features/payment-runtime/rails/xrpl/index.js';
import { ISSUER as XRPL_ISSUER, OTHER_SOURCE, RLUSD_ASSET, TREASURY, VENDOR, createTestSoftwareXrplSigner, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryPaymentSettlementStore, createPaymentSettlementService, createSqlitePaymentSettlementStore, verifyPaymentReceipt, type PaymentReceipt, type PaymentSettlementStore } from '../payment-settlement/index.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { XRPL_FINALITY_AUTHORITY_ID, XRPL_FINALITY_METHOD, createXrplFinalityAuthority, readOnlyXrplFinalityLedger } from '../xrpl-payment-rail/xrpl-finality-authority.js';
import { XRPL_RESOLUTION_AUTHORITY_ID, createXrplResolutionAuthority, readOnlyXrplLedger } from '../xrpl-payment-rail/xrpl-resolution-authority.js';
import { ALLOWED_INTENT, IDENTITY, NOW, ORG, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';
import { SIMULATED_RESTART_QUARANTINE, createLedgerSimulator, scratch, type LedgerSimulator, type SimulatedOutcome } from './pay03-xrpl-fixture.js';

/**
 * PAY-05 — XRPL / RLUSD settlement finality, production-shaped: a governed
 * payment through the unchanged path, the PAY-01 bridge, the real PAY-02 rail
 * with PAY-03's durable interlock, P11 (and P12 where uncertain), then the
 * read-only XRPL finality authority re-reading the transaction from the ledger
 * and proving every governed field before a settlement is recorded.
 *
 * The ledger is PAY-03's deterministic simulator (rippled API v2 answers); a
 * live Testnet run is `pay05-xrpl-testnet-settlement.test.ts` (opt-in).
 */

const tmp = scratch('frontera-pay05-xrpl-');
after(() => tmp.cleanup());

const ACTION = ALLOWED_INTENT.action;
const ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: ACTION });
const ASSETS = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: RLUSD_ASSET, scale: 15 }]);
const CONFIGURATION: XrplRlusdRailConfiguration = testConfiguration({ sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress }], finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
const DESTINATION = { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` } as const;
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

interface XrplWorld {
  readonly world: GovernedWorld;
  readonly ledger: LedgerSimulator;
  readonly interlock: DurableXrplSubmissionInterlock;
  /** For an unconfirmed payment: the rail is done; from now on the ledger answers truthfully. */
  readonly ledgerDecides: () => void;
}

async function xrplWorld(outcome: SimulatedOutcome = 'success', options: { readonly railSeesPending?: boolean } = {}): Promise<XrplWorld> {
  const ledger = createLedgerSimulator();
  ledger.nextOutcome = outcome;
  const interlock = await createSqliteXrplSubmissionInterlock(join(tmp.dir(), 'interlock.sqlite'), { scope: { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId }, now: () => new Date().toISOString() });
  const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY)], interlock, ...testClock() });
  await rail.readiness();
  ledger.index += SIMULATED_RESTART_QUARANTINE;
  let railReading = options.railSeesPending === true;
  if (railReading) {
    // The rail's own finality loop sees "pending"; the ledger decides afterwards (an unconfirmed payment).
    const lookup = ledger.lookupTransaction.bind(ledger);
    ledger.lookupTransaction = async (query, timeoutMs) => (railReading ? { hash: query.hash, validated: false } : lookup(query, timeoutMs));
  }
  const world = buildGovernedWorld({
    monetary: { assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) },
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority('1000', '100000', RLUSD_ASSET),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
  });
  return { world, ledger, interlock, ledgerDecides: () => (railReading = false) };
}

function intent(value = '25.5'): PaymentIntent {
  const validation = validatePaymentIntent(
    { source: { accountId: ACCOUNT }, destination: DESTINATION, amount: { value, unit: RLUSD_ASSET }, purpose: 'vendor-payment', reference: 'INV-XRPL-1', rail: 'xrpl-rlusd', idempotencyKey: `xrpl-${Math.random().toString(36).slice(2)}` },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { intent: PaymentIntent }).intent;
}

function settlementFor(x: XrplWorld, resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW })) {
  const authority = createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplFinalityLedger(x.ledger), interlock: x.interlock });
  const service = createPaymentSettlementService({
    outcomes: x.world.outcomes,
    resolutions,
    governance: x.world.rawStore,
    payments: [BINDING],
    store: createInMemoryPaymentSettlementStore({ now: () => NOW }),
    authorities: [authority],
    selectAuthority: (context) => (context.railId === CONFIGURATION.railId || context.rail === CONFIGURATION.railId ? XRPL_FINALITY_AUTHORITY_ID : 'none'),
    now: () => NOW,
  });
  return { service, authority, resolutions };
}

async function governedXrplPayment(outcome: SimulatedOutcome = 'success', options: { readonly railSeesPending?: boolean } = {}) {
  const x = await xrplWorld(outcome, options);
  const result = await x.world.orchestrator.govern(IDENTITY, compilePaymentIntent(intent(), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
  assert.ok(result.executionId !== undefined, JSON.stringify(result));
  x.ledgerDecides();
  return { ...x, result, executionId: result.executionId };
}

describe('PAY-05 XRPL — governed RLUSD payment → final validated ledger proof → settlement → receipt', () => {
  it('S7 (XRPL): the authority re-reads the validated transaction and proves every field; settled with normalized evidence', async () => {
    const x = await governedXrplPayment('success');
    assert.equal(x.result.status, 'executed', JSON.stringify(x.result));
    const submissions = x.ledger.calls.submit;
    const { service } = settlementFor(x);
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'status', state: 'awaiting-finality' }, 'P11 completed is not settled');
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: x.executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    if (settled.outcome !== 'settled') return;
    const finality = settled.settlement.finality;
    assert.equal(finality.authorityId, XRPL_FINALITY_AUTHORITY_ID);
    assert.equal(finality.method, XRPL_FINALITY_METHOD);
    assert.match(finality.providerRef, /^[0-9A-F]{64}$/);
    assert.match(finality.finalizedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'the validated ledger’s consensus close time');
    const facts = Object.fromEntries(finality.facts.map((fact) => [fact.name, fact.value]));
    assert.deepEqual(Object.keys(facts).sort(), ['xrpl.currency', 'xrpl.delivered-value', 'xrpl.destination-address', 'xrpl.destination-tag', 'xrpl.issuer', 'xrpl.ledger-hash', 'xrpl.ledger-index', 'xrpl.network-id', 'xrpl.source-address', 'xrpl.transaction-result']);
    assert.equal(facts['xrpl.network-id'], '1');
    assert.equal(facts['xrpl.source-address'], TREASURY.classicAddress);
    assert.equal(facts['xrpl.destination-tag'], '4471');
    assert.equal(facts['xrpl.issuer'], XRPL_ISSUER.classicAddress);
    assert.equal(settled.settlement.railId, 'xrpl-rlusd');
    assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });
    assert.equal(JSON.stringify(settled).includes(TREASURY.seed ?? '<none>'), false, 'no key material anywhere');
    assert.equal(x.ledger.calls.submit, submissions, 'settlement submitted nothing');
    await x.interlock.close();
  });

  it('S4 (XRPL): unconfirmed → the P12 XRPL resolver resolves completed → the finality authority independently proves finality', async () => {
    const x = await governedXrplPayment('success', { railSeesPending: true });
    assert.equal(x.result.status, 'execution_unconfirmed', JSON.stringify(x.result));
    const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
    const { service } = settlementFor(x, resolutions);
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-eligible', state: 'execution-uncertain' });
    const resolver = createXrplResolutionAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplLedger(x.ledger), interlock: x.interlock });
    const reconciliation = createExecutionReconciliationService({ outcomes: x.world.outcomes, resolutions, composition: snapshotResolutionAuthorities([resolver], () => XRPL_RESOLUTION_AUTHORITY_ID, 'test'), claimed: async () => true, now: () => NOW });
    await reconciliation.adoptResolutionAuthority({ organizationId: ORG, executionId: x.executionId, authorityId: XRPL_RESOLUTION_AUTHORITY_ID });
    assert.equal((await reconciliation.reconcile({ organizationId: ORG, executionId: x.executionId })).outcome, 'resolved');
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: x.executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    assert.equal(settled.outcome === 'settled' && settled.settlement.basis.kind, 'resolution-confirmed-completed');
    assert.equal(x.ledger.calls.submit, 1, 'one submission, ever');
    await x.interlock.close();
  });

  for (const [label, tamper, expected] of [
    ['S12 (XRPL): the ledger transaction comes from another account', { Account: OTHER_SOURCE.classicAddress }, XRPL_FINALITY_CONTRADICTIONS.fieldMismatch],
    ['S11 (XRPL): another destination tag', { DestinationTag: 4472 }, XRPL_FINALITY_CONTRADICTIONS.fieldMismatch],
    ['S9 (XRPL): another instructed amount', { DeliverMax: 'tamper-amount' }, XRPL_FINALITY_CONTRADICTIONS.fieldMismatch],
    ['partial-payment flag', { Flags: 0x00020000 }, XRPL_FINALITY_CONTRADICTIONS.fieldMismatch],
  ] as const) {
    it(`${label} → contradicted; nothing recorded`, async () => {
      const x = await governedXrplPayment('success');
      const lookup = x.ledger.lookupTransaction.bind(x.ledger);
      x.ledger.lookupTransaction = async (query, timeoutMs) => {
        const answer = (await lookup(query, timeoutMs)) as Record<string, unknown>;
        const tx = { ...(answer['tx_json'] as Record<string, unknown>) };
        for (const [key, value] of Object.entries(tamper)) tx[key] = value === 'tamper-amount' ? { ...(tx['DeliverMax'] as Record<string, unknown>), value: '25.6' } : value;
        return { ...answer, tx_json: tx };
      };
      const { service } = settlementFor(x);
      assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'finality-contradicted', reason: expected });
      assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'status', state: 'awaiting-finality' });
      await x.interlock.close();
    });
  }

  it('S10 (XRPL): delivered in another currency or from another issuer → contradicted', async () => {
    const x = await governedXrplPayment('success');
    const lookup = x.ledger.lookupTransaction.bind(x.ledger);
    x.ledger.lookupTransaction = async (query, timeoutMs) => {
      const answer = (await lookup(query, timeoutMs)) as Record<string, unknown>;
      const meta = answer['meta'] as Record<string, unknown>;
      return { ...answer, meta: { ...meta, delivered_amount: { ...(meta['delivered_amount'] as Record<string, unknown>), issuer: TREASURY.classicAddress } } };
    };
    const { service } = settlementFor(x);
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'finality-contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.deliveredMismatch });
    await x.interlock.close();
  });

  it('S13 (XRPL): a server on another network, an unreachable server, a lagging (unvalidated) answer → not final, never negative', async () => {
    const x = await governedXrplPayment('success');
    const { service } = settlementFor(x);
    x.ledger.networkId = 0;
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' });
    x.ledger.networkId = 1;
    x.ledger.unavailable = true;
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' });
    x.ledger.unavailable = false;
    const lookup = x.ledger.lookupTransaction.bind(x.ledger);
    x.ledger.lookupTransaction = async (query) => ({ hash: query.hash, validated: false });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' });
    x.ledger.lookupTransaction = lookup;
    assert.equal((await service.verifySettlement({ organizationId: ORG, executionId: x.executionId })).outcome, 'settled', 'availability restored, finality proven');
    await x.interlock.close();
  });

  it('a hash alone is not proof: without the interlock record of this execution the authority answers not final', async () => {
    const x = await governedXrplPayment('success');
    const authority = createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplFinalityLedger(x.ledger), interlock: { read: async () => undefined } });
    const query = { organizationId: ORG, executionId: x.executionId, requestId: 'r', decisionId: 'd', basis: 'provider-confirmed-completed' as const, providerRef: 'A'.repeat(64), payment: { source: { accountId: ACCOUNT }, destination: DESTINATION, amount: { value: '25.5', unit: RLUSD_ASSET }, purpose: 'vendor-payment' as const } };
    assert.deepEqual(await authority.verifyFinality(query), { outcome: 'not-final' });
    await x.interlock.close();
  });

  it('S20 (XRPL): the finality authority is read-only — its ledger capability carries no submit, autofill or signer', async () => {
    const x = await xrplWorld();
    const reader = readOnlyXrplFinalityLedger(x.ledger);
    assert.deepEqual(Object.keys(reader).sort(), ['connect', 'ledgerHeader', 'lookupTransaction', 'serverInfo', 'validatedLedgerIndex']);
    assert.equal(Object.isFrozen(reader), true);
    const authority = createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: reader, interlock: x.interlock });
    assert.deepEqual(Object.keys(authority).sort(), ['authorityId', 'verifyFinality']);
    await x.interlock.close();
  });
});

describe('PAY-05 hardening DET-1 – DET-6 — a final XRPL transaction always yields the same canonical settlement and receipt', () => {
  /** A settlement service over its own store and its own local clock: nothing local may reach the canonical content. */
  function serviceOver(x: XrplWorld, store: PaymentSettlementStore, now: () => string) {
    return createPaymentSettlementService({
      outcomes: x.world.outcomes,
      resolutions: createInMemoryExecutionResolutionStore({ now }),
      governance: x.world.rawStore,
      payments: [BINDING],
      store,
      authorities: [createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplFinalityLedger(x.ledger), interlock: x.interlock })],
      selectAuthority: () => XRPL_FINALITY_AUTHORITY_ID,
      now,
    });
  }
  const clock = (instant: string) => () => instant;

  async function settledReceipt(x: XrplWorld & { readonly executionId: string }, store: PaymentSettlementStore = createInMemoryPaymentSettlementStore({ now: clock(NOW) }), now = clock(NOW)): Promise<{ readonly receipt: PaymentReceipt; readonly contentDigest: string; readonly proofDigest: string }> {
    const settled = await serviceOver(x, store, now).verifySettlement({ organizationId: ORG, executionId: x.executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    if (settled.outcome !== 'settled') throw new Error('unreachable');
    assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });
    return { receipt: settled.receipt, contentDigest: settled.settlement.contentDigest, proofDigest: settled.settlement.finality.proofDigest };
  }

  it('DET-1: the final transaction, ledger header available → canonical receipt R, carrying the validated ledger’s hash and close time', async () => {
    const x = await governedXrplPayment('success');
    const r = await settledReceipt(x);
    assert.match(r.receipt.finality.finalizedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const again = await settledReceipt(x);
    assert.deepEqual(again, r, 'a second verification into another store: byte-identical');
    await x.interlock.close();
  });

  it('DET-2: the ledger header temporarily unavailable → not final, nothing recorded; once readable → exactly R', async () => {
    const x = await governedXrplPayment('success');
    const r = await settledReceipt(x);
    const store = createInMemoryPaymentSettlementStore({ now: clock(NOW) });
    const service = serviceOver(x, store, clock(NOW));
    x.ledger.headerUnavailable = true;
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' }, 'never a weaker final answer');
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'status', state: 'awaiting-finality' });
    assert.equal(await store.read({ organizationId: ORG }, x.executionId), undefined);
    x.ledger.headerUnavailable = false;
    assert.deepEqual(await settledReceipt(x, store), r);
    await x.interlock.close();
  });

  it('DET-3: a tx answer with ledger_hash present or absent (API v2 / v1 shape) → the same R; a tx ledger_hash that disagrees with the header is refused', async () => {
    const x = await governedXrplPayment('success');
    const r = await settledReceipt(x);
    x.ledger.lookupOmitsLedgerHash = true;
    assert.deepEqual(await settledReceipt(x), r, 'the hash comes from the validated header, not from the answer shape');
    x.ledger.lookupOmitsLedgerHash = false;
    const lookup = x.ledger.lookupTransaction.bind(x.ledger);
    x.ledger.lookupTransaction = async (query, timeoutMs) => ({ ...((await lookup(query, timeoutMs)) as Record<string, unknown>), ledger_hash: 'F'.repeat(64) });
    assert.deepEqual(await serviceOver(x, createInMemoryPaymentSettlementStore({ now: clock(NOW) }), clock(NOW)).verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' });
    x.ledger.lookupTransaction = lookup;
    const header = x.ledger.ledgerHeader!.bind(x.ledger);
    for (const broken of [{ ledger_hash: undefined }, { ledger_hash: 'not-hex' }, { ledger_index: 1 }, { validated: false }, { close_time: undefined }]) {
      x.ledger.ledgerHeader = async (index) => ({ ...((await header(index)) as Record<string, unknown>), ...broken });
      assert.deepEqual(await serviceOver(x, createInMemoryPaymentSettlementStore({ now: clock(NOW) }), clock(NOW)).verifySettlement({ organizationId: ORG, executionId: x.executionId }), { outcome: 'not-final' }, JSON.stringify(broken));
    }
    x.ledger.ledgerHeader = header;
    await x.interlock.close();
  });

  it('DET-4: the settlement SQLite store is lost → re-verifying the same transaction rebuilds exactly the same receipt (receiptDigest identical)', async () => {
    const x = await governedXrplPayment('success');
    const path = join(tmp.dir(), 'settlements.sqlite');
    let store = await createSqlitePaymentSettlementStore(path, { now: clock('2026-01-01T00:00:00.000Z') });
    const r = await settledReceipt(x, store, clock('2026-01-01T00:00:00.000Z'));
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    store = await createSqlitePaymentSettlementStore(path, { now: clock('2027-06-30T12:00:00.000Z') });
    x.ledger.index += 50; // the network moved on; the validated ledger the transaction is in did not
    const rebuilt = await settledReceipt(x, store, clock('2027-06-30T12:00:00.000Z'));
    assert.equal(rebuilt.receipt.receiptDigest, r.receipt.receiptDigest);
    assert.deepEqual(rebuilt, r);
    await store.close();
    await x.interlock.close();
  });

  it('DET-5: the same transaction after a restart → the same settlement contentDigest', async () => {
    const x = await governedXrplPayment('success');
    const path = join(tmp.dir(), 'settlements.sqlite');
    let store = await createSqlitePaymentSettlementStore(path, { now: clock(NOW) });
    const r = await settledReceipt(x, store);
    await store.close();
    store = await createSqlitePaymentSettlementStore(path, { now: clock('2027-01-01T00:00:00.000Z') });
    const service = serviceOver(x, store, clock('2027-01-01T00:00:00.000Z'));
    const read = await service.readSettlement({ organizationId: ORG, executionId: x.executionId });
    assert.equal(read.outcome === 'status' && read.settlement?.contentDigest, r.contentDigest);
    const reverified = await service.verifySettlement({ organizationId: ORG, executionId: x.executionId });
    assert.equal(reverified.outcome === 'settled' && reverified.settlement.contentDigest, r.contentDigest);
    assert.deepEqual(reverified.outcome === 'settled' && reverified.receipt, r.receipt);
    await store.close();
    await x.interlock.close();
  });

  it('DET-6: optional enrichment in either answer cannot affect receipt identity; the header capability is required', async () => {
    const x = await governedXrplPayment('success');
    const r = await settledReceipt(x);
    const lookup = x.ledger.lookupTransaction.bind(x.ledger);
    const header = x.ledger.ledgerHeader!.bind(x.ledger);
    x.ledger.lookupTransaction = async (query, timeoutMs) => ({ ...((await lookup(query, timeoutMs)) as Record<string, unknown>), close_time_iso: '2030-01-01T00:00:00Z', ctid: 'C000000000000000', date: 1 });
    x.ledger.ledgerHeader = async (index) => ({ ...((await header(index)) as Record<string, unknown>), close_time_iso: '2030-01-01T00:00:00Z', parent_hash: 'E'.repeat(64) });
    assert.deepEqual(await settledReceipt(x), r);
    const { ledgerHeader: _withheld, ...headerless } = readOnlyXrplFinalityLedger(x.ledger);
    assert.throws(() => createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: headerless as never, interlock: x.interlock }), /ledgerHeader/);
    assert.throws(() => readOnlyXrplFinalityLedger(headerless as never), /ledgerHeader/);
    await x.interlock.close();
  });
});
