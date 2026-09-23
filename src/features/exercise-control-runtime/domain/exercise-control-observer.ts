import type { ExerciseReservationReleaseReason, ExerciseReservationSettleReason } from './exercise-reservation.js';

/**
 * A **write-only, non-blocking** observation boundary for reservation facts the
 * ledger has already proved — the one way evidence learns what the
 * exercise-control gate did, without the gate learning that evidence exists.
 *
 * ## Downstream only
 *
 * The gate reports an observation **after** the ledger returned the fact —
 * `reserved` after an admission committed, `settled` / `released` after the
 * terminal event was recorded (or found already recorded, identically) — and
 * never before. An admission refused, a conflicting terminal event, a ledger
 * that threw: none of these is observed, because none of them is a recorded
 * reservation fact.
 *
 * ## It can change nothing, and the gate never waits for it
 *
 * `reservationObserved` returns `void`: it **enqueues** an observation and
 * returns. It never represents durable storage, so the gate has nothing to
 * await and cannot be held by an observer whose projection is slow, stuck or
 * never settles. That matters because P7 reservations have no TTL and no
 * sweeper: a gate blocked between a committed reservation and its finalization
 * would leave capacity consumed indefinitely. (An observer that blocks
 * *synchronously* is trusted host code, as every composed port is.) An observer that throws synchronously is caught and
 * discarded; nothing it does can admit, withhold, revalidate, settle, release,
 * or change an outcome or a reason code. Admission still reads consumption only
 * from the ledger.
 */
export type ExerciseReservationObservation =
  | {
      readonly kind: 'reserved';
      readonly reservationId: string;
      readonly executionId: string;
      readonly boundedGrantId: string;
      /** The grant's decision correlation, read from the authoritative grant. */
      readonly requestId: string;
      readonly decisionId: string;
      readonly policyDigest: string;
      readonly authorityBindingDigest: string;
      /** The ledger's own admission instant — the recorded reservation's `reservedAt`, sampled inside the ledger's critical section. The gate copies it; it never chooses it. */
      readonly admittedAt: string;
    }
  | {
      readonly kind: 'settled';
      readonly reservationId: string;
      readonly executionId: string;
      readonly boundedGrantId: string;
      readonly requestId: string;
      readonly decisionId: string;
      readonly reason: ExerciseReservationSettleReason;
      /** The recorded terminal event's own instant — the first one, when the identical transition was already recorded. */
      readonly recordedAt: string;
    }
  | {
      readonly kind: 'released';
      readonly reservationId: string;
      readonly executionId: string;
      readonly boundedGrantId: string;
      readonly requestId: string;
      readonly decisionId: string;
      readonly reason: ExerciseReservationReleaseReason;
      readonly recordedAt: string;
    };

export interface ExerciseControlObserver {
  /** Enqueue-and-return. Never awaited by the gate, and never a durability signal. */
  reservationObserved(observation: ExerciseReservationObservation): void;
}
