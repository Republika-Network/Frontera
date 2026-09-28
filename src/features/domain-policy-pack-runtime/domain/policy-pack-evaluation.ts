import type { GovernedParameter } from '../../governed-parameter-runtime/index.js';
import type { PolicyRiskLevel } from './policy-pack-effect.js';
import type { PolicyEffectType } from './policy-pack-effect.js';
import type { PolicyObligation } from './policy-pack-obligation.js';
import type { PolicyEvidenceRequirement } from './policy-pack-evidence.js';
import type { PolicyApprovalRequirement } from './policy-pack-approval.js';
import type { PolicyApplicabilityResult } from './policy-pack-applicability.js';
import type { PolicyPackDecision } from './policy-pack-decision.js';
import type { PolicyPackProof } from './policy-pack-proof.js';
import type { PolicyPackEvent } from './policy-pack-event.js';

export interface PolicyEvaluationInput {
  readonly id: string;
  readonly trustDomainId: string;
  readonly actorId: string;
  readonly actorType?: string;
  readonly principalActorId?: string;
  readonly action: string;
  readonly capability?: string;
  readonly resourceScope: string;
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
  readonly sideEffectType?: string;
  readonly riskLevel: PolicyRiskLevel;
  readonly requestedAt: string;
  readonly hasApprovalProof?: boolean;
  readonly hasAuthorityProof?: boolean;
  readonly hasHandshakeProof?: boolean;
  readonly hasRequiredEvidence?: boolean;
  readonly approvalProofId?: string;
  readonly authorityProofId?: string;
  readonly handshakeProofId?: string;
  readonly evidenceIds?: readonly string[];

  /** CORE-03 — trusted semantic classification (domain-declared, opaque) and the typed parameter values the action proposes. */
  readonly actionClass?: string;
  readonly resourceClass?: string;
  readonly governanceProfile?: string;
  /** CORE-03 — the effective (trusted, server-resolved) Governance Profile's version. An integer; ordered predicates compare it numerically. */
  readonly governanceProfileVersion?: number;
  readonly governedParameters?: readonly GovernedParameter[];
  /**
   * CORE-04 — trusted context, admitted by the Trusted Context Boundary and
   * only that: one entry per material fact class whose reading was admitted,
   * fresh, unambiguous and at the declared trust class. A stale, conflicted,
   * refused or missing fact is simply absent. Never caller input.
   */
  readonly contextFacts?: readonly { readonly factClass: string; readonly value: string | number | boolean }[];
  /** CORE-04 — admitted restrict-only facts, on the same terms; readable only by restrict-only rules. */
  readonly restrictiveFacts?: readonly { readonly factClass: string; readonly value: string | number | boolean }[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PolicyRuleEvaluationResult {
  readonly policyPackId: string;
  readonly policyPackVersionId: string;
  readonly ruleId: string;
  readonly matched: boolean;
  readonly effectType?: PolicyEffectType;
  readonly riskOverride?: PolicyRiskLevel;
  readonly limitedActions?: readonly string[];
  readonly limitedCapabilities?: readonly string[];
  readonly limitedResourceScopes?: readonly string[];
  readonly severity: 'info' | 'warning' | 'error' | 'critical';
  readonly reasonCode: string;
  readonly reason: string;
  readonly obligations: readonly PolicyObligation[];
  readonly evidenceRequirements: readonly PolicyEvidenceRequirement[];
  readonly approvalRequirements: readonly PolicyApprovalRequirement[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PolicyPackEvaluationResult {
  readonly id: string;
  readonly input: PolicyEvaluationInput;
  readonly decision: PolicyPackDecision;
  readonly applicabilityResults: readonly PolicyApplicabilityResult[];
  readonly ruleResults: readonly PolicyRuleEvaluationResult[];
  readonly proof?: PolicyPackProof;
  readonly events: readonly PolicyPackEvent[];
}
