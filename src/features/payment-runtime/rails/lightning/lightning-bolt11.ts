import { decodeBech32, wordsToBytes, wordsToPaddedBytes, wordsToSafeInteger } from './lightning-bech32.js';
import { msatOfBolt11Amount } from './lightning-amount.js';
import { verifyBolt11Signature } from './lightning-signature.js';

/**
 * A strict, closed BOLT11 decoder (PAY-06).
 *
 * > **An invoice is hostile input.** It is merchant-controlled text that
 * > reaches Frontera from outside; the decoder answers either one frozen,
 * > fully verified reading of it or a closed refusal — never a partial,
 * > repaired or prototype-shaped object.
 *
 * ## Baseline (pinned)
 *
 * BOLT #11 at `lightning/bolts` commit
 * `14901bdcacee53d95b46dc276b0f09c85d7d71fd` (2026-03-09, "add new test vector
 * for signature (high-S) with 'n' field defined"), and BOLT #9's feature
 * table at the same commit. Behaviour is pinned by the spec's own test
 * vectors (`tests/lightning-bolt11.test.ts`). Not implemented: BOLT12 offers,
 * LNURL, any other encoding.
 *
 * ## What is checked
 *
 * | part | rule |
 * | --- | --- |
 * | encoding | Bech32 (BIP-0173) checksum, one case, at most `maximumLength` characters |
 * | prefix | `lnbc` mainnet · `lntb` testnet · `lntbs` signet · `lnbcrt` regtest — anything else refused |
 * | amount | digits, no leading zero, optional `m`/`u`/`n`/`p`; `p` must end in `0` (no sub-millisatoshi); exact `BigInt` |
 * | timestamp | 35 bits |
 * | `p`, `s`, `h`, `n` | exactly the fixed `data_length` (52, 52, 52, 53) — otherwise refused |
 * | `p`, `s` | exactly one each |
 * | `d` / `h` | exactly one of them; `d` valid UTF-8 (fatal decoding) |
 * | `x`, `c`, `9` | minimal encoding (no leading zero word) |
 * | `9` | an unknown **even** (required) bit refused; unknown odd bits ignored; `basic_mpp` needs `payment_secret` |
 * | `r` | whole 51-byte hops, each a compressed node key — malformed refused (never interpreted further) |
 * | `f` | counted; unknown versions skipped |
 * | duplicates | `p`, `s`, `d`, `h`, `n`, `x`, `c`, `9`, `m` at most once; `r`, `f` bounded |
 * | signature | compact secp256k1 over SHA-256(hrp ‖ data); with `n`: verified under it, low-S required; without: the payee **recovered** with its recovery id |
 *
 * ## What is not read
 *
 * The description text, the description hash's value, route-hint contents,
 * fallback addresses, the payment secret and metadata are never returned:
 * none of them is payment authority, identity or evidence, and the node reads
 * them from the invoice itself.
 */

export const LIGHTNING_NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'] as const;
export type LightningNetwork = (typeof LIGHTNING_NETWORKS)[number];

/** The BIP-0173 currency prefix of each network, as BOLT11 spells it after `ln`. */
export const LIGHTNING_INVOICE_PREFIXES: Readonly<Record<LightningNetwork, string>> = Object.freeze({ mainnet: 'lnbc', testnet: 'lntb', signet: 'lntbs', regtest: 'lnbcrt' });

/** A real invoice is a few hundred characters; several route hints reach about 1 500. LND's own decoder stops at 7 089. */
export const BOLT11_ABSOLUTE_MAXIMUM_LENGTH = 7089;

/** BOLT11 defaults when the field is absent. */
export const BOLT11_DEFAULT_EXPIRY_SECONDS = 3600;
export const BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY_DELTA = 18;

/**
 * Required (even) feature bits this adapter can honour in an invoice —
 * `var_onion_optin` (8), `payment_secret` (14), `basic_mpp` (16) and
 * `option_payment_metadata` (48): the invoice-context features BOLT 9 defines
 * that the reference node (LND) implements when sending. Any other required
 * bit — `option_route_blinding` (24) and `option_attribution_data` (36)
 * included — is refused: the adapter does not silently ignore mandatory
 * behaviour it cannot vouch for.
 */
