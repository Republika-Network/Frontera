// RSDK-01B: registrant continuity, manifest lifecycle state and unverified
// standings, as observed through the receiver API.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { contestClaim } from '@aoc/protocol/manifest';
import type { SignedSovereignManifest } from '@aoc/protocol/manifest';

import { verifyReceivedSovereignAsset } from '../src/index.js';
import type { ReceivedSovereignAssetVerificationResult, ReceivedSovereignAssetVerified } from '../src/index.js';
import {
  ATTACKER,
  ISSUER,
  attackerKeys,
  claimArtifact,
  consumerSupport,
  editBundleJson,
  issuerKeys,
  manifestArtifact,
  serialize,
  signedManifest,
  signedOriginClaim,
  trustingResolver,
  validOptions,
} from './fixtures.js';
import type { ManifestOverrides, ResolverCall } from './fixtures.js';

const bothTrusted = (calls: ResolverCall[] = []) => trustingResolver({ [ISSUER]: issuerKeys, [ATTACKER]: attackerKeys }, calls);

const manifestOnly = (overrides: Record<string, unknown> = {}) =>
  ({ consumerSupport: consumerSupport({ claimTypes: [] }), contentBytes: undefined, ...overrides });

function manifestVersion(sovereignAssetId: string, version: number, overrides: Partial<ManifestOverrides> = {}, keys = issuerKeys): SignedSovereignManifest {
  return signedManifest({ sovereignAssetId, manifestVersion: version, contentIdentity: undefined, ...overrides }, keys);
}

function bundleOf(sovereignAssetId: string, ...manifests: SignedSovereignManifest[]): string {
  return serialize({ subject: { sovereignAssetId }, manifests: manifests.map(manifestArtifact) });
}

function assertVerified(result: ReceivedSovereignAssetVerificationResult): ReceivedSovereignAssetVerified {
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  assertNoEligibilityClaim(result);
  return result as ReceivedSovereignAssetVerified;
}

function assertRejected(result: ReceivedSovereignAssetVerificationResult, reasons: readonly string[]): void {
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.reasons, [...reasons].sort());
  assertNoEligibilityClaim(result);
}

/** No result, of either outcome, claims authorization, usability or eligibility. */
function assertNoEligibilityClaim(result: ReceivedSovereignAssetVerificationResult): void {
  assert.equal(result.authorization, 'not_evaluated');
  assert.equal(result.revocation, 'not_evaluated');
  assert.equal(result.freshness, 'not_evaluated');
  for (const forbidden of ['allowed', 'authorized', 'granted', 'capability', 'decision', 'permit', 'usable', 'eligible', 'releasable', 'latest']) {
    assert.equal(forbidden in result, false, `result must not carry "${forbidden}"`);
  }
}

// --- Phase 1: registrant continuity -------------------------------------------

test('one issuer across several manifest versions verifies, with the bound issuer as current issuer', async () => {
  const id = mintSovereignAssetId();
  const text = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2), manifestVersion(id, 3));
  const result = assertVerified(await verifyReceivedSovereignAsset(text, validOptions(manifestOnly())));
  assert.equal(result.currentManifestVersion, 3);
  assert.equal(result.currentIssuer, ISSUER);
  assert.deepEqual(result.manifests.map((m) => [m.manifestVersion, m.issuer]), [[1, ISSUER], [2, ISSUER], [3, ISSUER]]);
});

test('a later version signed by a different, trusted issuer is rejected before any key is resolved', async () => {
  const id = mintSovereignAssetId();
  const calls: ResolverCall[] = [];
  const text = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2, { registrant: ATTACKER }, attackerKeys));
  const result = await verifyReceivedSovereignAsset(text, validOptions(manifestOnly({ verificationKeyResolver: bothTrusted(calls) })));
  assertRejected(result, ['REGISTRANT_DISCONTINUITY']);
  assert.deepEqual(calls, [], 'a newer valid signature is not consulted, let alone trusted');
});

