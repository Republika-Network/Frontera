import {
  serializeRevocationStateCommitment,
  serializeStoredGrantRecord,
  serializeStoredRevocationRecord,
  type RevocationStateCommitment,
} from '../bounded-grant-store/bounded-grant-record.js';
import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';

/**
 * The signature envelope for an authority artifact, the closed algorithm
 * registry it may name, and the exact bytes a signature is taken over.
 *
 * ## The distinction this file exists to hold
 *
 * `bounded-grant-record.ts` produces an **unkeyed digest**: it proves that a
 * record's bytes are the bytes that were digested, and it proves nothing about
 * who wrote them, because anyone who can rewrite a record can recompute its
 * digest. This file produces a **digital signature**: a private key signs, a
 * public key verifies, and a party holding only the public key can check
 * authority it cannot mint.
 *
 * The two are kept side by side rather than one replacing the other. They
 * detect different things — a digest catches a partial write or a corrupted
 * page without any key being present, a signature catches a writer who
 * recomputed that digest — and collapsing them would lose the cheaper check
 * while pretending the expensive one had always been there.
 *
 * A third thing this is emphatically not: a **MAC**. An HMAC over the same
 * bytes would authenticate against a shared secret, which means every party
 * able to verify authority is also able to mint it — exactly the property the
 * bounded-grant read path must not have. The repository's existing Agent
 * Passport signer is HMAC-based (`packages/agent-governance/src/signing/`);
 * `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §10.4 records why it was
 * evaluated and deliberately not reused here.
 *
 * ## Why the signature is over the *record* envelope
 *
 * `serializeStoredGrantRecord` already binds five things at once: the record
 * format, the store and grant id the row is filed under, the store schema
 * version, and the grant's full canonical form (which itself carries `digest`,
 * computed with `digest` held empty, so there is no circularity). Signing that
 * string therefore covers every authority-relevant field *and* the identity the
 * row is filed under — a signature lifted onto a different row, or into a
 * different store, fails, not merely a signature over different field values.
 *
 * ## The third artifact: the revocation-state commitment (CORE-01)
 *
 * A grant signature and a revocation signature each prove that one record is
 * genuine. Neither proves that a genuine revocation has not been *removed*. The
 * revocation-state commitment is the artifact that does: a signed statement of
 * the whole revocation set, re-signed on every revocation and checked on every
 * read. It gets its own domain for the same reason the other two do.
 */

/** The authority-artifact format this runtime implements. An envelope naming any other value is refused rather than reinterpreted under this one. */
export const AUTHORITY_ARTIFACT_VERSION = 'aoc.authority-artifact.v1';

/**
 * Domain separation, as a literal byte prefix rather than as a property of the
 * JSON shape.
 *
 * The canonical record strings already differ — one carries `"kind":"grant"`,
 * the other `"kind":"revocation"` — so shape alone would *probably* stop a
 * grant's signature verifying as a revocation's. "Probably" is the problem: it
 * makes cross-artifact separation a consequence of two serializers happening to
 * disagree, which a later field rename could quietly remove. The prefix makes
 * it a property of the signing input itself, so the two domains cannot collide
 * even if their payloads were ever made identical.
 *
 * The trailing newline is part of the prefix: without a separator, a domain tag
 * and the payload that follows it could in principle be re-split, and a prefix
 * that can be re-split is not a domain separator.
 */
export const AUTHORITY_SIGNING_DOMAINS = {
  grant: 'frontera:authority-artifact:bounded-grant:v1\n',
  revocation: 'frontera:authority-artifact:grant-revocation:v1\n',
  revocationState: 'frontera:authority-artifact:revocation-state:v1\n',
} as const;

export type AuthorityArtifactKind = keyof typeof AUTHORITY_SIGNING_DOMAINS;

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

/**
 * The detached signature envelope.
 *
 * Four fields, all explicit, none optional, and no free-form metadata: a
 * verifier reads `algorithm` and `artifactVersion` to decide *how* to check,
 * and `keyId` to decide *what to check against*. Anything else here would be
 * input to verification that nobody had reasoned about.
 *
 * There is deliberately **no public key field**. An artifact that carried its
 * own verification key would be its own root of trust — "this is signed, by
 * whoever signed it" — which is not a security property. `keyId` is a *claim*;
 * the trusted registry decides what, if anything, that claim resolves to.
 */
export interface AuthoritySignature {
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** A claim, never a capability. Resolved against the composition-supplied registry; an id it does not hold fails closed. */
  readonly keyId: string;
  /** base64url, unpadded. */
  readonly signature: string;
  readonly artifactVersion: string;
}

/** The exact bytes a bounded grant's signature is computed and verified over. Domain-separated, and identical on both sides by construction — there is one function, not a signing copy and a verifying copy that could drift. */
export function grantSigningBytes(grant: BoundedGrant, storeId: string): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.grant}${serializeStoredGrantRecord(grant, storeId)}`, 'utf8');
}

/** The exact bytes a revocation's signature is computed and verified over. A different domain from `grantSigningBytes`, so neither artifact's signature can be replayed as the other's. */
export function revocationSigningBytes(revocation: GrantRevocation, storeId: string): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.revocation}${serializeStoredRevocationRecord(revocation, storeId)}`, 'utf8');
}

/** The exact bytes a revocation-state commitment's signature is computed and verified over. Its own domain, so no grant or revocation signature can stand in for it. */
export function revocationStateSigningBytes(state: RevocationStateCommitment): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.revocationState}${serializeRevocationStateCommitment(state)}`, 'utf8');
}

/** Dispatches to the one signing-bytes function for a kind. Exhaustive by type, so a new artifact kind cannot be added without being given a domain. */
export function authoritySigningBytes(
  artifact:
    | { readonly kind: 'grant'; readonly grant: BoundedGrant; readonly storeId: string }
    | { readonly kind: 'revocation'; readonly revocation: GrantRevocation; readonly storeId: string }
    | { readonly kind: 'revocationState'; readonly state: RevocationStateCommitment },
): Buffer {
  switch (artifact.kind) {
    case 'grant':
      return grantSigningBytes(artifact.grant, artifact.storeId);
    case 'revocation':
      return revocationSigningBytes(artifact.revocation, artifact.storeId);
    case 'revocationState':
      return revocationStateSigningBytes(artifact.state);
  }
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
