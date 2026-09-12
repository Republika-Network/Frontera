/**
 * Why a grant was not issued, or why an issued grant may not be exercised.
 *
 * **A separate constant, in a separate file, with a separate type** from
 * `AOC_KERNEL_REASON_CODES` (authorization) and
 * `AOC_KERNEL_EXERCISE_REASON_CODES` (obligations) — the discipline
 * `exercise-reason-codes.ts` established one layer down, and for the same
 * measured reason: keeping three vocabularies in one union would make the
 * collapse three ADRs exist to prevent a typo away.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 is what these protect.
 * "Grant issuance failed" is **never** encoded as a policy denial, and a
 * denied decision is never re-labelled as a grant failure. A result reading
 * `status: 'allowed'` with `grants.eligibility: 'ineligible'` and
 * `GRANT_OBLIGATIONS_UNSATISFIED` is the normal, intended combination — the
 * policy said yes, conditionally, and the condition is not met yet.
 *
 * `structural-boundaries` tests assert the three vocabularies do not overlap.
 */
export const GRANT_REASON_CODES = {
  /** The authorizing layers did not conclude that this action may proceed. Layer E never re-derives that; it reads it and stops. */
  GRANT_AUTHORIZATION_NOT_PERMITTED: 'GRANT_AUTHORIZATION_NOT_PERMITTED',
  /** A blocking obligation stands. ADR §3 and hard invariant 4: this blocks issuance and never rewrites the decision. */
  GRANT_OBLIGATIONS_UNSATISFIED: 'GRANT_OBLIGATIONS_UNSATISFIED',
  /** The source authorization does not state every bound this deployment requires before any grant may be derived from it. Fail-closed: an unbounded grant is never the fallback. */
  GRANT_SOURCE_BOUNDS_INCOMPLETE: 'GRANT_SOURCE_BOUNDS_INCOMPLETE',
  /** A requested bound is broader than the source bound it claims to derive from. The settling invariant, refused. */
  GRANT_SCOPE_BROADENING: 'GRANT_SCOPE_BROADENING',
  /** A requested bound cannot be compared to its source — a different shape, a different unit, an unparseable instant, or an axis the source never bounded. Refused, never assumed. */
  GRANT_BOUND_INCOMPARABLE: 'GRANT_BOUND_INCOMPARABLE',
  /** The holder named for the grant is not the subject the authorization was evaluated for. There is no delegation at this layer; see `bounded-grant.ts`. */
  GRANT_SUBJECT_INVALID: 'GRANT_SUBJECT_INVALID',
  /** The issuance names a request, decision or action the source authorization does not. ADR §4's "a grant citing a decision for a different resource", refused. */
  GRANT_CORRELATION_INVALID: 'GRANT_CORRELATION_INVALID',
  /** The grant would carry no usable validity window, or one that is malformed. */
  GRANT_VALIDITY_INVALID: 'GRANT_VALIDITY_INVALID',
  /** The conditions that made issuance eligible no longer held when the authoritative transaction committed. The TOCTOU refusal. */
  GRANT_ELIGIBILITY_CHANGED: 'GRANT_ELIGIBILITY_CHANGED',
  /** A grant with this identity already stands. Reported, never overwritten. */
  GRANT_ALREADY_ISSUED: 'GRANT_ALREADY_ISSUED',
  /** Read at or after its `expiresAt`. ADR §6: derived from the clock at read time, never from a sweeper having run. */
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  /** A revocation stands against it. The historical authorization is untouched. */
  GRANT_REVOKED: 'GRANT_REVOKED',
  /** No grant with that identity is held by the authoritative store. */
  GRANT_NOT_FOUND: 'GRANT_NOT_FOUND',
} as const;

export type GrantReasonCode = (typeof GRANT_REASON_CODES)[keyof typeof GRANT_REASON_CODES];

export const GRANT_REASON_CODE_VALUES: readonly GrantReasonCode[] = Object.values(GRANT_REASON_CODES);
