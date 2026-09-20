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
  EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
  storedEmergencyControlDigest,
  type StoredEmergencyControl,
} from './emergency-control-record.js';

/**
 * The durable emergency-control store.
 *
 * `createInMemoryEmergencyControlStore` proves the vertical slice and loses
 * every control on restart, which fails **open** for that control: the stop
 * silently stops stopping. That is the one failure mode this implementation
 * exists to remove, so the design is organised around it.
 *
 * 1. **One database file, its own file.** Controls never share a file with
 *    grants, decisions, passports or assurance state: an operator must be able
 *    to back up, restore and rotate the kill switch independently of the
 *    records it governs.
 * 2. **One transaction per mutation.** `activate` and `release` are single
 *    synchronous `db.transaction(...)` calls, so a control and its digest
 *    commit together or not at all.
 * 3. **`journal_mode = WAL`, `synchronous = FULL`.** An acknowledged
 *    `activate` is durable before it returns. An operator who has been told
 *    "execution is stopped" must not lose that to a power cut.
 * 4. **Every read verifies, and a failure withholds.** A row whose digest does
 *    not match its fields, whose scope is outside the closed vocabulary, or
 *    whose `active` flag is not `0`/`1` is never interpreted. The read reports
 *    `unavailable`, which withholds — it is never repaired into `clear`.
 *
 * ## Why the read is synchronous, and why that is not a shortcut
 *
 * `better-sqlite3` is synchronous, so `read` can satisfy
 * `EmergencyControlReaderPort` exactly — including inside
 * `BoundedGrantStorePort.issue`'s synchronous `commitGuard`, which is where the
 * commit-boundary recheck has to happen and where an `await` is forbidden. No
 * cache, no background refresh, no snapshot: every call queries the database.
 *
 * ## Deployment scope, stated rather than implied
 *
 * This is proven for the repository's existing **single-host** deployment
 * assumption, which is the same assumption `AUTHORITATIVE_GRANT_STORE.md` §12
 * records for the grant store. Within one host, `better-sqlite3`'s synchronous
 * access and SQLite's own write serialization make a committed control visible
 * to the very next read. Across hosts sharing a filesystem, SQLite's locking
 * applies and `busy_timeout` bounds the wait, but no claim of distributed
 * linearizability is made here and none should be repeated elsewhere: a
 * multi-region deployment needs a control plane this phase does not build. See
 * `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
 */

