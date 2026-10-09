import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentGovernanceBinding,
  type PaymentGovernedActionIntent,
  type PaymentIntent,
  type PaymentRailResult,
} from '../../features/payment-runtime/index.js';
import { createRecordingPaymentRail, type RecordingPaymentRail } from '../../features/payment-runtime/tests/payment-rail-fixture.js';
import { buildAuthorityTrace } from '../evidence/trace-builder.js';
import { AUDITOR_DISCLOSURE_POLICY_V2, CUSTOMER_DISCLOSURE_POLICY_V2, PARTNER_DISCLOSURE_POLICY_V2, PUBLIC_DISCLOSURE_POLICY_V2, discloseAuthorityTrace } from '../evidence/trace-disclosure.js';
import { createExecutionActivityGuard } from '../execution-reconciliation/activity-guard.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createOperatorAttestationAuthority, selectOperatorAttestation } from '../execution-reconciliation/operator-attestation.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionApprovalAssessment, type GovernedActionIntent, type GovernedActionResult } from '../governed-action/index.js';
import { ALLOWED_INTENT, APPROVAL_INTENT, DENIED_ACTOR, IDENTITY, NOW, ORG, TEST_ASSETS, buildGovernedWorld, identityFor, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-01 qualification on the **unchanged governed path** (P5–P14).
 *
 * ```
 * PaymentIntent ─ validate ─ compile ─▶ GovernedActionIntent ─ orchestrator ─ Kernel ─ committed decision
 *   ─ (approval) ─ P10 ceiling ─ bounded grant ─ exercise ─ P7 reservation ─ write-ahead claim
 *   ─ payment rail adapter (ExecutionAdapter) ─ rail ─ P11 outcome ─ trace / disclosure ─ (P12 resolution)
 * ```
 *
 * The world is the real Kernel, the real Governance Store, the real grant
 * store, real ACE, real P7, real P10 and the real P11 store
 * (`governed-action-support.ts`). The only stand-ins are the payment rail —
 * the test-only recording rail, which performs no external effect — and, in
 * P8, the approval authority's port, so the test controls when approval
 * completes.
 *
 * The deployment's payment action is host configuration, not a constant: the
 * fixture Kernel allows one action for this actor, so that action is bound as
 * the payment action here, and the action it requires approval for is bound
 * as a second payment action. Amounts are arbitrary test values.
 */

const PAYMENT_ACTION = ALLOWED_INTENT.action;
const REVIEWED_PAYMENT_ACTION = APPROVAL_INTENT.action;
const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
const REVIEWED_BINDING = createPaymentGovernanceBinding({ action: REVIEWED_PAYMENT_ACTION });

/** What a host composes for the payment vertical: P9 classification, the CORE-03 payment dimensions, and one profile over its governed accounts. */
const MONETARY = Object.freeze({ assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION, REVIEWED_PAYMENT_ACTION] }) });
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION, REVIEWED_PAYMENT_ACTION] }],
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
});

const CEILING = '5000';

interface PaymentWorld {
  readonly world: GovernedWorld;
  readonly rail: RecordingPaymentRail;
}

function paymentWorld(
  options: {
    readonly behaviour?: () => PaymentRailResult | Promise<PaymentRailResult>;
    readonly binding?: PaymentGovernanceBinding;
    readonly approvals?: () => GovernedActionApprovalAssessment;
    readonly governance?: false;
  } = {},
): PaymentWorld {
  const rail = createRecordingPaymentRail(options.behaviour);
  const world = buildGovernedWorld({
    monetary: MONETARY,
    ...(options.governance === false ? {} : { governance: GOVERNANCE }),
    financialAuthority: monetaryAuthority(CEILING, '20000'),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: options.binding ?? BINDING }),
    ...(options.approvals !== undefined ? { approvals: { assess: () => Promise.resolve(options.approvals!()) } } : {}),
  });
  return { world, rail };
}

function payment(overrides: Record<string, unknown> = {}): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '1250.50', unit: 'USD' },
      purpose: 'vendor-payment',
      reference: 'INV-2026-0042',
      idempotencyKey: 'pay-key-1',
      ...overrides,
    },
    { assets: TEST_ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { readonly intent: PaymentIntent }).intent;
}

/** The compiled payment, with the envelope-owned evidence the fixture Kernel verifies. */
function governed(intent: PaymentIntent, binding: PaymentGovernanceBinding = BINDING): PaymentGovernedActionIntent {
  const context = binding === BINDING ? ALLOWED_INTENT.assertedContext : APPROVAL_INTENT.assertedContext;
  return compilePaymentIntent(intent, binding, { assertedContext: context });
}

function codes(result: GovernedActionResult): readonly string[] {
  return result.reasonCodes;
}

