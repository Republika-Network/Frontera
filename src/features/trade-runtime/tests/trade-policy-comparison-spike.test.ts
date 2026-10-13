import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../../domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyEffectType } from '../../domain-policy-pack-runtime/domain/policy-pack-effect.js';
import type { PolicyEvaluationInput } from '../../domain-policy-pack-runtime/domain/policy-pack-evaluation.js';
import type { PolicyPackVersion } from '../../domain-policy-pack-runtime/domain/policy-pack-version.js';
import { PolicyPackValidationError } from '../../domain-policy-pack-runtime/runtime/policy-pack-runtime-errors.js';
import { PolicyConditionEvaluator } from '../../domain-policy-pack-runtime/services/policy-condition-evaluator.js';
import { PolicyPackValidator } from '../../domain-policy-pack-runtime/services/policy-pack-validator.js';
import { compareGovernedParameterBound, governedParameterBoundFor, governedParameterBoundKindSupports, parseGovernedParameterValue } from '../../governed-parameter-runtime/index.js';

/**
 * TRADE-01 mandatory spike — characterization, not change.
 *
 * Question: can existing CORE semantics express exact or maximum bounds for
 * monetary trading values without floating point? Every assertion below
 * pins **current** CORE behaviour (CORE-03 parameters, CORE-04 fact
 * comparands, P9 monetary predicates) exactly as shipped; TRADE-01 changes
 * none of it. If CORE changes, this suite says which TRADE assumption moved.
 * Conclusions: `docs/integrations/trade/TRADE-01-CANONICAL-OFFERCREATE-CONTRACTS.md` §8.
 */

const NOW = '2026-10-12T12:00:00.000Z';
const evaluator = new PolicyConditionEvaluator();
const validator = new PolicyPackValidator();

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'spike',
    trustDomainId: 'td',
    actorId: 'agent',
    action: 'trade.offer-create',
    resourceScope: 'owner',
    riskLevel: 'low',
    requestedAt: NOW,
    governedParameters: [{ dimension: 'tradeQuantity', type: 'token', value: '0.30000000000000001' }],
    contextFacts: [{ factClass: 'trade.maxQuantity', value: '0.3' }],
    ...overrides,
  };
}

const matches = (condition: PolicyCondition, at: PolicyEvaluationInput = input()): boolean => evaluator.evaluate(condition, at).matched;

