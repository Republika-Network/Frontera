import type { EnforcementDecisionType } from '../domain/enforcement-decision.js';
import type { RecognitionVerificationResult } from '../domain/enforcement-context.js';
import type { EnforcementRequest } from '../domain/enforcement-request.js';
import type { EnforcementPolicySeverity } from '../domain/enforcement-verification.js';
import type {
  EnforcementPolicyPackEvaluationInput,
  EnforcementPolicyPackEvaluationResult,
  EnforcementPolicyPackIntegration,
  PolicyPackEnforcementDecisionType,
  PolicyPackEnforcementEvaluation,
  PolicyPackEnforcementViolationType,
} from '../domain/policy-pack-enforcement.js';
import type { EnforcementRuntimeContext } from '../runtime/enforcement-runtime-context.js';

const VALID_RESULT_TYPES: ReadonlySet<PolicyPackEnforcementDecisionType> = new Set([
  'policy_allowed',
  'policy_denied',
  'policy_requires_evidence',
  'policy_requires_approval',
  'policy_requires_authority',
  'policy_requires_external_standing',
  'policy_limited',
  'policy_warning',
  'policy_not_applicable',
]);

/** Result types that must always carry `allowed === false`. Every other known type must carry `allowed === true`; `policy_limited` is resolved separately (its scope-conflict outcome decides `allowed`). */
const INHERENTLY_BLOCKING_TYPES: ReadonlySet<PolicyPackEnforcementDecisionType> = new Set([
  'policy_denied',
  'policy_requires_evidence',
  'policy_requires_approval',
  'policy_requires_authority',
  'policy_requires_external_standing',
]);

const BLOCKING_DECISION_TYPE_MAP: Readonly<Partial<Record<PolicyPackEnforcementDecisionType, EnforcementDecisionType>>> = {
  policy_denied: 'execution_blocked',
  policy_requires_evidence: 'evidence_required',
  policy_requires_approval: 'approval_required',
  policy_requires_authority: 'execution_blocked',
  policy_requires_external_standing: 'external_handshake_required',
  policy_limited: 'execution_blocked',
};

const NOT_CONFIGURED_RESULT: EnforcementPolicyPackEvaluationResult = {
  type: 'policy_not_applicable',
  allowed: true,
  reasonCode: 'POLICY_PACK_NOT_CONFIGURED',
  reason: 'No policy pack integration is configured for this enforcement runtime.',
};

function integrationErrorResult(error: unknown): EnforcementPolicyPackEvaluationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'policy_denied',
    allowed: false,
    reasonCode: 'POLICY_PACK_INTEGRATION_ERROR',
    reason: `Domain Policy Pack Runtime integration threw while evaluating this request: ${message}`,
  };
}

const INVALID_RESULT_RESULT: EnforcementPolicyPackEvaluationResult = {
  type: 'policy_denied',
  allowed: false,
  reasonCode: 'POLICY_PACK_INVALID_RESULT',
  reason: 'Domain Policy Pack Runtime integration returned a malformed evaluation result; failing closed.',
};

/** Fail-closed structural validation of whatever the integration returned -- an integration bug or a wire-format drift must never be read as "no constraint applies". */
function isWellFormedResult(result: unknown): result is EnforcementPolicyPackEvaluationResult {
  if (result === null || typeof result !== 'object') {
    return false;
  }
  const candidate = result as Partial<EnforcementPolicyPackEvaluationResult>;
  if (typeof candidate.type !== 'string' || !VALID_RESULT_TYPES.has(candidate.type as PolicyPackEnforcementDecisionType)) {
    return false;
  }
  if (typeof candidate.allowed !== 'boolean') {
    return false;
  }
  if (typeof candidate.reasonCode !== 'string' || candidate.reasonCode.length === 0) {
    return false;
  }
  if (typeof candidate.reason !== 'string' || candidate.reason.length === 0) {
    return false;
  }
  const type = candidate.type as PolicyPackEnforcementDecisionType;
  if (INHERENTLY_BLOCKING_TYPES.has(type) && candidate.allowed !== false) {
    return false;
  }
  if ((type === 'policy_allowed' || type === 'policy_warning' || type === 'policy_not_applicable') && candidate.allowed !== true) {
    return false;
  }
  return true;
}

