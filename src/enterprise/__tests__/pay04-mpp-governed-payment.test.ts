import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentIntent,
  type PaymentRailResult,
} from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/protocols/mpp/index.js';
import { DEFAULT_CHARGE, contentDigestOf, paymentChallenge, testAdapter } from '../../features/payment-runtime/protocols/mpp/tests/mpp-test-support.js';
import { createRecordingPaymentRail, type RecordingPaymentRail } from '../../features/payment-runtime/tests/payment-rail-fixture.js';
import { createExecutionActivityGuard } from '../execution-reconciliation/activity-guard.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createOperatorAttestationAuthority, selectOperatorAttestation } from '../execution-reconciliation/operator-attestation.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionResult } from '../governed-action/index.js';
import {
  PaymentProtocolIngressConfigurationError,
  createInMemoryPaymentBusinessOperationStore,
  createPaymentProtocolContextReader,
  createPaymentProtocolIngress,
  createSqlitePaymentBusinessOperationStore,
  derivePaymentBusinessOperationKey,
  derivePaymentBusinessOperationRequestId,
  type PaymentBusinessOperationStore,
  type PaymentProtocolIngress,
  type PaymentProtocolIngressResult,
} from '../payment-protocol-ingress/index.js';
import { ALLOWED_INTENT, DENIED_ACTOR, IDENTITY, NOW, ORG, TEST_ASSETS, buildGovernedWorld, identityFor, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-04 layers G and H — the exit criterion, machine-tested on the
 * **unchanged** governed path:
 *
 * ```
 * MPP challenge ─ MPP adapter ─ PaymentProtocolTerms ─ paymentIntentOfProtocolTerms ─ PaymentIntent (PAY-01)
 *   ─ business operation, durable ─ compilePaymentIntent (PAY-01) ─ GovernedActionIntent
 *   ─ GovernedActionOrchestrator ─ Kernel ─ committed decision ─ P10 ─ grant ─ P7 ─ claim
 *   ─ createPaymentRailExecutionAdapter (PAY-01) ─ rail ─ P11 ─ (P12)
 * ```
 *
 * The world is the real Kernel, Governance Store, grant store, ACE, P7, P10
 * and P11 (`governed-action-support.ts`); the only stand-in is the test-only
 * recording rail. Every case counts rail calls.
 */

const PAYMENT_ACTION = ALLOWED_INTENT.action;
const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
const MONETARY = Object.freeze({ assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) });

const GOVERNANCE_DEFINITION = {
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [GOVERNED_ACCOUNT] }],
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
};
/** L-7: the protocol words are reserved through the CORE-03 registry's trusted extension — never the core's built-in list. */
const GOVERNANCE = createGovernanceProfileRegistry({ ...GOVERNANCE_DEFINITION, reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS] });

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-pay04-gov-'));
  directories.push(directory);
  return join(directory, 'payment-business-operations.sqlite');
}

/** The ingress clock: the merchant's challenges expire at 12:05, so the ingress observes at 12:00. Independent of the governance world's clock. */
let tick = 0;
const ingressClock = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();

interface ProtocolWorld {
  readonly world: GovernedWorld;
  readonly rail: RecordingPaymentRail;
  readonly store: PaymentBusinessOperationStore;
  readonly ingress: PaymentProtocolIngress;
  readonly governed: unknown[];
}

function protocolWorld(options: { readonly behaviour?: () => PaymentRailResult | Promise<PaymentRailResult>; readonly store?: PaymentBusinessOperationStore; readonly world?: GovernedWorld; readonly rail?: RecordingPaymentRail } = {}): ProtocolWorld {
  const rail = options.rail ?? createRecordingPaymentRail(options.behaviour);
  const world =
    options.world ??
    buildGovernedWorld({ monetary: MONETARY, governance: GOVERNANCE, financialAuthority: monetaryAuthority('5000', '20000'), executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }) });
  const store = options.store ?? createInMemoryPaymentBusinessOperationStore({ now: ingressClock });
  const governed: unknown[] = [];
  const orchestrator = {
    organizationId: world.orchestrator.organizationId,
    govern: (identity: Parameters<GovernedWorld['orchestrator']['govern']>[0], intent: unknown) => {
      governed.push(intent);
      return world.orchestrator.govern(identity, intent);
    },
  };
  const ingress = createPaymentProtocolIngress({ orchestrator, store, adapters: [testAdapter()], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock });
  return { world, rail, store, ingress, governed };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessOperationId: 'checkout-1001',
    protocol: 'mpp',
    challenges: paymentChallenge(),
    protectedRequest: { target: 'merchant:report-42', method: 'GET' },
    payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'purchase' },
    envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
    ...overrides,
  };
}

