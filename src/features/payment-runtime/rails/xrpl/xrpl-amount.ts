/**
 * PAY-01 canonical decimal → XRPL issued-currency value (PAY-02).
 *
 * The XRPL represents an issued-currency amount as a 16-digit mantissa and an
 * exponent in [-96, 80]; so at most **15 significant digits** survive exactly,
 * and the magnitude is bounded. The PAY-01 amount is already canonical decimal
 * text (`"1250.5"`), so the value handed to the ledger is that same text,
 * unchanged — this module only proves the ledger can hold it exactly, by
 * string arithmetic. No floating point, no rounding, no unit conversion. A
 * value the ledger cannot hold exactly is refused before anything is prepared.
 */

/** P9's canonical decimal: no sign, no exponent, no leading zero, no trailing fractional zero. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

export const XRPL_ISSUED_VALUE_LIMITS = Object.freeze({ significantDigits: 15, mantissaDigits: 16, minimumExponent: -96, maximumExponent: 80 });

/** The exact XRPL issued-currency value for a positive canonical decimal, or `undefined` when the ledger cannot represent it exactly. */
export function xrplIssuedValueOf(decimal: unknown): string | undefined {
  if (typeof decimal !== 'string' || !CANONICAL_DECIMAL.test(decimal)) return undefined;
  const point = decimal.indexOf('.');
  const integer = point === -1 ? decimal : decimal.slice(0, point);
  const fraction = point === -1 ? '' : decimal.slice(point + 1);
  const digits = (integer + fraction).replace(/^0+/, '');
  if (digits.length === 0) return undefined; // zero is not a payment
  const significant = digits.replace(/0+$/, '');
  const trailingZeros = digits.length - significant.length;
  if (significant.length > XRPL_ISSUED_VALUE_LIMITS.significantDigits) return undefined;
  // value = significant × 10^(trailingZeros − fraction.length); normalized to a 16-digit mantissa.
  const exponent = trailingZeros - fraction.length - (XRPL_ISSUED_VALUE_LIMITS.mantissaDigits - significant.length);
  if (exponent < XRPL_ISSUED_VALUE_LIMITS.minimumExponent || exponent > XRPL_ISSUED_VALUE_LIMITS.maximumExponent) return undefined;
  return decimal;
}

/** rippled's text form of an issued value: optional sign, digits, optional fraction, optional exponent. */
const LEDGER_VALUE = /^(-)?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/;

/**
 * A ledger-reported issued value (`"1250.5"`, `"1e-15"`, `"125e1"`) as P9
 * canonical decimal text, or `undefined` for anything else — negative, empty,
 * malformed. String arithmetic only, so it can be compared exactly with the
 * amount the grant bounded.
 */
export function canonicalDecimalOfLedgerValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const match = LEDGER_VALUE.exec(value);
  if (match === null || match[1] !== undefined) return undefined;
  const integer = match[2] ?? '';
  const fraction = match[3] ?? '';
  const shift = Number.parseInt(match[4] ?? '0', 10) - fraction.length;
  let digits = (integer + fraction).replace(/^0+/, '');
  if (digits.length === 0) return '0';
  if (shift >= 0) return digits + '0'.repeat(shift);
  const places = -shift;
  if (digits.length <= places) digits = '0'.repeat(places - digits.length + 1) + digits;
  const whole = digits.slice(0, digits.length - places).replace(/^0+(?=[0-9])/, '');
  const part = digits.slice(digits.length - places).replace(/0+$/, '');
  return part.length === 0 ? whole : `${whole}.${part}`;
}
