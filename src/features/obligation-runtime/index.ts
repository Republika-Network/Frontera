/**
 * Obligation Runtime — layer D of
 * `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.
 *
 * Answers "what must happen before this authorized action may be exercised, and
 * did it?" and answers nothing else. Nothing exported from this module can
 * allow, deny, narrow or recommend; nothing here imports the policy runtime,
 * the enforcement engine, the Kernel or the (future) Grants layer; and a
 * structural test in `tests/obligation-layer-boundaries.test.ts` keeps it that
 * way.
 *
 * The invariant the whole module exists to hold: **an obligation never changes
 * the meaning of an authorization decision.** For the same request, authority,
 * context and policy, removing every obligation and every discharge leaves the
 * decision byte-identical; all it can change is whether the already-authorized
 * action is currently eligible to proceed.
 *
 * See `README.md` for the lifecycle, the discharge trust model, the Kernel
 * integration and what this phase deliberately leaves to Bounded Grants.
 */
export type {
  DisregardedObligationObservation,
  ObligationCorrelation,
  ObligationDeclaration,
  ObligationDischargeObservation,
  ObligationDischargeOutcome,
  ObligationDischargeProviderOutput,
  ObligationDischargeProviderPort,
  ObligationDischargeQuery,
  ObligationDischargeRecord,
  ObligationDischargeSource,
  ObligationDischargeSourceKind,
  ObligationDischargeVerificationClass,
  ObligationExerciseEligibility,
  ObligationInstance,
  ObligationObservationDisregardReason,
  ObligationRequirement,
  ObligationResolution,
  ObligationState,
  ObligationTransition,
  ObligationTransitionOutcome,
  ObligationTransitionReason,
  ObligationType,
} from './domain/index.js';
export {
  OBLIGATION_DISCHARGE_OUTCOMES,
  OBLIGATION_DISCHARGE_SOURCE_KINDS,
  OBLIGATION_DISCHARGE_VERIFICATION_CLASSES,
  OBLIGATION_OBSERVATION_DISREGARD_REASONS,
  OBLIGATION_PROGRESS_CHAIN,
  OBLIGATION_RESERVED_REQUEST_KEY_PREFIX,
  OBLIGATION_STATES,
  OBLIGATION_STATE_TRANSITIONS,
  OBLIGATION_TYPES,
  SATISFYING_OBLIGATION_STATES,
  TERMINAL_OBLIGATION_STATES,
  declareObligation,
  dischargeExpiresAt,
  isDischargeFreshAt,
  isLegalObligationTransition,
  isObligationType,
  isReservedObligationKey,
  isTerminalObligationState,
  obligationCorrelationMatches,
  obligationInstanceId,
  obligationIsSatisfied,
  obligationIsTerminal,
  obligationProgressRank,
  obligationStateSatisfies,
  obligationWithholdsExercise,
  transitionObligation,
  unresolvedObligationResolution,
  validateObligationDeclaration,
  validateObligationDischargeObservation,
  validateObligationDischargeSource,
} from './domain/index.js';

export {
  ObligationConfigurationError,
  ObligationDischargeSourceRegistry,
  ObligationLifecycleService,
  createFailingObligationDischargeProvider,
  createInMemoryObligationDischargeProvider,
} from './services/index.js';
export type { ObligationLifecycleServiceOptions } from './services/index.js';