test('a later version from a different, untrusted issuer is rejected', async () => {
  const id = mintSovereignAssetId();
  const text = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2, { registrant: ATTACKER }, attackerKeys));
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions(manifestOnly())), ['REGISTRANT_DISCONTINUITY']);
});

test('an earlier version from a different issuer is rejected too: continuity has no direction', async () => {
  const id = mintSovereignAssetId();
  const text = bundleOf(id, manifestVersion(id, 1, { registrant: ATTACKER }, attackerKeys), manifestVersion(id, 2));
  assertRejected(await verifyReceivedSovereignAsset(text, validOptions(manifestOnly({ verificationKeyResolver: bothTrusted() }))), [
    'REGISTRANT_DISCONTINUITY',
  ]);
});

test('correctly signed versions with inconsistent registrants are rejected, compared by canonical identity only', async () => {
  const id = mintSovereignAssetId();
  const sameLabel = { kind: 'Organization', displayName: 'Same Display Name' };
  // Different canonical ids that share a display label: discontinuous.
  const relabelled = bundleOf(
    id,
    manifestVersion(id, 1, { registrant: { id: ISSUER, ...sameLabel } as never }),
    manifestVersion(id, 2, { registrant: { id: ATTACKER, ...sameLabel } as never }, attackerKeys),
  );
  assertRejected(
    await verifyReceivedSovereignAsset(relabelled, validOptions(manifestOnly({ verificationKeyResolver: bothTrusted() }))),
    ['REGISTRANT_DISCONTINUITY'],
  );

  // The same canonical id with a different display label, and as a plain
  // string: one registrant identity, so continuous.
  const sameIdentity = bundleOf(
    id,
    manifestVersion(id, 1, { registrant: ISSUER }),
    manifestVersion(id, 2, { registrant: { id: ISSUER, kind: 'Organization', displayName: 'Old name' } as never }),
    manifestVersion(id, 3, { registrant: { id: ISSUER, kind: 'Organization', displayName: 'New name' } as never }),
  );
  const result = assertVerified(await verifyReceivedSovereignAsset(sameIdentity, validOptions(manifestOnly({ expectedIssuer: ISSUER }))));
  assert.equal(result.currentIssuer, ISSUER);
});

test('a caller-supplied expected issuer cannot override the signed registrant', async () => {
  const id = mintSovereignAssetId();
  const resolver = bothTrusted();

  // It cannot repair a discontinuous bundle in favour of either issuer.
  const mixed = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2, { registrant: ATTACKER }, attackerKeys));
  for (const expectedIssuer of [ISSUER, ATTACKER]) {
    assertRejected(
      await verifyReceivedSovereignAsset(mixed, validOptions(manifestOnly({ verificationKeyResolver: resolver, expectedIssuer }))),
      ['REGISTRANT_DISCONTINUITY'],
    );
  }

  // It cannot rename the signed issuer of a continuous bundle.
  const continuous = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2));
  assertRejected(
    await verifyReceivedSovereignAsset(continuous, validOptions(manifestOnly({ verificationKeyResolver: resolver, expectedIssuer: ATTACKER }))),
    ['ISSUER_BINDING_MISMATCH'],
  );

  // When it matches, the reported issuer is still the signed one.
  const result = assertVerified(await verifyReceivedSovereignAsset(continuous, validOptions(manifestOnly({ expectedIssuer: ISSUER }))));
  assert.equal(result.currentIssuer, ISSUER);
});

// --- Phase 2: lifecycle state ---------------------------------------------------

test('a valid active manifest reports its state', async () => {
  const id = mintSovereignAssetId();
  const result = assertVerified(await verifyReceivedSovereignAsset(bundleOf(id, manifestVersion(id, 1)), validOptions(manifestOnly())));
  assert.equal(result.currentState, 'active');
  assert.equal(result.manifests[0]?.state, 'active');
});

