import type { ExerciseReservationReleaseReason, ExerciseReservationSettleReason } from '../../features/exercise-control-runtime/index.js';
import type { ExecutionFailureReason } from '../../features/execution-runtime/index.js';
import type { GrantRevocationReason } from '../../features/grant-runtime/index.js';

/**
 * P8 — the canonical authority event stream: its vocabulary and record shapes.
 *
 * ## What it is
 *
 * A durable, append-only, ordered and hash-chained record of facts that the
 * governed-action / bounded-grant lifecycle has **already** established in its
 * authoritative stores: a committed decision, an issued or revoked grant, a
 * write-ahead execution claim, a P7 reservation and its terminal event, and the
 * outcome the execution runtime reported. One stream per governed-action
 * request, tenant-confined, contiguous from sequence 1.
 *
 * ## What it is not
 *
 * **Evidence, never authority.** Nothing on any authorization path reads this
 * stream: not the Kernel, not grant issuance, not the exercise gate, not
 * exercise-control admission, not emergency control, not routing, not replay.
 * Every authoritative question keeps its existing owner — the Governance Store
 * for committed decisions and the at-most-once execution claim, the bounded-grant
 * store for grants and revocations, the exercise-control ledger for aggregate
 * consumption, the emergency-control store for the interlock. A missing, late,
 * failed or corrupt event changes none of their answers.
 *
 * It is not `EnterpriseUsageEvent` (the pure R004 contract for observed use of an
 * `EnterpriseAccessGrant`), not `EnterpriseEvidenceCorrelation` (an unordered
 * graph of which artifacts belong together), not `GovernanceEventRecord`
 * (operational Host events embedded in one evaluation aggregate), and not the
 * Agent Passport or emergency-control chains (per-aggregate histories of other
 * domains). See `docs/architecture/ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md`.
 *
 * ## Integrity, not authenticity
 *
 * Digests are unkeyed SHA-256 over `aoc.canonical-json.v1`, reused verbatim from
 * the Governance Store. They make mutation, deletion, insertion, reordering and
 * head drift detectable; they do not stop a writer who rewrites a whole stream
 * and re-seals it consistently, and they are not a signature.
 */

/** The record format carried inside every event's digested bytes. Bumped only when those bytes change. */
export const AUTHORITY_EVENT_SCHEMA_VERSION = 'aoc.authority-event.v1';

/** The durable store's schema version. A file recorded under any other value is refused at open, before mutation. */
export const AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION = 'aoc.authority-event-stream.schema.v1';

/**
 * The closed event vocabulary. Each name says what kind of fact it records and
 * how certain that fact is:
 *
 * | event | the authoritative fact it reports |
 * | --- | --- |
 * | `governance.decision.committed` | a Governance Record was committed and re-verified |
 * | `grant.issued` | the bounded-grant store holds this grant |
 * | `grant.revoked` | the bounded-grant store holds a revocation for this grant |
 * | `grant.expiry.observed` | an exercise assessment found the grant past its `expiresAt` — an observation, never a persisted transition |
 * | `execution.attempt.claimed` | the durable write-ahead claim for this execution identity was appended |
 * | `exercise.reservation.reserved` | the P7 ledger admitted and recorded this reservation |
 * | `exercise.reservation.settled` | the P7 ledger recorded the settlement |
 * | `exercise.reservation.released` | the P7 ledger recorded the release |
 * | `execution.outcome.observed` | the execution runtime returned this `ExecutionOutcome` |
 */
export const AUTHORITY_EVENT_TYPES = [
  'governance.decision.committed',
  'grant.issued',
  'grant.revoked',
  'grant.expiry.observed',
  'execution.attempt.claimed',
  'exercise.reservation.reserved',
  'exercise.reservation.settled',
  'exercise.reservation.released',
  'execution.outcome.observed',
] as const;

export type AuthorityEventType = (typeof AUTHORITY_EVENT_TYPES)[number];

export function isAuthorityEventType(value: unknown): value is AuthorityEventType {
  return typeof value === 'string' && (AUTHORITY_EVENT_TYPES as readonly string[]).includes(value);
}

/** The one event type a stream may begin with, and may hold only once: a lifecycle stream exists because a decision was committed. */
export const AUTHORITY_EVENT_GENESIS_TYPE: AuthorityEventType = 'governance.decision.committed';

