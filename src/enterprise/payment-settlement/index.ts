/**
 * PAY-05 — Settlement, Receipt & Payment Obligation Semantics.
 *
 * > **"Settled" means funds finality with evidence — distinct from P11's
 * > provider confirmation, from P12's execution resolution, and from P7's
 * > capacity settlement.**
 *
 * The payment vertical's settlement layer, composed by an embedder beside the
 * governed-action orchestrator: explicit, read-only finality verification by a
 * trusted rail authority from a canonical P11 / P12 basis; one durable,
 * append-only settlement per execution; a deterministic, verifiable receipt;
 * settlement-backed payment-obligation discharge through CORE-04's own
 * recorder; and refunds as new governed payments within a CORE-07-anchored
 * refundable balance. Nothing here executes, signs, submits, retries, issues
 * authority or touches P7. Not exported from any package entrypoint. See
 * `docs/payments/PAY-05-SETTLEMENT-AND-RECEIPTS.md`.
 */
export {
  PAYMENT_RECEIPT_FORMAT,
  PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION,
  type PaymentReceipt,
  type PaymentReceiptDisclosureLevel,
  type PaymentSettlementAccessContext,
  type PaymentSettlementBasis,
  type PaymentSettlementFinality,
  type PaymentSettlementRecord,
  type PaymentSettlementStoreHealth,
  type RecordPaymentSettlementInput,
  type RecordPaymentSettlementResult,
} from './contracts.js';
export { PaymentSettlementStoreError, isPaymentSettlementStoreError, type PaymentSettlementStoreErrorCode } from './errors.js';
export {
  derivePaymentReceipt,
  disclosePaymentReceipt,
  paymentFinalityProofDigest,
  paymentReceiptId,
  paymentSettlementId,
  verifyPaymentReceipt,
  type PaymentReceiptVerification,
} from './integrity.js';
export type { PaymentSettlementReader, PaymentSettlementStore, PaymentSettlementWriter } from './settlement-store.js';
export { createInMemoryPaymentSettlementStore, type InMemoryPaymentSettlementStoreOptions } from './in-memory-payment-settlement-store.js';
export { createSqlitePaymentSettlementStore, type CreateSqlitePaymentSettlementStoreOptions, type DurablePaymentSettlementStore } from './sqlite-payment-settlement-store.js';
export { readPaymentSettlementBasis, type CanonicalSettlementBasis, type PaymentSettlementBasisReading, type PaymentSettlementBasisSources, type PaymentSettlementGovernanceReader } from './basis.js';
export {
  PaymentSettlementConfigurationError,
  createPaymentSettlementService,
  type PaymentFinalityAuthoritySelector,
  type PaymentSettlementRequest,
  type PaymentSettlementService,
  type PaymentSettlementServiceOptions,
  type PaymentSettlementStatus,
  type PaymentSettlementVerification,
} from './service.js';
export {
  createPaymentObligationDischarger,
  paymentObligationReference,
  type PaymentObligationDischargeReader,
  type PaymentObligationDischargeRequest,
  type PaymentObligationDischargeResult,
  type PaymentObligationDischarger,
  type PaymentObligationDischargerOptions,
  type PaymentObligationExpectation,
  type PaymentObligationQuery,
  type PaymentObligationRegistry,
} from './obligation-bridge.js';
export {
  PAYMENT_REFUND_LEDGER_SCHEMA_VERSION,
  PAYMENT_REFUND_RELEASE_BASES,
  PAYMENT_REFUND_STATE_KIND,
  createInMemoryPaymentRefundLedger,
  paymentRefundGovernedKey,
  paymentRefundOperationId,
  type PaymentRefundBalance,
  type PaymentRefundLedger,
  type PaymentRefundReleaseBasis,
  type PaymentRefundReservation,
  type ReservePaymentRefundInput,
  type ReservePaymentRefundResult,
} from './refund-ledger.js';
export { createSqlitePaymentRefundLedger, type CreateSqlitePaymentRefundLedgerOptions, type DurablePaymentRefundLedger } from './sqlite-payment-refund-ledger.js';
export {
  createPaymentRefundService,
  type PaymentRefundCounterparty,
  type PaymentRefundCounterpartyResolver,
  type PaymentRefundReconciliation,
  type PaymentRefundRequest,
  type PaymentRefundRequestResult,
  type PaymentRefundService,
  type PaymentRefundServiceOptions,
} from './refund-service.js';
