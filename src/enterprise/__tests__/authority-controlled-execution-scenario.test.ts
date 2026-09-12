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
import {
  GRANT_REASON_CODES,
  createInMemoryBoundedGrantStore,
  type BoundedGrantStorePort,
  type GrantCorrelation,
} from '../../features/grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, type ExecutionOutcome, type GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { AocKernel, type KernelEvaluationRequest, type PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { toKernelEvaluationRequest, validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import {
  AUTHORITY_BINDING_REASON_CODES,
  createAuthorityControlledExecution,
  type AuthorityControlledAuthorizationOutcome,
  type AuthorityControlledExecutionService,
  type GrantAuthorityBinding,
  type GrantAuthorityBindingQuery,
} from '../execution-governance/index.js';

/**
 * The acceptance scenario for grant-aware execution, end to end, over the
 * trusted context, obligation and bounded-grant path the three previous phases
 * established — and through, for the first time, a real provider-neutral
 * execution adapter.
 *
 * ```
 * AUTHORITY      a mandate over this action, expiring at T+30m
 * REQUEST        payment, amount = 7500, vendor = V123
 * TRUSTED CTX    vendor.status = approved          (resolved, not asserted)
 * POLICY         ALLOW when amount <= 10000 AND vendor.status == approved
 * OBLIGATION     finance.approval, blocking, verified by an independent source
 * ISSUER         proposes expiresAt = T+10m
 * GRANT          subject agent-A, action = the evaluated capability,
 *                resource = the evaluated scope, vendor = V123,
 *                maxAmount = 7500, expiresAt = T+10m
 * CEILING        authority, T+30m
 * ```
 *
 * The request enters through the frozen v1 adaptation chain — the same
 * `validateGovernanceEvaluateRequestBody` and `toKernelEvaluationRequest` that
 * `POST /api/governance/evaluate` uses — so what is demonstrated is the real
 * boundary a boundary-crossing caller meets. There is still no ledger, no
 * signer and no chain: the adapter is a recorder, because what is being proved
 * is that **nothing reaches a provider without a grant that covers it**, not
 * that a particular provider works.
 *
 * ## Model A is unchanged
 *
 * The source ceiling is `7500` — the amount the decision was made on — and not
 * the policy's `10000`. Case B asserts that the policy threshold is never
 * reusable authority: an attempt at 9000 or 10000 is refused even though the
 * rule that allowed the request reads `<= 10000`.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const GRANT_HORIZON = '2026-01-01T12:10:00.000Z';
const AT_T_PLUS_5 = '2026-01-01T12:05:00.000Z';
const MANDATE_EXPIRES = '2026-01-01T12:30:00.000Z';
const MANDATE_REF = 'mandate-transfer-0001';

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CONTEXT_DECLARATION: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }] };
const RESOLVER_SAYS_APPROVED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }];

const FINANCE_APPROVALS: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const OBLIGATION_DECLARATION: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true }] };

const GRANT_CAPABILITY = new KernelGrantCapability({ declaration: {} });

/** The mandate-backed binding this deployment is in. Stated explicitly, which is the whole point of the type. */
const MANDATE_BINDING: GrantAuthorityBinding = {
  kind: 'bounded-authority',
  authorityKind: 'mandate',
  authorityRef: MANDATE_REF,
  expiresAt: MANDATE_EXPIRES,
};

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

const GUARD_INPUT = buildDraftClosureEmailGuardInput();
const EVALUATED_ACTION = GUARD_INPUT.capability ?? GUARD_INPUT.action;
const EVALUATED_RESOURCE = GUARD_INPUT.resourceScope;
const EVALUATED_SUBJECT = GUARD_INPUT.actorId;

