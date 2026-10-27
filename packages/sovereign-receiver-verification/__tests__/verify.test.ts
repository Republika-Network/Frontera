import test from 'node:test';
import assert from 'node:assert/strict';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { contestClaim } from '@aoc/protocol/manifest';
import { buildSovereigntyPortabilityBundleV1, serializeSovereigntyPortabilityBundle } from '@aoc/protocol/portability';

import { RECEIVER_VERIFICATION_REJECTION_REASONS, STRICT_RECEIVER_PROFILE, verifyReceivedSovereignAsset } from '../src/index.js';
import type { ReceivedSovereignAssetVerificationResult, ReceiverVerificationRejectionReason } from '../src/index.js';
import {
  CONTENT,
  ISSUER,
  claimArtifact,
  consumerSupport,
  editBundleJson,
  manifestArtifact,
  originClaim,
  serialize,
  signedManifest,
  signedOriginClaim,
  trustingResolver,
  validFixture,
  validOptions,
} from './fixtures.js';

function assertRejected(
  result: ReceivedSovereignAssetVerificationResult,
  expected: readonly ReceiverVerificationRejectionReason[],
): void {
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.reasons, [...expected].sort());
  for (const reason of result.reasons) assert.ok(RECEIVER_VERIFICATION_REJECTION_REASONS.includes(reason), `unlisted reason ${reason}`);
  assertNotAuthorization(result);
}

function assertNotAuthorization(result: ReceivedSovereignAssetVerificationResult): void {
  assert.equal(result.profile, STRICT_RECEIVER_PROFILE);
  assert.equal(result.authorization, 'not_evaluated');
  assert.equal(result.revocation, 'not_evaluated');
  assert.equal(result.freshness, 'not_evaluated');
  for (const forbidden of ['allowed', 'authorized', 'granted', 'capability', 'decision', 'permit']) {
    assert.equal(forbidden in result, false, `result must not carry an authorization field "${forbidden}"`);
  }
}

// --- Valid signed representation ---------------------------------------------

test('a valid signed representation verifies, with evidence and no authorization', async () => {
  const fixture = validFixture();
  const result = await verifyReceivedSovereignAsset(fixture.text, validOptions({ expectedSovereignAssetId: fixture.sovereignAssetId }));
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  assertNotAuthorization(result);
  if (result.outcome !== 'verified') return;
  assert.equal(result.sovereignAssetId, fixture.sovereignAssetId);
  assert.equal(result.currentManifestVersion, 1);
  assert.equal(result.contentIdentity, 'verified');
  assert.equal(result.compatibility, 'compatible');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.manifests, [
    { manifestVersion: 1, manifestDigest: fixture.manifest.manifestDigest, issuer: ISSUER, keyId: fixture.manifest.proof.keyId },
  ]);
  assert.deepEqual(result.claims, [{ claimId: 'claim-origin-1', claimType: 'Origin', issuer: ISSUER, keyId: fixture.claim.proof.keyId }]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.manifests) && Object.isFrozen(result.manifests[0]));
});

test('a manifest without a content commitment verifies without content bytes', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: undefined });
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)] });
  const result = await verifyReceivedSovereignAsset(text, validOptions({ contentBytes: undefined, consumerSupport: consumerSupport({ claimTypes: [] }) }));
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  if (result.outcome === 'verified') assert.equal(result.contentIdentity, 'not_declared');
});

test('verification runs with the network unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('network access attempted');
  }) as typeof fetch;
  try {
    const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions());
    assert.equal(result.outcome, 'verified');
  } finally {
    globalThis.fetch = original;
  }
});

// --- Malformed input -----------------------------------------------------------

test('non-string bundle input is rejected', async () => {
  for (const input of [undefined, null, 42, {}, [], new String(validFixture().text), new TextEncoder().encode('{}')]) {
    assertRejected(await verifyReceivedSovereignAsset(input, validOptions()), ['INVALID_INPUT']);
  }
});

test('malformed JSON is rejected', async () => {
  for (const text of ['', '{', 'not json', '{"schemaVersion":']) {
    assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['BUNDLE_MALFORMED']);
  }
});

