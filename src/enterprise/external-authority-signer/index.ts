/**
 * External authority-signer custody boundary (CORE-02).
 *
 * The enterprise composition edge — outside the Kernel and every governed
 * runtime — that lets a deployment sign its five authority artifacts through a
 * custody service outside this process, while verification stays local. See
 * `docs/architecture/ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md`.
 *
 * Vendor-neutral: no KMS/HSM SDK is imported anywhere in this module, and a
 * provider's resource identifiers, if any, stay opaque configuration at the
 * edge of a transport implementation.
 */
export {
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
  EXTERNAL_AUTHORITY_SIGNER_PATHS,
  EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
  externalSigningRequestBody,
  parseExternalSigningRequest,
} from './protocol.js';
export type { ExternalAuthoritySignerIdentity, ExternalAuthoritySignerOperation, ExternalAuthoritySigningRequest } from './protocol.js';

export { ExternalAuthoritySignerTransportError } from './transport.js';
export type { ExternalAuthoritySignerTransport } from './transport.js';

export {
  MINIMUM_EXTERNAL_SIGNER_CREDENTIAL_LENGTH,
  createHttpExternalAuthoritySignerTransport,
  externalSignerCredentialProblem,
  externalSignerEndpointProblem,
} from './http-transport.js';
export type { HttpExternalAuthoritySignerTransportOptions } from './http-transport.js';

export {
  MAXIMUM_EXTERNAL_SIGNER_ATTEMPTS,
  MAXIMUM_EXTERNAL_SIGNER_TIMEOUT_MS,
  establishExternalAuthorityArtifactSigner,
  isExternalAuthorityArtifactSigner,
} from './external-signer.js';
export type {
  ExternalAuthorityArtifactSigner,
  ExternalAuthorityArtifactSignerOptions,
  ExternalAuthoritySignerMonitor,
  ExternalAuthoritySignerOperationCounters,
  ExternalAuthoritySignerStatus,
  PinnedAuthoritySignerIdentity,
} from './external-signer.js';
