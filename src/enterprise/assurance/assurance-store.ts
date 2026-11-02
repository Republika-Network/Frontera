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
import type { CommercialReleaseCustodyCommit, CommercialReleaseCustodyRecord } from './commercial-release-custody.js';

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
 *  - manual reviews and signals only append;
 *  - ASSURE-OPS-01 (R-02): a manual review appends only while its assessment
 *    is non-terminal. The status check and the insert are one atomic unit, so
 *    a review racing a completion, a failure or a supersession is either
 *    recorded before the transition or refused after it -- never recorded
 *    against a terminal assessment.
 */
export interface AssuranceStore {
  readonly providerKind: 'memory' | 'sqlite';

  /** Persists a framework definition (system scope). A `(frameworkId, frameworkVersion)` pair persists once and is never overwritten. */
  saveFramework(context: AssuranceAccessContext, framework: AssuranceFramework): Promise<void>;
  getFramework(context: AssuranceAccessContext, frameworkId: string, frameworkVersion: string): Promise<AssuranceFramework | null>;
  listFrameworks(context: AssuranceAccessContext): Promise<readonly AssuranceFramework[]>;

  /**
   * Saves an assessment snapshot. Allowed while the stored status is
   * non-terminal; a completed/failed assessment is immutable.
   *
   * ASSURE-REL-01D: with `expected`, the save is a compare-and-set. Under the
   * same write lock that guards terminal immutability, the stored status and
   * `integrity.assessmentDigest` must equal what the writer read, or nothing is
   * written and `ASSURANCE_ASSESSMENT_CONFLICT` is thrown. Terminal immutability
   * is checked first and keeps its own error. Without `expected` the save is
   * unconditional (kept for compatibility; the service always passes it when
   * it rewrites a stored assessment).
   */
  saveAssessment(context: AssuranceAccessContext, assessment: AssuranceAssessment, expected?: AssuranceAssessmentWritePrecondition): Promise<void>;
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

  /**
   * Appends one manual review. ASSURE-OPS-01 (R-02): refuses with
   * `ASSURANCE_ASSESSMENT_IMMUTABLE` (`details.reason: 'terminal_assessment'`)
   * when the stored assessment is `completed`, `failed` or `superseded`, and
   * writes nothing. The status read and the insert must be atomic with
   * respect to every terminal transition (SQLite: one `BEGIN IMMEDIATE`
   * transaction; in memory: no `await` between check and append). A custom
   * store must honour the same contract. Existing reviews are never removed.
   */
  appendManualReview(context: AssuranceAccessContext, review: AssuranceManualReviewRecord): Promise<void>;
  listManualReviews(context: AssuranceAccessContext, assessmentId: string): Promise<readonly AssuranceManualReviewRecord[]>;

  appendSignal(context: AssuranceAccessContext, signal: AssuranceSignal): Promise<void>;
  listSignals(context: AssuranceAccessContext, query: AssuranceSignalQuery): Promise<readonly AssuranceSignal[]>;

  verifyAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessmentVerificationResult>;

  /**
   * ASSURE-REL-01A: records a commercial report release in custody, once per
   * `reportId`, append-only. In one write transaction it checks that the
   * assessment exists in the record's organization and is `completed`, then
   * either inserts the record (`committed`) or, when a release for that
   * `reportId` is already kept, writes nothing and returns it (`existing`) --
   * never overwriting it. An incoherent record is refused with
   * `ASSURANCE_VALIDATION_ERROR`; a persistence failure with
   * `ASSURANCE_STORE_UNAVAILABLE`, carrying no driver detail.
   *
   * Optional so that existing implementations still compile; the service
   * refuses to release when a store does not implement custody.
   */
  commitCommercialRelease?(context: AssuranceAccessContext, record: CommercialReleaseCustodyRecord): Promise<CommercialReleaseCustodyCommit>;
  /** ASSURE-REL-01A: the release kept for `reportId`, or `null` (also when it belongs to another organization). A corrupted record throws `ASSURANCE_INTEGRITY_FAILED`. */
  getCommercialRelease?(context: AssuranceAccessContext, reportId: string): Promise<CommercialReleaseCustodyRecord | null>;
  /** ASSURE-REL-01A: every release kept for an assessment within the caller's scope, oldest first. */
  listCommercialReleases?(context: AssuranceAccessContext, assessmentId: string): Promise<readonly CommercialReleaseCustodyRecord[]>;

  health(): Promise<AssuranceStoreHealth>;
  close(): Promise<void>;
}

/**
 * ASSURE-REL-01D: the stored state a writer read, which a compare-and-set save
 * requires to be unchanged. The integrity digest covers the assessment's
 * content but not its lifecycle status (nor a termination record), so both are
 * compared: two stored states that differ only in status are distinct.
 */
export interface AssuranceAssessmentWritePrecondition {
  readonly status: AssuranceAssessment['status'];
  readonly assessmentDigest: string;
}

/** The precondition for rewriting `read`, an assessment as the store returned it. */
export function assessmentWritePrecondition(read: AssuranceAssessment): AssuranceAssessmentWritePrecondition {
  return { status: read.status, assessmentDigest: read.integrity.assessmentDigest };
}

/**
 * Refuses a compare-and-set write whose precondition does not hold against the
 * stored state (`undefined` when no assessment is stored). Shared by every store
 * so the conflict is the same everywhere; call it inside the write lock.
 */
export function assertAssessmentWritePrecondition(
  assessmentId: string,
  stored: AssuranceAssessmentWritePrecondition | undefined,
  expected: AssuranceAssessmentWritePrecondition | undefined,
): void {
  if (expected === undefined) return;
  if (stored === undefined || stored.status !== expected.status || stored.assessmentDigest !== expected.assessmentDigest) {
    throw new AssuranceError('ASSURANCE_ASSESSMENT_CONFLICT', `Assessment '${assessmentId}' changed after it was read; nothing was written. Read it again and retry.`, {
      reason: 'concurrent_modification',
      retryable: true,
    });
  }
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
