/**
 * The XRPL rail's bounded `detail` tokens (PAY-02).
 *
 * Rail specifics travel as a `PaymentRailResult.detail` token beside one of
 * the execution runtime's existing `ExecutionFailureReason`s — never as new
 * core vocabulary. A validated ledger failure carries its own engine result
 * code (`tecPATH_DRY`, `tecNO_LINE`, …) instead, which is already a bounded
 * token; no table of engine codes is kept here.
 */
export const XRPL_RAIL_DETAILS = Object.freeze({
  // — refused before any contact with the ledger: definitive —
  ASSET_NOT_CONFIGURED: 'xrpl-asset-not-configured',
  SOURCE_NOT_MAPPED: 'xrpl-source-not-mapped',
  DESTINATION_INVALID: 'xrpl-destination-invalid',
  DESTINATION_IS_SOURCE: 'xrpl-destination-is-source',
  DESTINATION_IS_ISSUER: 'xrpl-destination-is-issuer',
  AMOUNT_NOT_REPRESENTABLE: 'xrpl-amount-not-representable',
  // — refused after reads, before any submission: definitive —
  NETWORK_UNAVAILABLE: 'xrpl-network-unavailable',
  NETWORK_MISMATCH: 'xrpl-network-mismatch',
  PREPARATION_FAILED: 'xrpl-preparation-failed',
  PREPARATION_INVALID: 'xrpl-preparation-invalid',
  FEE_CEILING_EXCEEDED: 'xrpl-fee-ceiling-exceeded',
  SIGNING_FAILED: 'xrpl-signing-failed',
  SIGNATURE_MISMATCH: 'xrpl-signature-mismatch',
  SUBMISSION_NOT_ATTEMPTED: 'xrpl-submission-not-attempted',
  RAIL_ERROR_BEFORE_SUBMISSION: 'xrpl-rail-error-before-submission',
  // — after submission, provably not included: definitive —
  TRANSACTION_EXPIRED: 'xrpl-transaction-expired',
  // — after submission, outcome unknown: unconfirmed, P12 —
  SUBMISSION_OUTCOME_UNKNOWN: 'xrpl-submission-outcome-unknown',
  SUBMISSION_RESPONSE_UNREADABLE: 'xrpl-submission-response-unreadable',
  FINALITY_UNKNOWN: 'xrpl-finality-unknown',
  DELIVERED_AMOUNT_MISMATCH: 'xrpl-delivered-amount-mismatch',
  RESULT_UNRECOGNIZED: 'xrpl-result-unrecognized',
  RAIL_ERROR_AFTER_SUBMISSION: 'xrpl-rail-error-after-submission',
} as const);

export type XrplRailDetail = (typeof XRPL_RAIL_DETAILS)[keyof typeof XRPL_RAIL_DETAILS];