export const BOLT11_SUPPORTED_REQUIRED_FEATURES: readonly number[] = Object.freeze([8, 14, 16, 48]);

const MAXIMUM_ROUTE_HINT_FIELDS = 8;
const MAXIMUM_FALLBACK_FIELDS = 4;
const MAXIMUM_UNKNOWN_FIELDS = 8;
const ROUTE_HINT_HOP_BYTES = 51;
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;

export const BOLT11_REFUSALS = [
  'bolt11-oversized',
  'bolt11-encoding-invalid',
  'bolt11-network-unknown',
  'bolt11-amount-invalid',
  'bolt11-structure-invalid',
  'bolt11-field-length-invalid',
  'bolt11-field-duplicated',
  'bolt11-field-non-minimal',
  'bolt11-payment-hash-missing',
  'bolt11-payment-secret-missing',
  'bolt11-description-invalid',
  'bolt11-feature-unsupported',
  'bolt11-feature-dependency-missing',
  'bolt11-route-hint-invalid',
  'bolt11-signature-invalid',
  'bolt11-signature-high-s',
] as const;
export type Bolt11Refusal = (typeof BOLT11_REFUSALS)[number];

/** One verified invoice — closed, frozen, bounded, secret-free. */
export interface Bolt11Invoice {
  /** The invoice as read: lowercase Bech32. Its digest is the invoice's identity. */
  readonly canonical: string;
  readonly network: LightningNetwork;
  /** Absent for an amountless invoice. Exact millisatoshis. */
  readonly amountMsat?: bigint;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly expirySeconds: number;
  /** 32 bytes, lowercase hex. */
  readonly paymentHash: string;
  /** The payee node: 33-byte compressed key, lowercase hex — from `n` or recovered from the signature. */
  readonly payee: string;
  readonly payeeSource: 'n-field' | 'recovered';
  readonly minFinalCltvExpiryDelta: number;
  /** Required (even) feature bits set — every one in `BOLT11_SUPPORTED_REQUIRED_FEATURES`. */
  readonly requiredFeatures: readonly number[];
  readonly routeHintCount: number;
  readonly fallbackCount: number;
}

export type Bolt11Decoding = { readonly valid: true; readonly invoice: Bolt11Invoice } | { readonly valid: false; readonly refusal: Bolt11Refusal };

const TAG = Object.freeze({ p: 1, r: 3, '9': 5, x: 6, f: 9, d: 13, s: 16, n: 19, h: 23, c: 24, m: 27 });
const SINGLE_TAGS = new Set<number>([TAG.p, TAG.s, TAG.d, TAG.h, TAG.n, TAG.x, TAG.c, TAG['9'], TAG.m]);
const FIXED_LENGTH: ReadonlyMap<number, number> = new Map([
  [TAG.p, 52],
  [TAG.s, 52],
  [TAG.h, 52],
  [TAG.n, 53],
]);

class Refused {
  constructor(readonly refusal: Bolt11Refusal) {}
}

