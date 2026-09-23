import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createInMemoryContextResolver,
  readContextFact,
  type ContextDeclaration,
  type ContextFactObservation,
  type ContextResolution,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { AocKernel, type KernelEvaluationResult, type PolicyPackProvider } from '../../kernel/index.js';
import { toKernelEvaluationRequest, validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import { compareCanonicalDecimals, isCanonicalDecimal } from '../../features/monetary-runtime/index.js';

/**
 * The acceptance scenario for trusted context, end to end.
 *
 * ```
 * REQUEST           payment, amount = 7500, vendorId = V123
 * TRUSTED CONTEXT   vendor.status = approved
 * POLICY            ALLOW only when amount <= 10000 AND trusted vendor.status == approved
 * ```
 *
 * Three cases, and the middle one is the point of the whole phase:
 *
 * ```
 * A  resolver says approved     -> the policy can authorize
 * B  the *caller* says approved -> the trusted condition is not satisfied
 * C  resolver says blocked      -> the trusted condition fails
 * ```
 *
 * The request enters through the frozen v1 adaptation chain — the same
 * `validateGovernanceEvaluateRequestBody` and `toKernelEvaluationRequest` that
 * `POST /api/governance/evaluate` uses — so what is demonstrated is the real
 * boundary a boundary-crossing caller meets, not a convenient in-process one.
 * There is no ERP here and there is deliberately none: the resolver is an
 * in-memory table, because what is being proved is the trust boundary rather
 * than a connector.
 */

const NOW = '2026-01-01T12:00:00.000Z';

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
/**
 * Registered so the scenario can show a deployment that *does* admit the
 * requester as a source — and show that admitting it still does not let a
 * request satisfy a rule that asked for a system of record.
 */
const REQUEST_SOURCE: ContextSource = { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' };

const DECLARATION: ContextDeclaration = {
  requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }],
};

/**
 * The deployment's own rule. Frontera ships no such rule, and the fact that it
 * has to be written here — by a deployment, over facts the platform hands it —
 * is the property this phase claims.
 *
 * It reads `amount` from the caller-supplied `ActionDescriptor`, exactly as it
 * does today and with exactly today's meaning, and `vendor.status` from the
 * resolved namespace. Two channels, one rule, and the pack chooses which is
 * which.
 */
const VENDOR_PAYMENT_POLICY: PolicyPackProvider = {
  evaluatePolicyForEnforcement(input) {
    const resolution = input.metadata?.['aoc.context'] as ContextResolution | undefined;
    const amountWithinLimit = isCanonicalDecimal(input.amount) && compareCanonicalDecimals(input.amount, '10000') <= 0;

    if (resolution === undefined) {
      return { type: 'policy_denied', allowed: false, reasonCode: 'VENDOR_STATUS_NOT_RESOLVED', reason: 'This deployment requires resolved vendor status.' };
    }

    const read = readContextFact(resolution, { key: 'vendor.status', minimumTrustClass: 'authoritative', required: false });
    const vendorApproved = read.status === 'satisfied' && read.value === 'approved';

    if (amountWithinLimit && vendorApproved) {
      return { type: 'policy_allowed', allowed: true, reasonCode: 'PAYMENT_PERMITTED', reason: `Vendor status read from ${String(read.sourceId)}.` };
    }
    return {
      type: 'policy_denied',
      allowed: false,
      reasonCode: vendorApproved ? 'AMOUNT_ABOVE_LIMIT' : 'VENDOR_NOT_TRUSTED_APPROVED',
      reason: `amountWithinLimit=${String(amountWithinLimit)} vendorStatusRead=${read.status}`,
    };
  },
};

function buildKernel(observations: readonly ContextFactObservation[]): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    policyPackProvider: VENDOR_PAYMENT_POLICY,
    contextResolution: {
      provider: createInMemoryContextResolver(observations),
      sources: [ERP, REQUEST_SOURCE],
      declaration: DECLARATION,
    },
  });
}

/**
 * The wire body a boundary-crossing caller sends, adapted exactly as the frozen
 * v1 endpoint adapts it. `extraContext` is whatever the caller tries to smuggle
 * alongside what it is entitled to state.
 */
function evaluatePaymentRequest(
  observations: readonly ContextFactObservation[],
  options: { readonly requestId: string; readonly amount?: string; readonly extraContext?: Readonly<Record<string, unknown>> },
): Promise<KernelEvaluationResult> {
  const guardInput = buildDraftClosureEmailGuardInput();
  const body = validateGovernanceEvaluateRequestBody({
    requestId: options.requestId,
    requestedAt: NOW,
    actor: { id: guardInput.actorId, principalId: guardInput.principalActorId, trustDomainId: guardInput.trustDomainId },
    action: {
      type: guardInput.action,
      resourceScope: guardInput.resourceScope,
      capability: guardInput.capability,
      riskLevel: guardInput.riskLevel,
      sideEffectType: guardInput.sideEffectType,
      amount: options.amount ?? '7500',
      currency: 'USD',
      counterpartyId: 'V123',
    },
    // The recognition world's own passport/capability references travel in the
    // same free-form bag the forgery does, which is exactly the point: one bag,
    // and only the reserved namespace is taken out of it.
    context: { ...(guardInput.metadata ?? {}), ...(options.extraContext ?? {}) },
  });

  return buildKernel(observations).evaluate(toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: (prefix) => `${prefix}-scenario` }));
}

