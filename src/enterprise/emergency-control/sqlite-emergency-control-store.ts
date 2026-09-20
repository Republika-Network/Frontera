import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  applicableEmergencyControlScopes,
  emergencyControlBlocked,
  emergencyControlKey,
  emergencyControlUnavailable,
  isEmergencyControlScope,
  isWellFormedEmergencyControlDeclaration,
  isWellFormedEmergencyControlQuery,
  EMERGENCY_CONTROL_CLEAR,
  type EmergencyControlAssessment,
  type EmergencyControlDeclaration,
  type EmergencyControlQuery,
  type EmergencyControlRelease,
  type EmergencyControlScopeMatch,
  type EmergencyControlStorePort,
} from '../../features/emergency-control-runtime/index.js';
import { EmergencyControlStoreError } from './errors.js';
import {
  EMERGENCY_CONTROL_GENESIS_DIGEST,
  EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
  emergencyControlEventDigest,
  emergencyControlHeadDigest,
  isEmergencyControlTransition,
  storedEmergencyControlDigest,
  type EmergencyControlEventRecord,
  type EmergencyControlHeadRecord,
  type EmergencyControlTransition,
  type StoredEmergencyControl,
} from './emergency-control-record.js';

/**
 * The durable emergency-control store.
 *
 * `createInMemoryEmergencyControlStore` proves the vertical slice and loses
 * every control on restart, which fails **open** for that control: the stop
 * silently stops stopping. That is the failure mode this implementation exists
 * to remove, and the design is organised around it.
 *
 * 1. **One database file, its own file.** Controls never share a file with
 *    grants, decisions, passports or assurance state: an operator must be able
 *    to back up, restore and rotate the kill switch independently of the
 *    records it governs.
 * 2. **Append-only history, plus a projection, plus a head anchor.** Every
 *    operator transition is an `activated`/`released` event with a contiguous
 *    sequence and a hash chain; the current-state row points at the event that
 *    produced it; one head row records the latest event's sequence, the number
 *    of events that must exist, and the latest digest. See
 *    `emergency-control-record.ts` for why one record was not enough.
 * 3. **One transaction per mutation.** The event, the projection and the head
 *    move together or not at all, under `journal_mode = WAL` and
 *    `synchronous = FULL`, so an acknowledged `activate` is durable before it
 *    returns.
 * 4. **Every read cross-checks all three, and a disagreement withholds.** A
 *    deleted control row, a deleted event, a deleted head, a re-pointed
 *    projection, a stale projection, a flipped `active` flag or a digest that
 *    does not recompute are each *state that cannot be established*, and the
 *    read reports `unavailable`. None of them is ever repaired into `clear` —
 *    "clear" is the one direction that must never be guessed.
 *
 * **A vanished row is not a release.** An operator who wants execution to
 * resume calls `release`, which records an explicit later transition. Anything
 * else that makes an active control disappear is damage, and damage withholds.
 *
 * ## Why the read is synchronous, and why that is not a shortcut
 *
 * `better-sqlite3` is synchronous, so `read` satisfies
 * `EmergencyControlReaderPort` exactly — including inside
 * `BoundedGrantStorePort.issue`'s synchronous `commitGuard`, which is where the
 * commit-boundary recheck has to happen and where an `await` is forbidden. No
 * cache, no background refresh, no snapshot: every call queries the database.
 * The cross-checks are a handful of primary-key and indexed lookups over a
 * table whose size is bounded by operator actions, not by traffic.
 *
 * ## Deployment scope, stated rather than implied
 *
 * Proven for the repository's existing **single-host** deployment assumption,
 * the same one `AUTHORITATIVE_GRANT_STORE.md` §12 records for the grant store.
 * Within one host, `better-sqlite3`'s synchronous access and SQLite's own write
 * serialization make a committed control visible to the very next read. Across
 * hosts sharing a filesystem, SQLite's locking applies and `busy_timeout`
 * bounds the wait. No multi-region or distributed linearizability claim is made
 * here and none should be repeated elsewhere. See
 * `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
 */

