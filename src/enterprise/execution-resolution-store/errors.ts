/**
 * The execution resolution store's error taxonomy.
 *
 * None of these is an authorization outcome, and none resolves an execution.
 * On every path they resolve in the closed direction: a binding that cannot be
 * proven written stops a governed execution before its claim and its provider;
 * a resolution that cannot be written leaves the execution unresolved and its
 * capacity consumed; a record that cannot be read or verified is never
 * replayed as an answer, never used to return capacity, and never overwritten.
 *
 * Messages name the execution id and the condition, and nothing else.
 */
export type ExecutionResolutionStoreErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. */
  | 'EXECUTION_RESOLUTION_STORE_UNAVAILABLE'
  /** The input is outside the closed contract. Nothing was written. */
  | 'EXECUTION_RESOLUTION_INPUT_INVALID'
  /** A different binding or a different definitive resolution is already recorded for this execution. The first stands. Never last-write-wins. */
  | 'EXECUTION_RESOLUTION_CONFLICT'
  /** The call's organization is not the record's organization. Nothing was read or written. */
  | 'EXECUTION_RESOLUTION_TENANT_VIOLATION'
  /** A resolution names no binding, or not the one on record. Only the bound authority may resolve. Nothing was written. */
  | 'EXECUTION_RESOLUTION_NOT_BOUND'
  /** A persisted record failed validation or integrity verification. Refused, never repaired. */
  | 'EXECUTION_RESOLUTION_CORRUPT';

export class ExecutionResolutionStoreError extends Error {
  constructor(
    readonly code: ExecutionResolutionStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionResolutionStoreError';
  }
}

export function isExecutionResolutionStoreError(error: unknown): error is ExecutionResolutionStoreError {
  return error instanceof ExecutionResolutionStoreError;
}
