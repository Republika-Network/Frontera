/**
 * Why an operational emergency control prevented an execution from proceeding.
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
 * | `EMERGENCY_CONTROL_REASON_CODES` | has an operator administratively stopped execution, and can that be established at all? |
 *
 * **None of these is a decision.** An emergency control never produces
 * `allowed`, `denied`, `indeterminate` or `approval_required`; the Kernel
 * remains the only decision producer, and a stop leaves the decision it was
 * evaluated under exactly as the Kernel produced it. It never revokes a grant
 * either: `decision = ALLOW`, `grant = VALID`, `execution = WITHHELD` is the
 * normal, intended combination while a stop is active, and everything about it
 * is reversible by clearing the control.
 *
 * The vocabulary is deliberately two codes. A stop is either established as
 * active, or its state could not be established — and both withhold.
 */
export const EMERGENCY_CONTROL_REASON_CODES = {
  /** An applicable emergency control is active. Execution is withheld; nothing was revoked and no decision was rewritten. */
  EMERGENCY_CONTROL_ACTIVE: 'EMERGENCY_CONTROL_ACTIVE',
  /**
   * The current emergency-control state could not be established — the reader
   * raised, the store is closed, the persisted state failed validation, or the
   * query itself was not well formed.
   *
   * Reported, never assumed away. "The stop could not be read" and "no stop is
   * active" are different facts, and treating the first as the second is the
   * one direction an operational interlock must never take.
   */
  EMERGENCY_CONTROL_UNAVAILABLE: 'EMERGENCY_CONTROL_UNAVAILABLE',
} as const;

export type EmergencyControlReasonCode = (typeof EMERGENCY_CONTROL_REASON_CODES)[keyof typeof EMERGENCY_CONTROL_REASON_CODES];

export const EMERGENCY_CONTROL_REASON_CODE_VALUES: readonly EmergencyControlReasonCode[] = Object.values(EMERGENCY_CONTROL_REASON_CODES);
