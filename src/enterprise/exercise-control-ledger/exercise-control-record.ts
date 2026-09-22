import { createHash } from 'node:crypto';

import {
  serializeExerciseControlLimit,
  type ExerciseControlRuleUsage,
  type ExerciseReservationRecord,
  type ExerciseReservationTerminalEvent,
} from '../../features/exercise-control-runtime/index.js';

/**
 * The canonical persisted form of every exercise-control ledger row, and its
 * integrity digest.
 *
 * ## Integrity, not authenticity
 *
 * Every digest here is **unkeyed** SHA-256 — the same limit
 * `boundedGrantDigest`, the bounded-grant store's record envelope and the
 * Governance Store's `computeDigest` state. It detects accidental corruption,
 * partial writes and a row edited without re-sealing. On its own a row digest
 * cannot detect a row deleted outright — the sealed per-bucket heads below are
 * what make a deleted or re-bucketed rule row detectable. None of it stops a
 * writer who can rewrite rows and recompute every digest consistently, and it
 * is not a signature. A KMS/HSM key boundary is future work.
 *
 * ## Canonical form
 *
 * Lexicographic key order fixed here, no whitespace, no omitted field, and the
 * format and schema version inside the bytes, so a digest can never be read
 * under a different encoding than it was taken over.
 */

export const EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION = 'aoc.exercise-control-ledger.schema.v1';

/** The record-envelope format. Bumped only when the canonical bytes change. */
export const EXERCISE_CONTROL_LEDGER_RECORD_FORMAT = 'aoc.exercise-control-ledger.record.v1';

function digestOf(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The reservation's base row: every field of the admitted request except the rules, plus the rule count, so a missing rule row is detectable. */
export function serializeStoredReservation(reservation: ExerciseReservationRecord): string {
  return [
    '{',
    [
      `"authorityBindingDigest":${JSON.stringify(reservation.authorityBindingDigest)}`,
      `"boundedGrantId":${JSON.stringify(reservation.boundedGrantId)}`,
      `"executionId":${JSON.stringify(reservation.executionId)}`,
      `"format":${JSON.stringify(EXERCISE_CONTROL_LEDGER_RECORD_FORMAT)}`,
      '"kind":"reservation"',
      `"policyDigest":${JSON.stringify(reservation.policyDigest)}`,
      `"requestDigest":${JSON.stringify(reservation.requestDigest)}`,
      `"reservationId":${JSON.stringify(reservation.reservationId)}`,
      `"reservedAt":${JSON.stringify(reservation.reservedAt)}`,
      `"ruleCount":${String(reservation.rules.length)}`,
      `"schemaVersion":${JSON.stringify(EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION)}`,
    ].join(','),
    '}',
  ].join('');
}

export function storedReservationDigest(reservation: ExerciseReservationRecord): string {
  return digestOf(serializeStoredReservation(reservation));
}

/**
 * One rule row: the reservation it belongs to, its position, the full limit it
 * was admitted under, the usage it consumes, and the reservation instant in
 * epoch milliseconds, so none of them can be edited without the digest
 * failing. Admission verifies this digest for every row in a bucket **before**
 * a rolling window is applied to the verified instant, so an unsealed edit of
 * `reserved_at_ms` cannot move a row out of verification.
 */
export function serializeStoredRule(input: { readonly reservationId: string; readonly ordinal: number; readonly rule: ExerciseControlRuleUsage; readonly reservedAtMs: number }): string {
  return [
    '{',
    [
      `"format":${JSON.stringify(EXERCISE_CONTROL_LEDGER_RECORD_FORMAT)}`,
      '"kind":"rule"',
      `"limit":${serializeExerciseControlLimit(input.rule.limit)}`,
      `"ordinal":${String(input.ordinal)}`,
      `"reservationId":${JSON.stringify(input.reservationId)}`,
      `"reservedAtMs":${String(input.reservedAtMs)}`,
      `"schemaVersion":${JSON.stringify(EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION)}`,
      `"usage":${JSON.stringify(input.rule.usage)}`,
    ].join(','),
    '}',
  ].join('');
}

export function storedRuleDigest(input: { readonly reservationId: string; readonly ordinal: number; readonly rule: ExerciseControlRuleUsage; readonly reservedAtMs: number }): string {
  return digestOf(serializeStoredRule(input));
}

/** The one terminal event a reservation may have. */
export function serializeStoredTerminalEvent(event: ExerciseReservationTerminalEvent): string {
  return [
    '{',
    [
      `"format":${JSON.stringify(EXERCISE_CONTROL_LEDGER_RECORD_FORMAT)}`,
      '"kind":"terminal"',
      `"reason":${JSON.stringify(event.reason)}`,
      `"recordedAt":${JSON.stringify(event.recordedAt)}`,
      `"reservationId":${JSON.stringify(event.reservationId)}`,
      `"schemaVersion":${JSON.stringify(EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION)}`,
      `"terminal":${JSON.stringify(event.kind)}`,
    ].join(','),
    '}',
  ].join('');
}

export function storedTerminalEventDigest(event: ExerciseReservationTerminalEvent): string {
  return digestOf(serializeStoredTerminalEvent(event));
}

/**
 * The per-bucket anchor: how many rule rows the bucket holds, sealed. Admission
 * compares it with the rows the bucket index actually returns, so a rule row
 * that was deleted, or edited into another bucket, makes the bucket fail closed
 * instead of quietly returning its capacity.
 */
export function serializeStoredBucketHead(input: { readonly limitId: string; readonly scopeKey: string; readonly ruleRowCount: number }): string {
  return [
    '{',
    [
      `"format":${JSON.stringify(EXERCISE_CONTROL_LEDGER_RECORD_FORMAT)}`,
      '"kind":"bucket-head"',
      `"limitId":${JSON.stringify(input.limitId)}`,
      `"ruleRowCount":${String(input.ruleRowCount)}`,
      `"schemaVersion":${JSON.stringify(EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION)}`,
      `"scopeKey":${JSON.stringify(input.scopeKey)}`,
    ].join(','),
    '}',
  ].join('');
}

export function storedBucketHeadDigest(input: { readonly limitId: string; readonly scopeKey: string; readonly ruleRowCount: number }): string {
  return digestOf(serializeStoredBucketHead(input));
}
