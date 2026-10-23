import { AUTHORITY_ARTIFACT_VERSION, decodeAuthoritySignatureBytes, isSupportedAuthoritySignatureAlgorithm } from '../authority-authenticity/signature-envelope.js';
import { isExecutionCapabilityIdentifier, parseExecutionCapability } from '../execution-capability/capability.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';

/**
 * G-02C1A — `frontera.execution-capability-presentation.v1`: how a signed
 * G-02A capability travels to an executor, as one header value.
 *
 * ```
 * base64url( aoc.canonical-json.v1 {
 *   bindingFormat,          // equals the signed capability's actionBinding.format
 *   capability,             // the canonical capability text, exactly as signed
 *   format,                 // this constant
 *   signature: { algorithm, artifactVersion, keyId, signature }   // the CORE-02 envelope
 * } )
 * ```
 *
 * It carries the capability and its signature, and nothing else: no grant, no
 * grant-reference nonce, no policy or approval detail, no credential, no key,
 * no store path or row id, no Host evidence. The capability itself is the
 * closed G-02A record, whose `grantReference` is an opaque digest.
 *
 * ## Pure, and never a signer
 *
 * This module encodes and decodes. It holds no key, signs nothing and verifies
 * no signature: an executor verifies with the standalone G-02A verifier against
 * keys it pinned itself. A decoded presentation is only well formed, never
 * trusted.
 *
 * ## One spelling
 *
 * The encoded value must be exactly the canonical encoding of what it decodes
 * to. Unpadded base64url with no stray bits, strict UTF-8, canonical JSON (one
 * key order, no whitespace, one escape per character, no duplicated key), and
 * the four fields with their exact shapes. Every other spelling is refused, never
 * normalized, so two different header values can never present one capability.
 */

export const EXECUTION_CAPABILITY_PRESENTATION_FORMAT = 'frontera.execution-capability-presentation.v1';

/** The request header that carries a presentation (G-02C1D will reserve it in the Host mapper). */
export const EXECUTION_CAPABILITY_PRESENTATION_HEADER = 'frontera-execution-capability';

export const EXECUTION_CAPABILITY_PRESENTATION_LIMITS = Object.freeze({
  /** Base64url characters. A realistic presentation is about 1.5 KB; this stays below the Host's 16 KiB header budget. */
  maximumEncodedLength: 8_192,
});

export const EXECUTION_CAPABILITY_PRESENTATION_FAILURES = Object.freeze([
  'PRESENTATION_MISSING',
  'PRESENTATION_TOO_LARGE',
  'PRESENTATION_ENCODING_INVALID',
  'PRESENTATION_NOT_UTF8',
  'PRESENTATION_MALFORMED',
  'PRESENTATION_NONCANONICAL',
  'PRESENTATION_FORMAT_UNSUPPORTED',
  'PRESENTATION_SIGNATURE_MALFORMED',
  'PRESENTATION_ALGORITHM_UNSUPPORTED',
  'PRESENTATION_CAPABILITY_INVALID',
  'PRESENTATION_BINDING_FORMAT_MISMATCH',
] as const);
export type ExecutionCapabilityPresentationFailure = (typeof EXECUTION_CAPABILITY_PRESENTATION_FAILURES)[number];

export interface ExecutionCapabilityPresentationSignature {
  readonly algorithm: string;
  readonly artifactVersion: string;
  readonly keyId: string;
  readonly signature: string;
}

/** A decoded presentation: well formed, not verified. */
export interface ExecutionCapabilityPresentation {
  /** The canonical capability text, exactly as presented. */
  readonly capability: string;
  readonly signature: ExecutionCapabilityPresentationSignature;
  readonly bindingFormat: string;
}

export type ExecutionCapabilityPresentationDecoding =
  | { readonly ok: true; readonly presentation: ExecutionCapabilityPresentation }
  | { readonly ok: false; readonly failure: ExecutionCapabilityPresentationFailure };

const ENVELOPE_FIELDS = Object.freeze(['bindingFormat', 'capability', 'format', 'signature'] as const);
const SIGNATURE_FIELDS = Object.freeze(['algorithm', 'artifactVersion', 'keyId', 'signature'] as const);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** The same Unicode rule as the G-02A codec: an unpaired surrogate is malformed text. */
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

