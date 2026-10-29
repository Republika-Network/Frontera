import type { DocumentUseAction, DocumentUsePolicyDecisionValue, DocumentUsePolicyReference } from './document-policy-types.js';
import type { SovereignAssetStatusValue, SovereignStatusRejectionReason } from './sovereign-status-types.js';
import type { ReceiverVerificationKeyResolver } from './types.js';

/** Identifies the freshness rules `checkDocumentUseFreshness` applies. */
export const DOCUMENT_USE_FRESHNESS_GATE = 'aoc-enterprise.document-use-freshness/1' as const;
export type DocumentUseFreshnessGate = typeof DOCUMENT_USE_FRESHNESS_GATE;

/**
 * The largest status age, in seconds, a host may configure per action. A host
 * may configure less; nothing may configure more. These are operational
 * ceilings, independent of (and much shorter than) the seven-day maximum
 * validity window of a signed status.
 */
export const DOCUMENT_USE_FRESHNESS_CEILINGS: Readonly<Record<DocumentUseAction, number>> = Object.freeze({
  'aoc.licensing:access': 86_400,
  'soberania.document:export': 900,
  'soberania.document:modify-protected-terms': 900,
});

/**
 * The closed set of freshness verdicts. Exactly one is reported; only `FRESH`
 * lets a policy decision stand.
 */
export const DOCUMENT_USE_FRESHNESS_VERDICTS = Object.freeze([
  'FRESH',
  // What the receiver's latest known status says
  'STALE',
  'EXPIRED',
  'REVOKED',
  'WITHDRAWN',
  'SUPERSEDED',
  // History
  'UNKNOWN',
  'ROLLBACK_DETECTED',
  'CONFLICT_DETECTED',
  'CONTINUITY_UNPROVEN',
  'HISTORY_UNINITIALIZED',
  'HISTORY_STORE_UNAVAILABLE',
  'HISTORY_STORE_INVALID',
  'CLOCK_ROLLBACK_DETECTED',
  // The status itself
  'STATUS_BINDING_MISMATCH',
  'STATUS_VERIFICATION_FAILED',
  // Inputs
  'POLICY_PROVENANCE_INVALID',
  'UNSUPPORTED_ACTION',
  'CONTEXT_INVALID',
  // Anything unexpected
  'GATE_ERROR',
] as const);
export type DocumentUseFreshnessVerdict = (typeof DOCUMENT_USE_FRESHNESS_VERDICTS)[number];

/** One receiver history: a registrant's statuses for one asset. */
export interface StatusHistoryKey {
  readonly sovereignAssetId: string;
  readonly issuer: string;
}

/**
 * What this receiver has trusted so far about one `(asset, issuer)` history.
 * It records only what this receiver observed; it says nothing about statuses
 * that never reached it.
 */
export interface StatusHighWaterMark {
  readonly sovereignAssetId: string;
  readonly issuer: string;
  /** The highest sequence accepted. Never decreases. */
  readonly sequence: number;
  /** The digest of the status accepted at `sequence`. */
  readonly statusDigest: string;
  /** That status's `issuedAt`. */
  readonly issuedAt: string;
  /** That status's current terms digest, or `null` when it named none. */
  readonly currentTermsDigest: string | null;
  /** The latest `issuedAt` ever accepted: the trusted clock must never be behind it. */
  readonly timeFloor: string;
  /** Set once a `withdrawn` status is accepted. Terminal. */
  readonly withdrawn: boolean;
  /** Terms digests a later status replaced or revoked. They may never become current again. Sorted, unique. */
  readonly retiredTermsDigests: readonly string[];
  /** `verified` while every accepted status linked to its predecessor; `unproven` after a sequence gap. Sticky. */
  readonly continuity: 'verified' | 'unproven';
  /** Set once two incompatible statuses were seen (equivocation, fork, reactivation). Sticky. */
  readonly conflict: boolean;
  /** The trusted instant the history was established or re-established by bootstrap. */
  readonly anchoredAt: string;
}

/** A stored mark with its store-assigned revision. */
export interface StatusHighWaterMarkEntry {
  readonly revision: number;
  readonly mark: StatusHighWaterMark;
}

/**
 * The receiver-owned history store. Not a registry: it holds only what this
 * receiver trusted. Implementations must make `compareAndSet` atomic against
 * a single authoritative state: it succeeds only when the stored revision is
 * still `expectedRevision` (`null`: no entry exists), and then stores `next`
 * under a new, higher revision. Concurrent conflicting writers can therefore
 * never both succeed.
 */
export interface StatusHighWaterMarkStore {
  read(key: StatusHistoryKey): Promise<StatusHighWaterMarkEntry | undefined>;
  compareAndSet(key: StatusHistoryKey, expectedRevision: number | null, next: StatusHighWaterMark): Promise<boolean>;
}

/** Per-action maximum status age in seconds: an integer from 1 to the action's ceiling. */
export type DocumentUseFreshnessPolicy = Readonly<Record<DocumentUseAction, number>>;

/**
 * Supplied by the receiving host, never by a requester. The gate checks form
 * and ceilings; it cannot authenticate these values.
 */
