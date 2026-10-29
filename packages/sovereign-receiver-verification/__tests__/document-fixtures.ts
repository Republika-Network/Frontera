// Test-only fixtures for soberania.document-use/1 bundles. Synthetic, generated per run with
// Protocol's own primitives; only public halves of keys reach a resolver.
import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';
import { SovereignLicenseTermsAudienceKind, SovereignLicenseTermsRuleEffect, buildLicenseTermsClaim } from '@aoc/protocol/licensing';
import type { LicenseTermsClaim, SovereignLicenseTermsAudience, SovereignLicenseTermsRuleV1 } from '@aoc/protocol/licensing';
import { signClaim } from '@aoc/protocol/manifest';
import type { SignedClaim } from '@aoc/protocol/manifest';
import type { PortableSovereignClaimArtifact } from '@aoc/protocol/portability';

import { verifyDocumentUseEligibility } from '../src/index.js';
import type { DocumentUseEligible } from '../src/index.js';
import { ISSUER, SIGNED_AT, issuerKeys, manifestArtifact, serialize, signedManifest, trustingResolver } from './fixtures.js';

export const RECEIVER = 'did:example:receiver';
export const DOCUMENT = new TextEncoder().encode('# Synthetic Agreement\n\n> SYNTHETIC TEST DOCUMENT. Not a real agreement.\n');

export const ACCESS = { namespace: 'aoc.licensing', termRef: 'aoc.licensing:access' } as const;
export const EXPORT = { namespace: 'soberania.document', termRef: 'soberania.document:export' } as const;
export const MODIFY = { namespace: 'soberania.document', termRef: 'soberania.document:modify-protected-terms' } as const;
export const APPROVAL = { namespace: 'soberania.document', termRef: 'soberania.document:owner-approval.modify-protected-terms' } as const;

type Effect = SovereignLicenseTermsRuleV1['effect'];
export const { Permission, Restriction, Obligation } = SovereignLicenseTermsRuleEffect;

export const rule = (id: string, effect: Effect, action: { readonly namespace: string; readonly termRef: string }): SovereignLicenseTermsRuleV1 => ({
  id,
  effect,
  action: { namespace: action.namespace, termRef: action.termRef },
  statement: `Synthetic rule ${id}.`,
});

/** The profile's reference terms: read yes, export no, modify only with owner approval. */
export const PROFILE_RULES: readonly SovereignLicenseTermsRuleV1[] = [
  rule('rule-access', Permission, ACCESS),
  rule('rule-export', Restriction, EXPORT),
  rule('rule-modify', Permission, MODIFY),
  rule('rule-approval', Obligation, APPROVAL),
];

export interface TermsOptions {
  readonly rules?: readonly SovereignLicenseTermsRuleV1[];
  readonly audience?: SovereignLicenseTermsAudience;
  readonly effectiveAt?: string;
  readonly expiresAt?: string | null;
}

export interface EligibleDocument {
  readonly sovereignAssetId: string;
  readonly signedTerms: SignedClaim<LicenseTermsClaim>;
  readonly eligibility: DocumentUseEligible;
  /** The current manifest's digest, as RSDK-01 verified it. */
  readonly manifestDigest: string;
}

/** Signs a document asset with the given terms and runs it through the real FV-P2 check. */
export async function eligibleDocument(options: TermsOptions = {}): Promise<EligibleDocument> {
  const sovereignAssetId = mintSovereignAssetId();
  const claim = buildLicenseTermsClaim({
    id: 'claim:terms-1',
    sovereignAssetId,
    issuer: ISSUER,
    statement: 'Usage terms for a synthetic document.',
    audience: options.audience ?? { kind: SovereignLicenseTermsAudienceKind.Principal, principal: RECEIVER },
    rules: options.rules ?? PROFILE_RULES,
    issuedAt: '2026-01-01T00:00:00.000Z',
    ...(options.effectiveAt === undefined ? {} : { effectiveAt: options.effectiveAt }),
    ...(options.expiresAt === null ? {} : { expiresAt: options.expiresAt ?? '2099-01-01T00:00:00.000Z' }),
  });
  const signedTerms = signClaim(claim, issuerKeys.privateKeyPem, issuerKeys.signingKey, SIGNED_AT);
  const manifest = signedManifest({ sovereignAssetId, contentIdentity: computeContentIdentity(DOCUMENT) });
  const artifact = { kind: 'signed-claim', signedClaim: signedTerms } as PortableSovereignClaimArtifact;
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)], claims: [artifact] });
  const result = await verifyDocumentUseEligibility(text, {
    verificationKeyResolver: trustingResolver(),
    expectedSovereignAssetId: sovereignAssetId,
    contentBytes: DOCUMENT,
  });
  if (result.outcome !== 'eligible_for_evaluation') throw new Error(`fixture not eligible: ${JSON.stringify(result)}`);
  return { sovereignAssetId, signedTerms, eligibility: result, manifestDigest: manifest.manifestDigest };
}
