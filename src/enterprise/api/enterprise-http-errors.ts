import type { GovernanceStoreError } from '../governance-store/errors.js';
import type { EvidenceError } from '../evidence/errors.js';
import type { AgentPassportError } from '../passport/errors.js';
import type { AssuranceError } from '../assurance/errors.js';

/**
 * The Soberanía Enterprise Host's own HTTP error taxonomy (mission's "Enterprise
 * Error Model"). A denied/approval-required/indeterminate governance
 * outcome is never represented as one of these -- those are successful
 * evaluations with a `KernelEvaluationResult` body; see
 * `mapDecisionStatusToHttpStatus` in `governance-evaluate-contract.ts` for
 * how `status` maps to an HTTP code. This class exists solely for failures
 * *before or around* the Kernel call: malformed requests, auth failures,
 * persistence conflicts, and genuine infrastructure/provider faults.
 */
export type EnterpriseHttpErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'CONCURRENCY_CONFLICT'
  | 'INFRASTRUCTURE_FAILURE'
  | 'PROVIDER_UNAVAILABLE'
  /** The Enterprise Module Lifecycle is not `ready` (still starting, degraded-blocking, shutting down, or stopped) -- a readiness failure, never a Kernel denial (mission section 16/37). */
  | 'ENTERPRISE_NOT_READY'
  | 'NOT_FOUND'
  /** Governance Store error codes surfaced on the wire (PR-004 section 43). The Store's own taxonomy is preserved verbatim so callers see one stable vocabulary. */
  | 'GOVERNANCE_IDEMPOTENCY_CONFLICT'
  | 'GOVERNANCE_STORE_UNAVAILABLE'
  | 'GOVERNANCE_STORE_TRANSACTION_FAILED'
  | 'GOVERNANCE_STORE_VALIDATION_ERROR'
  | 'GOVERNANCE_RECORD_NOT_FOUND'
  | 'GOVERNANCE_RECORD_CORRUPTED'
  | 'GOVERNANCE_RECORD_TOO_LARGE'
  | 'GOVERNANCE_ACCESS_SCOPE_VIOLATION'
  /** Evidence Bundle error codes surfaced on the wire (PR-005). The Evidence module's own taxonomy is preserved verbatim, mirroring how Governance Store errors are handled. */
  | 'EVIDENCE_VALIDATION_ERROR'
  | 'EVIDENCE_SOURCE_RECORD_NOT_FOUND'
  | 'EVIDENCE_DISCLOSURE_POLICY_UNKNOWN'
  | 'EVIDENCE_BUNDLE_NOT_FOUND'
  | 'EVIDENCE_ACCESS_SCOPE_VIOLATION'
  | 'EVIDENCE_TENANT_SCOPE_REQUIRED'
  | 'EVIDENCE_STORE_UNAVAILABLE'
  | 'EVIDENCE_BUNDLE_ALREADY_EXISTS'
  | 'EVIDENCE_TRACE_NOT_FOUND'
  | 'EVIDENCE_DISCLOSURE_NOT_PERMITTED'
  | 'EVIDENCE_TRACE_TOO_LARGE'
  | 'EVIDENCE_STORE_CORRUPT'
  /** Agent Passport Runtime error codes surfaced on the wire (PR-006), mirroring how Governance Store and Evidence errors are handled. */
  | 'PASSPORT_NOT_FOUND'
  | 'PASSPORT_ALREADY_EXISTS'
  | 'PASSPORT_IDEMPOTENCY_CONFLICT'
  | 'PASSPORT_INVALID_STATE_TRANSITION'
  | 'PASSPORT_ALREADY_REVOKED'
  | 'PASSPORT_EXPIRED'
  | 'PASSPORT_TENANT_SCOPE_REQUIRED'
  | 'PASSPORT_ACCESS_SCOPE_VIOLATION'
  | 'PASSPORT_REFERENCE_INVALID'
  | 'PASSPORT_EVIDENCE_NOT_FOUND'
  | 'PASSPORT_GOVERNANCE_RECORD_NOT_FOUND'
  | 'PASSPORT_INTEGRITY_FAILED'
  | 'PASSPORT_STORE_UNAVAILABLE'
  | 'PASSPORT_VERSION_UNSUPPORTED'
  | 'PASSPORT_VALIDATION_ERROR'
  /** Assurance Runtime error codes surfaced on the wire (PR-007 section 59), mirroring how Governance Store, Evidence, and Passport errors are handled. */
  | 'ASSURANCE_FRAMEWORK_NOT_FOUND'
  | 'ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED'
  | 'ASSURANCE_FRAMEWORK_INVALID'
  | 'ASSURANCE_SCOPE_INVALID'
  | 'ASSURANCE_SUBJECT_NOT_FOUND'
  | 'ASSURANCE_EVIDENCE_INSUFFICIENT'
  | 'ASSURANCE_EVIDENCE_INVALID'
  | 'ASSURANCE_EVIDENCE_WRONG_TENANT'
  | 'ASSURANCE_EVIDENCE_CONTRADICTORY'
  | 'ASSURANCE_CONTROL_NOT_FOUND'
  | 'ASSURANCE_CONTROL_EVALUATION_FAILED'
  | 'ASSURANCE_MANUAL_REVIEW_REQUIRED'
  | 'ASSURANCE_MANUAL_REVIEW_INVALID'
  | 'ASSURANCE_ASSESSMENT_NOT_FOUND'
  | 'ASSURANCE_ASSESSMENT_IMMUTABLE'
  | 'ASSURANCE_ASSESSMENT_INCOMPLETE'
  | 'ASSURANCE_FINDING_NOT_FOUND'
  | 'ASSURANCE_INVALID_FINDING_TRANSITION'
  | 'ASSURANCE_ELIGIBILITY_NOT_SATISFIED'
  | 'ASSURANCE_SIGNAL_INVALID'
  | 'ASSURANCE_INTEGRITY_FAILED'
  | 'ASSURANCE_STORE_UNAVAILABLE'
  | 'ASSURANCE_TENANT_SCOPE_REQUIRED'
  | 'ASSURANCE_ACCESS_SCOPE_VIOLATION'
  | 'ASSURANCE_VALIDATION_ERROR'
  /** CTRL-01 authority administration. */
  | 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'
  | 'AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED'
  | 'AUTHORITY_ADMIN_OPERATION_REFUSED'
  | 'AUTHORITY_STATE_UNAVAILABLE'
  /** CORE-02: the authority signer could not sign, so nothing was recorded (AA-004). */
  | 'AUTHORITY_SIGNER_UNAVAILABLE'
  | 'AUTHORITY_STATE_INTEGRITY_FAILED'
  /** CTRL-02 operator plane: an authenticated operator whose role does not hold the permission. */
  | 'OPERATOR_PERMISSION_DENIED'
  /** CTRL-02: an idempotency key replayed with materially different content. Nothing was written. */
  | 'OPERATOR_IDEMPOTENCY_CONFLICT'
  /** CTRL-02: the authoritative store or lifecycle refused the operation (conflict, terminal state, unresolvable reference). Nothing was written. */
  | 'OPERATOR_OPERATION_REFUSED'
  /** CTRL-02: the authority write was durably recorded, and refreshing the in-memory projection failed (which fails closed). Retry the same request; it replays. */
  | 'AUTHORITY_STATE_REFRESH_FAILED';

