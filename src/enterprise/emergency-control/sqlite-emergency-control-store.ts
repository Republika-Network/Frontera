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
  isWellFormedEmergencyControlRelease,
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
 * 5. **A store is initialized once, and never re-initialized.** The genesis
 *    head is written only for a file carrying no emergency-control structure
 *    at all. A file that already holds a `current` v2 version row is *never*
 *    given a fresh head, so a head that was deleted stays missing and every
 *    read withholds. Anything in between — a version table with no valid
 *    current row, or emergency-control tables with no version table — refuses
 *    to open rather than guessing that the file is new. See
 *    `classifyInitialization`.
 *
 * **A vanished row is not a release.** An operator who wants execution to
 * resume calls `release`, which records an explicit later transition. Anything
 * else that makes an active control disappear is damage, and damage withholds.
 * That includes deleting every state-bearing table at once: the version row is
 * not state, it survives, and it is what stops the store reading its own
 * wreckage as a new database.
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

/**
 * The three state-bearing tables. `emergency_control_store_versions` is
 * deliberately not one of them: it is the *marker* that says this file was
 * initialized, and it is what the tables below are judged against.
 */
const STATE_TABLES = ['emergency_control_events', 'emergency_controls', 'emergency_control_head'] as const;

interface VersionRow {
  readonly schema_version: string;
  readonly migration_state: string;
  readonly recorded_at: string;
}

/**
 * Whether this file has been initialized as a v2 emergency-control store
 * before — decided **before** a single `CREATE TABLE` or `INSERT` runs, because
 * once the schema has been recreated the two cases are indistinguishable.
 *
 * This is the distinction the store previously did not draw, and the omission
 * fails **open** in the one direction that must never be guessed. Old
 * behaviour: an absent head row was written back as a genesis head, on the
 * reasoning that a store with no head must be new. But a store whose head was
 * *deleted* also has no head. So
 *
 *     activate global stop -> close -> DELETE FROM emergency_controls;
 *                                      DELETE FROM emergency_control_events;
 *                                      DELETE FROM emergency_control_head;
 *                          -> reopen
 *
 * regenerated genesis over a database that had held an active global stop. The
 * head then verified (0 events, 0 counted), the key had no projection and no
 * events, `verifiedControl` reported `never-declared` — its one honest shape
 * for "no control was ever declared" — and the read returned **clear**. The
 * kill switch had been switched off by a `DELETE`.
 *
 * The version row is the evidence that separates the two, and it survives that
 * deletion because it is not state, it is history: an initialized store can
 * never legitimately return to having no head, so a missing head in a store
 * that carries a v2 marker is damage, and damage withholds.
 *
 * Returns `'new'` only for a file carrying no emergency-control structure at
 * all. Everything ambiguous refuses rather than initializing over it:
 *
 * - a version table whose newest row is not a valid `current` row — an
 *   interrupted or hand-edited initialization — is **not** silently completed;
 * - emergency-control tables with no version table at all — a partially created
 *   or partially restored file — are **not** adopted as fresh.
 */