const refuse = (refusal: Bolt11Refusal): never => {
  throw new Refused(refusal);
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function readPrefix(prefix: string): { readonly network: LightningNetwork; readonly amountMsat?: bigint } {
  // Longest currency first: `lnbcrt` before `lnbc`, `lntbs` before `lntb`. An amount always starts with a digit.
  const match = /^ln(bcrt|bc|tbs|tb)([0-9a-z]*)$/.exec(prefix);
  if (match === null) return refuse('bolt11-network-unknown');
  const network: LightningNetwork = match[1] === 'bc' ? 'mainnet' : match[1] === 'tb' ? 'testnet' : match[1] === 'tbs' ? 'signet' : 'regtest';
  const amount = match[2] ?? '';
  if (amount.length === 0) return { network };
  const amountMsat = msatOfBolt11Amount(amount);
  if (amountMsat === undefined) return refuse('bolt11-amount-invalid');
  return { network, amountMsat };
}

/** The feature bits set in a big-endian field of 5-bit words, least-significant bit = 0. */
function featureBits(words: readonly number[]): number[] {
  const bits: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[words.length - 1 - index] ?? 0;
    for (let bit = 0; bit < 5; bit += 1) if (((word >>> bit) & 1) === 1) bits.push(index * 5 + bit);
  }
  return bits;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

interface Parsed {
  readonly invoice: Omit<Bolt11Invoice, 'payee' | 'payeeSource'>;
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
  readonly explicitPayee?: Uint8Array;
}

/** Everything but the signature check: pure, synchronous, total (refusals are thrown as `Refused` and caught by the caller). */
function parse(text: string, maximumLength: number): Parsed {
  if (text.length > maximumLength) refuse('bolt11-oversized');
  const decoded = decodeBech32(text, maximumLength);
  if (decoded === undefined) return refuse('bolt11-encoding-invalid');
  const { network, amountMsat } = readPrefix(decoded.prefix);
  const words = decoded.words;
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) refuse('bolt11-structure-invalid');
  const dataWords = words.slice(0, words.length - SIGNATURE_WORDS);
  const signature = wordsToBytes(words.slice(words.length - SIGNATURE_WORDS), 'allowed');
  if (signature === undefined || signature.length !== 65) return refuse('bolt11-structure-invalid');
  const timestamp = wordsToSafeInteger(dataWords.slice(0, TIMESTAMP_WORDS));
  if (timestamp === undefined) return refuse('bolt11-structure-invalid');

  const seen = new Set<number>();
  let paymentHash: string | undefined;
  let paymentSecret = false;
  let description = 0;
  let explicitPayee: Uint8Array | undefined;
  let expirySeconds = BOLT11_DEFAULT_EXPIRY_SECONDS;
  let minFinalCltvExpiryDelta = BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY_DELTA;
  let requiredFeatures: number[] = [];
  let routeHintCount = 0;
  let routeHintFields = 0;
  let fallbackCount = 0;
  let unknownFields = 0;

  let position = TIMESTAMP_WORDS;
  while (position < dataWords.length) {
    if (position + 3 > dataWords.length) refuse('bolt11-structure-invalid');
    const tag = dataWords[position] ?? 0;
    const length = (dataWords[position + 1] ?? 0) * 32 + (dataWords[position + 2] ?? 0);
    const start = position + 3;
    const end = start + length;
    if (end > dataWords.length) refuse('bolt11-structure-invalid');
    const field = dataWords.slice(start, end);
    position = end;

    if (SINGLE_TAGS.has(tag)) {
      if (seen.has(tag)) refuse('bolt11-field-duplicated');
      seen.add(tag);
    }
    const fixed = FIXED_LENGTH.get(tag);
    if (fixed !== undefined && length !== fixed) refuse('bolt11-field-length-invalid');

    switch (tag) {
      case TAG.p: {
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined || bytes.length !== 32) refuse('bolt11-field-length-invalid');
        paymentHash = hex(bytes as Uint8Array);
        break;
      }
      case TAG.s: {
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined || bytes.length !== 32) refuse('bolt11-field-length-invalid');
        paymentSecret = true;
        break;
      }
      case TAG.d: {
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined) return refuse('bolt11-description-invalid');
        try {
          UTF8.decode(bytes);
        } catch {
          refuse('bolt11-description-invalid');
        }
        description += 1;
        break;
      }
      case TAG.h: {
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined || bytes.length !== 32) refuse('bolt11-field-length-invalid');
        description += 1;
        break;
      }
      case TAG.n: {
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined || bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) return refuse('bolt11-field-length-invalid');
        explicitPayee = bytes;
        break;
      }
      case TAG.x:
      case TAG.c: {
        if (field.length === 0 || field[0] === 0) refuse('bolt11-field-non-minimal');
        const value = wordsToSafeInteger(field);
        if (value === undefined) return refuse('bolt11-structure-invalid');
        if (tag === TAG.x) expirySeconds = value;
        else minFinalCltvExpiryDelta = value;
        break;
      }
      case TAG['9']: {
        if (field.length === 0 || field[0] === 0) refuse('bolt11-field-non-minimal');
        const bits = featureBits(field);
        const has = (bit: number): boolean => bits.includes(bit);
        for (const bit of bits) if (bit % 2 === 0 && !BOLT11_SUPPORTED_REQUIRED_FEATURES.includes(bit)) refuse('bolt11-feature-unsupported');
        // BOLT 9: `basic_mpp` (16/17) depends on `payment_secret` (14/15).
        if ((has(16) || has(17)) && !(has(14) || has(15))) refuse('bolt11-feature-dependency-missing');
        requiredFeatures = bits.filter((bit) => bit % 2 === 0).sort((left, right) => left - right);
        break;
      }
      case TAG.r: {
        routeHintFields += 1;
        if (routeHintFields > MAXIMUM_ROUTE_HINT_FIELDS) refuse('bolt11-route-hint-invalid');
        const bytes = wordsToBytes(field, 'allowed');
        if (bytes === undefined || bytes.length === 0 || bytes.length % ROUTE_HINT_HOP_BYTES !== 0) return refuse('bolt11-route-hint-invalid');
        for (let offset = 0; offset < bytes.length; offset += ROUTE_HINT_HOP_BYTES) {
          if (bytes[offset] !== 2 && bytes[offset] !== 3) refuse('bolt11-route-hint-invalid');
          routeHintCount += 1;
        }
        break;
      }
      case TAG.f: {
        fallbackCount += 1;
        if (fallbackCount > MAXIMUM_FALLBACK_FIELDS || field.length === 0) refuse('bolt11-structure-invalid');
        break;
      }
      case TAG.m:
        if (field.length === 0) refuse('bolt11-structure-invalid');
        break;
      default:
        // Unknown tagged fields are skipped (they are still covered by the signature), but bounded.
        unknownFields += 1;
        if (unknownFields > MAXIMUM_UNKNOWN_FIELDS) refuse('bolt11-structure-invalid');
    }
  }

  if (paymentHash === undefined) return refuse('bolt11-payment-hash-missing');
  if (!paymentSecret) refuse('bolt11-payment-secret-missing');
  if (description !== 1) refuse('bolt11-description-invalid');

  const message = Uint8Array.from([...Buffer.from(decoded.prefix, 'utf8'), ...wordsToPaddedBytes(dataWords)]);
  return {
    invoice: {
      canonical: decoded.canonical,
      network,
      ...(amountMsat !== undefined ? { amountMsat } : {}),
      timestamp,
      expirySeconds,
      paymentHash,
      minFinalCltvExpiryDelta,
      requiredFeatures: Object.freeze(requiredFeatures),
      routeHintCount,
      fallbackCount,
    },
    message,
    signature,
    ...(explicitPayee !== undefined ? { explicitPayee } : {}),
  };
}

