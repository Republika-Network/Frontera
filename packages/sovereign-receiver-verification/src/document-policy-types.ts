import type { DocumentUseProfile } from './document-use-types.js';

/** Identifies the evaluation rules `evaluateDocumentUsePolicy` applies. */
export const DOCUMENT_USE_POLICY_EVALUATOR = 'aoc-enterprise.document-use-policy-evaluation/1' as const;
export type DocumentUsePolicyEvaluator = typeof DOCUMENT_USE_POLICY_EVALUATOR;

/** The profile's three actions, named by their concept identity (profile §3). */
export const DOCUMENT_USE_ACTIONS = Object.freeze([
  'aoc.licensing:access',
  'soberania.document:export',
  'soberania.document:modify-protected-terms',
] as const);
export type DocumentUseAction = (typeof DOCUMENT_USE_ACTIONS)[number];

export type DocumentUsePolicyDecisionValue = 'ALLOWED' | 'DENIED' | 'WITHHELD';

/**
 * The closed set of reasons. Exactly one is reported per decision: the step of
 * the profile's ordered semantics (or the input check) that settled it.
 */
export const DOCUMENT_USE_POLICY_REASONS = Object.freeze([
  // ALLOWED
  'PERMITTED',
  // WITHHELD
  'OWNER_APPROVAL_REQUIRED',
  // DENIED — inputs
  'ELIGIBILITY_UNVERIFIED',
  'REQUEST_INVALID',
  'CONTEXT_INVALID',
  'ACTION_UNKNOWN',
  'EVALUATION_TIME_INVALID',
  'RECEIVER_IDENTITY_INVALID',
  'ASSET_MISMATCH',
  'POLICY_REFERENCE_MISMATCH',
  // DENIED — terms applicability
  'TERMS_TIME_INVALID',
  'TERMS_NOT_YET_EFFECTIVE',
  'TERMS_EXPIRED',
  'AUDIENCE_UNSUPPORTED',
  'AUDIENCE_MISMATCH',
  // DENIED — rule semantics
  'CONCEPT_UNSUPPORTED',
  'EFFECT_UNSUPPORTED',
  'EFFECT_MISPLACED',
  'RESTRICTED',
  'NOT_PERMITTED',
  // DENIED — anything unexpected
  'EVALUATION_ERROR',
] as const);
export type DocumentUsePolicyReason = (typeof DOCUMENT_USE_POLICY_REASONS)[number];

/** The applicable terms a decision was taken under. Identity only: never the terms' content or the document. */
export interface DocumentUsePolicyReference {
  readonly claimId: string;
  readonly claimDigest: string;
}

/**
 * The caller's request. Untrusted: it names the action and nothing else, so no
 * field of a user request can become a source of time, identity, policy or approval.
 */
export interface DocumentUsePolicyRequest {
  readonly action: string;
}

/**
 * Supplied by the receiving host, never by the requester. The evaluator
 * cannot authenticate these values; it only refuses malformed ones.
 *
 * There is deliberately no approval field: the approval evidence format is not
 * defined (profile §4 step 5), so nothing can turn WITHHELD into ALLOWED.
 */
export interface DocumentUsePolicyTrustedContext {
  /** The receiving platform's own principal identity, compared exactly with the terms audience. */
  readonly receiverPrincipal: string;
  /** A canonical UTC timestamp from the host's trusted clock. */
  readonly evaluationTime: string;
  /** The asset the host was asked to act on. */
  readonly expectedSovereignAssetId: string;
  /** The terms the host expects to be evaluated; must name the eligible terms exactly. */
  readonly policyReference: DocumentUsePolicyReference;
}

/** What a decision deliberately is not. */
interface DocumentUsePolicyNotEvaluated {
  /** No operation is authorized and no execution capability is issued. */
  readonly authorization: 'not_evaluated';
  /** Key, manifest and terms revocation are not checked. */
  readonly revocation: 'not_evaluated';
  /** Newer terms or manifests the bundle omitted cannot be detected. */
  readonly freshness: 'not_evaluated';
  /** Nothing was executed. */
  readonly execution: 'not_performed';
}

export interface DocumentUsePolicyDecision extends DocumentUsePolicyNotEvaluated {
  readonly decision: DocumentUsePolicyDecisionValue;
  readonly reason: DocumentUsePolicyReason;
  readonly evaluator: DocumentUsePolicyEvaluator;
  readonly documentProfile: DocumentUseProfile;
  /** The requested action when it was readable; `null` otherwise. */
  readonly action: string | null;
  /** The evaluated asset, from verified eligibility; `null` when none could be trusted. */
  readonly sovereignAssetId: string | null;
  /** The evaluated terms, from verified eligibility; `null` when none could be trusted. */
  readonly policy: DocumentUsePolicyReference | null;
  /** The instant the decision was evaluated at, as the host supplied it; `null` when invalid. */
  readonly evaluationTime: string | null;
  /** Ids of the rules that settled the decision, in authored order; empty when no rule did. */
  readonly matchedRuleIds: readonly string[];
}
