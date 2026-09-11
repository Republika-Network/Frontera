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
import {
  createInMemoryObligationDischargeProvider,
  type ObligationDeclaration,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import { AocKernel, type KernelEnforcementResult, type PolicyPackProvider } from '../../kernel/index.js';
import { toKernelEvaluationRequest, validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';

/**
 * The acceptance scenario for obligation discharge, end to end, over the
 * trusted-context path the previous phase established.
 *
 * ```
 * REQUEST           payment, amount = 7500, vendorId = V123
 * TRUSTED CONTEXT   vendor.status = approved
 * POLICY            ALLOW only when amount <= 10000 AND trusted vendor.status == approved
 * OBLIGATION        finance.approval, blocking
 * ```
 *
 * Five cases, and the first three are the point of the whole phase:
 *
 * ```
 * A  no discharge                 -> ALLOW, obligation pending,  exercise BLOCKED,  executor NOT called
 * B  the caller asserts approval  -> ALLOW, obligation pending,  exercise BLOCKED,  executor NOT called
 * C  trusted finance discharge    -> ALLOW, obligation verified, exercise ELIGIBLE, executor CALLED
 * D  wrong-source / mismatched    -> ALLOW, not validly discharged, exercise BLOCKED, executor NOT called
 * E  policy denial                -> DENY, and no obligation state converts that into an authorization
 * ```
 *
 * A and B are the same *decision* with the same *obligation outcome* and
 * different attack surfaces; C is the only one that opens the gate. Throughout,
 * `status` is what the policy concluded and nothing else — an obligation
 * changes whether the action proceeds, never whether it was authorized.
 *
 * The request enters through the frozen v1 adaptation chain — the same
 * `validateGovernanceEvaluateRequestBody` and `toKernelEvaluationRequest` that
 * `POST /api/governance/evaluate` uses — so what is demonstrated is the real
 * boundary a boundary-crossing caller meets. There is no approval system here
 * and there is deliberately none: the discharge provider is an in-memory table,
 * because what is being proved is the trust boundary rather than a connector.
 */

const NOW = '2026-01-01T12:00:00.000Z';

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CONTEXT_DECLARATION: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }] };

const FINANCE_APPROVALS: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
/** Registered so the scenario can show a deployment that *does* admit the requester — and show that admitting it still does not let it discharge its own obligation. */
const REQUEST_SOURCE: ObligationDischargeSource = { id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' };

const OBLIGATION_DECLARATION: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true, maxDischargeAgeSeconds: 86_400 }] };

/**
 * The deployment's own rule, unchanged from the context phase's scenario.
 *
 * It decides *authority*: may this actor make this payment at all? It says
 * nothing about finance approval, and it must not — an obligation is a
 * condition on exercising authority that already exists, and folding it into
 * the policy predicate would collapse exactly the distinction this phase
 * preserves.
 */
const VENDOR_PAYMENT_POLICY: PolicyPackProvider = {
  evaluatePolicyForEnforcement(input) {
    const resolution = input.metadata?.['aoc.context'] as ContextResolution | undefined;
    const amountWithinLimit = typeof input.amount === 'number' && input.amount <= 10_000;

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

const RESOLVER_SAYS_APPROVED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }];
const RESOLVER_SAYS_BLOCKED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'blocked', sourceId: ERP.id, observedAt: NOW }];

/** Exactly the forgery the brief names: the caller writing the condition that releases its own payment. */
const CALLER_ASSERTS_FINANCE_APPROVED: Readonly<Record<string, unknown>> = {
  financeApproved: true,
  'aoc.obligations': { 'finance.approval': true, exerciseEligibility: 'eligible' },
  'aoc.obligations.finance.approved': true,
  obligation: { state: 'DISCHARGED' },
};

function correlationFor(requestId: string, guardInput: ReturnType<typeof buildDraftClosureEmailGuardInput>) {
  return { requestId, action: guardInput.capability ?? guardInput.action, resourceScope: guardInput.resourceScope };
}

function buildKernel(input: { readonly contextObservations: readonly ContextFactObservation[]; readonly dischargeObservations: readonly ObligationDischargeObservation[] }): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    policyPackProvider: VENDOR_PAYMENT_POLICY,
    contextResolution: { provider: createInMemoryContextResolver(input.contextObservations), sources: [ERP], declaration: CONTEXT_DECLARATION },
    obligations: {
      provider: createInMemoryObligationDischargeProvider(input.dischargeObservations),
      sources: [FINANCE_APPROVALS, REQUEST_SOURCE],
      declaration: OBLIGATION_DECLARATION,
    },
  });
}

interface ScenarioOutcome {
  readonly result: KernelEnforcementResult<string>;
  readonly executorCalls: number;
}

/**
 * One payment, submitted exactly as the frozen v1 endpoint submits it, and
 * enforced with a real executor so the call count is a measurement rather than
 * an inference.
 */
