/**
 * G-02C1A — the reference independent executor: verification only.
 *
 * Runs as its own process (`scripts/run-reference-executor.mjs`). It imports
 * no Host, Kernel, orchestration, grant, store or signing module — pinned by
 * `g02c1a-reference-executor-structure.test.ts`. Not re-exported from the
 * Enterprise barrel. See `docs/architecture/ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md`.
 */
export { REFERENCE_EXECUTOR_ADMISSION_LIMITS, REFERENCE_EXECUTOR_ADMISSION_REFUSALS, admitHttpRequest, isRefusedByAdmission } from './admission.js';
export type { AdmissionPolicy, AdmittedHttpRequest, HttpAdmission, ObservedHttpRequest, ReferenceExecutorAdmissionRefusal } from './admission.js';
export { IMPLICIT_ZERO_LENGTH_METHODS, REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, reconstructHttpRequestBinding } from './binding-reconstruction.js';
export type { BindingReconstruction, ReconstructedHttpRequestBinding } from './binding-reconstruction.js';
export {
  REFERENCE_EXECUTOR_CONFIGURATION_ERROR_CODES,
  REFERENCE_EXECUTOR_CONFIGURATION_FORMAT,
  REFERENCE_EXECUTOR_ENVIRONMENT,
  REFERENCE_EXECUTOR_METHODS,
  REFERENCE_EXECUTOR_STATUS_POLICIES,
  ReferenceExecutorConfigurationError,
  parseReferenceExecutorConfiguration,
} from './configuration.js';
export type { ReferenceExecutorConfiguration, ReferenceExecutorConfigurationErrorCode, ReferenceExecutorCredential, ReferenceExecutorMethod, ReferenceExecutorOrigin } from './configuration.js';
export { REFERENCE_EXECUTOR_ASSESSMENT_FORMAT, REFERENCE_EXECUTOR_GATEWAY_LIMITS, referenceExecutorStatusOf, startReferenceExecutorGateway } from './gateway.js';
export type { ReferenceExecutorGateway, ReferenceExecutorGatewayOptions } from './gateway.js';
export { REFERENCE_EXECUTOR_CONFIG_ENVIRONMENT_VARIABLE, ReferenceExecutorStartupError, referenceExecutorStartupRefusal, startReferenceExecutorProcess } from './launcher.js';
export { REFERENCE_EXECUTOR_STAGES, createReferenceExecutorVerificationPipeline } from './verification-pipeline.js';
export type { ReferenceExecutorAssessment, ReferenceExecutorAssessmentCode, ReferenceExecutorPolicyRefusal, ReferenceExecutorStage, ReferenceExecutorVerificationPipeline } from './verification-pipeline.js';
