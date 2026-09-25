/**
 * Public surface of the Soberanía Enterprise Host: the production HTTP service
 * that hosts `AocKernel` (`../kernel`). Exposes composition, hosting, and
 * contract types only -- internal orchestration/persistence wiring is
 * reachable for advanced embedding (e.g. a Next.js route handler that
 * wants `createEnterprise()` without `node:http`), but nothing here
 * introduces governance logic; every decision still comes from
 * `AocKernel.evaluate()`.
 *
 * This module replaces the prior `kernel-host` package (see
 * `docs/enterprise/KERNEL_HOST_TO_ENTERPRISE_MIGRATION.md`); a compatibility
 * re-export lives at `@aoc-enterprise/runtime/kernel-host` for one
 * transition period.
 */

export { AOC_ENTERPRISE_HOST_VERSION } from './version.js';

export { loadEnterpriseConfiguration, computeConfigurationChecksum, toPublicEnterpriseConfiguration } from './configuration/enterprise-configuration.js';
export type {
  EnterpriseConfiguration,
  EnterpriseEnvironment,
  EnterprisePersistenceProviderKind,
  EnterpriseFeatureFlags,
  EnterpriseApiKey,
  PublicEnterpriseConfiguration,
} from './configuration/enterprise-configuration.js';

export { createEnterpriseTelemetry } from './telemetry/enterprise-telemetry.js';
export type { EnterpriseTelemetry, EnterpriseMetricsSnapshot } from './telemetry/enterprise-telemetry.js';
export { createEnterpriseLogger } from './telemetry/enterprise-logger.js';
export type { EnterpriseLogger, EnterpriseLogContext, EnterpriseLogLevel, EnterpriseLoggerSink } from './telemetry/enterprise-logger.js';

export { createInProcessEventPublisher } from './events/enterprise-events.js';
export type { EnterpriseEvent, EnterpriseEventType, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent, GovernanceEvaluationCompletedEvent } from './events/enterprise-events.js';

export { createDefaultKernelProviders } from './providers/kernel-provider-composition.js';
export type { KernelProviderSet, KernelWorldHandles } from './providers/kernel-provider-composition.js';

// -- Soberanía Enterprise Governance Store v1 (PR-004) ----------------------------

