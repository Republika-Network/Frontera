/**
 * P13 — MPP challenge adaptation and business-level idempotency. Trusted
 * in-process only: composed through `createEnterprise({ mppChallengePayments })`
 * and reached as `AocEnterprise.mppChallengePayments` (and the read-only
 * `AocEnterprise.mppChallengeContexts`). No route, no SDK method, no
 * governed-action field. See
 * `docs/architecture/ADR-MPP-CHALLENGE-AND-BUSINESS-IDEMPOTENCY.md`.
 */
export {
  MPP_CHALLENGE_REFUSALS,
  type MppChallengeContextReader,
  type MppChallengeMethodNormalizer,
  type MppChallengePaymentRequest,
  type MppChallengePaymentResult,
  type MppChallengePaymentService,
  type MppChallengeRefusal,
  type MppChallengeSelectionContext,
  type MppChallengeSelector,
  type MppCounterpartyResolutionContext,
  type MppCounterpartyResolver,
  type MppNormalizedCharge,
  type ProtectedMppRequest,
  type SupportedMppChallenge,
  type VerifiedMppChallengeContext,
} from './contracts.js';
export {
  MPP_CHALLENGE_LIMITS,
  MPP_PAYMENT_AUTHORIZATION_HEADER,
  computeContentDigest,
  isMppChallengeUsableAt,
  mppCredentialHeaderField,
  parsePaymentChallenge,
  parseWwwAuthenticate,
  type MppChallengeFields,
  type MppJsonValue,
  type ParsedMppPaymentChallenge,
  type RawAuthChallenge,
} from './protocol.js';
export { MPP_GOVERNED_IDEMPOTENCY_KEY_PREFIX, deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from './business-identity.js';
export { MppChallengeConfigurationError, snapshotMppChallengeComposition, type MppChallengeComposition } from './composition.js';
export { createMppChallengePaymentService, type MppChallengePaymentServiceOptions } from './service.js';
export { createMppChallengeContextReader } from './context-reader.js';
