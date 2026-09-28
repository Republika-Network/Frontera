import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyPackStore } from '../services/policy-pack-store.js';
import { PolicyPackLedger } from '../services/policy-pack-ledger.js';
import { PolicyPackRegistry } from '../services/policy-pack-registry.js';
import { PolicyPackEvaluationService } from '../services/policy-pack-evaluation-service.js';

/** NB-008: the trusted policy author these tests write as. */
const POLICY_WRITER = { system: true, actorId: 'operator:policy-pack-test' } as const;

const NOW = '2026-01-01T00:00:00.000Z';

function buildRule(overrides: Partial<PolicyPackRule> = {}): PolicyPackRule {
  return {
    id: overrides.id ?? 'rule-1',
    policyPackVersionId: 'pack-1-v1',
    name: 'Test rule',
    description: 'A test rule.',
    status: 'active',
    priority: 100,
    condition: { type: 'predicate', field: 'action', operator: 'equals', value: 'approve_payment' },
    effect: { type: 'allow', reasonCode: 'TEST_ALLOW', reason: 'Allowed for test.' },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'info',
    sourceIds: [],
    ...overrides,
  };
}

function buildInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'trust-domain-1',
    actorId: 'actor-1',
    action: 'approve_payment',
    resourceScope: 'scope-1',
    riskLevel: 'low',
    requestedAt: NOW,
    ...overrides,
  };
}

function setUp(rules: readonly PolicyPackRule[]) {
  const ctx = createPolicyPackRuntimeContext(NOW);
  const store = new PolicyPackStore();
  const ledger = new PolicyPackLedger(ctx, store);
  const registry = new PolicyPackRegistry(ctx, store, ledger);
  registry.registerPolicyPack(POLICY_WRITER, { id: 'pack-1', name: 'Test Pack', description: 'Test', kind: 'demo', domain: 'payments' });
  registry.registerPolicyPackVersion(POLICY_WRITER, {
    id: 'pack-1-v1',
    policyPackId: 'pack-1',
    version: '1.0.0',
    scope: {},
    rules,
    sources: [],
    effectiveFrom: NOW,
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
  const evaluationService = new PolicyPackEvaluationService(ctx, store, ledger);
  return { ctx, store, ledger, evaluationService };
}

function setUpEmpty() {
  const ctx = createPolicyPackRuntimeContext(NOW);
  const store = new PolicyPackStore();
  const ledger = new PolicyPackLedger(ctx, store);
  const evaluationService = new PolicyPackEvaluationService(ctx, store, ledger);
  return { ctx, store, ledger, evaluationService };
}

describe('PolicyPackEvaluationService', () => {
  it('1. returns not_applicable when no pack applies', () => {
    const { evaluationService } = setUpEmpty();
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'not_applicable');
    assert.equal(result.decision.allowed, true);
  });

  it('2. returns allowed for allow rule', () => {
    const { evaluationService } = setUp([buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'allowed');
    assert.equal(result.decision.allowed, true);
  });

  it('3. returns denied when deny rule matches', () => {
    const { evaluationService } = setUp([buildRule({ effect: { type: 'deny', reasonCode: 'NO', reason: 'no' } })]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'denied');
    assert.equal(result.decision.allowed, false);
  });

  it('4. deny takes precedence over allow', () => {
    const { evaluationService } = setUp([
      buildRule({ id: 'rule-allow', effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } }),
      buildRule({ id: 'rule-deny', effect: { type: 'deny', reasonCode: 'NO', reason: 'no' } }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'denied');
    assert.deepEqual([...result.decision.matchedRuleIds].sort(), ['rule-allow', 'rule-deny']);
  });

  it('5. requires evidence when evidence rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({
        effect: { type: 'require_evidence', reasonCode: 'NEED_EVIDENCE', reason: 'need evidence' },
        evidenceRequirements: [{ id: 'evidence-1', type: 'invoice', description: 'Attach invoice.', required: true }],
      }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'requires_evidence');
    assert.equal(result.decision.evidenceRequirements.length, 1);
  });

  it('6. requires approval when approval rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({
        effect: { type: 'require_approval', reasonCode: 'NEED_APPROVAL', reason: 'need approval' },
        approvalRequirements: [
          { id: 'approval-1', type: 'finance_review', description: 'Finance review.', required: true, minimumApprovals: 1, requiresSegregationOfDuties: false },
        ],
      }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.approvalRequirements.length, 1);
  });

  it('7. requires authority when authority rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({ effect: { type: 'require_authority', reasonCode: 'NEED_AUTHORITY', reason: 'need authority' } }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'requires_authority');
  });

  it('8. requires external standing when external standing rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({ effect: { type: 'require_external_standing', reasonCode: 'NEED_STANDING', reason: 'need standing' } }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'requires_external_standing');
  });

  it('9. limits scope when limit rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({
        effect: {
          type: 'limit_scope',
          reasonCode: 'LIMITED',
          reason: 'limited',
          limitedActions: ['read_only_action'],
        },
      }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'limited');
    assert.deepEqual(result.decision.limitedActions, ['read_only_action']);
  });

  it('10. raises risk when risk rule matches', () => {
    const { evaluationService } = setUp([
      buildRule({ effect: { type: 'raise_risk', reasonCode: 'RISK_UP', reason: 'risk up', riskOverride: 'critical' } }),
    ]);
    const result = evaluationService.evaluate(buildInput({ riskLevel: 'low' }));
    assert.equal(result.decision.effectiveRiskLevel, 'critical');
  });

  it('11. returns warning for warning-only rule', () => {
    const { evaluationService } = setUp([buildRule({ effect: { type: 'warn', reasonCode: 'WARN', reason: 'warn' } })]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.type, 'warning');
    assert.equal(result.decision.allowed, true);
  });

  it('12. aggregates obligations', () => {
    const { evaluationService } = setUp([
      buildRule({
        effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' },
        obligations: [{ id: 'obligation-1', type: 'record_event', description: 'Record it.', required: true }],
      }),
    ]);
    const result = evaluationService.evaluate(buildInput());
    assert.equal(result.decision.obligations.length, 1);
  });

  it('13. creates proof', () => {
    const { evaluationService } = setUp([buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })]);
    const result = evaluationService.evaluate(buildInput());
    assert.ok(result.proof);
    assert.equal(result.decision.proofId, result.proof!.id);
  });

  it('14. records events', () => {
    const { evaluationService, ledger } = setUp([buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })]);
    evaluationService.evaluate(buildInput());
    const types = ledger.getEvents().map((event) => event.type);
    assert.ok(types.includes('policy_evaluation_started'));
    assert.ok(types.includes('policy_pack_applicability_resolved'));
    assert.ok(types.includes('policy_rule_matched'));
    assert.ok(types.includes('policy_decision_created'));
    assert.ok(types.includes('policy_proof_created'));
  });

  it('15. deterministic same input produces same decision/proof', () => {
    const rules = [buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })];
    const first = setUp(rules).evaluationService.evaluate(buildInput());
    const second = setUp(rules).evaluationService.evaluate(buildInput());
    assert.equal(first.decision.type, second.decision.type);
    assert.equal(first.proof!.proofHash, second.proof!.proofHash);
  });

  it('flags invalid input as denied and fails closed', () => {
    const { evaluationService } = setUpEmpty();
    const result = evaluationService.evaluate(buildInput({ trustDomainId: '' }));
    assert.equal(result.decision.type, 'invalid_input');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.proof);
  });
});
