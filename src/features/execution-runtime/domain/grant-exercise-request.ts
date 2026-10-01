import { compareDimensionIds, isWellFormedGovernedParameter, type GovernedParameter } from '../../governed-parameter-runtime/index.js';
import type { GrantCorrelation } from '../../grant-runtime/index.js';
import { isWellFormedMonetaryAmount, type MonetaryAmount } from '../../monetary-runtime/index.js';

/**
 * One attempt to exercise one already-issued bounded grant.
 *
 * ## It carries a *reference*, never a grant
 *
 * `boundedGrantId` is the whole of what a caller may say about the grant.
 * There is deliberately no field on this type for a grant object, a grant
 * scope, an expiry, a revocation status, a digest or a subject claimed by the
 * grant — `ADR-ACCESS-GRANT.md` and `bounded-grant.ts` both settle that a
 * bounded grant "is an internal, typed record held by a trusted store; a caller
 * never holds one and therefore never presents one", and no accepted ADR has
 * since defined a self-authenticating serialized form.
 *
 * So the tampering case has no shape to arrive in. A caller that sends
 * `{"grantId":"trusted-grant","maxAmount":1000000}` has sent one field this
 * type reads — the id — and a second field that does not exist here and is not
 * read anywhere downstream. The authoritative bounds come from the store, and
 * `tests/execution-adversarial.test.ts` measures that the assessment is
 * byte-identical with and without every such payload.
 *
 * ## What the other fields are
 *
 * They describe **the action being attempted now**, and every one of them is
 * proven against the trusted grant before anything executes. They are not
 * claims that widen anything: a value outside the grant's bound refuses the
 * exercise rather than enlarging it, and a value the grant does not bound at
 * all refuses it too — containment cannot be proven against an absent bound,
 * which is the same fail-closed posture `attenuateGrantScope` takes at
 * issuance.
 *
 * `correlation` is the authorization this exercise claims to be under, and it
 * is matched exactly against the correlation the trusted grant carries.
 * `executionId` is this attempt's own identity, carried through to the outcome
 * so the later Evidence phase can reconstruct
 * `request → decision → grant → exercise → execution result` without
 * re-deriving it from free text.
 */
export interface GrantExerciseRequest {
  /** The trusted grant this attempt is made under. A reference; the store is what is believed. */
  readonly boundedGrantId: string;
  /** Who is attempting it. Must equal the grant's holder — there is no delegation at this layer. */
  readonly subject: string;
  /** The action being attempted. Must equal the action the grant bounds. */
  readonly action: string;
  /** The resource being acted over. Must be a member of the grant's bounded resource set. */
  readonly resource: string;
  /** The counterparty, where the action has one. */
  readonly counterparty?: string;
  /** The tenant the attempt is made in, where the grant is tenant-bound. */
  readonly organization?: string;
  /** The quantity being attempted, with the unit it is denominated in. Compared against the grant's ceiling exactly, never converted. */
  readonly amount?: GrantExerciseAmount;
  /**
   * The Governance Profile reference (`<id>@<version>#<digest>`) the action was
   * classified under, where it was classified (CORE-03). Must equal the
   * profile the grant is bound to, under the same three-way rule as every
   * identity axis.
   */
  readonly governanceProfile?: string;
  /** CORE-03 — the trusted action class and resource class the action was classified under. Each must equal the class the grant is bound to, under the same three-way rule. */
  readonly actionClass?: string;
  readonly resourceClass?: string;
  /**
   * The typed parameter values being attempted, one per declared dimension, in
   * canonical dimension order (CORE-03). Every dimension the grant bounds must
   * be stated and inside its bound; a dimension the grant does not bound may
   * not be stated at all.
   */
  readonly parameters?: readonly GovernedParameter[];
  /** The authorization this exercise claims to be under. Exact on all four fields. */
  readonly correlation: GrantCorrelation;
  /** This attempt's own identity, preserved into the outcome for later correlation. */
  readonly executionId: string;
}

/**
 * ## Why there is no free-form provider payload on this type
 *
 * An earlier revision carried an opaque `payloadRef` — "whatever the provider
 * needs in order to act, never interpreted here". It is gone, because an
 * adapter that dereferences such a handle to load the provider command would
 * execute data that **no bound covered and no assessment saw**.
 *
 * The hole was concrete. A caller holding a grant for 7500 to V123 passes the
 * assessment with `amount = 7500`, `counterparty = 'V123'` — and a `payloadRef`
 * naming a stored payload for 100000 to V999. Every check passes, because none
 * of them can reach inside an opaque handle, and the adapter submits the
 * payload. The module's one invariant would have held in the letter and failed
 * in the substance.
 *
 * The two ways to keep such a field are both refused here. Resolving the
 * payload before assessment and comparing its actionable fields would make this
 * layer read and interpret provider-specific data, which is exactly what the
 * adapter boundary exists to keep out. Integrity-binding the reference to the
 * authorized action would mean choosing a binding scheme — a decision no
 * accepted ADR makes, and the sort of thing this phase must not invent.
 *
 * So the action *is* the payload: `ValidatedExecutionAction` carries the
 * subject, action, resource, counterparty, organization and amount, each proven
 * inside a bound, and an adapter translates those into a provider call. A later
 * ADR that genuinely needs an out-of-band payload can add one together with the
 * integrity binding that makes it safe; until then the closed direction is to
 * have no unassessed channel across the execution boundary at all.
 */

