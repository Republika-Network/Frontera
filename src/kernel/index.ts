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
  DisregardedObligationObservationEvaluation,
  GrantBoundEvaluation,
  GrantEvaluation,
  ObligationDischargeEvaluation,
  ObligationEvaluation,
  ObligationInstanceEvaluation,
  ObligationTransitionEvaluation,
  ObligationVerificationEvaluation,
  KernelEvaluationResult,
  KernelTrace,
  KernelTraceStep,
  KernelTraceStepStatus,
  KernelExecutionStatus,
  KernelExecutionOutcome,
  KernelExecutionWithholdingLayer,
  KernelEnforcementResult,
  RecognitionProvider,
  RecognitionVerificationInput,
  RecognitionVerificationResult,
  PolicyPackProvider,
  GovernedAuthorityProvider,
  GovernedConstraintProvider,
  GovernedRepresentationProvider,
  ContextProvider,
  ObligationDischargeProvider,
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

/**
 * The obligation capability's configuration shape, and the exercise reason-code
 * type. Type-only, as every other kernel contract export is, and for the reason
 * stated above: `dist/src/kernel/index.js` is a checksummed release artifact,
 * and a type export leaves it byte for byte unchanged.
 *
 * The reason-code *constants* are deliberately not re-exported here. Every
 * obligation field on `KernelEvaluationResult` is typed `string`, exactly as the
 * context fields are, so an integrator programs against the documented literals
 * without the frozen entrypoint growing a runtime export. A consumer that wants
 * the constants imports them from `src/features/obligation-runtime` or from
 * `src/kernel/reason-codes/exercise-reason-codes.js`, neither of which is a
 * frozen artifact.
 */
export type { KernelObligationOptions } from './orchestration/obligation-adapter.js';
export type { AocKernelExerciseReasonCode } from './reason-codes/exercise-reason-codes.js';

/**
 * The bounded-grant capability's configuration shape. Type-only, as every other
 * kernel contract export is, and for the reason stated above:
 * `dist/src/kernel/index.js` is a checksummed release artifact, and a type
 * export leaves it byte for byte unchanged.
 *
 * The grant reason-code *constants* are deliberately not re-exported here, for
 * the reason the obligation ones are not: every grant field on
 * `KernelEvaluationResult` is typed `string`, so an integrator programs against
 * the documented literals without the frozen entrypoint growing a runtime
 * export. A consumer that wants the constants — or the issuance service, the
 * store port, or the bound algebra — imports them from
 * `src/features/grant-runtime`, which is not a frozen artifact.
 */
export type { KernelGrantOptions } from './orchestration/grant-adapter.js';

export { AOC_KERNEL_REASON_CODES } from './reason-codes/reason-codes.js';
export type { AocKernelReasonCode } from './reason-codes/reason-codes.js';

export { KernelError, KernelValidationError, KernelConfigurationError, KernelDependencyError, KernelInvariantError, KernelExecutionError } from './errors/kernel-errors.js';
