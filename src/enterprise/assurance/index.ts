/**
 * Soberanía Enterprise Assurance Runtime v1 (PR-007) -- versioned, evidence-driven
 * control evaluation, findings, deterministic scoring, eligibility, and
 * continuous Assurance signals. See
 * `docs/enterprise/AOC_ASSURANCE_RUNTIME.md`.
 */

export {
  AOC_ASSURANCE_RUNTIME_VERSION,
  ASSURANCE_STORE_SCHEMA_VERSION,
  ASSURANCE_EVALUATOR_VERSION,
  ASSURANCE_RESOLVER_VERSION,
  ASSURANCE_SCORING_VERSION,
  ASSURANCE_ELIGIBILITY_VERSION,
  ASSURANCE_CONTRACT_IDS,
  ASSURANCE_CONTROL_STATUSES,
  ASSURANCE_SUBJECT_TYPES,
  ASSURANCE_EVIDENCE_TYPES,
  ASSURANCE_FINDING_SEVERITIES,
  ASSURANCE_SIGNAL_TYPES,
  ASSURANCE_REPORT_VIEWS,
  ASSURANCE_TERMINAL_STATUSES,
} from './contracts.js';
export type {
  AssuranceFrameworkStatus,
  AssuranceFramework,
  AssuranceFrameworkSummary,
  AssuranceDomainDefinition,
  AssuranceControlType,
  AssuranceControlCriticality,
  AssuranceEvaluationMethod,
  AssuranceControlApplicability,
  AssuranceControlDefinition,
  AssuranceControlScoring,
  AssuranceSeverityMapping,
  AssuranceBooleanCriteria,
  AssuranceThresholdOperator,
  AssuranceThresholdCriteria,
  AssuranceEvidencePresenceCriteria,
  AssuranceCompositeOperator,
  AssuranceCompositeCriteria,
  AssuranceManualReviewCriteria,
  AssuranceControlCriteria,
  AssuranceControlStatus,
  AssuranceSubjectType,
  AssuranceSubject,
  AssuranceScope,
  AssuranceEvidenceContradictionPolicy,
  AssuranceEvidenceRequirement,
  AssuranceEvidenceType,
  AssuranceEvidenceProvenance,
  AssuranceEvidenceReference,
  AssuranceEvidenceRejectionCode,
  AssuranceRejectedEvidence,
  AssuranceEvidenceContradiction,
  AssuranceEvidenceResolutionStatus,
  AssuranceEvidenceResolution,
  AssuranceConfidence,
  AssuranceCriteriaResult,
  AssuranceManualReviewRequirement,
  AssuranceControlEvaluation,
  AssuranceManualReviewOutcome,
  AssuranceManualReviewRecord,
  AssuranceFindingType,
  AssuranceFindingSeverity,
  AssuranceFindingStatus,
  AssurancePriority,
  AssuranceRemediationGuidance,
  AssuranceFinding,
  AssuranceFindingEventType,
  AssuranceFindingEvent,
  AssuranceDomainStatus,
  AssuranceDomainAssessment,
  AssuranceUnknownPolicy,
  AssuranceManualReviewPolicy,
  AssuranceBlockingRule,
  AssuranceScoringModel,
  AssuranceScoreContribution,
  AssuranceDomainScoreContribution,
  AssuranceDomainScoreReference,
  AssuranceScore,
  AssuranceEligibilityProfile,
  AssuranceEligibilityResult,
  AssuranceEligibilityCandidate,
  AssuranceAssessmentStatus,
  AssuranceModuleSnapshot,
  AssuranceAssessmentProvenance,
  AssuranceAssessmentIntegrity,
  AssuranceAssessment,
  AssuranceSignalType,
  AssuranceSignalSeverity,
  AssuranceSignal,
  AssuranceSignalOutcome,
  AssuranceSignalProcessingResult,
  ContinuousAssuranceStateKind,
  ContinuousAssuranceState,
  AssuranceVerificationFailure,
  AssuranceAssessmentVerificationResult,
  AssuranceReportView,
  AssuranceExecutiveSummary,
  AssuranceDomainReport,
  AssuranceControlReport,
  AssuranceFindingReport,
  AssuranceEvidenceIndexEntry,
  AssuranceReportProvenance,
  AssuranceReportIntegrity,
  AssuranceReport,
  AssuranceAccessContext,
  AssuranceAssessmentQuery,
  AssuranceAssessmentSummary,
  AssuranceAssessmentQueryResult,
  AssuranceSignalQuery,
  AssuranceStoreHealth,
  AssuranceFrameworkValidationIssue,
  AssuranceFrameworkValidationResult,
} from './contracts.js';

