/**
 * Exact, non-negative decimal quantities for aggregate amount limits.
 *
 * ## Why not a number
 *
 * An aggregate amount limit is authority: "at most 100 USD across every use of
 * this grant". Summing JavaScript numbers — or letting SQLite `SUM()` a `REAL`
 * column — answers that question in binary floating point, where
 * `0.1 + 0.2 === 0.30000000000000004`. A limit of `0.3` would then refuse an
 * exactly-full bucket, and a limit rounded the other way would admit more than
 * the maximum. Neither error is acceptable in an authority check, so nothing
 * here adds two numbers.
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
 * fractional zeros, no bare trailing `.`. Every non-negative decimal has
 * exactly one spelling, so equal quantities compare equal as strings and hash
 * to the same digest. `10.0`, `01`, `+10`, `10.`, `1e3`, `NaN`, `Infinity` and
 * `-1` are all refused rather than normalized: a policy maximum that needs
 * normalizing is a policy nobody reviewed in the form it is enforced in.
 *
 * ## The attempted amount
 *
 * An attempt carries a JavaScript number, because that is what the grant's own
 * ceiling comparison and the customer wire format carry. It is converted to
 * canonical text **once**, from the shortest round-trip spelling JavaScript
 * itself produces (`String(0.1) === '0.1'`), with exponent notation expanded
 * explicitly (`1e-7 → '0.0000001'`, `1e21 → '1000000000000000000000'`). From
 * there on every comparison and every sum is `BigInt` coefficient/scale
 * arithmetic. The precision of the *input* is therefore bounded by what the
 * caller's JSON number could express — that is a stated limit, not a hidden
 * rounding step.
 */

/** A policy maximum may state at most this many digits. Bounded, so a hostile or mistaken policy cannot make every admission do unbounded big-number work. */
export const EXERCISE_DECIMAL_MAXIMUM_DIGITS = 128;

/**
 * An attempted or recorded usage may state at most this many digits.
 *
 * Larger than the policy bound because it must hold **every** finite
 * non-negative JavaScript number exactly as its shortest round-trip spelling
 * expands — the smallest subnormal expands to 324 fractional digits and the
 * largest finite value to 309 integer digits — so no finite attempt is ever
 * unrepresentable, and nothing is ever rounded to fit.
 */
export const EXERCISE_DECIMAL_USAGE_DIGITS = 400;

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function digitCount(text: string): number {
  return text.replace('.', '').length;
}

/** Whether `value` is a canonical non-negative decimal of at most `maximumDigits` digits. Total: every other input is `false`. */
export function isCanonicalExerciseDecimal(value: unknown, maximumDigits: number = EXERCISE_DECIMAL_MAXIMUM_DIGITS): value is string {
  return typeof value === 'string' && CANONICAL_DECIMAL.test(value) && digitCount(value) <= maximumDigits;
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
  if (!isCanonicalExerciseDecimal(value, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is not a canonical exercise decimal.`);
  }
}

/** `left + right`, exactly. Both operands must already be canonical; the result is canonical. */
export function addExerciseDecimals(left: string, right: string): string {
  requireCanonical(left, 'left operand');
  requireCanonical(right, 'right operand');
  const aligned = align(parse(left), parse(right));
  return format({ coefficient: aligned.left + aligned.right, scale: aligned.scale });
}

/** `-1`, `0` or `1` as `left` is below, equal to or above `right`, exactly. */
export function compareExerciseDecimals(left: string, right: string): -1 | 0 | 1 {
  requireCanonical(left, 'left operand');
  requireCanonical(right, 'right operand');
  const aligned = align(parse(left), parse(right));
  return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
}

/**
 * The canonical decimal text of a finite, non-negative JavaScript number, or
 * `undefined` when there is none.
 *
 * Converted from `String(value)` — the shortest spelling that round-trips to
 * the same double — with exponent notation expanded by string manipulation
 * rather than by arithmetic, so nothing is rounded on the way. `-0` is `0`.
 * `NaN`, `±Infinity` and negatives have no canonical form and yield
 * `undefined`, which every caller treats as "no usable amount".
 */
export function exerciseDecimalFromNumber(value: number): string | undefined {
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
  return isCanonicalExerciseDecimal(text, EXERCISE_DECIMAL_USAGE_DIGITS) ? text : undefined;
}
