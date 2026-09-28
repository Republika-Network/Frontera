import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { PolicyConditionEvaluator } from '../services/policy-condition-evaluator.js';
import { PolicyPackValidator } from '../services/policy-pack-validator.js';

/**
 * CORE-03 §33 — policy reasons over the typed semantic fields with the same
 * closed, deterministic grammar it always had: three identifier fields
 * (`actionClass`, `resourceClass`, `governanceProfile`) and one `parameter`
 * field addressed by an exact declared dimension id. No path, no expression,
 * no coercion; a threshold on an integer dimension is a safe integer.
 */

const NOW = '2026-01-01T00:00:00.000Z';

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'td',
    actorId: 'actor-1',
    action: 'export-customer-records',
    resourceScope: 'customer-data-example',
    riskLevel: 'low',
    requestedAt: NOW,
    actionClass: 'export',
    resourceClass: 'customer_dataset',
    governanceProfile: 'customer-data-export',
    governedParameters: [
      { dimension: 'destination', type: 'token', value: 'approved-archive' },
      { dimension: 'recordCount', type: 'integer', value: 500 },
    ],
    ...overrides,
  };
}

const evaluator = new PolicyConditionEvaluator();
const matches = (condition: PolicyCondition, at: PolicyEvaluationInput = input()) => evaluator.evaluate(condition, at).matched;
const parameter = (parameterId: string, operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than_or_equal' | 'in' | 'not_in' | 'exists' | 'not_exists', value?: unknown): PolicyCondition => ({
  type: 'predicate',
  field: 'parameter',
  parameterId,
  operator,
  ...(value !== undefined ? { value } : {}),
});

describe('CORE-03 — evaluating the semantic fields', () => {
  it('reads the classification fields', () => {
    assert.equal(matches({ type: 'predicate', field: 'actionClass', operator: 'equals', value: 'export' }), true);
    assert.equal(matches({ type: 'predicate', field: 'resourceClass', operator: 'equals', value: 'customer_dataset' }), true);
    assert.equal(matches({ type: 'predicate', field: 'governanceProfile', operator: 'in', value: ['customer-data-export'] }), true);
    assert.equal(matches({ type: 'predicate', field: 'actionClass', operator: 'equals', value: 'read' }), false);
  });

  it('orders an integer parameter numerically and compares a token exactly', () => {
    assert.equal(matches(parameter('recordCount', 'greater_than', 100)), true);
    assert.equal(matches(parameter('recordCount', 'less_than_or_equal', 500)), true);
    assert.equal(matches(parameter('recordCount', 'greater_than', 500)), false);
    assert.equal(matches(parameter('destination', 'in', ['approved-archive'])), true);
    assert.equal(matches(parameter('destination', 'not_in', ['approved-archive'])), false);
  });

  it('reads by exact dimension id only: another case, a prototype name or an undeclared id reads as absent', () => {
    assert.equal(matches(parameter('RecordCount', 'exists')), false);
    assert.equal(matches(parameter('constructor', 'exists')), false);
    assert.equal(matches(parameter('__proto__', 'exists')), false);
    assert.equal(matches(parameter('blastRadius', 'not_exists')), true);
  });

  it('never orders across types: a threshold as text against an integer parameter does not match', () => {
    assert.equal(matches(parameter('recordCount', 'greater_than', '100')), false);
  });

  it('an action with no classification reads every semantic field as absent', () => {
    const bare = input({});
    const { actionClass: _a, resourceClass: _r, governanceProfile: _g, governedParameters: _p, ...unclassified } = bare;
    assert.equal(matches({ type: 'predicate', field: 'actionClass', operator: 'exists' }, unclassified), false);
    assert.equal(matches(parameter('recordCount', 'exists'), unclassified), false);
  });
});

describe('CORE-03 — validating the semantic fields', () => {
  const rule = (condition: PolicyCondition): PolicyPackRule => ({
    id: 'rule-1',
    policyPackVersionId: 'version-1',
    name: 'r',
    description: 'r',
    status: 'active',
    priority: 100,
    condition,
    effect: { type: 'deny', reasonCode: 'TEST_DENY', reason: 'Denied.' },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'error',
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
  const refuses = (condition: PolicyCondition, code: string) =>
    assert.throws(() => validator.validateVersion(version(condition)), (error: unknown) => error instanceof PolicyPackValidationError && error.message.includes(code), JSON.stringify(condition));

  it('accepts well-formed parameter and classification predicates', () => {
    assert.equal(validator.validateVersion(version(parameter('recordCount', 'greater_than', 100))).valid, true);
    assert.equal(validator.validateVersion(version({ type: 'predicate', field: 'actionClass', operator: 'equals', value: 'export' })).valid, true);
  });

  it('refuses a parameter predicate without a declared-dimension id, with a path, or on another field', () => {
    refuses({ type: 'predicate', field: 'parameter', operator: 'exists' }, 'INVALID_PARAMETER_PREDICATE');
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'Record Count', operator: 'exists' }, 'INVALID_PARAMETER_PREDICATE');
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'recordCount', metadataPath: 'a.b', operator: 'exists' }, 'INVALID_PARAMETER_PREDICATE');
    refuses({ type: 'predicate', field: 'amount', parameterId: 'recordCount', operator: 'equals', value: '1' }, 'INVALID_PARAMETER_PREDICATE');
  });

  it('refuses an ordered parameter threshold that is not a safe integer', () => {
    refuses(parameter('recordCount', 'greater_than', '100'), 'INVALID_PARAMETER_THRESHOLD');
    refuses(parameter('recordCount', 'greater_than', 100.5), 'INVALID_PARAMETER_THRESHOLD');
    refuses(parameter('recordCount', 'greater_than', 2 ** 53), 'INVALID_PARAMETER_THRESHOLD');
  });
});
