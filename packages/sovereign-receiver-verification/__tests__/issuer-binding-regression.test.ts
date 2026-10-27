// SOBE-SEC-01 issuer-to-signing-key substitution, as seen by a receiver.
//
// Protocol burned 0.2.0-rc.0/rc.1 for two defects, fixed in rc.2 and rc.3
// (integration-contract.json -> lastMetadataUpdate / previousMetadataUpdates):
//   SOBE-SEC-01     a binding could be reported verified without tying the
//                   signing key to the registered issuer key;
//   SOBE-SEC-01 N1  a caller-supplied issuer could replace the issuer named
//                   by the signed manifest or claim.
// These tests exercise only the fixed rc.3 primitives through the receiver
// API and assert observable outcomes. They reimplement no historical
// algorithm.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { verifySovereignManifest } from '@aoc/protocol/manifest';

import { verifyReceivedSovereignAsset } from '../src/index.js';
import type { ReceivedSovereignAssetVerificationResult, ReceiverVerificationKeyResolver } from '../src/index.js';
import {
  ATTACKER,
  ISSUER,
  attackerKeys,
  claimArtifact,
  consumerSupport,
  issuerKeys,
  manifestArtifact,
  serialize,
  signedManifest,
  signedOriginClaim,
  trustingResolver,
  validOptions,
} from './fixtures.js';
import type { ResolverCall } from './fixtures.js';

function assertNotVerified(result: ReceivedSovereignAssetVerificationResult, reason: string): void {
  assert.equal(result.outcome, 'rejected');
  assert.ok((result.reasons as readonly string[]).includes(reason), `expected ${reason}, got ${JSON.stringify(result.reasons)}`);
}

const manifestOnlySupport = () => consumerSupport({ claimTypes: [], artifactKinds: ['signed-manifest'] });

/** A manifest that names ISSUER as registrant, signed with the attacker's key. */
function attackerSignedIssuerManifest(): { readonly text: string; readonly sovereignAssetId: string } {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: undefined }, attackerKeys);
  return { sovereignAssetId, text: serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)] }) };
}

// 1. A correct signature from an unrelated issuer is insufficient.

test('SOBE-SEC-01: a valid signature by an unrelated key does not verify the named issuer', async () => {
  const { text } = attackerSignedIssuerManifest();
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(), consumerSupport: manifestOnlySupport() });
  assertNotVerified(result, 'ISSUER_BINDING_UNVERIFIED');
  assert.equal((result.reasons as readonly string[]).includes('MANIFEST_SIGNATURE_INVALID'), false, 'the signature itself is valid; only the binding fails');
});

test('SOBE-SEC-01: borrowing the registered key id for a different key does not verify', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: undefined }, {
    privateKeyPem: attackerKeys.privateKeyPem,
    signingKey: { ...attackerKeys.signingKey, keyId: issuerKeys.signingKey.keyId },
  });
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)] });
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(), consumerSupport: manifestOnlySupport() });
  assertNotVerified(result, 'ISSUER_BINDING_UNVERIFIED');
});

test('SOBE-SEC-01: an unrelated issuer signing a claim that names the issuer does not verify', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({
    subject: { sovereignAssetId },
    manifests: [manifestArtifact(signedManifest({ sovereignAssetId, contentIdentity: undefined }))],
    claims: [claimArtifact(signedOriginClaim(sovereignAssetId, attackerKeys))],
  });
  const resolver = trustingResolver({ [ISSUER]: issuerKeys, [ATTACKER]: attackerKeys });
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: resolver, consumerSupport: consumerSupport() });
  assertNotVerified(result, 'ISSUER_BINDING_UNVERIFIED');
});

// 2. The signed issuer must be bound to the trusted verification key.

test('SOBE-SEC-01: the resolver is asked only about the issuers the signed artifacts name', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({
    subject: { sovereignAssetId },
    manifests: [manifestArtifact(signedManifest({ sovereignAssetId, contentIdentity: undefined }))],
    claims: [claimArtifact(signedOriginClaim(sovereignAssetId))],
  });
  const calls: ResolverCall[] = [];
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(undefined, calls), consumerSupport: consumerSupport() });
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  assert.deepEqual(calls, [{ issuer: ISSUER }, { issuer: ISSUER }]);
});

test('SOBE-SEC-01: a resolver entry whose key material differs from the signing key does not verify', async () => {
  // The descriptor names the attacker's (derived) key id but pins the issuer's
  // real key material: key id agreement alone must not bind.
  const { text } = attackerSignedIssuerManifest();
  const { createPublicKey } = await import('node:crypto');
  // Spread into a plain record: newer @types/node declares JsonWebKey without an index signature.
  const issuerJwk: Readonly<Record<string, unknown>> = { ...createPublicKey(issuerKeys.signingKey.publicKey).export({ format: 'jwk' }) };
  const resolver: ReceiverVerificationKeyResolver = {
    resolveVerificationKey: (issuer) => ({ keyId: attackerKeys.signingKey.keyId, issuer, algorithm: 'ed25519', publicKeyJwk: issuerJwk }),
  };
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: resolver, consumerSupport: manifestOnlySupport() });
  assertNotVerified(result, 'ISSUER_BINDING_UNVERIFIED');
});

