/**
 * PAY-08 — the x402 composition edge: the one place the x402 protocol meets a
 * Frontera rail (Lightning, through `exact` on `lnbtc`). Embedder-composed,
 * like PAY-04's ingress and PAY-06's Lightning edge: no Host route, module,
 * configuration or package export. See
 * `docs/payments/PAY-08-X402-PROTOCOL-ADAPTER.md`.
 */
export {
  X402_LNBTC_ASSET,
  X402_LNBTC_ATOMIC_SCALE,
  X402_LNBTC_DEFAULT_CLOCK_SKEW_SECONDS,
  X402_LNBTC_HTTP_PROFILE,
  X402_LNBTC_NETWORKS,
  X402_LNBTC_SCHEME,
  X402_LNBTC_TRANSFER_METHOD,
  createX402LightningBinding,
  createX402LightningInvoiceVerifier,
  x402LightningBindingId,
  x402LightningHttpRequestHash,
} from './x402-lightning-binding.js';
export type { X402LightningBindingOptions, X402LightningInvoiceVerifier } from './x402-lightning-binding.js';
export { createX402LightningExecutionInvoices } from './x402-lightning-execution-invoices.js';
export type { X402GovernedRequestRecordReader, X402LightningExecutionInvoices, X402LightningExecutionInvoicesOptions } from './x402-lightning-execution-invoices.js';
export { X402PaymentSignature, X402_PAYMENT_SIGNATURE_REFUSALS, createX402PaymentSignatureBuilder, lightningNodeProofSource } from './x402-payment-signature.js';
export type { X402LightningProofSource, X402PaymentSignatureBuilderOptions, X402PaymentSignatureRefusal, X402PaymentSignatureRequest, X402PaymentSignatureResult } from './x402-payment-signature.js';
export { readX402PaymentResponseEvidence } from './x402-payment-response.js';
export type { X402PaymentResponseEvidence, X402PaymentResponseMismatch } from './x402-payment-response.js';
export { createX402Presentation } from './x402-presentation.js';
export type { X402Presentation } from './x402-presentation.js';
