import { AssuranceError } from './errors.js';
import type {
  AssuranceAccessContext,
  AssuranceAssessment,
  AssuranceAssessmentQuery,
  AssuranceAssessmentQueryResult,
  AssuranceAssessmentVerificationResult,
  AssuranceFinding,
  AssuranceFindingEvent,
  AssuranceFramework,
  AssuranceManualReviewRecord,
  AssuranceSignal,
  AssuranceSignalQuery,
  AssuranceStoreHealth,
} from './contracts.js';
import type { AssuranceCompletionCommit } from './finding-history.js';

/**
 * The Assurance Store (mission sections 48-52): an independent,
 * append-oriented store. Assurance assessments are never persisted inside
 * the Governance Store, Evidence Bundle Store, or Passport Store, and there
 * is deliberately NO general update or delete API:
 *
 *  - assessments save in non-terminal states and freeze at
 *    `completed`/`failed` (`ASSURANCE_ASSESSMENT_IMMUTABLE` on any later
 *    content write);
 *  - the only post-completion change is the store-level supersession marker
 *    (`markSuperseded`), which never touches content or digests;
 *  - completion is one unit (ASSURE-SEC-01E): `completeAssessment` persists the
 *    terminal assessment, the opening event of every finding and the
 *    supersession of the assessment it replaces together, or nothing;
 *  - findings evolve exclusively through appended finding events;
 *  - manual reviews and signals only append.
 */
export interface AssuranceStore {
  readonly providerKind: 'memory' | 'sqlite';

  /** Persists a framework definition (system scope). A `(frameworkId, frameworkVersion)` pair persists once and is never overwritten. */
  saveFramework(context: AssuranceAccessContext, framework: AssuranceFramework): Promise<void>;
  getFramework(context: AssuranceAccessContext, frameworkId: string, frameworkVersion: string): Promise<AssuranceFramework | null>;
  listFrameworks(context: AssuranceAccessContext): Promise<readonly AssuranceFramework[]>;

  /** Saves an assessment snapshot. Allowed while the stored status is non-terminal; a completed/failed assessment is immutable. */
  saveAssessment(context: AssuranceAccessContext, assessment: AssuranceAssessment): Promise<void>;
  getAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessment | null>;
  queryAssessments(context: AssuranceAccessContext, query: AssuranceAssessmentQuery): Promise<AssuranceAssessmentQueryResult>;
  /** Store-level supersession bookkeeping over a completed assessment -- content and digests stay frozen (mission section 40). */
  markSuperseded(context: AssuranceAccessContext, assessmentId: string, supersededByAssessmentId: string): Promise<void>;
  /**
   * ASSURE-SEC-01E: completes an assessment as one unit -- the `completed`
   * assessment, its findings, one `AssuranceFindingCreated` event per finding,
   * and, for a reassessment, the supersession of the assessment it replaces
   * (left as it is when that one is already superseded). Either everything is
   * persisted or nothing is: a failure leaves the assessment in its previous,
   * completable state, so the completion can be retried. A second completion
   * is refused with `ASSURANCE_ASSESSMENT_IMMUTABLE`; an inconsistent event set
   * with `ASSURANCE_INVALID_FINDING_TRANSITION`; a persistence failure with
   * `ASSURANCE_STORE_UNAVAILABLE`, carrying no driver detail.
   */
  completeAssessment(context: AssuranceAccessContext, commit: AssuranceCompletionCommit): Promise<void>;

  appendFindingEvent(context: AssuranceAccessContext, event: AssuranceFindingEvent): Promise<void>;
  listFindingEvents(context: AssuranceAccessContext, findingId: string): Promise<readonly AssuranceFindingEvent[]>;
  /** Findings for one assessment with their event-folded current status. */
  listFindings(context: AssuranceAccessContext, assessmentId: string): Promise<readonly AssuranceFinding[]>;
  getFinding(context: AssuranceAccessContext, findingId: string): Promise<AssuranceFinding | null>;
  /** Persists a post-completion, signal-driven finding (never mutates a completed assessment's frozen content). */
  saveFinding(context: AssuranceAccessContext, finding: AssuranceFinding): Promise<void>;

  appendManualReview(context: AssuranceAccessContext, review: AssuranceManualReviewRecord): Promise<void>;
  listManualReviews(context: AssuranceAccessContext, assessmentId: string): Promise<readonly AssuranceManualReviewRecord[]>;

  appendSignal(context: AssuranceAccessContext, signal: AssuranceSignal): Promise<void>;
  listSignals(context: AssuranceAccessContext, query: AssuranceSignalQuery): Promise<readonly AssuranceSignal[]>;

  verifyAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessmentVerificationResult>;

  health(): Promise<AssuranceStoreHealth>;
  close(): Promise<void>;
}

/** True when `context` may see a record scoped to `recordOrganizationId`. Mirrors `canAccessPassportOrganization`. */
export function canAccessAssuranceOrganization(context: AssuranceAccessContext, recordOrganizationId: string): boolean {
  if (context.system) return true;
  return context.organizationId !== undefined && context.organizationId === recordOrganizationId;
}

export function requireAssuranceTenantScope(context: AssuranceAccessContext): void {
  if (!context.system && (context.organizationId === undefined || context.organizationId.length === 0)) {
    throw new AssuranceError('ASSURANCE_TENANT_SCOPE_REQUIRED', 'A non-system caller must provide an organization scope for Assurance access.');
  }
}

export function requireAccessToAssuranceOrganization(context: AssuranceAccessContext, organizationId: string): void {
  requireAssuranceTenantScope(context);
  if (!canAccessAssuranceOrganization(context, organizationId)) {
    throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `The caller is not authorized to access Assurance data for organization '${organizationId}'.`);
  }
}
