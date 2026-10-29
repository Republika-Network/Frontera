import { AssuranceError } from './errors.js';
import { verifyAssuranceAssessment } from './verification.js';
import { applyFindingTransition, foldFindingStatus } from './findings.js';
import { assertCompletionCommit } from './finding-history.js';
import {
  canAccessAssuranceOrganization,
  requireAccessToAssuranceOrganization,
  requireAssuranceTenantScope,
  type AssuranceStore,
} from './assurance-store.js';
import type {
  AssuranceAccessContext,
  AssuranceAssessment,
  AssuranceAssessmentQuery,
  AssuranceAssessmentSummary,
  AssuranceFinding,
  AssuranceFindingEvent,
  AssuranceFramework,
  AssuranceManualReviewRecord,
  AssuranceSignal,
  AssuranceSignalQuery,
} from './contracts.js';
import { ASSURANCE_STORE_SCHEMA_VERSION, ASSURANCE_TERMINAL_STATUSES } from './contracts.js';

export interface CreateInMemoryAssuranceStoreOptions {
  readonly now?: () => string;
}

/**
 * In-memory Assurance Store. Atomicity comes from the synchronous commit
 * sections (single-threaded JS) -- no `await` sits between a validation and
 * its corresponding map update. Shares its behavioural contract with the
 * SQLite store via `assurance-store-contract.test.ts`.
 */
