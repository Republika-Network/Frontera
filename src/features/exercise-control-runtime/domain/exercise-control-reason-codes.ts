/**
 * Why an aggregate / velocity exercise control prevented an execution from
 * proceeding.
 *
 * **A separate constant, in a separate module, with a separate type** from
 * every vocabulary that already exists, and the separation is load-bearing:
 *
 * | vocabulary | answers |
 * | --- | --- |
 * | `AOC_KERNEL_REASON_CODES` | what did the authority and policy layers conclude? |
 * | `AOC_KERNEL_EXERCISE_REASON_CODES` | is a condition on an authorized action met? |
 * | `GRANT_REASON_CODES` | may a bounded grant be *issued*, and does an issued one still stand? |
 * | `GRANT_EXERCISE_REASON_CODES` | is *this* grant sufficient for *this* attempted action at *this* instant? |
 * | `EXECUTION_FAILURE_REASONS` | what did the provider do when it was asked? |
 * | `EMERGENCY_CONTROL_REASON_CODES` | has an operator administratively stopped execution? |
 * | `EXERCISE_CONTROL_REASON_CODES` | does *repeated* use of a sufficient grant still fit the trusted aggregate limits, and does the authority it was issued under still stand exactly? |
 *
 * The last question is asked **after** the grant-exercise assessment has
 * already proven the single attempt is inside the grant. An exercise-control
 * refusal therefore never means "this grant does not cover this action" — that
 * is `GRANT_EXERCISE_*` — and it never means "policy said no" — that is the
 * Kernel's. It means the grant covered the attempt, and a separate, narrower,
 * trusted host control stopped the effect: `decision = ALLOW`,
 * `grant = VALID`, `assessment.usable = true`, `execution = WITHHELD`.
 *
 * **None of these is a decision.** An exercise control produces no `allowed`,
 * `denied`, `indeterminate` or `approval_required`, and it never revokes or
 * mutates a grant.
 */
export const EXERCISE_CONTROL_REASON_CODES = {
  /** The trusted host policy threw, returned something that is not an array of limits, returned more than the bounded number of limits, returned a duplicate `(limitId, scopeKey)`, or returned a limit outside the closed contract. Fail closed: no reservation, no adapter. */
  EXERCISE_CONTROL_POLICY_INVALID: 'EXERCISE_CONTROL_POLICY_INVALID',
  /** The exercise-control ledger could not be read or written, raised, answered outside its contract, or holds state that failed validation. An unreadable ledger is never an empty one. */
  EXERCISE_CONTROL_LEDGER_UNAVAILABLE: 'EXERCISE_CONTROL_LEDGER_UNAVAILABLE',
  /** Admitting this execution would take at least one applicable aggregate count, amount or rolling-velocity limit above its maximum. Every applicable limit is admitted together or none is. */
  EXERCISE_CONTROL_LIMIT_EXCEEDED: 'EXERCISE_CONTROL_LIMIT_EXCEEDED',
  /** An amount limit applies and the attempt states no amount. An amount limit cannot be proven satisfied by an absent quantity. */
  EXERCISE_CONTROL_AMOUNT_REQUIRED: 'EXERCISE_CONTROL_AMOUNT_REQUIRED',
  /** An amount limit applies and the attempt — or usage already recorded under the same limit bucket — is denominated in a different unit. Never converted. */
  EXERCISE_CONTROL_UNIT_MISMATCH: 'EXERCISE_CONTROL_UNIT_MISMATCH',
  /** This exact execution identity already holds a reservation for exactly this request, policy and binding provenance. An execution identity is one attempt; the adapter is not invoked again. */
  EXERCISE_CONTROL_EXECUTION_ALREADY_RESERVED: 'EXERCISE_CONTROL_EXECUTION_ALREADY_RESERVED',
  /** A reservation already exists for this execution identity under a different request, policy or binding provenance. Refused, never merged or repaired. */
  EXERCISE_CONTROL_RESERVATION_CONFLICT: 'EXERCISE_CONTROL_RESERVATION_CONFLICT',
  /** The grant carries no authority-binding provenance, or the trusted exercise-time resolver could not establish the current binding. Execution requires the binding to be revalidated, so an unverifiable one withholds. */
  EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE: 'EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE',
  /** The current authority binding is not byte-for-byte the binding the grant was issued under. Exact identity, not containment: a different reference, a shorter horizon or a changed justification all withhold. */
  EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED: 'EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED',
} as const;

export type ExerciseControlReasonCode = (typeof EXERCISE_CONTROL_REASON_CODES)[keyof typeof EXERCISE_CONTROL_REASON_CODES];

export const EXERCISE_CONTROL_REASON_CODE_VALUES: readonly ExerciseControlReasonCode[] = Object.values(EXERCISE_CONTROL_REASON_CODES);

export function isExerciseControlReasonCode(value: unknown): value is ExerciseControlReasonCode {
  return typeof value === 'string' && (EXERCISE_CONTROL_REASON_CODE_VALUES as readonly string[]).includes(value);
}
