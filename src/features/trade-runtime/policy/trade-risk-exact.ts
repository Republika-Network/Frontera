import { createHash } from 'node:crypto';

import { isCanonicalDecimal } from '../../monetary-runtime/index.js';
import { canonicalTradeJson } from '../domain/trade-canonical.js';
import { parseTradeAmount, tradeAssetOf, tradeAssetToken, type TradeAsset, type TradeExactQuantity } from '../domain/trade-asset.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { isPlainRecord, snapshotTradeRecord } from '../domain/trade-grammar.js';
import { formatTradePrice, parseTradePriceAssertion, type TradePrice } from '../domain/trade-price.js';

/**
 * Exact arithmetic and strict readers for trading-risk policy (TRADE-03).
 *
 * Every quantity a risk control compares is an exact non-negative rational of
 * two `BigInt`s — a canonical decimal (`coefficient / 10^scale`), a TRADE-01
 * price (`quote / base`), or a product of the two. Nothing is ever a
 * JavaScript number, nothing is rounded, and a comparison at a configured
 * boundary is decided by cross-multiplication, so `0.1 + 0.2` against `0.3`
 * is equal and `0.30000000000000001` against `0.3` is above.
 *
 * The readers below accept configuration and trusted snapshots as untrusted
 * data: a closed record read once (no getters, symbols or prototype keys),
 * canonical decimal text (`"10.50"` is refused, never repaired), positive
 * integer rationals, and TRADE-01's asset grammar (an issued asset is its
 * currency **and** its issuer). Pure: no I/O, no clock, no randomness.
 */

/** A non-negative rational in lowest terms; `denominator > 0`. A `TradePrice` is a positive one. */
export interface TradeRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduced(numerator: bigint, denominator: bigint): TradeRational {
  if (denominator <= 0n || numerator < 0n) throw new RangeError('A risk rational is non-negative with a positive denominator.');
  if (numerator === 0n) return Object.freeze({ numerator: 0n, denominator: 1n });
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

export const ZERO_RATIONAL: TradeRational = Object.freeze({ numerator: 0n, denominator: 1n });

/** Basis points per unit (100% = 10 000 bps). */
export const TRADE_RISK_BASIS_POINTS = 10_000n;

export function rationalOfQuantity(quantity: TradeExactQuantity): TradeRational {
  return reduced(quantity.coefficient, 10n ** BigInt(quantity.scale));
}

/** A canonical non-negative decimal as an exact rational. Throws on anything else: callers parse first. */
export function rationalOfDecimal(canonical: string): TradeRational {
  if (!isCanonicalDecimal(canonical)) throw new RangeError('Not a canonical decimal.');
  const point = canonical.indexOf('.');
  if (point === -1) return reduced(BigInt(canonical), 1n);
  return reduced(BigInt(canonical.slice(0, point) + canonical.slice(point + 1)), 10n ** BigInt(canonical.length - point - 1));
}

export function addRationals(left: TradeRational, right: TradeRational): TradeRational {
  return reduced(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}

export function multiplyRationals(left: TradeRational, right: TradeRational): TradeRational {
  return reduced(left.numerator * right.numerator, left.denominator * right.denominator);
}

/** `-1`, `0` or `1`, exactly. */
export function compareRationals(left: TradeRational, right: TradeRational): -1 | 0 | 1 {
  const l = left.numerator * right.denominator;
  const r = right.numerator * left.denominator;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** `|limit − reference| / reference`, in basis points, exactly. The reference must be positive. */
export function deviationBasisPoints(limit: TradePrice, reference: TradePrice): TradeRational {
  if (reference.numerator <= 0n) throw new RangeError('A reference price is positive.');
  const crossLimit = limit.numerator * reference.denominator;
  const crossReference = reference.numerator * limit.denominator;
  const difference = crossLimit >= crossReference ? crossLimit - crossReference : crossReference - crossLimit;
  // (|Ln·Rd − Rn·Ld| / (Ld·Rd)) / (Rn/Rd) · 10⁴ = |Ln·Rd − Rn·Ld| · 10⁴ / (Rn·Ld)
  return reduced(difference * TRADE_RISK_BASIS_POINTS, reference.numerator * limit.denominator);
}

/** One spelling per value: `<numerator>/<denominator>` in lowest terms. */
export function formatTradeRational(value: TradeRational): string {
  return formatTradePrice(value);
}

// ── Strict readers ───────────────────────────────────────────────────────────

/** A closed record: exactly the required keys, optionally some optional ones, nothing else. `undefined` otherwise. */
export function closedRecord(raw: unknown, required: readonly string[], optional: readonly string[] = []): ReadonlyMap<string, unknown> | undefined {
  const snapshot = snapshotTradeRecord(raw, required.length + optional.length);
  if (!snapshot.ok) return undefined;
  for (const key of snapshot.entries.keys()) if (!required.includes(key) && !optional.includes(key)) return undefined;
  for (const key of required) if (!snapshot.entries.has(key)) return undefined;
  return snapshot.entries;
}

/** A list read once as data: a real array of at most `maximum` own data elements. */
export function plainList(raw: unknown, maximum: number): readonly unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length > maximum || Reflect.ownKeys(raw).length !== raw.length + 1) return undefined;
  const out: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, index);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    out.push(descriptor.value as unknown);
  }
  return out;
}

