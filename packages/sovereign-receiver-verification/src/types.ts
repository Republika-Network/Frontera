import type { VerifySovereignManifestOptions } from '@aoc/protocol/manifest';
import type { SovereigntyInteroperabilityConsumerSupportV1 } from '@aoc/protocol/interoperability';

import type { ReceiverVerificationRejectionReason } from './reasons.js';

/** Identifies the verification rules this package applies. */
export const STRICT_RECEIVER_PROFILE = 'aoc-enterprise.strict-receiver-verification/1' as const;
export type StrictReceiverProfile = typeof STRICT_RECEIVER_PROFILE;

/**
 * Protocol's own key resolver contract, taken from the manifest verifier that
 * consumes it rather than restated here.
 */
export type ReceiverVerificationKeyResolver = NonNullable<VerifySovereignManifestOptions['verificationKeyResolver']>;

export interface VerifyReceivedSovereignAssetOptions {
  /** Binds each signed issuer to its trusted key. Required: without it no issuer binding can be verified. */
  readonly verificationKeyResolver: ReceiverVerificationKeyResolver;
  /** What this receiver can consume. Anything short of `compatible` is rejected. */
  readonly consumerSupport: SovereigntyInteroperabilityConsumerSupportV1;
  /** When set, the bundle subject must be exactly this sovereign asset. */
  readonly expectedSovereignAssetId?: string;
  /**
   * When set, narrows the manifest registrant the issuer binding is about. It
   * never replaces the registrant the signed manifest names: a different value
   * is rejected. Required for a registrant that is a principal reference rather
   * than a string. Not applied to separately signed claims, whose signed issuer
   * is always the one bound.
   */
  readonly expectedIssuer?: string;
  /** Content bytes to check against the current manifest's declared content identity. */
  readonly contentBytes?: Uint8Array;
}

/** Checks this package deliberately does not perform. */
interface NotEvaluated {
  /** Verification is not authorization: no access, execution or policy decision is made. */
  readonly authorization: 'not_evaluated';
  /** Key and claim revocation are not checked. */
  readonly revocation: 'not_evaluated';
  /** No clock is read; `signedAt` and timestamps are signer-asserted. */
  readonly freshness: 'not_evaluated';
}

export interface VerifiedManifestEvidence {
  readonly manifestVersion: number;
  readonly manifestDigest: string;
  readonly issuer: string;
  readonly keyId: string;
}

export interface VerifiedClaimEvidence {
  readonly claimId: string;
  readonly claimType: string;
  readonly issuer: string;
  readonly keyId: string;
}

export interface ReceivedSovereignAssetVerified extends NotEvaluated {
  readonly outcome: 'verified';
  readonly profile: StrictReceiverProfile;
  readonly sovereignAssetId: string;
  readonly currentManifestVersion: number;
  /** `not_declared` when the current manifest makes no content commitment. */
  readonly contentIdentity: 'verified' | 'not_declared';
  readonly compatibility: 'compatible';
  readonly manifests: readonly VerifiedManifestEvidence[];
  readonly claims: readonly VerifiedClaimEvidence[];
  readonly reasons: readonly [];
}

export interface ReceivedSovereignAssetRejected extends NotEvaluated {
  readonly outcome: 'rejected';
  readonly profile: StrictReceiverProfile;
  readonly reasons: readonly ReceiverVerificationRejectionReason[];
}

export type ReceivedSovereignAssetVerificationResult = ReceivedSovereignAssetVerified | ReceivedSovereignAssetRejected;