function isWithinDeclaredLimits(input: EnforcementPolicyPackEvaluationInput, result: EnforcementPolicyPackEvaluationResult): boolean {
  if (result.limitedActions !== undefined && result.limitedActions.length > 0 && !result.limitedActions.includes(input.action)) {
    return false;
  }
  if (
    result.limitedCapabilities !== undefined &&
    result.limitedCapabilities.length > 0 &&
    (input.capability === undefined || !result.limitedCapabilities.includes(input.capability))
  ) {
    return false;
  }
  if (
    result.limitedResourceScopes !== undefined &&
    result.limitedResourceScopes.length > 0 &&
    !result.limitedResourceScopes.includes(input.resourceScope)
  ) {
    return false;
  }
  return true;
}

/** Resolves a `policy_limited` result into a concrete allow/block outcome: allowed only if the requested action/capability/scope stays within whatever the policy pack limited it to. */
function resolveLimitedResult(
  input: EnforcementPolicyPackEvaluationInput,
  result: EnforcementPolicyPackEvaluationResult,
): EnforcementPolicyPackEvaluationResult {
  if (isWithinDeclaredLimits(input, result)) {
    return { ...result, allowed: true };
  }
  return {
    ...result,
    allowed: false,
    reasonCode: 'POLICY_LIMITED_SCOPE_VIOLATION',
    reason: `${result.reason} The requested action/capability/resourceScope falls outside the scope this policy pack limited it to.`,
  };
}

/** Severities mirror the existing core enforcement policies: pending states (evidence/approval) are 'warning', hard blocks are 'error'/'critical'. */
function severityForBlockedResult(result: EnforcementPolicyPackEvaluationResult): EnforcementPolicySeverity {
  switch (result.type) {
    case 'policy_denied':
      return 'critical';
    case 'policy_requires_authority':
      return 'error';
    case 'policy_requires_external_standing':
      return 'error';
    case 'policy_requires_approval':
    case 'policy_requires_evidence':
      return 'warning';
    case 'policy_limited':
      return 'error';
    default:
      return 'critical';
  }
}

function violationTypeForResult(result: EnforcementPolicyPackEvaluationResult): PolicyPackEnforcementViolationType {
  if (result.reasonCode === 'POLICY_PACK_INTEGRATION_ERROR') {
    return 'policy_integration_error';
  }
  if (result.reasonCode === 'POLICY_PACK_INVALID_RESULT') {
    return 'policy_invalid_result';
  }
  switch (result.type) {
    case 'policy_requires_evidence':
      return 'policy_requires_evidence';
    case 'policy_requires_approval':
      return 'policy_requires_approval';
    case 'policy_requires_authority':
      return 'policy_requires_authority';
    case 'policy_requires_external_standing':
      return 'policy_requires_external_standing';
    default:
      return 'policy_denied';
  }
}

/** Never invokes, never executes, never mutates anything upstream -- pure evaluation + mapping over an optional Domain Policy Pack Runtime integration. */
export class PolicyPackEnforcementService {
  constructor(
    private readonly ctx: EnforcementRuntimeContext,
    private readonly integration?: EnforcementPolicyPackIntegration,
  ) {}

  isConfigured(): boolean {
    return this.integration !== undefined;
  }

  buildEvaluationInput(request: EnforcementRequest, now: string, recognitionResult?: RecognitionVerificationResult): EnforcementPolicyPackEvaluationInput {
    const intent = request.intent;
    const evalInput = request.policyEvaluationInput;
    const authorityProofId = recognitionResult?.authorityProofId;
    const approvalProofId = recognitionResult?.approvalProofId ?? request.approvalProofId;
    const handshakeProofId = recognitionResult?.handshakeProofId ?? request.handshakeProofId;

    return {
      enforcementRequestId: request.id,
      trustDomainId: request.trustDomainId,
      actorId: request.actorId,
      action: request.action,
      resourceScope: request.resourceScope,
      riskLevel: intent.riskLevel,
      sideEffectType: intent.sideEffectType,
      requestedAt: now,
      ...(request.principalActorId !== undefined ? { principalActorId: request.principalActorId } : {}),
      ...(request.capability !== undefined ? { capability: request.capability } : {}),
      ...(authorityProofId !== undefined ? { authorityProofId } : {}),
      ...(approvalProofId !== undefined ? { approvalProofId } : {}),
      ...(handshakeProofId !== undefined ? { handshakeProofId } : {}),
      ...(evalInput?.domain !== undefined ? { domain: evalInput.domain } : {}),
      ...(evalInput?.jurisdiction !== undefined ? { jurisdiction: evalInput.jurisdiction } : {}),
      ...(evalInput?.country !== undefined ? { country: evalInput.country } : {}),
      ...(evalInput?.industry !== undefined ? { industry: evalInput.industry } : {}),
      ...(evalInput?.customerId !== undefined ? { customerId: evalInput.customerId } : {}),
      ...(evalInput?.amount !== undefined ? { amount: evalInput.amount } : {}),
      ...(evalInput?.currency !== undefined ? { currency: evalInput.currency } : {}),
      ...(evalInput?.counterpartyId !== undefined ? { counterpartyId: evalInput.counterpartyId } : {}),
      ...(evalInput?.dataDomains !== undefined ? { dataDomains: evalInput.dataDomains } : {}),
      ...(evalInput?.evidenceIds !== undefined ? { evidenceIds: evalInput.evidenceIds } : {}),
      ...(evalInput?.actionClass !== undefined ? { actionClass: evalInput.actionClass } : {}),
      ...(evalInput?.resourceClass !== undefined ? { resourceClass: evalInput.resourceClass } : {}),
      ...(evalInput?.governanceProfile !== undefined ? { governanceProfile: evalInput.governanceProfile } : {}),
      ...(evalInput?.governedParameters !== undefined ? { governedParameters: evalInput.governedParameters } : {}),
      ...(evalInput?.metadata !== undefined ? { metadata: evalInput.metadata } : {}),
    };
  }

