import test from 'node:test';
import assert from 'node:assert/strict';

import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';
import {
  AOC_LICENSING_ACTION_TERM_IDS,
  SovereignLicenseTermsAudienceKind,
  SovereignLicenseTermsRuleEffect,
  buildLicenseTermsClaim,
} from '@aoc/protocol/licensing';
import type { LicenseTermsClaim, SovereignLicenseTermsRuleV1 } from '@aoc/protocol/licensing';
import { AuthorityClaimKind, SovereignAssetState, buildAuthorityClaim, generateSovereignKeyPair, signClaim } from '@aoc/protocol/manifest';
import type { SignedClaim, SignedSovereignManifest, SovereignKeyPair } from '@aoc/protocol/manifest';
import {
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID,
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION,
  AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE,
  buildSovereigntyInteroperabilityConsumerSupportV1,
} from '@aoc/protocol/interoperability';
import type { SovereigntyInteroperabilityConsumerSupportV1 } from '@aoc/protocol/interoperability';
import { SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION } from '@aoc/protocol/portability';
import type { PortableSovereignClaimArtifact } from '@aoc/protocol/portability';

import {
  DOCUMENT_USE_INELIGIBILITY_REASONS,
  DOCUMENT_USE_PROFILE,
  DOCUMENT_USE_RECEIVER_PROFILE,
  RECEIVER_VERIFICATION_REJECTION_REASONS,
  verifyDocumentUseEligibility,
  verifyReceivedSovereignAsset,
} from '../src/index.js';
import type { DocumentUseEligibilityResult, DocumentUseIneligibilityReason, DocumentUseIneligibilityStage } from '../src/index.js';
import { ATTACKER, ISSUER, SIGNED_AT, attackerKeys, issuerKeys, manifestArtifact, serialize, signedManifest, signedOriginClaim, trustingResolver } from './fixtures.js';

// FV-P2 fixtures. Everything is synthetic and generated per run with Protocol's
// own primitives; only public halves of keys reach a resolver.

const REGISTRANT = ISSUER;
const THIRD_PARTY = 'did:example:trusted-third-party';
const RECEIVER = 'did:example:receiver';
const thirdPartyKeys: SovereignKeyPair = generateSovereignKeyPair();
const DOCUMENT = new TextEncoder().encode('# Synthetic Agreement\n\n> SYNTHETIC TEST DOCUMENT. Not a real agreement.\n');
/** Trusts the registrant and, as itself only, a third party. */
const RESOLVER_KEYS = { [REGISTRANT]: issuerKeys, [THIRD_PARTY]: thirdPartyKeys };

const action = (namespace: string, termRef: string) => ({ namespace, termRef });
const ACCESS = action('aoc.licensing', AOC_LICENSING_ACTION_TERM_IDS.access);
const EXPORT = action('soberania.document', 'soberania.document:export');
const MODIFY = action('soberania.document', 'soberania.document:modify-protected-terms');
const APPROVAL = action('soberania.document', 'soberania.document:owner-approval.modify-protected-terms');

const PROFILE_RULES: readonly SovereignLicenseTermsRuleV1[] = [
  { id: 'rule-access', effect: SovereignLicenseTermsRuleEffect.Permission, action: ACCESS, statement: 'The receiver may read the document.' },
  { id: 'rule-export', effect: SovereignLicenseTermsRuleEffect.Restriction, action: EXPORT, statement: 'The receiver may not export the document.' },
  { id: 'rule-modify', effect: SovereignLicenseTermsRuleEffect.Permission, action: MODIFY, statement: 'The receiver may modify protected terms.' },
  { id: 'rule-approval', effect: SovereignLicenseTermsRuleEffect.Obligation, action: APPROVAL, statement: 'Owner approval is required first.' },
];

interface TermsInput {
  readonly sovereignAssetId: string;
  readonly issuer?: string;
  readonly id?: string;
  readonly rules?: readonly SovereignLicenseTermsRuleV1[];
  readonly expiresAt?: string;
}

