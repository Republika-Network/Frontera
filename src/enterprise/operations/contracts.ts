import type { AuthorityTraceFinalState, AuthorityTraceVerification } from '../evidence/trace-contracts.js';
import type { DisclosedAuthorityTrace } from '../evidence/trace-disclosure.js';
import type { EvidenceDisclosureMetadata } from '../evidence/contracts.js';
import type { EnterpriseHealthReport } from '../health/health-check.js';

/**
 * PROD-03-01 — Operational Visibility: the closed vocabulary an operator reads
 * the governed path in.
 *
 * Nothing here is a new state machine. Every classification is a projection
 * of facts the canonical stores already hold, read through the one ASSURE-01
 * trace builder (`evidence/trace-builder.ts`) and classified by one pure
 * function (`classification.ts`). The projection never decides, never writes
 * and is never read to decide anything.
 */

/**
 * Where one governed request stands, operationally. Closed.
 *
 * | State | Meaning (from the trace) |
 * |---|---|
 * | `decision-denied` | the Kernel denied it; no authority, no execution |
 * | `decision-indeterminate` | the Kernel could not decide; treated as a refusal |
 * | `approval-pending` | `approval_required`, the approval log is read and holds no verdict, no grant |
 * | `approval-not-resumed` | `approval_required`, no pending request, and no authority was issued (rejected, revoked, lapsed, or approved but not yet resumed) |
 * | `issuance-withheld` | the Kernel allowed it; issuance was evaluated and withheld (LAND-02 evidence), no grant |
 * | `allowed-not-authorized` | the Kernel allowed it; no grant and no issuance withholding is recorded (grant terms unavailable, or history from before LAND-02) |
 * | `authorized-not-claimed` | a bounded grant was issued; no execution was claimed |
 * | `withheld-at-exercise` | claimed, then withheld at the exercise boundary; nothing ran |
 * | `executed-succeeded` | claimed; the outcome is confirmed completed (initial observation or P12 resolution) |
 * | `executed-failed` | claimed; the outcome is confirmed not completed |
 * | `claimed-outcome-unconfirmed` | claimed; the provider's answer is recorded as unconfirmed and no resolution exists |
 * | `claimed-no-outcome` | claimed; no outcome is recorded at all (in flight, or a crash between claim and observation) |
 * | `trace-unverifiable` | a canonical store this request depends on failed its own checks |
 * | `trace-inconsistent` | the canonical records contradict each other |
 * | `trace-unavailable` | the trace could not be built for this record (over its bound, or unreadable) |
 * | `evaluation-only` | a Kernel decision recorded by the evaluate route, with no governed path |
 */
export const OPERATIONAL_STATES = [
  'decision-denied',
  'decision-indeterminate',
  'approval-pending',
  'approval-not-resumed',
  'issuance-withheld',
  'allowed-not-authorized',
  'authorized-not-claimed',
  'withheld-at-exercise',
  'executed-succeeded',
  'executed-failed',
  'claimed-outcome-unconfirmed',
  'claimed-no-outcome',
  'trace-unverifiable',
  'trace-inconsistent',
  'trace-unavailable',
  'evaluation-only',
] as const;

export type OperationalState = (typeof OPERATIONAL_STATES)[number];

/**
 * Why a request needs an operator's follow-up. Closed and fact-based: no age,
 * no timer, no threshold — Frontera defines no execution timeout, so a claim
 * in flight is reported as exactly what it is.
 *
 * Never attention: a Kernel denial, an issuance withholding, a pending
 * approval, a confirmed success, a confirmed failure, a withholding at the
 * exercise boundary. Those are governance working, not operational incidents.
 */
export const ATTENTION_REASONS = ['EXECUTION_CLAIMED_NO_OUTCOME', 'EXECUTION_OUTCOME_UNCONFIRMED', 'TRACE_UNVERIFIABLE', 'TRACE_INCONSISTENT', 'TRACE_UNAVAILABLE'] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** The definitive answer an execution has, if any. `none`: no outcome is recorded. */
export type OperationalOutcomeStatus = 'confirmed-completed' | 'confirmed-not-completed' | 'withheld' | 'unconfirmed' | 'none';

/** Where the definitive answer was read from. */
export type OperationalOutcomeSource = 'initial-observation' | 'resolution' | 'legacy-summary';

/**
 * One governed request, projected for an operator. Identities, closed states
 * and codes, and timestamps only: never an amount, a governed parameter, an
 * adapter or provider reference, a credential or a payload. The ASSURE-01
 * trace (`/api/admin/operations/traces/{requestId}`) holds the rest, under its
 * disclosure policy.
 */
