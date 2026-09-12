import {
  GRANT_REASON_CODES,
  assessGrantEligibility,
  assertValidGrantDeclaration,
  deploymentGrantValidityCeiling,
  statedGrantBoundKeys,
  type GrantBound,
  type GrantBoundKey,
  type GrantCorrelation,
  type GrantDeclaration,
  type GrantEligibilityAssessment,
  type GrantScope,
  type GrantSourceAuthorization,
  type GrantValidityCeiling,
} from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { GrantBoundEvaluation, GrantEvaluation, KernelEvaluationResult } from '../contracts/kernel-result.js';

/**
 * How a deployment adopts bounded grants.
 *
 * One option object rather than loose fields, for the reason
 * `KernelObligationOptions` is one: supplying the object is the whole of the
 * opt-in, and omitting it leaves the Kernel byte-identical to this layer not
 * existing.
 *
 * Note what is **not** here: no store, no issuance path, no provider.
 * `evaluate()` reports whether an authorization would be grant-eligible and
 * issues nothing, so it needs no writable dependency and is given none. A
 * deployment that also wants to *issue* composes
 * `createGrantIssuanceService` at the host, against the same declaration. The
 * separation is deliberate — see the README's "Evaluation is not issuance".
 */
export interface KernelGrantOptions {
  /**
   * Operator configuration. Every field on it is optional and an empty
   * declaration is valid: a deployment adopts grants by composing the
   * capability, not by configuring a limit.
   */
  readonly declaration: GrantDeclaration;
}

/**
 * The grant capability, composed once at Kernel construction.
 *
 * Constructed here rather than per request so a declaration that could never be
 * honoured — a zero or negative grant horizon — is a wiring-time failure
 * instead of one discovered in the middle of a payment. Exactly the discipline
 * `KernelObligationCapability` and `KernelContextCapability` follow.
 */
export class KernelGrantCapability {
  readonly declaration: GrantDeclaration;

  constructor(options: KernelGrantOptions) {
    assertValidGrantDeclaration(options.declaration);
    this.declaration = options.declaration;
  }
}

/** The correlation a grant derived from this evaluation is bound to, taken from the typed request and the Kernel's own decision id — never from a requester-supplied bag. */
export function grantCorrelationFor(request: KernelEvaluationRequest, decisionId: string): GrantCorrelation {
  return {
    requestId: request.requestId,
    decisionId,
    action: request.action.capability ?? request.action.type,
    resourceScope: request.action.resourceScope,
  };
}

/**
 * Whether a decision status is one an authority could be exercised under at
 * all.
 *
 * The single place the authorization vocabulary is read on behalf of layer E,
 * and it is read *here*, in the Kernel, because
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` §4 makes the Kernel the only decision
 * producer and gives layer E no standing to interpret one. What crosses the
 * boundary is a boolean, so the grant runtime has no decision vocabulary to
 * misuse — and `grant-layer-boundaries.test.ts` proves it has none.
 *
 * `allowed` and nothing else. `approval_required` is not an authorization to
 * exercise, it is a decision that more has to happen first; `denied` and
 * `indeterminate` speak for themselves. Identical in value and in intent to
 * `isExecutableStatus` in `obligation-adapter.ts`.
 */
function authorizationPermitsExercise(status: KernelEvaluationResult['status']): boolean {
  return status === 'allowed';
}

/**
 * The bounds the authorization stood under, read out of the evaluated request.
 *
 * Every value here is one the decision was *made on*: the action that was
 * evaluated, the resource scope that was evaluated, the counterparty that was
 * evaluated, the tenant it was scoped to, the quantity that was evaluated, and
 * the horizon operator configuration allows off it. That is what makes them a
 * safe ceiling even though the request carried some of them: the policy
 * concluded what it concluded *about these values*, so a grant at or below them
 * is inside what was authorized, and a grant above them describes something
 * that was never evaluated.
 *
 * It is emphatically **not** a re-reading of the request as fact. Layer C
 * exists precisely because a caller's claim is not evidence of the world; this
 * is the different question of what the decision covered, and the answer to
 * that is, by construction, the input the decision was given.
 */
