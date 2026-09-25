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
  authoritySigningBytes,
  decodeAuthoritySignatureBytes,
  grantSigningBytes,
  isSupportedAuthoritySignatureAlgorithm,
  isWellFormedAuthoritySignature,
  revocationSigningBytes,
} from './authority-signature.js';
export type { AuthorityArtifactKind, AuthoritySignature, AuthoritySignatureAlgorithm } from './authority-signature.js';

export { AUTHORITY_SIGNATURE_FAILURES, AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError } from './errors.js';
export type { AuthoritySignatureFailure } from './errors.js';

export { authorityVerificationKeyFromPrivateKey, createSoftwareAuthorityArtifactSigner } from './signer.js';
export type { AuthorityArtifactSigner, SoftwareAuthorityArtifactSignerOptions } from './signer.js';

export { createAuthorityArtifactVerifier } from './verifier.js';
export type { AuthorityArtifactVerifier, AuthoritySignatureVerification, TrustedVerificationKey } from './verifier.js';