export function createInMemoryAssuranceStore(options: CreateInMemoryAssuranceStoreOptions = {}): AssuranceStore {
  const now = options.now ?? (() => new Date().toISOString());

  const frameworks = new Map<string, AssuranceFramework>();
  const assessments = new Map<string, AssuranceAssessment>();
  const findings = new Map<string, AssuranceFinding>();
  const findingEvents = new Map<string, AssuranceFindingEvent[]>();
  /** Every stored finding event id -- unique across the store, as the SQLite primary key makes it. */
  const findingEventIds = new Set<string>();
  const manualReviews = new Map<string, AssuranceManualReviewRecord[]>();
  const signals: AssuranceSignal[] = [];
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', 'The Assurance Store has been closed.');
  }

  function frameworkKey(frameworkId: string, frameworkVersion: string): string {
    return `${frameworkId}@@${frameworkVersion}`;
  }

  function requireVisibleAssessment(context: AssuranceAccessContext, assessmentId: string): AssuranceAssessment {
    const assessment = assessments.get(assessmentId);
    if (assessment === undefined || !canAccessAssuranceOrganization(context, assessment.subject.organizationId)) {
      throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessmentId}' within this scope.`);
    }
    return assessment;
  }

  function findingWithFoldedStatus(finding: AssuranceFinding): AssuranceFinding {
    const events = findingEvents.get(finding.findingId) ?? [];
    const folded = foldFindingStatus(events);
    return folded === undefined ? finding : { ...finding, status: folded };
  }

  return {
    providerKind: 'memory',

    async saveFramework(context, framework) {
      assertOpen();
      if (!context.system) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', 'Only system callers may persist Assurance framework definitions.');
      }
      const key = frameworkKey(framework.frameworkId, framework.frameworkVersion);
      if (frameworks.has(key)) {
        throw new AssuranceError('ASSURANCE_FRAMEWORK_INVALID', `Framework '${framework.frameworkId}@${framework.frameworkVersion}' is already persisted; framework versions are immutable.`);
      }
      frameworks.set(key, framework);
    },

    async getFramework(_context, frameworkId, frameworkVersion) {
      assertOpen();
      return frameworks.get(frameworkKey(frameworkId, frameworkVersion)) ?? null;
    },

    async listFrameworks(_context) {
      assertOpen();
      return [...frameworks.values()];
    },

    async saveAssessment(context, assessment) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      const existing = assessments.get(assessment.assessmentId);
      if (existing !== undefined) {
        if (existing.subject.organizationId !== assessment.subject.organizationId) {
          throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Assessment '${assessment.assessmentId}' belongs to a different organization.`);
        }
        if (ASSURANCE_TERMINAL_STATUSES.includes(existing.status)) {
          throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Assessment '${assessment.assessmentId}' is '${existing.status}' and immutable; changed evidence or framework versions require a new assessment.`);
        }
      }
      assessments.set(assessment.assessmentId, assessment);
      // Findings rows persist only at the terminal save (re-evaluation before
      // completion replaces the working findings set; only the final set gets
      // an append-only lifecycle). Content stays owned by the assessment.
      if (ASSURANCE_TERMINAL_STATUSES.includes(assessment.status)) {
        for (const finding of assessment.findings) {
          if (!findings.has(finding.findingId)) findings.set(finding.findingId, finding);
        }
      }
    },

    async getAssessment(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const assessment = assessments.get(assessmentId);
      if (assessment === undefined || !canAccessAssuranceOrganization(context, assessment.subject.organizationId)) return null;
      return assessment;
    },

    async queryAssessments(context, query: AssuranceAssessmentQuery) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const matches = [...assessments.values()]
        .filter((assessment) => canAccessAssuranceOrganization(context, assessment.subject.organizationId))
        .filter((assessment) => query.subjectId === undefined || assessment.subject.subjectId === query.subjectId)
        .filter((assessment) => query.frameworkId === undefined || assessment.frameworkId === query.frameworkId)
        .filter((assessment) => query.frameworkVersion === undefined || assessment.frameworkVersion === query.frameworkVersion)
        .filter((assessment) => query.status === undefined || assessment.status === query.status)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.assessmentId < b.assessmentId ? 1 : -1));
      const limited = matches.slice(0, query.limit ?? 50);
      const summaries: AssuranceAssessmentSummary[] = limited.map((assessment) => ({
        assessmentId: assessment.assessmentId,
        subjectId: assessment.subject.subjectId,
        subjectType: assessment.subject.subjectType,
        organizationId: assessment.subject.organizationId,
        frameworkId: assessment.frameworkId,
        frameworkVersion: assessment.frameworkVersion,
        status: assessment.status,
        normalizedScore: assessment.score.normalizedScore,
        createdAt: assessment.createdAt,
        ...(assessment.completedAt !== undefined ? { completedAt: assessment.completedAt } : {}),
      }));
      return { assessments: summaries, total: matches.length };
    },

    async markSuperseded(context, assessmentId, supersededByAssessmentId) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      if (assessment.status !== 'completed') {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Only a completed assessment can be marked superseded; '${assessmentId}' is '${assessment.status}'.`);
      }
      assessments.set(assessmentId, { ...assessment, status: 'superseded', supersededByAssessmentId });
    },

    async completeAssessment(context, commit) {
      assertOpen();
      const { assessment, findingEvents: openingEvents } = commit;
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      // ASSURE-SEC-01E: every check runs before the first map update, and no
      // `await` separates them -- the completion lands whole or not at all.
      assertCompletionCommit(commit);
      const existing = assessments.get(assessment.assessmentId);
      if (existing === undefined) {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessment.assessmentId}' within this scope.`);
      }
      if (existing.subject.organizationId !== assessment.subject.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Assessment '${assessment.assessmentId}' belongs to a different organization.`);
      }
      if (ASSURANCE_TERMINAL_STATUSES.includes(existing.status)) {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Assessment '${assessment.assessmentId}' is '${existing.status}' and immutable; changed evidence or framework versions require a new assessment.`);
      }
      for (const event of openingEvents) {
        if (findingEventIds.has(event.findingEventId)) {
          throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding event id '${event.findingEventId}' already exists.`);
        }
        if ((findingEvents.get(event.findingId) ?? []).length > 0) {
          throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding '${event.findingId}' already has a history; its opening event cannot be appended again.`);
        }
      }
      let superseded: AssuranceAssessment | undefined;
      if (assessment.supersedesAssessmentId !== undefined) {
        const previous = requireVisibleAssessment(context, assessment.supersedesAssessmentId);
        if (previous.subject.organizationId !== assessment.subject.organizationId) {
          throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Assessment '${assessment.supersedesAssessmentId}' belongs to a different organization.`);
        }
        if (previous.status === 'completed') superseded = { ...previous, status: 'superseded', supersededByAssessmentId: assessment.assessmentId };
        else if (previous.status !== 'superseded') {
          throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Only a completed assessment can be superseded; '${previous.assessmentId}' is '${previous.status}'.`);
        }
      }

      assessments.set(assessment.assessmentId, assessment);
      for (const finding of assessment.findings) {
        if (!findings.has(finding.findingId)) findings.set(finding.findingId, finding);
      }
      for (const event of openingEvents) {
        findingEvents.set(event.findingId, [event]);
        findingEventIds.add(event.findingEventId);
      }
      if (superseded !== undefined) assessments.set(superseded.assessmentId, superseded);
    },

    async appendFindingEvent(context, event) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, event.organizationId);
      const finding = findings.get(event.findingId);
      if (finding === undefined) {
        throw new AssuranceError('ASSURANCE_FINDING_NOT_FOUND', `No Assurance finding for findingId '${event.findingId}'.`);
      }
      const assessment = assessments.get(event.assessmentId);
      if (assessment === undefined || assessment.subject.organizationId !== event.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Finding event organization '${event.organizationId}' does not match assessment '${event.assessmentId}'.`);
      }
      const events = findingEvents.get(event.findingId) ?? [];
      if (event.sequence !== events.length + 1) {
        throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding event sequence ${event.sequence} is not contiguous (expected ${events.length + 1}).`);
      }
      // Validates the transition (throws ASSURANCE_INVALID_FINDING_TRANSITION).
      applyFindingTransition(foldFindingStatus(events), event.eventType);
      if (findingEventIds.has(event.findingEventId)) {
        throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding event id '${event.findingEventId}' already exists.`);
      }
      findingEvents.set(event.findingId, [...events, event]);
      findingEventIds.add(event.findingEventId);
    },

    async listFindingEvents(context, findingId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const events = findingEvents.get(findingId) ?? [];
      return events.filter((event) => canAccessAssuranceOrganization(context, event.organizationId));
    },

    async listFindings(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const assessment = assessments.get(assessmentId);
      if (assessment === undefined || !canAccessAssuranceOrganization(context, assessment.subject.organizationId)) return [];
      return [...findings.values()].filter((finding) => finding.assessmentId === assessmentId).map(findingWithFoldedStatus);
    },

    async getFinding(context, findingId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const finding = findings.get(findingId);
      if (finding === undefined) return null;
      const assessment = assessments.get(finding.assessmentId);
      if (assessment === undefined || !canAccessAssuranceOrganization(context, assessment.subject.organizationId)) return null;
      return findingWithFoldedStatus(finding);
    },

    async saveFinding(context, finding) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, finding.assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      if (findings.has(finding.findingId)) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `Finding '${finding.findingId}' already exists; finding history is append-only.`);
      }
      findings.set(finding.findingId, finding);
    },

    async appendManualReview(context, review) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, review.assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      const existing = manualReviews.get(review.assessmentId) ?? [];
      if (existing.some((candidate) => candidate.reviewId === review.reviewId)) {
        throw new AssuranceError('ASSURANCE_MANUAL_REVIEW_INVALID', `Manual review '${review.reviewId}' already exists; reviews are append-only.`);
      }
      manualReviews.set(review.assessmentId, [...existing, review]);
    },

    async listManualReviews(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const assessment = assessments.get(assessmentId);
      if (assessment === undefined || !canAccessAssuranceOrganization(context, assessment.subject.organizationId)) return [];
      return manualReviews.get(assessmentId) ?? [];
    },

    async appendSignal(context, signal) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, signal.organizationId);
      if (signals.some((candidate) => candidate.signalId === signal.signalId)) {
        throw new AssuranceError('ASSURANCE_SIGNAL_INVALID', `Signal '${signal.signalId}' already exists; signals are append-only.`);
      }
      signals.push(signal);
    },

    async listSignals(context, query: AssuranceSignalQuery) {
      assertOpen();
      requireAssuranceTenantScope(context);
      return signals
        .filter((signal) => canAccessAssuranceOrganization(context, signal.organizationId))
        .filter((signal) => query.subjectId === undefined || signal.subjectId === query.subjectId)
        .filter((signal) => query.signalType === undefined || signal.signalType === query.signalType)
        .filter((signal) => query.since === undefined || signal.observedAt >= query.since)
        .slice(0, query.limit ?? 200);
    },

    async verifyAssessment(context, assessmentId) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, assessmentId);
      const framework = frameworks.get(frameworkKey(assessment.frameworkId, assessment.frameworkVersion));
      return verifyAssuranceAssessment({ assessment, ...(framework !== undefined ? { framework } : {}), now });
    },

    async health() {
      return {
        status: closed ? 'unhealthy' : 'healthy',
        readable: !closed,
        writable: !closed,
        schemaVersion: ASSURANCE_STORE_SCHEMA_VERSION,
        migrationState: 'current',
        checkedAt: now(),
      };
    },

    async close() {
      closed = true;
    },
  };
}