function sourceScopeFor(request: KernelEvaluationRequest): GrantScope {
  const action = request.action.capability ?? request.action.type;
  const amountBound: GrantBound | undefined =
    typeof request.action.amount === 'number' && Number.isFinite(request.action.amount) && request.action.amount >= 0 && request.action.currency !== undefined
      ? { kind: 'ceiling', limit: request.action.amount, unit: request.action.currency }
      : undefined;

  return {
    ...(action.length > 0 ? { action: { kind: 'identity' as const, value: action } } : {}),
    ...(amountBound !== undefined ? { amount: amountBound } : {}),
    ...(request.action.counterpartyId !== undefined ? { counterparty: { kind: 'identity' as const, value: request.action.counterpartyId } } : {}),
    ...(request.organization?.id !== undefined ? { organization: { kind: 'identity' as const, value: request.organization.id } } : {}),
    ...(request.action.resourceScope.length > 0 ? { resources: { kind: 'set' as const, values: [request.action.resourceScope] } } : {}),
  };
}

/**
 * The upstream temporal ceilings the Kernel can see, and only those.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4, rule 4, measured rather
 * than assumed: **no decision record in this repository carries a validity
 * window.** `EnterpriseAccessDecision`, `GovernanceEvaluationRecord` and
 * `KernelEvaluationResult` each carry `evaluatedAt` and no horizon, so there is
 * no `decision` ceiling to emit and none is invented. If a decision ever gains
 * one, this is where it joins the list.
 *
 * The Kernel cannot see a mandate or a representative authority either — those
 * live behind the Enterprise authority stores, which layer E may not reach — so
 * an `authority` ceiling is added by the composition root that knows of one,
 * through `withGrantValidityCeiling` or
 * `GrantIssuanceRequest.additionalValidityCeilings`.
 *
 * What is left is the deployment's own optional safety cap, when configured.
 * When it is not, this returns an empty list, and an empty list is an ordinary
 * answer: the issuer's finite `expiresAt` is what bounds the grant, and
 * `resolveGrantValidity` still requires one.
 */
function validityCeilingsFor(declaration: GrantDeclaration, evaluatedAt: string): readonly GrantValidityCeiling[] {
  const deployment = deploymentGrantValidityCeiling(declaration, evaluatedAt);
  return deployment === undefined ? [] : [deployment];
}

/**
 * Projects an evaluated result into the only shape layer E may see.
 *
 * The projection is a **read**. Nothing here mutates the result, the decision,
 * the policy outcomes, the context evaluation or the obligation evaluation —
 * every field is copied by value out of an already-frozen result, and a grant
 * is a derived artifact of it.
 *
 * `allBlockingObligationsSatisfied` comes straight off the obligation
 * evaluation, and is `true` when no obligation evaluation is present at all:
 * a deployment that declared no obligations has nothing outstanding, which is
 * the same reading `applyObligationStep` gives an absent evaluation.
 */
export function deriveGrantSourceAuthorization(
  capability: KernelGrantCapability,
  request: KernelEvaluationRequest,
  result: KernelEvaluationResult,
): GrantSourceAuthorization {
  return {
    correlation: grantCorrelationFor(request, result.decisionId),
    subject: request.actor.id,
    scope: sourceScopeFor(request),
    authorizationPermitsExercise: authorizationPermitsExercise(result.status),
    allBlockingObligationsSatisfied: result.obligations === undefined ? true : result.obligations.allBlockingObligationsSatisfied,
    evaluatedAt: result.evaluatedAt,
    validityCeilings: validityCeilingsFor(capability.declaration, result.evaluatedAt),
  };
}