function terms(input: TermsInput): LicenseTermsClaim {
  return buildLicenseTermsClaim({
    id: input.id ?? 'claim:terms-1',
    sovereignAssetId: input.sovereignAssetId,
    issuer: input.issuer ?? REGISTRANT,
    statement: 'Usage terms for a synthetic document.',
    audience: { kind: SovereignLicenseTermsAudienceKind.Principal, principal: RECEIVER },
    rules: input.rules ?? PROFILE_RULES,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: input.expiresAt ?? '2099-01-01T00:00:00.000Z',
  });
}

function sign<T extends LicenseTermsClaim>(claim: T, keys: SovereignKeyPair = issuerKeys): SignedClaim<T> {
  return signClaim(claim, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
}

// Terms and authority claims are portable Authorship claims; Protocol's portable union is narrower than SignedClaim.
const claimArtifact = (signed: SignedClaim): PortableSovereignClaimArtifact => ({ kind: 'signed-claim', signedClaim: signed } as PortableSovereignClaimArtifact);

function documentManifest(sovereignAssetId: string, overrides: Record<string, unknown> = {}, keys: SovereignKeyPair = issuerKeys): SignedSovereignManifest {
  return signedManifest({ sovereignAssetId, contentIdentity: computeContentIdentity(DOCUMENT), ...overrides }, keys);
}

function bundle(sovereignAssetId: string, claims: readonly SignedClaim[], manifest: SignedSovereignManifest = documentManifest(sovereignAssetId)): string {
  return serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)], claims: claims.map(claimArtifact) });
}

interface DocumentFixture {
  readonly sovereignAssetId: string;
  readonly signedTerms: SignedClaim<LicenseTermsClaim>;
  readonly text: string;
}

function validDocument(): DocumentFixture {
  const sovereignAssetId = mintSovereignAssetId();
  const signedTerms = sign(terms({ sovereignAssetId }));
  return { sovereignAssetId, signedTerms, text: bundle(sovereignAssetId, [signedTerms]) };
}

function options(sovereignAssetId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { verificationKeyResolver: trustingResolver(RESOLVER_KEYS), expectedSovereignAssetId: sovereignAssetId, contentBytes: DOCUMENT, ...overrides };
}

/** A resigned copy of the valid terms with `edit` applied to a plain copy of the claim. */
function resignedTerms(base: LicenseTermsClaim, edit: (claim: Record<string, unknown> & { metadata: { terms: { rules: unknown[] } } }) => void, keys = issuerKeys): SignedClaim<LicenseTermsClaim> {
  const claim = JSON.parse(JSON.stringify(base)) as Record<string, unknown> & { metadata: { terms: { rules: unknown[] } } };
  edit(claim);
  return signClaim(claim as unknown as LicenseTermsClaim, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
}

const DOCUMENT_CONSUMER_SUPPORT_TERMS = [
  'aoc.licensing:license-terms-declaration',
  'aoc.licensing:permission-rule',
  'aoc.licensing:restriction-rule',
  'aoc.licensing:obligation-rule',
  ACCESS.termRef,
  EXPORT.termRef,
  MODIFY.termRef,
  APPROVAL.termRef,
];

function assertNotDecision(result: DocumentUseEligibilityResult): void {
  assert.equal(result.profile, DOCUMENT_USE_RECEIVER_PROFILE);
  assert.equal(result.documentProfile, DOCUMENT_USE_PROFILE);
  for (const field of ['policyEvaluation', 'authorization', 'revocation', 'freshness', 'temporalValidity', 'audience'] as const) {
    assert.equal(result[field], 'not_evaluated', field);
  }
  for (const forbidden of ['allowed', 'authorized', 'granted', 'capability', 'decision', 'permit', 'verdict']) {
    assert.equal(forbidden in result, false, `result must not carry a decision field "${forbidden}"`);
  }
  assert.ok(Object.isFrozen(result));
}

function assertIneligible(result: DocumentUseEligibilityResult, stage: DocumentUseIneligibilityStage, expected: readonly DocumentUseIneligibilityReason[]): void {
  assert.equal(result.outcome, 'ineligible', JSON.stringify(result));
  if (result.outcome !== 'ineligible') return;
  assert.equal(result.stage, stage);
  assert.deepEqual(result.reasons, [...expected].sort());
  for (const reason of result.reasons) assert.ok(DOCUMENT_USE_INELIGIBILITY_REASONS.includes(reason), `unlisted reason ${reason}`);
  assertNotDecision(result);
}

// --- Eligible ----------------------------------------------------------------

test('the right asset with registrant-issued, well-formed terms is eligible for evaluation, and nothing more', async () => {
  const fixture = validDocument();
  const result = await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId));
  assert.equal(result.outcome, 'eligible_for_evaluation', JSON.stringify(result));
  assertNotDecision(result);
  if (result.outcome !== 'eligible_for_evaluation') return;
  assert.equal(result.artifactVerification, 'verified');
  assert.equal(result.sovereignAssetId, fixture.sovereignAssetId);
  assert.equal(result.registrant, REGISTRANT);
  assert.equal(result.terms.issuer, REGISTRANT);
  assert.equal(result.terms.claimId, 'claim:terms-1');
  assert.equal(result.terms.keyId, issuerKeys.signingKey.keyId);
  assert.equal(result.terms.claimDigest, fixture.signedTerms.digest);
  assert.equal(result.terms.expiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(result.terms.effectiveAt, null);
  assert.deepEqual(result.terms.audience, { kind: 'Principal', principal: RECEIVER });
  assert.deepEqual(result.terms.rules.map((rule) => [rule.effect, rule.action.termRef]), PROFILE_RULES.map((rule) => [rule.effect, rule.action.termRef]));
  assert.deepEqual(result.reasons, []);
});

