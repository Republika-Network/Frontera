export type PaymentBusinessOperationStoreErrorCode =
  /** The store cannot be opened, written or read, or its clock did not answer. */
  | 'PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE'
  /** Persisted state failed verification. Never repaired, never read as "absent". */
  | 'PAYMENT_BUSINESS_OPERATION_CORRUPT'
  /** The operation is on record with different business semantics. The first stands. */
  | 'PAYMENT_BUSINESS_OPERATION_CONFLICT'
  /** The challenge's identity is on record for another operation, or as a different challenge. */
  | 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT'
  /** The operation already holds the maximum number of challenges. */
  | 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL'
  /** A call outside exactly one organization scope. */
  | 'PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION'
  /** A record input outside the closed contract, or inconsistent with what it derives from. */
  | 'PAYMENT_BUSINESS_OPERATION_INPUT_INVALID';

export class PaymentBusinessOperationStoreError extends Error {
  readonly code: PaymentBusinessOperationStoreErrorCode;

  constructor(code: PaymentBusinessOperationStoreErrorCode, message: string) {
    super(message);
    this.name = 'PaymentBusinessOperationStoreError';
    this.code = code;
  }
}

export function isPaymentBusinessOperationStoreError(error: unknown): error is PaymentBusinessOperationStoreError {
  return error instanceof PaymentBusinessOperationStoreError;
}