function buildRequest(options: { readonly requestId: string; readonly amount?: number; readonly extraContext?: Readonly<Record<string, unknown>> }): KernelEvaluationRequest {
  const body = validateGovernanceEvaluateRequestBody({
    requestId: options.requestId,
    requestedAt: NOW,
    actor: { id: GUARD_INPUT.actorId, principalId: GUARD_INPUT.principalActorId, trustDomainId: GUARD_INPUT.trustDomainId },
    action: {
      type: GUARD_INPUT.action,
      resourceScope: GUARD_INPUT.resourceScope,
      capability: GUARD_INPUT.capability,
      riskLevel: GUARD_INPUT.riskLevel,
      sideEffectType: GUARD_INPUT.sideEffectType,
      amount: options.amount ?? 7_500,
      currency: 'USD',
      counterpartyId: 'V123',
    },
    context: { ...(GUARD_INPUT.metadata ?? {}), ...(options.extraContext ?? {}) },
  });
  return toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: (prefix) => `${prefix}-execution-scenario` });
}

const FINANCE_APPROVED = (correlation: { requestId: string; action: string; resourceScope: string }): readonly ObligationDischargeObservation[] => [
  {
    obligationType: 'finance.approval',
    correlation,
    sourceId: FINANCE_APPROVALS.id,
    outcome: 'discharged',
    observedAt: '2026-01-01T11:30:00.000Z',
    subjectId: 'cfo@example.test',
    reference: 'AP-771',
  },
];

interface ComposedWorld {
  readonly service: AuthorityControlledExecutionService;
  readonly adapter: RecordingExecutionAdapter;
  readonly store: BoundedGrantStorePort;
}

/**
 * The composition a host performs: one grant-aware Kernel, one grant store, one
 * execution adapter, one authority-binding resolver.
 */
function compose(options: {
  readonly discharged?: boolean;
  readonly resolveAuthorityBinding?: (query: GrantAuthorityBindingQuery) => GrantAuthorityBinding | undefined;
  readonly now?: () => string;
  readonly store?: BoundedGrantStorePort;
  readonly requestId?: string;
} = {}): ComposedWorld {
  const correlation = { requestId: options.requestId ?? 'execution-scenario', action: EVALUATED_ACTION, resourceScope: EVALUATED_RESOURCE };
  const fixture = buildDatasysEnforcementFixture();
  const kernel = new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    policyPackProvider: VENDOR_PAYMENT_POLICY,
    contextResolution: { provider: createInMemoryContextResolver(RESOLVER_SAYS_APPROVED), sources: [ERP], declaration: CONTEXT_DECLARATION },
    obligations: {
      provider: createInMemoryObligationDischargeProvider(options.discharged === false ? [] : FINANCE_APPROVED(correlation)),
      sources: [FINANCE_APPROVALS],
      declaration: OBLIGATION_DECLARATION,
    },
    grants: { declaration: {} },
  });

  const store = options.store ?? createInMemoryBoundedGrantStore();
  const adapter = createRecordingExecutionAdapter();
  const service = createAuthorityControlledExecution({
    kernel,
    grantCapability: GRANT_CAPABILITY,
    grantStore: store,
    executionAdapter: adapter,
    now: options.now ?? (() => NOW),
    resolveAuthorityBinding: options.resolveAuthorityBinding ?? (() => MANDATE_BINDING),
  });

  return { service, adapter, store };
}

function exerciseRequestFor(
  grantId: string,
  correlation: GrantCorrelation,
  overrides: {
    readonly subject?: string;
    readonly action?: string;
    readonly resource?: string;
    readonly counterparty?: string;
    readonly amount?: { readonly value: number; readonly unit: string };
    readonly correlation?: GrantCorrelation;
    readonly executionId?: string;
  } = {},
): GrantExerciseRequest {
  return {
    boundedGrantId: grantId,
    subject: overrides.subject ?? EVALUATED_SUBJECT,
    action: overrides.action ?? EVALUATED_ACTION,
    resource: overrides.resource ?? EVALUATED_RESOURCE,
    counterparty: overrides.counterparty ?? 'V123',
    amount: overrides.amount ?? { value: 7_500, unit: 'USD' },
    correlation: overrides.correlation ?? correlation,
    executionId: overrides.executionId ?? 'exec-1',
  };
}