export interface CreateSqliteEmergencyControlStoreOptions {
  /** Records when a row was committed, and stamps each event. */
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface EmergencyControlStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly schemaVersion: string;
  readonly activeControls: number;
  readonly checkedAt: string;
}

/** The durable store, plus the lifecycle surface a host needs. Execution components are handed only `EmergencyControlReaderPort`; nothing below widens what they can reach. */
export interface DurableEmergencyControlStore extends EmergencyControlStorePort {
  readonly providerKind: 'sqlite';
  health(): EmergencyControlStoreHealth;
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema (`aoc.emergency-control-store.schema.v2`), three tables:
//
//   emergency_control_events  append-only, one row per operator transition.
//                             `sequence` is contiguous and assigned by this
//                             store, never by AUTOINCREMENT, so the head's
//                             count and max can be compared against it.
//   emergency_controls        the current-state projection, one row per control
//                             key, carrying the event it was produced by.
//   emergency_control_head    exactly one row. The anchor that makes a *deleted*
//                             event detectable without walking the chain.
//
// Every digest covers `active`/`transition`, which is what makes a flag flipped
// by a raw writer detectable rather than obeyed — and the three-record
// cross-check is what makes a row *removed* by a raw writer detectable rather
// than read as "no control was ever declared".
// ---------------------------------------------------------------------------
const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS emergency_control_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emergency_control_events (
    sequence INTEGER PRIMARY KEY,
    control_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_value TEXT,
    transition TEXT NOT NULL,
    issuer_ref TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    previous_event_digest TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS emergency_control_events_by_key
    ON emergency_control_events (control_key, sequence);

  CREATE TABLE IF NOT EXISTS emergency_controls (
    control_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scope_value TEXT,
    active INTEGER NOT NULL,
    issuer_ref TEXT NOT NULL,
    declared_at TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emergency_control_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    event_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    head_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );
`;

interface ControlRow {
  readonly control_key: string;
  readonly scope: string;
  readonly scope_value: string | null;
  readonly active: number;
  readonly issuer_ref: string;
  readonly declared_at: string;
  readonly event_sequence: number;
  readonly event_digest: string;
  readonly record_digest: string;
  readonly schema_version: string;
}

interface EventRow {
  readonly sequence: number;
  readonly control_key: string;
  readonly scope: string;
  readonly scope_value: string | null;
  readonly transition: string;
  readonly issuer_ref: string;
  readonly recorded_at: string;
  readonly previous_event_digest: string;
  readonly event_digest: string;
  readonly schema_version: string;
}

interface HeadRow {
  readonly event_sequence: number;
  readonly event_count: number;
  readonly event_digest: string;
  readonly head_digest: string;
  readonly updated_at: string;
  readonly schema_version: string;
}

function unavailableError(message: string): EmergencyControlStoreError {
  return new EmergencyControlStoreError('EMERGENCY_CONTROL_STORE_UNAVAILABLE', message);
}

function corruptError(message: string): EmergencyControlStoreError {
  return new EmergencyControlStoreError('EMERGENCY_CONTROL_STORE_STATE_CORRUPT', message);
}

/**
 * The event a row holds, proven to be the event that was written — or
 * `undefined`, which every caller turns into a withholding.
 */
function parseStoredEvent(row: EventRow): EmergencyControlEventRecord | undefined {
  if (row.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) return undefined;
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) return undefined;
  if (!isEmergencyControlScope(row.scope)) return undefined;
  if (!isEmergencyControlTransition(row.transition)) return undefined;
  if (typeof row.issuer_ref !== 'string' || row.issuer_ref.length === 0) return undefined;
  if (typeof row.recorded_at !== 'string' || row.recorded_at.length === 0) return undefined;
  if (typeof row.previous_event_digest !== 'string' || row.previous_event_digest.length === 0) return undefined;

  const value = row.scope_value === null ? undefined : row.scope_value;
  if (row.scope === 'global') {
    if (value !== undefined) return undefined;
  } else if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (emergencyControlKey(row.scope, value) !== row.control_key) return undefined;

  const event: EmergencyControlEventRecord = {
    sequence: row.sequence,
    controlKey: row.control_key,
    scope: row.scope,
    ...(value !== undefined ? { value } : {}),
    transition: row.transition,
    issuerRef: row.issuer_ref,
    recordedAt: row.recorded_at,
    previousEventDigest: row.previous_event_digest,
  };
  return emergencyControlEventDigest(event) === row.event_digest ? event : undefined;
}

/**
 * The control a row holds, proven to be the control that was written — or
 * `undefined`.
 *
 * Deliberately total and deliberately unforgiving. A scope outside the closed
 * vocabulary, an `active` value that is not `0`/`1`, a `scope_value` present on
 * `global` or absent on anything else, a key that does not match the scope and
 * value it claims, an event pointer that is not a real sequence, or a digest
 * that does not recompute — every one of them refuses. There is no shape this
 * can normalize into a readable row.
 */
function parseStoredControl(row: ControlRow): StoredEmergencyControl | undefined {
  if (row.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) return undefined;
  if (!isEmergencyControlScope(row.scope)) return undefined;
  if (row.active !== 0 && row.active !== 1) return undefined;
  if (typeof row.issuer_ref !== 'string' || row.issuer_ref.length === 0) return undefined;
  if (typeof row.declared_at !== 'string' || row.declared_at.length === 0) return undefined;
  if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence < 1) return undefined;
  if (typeof row.event_digest !== 'string' || row.event_digest.length === 0) return undefined;

  const value = row.scope_value === null ? undefined : row.scope_value;
  if (row.scope === 'global') {
    if (value !== undefined) return undefined;
  } else if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (emergencyControlKey(row.scope, value) !== row.control_key) return undefined;

  const control: StoredEmergencyControl = {
    controlKey: row.control_key,
    scope: row.scope,
    ...(value !== undefined ? { value } : {}),
    active: row.active === 1,
    issuerRef: row.issuer_ref,
    declaredAt: row.declared_at,
    eventSequence: row.event_sequence,
    eventDigest: row.event_digest,
  };
  return storedEmergencyControlDigest(control) === row.record_digest ? control : undefined;
}

function parseStoredHead(row: HeadRow): EmergencyControlHeadRecord | undefined {
  if (row.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) return undefined;
  if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence < 0) return undefined;
  if (!Number.isSafeInteger(row.event_count) || row.event_count < 0) return undefined;
  if (typeof row.event_digest !== 'string' || row.event_digest.length === 0) return undefined;
  if (typeof row.updated_at !== 'string' || row.updated_at.length === 0) return undefined;

  const head: EmergencyControlHeadRecord = {
    eventSequence: row.event_sequence,
    eventCount: row.event_count,
    eventDigest: row.event_digest,
    updatedAt: row.updated_at,
  };
  return emergencyControlHeadDigest(head) === row.head_digest ? head : undefined;
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, received '${String(value)}'.`);
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

export async function createSqliteEmergencyControlStore(
  dbPath: string,
  options: CreateSqliteEmergencyControlStoreOptions = {},
): Promise<DurableEmergencyControlStore> {
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // FULL rather than NORMAL: an acknowledged `activate` that a power loss could
  // still lose would leave an operator believing a deployment is stopped when
  // it is running.
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  // The version guard runs *before* `CREATE TABLE IF NOT EXISTS`, so a database
  // written by a runtime this one does not implement is refused without being
  // mutated. That includes a `schema.v1` file, which held only the projection
  // and could not prove an active control had not been deleted: it is refused
  // rather than read under rules it was never written to satisfy.
  if (tableExists(db, 'emergency_control_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM emergency_control_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailableError(
        `The emergency-control store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${EMERGENCY_CONTROL_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V2);

  const latest = db.prepare(`SELECT schema_version FROM emergency_control_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    db.prepare(`INSERT INTO emergency_control_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, now());
  } else if (latest.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) {
    db.close();
    throw unavailableError(
      `The emergency-control store is recorded under schema version '${latest.schema_version}', which this runtime does not implement (expected '${EMERGENCY_CONTROL_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
    );
  }

  const selectControl = db.prepare(
    `SELECT control_key, scope, scope_value, active, issuer_ref, declared_at, event_sequence, event_digest, record_digest, schema_version FROM emergency_controls WHERE control_key = ?`,
  );
  const selectActive = db.prepare(
    `SELECT control_key, scope, scope_value, active, issuer_ref, declared_at, event_sequence, event_digest, record_digest, schema_version FROM emergency_controls WHERE active = 1`,
  );
  const selectEvent = db.prepare(
    `SELECT sequence, control_key, scope, scope_value, transition, issuer_ref, recorded_at, previous_event_digest, event_digest, schema_version FROM emergency_control_events WHERE sequence = ?`,
  );
  const selectEventStats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS max_sequence FROM emergency_control_events`);
  const selectKeyStats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS max_sequence FROM emergency_control_events WHERE control_key = ?`);
  const selectHead = db.prepare(`SELECT event_sequence, event_count, event_digest, head_digest, updated_at, schema_version FROM emergency_control_head WHERE id = 1`);
  const insertEvent = db.prepare(
    `INSERT INTO emergency_control_events (sequence, control_key, scope, scope_value, transition, issuer_ref, recorded_at, previous_event_digest, event_digest, schema_version)
     VALUES (@sequence, @controlKey, @scope, @scopeValue, @transition, @issuerRef, @recordedAt, @previousEventDigest, @eventDigest, @schemaVersion)`,
  );
  const upsertControl = db.prepare(
    `INSERT INTO emergency_controls (control_key, scope, scope_value, active, issuer_ref, declared_at, event_sequence, event_digest, record_digest, committed_at, schema_version)
     VALUES (@controlKey, @scope, @scopeValue, @active, @issuerRef, @declaredAt, @eventSequence, @eventDigest, @recordDigest, @committedAt, @schemaVersion)
     ON CONFLICT(control_key) DO UPDATE SET
       scope = excluded.scope,
       scope_value = excluded.scope_value,
       active = excluded.active,
       issuer_ref = excluded.issuer_ref,
       declared_at = excluded.declared_at,
       event_sequence = excluded.event_sequence,
       event_digest = excluded.event_digest,
       record_digest = excluded.record_digest,
       committed_at = excluded.committed_at,
       schema_version = excluded.schema_version`,
  );
  const upsertHead = db.prepare(
    `INSERT INTO emergency_control_head (id, event_sequence, event_count, event_digest, head_digest, updated_at, schema_version)
     VALUES (1, @eventSequence, @eventCount, @eventDigest, @headDigest, @updatedAt, @schemaVersion)
     ON CONFLICT(id) DO UPDATE SET
       event_sequence = excluded.event_sequence,
       event_count = excluded.event_count,
       event_digest = excluded.event_digest,
       head_digest = excluded.head_digest,
       updated_at = excluded.updated_at,
       schema_version = excluded.schema_version`,
  );

  function writeHead(head: EmergencyControlHeadRecord): void {
    upsertHead.run({
      eventSequence: head.eventSequence,
      eventCount: head.eventCount,
      eventDigest: head.eventDigest,
      headDigest: emergencyControlHeadDigest(head),
      updatedAt: head.updatedAt,
      schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
    });
  }

  // The genesis head. An initialized store **always** has one, which is what
  // lets a missing head be read as damage rather than as a fresh database.
  if (selectHead.get() === undefined) {
    writeHead({ eventSequence: 0, eventCount: 0, eventDigest: EMERGENCY_CONTROL_GENESIS_DIGEST, updatedAt: now() });
  }

  let closed = false;

  /**
   * The head, proven consistent with the event table — or `undefined`.
   *
   * Three things are checked, and each catches a different destructive edit:
   * the head row recomputes its own digest (mutation); the event table holds
   * exactly the number of rows the head counts, with exactly the head's highest
   * sequence (deletion, truncation, or a rolled-back head); and the event the
   * head names exists and digests to what the head recorded (substitution).
   */
  function verifiedHead(): EmergencyControlHeadRecord | undefined {
    const headRow = selectHead.get() as HeadRow | undefined;
    if (headRow === undefined) return undefined;
    const head = parseStoredHead(headRow);
    if (head === undefined) return undefined;

    const stats = selectEventStats.get() as { count: number; max_sequence: number };
    if (stats.count !== head.eventCount) return undefined;
    if (stats.max_sequence !== head.eventSequence) return undefined;

    if (head.eventSequence === 0) {
      return head.eventDigest === EMERGENCY_CONTROL_GENESIS_DIGEST && head.eventCount === 0 ? head : undefined;
    }

    const eventRow = selectEvent.get(head.eventSequence) as EventRow | undefined;
    if (eventRow === undefined) return undefined;
    const event = parseStoredEvent(eventRow);
    if (event === undefined) return undefined;
    return event.sequence === head.eventSequence && eventRow.event_digest === head.eventDigest ? head : undefined;
  }

  /**
   * What the history says about one control key, cross-checked against the
   * projection — or `undefined`, meaning the two disagree and nothing about
   * this key can be established.
   *
   * Returns `'never-declared'` only when the key has **no events at all** and
   * **no projection row**. That is the one shape in which an absent row is
   * honestly "no control was ever declared"; every other absence is damage.
   */
  function verifiedControl(key: string): StoredEmergencyControl | 'never-declared' | undefined {
    const row = selectControl.get(key) as ControlRow | undefined;
    const keyStats = selectKeyStats.get(key) as { count: number; max_sequence: number };

    if (row === undefined) {
      // The deletion case the projection alone could never see: history says
      // this control was declared, and the state it produced is gone.
      return keyStats.count === 0 ? 'never-declared' : undefined;
    }

    const control = parseStoredControl(row);
    if (control === undefined) return undefined;
    // A projection with no history behind it is as inconsistent as history with
    // no projection in front of it.
    if (keyStats.count === 0) return undefined;
    // It must be derived from the **latest** event for this key, so a
    // projection left behind a newer transition cannot stand in for it.
    if (keyStats.max_sequence !== control.eventSequence) return undefined;

    const eventRow = selectEvent.get(control.eventSequence) as EventRow | undefined;
    if (eventRow === undefined) return undefined;
    const event = parseStoredEvent(eventRow);
    if (event === undefined) return undefined;
    if (event.controlKey !== key) return undefined;
    if (eventRow.event_digest !== control.eventDigest) return undefined;
    // And the projection's flag must be the transition the event recorded.
    if ((event.transition === 'activated') !== control.active) return undefined;

    return control;
  }

  /**
   * The read, inside one transaction so every applicable control is judged
   * against one consistent view.
   *
   * Only the rows that could apply are fetched — `global`, plus one per axis
   * the query states. A corrupt row for an organization this query is not about
   * is not this query's problem, and blocking every tenant because one
   * unrelated row is unreadable would be an availability failure nobody chose.
   * The **head**, by contrast, is global state: if it cannot be verified, no
   * query can be answered.
   */
  const runRead = db.transaction((query: EmergencyControlQuery): EmergencyControlAssessment => {
    if (verifiedHead() === undefined) return emergencyControlUnavailable();

    const matched: EmergencyControlScopeMatch[] = [];
    for (const applicable of applicableEmergencyControlScopes(query)) {
      const control = verifiedControl(emergencyControlKey(applicable.scope, applicable.value));
      // Unreadable or unaccounted-for applicable state is not "no control":
      // it is state that cannot be established, and it withholds.
      if (control === undefined) return emergencyControlUnavailable();
      if (control === 'never-declared') continue;
      if (control.active) matched.push(applicable);
    }
    // Monotonic: one applicable active control blocks, whatever the others say.
    // A narrower clear control never overrides a broader active one, because
    // "clear" is the absence of a match rather than a vote.
    return matched.length > 0 ? emergencyControlBlocked(matched) : EMERGENCY_CONTROL_CLEAR;
  });

  /**
   * Records one transition: the event, the projection it produces and the head
   * that anchors it, in one transaction.
   *
   * The head is verified **first**. An operator writing into state this store
   * cannot vouch for is told so loudly rather than having the write silently
   * extend a broken history — reads keep withholding meanwhile, which is the
   * safe side to be stuck on.
   */
  function appendTransition(input: {
    readonly scope: EmergencyControlScopeMatch['scope'];
    readonly value?: string;
    readonly transition: EmergencyControlTransition;
    readonly issuerRef: string;
    readonly recordedAt: string;
  }): void {
    const head = verifiedHead();
    if (head === undefined) {
      throw corruptError('The emergency-control history could not be verified, so no transition was recorded. The store refuses to extend state it cannot vouch for.');
    }
    const key = emergencyControlKey(input.scope, input.value);
    const current = verifiedControl(key);
    if (current === undefined) {
      throw corruptError(`Persisted state for emergency control '${input.scope}' could not be verified, so no transition was recorded.`);
    }
    // Idempotent on both arms: the moment execution was stopped is a fact, and
    // a second `activate` is not new information about it. A `release` of a
    // control that is not active is likewise a no-op rather than an error.
    const alreadyInState = current === 'never-declared' ? input.transition === 'released' : current.active === (input.transition === 'activated');
    if (alreadyInState) return;

    const sequence = head.eventSequence + 1;
    const event: EmergencyControlEventRecord = {
      sequence,
      controlKey: key,
      scope: input.scope,
      ...(input.value !== undefined ? { value: input.value } : {}),
      transition: input.transition,
      issuerRef: input.issuerRef,
      recordedAt: input.recordedAt,
      previousEventDigest: head.eventDigest,
    };
    const eventDigest = emergencyControlEventDigest(event);

    insertEvent.run({
      sequence,
      controlKey: key,
      scope: input.scope,
      scopeValue: input.value ?? null,
      transition: input.transition,
      issuerRef: input.issuerRef,
      recordedAt: input.recordedAt,
      previousEventDigest: head.eventDigest,
      eventDigest,
      schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
    });

    const control: StoredEmergencyControl = {
      controlKey: key,
      scope: input.scope,
      ...(input.value !== undefined ? { value: input.value } : {}),
      active: input.transition === 'activated',
      issuerRef: input.issuerRef,
      declaredAt: input.recordedAt,
      eventSequence: sequence,
      eventDigest,
    };
    upsertControl.run({
      controlKey: control.controlKey,
      scope: control.scope,
      scopeValue: control.value ?? null,
      active: control.active ? 1 : 0,
      issuerRef: control.issuerRef,
      declaredAt: control.declaredAt,
      eventSequence: control.eventSequence,
      eventDigest: control.eventDigest,
      recordDigest: storedEmergencyControlDigest(control),
      committedAt: now(),
      schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
    });

    writeHead({ eventSequence: sequence, eventCount: head.eventCount + 1, eventDigest, updatedAt: input.recordedAt });
  }

  const runActivate = db.transaction((declaration: EmergencyControlDeclaration): void => {
    appendTransition({
      scope: declaration.scope,
      ...(declaration.value !== undefined ? { value: declaration.value } : {}),
      transition: 'activated',
      issuerRef: declaration.issuerRef,
      recordedAt: declaration.declaredAt,
    });
  });

  const runRelease = db.transaction((release: EmergencyControlRelease): void => {
    appendTransition({
      scope: release.scope,
      ...(release.value !== undefined ? { value: release.value } : {}),
      transition: 'released',
      issuerRef: release.issuerRef,
      recordedAt: release.releasedAt,
    });
  });

  const runActive = db.transaction((): readonly EmergencyControlScopeMatch[] => {
    if (verifiedHead() === undefined) {
      throw corruptError('The emergency-control history could not be verified, so the active-control list cannot be reported.');
    }
    const rows = selectActive.all() as readonly ControlRow[];
    const out: EmergencyControlScopeMatch[] = [];
    for (const row of rows) {
      const control = verifiedControl(row.control_key);
      if (control === undefined) {
        throw corruptError(`Persisted state for emergency control '${row.scope}' could not be verified, so the active-control list cannot be reported.`);
      }
      if (control === 'never-declared' || !control.active) continue;
      out.push(control.value === undefined ? { scope: control.scope } : { scope: control.scope, value: control.value });
    }
    return Object.freeze(out);
  });

  return {
    providerKind: 'sqlite',

    read(query: EmergencyControlQuery): EmergencyControlAssessment {
      // Total by contract. A closed store, a malformed query, a driver failure,
      // a corrupt row and a *missing* row that history says should exist all
      // land on the same answer, and that answer withholds. This function must
      // never throw: it is called inside the grant store's commit guard.
      if (closed) return emergencyControlUnavailable();
      if (!isWellFormedEmergencyControlQuery(query)) return emergencyControlUnavailable();
      try {
        return runRead(query);
      } catch {
        return emergencyControlUnavailable();
      }
    },

    activate(declaration: EmergencyControlDeclaration): void {
      if (closed) throw unavailableError('The emergency-control store has been closed.');
      if (!isWellFormedEmergencyControlDeclaration(declaration)) {
        throw new EmergencyControlStoreError(
          'EMERGENCY_CONTROL_DECLARATION_INVALID',
          'An emergency control must state a known scope, a value for every scope but global, an issuerRef and an instant.',
        );
      }
      runActivate(declaration);
    },

    release(release: EmergencyControlRelease): void {
      if (closed) throw unavailableError('The emergency-control store has been closed.');
      if (!isEmergencyControlScope(release.scope)) {
        throw new EmergencyControlStoreError('EMERGENCY_CONTROL_DECLARATION_INVALID', 'An emergency-control release must name a known scope.');
      }
      if (release.scope === 'global' ? release.value !== undefined : typeof release.value !== 'string' || release.value.length === 0) {
        throw new EmergencyControlStoreError('EMERGENCY_CONTROL_DECLARATION_INVALID', 'An emergency-control release must state a value for every scope but global.');
      }
      if (typeof release.issuerRef !== 'string' || release.issuerRef.length === 0 || typeof release.releasedAt !== 'string' || release.releasedAt.length === 0) {
        throw new EmergencyControlStoreError('EMERGENCY_CONTROL_DECLARATION_INVALID', 'An emergency-control release must state an issuerRef and an instant.');
      }
      runRelease(release);
    },

    active(): readonly EmergencyControlScopeMatch[] {
      if (closed) throw unavailableError('The emergency-control store has been closed.');
      return runActive();
    },

    health(): EmergencyControlStoreHealth {
      const checkedAt = now();
      if (closed) {
        return { status: 'unhealthy', readable: false, schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, activeControls: 0, checkedAt };
      }
      try {
        const active = runActive();
        return { status: 'healthy', readable: true, schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, activeControls: active.length, checkedAt };
      } catch {
        return { status: 'unhealthy', readable: false, schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, activeControls: 0, checkedAt };
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
