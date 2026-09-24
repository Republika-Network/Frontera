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
  withGrantAmountCeiling,
  withGrantValidityCeiling,
  type BoundedGrantStorePort,
  type GrantIssuanceOutcome,
  type GrantIssuanceService,
  type RequestedGrantBounds,
} from '../../features/grant-runtime/index.js';
import { AocKernel, type KernelEvaluationResult, type PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { toKernelEvaluationRequest, validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import { compareCanonicalDecimals, isCanonicalDecimal } from '../../features/monetary-runtime/index.js';

/**
 * The acceptance scenario for bounded grants, end to end, over the trusted
 * context and obligation path the two previous phases established.
 *
 * ```
 * REQUEST                   payment, amount = 7500, vendorId = V123
 * TRUSTED CONTEXT           vendor.status = approved
 * POLICY                    ALLOW only when amount <= 10000 AND trusted vendor.status == approved
 * OBLIGATION                finance.approval, blocking
 * DURABLE AUTHORITY         per-execution ceiling = 8000 USD (provisioned, independent of the request)
 * SOURCE AUTHORIZATION      action = payment, vendor = V123, maxAmount = 8000 (the authority's)
 * ISSUER-PROPOSED VALIDITY  expiresAt, contained by the deployment cap at T+10m
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
 * ## Where the source amount ceiling comes from (P10)
 *
 * Three different numbers, and only one of them is authority:
 *
 * ```
 * requested amount    7500    the effect this payment proposes        (the request)
 * policy threshold   10000    ALLOW when amount <= 10000              (a rule)
 * authority ceiling   8000    the most one payment may move           (durable authority)
 * ```
 *
 * Before P10 the Kernel projected the *requested* amount as the source
 * ceiling — a request authorizing itself. It now projects no amount bound at
 * all, and the composition that can see durable monetary authority attaches
 * the authority's ceiling with `withGrantAmountCeiling` (in production, the
 * Kernel Authority Store's `max_amount`, resolved on the decision's own
 * authority lineage — see `authority-payment-ceilings.test.ts`). This suite
 * attaches it directly, because what it proves is layer E's containment:
 * requested bounds at or below 8000 issue, anything above — including the
 * policy's 10000 — is broadening, and a decision with no authority ceiling
 * attached carries no amount axis a requested bound could narrow.
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
      amount: '7500',
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

/** The durably provisioned per-execution authority ceiling this scenario's issuer attaches — deliberately neither the request's 7500 nor the policy's 10000. */
const AUTHORITY_CEILING = { kind: 'ceiling', limit: '8000', unit: 'USD' } as const;

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
  /** The trusted issuer's proposed expiry. Defaults to the deployment horizon so a case that is not about validity need not restate it. */
  readonly expiresAt?: string;
  readonly subject?: string;
  readonly contextObservations?: readonly ContextFactObservation[];
  readonly discharges?: (correlation: ReturnType<typeof correlationFor>) => readonly ObligationDischargeObservation[];
  readonly extraContext?: Readonly<Record<string, unknown>>;
  /** `null` issues from the bare Kernel projection, with no authority ceiling attached. */
  readonly authorityCeiling?: null;
}): Promise<IssuedWorld> {
  const evaluated = await evaluatePayment({
    requestId: options.requestId,
    ...(options.contextObservations !== undefined ? { contextObservations: options.contextObservations } : {}),
    ...(options.discharges !== undefined ? { discharges: options.discharges } : {}),
    ...(options.extraContext !== undefined ? { extraContext: options.extraContext } : {}),
  });

  const projected = deriveGrantSourceAuthorization(GRANT_CAPABILITY, evaluated.request, evaluated.result);
  const source = options.authorityCeiling === null ? projected : withGrantAmountCeiling(projected, AUTHORITY_CEILING);
  if (source === undefined) throw new Error('the authority ceiling could not be attached');
  const store = createInMemoryBoundedGrantStore();
  const service = createGrantIssuanceService({ store, revalidateSource: () => source });
  const outcome = await service.issueGrant({
    source,
    ...(options.requestedBounds !== undefined ? { requestedBounds: options.requestedBounds } : {}),
    subject: options.subject ?? source.subject,
    correlation: source.correlation,
    issuedAt: NOW,
    expiresAt: options.expiresAt ?? HORIZON,
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

  it('a grant narrowed from the 8000 authority ceiling to maxAmount 7500 and validUntil T+5m is issued', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-b-issue',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: '7500', unit: 'USD' } },
      expiresAt: '2026-01-01T12:05:00.000Z',
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: '7500', unit: 'USD' });
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
  it('a requested ceiling above the authority ceiling issues nothing', async () => {
    const { evaluated, outcome } = await issueFor({
      requestId: 'grant-scenario-c',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: '15000', unit: 'USD' } },
    });

    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    assert.equal(evaluated.result.status, 'allowed', 'a refused grant never rewrites the decision');
    assert.equal(evaluated.result.grants?.eligibility, 'eligible', 'the authorization was and remains grant-eligible; this particular grant was not');
  });

  it("the policy's own 10000 limit is not authority, so a 10000 grant is refused too", async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-c-policy-limit',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: '10000', unit: 'USD' } },
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });
});

