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
