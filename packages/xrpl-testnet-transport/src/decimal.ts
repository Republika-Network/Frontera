/**
 * Exact comparison of XRPL issued-currency values — text only, never a
 * floating-point number.
 *
 * A ledger may report an issued value as plain decimal (`"75000"`,
 * `"75000.00"`) or in exponent form (`"7.5e4"`). Both sides are reduced to one
 * canonical form — a positive digit string with no leading or trailing zeros,
 * and a power-of-ten exponent — and compared as strings.
 */

const ISSUED_VALUE = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export interface CanonicalDecimal {
  readonly negative: boolean;
  /** Significant digits, no leading or trailing zeros; `"0"` for zero. */
  readonly digits: string;
  /** value = digits × 10^exponent. 0 for zero. */
  readonly exponent: number;
}

export function canonicalIssuedValue(text: unknown): CanonicalDecimal | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return undefined;
  const match = ISSUED_VALUE.exec(text);
  if (match === null) return undefined;
  const [, sign = '', integer = '', fraction = '', exponentText = '0'] = match;
  const exponentValue = /^[+-]?\d{1,4}$/.test(exponentText) ? Number.parseInt(exponentText, 10) : undefined;
  if (exponentValue === undefined) return undefined;
  let digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (digits.length === 0) return { negative: false, digits: '0', exponent: 0 };
  let exponent = exponentValue - fraction.length;
  const trimmed = digits.replace(/0+$/, '');
  exponent += digits.length - trimmed.length;
  digits = trimmed;
  return { negative: sign === '-', digits, exponent };
}

/** True when both texts are well-formed issued values denoting exactly the same number. */
export function issuedValuesEqual(left: unknown, right: unknown): boolean {
  const a = canonicalIssuedValue(left);
  const b = canonicalIssuedValue(right);
  return a !== undefined && b !== undefined && a.negative === b.negative && a.digits === b.digits && a.exponent === b.exponent;
}
