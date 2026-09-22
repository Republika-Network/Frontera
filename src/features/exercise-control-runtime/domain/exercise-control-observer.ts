import type { ExerciseReservationReleaseReason, ExerciseReservationSettleReason } from './exercise-reservation.js';

/**
 * A **write-only** observation boundary for reservation facts the ledger has
 * already proved — the one way evidence learns what the exercise-control gate
 * did, without the gate learning that evidence exists.
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
 * ## It can change nothing
 *
 * The method returns nothing the gate reads. The gate awaits it inside a
 * `try`/`catch` and discards both the result and any failure, so an observer
 * that throws, rejects, hangs up or lies cannot admit, withhold, release,
 * settle, or change a reservation, an outcome or a reason code. Nothing here is
 * ever consulted for admission: consumption is read only from the ledger.
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
  reservationObserved(observation: ExerciseReservationObservation): Promise<void>;
}