export class EnterpriseHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: EnterpriseHttpErrorCode,
    message: string,
    readonly details?: readonly string[],
    /** Additional structured fields merged into the wire error body (e.g. `{ lifecycleState }` for `ENTERPRISE_NOT_READY`, per mission section 16). Never secrets. */
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EnterpriseHttpError';
  }
}

export const EnterpriseHttpErrors = {
  invalidRequest: (message: string, details?: readonly string[]) => new EnterpriseHttpError(400, 'INVALID_REQUEST', message, details),
  authenticationFailed: (message = 'Authentication is required.') => new EnterpriseHttpError(401, 'AUTHENTICATION_FAILED', message),
  authorizationFailed: (message = 'The caller is not authorized to call this endpoint.') => new EnterpriseHttpError(403, 'AUTHORIZATION_FAILED', message),
  concurrencyConflict: (message: string) => new EnterpriseHttpError(409, 'CONCURRENCY_CONFLICT', message),
  infrastructureFailure: (message = 'An unexpected Enterprise Host failure occurred.') => new EnterpriseHttpError(500, 'INFRASTRUCTURE_FAILURE', message),
  providerUnavailable: (message = 'A configured provider is unavailable.') => new EnterpriseHttpError(503, 'PROVIDER_UNAVAILABLE', message),
  enterpriseNotReady: (lifecycleState: string) =>
    new EnterpriseHttpError(503, 'ENTERPRISE_NOT_READY', 'Soberanía Enterprise is not ready to evaluate governance requests.', undefined, { lifecycleState }),
};

