export type PolicyConditionOperator = 'all' | 'any' | 'not';

export type PolicyPredicateOperator =
  | 'equals'
  | 'not_equals'
  | 'includes'
  | 'not_includes'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'exists'
  | 'not_exists';

export type PolicyPredicateField =
  | 'trustDomainId'
  | 'actorId'
  | 'actorType'
  | 'principalActorId'
  | 'action'
  | 'capability'
  | 'resourceScope'
  | 'riskLevel'
  | 'jurisdiction'
  | 'country'
  | 'industry'
  | 'domain'
  | 'amount'
  | 'currency'
  | 'counterpartyId'
  | 'dataDomains'
  | 'sideEffectType'
  | 'hasApprovalProof'
  | 'hasAuthorityProof'
  | 'hasHandshakeProof'
  | 'hasRequiredEvidence'
  | 'metadata'
  // CORE-03: the trusted semantic classification and the typed parameters.
  | 'actionClass'
  | 'resourceClass'
  | 'governanceProfile'
  | 'governanceProfileVersion'
  | 'parameter'
  // CORE-04: trusted context, admitted by the Trusted Context Boundary.
  | 'contextFact'
  | 'restrictiveFact';

export interface PolicyGroupCondition {
  readonly type: 'group';
  readonly operator: PolicyConditionOperator;
  readonly conditions: readonly PolicyCondition[];
}

export interface PolicyPredicateCondition {
  readonly type: 'predicate';
  readonly field: PolicyPredicateField;
  readonly operator: PolicyPredicateOperator;
  readonly value?: unknown;
  readonly metadataPath?: string;
  /**
   * CORE-03 — the declared parameter dimension a `field: 'parameter'`
   * predicate reads, exactly (case-sensitive, no path). Required with that
   * field and refused with any other. Reads the typed value — a JSON number
   * for an integer dimension, a string for a token, a boolean — and an
   * undeclared or absent dimension reads as absent, never as a default.
   */
  readonly parameterId?: string;
  /**
   * CORE-04 — the fact class a `field: 'contextFact'` or
   * `field: 'restrictiveFact'` predicate reads, exactly (case-sensitive, no
   * path). Required with those fields and refused with any other.
   *
   * Only **admitted** facts are readable: a fact that was missing, stale,
   * conflicted, refused or below its declared trust class reads as absent —
   * never as `false`, never as a default. `contextFact` reads material facts;
   * `restrictiveFact` reads restrict-only facts, and a rule that does so may
   * only restrict (validator: no `allow`/`no_op` effect, no negation).
   */
  readonly factClass?: string;
}

export type PolicyCondition = PolicyGroupCondition | PolicyPredicateCondition;
