export type { ActorReference, ActionDescriptor, TargetReference, OrganizationReference, KernelEvaluationRequest } from './kernel-request.js';
export type { KernelEvaluationOptions } from './kernel-options.js';
export type {
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
  ObligationDischargeEvaluation,
  GrantBoundEvaluation,
  GrantEvaluation,
  ObligationEvaluation,
  ObligationInstanceEvaluation,
  ObligationTransitionEvaluation,
  ObligationVerificationEvaluation,
  KernelEvaluationResult,
} from './kernel-result.js';
export type { KernelTrace, KernelTraceStep, KernelTraceStepStatus } from './kernel-trace.js';
export type { KernelExecutionStatus, KernelExecutionOutcome, KernelExecutionWithholdingLayer, KernelEnforcementResult } from './kernel-enforcement-result.js';
export type {
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
} from './ports.js';

/** Contract identifiers for the v1 kernel surface -- only the exported public contracts are versioned, not every internal module. */
export const KERNEL_CONTRACT_IDS = {
  evaluationRequest: 'aoc.kernel.evaluation-request.v1',
  evaluationResult: 'aoc.kernel.evaluation-result.v1',
  trace: 'aoc.kernel.trace.v1',
} as const;