test('malformed option objects are rejected before the bundle is read', async () => {
  const text = validFixture().text;
  const cases: unknown[] = [
    undefined,
    null,
    'options',
    [],
    {},
    validOptions({ verificationKeyResolver: undefined }),
    validOptions({ verificationKeyResolver: {} }),
    validOptions({ verificationKeyResolver: { resolveVerificationKey: 'not a function' } }),
    validOptions({ consumerSupport: undefined }),
    validOptions({ expectedSovereignAssetId: 'not-a-sovereign-asset-id' }),
    validOptions({ expectedIssuer: '' }),
    validOptions({ expectedIssuer: 7 }),
    validOptions({ contentBytes: 'bytes' }),
    validOptions({ contentBytes: [1, 2, 3] }),
    // An unknown option is never silently ignored.
    validOptions({ allowUnsigned: true }),
    validOptions({ issuer: ISSUER }),
  ];
  for (const options of cases) {
    assertRejected(await verifyReceivedSovereignAsset(text, options), ['INVALID_OPTIONS']);
  }
});

test('an invalid consumer support declaration is rejected', async () => {
  const text = validFixture().text;
  for (const support of [{}, { ...consumerSupport(), schemaVersion: 'other/1' }, 'support']) {
    assertRejected(await verifyReceivedSovereignAsset(text, validOptions({ consumerSupport: support })), ['CONSUMER_SUPPORT_INVALID']);
  }
});

// --- Unsupported schema --------------------------------------------------------

test('an unsupported or future bundle schema is rejected', async () => {
  const text = editBundleJson(validFixture().text, (bundle) => {
    bundle['schemaVersion'] = 'aoc-sovereignty-portability-bundle/2';
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['BUNDLE_UNSUPPORTED_SCHEMA']);
});

test('an unsupported canonicalization profile is rejected', async () => {
  const text = editBundleJson(validFixture().text, (bundle) => {
    bundle['canonicalizationProfile'] = 'json-stable-stringify';
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['BUNDLE_UNSUPPORTED_CANONICALIZATION']);
});

test('an unknown artifact kind is rejected', async () => {
  const text = editBundleJson(validFixture().text, (bundle) => {
    (bundle['manifests'] as Record<string, unknown>[])[0]!['kind'] = 'detached-manifest';
  });
  const result = await verifyReceivedSovereignAsset(text, validOptions());
  assert.equal(result.outcome, 'rejected');
  assert.ok(result.reasons.includes('UNSUPPORTED_ARTIFACT_KIND'), JSON.stringify(result.reasons));
});

// --- Non-canonical representation ----------------------------------------------

test('a non-canonical representation of a valid bundle is rejected', async () => {
  const { text } = validFixture();
  const variants = [
    JSON.stringify(JSON.parse(text), null, 2),
    `${text}\n`,
    ` ${text}`,
    // Same members, envelope keys in a different order.
    (() => {
      const bundle = JSON.parse(text) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(bundle).reverse()));
    })(),
  ];
  for (const variant of variants) {
    assert.notEqual(variant, text);
    assertRejected(await verifyReceivedSovereignAsset(variant, validOptions()), ['BUNDLE_NOT_CANONICAL']);
  }
});

// --- Subject mismatch --------------------------------------------------------

test('a bundle about a different sovereign asset than expected is rejected', async () => {
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ expectedSovereignAssetId: mintSovereignAssetId() }));
  assertRejected(result, ['SUBJECT_MISMATCH']);
});

