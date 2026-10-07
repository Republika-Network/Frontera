/**
 * ASSURE-01 — the Unified Authority-to-Outcome Trace.
 *
 * A trace is a deterministic, read-only **projection** of one governed request
 * over the canonical records that already exist for it:
 *
 *   Governance Record (request, decision) → approval log → obligation
 *   discharges → bounded grant (+ revocation) → write-ahead claim → P11
 *   attempt → P7 reservation → P11 initial observation → P12 binding /
 *   resolution → P8 authority events.
 *
 * It is not a store of its own and not a second truth: it is rebuilt from those
 * records on every read, every component carries the canonical identity and
 * digest it was read under, and nothing in it is copied forward as authority.
 * It never decides anything, and nothing ever reads it to decide anything.
 *
 * The lookup identity is the governed request id (`aoc.gar:…`), which
 * `POST /api/governed-actions` returns publicly. Every other identity is
 * **derived** from it exactly — the execution id is `H(requestId, decisionId)`,
 * the P8 stream id `H(organizationId, requestId)`, the grant the P11 attempt
 * names — never joined by time or by similarity.
 *
 * Each stage states one of a closed set of presences, so "this did not happen
 * on this path" (`not-applicable`, `not-reached`), "this has not happened yet"
 * (`unresolved`), "this should exist and does not" (`missing`) and "this exists
 * and cannot be believed" (`unreadable`) are never confused.
 */

export const AUTHORITY_TRACE_VERSION = 'aoc.authority-trace.v1';

export const AUTHORITY_TRACE_VERIFICATION_VERSION = 'aoc.authority-trace-verification.v1';

/** The governed request identity format (`governed-action/identifiers.ts`): the only lookup key a trace accepts. */
export const GOVERNED_REQUEST_ID_PATTERN = /^aoc\.gar:[0-9a-f]{32}$/;

/** Bounds on how much one trace may carry. A request whose canonical records exceed them is refused, never truncated. */
export const AUTHORITY_TRACE_LIMITS = {
  maxEvents: 256,
  maxGrants: 16,
  maxApprovalRecords: 256,
  maxObligationDischarges: 256,
} as const;

/**
 * - `recorded` — the canonical record exists and was read under its own integrity checks.
 * - `not-applicable` — the observed decision path never leads here (a denial has no grant).
 * - `not-reached` — the path could lead here and the canonical records show it did not (yet).
 * - `unresolved` — the stage began and its definitive answer does not exist (an unconfirmed outcome with no P12 resolution).
 * - `missing` — another canonical record says it must exist, and it does not.
 * - `unreadable` — it exists and failed its store's own integrity or authenticity checks.
 * - `not-composed` — this deployment composes no store for it.
 * - `none-recorded` — the store is composed and holds nothing for this request, and nothing requires that it should.
 */
export type AuthorityTracePresence = 'recorded' | 'not-applicable' | 'not-reached' | 'unresolved' | 'missing' | 'unreadable' | 'not-composed' | 'none-recorded';

export type AuthorityTraceDecisionPath = 'allowed' | 'denied' | 'approval_required' | 'indeterminate';

/**
 * Where the request ended, as the canonical records state it — never inferred
 * from a later stage. `executed-unconfirmed` stays unconfirmed until a P12
 * resolution exists; `claimed-outcome-unrecorded` is a write-ahead claim with
 * no initial observation (a crash window), never "executed".
 */
export type AuthorityTraceFinalState =
  | 'denied'
  | 'indeterminate'
  | 'approval-pending'
  | 'not-executed'
  | 'withheld-at-exercise'
  | 'executed-confirmed-completed'
  | 'executed-confirmed-not-completed'
  | 'executed-unconfirmed'
  | 'claimed-outcome-unrecorded'
  | 'resolved-confirmed-completed'
  | 'resolved-confirmed-not-completed'
  /** A canonical store this request depends on failed its own integrity checks: where the request ended cannot be stated. */
  | 'unverifiable'
  | 'inconsistent';

