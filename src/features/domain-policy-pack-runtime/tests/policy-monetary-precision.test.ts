import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import { PAYMENTS_BASIC_POLICY_PACK, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1 } from '../packs/payments-basic.policy-pack.js';
import { SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK, SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK_VERSION_V1 } from '../packs/sports-event-settlement-basic.policy-pack.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyConditionEvaluator } from '../services/policy-condition-evaluator.js';
import { PolicyPackEvaluationService } from '../services/policy-pack-evaluation-service.js';
import { PolicyPackLedger } from '../services/policy-pack-ledger.js';
import { PolicyPackRegistry } from '../services/policy-pack-registry.js';
import { PolicyPackStore } from '../services/policy-pack-store.js';
import { PolicyPackValidator } from '../services/policy-pack-validator.js';

/**
 * P9 closure — a policy's monetary threshold is exact data, never a JavaScript
 * number.
 *
 * Every case below is chosen so that a `number` round trip would change the
 * answer: `9007199254740993` and `9007199254740992` are the same double, and so
 * are `0.30000000000000001` and `0.3`. An implementation that converted either
 * side through `number` fails these rows.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const BEYOND_DOUBLE = '9007199254740993';
const BELOW_IT = '9007199254740992';

function input(amount: unknown): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'trust-domain-1',
    actorId: 'actor-1',
    action: 'approve_payment',
    resourceScope: 'scope-1',
    riskLevel: 'low',
    requestedAt: NOW,
    amount: amount as string,
  };
}

const atLeast = (threshold: unknown): PolicyCondition => ({ type: 'predicate', field: 'amount', operator: 'greater_than_or_equal', value: threshold });

describe('P9 policy thresholds — exact canonical text reaches the comparison', () => {
  const evaluator = new PolicyConditionEvaluator();

  it(`a threshold beyond 2^53 separates ${BEYOND_DOUBLE} from ${BELOW_IT}`, () => {
    assert.equal(Number(BEYOND_DOUBLE) === Number(BELOW_IT), true, 'the hazard is real: as numbers they are one value');
    assert.equal(evaluator.evaluate(atLeast(BEYOND_DOUBLE), input(BEYOND_DOUBLE)).matched, true);
    assert.equal(evaluator.evaluate(atLeast(BEYOND_DOUBLE), input(BELOW_IT)).matched, false);
    assert.equal(evaluator.evaluate({ type: 'predicate', field: 'amount', operator: 'less_than', value: BEYOND_DOUBLE }, input(BELOW_IT)).matched, true);
  });

  it('a high-precision fractional threshold is exact', () => {
    const threshold = '0.30000000000000001';
    assert.equal(Number(threshold) === 0.3, true, 'the hazard is real');
    assert.equal(evaluator.evaluate(atLeast(threshold), input('0.3')).matched, false);
    assert.equal(evaluator.evaluate(atLeast(threshold), input('0.30000000000000001')).matched, true);
    assert.equal(evaluator.evaluate(atLeast('0.000000000000000001'), input('0.000000000000000001')).matched, true);
    assert.equal(evaluator.evaluate(atLeast('0.000000000000000001'), input('0')).matched, false);
  });

  it('equality on amount is exact canonical text', () => {
    assert.equal(evaluator.evaluate({ type: 'predicate', field: 'amount', operator: 'equals', value: BEYOND_DOUBLE }, input(BELOW_IT)).matched, false);
    assert.equal(evaluator.evaluate({ type: 'predicate', field: 'amount', operator: 'equals', value: BEYOND_DOUBLE }, input(BEYOND_DOUBLE)).matched, true);
  });

  it('a JavaScript-number threshold never matches a monetary amount — it is not re-spelled', () => {
    for (const operator of ['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'] as const) {
      assert.equal(evaluator.evaluate({ type: 'predicate', field: 'amount', operator, value: 100 }, input('100')).matched, false, operator);
      assert.equal(evaluator.evaluate({ type: 'predicate', field: 'amount', operator, value: '100' }, input(100)).matched, false, `${operator}: a number amount is not compared either`);
    }
  });
});

describe('P9 policy thresholds — a number threshold cannot be registered', () => {
  const rule = (condition: PolicyCondition): PolicyPackRule => ({
    id: 'rule-1',
    policyPackVersionId: 'version-1',
    name: 'Threshold',
    description: 'Threshold rule.',
    status: 'active',
    priority: 100,
    condition,
    effect: { type: 'require_approval', reasonCode: 'TEST_APPROVAL', reason: 'Approval.' },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'warning',
    sourceIds: [],
  });
  const version = (condition: PolicyCondition): PolicyPackVersion => ({
    id: 'version-1',
    policyPackId: 'pack-1',
    version: '1.0.0',
    status: 'draft',
    scope: {},
    rules: [rule(condition)],
    sources: [],
    effectiveFrom: NOW,
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const validator = new PolicyPackValidator();

  for (const [name, condition] of [
    ['a number threshold', atLeast(10000)],
    ['a number beyond 2^53', atLeast(9007199254740993)],
    ['a non-canonical text threshold', atLeast('10000.00')],
    ['an exponent threshold', atLeast('1e4')],
    ['a number in an `in` list', { type: 'predicate', field: 'amount', operator: 'in', value: ['100', 200] } as PolicyCondition],
    ['a string operator on amount', { type: 'predicate', field: 'amount', operator: 'starts_with', value: '1' } as PolicyCondition],
  ] as const) {
    it(`${name} is refused as INVALID_MONETARY_THRESHOLD`, () => {
      assert.throws(
        () => validator.validateVersion(version(condition)),
        (error: unknown) => error instanceof PolicyPackValidationError && error.message.includes('INVALID_MONETARY_THRESHOLD'),
      );
    });
  }

  it('a canonical text threshold is accepted', () => {
    assert.equal(validator.validateVersion(version(atLeast(BEYOND_DOUBLE))).valid, true);
  });

  it('every shipped pack with a monetary threshold registers — its thresholds are canonical text', () => {
    for (const [pack, shipped] of [
      [PAYMENTS_BASIC_POLICY_PACK, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1],
      [SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK, SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK_VERSION_V1],
    ] as const) {
      const ctx = createPolicyPackRuntimeContext(NOW);
      const store = new PolicyPackStore();
      const registry = new PolicyPackRegistry(ctx, store, new PolicyPackLedger(ctx, store));
      registry.registerPolicyPack(pack);
      assert.doesNotThrow(() => registry.registerPolicyPackVersion(shipped), shipped.id);
    }
  });
});

describe('P9 policy evaluation — a non-canonical input amount fails closed', () => {
  function evaluationService() {
    const ctx = createPolicyPackRuntimeContext(NOW);
    const store = new PolicyPackStore();
    const ledger = new PolicyPackLedger(ctx, store);
    const registry = new PolicyPackRegistry(ctx, store, ledger);
    registry.registerPolicyPack({ id: 'pack-1', name: 'Pack', description: 'Pack', kind: 'demo', domain: 'payments' });
    registry.registerPolicyPackVersion({
      id: 'pack-1-v1',
      policyPackId: 'pack-1',
      version: '1.0.0',
      scope: {},
      rules: [
        {
          id: 'rule-high-value',
          policyPackVersionId: 'pack-1-v1',
          name: 'High value',
          description: 'High value needs approval.',
          status: 'active',
          priority: 100,
          condition: atLeast(BEYOND_DOUBLE),
          effect: { type: 'deny', reasonCode: 'TEST_HIGH_VALUE', reason: 'High value.' },
          obligations: [],
          evidenceRequirements: [],
          approvalRequirements: [],
          severity: 'error',
          sourceIds: [],
        },
      ],
      sources: [],
      effectiveFrom: NOW,
      demoOnly: true,
      legalCompleteness: 'not_legal_advice',
    });
    registry.activatePolicyPackVersion('pack-1-v1');
    return new PolicyPackEvaluationService(ctx, store, ledger);
  }

  it('the exact threshold decides: 9007199254740993 is denied, 9007199254740992 is not', () => {
    const service = evaluationService();
    assert.equal(service.evaluate(input(BEYOND_DOUBLE)).decision.allowed, false);
    assert.equal(service.evaluate(input(BELOW_IT)).decision.allowed, true);
  });

  for (const amount of [9007199254740993, 100, '100.00', '1e3', '-1', ' 1']) {
    it(`an input amount of ${JSON.stringify(amount)} is invalid input, never compared (and never allowed)`, () => {
      const decision = evaluationService().evaluate(input(amount)).decision;
      assert.equal(decision.type, 'invalid_input');
      assert.equal(decision.allowed, false);
    });
  }
});
