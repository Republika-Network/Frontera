import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
  type BindExecutionResolutionAuthorityInput,
  type BindExecutionResolutionAuthorityResult,
  type ExecutionResolutionAccessContext,
  type ExecutionResolutionBinding,
  type ExecutionResolutionRecord,
  type ExecutionResolutionState,
  type ExecutionResolutionStoreHealth,
  type RecordExecutionResolutionInput,
  type RecordExecutionResolutionResult,
} from './contracts.js';
import { ExecutionResolutionStoreError } from './errors.js';
import { buildExecutionResolutionBinding, buildExecutionResolutionRecord } from './integrity.js';
import {
  planExecutionResolution,
  planExecutionResolutionBinding,
  requireResolutionAccessContext,
  requireResolutionExecutionId,
  requireValidBinding,
  requireValidResolution,
  verifyLoadedResolutionState,
  type ExecutionResolutionStore,
} from './resolution-store.js';
import { isCanonicalResolutionInstant } from './validation.js';

/**
 * The durable execution resolution store — the production implementation of
 * `ExecutionResolutionStore` (P12). Its own file, beside P11's, never inside it:
 * P11 owns the attempt and the initial observation; this store owns the
 * resolution-authority binding and the later definitive resolution.
 *
 * ## Two append-only tables, one row each per execution
 *
 * ```
 * execution_resolution_bindings    which trusted authority may resolve this
 *                                  execution, bound to the P11 attempt digest
 * execution_resolutions            what that authority established, bound to
 *                                  the attempt, the binding and the P11
 *                                  observation it resolved
 * ```
 *
 * `execution_id` is the primary key of both. Triggers refuse `UPDATE` and
 * `DELETE`. There is no status column: "unresolved" is the absence of a
 * resolution row, and it may stay absent forever.
 *
 * ## Every write decision is one `BEGIN IMMEDIATE` transaction
 *
 * Load → verify → decide existing / conflict / write → sample `recordedAt` →
 * insert, with the write lock held from before the first read. The resolution
 * authority is **never** consulted inside a transaction: the reconciliation
 * service asks it first, outside any lock, and only then appends — so two
 * racing lookups can both happen, and at most one resolution is ever written.
 *
 * `WAL` + `synchronous = FULL`; an unknown schema version refuses to open the
 * file; every row read is re-validated and its digest recomputed. Anything else
 * is `EXECUTION_RESOLUTION_CORRUPT`, never repaired.
 */

export interface CreateSqliteExecutionResolutionStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, after the lock is held, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurableExecutionResolutionStore extends ExecutionResolutionStore {
  readonly providerKind: 'sqlite';
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS execution_resolution_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_resolution_bindings (
    execution_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    attempt_digest TEXT NOT NULL,
    authority_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    binding_digest TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_resolutions (
    execution_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    attempt_digest TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    basis_observation_digest TEXT,
    authority_id TEXT NOT NULL,
    certainty TEXT NOT NULL,
    failure TEXT,
    provider_ref TEXT,
    resolved_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    resolution_digest TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS execution_resolution_bindings_append_only_update
    BEFORE UPDATE ON execution_resolution_bindings
    BEGIN SELECT RAISE(ABORT, 'execution resolution bindings are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_resolution_bindings_append_only_delete
    BEFORE DELETE ON execution_resolution_bindings
    BEGIN SELECT RAISE(ABORT, 'execution resolution bindings are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_resolutions_append_only_update
    BEFORE UPDATE ON execution_resolutions
    BEGIN SELECT RAISE(ABORT, 'execution resolutions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS execution_resolutions_append_only_delete
    BEFORE DELETE ON execution_resolutions
    BEGIN SELECT RAISE(ABORT, 'execution resolutions are immutable'); END;
`;

interface BindingRow {
  readonly execution_id: unknown;
  readonly organization_id: unknown;
  readonly attempt_digest: unknown;
  readonly authority_id: unknown;
  readonly origin: unknown;
  readonly bound_at: unknown;
  readonly recorded_at: unknown;
  readonly schema_version: unknown;
  readonly binding_digest: unknown;
}

interface ResolutionRow {
  readonly execution_id: unknown;
  readonly organization_id: unknown;
  readonly attempt_digest: unknown;
  readonly binding_digest: unknown;
  readonly basis_observation_digest: unknown;
  readonly authority_id: unknown;
  readonly certainty: unknown;
  readonly failure: unknown;
  readonly provider_ref: unknown;
  readonly resolved_at: unknown;
  readonly recorded_at: unknown;
  readonly schema_version: unknown;
  readonly resolution_digest: unknown;
}

function unavailable(message: string): ExecutionResolutionStoreError {
  return new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_STORE_UNAVAILABLE', message);
}

function corrupt(executionId: string, what: string): ExecutionResolutionStoreError {
  return new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_CORRUPT', `The persisted resolution state for execution '${executionId}' failed validation (${what}). Refused, never repaired.`);
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

/** A column read back literally: `NULL` is absence, anything that is not text is corruption. */
function text(executionId: string, value: unknown, column: string): string {
  if (typeof value !== 'string') throw corrupt(executionId, `${column} is not text`);
  return value;
}

function optional(executionId: string, value: unknown, column: string, key: string): Record<string, string> {
  if (value === null) return {};
  return { [key]: text(executionId, value, column) };
}

function bindingOf(executionId: string, row: BindingRow): ExecutionResolutionBinding {
  return {
    schemaVersion: text(executionId, row.schema_version, 'schema_version'),
    organizationId: text(executionId, row.organization_id, 'organization_id'),
    executionId: text(executionId, row.execution_id, 'execution_id'),
    attemptDigest: text(executionId, row.attempt_digest, 'attempt_digest'),
    authorityId: text(executionId, row.authority_id, 'authority_id'),
    origin: text(executionId, row.origin, 'origin') as ExecutionResolutionBinding['origin'],
    boundAt: text(executionId, row.bound_at, 'bound_at'),
    recordedAt: text(executionId, row.recorded_at, 'recorded_at'),
    bindingDigest: text(executionId, row.binding_digest, 'binding_digest'),
  };
}

/** Every column that should be absent is decoded when present, so a completion with a failure is refused by the contract rather than dropped into a valid shape. */
function resolutionOf(executionId: string, row: ResolutionRow): ExecutionResolutionRecord {
  return {
    schemaVersion: text(executionId, row.schema_version, 'schema_version'),
    organizationId: text(executionId, row.organization_id, 'organization_id'),
    executionId: text(executionId, row.execution_id, 'execution_id'),
    attemptDigest: text(executionId, row.attempt_digest, 'attempt_digest'),
    bindingDigest: text(executionId, row.binding_digest, 'binding_digest'),
    ...optional(executionId, row.basis_observation_digest, 'basis_observation_digest', 'basisObservationDigest'),
    authorityId: text(executionId, row.authority_id, 'authority_id'),
    certainty: text(executionId, row.certainty, 'certainty') as ExecutionResolutionRecord['certainty'],
    ...optional(executionId, row.failure, 'failure', 'failure'),
    ...optional(executionId, row.provider_ref, 'provider_ref', 'providerRef'),
    resolvedAt: text(executionId, row.resolved_at, 'resolved_at'),
    recordedAt: text(executionId, row.recorded_at, 'recorded_at'),
    resolutionDigest: text(executionId, row.resolution_digest, 'resolution_digest'),
  } as ExecutionResolutionRecord;
}

export async function createSqliteExecutionResolutionStore(dbPath: string, options: CreateSqliteExecutionResolutionStoreOptions): Promise<DurableExecutionResolutionStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The execution resolution store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The execution resolution store requires an injected clock.');
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
  if (tableExists(db, 'execution_resolution_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM execution_resolution_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The execution resolution store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);
  const latest = db.prepare(`SELECT schema_version FROM execution_resolution_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    const openedAt = now();
    if (!isCanonicalResolutionInstant(openedAt)) {
      db.close();
      throw unavailable('The store clock did not answer a canonical instant.');
    }
    db.prepare(`INSERT INTO execution_resolution_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION, openedAt);
  }

  const selectBinding = db.prepare(
    `SELECT execution_id, organization_id, attempt_digest, authority_id, origin, bound_at, recorded_at, schema_version, binding_digest FROM execution_resolution_bindings WHERE execution_id = ?`,
  );
  const selectResolution = db.prepare(
    `SELECT execution_id, organization_id, attempt_digest, binding_digest, basis_observation_digest, authority_id, certainty, failure, provider_ref, resolved_at, recorded_at, schema_version, resolution_digest
       FROM execution_resolutions WHERE execution_id = ?`,
  );
  const insertBinding = db.prepare(
    `INSERT INTO execution_resolution_bindings (execution_id, organization_id, attempt_digest, authority_id, origin, bound_at, recorded_at, schema_version, binding_digest)
     VALUES (@executionId, @organizationId, @attemptDigest, @authorityId, @origin, @boundAt, @recordedAt, @schemaVersion, @bindingDigest)`,
  );
  const insertResolution = db.prepare(
    `INSERT INTO execution_resolutions
       (execution_id, organization_id, attempt_digest, binding_digest, basis_observation_digest, authority_id, certainty, failure, provider_ref, resolved_at, recorded_at, schema_version, resolution_digest)
     VALUES (@executionId, @organizationId, @attemptDigest, @bindingDigest, @basisObservationDigest, @authorityId, @certainty, @failure, @providerRef, @resolvedAt, @recordedAt, @schemaVersion, @resolutionDigest)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The execution resolution store has been closed.');
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalResolutionInstant(instant)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function load(executionId: string, organizationId: string): ExecutionResolutionState | undefined {
    const bindingRow = selectBinding.get(executionId) as BindingRow | undefined;
    const resolutionRow = selectResolution.get(executionId) as ResolutionRow | undefined;
    return verifyLoadedResolutionState(
      executionId,
      organizationId,
      bindingRow === undefined ? undefined : bindingOf(executionId, bindingRow),
      resolutionRow === undefined ? undefined : resolutionOf(executionId, resolutionRow),
    );
  }

  const runBind = db.transaction((input: BindExecutionResolutionAuthorityInput): BindExecutionResolutionAuthorityResult => {
    const plan = planExecutionResolutionBinding(input, load(input.executionId, input.organizationId));
    if (plan.kind === 'existing') return { outcome: 'existing', binding: plan.binding };
    const binding = buildExecutionResolutionBinding(input, recordedAt());
    insertBinding.run({
      executionId: binding.executionId,
      organizationId: binding.organizationId,
      attemptDigest: binding.attemptDigest,
      authorityId: binding.authorityId,
      origin: binding.origin,
      boundAt: binding.boundAt,
      recordedAt: binding.recordedAt,
      schemaVersion: binding.schemaVersion,
      bindingDigest: binding.bindingDigest,
    });
    return { outcome: 'bound', binding };
  });

  const runRecord = db.transaction((input: RecordExecutionResolutionInput): RecordExecutionResolutionResult => {
    const plan = planExecutionResolution(input, load(input.executionId, input.organizationId));
    if (plan.kind === 'existing') return { outcome: 'existing', resolution: plan.resolution };
    const resolution = buildExecutionResolutionRecord(input, recordedAt());
    insertResolution.run({
      executionId: resolution.executionId,
      organizationId: resolution.organizationId,
      attemptDigest: resolution.attemptDigest,
      bindingDigest: resolution.bindingDigest,
      basisObservationDigest: resolution.basisObservationDigest ?? null,
      authorityId: resolution.authorityId,
      certainty: resolution.certainty,
      failure: resolution.failure ?? null,
      providerRef: resolution.providerRef ?? null,
      resolvedAt: resolution.resolvedAt,
      recordedAt: resolution.recordedAt,
      schemaVersion: resolution.schemaVersion,
      resolutionDigest: resolution.resolutionDigest,
    });
    return { outcome: 'recorded', resolution };
  });

  const runRead = db.transaction((executionId: string, organizationId: string): ExecutionResolutionState | undefined => load(executionId, organizationId));

  return {
    providerKind: 'sqlite',

    async bind(context: ExecutionResolutionAccessContext, input: BindExecutionResolutionAuthorityInput): Promise<BindExecutionResolutionAuthorityResult> {
      assertOpen();
      requireValidBinding(context, input);
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return runBind.immediate(input);
    },

    async recordResolution(context: ExecutionResolutionAccessContext, input: RecordExecutionResolutionInput): Promise<RecordExecutionResolutionResult> {
      assertOpen();
      requireValidResolution(context, input);
      return runRecord.immediate(input);
    },

    async read(context: ExecutionResolutionAccessContext, executionId: string): Promise<ExecutionResolutionState | undefined> {
      assertOpen();
      const organizationId = requireResolutionAccessContext(context);
      requireResolutionExecutionId(executionId);
      return runRead(executionId, organizationId);
    },

    async health(): Promise<ExecutionResolutionStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM execution_resolution_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