/** A configured limit: canonical, strictly positive decimal text. `"10.50"`, `"0"`, `"-1"`, `"1e3"` and numbers are refused. */
export function parsePositiveRiskDecimal(raw: unknown): string | undefined {
  if (!isCanonicalDecimal(raw) || raw === '0') return undefined;
  return raw;
}

/** A canonical non-negative decimal (a snapshot figure may be zero). */
export function parseRiskDecimal(raw: unknown): string | undefined {
  return isCanonicalDecimal(raw) ? raw : undefined;
}

/** `{ numerator, denominator }` as positive integer text, reduced; zero, negative, non-integer and empty denominators are refused. */
export function parseRiskPrice(raw: unknown): TradePrice | undefined {
  const parsed = parseTradePriceAssertion(raw);
  return parsed.valid ? parsed.price : undefined;
}

export function priceRecord(price: TradePrice): { readonly numerator: string; readonly denominator: string } {
  return Object.freeze({ numerator: price.numerator.toString(), denominator: price.denominator.toString() });
}

/** An asset named exactly: `{ currency: 'XRP' }`, or `{ currency, issuer }` in TRADE-01's grammar. */
export function parseRiskAsset(raw: unknown): TradeAsset | undefined {
  const snapshot = snapshotTradeRecord(raw, 2);
  if (!snapshot.ok) return undefined;
  if (snapshot.entries.get('currency') === 'XRP') return snapshot.entries.size === 1 ? Object.freeze({ kind: 'xrp' }) : undefined;
  if (snapshot.entries.size !== 2 || !snapshot.entries.has('issuer')) return undefined;
  // TRADE-01's amount grammar decides the asset; a nominal value makes it an amount to parse.
  const parsed = parseTradeAmount({ currency: snapshot.entries.get('currency'), issuer: snapshot.entries.get('issuer'), value: '1' }, 'asset');
  return parsed.valid ? tradeAssetOf(parsed.amount) : undefined;
}

/** The record form of an asset, the inverse of `parseRiskAsset`. */
export function assetRecord(asset: TradeAsset): { readonly currency: string; readonly issuer?: string } {
  return asset.kind === 'xrp' ? Object.freeze({ currency: 'XRP' }) : Object.freeze({ currency: asset.currency, issuer: asset.issuer });
}

export { tradeAssetToken };

export function isSafeIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}

/** Milliseconds from `from` to `to`; both must be TRADE instants. */
export function millisecondsBetween(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from);
}

/** Whether a reading observed at `observedAt` is within `maxAgeSeconds` at `at` (inclusive; the same rule as TRADE-02's reliance check). */
export type FreshnessVerdict = 'fresh' | 'stale' | 'future' | 'invalid';

export function freshnessAt(observedAt: unknown, maxAgeSeconds: number, at: string): FreshnessVerdict {
  if (!isTradeInstant(observedAt) || !isTradeInstant(at) || !isSafeIntegerIn(maxAgeSeconds, 1, 31_536_000)) return 'invalid';
  const age = millisecondsBetween(observedAt, at);
  if (age < 0) return 'future';
  return age > maxAgeSeconds * 1000 ? 'stale' : 'fresh';
}

// ── Digests ──────────────────────────────────────────────────────────────────

/** `sha256:<hex>` over a domain tag and the canonical JSON of `value`. An integrity primitive, never a signature. */
export function tradeRiskDigest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(`${domain}\n${canonicalTradeJson(value)}`).digest('hex')}`;
}

const MAXIMUM_DATA_DEPTH = 8;
const MAXIMUM_DATA_KEYS = 64;

/**
 * A bounded, getter-free deep copy of canonical JSON data (strings, booleans,
 * safe integers, arrays, plain records), or `undefined` for anything else. A
 * record received from elsewhere is copied once with this before any field of
 * it is trusted, so what is checked is what is used.
 */
export function plainRiskData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : undefined;
  if (depth >= MAXIMUM_DATA_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items = plainList(value, MAXIMUM_DATA_KEYS);
    if (items === undefined) return undefined;
    const out: unknown[] = [];
    for (const item of items) {
      const copied = plainRiskData(item, depth + 1);
      if (copied === undefined) return undefined;
      out.push(copied);
    }
    return out;
  }
  if (!isPlainRecord(value)) return undefined;
  const snapshot = snapshotTradeRecord(value, MAXIMUM_DATA_KEYS);
  if (!snapshot.ok) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of snapshot.entries) {
    const copied = plainRiskData(item, depth + 1);
    if (copied === undefined) return undefined;
    out[key] = copied;
  }
  return out;
}

/** Seals a record: the record plus `digest` over everything else. */
export function sealRiskRecord<T extends object>(domain: string, body: T): T & { readonly digest: string } {
  return Object.freeze({ ...body, digest: tradeRiskDigest(domain, body) });
}

/** Recomputes a sealed record's digest over a plain copy; the copy without `digest` when intact. */
export function unsealRiskRecord(domain: string, raw: unknown): Record<string, unknown> | undefined {
  const copy = plainRiskData(raw);
  if (!isPlainRecord(copy) || typeof copy['digest'] !== 'string') return undefined;
  const body: Record<string, unknown> = { ...copy };
  delete body['digest'];
  try {
    return tradeRiskDigest(domain, body) === copy['digest'] ? copy : undefined;
  } catch {
    return undefined;
  }
}
