import type { SovereignLicenseTermsAudience, SovereignLicenseTermsRuleV1 } from '@aoc/protocol/licensing';

import { RECEIVER_VERIFICATION_REJECTION_REASONS } from './reasons.js';
import type { ReceiverVerificationKeyResolver } from './types.js';

/** Identifies the eligibility rules `verifyDocumentUseEligibility` applies. */
export const DOCUMENT_USE_RECEIVER_PROFILE = 'aoc-enterprise.document-use-eligibility/1' as const;
export type DocumentUseReceiverProfile = typeof DOCUMENT_USE_RECEIVER_PROFILE;

/** The Soberanía document profile whose eligibility preconditions this checks (PROPOSED, FV-P1). */
export const DOCUMENT_USE_PROFILE = 'soberania.document-use/1' as const;
export type DocumentUseProfile = typeof DOCUMENT_USE_PROFILE;

/**
 * The closed set of reasons an asset is not eligible for evaluation: every
 * RSDK-01 rejection reason, plus the eligibility preconditions RSDK-01 does
 * not check. A receiver can switch exhaustively over it.
 */
export const DOCUMENT_USE_INELIGIBILITY_REASONS = Object.freeze([
  ...RECEIVER_VERIFICATION_REJECTION_REASONS,
  // The caller did not name the asset it was asked to act on.
  'EXPECTED_ASSET_REQUIRED',
  // The current manifest records a state other than active.
  'MANIFEST_STATE_NOT_ACTIVE',
  // Terms
  'TERMS_MISSING',
  'TERMS_AMBIGUOUS',
  'TERMS_UNEXPECTED_CLAIM',
  'TERMS_STRUCTURE_INVALID',
  'TERMS_SUBJECT_MISMATCH',
  'TERMS_ISSUER_NOT_REGISTRANT',
  'TERMS_CONCEPT_UNSUPPORTED',
] as const);

export type DocumentUseIneligibilityReason = (typeof DOCUMENT_USE_INELIGIBILITY_REASONS)[number];

/**
 * Where an ineligible result was decided: the caller's input, RSDK-01's
 * artifact verification, or this check's eligibility preconditions.
 */
export type DocumentUseIneligibilityStage = 'options' | 'artifact_verification' | 'eligibility';

/** What this check deliberately does not decide. None of it is implied by eligibility. */
interface DocumentUseNotEvaluated {
  /** The terms' rules are not applied: no ALLOWED, DENIED or WITHHELD is computed. */
  readonly policyEvaluation: 'not_evaluated';
  /** No operation is authorized and no execution capability is issued. */
  readonly authorization: 'not_evaluated';
  /** Key, manifest and terms revocation are not checked. */
  readonly revocation: 'not_evaluated';
  /** A bundle may omit newer terms or manifests; nothing here can tell. */
  readonly freshness: 'not_evaluated';
  /** `effectiveAt` and `expiresAt` are reported, never compared with a clock. */
  readonly temporalValidity: 'not_evaluated';
  /** The terms' audience is reported, never matched against the receiver. */
  readonly audience: 'not_evaluated';
}

/** The verified terms, as plain data. An evaluator's input, not a decision. */
export interface DocumentUseTermsEvidence {
  readonly claimId: string;
  /** Equal to the verified registrant: the only issuer with authority over the asset's terms. */
  readonly issuer: string;
  readonly keyId: string;
  readonly claimDigest: string;
  readonly issuedAt: string;
  /** Signer-declared; not evaluated. `null` when absent. */
  readonly effectiveAt: string | null;
  /** Signer-declared; not evaluated. `null` when absent. */
  readonly expiresAt: string | null;
  readonly audience: SovereignLicenseTermsAudience;
  readonly rules: readonly SovereignLicenseTermsRuleV1[];
}

export interface DocumentUseEligible extends DocumentUseNotEvaluated {
  readonly outcome: 'eligible_for_evaluation';
  readonly profile: DocumentUseReceiverProfile;
  readonly documentProfile: DocumentUseProfile;
  /** RSDK-01 verified every artifact; authenticity, never authority to act. */
  readonly artifactVerification: 'verified';
  readonly sovereignAssetId: string;
  /** The verified issuer of the current manifest (RSDK-01 `currentIssuer`). */
  readonly registrant: string;
  readonly currentManifestVersion: number;
  readonly terms: DocumentUseTermsEvidence;
  readonly reasons: readonly [];
}

export interface DocumentUseIneligible extends DocumentUseNotEvaluated {
  readonly outcome: 'ineligible';
  readonly profile: DocumentUseReceiverProfile;
  readonly documentProfile: DocumentUseProfile;
  readonly stage: DocumentUseIneligibilityStage;
  readonly reasons: readonly DocumentUseIneligibilityReason[];
}

export type DocumentUseEligibilityResult = DocumentUseEligible | DocumentUseIneligible;

/**
 * Options for `verifyDocumentUseEligibility`. Unlike RSDK-01, the expected asset
 * is required and the compatibility declaration is not configurable: it is the
 * profile's own. Only plain own data properties are read.
 */
export interface VerifyDocumentUseEligibilityOptions {
  readonly verificationKeyResolver: ReceiverVerificationKeyResolver;
  readonly expectedSovereignAssetId: string;
  readonly expectedIssuer?: string;
  readonly contentBytes?: Uint8Array;
}