describe('PAY-01 — the compiled payment is the envelope, not a parallel model', () => {
  it('a compiled payment is assignable to GovernedActionIntent with no adaptation', () => {
    const compiled: GovernedActionIntent = governed(payment());
    assert.equal(compiled.action, PAYMENT_ACTION);
  });
});

describe('PAY-01 P6 / P9 — a granted payment reaches the rail once, exactly as normalized', () => {
  it('governs through the normal path and hands the rail the granted payment only', async () => {
    const { world, rail } = paymentWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(rail.callCount, 1);
    assert.equal(world.kernelRequests.length, 1, 'the Kernel decided it');
    assert.ok(world.issueOutcomes.some((outcome) => outcome.outcome === 'issued'), 'a bounded grant was issued before execution');

    const request = rail.requests[0];
    assert.ok(request !== undefined);
    assert.deepEqual(
      { ...request, grantId: '<grant>', notAfter: '<notAfter>' },
      {
        executionId: result.executionId,
        requestId: result.requestId,
        decisionId: result.decision?.decisionId,
        grantId: '<grant>',
        notAfter: '<notAfter>',
        source: { accountId: GOVERNED_ACCOUNT },
        destination: { kind: 'account', reference: 'vendor-4471' },
        amount: { value: '1250.5', unit: 'USD' },
        purpose: 'vendor-payment',
        reference: 'INV-2026-0042',
      },
    );
    assert.ok(world.issueOutcomes.some((outcome) => outcome.outcome === 'issued' && outcome.grant.id === request.grantId), 'the rail is told the grant it executes under');
    assert.equal(JSON.stringify(request).includes(IDENTITY.actor.actorId), false, 'the rail never learns who asked');
  });

  it('the Kernel saw the payment on its canonical axes', async () => {
    const { world } = paymentWorld();
    await world.orchestrator.govern(IDENTITY, governed(payment()));
    const kernel = world.kernelRequests[0] as unknown as { readonly action: Record<string, unknown> };
    assert.equal(kernel.action['type'], PAYMENT_ACTION);
    assert.equal(kernel.action['counterpartyId'], 'account:vendor-4471');
    assert.equal(kernel.action['amount'], '1250.5');
    assert.equal(kernel.action['currency'], 'USD');
  });
});

describe('PAY-01 P5 — idempotency is the envelope’s', () => {
  it('the same payment with the same key replays and never reaches the rail twice', async () => {
    const { world, rail } = paymentWorld();
    const first = await world.orchestrator.govern(IDENTITY, governed(payment()));
    const second = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '1250.5', unit: 'USD' } })));
    assert.equal(first.status, 'executed');
    assert.equal(second.status === 'executed' && second.replayed, true, JSON.stringify(second));
    assert.equal(second.executionId, first.executionId, 'a stable execution identity');
    assert.equal(rail.callCount, 1);
  });

  it('a different payment under the same key is refused, and the original stands', async () => {
    const { world, rail } = paymentWorld();
    await world.orchestrator.govern(IDENTITY, governed(payment()));
    for (const conflicting of [
      payment({ amount: { value: '1250.51', unit: 'USD' } }),
      payment({ destination: { kind: 'account', reference: 'vendor-9999' } }),
      payment({ purpose: 'payroll' }),
      payment({ reference: 'INV-OTHER' }),
    ]) {
      const result = await world.orchestrator.govern(IDENTITY, governed(conflicting));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.deepEqual(codes(result), [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    }
    assert.equal(rail.callCount, 1);
  });
});

