/**
 * Context Resolution Runtime — layer C of
 * `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.
 *
 * Answers "what is true right now, and who says so?" and answers nothing else.
 * Nothing exported from this module can allow, deny, narrow or recommend, and
 * nothing here imports the policy runtime, the enforcement engine or the
 * Kernel — the dependency rule runs one way, and a structural test in
 * `tests/context-layer-boundaries.test.ts` keeps it that way.
 *
 * See `README.md` for the trust model, the migration posture and what this
 * phase deliberately leaves undone.
 */
export type {
  ContextAssertedFactPolicy,
  ContextDeclaration,
  ContextDerivation,
  ContextDerivationFailureReason,
  ContextDerivationOperator,
  ContextDerivationOutcome,
  ContextFact,
  ContextFactDerivation,
  ContextFactFreshness,
  ContextFactObservation,
  ContextFactRead,
  ContextFactReadStatus,
  ContextFactResolution,
  ContextFactValue,
  ContextObservationProvenanceInput,
  ContextObservationRefusalReason,
  ContextRequirement,
  ContextResolution,
  ContextResolutionQuery,
  ContextResolverOutput,
  ContextResolverPort,
  ContextSource,
  ContextSourceAttestation,
  ContextSourceKind,
  ContextSourceProvenanceRequirement,
  ContextTrustClass,
  RefusedContextObservation,
  ResolvedContextFactStatus,
  TerminalContextTrustClass,
} from './domain/index.js';
export {
  ADMITTED_CONTEXT_FORMAT,
  CONTEXT_ASSERTED_FACT_POLICIES,
  CONTEXT_DERIVATION_OPERATORS,
  CONTEXT_FACT_CLASS_MAX_LENGTH,
  CONTEXT_FACT_STRING_MAX_LENGTH,
  CONTEXT_MAX_AGE_SECONDS_LIMIT,
  CONTEXT_MAX_FUTURE_SKEW_SECONDS,
  CONTEXT_OBSERVATION_PROVENANCE_DOMAIN,
  CONTEXT_OBSERVATION_REFUSAL_REASONS,
  CONTEXT_SOURCE_PROVENANCE_REQUIREMENTS,
  CONTEXT_DERIVED_SOURCE,
  CONTEXT_DERIVED_SOURCE_ID,
  CONTEXT_RESERVED_REQUEST_KEY_PREFIX,
  CONTEXT_RESOLUTION_POLICY_METADATA_KEY,
  CONTEXT_SOURCE_KINDS,
  CONTEXT_TRUST_CLASSES,
  DEFAULT_CONTEXT_ASSERTED_FACT_POLICY,
  TERMINAL_CONTEXT_TRUST_CLASSES,
  contextDeclarationAssertedFactPolicy,
  contextObservationProvenanceDigest,
  contextResolutionDigest,
  contextSourceAttestationFor,
  contextTrustClassSatisfies,
  evaluateContextDerivation,
  isAdmissibleContextFactValue,
  isContextFactClass,
  isFreshAt,
  isFutureDatedAt,
  isReservedContextKey,
  isTerminalContextTrustClass,
  minimumContextTrustClass,
  readContextFact,
  readContextFacts,
  staleAtFor,
  unresolvedContextResolution,
  validateContextDeclaration,
  validateContextDerivation,
  validateContextFact,
  validateContextSource,
} from './domain/index.js';

export { ContextConfigurationError, ContextResolutionService, ContextSourceRegistry, createFailingContextResolver, createInMemoryContextResolver } from './services/index.js';
export type { ContextAttestationVerifier, ContextResolutionServiceOptions } from './services/index.js';
