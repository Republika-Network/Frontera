import { addCanonicalDecimals, compareCanonicalDecimals, isCanonicalDecimal } from '../../monetary-runtime/index.js';

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
 * Since P9 an attempt carries its amount as canonical decimal text from the
 * governed-action boundary onward (`src/features/monetary-runtime`), so it is
 * never converted from a number here: an attempt whose amount is not canonical
 * text is withheld. This module is the exercise-control view of the one shared
 * implementation — the grammar, parse, format and `BigInt` arithmetic live in
 * `monetary-runtime/domain/canonical-decimal.ts`, and nothing here re-implements
 * them.
 */

/** A policy maximum may state at most this many digits. Bounded, so a hostile or mistaken policy cannot make every admission do unbounded big-number work. */
export const EXERCISE_DECIMAL_MAXIMUM_DIGITS = 128;

/**
 * An attempted or recorded usage may state at most this many digits.
 *
 * Larger than the policy bound because usage recorded before P9 was converted
 * from **every** finite non-negative JavaScript number as its shortest
 * round-trip spelling expands — the smallest subnormal expands to 324
 * fractional digits and the largest finite value to 309 integer digits — and a
 * ledger must still read what it already holds.
 */
export const EXERCISE_DECIMAL_USAGE_DIGITS = 400;

/** Whether `value` is a canonical non-negative decimal of at most `maximumDigits` digits. Total: every other input is `false`. */
export function isCanonicalExerciseDecimal(value: unknown, maximumDigits: number = EXERCISE_DECIMAL_MAXIMUM_DIGITS): value is string {
  return isCanonicalDecimal(value, maximumDigits);
}

/** `left + right`, exactly. Both operands must already be canonical; the result is canonical. */
export function addExerciseDecimals(left: string, right: string): string {
  return addCanonicalDecimals(left, right);
}

/** `-1`, `0` or `1` as `left` is below, equal to or above `right`, exactly. */
export function compareExerciseDecimals(left: string, right: string): -1 | 0 | 1 {
  return compareCanonicalDecimals(left, right);
}