describe('P10 amount semantics — the grant is bounded by authority, never by the request or the policy', () => {
  /**
   * ```
   * request amount    = 7500    the proposed effect
   * policy threshold  = ALLOW when amount <= 10000
   * authority ceiling = 8000    NOT 7500, NOT 10000
   * ```
   *
   * The decision proves *this* action at *this* amount was authorized; the
   * authority ceiling says how much one payment under this authority may ever
   * move. Neither the request nor the rule's threshold becomes a ceiling.
   */
  const CASES: readonly { readonly limit: string; readonly expected: 'issued' | 'refused'; readonly why: string }[] = [
    { limit: '8000', expected: 'issued', why: 'equal to the authority ceiling' },
    { limit: '7500', expected: 'issued', why: 'the requested amount — a narrowing a trusted issuer may choose, never the default' },
    { limit: '5000', expected: 'issued', why: 'a narrowing of it' },
    { limit: '1', expected: 'issued', why: 'a much smaller narrowing' },
    { limit: '8000.01', expected: 'refused', why: 'one cent above the authority ceiling' },
    { limit: '9000', expected: 'refused', why: 'below the policy threshold but above the authority ceiling' },
    { limit: '10000', expected: 'refused', why: 'exactly the policy threshold, which is a rule and not authority' },
    { limit: '15000', expected: 'refused', why: 'above both' },
  ];

  for (const testCase of CASES) {
    it(`a requested ceiling of ${testCase.limit} is ${testCase.expected} — ${testCase.why}`, async () => {
      const { outcome } = await issueFor({
        requestId: `grant-scenario-p10-${testCase.limit}`,
        discharges: FINANCE_APPROVED,
        requestedBounds: { amount: { kind: 'ceiling', limit: testCase.limit, unit: 'USD' } },
      });

      assert.equal(outcome.outcome, testCase.expected);
      if (testCase.expected === 'refused') {
        assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
      }
    });
  }

  it('neither the requested amount nor the policy threshold reaches the grant derivation path', async () => {
    const { evaluated } = await issueFor({ requestId: 'grant-scenario-p10-threshold', discharges: FINANCE_APPROVED });

    assert.equal(
      evaluated.result.grants?.sourceBounds.some((bound) => bound.key === 'amount'),
      false,
      'the Kernel projects no amount bound: the request cannot be the source of its own ceiling',
    );
    assert.equal(JSON.stringify(evaluated.result.grants).includes('10000'), false, "nothing carries a rule's threshold out of policy evaluation");
    assert.equal(JSON.stringify(evaluated.result.grants).includes('7500'), false, 'nothing carries the requested amount into the grant source');
  });

  it('without an authority ceiling there is no amount axis, so no requested bound can create one', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-p10-no-authority',
      discharges: FINANCE_APPROVED,
      authorityCeiling: null,
      requestedBounds: { amount: { kind: 'ceiling', limit: '7500', unit: 'USD' } },
    });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('a second, larger action cannot stretch a grant past the authority ceiling', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-p10-second-action',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: '9000', unit: 'USD' } },
    });
    assert.equal(outcome.outcome, 'refused');
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
      expiresAt: '2026-01-01T12:30:00.000Z',
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('an unparseable temporal bound fails closed rather than being ignored', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-e-malformed',
      discharges: FINANCE_APPROVED,
      expiresAt: 'whenever',
    });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
  });
});

