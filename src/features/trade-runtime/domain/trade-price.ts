import { snapshotTradeRecord } from './trade-grammar.js';
import type { TradeExactQuantity } from './trade-asset.js';

/**
 * The limit price of an offer, as an exact rational (TRADE-01).
 *
 * An offer's price is the ratio of its two amounts. Two decimals divide into a
 * value that is often not a decimal at all (`1 / 3`), so the price is kept as
 * a reduced fraction of two positive `BigInt`s and never as a rounded decimal:
 * an authorization for "at least 1/3 USD per XRP" must not quietly become one
 * for 0.3333.
 *
 * Orientation is fixed by the canonical pair: the price is always **quote
 * units per one base unit**, XRP counted in XRP (not drops). Its meaning
 * follows from the side:
 *
 * - a `sell` (the owner gives base) states the **lowest** price the owner
 *   accepts;
 * - a `buy` (the owner gives quote) states the **highest** price the owner
 *   pays.
 *
 * A limit price bounds the worst rate an order may fill at. It is **not**
 * slippage protection against a market reference; that needs a trusted
 * reference price, which is never the applicant's (see the TRADE-01 doc).
 */
export interface TradePrice {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** A price numerator or denominator states at most this many digits. Bounded so hostile input cannot force unbounded arithmetic. */
export const TRADE_PRICE_MAXIMUM_DIGITS = 256;

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** `quote / base` in lowest terms. Both quantities must be positive. */
export function tradePriceOf(quote: TradeExactQuantity, base: TradeExactQuantity): TradePrice {
  // (q / 10^qs) / (b / 10^bs) = (q · 10^bs) / (b · 10^qs)
  const numerator = quote.coefficient * 10n ** BigInt(base.scale);
  const denominator = base.coefficient * 10n ** BigInt(quote.scale);
  if (numerator <= 0n || denominator <= 0n) throw new RangeError('A price needs two positive quantities.');
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

/** `-1`, `0` or `1` as `left` is below, equal to or above `right`, exactly (cross-multiplication; denominators are positive). */
export function compareTradePrices(left: TradePrice, right: TradePrice): -1 | 0 | 1 {
  const l = left.numerator * right.denominator;
  const r = right.numerator * left.denominator;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The canonical text of a reduced price: `<numerator>/<denominator>`. One spelling per price. */
export function formatTradePrice(price: TradePrice): string {
  return `${price.numerator.toString()}/${price.denominator.toString()}`;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export type TradePriceParse = { readonly valid: true; readonly price: TradePrice } | { readonly valid: false };

/**
 * A price an applicant *asserts* — `{ numerator, denominator }`, each positive
 * integer text with no leading zero. Need not be in lowest terms; it is
 * reduced. An assertion is only ever checked against the price the two
 * amounts imply; it never sets one.
 */
export function parseTradePriceAssertion(raw: unknown): TradePriceParse {
  const snapshot = snapshotTradeRecord(raw, 4);
  if (!snapshot.ok || snapshot.entries.size !== 2) return { valid: false };
  const numerator = snapshot.entries.get('numerator');
  const denominator = snapshot.entries.get('denominator');
  const ok = (value: unknown): value is string => typeof value === 'string' && value.length <= TRADE_PRICE_MAXIMUM_DIGITS && POSITIVE_INTEGER.test(value);
  if (!ok(numerator) || !ok(denominator)) return { valid: false };
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const divisor = gcd(n, d);
  return { valid: true, price: Object.freeze({ numerator: n / divisor, denominator: d / divisor }) };
}
