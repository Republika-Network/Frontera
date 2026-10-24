import { AUTHORITY_ARTIFACT_VERSION, decodeAuthoritySignatureBytes, isSupportedAuthoritySignatureAlgorithm } from '../authority-authenticity/signature-envelope.js';
import { isExecutionCapabilityIdentifier } from '../execution-capability/capability.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { parseExecutorReceipt } from './receipt.js';
import type { PresentedExecutorReceipt } from './verifier.js';

/**
 * G-02C1D — `frontera.executor-receipt-transport.v1`: how one signed G-02C1C
 * receipt travels back to the Host, as the value of the one
 * `frontera-execution-receipt` response header.
 *
 * ```
 * base64url( aoc.canonical-json.v1 {
 *   format,                // this constant
 *   receipt,               // the canonical receipt text, exactly as the executor's receipt ledger persisted it
 *   signature: { algorithm, artifactVersion, keyId, signature }   // the persisted CORE-02 envelope
 * } )
 * ```
 *
 * It is a transport encoding, not a new receipt: the receipt text and its
 * signature are the persisted artifact, byte for byte, and nothing is added —
 * no status, no diagnostic, no key.
 *
 * ## Pure, and never a signer or a verifier
 *
 * This module encodes and decodes. It holds no key and verifies no signature:
 * a decoded value is only well formed (the receipt text parses as a canonical,
 * self-consistent receipt; the envelope has the CORE-02 shape). Trust is the
 * verifier's, against keys its caller pinned.
 *
 * ## One spelling
 *
 * The value must be exactly the canonical encoding of what it decodes to:
 * unpadded base64url with no stray bits, strict UTF-8, canonical JSON with the
 * three fields and their exact shapes. Every other spelling is refused, never
 * normalized.
 */

export const EXECUTOR_RECEIPT_TRANSPORT_FORMAT = 'frontera.executor-receipt-transport.v1';

/** The response header that carries one receipt (the Host's Generic HTTP adapter reserves it). */
export const EXECUTOR_RECEIPT_TRANSPORT_HEADER = 'frontera-execution-receipt';

export const EXECUTOR_RECEIPT_TRANSPORT_LIMITS = Object.freeze({
  /** Base64url characters. A realistic receipt encodes to about 2.5 KB; this stays well inside Node's 16 KiB response-header budget. */
  maximumEncodedLength: 8_192,
});

export const EXECUTOR_RECEIPT_TRANSPORT_FAILURES = Object.freeze([
  'RECEIPT_MISSING',
  'RECEIPT_DUPLICATED',
  'RECEIPT_TOO_LARGE',
  'RECEIPT_ENCODING_INVALID',
  'RECEIPT_NOT_UTF8',
  'RECEIPT_MALFORMED',
  'RECEIPT_NONCANONICAL',
  'RECEIPT_FORMAT_UNSUPPORTED',
  'RECEIPT_SIGNATURE_MALFORMED',
  'RECEIPT_TEXT_INVALID',
] as const);
export type ExecutorReceiptTransportFailure = (typeof EXECUTOR_RECEIPT_TRANSPORT_FAILURES)[number];

export type ExecutorReceiptTransportDecoding = { readonly ok: true; readonly presented: PresentedExecutorReceipt } | { readonly ok: false; readonly failure: ExecutorReceiptTransportFailure };

const ENVELOPE_FIELDS = Object.freeze(['format', 'receipt', 'signature'] as const);
const SIGNATURE_FIELDS = Object.freeze(['algorithm', 'artifactVersion', 'keyId', 'signature'] as const);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Exactly these own, enumerable data properties on a plain object, read once. */
function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !keys.every((key) => typeof key === 'string' && fields.includes(key))) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
    out[field] = descriptor.value;
  }
  return Object.freeze(out);
}

