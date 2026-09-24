import { isWellFormedExerciseDigest, isExerciseReservationInstant, type ExerciseReservationTerminalEvent } from './exercise-reservation.js';

/**
 * P12 — what a reservation learns when a trusted resolution authority later
 * establishes whether the effect it reserved for actually completed.
 *
 * ## A second immutable fact, never a rewritten first one
 *
 * P7's terminal event records what the execution runtime knew **at the time**:
 * `settled / execution-unconfirmed` means "the provider may have acted, so the
 * capacity stays consumed". That was true, and it stays in the ledger exactly
 * as written. A later definitive resolution is recorded **beside** it, as one
 * more append-only row:
 *
 * ```
 * reservation
 *   ↓
 * settled because execution was unconfirmed        (P7, unchanged)
 *   ↓
 * resolution: confirmed-not-completed, bound to    (this file)
 *   the P12 resolution digest
 * ```
 *
 * ## It can only follow a canonical resolution
 *
 * The row names the P12 `resolutionDigest` it follows, and the only writer is
 * the P12 reconciliation service, after that resolution is durable. There is
 * no "release this reservation" call anywhere: capacity returns because a
 * verified resolution says the effect did not happen, never because someone
 * asked for it back.
 *
 * ## Effective consumption
 *
 * ```
 * reserved                                             consumes
 * settled                                              consumes
 * released                                             does not consume
 * reserved | settled  + resolution confirmed-completed consumes
 * reserved | settled  + resolution confirmed-not-...   does not consume
 * ```
 *
 * A completed resolution never creates capacity. A not-completed resolution
 * removes the **whole** reservation from **every** bucket it named, in the
 * same verified read that decides admission, so no bucket is ever partially
 * returned.
 */

export const EXERCISE_RESERVATION_RESOLUTIONS = ['confirmed-completed', 'confirmed-not-completed'] as const;
export type ExerciseReservationResolution = (typeof EXERCISE_RESERVATION_RESOLUTIONS)[number];

