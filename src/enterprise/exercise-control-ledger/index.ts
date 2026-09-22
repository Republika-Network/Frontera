/**
 * The durable exercise-control ledger — P7's authoritative consumption state.
 *
 * See `docs/enterprise/AOC_EXERCISE_CONTROLS.md`. The three things to know from
 * here: it sits behind `ExerciseControlLedgerPort`, so the gate never learns a
 * database exists; admission is one `BEGIN IMMEDIATE` transaction, so racing
 * processes on one file cannot over-admit; and its digests are storage
 * integrity, never cryptographic authenticity. It is **not** the Governed
 * Action execution ledger, which is Governance Store evidence.
 */
export { ExerciseControlLedgerError, isExerciseControlLedgerError } from './errors.js';
export type { ExerciseControlLedgerErrorCode } from './errors.js';

export {
  EXERCISE_CONTROL_LEDGER_RECORD_FORMAT,
  EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
  serializeStoredBucketHead,
  serializeStoredReservation,
  serializeStoredRule,
  serializeStoredTerminalEvent,
  storedBucketHeadDigest,
  storedReservationDigest,
  storedRuleDigest,
  storedTerminalEventDigest,
} from './exercise-control-record.js';

export { createSqliteExerciseControlLedger } from './sqlite-exercise-control-ledger.js';
export type { CreateSqliteExerciseControlLedgerOptions, DurableExerciseControlLedger, ExerciseControlLedgerHealth } from './sqlite-exercise-control-ledger.js';
