import { canonicalizeDecimalText } from '../../monetary-runtime/index.js';
import { checkTradeAccountAddress, parseTradeCurrencyCode, snapshotTradeRecord, type TradeNetwork } from './trade-grammar.js';

/**
 * Assets and amounts of an XRP Ledger OfferCreate, exactly (TRADE-01).
 *
 * ## Two assets, two amount forms, no number
 *
 * | asset | wire / canonical form | unit |
 * | --- | --- | --- |
 * | XRP (native) | `{ currency: 'XRP', drops: '<positive integer>' }` | drops, 1 XRP = 1 000 000 drops |
 * | issued | `{ currency, issuer, value: '<canonical decimal>' }` | the issuer's unit |
 *
 * A quantity is text from the boundary on and every computation over it is
 * `BigInt` coefficient/scale arithmetic. A JavaScript number is refused, never
 * re-spelled: its precision was decided by whoever parsed it.
 *
 * ## Exactly representable on the ledger, or refused
 *
 * The ledger stores an issued value as a 16-digit mantissa with an exponent in
 * −96…80 and **rounds** anything else. A rounded amount is a different amount
 * than the one authorized, so an issued value with more than 16 significant
 * digits, or outside that range, is refused here — never rounded. XRP is a
 * whole number of drops, at most 10^17 (the total supply).
 *
 * ## One spelling per quantity
 *
 * The only normalization is P9's: trailing fractional zeros are dropped
 * (`"10.50"` → `"10.5"`). Leading zeros, signs, exponents, whitespace and
 * locale separators are refused. A 40-digit currency code is upper-cased.
 * Equal amounts therefore have equal canonical text, and different amounts
 * never do.
 */

export interface TradeXrpAmount {
  readonly currency: 'XRP';
  readonly drops: string;
}

export interface TradeIssuedAmount {
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
}

export type TradeAmount = TradeXrpAmount | TradeIssuedAmount;

export type TradeAsset = { readonly kind: 'xrp' } | { readonly kind: 'issued'; readonly currency: string; readonly issuer: string };

/** Drops per XRP. */
export const TRADE_DROPS_PER_XRP_SCALE = 6;
/** The largest XRP amount, in drops: the total supply. */
export const TRADE_MAXIMUM_DROPS = 10n ** 17n;
/** Significant digits the ledger stores for an issued value. */
export const TRADE_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS = 16;
/** The ledger's exponent range for a normalized issued value (mantissa in 10^15…10^16−1). */
export const TRADE_ISSUED_MINIMUM_EXPONENT = -96;
export const TRADE_ISSUED_MAXIMUM_EXPONENT = 80;

export const TRADE_AMOUNT_VIOLATIONS = {
  AMOUNT_MALFORMED: 'AMOUNT_MALFORMED',
  AMOUNT_NOT_TEXT: 'AMOUNT_NOT_TEXT',
  AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
  AMOUNT_EXPONENT_NOT_ACCEPTED: 'AMOUNT_EXPONENT_NOT_ACCEPTED',
  AMOUNT_PRECISION_EXCEEDED: 'AMOUNT_PRECISION_EXCEEDED',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  CURRENCY_MALFORMED: 'CURRENCY_MALFORMED',
  ISSUER_MISSING: 'ISSUER_MISSING',
  ISSUER_MALFORMED: 'ISSUER_MALFORMED',
  ISSUER_RESERVED: 'ISSUER_RESERVED',
  ISSUER_NOT_ALLOWED_FOR_XRP: 'ISSUER_NOT_ALLOWED_FOR_XRP',
  AMOUNT_FIELDS_INVALID: 'AMOUNT_FIELDS_INVALID',
} as const;

export type TradeAmountViolation = (typeof TRADE_AMOUNT_VIOLATIONS)[keyof typeof TRADE_AMOUNT_VIOLATIONS];

export type TradeAmountParse = { readonly valid: true; readonly amount: TradeAmount } | { readonly valid: false; readonly violation: TradeAmountViolation; readonly field: string };

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const PLAIN_DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;
/** Text longer than this is refused before it is inspected. */
const AMOUNT_TEXT_MAXIMUM_LENGTH = 256;

