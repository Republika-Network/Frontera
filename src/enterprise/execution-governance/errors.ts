/**
 * The Authority-Controlled Execution composition's error taxonomy, parallel in
 * shape to `AccessGovernanceErrorCode` and `GovernanceStoreErrorCode`.
 *
 * Every code here is a **wiring** defect — a host composed something that
 * cannot work — and not a governance outcome. A grant that may not be issued
 * and an action that may not be exercised are reported as outcomes with their
 * own reason codes, never as errors: `ADR-AUTHORITY-CONTROL-LAYERING.md` §4
 * makes the Kernel the only decision producer, and an exception thrown from a
 * composition layer would be a second way for it to conclude something.
 *
 * They are thrown rather than returned for exactly the reason the repository
 * throws `GrantConfigurationError` at Kernel construction: a deployment whose
 * composition could never honour its own contract should fail where it is
 * composed, not in the middle of a payment.
 */
export type ExecutionGovernanceErrorCode =
  /** The Kernel handed to this composition is not grant-aware — `evaluate()` returned a result with no `grants` block, so `KernelGrantOptions` was never configured on it. Nothing can be issued from such a result, and guessing is not the closed direction. */
  | 'EXECUTION_KERNEL_NOT_GRANT_AWARE'
  /** The grant declaration this composition was given differs from the one the Kernel evaluates under. Two declarations means two deployment ceilings, and the grant would be contained by whichever one happened to be read. */
  | 'EXECUTION_GRANT_DECLARATION_MISMATCH'
  /** The host stated both a single execution adapter and an adapter routing table, or neither. Which provider an authorized action reaches is not a thing to resolve by precedence. */
  | 'EXECUTION_ADAPTER_COMPOSITION_INVALID'
  /** P7: the host composed `exerciseControls` without a policy, without an exercise-time authority-binding resolver, or with a ledger that does not implement the port. There is no default policy and no permissive stand-in. */
  | 'EXECUTION_EXERCISE_CONTROLS_INVALID';

export class ExecutionGovernanceError extends Error {
  constructor(
    readonly code: ExecutionGovernanceErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ExecutionGovernanceError';
  }
}

export function isExecutionGovernanceError(error: unknown): error is ExecutionGovernanceError {
  return error instanceof ExecutionGovernanceError;
}
