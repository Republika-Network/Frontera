import { createHash, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/signature-envelope.js';
import { createAuthoritySignatureRegistry } from '../authority-authenticity/signature-verification.js';
import { canonicalizeConformance } from './canonical.js';

/**
 * RN-CONFORM-02 — domain-separated Ed25519 signatures for conformance
 * artifacts.
 *
 * Reuse decision (mission §9): the CORE-02 **envelope** (`AuthoritySignature`,
 * `ed25519-v1`, `aoc.authority-artifact.v1`) and the CORE-02 **verification
 * routine** (`createAuthoritySignatureRegistry`: public material only, closed
 * algorithm set, fixed check order) are reused unchanged. The
 * `AUTHORITY_SIGNING_DOMAINS` table is **not** extended: its dispatcher
 * `authoritySigningBytes` is exhaustive over Host authority artifacts, and
 * adding conformance kinds to it would put them into the Host signer's
 * vocabulary. Conformance domains are a separate, narrowly scoped namespace
 * whose prefix (`frontera:conformance-`) cannot be a prefix of, or prefixed by,
 * any `frontera:authority-artifact:` domain (pinned by a test).
 *
 * Signing bytes = `domain ‖ aoc-canonical-json/1(payload)`, where `payload`
 * never contains the signature itself.
 */
export const CONFORMANCE_SIGNING_DOMAINS = Object.freeze({
  challenge: 'frontera:conformance-challenge:v1\n',
  observation: 'frontera:conformance-observation:v1\n',
  transition: 'frontera:conformance-transition:v1\n',
  humanDecision: 'frontera:conformance-human-decision:v1\n',
} as const);

export type ConformanceSigningKind = keyof typeof CONFORMANCE_SIGNING_DOMAINS;

export function conformanceSigningBytes(kind: ConformanceSigningKind, payload: unknown): Buffer {
  const domain = CONFORMANCE_SIGNING_DOMAINS[kind];
  if (domain === undefined) throw new TypeError('Unknown conformance signing domain.');
  return Buffer.from(`${domain}${canonicalizeConformance(payload)}`, 'utf8');
}

/**
 * Key ids are derived, never chosen: `sha256:<hex of the SPKI DER public key>`,
 * the same material fingerprint `executor-receipt/verifier.ts` and
 * `reference-executor/receipt-signer.ts` compute. A registry refuses an entry
 * whose id is not the derivation of its own key.
 */
export function deriveConformanceKeyId(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Conformance keys are Ed25519.');
  const spki = (key.type === 'private' ? createPublicKey(key) : key).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(spki).digest('hex')}`;
}

/** Public SPKI PEM for an Ed25519 key. */
export function publicKeyPemOf(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** Signs `payload` in `kind`'s domain. Used by the registry signer and by synthetic fixtures only; no conformance code accepts a private key from a submission. */
export function signConformancePayload(kind: ConformanceSigningKind, payload: unknown, privateKey: KeyObject): AuthoritySignature {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('A conformance signature needs an Ed25519 private key.');
  const signature = cryptoSign(null, conformanceSigningBytes(kind, payload), privateKey);
  return Object.freeze({
    algorithm: 'ed25519-v1',
    keyId: deriveConformanceKeyId(privateKey),
    signature: signature.toString('base64url'),
    artifactVersion: AUTHORITY_ARTIFACT_VERSION,
  });
}

export type ConformanceSignatureCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'KEY_ID_MISMATCH' | 'PAYLOAD_NOT_CANONICALIZABLE' | 'SIGNATURE_INVALID' | 'KEY_UNUSABLE' };

/**
 * Verifies `signature` over `payload` in `kind`'s domain against exactly one
 * **trusted** public key — resolved by the caller from an approved registry,
 * never from the artifact. The envelope's `keyId` must equal the derived id of
 * that key. Never throws.
 */
export function verifyConformanceSignature(kind: ConformanceSigningKind, payload: unknown, signature: unknown, trustedPublicKeyPem: string): ConformanceSignatureCheck {
  let keyId: string;
  try {
    keyId = deriveConformanceKeyId(trustedPublicKeyPem);
  } catch {
    return { ok: false, reason: 'KEY_UNUSABLE' };
  }
  if (typeof signature !== 'object' || signature === null || (signature as { keyId?: unknown }).keyId !== keyId) return { ok: false, reason: 'KEY_ID_MISMATCH' };
  let bytes: Buffer;
  try {
    bytes = conformanceSigningBytes(kind, payload);
  } catch {
    return { ok: false, reason: 'PAYLOAD_NOT_CANONICALIZABLE' };
  }
  try {
    const registry = createAuthoritySignatureRegistry([{ keyId, algorithm: 'ed25519-v1', publicKeyPem: trustedPublicKeyPem }]);
    return registry.verify(bytes, signature).verified ? { ok: true } : { ok: false, reason: 'SIGNATURE_INVALID' };
  } catch {
    return { ok: false, reason: 'KEY_UNUSABLE' };
  }
}