function governedResult(outcome: PaymentProtocolIngressResult): GovernedActionResult & { readonly businessOperation: 'created' | 'existing'; readonly challenge: 'appended' | 'existing'; readonly sequence: number } {
  assert.equal(outcome.outcome, 'governed', JSON.stringify(outcome));
  if (outcome.outcome !== 'governed') throw new Error('unreachable');
  return { ...outcome.result, businessOperation: outcome.operation, challenge: outcome.challenge, sequence: outcome.challengeSequence };
}

function refusalOf(outcome: PaymentProtocolIngressResult): string {
  assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
  return outcome.outcome === 'refused' ? outcome.refusal : '';
}

const SCOPE = { organizationId: ORG, principalId: IDENTITY.principal.principalId, businessOperationId: 'checkout-1001' };

/** The canonical PaymentIntent the default challenge must become — built here by PAY-01's own validator. */
function expectedIntent(): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '10.00', unit: 'USD' },
      purpose: 'purchase',
      reference: 'ORD-1',
      idempotencyKey: derivePaymentBusinessOperationKey(SCOPE),
    },
    { assets: TEST_ASSETS },
  );
  assert.equal(validation.valid, true);
  return (validation as { readonly intent: PaymentIntent }).intent;
}

describe('PAY-04 G/H — exit criterion: an MPP challenge becomes the canonical PaymentIntent and governs on the unchanged spine', () => {
  it('MPP → PaymentIntent → PAY-01 compile → orchestrator → Kernel → grant → PAY-01 adapter → rail, exactly once', async () => {
    const { world, rail, ingress, governed } = protocolWorld();
    const outcome = await ingress.prepareAndGovern(IDENTITY, request());
    const result = governedResult(outcome);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(result.businessOperation, 'created');
    assert.equal(result.requestId, derivePaymentBusinessOperationRequestId(SCOPE));
    assert.equal(rail.callCount, 1);
    assert.equal(world.kernelRequests.length, 1, 'the Kernel decided it');
    assert.ok(world.issueOutcomes.some((issued) => issued.outcome === 'issued'), 'a bounded grant was issued before execution');

    // The governed intent is exactly PAY-01's compilation of the canonical PaymentIntent — no hand-built envelope.
    assert.deepEqual(governed, [compilePaymentIntent(expectedIntent(), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext })]);

    const kernel = world.kernelRequests[0] as unknown as { readonly action: Record<string, unknown> };
    assert.equal(kernel.action['type'], PAYMENT_ACTION);
    assert.equal(kernel.action['counterpartyId'], 'account:vendor-4471');
    assert.equal(kernel.action['amount'], '10');
    assert.equal(kernel.action['currency'], 'USD');
    assert.equal(JSON.stringify(world.kernelRequests).includes('api.merchant.example'), false, 'no protocol field reaches the Kernel');

    const sent = rail.requests[0];
    assert.deepEqual(sent && { source: sent.source, destination: sent.destination, amount: sent.amount, purpose: sent.purpose, reference: sent.reference }, {
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '10', unit: 'USD' },
      purpose: 'purchase',
      reference: 'ORD-1',
    });
    assert.equal(JSON.stringify(sent).includes('ch-1'), false, 'the rail never sees the challenge');
  });

  it('direct PAY-01 use remains valid beside the ingress, and request idempotency is not business-operation idempotency', async () => {
    const { rail, ingress, world } = protocolWorld();
    await ingress.prepareAndGovern(IDENTITY, request());
    // A direct payment keyed by the raw business operation id is a different request, governed on its own.
    const direct = { ...expectedIntent(), idempotencyKey: 'checkout-1001' };
    const result = await world.orchestrator.govern(IDENTITY, compilePaymentIntent(direct, BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.notEqual(result.requestId, derivePaymentBusinessOperationRequestId(SCOPE));
    assert.equal(rail.callCount, 2);
  });

  it('the context reader hands the verified operation and its latest challenge back by governed request id only', async () => {
    const { ingress, store } = protocolWorld();
    const result = governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
    await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2' }) }));
    const context = await createPaymentProtocolContextReader(store).readByGovernedRequestId(ORG, result.requestId!);
    assert.equal(context?.businessOperationId, 'checkout-1001');
    assert.equal(context?.challenge.protocolId, 'mpp');
    assert.equal(context?.challenge.fields['id'], 'ch-2');
    assert.equal(context?.challenge.sequence, 2);
    assert.deepEqual(context?.terms.amount, { value: '10', unit: 'USD' });
    assert.equal(await createPaymentProtocolContextReader(store).readByGovernedRequestId('org-other', result.requestId!), undefined);
  });
});

