import { createHash } from 'crypto';

import { EXERCISE_CONTROL_REASON_CODES, type ExerciseControlReasonCode } from './exercise-control-reason-codes.js';
import {
  exerciseControlBucketKey,
  exerciseControlPolicyDigest,
  snapshotExerciseControlLimits,
  type ExerciseControlLimit,
  type ExerciseControlQuery,
} from './exercise-control-limits.js';
import {
  EXERCISE_DECIMAL_USAGE_DIGITS,
  addExerciseDecimals,
  compareExerciseDecimals,
  isCanonicalExerciseDecimal,
} from './exercise-decimal.js';

/**
 * One reservation of aggregate capacity for one execution identity, and the
 * pure rule both ledger implementations admit it under.
 *
 * ## Reservation before effect
 *
 * A reservation is written — durably, atomically across every applicable
 * limit — **before** the adapter is invoked, and it consumes capacity the
 * moment it exists. It is never "pending" in the sense of "not yet counted": a
 * process can crash one instruction after the provider received the request and
 * before anything recorded the outcome, and a pending reservation that did not
 * count would let the same capacity be spent twice.
 *
 * ```
 * reserved   (no terminal event)   consumes
 * settled    (terminal event)      consumes
 * released   (terminal event)      does not consume
 * ```
 *
 * A reservation is an immutable base record. Its state is derived from whether
 * one immutable terminal event exists beside it — the same model the
 * bounded-grant store uses for revocation — so there is no status column that
 * could be rewritten, and releasing capacity never deletes history.
 */