export { createInMemoryGovernanceStore } from './governance-store/in-memory-governance-store.js';
export type { CreateGovernanceStoreOptions } from './governance-store/in-memory-governance-store.js';
export { createSqliteGovernanceStore } from './governance-store/sqlite-governance-store.js';
export type { CreateSqliteGovernanceStoreOptions } from './governance-store/sqlite-governance-store.js';
export type {
  GovernanceStore,
  GovernanceDecisionTraceRecord,
  EnterpriseEventRecord,
  EnterpriseVersionRecord,
  PersistEvaluationInput,
  PersistEvaluationResult,
  PersistEvaluationOutcome,
} from './governance-store/governance-store.js';
export {
  AOC_GOVERNANCE_STORE_VERSION,
  GOVERNANCE_STORE_SCHEMA_VERSION,
  GOVERNANCE_STORE_CONTRACT_IDS,
  GOVERNANCE_MIGRATION_SOURCE_PR_002,
  GOVERNANCE_REFERENCE_TYPES,
  GOVERNANCE_REFERENCE_INTEGRITY_VERSION,
  isCanonicalGovernanceReferenceType,
  toGovernanceReplayMetadata,
} from './governance-store/contracts.js';
export type {
  GovernanceRecord,
  GovernanceRequestRecord,
  GovernanceEvaluationRecord,
  GovernanceTraceRecord,
  GovernanceReasonRecord,
  GovernanceEventRecord,
  GovernanceEventAggregateType,
  GovernanceModuleSnapshot,
  GovernanceProviderSnapshot,
  GovernanceRecordMetadata,
  GovernanceIntegrityMetadata,
  GovernanceReferenceRecord,
  GovernanceReferenceInput,
  GovernanceReferenceType,
  GovernanceReferenceIntegrityStatus,
  GovernanceReferenceIntegritySummary,
  GovernanceReferenceChainState,
  GovernanceCorrectionRecord,
  GovernanceReplayMetadata,
  GovernanceStoreAccessContext,
  GovernanceIdempotencyContext,
  GovernanceIdempotencyRecord,
  GovernanceIdempotencyProbe,
  GovernanceIdempotencyResolution,
  GovernanceEnterpriseContext,
  AppendGovernanceEvaluationInput,
  AppendGovernanceEvaluationResult,
  GovernanceStoreQuery,
  GovernanceStoreQueryResult,
  GovernanceRecordSummary,
  GovernanceIntegrityFailure,
  GovernanceRecordVerificationResult,
  GovernanceRecordLoadResult,
  GovernanceStoreHealth,
} from './governance-store/contracts.js';
export { GovernanceStoreError, isGovernanceStoreError } from './governance-store/errors.js';
export type { GovernanceStoreErrorCode, GovernanceIdempotencyConflictKind } from './governance-store/errors.js';
export { AOC_CANONICALIZATION_VERSION, canonicalSerialize, CanonicalSerializationError } from './governance-store/canonical-json.js';
export { computeDigest, isWellFormedDigest, GOVERNANCE_DIGEST_ALGORITHM } from './governance-store/digest.js';
export { redactSensitiveValues, isSensitiveKey, DEFAULT_SENSITIVE_KEY_TERMS, GOVERNANCE_REDACTED_VALUE } from './governance-store/redaction.js';
export { DEFAULT_GOVERNANCE_STORE_LIMITS, computeGovernanceRequestPayloadDigest } from './governance-store/projection.js';
export type { GovernanceStoreLimits } from './governance-store/projection.js';
export { verifyGovernanceRecordIntegrity } from './governance-store/verification.js';
export { toKernelTrace, toKernelEvaluationResult } from './governance-store/store-common.js';
export { createGovernanceReadService, resolveGovernanceAccessContext } from './orchestration/governance-read-service.js';
export type { GovernanceReadService } from './orchestration/governance-read-service.js';

// -- Soberanía Enterprise Evidence Bundle v1 (PR-005) -----------------------------

export {
  AOC_EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_PROJECTION_ENGINE_VERSION,
  EVIDENCE_CONTRACT_IDS,
  EVIDENCE_FIELD_KEYS,
} from './evidence/contracts.js';
export type {
  DisclosureLevel,
  DisclosurePolicy,
  EvidenceFieldKey,
  EvidenceDisclosureMetadata,
  EvidenceSource,
  EvidenceSubject,
  EvidenceSubjectType,
  EvidenceTraceStep,
  EvidenceEventSummary,
  EvidenceContent,
  EvidenceIntegrityMetadata,
  EvidenceProvenance,
  EvidenceReference,
  EvidenceReferenceType,
  EvidenceBundle,
  EvidenceBundleState,
  EvidenceBundleRecord,
  EvidenceIntegrityFailure,
  EvidenceVerificationResult,
} from './evidence/contracts.js';
export { EvidenceError, isEvidenceError } from './evidence/errors.js';
export type { EvidenceErrorCode } from './evidence/errors.js';
export {
  FULL_DISCLOSURE_POLICY,
  AUDITOR_DISCLOSURE_POLICY,
  PARTNER_DISCLOSURE_POLICY,
  CUSTOMER_DISCLOSURE_POLICY,
  PUBLIC_DISCLOSURE_POLICY,
  getDisclosurePolicy,
  findDisclosurePolicyById,
  listDisclosurePolicies,
} from './evidence/disclosure-policies.js';
export { buildEvidenceBundle, EVIDENCE_DISCLOSURE_REDACTED_VALUE } from './evidence/projector.js';
export type { EvidenceProjectionDependencies } from './evidence/projector.js';
export { verifyEvidenceBundle } from './evidence/verifier.js';
export { createInMemoryEvidenceStore } from './evidence/evidence-store.js';
export type { EvidenceStore, CreateEvidenceStoreOptions } from './evidence/evidence-store.js';
export { createEvidenceService } from './evidence/evidence-service.js';
export type { EvidenceService, EvidenceServiceDependencies, BuildEvidenceBundleInput } from './evidence/evidence-service.js';
export {
  validateEvidenceBuildRequestBody,
  validateEvidenceVerifyRequestBody,
  toEvidenceBundleResponseBody,
  toEvidenceVerifyResponseBody,
} from './api/evidence-contract.js';
export type { EvidenceBuildRequestBody, EvidenceBundleResponseBody, EvidenceVerifyRequestBody } from './api/evidence-contract.js';
export { mapEvidenceErrorToHttp } from './api/enterprise-http-errors.js';

