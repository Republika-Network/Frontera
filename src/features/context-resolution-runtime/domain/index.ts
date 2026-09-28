export type { ContextTrustClass, TerminalContextTrustClass } from './context-trust.js';
export {
  CONTEXT_TRUST_CLASSES,
  TERMINAL_CONTEXT_TRUST_CLASSES,
  contextTrustClassSatisfies,
  isTerminalContextTrustClass,
  minimumContextTrustClass,
} from './context-trust.js';

export type { ContextSource, ContextSourceAttestation, ContextSourceKind, ContextSourceProvenanceRequirement } from './context-source.js';
export {
  CONTEXT_DERIVED_SOURCE,
  CONTEXT_DERIVED_SOURCE_ID,
  CONTEXT_FACT_CLASS_MAX_LENGTH,
  CONTEXT_MAX_AGE_SECONDS_LIMIT,
  CONTEXT_SOURCE_KINDS,
  CONTEXT_SOURCE_PROVENANCE_REQUIREMENTS,
  contextSourceAttestationFor,
  isContextFactClass,
  validateContextSource,
} from './context-source.js';

export type {
  ContextFact,
  ContextFactDerivation,
  ContextFactFreshness,
  ContextFactObservation,
  ContextFactResolution,
  ContextFactValue,
  ResolvedContextFactStatus,
} from './context-fact.js';
export { CONTEXT_FACT_STRING_MAX_LENGTH, isAdmissibleContextFactValue, isFreshAt, isFutureDatedAt, staleAtFor, validateContextFact } from './context-fact.js';

export type { ContextObservationProvenanceInput } from './context-digest.js';
export { ADMITTED_CONTEXT_FORMAT, CONTEXT_OBSERVATION_PROVENANCE_DOMAIN, contextObservationProvenanceDigest, contextResolutionDigest } from './context-digest.js';

export type { ContextDerivation, ContextDerivationFailureReason, ContextDerivationOperator, ContextDerivationOutcome } from './context-derivation.js';
export { CONTEXT_DERIVATION_OPERATORS, evaluateContextDerivation, validateContextDerivation } from './context-derivation.js';

export type { ContextAssertedFactPolicy, ContextDeclaration, ContextRequirement } from './context-requirement.js';
export {
  CONTEXT_ASSERTED_FACT_POLICIES,
  CONTEXT_MAX_FUTURE_SKEW_SECONDS,
  DEFAULT_CONTEXT_ASSERTED_FACT_POLICY,
  contextDeclarationAssertedFactPolicy,
  validateContextDeclaration,
} from './context-requirement.js';

export type { ContextObservationRefusalReason, ContextResolution, RefusedContextObservation } from './context-resolution.js';
export {
  CONTEXT_OBSERVATION_REFUSAL_REASONS,
  CONTEXT_RESERVED_REQUEST_KEY_PREFIX,
  CONTEXT_RESOLUTION_POLICY_METADATA_KEY,
  isReservedContextKey,
  unresolvedContextResolution,
} from './context-resolution.js';

export type { ContextFactRead, ContextFactReadStatus } from './context-fact-read.js';
export { readContextFact, readContextFacts } from './context-fact-read.js';

export type { ContextResolutionQuery, ContextResolverOutput, ContextResolverPort } from './context-resolver-port.js';
