import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { canonicalSerialize } from '../governance-store/canonical-json.js';
import {
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION,
  type ExecutionAttemptRecord,
  type ExecutionOutcomeAccessContext,
  type ExecutionOutcomeRecord,
  type ExecutionOutcomeStoreHealth,
  type ExecutionTerminalObservation,
  type ExecutionTerminalRecord,
  type PrepareExecutionAttemptInput,
  type PrepareExecutionAttemptResult,
  type RecordExecutionTerminalInput,
  type RecordExecutionTerminalResult,
} from './contracts.js';
import { ExecutionOutcomeStoreError } from './errors.js';
import { buildExecutionAttemptRecord, buildExecutionTerminalRecord } from './integrity.js';
import {
  planExecutionAttempt,
  planExecutionTerminal,
  requireExecutionId,
  requireOutcomeAccessContext,
  requireValidAttempt,
  requireValidTerminal,
  verifyLoadedOutcome,
  type ExecutionOutcomeStore,
} from './outcome-store.js';
import { isCanonicalOutcomeInstant } from './validation.js';

/**
 * The durable execution outcome store — the production implementation of
 * `ExecutionOutcomeStore` (P11).
 *
 * ## Two append-only tables, one row each per execution
 *
 * ```
 * execution_attempts                 the exact prepared context: tenant,
 *                                    correlation by id, action, exact amount
 * execution_terminal_observations    the initial observation: provider
 *                                    certainty + attribution + reference, or
 *                                    the withholding layer + its codes
 * ```
 *
 * `execution_id` is the primary key of both, so one execution identity has at
 * most one attempt and one initial observation — in this process or any other
 * sharing the file. Triggers refuse `UPDATE` and `DELETE` on both; nothing here
 * issues either. There is no status column to overwrite: "pending" is the
 * absence of an observation, and a later resolution belongs to a different
 * artifact.
 *
 * Money is stored as it arrived: `amount_value` and `amount_unit` are `TEXT`,
 * written and read as JavaScript strings, never bound as numbers, so
 * `"9007199254740993.01"` and `"0.1"` come back byte-for-byte.
 *
 * ## Every write decision is one `BEGIN IMMEDIATE` transaction
 *
 * The write lock is taken **before** existing rows are read, so "load → verify
 * → decide existing / conflict / write → sample `recordedAt` → insert" happens
 * with no other writer able to interleave. The primary key is a second,
 * independent refusal of a duplicate — not the mechanism, which is the lock.
 *
 * ## Verified on every read, never repaired
 *
 * An unknown schema version refuses to open the file. Every row read — on a
 * write that finds one, and on every `read` — is re-validated against the
 * closed contract (canonical money, closed certainty combinations, recordable
 * attribution and reference) and its digest recomputed; the observation must
 * name its attempt's digest. Anything else is `EXECUTION_OUTCOME_CORRUPT`.
 *
 * `WAL` + `synchronous = FULL`: an acknowledged attempt or observation that a
 * power loss could still lose would be exactly the gap this store exists to
 * close.
 *
 * ## What this is not
 *
 * - **Not exactly-once.** No local commit is atomic with an external effect;
 *   see `ADR-DURABLE-MONETARY-OUTCOMES.md`.
 * - **Not authenticity.** Unkeyed SHA-256; a writer able to rewrite a row and
 *   its digest consistently is not detected from inside this file.
 * - **Not authority, settlement or a receipt.** No TTL, no sweeper, no poll,
 *   no reconciliation, no cleanup.
 */

export interface CreateSqliteExecutionOutcomeStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, after the lock is held, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurableExecutionOutcomeStore extends ExecutionOutcomeStore {
  readonly providerKind: 'sqlite';
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS execution_outcome_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_attempts (
    execution_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    evaluation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    bounded_grant_id TEXT NOT NULL,
    action TEXT NOT NULL,
    amount_value TEXT,
    amount_unit TEXT,
    prepared_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    attempt_digest TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_terminal_observations (
    execution_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    attempt_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    certainty TEXT,
    adapter_id TEXT,
    routed_by TEXT,
    provider_ref TEXT,
    failure TEXT,
    withheld_by TEXT,
    reason_codes_json TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    observation_digest TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS execution_attempts_append_only_update
    BEFORE UPDATE ON execution_attempts
    BEGIN SELECT RAISE(ABORT, 'execution attempts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_attempts_append_only_delete
    BEFORE DELETE ON execution_attempts
    BEGIN SELECT RAISE(ABORT, 'execution attempts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_terminal_observations_append_only_update
    BEFORE UPDATE ON execution_terminal_observations
    BEGIN SELECT RAISE(ABORT, 'execution terminal observations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_terminal_observations_append_only_delete
    BEFORE DELETE ON execution_terminal_observations
    BEGIN SELECT RAISE(ABORT, 'execution terminal observations are immutable'); END;
`;

interface AttemptRow {
  readonly execution_id: unknown;
  readonly organization_id: unknown;
  readonly evaluation_id: unknown;
  readonly request_id: unknown;
  readonly decision_id: unknown;
  readonly bounded_grant_id: unknown;
  readonly action: unknown;
  readonly amount_value: unknown;
  readonly amount_unit: unknown;
  readonly prepared_at: unknown;
  readonly recorded_at: unknown;
  readonly schema_version: unknown;
  readonly attempt_digest: unknown;
}

interface TerminalRow {
  readonly execution_id: unknown;
  readonly organization_id: unknown;
  readonly attempt_digest: unknown;
  readonly kind: unknown;
  readonly certainty: unknown;
  readonly adapter_id: unknown;
  readonly routed_by: unknown;
  readonly provider_ref: unknown;
  readonly failure: unknown;
  readonly withheld_by: unknown;
  readonly reason_codes_json: unknown;
  readonly observed_at: unknown;
  readonly recorded_at: unknown;
  readonly schema_version: unknown;
  readonly observation_digest: unknown;
}

function unavailable(message: string): ExecutionOutcomeStoreError {
  return new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_STORE_UNAVAILABLE', message);
}

function corrupt(executionId: string, what: string): ExecutionOutcomeStoreError {
  return new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_CORRUPT', `The persisted outcome for execution '${executionId}' failed validation (${what}). Refused, never repaired.`);
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

/** A column read back literally: `NULL` is absence, and anything that is not text is corruption — a number is never coerced into money or an id. */
function text(executionId: string, value: unknown, column: string): string {
  if (typeof value !== 'string') throw corrupt(executionId, `${column} is not text`);
  return value;
}

function optionalText(executionId: string, value: unknown, column: string): string | undefined {
  return value === null ? undefined : text(executionId, value, column);
}

function attemptOf(executionId: string, row: AttemptRow): ExecutionAttemptRecord {
  const amountValue = optionalText(executionId, row.amount_value, 'amount_value');
  const amountUnit = optionalText(executionId, row.amount_unit, 'amount_unit');
  if ((amountValue === undefined) !== (amountUnit === undefined)) throw corrupt(executionId, 'the amount is half present');
  return {
    schemaVersion: text(executionId, row.schema_version, 'schema_version'),
    organizationId: text(executionId, row.organization_id, 'organization_id'),
    executionId: text(executionId, row.execution_id, 'execution_id'),
    evaluationId: text(executionId, row.evaluation_id, 'evaluation_id'),
    requestId: text(executionId, row.request_id, 'request_id'),
    decisionId: text(executionId, row.decision_id, 'decision_id'),
    boundedGrantId: text(executionId, row.bounded_grant_id, 'bounded_grant_id'),
    action: text(executionId, row.action, 'action'),
    ...(amountValue !== undefined && amountUnit !== undefined ? { amount: { value: amountValue, unit: amountUnit } } : {}),
    preparedAt: text(executionId, row.prepared_at, 'prepared_at'),
    recordedAt: text(executionId, row.recorded_at, 'recorded_at'),
    attemptDigest: text(executionId, row.attempt_digest, 'attempt_digest'),
  };
}

/**
 * A row back into an observation, **including every column that should be
 * absent**: a withheld row with an adapter, or a completed one with a failure,
 * decodes with that key present and is then refused by the closed contract —
 * never silently dropped into a valid shape.
 */
function terminalOf(executionId: string, row: TerminalRow): ExecutionTerminalRecord {
  const optional = (value: unknown, column: string, key: string): Record<string, string> => {
    const decoded = optionalText(executionId, value, column);
    return decoded === undefined ? {} : { [key]: decoded };
  };
  let reasonCodes: unknown;
  if (row.reason_codes_json !== null) {
    try {
      reasonCodes = JSON.parse(text(executionId, row.reason_codes_json, 'reason_codes_json'));
    } catch (error) {
      if (error instanceof ExecutionOutcomeStoreError) throw error;
      throw corrupt(executionId, 'reason codes do not decode');
    }
  }
  const observation = {
    kind: text(executionId, row.kind, 'kind'),
    ...optional(row.certainty, 'certainty', 'certainty'),
    ...optional(row.adapter_id, 'adapter_id', 'adapterId'),
    ...optional(row.routed_by, 'routed_by', 'routedBy'),
    ...optional(row.provider_ref, 'provider_ref', 'providerRef'),
    ...optional(row.failure, 'failure', 'failure'),
    ...optional(row.withheld_by, 'withheld_by', 'withheldBy'),
    ...(reasonCodes !== undefined ? { reasonCodes } : {}),
    observedAt: text(executionId, row.observed_at, 'observed_at'),
  } as unknown as ExecutionTerminalObservation;
  return {
    schemaVersion: text(executionId, row.schema_version, 'schema_version'),
    organizationId: text(executionId, row.organization_id, 'organization_id'),
    executionId: text(executionId, row.execution_id, 'execution_id'),
    attemptDigest: text(executionId, row.attempt_digest, 'attempt_digest'),
    observation,
    recordedAt: text(executionId, row.recorded_at, 'recorded_at'),
    observationDigest: text(executionId, row.observation_digest, 'observation_digest'),
  };
}

function terminalColumns(observation: ExecutionTerminalObservation): Record<string, string | null> {
  if (observation.kind === 'withheld') {
    return { kind: 'withheld', certainty: null, adapterId: null, routedBy: null, providerRef: null, failure: null, withheldBy: observation.withheldBy, reasonCodesJson: canonicalSerialize(observation.reasonCodes) };
  }
  return {
    kind: 'provider',
    certainty: observation.certainty,
    adapterId: observation.adapterId,
    routedBy: observation.routedBy ?? null,
    providerRef: observation.providerRef ?? null,
    failure: observation.certainty === 'confirmed-not-completed' ? observation.failure : null,
    withheldBy: null,
    reasonCodesJson: null,
  };
}

export async function createSqliteExecutionOutcomeStore(dbPath: string, options: CreateSqliteExecutionOutcomeStoreOptions): Promise<DurableExecutionOutcomeStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The execution outcome store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The execution outcome store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version guard runs before `CREATE TABLE IF NOT EXISTS`, so a file
  // written under a schema this runtime does not implement is refused unmutated.
  if (tableExists(db, 'execution_outcome_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM execution_outcome_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== EXECUTION_OUTCOME_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The execution outcome store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${EXECUTION_OUTCOME_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);
  const latest = db.prepare(`SELECT schema_version FROM execution_outcome_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    const openedAt = now();
    if (!isCanonicalOutcomeInstant(openedAt)) {
      db.close();
      throw unavailable('The store clock did not answer a canonical instant.');
    }
    db.prepare(`INSERT INTO execution_outcome_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EXECUTION_OUTCOME_STORE_SCHEMA_VERSION, openedAt);
  }

  const selectAttempt = db.prepare(
    `SELECT execution_id, organization_id, evaluation_id, request_id, decision_id, bounded_grant_id, action, amount_value, amount_unit, prepared_at, recorded_at, schema_version, attempt_digest
       FROM execution_attempts WHERE execution_id = ?`,
  );
  const selectTerminal = db.prepare(
    `SELECT execution_id, organization_id, attempt_digest, kind, certainty, adapter_id, routed_by, provider_ref, failure, withheld_by, reason_codes_json, observed_at, recorded_at, schema_version, observation_digest
       FROM execution_terminal_observations WHERE execution_id = ?`,
  );
  const insertAttempt = db.prepare(
    `INSERT INTO execution_attempts
       (execution_id, organization_id, evaluation_id, request_id, decision_id, bounded_grant_id, action, amount_value, amount_unit, prepared_at, recorded_at, schema_version, attempt_digest)
     VALUES (@executionId, @organizationId, @evaluationId, @requestId, @decisionId, @boundedGrantId, @action, @amountValue, @amountUnit, @preparedAt, @recordedAt, @schemaVersion, @attemptDigest)`,
  );
  const insertTerminal = db.prepare(
    `INSERT INTO execution_terminal_observations
       (execution_id, organization_id, attempt_digest, kind, certainty, adapter_id, routed_by, provider_ref, failure, withheld_by, reason_codes_json, observed_at, recorded_at, schema_version, observation_digest)
     VALUES (@executionId, @organizationId, @attemptDigest, @kind, @certainty, @adapterId, @routedBy, @providerRef, @failure, @withheldBy, @reasonCodesJson, @observedAt, @recordedAt, @schemaVersion, @observationDigest)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The execution outcome store has been closed.');
  }

  function recordedAt(): string {
    // Sampled inside the transaction: after the write lock is held, however long it waited.
    const instant = now();
    if (!isCanonicalOutcomeInstant(instant)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function load(executionId: string, organizationId: string): ExecutionOutcomeRecord | undefined {
    const attemptRow = selectAttempt.get(executionId) as AttemptRow | undefined;
    const terminalRow = selectTerminal.get(executionId) as TerminalRow | undefined;
    return verifyLoadedOutcome(
      executionId,
      organizationId,
      attemptRow === undefined ? undefined : attemptOf(executionId, attemptRow),
      terminalRow === undefined ? undefined : terminalOf(executionId, terminalRow),
    );
  }

  const runPrepare = db.transaction((input: PrepareExecutionAttemptInput): PrepareExecutionAttemptResult => {
    const plan = planExecutionAttempt(input, load(input.executionId, input.organizationId));
    if (plan.kind === 'existing') return { outcome: 'existing', attempt: plan.attempt };
    const attempt = buildExecutionAttemptRecord(input, recordedAt());
    insertAttempt.run({
      executionId: attempt.executionId,
      organizationId: attempt.organizationId,
      evaluationId: attempt.evaluationId,
      requestId: attempt.requestId,
      decisionId: attempt.decisionId,
      boundedGrantId: attempt.boundedGrantId,
      action: attempt.action,
      amountValue: attempt.amount?.value ?? null,
      amountUnit: attempt.amount?.unit ?? null,
      preparedAt: attempt.preparedAt,
      recordedAt: attempt.recordedAt,
      schemaVersion: attempt.schemaVersion,
      attemptDigest: attempt.attemptDigest,
    });
    return { outcome: 'prepared', attempt };
  });

  const runRecord = db.transaction((input: RecordExecutionTerminalInput): RecordExecutionTerminalResult => {
    const plan = planExecutionTerminal(input, load(input.executionId, input.organizationId));
    if (plan.kind === 'existing') return { outcome: 'existing', terminal: plan.terminal };
    const terminal = buildExecutionTerminalRecord(input, plan.attempt, recordedAt());
    insertTerminal.run({
      executionId: terminal.executionId,
      organizationId: terminal.organizationId,
      attemptDigest: terminal.attemptDigest,
      ...terminalColumns(terminal.observation),
      observedAt: terminal.observation.observedAt,
      recordedAt: terminal.recordedAt,
      schemaVersion: terminal.schemaVersion,
      observationDigest: terminal.observationDigest,
    });
    return { outcome: 'recorded', terminal };
  });

  const runRead = db.transaction((executionId: string, organizationId: string): ExecutionOutcomeRecord | undefined => load(executionId, organizationId));

  return {
    providerKind: 'sqlite',

    async prepareAttempt(context: ExecutionOutcomeAccessContext, input: PrepareExecutionAttemptInput): Promise<PrepareExecutionAttemptResult> {
      assertOpen();
      requireValidAttempt(context, input);
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return runPrepare.immediate(input);
    },

    async recordTerminal(context: ExecutionOutcomeAccessContext, input: RecordExecutionTerminalInput): Promise<RecordExecutionTerminalResult> {
      assertOpen();
      requireValidTerminal(context, input);
      return runRecord.immediate(input);
    },

    async read(context: ExecutionOutcomeAccessContext, executionId: string): Promise<ExecutionOutcomeRecord | undefined> {
      assertOpen();
      const organizationId = requireOutcomeAccessContext(context);
      requireExecutionId(executionId);
      return runRead(executionId, organizationId);
    },

    async health(): Promise<ExecutionOutcomeStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM execution_outcome_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === EXECUTION_OUTCOME_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: EXECUTION_OUTCOME_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
