// Public surface is deliberately small: the verifier, its closed reason set
// and its result types. No @aoc/protocol value is re-exported, so the
// package-scoped Protocol import allowance cannot be reached through it.
export { verifyReceivedSovereignAsset } from './verify.js';
export { RECEIVER_VERIFICATION_REJECTION_REASONS } from './reasons.js';
export type { ReceiverVerificationRejectionReason } from './reasons.js';
export { STRICT_RECEIVER_PROFILE } from './types.js';
export type {
  ReceivedSovereignAssetRejected,
  ReceivedSovereignAssetVerificationResult,
  ReceivedSovereignAssetVerified,
  ReceiverVerificationKeyResolver,
  StrictReceiverProfile,
  VerifiedClaimEvidence,
  VerifiedManifestEvidence,
  VerifyReceivedSovereignAssetOptions,
} from './types.js';
// FV-P2: opt-in eligibility check for soberania.document-use/1 assets. Additive:
// verifyReceivedSovereignAsset and its reason set are unchanged.
export { verifyDocumentUseEligibility } from './document-use.js';
export { DOCUMENT_USE_INELIGIBILITY_REASONS, DOCUMENT_USE_PROFILE, DOCUMENT_USE_RECEIVER_PROFILE } from './document-use-types.js';
export type {
  DocumentUseEligibilityResult,
  DocumentUseEligible,
  DocumentUseIneligibilityReason,
  DocumentUseIneligibilityStage,
  DocumentUseIneligible,
  DocumentUseProfile,
  DocumentUseReceiverProfile,
  DocumentUseTermsEvidence,
  VerifyDocumentUseEligibilityOptions,
} from './document-use-types.js';
