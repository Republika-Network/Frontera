import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyCondition } from '../domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { PolicyConditionEvaluator } from '../services/policy-condition-evaluator.js';

const NOW = '2026-01-01T00:00:00.000Z';

function buildInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'trust-domain-1',
    actorId: 'actor-1',
    action: 'approve_payment',
    resourceScope: 'scope-1',
    riskLevel: 'low',
    requestedAt: NOW,
    amount: '100',
    dataDomains: ['pii'],
    ...overrides,
  };
}

describe('PolicyConditionEvaluator', () => {
  const evaluator = new PolicyConditionEvaluator();

  it('1. evaluates equals', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'equals', value: 'approve_payment' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'other' })).matched, false);
  });

  it('2. evaluates not_equals', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'not_equals', value: 'approve_payment' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'other' })).matched, true);
  });

  it('3. evaluates includes', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'dataDomains', operator: 'includes', value: 'pii' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ dataDomains: ['health'] })).matched, false);
  });

  it('4. evaluates not_includes', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'dataDomains', operator: 'not_includes', value: 'pii' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
    assert.equal(evaluator.evaluate(condition, buildInput({ dataDomains: ['health'] })).matched, true);
  });

  it('5. evaluates starts_with', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'starts_with', value: 'approve_' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'deny_payment' })).matched, false);
  });

  it('6. evaluates ends_with', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'ends_with', value: '_payment' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'approve_invoice' })).matched, false);
  });

  it('7. evaluates in', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'in', value: ['approve_payment', 'deny_payment'] };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'other' })).matched, false);
  });

  it('8. evaluates not_in', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'action', operator: 'not_in', value: ['approve_payment'] };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'other' })).matched, true);
  });

  it('9. evaluates greater_than', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'greater_than', value: 50 };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '50' })).matched, false);
  });

  it('10. evaluates greater_than_or_equal', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'greater_than_or_equal', value: 100 };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '99' })).matched, false);
  });

  it('11. evaluates less_than', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'less_than', value: 200 };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '200' })).matched, false);
  });

  it('12. evaluates less_than_or_equal', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'less_than_or_equal', value: 100 };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '101' })).matched, false);
  });

  it('13. evaluates exists', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'counterpartyId', operator: 'exists' };
    assert.equal(evaluator.evaluate(condition, buildInput({ counterpartyId: 'counterparty-1' })).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
  });

  it('14. evaluates not_exists', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'counterpartyId', operator: 'not_exists' };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ counterpartyId: 'counterparty-1' })).matched, false);
  });

  it('15. evaluates all group', () => {
    const condition: PolicyCondition = {
      type: 'group',
      operator: 'all',
      conditions: [
        { type: 'predicate', field: 'action', operator: 'equals', value: 'approve_payment' },
        { type: 'predicate', field: 'amount', operator: 'greater_than', value: 50 },
      ],
    };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '1' })).matched, false);
  });

  it('16. evaluates any group', () => {
    const condition: PolicyCondition = {
      type: 'group',
      operator: 'any',
      conditions: [
        { type: 'predicate', field: 'action', operator: 'equals', value: 'nonexistent' },
        { type: 'predicate', field: 'amount', operator: 'greater_than', value: 50 },
      ],
    };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, true);
    assert.equal(evaluator.evaluate(condition, buildInput({ amount: '1' })).matched, false);
  });

  it('17. evaluates not group', () => {
    const condition: PolicyCondition = {
      type: 'group',
      operator: 'not',
      conditions: [{ type: 'predicate', field: 'action', operator: 'equals', value: 'approve_payment' }],
    };
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
    assert.equal(evaluator.evaluate(condition, buildInput({ action: 'other' })).matched, true);
  });

  it('18. evaluates metadataPath', () => {
    const condition: PolicyCondition = {
      type: 'predicate',
      field: 'metadata',
      operator: 'equals',
      value: true,
      metadataPath: 'customerPolicyAllowsBankAccountChange',
    };
    assert.equal(
      evaluator.evaluate(condition, buildInput({ metadata: { customerPolicyAllowsBankAccountChange: true } })).matched,
      true,
    );
    assert.equal(
      evaluator.evaluate(condition, buildInput({ metadata: { customerPolicyAllowsBankAccountChange: false } })).matched,
      false,
    );
    assert.equal(evaluator.evaluate(condition, buildInput()).matched, false);
  });

  it('19. handles missing fields deterministically', () => {
    const condition: PolicyCondition = { type: 'predicate', field: 'jurisdiction', operator: 'equals', value: 'demo-jurisdiction-a' };
    const first = evaluator.evaluate(condition, buildInput());
    const second = evaluator.evaluate(condition, buildInput());
    assert.equal(first.matched, false);
    assert.deepEqual(first, second);
  });
});