test('a withdrawn manifest verifies as authentic and is reported withdrawn, never active', async () => {
  const id = mintSovereignAssetId();
  const text = bundleOf(id, manifestVersion(id, 1, { state: 'withdrawn' }));
  const result = assertVerified(await verifyReceivedSovereignAsset(text, validOptions(manifestOnly())));
  assert.equal(result.currentState, 'withdrawn');
  assert.deepEqual(result.manifests.map((m) => m.state), ['withdrawn']);
  assert.equal(JSON.stringify(result).includes('"active"'), false, 'nothing in the result describes the asset as active');
});

test('a disputed current manifest is reported disputed', async () => {
  const id = mintSovereignAssetId();
  const result = assertVerified(await verifyReceivedSovereignAsset(bundleOf(id, manifestVersion(id, 1, { state: 'disputed' })), validOptions(manifestOnly())));
  assert.equal(result.currentState, 'disputed');
});

test('a highest-version manifest marked superseded is rejected before any key is resolved', async () => {
  const id = mintSovereignAssetId();
  const calls: ResolverCall[] = [];
  const alone = bundleOf(id, manifestVersion(id, 1, { state: 'superseded' }));
  assertRejected(
    await verifyReceivedSovereignAsset(alone, validOptions(manifestOnly({ verificationKeyResolver: trustingResolver(undefined, calls) }))),
    ['CURRENT_MANIFEST_SUPERSEDED'],
  );
  assert.deepEqual(calls, []);

  const latest = bundleOf(id, manifestVersion(id, 1), manifestVersion(id, 2, { state: 'superseded' }));
  assertRejected(await verifyReceivedSovereignAsset(latest, validOptions(manifestOnly())), ['CURRENT_MANIFEST_SUPERSEDED']);
});

test('lifecycle state is preserved per version in a multi-version result', async () => {
  const id = mintSovereignAssetId();
  const text = bundleOf(
    id,
    manifestVersion(id, 1, { state: 'superseded' }),
    manifestVersion(id, 2, { state: 'superseded' }),
    manifestVersion(id, 3, { state: 'withdrawn' }),
  );
  const result = assertVerified(await verifyReceivedSovereignAsset(text, validOptions(manifestOnly())));
  assert.deepEqual(result.manifests.map((m) => [m.manifestVersion, m.state]), [[1, 'superseded'], [2, 'superseded'], [3, 'withdrawn']]);
  assert.equal(result.currentManifestVersion, 3);
  assert.equal(result.currentState, 'withdrawn');
});

test('the highest version in a bundle is reported as such, not as the globally latest version', async () => {
  const id = mintSovereignAssetId();
  const v1 = manifestVersion(id, 1);
  // A newer v2 exists, but this bundle omits it: nothing here can tell.
  manifestVersion(id, 2);
  const result = assertVerified(await verifyReceivedSovereignAsset(bundleOf(id, v1), validOptions(manifestOnly())));
  assert.equal(result.currentManifestVersion, 1);
  assert.equal(result.currentManifestBasis, 'highest_version_in_bundle');
  assert.equal(result.freshness, 'not_evaluated');
});

// --- Phase 3: standings ---------------------------------------------------------

function withStanding(status?: string) {
  const id = mintSovereignAssetId();
  const claim = signedOriginClaim(id);
  const manifest = signedManifest({ sovereignAssetId: id });
  const standing = { ...contestClaim({ id: 'standing-1', claimRef: claim.claim.id, reason: 'disputed', effectiveAt: '2026-01-02T00:00:00.000Z' }), ...(status ? { status } : {}) };
  const base = { subject: { sovereignAssetId: id }, manifests: [manifestArtifact(manifest)], claims: [claimArtifact(claim)] };
  return { withStandings: serialize({ ...base, standings: [standing as never] }), without: serialize(base) };
}