describe('PAY-04 I-matrix — business-operation idempotency on the governed path', () => {
  it('I1 / I6 / M28 / M31: a refreshed challenge with identical terms replays the same governed request — never a second payment', async () => {
    const { rail, ingress, world } = protocolWorld();
    const first = governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
    const refreshed = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2', expires: '2026-09-24T12:10:00Z' }) })));
    assert.equal(refreshed.status === 'executed' && refreshed.replayed, true, JSON.stringify(refreshed));
    assert.deepEqual([refreshed.businessOperation, refreshed.challenge, refreshed.sequence], ['existing', 'appended', 2]);
    assert.equal(refreshed.requestId, first.requestId);
    assert.equal(refreshed.executionId, first.executionId);
    assert.equal(rail.callCount, 1);
    assert.equal(world.kernelRequests.length, 1, 'the committed decision is replayed, not re-evaluated');
  });

  it('I7: an old challenge presented again replays — it cannot create a duplicate execution', async () => {
    const { rail, ingress } = protocolWorld();
    await ingress.prepareAndGovern(IDENTITY, request());
    await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2' }) }));
    const old = governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
    assert.deepEqual([old.businessOperation, old.challenge, old.sequence], ['existing', 'existing', 1]);
    assert.equal(old.status === 'executed' && old.replayed, true);
    assert.equal(rail.callCount, 1);
  });

  for (const [label, overrides] of [
    ['I2 amount', { challenges: paymentChallenge({ id: 'ch-2', request: { ...DEFAULT_CHARGE, amount: '1100' } }) }],
    ['I3 asset', { challenges: paymentChallenge({ id: 'ch-2', request: { ...DEFAULT_CHARGE, currency: 'eur' } }) }],
    ['I4 destination', { challenges: paymentChallenge({ id: 'ch-2', request: { ...DEFAULT_CHARGE, recipient: 'm-002' } }) }],
    ['I5 protected resource', { challenges: paymentChallenge({ id: 'ch-2' }), protectedRequest: { target: 'merchant:report-43', method: 'GET' } }],
    ['I5 protected body', { challenges: paymentChallenge({ id: 'ch-2', digest: contentDigestOf('{"order":2}') }), protectedRequest: { target: 'merchant:report-42', method: 'POST', contentDigest: contentDigestOf('{"order":2}') } }],
    ['purpose', { challenges: paymentChallenge({ id: 'ch-2' }), payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'vendor-payment' } }],
    ['merchant order', { challenges: paymentChallenge({ id: 'ch-2', request: { ...DEFAULT_CHARGE, externalId: 'ORD-2' } }) }],
  ] as const) {
    it(`${label} / M27: the same operation with changed terms is a conflict before governance; the original stands`, async () => {
      const { rail, ingress, governed } = protocolWorld();
      await ingress.prepareAndGovern(IDENTITY, request());
      assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request(overrides))), 'business-operation-conflict');
      assert.equal(governed.length, 1, 'never reached governance');
      assert.equal(rail.callCount, 1);
    });
  }

  it('M30: a challenge captured for one operation cannot pay for another', async () => {
    const { rail, ingress, governed } = protocolWorld();
    await ingress.prepareAndGovern(IDENTITY, request());
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-2002' }))), 'challenge-conflict');
    assert.equal(governed.length, 1);
    assert.equal(rail.callCount, 1);
    // A new purchase with its own challenge is a new operation and pays once.
    assert.equal(governedResult(await ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-2002', challenges: paymentChallenge({ id: 'ch-new' }) }))).status, 'executed');
    assert.equal(rail.callCount, 2);
  });

  it('I8 / M29: concurrent identical presentations converge on one operation, one governed request and one rail call', async () => {
    const { rail, ingress } = protocolWorld();
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) => ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: `ch-${index % 3}` }) }))));
    const results = outcomes.map((outcome) => governedResult(outcome));
    assert.equal(new Set(results.map((result) => result.requestId)).size, 1);
    assert.equal(results.filter((result) => result.businessOperation === 'created').length, 1);
    assert.equal(rail.callCount, 1);
  });

  it('I9: concurrent conflicting presentations — one wins, the others conflict, never two operations or two payments', async () => {
    const { rail, ingress } = protocolWorld();
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, index) => ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: `ch-${index}`, request: { ...DEFAULT_CHARGE, amount: index % 2 === 0 ? '1000' : '1100' } }) }))));
    const governed = outcomes.filter((outcome) => outcome.outcome === 'governed');
    const conflicts = outcomes.filter((outcome) => outcome.outcome === 'refused' && outcome.refusal === 'business-operation-conflict');
    assert.equal(governed.length + conflicts.length, 10);
    assert.equal(governed.length, 5, 'every presentation of the winning terms governs (one execution, replays)');
    assert.equal(rail.callCount, 1);
  });
});