export interface AuthorityTraceRequestStage {
  readonly presence: 'recorded';
  readonly actorId: string;
  readonly actorType?: string;
  readonly actionType: string;
  readonly resourceScope: string;
  readonly requestedAt: string;
  readonly receivedAt: string;
  readonly payloadDigest: string;
  /** LAND-01 — present only when this request is a linked reconsideration. */
  readonly lineage?: AuthorityTraceLineage;
}

/**
 * LAND-01 — this request reconsiders an earlier withheld governed action.
 * Rebuilt from canonical records on every trace (the link row on this
 * evaluation, the original's own committed record), never copied from a
 * request field, and checked under `lineage.*`.
 */
export interface AuthorityTraceLineage {
  readonly role: 'reconsideration';
  /** Server-derived from the original request id; shared by the original and every linked reconsideration. */
  readonly businessIntentId: string;
  /** Digest of the business intent (who, action, resource, counterparty, amount, semantics) — equal on both requests. */
  readonly intentDigest: string;
  readonly reason: string;
  readonly reconsiders: {
    readonly requestId: string;
    readonly evaluationId: string;
    readonly decisionId: string;
    /** The original's committed status — historically true, never rewritten. */
    readonly status: string;
    readonly reasonCodes: readonly string[];
  };
  /** True when this reconsideration holds the original's one realization marker (it was allowed and proceeded to authority). */
  readonly realizedOriginal: boolean;
}

export interface AuthorityTraceDecisionStage {
  readonly presence: 'recorded';
  readonly status: AuthorityTraceDecisionPath;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly kernelVersion: string;
  /** The Governance Store's own aggregate digest — a reference, verified by the store, never recomputed here. */
  readonly aggregateDigest: string;
  readonly chainPosition: number;
}

export interface AuthorityTraceApprovalRecord {
  readonly sequence: number;
  readonly kind: string;
  readonly decisionId: string;
  readonly subjectDigest: string;
  readonly actorId?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly digest: string;
}

export interface AuthorityTraceApprovalStage {
  readonly presence: AuthorityTracePresence;
  /** `durable-authenticated` when the approval log's committed head is signed (CORE-05) — a property of the approval store, not of this trace. */
  readonly storeKind?: string;
  readonly records: readonly AuthorityTraceApprovalRecord[];
}

export interface AuthorityTraceObligationDischarge {
  readonly sequence: number;
  readonly obligationType: string;
  readonly sourceId: string;
  readonly outcome: string;
  readonly observedAt: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly digest: string;
}

export interface AuthorityTraceObligationStage {
  readonly presence: AuthorityTracePresence;
  readonly storeKind?: string;
  readonly discharges: readonly AuthorityTraceObligationDischarge[];
}

export interface AuthorityTraceRevocation {
  readonly revokedAt: string;
  readonly reason: string;
  readonly issuerRef: string;
}

export interface AuthorityTraceGrant {
  readonly presence: AuthorityTracePresence;
  readonly grantId: string;
  /** The digest the Governance Store's `authorization_artifact` reference recorded for this grant. */
  readonly referenceDigest?: string;
  readonly grantDigest?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly sourceDigest?: string;
  readonly authorityBindingDigest?: string;
  readonly semanticsFormat?: string;
  /** True for the grant the P11 attempt names — the one that was claimed and exercised. */
  readonly exercised: boolean;
  readonly revocation?: AuthorityTraceRevocation;
  readonly failure?: string;
}

export interface AuthorityTraceAuthorityStage {
  readonly presence: AuthorityTracePresence;
  /** `authenticated-durable` when grants and revocations verify under the deployment's trusted Ed25519 keys on every read (CORE-01) — a property of the grant store. */
  readonly storeKind?: string;
  readonly grants: readonly AuthorityTraceGrant[];
  /**
   * LAND-02 — present only when authority issuance was evaluated for this
   * decision and **withheld**: rebuilt from the durable `issuance_record` row
   * the orchestrator wrote from the issuance core's own result, checked under
   * `issuance.*`. The stage is then `recorded` (issuance was reached), with no
   * grant. Never re-decided here.
   */
  readonly issuance?: AuthorityTraceIssuance;
}