async function enforcePayment(options: {
  readonly requestId: string;
  readonly contextObservations?: readonly ContextFactObservation[];
  readonly discharges?: (correlation: ReturnType<typeof correlationFor>) => readonly ObligationDischargeObservation[];
  readonly extraContext?: Readonly<Record<string, unknown>>;
}): Promise<ScenarioOutcome> {
  const guardInput = buildDraftClosureEmailGuardInput();
  const correlation = correlationFor(options.requestId, guardInput);

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
      amount: 7_500,
      currency: 'USD',
      counterpartyId: 'V123',
    },
    context: { ...(guardInput.metadata ?? {}), ...(options.extraContext ?? {}) },
  });

  const kernel = buildKernel({
    contextObservations: options.contextObservations ?? RESOLVER_SAYS_APPROVED,
    dischargeObservations: options.discharges?.(correlation) ?? [],
  });

  let executorCalls = 0;
  const result = await kernel.enforce(toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: (prefix) => `${prefix}-scenario` }), () => {
    executorCalls += 1;
    return 'payment-sent';
  });

  return { result, executorCalls };
}

describe('Acceptance scenario — A: authorized, and the obligation is not discharged', () => {
  it('the decision is ALLOW, the obligation is pending, exercise is blocked, and the executor is not called', async () => {
    const { result, executorCalls } = await enforcePayment({ requestId: 'obl-scenario-a' });

    assert.equal(result.status, 'allowed', 'policy authorized the payment; a pending condition does not un-authorize it');
    assert.equal(result.obligations?.obligations[0]?.obligationType, 'finance.approval');
    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, false);
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(executorCalls, 0);
    assert.equal(result.execution.executed, false);
    assert.equal(result.execution.withheldBy, 'obligation');
  });

  it('the record shows an authorization that stands alongside an execution that was withheld — not a denial', async () => {
    const { result } = await enforcePayment({ requestId: 'obl-scenario-a-record' });

    assert.notEqual(result.status, 'denied');
    assert.equal(result.reasonCodes.includes('OBLIGATION_PENDING'), false, 'an obligation condition is never an authorization reason');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, ['OBLIGATION_PENDING']);
  });
});

describe('Acceptance scenario — B: the caller says finance approved, and it does not count', () => {
  it('a self-asserted approval leaves the obligation pending and the executor uncalled', async () => {
    const { result, executorCalls } = await enforcePayment({ requestId: 'obl-scenario-b', extraContext: CALLER_ASSERTS_FINANCE_APPROVED });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'required', 'nothing the caller wrote became a discharge');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(executorCalls, 0);
  });

  it('a deployment that admits the requester as a source still does not let it release its own payment', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-b-source',
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: REQUEST_SOURCE.id, outcome: 'discharged', observedAt: NOW }],
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'discharged', 'reported, and honestly recorded as self-reported');
    assert.equal(result.obligations?.obligations[0]?.discharge?.verificationClass, 'self_reported');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(executorCalls, 0);
  });
});

describe('Acceptance scenario — C: a trusted finance discharge releases the payment', () => {
  it('the decision is ALLOW, the obligation is verified, exercise is eligible, and the executor runs exactly once', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-c',
      discharges: (correlation) => [
        { obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: '2026-01-01T11:30:00.000Z', subjectId: 'cfo@example.test', reference: 'AP-771' },
      ],
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, true);
    assert.equal(result.obligations?.exerciseEligibility, 'eligible');
    assert.equal(executorCalls, 1);
    assert.equal(result.execution.executed, true);
    assert.equal(result.execution.value, 'payment-sent');
  });

  it('the record names who discharged it, from where, when and under what reference — and carries no approval payload', async () => {
    const { result } = await enforcePayment({
      requestId: 'obl-scenario-c-record',
      discharges: (correlation) => [
        { obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: '2026-01-01T11:30:00.000Z', subjectId: 'cfo@example.test', reference: 'AP-771' },
      ],
    });

    const discharge = result.obligations?.obligations[0]?.discharge;
    assert.equal(discharge?.sourceId, FINANCE_APPROVALS.id);
    assert.equal(discharge?.sourceKind, 'approval_runtime');
    assert.equal(discharge?.verificationClass, 'independent');
    assert.equal(discharge?.subjectId, 'cfo@example.test');
    assert.equal(discharge?.reference, 'AP-771');
    assert.equal(result.obligations?.obligations[0]?.dischargeExpiresAt, '2026-01-02T11:30:00.000Z');
  });

  it('a caller forging approval alongside the real one changes nothing — the real discharge is why it proceeds', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-c-forged-too',
      extraContext: CALLER_ASSERTS_FINANCE_APPROVED,
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }],
    });

    assert.equal(result.obligations?.obligations[0]?.discharge?.sourceId, FINANCE_APPROVALS.id);
    assert.equal(executorCalls, 1);
  });
});