// -- Soberanía Enterprise Agent Passport Runtime v1 (PR-006) ----------------------

export {
  AOC_AGENT_PASSPORT_RUNTIME_VERSION,
  AGENT_PASSPORT_SCHEMA_VERSION,
  AGENT_PASSPORT_CONTRACT_IDS,
  AGENT_PASSPORT_TERMINAL_STATUSES,
} from './passport/contracts.js';
export type {
  AgentPassportSubjectType,
  AgentPassportSubject,
  AgentPassportOrganizationBinding,
  AgentPassportStatus,
  AgentPassportLifecycle,
  AgentIdentityDescriptor,
  AgentReferenceStatus,
  AgentCapabilityReference,
  AgentAuthorityReference,
  AgentDelegationReference,
  PassportGovernanceReference,
  PassportEvidenceReference,
  AgentPassportProvenance,
  AgentPassportIntegrity,
  AgentPassport,
  AgentPassportEventType,
  AgentPassportEvent,
  AgentPassportClaim,
  AgentPassportHistorySummary,
  AgentPassportViewType,
  AgentPassportViewProvenance,
  AgentPassportViewIntegrity,
  AgentPassportView,
  AgentPassportVerificationMode,
  PassportVerificationFailure,
  AgentPassportVerificationResult,
  PassportAccessContext,
  AppendPassportEventInput,
  AppendPassportEventResult,
  AgentPassportLoadResult,
  AgentPassportStoreHealth,
  PassportIdempotencyContext,
  PassportIdempotencyProbe,
  PassportIdempotencyResolution,
} from './passport/contracts.js';
export { AgentPassportError, isAgentPassportError } from './passport/errors.js';
export type { AgentPassportErrorCode } from './passport/errors.js';
export { applyLifecycleTransition, isLifecycleEventType, isTerminalStatus } from './passport/lifecycle.js';
export { verifyEventChain } from './passport/events.js';
export { reconstructAgentPassportFromEvents, computePassportHistorySummary } from './passport/reconstruction.js';
export type { AgentPassportStore } from './passport/passport-store.js';
export { createInMemoryPassportStore } from './passport/in-memory-passport-store.js';
export type { CreateInMemoryPassportStoreOptions } from './passport/in-memory-passport-store.js';
export { createSqlitePassportStore } from './passport/sqlite-passport-store.js';
export type { CreateSqlitePassportStoreOptions } from './passport/sqlite-passport-store.js';
export { verifyAgentPassport } from './passport/verification.js';
export type { PassportReferenceCheckers } from './passport/verification.js';
export { AGENT_PASSPORT_VIEW_TYPES, buildAgentPassportView, isAgentPassportViewType } from './passport/disclosure.js';
export { createAgentPassportService } from './passport/service.js';
export type {
  AgentPassportService,
  AgentPassportServiceDependencies,
  IssueAgentPassportInput,
  IssueAgentPassportResult,
  RetireAgentPassportInput,
  RevokeAgentPassportInput,
  SuspendAgentPassportInput,
} from './passport/service.js';
export { createAgentPassportModule, AGENT_PASSPORT_MODULE_ID } from './modules/passport-module.js';
export { mapAgentPassportErrorToHttp } from './api/enterprise-http-errors.js';

