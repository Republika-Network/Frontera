/**
 * The Assurance Runtime's error taxonomy (mission section 59), parallel in
 * shape to `GovernanceStoreErrorCode`/`EvidenceErrorCode`/
 * `AgentPassportErrorCode`. Every failure this module surfaces is one of
 * these codes; raw driver/internal errors never escape it.
 *
 * A failed control is a valid assessment RESULT, never one of these errors
 * (mission section 60) -- these exist only for failures *around* the
 * evaluation: bad scope, missing framework, tenant violations, store
 * outages, integrity failures.
 */
export type AssuranceErrorCode =
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
  /** ASSURE-SEC-01B: no authenticated reviewer, a role the reviewer does not hold, or a declared identity that is not the authenticated one. Nothing is recorded. */
  | 'ASSURANCE_REVIEWER_UNAUTHORIZED'
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
  | 'ASSURANCE_VALIDATION_ERROR';

export class AssuranceError extends Error {
  constructor(
    readonly code: AssuranceErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AssuranceError';
  }
}

export function isAssuranceError(error: unknown): error is AssuranceError {
  return error instanceof AssuranceError;
}
