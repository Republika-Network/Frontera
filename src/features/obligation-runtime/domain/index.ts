export type { ObligationState } from './obligation-state.js';
export {
  OBLIGATION_PROGRESS_CHAIN,
  OBLIGATION_STATES,
  OBLIGATION_STATE_TRANSITIONS,
  SATISFYING_OBLIGATION_STATES,
  TERMINAL_OBLIGATION_STATES,
  isLegalObligationTransition,
  isTerminalObligationState,
  isObligationExpiredAt,
  obligationProgressRank,
  obligationStateSatisfies,
} from './obligation-state.js';

export type { ObligationCorrelation } from './obligation-correlation.js';
export { obligationCorrelationMatches, obligationInstanceId } from './obligation-correlation.js';

export type { ObligationDischargeSource, ObligationDischargeSourceKind, ObligationDischargeVerificationClass } from './obligation-source.js';
export {
  OBLIGATION_DISCHARGE_SOURCE_KINDS,
  OBLIGATION_DISCHARGE_VERIFICATION_CLASSES,
  validateObligationDischargeSource,
} from './obligation-source.js';

export type {
  DisregardedObligationObservation,
  ObligationDischargeObservation,
  ObligationDischargeOutcome,
  ObligationDischargeRecord,
  ObligationObservationDisregardReason,
  ObligationVerificationRecord,
} from './obligation-discharge.js';
export { OBLIGATION_DISCHARGE_OUTCOMES, OBLIGATION_OBSERVATION_DISREGARD_REASONS, validateObligationDischargeObservation } from './obligation-discharge.js';

export type { ObligationDeclaration, ObligationRequirement, ObligationType } from './obligation-requirement.js';
export { OBLIGATION_TYPES, isObligationType, validateObligationDeclaration } from './obligation-requirement.js';

export type { ObligationInstance, ObligationTransition, ObligationTransitionReason } from './obligation-instance.js';
export { declareObligation, obligationIsSatisfied, obligationIsTerminal, obligationWithholdsExercise } from './obligation-instance.js';

export type { ObligationTransitionOutcome } from './obligation-transition.js';
export { transitionObligation } from './obligation-transition.js';

export type { ObligationExerciseEligibility, ObligationResolution } from './obligation-resolution.js';
export { OBLIGATION_RESERVED_REQUEST_KEY_PREFIX, isReservedObligationKey, unresolvedObligationResolution } from './obligation-resolution.js';

export type { ObligationDischargeProviderOutput, ObligationDischargeProviderPort, ObligationDischargeQuery } from './obligation-discharge-port.js';