describe('PAY-01 P7 / P8 / invalid — zero side effects before a grant', () => {
  it('P7: a denied payment never reaches the rail', async () => {
    const { world, rail } = paymentWorld();
    const result = await world.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), governed(payment()));
    assert.equal(result.status, 'denied', JSON.stringify(result));
    assert.equal(world.issueOutcomes.length, 0);
    assert.equal(rail.callCount, 0);
  });

  it('P8: a payment awaiting approval reaches the rail zero times until approval completes, then exactly once', async () => {
    let answer: GovernedActionApprovalAssessment = { kind: 'withheld', status: 'pending' };
    const { world, rail } = paymentWorld({ binding: REVIEWED_BINDING, approvals: () => answer });
    const intent = governed(payment(), REVIEWED_BINDING);
    const pending = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(pending.status === 'withheld' && pending.withheldBy, 'approval', JSON.stringify(pending));
    assert.ok(codes(pending).includes(R.GOVERNED_ACTION_APPROVAL_PENDING));
    assert.equal(rail.callCount, 0);

    answer = { kind: 'withheld', status: 'rejected' };
    assert.equal((await world.orchestrator.govern(IDENTITY, intent)).status, 'withheld');
    assert.equal(rail.callCount, 0);

    answer = { kind: 'approved', approvalDigest: `sha256:${'a'.repeat(64)}`, notAfter: new Date(Date.parse(NOW) + 5 * 60_000).toISOString() };
    const approved = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(approved.status, 'executed', JSON.stringify(approved));
    assert.equal(rail.callCount, 1);
  });

  it('P8: without an approval authority, an approval-required payment stays withheld and never reaches the rail', async () => {
    const { world, rail } = paymentWorld({ binding: REVIEWED_BINDING });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment(), REVIEWED_BINDING));
    assert.equal(result.status === 'withheld' && result.withheldBy, 'approval');
    assert.equal(rail.callCount, 0);
  });

  it('P10 ceiling: a payment above the authority ceiling is withheld before any grant', async () => {
    const { world, rail } = paymentWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000.01', unit: 'USD' } })));
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.ok(codes(result).includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), codes(result).join(','));
    assert.equal(rail.callCount, 0);
  });

  it('P7 capacity: cumulative exposure is the existing aggregate limit — the payment that would exceed it never reaches the rail', async () => {
    const { world, rail } = paymentWorld();
    for (let index = 0; index < 4; index += 1) {
      const result = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000', unit: 'USD' }, idempotencyKey: `pay-cap-${index}` })));
      assert.equal(result.status, 'executed', JSON.stringify(result));
    }
    const over = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '0.01', unit: 'USD' }, idempotencyKey: 'pay-cap-over' })));
    assert.equal(over.status === 'withheld' && over.withheldBy, 'exercise', JSON.stringify(over));
    assert.equal(rail.callCount, 4);
  });

  it('invalid: a payment that fails validation is never compiled, and a mis-composed host refuses before evaluation', async () => {
    const refused = validatePaymentIntent({ source: { accountId: GOVERNED_ACCOUNT }, destination: { kind: 'account', reference: 'v' }, amount: { value: '0', unit: 'USD' }, purpose: 'vendor-payment', idempotencyKey: 'k' }, { assets: TEST_ASSETS });
    assert.equal(refused.valid, false);

    const { world, rail } = paymentWorld({ governance: false });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'rejected', 'no profile governs the payment dimensions, so the envelope refuses them');
    assert.deepEqual(codes(result), [R.GOVERNED_ACTION_INTENT_INVALID]);
    assert.equal(world.kernelRequests.length, 0);
    assert.equal(rail.callCount, 0);

    const forged = { ...governed(payment()), amount: { value: '1250.5', currency: 'GBP' } };
    const unknownAsset = await paymentWorld().world.orchestrator.govern(IDENTITY, forged);
    assert.equal(unknownAsset.status, 'rejected');
  });
});

