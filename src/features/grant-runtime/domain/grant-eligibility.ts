import { GRANT_REASON_CODES, type GrantReasonCode } from './grant-reason-codes.js';
import { isDerivableGrantSource, missingMandatoryGrantBounds, type GrantSourceAuthorization } from './grant-source-authorization.js';

/**
 * Whether an authorization is one a bounded grant may be derived from at all.
 *
 * **This is not a decision, and it never becomes one.** The vocabulary is
 * deliberately `eligible`/`ineligible` rather than anything readable as
 * allow/deny, for the reason
 * `ObligationEvaluation.exerciseEligibility` is `eligible`/`blocked`:
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 protects the difference
 * between "policy said no" and "policy said yes and the grant was withheld",
 * and a third vocabulary that could be mistaken for the first would undo it.
 *
 * The two combinations the ADR cares most about, stated as this module produces
 * them:
 *
 * ```
 * authorization permits exercise, obligation pending
 *   -> authorization unchanged, eligibility INELIGIBLE, no grant
 * authorization does not permit, every obligation satisfied
 *   -> authorization unchanged, eligibility INELIGIBLE, no grant
 * ```
 *
 * Neither rewrites the decision, and nothing in this file can: it receives a
 * `GrantSourceAuthorization`, which carries no status to rewrite.
 */
export type GrantEligibility = 'eligible' | 'ineligible';

export interface GrantEligibilityAssessment {
  readonly eligibility: GrantEligibility;
  /** Why not, in canonical order. Empty when eligible. Never an authorization reason code — a structurally separate vocabulary; see `grant-reason-codes.ts`. */
  readonly reasonCodes: readonly GrantReasonCode[];
}

const ELIGIBLE: GrantEligibilityAssessment = { eligibility: 'eligible', reasonCodes: [] };

/**
 * The three conditions `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4 puts
 * ahead of issuance, evaluated together so a caller learns every one it fails
 * rather than only the first.
 *
 * 1. the authorization permitted exercise (§4.2, hard invariant 3);
 * 2. every blocking obligation is satisfied (§4.2, §3, hard invariant 4);
 * 3. there is enough deterministic, well-shaped source scope to prove ⊆
 *    against (§4.4, §4.5) — without it there is no bound to attenuate from,
 *    and an unbounded grant is never the fallback.
 *
 * Pure, total and deterministic: no clock, no store, no randomness. The same
 * source authorization always assesses identically, which is what lets
 * `evaluate()` report eligibility without mutating anything.
 */
export function assessGrantEligibility(source: GrantSourceAuthorization): GrantEligibilityAssessment {
  const reasonCodes: GrantReasonCode[] = [];

  if (!source.authorizationPermitsExercise) reasonCodes.push(GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED);
  if (!source.allBlockingObligationsSatisfied) reasonCodes.push(GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED);
  if (!isDerivableGrantSource(source)) reasonCodes.push(GRANT_REASON_CODES.GRANT_SOURCE_BOUNDS_INCOMPLETE);

  return reasonCodes.length === 0 ? ELIGIBLE : { eligibility: 'ineligible', reasonCodes };
}

/** Which mandatory bounds the source is missing — reported so "why is this ineligible" is answerable without re-running anything. */
export function unstatedMandatoryBounds(source: GrantSourceAuthorization): readonly string[] {
  return missingMandatoryGrantBounds(source);
}
