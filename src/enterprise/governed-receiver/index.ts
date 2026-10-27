/**
 * RSDK-02B — the governed sovereign receiver: a G-02 executor that acts on a
 * sovereign asset only when a Frontera capability authorizes the exact
 * request, RSDK-01 verifies the asset, and the receiver's own policy accepts
 * it. Internal and unpublished. The demonstration policy is deliberately not
 * exported here (`./demonstration-policy.js`).
 *
 * See `docs/architecture/ADR-RSDK-02-GOVERNED-RECEIVER.md`.
 */
export {
  GOVERNED_RECEIVER_ASSET_REFUSALS,
  GOVERNED_RECEIVER_LIMITS,
  GOVERNED_RECEIVER_MODE,
  SOVEREIGN_ASSET_IDENTIFIER_PATTERN,
  isSovereignAssetIdentifier,
} from './contracts.js';
export type {
  GovernedReceiverAnswer,
  GovernedReceiverAssetRefusal,
  GovernedReceiverAssetRefusalCode,
  GovernedReceiverDeadlineScheduler,
  GovernedReceiverRecord,
  GovernedSovereignReceiver,
  GovernedSovereignReceiverOptions,
  SovereignAssetEligibilityDecision,
  SovereignAssetEligibilityInput,
  SovereignAssetEligibilityPolicy,
  SovereignAssetStore,
  SovereignAssetVerificationRequest,
  SovereignAssetVerifier,
  StoredSovereignAsset,
  VerifiedSovereignAsset,
  VerifiedSovereignClaim,
  VerifiedSovereignManifest,
} from './contracts.js';
export { createGovernedSovereignReceiver } from './receiver.js';
