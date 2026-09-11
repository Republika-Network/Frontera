export { AocKernel, createAocKernel } from './AocKernel.js';
export type { AocKernelOptions } from './AocKernel.js';

export { AOC_KERNEL_VERSION } from './versioning.js';

export type {
  ActorReference,
  ActionDescriptor,
  TargetReference,
  OrganizationReference,
  KernelEvaluationRequest,
  KernelEvaluationOptions,
  KernelDecisionStatus,
  RecognitionEvaluation,
  AuthorityEvaluation,
  GovernedAuthorityEvaluation,
  GovernedRepresentationEvaluation,
  GovernedRightEvaluation,
  GovernedRightRepresentationEvaluation,
  PolicyEvaluation,
  ApprovalEvaluation,
  ApprovalStatus,
  EvidenceEvaluation,
  ContextEvaluation,
  ContextFactEvaluation,
  ContextRequirementEvaluation,
  KernelEvaluationResult,
  KernelTrace,
  KernelTraceStep,
  KernelTraceStepStatus,
  KernelExecutionStatus,
  KernelExecutionOutcome,
  KernelEnforcementResult,
  RecognitionProvider,
  RecognitionVerificationInput,
  RecognitionVerificationResult,
  PolicyPackProvider,
  GovernedAuthorityProvider,
  GovernedConstraintProvider,
  GovernedRepresentationProvider,
  ContextProvider,
  KernelClock,
  KernelIdGenerator,
} from './contracts/index.js';
export { KERNEL_CONTRACT_IDS } from './contracts/index.js';

/**
 * The trusted-context capability's configuration shape. Type-only, as every
 * other kernel contract export is: the compiled `dist/src/kernel/index.js`
 * entrypoint is a frozen release artifact, and a type export leaves it byte
 * for byte unchanged.
 */
export type { KernelContextResolutionOptions } from './orchestration/context-adapter.js';

export { AOC_KERNEL_REASON_CODES } from './reason-codes/reason-codes.js';
export type { AocKernelReasonCode } from './reason-codes/reason-codes.js';

export { KernelError, KernelValidationError, KernelConfigurationError, KernelDependencyError, KernelInvariantError, KernelExecutionError } from './errors/kernel-errors.js';
