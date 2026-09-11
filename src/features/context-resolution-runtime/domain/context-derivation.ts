import type { ContextFactValue } from './context-fact.js';

/**
 * The closed, total algebra over context facts — and the whole of it.
 *
 * `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` and the target architecture both put a
 * hard boundary here (risk R3: "derived values grow into an expression language
 * and then into `eval`"). The countermeasure is structural rather than
 * advisory: seven named operators, each a plain function over numbers, and no
 * parser, no expression string, no `eval`, no `new Function`, no user-supplied
 * code path of any kind. A derivation is *declared configuration* — an operator
 * and a list of operand keys — never something a requester or a policy author
 * writes as text.
 *
 * Every failure resolves to a typed outcome rather than a thrown error or a
 * substituted default, because a derived value that could not be computed must
 * reach policy as `unresolved` (ADR §5), never as zero.
 */
export type ContextDerivationOperator = 'sum' | 'difference' | 'product' | 'quotient' | 'min' | 'max' | 'count';

export const CONTEXT_DERIVATION_OPERATORS: readonly ContextDerivationOperator[] = [
  'sum',
  'difference',
  'product',
  'quotient',
  'min',
  'max',
  'count',
];

/** One declared derived fact: which key it produces, from which operand keys, under which operator. Operand keys must themselves be declared context keys. */
export interface ContextDerivation {
  readonly key: string;
  readonly operator: ContextDerivationOperator;
  readonly operandKeys: readonly string[];
}

export type ContextDerivationFailureReason =
  /** An operand was not a number. Never coerced: `'10'` and `10` are different claims about the world. */
  | 'type_mismatch'
  /** `quotient` with a zero divisor. */
  | 'division_by_zero'
  /** The operator was given the wrong number of operands. */
  | 'arity'
  /** A non-finite result (overflow, or a computation that produced `NaN`/Infinity). */
  | 'not_finite';

export type ContextDerivationOutcome =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: ContextDerivationFailureReason };

/**
 * Evaluates one derivation. Pure, total and deterministic: no clock, no store,
 * no randomness, and the same operands in the same order always produce the
 * same outcome.
 *
 * `count` is the one operator that accepts non-numeric operands, because it
 * counts observations rather than reading their values — "how many approvals
 * were resolved" is a legitimate aggregate over facts whose values are strings.
 */
export function evaluateContextDerivation(operator: ContextDerivationOperator, operands: readonly ContextFactValue[]): ContextDerivationOutcome {
  if (operator === 'count') {
    return { ok: true, value: operands.length };
  }

  const numbers: number[] = [];
  for (const operand of operands) {
    if (typeof operand !== 'number' || !Number.isFinite(operand)) return { ok: false, reason: 'type_mismatch' };
    numbers.push(operand);
  }

  switch (operator) {
    case 'sum':
      if (numbers.length === 0) return { ok: false, reason: 'arity' };
      return finite(numbers.reduce((total, value) => total + value, 0));
    case 'product':
      if (numbers.length === 0) return { ok: false, reason: 'arity' };
      return finite(numbers.reduce((total, value) => total * value, 1));
    case 'min':
      if (numbers.length === 0) return { ok: false, reason: 'arity' };
      return finite(numbers.reduce((lowest, value) => (value < lowest ? value : lowest)));
    case 'max':
      if (numbers.length === 0) return { ok: false, reason: 'arity' };
      return finite(numbers.reduce((highest, value) => (value > highest ? value : highest)));
    case 'difference': {
      if (numbers.length !== 2) return { ok: false, reason: 'arity' };
      const [left, right] = numbers as [number, number];
      return finite(left - right);
    }
    case 'quotient': {
      if (numbers.length !== 2) return { ok: false, reason: 'arity' };
      const [left, right] = numbers as [number, number];
      if (right === 0) return { ok: false, reason: 'division_by_zero' };
      return finite(left / right);
    }
  }
}

function finite(value: number): ContextDerivationOutcome {
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'not_finite' };
}

/** Structural violations of a derivation declaration. A derivation with no operands is rejected outright: it would produce a fact that derives from nothing and therefore evidences nothing. */
export function validateContextDerivation(derivation: ContextDerivation): readonly string[] {
  const violations: string[] = [];
  if (typeof derivation.key !== 'string' || derivation.key.trim().length === 0) violations.push('ContextDerivation.key is required and must be non-empty.');
  if (!CONTEXT_DERIVATION_OPERATORS.includes(derivation.operator)) {
    violations.push(`ContextDerivation '${derivation.key}': operator '${String(derivation.operator)}' is not part of the closed derivation algebra.`);
  }
  if (derivation.operandKeys.length === 0) {
    violations.push(`ContextDerivation '${derivation.key}': a derived fact must derive from at least one operand key.`);
  }
  if (derivation.operandKeys.includes(derivation.key)) {
    violations.push(`ContextDerivation '${derivation.key}': a derivation may not name its own key as an operand.`);
  }
  if ((derivation.operator === 'difference' || derivation.operator === 'quotient') && derivation.operandKeys.length !== 2) {
    violations.push(`ContextDerivation '${derivation.key}': operator '${derivation.operator}' takes exactly two operands.`);
  }
  return violations;
}