describe('PAY-01 P10 / P11 / P12 — rail outcomes are the existing durable execution outcomes', () => {
  const ctx = { organizationId: ORG };

  it('P10: completed → executed, recorded confirmed-completed with the provider handle', async () => {
    const { world } = paymentWorld({ behaviour: () => ({ status: 'completed', externalReference: 'prov-123' }) });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status === 'executed' && result.providerRef, 'prov-123');
    const record = await world.outcomes.read(ctx, result.executionId!);
    assert.equal(record?.terminal?.observation.kind, 'provider');
    assert.deepEqual(
      record?.terminal?.observation.kind === 'provider' ? { certainty: record.terminal.observation.certainty, providerRef: record.terminal.observation.providerRef } : undefined,
      { certainty: 'confirmed-completed', providerRef: 'prov-123' },
    );
    assert.deepEqual(record?.attempt.amount, { value: '1250.5', unit: 'USD' });
  });

  it('P11: not-completed → execution_failed with the existing reason, recorded confirmed-not-completed; a replay does not retry', async () => {
    const { world, rail } = paymentWorld({ behaviour: () => ({ status: 'not-completed', reason: 'PROVIDER_REJECTED', detail: 'insufficient-funds' }) });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status === 'execution_failed' && result.failure, 'PROVIDER_REJECTED', JSON.stringify(result));
    const record = await world.outcomes.read(ctx, result.executionId!);
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.certainty, 'confirmed-not-completed');
    const replay = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(replay.status === 'execution_failed' && replay.replayed, true);
    assert.equal(rail.callCount, 1);
  });

  it('P12: unconfirmed → execution_unconfirmed, never retried, and resolved through the existing operator resolution — no payment-specific path', async () => {
    const { world, rail } = paymentWorld({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'job-7' }) });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    assert.ok(codes(result).includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED));
    const executionId = result.executionId!;
    const record = await world.outcomes.read(ctx, executionId);
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.certainty, 'unconfirmed');

    const again = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(again.status, 'execution_unconfirmed');
    assert.equal(rail.callCount, 1, 'an unconfirmed payment is never re-sent');

    const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
    const service = createExecutionReconciliationService({
      outcomes: world.outcomes,
      resolutions,
      composition: snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 'test'),
      claimed: async () => true,
      activity: createExecutionActivityGuard(),
      now: () => NOW,
    });
    const resolved = await service.recordOperatorResolution({ organizationId: ORG, executionId, attestedBy: 'operator:treasury-ops', observedOutcome: 'unconfirmed', certainty: 'confirmed-completed' });
    assert.equal(resolved.outcome, 'recorded', JSON.stringify(resolved));
    assert.equal((await resolutions.read(ctx, executionId))?.resolution?.certainty, 'confirmed-completed');
    assert.equal(rail.callCount, 1, 'resolution queries nothing and re-sends nothing');
  });

  it('a rail that throws is unconfirmed — the payment may have moved, so capacity stays held and nothing retries', async () => {
    const { world, rail } = paymentWorld({
      behaviour: () => {
        throw new Error('connection reset');
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    assert.equal((await world.orchestrator.govern(IDENTITY, governed(payment()))).status, 'execution_unconfirmed');
    assert.equal(rail.callCount, 1);
  });
});

describe('PAY-01 P13 / P14 — payment evidence and disclosure use the existing trace and tiers', () => {
  async function tracedPayment() {
    const { world } = paymentWorld({ behaviour: () => ({ status: 'completed', externalReference: 'prov-123' }) });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'executed');
    const build = await buildAuthorityTrace(
      { governance: world.rawStore, grants: { kind: 'in-memory', read: (grantId) => world.grantStore.read(grantId) }, outcomes: world.outcomes },
      { system: true },
      result.requestId!,
    );
    assert.ok(build !== null);
    return { result, trace: build.trace };
  }

  it('P13: the trace distinguishes intent, decision, grant, execution and provider outcome, and carries the payment’s amount and purpose', async () => {
    const { result, trace } = await tracedPayment();
    const stages = trace.stages;
    assert.equal(stages.request.presence, 'recorded');
    assert.equal(stages.decision.presence, 'recorded');
    assert.equal(stages.authority.presence, 'recorded');
    assert.equal(stages.execution.presence, 'recorded');
    assert.deepEqual(stages.parameters.amount, { value: '1250.5', unit: 'USD' });
    const parameters = JSON.stringify(stages.parameters.parameters);
    assert.ok(parameters.includes('paymentPurpose') && parameters.includes('vendor-payment'), parameters);
    assert.equal(stages.outcome.kind, 'provider');
    assert.equal(stages.outcome.certainty, 'confirmed-completed');
    assert.equal(stages.outcome.providerRef, 'prov-123');
    assert.equal(trace.requestId, result.requestId);
  });

  it('P14: amount, purpose and source are AUDITOR evidence; the provider handle is PARTNER at most; CUSTOMER and PUBLIC see the business result only', async () => {
    const { trace } = await tracedPayment();
    const view = (policy: Parameters<typeof discloseAuthorityTrace>[1]) => JSON.stringify(discloseAuthorityTrace(trace, policy));
    const auditor = view(AUDITOR_DISCLOSURE_POLICY_V2);
    const partner = view(PARTNER_DISCLOSURE_POLICY_V2);
    const customer = view(CUSTOMER_DISCLOSURE_POLICY_V2);
    const publicView = view(PUBLIC_DISCLOSURE_POLICY_V2);

    for (const value of ['1250.5', 'vendor-payment', 'INV-2026-0042', GOVERNED_ACCOUNT, 'prov-123']) assert.ok(auditor.includes(value), `AUDITOR sees ${value}`);
    assert.ok(partner.includes('prov-123'), 'PARTNER sees the rail execution reference');
    for (const value of ['1250.5', 'vendor-payment', 'INV-2026-0042', GOVERNED_ACCOUNT]) assert.equal(partner.includes(value), false, `PARTNER does not see ${value}`);
    for (const value of ['1250.5', 'vendor-payment', 'INV-2026-0042', GOVERNED_ACCOUNT, 'prov-123']) {
      assert.equal(customer.includes(value), false, `CUSTOMER does not see ${value}`);
      assert.equal(publicView.includes(value), false, `PUBLIC does not see ${value}`);
    }
    assert.ok(customer.includes('confirmed-completed') || customer.includes('executed'), 'CUSTOMER sees the business-level result');
    // The destination is bound in the committed decision and the grant, and
    // the trace references the request only by digest: no tier discloses it.
    for (const disclosed of [auditor, partner, customer, publicView]) assert.equal(disclosed.includes('vendor-4471'), false);
  });
});
