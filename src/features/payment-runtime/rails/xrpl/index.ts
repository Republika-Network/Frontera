/**
 * XRPL / RLUSD payment rail (PAY-02).
 *
 * > A payment already governed and granted by Frontera, translated into one
 * > XRPL issued-currency Payment, submitted at most once, and mapped back
 * > onto the three-way execution outcome.
 *
 * A `PaymentRail` under the PAY-01 adapter boundary — composed through
 * `createPaymentRailExecutionAdapter`, never called any other way. Not
 * re-exported from the payment vertical's barrel or from any package
 * entrypoint. See `docs/payments/XRPL_RLUSD_RAIL.md`.
 */
export { XRPL_DESTINATION_KINDS, isXrplClassicAddress, parseXrplDestination } from './xrpl-address.js';
export type { XrplDestination } from './xrpl-address.js';
export { XRPL_ISSUED_VALUE_LIMITS, canonicalDecimalOfLedgerValue, xrplIssuedValueOf } from './xrpl-amount.js';
export { isXrplTransactionHash, signedPaymentMatches } from './xrpl-codec.js';
export { XRPL_NETWORK_IDS, XRPL_RAIL_LIMITS, XRPL_RLUSD_RAIL_ID, XrplRailConfigurationError, createXrplRlusdRailConfiguration, isXrplCurrencyCode } from './xrpl-config.js';
export type { XrplNetwork, XrplRlusdRailConfiguration, XrplRlusdRailConfigurationInput } from './xrpl-config.js';
export { XrplSubmissionNotAttemptedError } from './xrpl-client-port.js';
export type { XrplClientPort, XrplPaymentTransaction, XrplPreparedPayment, XrplTransactionSigner } from './xrpl-client-port.js';
export { buildXrplPayment } from './xrpl-payment-builder.js';
export type { XrplPaymentBuild } from './xrpl-payment-builder.js';
export { XRPL_RAIL_DETAILS } from './xrpl-rail-details.js';
export type { XrplRailDetail } from './xrpl-rail-details.js';
export { readAutofill, readLedgerIndex, readLookup, readNetworkId, readSubmission } from './xrpl-result-normalizer.js';
export type { XrplExpectedPayment, XrplLookupReading, XrplSubmissionReading } from './xrpl-result-normalizer.js';
export { createXrplRlusdRail } from './xrpl-rlusd-rail.js';
export type { XrplRailLogger, XrplRailReadiness, XrplRlusdRail, XrplRlusdRailOptions } from './xrpl-rlusd-rail.js';
export { createXrplSdkClient } from './xrpl-sdk-client.js';
