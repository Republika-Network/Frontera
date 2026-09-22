/**
 * The durable exercise-control ledger's error taxonomy.
 *
 * Deliberately parallel to `BoundedGrantStoreError`, and deliberately **not**
 * `ExecutionGovernanceError`: these are runtime conditions of an authoritative
 * store — it cannot be opened, it has been closed, or the state it holds failed
 * validation — not wiring defects.
 *
 * ## Thrown, never returned
 *
 * `ExerciseControlLedgerPort` states it as the port's contract: a ledger that
 * cannot establish its state throws, and the gate turns the throw into
 * `EXERCISE_CONTROL_LEDGER_UNAVAILABLE` with the adapter not invoked. A ledger
 * that returned "no usage" from state it could not validate would be granting
 * exactly the capacity it could not prove was free.
 *
 * ## What the messages may say
 *
 * The reservation id, the condition, and nothing else. No SQL, no file path, no
 * driver text, no row contents.
 */
export type ExerciseControlLedgerErrorCode =
  /** The ledger cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. Never a reason to fall back to another ledger. */
  | 'EXERCISE_CONTROL_LEDGER_UNAVAILABLE'
  /** Persisted reservation state failed integrity validation, or a reservation, its rule rows and its terminal event disagree. Refused, never repaired. */
  | 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT'
  /** A caller handed the ledger a reservation or terminal transition outside the closed contract. Nothing was written. */
  | 'EXERCISE_CONTROL_LEDGER_INPUT_INVALID';

export class ExerciseControlLedgerError extends Error {
  constructor(
    readonly code: ExerciseControlLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExerciseControlLedgerError';
  }
}

export function isExerciseControlLedgerError(error: unknown): error is ExerciseControlLedgerError {
  return error instanceof ExerciseControlLedgerError;
}