describe('PAY-04 — P11 / P12 replay is preserved under challenge refresh (M32 – M34, M37, I12)', () => {
  const ctx = { organizationId: ORG };

  it('M32: completed → a refreshed challenge replays executed; the rail is not called again', async () => {
    const { rail, ingress } = protocolWorld({ behaviour: () => ({ status: 'completed', externalReference: 'prov-1' }) });
    governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
    const replay = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2' }) })));
    assert.equal(replay.status === 'executed' && replay.replayed, true);
    assert.equal(rail.callCount, 1);
  });

  it('I12 / M33: unconfirmed → a refreshed challenge cannot become a second execution', async () => {
    const { rail, ingress, world } = protocolWorld({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'job-7' }) });
    const first = governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
    assert.equal(first.status, 'execution_unconfirmed');
    for (let index = 2; index <= 5; index += 1) {
      const again = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: `ch-${index}`, expires: `2026-09-24T12:0${index}:30Z` }) })));
      assert.equal(again.status, 'execution_unconfirmed', JSON.stringify(again));
      assert.ok(again.reasonCodes.includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED));
      assert.equal(again.executionId, first.executionId);
    }
    assert.equal(rail.callCount, 1, 'an unconfirmed payment is never re-sent because the merchant refreshed');
    assert.equal((await world.outcomes.read(ctx, first.executionId!))?.terminal?.observation.kind === 'provider', true);
  });

  for (const certainty of ['confirmed-not-completed', 'confirmed-completed'] as const) {
    it(`M34: unconfirmed, then P12-resolved ${certainty} → a refreshed challenge replays; protocol refresh never overrules P12 and never retries`, async () => {
      const { rail, ingress, world } = protocolWorld({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'job-8' }) });
      const first = governedResult(await ingress.prepareAndGovern(IDENTITY, request()));
      const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
      const service = createExecutionReconciliationService({
        outcomes: world.outcomes,
        resolutions,
        composition: snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 'test'),
        claimed: async () => true,
        activity: createExecutionActivityGuard(),
        now: () => NOW,
      });
      const base = { organizationId: ORG, executionId: first.executionId!, attestedBy: 'operator:treasury-ops', observedOutcome: 'unconfirmed' } as const;
      const resolved = await service.recordOperatorResolution(certainty === 'confirmed-not-completed' ? { ...base, certainty, failure: 'PROVIDER_REJECTED' } : { ...base, certainty });
      assert.equal(resolved.outcome, 'recorded', JSON.stringify(resolved));
      const refreshed = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-after-resolution' }) })));
      assert.equal(refreshed.requestId, first.requestId);
      // Exactly what a direct PAY-01 replay of the same request answers: the recorded outcome. P12's resolution
      // is read through P12; a protocol refresh neither overrules it nor turns it into a new attempt.
      const direct = await world.orchestrator.govern(IDENTITY, compilePaymentIntent(expectedIntent(), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
      assert.deepEqual({ status: refreshed.status, reasonCodes: refreshed.reasonCodes, executionId: refreshed.executionId }, { status: direct.status, reasonCodes: direct.reasonCodes, executionId: direct.executionId });
      assert.equal(refreshed.status, 'execution_unconfirmed');
      assert.equal((await resolutions.read(ctx, first.executionId!))?.resolution?.certainty, certainty, 'the P12 resolution stands');
      assert.equal(rail.callCount, 1, 'no second payment — a new purchase needs a new businessOperationId');
    });
  }

  it('P11 not-completed → a refreshed challenge replays the failure; it is not retried', async () => {
    const { rail, ingress } = protocolWorld({ behaviour: () => ({ status: 'not-completed', reason: 'PROVIDER_REJECTED', detail: 'insufficient-funds' }) });
    assert.equal(governedResult(await ingress.prepareAndGovern(IDENTITY, request())).status, 'execution_failed');
    const replay = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2' }) })));
    assert.equal(replay.status === 'execution_failed' && replay.replayed, true);
    assert.equal(rail.callCount, 1);
  });

  it('M37: a denied or withheld payment stays so under refresh, and no refusal reaches the Kernel or the rail', async () => {
    const { rail, ingress, world } = protocolWorld();
    const denied = governedResult(await ingress.prepareAndGovern(identityFor({ actorId: DENIED_ACTOR }), request()));
    assert.equal(denied.status, 'denied');
    const over = governedResult(await ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'big', challenges: paymentChallenge({ id: 'big', request: { ...DEFAULT_CHARGE, amount: '500001' } }) })));
    assert.equal(over.status, 'withheld', 'the P10 ceiling binds a protocol payment exactly like a direct one');
    const kernelCalls = world.kernelRequests.length;
    for (const refused of [request({ challenges: 'Payment id=' }), request({ challenges: paymentChallenge({ expires: '2026-09-24T11:00:00Z' }) }), request({ challenges: paymentChallenge({ request: { ...DEFAULT_CHARGE, recipient: 'attacker' } }) })]) {
      assert.equal((await ingress.prepareAndGovern(IDENTITY, { ...refused, businessOperationId: 'other' })).outcome, 'refused');
    }
    assert.equal(world.kernelRequests.length, kernelCalls);
    assert.equal(rail.callCount, 0);
  });
});

