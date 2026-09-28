export type PolicyPackEventType =
  | 'policy_pack_registered'
  | 'policy_pack_version_activated'
  | 'policy_pack_version_deprecated'
  | 'policy_pack_version_revoked'
  | 'policy_pack_version_superseded'
  | 'policy_pack_registry_frozen'
  | 'policy_evaluation_started'
  | 'policy_pack_applicability_resolved'
  | 'policy_rule_matched'
  | 'policy_rule_not_matched'
  | 'policy_decision_created'
  | 'policy_proof_created'
  | 'policy_simulation_started'
  | 'policy_simulation_completed';

export interface PolicyPackEvent {
  readonly id: string;
  readonly type: PolicyPackEventType;
  readonly policyPackId?: string;
  readonly policyPackVersionId?: string;
  readonly evaluationId?: string;
  readonly decisionId?: string;
  readonly proofId?: string;
  readonly trustDomainId?: string;
  readonly actorId?: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousHash?: string;
  readonly eventHash: string;
}