test('the reason set extends RSDK-01 without dropping any of its reasons', () => {
  for (const reason of RECEIVER_VERIFICATION_REJECTION_REASONS) assert.ok(DOCUMENT_USE_INELIGIBILITY_REASONS.includes(reason), reason);
  assert.equal(new Set(DOCUMENT_USE_INELIGIBILITY_REASONS).size, DOCUMENT_USE_INELIGIBILITY_REASONS.length);
  assert.ok(Object.isFrozen(DOCUMENT_USE_INELIGIBILITY_REASONS));
});

// --- Asset identity --------------------------------------------------------------

test('the expected asset is mandatory, where RSDK-01 alone treats it as optional', async () => {
  const fixture = validDocument();
  const { expectedSovereignAssetId: _omitted, ...withoutExpected } = options(fixture.sovereignAssetId);
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, withoutExpected), 'options', ['EXPECTED_ASSET_REQUIRED']);
});

test('a correctly signed bundle for another asset is refused', async () => {
  const fixture = validDocument();
  const other = mintSovereignAssetId();
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, options(other)), 'artifact_verification', ['SUBJECT_MISMATCH']);
});

// --- Signer identity and authority -------------------------------------------------

test('an unknown signer naming the registrant is refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const forgedTerms = sign(terms({ sovereignAssetId }), attackerKeys);
  const text = bundle(sovereignAssetId, [forgedTerms], documentManifest(sovereignAssetId, {}, attackerKeys));
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'artifact_verification', ['ISSUER_BINDING_UNVERIFIED']);
});

test('terms signed by an untrusted principal under its own name are refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId, issuer: ATTACKER }), attackerKeys)]);
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'artifact_verification', ['ISSUER_BINDING_UNVERIFIED']);
});

test('a trusted third party without authority over the asset: RSDK-01 verifies it, eligibility refuses it', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId, issuer: THIRD_PARTY }), thirdPartyKeys)]);
  // The signature is valid and bound to a trusted key: authenticity holds...
  const verified = await verifyReceivedSovereignAsset(text, {
    verificationKeyResolver: trustingResolver(RESOLVER_KEYS),
    consumerSupport: documentConsumerSupport(),
    expectedSovereignAssetId: sovereignAssetId,
    contentBytes: DOCUMENT,
  });
  assert.equal(verified.outcome, 'verified', JSON.stringify(verified));
  // ...authority does not: only the verified registrant may declare the asset's terms.
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'eligibility', ['TERMS_ISSUER_NOT_REGISTRANT']);
});

