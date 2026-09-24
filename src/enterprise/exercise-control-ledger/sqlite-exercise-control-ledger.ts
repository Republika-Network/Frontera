import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  EXERCISE_RESERVATION_TERMINAL_KINDS,
  assessExerciseReservationAdmission,
  exerciseControlBucketKey,
  exerciseReservationConsumes,
  exerciseReservationResolutionConsistent,
  exerciseReservationResolutionMatches,
  exerciseReservationTerminalReasonMatches,
  isExerciseReservationResolution,
  isWellFormedExerciseDigest,
  isWellFormedExerciseReservationResolutionInput,
  exerciseReservationsDescribeSameAttempt,
  isExerciseReservationInstant,
  isWellFormedExerciseReservation,
  isWellFormedExerciseReservationRequest,
  type ExerciseControlActiveUsage,
  type ExerciseControlLedgerPort,
  type ExerciseControlLimit,
  type ExerciseControlReconciliationPort,
  type ExerciseControlRuleUsage,
  type ExerciseControlWindow,
  type ExerciseReservationOutcome,
  type ExerciseReservationRecord,
  type ExerciseReservationRelease,
  type ExerciseReservationRequest,
  type ExerciseReservationResolutionEvent,
  type ExerciseReservationResolutionInput,
  type ExerciseReservationResolutionOutcome,
  type ExerciseReservationSettlement,
  type ExerciseReservationTerminalEvent,
  type ExerciseReservationTerminalKind,
  type ExerciseReservationTerminalOutcome,
  type ExerciseReservationTerminalReason,
  type ExerciseReservationView,
} from '../../features/exercise-control-runtime/index.js';
import { ExerciseControlLedgerError } from './errors.js';
import {
  EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
  storedBucketHeadDigest,
  storedReservationDigest,
  storedResolutionEventDigest,
  storedRuleDigest,
  storedTerminalEventDigest,
} from './exercise-control-record.js';

/**
 * The durable, authoritative exercise-control ledger — the production
 * reference implementation of `ExerciseControlLedgerPort`.
 *
 * ## The one property everything else serves
 *
 * ```
 * two processes racing for the LAST remaining unit of a bucket cannot both win
 * ```
 *
 * Every admission is one `BEGIN IMMEDIATE` transaction (`better-sqlite3`'s
 * `transaction(...).immediate(...)`): the database write lock is taken
 * **before** the first read, so "sample the reservation instant → read active
 * usage → test every applicable limit → insert the reservation" happens with no
 * other writer able to interleave, in this process or any other process
 * sharing the file. There is
 * no `SELECT`, then `await`, then `INSERT` across two transactions anywhere in
 * this file. `exercise-control-concurrency.test.ts` races independent
 * connections on one file — in worker threads, genuinely in parallel — and
 * asserts that no more than `maximum` are ever admitted.
 *
 * ## Immutable base records, one immutable terminal event
 *
 * ```
 * exercise_control_reservations         one row per admitted reservation
 * exercise_control_reservation_limits   one row per applicable limit, with its usage
 * exercise_control_terminal_events      at most one row per reservation: settled | released
 * ```
 *
 * A fifth table, `exercise_control_reservation_resolutions` (P12), holds at
 * most one immutable resolution row per reservation, written only by the P12
 * reconciliation service after a canonical resolution is durable, and bound to
 * that resolution's digest. It never replaces the terminal event: a
 * reservation "settled because execution was unconfirmed" stays exactly that,
 * and the resolution beside it says what was learned later. A verified
 * `confirmed-not-completed` resolution stops the whole reservation consuming
 * in every bucket it names; `confirmed-completed` changes nothing.
 *
 * There is no status column. A reservation with no terminal event is
 * `reserved`; the terminal event's own kind is the rest. The primary key on
 * `exercise_control_terminal_events.reservation_id` makes "at most one" a
 * database fact, and triggers refuse every `UPDATE` and `DELETE` on all three
 * tables, so releasing capacity appends history and never erases it.
 *
 * A fourth table, `exercise_control_bucket_heads`, is a sealed cross-check and
 * not a source of truth: one row per `(limitId, scopeKey)` holding how many rule
 * rows the bucket has, advanced inside the same admission transaction that adds
 * them. Admission compares it with what the bucket index returns, so a rule row
 * deleted from a bucket — or edited into another one — fails the bucket closed
 * rather than returning its capacity.
 *
 * ## The reservation instant is the admission instant
 *
 * A request carries no instant. The injected clock is sampled **once**, as the
 * first statement of the `BEGIN IMMEDIATE` callback — that is, after the write
 * lock has been acquired, however long the busy timeout made it wait — and that
 * one value is the rolling-window threshold, `reserved_at`, `reserved_at_ms`,
 * every rule row's `reserved_at_ms`, and the returned record's `reservedAt`. A
 * reservation therefore begins its rolling lifetime when it actually starts
 * consuming, not when some caller began asking for it.
 *
 * ## Verify, then filter
 *
 * Admission reads **every** reservation the `(limit_id, scope_key)` bucket
 * index names — lifetime and rolling alike — and verifies each one before any
 * of its fields is believed. The rolling window is applied afterwards, by the
 * pure `exerciseControlRuleVerdict`, to the *verified* reservation instant. An
 * earlier revision range-filtered on the indexed `reserved_at_ms` column in
 * SQL, which let a single unsealed edit of that column move a live row out of
 * the scan and so out of verification; nothing unverified now decides whether
 * a row gets verified. This is an indexed bucket scan — linear in the bucket's
 * history, never a table scan.
 *
 * ## No expiry, no sweeper, no startup cleanup
 *
 * Nothing here ages a reservation out of `reserved`. A process that crashed
 * after reserving leaves a reservation that keeps consuming — indefinitely for
 * a lifetime limit, until it leaves the window for a rolling one — and opening
 * the ledger again changes nothing about it. Only a verified P12 resolution
 * row can stop it consuming — never time, never a restart, never a request.
 *
 * ## Fail closed, never repair
 *
 * Every row an admission reads is validated before it counts: schema version,
 * record digest, rule digests, rule count, ordinals, reservation instant,
 * reservation-id derivation, policy digest and terminal-event digest. A row
 * that fails any of them throws `EXERCISE_CONTROL_LEDGER_STATE_CORRUPT`, the
 * gate reports `EXERCISE_CONTROL_LEDGER_UNAVAILABLE`, and the adapter is not
 * invoked. Nothing is normalized, skipped or rewritten.
 *
 * ## What this is not
 *
 * - **Not authenticity.** Digests are unkeyed; a writer able to rewrite the file
 *   and re-seal every relevant digest consistently, or to delete whole
 *   reservations together with their bucket heads re-sealed, is trusted. A
 *   single field edited without re-sealing — including a rule row's
 *   `reserved_at_ms` moved backwards out of a rolling window — fails the next
 *   admission against that bucket closed.
 * - **Not distributed.** One SQLite file serializes the processes that share it
 *   on one host. Separate files on separate hosts do not share a quota, and
 *   SQLite on a network filesystem that does not honour its locking is not a
 *   distributed lock.
 * - **Not optimized for very large buckets.** Every reservation a bucket has
 *   ever held is verified on each admission against it — rolling buckets
 *   included — and amounts are summed exactly in `BigInt`, never with `SUM()`
 *   over a floating column, so admission is linear in a bucket's indexed
 *   history. Stage A accepts that: integrity wins over the range optimization.
 */