test('a manifest about another subject inside the bundle is rejected', async () => {
  const fixture = validFixture();
  const foreign = signedManifest({ sovereignAssetId: mintSovereignAssetId(), manifestVersion: 2 });
  const text = editBundleJson(fixture.text, (bundle) => {
    (bundle['manifests'] as unknown[]).push(manifestArtifact(foreign));
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['SUBJECT_MISMATCH']);
});

test('a claim about another subject inside the bundle is rejected', async () => {
  const fixture = validFixture();
  const foreign = signedOriginClaim(mintSovereignAssetId(), undefined, { id: 'claim-foreign' });
  const text = editBundleJson(fixture.text, (bundle) => {
    (bundle['claims'] as unknown[]).push(claimArtifact(foreign));
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['SUBJECT_MISMATCH']);
});

test('an invalid subject is rejected', async () => {
  const text = editBundleJson(validFixture().text, (bundle) => {
    bundle['subject'] = { sovereignAssetId: 'not-an-id' };
  });
  const result = await verifyReceivedSovereignAsset(text, validOptions());
  assert.equal(result.outcome, 'rejected');
  assert.ok(result.reasons.includes('SUBJECT_INVALID'), JSON.stringify(result.reasons));
});

// --- Manifest substitution, digest and signature --------------------------------

function bundleWith(sovereignAssetId: string, manifest: unknown): string {
  return serializeSovereigntyPortabilityBundle(
    buildSovereigntyPortabilityBundleV1({
      subject: { sovereignAssetId },
      manifests: [manifestArtifact(manifest as ReturnType<typeof signedManifest>)],
    }),
  );
}

const noClaims = () => validOptions({ consumerSupport: consumerSupport({ claimTypes: [], artifactKinds: ['signed-manifest'] }) });

test('a substituted manifest under the original digest and proof is rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const original = signedManifest({ sovereignAssetId });
  const substitute = signedManifest({ sovereignAssetId, registrant: 'did:example:someone-else' }).manifest;
  const text = bundleWith(sovereignAssetId, { ...original, manifest: substitute });
  // A key that did not produce a valid signature is bound to nothing.
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['ISSUER_BINDING_UNVERIFIED', 'MANIFEST_DIGEST_MISMATCH', 'MANIFEST_SIGNATURE_INVALID']);
});

test('a proof lifted from another manifest of the same issuer is rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const original = signedManifest({ sovereignAssetId });
  const other = signedManifest({ sovereignAssetId: mintSovereignAssetId() });
  const text = bundleWith(sovereignAssetId, { ...original, proof: other.proof });
  // A key that did not produce a valid signature is bound to nothing.
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['ISSUER_BINDING_UNVERIFIED', 'MANIFEST_DIGEST_MISMATCH', 'MANIFEST_SIGNATURE_INVALID']);
});

test('a manifest digest that does not match the manifest is rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const original = signedManifest({ sovereignAssetId });
  const text = bundleWith(sovereignAssetId, { ...original, manifestDigest: 'f'.repeat(64) });
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['MANIFEST_DIGEST_MISMATCH']);
});

test('an invalid manifest signature is rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const original = signedManifest({ sovereignAssetId });
  const signature = original.proof.signature;
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  const text = bundleWith(sovereignAssetId, { ...original, proof: { ...original.proof, signature: flipped } });
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['ISSUER_BINDING_UNVERIFIED', 'MANIFEST_SIGNATURE_INVALID']);
});

test('an unsigned manifest is rejected in the strict profile', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const signed = signedManifest({ sovereignAssetId });
  const unsigned = signedManifest({ sovereignAssetId, manifestVersion: 2 }).manifest;
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(signed), { kind: 'manifest', manifest: unsigned }] });
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['UNSIGNED_MANIFEST']);
});

test('a bundle with no signed manifest is rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({ subject: { sovereignAssetId }, claims: [claimArtifact(signedOriginClaim(sovereignAssetId))] });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['NO_SIGNED_MANIFEST']);
});

test('an untrusted signing key is rejected', async () => {
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ verificationKeyResolver: trustingResolver({}) }));
  assertRejected(result, ['ISSUER_BINDING_UNVERIFIED']);
});

// --- Duplicate versions and referenced claims -------------------------------------

test('duplicate manifest versions are rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const first = signedManifest({ sovereignAssetId });
  const second = signedManifest({ sovereignAssetId, registrant: 'did:example:second' });
  const text = editBundleJson(bundleWith(sovereignAssetId, first), (bundle) => {
    (bundle['manifests'] as unknown[]).push(manifestArtifact(second));
  });
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['DUPLICATE_MANIFEST_VERSION']);
});

