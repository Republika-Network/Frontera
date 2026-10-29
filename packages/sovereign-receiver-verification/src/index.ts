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
// FV-P3: deterministic policy evaluation over an eligible result. Evaluation is
// not authorization: nothing here grants, issues a capability or executes.
export { evaluateDocumentUsePolicy } from './document-policy.js';
export { DOCUMENT_USE_ACTIONS, DOCUMENT_USE_POLICY_EVALUATOR, DOCUMENT_USE_POLICY_REASONS } from './document-policy-types.js';
export type {
  DocumentUseAction,
  DocumentUsePolicyDecision,
  DocumentUsePolicyDecisionValue,
  DocumentUsePolicyEvaluator,
  DocumentUsePolicyReason,
  DocumentUsePolicyReference,
  DocumentUsePolicyRequest,
  DocumentUsePolicyTrustedContext,
} from './document-policy-types.js';
// FV-P4B: strict verification of one signed soberania.sovereign-status/1
// artifact. Authenticity, authority, binding and the status's own validity
// window only: freshness, revocation currentness and authorization are not evaluated.
export { verifySovereignStatus } from './sovereign-status.js';
export {
  SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS,
  SOVEREIGN_STATUS_PROFILE,
  SOVEREIGN_STATUS_PURPOSE,
  SOVEREIGN_STATUS_REJECTION_REASONS,
  SOVEREIGN_STATUS_VERIFIER,
} from './sovereign-status-types.js';
export type {
  SignedSovereignStatusV1,
  SovereignAssetStatusValue,
  SovereignStatusPayloadV1,
  SovereignStatusProfile,
  SovereignStatusPurpose,
  SovereignStatusRejected,
  SovereignStatusRejectionReason,
  SovereignStatusTermsReference,
  SovereignStatusTrustedContext,
  SovereignStatusVerificationResult,
  SovereignStatusVerified,
  SovereignStatusVerifier,
} from './sovereign-status-types.js';
