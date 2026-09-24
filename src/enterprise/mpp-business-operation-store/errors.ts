/**
 * The MPP business-operation store's error taxonomy.
 *
 * None of these is an authorization outcome. On every path they resolve in
 * the closed direction: an operation that cannot be proven written never
 * reaches governance, and a record that cannot be read or verified is never
 * interpreted as "no previous operation".
 *
 * Messages name the operation or request and the condition, and nothing else.
 */
export type MppBusinessOperationStoreErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. */
  | 'MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE'
  /** The input is outside the closed contract. Nothing was written. */
  | 'MPP_BUSINESS_OPERATION_INPUT_INVALID'
  /** The business operation is already on record with different business semantics. The first stands; nothing was written. Never last-write-wins. */
  | 'MPP_BUSINESS_OPERATION_CONFLICT'
  /** The operation already holds the maximum number of distinct challenge instances. Nothing was written, nothing evicted. */
  | 'MPP_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL'
  /** The call's organization is not the record's organization. Nothing was read or written. */
  | 'MPP_BUSINESS_OPERATION_TENANT_VIOLATION'
  /** A persisted record failed validation or integrity verification. Refused, never repaired, never read as absent. */
  | 'MPP_BUSINESS_OPERATION_CORRUPT';

export class MppBusinessOperationStoreError extends Error {
  constructor(
    readonly code: MppBusinessOperationStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MppBusinessOperationStoreError';
  }
}

export function isMppBusinessOperationStoreError(error: unknown): error is MppBusinessOperationStoreError {
  return error instanceof MppBusinessOperationStoreError;
}
