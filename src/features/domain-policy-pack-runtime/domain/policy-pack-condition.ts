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
  | 'parameter';

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
}

export type PolicyCondition = PolicyGroupCondition | PolicyPredicateCondition;