test('third-party terms beside the registrant\'s terms are refused, never ignored', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const own = sign(terms({ sovereignAssetId }));
  const foreign = sign(terms({ sovereignAssetId, issuer: THIRD_PARTY, id: 'claim:terms-2' }), thirdPartyKeys);
  const result = await verifyDocumentUseEligibility(bundle(sovereignAssetId, [own, foreign]), options(sovereignAssetId));
  assertIneligible(result, 'eligibility', ['TERMS_AMBIGUOUS', 'TERMS_ISSUER_NOT_REGISTRANT']);
});

test('a resolver that fails during the terms authority check is a refusal, not a pass', async () => {
  const fixture = validDocument();
  const trusted = trustingResolver(RESOLVER_KEYS);
  let calls = 0;
  const flaky = {
    resolveVerificationKey(issuer: string) {
      calls += 1;
      // RSDK-01 resolves the manifest and the claim; the third lookup is the authority re-check.
      if (calls >= 3) throw new Error('resolver unavailable');
      return trusted.resolveVerificationKey(issuer);
    },
  };
  const result = await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId, { verificationKeyResolver: flaky }));
  assertIneligible(result, 'eligibility', ['KEY_RESOLVER_FAILED']);
  assert.equal(calls, 3);
});

// --- Terms structure, presence and uniqueness --------------------------------------

test('a claim signed by the registrant with a malformed terms document is refused (RSDK-01 alone verifies it)', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const malformed = resignedTerms(terms({ sovereignAssetId }), (claim) => { claim.metadata.terms.rules = []; });
  const text = bundle(sovereignAssetId, [malformed]);
  const verified = await verifyReceivedSovereignAsset(text, {
    verificationKeyResolver: trustingResolver(RESOLVER_KEYS),
    consumerSupport: documentConsumerSupport(),
    expectedSovereignAssetId: sovereignAssetId,
    contentBytes: DOCUMENT,
  });
  assert.equal(verified.outcome, 'verified', JSON.stringify(verified));
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'eligibility', ['TERMS_STRUCTURE_INVALID']);
});

test('a terms rule with an effect outside Protocol\'s closed set is refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const malformed = resignedTerms(terms({ sovereignAssetId }), (claim) => {
    (claim.metadata.terms.rules[0] as Record<string, unknown>)['effect'] = 'Allow';
  });
  assertIneligible(await verifyDocumentUseEligibility(bundle(sovereignAssetId, [malformed]), options(sovereignAssetId)), 'eligibility', ['TERMS_STRUCTURE_INVALID']);
});

test('a registrant-signed rule naming a concept outside the profile, with stale semantic refs, is refused', async () => {
  // The semantic refs still list only profile concepts, so the compatibility
  // declaration passes, and rc.3's validateLicenseTermsClaim accepts the claim:
  // only the profile's own concept table catches the smuggled action.
  const sovereignAssetId = mintSovereignAssetId();
  const smuggled = resignedTerms(terms({ sovereignAssetId }), (claim) => {
    (claim.metadata.terms.rules[0] as Record<string, unknown>)['action'] = action('aoc.licensing', AOC_LICENSING_ACTION_TERM_IDS.commercialUse);
  });
  assertIneligible(await verifyDocumentUseEligibility(bundle(sovereignAssetId, [smuggled]), options(sovereignAssetId)), 'eligibility', ['TERMS_CONCEPT_UNSUPPORTED']);
});

test('a bundle without terms is refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  assertIneligible(await verifyDocumentUseEligibility(bundle(sovereignAssetId, []), options(sovereignAssetId)), 'eligibility', ['TERMS_MISSING']);
});

