import type { PolicyEffectType, PolicyRiskLevel } from '../domain/policy-pack-effect.js';
import type {
  PolicyEvaluationInput,
  PolicyPackEvaluationResult,
  PolicyRuleEvaluationResult,
} from '../domain/policy-pack-evaluation.js';
import type { PolicyPackDecision, PolicyPackDecisionType } from '../domain/policy-pack-decision.js';
import type { PolicyPackEvent } from '../domain/policy-pack-event.js';
import type { PolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyPackApplicabilityService } from './policy-pack-applicability-service.js';
import { PolicyRuleEvaluator } from './policy-rule-evaluator.js';
import { PolicyObligationService } from './policy-obligation-service.js';
import { PolicyEvidenceService } from './policy-evidence-service.js';
import { PolicyApprovalRequirementService } from './policy-approval-requirement-service.js';
import { PolicyRiskClassifier } from './policy-risk-classifier.js';
import { PolicyPackProofService } from './policy-pack-proof-service.js';
import { PolicyPackLedger } from './policy-pack-ledger.js';
import type { PolicyPackStore } from './policy-pack-store.js';
import { isCanonicalDecimal } from '../../monetary-runtime/index.js';

/**
 * Decision precedence, most to least restrictive. A rule with effect type
 * `no_op` never wins -- it may still contribute obligations, but it can
 * never determine the decision type.
 */
const EFFECT_PRECEDENCE: readonly PolicyEffectType[] = [
  'deny',
  'require_external_standing',
  'require_authority',
  'require_approval',
  'require_evidence',
  'limit_scope',
  'raise_risk',
  'warn',
  'allow',
];

const EFFECT_TO_DECISION_TYPE: Readonly<Record<PolicyEffectType, PolicyPackDecisionType>> = {
  deny: 'denied',
  require_external_standing: 'requires_external_standing',
  require_authority: 'requires_authority',
  require_approval: 'requires_approval',
  require_evidence: 'requires_evidence',
  limit_scope: 'limited',
  raise_risk: 'warning',
  warn: 'warning',
  allow: 'allowed',
  no_op: 'not_applicable',
};

/** Decision types that permit the caller to continue (do not themselves block execution). */
const NON_BLOCKING_DECISION_TYPES: ReadonlySet<PolicyPackDecisionType> = new Set(['allowed', 'warning', 'not_applicable']);

/**
 * Composes applicability resolution, rule evaluation and effect aggregation
 * into a single deterministic PolicyPackDecision, with a full proof and
 * event trail. This is the only service that decides the final decision --
 * every other service in this module only collects or classifies inputs to
 * it.
 */
export class PolicyPackEvaluationService {
  private readonly applicabilityService: PolicyPackApplicabilityService;
  private readonly ruleEvaluator = new PolicyRuleEvaluator();
  private readonly obligationService = new PolicyObligationService();
  private readonly evidenceService = new PolicyEvidenceService();
  private readonly approvalService = new PolicyApprovalRequirementService();
  private readonly riskClassifier = new PolicyRiskClassifier();
  private readonly proofService: PolicyPackProofService;
  private readonly ledger: PolicyPackLedger;

  constructor(
    private readonly ctx: PolicyPackRuntimeContext,
    private readonly store: PolicyPackStore,
    ledger?: PolicyPackLedger,
  ) {
    this.applicabilityService = new PolicyPackApplicabilityService(store);
    this.proofService = new PolicyPackProofService(ctx, store);
    this.ledger = ledger ?? new PolicyPackLedger(ctx, store);
  }

