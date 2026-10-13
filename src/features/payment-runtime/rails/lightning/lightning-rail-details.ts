import type { LightningPaymentFailure } from './lightning-node-port.js';

/**
 * The bounded detail tokens the Lightning rail reports (PAY-06). Each is a
 * PAY-01 `detail` — a token, never a node message, error string, route or
 * invoice field — so no vendor vocabulary reaches P11.
 */
export const LIGHTNING_RAIL_DETAILS = {
  // ── refused before anything was sent (not-completed) ──
  ASSET_UNSUPPORTED: 'lightning-asset-unsupported',
  AMOUNT_UNREPRESENTABLE: 'lightning-amount-unrepresentable',
  SOURCE_UNMAPPED: 'lightning-source-unmapped',
  DESTINATION_INVALID: 'lightning-destination-invalid',
  INVOICE_UNAVAILABLE: 'lightning-invoice-unavailable',
  INVOICE_INVALID: 'lightning-invoice-invalid',
  INVOICE_NETWORK_MISMATCH: 'lightning-invoice-network-mismatch',
  INVOICE_PAYEE_MISMATCH: 'lightning-invoice-payee-mismatch',
  INVOICE_PAYMENT_HASH_MISMATCH: 'lightning-invoice-payment-hash-mismatch',
  INVOICE_AMOUNTLESS: 'lightning-invoice-amountless',
  INVOICE_AMOUNT_MISMATCH: 'lightning-invoice-amount-mismatch',
  INVOICE_EXPIRED: 'lightning-invoice-expired',
  INVOICE_TIMESTAMP_IN_FUTURE: 'lightning-invoice-timestamp-in-future',
  INVOICE_CLTV_UNSUPPORTED: 'lightning-invoice-cltv-unsupported',
  NODE_UNAVAILABLE: 'lightning-node-unavailable',
  NODE_NETWORK_MISMATCH: 'lightning-node-network-mismatch',
  NODE_SELF_PAYMENT: 'lightning-node-self-payment',
  NODE_INVOICE_DISAGREEMENT: 'lightning-node-invoice-disagreement',
  INTERLOCK_UNAVAILABLE: 'lightning-interlock-unavailable',
  PAYMENT_HASH_RESERVED: 'lightning-payment-hash-reserved',
  SEND_NOT_ATTEMPTED: 'lightning-send-not-attempted',
  RAIL_ERROR_BEFORE_SEND: 'lightning-rail-error-before-send',
  // ── after the one send, or an earlier one (unconfirmed) ──
  EXECUTION_PREVIOUSLY_INITIATED: 'lightning-execution-previously-initiated',
  EXECUTION_INVOICE_CONFLICT: 'lightning-execution-invoice-conflict',
  PAYMENT_IN_FLIGHT: 'lightning-payment-in-flight',
  SEND_OUTCOME_UNKNOWN: 'lightning-send-outcome-unknown',
  NODE_ANSWER_UNREADABLE: 'lightning-node-answer-unreadable',
  NODE_ANSWER_INCONSISTENT: 'lightning-node-answer-inconsistent',
  PREIMAGE_MISMATCH: 'lightning-preimage-mismatch',
  DELIVERED_AMOUNT_MISMATCH: 'lightning-delivered-amount-mismatch',
  FEE_BOUND_VIOLATED: 'lightning-fee-bound-violated',
} as const;

export type LightningRailDetail = (typeof LIGHTNING_RAIL_DETAILS)[keyof typeof LIGHTNING_RAIL_DETAILS];

/** The definitive-failure detail of each neutral failure (not-completed `PROVIDER_REJECTED`). */
export const LIGHTNING_FAILURE_DETAILS: Readonly<Record<LightningPaymentFailure, string>> = Object.freeze({
  'no-route': 'lightning-no-route',
  timeout: 'lightning-routing-timeout',
  'incorrect-payment-details': 'lightning-incorrect-payment-details',
  'insufficient-balance': 'lightning-insufficient-balance',
  canceled: 'lightning-payment-canceled',
  error: 'lightning-payment-failed',
});