// -- Soberanía Enterprise Assurance Runtime v1 (PR-007) ----------------------------

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
} from './assurance/contracts.js';
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
} from './assurance/contracts.js';
export { AssuranceError, isAssuranceError } from './assurance/errors.js';
export type { AssuranceErrorCode } from './assurance/errors.js';
export { validateAssuranceFramework } from './assurance/framework-validation.js';
export { createAssuranceFrameworkRegistry, resolveFrameworkForAssessment } from './assurance/framework-registry.js';
export type { AssuranceFrameworkRegistry } from './assurance/framework-registry.js';
export { AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_VERSION } from './assurance/saf-framework.js';
export { createAssuranceEvidenceResolver } from './assurance/evidence-resolver.js';
export type { AssuranceEvidenceResolver, AssuranceEvidenceSources, AssuranceRuntimeHealthSnapshot } from './assurance/evidence-resolver.js';
export { deriveAssuranceMetrics } from './assurance/metrics.js';
export { createAssuranceControlEvaluator } from './assurance/control-evaluator.js';
export type { AssuranceControlEvaluator, AssuranceEvaluationContext } from './assurance/control-evaluator.js';
export { deriveFindingsFromEvaluations, deriveFindingSeverity, applyFindingTransition, foldFindingStatus, buildFindingEvent } from './assurance/findings.js';
export { computeDomainAssessments, computeOverallScore, roundScore } from './assurance/scoring.js';
export { evaluateEligibility } from './assurance/eligibility.js';
export { assertAssessmentTransition, computeAssessmentIntegrity, recomputeAssessmentIntegrity } from './assurance/assessment.js';
export { verifyAssuranceAssessment } from './assurance/verification.js';
export {
  ASSURANCE_SIGNAL_SEVERITIES,
  ASSURANCE_SIGNAL_OUTCOMES,
  buildAssuranceSignal,
  isAssuranceSignalType,
  deriveStaleReasons,
  deriveContinuousAssuranceState,
} from './assurance/signals.js';
export type { BuildAssuranceSignalInput } from './assurance/signals.js';
export { buildAssuranceReport, isAssuranceReportView, ASSURANCE_REPORT_ENGINE_VERSION } from './assurance/report.js';
export type { AssuranceStore } from './assurance/assurance-store.js';
export { canAccessAssuranceOrganization, requireAccessToAssuranceOrganization, requireAssuranceTenantScope } from './assurance/assurance-store.js';
export { createInMemoryAssuranceStore } from './assurance/in-memory-assurance-store.js';
export type { CreateInMemoryAssuranceStoreOptions } from './assurance/in-memory-assurance-store.js';
export { createSqliteAssuranceStore } from './assurance/sqlite-assurance-store.js';
export type { CreateSqliteAssuranceStoreOptions } from './assurance/sqlite-assurance-store.js';
export { createAssuranceService } from './assurance/service.js';
export type {
  AssuranceService,
  AssuranceServiceDependencies,
  CreateAssuranceAssessmentInput,
  RecordManualReviewInput,
  AppendFindingEventInput,
  RequestReassessmentInput,
  CollectEvidenceOptions,
} from './assurance/service.js';
export { createAssuranceModule, ASSURANCE_MODULE_ID } from './modules/assurance-module.js';
export { mapAssuranceErrorToHttp } from './api/enterprise-http-errors.js';
export {
  validateCreateAssessmentRequestBody,
  validateEvaluateAssessmentRequestBody,
  validateFindingEventRequestBody,
  validateManualReviewRequestBody,
  validateSignalRequestBody,
  validateReassessRequestBody,
} from './api/assurance-contract.js';
export type { AssuranceEnterpriseEvent, AssuranceEnterpriseEventType } from './events/enterprise-events.js';

// -- Frontera Kernel Authority Runtime v1 (P0-PKG-07) ----------------------------
//
// The durable, operator-provisioned recognition/authority world
// `AocKernel.evaluate()` decides against. Composition surface, so it ships on
// this existing `./enterprise` subpath rather than claiming a new one.
//
// Note what is exported and what is not: the store, the hydration, the durable
// provider set and the operator provisioning service are all here, because an
// external consumer legitimately needs to open a store, restore a world and
// (as an operator) provision one. Nothing here lets an *evaluation* write:
// every write path demands a privileged operator context that the evaluation
// path never holds.