  /**
   * Deterministically evaluates the configured policy pack integration (if
   * any) for this request. Never throws: an unconfigured integration
   * resolves to `policy_not_applicable`/allowed, a throwing integration and
   * a malformed result both resolve to a fail-closed `policy_denied`.
   */
  evaluatePolicyPackForRequest(request: EnforcementRequest, now: string, recognitionResult?: RecognitionVerificationResult): EnforcementPolicyPackEvaluationResult {
    if (!this.integration) {
      return NOT_CONFIGURED_RESULT;
    }

    const input = this.buildEvaluationInput(request, now, recognitionResult);

    let rawResult: unknown;
    try {
      rawResult = this.integration.evaluatePolicyForEnforcement(input);
    } catch (error) {
      return integrationErrorResult(error);
    }

    if (!isWellFormedResult(rawResult)) {
      return INVALID_RESULT_RESULT;
    }

    if (rawResult.type === 'policy_limited') {
      return resolveLimitedResult(input, rawResult);
    }

    return rawResult;
  }

  toPolicyPackEnforcementEvaluation(request: EnforcementRequest, result: EnforcementPolicyPackEvaluationResult, now: string): PolicyPackEnforcementEvaluation {
    return {
      id: this.ctx.ids.nextId('policy-pack-enforcement-evaluation'),
      enforcementRequestId: request.id,
      type: result.type,
      allowed: result.allowed,
      policyPackVersionIds: result.policyPackVersionIds ?? [],
      matchedRuleIds: result.matchedRuleIds ?? [],
      reasonCode: result.reasonCode,
      reason: result.reason,
      evidenceRequirementIds: (result.evidenceRequirements ?? []).map((requirement) => requirement.id),
      approvalRequirementIds: (result.approvalRequirements ?? []).map((requirement) => requirement.id),
      obligationIds: (result.obligations ?? []).map((obligation) => obligation.id),
      evaluatedAt: now,
      ...(result.policyDecisionId !== undefined ? { policyDecisionId: result.policyDecisionId } : {}),
      ...(result.policyProofId !== undefined ? { policyProofId: result.policyProofId } : {}),
      ...(result.effectiveRiskLevel !== undefined ? { effectiveRiskLevel: result.effectiveRiskLevel } : {}),
      ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    };
  }
}

/** `undefined` means "does not block" -- the policy chain must not override the prevailing decision type in that case. */
export function mapPolicyResultToEnforcementDecisionType(result: EnforcementPolicyPackEvaluationResult): EnforcementDecisionType | undefined {
  if (result.allowed) {
    return undefined;
  }
  return BLOCKING_DECISION_TYPE_MAP[result.type] ?? 'execution_blocked';
}

export function shouldBlockForPolicy(result: EnforcementPolicyPackEvaluationResult): boolean {
  return !result.allowed;
}

export function severityForPolicyPackResult(result: EnforcementPolicyPackEvaluationResult): EnforcementPolicySeverity {
  return severityForBlockedResult(result);
}

export function policyPackViolationType(result: EnforcementPolicyPackEvaluationResult): PolicyPackEnforcementViolationType {
  return violationTypeForResult(result);
}
