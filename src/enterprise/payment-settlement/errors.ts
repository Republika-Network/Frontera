/**
 * PAY-05 — the payment settlement layer's store error taxonomy.
 *
 * None of these is an authorization outcome, and none is ever read as one.
 * Every one resolves in the closed direction: a settlement that cannot be
 * proven written is not settled; a record that cannot be read or verified is
 * never believed (never a receipt, never an obligation discharge, never a
 * refund basis); a refund reservation that cannot be proven written reserves
 * nothing and governs nothing.
 *
 * Messages name the identifier and the condition only — no SQL, no path, no
 * amount, no provider reference, no evidence.
 */
export type PaymentSettlementStoreErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema this runtime does not implement. */
  | 'PAYMENT_SETTLEMENT_STORE_UNAVAILABLE'
  /** The input is outside the closed contract. Nothing was written. */
  | 'PAYMENT_SETTLEMENT_INPUT_INVALID'
  /** A different fact is already recorded under this identity. The first stands; nothing was written. Never last-write-wins. */
  | 'PAYMENT_SETTLEMENT_CONFLICT'
  /** The call's organization is not the record's organization. Nothing was read or written. */
  | 'PAYMENT_SETTLEMENT_TENANT_VIOLATION'
  /** A persisted record failed validation or integrity verification. Refused, never repaired. */
  | 'PAYMENT_SETTLEMENT_CORRUPT';

export class PaymentSettlementStoreError extends Error {
  constructor(
    readonly code: PaymentSettlementStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentSettlementStoreError';
  }
}

export function isPaymentSettlementStoreError(error: unknown): error is PaymentSettlementStoreError {
  return error instanceof PaymentSettlementStoreError;
}