export { AssuranceError, isAssuranceError } from './errors.js';
export type { AssuranceErrorCode } from './errors.js';

export { validateAssuranceFramework } from './framework-validation.js';
export { createAssuranceFrameworkRegistry, resolveFrameworkForAssessment } from './framework-registry.js';
export type { AssuranceFrameworkRegistry } from './framework-registry.js';

export { AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_VERSION } from './saf-framework.js';
export { RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_VERSION, RN_SV_REVIEWER_ROLE } from './frameworks/rn-sv-framework.js';

export { createAssuranceEvidenceResolver } from './evidence-resolver.js';
export type { AssuranceEvidenceResolver, AssuranceEvidenceSources, AssuranceRuntimeHealthSnapshot, CreateEvidenceResolverOptions } from './evidence-resolver.js';

export { deriveAssuranceMetrics } from './metrics.js';

export { createAssuranceControlEvaluator } from './control-evaluator.js';
export type { AssuranceControlEvaluator, AssuranceEvaluationContext } from './control-evaluator.js';

export { deriveFindingsFromEvaluations, deriveFindingSeverity, applyFindingTransition, foldFindingStatus, buildFindingEvent } from './findings.js';
export type { BuildFindingEventInput, DeriveFindingsInput } from './findings.js';

export { computeDomainAssessments, computeOverallScore, roundScore } from './scoring.js';
export { evaluateEligibility } from './eligibility.js';
export type { EvaluateEligibilityInput } from './eligibility.js';

export { assertAssessmentTransition, computeAssessmentIntegrity, recomputeAssessmentIntegrity, emptyAssuranceScore } from './assessment.js';
export { verifyAssuranceAssessment } from './verification.js';
export type { VerifyAssuranceAssessmentInput } from './verification.js';

export {
  ASSURANCE_SIGNAL_SEVERITIES,
  ASSURANCE_SIGNAL_OUTCOMES,
  buildAssuranceSignal,
  isAssuranceSignalType,
  deriveStaleReasons,
  deriveContinuousAssuranceState,
  signalAffectsAssessment,
} from './signals.js';
export type { BuildAssuranceSignalInput, DeriveContinuousStateInput } from './signals.js';

export { buildAssuranceReport, isAssuranceReportView, ASSURANCE_REPORT_ENGINE_VERSION } from './report.js';
export type { BuildAssuranceReportInput } from './report.js';

export { canAccessAssuranceOrganization, requireAccessToAssuranceOrganization, requireAssuranceTenantScope } from './assurance-store.js';
export type { AssuranceStore } from './assurance-store.js';
export { createInMemoryAssuranceStore } from './in-memory-assurance-store.js';
export type { CreateInMemoryAssuranceStoreOptions } from './in-memory-assurance-store.js';
export { createSqliteAssuranceStore } from './sqlite-assurance-store.js';
export type { CreateSqliteAssuranceStoreOptions } from './sqlite-assurance-store.js';

export { createAssuranceService } from './service.js';
export type {
  AssuranceService,
  AssuranceServiceDependencies,
  CreateAssuranceAssessmentInput,
  RecordManualReviewInput,
  AppendFindingEventInput,
  RequestReassessmentInput,
  CollectEvidenceOptions,
} from './service.js';