export interface AuthorityTraceIssuance {
  readonly presence: 'recorded';
  readonly outcome: 'withheld';
  readonly withheldBy: string;
  readonly reasonCodes: readonly string[];
  /** The requested amount, as the committed request states it. */
  readonly requested?: { readonly value: string; readonly unit: string };
  /** The authority ceiling the issuance core compared against (financial layer). */
  readonly ceiling?: { readonly value: string; readonly unit: string };
  readonly recordedAt: string;
  /** How many withholdings this decision recorded (a replay re-runs the gates; an identical outcome is recorded once). */
  readonly records: number;
}

export interface AuthorityTraceExecutionStage {
  readonly presence: AuthorityTracePresence;
  readonly executionId?: string;
  /** The write-ahead claim the Governance Store recorded, before any adapter. */
  readonly claim?: { readonly presence: AuthorityTracePresence; readonly claimedAt?: string };
  /** The P11 attempt record. */
  readonly attempt?: {
    readonly presence: AuthorityTracePresence;
    readonly schemaVersion?: string;
    readonly boundedGrantId?: string;
    readonly action?: string;
    readonly preparedAt?: string;
    readonly recordedAt?: string;
    readonly attemptDigest?: string;
    readonly failure?: string;
  };
}

/** The exercise-contained amount and typed parameters the P11 attempt bound — disclosed under their own field so a policy can withhold them. */
export interface AuthorityTraceParameterStage {
  readonly presence: AuthorityTracePresence;
  readonly amount?: { readonly value: string; readonly unit: string };
  readonly parameters?: readonly unknown[];
}

export interface AuthorityTraceReservationStage {
  readonly presence: AuthorityTracePresence;
  readonly reservationId?: string;
  readonly state?: string;
  readonly terminalReason?: string;
  readonly resolution?: string;
  readonly failure?: string;
}

export interface AuthorityTraceOutcomeStage {
  readonly presence: AuthorityTracePresence;
  readonly kind?: 'provider' | 'withheld';
  readonly certainty?: string;
  readonly failure?: string;
  readonly withheldBy?: string;
  readonly reasonCodes?: readonly string[];
  readonly adapterId?: string;
  readonly routedBy?: string;
  readonly providerRef?: string;
  readonly observedAt?: string;
  readonly recordedAt?: string;
  readonly observationDigest?: string;
  /** The compact summary the Governance execution ledger recorded (`executed`, `execution-unconfirmed`, `withheld:…`). */
  readonly governanceSummary?: string;
  /** True for an execution answered before P11 existed: the Governance summary is its only (and replay) record. */
  readonly legacy?: boolean;
  readonly readFailure?: string;
}

export interface AuthorityTraceResolutionStage {
  readonly presence: AuthorityTracePresence;
  readonly binding?: { readonly authorityId: string; readonly origin: string; readonly boundAt: string; readonly bindingDigest: string };
  readonly resolution?: {
    readonly authorityId: string;
    readonly certainty: string;
    readonly failure?: string;
    readonly providerRef?: string;
    readonly resolvedAt: string;
    readonly resolutionDigest: string;
    readonly basisObservationDigest?: string;
  };
  readonly governanceSummary?: string;
  readonly readFailure?: string;
}

export interface AuthorityTraceEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly previousEventDigest?: string;
  readonly eventDigest: string;
}

export interface AuthorityTraceEventStage {
  readonly presence: AuthorityTracePresence;
  readonly streamId?: string;
  readonly head?: { readonly sequence: number; readonly eventDigest: string };
  readonly events: readonly AuthorityTraceEvent[];
  readonly readFailure?: string;
}

