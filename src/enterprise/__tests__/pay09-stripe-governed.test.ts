import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { STRIPE_RAIL_ID, createStripeRail, readOnlyStripe, stripeDestinationOf, type StripePaymentReader, type StripeRail } from '../../features/payment-runtime/rails/stripe/index.js';
import {
  CONNECTED_ACCOUNT,
  OTHER_CONNECTED_ACCOUNT,
  OTHER_PLATFORM_ACCOUNT,
  TEST_CUSTOMER,
  TEST_PAYMENT_METHOD,
  USD_ASSET,
  createSimulatedStripe,
  testRailConfiguration,
  type SimulatedStripe,
} from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryPaymentSettlementStore, createPaymentSettlementService, verifyPaymentReceipt, type PaymentSettlementStore } from '../payment-settlement/index.js';
import { STRIPE_FINALITY_AUTHORITY_ID, STRIPE_FINALITY_METHOD, createStripeFinalityAuthority, stripeFundingCommitment } from '../stripe-payment-rail/stripe-finality-authority.js';
import { STRIPE_RESOLUTION_AUTHORITY_ID, createStripeResolutionAuthority } from '../stripe-payment-rail/stripe-resolution-authority.js';
import { createSqliteStripePaymentInterlock, type DurableStripePaymentInterlock } from '../stripe-payment-rail/sqlite-stripe-payment-interlock.js';
import { ALLOWED_INTENT, DENIED_ACTOR, IDENTITY, NOW, ORG, buildGovernedWorld, identityFor, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';
import { boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * PAY-09 — the exit proofs: the SAME Frontera CORE, unchanged, governs a fiat
 * rail. A canonical `PaymentIntent` in USD to a Stripe connected account
 * compiles through PAY-01, is decided and granted by the unchanged spine
 * (Kernel, policy, P10 ceiling, grant, P7, write-ahead claim), and reaches the
 * Stripe rail only through PAY-01's bridge; P11 records the processor's
 * certainty, P12 resolves uncertainty by retrieving the bound PaymentIntent,
 * and PAY-05 settles only on a processor-confirmed `succeeded` with every
 * term exact — producing the generic, deterministic receipt.
 *
 * Below the bridge: the real rail, the real durable interlock anchored at a
 * real CORE-07 witness, and a deterministic Stripe simulator below the
 * external port (counted creates, confirmations, charges). No Stripe test-mode
 * credentials were available to this qualification; see
 * `docs/payments/PAY-09-STRIPE-FIAT-RAIL.md` §20.
 */

const made: string[] = [];
const dir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay09-governed-'));
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
const ASSETS = createMonetaryAssetRegistry([{ assetId: USD_ASSET, scale: 2 }]);
const CONFIGURATION = testRailConfiguration({ fundingSources: [{ accountId: ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD }] });
const SCOPE = { railId: CONFIGURATION.railId, mode: CONFIGURATION.mode, platformAccountId: CONFIGURATION.platformAccountId } as const;
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

interface StripeWorld {
  readonly world: GovernedWorld;
  readonly stripe: SimulatedStripe;
  readonly rail: StripeRail;
  readonly witness: StartedWitness;
  readonly paths: { readonly interlock: string; readonly outcomes: string; readonly resolutions: string };
  interlock: DurableStripePaymentInterlock;
  outcomes: ExecutionOutcomeStore;
}

const clock = (): string => new Date().toISOString();

async function stripeWorld(options: { readonly ceiling?: string; readonly revoke?: boolean } = {}): Promise<StripeWorld> {
  const directory = dir();
  const paths = { interlock: join(directory, 'interlock.sqlite'), outcomes: join(directory, 'outcomes.sqlite'), resolutions: join(directory, 'resolutions.sqlite') };
  const witness = await startWitness();
  const stripe = createSimulatedStripe();
  const interlock = await createSqliteStripePaymentInterlock(paths.interlock, { scope: SCOPE, now: clock, freshness: { boundary: await boundaryFor(witness, ORG) } });
  const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
  const rail = createStripeRail({ configuration: CONFIGURATION, stripe, interlock });
  let revoke = options.revoke === true;
  const world = buildGovernedWorld({
    monetary: { assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) },
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority(options.ceiling ?? '100', '100000', USD_ASSET),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
    executionOutcomes: outcomes,
    beforeExercise: async ({ ace }, grantId) => {
      if (!revoke) return;
      revoke = false;
      await ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
    },
  });
  return { world, stripe, rail, witness, paths, interlock, outcomes };
}

function intentFor(overrides: Record<string, unknown> = {}): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: ACCOUNT },
      destination: stripeDestinationOf(CONNECTED_ACCOUNT),
      amount: { value: '75.00', unit: USD_ASSET },
      purpose: 'purchase',
      reference: 'INV-STRIPE-1',
      rail: STRIPE_RAIL_ID,
      idempotencyKey: `stripe-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { intent: PaymentIntent }).intent;
}

async function govern(sw: StripeWorld, intent: PaymentIntent = intentFor(), who = IDENTITY) {
  return sw.world.orchestrator.govern(who, compilePaymentIntent(intent, BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
}

function settlementService(sw: StripeWorld, resolutions: ExecutionResolutionStore, reader: StripePaymentReader = sw.stripe, store: PaymentSettlementStore = createInMemoryPaymentSettlementStore({ now: () => NOW })) {
  const authority = createStripeFinalityAuthority({ configuration: CONFIGURATION, stripe: readOnlyStripe(reader), interlock: sw.interlock });
  return createPaymentSettlementService({
    outcomes: sw.outcomes,
    resolutions,
    governance: sw.world.rawStore,
    payments: [BINDING],
    store,
    authorities: [authority],
    selectAuthority: (context) => (context.railId === CONFIGURATION.railId || context.rail === CONFIGURATION.railId ? STRIPE_FINALITY_AUTHORITY_ID : 'none'),
    now: () => NOW,
  });
}

function reconciliation(sw: StripeWorld, resolutions: ExecutionResolutionStore, reader: StripePaymentReader = sw.stripe, configuration = CONFIGURATION) {
  const authority = createStripeResolutionAuthority({ configuration, stripe: readOnlyStripe(reader), interlock: sw.interlock });
  return createExecutionReconciliationService({
    outcomes: sw.outcomes,
    resolutions,
    composition: snapshotResolutionAuthorities([authority], () => STRIPE_RESOLUTION_AUTHORITY_ID, 'test'),
    claimed: async () => true,
    now: () => NOW,
  });
}

/** Restart: the interlock and P11 store reopened from disk, the rail recomposed over the same Stripe. */
async function restart(sw: StripeWorld): Promise<void> {
  await sw.interlock.close();
  await sw.outcomes.close();
  sw.interlock = await createSqliteStripePaymentInterlock(sw.paths.interlock, { scope: SCOPE, now: clock, freshness: { boundary: await boundaryFor(sw.witness, ORG) } });
  sw.outcomes = await createSqliteExecutionOutcomeStore(sw.paths.outcomes, { now: () => NOW });
}

const observed = (record: { readonly terminal?: { readonly observation: unknown } } | undefined): { readonly certainty?: string; readonly providerRef?: string } | undefined => record?.terminal?.observation as { readonly certainty?: string; readonly providerRef?: string } | undefined;
const show = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
const effects = (stripe: SimulatedStripe) => ({ creates: stripe.calls.create, confirms: stripe.calls.confirmReceived, charges: stripe.charges() });

describe('PAY-09 EXIT PROOF A — success: governed USD payment → one confirmation → P11 → processor finality → settled → deterministic receipt', () => {
  it('the unchanged spine governs Stripe end to end; settlement only after the processor confirmed every term', async () => {
    const sw = await stripeWorld();
    const result = await govern(sw);
    assert.equal(result.status, 'executed', show(result));
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 1 }, 'ONE PaymentIntent, ONE confirmation, ONE charge');
    const intent = sw.stripe.intents()[0]!;
    assert.equal(intent.amountCents, 7500n, 'USD 75.00 → 7500 cents, exactly');
    assert.equal(intent.destinationAccountId, CONNECTED_ACCOUNT);
    const record = await sw.outcomes.read({ organizationId: ORG }, result.executionId!);
    assert.equal(observed(record)?.certainty, 'confirmed-completed');
    assert.equal(observed(record)?.providerRef, intent.id, 'P11 holds the PaymentIntent id as an opaque handle');

    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = settlementService(sw, resolutions);
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'status', state: 'awaiting-finality' }, 'P11 completed is NOT settled');
    const before = effects(sw.stripe);
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', show(settled));
    if (settled.outcome !== 'settled') return;
    assert.deepEqual(effects(sw.stripe), before, 'FIN-S8 finality performs zero money effects');
    const finality = settled.settlement.finality;
    assert.equal(finality.authorityId, STRIPE_FINALITY_AUTHORITY_ID);
    assert.equal(finality.method, STRIPE_FINALITY_METHOD);
    assert.equal(finality.providerRef, intent.id);
    assert.equal(finality.finalizedAt, undefined, 'no Stripe timestamp claimed as a finality instant');
    const facts = Object.fromEntries(finality.facts.map((fact) => [fact.name, fact.value]));
    assert.deepEqual(Object.keys(facts).sort(), [
      'stripe.amount-cents',
      'stripe.currency',
      'stripe.destination-account',
      'stripe.finality-basis',
      'stripe.funding-commitment',
      'stripe.latest-charge',
      'stripe.mode',
      'stripe.payment-intent',
      'stripe.platform-account',
      'stripe.status',
    ]);
    assert.equal(facts['stripe.finality-basis'], 'processor-confirmed', 'the evidence says what final means here');
    assert.equal(facts['stripe.amount-cents'], '7500');
    assert.equal(facts['stripe.funding-commitment'], stripeFundingCommitment(TEST_CUSTOMER, TEST_PAYMENT_METHOD));
    assert.equal(settled.settlement.payment.amount.value, '75');
    assert.equal(settled.settlement.railId, STRIPE_RAIL_ID);
    assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });
    assert.equal(settled.receipt.format, 'frontera.payment-receipt.v1', 'the generic PAY-05 receipt — no Stripe receipt type');
    const everything = show({ settled, record });
    for (const forbidden of [TEST_CUSTOMER, TEST_PAYMENT_METHOD, 'client_secret', '_secret_', 'sk_test', 'whsec']) assert.equal(everything.includes(forbidden), false, forbidden);

    // Deterministic: the same payment yields the same settlement content after the store is lost.
    const again = await settlementService(sw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(again.outcome === 'settled' ? again.settlement.contentDigest : undefined, settled.settlement.contentDigest);
    assert.equal(again.outcome === 'settled' ? again.receipt.receiptDigest : undefined, settled.receipt.receiptDigest);
    await resolutions.close();
    await sw.interlock.close();
  });
});

describe('PAY-09 governed — nothing reaches Stripe unless granted (denial, over-ceiling, revocation)', () => {
  it('DENIAL: an unrecognized principal is denied → zero Stripe calls of any kind', async () => {
    const sw = await stripeWorld();
    const result = await govern(sw, intentFor(), identityFor({ actorId: DENIED_ACTOR }));
    assert.notEqual(result.status, 'executed');
    assert.ok(['denied', 'rejected'].includes(result.status), result.status);
    assert.deepEqual(sw.stripe.calls, { create: 0, confirmAttempted: 0, confirmReceived: 0, retrieve: 0, account: 0 });
    await sw.interlock.close();
  });

  it('OVER-CEILING: P10 withholds above the ceiling — Stripe’s own limits are never relied on', async () => {
    const sw = await stripeWorld({ ceiling: '50' });
    const result = await govern(sw);
    assert.equal(result.status, 'withheld', show(result));
    assert.equal((result as { withheldBy?: string }).withheldBy, 'authority-binding');
    assert.ok(result.reasonCodes.includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), show(result.reasonCodes));
    assert.deepEqual(sw.stripe.calls, { create: 0, confirmAttempted: 0, confirmReceived: 0, retrieve: 0, account: 0 });
    await sw.interlock.close();
  });

  it('REVOKED-BEFORE-EFFECT: the grant is revoked at the shared checkpoint → no confirmation, no charge', async () => {
    const sw = await stripeWorld({ revoke: true });
    const result = await govern(sw);
    assert.equal(result.status, 'withheld', show(result));
    assert.equal((result as { withheldBy?: string }).withheldBy, 'exercise');
    assert.deepEqual(sw.stripe.calls, { create: 0, confirmAttempted: 0, confirmReceived: 0, retrieve: 0, account: 0 });
    await sw.interlock.close();
  });
});

describe('PAY-09 governed — replay and uncertainty', () => {
  it('SUCCESSFUL REPLAY: the exact governed request again → the same lifecycle result, no second PaymentIntent, confirmation or charge', async () => {
    const sw = await stripeWorld();
    const intent = intentFor();
    const first = await govern(sw, intent);
    const second = await govern(sw, intent);
    assert.equal(first.status, 'executed');
    assert.equal(second.status, 'executed');
    assert.equal(second.executionId, first.executionId);
    assert.equal((second as { replayed?: boolean }).replayed, true);
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 1 });
    await sw.interlock.close();
  });

  it('CRASH AFTER REQUEST: Stripe charged, the answer was lost → P11 unconfirmed → restart → P12 retrieves the bound PaymentIntent → completed → settled; one charge', async () => {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'succeed-response-lost';
    const intent = intentFor();
    const result = await govern(sw, intent);
    assert.equal(result.status, 'execution_unconfirmed', show(result));
    const pi = sw.stripe.intents()[0]!.id;
    assert.equal(observed(await sw.outcomes.read({ organizationId: ORG }, result.executionId!))?.certainty, 'unconfirmed');
    // The governed replay never resends.
    assert.equal((await govern(sw, intent)).status, 'execution_unconfirmed');
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 1 });

    await restart(sw);
    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = reconciliation(sw, resolutions);
    await service.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: STRIPE_RESOLUTION_AUTHORITY_ID });
    const resolved = await service.reconcile({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(resolved.outcome, 'resolved', show(resolved));
    if (resolved.outcome !== 'resolved') return;
    assert.equal(resolved.resolution.certainty, 'confirmed-completed');
    assert.equal(resolved.resolution.providerRef, pi);
    const settled = await settlementService(sw, resolutions).verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', show(settled));
    assert.equal(settled.outcome === 'settled' ? settled.settlement.basis.kind : undefined, 'resolution-confirmed-completed');
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 1 }, 'P12 and finality added nothing');
    await resolutions.close();
    await sw.interlock.close();
  });

  it('PROCESSING: P11 unconfirmed → P12 unresolved while processing → Stripe succeeds → P12 completed; no resend', async () => {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'processing';
    const result = await govern(sw);
    assert.equal(result.status, 'execution_unconfirmed');
    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = reconciliation(sw, resolutions);
    await service.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: STRIPE_RESOLUTION_AUTHORITY_ID });
    assert.equal((await service.reconcile({ organizationId: ORG, executionId: result.executionId! })).outcome, 'unresolved', 'P12-S2 processing remains unresolved');
    assert.equal((await settlementService(sw, resolutions).readSettlement({ organizationId: ORG, executionId: result.executionId! })).outcome, 'status');
    sw.stripe.settle(sw.stripe.intents()[0]!.id);
    const resolved = await service.reconcile({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(resolved.outcome === 'resolved' ? resolved.resolution.certainty : resolved.outcome, 'confirmed-completed');
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 1 });
    await resolutions.close();
    await sw.interlock.close();
  });

  it('REQUIRES_ACTION: unconfirmed; P12 unresolved; never confirmed again, never an interactive flow', async () => {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'requires-action';
    const result = await govern(sw);
    assert.equal(result.status, 'execution_unconfirmed');
    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = reconciliation(sw, resolutions);
    await service.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: STRIPE_RESOLUTION_AUTHORITY_ID });
    assert.equal((await service.reconcile({ organizationId: ORG, executionId: result.executionId! })).outcome, 'unresolved');
    assert.equal(sw.stripe.calls.confirmAttempted, 1);
    await resolutions.close();
    await sw.interlock.close();
  });

  it('DEFINITIVE FAILURE: a decline → P11 confirmed-not-completed → not settleable, no receipt, never retried', async () => {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'decline';
    const result = await govern(sw);
    assert.equal(result.status, 'execution_failed', show(result));
    assert.equal(observed(await sw.outcomes.read({ organizationId: ORG }, result.executionId!))?.certainty, 'confirmed-not-completed');
    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = settlementService(sw, resolutions);
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId: result.executionId! }), { outcome: 'status', state: 'not-settleable' });
    assert.equal(await service.receipt({ organizationId: ORG, executionId: result.executionId! }), undefined);
    assert.deepEqual(effects(sw.stripe), { creates: 1, confirms: 1, charges: 0 });
    await resolutions.close();
    await sw.interlock.close();
  });

  it('OUT-OF-BAND RECONFIRMATION (C11, trust assumption): after Frontera recorded confirmed-not-completed, an actor with Stripe write authority makes the SAME PaymentIntent succeed — Frontera never reconfirms it, never rewrites the P11 observation, never settles or receipts it', async () => {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'decline';
    const intent = intentFor();
    const result = await govern(sw, intent);
    assert.equal(result.status, 'execution_failed', show(result));
    const executionId = result.executionId!;
    const initial = observed(await sw.outcomes.read({ organizationId: ORG }, executionId));
    assert.equal(initial?.certainty, 'confirmed-not-completed');
    const pi = sw.stripe.intents()[0]!.id;
    assert.equal(sw.stripe.intent(pi)?.status, 'requires_payment_method', 'Stripe would accept a new confirmation of this object');
    // Outside Frontera: someone with the platform's Stripe write authority attaches a method and confirms it again.
    sw.stripe.settle(pi);
    assert.equal(sw.stripe.intent(pi)?.status, 'succeeded');
    // 1. The P11 observation is immutable: Frontera's one confirmation attempt failed, and that record never changes.
    assert.deepEqual(observed(await sw.outcomes.read({ organizationId: ORG }, executionId)), initial);
    // 2. P12 does not rewrite P11: a definitive initial observation is never "resolved" again — whatever Stripe now says.
    const resolutions = await createSqliteExecutionResolutionStore(sw.paths.resolutions, { now: () => NOW });
    const service = reconciliation(sw, resolutions, sw.stripe, CONFIGURATION);
    await service.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: STRIPE_RESOLUTION_AUTHORITY_ID }).catch(() => undefined);
    const reconciled = await service.reconcile({ organizationId: ORG, executionId }).catch((error: unknown) => ({ outcome: `refused:${String((error as { code?: unknown }).code ?? error)}` }));
    assert.notEqual((reconciled as { outcome: string }).outcome, 'resolved', JSON.stringify(reconciled));
    assert.equal(observed(await sw.outcomes.read({ organizationId: ORG }, executionId))?.certainty, 'confirmed-not-completed');
    // 3. Nothing settles or receipts on the strength of the out-of-band success.
    const settlement = settlementService(sw, resolutions);
    assert.deepEqual(await settlement.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'not-settleable' });
    assert.equal(await settlement.receipt({ organizationId: ORG, executionId }), undefined);
    // 4. The exact governed request again: no second PaymentIntent, and Frontera never confirms the failed one again.
    sw.stripe.confirmBehaviour = 'succeed';
    const replay = await govern(sw, intent);
    assert.equal(replay.executionId, executionId);
    assert.equal(replay.status, 'execution_failed', 'the replay answers the recorded P11 outcome, not what Stripe now says');
    assert.equal(sw.stripe.calls.create, 1);
    assert.equal(sw.stripe.calls.confirmReceived, 1, "Frontera's one confirmation; the success came from outside it");
    await resolutions.close();
    await sw.interlock.close();
  });
});

describe('PAY-09 P12 matrix (P12-S1 … P12-S12) — read-only resolution of the bound PaymentIntent', () => {
  /** One uncertain execution (processing), its P12 service, and a reader that can be swapped. */
  async function uncertain() {
    const sw = await stripeWorld();
    sw.stripe.confirmBehaviour = 'processing';
    const result = await govern(sw);
    assert.equal(result.status, 'execution_unconfirmed');
    const resolutions = await createSqliteExecutionResolutionStore(join(dir(), 'resolutions.sqlite'), { now: () => NOW });
    const pi = sw.stripe.intents()[0]!.id;
    const resolve = async (reader: StripePaymentReader = sw.stripe, configuration = CONFIGURATION) => {
      const service = reconciliation(sw, resolutions, reader, configuration);
      await service.adoptResolutionAuthority({ organizationId: ORG, executionId: result.executionId!, authorityId: STRIPE_RESOLUTION_AUTHORITY_ID }).catch(() => undefined);
      const answer = await service.reconcile({ organizationId: ORG, executionId: result.executionId! });
      return answer.outcome === 'resolved' ? answer.resolution.certainty : answer.outcome;
    };
    return { sw, resolutions, pi, resolve, executionId: result.executionId! };
  }

  it('P12-S1 success after an initial ambiguity → confirmed-completed', async () => {
    const t = await uncertain();
    t.sw.stripe.settle(t.pi);
    assert.equal(await t.resolve(), 'confirmed-completed');
    await t.sw.interlock.close();
  });

  it('P12-S3 / P12-S4 a definitive failure, or a cancellation → confirmed-not-completed (PROVIDER_REJECTED)', async () => {
    for (const end of ['fail', 'cancel'] as const) {
      const t = await uncertain();
      if (end === 'fail') t.sw.stripe.fail(t.pi);
      else t.sw.stripe.cancel(t.pi);
      assert.equal(await t.resolve(), 'confirmed-not-completed', end);
      await t.sw.interlock.close();
    }
  });

  it('P12-S5 the object not found → unresolved (absence is never evidence)', async () => {
    const t = await uncertain();
    t.sw.stripe.settle(t.pi);
    const nowhere: StripePaymentReader = { retrieveAccount: (ms) => t.sw.stripe.retrieveAccount(ms), retrievePaymentIntent: async () => ({ notFound: true }) };
    assert.equal(await t.resolve(nowhere), 'unresolved');
    await t.sw.interlock.close();
  });

  it('P12-S6 … S8 a succeeded PaymentIntent whose amount, currency or destination differs from the binding → unresolved (integrity refusal)', async () => {
    for (const patch of [{ amountCents: 7501n, amountReceivedCents: 7501n }, { currency: 'eur' }, { destinationAccountId: OTHER_CONNECTED_ACCOUNT }, { amountReceivedCents: 7400n }]) {
      const t = await uncertain();
      t.sw.stripe.settle(t.pi);
      t.sw.stripe.tamper(t.pi, patch);
      assert.equal(await t.resolve(), 'unresolved', show(patch));
      await t.sw.interlock.close();
    }
  });

  it('P12-S9 the wrong account context → unresolved: a reader for another platform (that even knows the same object), or an authority configured for another platform', async () => {
    const t = await uncertain();
    t.sw.stripe.settle(t.pi);
    const elsewhere = createSimulatedStripe({ platformAccountId: OTHER_PLATFORM_ACCOUNT, mirrorOf: t.sw.stripe });
    assert.equal((await elsewhere.retrievePaymentIntent(t.pi, 1_000) as { status?: string }).status, 'succeeded', 'the adversary does see a succeeded object with that id');
    assert.equal(await t.resolve(elsewhere), 'unresolved');
    assert.equal(await t.resolve(t.sw.stripe, testRailConfiguration({ platformAccountId: OTHER_PLATFORM_ACCOUNT, fundingSources: CONFIGURATION.fundingSources.map((source) => ({ ...source })) })), 'unresolved');
    const live = createSimulatedStripe({ mirrorOf: t.sw.stripe });
    live.readMode = 'live';
    assert.equal(await t.resolve(live), 'unresolved', 'a live-mode reader proves nothing');
    assert.equal(await t.resolve(), 'confirmed-completed', 'control: the bound account resolves');
    await t.sw.interlock.close();
  });

  it('P12-S10 a read failure → unresolved; P12-S11 / S12 the authority calls no mutation and attempts no payment', async () => {
    const t = await uncertain();
    t.sw.stripe.settle(t.pi);
    const before = { ...t.sw.stripe.calls };
    t.sw.stripe.readMode = 'unavailable';
    assert.equal(await t.resolve(), 'unresolved');
    t.sw.stripe.readMode = 'normal';
    assert.equal(await t.resolve(), 'confirmed-completed');
    assert.deepEqual({ create: t.sw.stripe.calls.create, confirm: t.sw.stripe.calls.confirmAttempted }, { create: before.create, confirm: before.confirmAttempted });
    const reader = readOnlyStripe(t.sw.stripe) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(reader).sort(), ['retrieveAccount', 'retrievePaymentIntent'], 'the reader has no create, confirm, capture, cancel or refund');
    await t.sw.interlock.close();
  });

  it('a reservation never bound (crash before the creation finished) → unresolved: P12 never infers "not completed" from absence', async () => {
    const sw = await stripeWorld();
    await sw.interlock.reserve({
      executionId: 'exec-unbound',
      railId: SCOPE.railId,
      mode: 'test',
      platformAccountId: SCOPE.platformAccountId,
      sourceAccountId: ACCOUNT,
      customerId: TEST_CUSTOMER,
      paymentMethodId: TEST_PAYMENT_METHOD,
      destinationAccountId: CONNECTED_ACCOUNT,
      amountValue: '75',
      amountUnit: USD_ASSET,
      amountCents: 7500n,
      currency: 'usd',
      createIdempotencyKey: 'frontera:stripe-usd:exec-unbound:create',
      confirmIdempotencyKey: 'frontera:stripe-usd:exec-unbound:confirm',
    });
    const authority = createStripeResolutionAuthority({ configuration: CONFIGURATION, stripe: readOnlyStripe(sw.stripe), interlock: sw.interlock });
    const answer = await authority.resolve({ organizationId: ORG, executionId: 'exec-unbound', evaluationId: 'e', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', action: ACTION, basis: 'no-initial-observation' });
    assert.deepEqual(answer, { outcome: 'unresolved' });
    await sw.interlock.close();
  });
});

describe('PAY-09 finality matrix (FIN-S1 … FIN-S8) — the unchanged PAY-05 port', () => {
  async function completed() {
    const sw = await stripeWorld();
    const result = await govern(sw);
    assert.equal(result.status, 'executed');
    const pi = sw.stripe.intents()[0]!.id;
    const query: PaymentFinalityQuery = {
      organizationId: ORG,
      executionId: result.executionId!,
      requestId: result.requestId!,
      decisionId: 'decision',
      basis: 'provider-confirmed-completed',
      railId: STRIPE_RAIL_ID,
      providerRef: pi,
      payment: { source: { accountId: ACCOUNT }, destination: stripeDestinationOf(CONNECTED_ACCOUNT), amount: { value: '75', unit: USD_ASSET }, purpose: 'purchase', reference: 'INV-STRIPE-1', rail: STRIPE_RAIL_ID },
    };
    const verify = (reader: StripePaymentReader = sw.stripe, overrides: Partial<PaymentFinalityQuery> = {}) =>
      createStripeFinalityAuthority({ configuration: CONFIGURATION, stripe: readOnlyStripe(reader), interlock: sw.interlock }).verifyFinality({ ...query, ...overrides });
    return { sw, pi, query, verify };
  }

  it('FIN-S1 succeeded with exact correlation → final; FIN-S8 zero money effects', async () => {
    const t = await completed();
    const before = effects(t.sw.stripe);
    const answer = await t.verify();
    assert.equal(answer.outcome, 'final');
    assert.deepEqual(effects(t.sw.stripe), before);
    await t.sw.interlock.close();
  });

  it('FIN-S2 processing → not-final', async () => {
    const t = await completed();
    t.sw.stripe.tamper(t.pi, { status: 'processing', amountReceivedCents: 0n });
    assert.deepEqual(await t.verify(), { outcome: 'not-final' });
    await t.sw.interlock.close();
  });

  it('FIN-S3 / S4 / S5 the bound PaymentIntent reports another amount, currency or destination → contradicted (nothing recorded)', async () => {
    for (const [patch, reason] of [
      [{ amountCents: 7600n, amountReceivedCents: 7600n }, 'stripe.amount-mismatch'],
      [{ amountReceivedCents: 7000n }, 'stripe.amount-received-mismatch'],
      [{ currency: 'eur' }, 'stripe.currency-mismatch'],
      [{ destinationAccountId: OTHER_CONNECTED_ACCOUNT }, 'stripe.destination-mismatch'],
      [{ applicationFeeCents: 100n }, 'stripe.charge-model-mismatch'],
      [{ status: 'requires_capture' }, 'stripe.capture-pending'],
      [{ status: 'canceled' }, 'stripe.payment-canceled'],
    ] as const) {
      const t = await completed();
      t.sw.stripe.tamper(t.pi, patch);
      assert.deepEqual(await t.verify(), { outcome: 'contradicted', reason }, show(patch));
      await t.sw.interlock.close();
    }
  });

  it('a query whose governed terms disagree with the binding → not-final (the canonical payment, not Stripe, decides what is asked)', async () => {
    const t = await completed();
    for (const payment of [
      { ...t.query.payment, amount: { value: '75.01', unit: USD_ASSET } },
      { ...t.query.payment, destination: stripeDestinationOf(OTHER_CONNECTED_ACCOUNT) },
      { ...t.query.payment, source: { accountId: 'treasury-unmapped' } },
    ]) assert.deepEqual(await t.verify(t.sw.stripe, { payment }), { outcome: 'not-final' }, show(payment));
    await t.sw.interlock.close();
  });

  it('FIN-S6 another PaymentIntent (handle or metadata) → not-final; FIN-S7 read unavailable → not-final', async () => {
    const t = await completed();
    assert.deepEqual(await t.verify(t.sw.stripe, { providerRef: 'pi_somethingElse' }), { outcome: 'not-final' });
    t.sw.stripe.tamper(t.pi, { executionId: 'exec-another' });
    assert.deepEqual(await t.verify(), { outcome: 'not-final' }, 'metadata of another execution is absence of evidence, never a contradiction');
    t.sw.stripe.tamper(t.pi, { executionId: t.query.executionId });
    t.sw.stripe.readMode = 'unavailable';
    assert.deepEqual(await t.verify(), { outcome: 'not-final' });
    await t.sw.interlock.close();
  });

  it('ACCOUNT SUBSTITUTION: finality composed with another platform’s reader (which sees the same succeeded object id) → not-final', async () => {
    const t = await completed();
    const elsewhere = createSimulatedStripe({ platformAccountId: OTHER_PLATFORM_ACCOUNT, mirrorOf: t.sw.stripe });
    assert.deepEqual(await t.verify(elsewhere), { outcome: 'not-final' });
    assert.equal((await t.verify()).outcome, 'final', 'control');
    await t.sw.interlock.close();
  });
});
