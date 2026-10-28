import {
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID,
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION,
  AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE,
  buildSovereigntyInteroperabilityConsumerSupportV1,
} from '@aoc/protocol/interoperability';
import type { SovereigntyInteroperabilityConsumerSupportV1 } from '@aoc/protocol/interoperability';
import {
  AOC_LICENSING_ACTION_TERM_IDS,
  AOC_LICENSING_DECLARATION_TERM_IDS,
  AOC_LICENSING_SEMANTIC_NAMESPACE,
  validateLicenseTermsClaim,
} from '@aoc/protocol/licensing';
import type { LicenseTermsClaim } from '@aoc/protocol/licensing';
import { AuthorityClaimKind, SovereignAssetState, verifySignedSovereignClaim } from '@aoc/protocol/manifest';
import type { SignedClaim } from '@aoc/protocol/manifest';
import { SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION, parseSovereigntyPortabilityBundle } from '@aoc/protocol/portability';

import type { ReceiverVerificationKeyResolver } from './types.js';
import { DOCUMENT_USE_PROFILE, DOCUMENT_USE_RECEIVER_PROFILE } from './document-use-types.js';
import type {
  DocumentUseEligibilityResult,
  DocumentUseEligible,
  DocumentUseIneligibilityReason,
  DocumentUseIneligibilityStage,
  DocumentUseIneligible,
  DocumentUseTermsEvidence,
} from './document-use-types.js';
import { verifyReceivedSovereignAsset } from './verify.js';

/**
 * FV-P2 — opt-in eligibility check for `soberania.document-use/1` assets.
 *
 * Composes RSDK-01 without changing it: `verifyReceivedSovereignAsset` must
 * first verify the bundle (artifact verification). Only then are the profile's
 * eligibility preconditions checked, through Protocol only:
 *
 * - the caller names the expected asset (mandatory here, optional in RSDK-01);
 * - the receiver's compatibility declaration is the profile's own, fixed one;
 * - the current manifest is `active` and commits to content;
 * - the bundle carries exactly one claim, a structurally valid `LicenseTermsClaim`
 *   (`validateLicenseTermsClaim`) about the expected asset;
 * - its issuer is the verified registrant, re-verified with Protocol's opt-in
 *   expected-issuer binding;
 * - every rule names a concept from the profile's table.
 *
 * `eligible_for_evaluation` means the terms are authentic, authoritative and
 * unambiguous. It is not a policy decision and not an authorization: rule
 * semantics, time, audience, revocation and freshness are not evaluated.
 * Never throws; every failure is a closed refusal.
 */

const OPTION_KEYS: ReadonlySet<string> = new Set(['verificationKeyResolver', 'expectedSovereignAssetId', 'expectedIssuer', 'contentBytes']);

/** The profile's concept table: the three actions and the one obligated action (profile §3). */
const PROFILE_CONCEPTS: ReadonlySet<string> = new Set(
  [
    [AOC_LICENSING_SEMANTIC_NAMESPACE, AOC_LICENSING_ACTION_TERM_IDS.access],
    ['soberania.document', 'soberania.document:export'],
    ['soberania.document', 'soberania.document:modify-protected-terms'],
    ['soberania.document', 'soberania.document:owner-approval.modify-protected-terms'],
  ].map(([namespace, termRef]) => conceptKey(namespace!, termRef!)),
);

/**
 * The only compatibility declaration this check accepts (profile §7): a terms
 * claim travels as an `Authorship` claim, and every concept a document-use/1
 * bundle may carry is declared — nothing else, so a bundle naming any other
 * concept, claim type or standing is only partially compatible and refused.
 */