async function issuedWorld(options: Parameters<typeof compose>[0] = {}) {
  const world = compose({ requestId: options.requestId ?? 'execution-scenario', ...options });
  const outcome = await world.service.authorize({
    request: buildRequest({ requestId: options.requestId ?? 'execution-scenario' }),
    grantExpiresAt: GRANT_HORIZON,
  });
  return { ...world, outcome };
}

function grantOf(outcome: AuthorityControlledAuthorizationOutcome) {
  assert.equal(outcome.outcome, 'grant-issued', `expected a grant, got ${outcome.outcome}`);
  assert.ok(outcome.outcome === 'grant-issued');
  return outcome.grant;
}

function blockedCodes(outcome: ExecutionOutcome): readonly string[] {
  return [...outcome.assessment.reasonCodes];
}

// ---------------------------------------------------------------------------

describe('Production composition — issuance happens only after ALLOW and a satisfied blocking obligation', () => {
  it('issues a grant bounded to the evaluated action, resource, vendor and amount', async () => {
    const { outcome } = await issuedWorld();
    const grant = grantOf(outcome);

    assert.equal(outcome.outcome === 'grant-issued' ? outcome.decision.status : undefined, 'allowed');
    assert.equal(grant.subject, EVALUATED_SUBJECT);
    assert.deepEqual(grant.scope.action, { kind: 'identity', value: EVALUATED_ACTION });
    assert.deepEqual(grant.scope.resources, { kind: 'set', values: [EVALUATED_RESOURCE] });
    assert.deepEqual(grant.scope.counterparty, { kind: 'identity', value: 'V123' });
    assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: 7_500, unit: 'USD' });
    assert.equal(grant.expiresAt, GRANT_HORIZON, 'a proposal within every ceiling is accepted exactly as supplied');
  });

  it('the mandate ceiling is supplied explicitly and reported as the effective one', async () => {
    const { outcome } = await issuedWorld();
    assert.ok(outcome.outcome === 'grant-issued');
    assert.deepEqual(outcome.authorityBinding, MANDATE_BINDING);
    assert.deepEqual(outcome.effectiveValidityCeiling, { source: 'authority', notAfter: MANDATE_EXPIRES });
  });

  it('a pending blocking obligation withholds the grant and leaves the decision ALLOW', async () => {
    const world = compose({ discharged: false, requestId: 'execution-scenario-pending' });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'execution-scenario-pending' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'grant-withheld');
    assert.equal(outcome.decision.status, 'allowed', 'a condition not yet met does not un-authorize the request');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.deepEqual([...outcome.reasonCodes], [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
    for (const code of outcome.decision.reasonCodes) assert.equal(code.startsWith('GRANT_'), false, 'a grant refusal is never a policy reason code');
  });

  it('a DENY issues nothing, and the refusal names the authorization rather than a grant defect', async () => {
    const world = compose({ requestId: 'execution-scenario-deny' });
    // 12500 is above the policy's own threshold, so the decision itself is not ALLOW.
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'execution-scenario-deny', amount: 12_500 }), grantExpiresAt: GRANT_HORIZON });

    assert.notEqual(outcome.decision.status, 'allowed');
    assert.equal(outcome.outcome, 'grant-withheld');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.ok(outcome.reasonCodes.includes(GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED));
  });
});

