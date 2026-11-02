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
  /**
   * ASSURE-REL-01D: the assessment changed after the writer read it (another
   * writer saved first). Nothing was written; re-read and retry.
   */
  | 'ASSURANCE_ASSESSMENT_CONFLICT'
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
  /**
   * ASSURE-OPS-01 (R-05): a kept release whose delivery package cannot be
   * exported from custody -- it predates artifact custody
   * (`reason: 'artifacts_not_in_custody'`) or exceeds the delivery bound
   * (`reason: 'package_too_large'`). Nothing is wrong with the release itself.
   */
  | 'ASSURANCE_RELEASE_NOT_EXPORTABLE';

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

/**
 * ASSURE-OPS-01 (R-02): the one refusal for a manual review offered to a
 * terminal assessment. `ASSURANCE_ASSESSMENT_IMMUTABLE` already means "this
 * assessment's recorded content can no longer change" (HTTP 409); a review is
 * part of what a terminal conclusion rests on, so the same code applies, with
 * `reason: 'terminal_assessment'` to tell it apart from a content rewrite.
 * Raised by the service and again by every store inside the insert unit.
 */
export function terminalReviewRefusal(assessmentId: string, status: string): AssuranceError {
  return new AssuranceError(
    'ASSURANCE_ASSESSMENT_IMMUTABLE',
    `Assessment '${assessmentId}' is '${status}'; a terminal assessment accepts no new manual review. Nothing was recorded. Corrections need a reassessment.`,
    { reason: 'terminal_assessment', status },
  );
}
