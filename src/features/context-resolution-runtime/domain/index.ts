export type { ContextTrustClass, TerminalContextTrustClass } from './context-trust.js';
export {
  CONTEXT_TRUST_CLASSES,
  TERMINAL_CONTEXT_TRUST_CLASSES,
  contextTrustClassSatisfies,
  isTerminalContextTrustClass,
  minimumContextTrustClass,
} from './context-trust.js';

export type { ContextSource, ContextSourceKind } from './context-source.js';
export { CONTEXT_DERIVED_SOURCE, CONTEXT_DERIVED_SOURCE_ID, CONTEXT_SOURCE_KINDS, validateContextSource } from './context-source.js';

export type {
  ContextFact,
  ContextFactDerivation,
  ContextFactFreshness,
  ContextFactObservation,
  ContextFactResolution,
  ContextFactValue,
  ResolvedContextFactStatus,
} from './context-fact.js';
export { isFreshAt, staleAtFor, validateContextFact } from './context-fact.js';

export type { ContextDerivation, ContextDerivationFailureReason, ContextDerivationOperator, ContextDerivationOutcome } from './context-derivation.js';
export { CONTEXT_DERIVATION_OPERATORS, evaluateContextDerivation, validateContextDerivation } from './context-derivation.js';

export type { ContextAssertedFactPolicy, ContextDeclaration, ContextRequirement } from './context-requirement.js';
export {
  CONTEXT_ASSERTED_FACT_POLICIES,
  DEFAULT_CONTEXT_ASSERTED_FACT_POLICY,
  contextDeclarationAssertedFactPolicy,
  validateContextDeclaration,
} from './context-requirement.js';

export type { ContextResolution } from './context-resolution.js';
export {
  CONTEXT_RESERVED_REQUEST_KEY_PREFIX,
  CONTEXT_RESOLUTION_POLICY_METADATA_KEY,
  isReservedContextKey,
  unresolvedContextResolution,
} from './context-resolution.js';

export type { ContextFactRead, ContextFactReadStatus } from './context-fact-read.js';
export { readContextFact, readContextFacts } from './context-fact-read.js';

export type { ContextResolutionQuery, ContextResolverOutput, ContextResolverPort } from './context-resolver-port.js';