describe('Acceptance F — equal bounds: VALID', () => {
  it('requesting exactly the source bounds issues a grant', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-f',
      discharges: FINANCE_APPROVED,
      requestedBounds: {
        action: { kind: 'identity', value: buildDraftClosureEmailGuardInput().capability ?? buildDraftClosureEmailGuardInput().action },
        amount: AUTHORITY_CEILING,
        counterparty: { kind: 'identity', value: 'V123' },
        resources: { kind: 'set', values: [buildDraftClosureEmailGuardInput().resourceScope] },
      },
      expiresAt: HORIZON,
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.equal(outcome.grant.expiresAt, HORIZON);
    assert.equal(outcome.bounds.every((bound) => bound.comparison === 'equal'), true);
  });

  it('requesting no narrowing at all inherits the source bounds exactly', async () => {
    const { evaluated, outcome } = await issueFor({ requestId: 'grant-scenario-f-inherit', discharges: FINANCE_APPROVED });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');

    const sourceBounds = evaluated.result.grants?.sourceBounds ?? [];
    assert.deepEqual(outcome.grant.scope.amount, AUTHORITY_CEILING, 'the grant inherits the authority ceiling, not the requested 7500');
    assert.equal(sourceBounds.find((bound) => bound.key === 'amount'), undefined, 'the Kernel projection carries no amount bound');
    assert.equal(outcome.grant.expiresAt, HORIZON);
    assert.deepEqual(evaluated.result.grants?.validityCeilings, [{ source: 'deployment', notAfter: HORIZON }]);
  });
});

describe('Acceptance G — narrower bounds: VALID', () => {
  it('maxAmount 5000 and validUntil T+2m issues a grant inside the source on every axis', async () => {
    const { outcome } = await issueFor({
      requestId: 'grant-scenario-g',
      discharges: FINANCE_APPROVED,
      requestedBounds: { amount: { kind: 'ceiling', limit: '5000', unit: 'USD' } },
      expiresAt: '2026-01-01T12:02:00.000Z',
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: '5000', unit: 'USD' });
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:02:00.000Z');
    assert.deepEqual(
      outcome.bounds.filter((bound) => bound.narrowingRequested).map((bound) => [bound.key, bound.comparison]),
      [['amount', 'narrower']],
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
      requestedBounds: { amount: { kind: 'ceiling', limit: '1', unit: 'USD' } },
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
    assert.deepEqual(outcome.grant.scope.amount, AUTHORITY_CEILING);
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

describe('Validity source, end to end', () => {
  it('the issuer proposes the expiry and it is accepted exactly, within the deployment cap', async () => {
    const { outcome } = await issueFor({ requestId: 'grant-scenario-validity-issuer', discharges: FINANCE_APPROVED, expiresAt: '2026-01-01T12:03:00.000Z' });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:03:00.000Z');
    assert.deepEqual(outcome.effectiveValidityCeiling, { source: 'deployment', notAfter: HORIZON });
  });

  it('a governing authority window caps the grant below the deployment cap', async () => {
    const evaluated = await evaluatePayment({ requestId: 'grant-scenario-validity-authority', discharges: FINANCE_APPROVED });
    const source = withGrantValidityCeiling(deriveGrantSourceAuthorization(GRANT_CAPABILITY, evaluated.request, evaluated.result), {
      source: 'authority',
      notAfter: '2026-01-01T12:04:00.000Z',
    });
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });

    const beyond = await service.issueGrant({ source, subject: source.subject, correlation: source.correlation, issuedAt: NOW, expiresAt: '2026-01-01T12:08:00.000Z' });
    assert.equal(beyond.outcome, 'refused', 'a grant never outlives the authority justifying it');

    const within = await service.issueGrant({ source, subject: source.subject, correlation: source.correlation, issuedAt: NOW, expiresAt: '2026-01-01T12:03:00.000Z' });
    assert.equal(within.outcome, 'issued');
  });

  it('a deployment that configures no cap still issues grants on the issuer’s own finite expiry', async () => {
    const evaluated = await evaluatePayment({ requestId: 'grant-scenario-validity-no-cap', discharges: FINANCE_APPROVED });
    const uncapped = new KernelGrantCapability({ declaration: {} });
    const source = deriveGrantSourceAuthorization(uncapped, evaluated.request, evaluated.result);
    assert.deepEqual(source.validityCeilings, [], 'no decision record carries a validity window, and no cap is configured');

    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    const outcome = await service.issueGrant({ source, subject: source.subject, correlation: source.correlation, issuedAt: NOW, expiresAt: '2026-01-01T12:06:00.000Z' });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:06:00.000Z');
    assert.equal(outcome.effectiveValidityCeiling, undefined);
  });

  it('and still refuses one with no finite expiry — an absent ceiling never means unbounded', async () => {
    const evaluated = await evaluatePayment({ requestId: 'grant-scenario-validity-no-expiry', discharges: FINANCE_APPROVED });
    const source = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), evaluated.request, evaluated.result);
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });

    const outcome = await service.issueGrant({
      source,
      subject: source.subject,
      correlation: source.correlation,
      issuedAt: NOW,
      expiresAt: undefined as unknown as string,
    });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
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
