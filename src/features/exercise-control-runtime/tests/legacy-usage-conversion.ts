import { EXERCISE_DECIMAL_USAGE_DIGITS, isCanonicalExerciseDecimal } from '../index.js';

/**
 * **Test support only.** How the P7 gate turned an attempted JavaScript number
 * into canonical usage text before P9 — kept verbatim so the suite can still
 * prove what that conversion produced, and that every value it could ever have
 * written to a ledger fits `EXERCISE_DECIMAL_USAGE_DIGITS` and is therefore
 * still readable.
 *
 * Since P9 no production path converts a number into monetary text: an attempt
 * carries canonical text from the governed-action boundary, and this function
 * is deliberately not exported from the exercise-control or monetary runtime.
 */
export function legacyExerciseDecimalFromNumber(value: number): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const spelled = String(value === 0 ? 0 : value);
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/.exec(spelled);
  if (match === null) return undefined;
  const integer = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  let scale = fraction.length - exponent;
  let coefficient = BigInt(`${integer}${fraction}`);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  let text: string;
  if (coefficient === 0n) text = '0';
  else if (scale === 0) text = coefficient.toString();
  else {
    const padded = coefficient.toString().padStart(scale + 1, '0');
    text = `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  }
  return isCanonicalExerciseDecimal(text, EXERCISE_DECIMAL_USAGE_DIGITS) ? text : undefined;
}