describe('Production composition — the authority ceiling is a hard gate', () => {
  it('an issuer expiry inside the mandate window is accepted', async () => {
    const { outcome } = await issuedWorld({ requestId: 'ceiling-inside' });
    assert.equal(outcome.outcome, 'grant-issued');
  });

  it('an issuer expiry beyond the mandate window is refused, never clamped', async () => {
    const world = compose({ requestId: 'ceiling-outside' });
    const outcome = await world.service.authorize({
      request: buildRequest({ requestId: 'ceiling-outside' }),
      // The mandate ends at T+30m; the issuer asks for T+45m.
      grantExpiresAt: '2026-01-01T12:45:00.000Z',
    });

    assert.equal(outcome.outcome, 'grant-withheld');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.ok(outcome.reasonCodes.includes(GRANT_REASON_CODES.GRANT_SCOPE_BROADENING));
    assert.deepEqual(outcome.effectiveValidityCeiling, { source: 'authority', notAfter: MANDATE_EXPIRES });
  });

  it('a mandate shorter than the requested grant refuses issuance', async () => {
    // The brief's case H: mandate expires T+8m, the issuer asks for T+10m.
    const world = compose({
      requestId: 'ceiling-short',
      resolveAuthorityBinding: () => ({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: MANDATE_REF, expiresAt: '2026-01-01T12:08:00.000Z' }),
    });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'ceiling-short' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'grant-withheld');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.ok(outcome.reasonCodes.includes(GRANT_REASON_CODES.GRANT_SCOPE_BROADENING));
  });

  it('a resolver that cannot answer fails closed — no grant, and its own vocabulary says why', async () => {
    // The wiring hazard, closed. `validityCeilings: []` would have issued here.
    const world = compose({ requestId: 'ceiling-unresolved', resolveAuthorityBinding: () => undefined });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'ceiling-unresolved' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'authority-binding-unresolved');
    assert.ok(outcome.outcome === 'authority-binding-unresolved');
    assert.deepEqual([...outcome.reasonCodes], [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_UNRESOLVED]);
    assert.equal(outcome.decision.status, 'allowed', 'the authorization is untouched; only the grant is withheld');
  });

  it('a malformed bounded-authority binding fails closed — a cap nobody can parse is not an absent cap', async () => {
    const world = compose({
      requestId: 'ceiling-malformed',
      resolveAuthorityBinding: () => ({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: MANDATE_REF, expiresAt: 'whenever' }),
    });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'ceiling-malformed' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'authority-binding-unresolved');
    assert.ok(outcome.outcome === 'authority-binding-unresolved');
    assert.deepEqual([...outcome.reasonCodes], [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_MALFORMED]);
  });

  it('an unjustified "no temporal bound" binding fails closed — the permissive case costs an explicit word', async () => {
    const world = compose({
      requestId: 'ceiling-unjustified',
      resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: '   ' }),
    });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'ceiling-unjustified' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'authority-binding-unresolved');
  });

  it('a genuinely unbounded authority issues normally, and reports no ceiling', async () => {
    const world = compose({
      requestId: 'ceiling-none',
      resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: 'A capability token resolved per evaluation carries no validity window.' }),
    });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'ceiling-none' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'grant-issued');
    assert.ok(outcome.outcome === 'grant-issued');
    assert.equal(outcome.effectiveValidityCeiling, undefined, 'no ceiling existed, and none was invented');
    assert.equal(outcome.grant.expiresAt, GRANT_HORIZON, 'the issuer’s finite proposal is what bounds it');
  });
});