export interface AuthorityTraceStages {
  readonly request: AuthorityTraceRequestStage;
  readonly decision: AuthorityTraceDecisionStage;
  readonly approval: AuthorityTraceApprovalStage;
  readonly obligations: AuthorityTraceObligationStage;
  readonly authority: AuthorityTraceAuthorityStage;
  readonly execution: AuthorityTraceExecutionStage;
  readonly parameters: AuthorityTraceParameterStage;
  readonly reservation: AuthorityTraceReservationStage;
  readonly outcome: AuthorityTraceOutcomeStage;
  readonly resolution: AuthorityTraceResolutionStage;
  readonly events: AuthorityTraceEventStage;
}

export type AuthorityTraceStageName = keyof AuthorityTraceStages;

export const AUTHORITY_TRACE_STAGE_NAMES: readonly AuthorityTraceStageName[] = [
  'request',
  'decision',
  'approval',
  'obligations',
  'authority',
  'execution',
  'parameters',
  'reservation',
  'outcome',
  'resolution',
  'events',
];

/** The canonical (pre-disclosure) trace. Deterministic over the canonical records: no clock, no random id. */
export interface AuthorityTrace {
  readonly traceVersion: typeof AUTHORITY_TRACE_VERSION;
  readonly requestId: string;
  readonly organizationId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  /** `H(requestId, decisionId)` — present only when the decision path can reach an execution identity (an `allowed` or `approval_required` decision). */
  readonly executionId?: string;
  readonly path: AuthorityTraceDecisionPath;
  readonly finalState: AuthorityTraceFinalState;
  readonly stages: AuthorityTraceStages;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * The properties a trace check establishes. They are kept apart on purpose and
 * never collapsed into one boolean:
 *
 * - `contract` — the trace version and identities are recognized and well formed;
 * - `integrity` — every digest a canonical store holds recomputes (the store's own read);
 * - `authenticity` — a signature over the artifact verified, **only** where the
 *   artifact itself carries one (grants and revocations, the approval and
 *   obligation chain heads). The trace itself is not signed (ASSURE-02);
 * - `correlation` — every component belongs to this request, decision, execution and grant;
 * - `completeness` — every component the observed path requires is present.
 */
export type AuthorityTraceCheckCategory = 'contract' | 'integrity' | 'authenticity' | 'correlation' | 'completeness';

export type AuthorityTraceCheckStatus = 'pass' | 'fail' | 'not-applicable';

export interface AuthorityTraceCheck {
  readonly check: string;
  readonly category: AuthorityTraceCheckCategory;
  readonly status: AuthorityTraceCheckStatus;
  /** A closed failure code or a short factual note. Never record content. */
  readonly detail?: string;
}

export interface AuthorityTraceVerification {
  readonly verificationVersion: typeof AUTHORITY_TRACE_VERIFICATION_VERSION;
  readonly traceVersion: typeof AUTHORITY_TRACE_VERSION;
  readonly requestId: string;
  /** True only when no check in any category failed. */
  readonly verified: boolean;
  readonly categories: Readonly<Record<AuthorityTraceCheckCategory, 'pass' | 'fail'>>;
  readonly checks: readonly AuthorityTraceCheck[];
  /** Digest of the canonical trace this verification was computed over (`aoc.canonical-json.v1`, SHA-256). Integrity of the projection, not a signature. Absent from a verification disclosed below AUDITOR. */
  readonly traceDigest?: string;
  readonly finalState: AuthorityTraceFinalState;
  readonly verifiedAt: string;
  /** What this verification does not establish, stated rather than implied. */
  readonly boundary: string;
}

export const AUTHORITY_TRACE_VERIFICATION_BOUNDARY =
  'Integrity, correlation and completeness of canonical records, recomputed now; authenticity only where an artifact carries its own signature (grants, revocations, approval and obligation chain heads). The trace and its digest are not signed (ASSURE-02), so this is not non-repudiation and does not bind a privileged writer who re-seals unsigned stores.';