function classifyInitialization(db: import('better-sqlite3').Database): 'new' | 'initialized' {
  const versioned = tableExists(db, 'emergency_control_store_versions');
  const stateTables = STATE_TABLES.filter((table) => tableExists(db, table));

  if (!versioned) {
    // (E) Emergency-control structure with nothing vouching for how it got
    // there. Treating it as fresh would mean writing a genesis head into a file
    // whose history this runtime cannot account for.
    if (stateTables.length > 0) {
      throw unavailableError(
        `The emergency-control database already holds emergency-control tables (${stateTables.join(', ')}) but no schema-version record, so this runtime cannot establish whether it was ever initialized. Refusing to open it rather than treating it as a new store.`,
      );
    }
    // (A) Nothing here. This is the only shape that may be initialized.
    return 'new';
  }

  let newest: VersionRow | undefined;
  try {
    newest = db.prepare(`SELECT schema_version, migration_state, recorded_at FROM emergency_control_store_versions ORDER BY id DESC LIMIT 1`).get() as VersionRow | undefined;
  } catch {
    // A version table this runtime cannot even read is not a fresh store.
    throw unavailableError(
      'The emergency-control database holds a schema-version table this runtime cannot read. Refusing to open it rather than treating it as a new store.',
    );
  }

  // (D) A version table with no valid current row. Silently initializing here
  // would mint a genesis head for a file that may already have held controls.
  if (newest === undefined) {
    throw unavailableError(
      'The emergency-control store has a schema-version table but no version row, so this runtime cannot establish what state the database is in. Refusing to open it rather than initializing over it.',
    );
  }
  if (typeof newest.schema_version !== 'string' || newest.schema_version.length === 0) {
    throw unavailableError(
      'The emergency-control store has a schema-version row that does not record a schema version. Refusing to open it rather than initializing over it.',
    );
  }
  // The version guard proper: a database written by a runtime this one does not
  // implement is refused without being mutated. That includes a `schema.v1`
  // file, which held only the projection and could not prove an active control
  // had not been deleted.
  if (newest.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) {
    throw unavailableError(
      `The emergency-control store is recorded under schema version '${newest.schema_version}', which this runtime does not implement (expected '${EMERGENCY_CONTROL_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
    );
  }
  // (D, continued) A version row left mid-migration records an initialization
  // that never finished; completing it silently is the same guess.
  if (newest.migration_state !== 'current') {
    throw unavailableError(
      `The emergency-control store's newest schema-version row is recorded as '${newest.migration_state}' rather than 'current', so its initialization cannot be established as complete. Refusing to open it.`,
    );
  }

  // (B and C) Previously initialized under v2. Whether its head survived is not
  // decided here: it is decided by `verifiedHead`, which withholds when it did
  // not. What matters is that nothing below writes a genesis head into it.
  return 'initialized';
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

  // Which of the two this file is must be settled *before* `CREATE TABLE IF
  // NOT EXISTS` runs, because recreating the schema erases the difference. A
  // refusal here has not mutated the database.
  let initialization: 'new' | 'initialized';
  try {
    initialization = classifyInitialization(db);
  } catch (error) {
    db.close();
    throw error;
  }

  if (initialization === 'new') {
    // One transaction for the whole initialization: the schema, the marker that
    // says this file is initialized, and the genesis head that an initialized
    // file must always have. All three or none — an interrupted initialization
    // must not leave behind a version row with no head, which the rule above
    // would (correctly, but uselessly) refuse forever after.
    const genesis: EmergencyControlHeadRecord = { eventSequence: 0, eventCount: 0, eventDigest: EMERGENCY_CONTROL_GENESIS_DIGEST, updatedAt: now() };
    db.transaction(() => {
      db.exec(SCHEMA_V2);
      db.prepare(`INSERT INTO emergency_control_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, now());
      db.prepare(
        `INSERT INTO emergency_control_head (id, event_sequence, event_count, event_digest, head_digest, updated_at, schema_version) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      ).run(genesis.eventSequence, genesis.eventCount, genesis.eventDigest, emergencyControlHeadDigest(genesis), genesis.updatedAt, EMERGENCY_CONTROL_STORE_SCHEMA_VERSION);
    })();
  } else {
    // An already-initialized store. Missing tables are recreated so the
    // statements below can be prepared, and that is all: no version row, and
    // above all **no genesis head**. A table that had to be recreated is empty,
    // which is exactly what `verifiedHead` and `verifiedControl` read as damage.
    db.exec(SCHEMA_V2);
  }

  const selectControl = db.prepare(
    `SELECT control_key, scope, scope_value, active, issuer_ref, declared_at, event_sequence, event_digest, record_digest, schema_version FROM emergency_controls WHERE control_key = ?`,
  );
  const selectEvent = db.prepare(
    `SELECT sequence, control_key, scope, scope_value, transition, issuer_ref, recorded_at, previous_event_digest, event_digest, schema_version FROM emergency_control_events WHERE sequence = ?`,
  );
  // The whole history, in order, for the chain walk. Ordered by the primary
  // key, so SQLite returns it from the index without a sort.
  const selectAllEvents = db.prepare(
    `SELECT sequence, control_key, scope, scope_value, transition, issuer_ref, recorded_at, previous_event_digest, event_digest, schema_version FROM emergency_control_events ORDER BY sequence ASC`,
  );
  // Every key this database has ever mentioned, from either side. A key present
  // in only one of the two is precisely the disagreement operator diagnostics
  // have to notice.
  const selectKnownKeys = db.prepare(
    `SELECT control_key FROM emergency_control_events UNION SELECT control_key FROM emergency_controls`,
  );
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

  let closed = false;

  /**
   * The head, proven consistent with the **entire** event history — or
   * `undefined`.
   *
   * An earlier revision checked the head's own digest, the event table's count
   * and highest sequence, and the single event the head names. That is enough
   * to catch a deleted head, a truncated table and a substituted latest event,
   * and it is **not** enough to catch a rewritten *old* one. With
   *
   *     event 1  organization:org-acme  activated
   *     event 2  organization:org-acme  released     — the head names this
   *
   * rewriting event 1's `transition` leaves the count at 2, the maximum
   * sequence at 2, and event 2 digesting exactly as recorded, so every check
   * passed and the read reported success over a history that had been altered.
   * `verifiedControl` did not catch it either: it verifies only the *latest*
   * event for its key. The module advertises an append-only hash chain, and a
   * chain nobody walks is a chain nobody has.
   *
   * So the walk is the verification. From genesis forward, each row must be the
   * next sequence, must parse (which recomputes its own digest over its
   * state-bearing fields), and must name the previous row's digest as its
   * `previousEventDigest` — the link that makes rewriting *any* event break
   * every event after it. What the head claims is then checked against what the
   * walk actually found: the number of events, the final sequence, and the
   * final digest.
   *
   * ## Cost, stated exactly
   *
   * This is **O(number of operator transitions)**, on every read — not
   * constant-time, and it is not cached, because a cache is a second answer
   * that can disagree with the database at the commit boundary this read exists
   * to be correct at. What bounds it is that the history grows only when an
   * operator activates or releases a control: it is bounded by operator
   * actions, never by request traffic, so a deployment taking a million
   * governed actions against a handful of declared stops walks a handful of
   * rows each time. It stays synchronous, and it stays inside the caller's
   * transaction.
   */
  function verifiedHead(): EmergencyControlHeadRecord | undefined {
    const headRow = selectHead.get() as HeadRow | undefined;
    if (headRow === undefined) return undefined;
    const head = parseStoredHead(headRow);
    if (head === undefined) return undefined;

    const rows = selectAllEvents.all() as readonly EventRow[];
    let expectedPrevious = EMERGENCY_CONTROL_GENESIS_DIGEST;
    let verified = 0;

    for (const row of rows) {
      // Contiguous from 1: a gap, a duplicate or a re-numbered row is caught
      // here rather than by counting alone, so deleting an interior event
      // cannot be hidden by inserting another somewhere else.
      if (row.sequence !== verified + 1) return undefined;
      const event = parseStoredEvent(row);
      if (event === undefined) return undefined;
      // The link. Rewriting event N changes its digest, which is what event
      // N+1 recorded as its predecessor, so the break surfaces even when the
      // head and the latest event are untouched.
      if (event.previousEventDigest !== expectedPrevious) return undefined;
      expectedPrevious = row.event_digest;
      verified += 1;
    }

    // And the head must describe the history that was just walked, rather than
    // some other one.
    if (verified !== head.eventCount) return undefined;
    if (verified !== head.eventSequence) return undefined;
    return expectedPrevious === head.eventDigest ? head : undefined;
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

  /**
   * The operator view: every key this database knows about, reconciled, and
   * only then filtered to the active ones.
   *
   * The distinction from the effect-path read is deliberate and runs the other
   * way. A read answers *one query* and is scoped to it: a corrupt row for an
   * organization the query is not about does not block an unrelated tenant,
   * because blocking every tenant over one unrelated row is an availability
   * failure nobody chose. `active()` and `health()` answer *about the store*,
   * so they must reconcile all of it — an operator asking whether the kill
   * switch is sound is owed the whole answer or none of it.
   *
   * An earlier revision selected `WHERE active = 1` and validated only what
   * came back, which is the one query that cannot see the rows that matter: an
   * active projection that was **deleted**, and one whose `active` flag was
   * **flipped to 0**, both leave that result set before anything validates
   * them. History and head stayed intact, the loop validated nothing, and
   * `active()` returned `[]` while `health()` reported `healthy` — at the same
   * moment an effect-path read for that very control was correctly returning
   * `unavailable`. Operator diagnostics contradicting the effect path, in the
   * direction that says "all clear", is the worst available answer.
   *
   * Enumerating from **both** sides is what closes it: a key in the history
   * with no projection, and a projection with no history, are each a
   * disagreement, and neither side alone can see both.
   */
  const runActive = db.transaction((): readonly EmergencyControlScopeMatch[] => {
    if (verifiedHead() === undefined) {
      throw corruptError('The emergency-control history could not be verified, so the active-control list cannot be reported.');
    }
    const keys = selectKnownKeys.all() as readonly { control_key: string }[];
    const out: EmergencyControlScopeMatch[] = [];
    for (const { control_key: key } of keys) {
      const control = verifiedControl(key);
      // A key named by the history or by the projection is a key that was
      // declared, so `never-declared` here is itself a disagreement rather than
      // an honest absence.
      if (control === undefined || control === 'never-declared') {
        throw corruptError('Persisted emergency-control state could not be reconciled, so the active-control list cannot be reported.');
      }
      if (!control.active) continue;
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
      // The same predicate the in-memory store applies, rather than a second
      // hand-written copy of the rule. The two had already drifted once, in the
      // direction that resumes execution.
      if (!isWellFormedEmergencyControlRelease(release)) {
        throw new EmergencyControlStoreError(
          'EMERGENCY_CONTROL_DECLARATION_INVALID',
          'An emergency-control release must state a known scope, a value for every scope but global, an issuerRef and an instant.',
        );
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
