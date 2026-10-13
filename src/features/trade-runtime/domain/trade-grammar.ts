import { createHash } from 'crypto';

import { isRecordableProviderRef } from '../../execution-runtime/index.js';
import { isGovernedParameterToken } from '../../governed-parameter-runtime/index.js';

/**
 * The grammars a governed trading proposal is held to (TRADE-01).
 *
 * Everything a proposal names — an identity, an XRP Ledger account, a
 * currency — is checked against one exact grammar here and refused, never
 * repaired, when it does not fit. Pure: no I/O, no clock, no randomness and
 * no network. The one hash used (`createHash`) is the base58check checksum of
 * a classic account address; nothing here signs, derives a key or holds one.
 */

/**
 * The ledgers a TRADE-01 proposal may target. XRP Ledger Testnet and Devnet
 * only, each with the network id its `server_info` reports. Mainnet is not
 * representable: a proposal that names it is refused, so a Testnet
 * demonstration configuration cannot be pointed at real funds through this
 * contract (SEC-TRADE-09).
 */
export const TRADE_NETWORKS = Object.freeze({
  'xrp-ledger-testnet': Object.freeze({ networkId: 1 }),
  'xrp-ledger-devnet': Object.freeze({ networkId: 2 }),
} as const);

export type TradeNetwork = keyof typeof TRADE_NETWORKS;

export function isTradeNetwork(value: unknown): value is TradeNetwork {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRADE_NETWORKS, value);
}

/** An identity a proposal carries (organization, principal, request, idempotency key): a governed token that is never credential-shaped. */
export function isTradeIdentifier(value: unknown): value is string {
  return isGovernedParameterToken(value) && isRecordableProviderRef(value);
}

/** An opaque reference the applicant states (a policy-context or market-snapshot reference). The same grammar as an identifier; it is a reference, never a fact. */
export const isTradeReference = isTradeIdentifier;

// ── Classic account addresses ────────────────────────────────────────────────

/** The XRP Ledger's base58 alphabet. */
const BASE58_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const BASE58_INDEX: ReadonlyMap<string, bigint> = new Map([...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)]));

/** Version byte (0x00), 20-byte account id, 4-byte checksum. */
const ACCOUNT_ADDRESS_BYTES = 25;
const ACCOUNT_ADDRESS_MINIMUM_LENGTH = 25;
const ACCOUNT_ADDRESS_MAXIMUM_LENGTH = 35;

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/** The 25 decoded bytes of a base58 string, or `undefined` when it is not exactly 25 bytes of the alphabet. Leading `r` (the zero digit) encodes leading zero bytes. */
function decodeBase58(text: string): Uint8Array | undefined {
  let value = 0n;
  let leadingZeros = 0;
  let counting = true;
  for (const character of text) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return undefined;
    if (counting && digit === 0n) leadingZeros += 1;
    else counting = false;
    value = value * 58n + digit;
  }
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value % 256n));
    value /= 256n;
  }
  if (leadingZeros + body.length !== ACCOUNT_ADDRESS_BYTES) return undefined;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

export type TradeAccountCheck = 'valid' | 'malformed' | 'reserved';

/**
 * Whether `value` is a classic XRP Ledger account address: base58 over the
 * ledger's alphabet, version byte `0x00`, a 20-byte account id and a correct
 * double-SHA-256 checksum. An X-address (which also encodes a tag) is
 * malformed here. The two special accounts whose ids are 0 and 1 (no key
 * controls either) are `reserved`: an owner, delegate or issuer that is one of
 * them is a mistake, never a configuration.
 */
export function checkTradeAccountAddress(value: unknown): TradeAccountCheck {
  if (typeof value !== 'string' || value.length < ACCOUNT_ADDRESS_MINIMUM_LENGTH || value.length > ACCOUNT_ADDRESS_MAXIMUM_LENGTH) return 'malformed';
  const bytes = decodeBase58(value);
  if (bytes === undefined || bytes[0] !== 0) return 'malformed';
  const checksum = sha256(sha256(bytes.subarray(0, 21)));
  for (let index = 0; index < 4; index += 1) if (checksum[index] !== bytes[21 + index]) return 'malformed';
  const accountId = bytes.subarray(1, 21);
  const highBytesZero = accountId.subarray(0, 19).every((byte) => byte === 0);
  if (highBytesZero && (accountId[19] === 0 || accountId[19] === 1)) return 'reserved';
  return 'valid';
}

export function isTradeAccountAddress(value: unknown): value is string {
  return checkTradeAccountAddress(value) === 'valid';
}