test('duplicate claim ids are rejected', async () => {
  const fixture = validFixture();
  const text = editBundleJson(fixture.text, (bundle) => {
    (bundle['claims'] as unknown[]).push(claimArtifact(fixture.claim));
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['DUPLICATE_CLAIM_ID']);
});

test('a standing that references a claim missing from the bundle is rejected', async () => {
  const fixture = validFixture();
  const standing = contestClaim({ id: 'standing-1', claimRef: 'claim-not-in-bundle', reason: 'disputed', effectiveAt: '2026-01-02T00:00:00.000Z' });
  const text = editBundleJson(fixture.text, (bundle) => {
    bundle['standings'] = [standing];
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['MISSING_REFERENCED_CLAIM']);
});

test('an unsigned standing is rejected even when its claim is present', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const claim = signedOriginClaim(sovereignAssetId);
  const standing = contestClaim({ id: 'standing-1', claimRef: claim.claim.id, reason: 'disputed', effectiveAt: '2026-01-02T00:00:00.000Z' });
  const text = serialize({
    subject: { sovereignAssetId },
    manifests: [manifestArtifact(signedManifest({ sovereignAssetId }))],
    claims: [claimArtifact(claim)],
    standings: [standing],
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['UNVERIFIABLE_STANDING']);
});

// --- Content identity -------------------------------------------------------------

test('content bytes that do not match the declared content identity are rejected', async () => {
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ contentBytes: new TextEncoder().encode('other bytes') }));
  assertRejected(result, ['CONTENT_DIGEST_MISMATCH']);
});

test('missing content bytes are rejected when the manifest commits to content', async () => {
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ contentBytes: undefined }));
  assertRejected(result, ['CONTENT_BYTES_REQUIRED']);
});

test('content bytes are rejected when no content identity is declared to check them against', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundleWith(sovereignAssetId, signedManifest({ sovereignAssetId, contentIdentity: undefined }));
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['CONTENT_IDENTITY_NOT_DECLARED']);
});

test('content is checked against the current manifest version', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const v1 = signedManifest({ sovereignAssetId });
  const v2 = signedManifest({ sovereignAssetId, manifestVersion: 2, contentIdentity: { algorithm: 'sha256', digest: 'a'.repeat(64) } });
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(v1), manifestArtifact(v2)] });
  // CONTENT matches v1 only; v2 is current.
  assertRejected(await verifyReceivedSovereignAsset(text, noClaims()), ['CONTENT_DIGEST_MISMATCH']);
});

test('the bytes verified are a private copy the caller cannot change mid-verification', async () => {
  const bytes = Uint8Array.from(CONTENT);
  const inner = trustingResolver();
  const resolver = {
    resolveVerificationKey(issuer: string) {
      bytes.fill(0);
      return inner.resolveVerificationKey(issuer);
    },
  };
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ contentBytes: bytes, verificationKeyResolver: resolver }));
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
});

// --- Claims ------------------------------------------------------------------------

test('an unsigned claim is rejected in the strict profile', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = serialize({
    subject: { sovereignAssetId },
    manifests: [manifestArtifact(signedManifest({ sovereignAssetId }))],
    claims: [{ kind: 'claim', claim: originClaim(sovereignAssetId) }],
  });
  const result = await verifyReceivedSovereignAsset(text, validOptions({ consumerSupport: consumerSupport({ artifactKinds: ['signed-manifest', 'claim'] }) }));
  assertRejected(result, ['UNSIGNED_CLAIM']);
});

