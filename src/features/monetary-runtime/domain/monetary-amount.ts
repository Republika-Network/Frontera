import { canonicalDecimalScale, canonicalizeDecimalText, compareCanonicalDecimals, isCanonicalDecimal } from './canonical-decimal.js';
import { isCanonicalMonetaryAssetId, type MonetaryAssetRegistry } from './monetary-asset.js';

/**
 * A monetary amount: an exact canonical decimal and the asset it is
 * denominated in.
 *
 * ```ts
 * { value: '123.45', unit: 'USD' }
 * ```
 *
 * `value` is canonical decimal text (`canonical-decimal.ts`), never a number.
 * `unit` is a registry asset identifier (`monetary-asset.ts`). An object of this
 * type that came out of `parseMonetaryAmount` has also been proven to fit its
 * asset's trusted scale exactly.
 */
export interface MonetaryAmount {
  readonly value: string;
  readonly unit: string;
}

export const MONETARY_AMOUNT_VIOLATIONS = {
  /** `value` is not a string — a JSON number in particular. Its precision was decided by whoever parsed it, so it is refused rather than re-spelled. */
  MONETARY_VALUE_NOT_TEXT: 'MONETARY_VALUE_NOT_TEXT',
  /** `value` is text but not a plain non-negative decimal: whitespace, a sign, an exponent, separators, leading zeros, `NaN`, empty. */
  MONETARY_VALUE_MALFORMED: 'MONETARY_VALUE_MALFORMED',
  /** `unit` is not an asset this deployment recognizes. */
  MONETARY_UNIT_UNKNOWN: 'MONETARY_UNIT_UNKNOWN',
  /** `value` states more fractional digits than the asset's trusted scale. Refused, never rounded or truncated. */
  MONETARY_SCALE_EXCEEDED: 'MONETARY_SCALE_EXCEEDED',
} as const;

export type MonetaryAmountViolation = (typeof MONETARY_AMOUNT_VIOLATIONS)[keyof typeof MONETARY_AMOUNT_VIOLATIONS];

export type MonetaryAmountParse = { readonly valid: true; readonly amount: MonetaryAmount } | { readonly valid: false; readonly violation: MonetaryAmountViolation };

/**
 * The single ingress from untrusted input to a trusted `MonetaryAmount`.
 *
 * In order: the value must be text; the text must be a plain decimal, which is
 * canonicalized (`"10.50"` → `"10.5"`); the unit must resolve in the trusted
 * registry; and the canonical value's fractional digits must not exceed the
 * resolved asset's scale. `"10.001"` against a scale-2 asset is refused —
 * `"10.00"` is never produced from it. The scale is read from the registry
 * only; nothing in `input` is consulted for it.
 */
export function parseMonetaryAmount(input: { readonly value: unknown; readonly unit: unknown }, assets: MonetaryAssetRegistry): MonetaryAmountParse {
  if (typeof input.value !== 'string') return { valid: false, violation: MONETARY_AMOUNT_VIOLATIONS.MONETARY_VALUE_NOT_TEXT };
  const value = canonicalizeDecimalText(input.value);
  if (value === undefined) return { valid: false, violation: MONETARY_AMOUNT_VIOLATIONS.MONETARY_VALUE_MALFORMED };
  const asset = assets.resolve(input.unit);
  if (asset === undefined) return { valid: false, violation: MONETARY_AMOUNT_VIOLATIONS.MONETARY_UNIT_UNKNOWN };
  if (canonicalDecimalScale(value) > asset.scale) return { valid: false, violation: MONETARY_AMOUNT_VIOLATIONS.MONETARY_SCALE_EXCEEDED };
  return { valid: true, amount: Object.freeze({ value, unit: asset.assetId }) };
}

/**
 * Whether a value is structurally a canonical monetary amount: canonical
 * decimal text and a well-formed asset identifier, and nothing else.
 *
 * Registry-free on purpose. The layers downstream of ingress — grant bounds,
 * exercise requests, aggregate controls — hold no registry and need none: they
 * receive amounts that already passed `parseMonetaryAmount`, and this is the
 * fail-closed re-check that a value reaching them was not built some other way.
 */
export function isWellFormedMonetaryAmount(value: unknown): value is MonetaryAmount {
  if (value === null || typeof value !== 'object') return false;
  const { value: decimal, unit } = value as { readonly value?: unknown; readonly unit?: unknown };
  return isCanonicalDecimal(decimal) && isCanonicalMonetaryAssetId(unit);
}

/** Whether an amount is strictly greater than zero. An expenditure of nothing is not an expenditure. */
export function isPositiveMonetaryAmount(amount: MonetaryAmount): boolean {
  return isWellFormedMonetaryAmount(amount) && amount.value !== '0';
}

/**
 * `-1`, `0` or `1` as `left` is below, equal to or above `right` — or
 * `'incomparable'` when either is malformed or they are denominated in
 * different assets.
 *
 * There is no conversion and no fallback to comparing magnitudes: `10 USD`
 * against `20 xrpl:XRP` is `'incomparable'`, and every caller treats that as the
 * fail-closed answer. A conversion table is a place for a rate to be wrong, and
 * a wrong rate in an authority check widens authority.
 */
export function compareMonetaryAmounts(left: MonetaryAmount, right: MonetaryAmount): -1 | 0 | 1 | 'incomparable' {
  if (!isWellFormedMonetaryAmount(left) || !isWellFormedMonetaryAmount(right)) return 'incomparable';
  if (left.unit !== right.unit) return 'incomparable';
  return compareCanonicalDecimals(left.value, right.value);
}
