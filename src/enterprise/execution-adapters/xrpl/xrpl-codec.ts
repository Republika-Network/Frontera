import { createHash } from 'node:crypto';
import { canonicalDecimalScale, isCanonicalDecimal } from '../../../features/monetary-runtime/index.js';

/**
 * The XRPL rail grammar this adapter needs, and only that: classic addresses,
 * standard currency codes, issued-currency values and XRP drops.
 *
 * ## Why the address codec is implemented here rather than imported
 *
 * The authoritative codec is `ripple-address-codec`. Its current release pulls
 * `@xrplf/isomorphic`, which depends on `ws`: a WebSocket client would enter a
 * runtime whose third-party dependency set is `better-sqlite3` alone, to check
 * a checksum. What is implemented below is the codec's own algorithm, not a
 * pattern match — base58 over the XRPL alphabet, the account-id version byte
 * `0x00`, a 20-byte account id and a 4-byte double-SHA-256 checksum — and the
 * tests pin it against vectors produced by that library and against the
 * well-known genesis and special accounts.
 *
 * ## Exact text, never a number
 *
 * Amounts arrive as P9 canonical decimal text and leave as text. Every bound
 * is checked on digit strings or `BigInt`; nothing here converts an amount to
 * a JavaScript number.
 */

const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const ACCOUNT_ID_VERSION = 0x00;
const ACCOUNT_ID_LENGTH = 20;
const CHECKSUM_LENGTH = 4;
/** A classic address is 25 decoded bytes, which base58 spells in 25 to 35 characters. */
const CLASSIC_ADDRESS_MINIMUM_LENGTH = 25;
const CLASSIC_ADDRESS_MAXIMUM_LENGTH = 35;

/** XRPL issued-currency amounts carry 15 decimal digits of precision; more would be rounded by the ledger, so more is refused. */
export const XRPL_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS = 15;
/** The exponent range of a normalized issued-currency amount (16-digit mantissa). */
export const XRPL_ISSUED_MINIMUM_EXPONENT = -96;
export const XRPL_ISSUED_MAXIMUM_EXPONENT = 80;
/** Fractional digits of XRP a drop can express: 1 XRP = 1,000,000 drops. */
export const XRPL_DROPS_SCALE = 6;
/** The total XRP supply in drops (100 billion XRP); no Payment can deliver more. */
export const XRPL_MAXIMUM_DROPS = 100_000_000_000_000_000n;

const STANDARD_CURRENCY_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function decodeBase58(text: string): Uint8Array | undefined {
  let value = 0n;
  let leadingZeros = 0;
  let counting = true;
  for (const char of text) {
    const digit = XRPL_ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    if (counting && digit === 0) leadingZeros += 1;
    else counting = false;
    value = value * 58n + BigInt(digit);
  }
  const hex = value === 0n ? '' : value.toString(16);
  const body = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

/**
 * Whether `value` is an XRPL classic address (`r…`) whose checksum verifies.
 *
 * Exact and case-sensitive: nothing is trimmed or re-spelled, so a value that
 * passes is the address that will be sent. An X-address, a seed, a public key
 * or a classic address with a corrupted character is refused.
 */
export function isXrplClassicAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < CLASSIC_ADDRESS_MINIMUM_LENGTH || value.length > CLASSIC_ADDRESS_MAXIMUM_LENGTH) return false;
  const decoded = decodeBase58(value);
  if (decoded === undefined || decoded.length !== 1 + ACCOUNT_ID_LENGTH + CHECKSUM_LENGTH || decoded[0] !== ACCOUNT_ID_VERSION) return false;
  const payload = decoded.subarray(0, 1 + ACCOUNT_ID_LENGTH);
  const checksum = sha256(sha256(payload)).subarray(0, CHECKSUM_LENGTH);
  return checksum.every((byte, index) => byte === decoded[1 + ACCOUNT_ID_LENGTH + index]);
}

/** A standard three-character XRPL currency code. `XRP` is reserved for the native asset and is never an issued currency. */
export function isXrplStandardCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && STANDARD_CURRENCY_CODE.test(value) && value.toUpperCase() !== 'XRP';
}

/** The integer and fractional digit strings of a canonical decimal. */
function splitDecimal(canonical: string): { readonly integer: string; readonly fraction: string } {
  const point = canonical.indexOf('.');
  return point < 0 ? { integer: canonical, fraction: '' } : { integer: canonical.slice(0, point), fraction: canonical.slice(point + 1) };
}

/**
 * The issued-currency `value` for a canonical decimal, or `undefined` when the
 * ledger could not hold it exactly.
 *
 * Positive, at most 15 significant digits, and inside the normalized exponent
 * range. The text is returned unchanged: `"75000"` stays `"75000"`.
 */
export function xrplIssuedCurrencyValue(canonical: unknown): string | undefined {
  if (!isCanonicalDecimal(canonical) || canonical === '0') return undefined;
  const { integer, fraction } = splitDecimal(canonical);
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  const significant = digits.replace(/0+$/, '');
  if (significant.length === 0 || significant.length > XRPL_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS) return undefined;
  const trailingZeros = digits.length - significant.length;
  // value = significant × 10^(trailingZeros − scale); normalized to a 16-digit mantissa.
  const exponent = trailingZeros - canonicalDecimalScale(canonical) - (16 - significant.length);
  if (exponent < XRPL_ISSUED_MINIMUM_EXPONENT || exponent > XRPL_ISSUED_MAXIMUM_EXPONENT) return undefined;
  return canonical;
}

/**
 * The drops string for a canonical decimal quantity of XRP, or `undefined` when
 * it is zero, finer than one drop, or more than the XRP supply.
 *
 * Digit-string arithmetic: `"1"` → `"1000000"`, `"0.000001"` → `"1"`, and
 * `"0.0000001"` is refused rather than rounded.
 */
export function xrplDropsFromXrp(canonical: unknown): string | undefined {
  if (!isCanonicalDecimal(canonical) || canonical === '0') return undefined;
  const { integer, fraction } = splitDecimal(canonical);
  if (fraction.length > XRPL_DROPS_SCALE) return undefined;
  const drops = BigInt(`${integer}${fraction.padEnd(XRPL_DROPS_SCALE, '0')}`);
  if (drops <= 0n || drops > XRPL_MAXIMUM_DROPS) return undefined;
  return drops.toString();
}