describe('Acceptance scenario — D: a mismatched or untrusted discharge does not release the payment', () => {
  const cases = [
    {
      name: 'a discharge of a different obligation',
      build: (correlation: ReturnType<typeof correlationFor>) => [{ obligationType: 'second.signer', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged' as const, observedAt: NOW }],
      // The provider is asked only about declared obligations, so this one is
      // filtered before it is ever classified. That the layer *also* discards an
      // undeclared obligation a misbehaving provider volunteers is covered in
      // `obligation-lifecycle-service.test.ts`.
      reason: undefined,
    },
    {
      name: 'a discharge obtained for a different request',
      build: (correlation: ReturnType<typeof correlationFor>) => [
        { obligationType: 'finance.approval', correlation: { ...correlation, requestId: 'some-other-payment' }, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged' as const, observedAt: NOW },
      ],
      reason: 'correlation_mismatch',
    },
    {
      name: 'a discharge obtained for a different action',
      build: (correlation: ReturnType<typeof correlationFor>) => [
        { obligationType: 'finance.approval', correlation: { ...correlation, action: 'payment.refund' }, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged' as const, observedAt: NOW },
      ],
      reason: 'correlation_mismatch',
    },
    {
      name: 'a discharge citing a source the deployment never registered',
      build: (correlation: ReturnType<typeof correlationFor>) => [{ obligationType: 'finance.approval', correlation, sourceId: 'obl.src.attacker', outcome: 'discharged' as const, observedAt: NOW }],
      reason: 'unregistered_source',
    },
    {
      name: 'a discharge older than the declared window',
      build: (correlation: ReturnType<typeof correlationFor>) => [
        { obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged' as const, observedAt: '2025-12-01T00:00:00.000Z' },
      ],
      reason: 'stale_observation',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: ALLOW, not validly discharged, exercise blocked, executor not called`, async () => {
      const { result, executorCalls } = await enforcePayment({ requestId: `obl-scenario-d-${testCase.reason ?? 'filtered'}-${testCase.name.length}`, discharges: testCase.build });

      assert.equal(result.status, 'allowed', 'a bad discharge is not a denial — the authorization is unaffected either way');
      assert.equal(result.obligations?.allBlockingObligationsSatisfied, false);
      assert.equal(result.obligations?.exerciseEligibility, 'blocked');
      assert.equal(executorCalls, 0);
      if (testCase.reason !== undefined) {
        assert.equal(result.obligations?.disregarded?.some((entry) => entry.reason === testCase.reason), true, `expected a '${testCase.reason}' entry`);
      }
    });
  }
});

describe('Acceptance scenario — E: policy denial, and no obligation state converts it into an authorization', () => {
  it('a blocked vendor denies the payment even with a fully verified finance approval', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-e',
      contextObservations: RESOLVER_SAYS_BLOCKED,
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }],
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.obligations?.exerciseEligibility, 'eligible', 'the condition was met; the action was still never authorized');
    assert.equal(executorCalls, 0);
    assert.equal(result.execution.withheldBy, undefined, 'the denial is the reason, and it is the only one');
  });

  it('a waiver does not rescue a denial either', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-e-waived',
      contextObservations: RESOLVER_SAYS_BLOCKED,
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'waived', observedAt: NOW }],
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalls, 0);
  });
});

describe('Acceptance scenario — the two security boundaries are independent', () => {
  it('trusted context with a forged discharge proceeds no further than untrusted context with a real one', async () => {
    const forgedDischarge = await enforcePayment({ requestId: 'obl-scenario-independence-1', extraContext: CALLER_ASSERTS_FINANCE_APPROVED });
    const untrustedContext = await enforcePayment({
      requestId: 'obl-scenario-independence-2',
      contextObservations: [],
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }],
    });

    assert.equal(forgedDischarge.result.status, 'allowed');
    assert.equal(forgedDischarge.executorCalls, 0, 'context passed, obligation did not');
    assert.equal(untrustedContext.result.status, 'denied');
    assert.equal(untrustedContext.executorCalls, 0, 'obligation passed, context did not');
  });

  it('both boundaries satisfied is the only combination that executes', async () => {
    const { result, executorCalls } = await enforcePayment({
      requestId: 'obl-scenario-independence-3',
      discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }],
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.context?.facts[0]?.sourceId, ERP.id);
    assert.equal(result.obligations?.obligations[0]?.discharge?.sourceId, FINANCE_APPROVALS.id);
    assert.equal(executorCalls, 1);
  });
});

describe('Acceptance scenario — the frozen v1 surface is unchanged', () => {
  it('the wire body carries no obligation field of its own — the capability is composed, never submitted', () => {
    const body = validateGovernanceEvaluateRequestBody({
      actor: { id: 'a', trustDomainId: 't' },
      action: { type: 'payment', resourceScope: 'finance:payments', amount: 7_500 },
      context: { callerNote: 'kept' },
    });
    const request = toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: () => 'id' });

    assert.deepEqual(request.context, { callerNote: 'kept' });
    assert.equal('obligations' in request, false);
    assert.equal('obligationDischarge' in request, false);
  });

  it('repeated evaluation of the same scenario is deterministic', async () => {
    const first = await enforcePayment({ requestId: 'obl-scenario-determinism', discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }] });
    const second = await enforcePayment({ requestId: 'obl-scenario-determinism', discharges: (correlation) => [{ obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: NOW }] });

    assert.equal(first.result.status, second.result.status);
    assert.equal(JSON.stringify(first.result.obligations), JSON.stringify(second.result.obligations));
  });
});