/**
 * The opaque, server-derived identities an event may reference. Every one of
 * them already exists in an authoritative store; the stream mints none of them
 * and none is caller input. Which keys an event carries is fixed per event type
 * (`validation.ts`), so a reference can be neither omitted nor smuggled in.
 */
export interface AuthorityEventReferences {
  /** The governed-action request identity (`aoc.gar:…`). Present on every event: it is what the stream is keyed by. */
  readonly requestId: string;
  readonly evaluationId?: string;
  readonly decisionId?: string;
  readonly boundedGrantId?: string;
  readonly executionId?: string;
  readonly reservationId?: string;
}

export const AUTHORITY_EVENT_REFERENCE_KEYS = ['requestId', 'evaluationId', 'decisionId', 'boundedGrantId', 'executionId', 'reservationId'] as const;

export type AuthorityEventReferenceKey = (typeof AUTHORITY_EVENT_REFERENCE_KEYS)[number];

/** The internal `ExecutionOutcome.status` values, verbatim. Never collapsed into a boolean. */
export type AuthorityEventExecutionStatus = 'executed' | 'execution-failed' | 'execution-unconfirmed' | 'withheld';

/** Which layer withheld an effect, exactly as the execution ledger records it. */
export type AuthorityEventWithholdingLayer = 'grant-exercise' | 'emergency-control' | 'exercise-control';

/**
 * The committed decision status, restated as data. Spelled here rather than
 * imported so the evidence layer never depends on the Kernel;
 * `authority-event-stream-boundaries.test.ts` proves it is exactly
 * `KernelDecisionStatus`, so the two cannot drift.
 */
export type AuthorityEventDecisionStatus = 'allowed' | 'denied' | 'approval_required' | 'indeterminate';

export interface DecisionCommittedPayload {
  readonly status: AuthorityEventDecisionStatus;
  /** The Kernel's own codes, verbatim and in order, from the committed record. */
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  /** The committed aggregate's own integrity digest — a reference, never a copy of the record. */
  readonly aggregateDigest: string;
}

export interface GrantIssuedPayload {
  readonly grantDigest: string;
  readonly expiresAt: string;
  readonly authorityBindingDigest?: string;
}

export interface GrantRevokedPayload {
  readonly reason: GrantRevocationReason;
}

export interface GrantExpiryObservedPayload {
  /** The grant's own expiry instant — also the event's `occurredAt`, because expiry is derived from the clock, not recorded by anyone. */
  readonly expiresAt: string;
}

export type ExecutionAttemptClaimedPayload = Readonly<Record<string, never>>;

export interface ReservationReservedPayload {
  readonly policyDigest: string;
  readonly authorityBindingDigest: string;
}

export interface ReservationSettledPayload {
  readonly reason: ExerciseReservationSettleReason;
}

export interface ReservationReleasedPayload {
  readonly reason: ExerciseReservationReleaseReason;
}

export interface ExecutionOutcomeObservedPayload {
  readonly status: AuthorityEventExecutionStatus;
  /** Present exactly when `status` is `withheld`. */
  readonly withheldBy?: AuthorityEventWithholdingLayer;
  /** The withholding layer's own codes, or the one provider-failure reason; empty for `executed` and `execution-unconfirmed`. */
  readonly reasonCodes: readonly string[];
  /** Present exactly when `status` is `execution-failed`. */
  readonly failure?: ExecutionFailureReason;
  /** The adapter that performed (or was asked to perform) the effect, when the runtime attributed one. Absent for `withheld`. */
  readonly adapterId?: string;
  readonly routedBy?: string;
  /** The adapter's provider-neutral handle. Evidence and correlation only: never dereferenced, never executable, never proof of execution. */
  readonly providerRef?: string;
  /** Whether the Governance Store outcome reference was written. Reported beside the outcome, never instead of it. */
  readonly outcomeRecorded: boolean;
}

