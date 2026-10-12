/**
 * Bech32 (BIP-0173) decoding for BOLT11 invoices (PAY-06).
 *
 * A checksum encoding, not cryptography: a human-readable part, the separator
 * `1`, 5-bit data words in the 32-character alphabet, and a 6-word BCH
 * checksum over both. BOLT11 uses the original Bech32 constant (`1`, not
 * Bech32m's) and lifts BIP-0173's 90-character limit; this module replaces
 * that limit with the caller's own bound, so hostile input is refused before
 * any work proportional to it is done.
 *
 * Strict in the ways BIP-0173 requires and no further: mixed case is refused
 * (one case only — an uppercase invoice is read as its lowercase spelling),
 * every character must be printable US-ASCII, the separator is the **last**
 * `1`, the human-readable part is non-empty, and the checksum must verify.
 * Nothing is repaired; a single wrong character is a refusal.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;
const CHECKSUM_WORDS = 6;

/** The alphabet's reverse map, built once: a character outside it is `-1`. */
const WORD_OF = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < CHARSET.length; index += 1) table[CHARSET.charCodeAt(index)] = index;
  return table;
})();

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if (((top >>> bit) & 1) === 1) checksum ^= GENERATORS[bit] ?? 0;
  }
  return checksum;
}

function expandedPrefix(prefix: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < prefix.length; index += 1) out.push(prefix.charCodeAt(index) >>> 5);
  out.push(0);
  for (let index = 0; index < prefix.length; index += 1) out.push(prefix.charCodeAt(index) & 31);
  return out;
}

export interface Bech32Decoding {
  /** The human-readable part, lowercase. */
  readonly prefix: string;
  /** The data words (each 0–31), checksum removed. */
  readonly words: readonly number[];
  /** The whole string as read: lowercase. */
  readonly canonical: string;
}

/**
 * Decodes one Bech32 string of at most `maximumLength` characters, or answers
 * `undefined`. Total: never throws.
 */
export function decodeBech32(text: unknown, maximumLength: number): Bech32Decoding | undefined {
  if (typeof text !== 'string' || text.length < 8 || text.length > maximumLength) return undefined;
  let hasLower = false;
  let hasUpper = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 33 || code > 126) return undefined;
    if (code >= 97 && code <= 122) hasLower = true;
    if (code >= 65 && code <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) return undefined;
  const canonical = text.toLowerCase();
  const separator = canonical.lastIndexOf('1');
  if (separator < 1 || canonical.length - separator - 1 < CHECKSUM_WORDS) return undefined;
  const prefix = canonical.slice(0, separator);
  const words: number[] = [];
  for (let index = separator + 1; index < canonical.length; index += 1) {
    const word = WORD_OF[canonical.charCodeAt(index)] ?? -1;
    if (word < 0) return undefined;
    words.push(word);
  }
  if (polymod([...expandedPrefix(prefix), ...words]) !== 1) return undefined;
  return Object.freeze({ prefix, words: Object.freeze(words.slice(0, words.length - CHECKSUM_WORDS)), canonical });
}

/**
 * 5-bit words → bytes. `padding: 'allowed'` (a tagged field's data) admits up
 * to 4 trailing zero bits and drops them; `padding: 'forbidden'` (none
 * expected) refuses any leftover. Non-zero leftover bits are always refused.
 */
export function wordsToBytes(words: readonly number[], padding: 'allowed' | 'forbidden'): Uint8Array | undefined {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) return undefined;
    accumulator = ((accumulator << 5) | word) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits > 0) {
    if (padding === 'forbidden' || bits >= 5) return undefined;
    if ((accumulator & ((1 << bits) - 1)) !== 0) return undefined;
  }
  return Uint8Array.from(out);
}

/** 5-bit words → bytes for the signed message: zero bits appended to a byte boundary (BOLT11 "Data Part"). */
export function wordsToPaddedBytes(words: readonly number[]): Uint8Array {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  for (const word of words) {
    accumulator = ((accumulator << 5) | (word & 31)) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits > 0) out.push((accumulator << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

/** Big-endian unsigned integer of up to 52 bits from 5-bit words (a timestamp, an expiry, a CLTV delta). */
export function wordsToSafeInteger(words: readonly number[]): number | undefined {
  if (words.length > 10) return undefined;
  let value = 0;
  for (const word of words) value = value * 32 + word;
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Test-only inverse, so fixtures can build invoices word by word. */
export function encodeBech32(prefix: string, words: readonly number[]): string {
  const values = [...expandedPrefix(prefix), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let index = 0; index < CHECKSUM_WORDS; index += 1) checksum.push((mod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((word) => CHARSET[word]).join('')}`;
}

/** Test-only: bytes → 5-bit words, zero-padded. */
export function bytesToWords(bytes: Uint8Array): number[] {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((accumulator << (5 - bits)) & 31);
  return out;
}
