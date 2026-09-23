import type { ExecutionRiskLevel } from './execution-intent.js';

/**
 * Structural bridge to Domain Policy Pack Runtime. Mirrors the local
 * structural interfaces already used to consult Recognition Runtime
 * (`EnforcementRecognitionIntegration` in ./enforcement-context.ts) --
 * Action Enforcement never imports Domain Policy Pack Runtime's own domain
 * types directly. A fixture or host composing both features is responsible
 * for adapting a `PolicyPackRuntime` (or its
 * `ActionEnforcementPolicyPackIntegration` adapter) onto this shape.
 */
export interface EnforcementPolicyPackEvaluationInput {
  readonly enforcementRequestId?: string;

  readonly trustDomainId: string;
  readonly actorId: string;
  readonly actorType?: string;
  readonly principalActorId?: string;

  readonly action: string;
  readonly capability?: string;
  readonly resourceScope: string;

  readonly sideEffectType?: string;
  readonly riskLevel: ExecutionRiskLevel;

  readonly domain?: string;
  readonly jurisdiction?: string;
  readonly country?: string;
  readonly industry?: string;
  readonly customerId?: string;

  /** Canonical decimal text (`src/features/monetary-runtime`), never a number. Ordered predicates compare it exactly. */
  readonly amount?: string;
  readonly currency?: string;
  readonly counterpartyId?: string;
  readonly dataDomains?: readonly string[];

  readonly requestedAt: string;

  readonly authorityProofId?: string;
  readonly approvalProofId?: string;
  readonly handshakeProofId?: string;
  readonly evidenceIds?: readonly string[];

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type PolicyPackEnforcementDecisionType =
  | 'policy_allowed'
  | 'policy_denied'
  | 'policy_requires_evidence'
  | 'policy_requires_approval'
  | 'policy_requires_authority'
  | 'policy_requires_external_standing'
  | 'policy_limited'
  | 'policy_warning'
  | 'policy_not_applicable';

export interface EnforcementPolicyPackEvidenceRequirement {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly required: boolean;
  readonly sourceRuleId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EnforcementPolicyPackApprovalRequirement {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly required: boolean;
  readonly minimumApprovals: number;
  readonly requiresSegregationOfDuties: boolean;
  readonly sourceRuleId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EnforcementPolicyPackObligation {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly required: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EnforcementPolicyPackEvaluationResult {
  readonly type: PolicyPackEnforcementDecisionType;

  readonly allowed: boolean;

  readonly policyDecisionId?: string;
  readonly policyProofId?: string;

  readonly policyPackVersionIds?: readonly string[];
  readonly matchedRuleIds?: readonly string[];

  readonly reasonCode: string;
  readonly reason: string;

  readonly evidenceRequirements?: readonly EnforcementPolicyPackEvidenceRequirement[];
  readonly approvalRequirements?: readonly EnforcementPolicyPackApprovalRequirement[];
  readonly obligations?: readonly EnforcementPolicyPackObligation[];

  /** Only meaningful when `type === 'policy_limited'`: the action/capability/resourceScope sets the limitation still permits. Absent or empty means "no requested-scope narrowing to check". */
  readonly limitedActions?: readonly string[];
  readonly limitedCapabilities?: readonly string[];
  readonly limitedResourceScopes?: readonly string[];

  readonly effectiveRiskLevel?: ExecutionRiskLevel;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EnforcementPolicyPackIntegration {
  evaluatePolicyForEnforcement(input: EnforcementPolicyPackEvaluationInput): EnforcementPolicyPackEvaluationResult;
}

export interface PolicyPackEnforcementEvaluation {
  readonly id: string;

  readonly enforcementRequestId: string;

  readonly type: PolicyPackEnforcementDecisionType;

  readonly allowed: boolean;

  readonly policyDecisionId?: string;
  readonly policyProofId?: string;

  readonly policyPackVersionIds: readonly string[];
  readonly matchedRuleIds: readonly string[];

  readonly reasonCode: string;
  readonly reason: string;

  readonly evidenceRequirementIds: readonly string[];
  readonly approvalRequirementIds: readonly string[];
  readonly obligationIds: readonly string[];

  readonly effectiveRiskLevel?: ExecutionRiskLevel;

  readonly evaluatedAt: string;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type PolicyPackEnforcementViolationType =
  | 'policy_denied'
  | 'policy_requires_evidence'
  | 'policy_requires_approval'
  | 'policy_requires_authority'
  | 'policy_requires_external_standing'
  | 'policy_integration_error'
  | 'policy_invalid_result';

export interface PolicyPackEnforcementViolation {
  readonly id: string;

  readonly enforcementRequestId: string;

  readonly type: PolicyPackEnforcementViolationType;

  readonly policyDecisionId?: string;
  readonly policyProofId?: string;

  readonly reasonCode: string;
  readonly reason: string;

  readonly severity: 'info' | 'warning' | 'error' | 'critical';

  readonly detectedAt: string;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PolicyPackEnforcementMetadata {
  readonly policyDecisionId?: string;
  readonly policyProofId?: string;
  readonly policyPackVersionIds?: readonly string[];
  readonly matchedRuleIds?: readonly string[];
  readonly policyReasonCode?: string;
  readonly policyReason?: string;
  readonly policyEffectiveRiskLevel?: ExecutionRiskLevel;
}
