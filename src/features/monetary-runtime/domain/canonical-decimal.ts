/**
 * Exact, non-negative canonical decimals — the one textual representation of a
 * monetary quantity inside Frontera's trusted domain.
 *
 * ## Why not a number
 *
 * A monetary amount is authority: "move at most 100 USD". Held as a JavaScript
 * number it is an IEEE-754 binary double, in which `0.1 + 0.2 !== 0.3` and
 * `9007199254740993` does not exist. Exact arithmetic downstream cannot recover
 * precision lost upstream, so the quantity is text from the moment it crosses
 * the boundary, and every comparison and sum is `BigInt` coefficient/scale
 * arithmetic over that text. Nothing here converts a decimal to a number.
 *
 * ## The one canonical text form
 *
 * ```
 * 0
 * [1-9][0-9]*                    an integer with no leading zero
 * (0|[1-9][0-9]*)\.[0-9]*[1-9]   a fraction with no trailing zero
 * ```
 *
 * No sign, no exponent, no leading `+`, no leading zeros, no trailing
 * fractional zeros, no bare trailing `.`, no whitespace, no separators. Every
 * non-negative decimal has exactly one spelling, so equal quantities compare
 * equal as strings and serialize — and therefore digest — identically.
 *
 * ## The one boundary normalization
 *
 * `canonicalizeDecimalText` is the only function that turns untrusted text into
 * canonical text, and the only normalization it performs is dropping trailing
 * fractional zeros (`"10.50"` → `"10.5"`, `"1.00"` → `"1"`), which changes the
 * spelling and never the quantity. Everything else that is not already a plain
 * decimal is refused rather than repaired. It never rounds and never truncates:
 * whether the quantity fits an asset's scale is a separate, exact question —
 * see `monetary-amount.ts`.
 */

/** A canonical monetary decimal may state at most this many digits. Bounded, so hostile input cannot make every comparison do unbounded big-number work. */
export const MONETARY_DECIMAL_MAXIMUM_DIGITS = 128;

/** Untrusted decimal text longer than this is refused before it is parsed. Generous enough for any canonical value plus trailing zeros a caller might spell. */
export const MONETARY_DECIMAL_MAXIMUM_TEXT_LENGTH = 256;

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

/** A plain decimal as a boundary may receive it: no sign, no exponent, no leading zero, an optional non-empty fraction. */
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function digitCount(text: string): number {
  return text.replace('.', '').length;
}

/** Whether `value` is a canonical non-negative decimal of at most `maximumDigits` digits. Total: every other input is `false`. */
export function isCanonicalDecimal(value: unknown, maximumDigits: number = MONETARY_DECIMAL_MAXIMUM_DIGITS): value is string {
  return typeof value === 'string' && CANONICAL_DECIMAL.test(value) && digitCount(value) <= maximumDigits;
}

/**
 * The canonical form of untrusted decimal text, or `undefined` when it is not a
 * plain non-negative decimal.
 *
 * Accepts exactly `(0|[1-9][0-9]*)(\.[0-9]+)?` and drops trailing fractional
 * zeros. Refuses — never repairs — whitespace, `+`, `-`, exponents, `NaN`,
 * `Infinity`, leading zeros, thousands or locale separators, a bare `.`, and
 * anything that is not a string (a JSON number in particular: its precision was
 * already decided by whoever parsed it).
 */
export function canonicalizeDecimalText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MONETARY_DECIMAL_MAXIMUM_TEXT_LENGTH) return undefined;
  if (!PLAIN_DECIMAL.test(value)) return undefined;
  const point = value.indexOf('.');
  let canonical = value;
  if (point !== -1) {
    let end = value.length;
    while (end > point + 1 && value.charCodeAt(end - 1) === 48 /* '0' */) end -= 1;
    canonical = end === point + 1 ? value.slice(0, point) : value.slice(0, end);
  }
  return isCanonicalDecimal(canonical) ? canonical : undefined;
}

/** How many fractional digits a canonical decimal states. `"12.345"` → `3`, `"12"` → `0`. */
export function canonicalDecimalScale(canonical: string): number {
  requireCanonical(canonical, 'value');
  const point = canonical.indexOf('.');
  return point === -1 ? 0 : canonical.length - point - 1;
}