test('two registrant-issued terms claims for one asset are ambiguous and refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const first = sign(terms({ sovereignAssetId }));
  const second = sign(terms({ sovereignAssetId, id: 'claim:terms-2', rules: PROFILE_RULES.slice(0, 1) }));
  assertIneligible(await verifyDocumentUseEligibility(bundle(sovereignAssetId, [first, second]), options(sovereignAssetId)), 'eligibility', ['TERMS_AMBIGUOUS']);
});

test('an authority claim that is not a terms claim is refused, never ignored', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const authorship = buildAuthorityClaim({
    id: 'claim:authorship-1',
    sovereignAssetId,
    issuer: REGISTRANT,
    kind: AuthorityClaimKind.Authorship,
    statement: 'Authored by the registrant.',
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  const signed = signClaim(authorship, issuerKeys.privateKeyPem, issuerKeys.signingKey, SIGNED_AT);
  // An Authorship claim carries no semantic refs, so it is compatible; the terms check refuses it.
  const result = await verifyDocumentUseEligibility(bundle(sovereignAssetId, [sign(terms({ sovereignAssetId })), signed]), options(sovereignAssetId));
  assertIneligible(result, 'eligibility', ['TERMS_AMBIGUOUS', 'TERMS_UNEXPECTED_CLAIM']);
});

// --- Compatibility ---------------------------------------------------------------

test('terms naming a concept the profile does not declare are only partially compatible', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const extra: SovereignLicenseTermsRuleV1 = {
    id: 'rule-commercial',
    effect: SovereignLicenseTermsRuleEffect.Permission,
    action: action('aoc.licensing', AOC_LICENSING_ACTION_TERM_IDS.commercialUse),
    statement: 'The receiver may use the document commercially.',
  };
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId, rules: [...PROFILE_RULES, extra] }))]);
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'artifact_verification', ['INTEROPERABILITY_PARTIAL']);
});

test('an origin claim is outside the profile declaration and is refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId })), signedOriginClaim(sovereignAssetId)]);
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'artifact_verification', ['INTEROPERABILITY_PARTIAL']);
});

test('the compatibility declaration is the profile\'s own and cannot be supplied by the caller', async () => {
  const fixture = validDocument();
  const result = await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId, { consumerSupport: documentConsumerSupport() }));
  assertIneligible(result, 'options', ['INVALID_OPTIONS']);
});

// --- Content ---------------------------------------------------------------------

test('missing content bytes are refused', async () => {
  const fixture = validDocument();
  const { contentBytes: _omitted, ...withoutBytes } = options(fixture.sovereignAssetId);
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, withoutBytes), 'artifact_verification', ['CONTENT_BYTES_REQUIRED']);
});

test('content bytes that differ from the committed identity are refused', async () => {
  const fixture = validDocument();
  const altered = new TextEncoder().encode('# Synthetic Agreement (altered)\n');
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId, { contentBytes: altered })), 'artifact_verification', ['CONTENT_DIGEST_MISMATCH']);
});

test('a manifest that commits to no content is refused: a document asset must bind its bytes', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId }))], documentManifest(sovereignAssetId, { contentIdentity: undefined }));
  const { contentBytes: _omitted, ...withoutBytes } = options(sovereignAssetId);
  assertIneligible(await verifyDocumentUseEligibility(text, withoutBytes), 'eligibility', ['CONTENT_IDENTITY_NOT_DECLARED']);
});

test('a current manifest that is not active is refused', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const text = bundle(sovereignAssetId, [sign(terms({ sovereignAssetId }))], documentManifest(sovereignAssetId, { state: SovereignAssetState.Disputed }));
  assertIneligible(await verifyDocumentUseEligibility(text, options(sovereignAssetId)), 'eligibility', ['MANIFEST_STATE_NOT_ACTIVE']);
});

// --- Time: pinned gap ------------------------------------------------------------

