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
import type { AssuranceStore } from './assurance-store.js';
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
  ContinuousAssuranceState,
} from './contracts.js';
import {
  AOC_ASSURANCE_RUNTIME_VERSION,
  ASSURANCE_ELIGIBILITY_VERSION,
  ASSURANCE_EVALUATOR_VERSION,
  ASSURANCE_SCORING_VERSION,
  ASSURANCE_SUBJECT_TYPES,
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

export interface RequestReassessmentInput {
  /** The completed assessment to supersede. Provide either this or `subjectId` (the latest completed assessment for the subject is resolved). */
  readonly assessmentId?: string;
  readonly subjectId?: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly evidenceCutoffAt?: string;
}

export interface CollectEvidenceOptions {
  readonly manualEvidence?: readonly AssuranceEvidenceReference[];
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
  buildAssuranceReport(context: AssuranceAccessContext, assessmentId: string, view: string, generatedBy: string): Promise<AssuranceReport>;
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
      if (previous.status !== 'completed' && previous.status !== 'superseded') {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `Only a completed assessment can be reassessed; '${assessmentId}' is '${previous.status}'.`);
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
        supersedesAssessmentId: previous.assessmentId,
        reassessmentReason: input.reason,
      });
      await store.saveAssessment(context, reassessment);
      publish('AssuranceReassessmentRequested', {
        assessmentId: reassessment.assessmentId,
        organizationId: previous.subject.organizationId,
        subjectId: previous.subject.subjectId,
        detail: { previousAssessmentId: previous.assessmentId, reason: input.reason },
      });
      return reassessment;
    },

    async buildAssuranceReport(context, assessmentId, view, generatedBy) {
      if (!isAssuranceReportView(view)) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `Unsupported report view '${view}'; expected one of INTERNAL, AUDITOR, CUSTOMER, PUBLIC.`);
      }
      const assessment = await requireAssessment(context, assessmentId);
      const framework = frameworkFor(assessment);
      return buildAssuranceReport({ assessment, framework, view: view as AssuranceReportView, generatedBy, now, nextId });
    },
  };
}

export { isAssuranceError };
