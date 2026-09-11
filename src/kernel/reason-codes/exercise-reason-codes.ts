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
 * Five codes, and they send an operator to five different places: obtain the
 * approval, get it confirmed by someone independent, find out why it was
 * refused, obtain a fresh one, or reconcile two systems that disagree.
 */
export const AOC_KERNEL_EXERCISE_REASON_CODES = {
  /** A blocking obligation stands and nothing has been reported about it, or it has only been reported outstanding. Never means the action was denied. */
  OBLIGATION_PENDING: 'OBLIGATION_PENDING',
  /** A discharge was reported by a source this deployment classifies as self-reporting, and nothing independent has confirmed it. ADR hard invariant 5: "a discharge that cannot be verified is not `verified`." */
  OBLIGATION_DISCHARGE_UNVERIFIED: 'OBLIGATION_DISCHARGE_UNVERIFIED',
  /** An independent source refuted a reported discharge. Materially different from "nobody confirmed it", and kept apart from it for that reason. */
  OBLIGATION_DISCHARGE_REJECTED: 'OBLIGATION_DISCHARGE_REJECTED',
  /** The discharge window the deployment declared closed without a valid discharge inside it. Derived from the clock at read time; no sweeper is load-bearing. */
  OBLIGATION_EXPIRED: 'OBLIGATION_EXPIRED',
  /** Two admissible sources reported contradicting outcomes for one obligation. Never silently resolved to one side. */
  OBLIGATION_DISCHARGE_CONFLICTED: 'OBLIGATION_DISCHARGE_CONFLICTED',
} as const;

export type AocKernelExerciseReasonCode = (typeof AOC_KERNEL_EXERCISE_REASON_CODES)[keyof typeof AOC_KERNEL_EXERCISE_REASON_CODES];