/**
 * Maps a `GovernanceStoreError` onto the wire (PR-004 section 43). Raw
 * driver/database details never reach the response — only the Store's own
 * taxonomy and message. Store validation errors default to 500 (they signal
 * a Host programming error, not caller input) unless the caller-input flag
 * says the offending value came off the wire (e.g. a bad query cursor).
 */
export function mapGovernanceStoreErrorToHttp(error: GovernanceStoreError, options: { readonly callerInput?: boolean } = {}): EnterpriseHttpError {
  switch (error.code) {
    case 'GOVERNANCE_IDEMPOTENCY_CONFLICT':
      return new EnterpriseHttpError(409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT', error.message);
    case 'GOVERNANCE_STORE_UNAVAILABLE':
      return new EnterpriseHttpError(503, 'GOVERNANCE_STORE_UNAVAILABLE', 'The Governance Store is unavailable; the evaluation was not durably recorded.');
    case 'GOVERNANCE_STORE_TRANSACTION_FAILED':
      return new EnterpriseHttpError(500, 'GOVERNANCE_STORE_TRANSACTION_FAILED', 'The Governance Store transaction failed; the evaluation was not durably recorded.');
    case 'GOVERNANCE_RECORD_NOT_FOUND':
      return new EnterpriseHttpError(404, 'GOVERNANCE_RECORD_NOT_FOUND', error.message);
    case 'GOVERNANCE_RECORD_CORRUPTED':
    case 'GOVERNANCE_INTEGRITY_VERIFICATION_FAILED':
      return new EnterpriseHttpError(500, 'GOVERNANCE_RECORD_CORRUPTED', 'A stored governance record is corrupted; see server logs.');
    case 'GOVERNANCE_RECORD_TOO_LARGE':
    case 'GOVERNANCE_TRACE_LIMIT_EXCEEDED':
    case 'GOVERNANCE_EVENT_PAYLOAD_TOO_LARGE':
      return new EnterpriseHttpError(413, 'GOVERNANCE_RECORD_TOO_LARGE', error.message);
    case 'GOVERNANCE_TENANT_SCOPE_REQUIRED':
    case 'GOVERNANCE_ACCESS_SCOPE_VIOLATION':
      return new EnterpriseHttpError(403, 'GOVERNANCE_ACCESS_SCOPE_VIOLATION', error.message);
    case 'GOVERNANCE_STORE_VALIDATION_ERROR':
      return options.callerInput === true
        ? new EnterpriseHttpError(400, 'INVALID_REQUEST', error.message)
        : new EnterpriseHttpError(500, 'GOVERNANCE_STORE_VALIDATION_ERROR', 'The Governance Store rejected an internally-built record; see server logs.');
    case 'GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED':
      return new EnterpriseHttpError(500, 'GOVERNANCE_STORE_TRANSACTION_FAILED', 'The Governance Store schema version is unsupported by this build.');
  }
}

/** Maps an `EvidenceError` onto the wire (PR-005), mirroring `mapGovernanceStoreErrorToHttp`. */
export function mapEvidenceErrorToHttp(error: EvidenceError): EnterpriseHttpError {
  switch (error.code) {
    case 'EVIDENCE_VALIDATION_ERROR':
    case 'EVIDENCE_DISCLOSURE_POLICY_UNKNOWN':
      return new EnterpriseHttpError(400, error.code, error.message);
    case 'EVIDENCE_SOURCE_RECORD_NOT_FOUND':
    case 'EVIDENCE_BUNDLE_NOT_FOUND':
    case 'EVIDENCE_TRACE_NOT_FOUND':
      return new EnterpriseHttpError(404, error.code, error.message);
    case 'EVIDENCE_TRACE_TOO_LARGE':
      return new EnterpriseHttpError(422, error.code, error.message);
    case 'EVIDENCE_STORE_CORRUPT':
      return new EnterpriseHttpError(500, error.code, 'An Evidence Bundle failed its integrity checks and was not returned.');
    case 'EVIDENCE_ACCESS_SCOPE_VIOLATION':
    case 'EVIDENCE_TENANT_SCOPE_REQUIRED':
    case 'EVIDENCE_DISCLOSURE_NOT_PERMITTED':
      return new EnterpriseHttpError(403, error.code, error.message);
    case 'EVIDENCE_STORE_UNAVAILABLE':
      return new EnterpriseHttpError(503, error.code, error.message);
    case 'EVIDENCE_BUNDLE_ALREADY_EXISTS':
      return new EnterpriseHttpError(409, error.code, error.message);
  }
}

/** Maps an `AgentPassportError` onto the wire (PR-006), mirroring `mapEvidenceErrorToHttp`. */
export function mapAgentPassportErrorToHttp(error: AgentPassportError): EnterpriseHttpError {
  const extra = error.details;
  switch (error.code) {
    case 'PASSPORT_VALIDATION_ERROR':
    case 'PASSPORT_REFERENCE_INVALID':
      return new EnterpriseHttpError(400, error.code, error.message, undefined, extra);
    case 'PASSPORT_NOT_FOUND':
    case 'PASSPORT_EVIDENCE_NOT_FOUND':
    case 'PASSPORT_GOVERNANCE_RECORD_NOT_FOUND':
      return new EnterpriseHttpError(404, error.code, error.message, undefined, extra);
    case 'PASSPORT_TENANT_SCOPE_REQUIRED':
    case 'PASSPORT_ACCESS_SCOPE_VIOLATION':
      return new EnterpriseHttpError(403, error.code, error.message, undefined, extra);
    case 'PASSPORT_ALREADY_EXISTS':
    case 'PASSPORT_IDEMPOTENCY_CONFLICT':
    case 'PASSPORT_INVALID_STATE_TRANSITION':
    case 'PASSPORT_ALREADY_REVOKED':
    case 'PASSPORT_EXPIRED':
      return new EnterpriseHttpError(409, error.code, error.message, undefined, extra);
    case 'PASSPORT_VERSION_UNSUPPORTED':
      return new EnterpriseHttpError(422, error.code, error.message, undefined, extra);
    case 'PASSPORT_INTEGRITY_FAILED':
      return new EnterpriseHttpError(500, error.code, error.message, undefined, extra);
    case 'PASSPORT_STORE_UNAVAILABLE':
      return new EnterpriseHttpError(503, error.code, error.message, undefined, extra);
  }
}

/**
 * Maps an `AssuranceError` onto the wire (PR-007 section 60), mirroring the
 * other mappers. A failed control is a valid assessment RESULT with a 200
 * body -- it never reaches this function; only failures *around* the
 * evaluation do.
 */
export function mapAssuranceErrorToHttp(error: AssuranceError): EnterpriseHttpError {
  const extra = error.details;
  switch (error.code) {
    case 'ASSURANCE_SCOPE_INVALID':
    case 'ASSURANCE_FRAMEWORK_INVALID':
    case 'ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED':
    case 'ASSURANCE_SIGNAL_INVALID':
    case 'ASSURANCE_EVIDENCE_INVALID':
    case 'ASSURANCE_MANUAL_REVIEW_INVALID':
    case 'ASSURANCE_VALIDATION_ERROR':
      return new EnterpriseHttpError(400, error.code, error.message, undefined, extra);
    case 'ASSURANCE_TENANT_SCOPE_REQUIRED':
    case 'ASSURANCE_ACCESS_SCOPE_VIOLATION':
    case 'ASSURANCE_EVIDENCE_WRONG_TENANT':
      return new EnterpriseHttpError(403, error.code, error.message, undefined, extra);
    case 'ASSURANCE_FRAMEWORK_NOT_FOUND':
    case 'ASSURANCE_ASSESSMENT_NOT_FOUND':
    case 'ASSURANCE_FINDING_NOT_FOUND':
    case 'ASSURANCE_SUBJECT_NOT_FOUND':
    case 'ASSURANCE_CONTROL_NOT_FOUND':
      return new EnterpriseHttpError(404, error.code, error.message, undefined, extra);
    case 'ASSURANCE_ASSESSMENT_IMMUTABLE':
    case 'ASSURANCE_ASSESSMENT_INCOMPLETE':
    case 'ASSURANCE_INVALID_FINDING_TRANSITION':
      return new EnterpriseHttpError(409, error.code, error.message, undefined, extra);
    case 'ASSURANCE_EVIDENCE_INSUFFICIENT':
    case 'ASSURANCE_EVIDENCE_CONTRADICTORY':
    case 'ASSURANCE_MANUAL_REVIEW_REQUIRED':
    case 'ASSURANCE_ELIGIBILITY_NOT_SATISFIED':
      return new EnterpriseHttpError(422, error.code, error.message, undefined, extra);
    case 'ASSURANCE_INTEGRITY_FAILED':
    case 'ASSURANCE_CONTROL_EVALUATION_FAILED':
      return new EnterpriseHttpError(500, error.code, error.message, undefined, extra);
    case 'ASSURANCE_STORE_UNAVAILABLE':
      return new EnterpriseHttpError(503, error.code, error.message, undefined, extra);
  }
}
