import type { ExerciseControlReasonCode } from './exercise-control-reason-codes.js';
import type {
  ExerciseReservationRecord,
  ExerciseReservationReleaseReason,
  ExerciseReservationRequest,
  ExerciseReservationSettleReason,
  ExerciseReservationTerminalEvent,
  ExerciseReservationView,
} from './exercise-reservation.js';

/**
 * The authoritative home of aggregate exercise consumption.
 *
 * ## Authority state, not evidence
 *
 * This is **not** the Governed Action execution ledger. That one is a set of
 * Governance Store references — evidence of what was authorized and attempted —
 * whose one behavioural use is negative replay prevention. This port holds the
 * state an admission decision is made from: which execution identities have
 * reserved how much of which bucket, and which of those reservations have been
 * settled or released. Evidence is never read to reconstruct it, and it is
 * never written as evidence.
 *
 * ## What an implementation must guarantee
 *
 * 1. **Atomic admission.** `reserve` reads the active usage of every bucket the
 *    request names, applies `assessExerciseReservationAdmission`, and records
 *    the reservation — or records nothing — inside **one** critical section.
 *    In SQLite that is one `BEGIN IMMEDIATE` transaction, which takes the write
 *    lock before the first read, so two processes racing for the last unit of a
 *    bucket cannot both be admitted. In memory it is one synchronous section
 *    with no `await`.
 * 2. **All or nothing.** Every rule is admitted together, or the reservation is
 *    refused and nothing is written. No bucket is ever partially reserved.
 * 3. **Reservation consumes.** A reservation with no terminal event counts
 *    toward every bucket it names from the moment it commits.
 * 4. **One identity, one attempt.** A second `reserve` for an existing
 *    reservation id never writes: it returns `already-reserved` when the
 *    request, policy and binding provenance are identical, and `conflict`
 *    otherwise. A reservation for an execution id that already holds one under
 *    a *different* grant is a `conflict` too: an execution identity is one
 *    attempt, whichever grant it names.
 * 5. **One terminal event, immutable.** `settle` and `release` append the one
 *    terminal event a reservation may ever have. Repeating the identical
 *    transition is idempotent; any other transition after the first is a
 *    `conflict` and changes nothing. Release never deletes — the history
 *    "reserved, then released" remains readable.
 * 6. **No expiry.** Nothing in an implementation ages a reservation out of
 *    `reserved`, sweeps it, or releases it on a timer or at startup. A crash
 *    leaves a reservation consuming, and it stays consuming: indefinitely for a
 *    lifetime bucket, until it leaves the window for a rolling one.
 * 7. **Fail closed.** A store that cannot read, cannot write, or reads state
 *    that fails validation **throws**. The gate turns a throw into
 *    `EXERCISE_CONTROL_LEDGER_UNAVAILABLE`, and the adapter is not invoked. An
 *    unreadable ledger is never an empty one.
 *
 * This port is handed to the exercise-control gate and to nothing else. No
 * adapter, no policy and no binding resolver ever receives it.
 */
export type ExerciseReservationOutcome =
  /** Admitted and durably recorded. It consumes from this moment. */
  | { readonly outcome: 'reserved'; readonly reservation: ExerciseReservationRecord }
  /** The same attempt was already reserved. Nothing was written; the adapter must not be invoked again. */
  | { readonly outcome: 'already-reserved'; readonly reservation: ExerciseReservationRecord }
  /** A reservation with this identity exists for a different request, policy or binding provenance. Nothing was written. */
  | { readonly outcome: 'conflict' }
  /** At least one bucket refused. Nothing was written, for any bucket. */
  | {
      readonly outcome: 'refused';
      readonly reasonCodes: readonly ExerciseControlReasonCode[];
      readonly refusedBuckets: readonly { readonly limitId: string; readonly scopeKey: string }[];
    };

export interface ExerciseReservationSettlement {
  readonly reservationId: string;
  readonly reason: ExerciseReservationSettleReason;
  readonly recordedAt: string;
}

export interface ExerciseReservationRelease {
  readonly reservationId: string;
  readonly reason: ExerciseReservationReleaseReason;
  readonly recordedAt: string;
}

export type ExerciseReservationTerminalOutcome =
  | { readonly outcome: 'settled' | 'released'; readonly terminal: ExerciseReservationTerminalEvent }
  /** The identical transition was already recorded. The first event stands, never re-dated. */
  | { readonly outcome: 'already-settled' | 'already-released'; readonly terminal: ExerciseReservationTerminalEvent }
  /** A different terminal event already stands — settle after release, release after settle, or the same kind for a different reason. Nothing was written. */
  | { readonly outcome: 'conflict'; readonly terminal: ExerciseReservationTerminalEvent }
  /** No reservation with this id exists. Nothing was written. */
  | { readonly outcome: 'not-found' };

export interface ExerciseControlLedgerPort {
  reserve(request: ExerciseReservationRequest): Promise<ExerciseReservationOutcome>;
  settle(input: ExerciseReservationSettlement): Promise<ExerciseReservationTerminalOutcome>;
  release(input: ExerciseReservationRelease): Promise<ExerciseReservationTerminalOutcome>;
  /** The reservation and its derived state, or `undefined` when none exists. Diagnostics and tests; never consulted by admission, which reads inside its own critical section. */
  read(reservationId: string): Promise<ExerciseReservationView | undefined>;
}