/**
 * The 20-byte account id a valid classic address encodes, as a fresh copy, or
 * `undefined` for anything `checkTradeAccountAddress` does not call `valid`
 * (reserved accounts included). Ledger keys are computed over these bytes.
 */
export function tradeAccountIdOf(value: unknown): Uint8Array | undefined {
  if (checkTradeAccountAddress(value) !== 'valid') return undefined;
  const bytes = decodeBase58(value as string);
  return bytes === undefined ? undefined : Uint8Array.from(bytes.subarray(1, 21));
}

// ── Currency codes ───────────────────────────────────────────────────────────

/** A three-character currency code. Deliberately narrower than the ledger: ASCII letters and digits only, so every accepted code is also a governed token. Case-sensitive, as on the ledger. */
const STANDARD_CURRENCY = /^[A-Za-z0-9]{3}$/;
/** A 160-bit nonstandard currency code, as 40 hexadecimal digits. */
const HEX_CURRENCY = /^[0-9A-Fa-f]{40}$/;

export type TradeCurrencyParse = { readonly valid: true; readonly currency: string } | { readonly valid: false };

/**
 * The canonical spelling of an issued currency code, or a refusal.
 *
 * - A three-character code is kept exactly (the ledger treats `USD` and `usd`
 *   as different currencies). `XRP` in any case is refused: the native asset
 *   is never an issued currency, and a look-alike issued `xrp` is exactly the
 *   confusion an authorization must not admit.
 * - A 40-digit code is upper-cased (one value, one spelling). One whose first
 *   byte is `00` is refused: that prefix is the ledger's encoding of a
 *   three-character code (or, all zero, of XRP), so admitting it would give one
 *   currency two spellings.
 */
export function parseTradeCurrencyCode(value: unknown): TradeCurrencyParse {
  if (typeof value !== 'string') return { valid: false };
  if (STANDARD_CURRENCY.test(value)) return value.toUpperCase() === 'XRP' ? { valid: false } : { valid: true, currency: value };
  if (HEX_CURRENCY.test(value)) {
    const currency = value.toUpperCase();
    return currency.startsWith('00') ? { valid: false } : { valid: true, currency };
  }
  return { valid: false };
}

// ── Closed records ───────────────────────────────────────────────────────────

/** Keys that must never be treated as data properties of a contract, whatever the closed schema says. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isDangerousPropertyName(name: string): boolean {
  return DANGEROUS_KEYS.has(name);
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Property names that announce secret material. The value is never read. */
const SECRET_PROPERTY = /(secret|password|passphrase|private_?key|privatekey|signing_?key|mnemonic|seed|credential|bearer|api_?key)/i;

export function isSecretShapedPropertyName(name: string): boolean {
  return SECRET_PROPERTY.test(name);
}

/** A property name safe to repeat in a violation: short and printable. Anything else is reported as `<property>`. */
export function reportablePropertyName(name: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : '<property>';
}

/** Why an object could not be read as a closed record. */
export type TradeRecordRefusal = 'NOT_AN_OBJECT' | 'TOO_MANY_PROPERTIES' | 'SYMBOL_PROPERTY' | 'DANGEROUS_PROPERTY' | 'ACCESSOR_PROPERTY';

export type TradeRecordSnapshot =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, unknown> }
  | { readonly ok: false; readonly refusal: TradeRecordRefusal; readonly property?: string };

/**
 * The own properties of a plain record, read **once** as data.
 *
 * Refused, never run or skipped: a non-plain object (class instance, array,
 * proxy-free exotic), a symbol key, `__proto__` / `constructor` / `prototype`
 * as an own key (which `JSON.parse` can produce), and an accessor or
 * non-enumerable property — a getter could answer differently on each read.
 * Which keys are *declared* is the caller's closed schema; this only makes
 * sure every value it then inspects is a value the caller actually stated.
 */
export function snapshotTradeRecord(raw: unknown, maximumProperties: number): TradeRecordSnapshot {
  if (!isPlainRecord(raw)) return { ok: false, refusal: 'NOT_AN_OBJECT' };
  const keys = Reflect.ownKeys(raw);
  if (keys.length > maximumProperties) return { ok: false, refusal: 'TOO_MANY_PROPERTIES' };
  const entries = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== 'string') return { ok: false, refusal: 'SYMBOL_PROPERTY' };
    if (isDangerousPropertyName(key)) return { ok: false, refusal: 'DANGEROUS_PROPERTY', property: key };
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return { ok: false, refusal: 'ACCESSOR_PROPERTY', property: reportablePropertyName(key) };
    entries.set(key, descriptor.value as unknown);
  }
  return { ok: true, entries };
}