/**
 * Decodes and verifies one BOLT11 invoice. Total: every input — any type, any
 * length, any content — yields a closed answer; nothing throws.
 *
 * @param maximumLength the deployment's bound (never above `BOLT11_ABSOLUTE_MAXIMUM_LENGTH`).
 */
export async function decodeBolt11Invoice(text: unknown, maximumLength: number = BOLT11_ABSOLUTE_MAXIMUM_LENGTH): Promise<Bolt11Decoding> {
  const bound = Math.min(Number.isSafeInteger(maximumLength) && maximumLength > 0 ? maximumLength : 0, BOLT11_ABSOLUTE_MAXIMUM_LENGTH);
  if (typeof text !== 'string' || text.length > bound) return { valid: false, refusal: 'bolt11-oversized' };
  let parsed: Parsed;
  try {
    parsed = parse(text, bound);
  } catch (error) {
    return { valid: false, refusal: error instanceof Refused ? error.refusal : 'bolt11-structure-invalid' };
  }
  const check = await verifyBolt11Signature(parsed.message, parsed.signature, parsed.explicitPayee);
  if (!check.valid) return { valid: false, refusal: check.reason === 'signature-high-s' ? 'bolt11-signature-high-s' : 'bolt11-signature-invalid' };
  return {
    valid: true,
    invoice: Object.freeze({ ...parsed.invoice, payee: check.payee, payeeSource: parsed.explicitPayee !== undefined ? 'n-field' : 'recovered' }),
  };
}

/** Unix seconds after which the invoice must not be paid (`timestamp + expiry`). Exact integer arithmetic over safe integers. */
export function bolt11ExpiresAt(invoice: Pick<Bolt11Invoice, 'timestamp' | 'expirySeconds'>): number {
  return invoice.timestamp + invoice.expirySeconds;
}
