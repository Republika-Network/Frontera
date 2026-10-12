/**
 * PAY-04 — payment protocol ingress: the protocol-neutral composition edge
 * that turns a payment protocol challenge into one ordinary governed payment.
 *
 * Like the PAY-03 rail composition, this directory is a composition edge of
 * the payment vertical; nothing else in the enterprise layer imports it, and
 * it names no protocol and no rail. Protocol adapters live in
 * `src/features/payment-runtime/protocols/` and are handed in by the embedder.
 * See `docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md`.
 */
export {
  PAYMENT_BUSINESS_OPERATION_KEY_PREFIX,
  computePaymentBusinessSemanticDigest,
  computePaymentChallengeDigest,
  computePaymentChallengeIdentity,
  derivePaymentBusinessOperationKey,
  derivePaymentBusinessOperationRequestId,
} from './business-operation.js';
export type { PaymentBusinessOperationScope, PaymentBusinessTerms, PaymentChallengeEvidence } from './business-operation.js';
export { PAYMENT_PROTOCOL_INGRESS_REFUSALS } from './contracts.js';
export type {
  PaymentProtocolContextReader,
  PaymentProtocolIngress,
  PaymentProtocolIngressRefusal,
  PaymentProtocolIngressRequest,
  PaymentProtocolIngressResult,
  VerifiedPaymentProtocolContext,
} from './contracts.js';
export { createPaymentProtocolContextReader } from './context-reader.js';
export { PaymentProtocolIngressConfigurationError, createPaymentProtocolIngress } from './service.js';
export type { PaymentProtocolIngressOptions } from './service.js';
export { PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, PAYMENT_CHALLENGES_PER_OPERATION_MAX } from './store-contracts.js';
export type {
  PaymentBusinessOperationAccessContext,
  PaymentBusinessOperationInput,
  PaymentBusinessOperationReader,
  PaymentBusinessOperationRecord,
  PaymentBusinessOperationState,
  PaymentBusinessOperationStore,
  PaymentBusinessOperationStoreHealth,
  PaymentBusinessOperationWriter,
  PaymentChallengeInput,
  PaymentChallengeRecord,
  PaymentGovernedRequestReader,
  PaymentGovernedRequestState,
  RecordPaymentChallengeInput,
  RecordPaymentChallengeResult,
} from './store-contracts.js';
export { PaymentBusinessOperationStoreError, isPaymentBusinessOperationStoreError } from './store-errors.js';
export type { PaymentBusinessOperationStoreErrorCode } from './store-errors.js';
export { createInMemoryPaymentBusinessOperationStore } from './in-memory-payment-business-operation-store.js';
export type { CreateInMemoryPaymentBusinessOperationStoreOptions } from './in-memory-payment-business-operation-store.js';
export { createSqlitePaymentBusinessOperationStore } from './sqlite-payment-business-operation-store.js';
export type { CreateSqlitePaymentBusinessOperationStoreOptions, DurablePaymentBusinessOperationStore } from './sqlite-payment-business-operation-store.js';