export {
  AOC_KERNEL_AUTHORITY_RUNTIME_VERSION,
  KERNEL_AUTHORITY_SCHEMA_VERSION,
  KERNEL_AUTHORITY_CONTRACT_IDS,
  KERNEL_AUTHORITY_ENTITY_KINDS,
} from './kernel-authority/contracts.js';
export type {
  KernelAuthorityAccessContext,
  KernelAuthorityActorType,
  KernelAuthorityDelegateActorType,
  KernelAuthorityEntityKind,
  KernelAuthorityEntityStatus,
  KernelAuthorityEvent,
  KernelAuthorityEventType,
  KernelAuthorityExternalSubject,
  KernelAuthorityIdempotency,
  KernelAuthorityPassportType,
  KernelAuthorityRecord,
  KernelAuthorityRecordQuery,
  KernelAuthorityRiskLevel,
  KernelAuthorityStoreHealth,
  AppendKernelAuthorityEventInput,
  AppendKernelAuthorityEventResult,
  KernelAuthorityProvisionInput,
  ProvisionActorInput,
  ProvisionAuthorityGrantInput,
  ProvisionCapabilityTokenInput,
  ProvisionDelegationGrantInput,
  ProvisionPassportInput,
  ProvisionRootIssuerInput,
  ProvisionTrustDomainInput,
} from './kernel-authority/contracts.js';

export { KernelAuthorityError, isKernelAuthorityError } from './kernel-authority/errors.js';
export type { KernelAuthorityErrorCode } from './kernel-authority/errors.js';

export type { KernelAuthorityStore } from './kernel-authority/kernel-authority-store.js';
export {
  canAccessKernelAuthorityOrganization,
  requireKernelAuthorityOperator,
  requireKernelAuthorityReadAccess,
  requireKernelAuthorityTenantScope,
  reconstructKernelAuthorityRecord,
} from './kernel-authority/kernel-authority-store.js';

export { createInMemoryKernelAuthorityStore } from './kernel-authority/in-memory-kernel-authority-store.js';
export type { CreateInMemoryKernelAuthorityStoreOptions } from './kernel-authority/in-memory-kernel-authority-store.js';
export { createSqliteKernelAuthorityStore } from './kernel-authority/sqlite-kernel-authority-store.js';
export type { CreateSqliteKernelAuthorityStoreOptions } from './kernel-authority/sqlite-kernel-authority-store.js';

export { hydrateKernelAuthorityWorld } from './kernel-authority/hydration.js';
export type { KernelAuthorityHydrationContext, KernelAuthorityHydrationResult } from './kernel-authority/hydration.js';

export { createDurableRecognitionProvider, resolveRecognitionCredentials } from './kernel-authority/recognition-bridge.js';
export type { DurableRecognitionBridgeOptions, ResolvedRecognitionCredentials } from './kernel-authority/recognition-bridge.js';

export { createDurableKernelProviders } from './kernel-authority/durable-kernel-providers.js';
export type { CreateDurableKernelProvidersOptions, DurableKernelDecisionService, DurableKernelProviderSet } from './kernel-authority/durable-kernel-providers.js';

export { createKernelAuthorityProvisioningService } from './kernel-authority/provisioning-service.js';
export type {
  CreateKernelAuthorityProvisioningServiceOptions,
  KernelAuthorityProvisioningOptions,
  KernelAuthorityProvisioningResult,
  KernelAuthorityProvisioningService,
  KernelAuthorityRevocationInput,
} from './kernel-authority/provisioning-service.js';
export { createKernelAuthorityModule, KERNEL_AUTHORITY_MODULE_ID } from './modules/kernel-authority-module.js';

export { computeEnterpriseHealth } from './health/health-check.js';
export type { EnterpriseHealthReport, EnterpriseHealthState, EnterpriseHealthDependencies } from './health/health-check.js';

