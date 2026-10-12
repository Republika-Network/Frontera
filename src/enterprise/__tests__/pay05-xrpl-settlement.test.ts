import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import { createInMemoryPaymentSettlementStore, createPaymentSettlementService, verifyPaymentReceipt } from '../payment-settlement/index.js';
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