  evaluate(input: PolicyEvaluationInput): PolicyPackEvaluationResult {
    const evaluationId = this.ctx.ids.nextId('policy-evaluation');
    const events: PolicyPackEvent[] = [];

    events.push(
      this.ledger.recordEvent({
        type: 'policy_evaluation_started',
        evaluationId,
        trustDomainId: input.trustDomainId,
        actorId: input.actorId,
        payload: { action: input.action, resourceScope: input.resourceScope, inputId: input.id },
      }),
    );

    if (this.isInvalidInput(input)) {
      const decision = this.buildDecision(input, 'invalid_input', [], [], 'INVALID_INPUT', 'Policy evaluation input is missing required fields.');
      this.store.saveDecision(decision);
      events.push(
        this.ledger.recordEvent({
          type: 'policy_decision_created',
          evaluationId,
          decisionId: decision.id,
          trustDomainId: input.trustDomainId,
          actorId: input.actorId,
          payload: { type: decision.type, reasonCode: decision.reasonCode },
        }),
      );
      const proof = this.proofService.createProof({
        evaluationId,
        input,
        ruleResults: [],
        decision,
        policyPackVersionIds: [],
        matchedRuleIds: [],
      });
      events.push(
        this.ledger.recordEvent({
          type: 'policy_proof_created',
          evaluationId,
          decisionId: decision.id,
          proofId: proof.id,
          trustDomainId: input.trustDomainId,
          actorId: input.actorId,
          payload: { proofHash: proof.proofHash },
        }),
      );

      const finalInvalidDecision: PolicyPackDecision = { ...decision, proofId: proof.id };
      this.store.saveDecision(finalInvalidDecision);

      const result: PolicyPackEvaluationResult = {
        id: evaluationId,
        input,
        decision: finalInvalidDecision,
        applicabilityResults: [],
        ruleResults: [],
        proof,
        events,
      };
      this.store.saveEvaluation(result);
      return result;
    }

    const applicabilityResults = this.applicabilityService.resolveApplicability(input);
    events.push(
      this.ledger.recordEvent({
        type: 'policy_pack_applicability_resolved',
        evaluationId,
        trustDomainId: input.trustDomainId,
        actorId: input.actorId,
        payload: { applicableCount: applicabilityResults.filter((result) => result.applicable).length },
      }),
    );

    const applicableVersionIds = applicabilityResults.filter((result) => result.applicable).map((result) => result.policyPackVersionId);
    const applicableVersions = applicableVersionIds
      .map((versionId) => this.store.getVersion(versionId))
      .filter((version): version is NonNullable<typeof version> => version !== undefined);

    const ruleResults = this.ruleEvaluator.evaluate(applicableVersions, input);
    for (const result of ruleResults) {
      events.push(
        this.ledger.recordEvent({
          type: result.matched ? 'policy_rule_matched' : 'policy_rule_not_matched',
          evaluationId,
          policyPackId: result.policyPackId,
          policyPackVersionId: result.policyPackVersionId,
          trustDomainId: input.trustDomainId,
          actorId: input.actorId,
          payload: { ruleId: result.ruleId, effectType: result.effectType, reasonCode: result.reasonCode },
        }),
      );
    }

    const matchedRuleIds = ruleResults.filter((result) => result.matched).map((result) => result.ruleId);
    const winner = this.selectWinningEffect(ruleResults);

    const decisionType: PolicyPackDecisionType =
      winner !== undefined ? EFFECT_TO_DECISION_TYPE[winner.effectType as PolicyEffectType] : 'not_applicable';

    const reasonCode = winner?.reasonCode ?? (applicableVersions.length === 0 ? 'NO_APPLICABLE_POLICY_PACK' : 'NO_RULE_MATCHED');
    const reason =
      winner?.reason ??
      (applicableVersions.length === 0
        ? 'No policy pack version applies to this action.'
        : 'No active rule in the applicable policy pack versions matched this action.');

    const decision = this.buildDecision(input, decisionType, applicableVersionIds, matchedRuleIds, reasonCode, reason, ruleResults, winner);
    this.store.saveDecision(decision);

    events.push(
      this.ledger.recordEvent({
        type: 'policy_decision_created',
        evaluationId,
        decisionId: decision.id,
        trustDomainId: input.trustDomainId,
        actorId: input.actorId,
        payload: { type: decision.type, reasonCode: decision.reasonCode, allowed: decision.allowed },
      }),
    );

    const proof = this.proofService.createProof({
      evaluationId,
      input,
      ruleResults,
      decision,
      policyPackVersionIds: applicableVersionIds,
      matchedRuleIds,
    });

    events.push(
      this.ledger.recordEvent({
        type: 'policy_proof_created',
        evaluationId,
        decisionId: decision.id,
        proofId: proof.id,
        trustDomainId: input.trustDomainId,
        actorId: input.actorId,
        payload: { proofHash: proof.proofHash },
      }),
    );

    const finalDecision: PolicyPackDecision = { ...decision, proofId: proof.id };
    this.store.saveDecision(finalDecision);

    const result: PolicyPackEvaluationResult = {
      id: evaluationId,
      input,
      decision: finalDecision,
      applicabilityResults,
      ruleResults,
      proof,
      events,
    };
    this.store.saveEvaluation(result);
    return result;
  }