export interface DocumentUseFreshnessTrustedContext {
  /** The same trusted resolver that verified the asset; asked only for the verified registrant. */
  readonly verificationKeyResolver: ReceiverVerificationKeyResolver;
  /** Must equal the decision's own `evaluationTime`: one trusted instant for policy and freshness. */
  readonly evaluationTime: string;
  /** The host's identifier for the operation being considered, echoed for evidence. */
  readonly operationId: string;
  readonly maxStatusAgeSeconds: DocumentUseFreshnessPolicy;
  readonly historyStore: StatusHighWaterMarkStore;
}

/** The status the gate checked, by identity only. */
export interface DocumentUseFreshnessStatusEvidence {
  readonly sequence: number;
  readonly statusDigest: string;
  readonly assetStatus: SovereignAssetStatusValue;
  readonly currentTermsDigest: string | null;
  readonly issuedAt: string;
  readonly validUntil: string;
}

export interface DocumentUseFreshnessHistoryEvidence {
  /** `UNKNOWN` when the store could not be read or the gate never reached it. */
  readonly initialization: 'ESTABLISHED' | 'UNINITIALIZED' | 'UNKNOWN';
  readonly before: { readonly sequence: number; readonly statusDigest: string } | null;
  readonly after: { readonly sequence: number; readonly statusDigest: string } | null;
  readonly transition: 'not_attempted' | 'unchanged' | 'advanced' | 'advanced_with_gap' | 'conflict_recorded' | 'refused';
}

export interface DocumentUseFreshnessResult {
  readonly gate: DocumentUseFreshnessGate;
  /** The host's operation identifier when the context was valid; `null` otherwise. */
  readonly operationId: string | null;
  readonly action: string | null;
  readonly sovereignAssetId: string | null;
  readonly policy: DocumentUsePolicyReference | null;
  readonly evaluationTime: string | null;
  /** The FV-P3 decision; `null` when the decision was not issued by FV-P3 in this process. */
  readonly policyDecisionBefore: DocumentUsePolicyDecisionValue | null;
  /**
   * `ALLOWED` only when the decision was `ALLOWED` and the verdict is `FRESH`;
   * `WITHHELD` only when it was `WITHHELD` and the verdict is `FRESH` (still not
   * executable: approval is pending); `DENIED` otherwise. Never higher than before.
   */
  readonly policyDecisionAfterFreshness: DocumentUsePolicyDecisionValue;
  readonly freshnessVerdict: DocumentUseFreshnessVerdict;
  /** The status verifier's reason when the presented status was rejected. */
  readonly statusRejection: SovereignStatusRejectionReason | null;
  readonly status: DocumentUseFreshnessStatusEvidence | null;
  readonly history: DocumentUseFreshnessHistoryEvidence;
  /** The maximum age applied, in seconds; `null` when none was reached. */
  readonly maxStatusAgeSeconds: number | null;
  /** Freshness is not authorization; nothing was authorized, issued or executed. */
  readonly authorization: 'not_evaluated';
  readonly execution: 'not_performed';
}

export const STATUS_HISTORY_BOOTSTRAP_REASONS = Object.freeze([
  'ESTABLISHED',
  'REESTABLISHED',
  'CONTEXT_INVALID',
  'STATUS_REJECTED',
  'ALREADY_ESTABLISHED',
  'CONFLICT_DETECTED',
  'REANCHOR_ROLLBACK',
  'REANCHOR_REACTIVATES_WITHDRAWN',
  'REANCHOR_REINTRODUCES_RETIRED_TERMS',
  'CLOCK_ROLLBACK_DETECTED',
  'HISTORY_STORE_UNAVAILABLE',
  'HISTORY_STORE_INVALID',
  'BOOTSTRAP_ERROR',
] as const);
export type StatusHistoryBootstrapReason = (typeof STATUS_HISTORY_BOOTSTRAP_REASONS)[number];

/**
 * The trusted, out-of-band operation that anchors a receiver history. It is
 * never reached from a request: the host runs it with a status it obtained
 * through a channel it trusts to be current (for example directly from the
 * registrant), and that trust is the bootstrap's assumption.
 */
export interface StatusHistoryBootstrapContext {
  readonly verificationKeyResolver: ReceiverVerificationKeyResolver;
  readonly historyStore: StatusHighWaterMarkStore;
  readonly expectedSovereignAssetId: string;
  readonly expectedRegistrant: string;
  readonly expectedManifestDigest: string;
  readonly evaluationTime: string;
  /**
   * Re-anchor an existing history (for example to restore continuity after a
   * sequence gap). Never lowers the sequence, never reopens a withdrawal, never
   * makes retired terms current, and never clears a latched conflict: a
   * history with a conflict is refused (`CONFLICT_DETECTED`).
   */
  readonly reanchor?: true;
}

export interface StatusHistoryBootstrapResult {
  readonly outcome: 'established' | 'refused';
  readonly reason: StatusHistoryBootstrapReason;
  readonly statusRejection: SovereignStatusRejectionReason | null;
  readonly mark: StatusHighWaterMark | null;
}
