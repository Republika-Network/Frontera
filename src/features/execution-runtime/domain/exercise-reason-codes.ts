/**
 * Why a presented bounded grant may not be exercised for a specific attempted
 * action, right now.
 *
 * **A separate constant, in a separate file, with a separate type** from all
 * three vocabularies that already exist, and the separation is the point:
 *
 * | vocabulary | answers |
 * | --- | --- |
 * | `AOC_KERNEL_REASON_CODES` | what did the authority and policy layers conclude? |
 * | `AOC_KERNEL_EXERCISE_REASON_CODES` | is a condition on an authorized action met? |
 * | `GRANT_REASON_CODES` | may a bounded grant be *issued*, and does an issued one still stand? |
 * | `GRANT_EXERCISE_REASON_CODES` | is *this* grant sufficient for *this* attempted action at *this* instant? |
 *
 * Keeping the last two in one union would collapse the distinction issuance and
 * exercise exist to keep. "This grant could not be issued" and "this grant
 * cannot cover this action" send an operator to different places: the first is
 * a defect in what was asked for at issuance, the second is an attempt outside
 * what was issued. `tests/execution-layer-boundaries.test.ts` asserts the four
 * vocabularies are pairwise disjoint, and that every code here carries the
 * `GRANT_EXERCISE_` prefix so a new one cannot be added into an overlap.
 *
 * **None of these is ever a policy denial.** An exercise refusal leaves the
 * authorization decision exactly as the Kernel produced it —
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3's whole argument, applied
 * one step further down: `decision = ALLOW`, `exercise = BLOCKED`,
 * `executor = NOT CALLED` is the normal, intended combination for a grant that
 * has expired or been revoked, and it rewrites nothing.
 */
export const GRANT_EXERCISE_REASON_CODES = {
  /** The exercise request itself is not well formed — a blank subject, a blank action, a blank resource, an unparseable instant, a malformed amount. Refused before anything is compared, so an empty string can never match an empty string into permission. */
  GRANT_EXERCISE_REQUEST_MALFORMED: 'GRANT_EXERCISE_REQUEST_MALFORMED',
  /** The authoritative store holds no grant with that identity. Includes the case where a caller presented a reference to a grant that never existed, and the case where an in-memory store lost it across a restart. Closed in both. */
  GRANT_EXERCISE_NOT_FOUND: 'GRANT_EXERCISE_NOT_FOUND',
  /** The trusted grant's recorded digest no longer matches its fields. Refused at read time, never repaired — `bounded-grant.ts`, "Integrity and canonicalization". */
  GRANT_EXERCISE_INTEGRITY_INVALID: 'GRANT_EXERCISE_INTEGRITY_INVALID',
  /** Read at or after its own `expiresAt`, against the injected instant. ADR §6: derived from the clock at read time, never from a sweeper having run. */
  GRANT_EXERCISE_EXPIRED: 'GRANT_EXERCISE_EXPIRED',
  /** A revocation stands against it. The historical authorization is untouched. */
  GRANT_EXERCISE_REVOKED: 'GRANT_EXERCISE_REVOKED',
  /** The party attempting the action is not the grant's holder. There is no delegation at this layer, so a different subject is refused rather than resolved. */
  GRANT_EXERCISE_SUBJECT_MISMATCH: 'GRANT_EXERCISE_SUBJECT_MISMATCH',
  /** The exercise names a request or decision the trusted grant does not. Exact on all four correlation fields — a partial match is a mismatch. */
  GRANT_EXERCISE_CORRELATION_INVALID: 'GRANT_EXERCISE_CORRELATION_INVALID',
  /** The attempted action is not the action the grant bounds. */
  GRANT_EXERCISE_ACTION_OUT_OF_SCOPE: 'GRANT_EXERCISE_ACTION_OUT_OF_SCOPE',
  /** The attempted resource is not inside the grant's resource set. */
  GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE: 'GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE',
  /** The attempted counterparty is not the counterparty the grant bounds — or the grant bounds one and the attempt states none, or the attempt states one and the grant bounds none. All three are refusals: containment cannot be proven against a bound that is absent on either side. */
  GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE: 'GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE',
  /** The attempted tenant is not the tenant the grant bounds, under the same three-way rule. */
  GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE: 'GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE',
  /** The attempted amount is above the grant's ceiling, denominated in a different unit, or absent where the grant states a ceiling. Never converted between units — a conversion table is a place for a rate to be wrong, and a wrong rate here widens authority. */
  GRANT_EXERCISE_AMOUNT_EXCEEDED: 'GRANT_EXERCISE_AMOUNT_EXCEEDED',
} as const;

export type GrantExerciseReasonCode = (typeof GRANT_EXERCISE_REASON_CODES)[keyof typeof GRANT_EXERCISE_REASON_CODES];

export const GRANT_EXERCISE_REASON_CODE_VALUES: readonly GrantExerciseReasonCode[] = Object.values(GRANT_EXERCISE_REASON_CODES);
