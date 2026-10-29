import { AOC_KERNEL_VERSION } from '../../kernel/index.js';
import { AOC_GOVERNANCE_STORE_VERSION } from '../governance-store/contracts.js';
import { AOC_EVIDENCE_BUNDLE_VERSION } from '../evidence/contracts.js';
import { AOC_AGENT_PASSPORT_RUNTIME_VERSION } from '../passport/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import type { EnterpriseEventPublisher, AssuranceEnterpriseEventType } from '../events/enterprise-events.js';
import type { EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { AssuranceError, isAssuranceError } from './errors.js';
import { resolveFrameworkForAssessment, type AssuranceFrameworkRegistry } from './framework-registry.js';
import { createAssuranceEvidenceResolver, type AssuranceEvidenceSources } from './evidence-resolver.js';
import { checkManualReviewEvidence } from './manual-review-evidence.js';
import { manualEvidenceBindingViolations } from './manual-evidence-trust.js';
import { createAssuranceReviewerAuthenticator, type AssuranceReviewerCredential } from './reviewer-identity.js';
import { createAssuranceControlEvaluator } from './control-evaluator.js';
import { deriveAssuranceMetrics } from './metrics.js';
import { buildFindingEvent, deriveFindingsFromEvaluations } from './findings.js';
import { computeDomainAssessments, computeOverallScore } from './scoring.js';
import { evaluateEligibility } from './eligibility.js';
import { assertAssessmentTransition, computeAssessmentIntegrity, emptyAssuranceScore } from './assessment.js';
import { verifyAssuranceAssessment } from './verification.js';
import { ASSURANCE_SIGNAL_OUTCOMES, buildAssuranceSignal, deriveContinuousAssuranceState, type BuildAssuranceSignalInput } from './signals.js';
import { buildAssuranceReport, isAssuranceReportView } from './report.js';
import {
  COMMERCIAL_REPORT_RELEASE_ROLE,
  buildCommercialReportDraft,
  buildCommercialReportRelease,
  type CommercialReleaseAcknowledgements,
  type CommercialReportDraft,
  type CommercialReportRelease,
} from './commercial-report.js';
import { requireAssuranceTenantScope, type AssuranceStore } from './assurance-store.js';
import { providesDurableReleaseCustody } from './sqlite-assurance-store.js';
import {
  buildCommercialReleaseCustodyRecord,
  commercialReleaseConflict,
  verifyCommercialReleaseAgainstCustody,
  type CommercialReleaseAuthorityLookup,
  type CommercialReleaseAuthorityVerification,
  type CommercialReleaseCustodyRecord,
  type CommercialReleasePackage,
} from './commercial-release-custody.js';
import type {
  AssuranceAccessContext,
  AssuranceAssessment,
  AssuranceAssessmentQuery,
  AssuranceAssessmentQueryResult,
  AssuranceAssessmentVerificationResult,
  AssuranceControlEvaluation,
  AssuranceEligibilityResult,
  AssuranceEvidenceReference,
  AssuranceEvidenceResolution,
  AssuranceFinding,
  AssuranceFindingEvent,
  AssuranceFindingEventType,
  AssuranceFramework,
  AssuranceManualReviewOutcome,
  AssuranceManualReviewRecord,
  AssuranceReviewerPrincipal,
  AssuranceModuleSnapshot,
  AssuranceReport,
  AssuranceReportView,
  AssuranceSignal,
  AssuranceSignalProcessingResult,
  AssuranceSubject,
  AssuranceTerminationReasonCode,
  ContinuousAssuranceState,
} from './contracts.js';
import {
  ASSURANCE_TERMINATION_RATIONALE_MAX_LENGTH,
  ASSURANCE_TERMINATION_REASON_CODES,
  ASSURANCE_TERMINATION_ROLE,
  assessmentTerminationViolations,
  buildAssessmentTermination,
  isSameTermination,
  unresolvedContradictions,
} from './assessment-termination.js';
import {
  AOC_ASSURANCE_RUNTIME_VERSION,
  ASSURANCE_ELIGIBILITY_VERSION,
  ASSURANCE_EVALUATOR_VERSION,
  ASSURANCE_SCORING_VERSION,
  ASSURANCE_SUBJECT_TYPES,
  ASSURANCE_TERMINAL_STATUSES,
} from './contracts.js';

/**
 * The Assurance service layer (mission section 54): the orchestration
 * surface HTTP handlers and embedders call. HTTP controllers contain no
 * control logic, evidence selection, scoring formulas, or eligibility logic
 * -- it all lives behind this interface, delegating to the deterministic
 * engines in this package.
 */

export interface CreateAssuranceAssessmentInput {
  readonly subject: AssuranceSubject;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly domainIds?: readonly string[];
  readonly controlIds?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly evidenceCutoffAt?: string;
  readonly includeHistoricalEvidence?: boolean;
  readonly requestedBy: string;
  readonly purpose?: string;
}

/**
 * ASSURE-SEC-01B: the reviewer is the authenticated `context.reviewer`, never
 * these fields. `reviewerId` / `reviewerRole` are optional assertions kept for
 * v1 callers: when present they must name the authenticated reviewer and a
 * role that reviewer holds, or the review is refused -- never silently replaced.
 */
export interface RecordManualReviewInput {
  readonly assessmentId: string;
  readonly controlId: string;
  readonly reviewerId?: string;
  readonly reviewerRole?: string;
  readonly outcome: AssuranceManualReviewOutcome;
  readonly rationale: string;
  readonly evidenceReferenceIds?: readonly string[];
}

export interface AppendFindingEventInput {
  readonly findingId: string;
  readonly eventType: AssuranceFindingEventType;
  readonly actorId: string;
  readonly rationale?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** ASSURE-REL-01B: why an attempt is ended without a conclusion. */
export interface TerminateAssessmentInput {
  readonly reasonCode: AssuranceTerminationReasonCode;
  readonly rationale: string;
}

/** ASSURE-REL-01B: the ended attempt, and whether this call ended it or found it already ended the same way. */
export interface AssuranceAssessmentTerminationResult {
  readonly assessment: AssuranceAssessment;
  readonly outcome: 'terminated' | 'replayed';
}

export interface RequestReassessmentInput {
  /**
   * The completed assessment to supersede, or (ASSURE-REL-01B) an attempt
   * ended as inconclusive to follow -- linked, never superseded. Provide either
   * this or `subjectId` (the latest completed assessment for the subject is resolved).
   */
  readonly assessmentId?: string;
  readonly subjectId?: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly evidenceCutoffAt?: string;
}

export interface CollectEvidenceOptions {
  readonly manualEvidence?: readonly AssuranceEvidenceReference[];
}

/** ASSURE-REP-01: what a commercial report is drafted from beyond the stored assessment. Untrusted until validated. */
export interface CommercialReportRequest {
  readonly engagement: unknown;
  readonly issue: unknown;
}

/** ASSURE-REP-01: a release names the exact content it approves and acknowledges the limitations it read. */
export interface CommercialReportReleaseRequest extends CommercialReportRequest {
  readonly approvedContentDigest: string;
  readonly acknowledgements: CommercialReleaseAcknowledgements;
}

export interface AssuranceService {
  createAssessment(context: AssuranceAccessContext, input: CreateAssuranceAssessmentInput): Promise<AssuranceAssessment>;
  collectEvidence(context: AssuranceAccessContext, assessmentId: string, options?: CollectEvidenceOptions): Promise<AssuranceAssessment>;
  evaluateControl(context: AssuranceAccessContext, assessmentId: string, controlId: string): Promise<AssuranceControlEvaluation>;
  evaluateAssessment(context: AssuranceAccessContext, assessmentId: string, options?: CollectEvidenceOptions): Promise<AssuranceAssessment>;
  completeAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessment>;
  getAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessment | null>;
  queryAssessments(context: AssuranceAccessContext, query: AssuranceAssessmentQuery): Promise<AssuranceAssessmentQueryResult>;
  verifyAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessmentVerificationResult>;
  listFindings(context: AssuranceAccessContext, assessmentId: string): Promise<readonly AssuranceFinding[]>;
  appendFindingEvent(context: AssuranceAccessContext, input: AppendFindingEventInput): Promise<AssuranceFindingEvent>;
  recordManualReview(context: AssuranceAccessContext, input: RecordManualReviewInput): Promise<AssuranceManualReviewRecord>;
  /** ASSURE-SEC-01B: the reviewer principal for a configured Assurance reviewer secret, or `undefined`. The only source of `context.reviewer`. */
  authenticateReviewer(bearerToken: string): AssuranceReviewerPrincipal | undefined;
  evaluateEligibility(context: AssuranceAccessContext, assessmentId: string): Promise<readonly AssuranceEligibilityResult[]>;
  processSignal(context: AssuranceAccessContext, input: BuildAssuranceSignalInput | Omit<BuildAssuranceSignalInput, 'signalId'>): Promise<AssuranceSignalProcessingResult>;
  getContinuousState(context: AssuranceAccessContext, subjectId: string, frameworkId?: string, frameworkVersion?: string): Promise<ContinuousAssuranceState>;
  requestReassessment(context: AssuranceAccessContext, input: RequestReassessmentInput): Promise<AssuranceAssessment>;
  /**
   * ASSURE-REL-01B: ends a non-terminal attempt as inconclusive -- status
   * `failed` with an attributed, self-digested `termination` record. Requires
   * an authenticated reviewer holding `assure.reviewer` in the assessment's
   * organization. It concludes nothing: no control result changes, no
   * evidence is removed, no finding or report is produced. A completed
   * assessment cannot be terminated. Repeating the same termination returns it
   * (`replayed`); a different one is refused. Continue with
   * `requestReassessment` on the ended attempt.
   */
  terminateAssessment(context: AssuranceAccessContext, assessmentId: string, input: TerminateAssessmentInput): Promise<AssuranceAssessmentTerminationResult>;
  buildAssuranceReport(context: AssuranceAccessContext, assessmentId: string, view: string, generatedBy: string): Promise<AssuranceReport>;
  /**
   * ASSURE-REP-01: the commercial `rn.sv@0.1.0` report as a DRAFT or
   * READY_FOR_RELEASE draft -- never released. Reads only; writes nothing.
   */
  buildCommercialReportDraft(context: AssuranceAccessContext, assessmentId: string, request: CommercialReportRequest): Promise<CommercialReportDraft>;
  /**
   * ASSURE-REP-01: releases a READY_FOR_RELEASE draft. Requires an
   * authenticated reviewer holding `assure.report-release` for the assessment's
   * organization, who names the exact content digest approved. The draft is
   * rebuilt from the store, so the approval binds what the store holds now.
   *
   * ASSURE-REL-01A: the release is recorded in the store's custody before it
   * is returned, once per report version. A repeated request by the same
   * approver for the same content returns the release already kept
   * (`custody.outcome: 'replayed'`); any other request for a report version
   * already released is refused (`ASSURANCE_ASSESSMENT_IMMUTABLE`, reason
   * `commercial_release_conflict`).
   *
   * ASSURE-REL-01A-R1: only durable custody can release -- the SQLite Assurance
   * Store this module's factory created. Any other store, the in-memory one
   * included, is refused with `ASSURANCE_STORE_UNAVAILABLE` before an approval
   * is built; drafting and verification still work on it.
   */
  releaseCommercialReport(
    context: AssuranceAccessContext,
    assessmentId: string,
    request: CommercialReportReleaseRequest,
  ): Promise<CommercialReportReleaseResult>;
  /** ASSURE-REL-01A: the release kept for a report version within the caller's organization, or `null`. */
  getCommercialRelease(context: AssuranceAccessContext, reportId: string): Promise<CommercialReleaseCustodyRecord | null>;
  /** ASSURE-REL-01A: every release kept for an assessment the caller can see, oldest first. */
  listCommercialReleases(context: AssuranceAccessContext, assessmentId: string): Promise<readonly CommercialReleaseCustodyRecord[]>;
  /**
   * ASSURE-REL-01A: verifies a delivered package against this Host's own
   * release custody -- the authority is this service's store, never something
   * the caller supplies. Reports package integrity and the authority's answer
   * separately; a match proves the Host recorded that approval, not that a
   * signature exists (`externalSignature` is always
   * `EXTERNAL_SIGNATURE_NOT_AVAILABLE`).
   */
  verifyCommercialRelease(context: AssuranceAccessContext, delivered: CommercialReleasePackage): Promise<CommercialReleaseAuthorityVerification>;
}

/** ASSURE-REL-01A: a release and how custody answered it. Every release returned is kept in durable custody (ASSURE-REL-01A-R1). */
export interface CommercialReportReleaseResult {
  readonly draft: CommercialReportDraft;
  readonly release: CommercialReportRelease;
  readonly custody: {
    /** `committed`: recorded by this call. `replayed`: already in custody; the original record is returned. */
    readonly outcome: 'committed' | 'replayed';
  };
}

export interface AssuranceServiceDependencies {
  readonly store: AssuranceStore;
  readonly registry: AssuranceFrameworkRegistry;
  readonly evidenceSources: AssuranceEvidenceSources;
  readonly telemetry?: EnterpriseTelemetry;
  readonly eventPublisher?: EnterpriseEventPublisher;
  readonly logger?: EnterpriseLogger;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  readonly enterpriseVersion: string;
  /** Live module snapshot captured into assessment provenance (mission section 37). */
  readonly moduleSnapshot?: () => readonly AssuranceModuleSnapshot[];
  readonly allowRetiredFrameworks?: boolean;
  /** ASSURE-SEC-01B: configured Assurance reviewer credentials. Absent or empty: no manual review can be recorded. */
  readonly reviewers?: readonly AssuranceReviewerCredential[];
}

export function createAssuranceService(deps: AssuranceServiceDependencies): AssuranceService {
  const { store, registry, telemetry, eventPublisher, logger, now, nextId } = deps;
  const evaluator = createAssuranceControlEvaluator();
  const reviewerAuthenticator = createAssuranceReviewerAuthenticator(deps.reviewers ?? []);

  function unauthorizedReviewer(message: string, details?: Readonly<Record<string, unknown>>): AssuranceError {
    return new AssuranceError('ASSURANCE_REVIEWER_UNAUTHORIZED', message, details);
  }

  function custodyUnsupported(): AssuranceError {
    return new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', 'This Assurance Store keeps no commercial release custody; a commercial report cannot be released or verified against it.');
  }

  /** ASSURE-REL-01A: the store's release custody. A store without it cannot release: a release is never returned without being kept. */
  function releaseCustody() {
    const { commitCommercialRelease, getCommercialRelease } = store;
    if (commitCommercialRelease === undefined || getCommercialRelease === undefined) throw custodyUnsupported();
    return {
      commit: (context: AssuranceAccessContext, record: CommercialReleaseCustodyRecord) => commitCommercialRelease.call(store, context, record),
      get: (context: AssuranceAccessContext, reportId: string) => getCommercialRelease.call(store, context, reportId),
    };
  }

  /** A request for a report version already in custody: the same approver and content get the kept release back; anything else is refused. */
  function replayOrRefuse(kept: CommercialReleaseCustodyRecord, draft: CommercialReportDraft, approvedBy: string): CommercialReportReleaseResult {
    const conflict = commercialReleaseConflict(kept, { ...draft.manifest, approvedBy });
    if (conflict !== undefined) {
      logger?.warn('assurance.commercial_report.release_conflict', { assessmentId: kept.assessmentId, reportId: kept.reportId, status: 'conflict', errorCode: `release_conflict_${conflict}` });
      throw new AssuranceError(
        'ASSURANCE_ASSESSMENT_IMMUTABLE',
        `Report '${kept.reportId}' was already released ${conflict === 'content' ? 'with different content' : 'by another approver'}; a released report version is never replaced. Issue a new report version for a new approval.`,
        { reason: 'commercial_release_conflict', reportId: kept.reportId, conflict },
      );
    }
    logger?.info('assurance.commercial_report.released', { assessmentId: kept.assessmentId, reportId: kept.reportId, status: 'replayed' });
    return { draft, release: kept.release, custody: { outcome: 'replayed' } };
  }

  function publish(type: AssuranceEnterpriseEventType, fields: { assessmentId?: string; organizationId?: string; subjectId?: string; detail?: Readonly<Record<string, unknown>> }): void {
    if (eventPublisher === undefined) return;
    const eventId = nextId('assurance-event');
    void eventPublisher
      .publish({
        eventId,
        type,
        occurredAt: now(),
        requestId: fields.assessmentId ?? fields.subjectId ?? eventId,
        ...(fields.assessmentId !== undefined ? { assessmentId: fields.assessmentId } : {}),
        ...(fields.organizationId !== undefined ? { organizationId: fields.organizationId } : {}),
        ...(fields.subjectId !== undefined ? { subjectId: fields.subjectId } : {}),
        ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      })
      .catch(() => {});
  }

  function frameworkFor(assessment: AssuranceAssessment): AssuranceFramework {
    return resolveFrameworkForAssessment(registry, assessment.frameworkId, assessment.frameworkVersion, { allowRetired: true });
  }

  /** ASSURE-REP-01: every source of the commercial report, read in `context`'s own scope. */
  async function commercialDraft(context: AssuranceAccessContext, assessmentId: string, request: CommercialReportRequest): Promise<CommercialReportDraft> {
    const assessment = await requireAssessment(context, assessmentId);
    const framework = frameworkFor(assessment);
    const verification = verifyAssuranceAssessment({ assessment, framework, now });
    const findings = await store.listFindings(context, assessmentId);
    const findingEvents = new Map<string, readonly AssuranceFindingEvent[]>();
    for (const finding of findings) findingEvents.set(finding.findingId, await store.listFindingEvents(context, finding.findingId));
    const manualReviews = await store.listManualReviews(context, assessmentId);
    return buildCommercialReportDraft({ assessment, framework, verification, findings, findingEvents, manualReviews, engagement: request?.engagement, issue: request?.issue });
  }

  async function requireAssessment(context: AssuranceAccessContext, assessmentId: string): Promise<AssuranceAssessment> {
    const assessment = await store.getAssessment(context, assessmentId);
    if (assessment === null) {
      throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessmentId}' within this scope.`);
    }
    return assessment;
  }

  function withIntegrity(assessment: AssuranceAssessment): AssuranceAssessment {
    const integrity = computeAssessmentIntegrity({
      assessmentId: assessment.assessmentId,
      assessmentVersion: assessment.assessmentVersion,
      scope: assessment.scope,
      evidenceReferences: assessment.evidenceReferences,
      evidenceResolutions: assessment.evidenceResolutions,
      controlEvaluations: assessment.controlEvaluations,
      findings: assessment.findings,
      domainAssessments: assessment.domainAssessments,
      score: assessment.score,
      eligibility: assessment.eligibility,
      provenanceDigestInput: { ...assessment.provenance },
      createdAt: assessment.createdAt,
      ...(assessment.completedAt !== undefined ? { completedAt: assessment.completedAt } : {}),
    });
    return { ...assessment, integrity };
  }

  function inScopeControls(framework: AssuranceFramework, assessment: AssuranceAssessment) {
    return framework.controls.filter(
      (control) =>
        (assessment.scope.domainIds === undefined || assessment.scope.domainIds.includes(control.domainId)) &&
        (assessment.scope.controlIds === undefined || assessment.scope.controlIds.includes(control.controlId)),
    );
  }

  async function resolveEvidence(
    context: AssuranceAccessContext,
    assessment: AssuranceAssessment,
    framework: AssuranceFramework,
    options?: CollectEvidenceOptions,
  ): Promise<{ resolutions: readonly AssuranceEvidenceResolution[]; references: readonly AssuranceEvidenceReference[] }> {
    const controls = inScopeControls(framework, assessment);
    const requirementIds = [...new Set(controls.flatMap((control) => control.evidenceRequirementIds))];
    const requirements = framework.evidenceRequirements.filter((requirement) => requirementIds.includes(requirement.requirementId));

    const resolver = createAssuranceEvidenceResolver({
      sources: deps.evidenceSources,
      ...(options?.manualEvidence !== undefined ? { manualEvidence: options.manualEvidence } : {}),
      now,
      nextId,
    });

    const resolutions: AssuranceEvidenceResolution[] = [];
    for (const requirement of requirements) {
      const resolution = await resolver.resolve(assessment.scope, requirement, context);
      resolutions.push(resolution);
      telemetry?.recordAssuranceEvidenceResolution(
        resolution.rejectedEvidence.length,
        resolution.contradictions.length,
        resolution.status === 'unsatisfied' || resolution.status === 'unavailable',
      );
      publish('AssuranceEvidenceResolved', {
        assessmentId: assessment.assessmentId,
        organizationId: assessment.subject.organizationId,
        detail: { requirementId: requirement.requirementId, status: resolution.status, accepted: resolution.acceptedEvidence.length, rejected: resolution.rejectedEvidence.length },
      });
    }

    const references = new Map<string, AssuranceEvidenceReference>();
    for (const resolution of resolutions) {
      for (const reference of resolution.acceptedEvidence) references.set(reference.evidenceReferenceId, reference);
    }
    return { resolutions, references: [...references.values()] };
  }

  async function evaluateAllControls(
    context: AssuranceAccessContext,
    assessment: AssuranceAssessment,
    framework: AssuranceFramework,
  ): Promise<readonly AssuranceControlEvaluation[]> {
    const controls = inScopeControls(framework, assessment);
    const metrics = deriveAssuranceMetrics(assessment.evidenceResolutions);
    const manualReviews = await store.listManualReviews(context, assessment.assessmentId);
    const evaluatedAt = now();

    const evaluations: AssuranceControlEvaluation[] = [];
    for (const control of controls) {
      const evaluation = await evaluator.evaluate(control, assessment.scope, assessment.evidenceResolutions, {
        assessmentId: assessment.assessmentId,
        metrics,
        manualReviews,
        scoringModel: framework.scoringModel,
        evaluatedAt,
        nextId,
      });
      evaluations.push(evaluation);
      telemetry?.recordAssuranceControlEvaluated(evaluation.status);
      logger?.info('assurance.control.evaluated', {
        assessmentId: assessment.assessmentId,
        controlId: control.controlId,
        domainId: control.domainId,
        status: evaluation.status,
        evaluatorVersion: evaluation.evaluatorVersion,
      });
      publish('AssuranceControlEvaluated', {
        assessmentId: assessment.assessmentId,
        organizationId: assessment.subject.organizationId,
        detail: { controlId: control.controlId, status: evaluation.status, confidence: evaluation.confidence },
      });
      if (evaluation.status === 'manual_review_required') {
        publish('AssuranceManualReviewRequested', {
          assessmentId: assessment.assessmentId,
          organizationId: assessment.subject.organizationId,
          detail: { controlId: control.controlId, reason: evaluation.manualReview?.reason },
        });
      }
    }
    return evaluations;
  }

  async function saveWithIntegrity(context: AssuranceAccessContext, assessment: AssuranceAssessment): Promise<AssuranceAssessment> {
    const sealed = withIntegrity(assessment);
    await store.saveAssessment(context, sealed);
    return sealed;
  }

  /** ASSURE-SEC-01C: an ambiguous manual evidence set is refused before anything is collected or the assessment changes state. */
  function assertManualEvidenceBindings(framework: AssuranceFramework, options?: CollectEvidenceOptions): void {
    if (options?.manualEvidence === undefined) return;
    const violations = manualEvidenceBindingViolations(
      options.manualEvidence,
      framework.evidenceRequirements.map((requirement) => requirement.requirementId),
      computeDigest,
    );
    if (violations.length > 0) {
      throw new AssuranceError('ASSURANCE_EVIDENCE_INVALID', 'The manually supplied evidence set has ambiguous or unknown requirement bindings.', { violations });
    }
  }

  async function collectEvidenceInternal(context: AssuranceAccessContext, assessmentId: string, options?: CollectEvidenceOptions): Promise<AssuranceAssessment> {
    const assessment = await requireAssessment(context, assessmentId);
    const framework = frameworkFor(assessment);
    assertManualEvidenceBindings(framework, options);
    assertAssessmentTransition(assessment.status, 'collecting_evidence');
    publish('AssuranceEvidenceCollectionStarted', { assessmentId, organizationId: assessment.subject.organizationId });

    const { resolutions, references } = await resolveEvidence(context, assessment, framework, options);
    return saveWithIntegrity(context, {
      ...assessment,
      status: 'collecting_evidence',
      evidenceReferences: references,
      evidenceResolutions: resolutions,
    });
  }

  async function createAssessmentInternal(context: AssuranceAccessContext, input: CreateAssuranceAssessmentInput): Promise<AssuranceAssessment> {
      if (!ASSURANCE_SUBJECT_TYPES.includes(input.subject.subjectType)) {
        throw new AssuranceError('ASSURANCE_SCOPE_INVALID', `Unsupported subject type '${String(input.subject.subjectType)}'.`);
      }
      if (input.subject.subjectId.length === 0 || input.subject.organizationId.length === 0) {
        throw new AssuranceError('ASSURANCE_SCOPE_INVALID', 'subject.subjectId and subject.organizationId are required.');
      }
      if (input.requestedBy.length === 0) {
        throw new AssuranceError('ASSURANCE_SCOPE_INVALID', 'requestedBy is required.');
      }
      if (!context.system && context.organizationId !== input.subject.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', 'A non-system caller may only assess subjects within its own organization.');
      }
      const framework = resolveFrameworkForAssessment(registry, input.frameworkId, input.frameworkVersion, {
        allowRetired: deps.allowRetiredFrameworks === true,
      });
      // Validate scope narrowing against the framework.
      for (const domainId of input.domainIds ?? []) {
        if (!framework.domains.some((domain) => domain.domainId === domainId)) {
          throw new AssuranceError('ASSURANCE_SCOPE_INVALID', `Scope names unknown domainId '${domainId}'.`);
        }
      }
      for (const controlId of input.controlIds ?? []) {
        if (!framework.controls.some((control) => control.controlId === controlId)) {
          throw new AssuranceError('ASSURANCE_CONTROL_NOT_FOUND', `Scope names unknown controlId '${controlId}'.`);
        }
      }

      const createdAt = now();
      const assessmentId = nextId('assurance-assessment');
      const assessment: AssuranceAssessment = withIntegrity({
        assessmentId,
        assessmentVersion: AOC_ASSURANCE_RUNTIME_VERSION,
        subject: input.subject,
        scope: {
          scopeId: nextId('assurance-scope'),
          subject: input.subject,
          frameworkId: framework.frameworkId,
          frameworkVersion: framework.frameworkVersion,
          ...(input.domainIds !== undefined ? { domainIds: input.domainIds } : {}),
          ...(input.controlIds !== undefined ? { controlIds: input.controlIds } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          evidenceCutoffAt: input.evidenceCutoffAt ?? createdAt,
          includeHistoricalEvidence: input.includeHistoricalEvidence ?? true,
          requestedBy: input.requestedBy,
          requestedAt: createdAt,
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        },
        frameworkId: framework.frameworkId,
        frameworkVersion: framework.frameworkVersion,
        status: 'created',
        evidenceReferences: [],
        evidenceResolutions: [],
        controlEvaluations: [],
        findings: [],
        domainAssessments: [],
        score: emptyAssuranceScore(framework.scoringModel.methodologyId, framework.scoringModel.methodologyVersion, createdAt),
        eligibility: [],
        provenance: {
          requestedBy: input.requestedBy,
          organizationId: input.subject.organizationId,
          frameworkId: framework.frameworkId,
          frameworkVersion: framework.frameworkVersion,
          evidenceCutoffAt: input.evidenceCutoffAt ?? createdAt,
          evaluatorVersion: ASSURANCE_EVALUATOR_VERSION,
          scoringVersion: ASSURANCE_SCORING_VERSION,
          eligibilityVersion: ASSURANCE_ELIGIBILITY_VERSION,
          enterpriseVersion: deps.enterpriseVersion,
          kernelVersion: AOC_KERNEL_VERSION,
          governanceStoreVersion: AOC_GOVERNANCE_STORE_VERSION,
          evidenceRuntimeVersion: AOC_EVIDENCE_BUNDLE_VERSION,
          passportRuntimeVersion: AOC_AGENT_PASSPORT_RUNTIME_VERSION,
          moduleSnapshot: deps.moduleSnapshot?.() ?? [],
          createdAt,
        },
        integrity: {
          algorithm: 'sha256',
          canonicalizationVersion: 'aoc.canonical-json.v1',
          scopeDigest: '',
          evidenceDigest: '',
          controlEvaluationsDigest: '',
          findingsDigest: '',
          domainAssessmentsDigest: '',
          scoreDigest: '',
          eligibilityDigest: '',
          assessmentDigest: '',
        },
        createdAt,
      });

      await store.saveAssessment(context, assessment);
      telemetry?.recordAssuranceAssessmentCreated();
      logger?.info('assurance.assessment.created', {
        assessmentId,
        frameworkId: framework.frameworkId,
        frameworkVersion: framework.frameworkVersion,
        subjectId: input.subject.subjectId,
        subjectType: input.subject.subjectType,
      });
      publish('AssuranceAssessmentCreated', {
        assessmentId,
        organizationId: input.subject.organizationId,
        subjectId: input.subject.subjectId,
        detail: { frameworkId: framework.frameworkId, frameworkVersion: framework.frameworkVersion },
      });
      return assessment;
  }

  return {
    async createAssessment(context, input) {
      return createAssessmentInternal(context, input);
    },

    async collectEvidence(context, assessmentId, options) {
      return collectEvidenceInternal(context, assessmentId, options);
    },

    async evaluateControl(context, assessmentId, controlId) {
      const assessment = await requireAssessment(context, assessmentId);
      const framework = frameworkFor(assessment);
      const control = framework.controls.find((candidate) => candidate.controlId === controlId);
      if (control === undefined) {
        throw new AssuranceError('ASSURANCE_CONTROL_NOT_FOUND', `Framework '${framework.frameworkId}@${framework.frameworkVersion}' defines no control '${controlId}'.`);
      }
      const metrics = deriveAssuranceMetrics(assessment.evidenceResolutions);
      const manualReviews = await store.listManualReviews(context, assessmentId);
      return evaluator.evaluate(control, assessment.scope, assessment.evidenceResolutions, {
        assessmentId,
        metrics,
        manualReviews,
        scoringModel: framework.scoringModel,
        evaluatedAt: now(),
        nextId,
      });
    },

    async evaluateAssessment(context, assessmentId, options) {
      let assessment = await requireAssessment(context, assessmentId);
      const framework = frameworkFor(assessment);
      if (assessment.status === 'created') assertManualEvidenceBindings(framework, options);

      try {
        if (assessment.status === 'created') {
          assessment = await collectEvidenceInternal(context, assessmentId, options);
        }
        assertAssessmentTransition(assessment.status, 'evaluating');
        assessment = { ...assessment, status: 'evaluating' };

        const evaluations = await evaluateAllControls(context, assessment, framework);
        const findings = deriveFindingsFromEvaluations({ framework, evaluations, assessmentId, nextId, now });
        for (const finding of findings) {
          telemetry?.recordAssuranceFindingCreated(finding.severity);
          publish('AssuranceFindingCreated', {
            assessmentId,
            organizationId: assessment.subject.organizationId,
            detail: { findingId: finding.findingId, controlId: finding.controlId, severity: finding.severity, findingType: finding.findingType },
          });
        }

        const evaluatedAt = now();
        const domainAssessments = computeDomainAssessments({ framework, evaluations, findings, assessmentId, nextId, evaluatedAt });
        for (const domain of domainAssessments) {
          logger?.info('assurance.domain.evaluated', { assessmentId, domainId: domain.domainId, status: domain.status, normalizedScore: domain.normalizedScore });
          publish('AssuranceDomainEvaluated', {
            assessmentId,
            organizationId: assessment.subject.organizationId,
            detail: { domainId: domain.domainId, status: domain.status, normalizedScore: domain.normalizedScore },
          });
        }
        const score = computeOverallScore({ framework, domainAssessments, calculatedAt: evaluatedAt });
        publish('AssuranceScoreCalculated', {
          assessmentId,
          organizationId: assessment.subject.organizationId,
          detail: { normalizedScore: score.normalizedScore, methodologyId: score.methodologyId, methodologyVersion: score.methodologyVersion },
        });

        const eligibility: AssuranceEligibilityResult[] = framework.eligibilityProfiles.map((profile) => {
          const result = evaluateEligibility({
            framework,
            profile,
            scope: assessment.scope,
            score,
            domainAssessments,
            controlEvaluations: evaluations,
            findings,
            evidenceReferences: assessment.evidenceReferences,
            evaluatedAt,
          });
          telemetry?.recordAssuranceEligibilityEvaluated(result.eligible ? 'pass' : result.provisional ? 'provisional' : 'fail');
          publish('AssuranceEligibilityEvaluated', {
            assessmentId,
            organizationId: assessment.subject.organizationId,
            detail: { profileId: profile.profileId, eligible: result.eligible, provisional: result.provisional, reasonCodes: result.reasonCodes },
          });
          return result;
        });

        const pendingManualReview = evaluations.some((evaluation) => evaluation.status === 'manual_review_required');
        return await saveWithIntegrity(context, {
          ...assessment,
          status: pendingManualReview ? 'manual_review' : 'evaluating',
          controlEvaluations: evaluations,
          findings,
          domainAssessments,
          score,
          eligibility,
        });
      } catch (error) {
        if (isAssuranceError(error) && (error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE' || error.code === 'ASSURANCE_ASSESSMENT_NOT_FOUND')) throw error;
        // Evaluation infrastructure failure: record the failed assessment
        // (best-effort) so the lifecycle is honest, then rethrow.
        telemetry?.recordAssuranceAssessmentFailed();
        publish('AssuranceAssessmentFailed', { assessmentId, organizationId: assessment.subject.organizationId, detail: { reason: error instanceof Error ? error.message : 'unknown' } });
        await saveWithIntegrity(context, { ...assessment, status: 'failed', failureReason: error instanceof Error ? error.message : 'Unknown evaluation failure.' }).catch(() => {});
        throw error;
      }
    },

    async completeAssessment(context, assessmentId) {
      const assessment = await requireAssessment(context, assessmentId);
      const framework = frameworkFor(assessment);
      assertAssessmentTransition(assessment.status, 'completed');

      const pendingManualReview = assessment.controlEvaluations.some((evaluation) => evaluation.status === 'manual_review_required');
      if (pendingManualReview && framework.scoringModel.manualReviewPolicy !== 'provisional') {
        throw new AssuranceError(
          'ASSURANCE_MANUAL_REVIEW_REQUIRED',
          `Assessment '${assessmentId}' has unresolved manual reviews and framework '${framework.frameworkId}@${framework.frameworkVersion}' does not allow a provisional completion.`,
        );
      }
      if (assessment.controlEvaluations.length === 0) {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `Assessment '${assessmentId}' has not been evaluated; call evaluateAssessment first.`);
      }

      const completedAt = now();
      const completed = withIntegrity({ ...assessment, status: 'completed', completedAt });
      // Findings become append-only lifecycle histories at completion: each opens with one event.
      const findingEvents = completed.findings.map((finding) =>
        buildFindingEvent({
          findingEventId: nextId('assurance-finding-event'),
          findingId: finding.findingId,
          assessmentId,
          organizationId: completed.subject.organizationId,
          eventType: 'AssuranceFindingCreated',
          sequence: 1,
          actorId: completed.provenance.requestedBy,
          occurredAt: completedAt,
        }),
      );

      // Whether this completion supersedes the prior assessment, or that one was already superseded (observability only).
      const supersedesCompleted =
        completed.supersedesAssessmentId !== undefined && (await store.getAssessment(context, completed.supersedesAssessmentId))?.status === 'completed';

      // ASSURE-SEC-01E: the completion, every opening event and the supersession
      // of a replaced assessment persist as one unit, or not at all. A failure
      // is reported, never swallowed, and leaves the assessment completable.
      try {
        await store.completeAssessment(context, { assessment: completed, findingEvents });
      } catch (error) {
        const failure =
          error instanceof AssuranceError
            ? error
            : new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', `Assessment '${assessmentId}' could not be completed: the Assurance Store reported a failure while persisting the completion.`, { assessmentId });
        logger?.warn('assurance.assessment.completion_failed', { assessmentId, errorCode: failure.code });
        throw failure;
      }

      // Reassessment supersession (mission section 40): the prior assessment
      // was marked superseded in the same unit, now that its replacement is complete.
      if (completed.supersedesAssessmentId !== undefined && supersedesCompleted) {
        publish('AssuranceAssessmentSuperseded', {
          assessmentId: completed.supersedesAssessmentId,
          organizationId: completed.subject.organizationId,
          detail: { supersededBy: assessmentId },
        });
      }

      const durationMs = Date.parse(completedAt) - Date.parse(completed.createdAt);
      telemetry?.recordAssuranceAssessmentCompleted(Number.isNaN(durationMs) ? 0 : Math.max(durationMs, 0));
      logger?.info('assurance.assessment.completed', {
        assessmentId,
        frameworkId: completed.frameworkId,
        frameworkVersion: completed.frameworkVersion,
        normalizedScore: completed.score.normalizedScore,
        findingCount: completed.findings.length,
      });
      publish('AssuranceAssessmentCompleted', {
        assessmentId,
        organizationId: completed.subject.organizationId,
        subjectId: completed.subject.subjectId,
        detail: { normalizedScore: completed.score.normalizedScore, findings: completed.findings.length },
      });
      return completed;
    },

    async getAssessment(context, assessmentId) {
      return store.getAssessment(context, assessmentId);
    },

    async queryAssessments(context, query) {
      return store.queryAssessments(context, query);
    },

    async verifyAssessment(context, assessmentId) {
      const assessment = await requireAssessment(context, assessmentId);
      const framework = registry.get(assessment.frameworkId, assessment.frameworkVersion);
      const result = verifyAssuranceAssessment({ assessment, ...(framework !== undefined ? { framework } : {}), now });
      telemetry?.recordAssuranceVerification(result.valid);
      return result;
    },

    async listFindings(context, assessmentId) {
      return store.listFindings(context, assessmentId);
    },

    async appendFindingEvent(context, input) {
      const finding = await store.getFinding(context, input.findingId);
      if (finding === null) {
        throw new AssuranceError('ASSURANCE_FINDING_NOT_FOUND', `No Assurance finding for findingId '${input.findingId}' within this scope.`);
      }
      if (input.actorId.length === 0) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', 'actorId is required for finding events; finding history is attributable.');
      }
      const assessment = await requireAssessment(context, finding.assessmentId);
      const existing = await store.listFindingEvents(context, input.findingId);
      const event = buildFindingEvent({
        findingEventId: nextId('assurance-finding-event'),
        findingId: input.findingId,
        assessmentId: finding.assessmentId,
        organizationId: assessment.subject.organizationId,
        eventType: input.eventType,
        sequence: existing.length + 1,
        actorId: input.actorId,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        occurredAt: now(),
      });
      await store.appendFindingEvent(context, event);
      if (input.eventType === 'AssuranceFindingClosed') telemetry?.recordAssuranceFindingClosed();
      return event;
    },

    authenticateReviewer(bearerToken) {
      return reviewerAuthenticator.authenticate(bearerToken);
    },

    async recordManualReview(context, input) {
      // -- Authenticated reviewer identity (ASSURE-SEC-01B). Identity, tenant
      // and roles come only from a principal this service's authenticator
      // issued; `system`, `actorId`, `roles` and body fields grant nothing.
      const reviewer = context.reviewer;
      if (!reviewerAuthenticator.isAuthenticated(reviewer)) {
        throw unauthorizedReviewer('A manual review requires an authenticated Assurance reviewer credential; caller-declared identity, roles or a system context are not accepted.');
      }
      if (context.organizationId !== undefined && context.organizationId !== reviewer.organizationId) {
        throw unauthorizedReviewer('The access context names a different organization than the authenticated reviewer.');
      }
      if (context.actorId !== undefined && context.actorId !== reviewer.reviewerId) {
        throw unauthorizedReviewer('The access context names a different actor than the authenticated reviewer.');
      }
      if (input.reviewerId !== undefined && input.reviewerId !== reviewer.reviewerId) {
        throw unauthorizedReviewer('The declared reviewerId is not the authenticated reviewer; a review cannot be attributed to someone else.');
      }
      if (input.reviewerRole !== undefined && !reviewer.roles.includes(input.reviewerRole)) {
        throw unauthorizedReviewer(`The authenticated reviewer does not hold the declared role '${input.reviewerRole}'.`);
      }
      if (input.rationale.trim().length === 0) {
        throw new AssuranceError('ASSURANCE_MANUAL_REVIEW_INVALID', 'rationale is required for a manual review.');
      }
      // Every read and the write below run in the reviewer's own tenant scope.
      const reviewerContext: AssuranceAccessContext = { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
      const assessment = await requireAssessment(reviewerContext, input.assessmentId);
      if (assessment.subject.organizationId !== reviewer.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', 'The authenticated reviewer is not authorized for this assessment\u2019s organization.');
      }
      const framework = frameworkFor(assessment);
      const control = framework.controls.find((candidate) => candidate.controlId === input.controlId);
      if (control === undefined) {
        throw new AssuranceError('ASSURANCE_CONTROL_NOT_FOUND', `Framework '${framework.frameworkId}@${framework.frameworkVersion}' defines no control '${input.controlId}'.`);
      }
      let reviewerRole = input.reviewerRole;
      if (control.criteria.type === 'manual_review') {
        const requiredRole = control.criteria.requiredReviewerRole;
        if (requiredRole !== undefined) {
          if (!reviewer.roles.includes(requiredRole)) {
            throw unauthorizedReviewer(`Control '${input.controlId}' requires a reviewer with role '${requiredRole}', which the authenticated reviewer does not hold.`, {
              requiredReviewerRole: requiredRole,
            });
          }
          if (input.reviewerRole !== undefined && input.reviewerRole !== requiredRole) {
            throw unauthorizedReviewer(`Control '${input.controlId}' is reviewed under role '${requiredRole}', not the declared '${input.reviewerRole}'.`, { requiredReviewerRole: requiredRole });
          }
          reviewerRole = requiredRole;
        }
        // Evidence-bound conclusions (ASSURE-SEC-01A): validated before anything is persisted.
        const evidenceCheck = checkManualReviewEvidence({
          control,
          criteria: control.criteria,
          outcome: input.outcome,
          citedEvidenceReferenceIds: input.evidenceReferenceIds ?? [],
          resolutions: assessment.evidenceResolutions,
          organizationId: assessment.subject.organizationId,
        });
        if (!evidenceCheck.valid) {
          throw new AssuranceError('ASSURANCE_MANUAL_REVIEW_INVALID', evidenceCheck.message ?? `Control '${input.controlId}' review is not supported by bound evidence.`, {
            policy: evidenceCheck.policy,
            ...(evidenceCheck.violation !== undefined ? { violation: evidenceCheck.violation } : {}),
          });
        }
      }

      const reviewedAt = now();
      const reviewId = nextId('assurance-review');
      const base = {
        reviewId,
        assessmentId: input.assessmentId,
        controlId: input.controlId,
        reviewerId: reviewer.reviewerId,
        ...(reviewerRole !== undefined ? { reviewerRole } : {}),
        outcome: input.outcome,
        rationale: input.rationale,
        evidenceReferenceIds: input.evidenceReferenceIds ?? [],
        reviewedAt,
        reviewerAuthentication: 'assurance_reviewer_credential' as const,
      };
      const review: AssuranceManualReviewRecord = { ...base, reviewDigest: computeDigest(base) };
      await store.appendManualReview(reviewerContext, review);
      publish('AssuranceManualReviewCompleted', {
        assessmentId: input.assessmentId,
        organizationId: assessment.subject.organizationId,
        detail: {
          reviewId,
          controlId: input.controlId,
          outcome: input.outcome,
          reviewerId: review.reviewerId,
          ...(review.reviewerRole !== undefined ? { reviewerRole: review.reviewerRole } : {}),
          reviewerAuthentication: review.reviewerAuthentication,
        },
      });
      return review;
    },

    async evaluateEligibility(context, assessmentId) {
      const assessment = await requireAssessment(context, assessmentId);
      // ASSURE-REL-01B: a failed or ended attempt concluded nothing; its provisional eligibility is not reported as if it had.
      if (assessment.status === 'failed') {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `Assessment '${assessmentId}' is failed${assessment.termination !== undefined ? ' (ended as inconclusive)' : ''}; it has no eligibility.`);
      }
      if (assessment.controlEvaluations.length === 0) {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `Assessment '${assessmentId}' has not been evaluated; eligibility derives from control results.`);
      }
      return assessment.eligibility;
    },

    async processSignal(context, input) {
      const signal: AssuranceSignal = buildAssuranceSignal({
        signalId: 'signalId' in input && typeof input.signalId === 'string' ? input.signalId : nextId('assurance-signal'),
        ...input,
      });
      if (!context.system && context.organizationId !== signal.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `The caller is not authorized to submit Assurance signals for organization '${signal.organizationId}'.`);
      }
      await store.appendSignal(context, signal);
      telemetry?.recordAssuranceSignalReceived();
      publish('AssuranceSignalReceived', {
        organizationId: signal.organizationId,
        subjectId: signal.subjectId,
        detail: { signalId: signal.signalId, signalType: signal.signalType, severity: signal.severity },
      });

      const outcomes = ASSURANCE_SIGNAL_OUTCOMES[signal.signalType];
      const affectedAssessmentIds: string[] = [];
      const detail: string[] = [`Signal '${signal.signalType}' recorded with severity '${signal.severity}'.`];

      // The latest completed assessment for the subject is what a signal may
      // affect -- historical assessments themselves stay immutable.
      const completedQuery = await store.queryAssessments(context, { subjectId: signal.subjectId, status: 'completed', limit: 1 });
      const latestSummary = completedQuery.assessments[0];
      const latest = latestSummary !== undefined ? await store.getAssessment(context, latestSummary.assessmentId) : null;

      if (latest !== null) {
        affectedAssessmentIds.push(latest.assessmentId);
        if (outcomes.includes('mark_assessment_stale')) {
          telemetry?.recordAssuranceAssessmentMarkedStale();
          detail.push(`Assessment '${latest.assessmentId}' is now derived stale (the stored assessment is unchanged).`);
          publish('AssuranceAssessmentMarkedStale', {
            assessmentId: latest.assessmentId,
            organizationId: signal.organizationId,
            subjectId: signal.subjectId,
            detail: { signalId: signal.signalId, signalType: signal.signalType },
          });
        }
        if (outcomes.includes('open_finding')) {
          const controlId = signal.affectedControlIds[0] ?? 'unspecified';
          const finding: AssuranceFinding = {
            findingId: nextId('assurance-finding'),
            assessmentId: latest.assessmentId,
            controlId,
            domainId: signal.affectedDomainIds[0] ?? 'unspecified',
            findingType: 'evidence_gap',
            severity: signal.severity === 'informational' ? 'low' : signal.severity,
            status: 'open',
            title: `Continuous Assurance signal: ${signal.signalType}`,
            description: `Signal '${signal.signalId}' (${signal.signalType}) reported a condition affecting control '${controlId}' after assessment completion.`,
            reasonCodes: [`SIGNAL_${signal.signalType.toUpperCase()}`],
            evidenceReferenceIds: [],
            remediation: {
              objective: 'Restore the evidence or condition the signal reported as degraded.',
              recommendedActions: ['Investigate the signal source and re-collect evidence via reassessment.'],
              requiredEvidence: [`Fresh evidence for control '${controlId}'.`],
              priority: signal.severity === 'critical' ? 'immediate' : 'high',
            },
            createdAt: now(),
          };
          await store.saveFinding(context, finding);
          const event = buildFindingEvent({
            findingEventId: nextId('assurance-finding-event'),
            findingId: finding.findingId,
            assessmentId: latest.assessmentId,
            organizationId: signal.organizationId,
            eventType: 'AssuranceFindingCreated',
            sequence: 1,
            actorId: 'aoc.assurance.signal-processor',
            payload: { signalId: signal.signalId },
            occurredAt: now(),
          });
          await store.appendFindingEvent(context, event);
          telemetry?.recordAssuranceFindingCreated(finding.severity);
          detail.push(`Opened finding '${finding.findingId}' on assessment '${latest.assessmentId}'.`);
        }
        if (outcomes.includes('reopen_finding')) {
          const findingId = typeof signal.payload.findingId === 'string' ? signal.payload.findingId : undefined;
          if (findingId !== undefined) {
            const events = await store.listFindingEvents(context, findingId);
            const event = buildFindingEvent({
              findingEventId: nextId('assurance-finding-event'),
              findingId,
              assessmentId: latest.assessmentId,
              organizationId: signal.organizationId,
              eventType: 'AssuranceFindingReopened',
              sequence: events.length + 1,
              actorId: 'aoc.assurance.signal-processor',
              payload: { signalId: signal.signalId },
              occurredAt: now(),
            });
            await store.appendFindingEvent(context, event);
            detail.push(`Reopened finding '${findingId}'.`);
          }
        }
        if (outcomes.includes('request_reassessment')) {
          telemetry?.recordAssuranceReassessmentRequested();
          detail.push(`Reassessment of '${latest.assessmentId}' is recommended; the Runtime records the recommendation but never runs it automatically.`);
          publish('AssuranceReassessmentRequested', {
            assessmentId: latest.assessmentId,
            organizationId: signal.organizationId,
            subjectId: signal.subjectId,
            detail: { signalId: signal.signalId, signalType: signal.signalType },
          });
        }
        if (outcomes.includes('change_eligibility')) {
          detail.push(`Eligibility derived from assessment '${latest.assessmentId}' is suspended pending reassessment (the stored eligibility results are unchanged).`);
        }
        if (outcomes.includes('require_manual_review')) {
          detail.push('Manual review is required before the subject can be reassessed as current.');
        }
      } else {
        detail.push('No completed assessment exists for this subject; the signal is recorded for the next assessment.');
      }

      return {
        signalId: signal.signalId,
        outcomes,
        affectedAssessmentIds,
        detail: detail.join(' '),
        processedAt: now(),
      };
    },

    async getContinuousState(context, subjectId, frameworkId, frameworkVersion) {
      const query = await store.queryAssessments(context, {
        subjectId,
        ...(frameworkId !== undefined ? { frameworkId } : {}),
        ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
        status: 'completed',
        limit: 1,
      });
      const latestSummary = query.assessments[0];
      const latest = latestSummary !== undefined ? await store.getAssessment(context, latestSummary.assessmentId) : null;
      const signals = await store.listSignals(context, { subjectId });
      const openFindings = latest !== null ? (await store.listFindings(context, latest.assessmentId)).filter((finding) => finding.status === 'open') : [];
      return deriveContinuousAssuranceState({
        subjectId,
        frameworkId: frameworkId ?? latest?.frameworkId ?? 'unknown',
        frameworkVersion: frameworkVersion ?? latest?.frameworkVersion ?? 'unknown',
        ...(latest !== null ? { latestCompletedAssessment: latest } : {}),
        openFindings,
        signals,
        now,
      });
    },

    async requestReassessment(context, input) {
      let assessmentId = input.assessmentId;
      if (assessmentId === undefined) {
        if (input.subjectId === undefined) {
          throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', 'requestReassessment requires an assessmentId or a subjectId.');
        }
        const latest = await store.queryAssessments(context, { subjectId: input.subjectId, status: 'completed', limit: 1 });
        const summary = latest.assessments[0];
        if (summary === undefined) {
          throw new AssuranceError('ASSURANCE_SUBJECT_NOT_FOUND', `No completed Assurance assessment exists for subject '${input.subjectId}' within this scope.`);
        }
        assessmentId = summary.assessmentId;
      }
      const previous = await requireAssessment(context, assessmentId);
      // ASSURE-REL-01B: an attempt ended as inconclusive is followed, never superseded.
      const followsTermination = previous.status === 'failed' && previous.termination !== undefined;
      if (!followsTermination && previous.status !== 'completed' && previous.status !== 'superseded') {
        throw new AssuranceError(
          'ASSURANCE_ASSESSMENT_INCOMPLETE',
          `Only a completed assessment, or an attempt ended as inconclusive, can be reassessed; '${assessmentId}' is '${previous.status}'.`,
        );
      }
      if (followsTermination && assessmentTerminationViolations(previous).length > 0) {
        throw new AssuranceError('ASSURANCE_INTEGRITY_FAILED', `The termination record of '${assessmentId}' does not verify; it cannot be continued.`);
      }
      if (input.reason.trim().length === 0) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', 'A reassessment reason is required.');
      }
      const created = await createAssessmentInternal(context, {
        subject: previous.subject,
        frameworkId: previous.frameworkId,
        frameworkVersion: previous.frameworkVersion,
        ...(previous.scope.domainIds !== undefined ? { domainIds: previous.scope.domainIds } : {}),
        ...(previous.scope.controlIds !== undefined ? { controlIds: previous.scope.controlIds } : {}),
        ...(previous.scope.from !== undefined ? { from: previous.scope.from } : {}),
        ...(input.evidenceCutoffAt !== undefined ? { evidenceCutoffAt: input.evidenceCutoffAt } : {}),
        includeHistoricalEvidence: previous.scope.includeHistoricalEvidence,
        requestedBy: input.requestedBy,
        ...(previous.scope.purpose !== undefined ? { purpose: previous.scope.purpose } : {}),
      });
      telemetry?.recordAssuranceReassessmentRequested();
      const reassessment = withIntegrity({
        ...created,
        previousAssessmentId: previous.assessmentId,
        ...(followsTermination ? {} : { supersedesAssessmentId: previous.assessmentId }),
        reassessmentReason: input.reason,
      });
      await store.saveAssessment(context, reassessment);
      publish('AssuranceReassessmentRequested', {
        assessmentId: reassessment.assessmentId,
        organizationId: previous.subject.organizationId,
        subjectId: previous.subject.subjectId,
        detail: { previousAssessmentId: previous.assessmentId, reason: input.reason, ...(followsTermination ? { followsTerminatedAttempt: true } : {}) },
      });
      return reassessment;
    },

    async terminateAssessment(context, assessmentId, input) {
      // -- Authenticated reviewer identity (as recordManualReview): identity, tenant and role from the credential only.
      const reviewer = context.reviewer;
      if (!reviewerAuthenticator.isAuthenticated(reviewer)) {
        throw unauthorizedReviewer('Ending an assessment requires an authenticated Assurance reviewer credential; a system context or declared identity is not accepted.');
      }
      if (!reviewer.roles.includes(ASSURANCE_TERMINATION_ROLE)) {
        throw unauthorizedReviewer(`Ending an assessment requires the role '${ASSURANCE_TERMINATION_ROLE}'.`, { requiredRole: ASSURANCE_TERMINATION_ROLE });
      }
      if (context.organizationId !== undefined && context.organizationId !== reviewer.organizationId) {
        throw unauthorizedReviewer('The access context names a different organization than the authenticated reviewer.');
      }
      if (context.actorId !== undefined && context.actorId !== reviewer.reviewerId) {
        throw unauthorizedReviewer('The access context names a different actor than the authenticated reviewer.');
      }
      if (!ASSURANCE_TERMINATION_REASON_CODES.includes(input?.reasonCode)) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `reasonCode must be one of ${ASSURANCE_TERMINATION_REASON_CODES.join(', ')}.`);
      }
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
      if (rationale.length === 0 || rationale.length > ASSURANCE_TERMINATION_RATIONALE_MAX_LENGTH) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `A termination rationale of 1 to ${ASSURANCE_TERMINATION_RATIONALE_MAX_LENGTH} characters is required.`);
      }
      const reviewerContext: AssuranceAccessContext = { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
      const request = { reasonCode: input.reasonCode, rationale, terminatedBy: reviewer.reviewerId };

      // An attempt already ended: the same termination is a replay; anything else is refused.
      const answerKept = (kept: AssuranceAssessment): AssuranceAssessmentTerminationResult => {
        if (kept.termination !== undefined && isSameTermination(kept.termination, request)) {
          logger?.info('assurance.assessment.terminated', { assessmentId, status: 'replayed', errorCode: kept.termination.reasonCode });
          return { assessment: kept, outcome: 'replayed' };
        }
        throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Assessment '${assessmentId}' is '${kept.status}' and can no longer be ended${kept.termination !== undefined ? ' differently' : ''}.`, {
          reason: kept.termination !== undefined ? 'assessment_already_terminated' : 'assessment_terminal',
        });
      };
      const assessment = await requireAssessment(reviewerContext, assessmentId);
      if (ASSURANCE_TERMINAL_STATUSES.includes(assessment.status)) return answerKept(assessment);
      assertAssessmentTransition(assessment.status, 'failed');
      if (input.reasonCode === 'unresolved_contradiction' && unresolvedContradictions(assessment).length === 0) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `Assessment '${assessmentId}' holds no contradictory evidence; 'unresolved_contradiction' cannot be recorded for it.`);
      }
      const termination = buildAssessmentTermination({ assessment, reasonCode: input.reasonCode, rationale, terminatedBy: reviewer.reviewerId, terminatedAt: now() });
      // Content and its digests are untouched: only the lifecycle status and the termination record change.
      const terminated: AssuranceAssessment = { ...assessment, status: 'failed', failureReason: `Ended as inconclusive (${input.reasonCode}).`, termination };
      try {
        await store.saveAssessment(reviewerContext, terminated);
      } catch (error) {
        // Another writer ended or completed it first (the store took the write lock and saw it terminal): answer from what is stored.
        if (isAssuranceError(error) && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE') return answerKept(await requireAssessment(reviewerContext, assessmentId));
        throw error;
      }
      publish('AssuranceAssessmentFailed', {
        assessmentId,
        organizationId: assessment.subject.organizationId,
        detail: { termination: input.reasonCode, terminatedBy: reviewer.reviewerId, outcome: 'inconclusive' },
      });
      logger?.info('assurance.assessment.terminated', { assessmentId, status: 'terminated', errorCode: input.reasonCode });
      return { assessment: terminated, outcome: 'terminated' };
    },

    async buildAssuranceReport(context, assessmentId, view, generatedBy) {
      if (!isAssuranceReportView(view)) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `Unsupported report view '${view}'; expected one of INTERNAL, AUDITOR, CUSTOMER, PUBLIC.`);
      }
      const assessment = await requireAssessment(context, assessmentId);
      const framework = frameworkFor(assessment);
      return buildAssuranceReport({ assessment, framework, view: view as AssuranceReportView, generatedBy, now, nextId });
    },

    async buildCommercialReportDraft(context, assessmentId, request) {
      return commercialDraft(context, assessmentId, request);
    },

    async releaseCommercialReport(context, assessmentId, request) {
      const approver = context.reviewer;
      if (!reviewerAuthenticator.isAuthenticated(approver)) {
        throw unauthorizedReviewer('Releasing a commercial report requires an authenticated Assurance reviewer credential; a system context or declared identity is not accepted.');
      }
      if (!approver.roles.includes(COMMERCIAL_REPORT_RELEASE_ROLE)) {
        throw unauthorizedReviewer(`Releasing a commercial report requires the role '${COMMERCIAL_REPORT_RELEASE_ROLE}'.`, { requiredRole: COMMERCIAL_REPORT_RELEASE_ROLE });
      }
      if (context.organizationId !== undefined && context.organizationId !== approver.organizationId) {
        throw unauthorizedReviewer('The access context names a different organization than the authenticated approver.');
      }
      // ASSURE-REL-01A-R1: no approval is built for custody that would not survive a restart.
      if (!providesDurableReleaseCustody(store)) {
        throw new AssuranceError(
          'ASSURANCE_STORE_UNAVAILABLE',
          'A commercial report can be released only into durable release custody, which this Assurance Store does not provide. Nothing was released.',
        );
      }
      const custody = releaseCustody();
      const approverContext: AssuranceAccessContext = { system: false, organizationId: approver.organizationId, actorId: approver.reviewerId, roles: approver.roles, reviewer: approver };
      const draft = await commercialDraft(approverContext, assessmentId, request);
      if (draft.content.readiness.status !== 'READY_FOR_RELEASE') {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `The commercial report for '${assessmentId}' is not ready for release.`, {
          failedChecks: draft.content.readiness.checks.filter((entry) => !entry.passed).map((entry) => entry.check),
        });
      }
      if (request.approvedContentDigest !== draft.manifest.contentDigest) {
        throw new AssuranceError('ASSURANCE_INTEGRITY_FAILED', 'The approved content digest does not match the report the store produces now; review the current draft and approve its digest.');
      }
      if (request.acknowledgements?.limitationsReviewed !== true || request.acknowledgements?.commercialUseRestrictionAcknowledged !== true) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', 'A release must acknowledge the reviewed limitations and the framework’s commercial-use restriction.');
      }
      // A release already kept for this report version answers the request before
      // anything is written: an idempotent retry gets the original record, even
      // after the issue date; anything else is refused.
      const kept = await custody.get(approverContext, draft.content.reportId);
      if (kept !== null) return replayOrRefuse(kept, draft, approver.reviewerId);
      const approvedAt = now();
      if (approvedAt.slice(0, 10) > draft.content.cover.issuedOn) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `A report dated ${draft.content.cover.issuedOn} cannot be approved after its issue date; draft it again with the current issue date.`);
      }
      const release = buildCommercialReportRelease(draft, {
        approvedBy: approver.reviewerId,
        approverRole: COMMERCIAL_REPORT_RELEASE_ROLE,
        approvedAt,
        acknowledgements: { limitationsReviewed: true, commercialUseRestrictionAcknowledged: true },
      });
      // The organization is the stored assessment's, through the approver's own scope; the approver is the credential's.
      const record = buildCommercialReleaseCustodyRecord({ organizationId: approver.organizationId, manifest: draft.manifest, release });
      const commit = await custody.commit(approverContext, record);
      // Another release for this report version won the write (a concurrent request): answer as that one dictates.
      if (commit.outcome === 'existing') return replayOrRefuse(commit.record, draft, approver.reviewerId);
      logger?.info('assurance.commercial_report.released', { assessmentId, reportId: record.reportId, status: 'committed' });
      return { draft, release: commit.record.release, custody: { outcome: 'committed' } };
    },

    async getCommercialRelease(context, reportId) {
      requireAssuranceTenantScope(context);
      return releaseCustody().get(context, reportId);
    },

    async listCommercialReleases(context, assessmentId) {
      await requireAssessment(context, assessmentId);
      const list = store.listCommercialReleases;
      if (list === undefined) throw custodyUnsupported();
      return list.call(store, context, assessmentId);
    },

    async verifyCommercialRelease(context, delivered) {
      requireAssuranceTenantScope(context);
      const reportId: unknown = delivered?.manifest?.reportId;
      let lookup: CommercialReleaseAuthorityLookup;
      if (typeof reportId !== 'string' || reportId.length === 0) {
        lookup = { kind: 'absent' };
      } else {
        try {
          const record = await releaseCustody().get(context, reportId);
          lookup = record === null ? { kind: 'absent' } : { kind: 'record', record };
        } catch (error) {
          lookup = { kind: 'unavailable', code: isAssuranceError(error) ? error.code : 'ASSURANCE_STORE_UNAVAILABLE' };
        }
      }
      const currentlyAuthorized =
        lookup.kind === 'record' ? reviewerAuthenticator.isCurrentlyAuthorized(lookup.record.release.approvedBy, lookup.record.organizationId, COMMERCIAL_REPORT_RELEASE_ROLE) : undefined;
      const verification = verifyCommercialReleaseAgainstCustody(delivered, lookup, currentlyAuthorized);
      if (!verification.releaseAuthenticated) {
        logger?.warn('assurance.commercial_report.verification_failed', {
          ...(typeof reportId === 'string' ? { reportId } : {}),
          status: verification.authority,
          errorCode: verification.integrity,
        });
      }
      return verification;
    },
  };
}

export { isAssuranceError };