test('GAP: expired terms are still eligible for evaluation; time is reported, never evaluated here', async () => {
  const sovereignAssetId = mintSovereignAssetId();
  const expired = sign(terms({ sovereignAssetId, expiresAt: '2001-01-01T00:00:00.000Z' }));
  const result = await verifyDocumentUseEligibility(bundle(sovereignAssetId, [expired]), options(sovereignAssetId));
  assert.equal(result.outcome, 'eligible_for_evaluation', JSON.stringify(result));
  if (result.outcome !== 'eligible_for_evaluation') return;
  // A future policy evaluator must refuse these; eligibility only hands it the declared instant.
  assert.equal(result.temporalValidity, 'not_evaluated');
  assert.equal(result.terms.expiresAt, '2001-01-01T00:00:00.000Z');
});

// --- Input and options hardening ----------------------------------------------------

test('never throws: non-string input and non-object options are closed refusals', async () => {
  const fixture = validDocument();
  assertIneligible(await verifyDocumentUseEligibility(42, options(fixture.sovereignAssetId)), 'options', ['INVALID_INPUT']);
  for (const bad of [null, undefined, 'options', [], 7]) {
    assertIneligible(await verifyDocumentUseEligibility(fixture.text, bad), 'options', ['INVALID_OPTIONS']);
  }
});

test('an accessor cannot show one expected asset to the check and another to RSDK-01', async () => {
  const fixture = validDocument();
  const other = mintSovereignAssetId();
  let reads = 0;
  const sneaky = { ...options(fixture.sovereignAssetId) };
  Object.defineProperty(sneaky, 'expectedSovereignAssetId', { enumerable: true, get: () => (reads++ === 0 ? other : undefined) });
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, sneaky), 'options', ['INVALID_OPTIONS']);
  assert.equal(reads, 0, 'the accessor must not be invoked');
});

test('unknown, inherited or prototype-borne options are refused', async () => {
  const fixture = validDocument();
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId, { allowExpired: true })), 'options', ['INVALID_OPTIONS']);
  const inherited = Object.create(options(fixture.sovereignAssetId)) as object;
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, inherited), 'options', ['INVALID_OPTIONS']);
  class Options {
    constructor(readonly expectedSovereignAssetId: string) {}
  }
  assertIneligible(await verifyDocumentUseEligibility(fixture.text, new Options(fixture.sovereignAssetId)), 'options', ['INVALID_OPTIONS']);
});

test('the resolver function is read once and serves both RSDK-01 and the authority check', async () => {
  const fixture = validDocument();
  const trusted = trustingResolver(RESOLVER_KEYS);
  let reads = 0;
  const resolverObject = {
    get resolveVerificationKey() {
      reads += 1;
      return trusted.resolveVerificationKey.bind(trusted);
    },
  };
  const result = await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId, { verificationKeyResolver: resolverObject }));
  assert.equal(result.outcome, 'eligible_for_evaluation', JSON.stringify(result));
  assert.equal(reads, 1);
});

test('the eligible result is deeply frozen and exposes plain data only', async () => {
  const fixture = validDocument();
  const result = await verifyDocumentUseEligibility(fixture.text, options(fixture.sovereignAssetId));
  if (result.outcome !== 'eligible_for_evaluation') throw new Error(JSON.stringify(result));
  assert.ok(Object.isFrozen(result.terms) && Object.isFrozen(result.terms.rules) && Object.isFrozen(result.terms.rules[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

/** The profile's declaration, rebuilt here for the RSDK-01 comparisons above. */
function documentConsumerSupport(): SovereigntyInteroperabilityConsumerSupportV1 {
  return buildSovereigntyInteroperabilityConsumerSupportV1({
    profile: { id: AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID, acceptedVersions: [AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION] },
    mediaTypes: [AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE],
    representationSchemaVersions: [SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION],
    canonicalizationProfiles: ['aoc-canonical-json/1'],
    artifactKinds: ['signed-manifest', 'signed-claim'],
    claimTypes: ['Authorship'],
    standingStatuses: [],
    semanticTerms: DOCUMENT_CONSUMER_SUPPORT_TERMS.map((termRef) => ({ namespace: termRef.split(':')[0]!, termRef })),
  });
}