export interface CreateSqliteEmergencyControlStoreOptions {
  /** Records when a row was committed. Bookkeeping only; no check reads it. */
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
// Schema (`aoc.emergency-control-store.schema.v1`), one table:
//
//   emergency_controls   one row per declared control, keyed by its scope and
//                        value. `active` is a flag rather than a row's presence
//                        so a cleared control keeps its history — who declared
//                        it, and when — instead of vanishing.
//
// `record_digest` covers every field including `active`, which is what makes a
// flag flipped by a raw writer detectable rather than obeyed.
// ---------------------------------------------------------------------------
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS emergency_control_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emergency_controls (
    control_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scope_value TEXT,
    active INTEGER NOT NULL,
    issuer_ref TEXT NOT NULL,
    declared_at TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
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
  readonly record_digest: string;
  readonly schema_version: string;
}

function unavailableError(message: string): EmergencyControlStoreError {
  return new EmergencyControlStoreError('EMERGENCY_CONTROL_STORE_UNAVAILABLE', message);
}

/**
 * The control a row holds, proven to be the control that was written — or
 * `undefined`, which the caller turns into `unavailable`.
 *
 * Deliberately total and deliberately unforgiving. A scope outside the closed
 * vocabulary, an `active` value that is not `0` or `1`, a `scope_value` present
 * on `global` or absent on anything else, a key that does not match the scope
 * and value it claims, or a digest that does not match the fields — every one
 * of them refuses. There is no shape this can normalize into a readable row,
 * and the only direction a repair could ever take is "clear", which is exactly
 * the direction that must never be taken.
 */
function parseStoredControl(row: ControlRow): StoredEmergencyControl | undefined {
  if (row.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) return undefined;
  if (!isEmergencyControlScope(row.scope)) return undefined;
  if (row.active !== 0 && row.active !== 1) return undefined;
  if (typeof row.issuer_ref !== 'string' || row.issuer_ref.length === 0) return undefined;
  if (typeof row.declared_at !== 'string' || row.declared_at.length === 0) return undefined;

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
  };
  return storedEmergencyControlDigest(control) === row.record_digest ? control : undefined;
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
  // mutated. Unknown control state is never reinterpreted under the current
  // schema.
  if (tableExists(db, 'emergency_control_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM emergency_control_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== EMERGENCY_CONTROL_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailableError(
        `The emergency-control store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${EMERGENCY_CONTROL_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);

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
    `SELECT control_key, scope, scope_value, active, issuer_ref, declared_at, record_digest, schema_version FROM emergency_controls WHERE control_key = ?`,
  );
  const selectActive = db.prepare(
    `SELECT control_key, scope, scope_value, active, issuer_ref, declared_at, record_digest, schema_version FROM emergency_controls WHERE active = 1`,
  );
  const upsertControl = db.prepare(
    `INSERT INTO emergency_controls (control_key, scope, scope_value, active, issuer_ref, declared_at, record_digest, committed_at, schema_version)
     VALUES (@controlKey, @scope, @scopeValue, @active, @issuerRef, @declaredAt, @recordDigest, @committedAt, @schemaVersion)
     ON CONFLICT(control_key) DO UPDATE SET
       scope = excluded.scope,
       scope_value = excluded.scope_value,
       active = excluded.active,
       issuer_ref = excluded.issuer_ref,
       declared_at = excluded.declared_at,
       record_digest = excluded.record_digest,
       committed_at = excluded.committed_at,
       schema_version = excluded.schema_version`,
  );

  let closed = false;

  function writeControl(control: StoredEmergencyControl): void {
    upsertControl.run({
      controlKey: control.controlKey,
      scope: control.scope,
      scopeValue: control.value ?? null,
      active: control.active ? 1 : 0,
      issuerRef: control.issuerRef,
      declaredAt: control.declaredAt,
      recordDigest: storedEmergencyControlDigest(control),
      committedAt: now(),
      schemaVersion: EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
    });
  }

  const runActivate = db.transaction((declaration: EmergencyControlDeclaration): void => {
    const key = emergencyControlKey(declaration.scope, declaration.value);
    const existingRow = selectControl.get(key) as ControlRow | undefined;
    if (existingRow !== undefined) {
      const existing = parseStoredControl(existingRow);
      // A row that already reads as active is left exactly as it stands: the
      // moment execution was stopped is a fact, and a second `activate` is not
      // new information about it. A row that cannot be read is overwritten with
      // a well-formed active one — moving from "unreadable" to "stopped" never
      // widens anything.
      if (existing !== undefined && existing.active) return;
    }
    writeControl({
      controlKey: key,
      scope: declaration.scope,
      ...(declaration.value !== undefined ? { value: declaration.value } : {}),
      active: true,
      issuerRef: declaration.issuerRef,
      declaredAt: declaration.declaredAt,
    });
  });

  const runRelease = db.transaction((release: EmergencyControlRelease): void => {
    const key = emergencyControlKey(release.scope, release.value);
    writeControl({
      controlKey: key,
      scope: release.scope,
      ...(release.value !== undefined ? { value: release.value } : {}),
      active: false,
      issuerRef: release.issuerRef,
      declaredAt: release.releasedAt,
    });
  });

  /**
   * The read, inside one transaction so every applicable control is judged
   * against one consistent view.
   *
   * Only the rows that could apply are fetched — `global`, plus one row per
   * axis the query states. A corrupt row for an organization this query is not
   * about is not this query's problem, and blocking every tenant because one
   * unrelated row is malformed would be an availability failure nobody chose.
   */
  const runRead = db.transaction((query: EmergencyControlQuery): EmergencyControlAssessment => {
    const matched: EmergencyControlScopeMatch[] = [];
    for (const applicable of applicableEmergencyControlScopes(query)) {
      const row = selectControl.get(emergencyControlKey(applicable.scope, applicable.value)) as ControlRow | undefined;
      if (row === undefined) continue;
      const control = parseStoredControl(row);
      // Unreadable applicable state is not "no control": it is state that
      // cannot be established, and it withholds.
      if (control === undefined) return emergencyControlUnavailable();
      if (control.active) matched.push(applicable);
    }
    // Monotonic: one applicable active control blocks, whatever the others say.
    // A narrower clear control never overrides a broader active one, because
    // "clear" is the absence of a match rather than a vote.
    return matched.length > 0 ? emergencyControlBlocked(matched) : EMERGENCY_CONTROL_CLEAR;
  });

  const runActive = db.transaction((): readonly EmergencyControlScopeMatch[] => {
    const rows = selectActive.all() as readonly ControlRow[];
    const out: EmergencyControlScopeMatch[] = [];
    for (const row of rows) {
      const control = parseStoredControl(row);
      if (control === undefined) continue;
      out.push(control.value === undefined ? { scope: control.scope } : { scope: control.scope, value: control.value });
    }
    return Object.freeze(out);
  });

  return {
    providerKind: 'sqlite',

    read(query: EmergencyControlQuery): EmergencyControlAssessment {
      // Total by contract. A closed store, a malformed query, a driver failure
      // and a corrupt row all land on the same answer, and that answer
      // withholds. This function must never throw: it is called inside the
      // grant store's commit guard.
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
