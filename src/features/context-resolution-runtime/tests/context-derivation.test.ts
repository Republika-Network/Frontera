import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONTEXT_DERIVATION_OPERATORS, evaluateContextDerivation, validateContextDerivation } from '../domain/context-derivation.js';

describe('The derivation algebra is closed and total', () => {
  it('has exactly the seven operators the ADR approved, and no way to add an eighth at runtime', () => {
    assert.deepEqual([...CONTEXT_DERIVATION_OPERATORS].sort(), ['count', 'difference', 'max', 'min', 'product', 'quotient', 'sum']);
  });

  it('computes each operator over numeric operands', () => {
    assert.deepEqual(evaluateContextDerivation('sum', [1, 2, 3]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('difference', [10, 4]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('product', [2, 3]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('quotient', [12, 2]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('min', [9, 6, 7]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('max', [1, 6, 2]), { ok: true, value: 6 });
    assert.deepEqual(evaluateContextDerivation('count', ['a', 'b', true, 4, 5, 6]), { ok: true, value: 6 });
  });

  it('division by zero resolves to a typed failure, never to Infinity and never to a default', () => {
    assert.deepEqual(evaluateContextDerivation('quotient', [1, 0]), { ok: false, reason: 'division_by_zero' });
  });

  it('a non-numeric operand is a type mismatch, never coerced', () => {
    assert.deepEqual(evaluateContextDerivation('sum', [1, '2']), { ok: false, reason: 'type_mismatch' });
    assert.deepEqual(evaluateContextDerivation('sum', [1, true]), { ok: false, reason: 'type_mismatch' });
    assert.deepEqual(evaluateContextDerivation('max', [Number.NaN]), { ok: false, reason: 'type_mismatch' });
  });

  it('wrong arity is a typed failure rather than a partial answer', () => {
    assert.deepEqual(evaluateContextDerivation('difference', [1, 2, 3]), { ok: false, reason: 'arity' });
    assert.deepEqual(evaluateContextDerivation('quotient', [1]), { ok: false, reason: 'arity' });
    assert.deepEqual(evaluateContextDerivation('sum', []), { ok: false, reason: 'arity' });
  });

  it('an overflowing result is reported rather than returned as Infinity', () => {
    assert.deepEqual(evaluateContextDerivation('product', [Number.MAX_VALUE, Number.MAX_VALUE]), { ok: false, reason: 'not_finite' });
  });

  it('is total: every operator returns an outcome for every operand list, and never throws', () => {
    const operandLists: readonly (readonly (string | number | boolean)[])[] = [[], [0], [1, 0], ['x'], [true, false], [1, 2, 3, 4]];
    for (const operator of CONTEXT_DERIVATION_OPERATORS) {
      for (const operands of operandLists) {
        const outcome = evaluateContextDerivation(operator, operands);
        assert.equal(typeof outcome.ok, 'boolean');
      }
    }
  });

  it('is deterministic: the same operands always produce the same outcome', () => {
    const first = evaluateContextDerivation('sum', [1, 2, 3]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      assert.deepEqual(evaluateContextDerivation('sum', [1, 2, 3]), first);
    }
  });
});

describe('Derivation declarations are validated, not executed', () => {
  it('rejects a derivation with no operands — a derived fact must derive from something', () => {
    const violations = validateContextDerivation({ key: 'a', operator: 'sum', operandKeys: [] });
    assert.ok(violations.some((violation) => /at least one operand/.test(violation)));
  });

  it('rejects a self-referential derivation', () => {
    const violations = validateContextDerivation({ key: 'a', operator: 'sum', operandKeys: ['a'] });
    assert.ok(violations.some((violation) => /may not name its own key/.test(violation)));
  });

  it('rejects a binary operator given the wrong number of operands', () => {
    assert.ok(validateContextDerivation({ key: 'a', operator: 'quotient', operandKeys: ['b'] }).length > 0);
    assert.deepEqual(validateContextDerivation({ key: 'a', operator: 'quotient', operandKeys: ['b', 'c'] }), []);
  });
});
