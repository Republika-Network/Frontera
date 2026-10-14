/**
 * TRADE-04B — the protected delegated OfferCreate signer edge: the closed
 * `frontera.xrpl-delegated-offer-signer.v1` protocol, Host-side verification of
 * a delegated signature, the signer's HTTP transport (NO_BYPASS EP-073) and
 * the Host-side client with its typed `DelegatedOfferSigningPort`.
 *
 * Composed nowhere yet: no Host module, route, configuration or package export
 * reaches it, and it submits nothing. TRADE-04C composes the port below the
 * bounded grant. The reference signer (`reference/`) is a separate process and
 * is deliberately not exported here.
 */
export {
  DELEGATED_OFFER_ALLOWED_FLAGS,
  DELEGATED_OFFER_OPTIONAL_FIELDS,
  DELEGATED_OFFER_REQUIRED_FIELDS,
  DELEGATED_OFFER_SIGNATURE_FIELDS,
  DELEGATED_OFFER_SIGNER_MAXIMUM_PAIRS,
  DELEGATED_OFFER_SIGNER_OPERATION,
  DELEGATED_OFFER_SIGNER_PATHS,
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  delegatedOfferPairKey,
  isDelegatedOfferAccount,
  isDelegatedOfferRequestId,
  isDelegatedOfferSignerId,
  parseDelegatedOfferAuditReference,
  parseDelegatedOfferSignerIdentity,
  parseDelegatedOfferSignerPair,
  parseDelegatedOfferSigningRequest,
  parseDelegatedOfferSigningResponse,
  parsePreparedDelegatedOffer,
} from './delegated-offer-protocol.js';
export type {
  DelegatedOfferAmount,
  DelegatedOfferAuditReference,
  DelegatedOfferIssuedAmount,
  DelegatedOfferNetwork,
  DelegatedOfferSignerIdentity,
  DelegatedOfferSignerPair,
  DelegatedOfferSigningRequest,
  DelegatedOfferSigningResponse,
  DelegatedOfferXrpAmount,
  PreparedDelegatedOffer,
} from './delegated-offer-protocol.js';

export { DELEGATED_OFFER_VERIFICATION_FAILURES, verifySignedDelegatedOffer } from './delegated-offer-verification.js';
export type { DelegatedOfferVerification, DelegatedOfferVerificationFailure, DelegatedOfferVerificationInput, VerifiedDelegatedOfferBlob } from './delegated-offer-verification.js';

export {
  DELEGATED_OFFER_SIGNER_FAILURE_REASONS,
  DELEGATED_OFFER_SIGNER_TRANSPORT_LIMITS,
  DelegatedOfferSignerConfigurationError,
  DelegatedOfferSignerError,
  createHttpDelegatedOfferSignerTransport,
  delegatedOfferSignerEndpointProblem,
} from './delegated-offer-signer-transport.js';
export type { DelegatedOfferSignerFailureReason, DelegatedOfferSignerTransport } from './delegated-offer-signer-transport.js';

export { DELEGATED_OFFER_SIGNER_LIMITS, createDelegatedOfferSigner, validateDelegatedOfferSignerPin, validateDelegatedOfferSignerPins } from './delegated-offer-signer.js';
export type {
  DelegatedOfferSigner,
  DelegatedOfferSignerOptions,
  DelegatedOfferSignerPin,
  DelegatedOfferSignerState,
  DelegatedOfferSignerStatus,
  DelegatedOfferSigningInput,
  DelegatedOfferSigningPort,
  VerifiedDelegatedOfferSignature,
} from './delegated-offer-signer.js';