export interface CreateSqliteExerciseControlLedgerOptions {
  /**
   * The injected clock. Sampled once inside every admission's `BEGIN
   * IMMEDIATE` transaction, after the write lock is held, to assign the
   * authoritative reservation instant; also records bookkeeping instants.
   * Defaults to the wall clock.
   */
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface ExerciseControlLedgerHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}

/** The durable ledger, plus the lifecycle surface a host needs. The gate is handed only `ExerciseControlLedgerPort`. */
export interface DurableExerciseControlLedger extends ExerciseControlLedgerPort, ExerciseControlReconciliationPort {
  readonly providerKind: 'sqlite';
  health(): Promise<ExerciseControlLedgerHealth>;
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS exercise_control_ledger_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exercise_control_reservations (
    reservation_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    bounded_grant_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    authority_binding_digest TEXT NOT NULL,
    reserved_at TEXT NOT NULL,
    reserved_at_ms INTEGER NOT NULL,
    rule_count INTEGER NOT NULL,
    record_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS exercise_control_reservations_by_execution
    ON exercise_control_reservations (execution_id);

  CREATE TABLE IF NOT EXISTS exercise_control_reservation_limits (
    reservation_id TEXT NOT NULL REFERENCES exercise_control_reservations (reservation_id),
    ordinal INTEGER NOT NULL,
    limit_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    metric TEXT NOT NULL,
    maximum TEXT NOT NULL,
    unit TEXT,
    window_kind TEXT NOT NULL,
    window_seconds INTEGER,
    usage TEXT NOT NULL,
    reserved_at_ms INTEGER NOT NULL,
    rule_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    PRIMARY KEY (reservation_id, ordinal),
    UNIQUE (reservation_id, limit_id, scope_key)
  );

  CREATE INDEX IF NOT EXISTS exercise_control_limits_by_bucket
    ON exercise_control_reservation_limits (limit_id, scope_key, reserved_at_ms);

  CREATE TABLE IF NOT EXISTS exercise_control_terminal_events (
    reservation_id TEXT PRIMARY KEY REFERENCES exercise_control_reservations (reservation_id),
    terminal_kind TEXT NOT NULL CHECK (terminal_kind IN ('settled', 'released')),
    reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exercise_control_reservation_resolutions (
    reservation_id TEXT PRIMARY KEY REFERENCES exercise_control_reservations (reservation_id),
    execution_id TEXT NOT NULL,
    resolution_digest TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK (resolution IN ('confirmed-completed', 'confirmed-not-completed')),
    recorded_at TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exercise_control_bucket_heads (
    limit_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    rule_row_count INTEGER NOT NULL,
    head_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    PRIMARY KEY (limit_id, scope_key)
  );

  CREATE TRIGGER IF NOT EXISTS exercise_control_bucket_heads_no_delete
    BEFORE DELETE ON exercise_control_bucket_heads
    BEGIN SELECT RAISE(ABORT, 'exercise-control bucket heads are never deleted'); END;

  CREATE TRIGGER IF NOT EXISTS exercise_control_reservations_append_only_update
    BEFORE UPDATE ON exercise_control_reservations
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_reservations_append_only_delete
    BEFORE DELETE ON exercise_control_reservations
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_limits_append_only_update
    BEFORE UPDATE ON exercise_control_reservation_limits
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservation limits are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_limits_append_only_delete
    BEFORE DELETE ON exercise_control_reservation_limits
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservation limits are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_terminal_events_append_only_update
    BEFORE UPDATE ON exercise_control_terminal_events
    BEGIN SELECT RAISE(ABORT, 'exercise-control terminal events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_terminal_events_append_only_delete
    BEFORE DELETE ON exercise_control_terminal_events
    BEGIN SELECT RAISE(ABORT, 'exercise-control terminal events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_resolutions_append_only_update
    BEFORE UPDATE ON exercise_control_reservation_resolutions
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservation resolutions are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS exercise_control_resolutions_append_only_delete
    BEFORE DELETE ON exercise_control_reservation_resolutions
    BEGIN SELECT RAISE(ABORT, 'exercise-control reservation resolutions are append-only'); END;
`;

interface ReservationRow {
  readonly reservation_id: string;
  readonly execution_id: string;
  readonly bounded_grant_id: string;
  readonly request_digest: string;
  readonly policy_digest: string;
  readonly authority_binding_digest: string;
  readonly reserved_at: string;
  readonly reserved_at_ms: number;
  readonly rule_count: number;
  readonly record_digest: string;
  readonly schema_version: string;
}

interface RuleRow {
  readonly reservation_id: string;
  readonly ordinal: number;
  readonly limit_id: string;
  readonly scope_key: string;
  readonly metric: string;
  readonly maximum: string;
  readonly unit: string | null;
  readonly window_kind: string;
  readonly window_seconds: number | null;
  readonly usage: string;
  readonly reserved_at_ms: number;
  readonly rule_digest: string;
  readonly schema_version: string;
}

interface TerminalRow {
  readonly reservation_id: string;
  readonly terminal_kind: string;
  readonly reason: string;
  readonly recorded_at: string;
  readonly event_digest: string;
  readonly schema_version: string;
}

interface ResolutionRow {
  readonly reservation_id: string;
  readonly execution_id: string;
  readonly resolution_digest: string;
  readonly resolution: string;
  readonly recorded_at: string;
  readonly event_digest: string;
  readonly schema_version: string;
}

interface VerifiedReservation {
  readonly record: ExerciseReservationRecord;
  readonly terminal?: ExerciseReservationTerminalEvent;
  readonly resolution?: ExerciseReservationResolutionEvent;
}

function corrupt(reservationId: string, what: string): ExerciseControlLedgerError {
  return new ExerciseControlLedgerError(
    'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT',
    `Persisted exercise-control state for reservation '${reservationId}' failed validation (${what}). The ledger refuses to answer from state it cannot validate.`,
  );
}

function unavailable(message: string): ExerciseControlLedgerError {
  return new ExerciseControlLedgerError('EXERCISE_CONTROL_LEDGER_UNAVAILABLE', message);
}

function invalidInput(message: string): ExerciseControlLedgerError {
  return new ExerciseControlLedgerError('EXERCISE_CONTROL_LEDGER_INPUT_INVALID', message);
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}, received '${String(value)}'.`);
  }
  return timeout;
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

/** A persisted window, or `undefined` when the columns do not spell one. */
function windowOf(row: RuleRow): ExerciseControlWindow | undefined {
  if (row.window_kind === 'lifetime' && row.window_seconds === null) return { kind: 'lifetime' };
  if (row.window_kind === 'rolling' && typeof row.window_seconds === 'number') return { kind: 'rolling', seconds: row.window_seconds };
  return undefined;
}

/** A persisted limit, or `undefined`. Deliberately literal: the rule digest and the reservation's policy digest are what prove it is the limit that was admitted. */
function limitOf(row: RuleRow): ExerciseControlLimit | undefined {
  const window = windowOf(row);
  if (window === undefined) return undefined;
  if (row.metric === 'count') {
    if (row.unit !== null) return undefined;
    const maximum = Number(row.maximum);
    if (!Number.isSafeInteger(maximum) || String(maximum) !== row.maximum) return undefined;
    return { limitId: row.limit_id, scopeKey: row.scope_key, metric: 'count', maximum, window };
  }
  if (row.metric === 'amount') {
    if (row.unit === null) return undefined;
    return { limitId: row.limit_id, scopeKey: row.scope_key, metric: 'amount', maximum: row.maximum, unit: row.unit, window };
  }
  return undefined;
}

function isTerminalKind(value: string): value is ExerciseReservationTerminalKind {
  return (EXERCISE_RESERVATION_TERMINAL_KINDS as readonly string[]).includes(value);
}

export async function createSqliteExerciseControlLedger(dbPath: string, options: CreateSqliteExerciseControlLedgerOptions = {}): Promise<DurableExerciseControlLedger> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The exercise-control ledger path must be a non-empty string.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // FULL: an acknowledged reservation that a power loss could still lose would
  // return capacity that was already spent.
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version guard runs *before* `CREATE TABLE IF NOT EXISTS`, so a ledger
  // written by a runtime this one does not implement is refused without being
  // mutated. Unknown authority state is never reinterpreted.
  if (tableExists(db, 'exercise_control_ledger_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM exercise_control_ledger_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The exercise-control ledger is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);

  const latest = db.prepare(`SELECT schema_version FROM exercise_control_ledger_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    db.prepare(`INSERT INTO exercise_control_ledger_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION, now());
  }

  const selectReservation = db.prepare(
    `SELECT reservation_id, execution_id, bounded_grant_id, request_digest, policy_digest, authority_binding_digest, reserved_at, reserved_at_ms, rule_count, record_digest, schema_version
       FROM exercise_control_reservations WHERE reservation_id = ?`,
  );
  const selectRules = db.prepare(
    `SELECT reservation_id, ordinal, limit_id, scope_key, metric, maximum, unit, window_kind, window_seconds, usage, reserved_at_ms, rule_digest, schema_version
       FROM exercise_control_reservation_limits WHERE reservation_id = ? ORDER BY ordinal`,
  );
  const selectReservationIdByExecution = db.prepare(`SELECT reservation_id FROM exercise_control_reservations WHERE execution_id = ?`);
  const selectTerminal = db.prepare(
    `SELECT reservation_id, terminal_kind, reason, recorded_at, event_digest, schema_version FROM exercise_control_terminal_events WHERE reservation_id = ?`,
  );
  // The one load-bearing bucket query, answered by the
  // `exercise_control_limits_by_bucket` prefix; never a table scan. It is
  // deliberately **not** range-filtered on `reserved_at_ms`: that column is
  // what a verification would prove, so it must not decide which rows are
  // verified. The rolling window is applied after verification.
  const selectBucket = db.prepare(`SELECT DISTINCT reservation_id FROM exercise_control_reservation_limits WHERE limit_id = ? AND scope_key = ?`);
  const countBucket = db.prepare(`SELECT COUNT(*) AS n FROM exercise_control_reservation_limits WHERE limit_id = ? AND scope_key = ?`);
  const selectHead = db.prepare(`SELECT limit_id, scope_key, rule_row_count, head_digest, schema_version FROM exercise_control_bucket_heads WHERE limit_id = ? AND scope_key = ?`);
  const upsertHead = db.prepare(
    `INSERT INTO exercise_control_bucket_heads (limit_id, scope_key, rule_row_count, head_digest, schema_version) VALUES (@limitId, @scopeKey, @ruleRowCount, @headDigest, @schemaVersion)
     ON CONFLICT (limit_id, scope_key) DO UPDATE SET rule_row_count = excluded.rule_row_count, head_digest = excluded.head_digest, schema_version = excluded.schema_version`,
  );
  const insertReservation = db.prepare(
    `INSERT INTO exercise_control_reservations
       (reservation_id, execution_id, bounded_grant_id, request_digest, policy_digest, authority_binding_digest, reserved_at, reserved_at_ms, rule_count, record_digest, committed_at, schema_version)
     VALUES (@reservationId, @executionId, @boundedGrantId, @requestDigest, @policyDigest, @authorityBindingDigest, @reservedAt, @reservedAtMs, @ruleCount, @recordDigest, @committedAt, @schemaVersion)`,
  );
  const insertRule = db.prepare(
    `INSERT INTO exercise_control_reservation_limits
       (reservation_id, ordinal, limit_id, scope_key, metric, maximum, unit, window_kind, window_seconds, usage, reserved_at_ms, rule_digest, schema_version)
     VALUES (@reservationId, @ordinal, @limitId, @scopeKey, @metric, @maximum, @unit, @windowKind, @windowSeconds, @usage, @reservedAtMs, @ruleDigest, @schemaVersion)`,
  );
  const selectResolution = db.prepare(
    `SELECT reservation_id, execution_id, resolution_digest, resolution, recorded_at, event_digest, schema_version FROM exercise_control_reservation_resolutions WHERE reservation_id = ?`,
  );
  const insertResolution = db.prepare(
    `INSERT INTO exercise_control_reservation_resolutions (reservation_id, execution_id, resolution_digest, resolution, recorded_at, event_digest, committed_at, schema_version)
     VALUES (@reservationId, @executionId, @resolutionDigest, @resolution, @recordedAt, @eventDigest, @committedAt, @schemaVersion)`,
  );
  const insertTerminal = db.prepare(
    `INSERT INTO exercise_control_terminal_events (reservation_id, terminal_kind, reason, recorded_at, event_digest, committed_at, schema_version)
     VALUES (@reservationId, @terminalKind, @reason, @recordedAt, @eventDigest, @committedAt, @schemaVersion)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The exercise-control ledger has been closed.');
  }

  /**
   * How many rule rows a bucket holds, proven against its sealed head. Throws
   * when they disagree — a row that left the bucket, a row that arrived in it,
   * a head that was edited or deleted — because either direction means the
   * bucket's usage can no longer be established.
   */
  function verifiedBucketRowCount(limitId: string, scopeKey: string): number {
    const actual = (countBucket.get(limitId, scopeKey) as { n: number }).n;
    const head = selectHead.get(limitId, scopeKey) as { rule_row_count: number; head_digest: string; schema_version: string } | undefined;
    if (head === undefined) {
      if (actual !== 0) throw corrupt(`bucket ${JSON.stringify([limitId, scopeKey])}`, 'rule rows exist for a bucket that has no head');
      return 0;
    }
    if (head.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) throw corrupt(`bucket ${JSON.stringify([limitId, scopeKey])}`, 'unrecognized bucket-head schema version');
    if (storedBucketHeadDigest({ limitId, scopeKey, ruleRowCount: head.rule_row_count }) !== head.head_digest) {
      throw corrupt(`bucket ${JSON.stringify([limitId, scopeKey])}`, 'bucket-head digest mismatch');
    }
    if (head.rule_row_count !== actual) throw corrupt(`bucket ${JSON.stringify([limitId, scopeKey])}`, 'the bucket holds a different number of rule rows than its head records');
    return actual;
  }

  /**
   * One reservation, its rules and its terminal event, proven to be what was
   * written — or `undefined` when no reservation has this id. Throws rather
   * than returning anything a caller could mistake for "no usage".
   */
  function loadVerified(reservationId: string): VerifiedReservation | undefined {
    const row = selectReservation.get(reservationId) as ReservationRow | undefined;
    const terminalRow = selectTerminal.get(reservationId) as TerminalRow | undefined;
    const resolutionRow = selectResolution.get(reservationId) as ResolutionRow | undefined;
    if (row === undefined) {
      // Under the foreign keys an orphan can only be tampering.
      if (terminalRow !== undefined || resolutionRow !== undefined || (selectRules.all(reservationId) as RuleRow[]).length > 0) throw corrupt(reservationId, 'rows exist for a reservation that does not');
      return undefined;
    }
    if (row.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) throw corrupt(reservationId, 'unrecognized reservation schema version');
    const reservedAtMs = Date.parse(row.reserved_at);
    if (Number.isNaN(reservedAtMs) || row.reserved_at_ms !== reservedAtMs) throw corrupt(reservationId, 'the reservation instant does not agree with itself');

    const ruleRows = selectRules.all(reservationId) as RuleRow[];
    if (!Number.isSafeInteger(row.rule_count) || ruleRows.length !== row.rule_count) throw corrupt(reservationId, 'the recorded rule count does not match the rule rows');
    const rules: ExerciseControlRuleUsage[] = [];
    ruleRows.forEach((ruleRow, ordinal) => {
      if (ruleRow.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) throw corrupt(reservationId, 'unrecognized rule schema version');
      if (ruleRow.ordinal !== ordinal) throw corrupt(reservationId, 'rule ordinals are not contiguous');
      if (ruleRow.reserved_at_ms !== reservedAtMs) throw corrupt(reservationId, 'a rule row disagrees with its reservation instant');
      const limit = limitOf(ruleRow);
      if (limit === undefined) throw corrupt(reservationId, 'a rule row does not spell a limit');
      const rule: ExerciseControlRuleUsage = { limit, usage: ruleRow.usage };
      if (storedRuleDigest({ reservationId, ordinal, rule, reservedAtMs }) !== ruleRow.rule_digest) throw corrupt(reservationId, 'rule digest mismatch');
      rules.push(rule);
    });

    const record: ExerciseReservationRecord = {
      reservationId: row.reservation_id,
      executionId: row.execution_id,
      boundedGrantId: row.bounded_grant_id,
      requestDigest: row.request_digest,
      policyDigest: row.policy_digest,
      authorityBindingDigest: row.authority_binding_digest,
      reservedAt: row.reserved_at,
      rules,
    };
    if (storedReservationDigest(record) !== row.record_digest) throw corrupt(reservationId, 'reservation record digest mismatch');
    // Recomputes the id from the grant and execution identity, and the policy
    // digest from the rule rows — so a rule row that was dropped, added or
    // swapped under a re-sealed digest still fails here.
    if (!isWellFormedExerciseReservation(record)) throw corrupt(reservationId, 'the reservation is not internally consistent');

    // P12: the resolution row is verified **before** anything reads its
    // answer. A row whose digest does not recompute — an edited answer, an
    // edited resolution digest, a row re-pointed at another reservation — is
    // corrupt, and the whole bucket fails closed: a tampered field can never
    // exclude its own reservation from consumption.
    let resolution: ExerciseReservationResolutionEvent | undefined;
    if (resolutionRow !== undefined) {
      if (resolutionRow.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) throw corrupt(reservationId, 'unrecognized resolution schema version');
      if (!isExerciseReservationResolution(resolutionRow.resolution) || !isWellFormedExerciseDigest(resolutionRow.resolution_digest)) throw corrupt(reservationId, 'the resolution is outside the closed vocabulary');
      if (resolutionRow.execution_id !== row.execution_id) throw corrupt(reservationId, 'the resolution names another execution');
      resolution = {
        reservationId,
        executionId: resolutionRow.execution_id,
        resolutionDigest: resolutionRow.resolution_digest,
        resolution: resolutionRow.resolution,
        recordedAt: resolutionRow.recorded_at,
      };
      if (storedResolutionEventDigest(resolution) !== resolutionRow.event_digest) throw corrupt(reservationId, 'resolution digest mismatch');
    }
    const withResolution = resolution !== undefined ? { resolution } : {};

    if (terminalRow === undefined) return { record, ...withResolution };
    if (terminalRow.schema_version !== EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION) throw corrupt(reservationId, 'unrecognized terminal-event schema version');
    if (!isTerminalKind(terminalRow.terminal_kind) || !exerciseReservationTerminalReasonMatches(terminalRow.terminal_kind, terminalRow.reason)) {
      throw corrupt(reservationId, 'the terminal event is outside the closed vocabulary');
    }
    const terminal: ExerciseReservationTerminalEvent = {
      reservationId,
      kind: terminalRow.terminal_kind,
      reason: terminalRow.reason as ExerciseReservationTerminalReason,
      recordedAt: terminalRow.recorded_at,
    };
    if (storedTerminalEventDigest(terminal) !== terminalRow.event_digest) throw corrupt(reservationId, 'terminal-event digest mismatch');
    return { record, terminal, ...withResolution };
  }

  /** After inserting one rule row: the head must record exactly one fewer row than the bucket now holds. */
  function verifiedBucketRowCountAfterInsert(limitId: string, scopeKey: string): number {
    const actual = (countBucket.get(limitId, scopeKey) as { n: number }).n;
    const head = selectHead.get(limitId, scopeKey) as { rule_row_count: number } | undefined;
    const previous = head?.rule_row_count ?? 0;
    if (previous + 1 !== actual) throw corrupt(`bucket ${JSON.stringify([limitId, scopeKey])}`, 'the bucket head does not account for the row just written');
    return actual;
  }

  const runReserve = db.transaction((request: ExerciseReservationRequest): ExerciseReservationOutcome => {
    // The authoritative reservation instant, sampled first — the write lock is
    // already held — and used for the window threshold, every persisted copy
    // and the returned record. Never an instant sampled before the lock wait.
    const reservedAt = now();
    if (!isExerciseReservationInstant(reservedAt)) throw unavailable('The exercise-control ledger clock did not answer an instant; nothing was admitted.');
    const reservedAtMs = Date.parse(reservedAt);

    const existing = loadVerified(request.reservationId);
    if (existing !== undefined) {
      return exerciseReservationsDescribeSameAttempt(existing.record, request) ? { outcome: 'already-reserved', reservation: existing.record } : { outcome: 'conflict' };
    }
    // One execution identity is one attempt, whichever grant it names. The
    // unique index makes this a database fact as well; checking first turns it
    // into a `conflict` answer rather than a constraint error.
    if ((selectReservationIdByExecution.get(request.executionId) as { reservation_id: string } | undefined) !== undefined) return { outcome: 'conflict' };

    // Active usage per bucket, read inside this transaction — which already
    // holds the write lock — and validated row by row before it counts. Every
    // reservation in the bucket is verified, rolling or not; which of them
    // fall inside a rolling window is decided afterwards, from the verified
    // instant, by `exerciseControlRuleVerdict`.
    const verified = new Map<string, VerifiedReservation>();
    const activeUsageFor = (rule: ExerciseControlRuleUsage): readonly ExerciseControlActiveUsage[] => {
      const { limit } = rule;
      verifiedBucketRowCount(limit.limitId, limit.scopeKey);
      const candidates = selectBucket.all(limit.limitId, limit.scopeKey) as { reservation_id: string }[];
      const bucket = exerciseControlBucketKey(limit);
      const active: ExerciseControlActiveUsage[] = [];
      for (const { reservation_id: reservationId } of candidates) {
        let entry = verified.get(reservationId);
        if (entry === undefined) {
          entry = loadVerified(reservationId);
          if (entry === undefined) throw corrupt(reservationId, 'a rule row names a reservation that does not exist');
          verified.set(reservationId, entry);
        }
        // Verified above — terminal and resolution alike — before either decides.
        if (!exerciseReservationConsumes(entry.terminal, entry.resolution)) continue;
        const recorded = entry.record.rules.find((candidate) => exerciseControlBucketKey(candidate.limit) === bucket);
        if (recorded === undefined) throw corrupt(reservationId, 'the bucket index names a reservation that holds no such rule');
        active.push({
          metric: recorded.limit.metric,
          ...(recorded.limit.metric === 'amount' ? { unit: recorded.limit.unit } : {}),
          usage: recorded.usage,
          reservedAtMs: Date.parse(entry.record.reservedAt),
        });
      }
      return active;
    };

    const admission = assessExerciseReservationAdmission(request, reservedAt, activeUsageFor);
    if (!admission.admitted) return { outcome: 'refused', reasonCodes: admission.reasonCodes, refusedBuckets: admission.refusedBuckets };

    const record: ExerciseReservationRecord = { ...request, reservedAt };
    insertReservation.run({
      reservationId: request.reservationId,
      executionId: request.executionId,
      boundedGrantId: request.boundedGrantId,
      requestDigest: request.requestDigest,
      policyDigest: request.policyDigest,
      authorityBindingDigest: request.authorityBindingDigest,
      reservedAt,
      reservedAtMs,
      ruleCount: request.rules.length,
      recordDigest: storedReservationDigest(record),
      committedAt: reservedAt,
      schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
    });
    request.rules.forEach((rule, ordinal) => {
      insertRule.run({
        reservationId: request.reservationId,
        ordinal,
        limitId: rule.limit.limitId,
        scopeKey: rule.limit.scopeKey,
        metric: rule.limit.metric,
        maximum: String(rule.limit.maximum),
        unit: rule.limit.metric === 'amount' ? rule.limit.unit : null,
        windowKind: rule.limit.window.kind,
        windowSeconds: rule.limit.window.kind === 'rolling' ? rule.limit.window.seconds : null,
        usage: rule.usage,
        reservedAtMs,
        ruleDigest: storedRuleDigest({ reservationId: request.reservationId, ordinal, rule, reservedAtMs }),
        schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
      });
      // The bucket's head advances in the same transaction, from the count it
      // was verified at during admission above.
      const ruleRowCount = verifiedBucketRowCountAfterInsert(rule.limit.limitId, rule.limit.scopeKey);
      upsertHead.run({
        limitId: rule.limit.limitId,
        scopeKey: rule.limit.scopeKey,
        ruleRowCount,
        headDigest: storedBucketHeadDigest({ limitId: rule.limit.limitId, scopeKey: rule.limit.scopeKey, ruleRowCount }),
        schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
      });
    });

    // Read back through the same verification path every later admission uses.
    const written = loadVerified(request.reservationId);
    if (written === undefined) throw corrupt(request.reservationId, 'the reservation could not be read back');
    return { outcome: 'reserved', reservation: written.record };
  });

  const runTerminal = db.transaction(
    (kind: ExerciseReservationTerminalKind, input: ExerciseReservationSettlement | ExerciseReservationRelease): ExerciseReservationTerminalOutcome => {
      const current = loadVerified(input.reservationId);
      if (current === undefined) return { outcome: 'not-found' };
      if (current.terminal !== undefined) {
        if (current.terminal.kind === kind && current.terminal.reason === input.reason) {
          return { outcome: kind === 'settled' ? 'already-settled' : 'already-released', terminal: current.terminal };
        }
        // Settle after release, release after settle, or the same kind for a
        // different reason: the first event stands and nothing is written.
        return { outcome: 'conflict', terminal: current.terminal };
      }
      const terminal: ExerciseReservationTerminalEvent = { reservationId: input.reservationId, kind, reason: input.reason, recordedAt: input.recordedAt };
      insertTerminal.run({
        reservationId: terminal.reservationId,
        terminalKind: terminal.kind,
        reason: terminal.reason,
        recordedAt: terminal.recordedAt,
        eventDigest: storedTerminalEventDigest(terminal),
        committedAt: now(),
        schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
      });
      const written = loadVerified(input.reservationId);
      if (written?.terminal === undefined) throw corrupt(input.reservationId, 'the terminal event could not be read back');
      return { outcome: kind, terminal: written.terminal };
    },
  );

  /**
   * P12: one resolution row, decided inside `BEGIN IMMEDIATE` — the same
   * database and the same write lock as admission — so a reservation that
   * stops consuming here and a new admission competing for that capacity are
   * serialized: the admission either sees the row or runs before it exists.
   */
  const runResolution = db.transaction((input: ExerciseReservationResolutionInput): ExerciseReservationResolutionOutcome => {
    const current = loadVerified(input.reservationId);
    if (current === undefined || current.record.executionId !== input.executionId) return { outcome: 'not-found' };
    if (current.resolution !== undefined) {
      return exerciseReservationResolutionMatches(current.resolution, input) ? { outcome: 'already-applied', event: current.resolution } : { outcome: 'conflict', event: current.resolution };
    }
    if (!exerciseReservationResolutionConsistent(current.terminal, input.resolution, input.basis)) return { outcome: 'inconsistent' };
    const event: ExerciseReservationResolutionEvent = {
      reservationId: input.reservationId,
      executionId: input.executionId,
      resolutionDigest: input.resolutionDigest,
      resolution: input.resolution,
      recordedAt: input.recordedAt,
    };
    insertResolution.run({ ...event, eventDigest: storedResolutionEventDigest(event), committedAt: now(), schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION });
    const written = loadVerified(input.reservationId);
    if (written?.resolution === undefined) throw corrupt(input.reservationId, 'the resolution could not be read back');
    return { outcome: 'applied', event: written.resolution };
  });

  const runRead = db.transaction((reservationId: string): ExerciseReservationView | undefined => {
    const current = loadVerified(reservationId);
    if (current === undefined) return undefined;
    return {
      reservation: current.record,
      state: current.terminal === undefined ? 'reserved' : current.terminal.kind,
      ...(current.terminal !== undefined ? { terminal: current.terminal } : {}),
      ...(current.resolution !== undefined ? { resolution: current.resolution } : {}),
    };
  });

  function terminal(kind: ExerciseReservationTerminalKind, input: ExerciseReservationSettlement | ExerciseReservationRelease): ExerciseReservationTerminalOutcome {
    assertOpen();
    if (
      typeof input.reservationId !== 'string' ||
      !exerciseReservationTerminalReasonMatches(kind, input.reason) ||
      typeof input.recordedAt !== 'string' ||
      Number.isNaN(Date.parse(input.recordedAt))
    ) {
      throw invalidInput('The terminal transition is outside the closed contract.');
    }
    // IMMEDIATE, like admission: the one-terminal-event check and the insert
    // happen under the write lock, so two processes finalizing one reservation
    // cannot both append.
    return runTerminal.immediate(kind, input);
  }

  return {
    providerKind: 'sqlite',

    async reserve(request: ExerciseReservationRequest): Promise<ExerciseReservationOutcome> {
      assertOpen();
      if (!isWellFormedExerciseReservationRequest(request)) throw invalidInput('The reservation request is outside the closed contract.');
      // BEGIN IMMEDIATE: the write lock is held from before the reservation
      // instant is sampled and the first usage read, until COMMIT. Returns only after COMMIT; with `synchronous = FULL`
      // the reservation is durable before this resolves.
      return runReserve.immediate(request);
    },

    async settle(input: ExerciseReservationSettlement): Promise<ExerciseReservationTerminalOutcome> {
      return terminal('settled', input);
    },

    async release(input: ExerciseReservationRelease): Promise<ExerciseReservationTerminalOutcome> {
      return terminal('released', input);
    },

    async read(reservationId: string): Promise<ExerciseReservationView | undefined> {
      assertOpen();
      return runRead(reservationId);
    },

    async reconcileResolution(input: ExerciseReservationResolutionInput): Promise<ExerciseReservationResolutionOutcome> {
      assertOpen();
      if (!isWellFormedExerciseReservationResolutionInput(input)) throw invalidInput('The reservation resolution is outside the closed contract.');
      return runResolution.immediate(input);
    },

    async health(): Promise<ExerciseControlLedgerHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM exercise_control_ledger_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return {
        status: readable && writable ? 'healthy' : 'unhealthy',
        readable,
        writable,
        schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
        checkedAt: now(),
      };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