const DOCUMENT_USE_CONSUMER_SUPPORT: SovereigntyInteroperabilityConsumerSupportV1 = buildSovereigntyInteroperabilityConsumerSupportV1({
  profile: { id: AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID, acceptedVersions: [AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION] },
  mediaTypes: [AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE],
  representationSchemaVersions: [SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION],
  canonicalizationProfiles: ['aoc-canonical-json/1'],
  artifactKinds: ['signed-manifest', 'signed-claim'],
  claimTypes: ['Authorship'],
  standingStatuses: [],
  semanticTerms: [
    ...Object.values(AOC_LICENSING_DECLARATION_TERM_IDS).map((termRef) => ({ namespace: AOC_LICENSING_SEMANTIC_NAMESPACE, termRef })),
    ...[...PROFILE_CONCEPTS].map((key) => {
      const [namespace, termRef] = JSON.parse(key) as [string, string];
      return { namespace, termRef };
    }),
  ],
});

interface DocumentUseOptionsSnapshot {
  readonly resolver: ReceiverVerificationKeyResolver;
  readonly expectedSovereignAssetId: string;
  readonly rsdk01Options: Readonly<Record<string, unknown>>;
}

type OptionsOutcome = { readonly ok: true; readonly options: DocumentUseOptionsSnapshot } | { readonly ok: false; readonly reason: DocumentUseIneligibilityReason };

/** Records whether the caller's resolver failed during the terms re-verification. */
interface ResolverState {
  failed: boolean;
}

export async function verifyDocumentUseEligibility(bundleText: unknown, options: unknown): Promise<DocumentUseEligibilityResult> {
  try {
    return await verifyEligibility(bundleText, options);
  } catch {
    return ineligible('eligibility', ['INTERNAL_VERIFICATION_ERROR']);
  }
}

async function verifyEligibility(bundleText: unknown, rawOptions: unknown): Promise<DocumentUseEligibilityResult> {
  if (typeof bundleText !== 'string') return ineligible('options', ['INVALID_INPUT']);
  const outcome = snapshotOptions(rawOptions);
  if (!outcome.ok) return ineligible('options', [outcome.reason]);
  const { resolver, expectedSovereignAssetId, rsdk01Options } = outcome.options;

  // 1. Artifact verification: RSDK-01, unchanged, with the snapshot and the profile's declaration.
  const verified = await verifyReceivedSovereignAsset(bundleText, rsdk01Options);
  if (verified.outcome !== 'verified') return ineligible('artifact_verification', verified.reasons);

  // 2. Eligibility. RSDK-01 already bound every artifact to a trusted key and the
  //    bundle subject to the expected asset; what follows is what it does not check.
  const reasons: DocumentUseIneligibilityReason[] = [];
  if (verified.sovereignAssetId !== expectedSovereignAssetId) reasons.push('SUBJECT_MISMATCH');
  if (verified.currentState !== SovereignAssetState.Active) reasons.push('MANIFEST_STATE_NOT_ACTIVE');
  if (verified.contentIdentity !== 'verified') reasons.push('CONTENT_IDENTITY_NOT_DECLARED');

  // The same immutable text RSDK-01 just accepted as canonical; it parses again identically.
  const parsed = parseSovereigntyPortabilityBundle(bundleText);
  if (!parsed.valid) return ineligible('eligibility', ['INTERNAL_VERIFICATION_ERROR']);
  const signedClaims: SignedClaim[] = [];
  for (const artifact of parsed.bundle.claims) {
    if (artifact.kind !== 'signed-claim') return ineligible('eligibility', ['INTERNAL_VERIFICATION_ERROR']);
    signedClaims.push(artifact.signedClaim);
  }

  // Exactly one claim, and it is the terms. Any other claim would be a
  // statement this profile neither reads nor may silently ignore.
  if (signedClaims.length === 0) reasons.push('TERMS_MISSING');
  if (signedClaims.length > 1) reasons.push('TERMS_AMBIGUOUS');

  const registrant = verified.currentIssuer;
  const state: ResolverState = { failed: false };
  const guarded = guardResolver(resolver, state);
  let evidence: DocumentUseTermsEvidence | undefined;
  for (const signed of signedClaims) {
    const termsReasons = await termsRejections(signed, registrant, expectedSovereignAssetId, guarded, state);
    reasons.push(...termsReasons);
    if (termsReasons.length === 0) evidence = termsEvidence(signed as SignedClaim<LicenseTermsClaim>);
  }

  if (reasons.length > 0) return ineligible('eligibility', reasons);
  if (evidence === undefined) return ineligible('eligibility', ['INTERNAL_VERIFICATION_ERROR']);

  const eligible: DocumentUseEligible = deepFreeze({
    outcome: 'eligible_for_evaluation',
    profile: DOCUMENT_USE_RECEIVER_PROFILE,
    documentProfile: DOCUMENT_USE_PROFILE,
    artifactVerification: 'verified',
    policyEvaluation: 'not_evaluated',
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    temporalValidity: 'not_evaluated',
    audience: 'not_evaluated',
    sovereignAssetId: verified.sovereignAssetId,
    registrant,
    currentManifestVersion: verified.currentManifestVersion,
    terms: evidence,
    reasons: [],
  });
  ISSUED_ELIGIBILITY.add(eligible);
  return eligible;
}

