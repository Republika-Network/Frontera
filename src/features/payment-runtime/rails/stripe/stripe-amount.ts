/**
 * Exact fiat money for the Stripe rail (PAY-09): USD as P9 canonical decimal
 * text ↔ integer cents, the smallest unit Stripe's `amount` field takes for
 * USD.
 *
 * ```
 * "0.01"     USD → 1 cent
 * "1"        USD → 100 cents          (P9 canonicalizes "1.00" to "1")
 * "75"       USD → 7500 cents
 * "75000"    USD → 7500000 cents
 * ```
 *
 * Text and `BigInt` only: no `Number` holds a monetary quantity, nothing is
 * rounded, truncated or parsed as a float, and no exponent is ever read. A
 * value that needs a sub-cent digit is refused, never rounded; zero is
 * refused (a payment is positive); a value Stripe's `amount` cannot carry is
 * refused before anything is contacted.
 *
 * The scale (2) is **trusted configuration**, the currency's ISO minor-unit
 * exponent — never inferred from a Stripe response. USD is the only currency
 * PAY-09 qualifies; zero-decimal and three-decimal currencies are not modelled
 * (`stripe-config.ts` refuses every other).
 */

/** The ISO 4217 minor-unit exponent of USD — the only currency this rail qualifies. */
export const STRIPE_USD_SCALE = 2;

/** Cents per US dollar. */
export const CENTS_PER_USD = 100n;

/**
 * The largest amount Stripe's `amount` field documents for a USD charge: "up
 * to eight digits (e.g., a value of 99999999 for a USD charge of $999,999.99)".
 */
export const STRIPE_MAXIMUM_AMOUNT_CENTS = 99_999_999n;

/** P9's canonical decimal: no sign, no exponent, no leading zero, no trailing fractional zero, no separator. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]*[1-9])?$/;
/** A non-negative integer count of cents as decimal text — what Stripe's integer fields become at this boundary. */
const CANONICAL_CENTS = /^(?:0|[1-9][0-9]{0,17})$/;

/**
 * The exact cents of a positive P9 canonical USD decimal, or `undefined`: not
 * canonical (an exponent, a sign, whitespace, a separator, a leading zero, a
 * trailing fractional zero), zero, more than two fractional digits (a
 * sub-cent quantity), or above Stripe's documented maximum.
 */
export function centsOfUsdDecimal(decimal: unknown): bigint | undefined {
  if (typeof decimal !== 'string' || !CANONICAL_DECIMAL.test(decimal)) return undefined;
  const point = decimal.indexOf('.');
  const integer = point === -1 ? decimal : decimal.slice(0, point);
  const fraction = point === -1 ? '' : decimal.slice(point + 1);
  if (fraction.length > STRIPE_USD_SCALE) return undefined;
  const cents = BigInt(integer) * CENTS_PER_USD + BigInt(fraction.padEnd(STRIPE_USD_SCALE, '0'));
  return cents > 0n && cents <= STRIPE_MAXIMUM_AMOUNT_CENTS ? cents : undefined;
}

/** The P9 canonical USD decimal of a cent amount (`0 < cents ≤` the maximum), or `undefined`. Exact: every cent amount has one. */
export function usdDecimalOfCents(cents: unknown): string | undefined {
  if (typeof cents !== 'bigint' || cents <= 0n || cents > STRIPE_MAXIMUM_AMOUNT_CENTS) return undefined;
  const whole = cents / CENTS_PER_USD;
  const fraction = (cents % CENTS_PER_USD).toString().padStart(STRIPE_USD_SCALE, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * A Stripe-reported cent count, carried across the adapter boundary as decimal
 * text → `BigInt`, or `undefined`. Never a `Number` here: the adapter turns
 * Stripe's JSON integer into text only after proving it a safe integer.
 * Zero is allowed (an `amount_received` before payment is zero).
 */
export function centsOfDecimalText(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !CANONICAL_CENTS.test(value)) return undefined;
  return BigInt(value);
}
