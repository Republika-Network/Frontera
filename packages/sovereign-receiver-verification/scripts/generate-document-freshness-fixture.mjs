#!/usr/bin/env node
// FV-P4C-2A — generates the synthetic document and signed status chain that the durable status history's end-to-end test
// (tests/fv-p4c2a-sqlite-status-history.e2e.test.mjs) runs through FV-P2, FV-P3 and the FV-P4C freshness gate. It runs
// here, inside the receiver package, because this is the one place the package-scoped Protocol allowance admits the
// licensing builders and the signing primitives.
//
// Keys are generated in memory for this run only. Their private halves are never written: the fixture holds the signed
// bundle, the signed statuses, the registrant's identity and key id, and nothing that can sign.
//
// Usage (after `npm run build`): node packages/sovereign-receiver-verification/scripts/generate-document-freshness-fixture.mjs <output.json>
import { writeFileSync } from 'node:fs';

import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';
import { SovereignLicenseTermsAudienceKind, SovereignLicenseTermsRuleEffect, buildLicenseTermsClaim } from '@aoc/protocol/licensing';
import { buildSovereignManifestV1, generateSovereignKeyPair, signClaim, signSovereignManifest, signSovereignPayload } from '@aoc/protocol/manifest';
import { buildSovereigntyPortabilityBundleV1, serializeSovereigntyPortabilityBundle } from '@aoc/protocol/portability';

import { SOVEREIGN_STATUS_PROFILE, SOVEREIGN_STATUS_PURPOSE, verifyDocumentUseEligibility, verifySovereignStatus } from '../dist/index.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: generate-document-freshness-fixture.mjs <output.json>');

const REGISTRANT = 'did:example:fv-p4c2a-registrant';
const RECEIVER = 'did:example:fv-p4c2a-receiver';
const SIGNED_AT = new Date('2026-01-01T00:00:00.000Z');
const keys = generateSovereignKeyPair();

const sovereignAssetId = mintSovereignAssetId();
const content = new TextEncoder().encode('# FV-P4C-2A synthetic document\n\n> SYNTHETIC TEST DOCUMENT. Not a real agreement.\n');
const rule = (id, effect, namespace, termRef) => ({ id, effect, action: { namespace, termRef }, statement: `Synthetic rule ${id}.` });
const terms = buildLicenseTermsClaim({
  id: 'claim:fv-p4c2a-terms-1',
  sovereignAssetId,
  issuer: REGISTRANT,
  statement: 'Usage terms for a synthetic document.',
  audience: { kind: SovereignLicenseTermsAudienceKind.Principal, principal: RECEIVER },
  rules: [
    rule('rule-access', SovereignLicenseTermsRuleEffect.Permission, 'aoc.licensing', 'aoc.licensing:access'),
    rule('rule-export', SovereignLicenseTermsRuleEffect.Restriction, 'soberania.document', 'soberania.document:export'),
  ],
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
});
const signedTerms = signClaim(terms, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
const manifest = signSovereignManifest(
  buildSovereignManifestV1({ sovereignAssetId, registrant: REGISTRANT, contentIdentity: computeContentIdentity(content) }, SIGNED_AT),
  keys.privateKeyPem,
  keys.signingKey,
  SIGNED_AT,
);
const bundleText = serializeSovereigntyPortabilityBundle(
  buildSovereigntyPortabilityBundleV1({
    subject: { sovereignAssetId },
    manifests: [{ kind: 'signed-manifest', signedManifest: manifest }],
    claims: [{ kind: 'signed-claim', signedClaim: signedTerms }],
  }),
);

const termsRef = { claimId: terms.id, claimDigest: signedTerms.digest };
const otherTerms = { claimId: 'claim:fv-p4c2a-terms-2', claimDigest: 'b'.repeat(64) };

/** aoc-canonical-json/1 for the JSON-safe values of a status envelope. */
const canonical = (value) =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;

function status(sequence, previous, issuedAt, overrides = {}) {
  const payload = {
    schemaVersion: SOVEREIGN_STATUS_PROFILE,
    purpose: SOVEREIGN_STATUS_PURPOSE,
    sovereignAssetId,
    issuer: REGISTRANT,
    manifestDigest: manifest.manifestDigest,
    assetStatus: 'active',
    currentTerms: { ...termsRef },
    sequence,
    previousStatusDigest: previous === null ? null : previous.digest,
    issuedAt,
    validUntil: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
  const proof = signSovereignPayload(payload, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
  return { text: canonical({ status: payload, proof }), digest: proof.payloadHash, sequence };
}

// One history: active (1) → withdrawn (2); then an equivocating active 2, and an active 3 that would reopen the withdrawal.
const active1 = status(1, null, '2026-10-28T11:50:00.000000001Z');
const withdrawn2 = status(2, active1, '2026-10-28T11:55:00Z', { assetStatus: 'withdrawn', currentTerms: null });
const equivocating2 = status(2, active1, '2026-10-28T11:56:00Z');
const reopening3 = status(3, withdrawn2, '2026-10-28T11:58:00Z');
// Another history of the same asset (kept in its own store file): the terms are superseded, then revived.
const superseding2 = status(2, active1, '2026-10-28T11:55:00Z', { currentTerms: { ...otherTerms } });
const reviving3 = status(3, superseding2, '2026-10-28T11:58:00Z');

const fixture = {
  format: 'frontera.fv-p4c2a-document-freshness-fixture.v1',
  note: 'Synthetic, test-only. Signed with keys generated for one run; no private key was written. Not an operational asset.',
  registrant: { issuer: REGISTRANT, keyId: keys.signingKey.keyId },
  receiver: RECEIVER,
  sovereignAssetId,
  bundleText,
  contentBase64: Buffer.from(content).toString('base64'),
  manifestDigest: manifest.manifestDigest,
  terms: termsRef,
  statuses: { active1, withdrawn2, equivocating2, reopening3, superseding2, reviving3 },
};

// Self-check before anything is written: the document is eligible and every status verifies.
const resolver = { resolveVerificationKey: (issuer) => (issuer === REGISTRANT ? { keyId: keys.signingKey.keyId, issuer, algorithm: 'ed25519' } : undefined) };
const eligibility = await verifyDocumentUseEligibility(bundleText, { verificationKeyResolver: resolver, expectedSovereignAssetId: sovereignAssetId, contentBytes: content });
if (eligibility.outcome !== 'eligible_for_evaluation') throw new Error(`fixture document is not eligible: ${eligibility.reasons.join(', ')}`);
for (const [name, entry] of Object.entries(fixture.statuses)) {
  const result = await verifySovereignStatus(entry.text, {
    verificationKeyResolver: resolver,
    expectedSovereignAssetId: sovereignAssetId,
    expectedRegistrant: REGISTRANT,
    expectedManifestDigest: manifest.manifestDigest,
    evaluationTime: '2026-10-28T12:00:00Z',
  });
  if (result.outcome !== 'authentic_authorized') throw new Error(`fixture status ${name} does not verify: ${result.reason}`);
}

writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`wrote ${output}\n`);