  private isInvalidInput(input: PolicyEvaluationInput): boolean {
    return (
      !input.trustDomainId ||
      !input.actorId ||
      !input.action ||
      !input.resourceScope ||
      !input.riskLevel ||
      !input.requestedAt ||
      // P9: an amount is canonical decimal text or it is not an amount. A
      // number (or any other spelling) is malformed input and fails closed —
      // it is never compared, so a threshold rule can never be skipped by it.
      (input.amount !== undefined && !isCanonicalDecimal(input.amount))
    );
  }

  private selectWinningEffect(ruleResults: readonly PolicyRuleEvaluationResult[]): PolicyRuleEvaluationResult | undefined {
    const matched = ruleResults.filter((result) => result.matched && result.effectType !== undefined && result.effectType !== 'no_op');
    for (const effectType of EFFECT_PRECEDENCE) {
      const winner = matched.find((result) => result.effectType === effectType);
      if (winner) {
        return winner;
      }
    }
    return undefined;
  }

  private buildDecision(
    input: PolicyEvaluationInput,
    type: PolicyPackDecisionType,
    applicablePackVersionIds: readonly string[],
    matchedRuleIds: readonly string[],
    reasonCode: string,
    reason: string,
    ruleResults: readonly PolicyRuleEvaluationResult[] = [],
    winner?: PolicyRuleEvaluationResult,
  ): PolicyPackDecision {
    const obligations = this.obligationService.collect(ruleResults);
    const evidence = this.evidenceService.collect(ruleResults, input);
    const approvals = this.approvalService.collect(ruleResults);
    const risk = this.riskClassifier.classify(input.riskLevel, ruleResults);

    const limitRules = ruleResults.filter((result) => result.matched && result.effectType === 'limit_scope');
    const limitedActions = type === 'limited' ? this.unionRuleField(limitRules, 'limitedActions') : undefined;
    const limitedCapabilities = type === 'limited' ? this.unionRuleField(limitRules, 'limitedCapabilities') : undefined;
    const limitedResourceScopes = type === 'limited' ? this.unionRuleField(limitRules, 'limitedResourceScopes') : undefined;

    return {
      id: this.ctx.ids.nextId('policy-decision'),
      inputId: input.id,
      type,
      allowed: NON_BLOCKING_DECISION_TYPES.has(type),
      trustDomainId: input.trustDomainId,
      actorId: input.actorId,
      action: input.action,
      resourceScope: input.resourceScope,
      riskLevel: input.riskLevel as PolicyRiskLevel,
      effectiveRiskLevel: risk.effectiveRiskLevel,
      applicablePackVersionIds,
      matchedRuleIds,
      obligations: obligations.all,
      evidenceRequirements: evidence.requirements,
      approvalRequirements: approvals,
      reasonCode,
      reason,
      decidedAt: this.ctx.clock.now(),
      ...(input.capability !== undefined ? { capability: input.capability } : {}),
      ...(limitedActions !== undefined && limitedActions.length > 0 ? { limitedActions } : {}),
      ...(limitedCapabilities !== undefined && limitedCapabilities.length > 0 ? { limitedCapabilities } : {}),
      ...(limitedResourceScopes !== undefined && limitedResourceScopes.length > 0 ? { limitedResourceScopes } : {}),
    };
  }

  private unionRuleField(
    rules: readonly PolicyRuleEvaluationResult[],
    field: 'limitedActions' | 'limitedCapabilities' | 'limitedResourceScopes',
  ): readonly string[] {
    const values = new Set<string>();
    for (const rule of rules) {
      for (const value of rule[field] ?? []) {
        values.add(value);
      }
    }
    return [...values];
  }
}
