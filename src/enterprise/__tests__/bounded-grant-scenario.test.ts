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
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  type BoundedGrantStorePort,
  type GrantIssuanceOutcome,
  type GrantIssuanceService,
  type RequestedGrantBounds,
} from '../../features/grant-runtime/index.js';
import { AocKernel, type KernelEvaluationResult, type PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { toKernelEvaluationRequest, validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';

/**
 * The acceptance scenario for bounded grants, end to end, over the trusted
 * context and obligation path the two previous phases established.
 *
 * ```
 * REQUEST                   payment, amount = 7500, vendorId = V123
 * TRUSTED CONTEXT           vendor.status = approved
 * POLICY                    ALLOW only when amount <= 10000 AND trusted vendor.status == approved
 * OBLIGATION                finance.approval, blocking
 * SOURCE AUTHORIZATION      action = payment, vendor = V123, maxAmount = 7500, validUntil = T+10m
 * ```
 *
 * Eleven cases, A through K. The first three carry the phase:
 *
 * ```
 * A  obligation pending   -> ALLOW, obligation unsatisfied, eligibility INELIGIBLE, grant ABSENT
 * B  obligation verified  -> ALLOW, obligation satisfied,   eligibility ELIGIBLE,   GRANT ISSUED
 * C  amount expansion     -> NO GRANT, and the decision is still ALLOW
 * ```
 *
 * The request enters through the frozen v1 adaptation chain — the same
 * `validateGovernanceEvaluateRequestBody` and `toKernelEvaluationRequest` that
 * `POST /api/governance/evaluate` uses — so what is demonstrated is the real
 * boundary a boundary-crossing caller meets. There is no ERP, no ledger, no
 * signer and no external adapter here, deliberately: what is being proved is
 * attenuation and the trust boundary, not a connector.
 *
 * ## One departure from the brief's stated source bounds, and why
 *
 * The brief writes the source ceiling as `maxAmount = 10000` — the *policy's*
 * limit. The source ceiling this architecture can derive is `7500`, the amount
 * the decision was actually made on. The difference matters and the narrower
 * value is the correct one: the policy's `<= 10000` is a rule, not a bound the
 * decision recorded, and no decision record in this repository carries a
 * rule's threshold. Granting up to 10000 off a decision taken about 7500 would
 * be granting authority over an amount nothing ever evaluated, which is the
 * broadening this whole phase refuses. Case F therefore reads "equal bounds =
 * 7500", and case C's rejected expansion is anything above it — including
 * 10000, which is asserted explicitly below.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const GRANT_LIFETIME_SECONDS = 600;

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CONTEXT_DECLARATION: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }] };

const FINANCE_APPROVALS: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const REQUEST_SOURCE: ObligationDischargeSource = { id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' };
const OBLIGATION_DECLARATION: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true }] };

const RESOLVER_SAYS_APPROVED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }];
const RESOLVER_SAYS_BLOCKED: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'blocked', sourceId: ERP.id, observedAt: NOW }];

/** Exactly the forgeries the brief names, submitted together. */
const CALLER_FORGES_A_GRANT: Readonly<Record<string, unknown>> = {
  grant: { maxAmount: 1_000_000, action: '*', subject: 'attacker', expiresAt: '2099-01-01T00:00:00.000Z' },
  'aoc.grant': { action: '*' },
  grantEligible: true,
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

const GRANT_CAPABILITY = new KernelGrantCapability({ declaration: { maximumGrantLifetimeSeconds: GRANT_LIFETIME_SECONDS } });

function correlationFor(requestId: string, guardInput: ReturnType<typeof buildDraftClosureEmailGuardInput>) {
  return { requestId, action: guardInput.capability ?? guardInput.action, resourceScope: guardInput.resourceScope };
}

interface EvaluatedPayment {
  readonly result: KernelEvaluationResult;
  readonly request: ReturnType<typeof toKernelEvaluationRequest>;
}

/** One payment, submitted exactly as the frozen v1 endpoint submits it. */
function evaluatePayment(options: {
  readonly requestId: string;
  readonly contextObservations?: readonly ContextFactObservation[];
  readonly discharges?: (correlation: ReturnType<typeof correlationFor>) => readonly ObligationDischargeObservation[];
  readonly extraContext?: Readonly<Record<string, unknown>>;
}): Promise<EvaluatedPayment> {
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

  const fixture = buildDatasysEnforcementFixture();
  const kernel = new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    policyPackProvider: VENDOR_PAYMENT_POLICY,
    contextResolution: { provider: createInMemoryContextResolver(options.contextObservations ?? RESOLVER_SAYS_APPROVED), sources: [ERP], declaration: CONTEXT_DECLARATION },
    obligations: {
      provider: createInMemoryObligationDischargeProvider(options.discharges?.(correlation) ?? []),
      sources: [FINANCE_APPROVALS, REQUEST_SOURCE],
      declaration: OBLIGATION_DECLARATION,
    },
    grants: { declaration: { maximumGrantLifetimeSeconds: GRANT_LIFETIME_SECONDS } },
  });

  const request = toKernelEvaluationRequest(body, { now: () => NOW }, { nextId: (prefix) => `${prefix}-grant-scenario` });
  return kernel.evaluate(request).then((result) => ({ result, request }));
}

const FINANCE_APPROVED = (correlation: ReturnType<typeof correlationFor>): readonly ObligationDischargeObservation[] => [
  { obligationType: 'finance.approval', correlation, sourceId: FINANCE_APPROVALS.id, outcome: 'discharged', observedAt: '2026-01-01T11:30:00.000Z', subjectId: 'cfo@example.test', reference: 'AP-771' },
];

interface IssuedWorld {
  readonly evaluated: EvaluatedPayment;
  readonly service: GrantIssuanceService;
  readonly store: BoundedGrantStorePort;
  readonly outcome: GrantIssuanceOutcome;
}

/** Evaluate, then issue through the trusted internal path, exactly as a host composes the two. */
async function issueFor(options: {
  readonly requestId: string;
  readonly requestedBounds?: RequestedGrantBounds;
  readonly subject?: string;
  readonly contextObservations?: readonly ContextFactObservation[];
  readonly discharges?: (correlation: ReturnType<typeof correlationFor>) => readonly ObligationDischargeObservation[];
  readonly extraContext?: Readonly<Record<string, unknown>>;
}): Promise<IssuedWorld> {
  const evaluated = await evaluatePayment({
    requestId: options.requestId,
    ...(options.contextObservations !== undefined ? { contextObservations: options.contextObservations } : {}),
    ...(options.discharges !== undefined ? { discharges: options.discharges } : {}),
    ...(options.extraContext !== undefined ? { extraContext: options.extraContext } : {}),
  });

  const source = deriveGrantSourceAuthorization(GRANT_CAPABILITY, evaluated.request, evaluated.result);
  const store = createInMemoryBoundedGrantStore();
  const service = createGrantIssuanceService({ store, revalidateSource: () => source });
  const outcome = await service.issueGrant({
    source,
    ...(options.requestedBounds !== undefined ? { requestedBounds: options.requestedBounds } : {}),
    subject: options.subject ?? source.subject,
    correlation: source.correlation,
    issuedAt: NOW,
  });

  return { evaluated, service, store, outcome };
}

function refusalCodes(outcome: GrantIssuanceOutcome): readonly string[] {
  return outcome.outcome === 'refused' ? [...outcome.reasonCodes] : [];
}

describe('Acceptance A — authorized, obligation pending: ALLOW, INELIGIBLE, no grant', () => {
  it('the decision is ALLOW and grant eligibility is INELIGIBLE', async () => {
    const { result } = await evaluatePayment({ requestId: 'grant-scenario-a' });

    assert.equal(result.status, 'allowed', 'policy authorized the payment; a pending condition does not un-authorize it');
    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, false);
    assert.equal(result.grants?.eligibility, 'ineligible');
    assert.deepEqual(result.grants?.ineligibilityReasonCodes, [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('no grant is issued, and the refusal names the obligation rather than a denial', async () => {
    const { outcome } = await issueFor({ requestId: 'grant-scenario-a-issue' });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('the record shows an authorization that stands beside a grant that was withheld — not a denial', async () => {
    const { result } = await evaluatePayment({ requestId: 'grant-scenario-a-record' });
    for (const code of result.reasonCodes) assert.equal(code.startsWith('GRANT_'), false);
    assert.equal(result.summary.includes('GRANT_'), false);
  });
});

describe('Acceptance B — obligation verified: ALLOW, ELIGIBLE, GRANT ISSUED', () => {
  it('a trusted finance discharge makes the authorization grant-eligible', async () => {
    const { result } = await evaluatePayment({ requestId: 'grant-scenario-b', discharges: FINANCE_APPROVED });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.grants?.eligibility, 'eligible');
  });

  it('a grant narrowed to maxAmount 7500 and validUntil T+5m is issued', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-b-issue',
      discharges: FINANCE_APPROVED,
      requestedBounds: {
        amount: { kind: 'ceiling', limit: 7_500, unit: 'USD' },
        validity: { kind: 'window', notAfter: '2026-01-01T12:05:00.000Z' },
      },
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: 7_500, unit: 'USD' });
    assert.deepEqual(outcome.grant.scope.counterparty, { kind: 'identity', value: 'V123' });
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:05:00.000Z');
    assert.equal(outcome.grant.issuedAt, NOW);
  });

  it('the issued grant correlates back to the request, the decision, the action and the resource scope', async () => {
    const { evaluated, outcome } = await issueFor({ requestId: 'grant-scenario-b-correlation', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    assert.equal(outcome.grant.correlation.requestId, 'grant-scenario-b-correlation');
    assert.equal(outcome.grant.correlation.decisionId, evaluated.result.decisionId);
    assert.equal(outcome.grant.correlation.action, evaluated.request.action.capability ?? evaluated.request.action.type);
    assert.equal(outcome.grant.correlation.resourceScope, evaluated.request.action.resourceScope);
  });

  it('the issued grant is exercisable now and carries a source digest naming what it was narrowed from', async () => {
    const { service, outcome } = await issueFor({ requestId: 'grant-scenario-b-exercise', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    assert.match(outcome.grant.sourceDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal((await service.assessExercise(outcome.grant.id, NOW)).eligibility, 'exercisable');
  });
});

describe('Acceptance C — amount expansion: NO GRANT, decision remains ALLOW', () => {
  it('a requested ceiling above the source ceiling issues nothing', async () => {
    const { evaluated, outcome } = await issueFor({
      requestId: 'grant-scenario-c',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: 15_000, unit: 'USD' } },
    });

    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    assert.equal(evaluated.result.status, 'allowed', 'a refused grant never rewrites the decision');
    assert.equal(evaluated.result.grants?.eligibility, 'eligible', 'the authorization was and remains grant-eligible; this particular grant was not');
  });

  it("the policy's own 10000 limit is not a bound the decision recorded, so a 10000 grant is refused too", async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-c-policy-limit',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });
});

describe('Acceptance D — resource expansion: NO GRANT', () => {
  it('a grant naming vendor V999 against a decision about V123 is refused', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-d',
      discharges: FINANCE_APPROVED,
      requestedBounds: { counterparty: { kind: 'identity', value: 'V999' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('a grant naming a resource scope the decision did not evaluate is refused', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-d-resource',
      discharges: FINANCE_APPROVED,
      requestedBounds: { resources: { kind: 'set', values: ['record:somebody-elses'] } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });
});

describe('Acceptance E — validity expansion: NO GRANT', () => {
  it('a grant valid until T+30m against a horizon of T+10m is refused', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-e',
      discharges: FINANCE_APPROVED,
      requestedBounds: { validity: { kind: 'window', notAfter: '2026-01-01T12:30:00.000Z' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('an unparseable temporal bound fails closed rather than being ignored', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-e-malformed',
      discharges: FINANCE_APPROVED,
      requestedBounds: { validity: { kind: 'window', notAfter: 'whenever' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });
});

describe('Acceptance F — equal bounds: VALID', () => {
  it('requesting exactly the source bounds issues a grant', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-f',
      discharges: FINANCE_APPROVED,
      requestedBounds: {
        action: { kind: 'identity', value: buildDraftClosureEmailGuardInput().capability ?? buildDraftClosureEmailGuardInput().action },
        amount: { kind: 'ceiling', limit: 7_500, unit: 'USD' },
        counterparty: { kind: 'identity', value: 'V123' },
        resources: { kind: 'set', values: [buildDraftClosureEmailGuardInput().resourceScope] },
        validity: { kind: 'window', notAfter: HORIZON },
      },
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.equal(outcome.grant.expiresAt, HORIZON);
    assert.equal(outcome.bounds.every((bound) => bound.comparison === 'equal'), true);
  });

  it('requesting no narrowing at all inherits the source bounds exactly', async () => {
    const { evaluated, outcome } = await issueFor({ requestId: 'grant-scenario-f-inherit', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    const sourceBounds = evaluated.result.grants?.sourceBounds ?? [];
    assert.equal(outcome.grant.scope.amount?.kind, 'ceiling');
    assert.equal(sourceBounds.find((bound) => bound.key === 'amount')?.limit, 7_500);
    assert.equal(outcome.grant.expiresAt, HORIZON);
  });
});

describe('Acceptance G — narrower bounds: VALID', () => {
  it('maxAmount 5000 and validUntil T+2m issues a grant inside the source on every axis', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-g',
      discharges: FINANCE_APPROVED,
      requestedBounds: {
        amount: { kind: 'ceiling', limit: 5_000, unit: 'USD' },
        validity: { kind: 'window', notAfter: '2026-01-01T12:02:00.000Z' },
      },
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: 5_000, unit: 'USD' });
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:02:00.000Z');
    assert.deepEqual(
      outcome.bounds.filter((bound) => bound.narrowingRequested).map((bound) => [bound.key, bound.comparison]),
      [['amount', 'narrower'], ['validity', 'narrower']],
    );
  });
});

describe('Acceptance H — policy DENY: INELIGIBLE, no grant', () => {
  it('a blocked vendor denies, and no obligation or grant state converts that into an authorization', async () => {
    const { result } = await evaluatePayment({ requestId: 'grant-scenario-h', contextObservations: RESOLVER_SAYS_BLOCKED, discharges: FINANCE_APPROVED });

    assert.equal(result.status, 'denied');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, true, 'the obligation really is satisfied — and it changes nothing');
    assert.equal(result.grants?.eligibility, 'ineligible');
    assert.deepEqual(result.grants?.ineligibilityReasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });

  it('issuance refuses, whatever bounds are asked for', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-h-issue',
      contextObservations: RESOLVER_SAYS_BLOCKED,
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: 1, unit: 'USD' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });
});

describe('Acceptance I — caller-forged grant: ignored, never authoritative', () => {
  it('the forged payload changes nothing about eligibility or the source bounds', async () => {
    const honest = await evaluatePayment({ requestId: 'grant-scenario-i', discharges: FINANCE_APPROVED });
    const forged = await evaluatePayment({ requestId: 'grant-scenario-i', discharges: FINANCE_APPROVED, extraContext: CALLER_FORGES_A_GRANT });

    assert.deepEqual(forged.result.grants, honest.result.grants);
  });

  it('a grant issued alongside the forgery carries the honest subject and the honest bounds', async () => {
    const { outcome } = await issueFor({ requestId: 'grant-scenario-i-issue', discharges: FINANCE_APPROVED, extraContext: CALLER_FORGES_A_GRANT });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    assert.notEqual(outcome.grant.subject, 'attacker');
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: 7_500, unit: 'USD' });
    assert.equal(outcome.grant.expiresAt, HORIZON);
  });

  it('the caller cannot name itself the holder even through the trusted path', async () => {
    const { outcome } = await issueFor({ requestId: 'grant-scenario-i-subject', discharges: FINANCE_APPROVED, subject: 'attacker' });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SUBJECT_INVALID]);
  });
});

describe('Acceptance J — revoked grant: unusable, and the history is untouched', () => {
  it('a previously valid grant becomes unusable, while the decision stays ALLOW', async () => {
    const { evaluated, service, outcome } = await issueFor({ requestId: 'grant-scenario-j', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    assert.equal((await service.assessExercise(outcome.grant.id, NOW)).eligibility, 'exercisable');
    await service.revokeGrant({ grantId: outcome.grant.id, reason: 'security-incident', revokedAt: '2026-01-01T12:03:00.000Z', issuerRef: 'ops' });

    const after = await service.assessExercise(outcome.grant.id, '2026-01-01T12:04:00.000Z');
    assert.equal(after.eligibility, 'unusable');
    assert.deepEqual(after.reasonCodes, [GRANT_REASON_CODES.GRANT_REVOKED]);
    assert.equal(evaluated.result.status, 'allowed', 'the historical authorization is exactly what it was');
    assert.equal(evaluated.result.grants?.eligibility, 'eligible');
  });

  it('revocation is idempotent and never re-dates the first one', async () => {
    const { service, outcome } = await issueFor({ requestId: 'grant-scenario-j-idempotent', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    const first = await service.revokeGrant({ grantId: outcome.grant.id, reason: 'administrator-revoked', revokedAt: '2026-01-01T12:03:00.000Z', issuerRef: 'ops' });
    const second = await service.revokeGrant({ grantId: outcome.grant.id, reason: 'security-incident', revokedAt: '2026-01-01T12:08:00.000Z', issuerRef: 'ops-2' });
    if (first.outcome === 'refused' || second.outcome === 'refused') throw new Error('expected both revocations to resolve');

    assert.equal(second.outcome, 'already-revoked');
    assert.deepEqual(second.revocation, first.revocation);
  });
});

describe('Acceptance K — expired grant: unusable, no mutation of history', () => {
  it('at the horizon the grant is unusable, with nothing having swept', async () => {
    const { service, store, outcome } = await issueFor({ requestId: 'grant-scenario-k', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    assert.equal((await service.assessExercise(outcome.grant.id, '2026-01-01T12:09:59.999Z')).eligibility, 'exercisable');
    const expired = await service.assessExercise(outcome.grant.id, HORIZON);
    assert.equal(expired.eligibility, 'unusable');
    assert.deepEqual(expired.reasonCodes, [GRANT_REASON_CODES.GRANT_EXPIRED]);

    const read = await store.read(outcome.grant.id);
    assert.deepEqual(read.grant, outcome.grant, 'expiry changed no stored byte');
  });

  it('the historical authorization is unchanged after the grant expires', async () => {
    const { evaluated, service, outcome } = await issueFor({ requestId: 'grant-scenario-k-history', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    await service.assessExercise(outcome.grant.id, '2026-01-02T00:00:00.000Z');
    assert.equal(evaluated.result.status, 'allowed');
    assert.equal(evaluated.result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(evaluated.result.grants?.eligibility, 'eligible');
  });
});