/** The signature envelope's exact shape: the one supported algorithm, this artifact version, a key id and exactly-sized signature bytes. */
function readSignature(value: unknown): ExecutionCapabilityPresentationSignature | ExecutionCapabilityPresentationFailure {
  const fields = exactRecord(value, SIGNATURE_FIELDS);
  if (fields === undefined) return 'PRESENTATION_SIGNATURE_MALFORMED';
  const algorithm = fields['algorithm'];
  const artifactVersion = fields['artifactVersion'];
  const keyId = fields['keyId'];
  const signature = fields['signature'];
  if (typeof algorithm !== 'string') return 'PRESENTATION_SIGNATURE_MALFORMED';
  if (!isSupportedAuthoritySignatureAlgorithm(algorithm)) return 'PRESENTATION_ALGORITHM_UNSUPPORTED';
  if (artifactVersion !== AUTHORITY_ARTIFACT_VERSION || !isExecutionCapabilityIdentifier(keyId) || typeof signature !== 'string') return 'PRESENTATION_SIGNATURE_MALFORMED';
  if (decodeAuthoritySignatureBytes(signature, algorithm) === undefined) return 'PRESENTATION_SIGNATURE_MALFORMED';
  return Object.freeze({ algorithm, artifactVersion, keyId, signature });
}

/**
 * Decodes one presented header value. Total: it never throws, and every
 * refusal is a closed failure code that quotes nothing of the input.
 */
export function decodeExecutionCapabilityPresentation(encoded: unknown): ExecutionCapabilityPresentationDecoding {
  const refuse = (failure: ExecutionCapabilityPresentationFailure): ExecutionCapabilityPresentationDecoding => ({ ok: false, failure });
  try {
    if (typeof encoded !== 'string' || encoded.length === 0) return refuse('PRESENTATION_MISSING');
    if (encoded.length > EXECUTION_CAPABILITY_PRESENTATION_LIMITS.maximumEncodedLength) return refuse('PRESENTATION_TOO_LARGE');
    // Unpadded base64url only, and the one spelling of its bytes: no padding, no stray trailing bits, no foreign alphabet.
    if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) return refuse('PRESENTATION_ENCODING_INVALID');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return refuse('PRESENTATION_ENCODING_INVALID');

    let text: string;
    try {
      text = STRICT_UTF8.decode(bytes);
    } catch {
      return refuse('PRESENTATION_NOT_UTF8');
    }
    if (UNPAIRED_SURROGATE.test(text)) return refuse('PRESENTATION_MALFORMED');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse('PRESENTATION_MALFORMED');
    }
    const envelope = exactRecord(parsed, ENVELOPE_FIELDS);
    if (envelope === undefined) return refuse('PRESENTATION_MALFORMED');
    if (envelope['format'] !== EXECUTION_CAPABILITY_PRESENTATION_FORMAT) return refuse(typeof envelope['format'] === 'string' ? 'PRESENTATION_FORMAT_UNSUPPORTED' : 'PRESENTATION_MALFORMED');

    const signature = readSignature(envelope['signature']);
    if (typeof signature === 'string') return refuse(signature);
    const capability = envelope['capability'];
    const bindingFormat = envelope['bindingFormat'];
    if (typeof capability !== 'string' || !isExecutionCapabilityIdentifier(bindingFormat)) return refuse('PRESENTATION_MALFORMED');

    // The text must be the canonical spelling of exactly what it decoded to: duplicated keys, reordering and re-escaping are refused here.
    const canonical = canonicalSerialize({ bindingFormat, capability, format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature });
    if (canonical !== text) return refuse('PRESENTATION_NONCANONICAL');

    // Structural only: the G-02A codec refuses a capability that is not canonical, closed and well formed. Its signature is not checked here.
    const parsedCapability = parseExecutionCapability(capability);
    if (!parsedCapability.ok) return refuse('PRESENTATION_CAPABILITY_INVALID');
    if (parsedCapability.capability.actionBinding.format !== bindingFormat) return refuse('PRESENTATION_BINDING_FORMAT_MISMATCH');

    return { ok: true, presentation: Object.freeze({ capability, signature, bindingFormat }) };
  } catch {
    return refuse('PRESENTATION_MALFORMED');
  }
}

/**
 * Encodes a presentation: the canonical envelope, as unpadded base64url. It
 * signs nothing — the signature is the one G-02B custody produced. Refuses
 * (throws `TypeError`) whatever its own decoder would refuse, so an encoded
 * value always decodes to what was encoded.
 */
export function encodeExecutionCapabilityPresentation(presentation: ExecutionCapabilityPresentation): string {
  const { capability, signature, bindingFormat } = presentation;
  const envelope = {
    bindingFormat,
    capability,
    format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT,
    signature: { algorithm: signature.algorithm, artifactVersion: signature.artifactVersion, keyId: signature.keyId, signature: signature.signature },
  };
  const encoded = Buffer.from(canonicalSerialize(envelope), 'utf8').toString('base64url');
  const decoded = decodeExecutionCapabilityPresentation(encoded);
  if (!decoded.ok) throw new TypeError(`The presentation cannot be encoded: ${decoded.failure}.`);
  return encoded;
}