/** Refusal codes for text that is not a plain positive decimal, most specific first. */
function refuseQuantityText(value: unknown): TradeAmountViolation | undefined {
  if (typeof value !== 'string') return TRADE_AMOUNT_VIOLATIONS.AMOUNT_NOT_TEXT;
  if (value.length === 0 || value.length > AMOUNT_TEXT_MAXIMUM_LENGTH) return TRADE_AMOUNT_VIOLATIONS.AMOUNT_MALFORMED;
  if (value.startsWith('-')) return TRADE_AMOUNT_VIOLATIONS.AMOUNT_NOT_POSITIVE;
  if (/[eE]/.test(value)) return TRADE_AMOUNT_VIOLATIONS.AMOUNT_EXPONENT_NOT_ACCEPTED;
  return undefined;
}

/** Significant digits and normalized exponent of a positive canonical decimal (`m × 10^e`, `10^15 ≤ m < 10^16`). */
function issuedShape(canonical: string): { readonly significantDigits: number; readonly exponent: number } {
  const point = canonical.indexOf('.');
  const integer = point === -1 ? canonical : canonical.slice(0, point);
  const fraction = point === -1 ? '' : canonical.slice(point + 1);
  const digits = (integer + fraction).replace(/^0+/, '');
  const significant = digits.replace(/0+$/, '');
  // value = significant × 10^power
  const power = digits.length - significant.length - fraction.length;
  return { significantDigits: significant.length, exponent: power - (TRADE_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS - significant.length) };
}

function parseIssuedValue(raw: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly violation: TradeAmountViolation } {
  const early = refuseQuantityText(raw);
  if (early !== undefined) return { ok: false, violation: early };
  const canonical = canonicalizeDecimalText(raw);
  if (canonical === undefined) return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_MALFORMED };
  if (canonical === '0') return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_NOT_POSITIVE };
  const shape = issuedShape(canonical);
  if (shape.significantDigits > TRADE_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS) return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_PRECISION_EXCEEDED };
  if (shape.exponent < TRADE_ISSUED_MINIMUM_EXPONENT || shape.exponent > TRADE_ISSUED_MAXIMUM_EXPONENT) return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_OUT_OF_RANGE };
  return { ok: true, value: canonical };
}

function parseDrops(raw: unknown): { readonly ok: true; readonly drops: string } | { readonly ok: false; readonly violation: TradeAmountViolation } {
  const early = refuseQuantityText(raw);
  if (early !== undefined) return { ok: false, violation: early };
  const text = raw as string;
  if (POSITIVE_INTEGER.test(text)) {
    return BigInt(text) <= TRADE_MAXIMUM_DROPS ? { ok: true, drops: text } : { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_OUT_OF_RANGE };
  }
  if (/^0+$/.test(text)) return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_NOT_POSITIVE };
  // A fraction of a drop does not exist; a plain decimal with a fractional part is more precision than the unit has.
  if (PLAIN_DECIMAL.test(text) && text.includes('.')) return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_PRECISION_EXCEEDED };
  return { ok: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_MALFORMED };
}

/**
 * Parses one OfferCreate amount from untrusted data into its canonical form.
 * Closed: XRP carries exactly `currency` and `drops`; an issued amount exactly
 * `currency`, `issuer` and `value`.
 */