function readSignature(value: unknown): Readonly<Record<string, string>> | undefined {
  const fields = exactRecord(value, SIGNATURE_FIELDS);
  if (fields === undefined) return undefined;
  const { algorithm, artifactVersion, keyId, signature } = fields;
  if (typeof algorithm !== 'string' || !isSupportedAuthoritySignatureAlgorithm(algorithm)) return undefined;
  if (artifactVersion !== AUTHORITY_ARTIFACT_VERSION || !isExecutionCapabilityIdentifier(keyId) || typeof signature !== 'string') return undefined;
  if (decodeAuthoritySignatureBytes(signature, algorithm) === undefined) return undefined;
  return Object.freeze({ algorithm, artifactVersion, keyId, signature });
}

/**
 * Decodes the receipt header's values, as the transport read them (every raw
 * value, in order, never joined). Exactly one value is a receipt; none is
 * `RECEIPT_MISSING` and more than one is `RECEIPT_DUPLICATED` — an ambiguous
 * answer is never resolved by picking one. Total: it never throws, and a
 * refusal quotes nothing of the input.
 */
export function decodeExecutorReceiptTransport(values: readonly unknown[]): ExecutorReceiptTransportDecoding {
  const refuse = (failure: ExecutorReceiptTransportFailure): ExecutorReceiptTransportDecoding => ({ ok: false, failure });
  try {
    if (!Array.isArray(values) || values.length === 0) return refuse('RECEIPT_MISSING');
    if (values.length > 1) return refuse('RECEIPT_DUPLICATED');
    const encoded: unknown = values[0];
    if (typeof encoded !== 'string' || encoded.length === 0) return refuse('RECEIPT_MISSING');
    if (encoded.length > EXECUTOR_RECEIPT_TRANSPORT_LIMITS.maximumEncodedLength) return refuse('RECEIPT_TOO_LARGE');
    if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) return refuse('RECEIPT_ENCODING_INVALID');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return refuse('RECEIPT_ENCODING_INVALID');

    let text: string;
    try {
      text = STRICT_UTF8.decode(bytes);
    } catch {
      return refuse('RECEIPT_NOT_UTF8');
    }
    if (UNPAIRED_SURROGATE.test(text)) return refuse('RECEIPT_MALFORMED');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse('RECEIPT_MALFORMED');
    }
    const envelope = exactRecord(parsed, ENVELOPE_FIELDS);
    if (envelope === undefined) return refuse('RECEIPT_MALFORMED');
    if (envelope['format'] !== EXECUTOR_RECEIPT_TRANSPORT_FORMAT) return refuse(typeof envelope['format'] === 'string' ? 'RECEIPT_FORMAT_UNSUPPORTED' : 'RECEIPT_MALFORMED');
    const signature = readSignature(envelope['signature']);
    if (signature === undefined) return refuse('RECEIPT_SIGNATURE_MALFORMED');
    const receipt = envelope['receipt'];
    if (typeof receipt !== 'string') return refuse('RECEIPT_MALFORMED');

    if (canonicalSerialize({ format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT, receipt, signature }) !== text) return refuse('RECEIPT_NONCANONICAL');
    // Structural only: the G-02C1C parser refuses a receipt that is not canonical, closed and self-consistent. No signature is checked here.
    if (!parseExecutorReceipt(receipt).ok) return refuse('RECEIPT_TEXT_INVALID');

    return { ok: true, presented: Object.freeze({ receipt, signature }) };
  } catch {
    return refuse('RECEIPT_MALFORMED');
  }
}

/**
 * Encodes one persisted receipt and its signature. Signs nothing. Refuses
 * (throws `TypeError`) whatever its own decoder would refuse — including an
 * encoding over the bound — so a delivered value always decodes to exactly
 * the persisted artifact.
 */
export function encodeExecutorReceiptTransport(presented: { readonly receipt: string; readonly signature: Readonly<Record<string, string>> }): string {
  const signature = presented.signature;
  const envelope = {
    format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT,
    receipt: presented.receipt,
    signature: { algorithm: signature['algorithm'], artifactVersion: signature['artifactVersion'], keyId: signature['keyId'], signature: signature['signature'] },
  };
  const encoded = Buffer.from(canonicalSerialize(envelope), 'utf8').toString('base64url');
  const decoded = decodeExecutorReceiptTransport([encoded]);
  if (!decoded.ok) throw new TypeError(`The receipt cannot be encoded for transport: ${decoded.failure}.`);
  return encoded;
}
