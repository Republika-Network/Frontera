/**
 * Cryptographic authenticity for authority artifacts.
 *
 * See `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md`. The two things to
 * know from here: signing and verification are separate interfaces, and only
 * the signer ever touches private material — the durable store's read path is
 * handed a verifier, which can check authority it cannot mint.
 */
export {
  AUTHORITY_ARTIFACT_VERSION,
  AUTHORITY_SIGNING_DOMAINS,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  approvalStateSigningBytes,
  authoritySigningBytes,
  delegatedOfferCapabilitySigningBytes,
  decodeAuthoritySignatureBytes,
  grantSigningBytes,
  isSupportedAuthoritySignatureAlgorithm,
  isWellFormedAuthoritySignature,
  revocationSigningBytes,
  obligationDischargeStateSigningBytes,
  revocationStateSigningBytes,
} from './authority-signature.js';
export type { AuthorityArtifactKind, AuthoritySignature, AuthoritySignatureAlgorithm } from './authority-signature.js';

export {
  AUTHORITY_SIGNATURE_FAILURES,
  AUTHORITY_SIGNING_FAILURE_REASONS,
  AuthorityAuthenticityConfigurationError,
  AuthoritySigningUnavailableError,
  isRetryableAuthoritySigningFailure,
} from './errors.js';
export type { AuthoritySignatureFailure, AuthoritySigningFailureReason } from './errors.js';

export { authoritySignerCustody, bindStoreSignerCustody, registerAuthoritySignerCustody, storeSignerCustody } from './custody.js';
export type { AuthoritySignerCustody } from './custody.js';

export { authorityVerificationKeyFromPrivateKey, createSoftwareAuthorityArtifactSigner } from './signer.js';
export type { AuthorityArtifactSigner, SoftwareAuthorityArtifactSignerOptions } from './signer.js';

export { createAuthorityArtifactVerifier } from './verifier.js';
export type { AuthorityArtifactVerifier, AuthoritySignatureVerification, TrustedVerificationKey } from './verifier.js';

export {
  DELEGATED_OFFER_CAPABILITY_FORMAT,
  DELEGATED_OFFER_CAPABILITY_ISSUANCE_FAILURES,
  DELEGATED_OFFER_CAPABILITY_LIMITS,
  DELEGATED_OFFER_CAPABILITY_NETWORKS,
  DELEGATED_OFFER_CAPABILITY_OPERATION,
  DELEGATED_OFFER_GRANT_DIMENSIONS,
  assessDelegatedOfferCapabilityIssuance,
  isWellFormedDelegatedOfferCapability,
  parseDelegatedOfferCapability,
  serializeDelegatedOfferCapability,
} from './delegated-offer-capability.js';
export type {
  DelegatedOfferCapability,
  DelegatedOfferCapabilityIssuanceContext,
  DelegatedOfferCapabilityIssuanceFailure,
  DelegatedOfferCapabilityIssuanceRequest,
  DelegatedOfferCapabilityNetwork,
} from './delegated-offer-capability.js';

export {
  DELEGATED_OFFER_CAPABILITY_ISSUER_FAILURES,
  DelegatedOfferCapabilityError,
  createDelegatedOfferCapabilityIssuer,
  createDelegatedOfferCapabilityIssuerSlot,
} from './delegated-offer-capability-issuer.js';
export type {
  DelegatedOfferCapabilityIssuanceInput,
  DelegatedOfferCapabilityIssuer,
  DelegatedOfferCapabilityIssuerFailure,
  DelegatedOfferCapabilityIssuerOptions,
  DelegatedOfferCapabilityIssuerSlot,
  IssuedDelegatedOfferCapability,
  SignedGrantReader,
} from './delegated-offer-capability-issuer.js';

export {
  EXECUTION_CAPABILITY_EXECUTION_DERIVATION,
  EXECUTION_CAPABILITY_GRANT_REFERENCE_V2_DOMAIN,
  EXECUTION_CAPABILITY_ISSUANCE_FAILURES,
  ExecutionCapabilityPolicyError,
  assessExecutionCapabilityIssuance,
  createExecutionCapabilityIssuancePolicy,
  executionCapabilityGrantReferenceV2,
  executionIdForGrant,
  isExecutionCapabilityGrantReferenceNonce,
} from './execution-capability-issuance.js';
export type {
  ExecutionCapabilityAudienceRegistration,
  ExecutionCapabilityIssuanceAssessment,
  ExecutionCapabilityIssuanceContext,
  ExecutionCapabilityIssuanceFailure,
  ExecutionCapabilityIssuancePolicy,
  ExecutionCapabilityIssuanceRequest,
} from './execution-capability-issuance.js';