function parse(text: string): ExactDecimal {
  const point = text.indexOf('.');
  if (point === -1) return { coefficient: BigInt(text), scale: 0 };
  return { coefficient: BigInt(text.slice(0, point) + text.slice(point + 1)), scale: text.length - point - 1 };
}

function format(value: ExactDecimal): string {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (coefficient === 0n) return '0';
  const digits = coefficient.toString();
  if (scale === 0) return digits;
  const padded = digits.padStart(scale + 1, '0');
  return `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
}

function align(left: ExactDecimal, right: ExactDecimal): { readonly left: bigint; readonly right: bigint; readonly scale: number } {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * 10n ** BigInt(scale - left.scale),
    right: right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function requireCanonical(value: string, label: string): void {
  if (!isCanonicalDecimal(value, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is not a canonical decimal.`);
  }
}

/** `left + right`, exactly. Both operands must already be canonical; the result is canonical. */
export function addCanonicalDecimals(left: string, right: string): string {
  requireCanonical(left, 'left operand');
  requireCanonical(right, 'right operand');
  const aligned = align(parse(left), parse(right));
  return format({ coefficient: aligned.left + aligned.right, scale: aligned.scale });
}

/** `-1`, `0` or `1` as `left` is below, equal to or above `right`, exactly. */
export function compareCanonicalDecimals(left: string, right: string): -1 | 0 | 1 {
  requireCanonical(left, 'left operand');
  requireCanonical(right, 'right operand');
  const aligned = align(parse(left), parse(right));
  return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
}

/** A JSON number exactly as it was written on the wire (RFC 8259 §6). */
const JSON_NUMBER_LEXEME = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,4}))?$/;

/**
 * The canonical decimal text of a **JSON number lexeme** — the characters a
 * client actually wrote, captured by the protocol boundary before any IEEE-754
 * parse — or `undefined` when it names no non-negative quantity.
 *
 * Text in, text out: the exponent is applied by moving the decimal point in the
 * digit string, never by arithmetic, so `"9007199254740993.010"` is
 * `"9007199254740993.01"` and `"1.5e3"` is `"1500"` exactly. The result goes
 * through `canonicalizeDecimalText`, so there is still one canonicalizer. A
 * negative lexeme has no canonical form (`"-0"` is zero), an exponent of more
 * than four digits is refused before any expansion, and anything that is not a
 * JSON number — a JavaScript number included — is refused.
 *
 * This is the one place a v1 wire amount written as a JSON number can become
 * monetary data, and it never goes through `number` on the way.
 */
export function canonicalDecimalFromJsonNumberLexeme(lexeme: unknown): string | undefined {
  if (typeof lexeme !== 'string' || lexeme.length === 0 || lexeme.length > MONETARY_DECIMAL_MAXIMUM_TEXT_LENGTH) return undefined;
  const match = JSON_NUMBER_LEXEME.exec(lexeme);
  if (match === null) return undefined;
  const negative = match[1] === '-';
  const integer = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const exponentText = match[4] ?? '0';
  const exponentDigits = exponentText.replace(/^[+-]/, '');
  const exponentMagnitude = Number(exponentDigits);
  const exponent = exponentText.startsWith('-') ? -exponentMagnitude : exponentMagnitude;
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  if (point > MONETARY_DECIMAL_MAXIMUM_TEXT_LENGTH || point < -MONETARY_DECIMAL_MAXIMUM_TEXT_LENGTH) return undefined;
  let plain: string;
  if (point <= 0) plain = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = `${digits}${'0'.repeat(point - digits.length)}`;
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole = '0', rest] = plain.split('.');
  const trimmedWhole = whole.replace(/^0+(?=[0-9])/, '');
  const canonical = canonicalizeDecimalText(rest === undefined ? trimmedWhole : `${trimmedWhole}.${rest}`);
  if (canonical === undefined) return undefined;
  if (negative) return canonical === '0' ? '0' : undefined;
  return canonical;
}