describe('PAY-04 — restart and stale restore cannot reopen a payment (I10, I11, M35, M36)', () => {
  it('I10 / M36: after a restart, a refreshed challenge finds the same operation and replays — no second payment', async () => {
    const path = freshPath();
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    const before = protocolWorld({ store, behaviour: () => ({ status: 'unconfirmed', externalReference: 'job-1' }) });
    governedResult(await before.ingress.prepareAndGovern(IDENTITY, request()));
    await store.close();
    const reopened = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    const after = protocolWorld({ store: reopened, world: before.world, rail: before.rail });
    const replay = governedResult(await after.ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-after-restart' }) })));
    assert.deepEqual([replay.businessOperation, replay.sequence, replay.status], ['existing', 2, 'execution_unconfirmed']);
    assert.equal(before.rail.callCount, 1);
    assert.equal(refusalOf(await after.ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-3', request: { ...DEFAULT_CHARGE, amount: '1100' } }) }))), 'business-operation-conflict');
    await reopened.close();
  });

  it('I11 / M35: a stale restore of the business-operation store forgets history, but cannot make a completed or unconfirmed payment look new', async () => {
    for (const behaviour of [(): PaymentRailResult => ({ status: 'completed', externalReference: 'p' }), (): PaymentRailResult => ({ status: 'unconfirmed', externalReference: 'u' })]) {
      const path = freshPath();
      // An empty store, backed up before the payment.
      await (await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock })).close();
      copyFileSync(path, `${path}.stale`);
      const store = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
      const live = protocolWorld({ store, behaviour });
      const first = governedResult(await live.ingress.prepareAndGovern(IDENTITY, request()));
      await store.close();
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
      copyFileSync(`${path}.stale`, path);
      const restored = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
      const after = protocolWorld({ store: restored, world: live.world, rail: live.rail });
      // Changed money terms first: the stale store believes the operation is new, but the derived key makes the
      // Governance Store's own idempotency refuse a different payment under it.
      const changed = governedResult(await after.ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-bigger', request: { ...DEFAULT_CHARGE, amount: '9900' } }) })));
      assert.equal(changed.businessOperation, 'created', 'the stale store forgot the operation');
      assert.equal(changed.status, 'rejected', JSON.stringify(changed));
      assert.deepEqual(changed.reasonCodes, [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
      assert.equal(changed.requestId, first.requestId);
      // Same terms on another restored copy: replayed, whatever the store says.
      await restored.close();
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
      copyFileSync(`${path}.stale`, path);
      const again = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
      const replay = governedResult(await protocolWorld({ store: again, world: live.world, rail: live.rail }).ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-after-restore' }) })));
      assert.equal(replay.businessOperation, 'created');
      assert.equal(replay.requestId, first.requestId);
      assert.equal(replay.status, first.status);
      await again.close();
      assert.equal(live.rail.callCount, 1, 'never a second payment');
    }
  });

  it('RESIDUAL (pinned, SEC-INV-242): after the store is lost, a caller minting a NEW businessOperationId for an already-paid challenge is a second purchase', async () => {
    const first = protocolWorld();
    governedResult(await first.ingress.prepareAndGovern(IDENTITY, request()));
    assert.equal(refusalOf(await first.ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-2002' }))), 'challenge-conflict', 'refused while the store is intact');
    const amnesiac = protocolWorld({ world: first.world, rail: first.rail, store: createInMemoryPaymentBusinessOperationStore({ now: ingressClock }) });
    const second = governedResult(await amnesiac.ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-2002' })));
    assert.equal(second.status, 'executed');
    assert.equal(first.rail.callCount, 2, 'the challenge-uniqueness record is lost with the store: business identity is the caller’s to keep');
  });

  it('a wholly lost (process-local) store behaves the same: the derived key replays, the rail is not called twice', async () => {
    const first = protocolWorld({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'u' }) });
    governedResult(await first.ingress.prepareAndGovern(IDENTITY, request()));
    const amnesiac = protocolWorld({ world: first.world, rail: first.rail, store: createInMemoryPaymentBusinessOperationStore({ now: ingressClock }) });
    const replay = governedResult(await amnesiac.ingress.prepareAndGovern(IDENTITY, request()));
    assert.equal(replay.businessOperation, 'created');
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.equal(first.rail.callCount, 1);
  });
});

describe('PAY-04 — trust boundary: the challenge is never authority', () => {
  it('a protocol cannot select the source, purpose, action, adapter or identity — none of those are protocol fields', async () => {
    const { rail, ingress, governed } = protocolWorld();
    const hostile = paymentChallenge({ request: { ...DEFAULT_CHARGE, source: 'treasury-main', purpose: 'payroll', action: 'admin.root', adapterId: 'other', organizationId: 'org-x', principalId: 'p-x', ceiling: '1000000000' } });
    governedResult(await ingress.prepareAndGovern(IDENTITY, request({ challenges: hostile })));
    const intent = governed[0] as Record<string, unknown>;
    assert.equal(intent['action'], PAYMENT_ACTION);
    assert.equal(intent['resource'], GOVERNED_ACCOUNT);
    assert.deepEqual(intent['parameters'], { paymentPurpose: 'purchase', paymentReference: 'ORD-1' });
    assert.equal(JSON.stringify(intent).includes('treasury-main') || JSON.stringify(intent).includes('admin.root'), false);
    assert.equal(rail.callCount, 1);
  });

  it('L-7: a protocol word in asserted context is refused before anything is stored, through the CORE-03 registry', async () => {
    const { ingress, store, governed } = protocolWorld();
    for (const key of ['businessOperationId', 'paymentChallenge', 'mppChallenge', 'MPPREALM']) {
      const outcome = await ingress.prepareAndGovern(IDENTITY, request({ envelope: { assertedContext: { ...ALLOWED_INTENT.assertedContext, [key]: 'x' } } }));
      assert.equal(refusalOf(outcome), 'payment-intent-invalid', key);
    }
    assert.equal(governed.length, 0);
    assert.equal(await store.readOperation({ organizationId: ORG }, IDENTITY.principal.principalId, 'checkout-1001'), undefined);
  });

  it('closed request: undeclared keys, accessors, a URL target, an undigested body and a foreign identity are refused before governance', async () => {
    const { ingress, governed } = protocolWorld();
    const getter = request();
    Object.defineProperty(getter, 'protocol', { get: () => 'mpp', enumerable: true });
    const cases: readonly [unknown, string][] = [
      [{ ...request(), amount: { value: '1', unit: 'USD' } }, 'request-invalid'],
      [getter, 'request-invalid'],
      [request({ protectedRequest: { target: 'https://merchant.example/r', method: 'GET' } }), 'request-invalid'],
      [request({ protectedRequest: { target: 'merchant:orders', method: 'POST' } }), 'request-invalid'],
      [request({ payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'purchase', destination: 'x' } }), 'request-invalid'],
      [request({ businessOperationId: '' }), 'request-invalid'],
      [request({ protocol: 'x402' }), 'protocol-unsupported'],
      [request({ envelope: { assertedContext: { evil: () => 1 } } }), 'request-invalid'],
    ];
    for (const [raw, expected] of cases) assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, raw)), expected);
    assert.equal(refusalOf(await ingress.prepareAndGovern(identityFor({ organizationId: 'org-foreign' }), request())), 'identity-invalid');
    assert.equal(refusalOf(await ingress.prepareAndGovern({ system: true } as never, request())), 'identity-invalid');
    assert.equal(governed.length, 0);
  });

  it('an unusable clock refuses before interpretation', async () => {
    const world = protocolWorld();
    const ingress = createPaymentProtocolIngress({ orchestrator: world.world.orchestrator, store: world.store, adapters: [testAdapter()], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: () => 'yesterday' });
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request())), 'clock-unavailable');
  });

  it('an orchestrator answering for another request id is reported inconsistent, never masked', async () => {
    const { store } = protocolWorld();
    const lying = { organizationId: ORG, govern: async (): Promise<GovernedActionResult> => ({ status: 'denied', requestId: 'aoc.gar:00000000000000000000000000000000', reasonCodes: [] }) };
    const ingress = createPaymentProtocolIngress({ orchestrator: lying, store, adapters: [testAdapter()], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock });
    assert.equal((await ingress.prepareAndGovern(IDENTITY, request())).outcome, 'inconsistent');
  });
});