export interface OperationalExecutionView {
  readonly requestId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly executionId: string | null;
  readonly actorId: string;
  readonly actionType: string;
  readonly classification: OperationalState;
  readonly attentionRequired: boolean;
  readonly attentionReasons: readonly AttentionReason[];
  /** An execution was claimed and no definitive outcome is recorded for it. */
  readonly unresolved: boolean;
  readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string; readonly persistedAt: string };
  /** `null` when the decision path carries no approval requirement. */
  readonly approval: { readonly presence: string; readonly verdicts: readonly string[] } | null;
  readonly issuance: {
    readonly status: 'issued' | 'withheld' | 'not-reached' | 'not-applicable' | 'unknown';
    readonly withheldBy: string | null;
    readonly reasonCodes: readonly string[];
    readonly recordedAt: string | null;
  };
  readonly execution: { readonly claim: 'recorded' | 'absent' | 'unknown'; readonly claimedAt: string | null };
  readonly outcome: {
    readonly status: OperationalOutcomeStatus;
    readonly source: OperationalOutcomeSource | null;
    readonly failure: string | null;
    readonly withheldBy: string | null;
    readonly reasonCodes: readonly string[];
    readonly recordedAt: string | null;
  };
  readonly trace: { readonly available: boolean; readonly finalState: AuthorityTraceFinalState | null; readonly failure: string | null };
}

export interface OperationalExecutionPage {
  /** Newest committed first (the Governance Store's chain order). */
  readonly executions: readonly OperationalExecutionView[];
  /** Opaque; `null` on the last page. */
  readonly nextCursor: string | null;
  readonly coverage: 'governance-store-decisions-classified-by-trace';
}

export interface OperationalAttentionPage {
  /** Executions claimed without a definitive recorded outcome, newest first; every entry requires attention. */
  readonly attention: readonly OperationalExecutionView[];
  /** Opaque; `null` when the candidate set is exhausted. A page may hold fewer entries than its limit. */
  readonly nextCursor: string | null;
  /** Candidates on this page whose trace showed a definitive outcome after all (a summary row that failed to write), and so were left out. */
  readonly resolvedOnRead: number;
  readonly coverage: 'execution-claims-without-definitive-outcome';
}

/** The bounded, read-only scan behind every operational count. */
export interface OperationalScan {
  /** Claims the Governance Store holds with no definitive outcome row: the candidates. */
  readonly candidates: number;
  /** How many candidates this read classified through their trace. */
  readonly examined: number;
  /** `true` when every candidate was examined; when `false` the counts below are lower bounds. */
  readonly complete: boolean;
  readonly limit: number;
}

export interface OperationalHealth {
  /** Claimed executions with no definitive outcome, confirmed by their trace. */
  readonly unresolvedExecutions: number;
  /** Requests among the candidates whose classification requires attention (`unresolvedExecutions` plus unverifiable ones). */
  readonly attentionRequired: number;
  readonly scan: OperationalScan;
  readonly checkedAt: string;
}

/** `GET /api/admin/operations/health` — the Host's health report, with the operational counts. Aggregates only: no request detail. */
export interface OperationalHealthView {
  readonly health: EnterpriseHealthReport;
  readonly operations: OperationalHealth;
}

/**
 * `GET /api/admin/operations/metrics` — closed counters, computed on read from
 * the durable stores (nothing is counted in memory, so a restart loses
 * nothing). A counter that cannot be stated honestly is `null`.
 */
export interface OperationalMetrics {
  readonly decisions: { readonly total: number; readonly allowed: number; readonly denied: number; readonly approvalRequired: number; readonly indeterminate: number };
  /** Decisions carrying LAND-02 issuance-withheld evidence. */
  readonly issuanceWithheld: number;
  /** Decisions holding a write-ahead execution claim. */
  readonly executionClaims: number;
  /** Claims with a definitive outcome (completed, not completed, or withheld at exercise). `null` when the scan was not complete. */
  readonly confirmedOutcomes: number | null;
  readonly unresolvedExecutions: number;
  readonly attentionRequired: number;
  readonly scan: OperationalScan;
  readonly computedAt: string;
  readonly coverage: 'governance-store-counts-and-claim-scan';
}

/** `GET /api/admin/operations/traces/{requestId}` — the ASSURE-01 trace, disclosed at an operator level, with its verification and classification. */
export interface OperationalTraceView {
  readonly requestId: string;
  readonly disclosure: EvidenceDisclosureMetadata;
  readonly trace: DisclosedAuthorityTrace;
  /** Digest of exactly the disclosed trace above — the value the customer-plane trace read returns for the same level. */
  readonly traceDigest: string;
  readonly verification: AuthorityTraceVerification;
  readonly operational: OperationalExecutionView;
  readonly generatedAt: string;
}

/** Operator trace levels: every v2 level except FULL, which is internal (`evidence-service.ts`). */
export const OPERATOR_TRACE_LEVELS = ['AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC'] as const;

export const OPERATIONS_PAGE_DEFAULT_LIMIT = 25;
/** Each entry is a full trace build, so a page is held well below the Governance Store's own maximum. */
export const OPERATIONS_PAGE_MAX_LIMIT = 50;
/** How many candidates one count may classify. Beyond it, counts are reported as lower bounds (`scan.complete: false`). */
export const OPERATIONS_SCAN_LIMIT = 500;