function toBoundEvaluations(scope: GrantScope): readonly GrantBoundEvaluation[] {
  return statedGrantBoundKeys(scope).map((key: GrantBoundKey) => {
    const bound = scope[key];
    if (bound === undefined) return { key, kind: 'identity' };
    switch (bound.kind) {
      case 'identity':
        return { key, kind: bound.kind, value: bound.value };
      case 'set':
        return { key, kind: bound.kind, values: bound.values };
      case 'ceiling':
        return { key, kind: bound.kind, limit: bound.limit, unit: bound.unit };
      case 'window':
        return { key, kind: bound.kind, notAfter: bound.notAfter };
      default:
        return { key, kind: 'identity' };
    }
  });
}

/** What the grant layer found for this evaluation — and, emphatically, not what it decided or issued. */
export interface KernelGrantFacts {
  readonly evaluation: GrantEvaluation;
  readonly source: GrantSourceAuthorization;
  readonly assessment: GrantEligibilityAssessment;
}

/**
 * Measures whether the evaluated authorization is one a bounded grant could be
 * derived from.
 *
 * The one thing this function must never do is produce or alter an
 * authorization outcome, and it has no way to: its return type carries no
 * status, no decision and no `AocKernelReasonCode`, and the codes it emits come
 * from a structurally separate union (`grant-reason-codes.ts`) that a test
 * asserts does not overlap either of the other two.
 */
export function resolveKernelGrantFacts(
  capability: KernelGrantCapability,
  request: KernelEvaluationRequest,
  result: KernelEvaluationResult,
): KernelGrantFacts {
  const source = deriveGrantSourceAuthorization(capability, request, result);
  const assessment = assessGrantEligibility(source);
  const eligible = assessment.eligibility === 'eligible';

  const evaluation: GrantEvaluation = {
    performed: true,
    eligibility: assessment.eligibility,
    correlation: source.correlation,
    subject: source.subject,
    sourceBounds: toBoundEvaluations(source.scope),
    // Reported whether or not any exist. An empty list is the measured answer
    // on the generic Kernel path — no decision record carries a validity window
    // — and reporting it is how "was anything capping this?" stays answerable
    // without re-deriving it.
    validityCeilings: source.validityCeilings.map((ceiling) => ({ source: ceiling.source, notAfter: ceiling.notAfter })),
    ...(assessment.reasonCodes.length > 0 ? { ineligibilityReasonCodes: assessment.reasonCodes } : {}),
    ...(eligible
      ? {}
      : {
          summary: `The authorization is reported exactly as the policy layers concluded it; no bounded grant may be derived from it yet: ${assessment.reasonCodes.join(', ')}.`,
        }),
  };

  return { evaluation, source, assessment };
}

/**
 * Attaches grant eligibility to an evaluated result.
 *
 * Exactly one thing happens here: the grant evaluation is added. **`status`,
 * `reasonCodes` and `summary` are not read, not compared and not written**, and
 * neither are `context` or `obligations`. That is the settling invariant of this
 * phase restated as a property of one function, and it is testable by deletion:
 * remove the grant capability from any scenario and the result this function was
 * handed comes back identical, because this function never had access to change
 * it.
 *
 * It also issues nothing. `evaluate()` stays pure — no store is touched, no
 * artifact is created, and two evaluations of the same world produce the same
 * result. Issuance is `createGrantIssuanceService`, and it is a separate
 * operation for exactly that reason.
 */
export function applyGrantStep<TResult extends KernelEvaluationResult>(
  capability: KernelGrantCapability | undefined,
  request: KernelEvaluationRequest,
  result: TResult,
): TResult {
  if (capability === undefined) return result;
  return { ...result, grants: resolveKernelGrantFacts(capability, request, result).evaluation };
}

/** Re-exported so a host composing issuance shares the Kernel's own ineligibility vocabulary rather than a parallel copy of it. */
export { GRANT_REASON_CODES };
