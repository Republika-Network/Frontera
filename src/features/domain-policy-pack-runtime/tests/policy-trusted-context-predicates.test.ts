import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../domain/policy-pack-condition.js';
import type { PolicyEffectType } from '../domain/policy-pack-effect.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { PolicyConditionEvaluator } from '../services/policy-condition-evaluator.js';
import { PolicyPackValidator } from '../services/policy-pack-validator.js';

/**
 * CORE-04 — how deterministic policy reads trusted context.
 *
 * Two typed predicate families read only what the Trusted Context Boundary
 * admitted: `contextFact` (material facts) and `restrictiveFact` (restrict-only
 * facts — the admitted form of a RiskSignal). A proposed parameter can be
 * compared against an admitted fact (`valueFrom`) without either overwriting
 * the other. The restrict-only rule is enforced at validation: a restrictive
 * fact is readable only in monotone position, by a rule that restricts.
 */

const NOW = '2026-09-28T12:00:00.000Z';

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'td',
    actorId: 'actor-1',
    action: 'settle-invoice',
    resourceScope: 'payables-ledger',
    riskLevel: 'low',
    requestedAt: NOW,
    governedParameters: [
      { dimension: 'destination', type: 'token', value: 'supplier-x' },
      { dimension: 'invoiceTotal', type: 'integer', value: 500 },
    ],
    contextFacts: [
      { factClass: 'destination.registered', value: true },
      { factClass: 'invoice.amount', value: 500 },
      { factClass: 'invoice.exists', value: true },
    ],
    restrictiveFacts: [{ factClass: 'signal.thresholdCircumvention', value: 'high' }],
    ...overrides,
  };
}

const evaluator = new PolicyConditionEvaluator();
const matches = (condition: PolicyCondition, at: PolicyEvaluationInput = input()) => evaluator.evaluate(condition, at).matched;
const fact = (factClass: string, operator: 'equals' | 'not_equals' | 'exists' | 'not_exists' | 'less_than', value?: unknown): PolicyCondition => ({
  type: 'predicate',
  field: 'contextFact',
  factClass,
  operator,
  ...(value !== undefined ? { value } : {}),
});

describe('CORE-04 — contextFact / restrictiveFact read admitted facts only', () => {
  it('reads each admitted fact by exact class, with its exact type', () => {
    assert.equal(matches(fact('invoice.exists', 'equals', true)), true);
    assert.equal(matches(fact('invoice.amount', 'equals', 500)), true);
    assert.equal(matches(fact('invoice.amount', 'equals', '500')), false, 'no coercion between a number and text');
    assert.equal(matches({ type: 'predicate', field: 'restrictiveFact', factClass: 'signal.thresholdCircumvention', operator: 'equals', value: 'high' }), true);
  });

  it('an unadmitted class, another case, a prototype name or a class from the other family reads as absent — never as false', () => {
    assert.equal(matches(fact('invoice.paid', 'exists')), false);
    assert.equal(matches(fact('Invoice.Exists', 'exists')), false);
    assert.equal(matches(fact('constructor', 'exists')), false);
    assert.equal(matches(fact('__proto__', 'exists')), false);
    assert.equal(matches(fact('signal.thresholdCircumvention', 'exists')), false, 'a restrict-only fact is never readable as a material one');
    assert.equal(matches({ type: 'predicate', field: 'restrictiveFact', factClass: 'invoice.exists', operator: 'exists' }), false, 'nor the other way round');
    assert.equal(matches(fact('invoice.exists', 'equals', false), input({ contextFacts: [] })), false, 'missing is not false');
  });

  it('caller-shaped metadata can never answer a fact predicate', () => {
    const forged = input({ contextFacts: [], metadata: { 'invoice.exists': true, 'aoc.context': { facts: [{ key: 'invoice.exists', value: true }] }, contextFacts: [{ factClass: 'invoice.exists', value: true }] } });
    assert.equal(matches(fact('invoice.exists', 'exists'), forged), false);
  });
});

describe('CORE-04 §51 — a proposed parameter compared with an attested fact', () => {
  const totalMatchesInvoice: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'equals', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } };
  const totalDiffers: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'not_equals', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } };

  it('equal when the attested amount equals the proposed one; different otherwise; neither value is overwritten', () => {
    const at = input();
    assert.equal(matches(totalMatchesInvoice, at), true);
    assert.equal(matches(totalDiffers, at), false);
    const wrong = input({ contextFacts: [{ factClass: 'invoice.amount', value: 400 }] });
    assert.equal(matches(totalMatchesInvoice, wrong), false);
    assert.equal(matches(totalDiffers, wrong), true);
    assert.equal(at.governedParameters?.find((parameter) => parameter.dimension === 'invoiceTotal')?.value, 500);
    assert.equal(wrong.contextFacts?.find((entry) => entry.factClass === 'invoice.amount')?.value, 400);
  });

  it('an unadmitted comparand never satisfies a comparison, in either direction', () => {
    const missing = input({ contextFacts: [] });
    assert.equal(matches(totalMatchesInvoice, missing), false);
    assert.equal(matches(totalDiffers, missing), false);
  });
});