export function isExerciseReservationResolution(value: unknown): value is ExerciseReservationResolution {
  return typeof value === 'string' && (EXERCISE_RESERVATION_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * What the P12 resolution started from — the durable P11 state it resolved.
 *
 * - `initial-observation-unconfirmed` — P11 recorded the provider's own
 *   "unknown". The runtime then settled (or, when the ledger was unreachable,
 *   left reserved) — never released.
 * - `no-initial-observation` — the claim exists and P11 recorded nothing: a
 *   crash, or an observation write that failed. The ledger may hold any
 *   terminal event the runtime reached before that.
 */
export const EXERCISE_RESERVATION_RESOLUTION_BASES = ['initial-observation-unconfirmed', 'no-initial-observation'] as const;
export type ExerciseReservationResolutionBasis = (typeof EXERCISE_RESERVATION_RESOLUTION_BASES)[number];

export function isExerciseReservationResolutionBasis(value: unknown): value is ExerciseReservationResolutionBasis {
  return typeof value === 'string' && (EXERCISE_RESERVATION_RESOLUTION_BASES as readonly string[]).includes(value);
}

/** The one resolution row a reservation may have. Immutable. */
export interface ExerciseReservationResolutionEvent {
  readonly reservationId: string;
  readonly executionId: string;
  /** The canonical P12 resolution this row follows. Capacity can never return for an uncorrelated "not completed". */
  readonly resolutionDigest: string;
  readonly resolution: ExerciseReservationResolution;
  readonly recordedAt: string;
}

export interface ExerciseReservationResolutionInput {
  readonly reservationId: string;
  readonly executionId: string;
  readonly resolutionDigest: string;
  readonly resolution: ExerciseReservationResolution;
  readonly basis: ExerciseReservationResolutionBasis;
  readonly recordedAt: string;
}

export type ExerciseReservationResolutionOutcome =
  /** Recorded now. */
  | { readonly outcome: 'applied'; readonly event: ExerciseReservationResolutionEvent }
  /** The identical row already stands — the idempotent repair after a crash between the P12 resolution and this row. */
  | { readonly outcome: 'already-applied'; readonly event: ExerciseReservationResolutionEvent }
  /** A different resolution row already stands. The first stands; nothing was written. */
  | { readonly outcome: 'conflict'; readonly event: ExerciseReservationResolutionEvent }
  /**
   * The ledger's own history contradicts the resolution or its basis — a
   * released reservation "resolved completed", or an unconfirmed observation
   * whose reservation was released. Nothing was written and nothing is
   * repaired: two authoritative stores disagree, and that is reported.
   */
  | { readonly outcome: 'inconsistent' }
  /** No reservation with this id exists for this execution. Nothing was written. */
  | { readonly outcome: 'not-found' };

/**
 * The narrow capability the P12 reconciliation service is handed — and nothing
 * else is. It is not part of `ExerciseControlLedgerPort`: the exercise gate
 * cannot record a resolution, and the reconciliation service cannot reserve,
 * settle or release.
 *
 * Same guarantees as the ledger's own writes: one critical section (SQLite:
 * `BEGIN IMMEDIATE`, the same database and lock as admission), every row it
 * reads verified first, one row per reservation, never updated or deleted.
 */
export interface ExerciseControlReconciliationPort {
  reconcileResolution(input: ExerciseReservationResolutionInput): Promise<ExerciseReservationResolutionOutcome>;
}

/** Whether a resolution input is inside the closed contract. Total. */
export function isWellFormedExerciseReservationResolutionInput(input: unknown): input is ExerciseReservationResolutionInput {
  try {
    if (input === null || typeof input !== 'object') return false;
    const value = input as Record<string, unknown>;
    const allowed = ['reservationId', 'executionId', 'resolutionDigest', 'resolution', 'basis', 'recordedAt'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
    return (
      typeof value.reservationId === 'string' &&
      value.reservationId.length > 0 &&
      typeof value.executionId === 'string' &&
      value.executionId.length > 0 &&
      isWellFormedExerciseDigest(value.resolutionDigest) &&
      isExerciseReservationResolution(value.resolution) &&
      isExerciseReservationResolutionBasis(value.basis) &&
      isExerciseReservationInstant(value.recordedAt)
    );
  } catch {
    return false;
  }
}

/**
 * Whether the ledger's own terminal history can agree with a resolution.
 *
 * The runtime chose the terminal event from what it observed, so some pairs
 * are impossible unless one store is wrong:
 *
 * - An unconfirmed initial observation is only ever settled
 *   `execution-unconfirmed` — or left reserved when finalization could not be
 *   recorded. A release beside it is a contradiction.
 * - With no initial observation, the terminal event may be anything the
 *   runtime reached before the observation was lost — but a released
 *   reservation (the adapter said "failed", or a layer withheld before any
 *   provider) can never be resolved `confirmed-completed`, and a reservation
 *   settled `executed` can never be resolved `confirmed-not-completed`.
 */
export function exerciseReservationResolutionConsistent(
  terminal: ExerciseReservationTerminalEvent | undefined,
  resolution: ExerciseReservationResolution,
  basis: ExerciseReservationResolutionBasis,
): boolean {
  if (terminal === undefined) return true;
  if (terminal.kind === 'settled' && terminal.reason === 'execution-unconfirmed') return true;
  if (basis === 'initial-observation-unconfirmed') return false;
  if (terminal.kind === 'settled') return resolution === 'confirmed-completed';
  return resolution === 'confirmed-not-completed';
}

/**
 * The one effective-consumption rule both ledgers apply, over **verified**
 * state only:
 *
 * - no resolution: released does not consume; everything else does (P7);
 * - a resolution the ledger's own history **agrees** with: `confirmed-completed`
 *   consumes, `confirmed-not-completed` does not;
 * - a resolution the ledger's own history **contradicts**: consumes.
 *
 * The contradiction case exists for an execution that was still in flight
 * when it was reconciled: if the runtime later settles it `executed` after a
 * not-completed resolution, or releases it after a completed one, the two
 * authoritative stores disagree about whether the effect happened — and a
 * contradiction never returns capacity.
 */
export function exerciseReservationConsumes(terminal: ExerciseReservationTerminalEvent | undefined, resolution: ExerciseReservationResolutionEvent | undefined): boolean {
  if (resolution === undefined) return terminal?.kind !== 'released';
  if (!exerciseReservationResolutionConsistent(terminal, resolution.resolution, 'no-initial-observation')) return true;
  return resolution.resolution !== 'confirmed-not-completed';
}

/** Whether a repeated resolution input is the identical row: same reservation, execution, resolution digest and answer. The first `recordedAt` stands. */
export function exerciseReservationResolutionMatches(event: ExerciseReservationResolutionEvent, input: ExerciseReservationResolutionInput): boolean {
  return event.reservationId === input.reservationId && event.executionId === input.executionId && event.resolutionDigest === input.resolutionDigest && event.resolution === input.resolution;
}