// 3. Caller-supplied issuer metadata cannot replace the signed issuer.

test('SOBE-SEC-01 N1: an expected issuer that differs from the signed registrant is rejected without consulting the resolver', async () => {
  // The attacker controls the key and the resolver entry for ATTACKER; the
  // manifest still names ISSUER. Substituting the issuer must not verify.
  const { text } = attackerSignedIssuerManifest();
  const calls: ResolverCall[] = [];
  const resolver = trustingResolver({ [ISSUER]: issuerKeys, [ATTACKER]: attackerKeys }, calls);
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: resolver, consumerSupport: manifestOnlySupport(), expectedIssuer: ATTACKER });
  assertNotVerified(result, 'ISSUER_BINDING_MISMATCH');
  assert.deepEqual(calls, []);
});

test('SOBE-SEC-01 N1: an expected issuer only narrows, so a matching one still verifies', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(signedManifest({ sovereignAssetId, contentIdentity: undefined }))] });
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(), consumerSupport: manifestOnlySupport(), expectedIssuer: ISSUER });
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
});

test('SOBE-SEC-01 N1: options that try to name a claim issuer are refused, not applied', async () => {
  for (const extra of [{ issuer: ATTACKER }, { claimIssuer: ATTACKER }, { verificationIssuer: ATTACKER }]) {
    const { text } = attackerSignedIssuerManifest();
    const result = await verifyReceivedSovereignAsset(text, { ...validOptions(), ...extra });
    assert.deepEqual(result.reasons, ['INVALID_OPTIONS']);
  }
});

// 4. Missing, mismatched or unresolved bindings fail closed.

test('SOBE-SEC-01: missing, mismatched and unresolved bindings fail closed', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(signedManifest({ sovereignAssetId, contentIdentity: undefined }))] });
  const cases: ReadonlyArray<readonly [string, ReceiverVerificationKeyResolver, string]> = [
    ['unresolved issuer', trustingResolver({}), 'ISSUER_BINDING_UNVERIFIED'],
    ['descriptor without key id', { resolveVerificationKey: (issuer) => ({ issuer } as never) }, 'ISSUER_BINDING_UNVERIFIED'],
    ['descriptor for another issuer', { resolveVerificationKey: () => ({ keyId: issuerKeys.signingKey.keyId, issuer: ATTACKER }) }, 'ISSUER_BINDING_MISMATCH'],
    ['descriptor with another key', { resolveVerificationKey: (issuer) => ({ keyId: attackerKeys.signingKey.keyId, issuer }) }, 'ISSUER_BINDING_UNVERIFIED'],
    ['unsupported algorithm', { resolveVerificationKey: (issuer) => ({ keyId: issuerKeys.signingKey.keyId, issuer, algorithm: 'rsa' }) }, 'ISSUER_BINDING_UNVERIFIED'],
    ['resolver failure', { resolveVerificationKey: () => { throw new Error('unavailable'); } }, 'KEY_RESOLVER_FAILED'],
  ];
  for (const [label, verificationKeyResolver, reason] of cases) {
    const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver, consumerSupport: manifestOnlySupport() });
    assert.equal(result.outcome, 'rejected', label);
    assert.ok((result.reasons as readonly string[]).includes(reason), `${label}: expected ${reason}, got ${JSON.stringify(result.reasons)}`);
  }
});

// 5. `issuerBinding: not_performed` is never accepted as verified.

test('SOBE-SEC-01: Protocol reports a principal-reference registrant as valid with the binding not performed; the receiver rejects it', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: undefined, registrant: { id: ISSUER } as never });
  const protocol = await verifySovereignManifest(manifest, { verificationKeyResolver: trustingResolver() });
  assert.equal(protocol.valid, true, 'precondition: Protocol alone does not fail this case');
  assert.equal(protocol.checks.issuerBinding, 'not_performed');

  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)] });
  const result = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(), consumerSupport: manifestOnlySupport() });
  assert.deepEqual(result.reasons, ['ISSUER_BINDING_NOT_PERFORMED']);

  // Naming the expected issuer lets the binding actually be performed.
  const narrowed = await verifyReceivedSovereignAsset(text, { verificationKeyResolver: trustingResolver(), consumerSupport: manifestOnlySupport(), expectedIssuer: ISSUER });
  assert.equal(narrowed.outcome, 'verified', JSON.stringify(narrowed.reasons));
});

test('SOBE-SEC-01: Protocol reports no resolver as valid with the binding not performed; the receiver cannot be called that way', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: undefined });
  const protocol = await verifySovereignManifest(manifest);
  assert.equal(protocol.valid, true);
  assert.equal(protocol.checks.issuerBinding, 'not_performed');

  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)] });
  const result = await verifyReceivedSovereignAsset(text, { consumerSupport: manifestOnlySupport() });
  assert.deepEqual(result.reasons, ['INVALID_OPTIONS']);
});