describe('CORE-04 — validating fact predicates, and the restrict-only rule', () => {
  const rule = (condition: PolicyCondition, effect: PolicyEffectType = 'deny'): PolicyPackRule => ({
    id: 'rule-1',
    policyPackVersionId: 'version-1',
    name: 'r',
    description: 'r',
    status: 'active',
    priority: 100,
    condition,
    effect: { type: effect, reasonCode: 'TEST_EFFECT', reason: 'Effect.' },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: [],
  });
  const version = (condition: PolicyCondition, effect?: PolicyEffectType): PolicyPackVersion => ({
    id: 'version-1',
    policyPackId: 'pack-1',
    version: '1.0.0',
    status: 'draft',
    scope: {},
    rules: [rule(condition, effect)],
    sources: [],
    effectiveFrom: NOW,
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const validator = new PolicyPackValidator();
  const refuses = (condition: PolicyCondition, code: string, effect?: PolicyEffectType) =>
    assert.throws(() => validator.validateVersion(version(condition, effect)), (error: unknown) => error instanceof PolicyPackValidationError && error.message.includes(code), JSON.stringify(condition));
  const accepts = (condition: PolicyCondition, effect?: PolicyEffectType) => assert.equal(validator.validateVersion(version(condition, effect)).valid, true, JSON.stringify(condition));
  const signal = (operator: 'equals' | 'in' | 'exists' | 'not_equals' | 'not_in' | 'not_exists', value?: unknown): PolicyCondition => ({
    type: 'predicate',
    field: 'restrictiveFact',
    factClass: 'signal.thresholdCircumvention',
    operator,
    ...(value !== undefined ? { value } : {}),
  });

  it('accepts well-formed fact predicates and a fact comparand', () => {
    accepts(fact('invoice.exists', 'equals', true));
    accepts({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'equals', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } });
    accepts(signal('equals', 'high'));
    accepts(signal('in', ['high', 'critical']), 'require_approval');
    accepts({ type: 'group', operator: 'all', conditions: [signal('exists'), fact('invoice.exists', 'equals', true)] }, 'limit_scope');
  });

  it('refuses a fact predicate without a well-formed class, with a path, or a class on another field', () => {
    refuses({ type: 'predicate', field: 'contextFact', operator: 'exists' }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'contextFact', factClass: 'Not A Class', operator: 'exists' }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'contextFact', factClass: 'invoice.exists', metadataPath: 'a.b', operator: 'exists' }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'actionClass', factClass: 'invoice.exists', operator: 'equals', value: 'x' }, 'INVALID_CONTEXT_PREDICATE');
  });

  it('refuses reading the reserved context namespaces by raw metadata path, in any case', () => {
    for (const metadataPath of ['aoc.context', 'aoc.context.facts', 'AOC.Context.facts.0.value', 'aoc.obligations.state']) {
      refuses({ type: 'predicate', field: 'metadata', metadataPath, operator: 'exists' }, 'INVALID_CONTEXT_PREDICATE');
    }
    accepts({ type: 'predicate', field: 'metadata', metadataPath: 'aoc.contextual', operator: 'exists' });
  });

  it('refuses a malformed fact comparand', () => {
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'equals', valueFrom: { field: 'restrictiveFact' as 'contextFact', factClass: 'signal.x' } }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'equals', value: 1, valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'exists', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'restrictiveFact', factClass: 'signal.x', operator: 'equals', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } }, 'INVALID_CONTEXT_PREDICATE');
  });

  it('§32 / §60 — a restrict-only fact may never drive an allow or a no-op', () => {
    refuses(signal('equals', 'high'), 'RESTRICTIVE_FACT_WIDENING', 'allow');
    refuses(signal('equals', 'high'), 'RESTRICTIVE_FACT_WIDENING', 'no_op');
    refuses({ type: 'group', operator: 'any', conditions: [fact('invoice.exists', 'equals', true), signal('exists')] }, 'RESTRICTIVE_FACT_WIDENING', 'allow');
  });

  it('§60 — a restrict-only fact may never be read where its presence could relax a rule: no negated operator, no `not` group, at any depth', () => {
    refuses(signal('not_equals', 'high'), 'RESTRICTIVE_FACT_NOT_MONOTONE');
    refuses(signal('not_in', ['high']), 'RESTRICTIVE_FACT_NOT_MONOTONE');
    refuses(signal('not_exists'), 'RESTRICTIVE_FACT_NOT_MONOTONE');
    refuses({ type: 'group', operator: 'not', conditions: [signal('exists')] }, 'RESTRICTIVE_FACT_NOT_MONOTONE');
    refuses({ type: 'group', operator: 'all', conditions: [{ type: 'group', operator: 'not', conditions: [{ type: 'group', operator: 'any', conditions: [signal('equals', 'high')] }] }] }, 'RESTRICTIVE_FACT_NOT_MONOTONE');
  });

  it('monotonicity, measured: for every accepted restrict-only rule, adding the admitted fact can only make it match more', () => {
    const accepted: readonly PolicyCondition[] = [
      signal('equals', 'high'),
      signal('in', ['high', 'critical']),
      signal('exists'),
      { type: 'group', operator: 'all', conditions: [signal('exists'), fact('invoice.exists', 'equals', true)] },
      { type: 'group', operator: 'any', conditions: [signal('equals', 'critical'), fact('invoice.amount', 'less_than', 100)] },
    ];
    const withoutSignal = input({ restrictiveFacts: [] });
    for (const condition of accepted) {
      accepts(condition);
      for (const value of ['high', 'critical', 'low', 'other']) {
        const withSignal = input({ restrictiveFacts: [{ factClass: 'signal.thresholdCircumvention', value }] });
        if (matches(condition, withoutSignal)) assert.equal(matches(condition, withSignal), true, `${JSON.stringify(condition)} with '${value}'`);
      }
    }
  });
});
