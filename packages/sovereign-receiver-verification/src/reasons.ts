/**
 * The closed set of reasons a strict receiver verification can reject with.
 *
 * Every rejection carries only codes from this list. Protocol's own reason
 * strings are mapped onto it rather than passed through, so a receiver can
 * switch exhaustively over the result and a future Protocol reason cannot
 * appear here unannounced: an unmapped one fails closed onto a generic code of
 * the stage that produced it.
 */
export const RECEIVER_VERIFICATION_REJECTION_REASONS = Object.freeze([
  // Input and options
  'INVALID_INPUT',
  'INVALID_OPTIONS',
  // Bundle representation (@aoc/protocol/portability)
  'BUNDLE_MALFORMED',
  'BUNDLE_UNSUPPORTED_SCHEMA',
  'BUNDLE_UNSUPPORTED_CANONICALIZATION',
  'BUNDLE_NOT_CANONICAL',
  'BUNDLE_INVALID',
  'UNSUPPORTED_ARTIFACT_KIND',
  // Sovereign asset identity (@aoc/protocol/identity)
  'SUBJECT_INVALID',
  'SUBJECT_MISMATCH',
  // Strict profile
  'NO_SIGNED_MANIFEST',
  'UNSIGNED_MANIFEST',
  'UNSIGNED_CLAIM',
  'REGISTRANT_DISCONTINUITY',
  'CURRENT_MANIFEST_SUPERSEDED',
  'STANDING_INVALID',
  'DUPLICATE_MANIFEST_VERSION',
  'DUPLICATE_CLAIM_ID',
  'MISSING_REFERENCED_CLAIM',
  // Manifests (@aoc/protocol/manifest)
  'MANIFEST_STRUCTURE_INVALID',
  'MANIFEST_DIGEST_MISMATCH',
  'MANIFEST_SIGNATURE_INVALID',
  'MANIFEST_VERIFICATION_FAILED',
  // Content identity
  'CONTENT_BYTES_REQUIRED',
  'CONTENT_IDENTITY_NOT_DECLARED',
  'CONTENT_DIGEST_MISMATCH',
  // Claims (@aoc/protocol/manifest)
  'CLAIM_STRUCTURE_INVALID',
  'CLAIM_DIGEST_MISMATCH',
  'CLAIM_SIGNATURE_INVALID',
  'CLAIM_VERIFICATION_FAILED',
  // Issuer-to-key binding
  'ISSUER_BINDING_MISMATCH',
  'ISSUER_BINDING_UNVERIFIED',
  'ISSUER_BINDING_NOT_PERFORMED',
  'KEY_RESOLVER_FAILED',
  // Interoperability (@aoc/protocol/interoperability)
  'CONSUMER_SUPPORT_INVALID',
  'INTEROPERABILITY_PARTIAL',
  'INTEROPERABILITY_INCOMPATIBLE',
  // Anything unexpected
  'INTERNAL_VERIFICATION_ERROR',
] as const);

export type ReceiverVerificationRejectionReason = (typeof RECEIVER_VERIFICATION_REJECTION_REASONS)[number];