/**
 * FV-P3 provenance: every eligible result this module returns, held weakly.
 * The results are deeply frozen, so a registered object is exactly what was
 * verified. A structurally identical object built by anyone else, a copy, a
 * deserialized result or one from another copy of this package is not
 * registered, and the policy evaluator refuses it. Process-local by design.
 */
const ISSUED_ELIGIBILITY = new WeakSet<object>();

/** Internal to this package (not exported from the index): whether `value` is an eligible result issued here. */
export function isIssuedDocumentUseEligibility(value: unknown): value is DocumentUseEligible {
  return typeof value === 'object' && value !== null && ISSUED_ELIGIBILITY.has(value);
}

async function termsRejections(
  signed: SignedClaim,
  registrant: string,
  expectedSovereignAssetId: string,
  resolver: ReceiverVerificationKeyResolver,
  state: ResolverState,
): Promise<DocumentUseIneligibilityReason[]> {
  const metadata = (signed.claim as { readonly metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null || (metadata as Record<string, unknown>)['kind'] !== AuthorityClaimKind.License) {
    return ['TERMS_UNEXPECTED_CLAIM'];
  }
  // The generic claim verifier does not check the terms document; Protocol's licensing validator does.
  if (!validateLicenseTermsClaim(signed.claim).valid) return ['TERMS_STRUCTURE_INVALID'];
  const terms = signed.claim as LicenseTermsClaim;

  const reasons: DocumentUseIneligibilityReason[] = [];
  if (terms.subject !== expectedSovereignAssetId) reasons.push('TERMS_SUBJECT_MISMATCH');
  for (const rule of terms.metadata.terms.rules) {
    if (!PROFILE_CONCEPTS.has(conceptKey(rule.action.namespace, rule.action.termRef))) {
      reasons.push('TERMS_CONCEPT_UNSUPPORTED');
      break;
    }
  }

  // Authority: a signature bound to a trusted key proves who signed, not that
  // the signer may declare terms for this asset. Only the verified registrant may.
  if (issuerId(terms.issuer) !== registrant) {
    reasons.push('TERMS_ISSUER_NOT_REGISTRANT');
    return reasons;
  }
  state.failed = false;
  const bound = await verifySignedSovereignClaim(signed, { verificationKeyResolver: resolver, issuer: registrant });
  if (state.failed) {
    reasons.push('KEY_RESOLVER_FAILED');
  } else if (
    bound.valid !== true
    || bound.checks.claimStructure !== 'valid'
    || bound.checks.claimDigest !== 'valid'
    || bound.checks.signature !== 'valid'
    || bound.checks.issuerBinding !== 'verified'
  ) {
    reasons.push('TERMS_ISSUER_NOT_REGISTRANT');
  }
  return reasons;
}

/** Plain, frozen data copied out of the verified terms; no Protocol object is handed back. */
function termsEvidence(signed: SignedClaim<LicenseTermsClaim>): DocumentUseTermsEvidence {
  const { claim } = signed;
  const document = JSON.parse(JSON.stringify(claim.metadata.terms)) as LicenseTermsClaim['metadata']['terms'];
  return {
    claimId: claim.id,
    issuer: issuerId(claim.issuer)!,
    keyId: signed.proof.keyId,
    claimDigest: signed.digest,
    issuedAt: claim.issuedAt,
    effectiveAt: document.effectiveAt ?? null,
    expiresAt: claim.expiresAt ?? null,
    audience: document.audience,
    rules: document.rules,
  };
}

/**
 * Reads the caller's options exactly once into a null-prototype snapshot that
 * RSDK-01 then reads, so a getter or proxy can never show one value to this
 * check and another to RSDK-01. Only plain own data properties are accepted:
 * accessors, unknown keys and inherited configuration are refused. The
 * resolver's function is read once too, and the same bound function serves
 * both RSDK-01 and the terms re-verification.
 */
function snapshotOptions(raw: unknown): OptionsOutcome {
  const invalid = { ok: false, reason: 'INVALID_OPTIONS' } as const;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid;
  const values = new Map<string, unknown>();
  try {
    const prototype = Reflect.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return invalid;
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !OPTION_KEYS.has(key)) return invalid;
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return invalid;
      values.set(key, descriptor.value);
    }
  } catch {
    return invalid;
  }

  const expectedSovereignAssetId = values.get('expectedSovereignAssetId');
  if (expectedSovereignAssetId === undefined) return { ok: false, reason: 'EXPECTED_ASSET_REQUIRED' };
  if (typeof expectedSovereignAssetId !== 'string') return invalid;

  const resolverObject = values.get('verificationKeyResolver');
  if (typeof resolverObject !== 'object' || resolverObject === null) return invalid;
  let resolve: unknown;
  try {
    resolve = Reflect.get(resolverObject, 'resolveVerificationKey');
  } catch {
    return invalid;
  }
  if (typeof resolve !== 'function') return invalid;
  const bound = resolve as ReceiverVerificationKeyResolver['resolveVerificationKey'];
  const resolver: ReceiverVerificationKeyResolver = {
    resolveVerificationKey: (issuer) => Reflect.apply(bound, resolverObject, [issuer]),
  };

  const rsdk01Options: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  rsdk01Options['verificationKeyResolver'] = resolver;
  rsdk01Options['consumerSupport'] = DOCUMENT_USE_CONSUMER_SUPPORT;
  rsdk01Options['expectedSovereignAssetId'] = expectedSovereignAssetId;
  for (const key of ['expectedIssuer', 'contentBytes']) {
    const value = values.get(key);
    if (value !== undefined) rsdk01Options[key] = value;
  }
  return { ok: true, options: { resolver, expectedSovereignAssetId, rsdk01Options: Object.freeze(rsdk01Options) } };
}

