import type { ReceiverVerificationKeyResolver } from './types.js';

/** The signed status profile this verifier accepts (Soberanía `SOVEREIGN_STATUS_PROFILE.md`, PROPOSED). */
export const SOVEREIGN_STATUS_PROFILE = 'soberania.sovereign-status/1' as const;
export type SovereignStatusProfile = typeof SOVEREIGN_STATUS_PROFILE;

/**
 * The domain tag every status payload carries. Protocol's proof signs the
 * payload alone, with no external domain prefix, so this field and the exact
 * schema are what keep a status from being read as a manifest or a claim.
 */
export const SOVEREIGN_STATUS_PURPOSE = 'soberania.sovereign-status.assertion' as const;
export type SovereignStatusPurpose = typeof SOVEREIGN_STATUS_PURPOSE;

/** Identifies the verification rules `verifySovereignStatus` applies. */
export const SOVEREIGN_STATUS_VERIFIER = 'aoc-enterprise.sovereign-status-verification/1' as const;
export type SovereignStatusVerifier = typeof SOVEREIGN_STATUS_VERIFIER;

/** The longest validity window a status may declare: seven days. A bound on the artifact, not a freshness policy. */
export const SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS = 604_800 as const;

export type SovereignAssetStatusValue = 'active' | 'withdrawn';

/**
 * The closed set of rejection reasons. Exactly one is reported: the first
 * check, in the verifier's fixed order, that failed.
 */
export const SOVEREIGN_STATUS_REJECTION_REASONS = Object.freeze([
  // The host's trusted context
  'CONTEXT_INVALID',
  'EVALUATION_TIME_INVALID',
  // The artifact's form
  'STATUS_MALFORMED',
  'STATUS_SCHEMA_UNSUPPORTED',
  'STATUS_PURPOSE_INVALID',
  'STATUS_TIME_INVALID',
  'STATUS_VALIDITY_TOO_LONG',
  'STATUS_NOT_CANONICAL',
  // Signature and authority
  'STATUS_SIGNATURE_INVALID',
  'STATUS_ISSUER_UNAUTHORIZED',
  'KEY_RESOLVER_FAILED',
  'STATUS_KEY_UNTRUSTED',
  'STATUS_KEY_BINDING_INVALID',
  // Binding to what the host expects
  'STATUS_SUBJECT_MISMATCH',
  'MANIFEST_BINDING_MISMATCH',
  'TERMS_BINDING_MISMATCH',
  // Validity window
  'STATUS_FROM_FUTURE',
  'STATUS_EXPIRED',
  // Anything unexpected
  'STATUS_INTERNAL_ERROR',
] as const);
export type SovereignStatusRejectionReason = (typeof SOVEREIGN_STATUS_REJECTION_REASONS)[number];

/** A terms claim by identity: its id and its signed digest. Never its content. */
export interface SovereignStatusTermsReference {
  readonly claimId: string;
  readonly claimDigest: string;
}

/**
 * The signed payload. Every field is required and no other is allowed.
 * Digests are lowercase hex SHA-256 without a prefix, as Protocol computes them.
 */
export interface SovereignStatusPayloadV1 {
  readonly schemaVersion: SovereignStatusProfile;
  readonly purpose: SovereignStatusPurpose;
  readonly sovereignAssetId: string;
  /** The verified registrant of the asset; the only principal that may sign its status in v1. */
  readonly issuer: string;
  /** The manifest the issuer declares current. */
  readonly manifestDigest: string;
  readonly assetStatus: SovereignAssetStatusValue;
  /** The terms the issuer declares current; `null` when none are. Always `null` for `withdrawn`. */
  readonly currentTerms: SovereignStatusTermsReference | null;
  /** A safe integer ≥ 1, ordering the issuer's statuses for this asset. */
  readonly sequence: number;
  /** `null` exactly when `sequence` is 1; otherwise the previous status's digest. Declarative only. */
  readonly previousStatusDigest: string | null;
  readonly issuedAt: string;
  readonly validUntil: string;
}

/**
 * The transported artifact: the payload and the Protocol proof produced by
 * `signSovereignPayload` over it, serialized as `aoc-canonical-json/1`.
 */
export interface SignedSovereignStatusV1 {
  readonly status: SovereignStatusPayloadV1;
  readonly proof: {
    readonly algorithm: 'ed25519';
    readonly canonicalizationProfile: 'aoc-canonical-json/1';
    readonly keyId: string;
    readonly publicKey: string;
    readonly signature: string;
    readonly signedAt: string;
    readonly payloadHash: string;
  };
}

/**
 * Supplied by the receiving host, never by whoever presents the status. Every
 * expected value comes from the host's own verification of the asset (RSDK-01
 * and FV-P2), not from the status. The verifier refuses malformed values but
 * cannot authenticate them.
 */
export interface SovereignStatusTrustedContext {
  /** Binds the registrant to its trusted key. Called at most once, with `expectedRegistrant`. */
  readonly verificationKeyResolver: ReceiverVerificationKeyResolver;
  readonly expectedSovereignAssetId: string;
  /** The verified registrant (RSDK-01 `currentIssuer`). */
  readonly expectedRegistrant: string;
  /** The verified current manifest's digest. */
  readonly expectedManifestDigest: string;
  /**
   * The terms the host is about to rely on. When given, the status must name
   * them as current; when absent, the result reports `termsBinding: 'not_requested'`.
   */
  readonly expectedTerms?: SovereignStatusTermsReference;
  /** A canonical UTC timestamp from the host's trusted clock. */
  readonly evaluationTime: string;
}

/** What a verified status deliberately does not establish. */
interface SovereignStatusNotEvaluated {
  /** Whether a newer status exists is unknown: no history, high-water mark or witness is consulted. */
  readonly freshness: 'not_evaluated';
  /** Whether a later status revoked or superseded this one is unknown. */
  readonly revocationCurrentness: 'not_evaluated';
  /** No operation is authorized and no capability is issued. */
  readonly authorization: 'not_evaluated';
  readonly execution: 'not_performed';
}

/**
 * The presented status is authentic, signed by the expected registrant's
 * trusted key, well formed, bound to the expected asset and manifest (and
 * terms, when requested), and inside its own validity window at
 * `evaluationTime`. Nothing more: it may already be superseded.
 */
export interface SovereignStatusVerified extends SovereignStatusNotEvaluated {
  readonly outcome: 'authentic_authorized';
  readonly verifier: SovereignStatusVerifier;
  readonly statusProfile: SovereignStatusProfile;
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly manifestDigest: string;
  /** What the status asserts. `active` is not an authorization and not a freshness claim. */
  readonly assetStatus: SovereignAssetStatusValue;
  readonly currentTerms: SovereignStatusTermsReference | null;
  readonly termsBinding: 'matches_expected' | 'not_requested';
  readonly sequence: number;
  readonly previousStatusDigest: string | null;
  /** The signed payload's digest (`proof.payloadHash`, recomputed by verification). */
  readonly statusDigest: string;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly evaluationTime: string;
  readonly temporalValidity: 'within_validity_window';
}

export interface SovereignStatusRejected extends SovereignStatusNotEvaluated {
  readonly outcome: 'rejected';
  readonly verifier: SovereignStatusVerifier;
  readonly statusProfile: SovereignStatusProfile;
  readonly reason: SovereignStatusRejectionReason;
}

export type SovereignStatusVerificationResult = SovereignStatusVerified | SovereignStatusRejected;
