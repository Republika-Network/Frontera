/**
 * G-02C1C — the executor receipt contract (`frontera.executor-receipt.v1`) and
 * its standalone verifier. Verification only: nothing here holds or uses a
 * private key. The signer lives in the reference executor
 * (`reference-executor/receipt-signer.ts`). Since G-02C1D the Host's receipt
 * evidence module composes the verifier and the transport codec; neither is
 * re-exported from the Enterprise barrel.
 */
export {
  EXECUTOR_RECEIPT_BASES,
  EXECUTOR_RECEIPT_FORMAT,
  EXECUTOR_RECEIPT_ID_DOMAIN,
  EXECUTOR_RECEIPT_LEDGER_STATES,
  EXECUTOR_RECEIPT_LIMITS,
  EXECUTOR_RECEIPT_OBSERVATION_KIND,
  EXECUTOR_RECEIPT_OUTCOMES,
  EXECUTOR_RECEIPT_SIGNING_DOMAIN,
  executorReceiptDigest,
  executorReceiptId,
  executorReceiptSigningBytes,
  isWellFormedExecutorReceipt,
  parseExecutorReceipt,
  positionExecutorReceipt,
  serializeExecutorReceipt,
} from './receipt.js';
export type { ExecutorReceipt, ExecutorReceiptBasis, ExecutorReceiptDraft, ExecutorReceiptLedgerState, ExecutorReceiptObservation, ExecutorReceiptOutcome, ExecutorReceiptParseFailure } from './receipt.js';
export { ExecutorReceiptVerifierConfigurationError, createExecutorReceiptVerifier } from './verifier.js';
export type { ExecutorReceiptHistory, ExecutorReceiptVerification, ExecutorReceiptVerificationFailure, ExecutorReceiptVerifier, ExpectedExecutorReceipt, PresentedExecutorReceipt, TrustedExecutor } from './verifier.js';
export {
  EXECUTOR_RECEIPT_TRANSPORT_FAILURES,
  EXECUTOR_RECEIPT_TRANSPORT_FORMAT,
  EXECUTOR_RECEIPT_TRANSPORT_HEADER,
  EXECUTOR_RECEIPT_TRANSPORT_LIMITS,
  decodeExecutorReceiptTransport,
  encodeExecutorReceiptTransport,
} from './transport.js';
export type { ExecutorReceiptTransportDecoding, ExecutorReceiptTransportFailure } from './transport.js';
