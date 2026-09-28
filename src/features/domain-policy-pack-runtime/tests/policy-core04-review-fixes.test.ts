import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import { parseMetadataPath } from '../domain/metadata-path.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { PolicyConditionEvaluator } from '../services/policy-condition-evaluator.js';
import { PolicyPackValidator } from '../services/policy-pack-validator.js';

/**
 * CORE-04 review — three policy-validation findings (Codex P1 / P2 / P2):
 *
 * 1. metadata paths are parsed by **one** grammar in validation and
 *    evaluation, so no alias of `aoc.context` / `aoc.obligations` /
 *    `aoc.grant` exists;
 * 2. a fact comparand (`valueFrom`) is validated as a comparand, not as a
 *    missing literal — ordered comparisons against admitted facts work, with
 *    no coercion;
 * 3. a malformed `valueFrom` is a controlled validation issue, never a raw
 *    TypeError.
 */

const NOW = '2026-09-28T12:00:00.000Z';

const rule = (condition: PolicyCondition): PolicyPackRule => ({
  id: 'rule-1',
  policyPackVersionId: 'version-1',
  name: 'r',
  description: 'r',
  status: 'active',
  priority: 100,
  condition,
  effect: { type: 'deny', reasonCode: 'TEST_EFFECT', reason: 'Effect.' },
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
/** Refusal is the repository's controlled error carrying `code` — never a TypeError. */
function refuses(condition: unknown, code: string): void {
  let thrown: unknown;
  try {
    validator.validateVersion(version(condition as PolicyCondition));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof PolicyPackValidationError, `${JSON.stringify(condition)}: expected a PolicyPackValidationError, got ${String(thrown)}`);
  assert.ok(thrown.message.includes(code), `${JSON.stringify(condition)}: ${thrown.message}`);
}
const accepts = (condition: PolicyCondition) => assert.equal(validator.validateVersion(version(condition)).valid, true, JSON.stringify(condition));

const evaluator = new PolicyConditionEvaluator();
function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    id: 'input-1',
    trustDomainId: 'td',
    actorId: 'actor-1',
    action: 'settle-invoice',
    resourceScope: 'payables-ledger',
    riskLevel: 'low',
    requestedAt: NOW,
    governedParameters: [{ dimension: 'invoiceTotal', type: 'integer', value: 500 }],
    contextFacts: [
      { factClass: 'invoice.amount', value: 500 },
      { factClass: 'invoice.limit', value: 1000 },
      { factClass: 'invoice.exists', value: true },
      { factClass: 'invoice.currencyText', value: '500' },
    ],
    ...overrides,
  };
}
const matches = (condition: PolicyCondition, at: PolicyEvaluationInput = input()) => evaluator.evaluate(condition, at).matched;

describe('CORE-04 review (P1) — one metadata-path grammar; no alias of a reserved namespace', () => {
  const reservedAliases = [
    '.aoc.context.facts.0.value',
    'aoc..context.facts.0.value',
    'aoc.context.facts.0.value.',
    'aoc.context..facts',
    '..aoc.context',
    '.aoc.obligations.state',
    'aoc..grant.id',
  ];

  it('leading, repeated and trailing dots and empty segments are not paths — refused INVALID_METADATA_PATH', () => {
    for (const metadataPath of [...reservedAliases, '.', '..', 'a..b', '.a', 'a.']) {
      refuses({ type: 'predicate', field: 'metadata', metadataPath, operator: 'exists' }, 'INVALID_METADATA_PATH');
      assert.equal(parseMetadataPath(metadataPath), undefined, metadataPath);
    }
  });

  it('the reserved namespaces — aoc.context, aoc.obligations and now aoc.grant — are refused in any case', () => {
    for (const metadataPath of ['aoc.context', 'aoc.context.facts.0.value', 'AOC.Context.facts', 'Aoc.OBLIGATIONS.state', 'aoc.grant', 'AOC.GRANT.scope']) {
      refuses({ type: 'predicate', field: 'metadata', metadataPath, operator: 'exists' }, 'INVALID_CONTEXT_PREDICATE');
    }
  });

  it('a normal metadata path is still accepted and read', () => {
    for (const metadataPath of ['tenant.region', 'aoc.contextual', 'aocx.context', 'deployment']) accepts({ type: 'predicate', field: 'metadata', metadataPath, operator: 'exists' });
    assert.equal(matches({ type: 'predicate', field: 'metadata', metadataPath: 'tenant.region', operator: 'equals', value: 'eu' }, input({ metadata: { tenant: { region: 'eu' } } })), true);
  });

  it('evaluation uses the same grammar: an alias reads nothing, and a reserved path reads nothing even from an unvalidated pack', () => {
    const smuggled = input({ metadata: { aoc: { context: { facts: [{ value: true }] }, grant: { id: 'g' } } } });
    for (const metadataPath of [...reservedAliases, 'aoc.context.facts.0.value', 'aoc.grant.id']) {
      assert.equal(matches({ type: 'predicate', field: 'metadata', metadataPath, operator: 'exists' }, smuggled), false, metadataPath);
    }
    // No prototype member answers a path either.
    assert.equal(matches({ type: 'predicate', field: 'metadata', metadataPath: 'constructor', operator: 'exists' }, input({ metadata: {} })), false);
  });
});