describe('Production composition — TOCTOU at the issuance commit boundary', () => {
  it('a mandate shortened between measurement and commit refuses the issuance', async () => {
    // The brief's case I: measured at T+30m, authoritative at commit T+6m,
    // requested T+10m. The binding is re-resolved *inside* the store's critical
    // section, so the commit sees the shortened window rather than the measured
    // one.
    let phase: 'issuance' | 'commit' = 'issuance';
    const world = compose({
      requestId: 'toctou-mandate',
      resolveAuthorityBinding: (query) => {
        phase = query.phase;
        return {
          kind: 'bounded-authority',
          authorityKind: 'mandate',
          authorityRef: MANDATE_REF,
          expiresAt: query.phase === 'commit' ? '2026-01-01T12:06:00.000Z' : MANDATE_EXPIRES,
        };
      },
    });

    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'toctou-mandate' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(phase, 'commit', 'the binding really was re-resolved at the commit boundary');
    assert.equal(outcome.outcome, 'grant-withheld');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.ok(outcome.reasonCodes.includes(GRANT_REASON_CODES.GRANT_SCOPE_BROADENING));
  });

  it('a mandate revoked between measurement and commit refuses the issuance', async () => {
    const world = compose({
      requestId: 'toctou-revoked',
      resolveAuthorityBinding: (query) => (query.phase === 'commit' ? undefined : MANDATE_BINDING),
    });
    const outcome = await world.service.authorize({ request: buildRequest({ requestId: 'toctou-revoked' }), grantExpiresAt: GRANT_HORIZON });

    assert.equal(outcome.outcome, 'grant-withheld');
    assert.ok(outcome.outcome === 'grant-withheld');
    assert.ok(outcome.reasonCodes.length > 0, 'the commit-boundary refusal names a cause rather than failing silently');
  });

  it('nothing was written when the commit refused', async () => {
    const store = createInMemoryBoundedGrantStore();
    const world = compose({
      requestId: 'toctou-nothing-written',
      store,
      resolveAuthorityBinding: (query) => (query.phase === 'commit' ? undefined : MANDATE_BINDING),
    });
    await world.service.authorize({ request: buildRequest({ requestId: 'toctou-nothing-written' }), grantExpiresAt: GRANT_HORIZON });

    const probe = await world.service.assessExercise(
      exerciseRequestFor('aoc.grant:anything', { requestId: 'toctou-nothing-written', decisionId: 'x', action: EVALUATED_ACTION, resourceScope: EVALUATED_RESOURCE }),
    );
    assert.equal(probe.usable, false);
    assert.deepEqual([...probe.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND]);
  });
});

