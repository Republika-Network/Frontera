import type { AuthoritySignature } from './authority-signature.js';

/**
 * The CORE-02 signature envelope's dependency-free primitives: the artifact
 * version, the closed algorithm registry, and the structural checks on an
 * envelope and its signature bytes.
 *
 * Moved here unchanged from `authority-signature.ts` (G-02A), which re-exports
 * every name, so that a standalone verifier can apply exactly these rules
 * without importing the serializers of the Host's other authority artifacts.
 * The envelope type itself stays declared in `authority-signature.ts`.
 */

/** The authority-artifact format this runtime implements. An envelope naming any other value is refused rather than reinterpreted under this one. */
export const AUTHORITY_ARTIFACT_VERSION = 'aoc.authority-artifact.v1';

/**
 * The closed registry of algorithms this runtime will verify.
 *
 * Closed on purpose, and the opposite of "accept whatever Node supports". A
 * verifier that dispatched on a caller-supplied algorithm string would let an
 * artifact choose the rules it is judged by, which is the algorithm-confusion
 * shape — and a verifier that tried several until one succeeded would turn the
 * weakest entry into the security level of the whole set. There is exactly one
 * entry, adding another is code and configuration work, and nothing falls back.
 *
 * `ed25519-v1` maps to Node's `crypto.sign(null, ...)` / `crypto.verify(null,
 * ...)`, which for Ed25519 take no hash parameter at all — the algorithm fixes
 * the hash internally. That absence is a security property here: there is no
 * digest-algorithm field for an artifact to influence, so the "sign with SHA-1
 * instead" family of downgrades has nowhere to attach. It is deterministic, it
 * needs no entropy at signing time, it is in the Node standard library at the
 * version this repository requires (`engines.node >= 22`), and it costs no new
 * dependency.
 */
export const SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS = {
  'ed25519-v1': {
    /** What `KeyObject.asymmetricKeyType` must report for a key registered under this algorithm. A key of any other type is refused at composition, never coerced. */
    keyType: 'ed25519',
    /** Ed25519 signatures are exactly 64 bytes. A truncated or padded signature is *malformed* rather than merely invalid, and is refused before any key is consulted. */
    signatureBytes: 64,
  },
} as const;

export type AuthoritySignatureAlgorithm = keyof typeof SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS;

export function isSupportedAuthoritySignatureAlgorithm(value: string): value is AuthoritySignatureAlgorithm {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS, value);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes signature bytes, or reports that the field is not a signature.
 *
 * `Buffer.from(s, 'base64url')` is lenient — it discards characters it does not
 * recognise and returns *something* for almost any input, so a corrupted field
 * would silently become a short buffer and then fail as an "invalid signature".
 * That would report tampering as a failed verification against a real key, when
 * the truth is that no signature was present to check. The alphabet is
 * therefore checked explicitly and the decoded width is required to be exactly
 * what the algorithm defines, so truncation and corruption are refused as
 * malformed before any key is touched.
 */
export function decodeAuthoritySignatureBytes(encoded: string, algorithm: AuthoritySignatureAlgorithm): Buffer | undefined {
  if (!BASE64URL.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, 'base64url');
  return decoded.length === SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS[algorithm].signatureBytes ? decoded : undefined;
}

/** Whether a value has the envelope's exact shape. Structural only: it says nothing about whether the signature verifies, or whether the key is one this deployment trusts. */
export function isWellFormedAuthoritySignature(value: unknown): value is AuthoritySignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.algorithm === 'string' &&
    isSupportedAuthoritySignatureAlgorithm(candidate.algorithm) &&
    typeof candidate.keyId === 'string' &&
    candidate.keyId.length > 0 &&
    typeof candidate.signature === 'string' &&
    candidate.signature.length > 0 &&
    typeof candidate.artifactVersion === 'string' &&
    candidate.artifactVersion.length > 0
  );
}
