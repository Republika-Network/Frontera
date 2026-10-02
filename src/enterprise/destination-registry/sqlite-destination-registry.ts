import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { executionDestinationKey, parseExecutionDestination } from '../../features/destination-runtime/index.js';
import {
  DestinationRegistryError,
  buildDestinationRegistration,
  isCanonicalRegistrationInstant,
  isDestinationRegistrantReference,
  knownDestination,
  requireRegisterDestinationInput,
  requireRegistryDestination,
  sampleRegistrationInstant,
  unknownDestination,
  type DestinationLookup,
  type DestinationRegisterResult,
  type DestinationRegistration,
  type DestinationRegistryPort,
  type RegisterDestinationInput,
} from '../../features/destination-runtime/registry/index.js';

/**
 * The durable destination registry (ANDREW-P0-02) — the production
 * implementation of `DestinationRegistryPort`.
 *
 * ## One append-only table, one row per destination
 *
 * ```
 * registered_destinations    destination_key (PRIMARY KEY), namespace,
 *                            identifier, registered_by, registered_at
 * ```
 *
 * `destination_key` is P0-01's `executionDestinationKey`, and
 * `(namespace, identifier)` is independently `UNIQUE`, so one destination has
 * at most one record — in this process or any other sharing the file. Both use
 * SQLite's default `BINARY` collation: comparison is byte-exact and
 * case-sensitive, exactly as P0-01 compares. Triggers refuse `UPDATE` and
 * `DELETE`: a destination's identity is immutable, and a vanished record would
 * not be a revocation of anything. There is no status, approval, trust or
 * expiry column, because registry membership is not any of those.
 *
 * ## Registration is one `BEGIN IMMEDIATE` transaction
 *
 * "look up → existing? return it : sample `registeredAt` → insert" runs with
 * the write lock held, so two concurrent registrations of one destination
 * converge on one row and both callers are told `registered` or `existing`.
 * The primary key is a second, independent refusal of a duplicate.
 *
 * ## Verified on every read, never repaired
 *
 * Every row read is re-parsed through `parseExecutionDestination`, its key
 * recomputed and compared, and its provenance re-checked. A row that fails is
 * `DESTINATION_REGISTRY_CORRUPT` — never silently read as `unknown`, and never
 * reshaped into a valid record. An unknown schema version refuses to open the
 * file. `WAL` + `synchronous = FULL`: an acknowledged registration is durable
 * before `register` returns.
 *
 * ## What this is not
 *
 * - **Not approval.** A row here means the destination is *known*. Whether it
 *   may receive anything is decided by governance (P0-03+), elsewhere.
 * - **Not authenticity.** `registered_by` is descriptive provenance; no
 *   signature or digest proves who wrote a row.
 * - **Not distributed.** Single-host SQLite, the same deployment assumption as
 *   the grant and emergency-control stores.
 */

export const DESTINATION_REGISTRY_SCHEMA_VERSION = 'aoc.destination-registry.schema.v1';

export interface CreateSqliteDestinationRegistryOptions {
  /** The injected clock: sampled inside each registration's `BEGIN IMMEDIATE`, after the lock is held, as `registeredAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

/** The durable registry, plus the lifecycle surface a host needs. */
export interface DurableDestinationRegistry extends DestinationRegistryPort {
  readonly providerKind: 'sqlite';
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS destination_registry_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registered_destinations (
    destination_key TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    identifier TEXT NOT NULL,
    registered_by TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    UNIQUE (namespace, identifier)
  );

