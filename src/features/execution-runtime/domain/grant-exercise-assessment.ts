import {
  boundedGrantDigestMatches,
  compareGrantBound,
  grantBoundComparisonPermits,
  grantCorrelationMatches,
  type BoundedGrant,
  type GrantBound,
  type GrantCorrelation,
  type GrantRevocation,
} from '../../grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, type GrantExerciseReasonCode } from './exercise-reason-codes.js';
import { isWellFormedGrantExerciseRequest, type GrantExerciseRequest } from './grant-exercise-request.js';

/**
 * Whether a specific attempted action is covered by a specific trusted grant,
 * at a specific instant.
 *
 * This is the gate the phase exists to install. `assessGrantExercise` in the
 * grant runtime answers the narrower question "may this grant be exercised at
 * all right now?" — tamper, revocation, expiry — and deliberately stops there,
 * because layer E owns the artifact and not the attempt. This answers the
 * composed question the target lifecycle's `bounded grant → action` edge needs:
 * the three read-time facts **plus** whether the action being attempted is
 * inside what was granted.
 *
 * The two never disagree on the facts they share, and
 * `tests/execution-exercise.test.ts` asserts that against the grant runtime's
 * own function rather than trusting the restatement — a rule restated by hand
 * is a rule that can drift.
 *
 * ## Every check is deterministic and fail-closed
 *
 * No clock is read: the instant is passed in, exactly as
 * `assessGrantExercise` and `isObligationExpiredAt` take theirs. No store is
 * touched: the trusted grant and its revocation are read by the caller and
 * handed in by value. No randomness, no network, no provider. Two assessments
 * of the same world at the same instant are identical, and
 * `tests/execution-determinism.test.ts` measures that by repetition.
 *
 * ## Every failing reason is reported, not only the first
 *
 * A grant that is revoked, expired *and* being used for the wrong resource is
 * all three, and an operator asking "why can this not be used" deserves all
 * three answers. The order below is stable so the report is deterministic.
 *
 * ## Absence on either side is a refusal
 *
 * A grant that bounds an axis the attempt does not state, and an attempt that
 * states an axis the grant does not bound, are both refused. Neither direction
 * can be proven ⊆, and "unbounded, so anything goes" is precisely the reading
 * `attenuateGrantScope` refuses one layer up. Stating it once here keeps the
 * two layers on the same posture.
 */
export interface BoundedGrantExerciseAssessment {
  readonly usable: boolean;
  readonly reasonCodes: readonly GrantExerciseReasonCode[];
  /** The grant this was assessed against — the id from the request, echoed so an outcome is self-describing even when nothing was found. */
  readonly boundedGrantId: string;
  /** The authorization correlation the attempt claimed. Preserved whether or not it matched, because a mismatch is exactly the thing an auditor wants to see. */
  readonly correlation: GrantCorrelation;
  /** This attempt's own identity. */
  readonly executionId: string;
}

function usable(input: { readonly boundedGrantId: string; readonly correlation: GrantCorrelation; readonly executionId: string }): BoundedGrantExerciseAssessment {
  return { usable: true, reasonCodes: [], boundedGrantId: input.boundedGrantId, executionId: input.executionId, correlation: input.correlation };
}

function unusable(
  input: { readonly boundedGrantId: string; readonly correlation: GrantCorrelation; readonly executionId: string },
  reasonCodes: readonly GrantExerciseReasonCode[],
): BoundedGrantExerciseAssessment {
  return { usable: false, reasonCodes, boundedGrantId: input.boundedGrantId, executionId: input.executionId, correlation: input.correlation };
}

/**
 * Whether an attempted bound is inside a granted bound.
 *
 * Both sides must exist. `compareGrantBound` is total and answers
 * `incomparable` for a shape mismatch, an unparseable value or a differing
 * unit, and `grantBoundComparisonPermits` treats `incomparable` exactly as it
 * treats `broader` — the fail-closed pair the bound algebra was built around.
 */
function attemptIsWithin(granted: GrantBound | undefined, attempted: GrantBound | undefined): boolean {
  if (granted === undefined || attempted === undefined) return false;
  return grantBoundComparisonPermits(compareGrantBound(granted, attempted));
}

