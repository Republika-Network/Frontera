import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackSimulationInput } from '../domain/policy-pack-simulation.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyPackStore } from '../services/policy-pack-store.js';
import { PolicyPackLedger } from '../services/policy-pack-ledger.js';
import { PolicyPackRegistry } from '../services/policy-pack-registry.js';
import { PolicyPackSimulationService } from '../services/policy-pack-simulation-service.js';

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

function buildEvaluationInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'eval-input-1',
    trustDomainId: 'trust-domain-1',
    actorId: 'actor-1',
    action: 'approve_payment',
    resourceScope: 'scope-1',
    riskLevel: 'low',
    requestedAt: NOW,
    ...overrides,
  };
}

function buildSimulationInput(overrides: Partial<PolicyPackSimulationInput> = {}): PolicyPackSimulationInput {
  return {
    id: 'simulation-1',
    policyPackVersionIds: ['pack-1-v1'],
    evaluationInputs: [buildEvaluationInput()],
    simulatedAt: NOW,
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
  const simulationService = new PolicyPackSimulationService(ctx, store, ledger);
  return { ctx, store, ledger, registry, simulationService };
}

describe('PolicyPackSimulationService', () => {
  it('1. simulates multiple inputs', () => {
    const { simulationService } = setUp([buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })]);
    const input = buildSimulationInput({
      evaluationInputs: [
        buildEvaluationInput({ id: 'eval-input-1' }),
        buildEvaluationInput({ id: 'eval-input-2' }),
        buildEvaluationInput({ id: 'eval-input-3' }),
      ],
    });
    const result = simulationService.simulate(input);
    assert.equal(result.results.length, 3);
  });

  it('2. returns summary counts', () => {
    const { simulationService } = setUp([
      buildRule({
        id: 'rule-allow',
        condition: { type: 'predicate', field: 'action', operator: 'equals', value: 'approve_payment' },
        effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' },
      }),
      buildRule({
        id: 'rule-deny',
        condition: { type: 'predicate', field: 'action', operator: 'equals', value: 'reject_payment' },
        effect: { type: 'deny', reasonCode: 'NO', reason: 'no' },
      }),
    ]);
    const input = buildSimulationInput({
      evaluationInputs: [
        buildEvaluationInput({ id: 'eval-input-1', action: 'approve_payment' }),
        buildEvaluationInput({ id: 'eval-input-2', action: 'approve_payment' }),
        buildEvaluationInput({ id: 'eval-input-3', action: 'reject_payment' }),
      ],
    });
    const result = simulationService.simulate(input);
    assert.equal(result.summary.allowed, 2);
    assert.equal(result.summary.denied, 1);
    assert.equal(result.summary.requiresEvidence, 0);
    assert.equal(result.summary.requiresApproval, 0);
    assert.equal(result.summary.warnings, 0);
    assert.equal(result.summary.notApplicable, 0);
  });

  it('3. does not mutate active runtime state', () => {
    const { store, simulationService } = setUp([buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })]);
    const decisionsBefore = store.listDecisions().length;
    const evaluationsBefore = store.listEvaluations().length;
    simulationService.simulate(
      buildSimulationInput({
        evaluationInputs: [buildEvaluationInput({ id: 'eval-input-1' }), buildEvaluationInput({ id: 'eval-input-2' })],
      }),
    );
    assert.equal(store.listDecisions().length, decisionsBefore);
    assert.equal(store.listEvaluations().length, evaluationsBefore);
  });

  it('4. deterministic simulation result', () => {
    const rules = [buildRule({ effect: { type: 'allow', reasonCode: 'OK', reason: 'ok' } })];
    const first = setUp(rules);
    const second = setUp(rules);
    const input = buildSimulationInput({
      evaluationInputs: [buildEvaluationInput({ id: 'eval-input-1' }), buildEvaluationInput({ id: 'eval-input-2' })],
    });
    const firstResult = first.simulationService.simulate(input);
    const secondResult = second.simulationService.simulate(input);
    assert.deepEqual(firstResult.summary, secondResult.summary);
  });
});