describe('CORE-04 review (P2) — a fact comparand is validated as a comparand, not as a missing literal', () => {
  const ordered = ['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'] as const;
  const against = (field: 'parameter' | 'amount', operator: (typeof ordered)[number], factClass: string): PolicyCondition => ({
    type: 'predicate',
    field,
    ...(field === 'parameter' ? { parameterId: 'invoiceTotal' } : {}),
    operator,
    valueFrom: { field: 'contextFact', factClass },
  });

  it('parameter and amount predicates ordered against an admitted fact validate — no literal is required', () => {
    for (const operator of ordered) {
      accepts(against('parameter', operator, 'invoice.limit'));
      accepts(against('amount', operator, 'invoice.limit'));
    }
  });

  it('integer parameter vs integer fact orders exactly: <, <=, >, >=', () => {
    // invoiceTotal 500 vs invoice.limit 1000, and vs invoice.amount 500.
    assert.equal(matches(against('parameter', 'less_than', 'invoice.limit')), true);
    assert.equal(matches(against('parameter', 'less_than_or_equal', 'invoice.amount')), true);
    assert.equal(matches(against('parameter', 'greater_than', 'invoice.limit')), false);
    assert.equal(matches(against('parameter', 'greater_than_or_equal', 'invoice.amount')), true);
    assert.equal(matches(against('parameter', 'greater_than', 'invoice.amount')), false);
  });

  it('no coercion: integer vs boolean, integer vs text, and a monetary amount vs an integer fact never order', () => {
    for (const operator of ordered) {
      assert.equal(matches(against('parameter', operator, 'invoice.exists')), false, `integer ${operator} boolean`);
      assert.equal(matches(against('parameter', operator, 'invoice.currencyText')), false, `integer ${operator} text`);
      assert.equal(matches(against('amount', operator, 'invoice.limit'), input({ amount: '500' })), false, `amount ${operator} integer fact`);
    }
  });

  it('a literal threshold is still validated as a literal', () => {
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'greater_than', value: '100' }, 'INVALID_PARAMETER_THRESHOLD');
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'greater_than' } as PolicyCondition, 'INVALID_PARAMETER_THRESHOLD');
    refuses({ type: 'predicate', field: 'amount', operator: 'greater_than', value: 100 }, 'INVALID_MONETARY_THRESHOLD');
  });

  it('a comparand is compatible only with equality and ordering, and ordering only on integer or monetary fields', () => {
    refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'in', valueFrom: { field: 'contextFact', factClass: 'invoice.limit' } }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'actorId', operator: 'starts_with', valueFrom: { field: 'contextFact', factClass: 'invoice.limit' } }, 'INVALID_CONTEXT_PREDICATE');
    refuses({ type: 'predicate', field: 'actorId', operator: 'greater_than', valueFrom: { field: 'contextFact', factClass: 'invoice.limit' } }, 'INVALID_CONTEXT_PREDICATE');
    accepts({ type: 'predicate', field: 'actorId', operator: 'equals', valueFrom: { field: 'contextFact', factClass: 'invoice.limit' } });
  });
});

describe('CORE-04 review (P2) — a malformed valueFrom is a controlled validation issue, never a TypeError', () => {
  for (const [label, valueFrom] of [
    ['null', null],
    ['an array', []],
    ['an array holding the right shape', [{ field: 'contextFact', factClass: 'invoice.limit' }]],
    ['a string', 'x'],
    ['a number', 7],
    ['an empty object', {}],
    ['a missing factClass', { field: 'contextFact' }],
    ['a missing field', { factClass: 'invoice.limit' }],
    ['a malformed factClass', { field: 'contextFact', factClass: 'Not A Class' }],
    ['a non-string factClass', { field: 'contextFact', factClass: 42 }],
    ['extra keys', { field: 'contextFact', factClass: 'invoice.limit', fallback: 1 }],
    ['a class instance', new (class Comparand {
      field = 'contextFact';
      factClass = 'invoice.limit';
    })()],
  ] as const) {
    it(`${label} → INVALID_CONTEXT_PREDICATE`, () => {
      refuses({ type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'greater_than', valueFrom }, 'INVALID_CONTEXT_PREDICATE');
    });
  }
});
