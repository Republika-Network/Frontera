/**
 * Lightning / BTC payment rail (PAY-06).
 *
 * > A payment already governed and granted by Frontera, translated into one
 * > logical Lightning payment for one verified BOLT11 invoice, initiated at
 * > most once, and mapped back onto the three-way execution outcome.
 *
 * A `PaymentRail` under the PAY-01 adapter boundary — composed through
 * `createPaymentRailExecutionAdapter`, never called any other way. Not
 * re-exported from the payment vertical's barrel or from any package
 * entrypoint. It imports nothing from the XRPL rail, and the XRPL rail
 * nothing from it. See `docs/payments/PAY-06-LIGHTNING-RAIL.md`.
 */
export { LIGHTNING_BTC_MAXIMUM_SCALE, LIGHTNING_MAXIMUM_MSAT, MSAT_PER_BTC, btcDecimalOfMsat, msatOfBolt11Amount, msatOfBtcDecimal, msatOfDecimalText } from './lightning-amount.js';
export {
  BOLT11_ABSOLUTE_MAXIMUM_LENGTH,
  BOLT11_DEFAULT_EXPIRY_SECONDS,
  BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY_DELTA,
  BOLT11_REFUSALS,
  BOLT11_SUPPORTED_REQUIRED_FEATURES,
  LIGHTNING_INVOICE_PREFIXES,
  LIGHTNING_NETWORKS,
  bolt11ExpiresAt,
  decodeBolt11Invoice,
} from './lightning-bolt11.js';
export type { Bolt11Decoding, Bolt11Invoice, Bolt11Refusal, LightningNetwork } from './lightning-bolt11.js';
export { concludeLightningPayment } from './lightning-classification.js';
export type { LightningExpectedPayment, LightningPaymentConclusion } from './lightning-classification.js';
export { LIGHTNING_RAIL_ID, LIGHTNING_RAIL_LIMITS, LightningRailConfigurationError, createLightningRailConfiguration, isLightningRailConfiguration, lightningFeeLimitMsat } from './lightning-config.js';
export type { LightningRailConfiguration, LightningRailConfigurationInput } from './lightning-config.js';
export { LIGHTNING_DESTINATION_KIND, isLightningPaymentHash, lightningDestinationOf, parseLightningDestination } from './lightning-destination.js';
export type { LightningDestination } from './lightning-destination.js';
export { createLightningInvoiceBook } from './lightning-invoice-source.js';
export type { LightningInvoiceSource } from './lightning-invoice-source.js';
export {
  LIGHTNING_PAYMENT_FAILURES,
  LightningSendNotAttemptedError,
  readLightningNodeInfo,
  readLightningNodeInvoiceView,
  readLightningPaymentObservation,
  readOnlyLightningNode,
} from './lightning-node-port.js';
export type { LightningNodeInfo, LightningNodeInvoiceView, LightningNodePort, LightningNodeReader, LightningPaymentFailure, LightningPaymentInstruction, LightningPaymentObservation } from './lightning-node-port.js';
export type { LightningPaymentInterlock, LightningPaymentReservation, LightningPaymentReservationInput } from './lightning-payment-interlock.js';
export { invoiceDigest, preimageCommitment, preimageMatchesPaymentHash } from './lightning-preimage.js';
export { LIGHTNING_FAILURE_DETAILS, LIGHTNING_RAIL_DETAILS } from './lightning-rail-details.js';
export type { LightningRailDetail } from './lightning-rail-details.js';
export { createLightningRail } from './lightning-rail.js';
export type { LightningRail, LightningRailLogger, LightningRailOptions, LightningRailReadiness } from './lightning-rail.js';
export { isLightningNodePublicKey } from './lightning-signature.js';