function version(condition: PolicyCondition, effect: PolicyEffectType = 'deny'): PolicyPackVersion {
  return {
    id: 'v1',
    policyPackId: 'pack',
    version: '1.0.0',
    status: 'draft',
    scope: {},
    rules: [
      {
        id: 'r1',
        policyPackVersionId: 'v1',
        name: 'r',
        description: 'r',
        status: 'active',
        priority: 100,
        condition,
        effect: { type: effect, reasonCode: 'SPIKE', reason: 'Spike.' },
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const validates = (condition: PolicyCondition): boolean => {
  try {
    return validator.validateVersion(version(condition)).valid;
  } catch (error) {
    if (error instanceof PolicyPackValidationError) return false;
    throw error;
  }
};

describe('Spike A/B — integer parameters and bounds', () => {
  it('A: integer bounds are `exact` or `maximum`, compared as JavaScript safe integers', () => {
    assert.equal(governedParameterBoundKindSupports('maximum', 'integer'), true);
    assert.equal(governedParameterBoundKindSupports('maximum', 'token'), false, 'a token can only be bound exactly');
    const bound = governedParameterBoundFor('maximum', { type: 'integer', value: 1000 });
    assert.deepEqual(bound, { kind: 'maximum', type: 'integer', limit: 1000 });
    assert.equal(compareGovernedParameterBound(bound!, { kind: 'maximum', type: 'integer', limit: 999 }), 'narrower');
  });

  it('B: arbitrarily large integers are NOT supported — above 2^53 − 1 is refused, so the full drops range (10^17) cannot be an integer dimension', () => {
    assert.equal(parseGovernedParameterValue('integer', Number.MAX_SAFE_INTEGER).valid, true);
    assert.equal(parseGovernedParameterValue('integer', 2 ** 53).valid, false);
    assert.equal(parseGovernedParameterValue('integer', 1e17).valid, false, '10^17 drops (the XRP supply) is not a safe integer');
    assert.equal(parseGovernedParameterValue('integer', '100').valid, false, 'no coercion from text');
  });
});

describe('Spike C — decimal text as a parameter', () => {
  it('decimal text is accepted only as an opaque token; the token grammar does not require a decimal', () => {
    assert.equal(parseGovernedParameterValue('token', '1250.5').valid, true);
    assert.equal(parseGovernedParameterValue('token', '1e5').valid, true, 'the grammar admits an exponent spelling — only TRADE validation guarantees canonical decimal text');
    assert.equal(parseGovernedParameterValue('token', '-5').valid, false);
  });

  it('a pack ordering a parameter against a literal decimal threshold is refused (INVALID_PARAMETER_THRESHOLD); only a safe-integer literal is admitted', () => {
    assert.equal(validates({ type: 'predicate', field: 'parameter', parameterId: 'tradeQuantity', operator: 'less_than_or_equal', value: '100' }), false);
    assert.equal(validates({ type: 'predicate', field: 'parameter', parameterId: 'tradeQuantity', operator: 'less_than_or_equal', value: 100 }), true);
  });

  it('a parameter ordered against an admitted fact (valueFrom) IS admitted by the validator, and compared exactly with BigInt when both sides are canonical decimal text', () => {
    const exceeds: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'tradeQuantity', operator: 'greater_than', valueFrom: { field: 'contextFact', factClass: 'trade.maxQuantity' } };
    assert.equal(validates(exceeds), true);
    assert.equal(matches(exceeds), true, '0.30000000000000001 > 0.3 exactly — a float would call them equal');
    assert.equal(matches(exceeds, input({ governedParameters: [{ dimension: 'tradeQuantity', type: 'token', value: '0.3' }] })), false);
  });

  it('the comparison fails CLOSED to "no match" — which makes a deny-shaped rule fail OPEN', () => {
    const exceeds: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'tradeQuantity', operator: 'greater_than', valueFrom: { field: 'contextFact', factClass: 'trade.maxQuantity' } };
    assert.equal(matches(exceeds, input({ contextFacts: [] })), false, 'fact not admitted: the deny rule does not fire');
    assert.equal(matches(exceeds, input({ governedParameters: [{ dimension: 'tradeQuantity', type: 'token', value: '1e9' }] })), false, 'non-canonical token: the deny rule does not fire');
    assert.equal(matches(exceeds, input({ contextFacts: [{ factClass: 'trade.maxQuantity', value: 1 }] })), false, 'decimal text against an integer fact: no match');
    // So a TRADE limit must be stated as an ALLOW condition that must hold
    // (within ≤ limit), with the fact required — never only as "deny when >".
    const within: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'tradeQuantity', operator: 'less_than_or_equal', valueFrom: { field: 'contextFact', factClass: 'trade.maxQuantity' } };
    assert.equal(matches(within, input({ contextFacts: [] })), false, 'missing fact: "within" is not satisfied either');
  });

  it('the governed amount (P9) supports exact ordered literal thresholds as canonical decimal text — and refuses number thresholds', () => {
    const atMost: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'less_than_or_equal', value: '1000' };
    assert.equal(validates(atMost), true);
    assert.equal(validates({ type: 'predicate', field: 'amount', operator: 'less_than_or_equal', value: 1000 }), false);
    assert.equal(matches(atMost, input({ amount: '1000.0000000000000001' } as Partial<PolicyEvaluationInput>)), false, 'one ten-quintillionth over is over');
    assert.equal(matches(atMost, input({ amount: '1000' } as Partial<PolicyEvaluationInput>)), true);
  });
});

describe('Spike D/E — scaled integers and exact rationals', () => {
  it('D: a fixed-scale integer works only inside the safe-integer range — 9 007 199 254.740991 XRP at drop scale — and needs a per-asset scale nobody may choose per request', () => {
    assert.equal(parseGovernedParameterValue('integer', 9_007_199_254_740_991).valid, true);
    assert.equal(parseGovernedParameterValue('integer', 9_007_199_254_740_992).valid, false);
  });

  it('E: an exact rational has no CORE parameter type and no ordered policy comparison: it can only be bound exactly (inside the digest)', () => {
    assert.equal(parseGovernedParameterValue('token', '1/3').valid, false, "'/' is outside the token grammar");
    assert.equal(parseGovernedParameterValue('token', '1:3').valid, true, 'as an opaque token it can be pinned exactly — never ordered');
  });
});