describe('PAY-04 — ingress composition is trusted and fail-closed', () => {
  it('refuses a registry that does not reserve every protocol word, a non-financial payment action, duplicate or malformed adapters', () => {
    const { world, store } = protocolWorld();
    const base = { orchestrator: world.orchestrator, store, adapters: [testAdapter()], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock };
    assert.throws(() => createPaymentProtocolIngress({ ...base, governance: createGovernanceProfileRegistry(GOVERNANCE_DEFINITION) }), PaymentProtocolIngressConfigurationError);
    assert.throws(() => createPaymentProtocolIngress({ ...base, governance: createGovernanceProfileRegistry({ ...GOVERNANCE_DEFINITION, reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS] }) }), /mppChallenge/);
    assert.throws(() => createPaymentProtocolIngress({ ...base, monetary: { assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [] }) } }), PaymentProtocolIngressConfigurationError);
    assert.throws(() => createPaymentProtocolIngress({ ...base, adapters: [testAdapter(), testAdapter()] }), PaymentProtocolIngressConfigurationError);
    assert.throws(() => createPaymentProtocolIngress({ ...base, adapters: [] }), PaymentProtocolIngressConfigurationError);
    assert.throws(() => createPaymentProtocolIngress({ ...base, adapters: [{ protocolId: 'mpp', reservedContextKeys: ['bad key'], interpret: () => undefined } as never] }), PaymentProtocolIngressConfigurationError);
  });

  it('a throwing or lying adapter is a refusal, never a governed action', async () => {
    const { world, store } = protocolWorld();
    for (const interpret of [
      () => {
        throw new Error('boom');
      },
      () => ({ interpreted: true, terms: { destination: { kind: 'account', reference: 'vendor-4471' }, amount: { value: '10', unit: 'USD' }, grant: 'all' }, challenge: { key: 'k', fields: { id: 'a' } } }),
      () => Promise.resolve({ interpreted: false, refusal: 'challenge-invalid' }),
    ]) {
      const ingress = createPaymentProtocolIngress({ orchestrator: world.orchestrator, store, adapters: [{ protocolId: 'mpp', reservedContextKeys: [], interpret } as never], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock });
      assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request())), 'challenge-invalid');
    }
    assert.equal(world.kernelRequests.length, 0);
  });
});