/**
 * The assessment, for a grant the caller has already read from the
 * authoritative store.
 *
 * Reading is the caller's job because the store is asynchronous and this
 * function must not be: a synchronous, total, pure assessment is what lets the
 * same logic run inside a commit boundary later without reintroducing the
 * interleaving `BoundedGrantStorePort.issue`'s synchronous `commitGuard`
 * exists to prevent.
 */
export function assessBoundedGrantExercise(input: {
  readonly grant: BoundedGrant;
  readonly revocation?: GrantRevocation;
  readonly request: GrantExerciseRequest;
  readonly at: string;
}): BoundedGrantExerciseAssessment {
  const { grant, request } = input;
  const identity = { boundedGrantId: request.boundedGrantId, correlation: request.correlation, executionId: request.executionId };

  // 0. The request itself. Refused before anything is compared, so a blank
  //    field can never be "matched" against another blank field.
  if (!isWellFormedGrantExerciseRequest(request)) {
    return unusable(identity, [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REQUEST_MALFORMED]);
  }

  const reasonCodes: GrantExerciseReasonCode[] = [];

  // 1. Integrity. A grant whose fields differ from the ones that were digested
  //    is refused, never repaired — and refused *first*, because every bound
  //    below is read off those same fields.
  if (!boundedGrantDigestMatches(grant)) reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_INTEGRITY_INVALID);

  // 2. Revocation. An immutable event held beside the grant; its presence is
  //    the whole of the check.
  if (input.revocation !== undefined) reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED);

  // 3. Expiry, from the passed-in instant. A malformed instant on either side
  //    makes the grant unusable rather than usable-forever — the same closed
  //    direction `assessGrantExercise` takes, for the same reason.
  const expiry = Date.parse(grant.expiresAt);
  const now = Date.parse(input.at);
  if (Number.isNaN(expiry) || Number.isNaN(now) || now >= expiry) reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED);

  // 4. The holder. No delegation at this layer, so a different subject is a
  //    different party and not a resolvable one.
  if (request.subject !== grant.subject) reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_SUBJECT_MISMATCH);

  // 5. The authorization this exercise claims to be under.
  if (!grantCorrelationMatches(grant.correlation, request.correlation)) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_CORRELATION_INVALID);
  }

  // 6-10. The attempt against the bounds, axis by axis, every axis reported.
  if (!attemptIsWithin(grant.scope.action, { kind: 'identity', value: request.action })) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE);
  }
  if (!attemptIsWithin(grant.scope.resources, { kind: 'set', values: [request.resource] })) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE);
  }
  if (!axisAgrees(grant.scope.counterparty, request.counterparty === undefined ? undefined : { kind: 'identity', value: request.counterparty })) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE);
  }
  if (!axisAgrees(grant.scope.organization, request.organization === undefined ? undefined : { kind: 'identity', value: request.organization })) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE);
  }
  if (!axisAgrees(grant.scope.amount, request.amount === undefined ? undefined : { kind: 'ceiling', limit: request.amount.value, unit: request.amount.unit })) {
    reasonCodes.push(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED);
  }

  return reasonCodes.length === 0 ? usable(identity) : unusable(identity, reasonCodes);
}

/**
 * An optional axis, in all four combinations.
 *
 * | grant bounds it | attempt states it | answer |
 * | --- | --- | --- |
 * | no | no | agrees — neither side is asserting anything about this axis |
 * | no | yes | refused — the attempt asserts an axis the authorization never bounded |
 * | yes | no | refused — the bound cannot be proven satisfied by an absent value |
 * | yes | yes | the bound algebra decides |
 *
 * The two middle rows are the ones that matter. A grant bounding `amount` and
 * an attempt stating none would otherwise execute an unbounded quantity under a
 * bounded permission; an attempt stating a counterparty the grant never bounded
 * would otherwise execute against a party nothing evaluated.
 */
function axisAgrees(granted: GrantBound | undefined, attempted: GrantBound | undefined): boolean {
  if (granted === undefined && attempted === undefined) return true;
  return attemptIsWithin(granted, attempted);
}
