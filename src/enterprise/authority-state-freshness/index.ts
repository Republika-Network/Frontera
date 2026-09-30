/**
 * Authority-state freshness & rollback detection (CORE-07).
 *
 * The enterprise composition edge — outside the Kernel, payment code and the
 * external signer — that anchors each authenticated authority store's signed
 * head at an external witness outside the store's restore domain, so a
 * restored earlier authentic state is refused across restarts. See
 * `docs/architecture/ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md`.
 *
 * Vendor-neutral: no ledger, timestamping or blockchain SDK is imported
 * anywhere in this module. A deployment may put any of them behind a server
 * that speaks `frontera.authority-state-witness.v1`.
 */
export {
  AUTHORITY_STATE_CHECKPOINT_FORMAT,
  AUTHORITY_STATE_KINDS,
  approvalStateCheckpoint,
  authorityStateCheckpointProblem,
  isAuthorityStateKind,
  obligationDischargeStateCheckpoint,
  revocationStateCheckpoint,
  sameCheckpoint,
  serializeAuthorityStateCheckpoint,
} from './checkpoint.js';
export type { AuthorityStateBinding, AuthorityStateCheckpoint, AuthorityStateHead, AuthorityStateKind } from './checkpoint.js';

export { AUTHORITY_STATE_FRESHNESS_ERROR_CODES, AuthorityStateFreshnessError, isAuthorityStateFreshnessError, isRetryableAuthorityStateFreshnessFailure } from './errors.js';
export type { AuthorityStateFreshnessErrorCode } from './errors.js';

export {
  AUTHORITY_STATE_WITNESS_OPERATIONS,
  AUTHORITY_STATE_WITNESS_PATHS,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN,
  parseWitnessRequest,
  parseWitnessResponse,
  serializeWitnessReceipt,
  witnessReceiptSigningBytes,
} from './protocol.js';
export type { AuthorityStateEnrollment, AuthorityStateWitnessOperation, WitnessBindingState, WitnessReceipt, WitnessRequest } from './protocol.js';

export type { AuthorityStateWitnessTransport } from './transport.js';
export {
  MINIMUM_AUTHORITY_FRESHNESS_CREDENTIAL_LENGTH,
  authorityFreshnessCredentialProblem,
  authorityFreshnessEndpointProblem,
  createHttpAuthorityStateWitnessTransport,
} from './http-transport.js';
export type { HttpAuthorityStateWitnessTransportOptions } from './http-transport.js';

export {
  MAXIMUM_AUTHORITY_FRESHNESS_ATTEMPTS,
  MAXIMUM_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS,
  MAXIMUM_AUTHORITY_FRESHNESS_TIMEOUT_MS,
  authorityStateWitnessKeyBytes,
  establishAuthorityStateWitness,
  isAuthorityStateFreshnessAnchor,
} from './witness-client.js';
export type {
  AuthorityStateFreshnessAnchor,
  AuthorityStateWitness,
  AuthorityStateWitnessAnswer,
  AuthorityStateWitnessClientOptions,
  AuthorityStateWitnessMonitor,
  AuthorityStateWitnessStatus,
  PinnedAuthorityStateWitness,
} from './witness-client.js';

export {
  createAuthorityStateFreshnessBoundary,
  isAuthorityStateEnrollmentContext,
  isAuthorityStateFreshnessBoundary,
  isFailedAuthorityStateFreshnessStatus,
} from './session.js';
export type {
  AuthorityStateEnrollmentContext,
  AuthorityStateFreshnessBoundary,
  AuthorityStateFreshnessProbe,
  AuthorityStateFreshnessSession,
  AuthorityStateFreshnessSessionStatus,
  AuthorityStateFreshnessStatusValue,
  CreateAuthorityStateFreshnessBoundaryOptions,
} from './session.js';
