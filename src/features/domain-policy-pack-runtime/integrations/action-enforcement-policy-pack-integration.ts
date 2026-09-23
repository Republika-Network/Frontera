import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackDecisionType } from '../domain/policy-pack-decision.js';
import type { PolicyEvidenceRequirement } from '../domain/policy-pack-evidence.js';
import type { PolicyApprovalRequirement } from '../domain/policy-pack-approval.js';
import type { PolicyObligation } from '../domain/policy-pack-obligation.js';
import type { PolicyRiskLevel } from '../domain/policy-pack-effect.js';
import type { PolicyPackRuntime } from '../services/policy-pack-runtime.js';

export interface PolicyEnforcementEvaluationInput {
  readonly enforcementRequestId?: string;

  readonly trustDomainId: string;
  readonly actorId: string;
  readonly actorType?: string;
  readonly principalActorId?: string;

  readonly action: string;
  readonly capability?: string;
  readonly resourceScope: string;

  readonly sideEffectType?: string;
  readonly riskLevel: PolicyRiskLevel;

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

export type PolicyEnforcementEvaluationResultType =
  | 'policy_allowed'
  | 'policy_denied'
  | 'policy_requires_evidence'
  | 'policy_requires_approval'
  | 'policy_requires_authority'
  | 'policy_requires_external_standing'
  | 'policy_limited'
  | 'policy_warning'
  | 'policy_not_applicable';

export interface PolicyEnforcementEvaluationResult {
  readonly type: PolicyEnforcementEvaluationResultType;

  readonly allowed: boolean;

  readonly policyDecisionId?: string;
  readonly policyProofId?: string;

  readonly reasonCode: string;
  readonly reason: string;

  readonly evidenceRequirements?: readonly PolicyEvidenceRequirement[];
  readonly approvalRequirements?: readonly PolicyApprovalRequirement[];
  readonly obligations?: readonly PolicyObligation[];

  readonly effectiveRiskLevel?: PolicyRiskLevel;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActionEnforcementPolicyPackIntegration {
  evaluatePolicyForEnforcement(input: PolicyEnforcementEvaluationInput): PolicyEnforcementEvaluationResult;
}

/**
 * Fail-closed mapping: 'invalid_input' (malformed evaluation input) maps to
 * 'policy_denied', not 'policy_not_applicable' -- a policy pack runtime that
 * cannot evaluate an action must never be read by a caller as "no
 * constraint applies".
 */
const DECISION_TYPE_TO_RESULT_TYPE: Readonly<Record<PolicyPackDecisionType, PolicyEnforcementEvaluationResultType>> = {
  allowed: 'policy_allowed',
  denied: 'policy_denied',
  requires_evidence: 'policy_requires_evidence',
  requires_approval: 'policy_requires_approval',
  requires_authority: 'policy_requires_authority',
  requires_external_standing: 'policy_requires_external_standing',
  limited: 'policy_limited',
  warning: 'policy_warning',
  not_applicable: 'policy_not_applicable',
  invalid_input: 'policy_denied',
};

/**
 * Structural adapter Action Enforcement's preflight path can call to
 * consult the Domain Policy Pack Runtime. This module never imports
 * action-enforcement's EnforcementRequest/EnforcementPolicy types -- the
 * caller (a wiring layer inside action-enforcement, or a host composing
 * both runtimes) is responsible for mapping an EnforcementRequest onto
 * PolicyEnforcementEvaluationInput and for deciding how a
 * PolicyEnforcementEvaluationResult affects its own EnforcementDecision.
 * This integration only ever *evaluates and reports*; it never itself
 * blocks or allows execution, and it never re-derives a decision Action
 * Enforcement's own policy chain already made -- Action Enforcement's
 * default-deny chain (recognition/authority/approval/handshake/adapter/
 * idempotency) always runs independently of this result, so a
 * 'policy_allowed' result here can never override a deny produced there.
 */
export function createActionEnforcementPolicyPackIntegration(runtime: PolicyPackRuntime): ActionEnforcementPolicyPackIntegration {
  return {
    evaluatePolicyForEnforcement(input: PolicyEnforcementEvaluationInput): PolicyEnforcementEvaluationResult {
      const evaluationInput: PolicyEvaluationInput = {
        id: input.enforcementRequestId ?? `policy-enforcement-eval-${input.trustDomainId}-${input.actorId}-${input.action}-${input.resourceScope}-${input.requestedAt}`,
        trustDomainId: input.trustDomainId,
        actorId: input.actorId,
        action: input.action,
        resourceScope: input.resourceScope,
        riskLevel: input.riskLevel,
        requestedAt: input.requestedAt,
        hasAuthorityProof: input.authorityProofId !== undefined,
        hasApprovalProof: input.approvalProofId !== undefined,
        hasHandshakeProof: input.handshakeProofId !== undefined,
        hasRequiredEvidence: input.evidenceIds !== undefined && input.evidenceIds.length > 0,
        ...(input.actorType !== undefined ? { actorType: input.actorType } : {}),
        ...(input.principalActorId !== undefined ? { principalActorId: input.principalActorId } : {}),
        ...(input.capability !== undefined ? { capability: input.capability } : {}),
        ...(input.sideEffectType !== undefined ? { sideEffectType: input.sideEffectType } : {}),
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.industry !== undefined ? { industry: input.industry } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.counterpartyId !== undefined ? { counterpartyId: input.counterpartyId } : {}),
        ...(input.dataDomains !== undefined ? { dataDomains: input.dataDomains } : {}),
        ...(input.authorityProofId !== undefined ? { authorityProofId: input.authorityProofId } : {}),
        ...(input.approvalProofId !== undefined ? { approvalProofId: input.approvalProofId } : {}),
        ...(input.handshakeProofId !== undefined ? { handshakeProofId: input.handshakeProofId } : {}),
        ...(input.evidenceIds !== undefined ? { evidenceIds: input.evidenceIds } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };

      const { decision } = runtime.evaluatePolicy(evaluationInput);

      return {
        type: DECISION_TYPE_TO_RESULT_TYPE[decision.type],
        allowed: decision.type === 'invalid_input' ? false : decision.allowed,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        evidenceRequirements: decision.evidenceRequirements,
        approvalRequirements: decision.approvalRequirements,
        obligations: decision.obligations,
        effectiveRiskLevel: decision.effectiveRiskLevel,
        ...(decision.id !== undefined ? { policyDecisionId: decision.id } : {}),
        ...(decision.proofId !== undefined ? { policyProofId: decision.proofId } : {}),
      };
    },
  };
}