test('a claim whose digest was tampered is rejected', async () => {
  const fixture = validFixture();
  const text = editBundleJson(fixture.text, (bundle) => {
    const artifact = (bundle['claims'] as Record<string, Record<string, unknown>>[])[0]!;
    artifact['signedClaim'] = { ...artifact['signedClaim'], digest: '0'.repeat(64) };
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['CLAIM_DIGEST_MISMATCH']);
});

test('a claim whose content was changed after signing is rejected', async () => {
  const fixture = validFixture();
  const text = editBundleJson(fixture.text, (bundle) => {
    const artifact = (bundle['claims'] as Record<string, Record<string, Record<string, unknown>>>[])[0]!;
    const claim = artifact['signedClaim']!['claim']!;
    claim['metadata'] = { assertedOrigin: 'a different origin' };
  });
  const result = await verifyReceivedSovereignAsset(text, validOptions());
  assert.equal(result.outcome, 'rejected');
  assert.ok(result.reasons.includes('CLAIM_SIGNATURE_INVALID'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('CLAIM_DIGEST_MISMATCH'), JSON.stringify(result.reasons));
});

test('a claim with an invalid signature is rejected', async () => {
  const fixture = validFixture();
  const text = editBundleJson(fixture.text, (bundle) => {
    const artifact = (bundle['claims'] as Record<string, Record<string, Record<string, unknown>>>[])[0]!;
    const proof = artifact['signedClaim']!['proof']!;
    const signature = proof['signature'] as string;
    proof['signature'] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['CLAIM_SIGNATURE_INVALID', 'ISSUER_BINDING_UNVERIFIED']);
});

// --- Interoperability ------------------------------------------------------------

test('partial interoperability is rejected', async () => {
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ consumerSupport: consumerSupport({ claimTypes: [] }) }));
  assertRejected(result, ['INTEROPERABILITY_PARTIAL']);
});

test('an artifact kind the receiver does not support is partial and rejected', async () => {
  const support = consumerSupport({ artifactKinds: ['signed-manifest'] });
  assertRejected(await verifyReceivedSovereignAsset(validFixture().text, validOptions({ consumerSupport: support })), ['INTEROPERABILITY_PARTIAL']);
});

test('unsupported semantics carried by a signed claim are rejected', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const claim = signedOriginClaim(sovereignAssetId, undefined, {
    semanticRefs: [{ id: 'semantic-1', namespace: 'example.untrusted', termRef: 'example.untrusted:elevated-rights' }],
  });
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(signedManifest({ sovereignAssetId }))], claims: [claimArtifact(claim)] });
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['INTEROPERABILITY_PARTIAL']);
});

test('incompatible interoperability is rejected', async () => {
  const cases = [
    consumerSupport({ mediaTypes: ['application/json'] }),
    consumerSupport({ profile: { id: 'example:other-profile', acceptedVersions: ['1.0.0'] } }),
    consumerSupport({ representationSchemaVersions: ['aoc-sovereignty-portability-bundle/2'] }),
  ];
  for (const support of cases) {
    assertRejected(await verifyReceivedSovereignAsset(validFixture().text, validOptions({ consumerSupport: support })), ['INTEROPERABILITY_INCOMPATIBLE']);
  }
});

// --- Resolver failures -------------------------------------------------------------

test('a resolver that throws or rejects fails closed', async () => {
  const resolvers = [
    { resolveVerificationKey: () => { throw new Error('resolver down'); } },
    { resolveVerificationKey: () => Promise.reject(new Error('resolver down')) },
    { resolveVerificationKey: () => ({ then: () => { throw new Error('hostile thenable'); } }) },
  ];
  for (const verificationKeyResolver of resolvers) {
    const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ verificationKeyResolver }));
    assertRejected(result, ['KEY_RESOLVER_FAILED']);
  }
});

test('a resolver answering with malformed or hostile descriptors fails closed', async () => {
  const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
  const descriptors: unknown[] = [null, 'key', 42, {}, { keyId: '' }];
  for (const descriptor of descriptors) {
    const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ verificationKeyResolver: { resolveVerificationKey: () => descriptor } }));
    assertRejected(result, ['ISSUER_BINDING_UNVERIFIED']);
  }
  // Awaiting the proxy reads its `then`, so the trap fires while resolving.
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ verificationKeyResolver: { resolveVerificationKey: () => hostile } }));
  assertRejected(result, ['KEY_RESOLVER_FAILED']);
});