const RESOLVER_SAYS_APPROVED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }];
const RESOLVER_SAYS_BLOCKED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'blocked', sourceId: ERP.id, observedAt: NOW }];

/** Exactly the forgery the brief names: the caller writing the facts that decide. */
const CALLER_ASSERTS_APPROVED: Readonly<Record<string, unknown>> = {
  'aoc.context': {
    resolved: true,
    declaredKeys: ['vendor.status'],
    facts: [
      {
        key: 'vendor.status',
        value: 'approved',
        sourceId: ERP.id,
        sourceKind: 'erp',
        trustClass: 'authoritative',
        effectiveTrustClass: 'authoritative',
        resolution: 'resolved',
        observedAt: NOW,
      },
    ],
    unresolved: [],
    stale: [],
    conflicted: [],
    assertedFactPolicy: 'permit',
    assertableKeys: [],
    resolvedAt: NOW,
  },
  'vendor.status': 'approved',
  invoiceStatus: 'approved',
  riskScore: 'low',
};

describe('Acceptance scenario — A: the resolver answers, and the policy can authorize', () => {
  it('amount 7500 under the limit, vendor.status resolved authoritative approved -> allowed', async () => {
    const result = await evaluatePaymentRequest(RESOLVER_SAYS_APPROVED, { requestId: 'scenario-a' });

    assert.equal(result.status, 'allowed');
    assert.equal(result.context?.resolved, true);
    const fact = result.context?.facts[0];
    assert.equal(fact?.key, 'vendor.status');
    assert.equal(fact?.sourceId, ERP.id);
    assert.equal(fact?.trustClass, 'authoritative');
    assert.equal(fact?.resolution, 'resolved');
  });

  it('the caller-supplied amount keeps its existing meaning: 12500 is above the limit and is denied', async () => {
    const result = await evaluatePaymentRequest(RESOLVER_SAYS_APPROVED, { requestId: 'scenario-a-over', amount: '12500' });
    assert.equal(result.status, 'denied');
  });
});

describe('Acceptance scenario — B: the caller says approved, and it does not count', () => {
  it('a forged `aoc.context` in the request body does not satisfy the trusted condition', async () => {
    const result = await evaluatePaymentRequest([], { requestId: 'scenario-b', extraContext: CALLER_ASSERTS_APPROVED });

    assert.equal(result.status, 'denied', 'the caller may state what it wants to do, never what makes it allowed');
    assert.deepEqual(result.context?.facts, [], 'nothing the caller wrote became a fact');
    assert.deepEqual(result.context?.unresolved, ['vendor.status']);
  });

  it('the identical request differs from case A only in who answered — and that is the whole difference', async () => {
    const forged = await evaluatePaymentRequest([], { requestId: 'scenario-b-pair', extraContext: CALLER_ASSERTS_APPROVED });
    const resolved = await evaluatePaymentRequest(RESOLVER_SAYS_APPROVED, { requestId: 'scenario-b-pair', extraContext: CALLER_ASSERTS_APPROVED });

    assert.equal(forged.status, 'denied');
    assert.equal(resolved.status, 'allowed');
  });

  it('a deployment that admits the requester as a source still does not let it satisfy an authoritative requirement', async () => {
    const result = await evaluatePaymentRequest([{ key: 'vendor.status', value: 'approved', sourceId: REQUEST_SOURCE.id, observedAt: NOW }], {
      requestId: 'scenario-b-asserted-source',
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.context?.facts[0]?.trustClass, 'asserted');
  });
});

describe('Acceptance scenario — C: the resolver says blocked, and the trusted condition fails', () => {
  it('vendor.status resolved authoritative blocked -> denied, even with a caller asserting approved', async () => {
    const result = await evaluatePaymentRequest(RESOLVER_SAYS_BLOCKED, { requestId: 'scenario-c', extraContext: CALLER_ASSERTS_APPROVED });

    assert.equal(result.status, 'denied');
    assert.equal(result.context?.facts[0]?.resolution, 'resolved', 'the fact resolved perfectly well; it simply does not say approved');
    assert.equal(result.context?.unsatisfiedRequirements, undefined, 'the denial came from the deployment’s policy, not from a context requirement');
  });
});

describe('Acceptance scenario — the frozen v1 surface is unchanged', () => {
  it('the wire body carries no context field of its own — `context` is the same free-form bag it has always been', () => {
    const body = validateGovernanceEvaluateRequestBody({
      actor: { id: 'a', trustDomainId: 't' },
      action: { type: 'payment', resourceScope: 'finance:payments', amount: '7500' },
      context: { callerNote: 'kept' },
    });
    const request = toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: () => 'id' });

    assert.deepEqual(request.context, { callerNote: 'kept' });
    assert.equal('contextResolution' in request, false, 'no new request field; the capability is composed, never submitted');
  });

  it('repeated evaluation of the same scenario is deterministic', async () => {
    const first = await evaluatePaymentRequest(RESOLVER_SAYS_APPROVED, { requestId: 'scenario-determinism' });
    const second = await evaluatePaymentRequest(RESOLVER_SAYS_APPROVED, { requestId: 'scenario-determinism' });

    assert.equal(first.status, second.status);
    assert.equal(JSON.stringify(first.context), JSON.stringify(second.context));
  });
});
