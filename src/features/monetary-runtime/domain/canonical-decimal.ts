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

/**
 * The canonical decimal text of a finite, non-negative JavaScript number, or
 * `undefined` when there is none.
 *
 * **Not a monetary ingress.** An amount never enters the trusted domain as a
 * number; this exists for values that are numbers *by their own contract* and
 * are authored by trusted configuration — a policy pack's literal threshold
 * (`amount >= 10000`), whose exact meaning is the decimal its author wrote.
 * Converted from `String(value)` — the shortest spelling that round-trips to the
 * same double — with exponent notation expanded by string manipulation rather
 * than by arithmetic, so nothing is rounded on the way. `-0` is `0`. `NaN`,
 * `±Infinity` and negatives have no canonical form and yield `undefined`.
 */
export function canonicalDecimalFromNumber(value: number, maximumDigits: number = MONETARY_DECIMAL_MAXIMUM_DIGITS): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const spelled = String(value === 0 ? 0 : value);
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/.exec(spelled);
  if (match === null) return undefined;
  const integer = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  const scale = fraction.length - exponent;
  const coefficient = BigInt(`${integer}${fraction}`);
  const exact: ExactDecimal = scale >= 0 ? { coefficient, scale } : { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 };
  const text = format(exact);
  return isCanonicalDecimal(text, maximumDigits) ? text : undefined;
}