export {
  validateGovernanceEvaluateRequestBody,
  toKernelEvaluationRequest,
  toKernelEvaluationOptions,
  toGovernanceEvaluateResponseBody,
  mapDecisionStatusToHttpStatus,
} from './api/governance-evaluate-contract.js';
export type { GovernanceEvaluateRequestBody, GovernanceEvaluateResponseBody } from './api/governance-evaluate-contract.js';
export { EnterpriseHttpError, EnterpriseHttpErrors, mapGovernanceStoreErrorToHttp } from './api/enterprise-http-errors.js';
export type { EnterpriseHttpErrorCode } from './api/enterprise-http-errors.js';

export { evaluateGovernanceRequest } from './orchestration/evaluate-governance-request.js';
export type { EvaluateGovernanceRequestInput, EvaluateGovernanceRequestDependencies, EnterpriseEvaluationResponse } from './orchestration/evaluate-governance-request.js';

export { createEnterprise, createDefaultEnterprise } from './composition/composition-root.js';
export type { AocEnterprise, CreateEnterpriseOptions, EnterpriseEvaluationRequest, EnterpriseRequestContext } from './composition/composition-root.js';
export type { EnterpriseAuthorityControlledExecutionOptions } from './composition/composition-root.js';

/**
 * Authority-Controlled Execution -- the opt-in composition that gates external
 * execution on a bounded grant. Type-only, deliberately.
 *
 * The *values* (`createAuthorityControlledExecution`, the reason-code
 * constants, the error class) are not re-exported here, for the reason the
 * grant and obligation constants are not re-exported from the Kernel's
 * entrypoint: `dist/src/enterprise/index.js` is a checksummed release
 * artifact, and a deployment adopts this capability by composing it through
 * `createEnterprise({ authorityControlledExecution })` rather than by importing
 * a factory. A host that needs the values imports them from
 * `src/enterprise/execution-governance`, which is not a frozen artifact.
 */
export type {
  AuthorityBindingReasonCode,
  AuthorityControlledAuthorizationInput,
  AuthorityControlledAuthorizationOutcome,
  AuthorityControlledExecutionOptions,
  AuthorityControlledExecutionService,
  ExecutionGovernanceErrorCode,
  ExecutionKernelPort,
  GrantAuthorityBinding,
  GrantAuthorityBindingQuery,
  GrantAuthorityBindingResolver,
  GrantBoundedAuthorityKind,
  GrantUnboundedAuthoritySourceKind,
  RevokeBoundedGrantRequest,
  RevokeBoundedGrantResult,
} from './execution-governance/index.js';

/**
 * The durable authoritative bounded-grant store -- type-only, for the same
 * reason the composition above is.
 *
 * A deployment adopts it by configuration
 * (`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`, with
 * `AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH`), not by importing a factory: the
 * composition root selects it exactly as it selects every other store. A host
 * that wants to construct one itself imports `createSqliteBoundedGrantStore`
 * from `src/enterprise/bounded-grant-store`, which is not a frozen artifact.
 *
 * See `docs/security/AUTHORITATIVE_GRANT_STORE.md`. Its digests are storage
 * integrity; the cryptographic authenticity beside them is
 * `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md`.
 */
export type {
  BoundedGrantStoreErrorCode,
  BoundedGrantStoreHealth,
  CreateSqliteBoundedGrantStoreOptions,
  DurableBoundedGrantStore,
} from './bounded-grant-store/index.js';

/**
 * The authority-artifact authenticity boundary -- type-only, for the same
 * reason the store above is.
 *
 * A deployment adopts it by configuration
 * (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID`,
 * `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`,
 * `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`), and the composition root builds
 * the signer and the verifier from it. A host that constructs its own durable
 * store imports the factories from `src/enterprise/authority-authenticity`.
 *
 * Exported as types so a host can *name* the boundary it satisfies. Note which
 * way the two halves point: a component handed an `AuthorityArtifactVerifier`
 * can check authority and cannot mint it, which is the whole reason the two are
 * separate types rather than one.
 */