/** Standings must be declared twice: as an artifact kind and per status (Protocol's compatibility rules). */
const standingSupport = (statuses: string[]) =>
  validOptions({
    consumerSupport: consumerSupport({ artifactKinds: ['signed-manifest', 'signed-claim', 'standing'], standingStatuses: statuses as never }),
  });

test('a bundle without standings reports none', async () => {
  const result = assertVerified(await verifyReceivedSovereignAsset(withStanding().without, validOptions()));
  assert.equal(result.standings, 'none');
});

test('present standings are reported unverified and change no verified evidence', async () => {
  for (const status of ['Contested', 'Verified', 'Active', 'Revoked']) {
    const { withStandings, without } = withStanding(status);
    const options = standingSupport([status]);
    const result = assertVerified(await verifyReceivedSovereignAsset(withStandings, options));
    const baseline = assertVerified(await verifyReceivedSovereignAsset(without, options));
    assert.equal(result.standings, 'present_unverified', status);
    // The claims and manifest evidence are exactly what the bundle without the
    // standing produces: a standing neither verifies, revokes nor reorders.
    const { standings: _s, ...withEvidence } = result;
    const { standings: _b, ...baseEvidence } = baseline;
    assert.deepEqual(withEvidence, baseEvidence, status);
    assert.equal(JSON.stringify(result.claims).includes('standing'), false);
  }
});

test('a standing cannot rescue an artifact that fails verification', async () => {
  const { withStandings } = withStanding('Verified');
  const result = await verifyReceivedSovereignAsset(withStandings, { ...standingSupport(['Verified']), verificationKeyResolver: trustingResolver({}) });
  assert.equal(result.outcome, 'rejected');
  assert.ok((result.reasons as readonly string[]).includes('ISSUER_BINDING_UNVERIFIED'), JSON.stringify(result.reasons));
});

test('standings the receiver did not declare support for are partial and rejected', async () => {
  const { withStandings } = withStanding('Contested');
  // Neither the standing kind nor the status declared.
  assertRejected(await verifyReceivedSovereignAsset(withStandings, validOptions()), ['INTEROPERABILITY_PARTIAL']);
  // The status declared but not the standing artifact kind.
  const statusOnly = validOptions({ consumerSupport: consumerSupport({ standingStatuses: ['Contested'] as never }) });
  assertRejected(await verifyReceivedSovereignAsset(withStandings, statusOnly), ['INTEROPERABILITY_PARTIAL']);
  // The kind declared but a different status.
  assertRejected(await verifyReceivedSovereignAsset(withStandings, standingSupport(['Revoked'])), ['INTEROPERABILITY_PARTIAL']);
});

test('malformed standings are rejected by Protocol\'s own standing rules', async () => {
  const { withStandings } = withStanding('Contested');
  const options = standingSupport(['Contested']);
  const edits: Record<string, (standing: Record<string, unknown>, bundle: Record<string, unknown>) => void> = {
    'unknown status': (s) => void (s['status'] = 'Adjudicated'),
    'missing effectiveAt': (s) => void delete s['effectiveAt'],
    'missing claimRef': (s) => void delete s['claimRef'],
    'non-string reason': (s) => void (s['reason'] = 7),
    'duplicate standing id': (s, b) => void (b['standings'] = [s, { ...s }]),
  };
  for (const [label, edit] of Object.entries(edits)) {
    const text = editBundleJson(withStandings, (bundle) => {
      const standing = (bundle['standings'] as Record<string, unknown>[])[0]!;
      edit(standing, bundle);
    });
    const result = await verifyReceivedSovereignAsset(text, options);
    assert.equal(result.outcome, 'rejected', label);
    assert.ok((result.reasons as readonly string[]).includes('STANDING_INVALID'), `${label}: ${JSON.stringify(result.reasons)}`);
  }
  const notArray = editBundleJson(withStandings, (bundle) => void (bundle['standings'] = {}));
  assert.ok(((await verifyReceivedSovereignAsset(notArray, options)).reasons as readonly string[]).includes('STANDING_INVALID'));
});