export function parseTradeAmount(raw: unknown, field: string): TradeAmountParse {
  const snapshot = snapshotTradeRecord(raw, 8);
  if (!snapshot.ok) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_FIELDS_INVALID, field };
  const entries = snapshot.entries;
  const currency = entries.get('currency');
  if (currency === 'XRP') {
    if (entries.has('issuer')) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.ISSUER_NOT_ALLOWED_FOR_XRP, field: `${field}.issuer` };
    if (entries.size !== 2 || !entries.has('drops')) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_FIELDS_INVALID, field };
    const drops = parseDrops(entries.get('drops'));
    return drops.ok ? { valid: true, amount: Object.freeze({ currency: 'XRP', drops: drops.drops }) } : { valid: false, violation: drops.violation, field: `${field}.drops` };
  }
  const code = parseTradeCurrencyCode(currency);
  if (!code.valid) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.CURRENCY_MALFORMED, field: `${field}.currency` };
  if (!entries.has('issuer')) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.ISSUER_MISSING, field: `${field}.issuer` };
  if (entries.size !== 3 || !entries.has('value')) return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.AMOUNT_FIELDS_INVALID, field };
  const issuer = entries.get('issuer');
  const issuerCheck = checkTradeAccountAddress(issuer);
  if (issuerCheck === 'reserved') return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.ISSUER_RESERVED, field: `${field}.issuer` };
  if (issuerCheck !== 'valid') return { valid: false, violation: TRADE_AMOUNT_VIOLATIONS.ISSUER_MALFORMED, field: `${field}.issuer` };
  const value = parseIssuedValue(entries.get('value'));
  if (!value.ok) return { valid: false, violation: value.violation, field: `${field}.value` };
  return { valid: true, amount: Object.freeze({ currency: code.currency, issuer: issuer as string, value: value.value }) };
}

export function isTradeXrpAmount(amount: TradeAmount): amount is TradeXrpAmount {
  return amount.currency === 'XRP' && 'drops' in amount;
}

export function tradeAssetOf(amount: TradeAmount): TradeAsset {
  return isTradeXrpAmount(amount) ? Object.freeze({ kind: 'xrp' }) : Object.freeze({ kind: 'issued', currency: amount.currency, issuer: amount.issuer });
}

export function tradeAssetsEqual(left: TradeAsset, right: TradeAsset): boolean {
  if (left.kind === 'xrp' || right.kind === 'xrp') return left.kind === right.kind;
  return left.currency === right.currency && left.issuer === right.issuer;
}

/**
 * The asset as a governed token: `XRP`, or `<currency>.<issuer>`. Injective
 * (a currency code never contains `.`), within the token grammar, and the key
 * the canonical pair orientation is ordered by.
 */
export function tradeAssetToken(asset: TradeAsset): string {
  return asset.kind === 'xrp' ? 'XRP' : `${asset.currency}.${asset.issuer}`;
}

/**
 * The asset's identifier for the host's P9 asset registry, scoped to its
 * network: `<network>:XRP` or `<network>:<currency>/<issuer>`. A Testnet asset
 * and a Devnet asset are different assets, so a ceiling on one is never a
 * ceiling on the other. The registry — trusted host configuration — says
 * whether the asset is recognized and at what scale; nothing here does.
 */
export function tradeMonetaryAssetId(network: TradeNetwork, asset: TradeAsset): string {
  return asset.kind === 'xrp' ? `${network}:XRP` : `${network}:${asset.currency}/${asset.issuer}`;
}

/** An exact non-negative decimal as a `BigInt` coefficient and a scale: `value = coefficient × 10^−scale`. */
export interface TradeExactQuantity {
  readonly coefficient: bigint;
  readonly scale: number;
}

/** The amount in its asset's unit, exactly — XRP in XRP (drops at scale 6), an issued value as stated. */
export function tradeExactQuantity(amount: TradeAmount): TradeExactQuantity {
  if (isTradeXrpAmount(amount)) return { coefficient: BigInt(amount.drops), scale: TRADE_DROPS_PER_XRP_SCALE };
  const point = amount.value.indexOf('.');
  if (point === -1) return { coefficient: BigInt(amount.value), scale: 0 };
  return { coefficient: BigInt(amount.value.slice(0, point) + amount.value.slice(point + 1)), scale: amount.value.length - point - 1 };
}

/** Canonical decimal text of an exact quantity (no trailing fractional zero, no leading zero). */
export function formatTradeExactQuantity(quantity: TradeExactQuantity): string {
  let { coefficient, scale } = quantity;
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

/** The amount as canonical decimal text in its asset's unit — XRP as XRP, never as drops. What the governed envelope's `amount.value` carries. */
export function tradeDecimalQuantity(amount: TradeAmount): string {
  return formatTradeExactQuantity(tradeExactQuantity(amount));
}