export type {
  AuthorityArtifactSigner,
  AuthorityArtifactVerifier,
  AuthoritySignature,
  AuthoritySignatureAlgorithm,
  AuthoritySignatureFailure,
  AuthoritySignatureVerification,
  TrustedVerificationKey,
} from './authority-authenticity/index.js';

export { createEnterpriseRequestListener } from './adapters/node-http-adapter.js';

export { createEnterpriseServer } from './host/enterprise-server.js';
export type { EnterpriseServer } from './host/enterprise-server.js';

// -- Soberanía Enterprise Module Lifecycle & Registry (PR-003) --------------------

export type {
  EnterpriseModuleId,
  EnterpriseModuleState,
  EnterpriseLifecycleState,
  EnterpriseHealthStatus,
  EnterpriseModuleHealth,
  EnterpriseModuleDependency,
  EnterpriseModuleDescriptor,
  EnterpriseModuleRegistryView,
  EnterpriseModuleContext,
  EnterpriseModule,
  EnterpriseModuleSnapshot,
} from './modules/enterprise-module.js';
export { createKernelModule, KERNEL_MODULE_ID } from './modules/kernel-module.js';
export { createProvidersModule, PROVIDERS_MODULE_ID } from './modules/providers-module.js';
export { createGovernanceStoreModule, createPersistenceModule, GOVERNANCE_STORE_MODULE_ID, PERSISTENCE_MODULE_ID } from './modules/governance-store-module.js';
export { createEventsModule, EVENTS_MODULE_ID } from './modules/events-module.js';
export { createTelemetryModule, TELEMETRY_MODULE_ID } from './modules/telemetry-module.js';

export { createEnterpriseModuleRegistry } from './registry/enterprise-module-registry.js';
export type { EnterpriseModuleRegistry, EnterpriseModuleRegistration, EnterpriseDependencyValidationResult } from './registry/enterprise-module-registry.js';
export { isVersionCompatible, resolveTopologicalOrder } from './registry/dependency-graph.js';

export { createEnterpriseLifecycleController } from './lifecycle/enterprise-lifecycle-controller.js';
export type {
  EnterpriseLifecycleController,
  EnterpriseLifecycleControllerDependencies,
  EnterpriseLifecycleSnapshot,
  EnterpriseModuleHealthEntry,
} from './lifecycle/enterprise-lifecycle-controller.js';
export { isValidModuleTransition, isValidHostTransition } from './lifecycle/lifecycle-state.js';
export {
  EnterpriseLifecycleError,
  EnterpriseModuleRegistrationError,
  EnterpriseModuleDependencyError,
  EnterpriseModuleCycleError,
  EnterpriseModuleInitializationError,
  EnterpriseModuleStateError,
  EnterpriseModuleShutdownError,
  EnterpriseNotReadyError,
} from './lifecycle/lifecycle-errors.js';
export type { EnterpriseModuleShutdownFailure } from './lifecycle/lifecycle-errors.js';
export type { EnterpriseLifecycleEvent, EnterpriseLifecycleEventType } from './lifecycle/lifecycle-events.js';

export type { EnterpriseLifecycleConfiguration } from './configuration/enterprise-configuration.js';

// Access Governance Runtime (Slice 1: Durable Grants + Truthful Effective
// Revocation, "Sovereign Execution Binding") deliberately has NO barrel
// export here yet. Its own canonical dependencies
// (`@aoc-enterprise/access-grant`, `grant-revocation`, `provider-adapter`,
// `provider-translation`, `pinata-adapter`) are not (yet) declared runtime
// dependencies of the published `@aoc-enterprise/runtime` package (see
// `scripts/validate-publishability.mjs`'s `bundledWorkspacePackages` --
// each carries its own further `file:` dependency chain that would need
// bundling too). Import directly from `./access-governance/index.js`
// within this monorepo; publishing it on this package's public surface is
// follow-up work, not Slice 1's.