/** Deterministic: the same grant and execution identity always name the same reservation. No UUID, no counter, no clock. */
export function exerciseReservationId(input: { readonly boundedGrantId: string; readonly executionId: string }): string {
  const canonical = `{"boundedGrantId":${JSON.stringify(input.boundedGrantId)},"executionId":${JSON.stringify(input.executionId)}}`;
  return `aoc.exercise-reservation:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/** The validated exercise a reservation was admitted for. Everything that makes it *this* attempt; nothing a caller could have added. */
export interface ExerciseReservationSubject {
  readonly boundedGrantId: string;
  readonly executionId: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly counterparty?: string;
  readonly organization?: string;
  /** Canonical decimal text and unit, when the attempt states an amount. */
  readonly amount?: { readonly value: string; readonly unit: string };
  readonly correlation: ExerciseControlQuery['correlation'];
}

/** `sha256:<hex>` over the canonical form of the validated exercise. A re-delivered execution identity with any field different is a conflict, never a replay. */
export function exerciseReservationRequestDigest(subject: ExerciseReservationSubject): string {
  const canonical = [
    '{',
    [
      ...(subject.amount !== undefined ? [`"amount":{"unit":${JSON.stringify(subject.amount.unit)},"value":${JSON.stringify(subject.amount.value)}}`] : []),
      `"action":${JSON.stringify(subject.action)}`,
      `"boundedGrantId":${JSON.stringify(subject.boundedGrantId)}`,
      `"correlation":{"action":${JSON.stringify(subject.correlation.action)},"decisionId":${JSON.stringify(subject.correlation.decisionId)},"requestId":${JSON.stringify(subject.correlation.requestId)},"resourceScope":${JSON.stringify(subject.correlation.resourceScope)}}`,
      ...(subject.counterparty !== undefined ? [`"counterparty":${JSON.stringify(subject.counterparty)}`] : []),
      `"executionId":${JSON.stringify(subject.executionId)}`,
      ...(subject.organization !== undefined ? [`"organization":${JSON.stringify(subject.organization)}`] : []),
      `"resource":${JSON.stringify(subject.resource)}`,
      `"subject":${JSON.stringify(subject.subject)}`,
    ].join(','),
    '}',
  ].join('');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** One limit, and what this execution consumes of it: `"1"` for a count, the attempt's canonical amount for an amount. */
export interface ExerciseControlRuleUsage {
  readonly limit: ExerciseControlLimit;
  readonly usage: string;
}

/**
 * What a ledger is asked to admit.
 *
 * Every digest is recomputable from the fields beside it, and both ledger
 * implementations recompute the ones they can — the reservation id from the
 * grant and execution identity, the policy digest from the rules — so a
 * malformed request cannot be persisted as though it were a well-formed one.
 *
 * ## No instant
 *
 * A request carries **no** reservation instant, deliberately. The caller does
 * not know when admission will happen: the SQLite ledger's `BEGIN IMMEDIATE`
 * can wait on another writer for as long as its busy timeout, and an instant
 * sampled before that wait would start a rolling window's lifetime early — a
 * reservation that waited 50 s for the lock under a 60 s window would leave the
 * window 10 s after it began consuming. The authoritative ledger samples its
 * own injected clock **inside** its admission critical section, once, and that
 * one instant is the admission threshold, the persisted `reservedAt` and the
 * returned record's `reservedAt`.
 */
export interface ExerciseReservationRequest {
  readonly reservationId: string;
  readonly executionId: string;
  readonly boundedGrantId: string;
  readonly requestDigest: string;
  readonly policyDigest: string;
  /** The grant's own authority-binding provenance, verified equal to the current binding before this request was built. */
  readonly authorityBindingDigest: string;
  /** Sorted by `(limitId, scopeKey)`, at most one per bucket. */
  readonly rules: readonly ExerciseControlRuleUsage[];
}

/**
 * A persisted reservation: exactly the request that was admitted, plus the
 * instant the ledger admitted it at, returned as stored.
 */
export interface ExerciseReservationRecord extends ExerciseReservationRequest {
  /**
   * The reservation instant, assigned by the ledger inside its atomic admission
   * critical section — after any write-lock wait — from its injected clock.
   * Never supplied by a caller. Rolling windows age by this, never by
   * settlement time.
   */
  readonly reservedAt: string;
}

export const EXERCISE_RESERVATION_TERMINAL_KINDS = ['settled', 'released'] as const;
export type ExerciseReservationTerminalKind = (typeof EXERCISE_RESERVATION_TERMINAL_KINDS)[number];

/**
 * Why a reservation settled: the effect happened, or may have. Both keep
 * consuming capacity — an unconfirmed effect is never given its capacity back,
 * because the provider may have acted.
 */
export const EXERCISE_RESERVATION_SETTLE_REASONS = ['executed', 'execution-unconfirmed'] as const;
export type ExerciseReservationSettleReason = (typeof EXERCISE_RESERVATION_SETTLE_REASONS)[number];

/**
 * Why a reservation released: the port contract says the effect did not
 * complete (`execution-failed`), or a layer withheld the effect **after** the
 * reservation and before the adapter — so no provider was reached.
 */
export const EXERCISE_RESERVATION_RELEASE_REASONS = ['execution-failed', 'emergency-control', 'exercise-control', 'grant-exercise'] as const;
export type ExerciseReservationReleaseReason = (typeof EXERCISE_RESERVATION_RELEASE_REASONS)[number];

export type ExerciseReservationTerminalReason = ExerciseReservationSettleReason | ExerciseReservationReleaseReason;

export function isExerciseReservationSettleReason(value: unknown): value is ExerciseReservationSettleReason {
  return typeof value === 'string' && (EXERCISE_RESERVATION_SETTLE_REASONS as readonly string[]).includes(value);
}

export function isExerciseReservationReleaseReason(value: unknown): value is ExerciseReservationReleaseReason {
  return typeof value === 'string' && (EXERCISE_RESERVATION_RELEASE_REASONS as readonly string[]).includes(value);
}

/** Whether a terminal reason belongs to the terminal kind it is recorded under. A `released` event naming `executed` is corrupt, not a release. */
export function exerciseReservationTerminalReasonMatches(kind: ExerciseReservationTerminalKind, reason: unknown): boolean {
  return kind === 'settled' ? isExerciseReservationSettleReason(reason) : isExerciseReservationReleaseReason(reason);
}

export interface ExerciseReservationTerminalEvent {
  readonly reservationId: string;
  readonly kind: ExerciseReservationTerminalKind;
  readonly reason: ExerciseReservationTerminalReason;
  readonly recordedAt: string;
}

export type ExerciseReservationState = 'reserved' | 'settled' | 'released';

export interface ExerciseReservationView {
  readonly reservation: ExerciseReservationRecord;
  readonly state: ExerciseReservationState;
  readonly terminal?: ExerciseReservationTerminalEvent;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isWellFormedExerciseDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

/** Whether a value is an instant a ledger can record a reservation at. A ledger clock that answers anything else fails admission closed. */
export function isExerciseReservationInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** Whether a usage is the one its metric can consume: exactly `"1"` for a count, a canonical decimal for an amount. */
export function isWellFormedExerciseRuleUsage(rule: ExerciseControlRuleUsage): boolean {
  if (rule.limit.metric === 'count') return rule.usage === '1';
  return isCanonicalExerciseDecimal(rule.usage, EXERCISE_DECIMAL_USAGE_DIGITS);
}

/**
 * Whether a reservation request is internally consistent: the id is the one
 * its grant and execution identity derive, the rules are a canonical sorted
 * limit set, the policy digest is that set's digest, every usage fits its
 * metric, and every other field is present and well formed.
 *
 * Total, and never repairing: anything else is `false`.
 */
export function isWellFormedExerciseReservationRequest(request: ExerciseReservationRequest): boolean {
  try {
    if (typeof request.boundedGrantId !== 'string' || request.boundedGrantId.length === 0) return false;
    if (typeof request.executionId !== 'string' || request.executionId.length === 0) return false;
    if (request.reservationId !== exerciseReservationId({ boundedGrantId: request.boundedGrantId, executionId: request.executionId })) return false;
    if (!isWellFormedExerciseDigest(request.requestDigest) || !isWellFormedExerciseDigest(request.policyDigest) || !isWellFormedExerciseDigest(request.authorityBindingDigest)) return false;
    if (!Array.isArray(request.rules)) return false;
    const limits = snapshotExerciseControlLimits(request.rules.map((rule) => rule.limit));
    if (limits === undefined) return false;
    // The snapshot sorts; the request must already be in that order, so a
    // record's rule ordinals are themselves canonical.
    for (let index = 0; index < limits.length; index += 1) {
      if (exerciseControlBucketKey(limits[index] as ExerciseControlLimit) !== exerciseControlBucketKey((request.rules[index] as ExerciseControlRuleUsage).limit)) return false;
    }
    if (exerciseControlPolicyDigest(limits) !== request.policyDigest) return false;
    return request.rules.every(isWellFormedExerciseRuleUsage);
  } catch {
    return false;
  }
}

/** Whether a record read back from storage is a well-formed request admitted at a readable instant. */
export function isWellFormedExerciseReservation(record: ExerciseReservationRecord): boolean {
  try {
    return isExerciseReservationInstant(record.reservedAt) && isWellFormedExerciseReservationRequest(record);
  } catch {
    return false;
  }
}

/**
 * Usage already recorded under one bucket, by an **active** reservation — one
 * with no terminal event, or one that settled. A released reservation is never
 * handed to the admission rule.
 */
export interface ExerciseControlActiveUsage {
  readonly metric: ExerciseControlLimit['metric'];
  readonly unit?: string;
  readonly usage: string;
  /** The reservation instant of the reservation that recorded it, in epoch milliseconds. */
  readonly reservedAtMs: number;
}

export type ExerciseControlRuleVerdict = 'within' | 'exceeded' | 'unit-mismatch';

/**
 * Whether one more execution fits one bucket.
 *
 * Pure and shared: the in-memory ledger and the SQLite ledger both call this
 * with the active usage they read inside their own critical section, so the
 * two cannot drift into different semantics.
 *
 * - **Window.** A lifetime window counts every active usage. A rolling window
 *   counts active usage whose reservation instant is after `at - seconds` —
 *   and that includes every reservation apparently in the **future**, so a
 *   clock that has been set back cannot make recorded usage disappear. Rolling
 *   windows age by reservation time, never by settlement time.
 * - **Count.** Every active reservation in the bucket consumes one, whatever
 *   metric it was recorded under.
 * - **Amount.** Every active usage in the bucket must be an amount in exactly
 *   the rule's unit; one that is not cannot be converted, so the answer is
 *   `unit-mismatch` rather than "ignore it". The sum is exact decimal
 *   arithmetic, never a float.
 */
export function exerciseControlRuleVerdict(rule: ExerciseControlRuleUsage, active: readonly ExerciseControlActiveUsage[], atMs: number): ExerciseControlRuleVerdict {
  const { limit } = rule;
  const window = limit.window;
  // A reservation instant that cannot be read is counted: an unreadable age is
  // never treated as "old enough to have left the window".
  const windowed = window.kind === 'lifetime' ? active : active.filter((entry) => Number.isNaN(entry.reservedAtMs) || entry.reservedAtMs > atMs - window.seconds * 1000);

  if (limit.metric === 'count') {
    return windowed.length + 1 <= limit.maximum ? 'within' : 'exceeded';
  }

  let total = rule.usage;
  for (const entry of windowed) {
    if (entry.metric !== 'amount' || entry.unit !== limit.unit || !isCanonicalExerciseDecimal(entry.usage, EXERCISE_DECIMAL_USAGE_DIGITS)) return 'unit-mismatch';
    total = addExerciseDecimals(total, entry.usage);
  }
  return compareExerciseDecimals(total, limit.maximum) <= 0 ? 'within' : 'exceeded';
}

/**
 * The admission of a whole reservation: every rule within, or none admitted.
 *
 * `reservedAt` is the instant the ledger sampled inside its own critical
 * section — the same instant it then persists — so a rolling window is judged
 * at the moment the reservation actually begins to consume.
 *
 * Reports every refusing bucket, in rule order, and the reason codes in a
 * stable order — `EXERCISE_CONTROL_UNIT_MISMATCH` before
 * `EXERCISE_CONTROL_LIMIT_EXCEEDED` — so the same world yields the same answer.
 */
export function assessExerciseReservationAdmission(
  request: ExerciseReservationRequest,
  reservedAt: string,
  activeUsageFor: (rule: ExerciseControlRuleUsage) => readonly ExerciseControlActiveUsage[],
):
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reasonCodes: readonly ExerciseControlReasonCode[]; readonly refusedBuckets: readonly { readonly limitId: string; readonly scopeKey: string }[] } {
  const atMs = Date.parse(reservedAt);
  let mismatch = false;
  let exceeded = false;
  const refusedBuckets: { readonly limitId: string; readonly scopeKey: string }[] = [];
  for (const rule of request.rules) {
    const verdict = exerciseControlRuleVerdict(rule, activeUsageFor(rule), atMs);
    if (verdict === 'within') continue;
    if (verdict === 'unit-mismatch') mismatch = true;
    else exceeded = true;
    refusedBuckets.push({ limitId: rule.limit.limitId, scopeKey: rule.limit.scopeKey });
  }
  if (!mismatch && !exceeded) return { admitted: true };
  return {
    admitted: false,
    reasonCodes: [
      ...(mismatch ? [EXERCISE_CONTROL_REASON_CODES.EXERCISE_CONTROL_UNIT_MISMATCH] : []),
      ...(exceeded ? [EXERCISE_CONTROL_REASON_CODES.EXERCISE_CONTROL_LIMIT_EXCEEDED] : []),
    ],
    refusedBuckets,
  };
}

/** Whether two reservation requests describe the same attempt, under the same policy and the same binding provenance. A stored record's reservation instant is not compared: a re-delivery happens later by definition. */
export function exerciseReservationsDescribeSameAttempt(left: ExerciseReservationRequest, right: ExerciseReservationRequest): boolean {
  return (
    left.reservationId === right.reservationId &&
    left.executionId === right.executionId &&
    left.boundedGrantId === right.boundedGrantId &&
    left.requestDigest === right.requestDigest &&
    left.policyDigest === right.policyDigest &&
    left.authorityBindingDigest === right.authorityBindingDigest
  );
}
