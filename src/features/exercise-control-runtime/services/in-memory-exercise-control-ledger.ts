import {
  assessExerciseReservationAdmission,
  exerciseControlBucketKey,
  exerciseReservationTerminalReasonMatches,
  exerciseReservationsDescribeSameAttempt,
  isWellFormedExerciseReservation,
  type ExerciseControlActiveUsage,
  type ExerciseControlLedgerPort,
  type ExerciseControlRuleUsage,
  type ExerciseReservationOutcome,
  type ExerciseReservationRecord,
  type ExerciseReservationRelease,
  type ExerciseReservationRequest,
  type ExerciseReservationSettlement,
  type ExerciseReservationTerminalEvent,
  type ExerciseReservationTerminalKind,
  type ExerciseReservationTerminalOutcome,
  type ExerciseReservationView,
} from '../domain/index.js';

/**
 * A process-local exercise-control ledger, for focused tests and single-process
 * development. **Not durable**: every reservation is lost on restart, which for
 * an aggregate limit fails *open* — spent capacity becomes available again. The
 * composition root never selects it; the production reference is the SQLite
 * ledger in `src/enterprise/exercise-control-ledger`.
 *
 * It implements the same port with the same **semantics**, deliberately, so a
 * test written against it cannot prove a weaker rule than production enforces:
 * admission runs the shared `assessExerciseReservationAdmission` inside one
 * synchronous critical section with no `await`, pending reservations consume,
 * duplicates and conflicts never write, the one terminal event is immutable,
 * and amounts are exact decimals.
 */
export function createInMemoryExerciseControlLedger(): ExerciseControlLedgerPort {
  const reservations = new Map<string, ExerciseReservationRecord>();
  const terminals = new Map<string, ExerciseReservationTerminalEvent>();

  function frozenCopy(request: ExerciseReservationRequest): ExerciseReservationRecord {
    return Object.freeze({
      reservationId: request.reservationId,
      executionId: request.executionId,
      boundedGrantId: request.boundedGrantId,
      requestDigest: request.requestDigest,
      policyDigest: request.policyDigest,
      authorityBindingDigest: request.authorityBindingDigest,
      reservedAt: request.reservedAt,
      rules: Object.freeze(
        request.rules.map((rule) =>
          Object.freeze({ limit: Object.freeze({ ...rule.limit, window: Object.freeze({ ...rule.limit.window }) }), usage: rule.usage }),
        ),
      ),
    }) as ExerciseReservationRecord;
  }

  /** Active usage for one bucket: every reservation that names it and has not been released. Settled and still-reserved both count. */
  function activeUsageFor(rule: ExerciseControlRuleUsage): readonly ExerciseControlActiveUsage[] {
    const bucket = exerciseControlBucketKey(rule.limit);
    const active: ExerciseControlActiveUsage[] = [];
    for (const reservation of reservations.values()) {
      if (terminals.get(reservation.reservationId)?.kind === 'released') continue;
      const recorded = reservation.rules.find((entry) => exerciseControlBucketKey(entry.limit) === bucket);
      if (recorded === undefined) continue;
      active.push({
        metric: recorded.limit.metric,
        ...(recorded.limit.metric === 'amount' ? { unit: recorded.limit.unit } : {}),
        usage: recorded.usage,
        reservedAtMs: Date.parse(reservation.reservedAt),
      });
    }
    return active;
  }

  function terminal(kind: ExerciseReservationTerminalKind, input: ExerciseReservationSettlement | ExerciseReservationRelease): ExerciseReservationTerminalOutcome {
    // ---- critical section begins. No `await` below this line. ----
    if (!exerciseReservationTerminalReasonMatches(kind, input.reason) || typeof input.recordedAt !== 'string' || Number.isNaN(Date.parse(input.recordedAt))) {
      throw new TypeError('The terminal transition is outside the closed contract.');
    }
    if (!reservations.has(input.reservationId)) return { outcome: 'not-found' };
    const existing = terminals.get(input.reservationId);
    if (existing !== undefined) {
      if (existing.kind === kind && existing.reason === input.reason) {
        return { outcome: kind === 'settled' ? 'already-settled' : 'already-released', terminal: existing };
      }
      return { outcome: 'conflict', terminal: existing };
    }
    const event: ExerciseReservationTerminalEvent = Object.freeze({ reservationId: input.reservationId, kind, reason: input.reason, recordedAt: input.recordedAt });
    terminals.set(input.reservationId, event);
    // ---- critical section ends. ----
    return { outcome: kind, terminal: event };
  }

  return {
    async reserve(request: ExerciseReservationRequest): Promise<ExerciseReservationOutcome> {
      // ---- critical section begins. No `await` below this line. ----
      if (!isWellFormedExerciseReservation(request)) throw new TypeError('The reservation request is outside the closed contract.');
      const existing = reservations.get(request.reservationId);
      if (existing !== undefined) {
        return exerciseReservationsDescribeSameAttempt(existing, request) ? { outcome: 'already-reserved', reservation: existing } : { outcome: 'conflict' };
      }
      // One execution identity is one attempt, whichever grant it names: a
      // second reservation for the same execution id under a different grant
      // is a conflict, never a second admission.
      for (const other of reservations.values()) {
        if (other.executionId === request.executionId) return { outcome: 'conflict' };
      }
      const admission = assessExerciseReservationAdmission(request, activeUsageFor);
      if (!admission.admitted) return { outcome: 'refused', reasonCodes: admission.reasonCodes, refusedBuckets: admission.refusedBuckets };
      const record = frozenCopy(request);
      reservations.set(record.reservationId, record);
      // ---- critical section ends. ----
      return { outcome: 'reserved', reservation: record };
    },

    async settle(input: ExerciseReservationSettlement): Promise<ExerciseReservationTerminalOutcome> {
      return terminal('settled', input);
    },

    async release(input: ExerciseReservationRelease): Promise<ExerciseReservationTerminalOutcome> {
      return terminal('released', input);
    },

    async read(reservationId: string): Promise<ExerciseReservationView | undefined> {
      const reservation = reservations.get(reservationId);
      if (reservation === undefined) return undefined;
      const event = terminals.get(reservationId);
      return { reservation, state: event === undefined ? 'reserved' : event.kind, ...(event !== undefined ? { terminal: event } : {}) };
    },
  };
}