describe('Production composition — exercise gates the adapter', () => {
  it('A. a valid exercise at T+5m runs the adapter exactly once', async () => {
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-valid', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation));

    assert.equal(executed.status, 'executed');
    assert.equal(adapter.callCount, 1);
  });

  const blocked: readonly { readonly name: string; readonly overrides: Parameters<typeof exerciseRequestFor>[2]; readonly code: string }[] = [
    { name: 'B. amount expansion to 9000', overrides: { amount: { value: 9_000, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'B2. amount expansion to the policy threshold 10000', overrides: { amount: { value: 10_000, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'C. resource expansion', overrides: { resource: 'project/other' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE },
    { name: 'C2. counterparty expansion', overrides: { counterparty: 'V999' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE },
    { name: 'D. wrong subject', overrides: { subject: 'agent-B' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_SUBJECT_MISMATCH },
    { name: 'D2. wrong action', overrides: { action: 'payment.release' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE },
  ];

  for (const testCase of blocked) {
    it(`${testCase.name} blocks, and the adapter is not called`, async () => {
      const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-blocked', now: () => AT_T_PLUS_5 });
      const grant = grantOf(outcome);

      const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation, testCase.overrides));

      assert.equal(executed.status, 'withheld');
      assert.ok(blockedCodes(executed).includes(testCase.code));
      assert.equal(adapter.callCount, 0);
    });
  }

  it('E. an expired grant blocks, and the historical authorization remains ALLOW', async () => {
    let instant = AT_T_PLUS_5;
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-expired', now: () => instant });
    const grant = grantOf(outcome);

    instant = GRANT_HORIZON;
    const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation));

    assert.equal(executed.status, 'withheld');
    assert.ok(blockedCodes(executed).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(adapter.callCount, 0);
    assert.equal(outcome.decision.status, 'allowed', 'a decision that concluded allow concluded allow, permanently');
  });

  it('F. a revoked grant blocks, and the historical authorization remains ALLOW', async () => {
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-revoked', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const revoked = await service.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'ops@example.test' });
    assert.equal(revoked.outcome, 'revoked');

    const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation));
    assert.equal(executed.status, 'withheld');
    assert.ok(blockedCodes(executed).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED));
    assert.equal(adapter.callCount, 0);
    assert.equal(outcome.decision.status, 'allowed');
  });

  it('G. a caller presenting forged grant fields changes nothing — the trusted 7500 stands', async () => {
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-forged', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const forged = {
      ...exerciseRequestFor(grant.id, grant.correlation, { amount: { value: 10_000, unit: 'USD' } }),
      maxAmount: 10_000,
      grant: { maxAmount: 10_000, subject: 'attacker', expiresAt: '2099-01-01T00:00:00.000Z', revoked: false, resource: '*' },
      'aoc.grant': { status: 'active' },
    } as unknown as GrantExerciseRequest;

    const executed = await service.exercise(forged);
    assert.equal(executed.status, 'withheld');
    assert.ok(blockedCodes(executed).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED));
    assert.equal(adapter.callCount, 0, '10000 never became authority');
  });

  it('K. no grant at all means no execution', async () => {
    const world = compose({ requestId: 'exercise-no-grant', now: () => AT_T_PLUS_5 });
    const executed = await world.service.exercise(
      exerciseRequestFor('aoc.grant:never-issued', { requestId: 'exercise-no-grant', decisionId: 'd', action: EVALUATED_ACTION, resourceScope: EVALUATED_RESOURCE }),
    );

    assert.equal(executed.status, 'withheld');
    assert.deepEqual(blockedCodes(executed), [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a correlation naming a different authorization blocks', async () => {
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'exercise-correlation', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const executed = await service.exercise(
      exerciseRequestFor(grant.id, grant.correlation, { correlation: { ...grant.correlation, decisionId: 'decision-somewhere-else' } }),
    );
    assert.equal(executed.status, 'withheld');
    assert.ok(blockedCodes(executed).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_CORRELATION_INVALID));
    assert.equal(adapter.callCount, 0);
  });
});

describe('Production composition — correlation a later Evidence phase will need', () => {
  it('the chain request → decision → grant → exercise → execution result is reconstructible', async () => {
    const { service, adapter, outcome } = await issuedWorld({ requestId: 'evidence-chain', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation, { executionId: 'exec-evidence-1' }));
    assert.equal(executed.status, 'executed');

    assert.equal(grant.correlation.requestId, 'evidence-chain');
    assert.equal(grant.correlation.decisionId, outcome.decision.decisionId);
    assert.equal(executed.correlation.requestId, grant.correlation.requestId);
    assert.equal(executed.correlation.decisionId, grant.correlation.decisionId);
    assert.equal(executed.correlation.executionId, 'exec-evidence-1');
    assert.equal(executed.assessment.boundedGrantId, grant.id);
    assert.equal(executed.exercisedAt, AT_T_PLUS_5, 'a stable timestamp, from the injected clock');
    assert.equal(adapter.calls[0]?.correlation.executionId, 'exec-evidence-1');
  });

  it('a withheld exercise is just as reconstructible as an executed one', async () => {
    const { service, outcome } = await issuedWorld({ requestId: 'evidence-chain-withheld', now: () => AT_T_PLUS_5 });
    const grant = grantOf(outcome);

    const executed = await service.exercise(exerciseRequestFor(grant.id, grant.correlation, { amount: { value: 9_000, unit: 'USD' }, executionId: 'exec-evidence-2' }));
    assert.equal(executed.status, 'withheld');
    assert.equal(executed.assessment.executionId, 'exec-evidence-2');
    assert.equal(executed.assessment.boundedGrantId, grant.id);
    assert.deepEqual(executed.assessment.correlation, grant.correlation);
    assert.equal(executed.exercisedAt, AT_T_PLUS_5);
  });
});

describe('Production composition — repeated issuance is idempotent on grant identity', () => {
  it('a re-delivered authorization resolves to the existing grant rather than a second one', async () => {
    const store = createInMemoryBoundedGrantStore();
    const first = await issuedWorld({ requestId: 'idempotent', store });
    const second = await issuedWorld({ requestId: 'idempotent', store });

    const a = grantOf(first.outcome);
    const b = grantOf(second.outcome);
    assert.equal(b.id, a.id, 'grant identity is deterministic, so the same grant collides rather than duplicating');
    assert.equal(second.outcome.outcome === 'grant-issued' ? second.outcome.issuance : undefined, 'already-issued');
  });
});
