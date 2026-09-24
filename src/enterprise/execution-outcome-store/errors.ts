/**
 * The execution outcome store's error taxonomy.
 *
 * None of these is an authorization outcome, and none may be read as one. On
 * the governed-action path every one of them resolves in the closed direction:
 * a preparation that cannot be proven written stops the attempt before the
 * claim and the adapter; a terminal observation that cannot be written leaves
 * the live result intact with `outcomeRecorded: false`; a record that cannot be
 * read or verified replays as "attempted, outcome not on record" — never as a
 * success, never as a failure, and never as a second invocation.
 *
 * Messages name the execution id and the condition, and nothing else: no SQL,
 * no file path, no driver text, no amount, no provider reference.
 */
export type ExecutionOutcomeStoreErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. */
  | 'EXECUTION_OUTCOME_STORE_UNAVAILABLE'
  /** The input is outside the closed contract: a malformed id, instant or amount, an impossible certainty combination, an unsafe reference, or an undeclared key. Nothing was written. */
  | 'EXECUTION_OUTCOME_INPUT_INVALID'
  /** A different fact is already recorded for this execution identity. The first stands; nothing was written. Never last-write-wins. */
  | 'EXECUTION_OUTCOME_CONFLICT'
  /** The call's organization is not the record's organization. Nothing was read or written. */
  | 'EXECUTION_OUTCOME_TENANT_VIOLATION'
  /** A terminal observation names an execution with no prepared attempt. Nothing was written. */
  | 'EXECUTION_OUTCOME_ATTEMPT_NOT_FOUND'
  /** A persisted record failed validation or integrity verification. Refused, never repaired, never replayed. */
  | 'EXECUTION_OUTCOME_CORRUPT';

export class ExecutionOutcomeStoreError extends Error {
  constructor(
    readonly code: ExecutionOutcomeStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionOutcomeStoreError';
  }
}

export function isExecutionOutcomeStoreError(error: unknown): error is ExecutionOutcomeStoreError {
  return error instanceof ExecutionOutcomeStoreError;
}