/** A `MonetaryAmount` (`src/features/monetary-runtime`): canonical decimal text and an asset identifier. Never a number. */
export type GrantExerciseAmount = MonetaryAmount;

/** Whether an amount is a quantity at all. Anything but canonical decimal text in a well-formed asset — a number included — is refused rather than compared. */
export function isWellFormedGrantExerciseAmount(amount: GrantExerciseAmount): boolean {
  return isWellFormedMonetaryAmount(amount);
}

/**
 * Whether the request states every field a deterministic comparison needs.
 *
 * Blank is refused rather than compared, for the reason
 * `isWellFormedGrantCorrelation` gives one layer up: an empty string matching
 * an empty string is not a proof of anything, and a check that can be satisfied
 * by absence is not a check.
 *
 * Optional axes are validated only when present — stating no counterparty is
 * an ordinary request shape, and whether the *grant* required one is the
 * containment question, answered separately.
 */
export function isWellFormedGrantExerciseRequest(request: GrantExerciseRequest): boolean {
  if (request.boundedGrantId.length === 0) return false;
  if (request.subject.length === 0) return false;
  if (request.action.length === 0) return false;
  if (request.resource.length === 0) return false;
  if (request.executionId.length === 0) return false;
  if (request.counterparty !== undefined && request.counterparty.length === 0) return false;
  if (request.organization !== undefined && request.organization.length === 0) return false;
  if (request.amount !== undefined && !isWellFormedGrantExerciseAmount(request.amount)) return false;
  if (request.governanceProfile !== undefined && request.governanceProfile.length === 0) return false;
  if (request.actionClass !== undefined && request.actionClass.length === 0) return false;
  if (request.resourceClass !== undefined && request.resourceClass.length === 0) return false;
  if (request.parameters !== undefined && !isWellFormedExerciseParameters(request.parameters)) return false;
  return (
    request.correlation.requestId.length > 0 &&
    request.correlation.decisionId.length > 0 &&
    request.correlation.action.length > 0 &&
    request.correlation.resourceScope.length > 0
  );
}

/**
 * The attempt, read **once** into fresh frozen data (CORE-08).
 *
 * The structured values an adapter will receive — the amount and the typed
 * parameters — are copied field by field into new frozen objects the moment an
 * exercise begins, and everything after that point (every assessment, the
 * exercise-control input, the `ValidatedExecutionAction`) reads the copy. A
 * caller that keeps a reference to its request object, its parameter array or
 * an entry in it, and mutates any of them while the exercise awaits a store,
 * a reservation or a second read, changes nothing that was assessed and
 * nothing an adapter sees: the value proven inside the grant's bound is the
 * value that crosses the boundary.
 *
 * Only the declared fields are copied (`dimension`, `type`, `value`; `value`,
 * `unit`), so nothing else on a caller's entry travels on. Total: a malformed
 * list or entry is carried as-is, or as `null` when reading it throws, and the
 * assessment refuses it as malformed rather than this function guessing. No
 * value is converted, trimmed, lowered or re-typed here.
 */
export function snapshotGrantExerciseRequest(request: GrantExerciseRequest): GrantExerciseRequest {
  const { parameters, amount } = request;
  return {
    ...request,
    ...(amount !== undefined ? { amount: snapshotAmount(amount) } : {}),
    ...(parameters !== undefined ? { parameters: snapshotParameters(parameters) } : {}),
  };
}

function snapshotAmount(amount: GrantExerciseAmount): GrantExerciseAmount {
  try {
    if (amount === null || typeof amount !== 'object') return amount;
    const { value, unit } = amount;
    return Object.freeze({ value, unit });
  } catch {
    return null as unknown as GrantExerciseAmount;
  }
}

function snapshotParameters(parameters: readonly GovernedParameter[]): readonly GovernedParameter[] {
  try {
    if (!Array.isArray(parameters)) return parameters;
    const length = parameters.length;
    const copy: GovernedParameter[] = [];
    for (let index = 0; index < length; index += 1) copy.push(snapshotParameter(parameters[index]));
    return Object.freeze(copy);
  } catch {
    return Object.freeze([null as unknown as GovernedParameter]);
  }
}

function snapshotParameter(parameter: unknown): GovernedParameter {
  try {
    if (parameter === null || typeof parameter !== 'object') return parameter as GovernedParameter;
    const source = parameter as Record<string, unknown>;
    return Object.freeze({ dimension: source['dimension'], type: source['type'], value: source['value'] }) as GovernedParameter;
  } catch {
    return null as unknown as GovernedParameter;
  }
}

/**
 * A stated parameter list: non-empty, every entry well formed, strictly
 * ascending by dimension — so two values for one dimension can never both be
 * "the" value an assessment compares.
 */
function isWellFormedExerciseParameters(parameters: readonly GovernedParameter[]): boolean {
  if (!Array.isArray(parameters) || parameters.length === 0) return false;
  return parameters.every(
    (parameter, index) => isWellFormedGovernedParameter(parameter) && (index === 0 || compareDimensionIds((parameters[index - 1] as GovernedParameter).dimension, parameter.dimension) < 0),
  );
}