/** The type-specific half of an event: which fact, about which artifacts. */
export type AuthorityEventBody =
  | { readonly eventType: 'governance.decision.committed'; readonly references: AuthorityEventReferences; readonly payload: DecisionCommittedPayload }
  | { readonly eventType: 'grant.issued'; readonly references: AuthorityEventReferences; readonly payload: GrantIssuedPayload }
  | { readonly eventType: 'grant.revoked'; readonly references: AuthorityEventReferences; readonly payload: GrantRevokedPayload }
  | { readonly eventType: 'grant.expiry.observed'; readonly references: AuthorityEventReferences; readonly payload: GrantExpiryObservedPayload }
  | { readonly eventType: 'execution.attempt.claimed'; readonly references: AuthorityEventReferences; readonly payload: ExecutionAttemptClaimedPayload }
  | { readonly eventType: 'exercise.reservation.reserved'; readonly references: AuthorityEventReferences; readonly payload: ReservationReservedPayload }
  | { readonly eventType: 'exercise.reservation.settled'; readonly references: AuthorityEventReferences; readonly payload: ReservationSettledPayload }
  | { readonly eventType: 'exercise.reservation.released'; readonly references: AuthorityEventReferences; readonly payload: ReservationReleasedPayload }
  | { readonly eventType: 'execution.outcome.observed'; readonly references: AuthorityEventReferences; readonly payload: ExecutionOutcomeObservedPayload };

/**
 * What a projector hands the store: one immutable source fact. Everything the
 * store owns is absent — sequence, `recordedAt`, previous digest, event digest —
 * so no writer can choose where an event sits, when it was recorded, or what it
 * chains to.
 */
export type AppendAuthorityEventInput = AuthorityEventBody & {
  /** Deterministic from the source fact (`deriveAuthorityEventId`). The same fact always carries the same id. */
  readonly eventId: string;
  /** Deterministic from the organization and the request (`deriveAuthorityEventStreamId`). */
  readonly streamId: string;
  readonly organizationId: string;
  /** The trusted instant of the source fact, taken from the authoritative artifact — never projection time. */
  readonly occurredAt: string;
};

/**
 * One persisted canonical event.
 *
 * `eventDigest` covers every other field here, including `sequence`,
 * `recordedAt`, `organizationId` and `previousEventDigest`, so none of them can
 * change without verification failing.
 */
export type AuthorityEvent = AppendAuthorityEventInput & {
  readonly schemaVersion: typeof AUTHORITY_EVENT_SCHEMA_VERSION;
  /** 1-based, contiguous within the stream, assigned by the store inside its critical section. */
  readonly sequence: number;
  /** The store's injected clock, sampled inside the append critical section. Never caller input. */
  readonly recordedAt: string;
  /** The immediately preceding event's digest. Absent on sequence 1, and only there. */
  readonly previousEventDigest?: string;
  readonly eventDigest: string;
};

/**
 * The tenant scope a store call runs under. There is deliberately no `system`
 * escape: Stage A has no cross-tenant reader, so nothing may read or append a
 * stream other than as the organization that owns it.
 */
export interface AuthorityEventStreamAccessContext {
  readonly organizationId: string;
}

/**
 * `appended` — a new event now sits at the stream head.
 * `existing` — an event with this id and a byte-equivalent canonical fact was
 * already recorded; it is returned unchanged, never re-dated or re-sequenced.
 *
 * The same id with a *different* fact is never an outcome: it is a thrown
 * `AUTHORITY_EVENT_CONFLICT`, and nothing is written.
 */
export interface AppendAuthorityEventResult {
  readonly outcome: 'appended' | 'existing';
  readonly event: AuthorityEvent;
}

/** A persisted stream head: a projection that summarizes the chain, never a substitute for verifying it. */
export interface AuthorityEventStreamHead {
  readonly streamId: string;
  readonly organizationId: string;
  readonly sequence: number;
  readonly eventDigest: string;
}

/**
 * What verifying one stream established. `valid: false` is reported rather than
 * repaired: no prefix is presented as the whole stream, nothing is skipped, and
 * nothing is rewritten.
 *
 * Integrity only. A corrupt stream is an evidence failure; it is never read as
 * permission for, or a refusal of, any new action.
 */
export interface AuthorityEventStreamVerification {
  readonly streamId: string;
  readonly valid: boolean;
  readonly eventCount: number;
  readonly head?: AuthorityEventStreamHead;
  readonly failures: readonly string[];
}

export interface AuthorityEventStreamStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}