  CREATE TRIGGER IF NOT EXISTS registered_destinations_append_only_update
    BEFORE UPDATE ON registered_destinations
    BEGIN SELECT RAISE(ABORT, 'registered destinations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS registered_destinations_append_only_delete
    BEFORE DELETE ON registered_destinations
    BEGIN SELECT RAISE(ABORT, 'registered destinations are immutable'); END;
`;

interface RegisteredDestinationRow {
  readonly destination_key: unknown;
  readonly namespace: unknown;
  readonly identifier: unknown;
  readonly registered_by: unknown;
  readonly registered_at: unknown;
  readonly schema_version: unknown;
}

function unavailable(message: string): DestinationRegistryError {
  return new DestinationRegistryError('DESTINATION_REGISTRY_UNAVAILABLE', message);
}

function corrupt(destinationKey: string, what: string): DestinationRegistryError {
  return new DestinationRegistryError('DESTINATION_REGISTRY_CORRUPT', `The persisted registration for '${destinationKey}' failed validation (${what}). Refused, never repaired.`);
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

/**
 * A row back into a record, re-derived rather than trusted: the destination
 * goes through P0-01's ingress again, and the stored key must equal both the
 * key it was looked up by and the key P0-01 computes for it.
 */
function registrationOf(lookupKey: string, row: RegisteredDestinationRow): DestinationRegistration {
  if (row.schema_version !== DESTINATION_REGISTRY_SCHEMA_VERSION) throw corrupt(lookupKey, 'unknown record schema version');
  const parsed = parseExecutionDestination({ namespace: row.namespace, identifier: row.identifier });
  if (!parsed.valid) throw corrupt(lookupKey, `stored destination is malformed: ${parsed.violation}`);
  const derivedKey = executionDestinationKey(parsed.destination);
  if (row.destination_key !== lookupKey || derivedKey !== lookupKey) throw corrupt(lookupKey, 'stored key does not match the destination');
  if (!isDestinationRegistrantReference(row.registered_by)) throw corrupt(lookupKey, 'registered_by is malformed');
  if (!isCanonicalRegistrationInstant(row.registered_at)) throw corrupt(lookupKey, 'registered_at is not a canonical instant');
  return buildDestinationRegistration(parsed.destination, row.registered_by, row.registered_at);
}

export async function createSqliteDestinationRegistry(dbPath: string, options: CreateSqliteDestinationRegistryOptions): Promise<DurableDestinationRegistry> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The destination registry path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The destination registry requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version decision is one `BEGIN IMMEDIATE` transaction, read before any
  // `CREATE`, so a file under a schema this runtime does not implement is
  // refused unmutated. A new file is recorded `current` once; reopening a v1
  // file appends nothing.
  try {
    db.transaction(() => {
      const latest = tableExists(db, 'destination_registry_versions')
        ? (db.prepare(`SELECT schema_version FROM destination_registry_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined)?.schema_version
        : undefined;
      if (latest !== undefined && latest !== DESTINATION_REGISTRY_SCHEMA_VERSION) {
        throw unavailable(`The destination registry is recorded under schema version '${latest}', which this runtime does not implement (expected '${DESTINATION_REGISTRY_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      const openedAt = latest === undefined ? sampleRegistrationInstant(now) : undefined;
      db.exec(SCHEMA_V1);
      if (openedAt !== undefined) {
        db.prepare(`INSERT INTO destination_registry_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(DESTINATION_REGISTRY_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const selectByKey = db.prepare(
    `SELECT destination_key, namespace, identifier, registered_by, registered_at, schema_version
       FROM registered_destinations WHERE destination_key = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO registered_destinations (destination_key, namespace, identifier, registered_by, registered_at, schema_version)
     VALUES (@destinationKey, @namespace, @identifier, @registeredBy, @registeredAt, @schemaVersion)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The destination registry has been closed.');
  }

  function load(destinationKey: string): DestinationRegistration | undefined {
    const row = selectByKey.get(destinationKey) as RegisteredDestinationRow | undefined;
    return row === undefined ? undefined : registrationOf(destinationKey, row);
  }

  const runRegister = db.transaction((input: RegisterDestinationInput): DestinationRegisterResult => {
    const destinationKey = executionDestinationKey(input.destination);
    const existing = load(destinationKey);
    // The first record stands: a retry, with any provenance, gets the original back.
    if (existing !== undefined) return Object.freeze({ outcome: 'existing', registration: existing });
    // Sampled after the write lock is held, however long it waited.
    const registration = buildDestinationRegistration(input.destination, input.registeredBy, sampleRegistrationInstant(now));
    insert.run({
      destinationKey: registration.destinationKey,
      namespace: registration.destination.namespace,
      identifier: registration.destination.identifier,
      registeredBy: registration.registeredBy,
      registeredAt: registration.registeredAt,
      schemaVersion: DESTINATION_REGISTRY_SCHEMA_VERSION,
    });
    return Object.freeze({ outcome: 'registered', registration });
  });

  return {
    providerKind: 'sqlite',

    register(input: RegisterDestinationInput): DestinationRegisterResult {
      assertOpen();
      // BEGIN IMMEDIATE; durable before this returns (`synchronous = FULL`).
      return runRegister.immediate(requireRegisterDestinationInput(input));
    },

    lookup(destination): DestinationLookup {
      assertOpen();
      const destinationKey = executionDestinationKey(requireRegistryDestination(destination));
      const registration = load(destinationKey);
      return registration === undefined ? unknownDestination(destinationKey) : knownDestination(registration);
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
