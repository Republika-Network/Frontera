/**
 * Why an *already-authorized* action is not currently eligible to be exercised.
 *
 * A separate vocabulary, in a separate file, with a separate type — and the
 * separation is the whole point of the phase.
 *
 * `AOC_KERNEL_REASON_CODES` answers "what did the authority and policy layers
 * conclude?". These answer "given that they concluded it, may the action
 * proceed right now?". Those are different questions with different audiences,
 * and the ADR's rejected alternative — "letting a blocking obligation flip the
 * decision to denied" — is rejected precisely because collapsing them "erases
 * the audit-critical difference between 'policy said no' and 'condition
 * unmet'".
 *
 * Keeping them in one union would have made that collapse a typo away —
 * every function returning `AocKernelReasonCode` could have returned
 * `OBLIGATION_PENDING`, and `KernelEvaluationResult.reasonCodes` would have
 * accepted it. `AocKernelExerciseReasonCode` is structurally not an
 * `AocKernelReasonCode`, so the type system refuses the mistake rather than a
 * reviewer catching it. `obligation-adapter.ts` never writes to `reasonCodes`
 * at all, and `kernel-obligation-lifecycle.test.ts` asserts that no code from
 * this file ever appears there.
 *
 * Three codes, one per unsatisfying lifecycle state, and they send an operator
 * to three different places: obtain the discharge, get the one you have
 * confirmed by someone independent, or accept that the deadline has passed.
 *
 * There is deliberately no code for a refused verification. ADR §2 gives a
 * refused verification no state of its own — the obligation stays `discharged`
 * — so it reports as `OBLIGATION_DISCHARGE_UNVERIFIED`, which is exactly what
 * it is. An earlier revision carried `OBLIGATION_DISCHARGE_REJECTED` and
 * `OBLIGATION_DISCHARGE_CONFLICTED` for lifecycle states the architecture never
 * defined; both are gone with the states that produced them.
 */
export const AOC_KERNEL_EXERCISE_REASON_CODES = {
  /** A blocking obligation stands and nothing has been reported about it, or it has only been reported outstanding. Never means the action was denied. */
  OBLIGATION_PENDING: 'OBLIGATION_PENDING',
  /** A discharge was supplied and has not been successfully verified — reported by a self-reporting source, or verified against and not confirmed. ADR hard invariant 5: "a discharge that cannot be verified is not `verified`; the obligation remains `discharged`." */
  OBLIGATION_DISCHARGE_UNVERIFIED: 'OBLIGATION_DISCHARGE_UNVERIFIED',
  /** The obligation's declared deadline passed before it reached a satisfying terminal state. Derived from the clock at read time; no sweeper is load-bearing. */
  OBLIGATION_EXPIRED: 'OBLIGATION_EXPIRED',
} as const;

export type AocKernelExerciseReasonCode = (typeof AOC_KERNEL_EXERCISE_REASON_CODES)[keyof typeof AOC_KERNEL_EXERCISE_REASON_CODES];