function guardResolver(resolver: ReceiverVerificationKeyResolver, state: ResolverState): ReceiverVerificationKeyResolver {
  return {
    resolveVerificationKey: async (issuer) => {
      try {
        return await resolver.resolveVerificationKey(issuer);
      } catch {
        state.failed = true;
        return undefined;
      }
    },
  };
}

function conceptKey(namespace: string, termRef: string): string {
  return JSON.stringify([namespace, termRef]);
}

/** The same canonical identity RSDK-01 binds: a string issuer, or a principal reference's id. */
function issuerId(issuer: unknown): string | undefined {
  if (typeof issuer === 'string' && issuer.trim() !== '') return issuer;
  if (typeof issuer === 'object' && issuer !== null) {
    const id = (issuer as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.trim() !== '') return id;
  }
  return undefined;
}

function ineligible(stage: DocumentUseIneligibilityStage, reasons: readonly DocumentUseIneligibilityReason[]): DocumentUseIneligible {
  return deepFreeze({
    outcome: 'ineligible',
    profile: DOCUMENT_USE_RECEIVER_PROFILE,
    documentProfile: DOCUMENT_USE_PROFILE,
    stage,
    policyEvaluation: 'not_evaluated',
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    temporalValidity: 'not_evaluated',
    audience: 'not_evaluated',
    reasons: [...new Set(reasons)].sort(),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
