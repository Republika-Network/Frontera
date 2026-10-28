#!/usr/bin/env node
// RSDK-02B — generates the synthetic sovereign-asset fixture the governed receiver's integration test verifies with
// RSDK-01 itself (tests/rsdk02-governed-receiver.e2e.test.mjs). It runs here, inside the RSDK-01 package, because this
// is the one place the package-scoped Protocol allowance admits the signing primitives.
//
// Keys are generated in memory for this run only. Their private halves are never written: the fixture holds signed
// bundles, the registrants' identities and key ids, and the consumer-support declaration — nothing that can sign.
//
// Usage (after `npm run build`): node packages/sovereign-receiver-verification/scripts/generate-governed-receiver-fixture.mjs <output.json>
import { writeFileSync } from 'node:fs';

import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';
import {
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID,
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION,
  AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE,
  buildSovereigntyInteroperabilityConsumerSupportV1,
} from '@aoc/protocol/interoperability';
import { buildOriginClaim, buildSovereignManifestV1, generateSovereignKeyPair, signClaim, signSovereignManifest } from '@aoc/protocol/manifest';
import { SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION, buildSovereigntyPortabilityBundleV1, serializeSovereigntyPortabilityBundle } from '@aoc/protocol/portability';

import { verifyReceivedSovereignAsset } from '../dist/index.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: generate-governed-receiver-fixture.mjs <output.json>');

const REGISTRANT = 'did:example:rsdk02-registrant';
const FOREIGN = 'did:example:rsdk02-foreign';
const SIGNED_AT = new Date('2026-01-01T00:00:00.000Z');
const registrantKeys = generateSovereignKeyPair();
const foreignKeys = generateSovereignKeyPair();

const consumerSupport = buildSovereigntyInteroperabilityConsumerSupportV1({
  profile: { id: AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID, acceptedVersions: [AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION] },
  mediaTypes: [AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE],
  representationSchemaVersions: [SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION],
  canonicalizationProfiles: ['aoc-canonical-json/1'],
  artifactKinds: ['signed-manifest', 'signed-claim'],
  claimTypes: ['Origin'],
  standingStatuses: [],
});

/** One signed asset: a manifest by the registrant in `state`, committing to `content`, and one origin claim by `claimIssuer`. */
function asset(name, state, claimIssuer = REGISTRANT) {
  const sovereignAssetId = mintSovereignAssetId();
  const content = new TextEncoder().encode(`rsdk02 synthetic content: ${name}`);
  const manifest = buildSovereignManifestV1({ sovereignAssetId, registrant: REGISTRANT, contentIdentity: computeContentIdentity(content), state }, SIGNED_AT);
  const signedManifest = signSovereignManifest(manifest, registrantKeys.privateKeyPem, registrantKeys.signingKey, SIGNED_AT);
  const claimKeys = claimIssuer === REGISTRANT ? registrantKeys : foreignKeys;
  const claim = buildOriginClaim({ id: `claim-origin-${name}`, sovereignAssetId, issuer: claimIssuer, assertedOrigin: 'synthetic fixture', assertedAt: '2026-01-01T00:00:00.000Z' });
  const signedClaim = signClaim(claim, claimKeys.privateKeyPem, claimKeys.signingKey, SIGNED_AT);
  const bundleText = serializeSovereigntyPortabilityBundle(
    buildSovereigntyPortabilityBundleV1({
      subject: { sovereignAssetId },
      manifests: [{ kind: 'signed-manifest', signedManifest }],
      claims: [{ kind: 'signed-claim', signedClaim }],
    }),
  );
  return { sovereignAssetId, bundleText, contentBase64: Buffer.from(content).toString('base64') };
}

const fixture = {
  format: 'frontera.rsdk02-governed-receiver-fixture.v1',
  note: 'Synthetic, test-only. Signed with keys generated for one run; no private key was written. Not an operational asset.',
  registrant: { issuer: REGISTRANT, keyId: registrantKeys.signingKey.keyId },
  foreign: { issuer: FOREIGN, keyId: foreignKeys.signingKey.keyId },
  consumerSupport,
  assets: {
    active: asset('active', 'active'),
    withdrawn: asset('withdrawn', 'withdrawn'),
    foreignClaim: asset('foreign-claim', 'active', FOREIGN),
  },
};

// Self-check with RSDK-01 before anything is written: every bundle verifies under a resolver that trusts both issuers.
const trusted = { [REGISTRANT]: fixture.registrant.keyId, [FOREIGN]: fixture.foreign.keyId };
const resolver = { resolveVerificationKey: (issuer) => (trusted[issuer] ? { keyId: trusted[issuer], issuer, algorithm: 'ed25519' } : undefined) };
for (const [name, entry] of Object.entries(fixture.assets)) {
  const result = await verifyReceivedSovereignAsset(entry.bundleText, {
    verificationKeyResolver: resolver,
    consumerSupport,
    expectedSovereignAssetId: entry.sovereignAssetId,
    contentBytes: new Uint8Array(Buffer.from(entry.contentBase64, 'base64')),
  });
  if (result.outcome !== 'verified') throw new Error(`fixture ${name} does not verify: ${result.reasons.join(', ')}`);
}

writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`wrote ${output}\n`);
