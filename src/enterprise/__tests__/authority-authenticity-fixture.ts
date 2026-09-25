import { generateKeyPairSync } from 'node:crypto';

import {
  createAuthorityArtifactVerifier,
  createSoftwareAuthorityArtifactSigner,
  type AuthorityArtifactSigner,
  type AuthorityArtifactVerifier,
  type TrustedVerificationKey,
} from '../authority-authenticity/index.js';
import { createSqliteBoundedGrantStore, type CreateSqliteBoundedGrantStoreOptions, type DurableBoundedGrantStore } from '../bounded-grant-store/index.js';

/**
 * Real key pairs for the durable store's tests.
 *
 * Generated once per process rather than checked in, and generated *properly*
 * rather than stubbed: every signature these tests exercise is a real Ed25519
 * signature over the real canonical bytes, so a test that passes is evidence
 * about the cryptography and not about a fake that agrees with itself. The
 * cost — a few milliseconds at module load — buys tests that would fail if the
 * signing bytes, the domain separators or the verification order changed.
 *
 * Module-level, so a "restart" that closes a store and reopens it over the same
 * file verifies with the same key the first process signed with. That is what
 * makes the restart suite meaningful: the artifacts genuinely outlive the store
 * instance that wrote them.
 *
 * Two pairs, because rotation needs two.
 */
function generate(keyId: string): { readonly keyId: string; readonly algorithm: 'ed25519-v1'; readonly privateKeyPem: string; readonly publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    algorithm: 'ed25519-v1',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export const AUTHORITY_KEY_A = generate('authority-key-a');
export const AUTHORITY_KEY_B = generate('authority-key-b');
/** Never placed in any trusted registry. The attacker's key. */
export const AUTHORITY_KEY_UNTRUSTED = generate('authority-key-untrusted');

export type TestAuthorityKey = typeof AUTHORITY_KEY_A;

export function trustedKeyOf(key: TestAuthorityKey): TrustedVerificationKey {
  return { keyId: key.keyId, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem };
}

export function testSigner(key: TestAuthorityKey = AUTHORITY_KEY_A): AuthorityArtifactSigner {
  return createSoftwareAuthorityArtifactSigner({ keyId: key.keyId, algorithm: key.algorithm, privateKeyPem: key.privateKeyPem });
}

export function testVerifier(keys: readonly TestAuthorityKey[] = [AUTHORITY_KEY_A]): AuthorityArtifactVerifier {
  return createAuthorityArtifactVerifier(keys.map(trustedKeyOf));
}

/** The default authenticity boundary for a test store: key A signs, key A is trusted. */
export function testAuthenticity(options: { readonly signWith?: TestAuthorityKey; readonly trust?: readonly TestAuthorityKey[] } = {}): {
  readonly signer: AuthorityArtifactSigner;
  readonly verifier: AuthorityArtifactVerifier;
} {
  const signWith = options.signWith ?? AUTHORITY_KEY_A;
  return { signer: testSigner(signWith), verifier: testVerifier(options.trust ?? [signWith]) };
}

/**
 * Opens a durable store with a working authenticity boundary.
 *
 * Exists so a test that is about durability does not have to restate the key
 * wiring, and — more usefully — so a test that *is* about the key wiring can
 * override exactly one half of it and leave everything else identical.
 */
export function openDurableStore(
  dbPath: string,
  options: Omit<CreateSqliteBoundedGrantStoreOptions, 'authenticity'> & { readonly authenticity?: CreateSqliteBoundedGrantStoreOptions['authenticity'] } = {},
): Promise<DurableBoundedGrantStore> {
  const { authenticity, ...rest } = options;
  return createSqliteBoundedGrantStore(dbPath, { ...rest, authenticity: authenticity ?? testAuthenticity() });
}

/**
 * The environment a SQLite-backed Enterprise Host needs for its authority
 * authenticity boundary: key A signs, key A is trusted. Spread into a
 * `loadEnterpriseConfiguration` call so a composition test exercises the real
 * configuration parser rather than a hand-built object.
 */
export function authorityAuthenticityEnv(key: TestAuthorityKey = AUTHORITY_KEY_A): Readonly<Record<string, string>> {
  return {
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: key.keyId,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: key.privateKeyPem,
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([trustedKeyOf(key)]),
  };
}
