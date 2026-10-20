import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * TRADE-04C-S1 — the reference delegated signer's **durable capability
 * consumption ledger**: one row per delegated-offer signing capability the
 * signer ever accepted, written and committed **before** its key is touched.
 *
 * - **Single use, across requests, processes and restarts.** The capability id
 *   is the primary key and the execution id is unique: a capability — or a
 *   second capability for the same execution — is refused once a row exists.
 *   The row is inserted in an `IMMEDIATE` transaction with `synchronous = FULL`,
 *   so two signer processes sharing the file serialize on it, and a crash after
 *   the commit leaves the capability consumed.
 * - **Consumed is permanent.** A row moves only forward — `consumed` →
 *   `signed` or `signing-failed` — and is never deleted (triggers refuse both).
 *   A capability consumed before a signing failure is not reusable; a crash
 *   between the commit and the signature leaves `consumed` with no hash, which
 *   is exactly the uncertainty a later reconciliation must see: the signer
 *   never signs that capability again, and never re-sends a stored blob.
 * - **What it is not.** It is the reference signer's own file, as trustworthy
 *   as the host that keeps it: an operator (or attacker) able to rewrite it
 *   can delete a row. That is the signer-process-compromise case, outside what
 *   any capability can guarantee.
 * - **Never recreated implicitly (TRADE-04D).** A missing file is not an
 *   empty ledger: recreating it would forget every consumption and reset
 *   replay protection. A ledger comes into existence only by an explicit act
 *   (`create: true`; the launcher's `init-consumption-ledger`). A file without
 *   the ledger's schema, under another schema, or failing SQLite's integrity
 *   check is refused, never repaired.
 * - **Not anchored (TRADE-04D).** Ordinary SQLite durability survives a crash;
 *   it does not detect a restore of an older copy or a malicious rollback.
 *   Nothing outside the signer host witnesses this file. Recovery therefore
 *   treats what it reports (`inspect`, `inspectReferenceCapabilityLedger`) as
 *   the customer's evidence — a hint, never proof that a capability was not
 *   consumed or that nothing was signed.
 */

export const REFERENCE_CAPABILITY_LEDGER_SCHEMA_VERSION = 'frontera.reference-delegated-offer-capability-ledger.v1';

export type ReferenceCapabilityState = 'consumed' | 'signed' | 'signing-failed';

export interface ReferenceCapabilityConsumption {
  readonly capabilityId: string;
  readonly executionId: string;
  readonly boundedGrantId: string;
  readonly signingPreimageDigest: string;
  readonly expiresAt: string;
}

/**
 * TRADE-04D — what the ledger says about one execution, for recovery: the
 * customer signer operator's report. `unavailable` when the ledger cannot be
 * read (missing, unreadable, corrupt): never `absent`.
 */
export type ReferenceCapabilityInspection =
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'absent' }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'consumed' | 'signing-failed'; readonly capabilityId: string }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'signed'; readonly capabilityId: string; readonly transactionHash: string }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'unavailable' };

export interface ReferenceCapabilityLedger {
  /** Consumes durably, or reports why it cannot: the capability, or another capability for the same execution, was consumed before. */
  consume(entry: ReferenceCapabilityConsumption, at: string): 'consumed' | 'capability-consumed' | 'execution-consumed';
  /** Records the signed transaction's hash for a consumed capability. Forward only. */
  markSigned(capabilityId: string, transactionHash: string): void;
  /** Records that signing failed after consumption. The capability stays consumed. */
  markFailed(capabilityId: string): void;
  read(capabilityId: string): { readonly state: ReferenceCapabilityState; readonly transactionHash?: string } | undefined;
  /** TRADE-04D: the row for one execution, by execution id. Throws when the ledger cannot be read (fail closed). */
  inspect(executionId: string): ReferenceCapabilityInspection;
  counts(): Readonly<Record<ReferenceCapabilityState, number>>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capability_ledger_versions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consumed_capabilities (
  capability_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  bounded_grant_id TEXT NOT NULL,
  signing_preimage_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('consumed', 'signed', 'signing-failed')),
  transaction_hash TEXT
);
CREATE TRIGGER IF NOT EXISTS consumed_capabilities_never_deleted BEFORE DELETE ON consumed_capabilities
BEGIN SELECT RAISE(ABORT, 'a consumed capability is permanent'); END;
CREATE TRIGGER IF NOT EXISTS consumed_capabilities_forward_only BEFORE UPDATE ON consumed_capabilities
WHEN OLD.state <> 'consumed' OR NEW.state = 'consumed'
  OR NEW.capability_id IS NOT OLD.capability_id OR NEW.execution_id IS NOT OLD.execution_id
  OR NEW.bounded_grant_id IS NOT OLD.bounded_grant_id OR NEW.signing_preimage_digest IS NOT OLD.signing_preimage_digest
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.consumed_at IS NOT OLD.consumed_at
BEGIN SELECT RAISE(ABORT, 'a consumed capability only moves forward'); END;
`;

type Row = { readonly state: ReferenceCapabilityState; readonly transaction_hash: string | null };
type ExecutionRow = { readonly capability_id: unknown; readonly state: unknown; readonly transaction_hash: unknown };

const STATES: readonly ReferenceCapabilityState[] = ['consumed', 'signed', 'signing-failed'];

function inspectionOf(executionId: string, row: ExecutionRow | undefined): ReferenceCapabilityInspection {
  if (row === undefined) return Object.freeze({ source: 'customer-signer-ledger', executionId, state: 'absent' });
  if (typeof row.capability_id !== 'string' || !STATES.includes(row.state as ReferenceCapabilityState)) throw new Error('The reference capability ledger holds a malformed row.');
  if (row.state === 'signed') {
    if (typeof row.transaction_hash !== 'string' || !/^[0-9A-F]{64}$/.test(row.transaction_hash)) throw new Error('The reference capability ledger holds a malformed row.');
    return Object.freeze({ source: 'customer-signer-ledger', executionId, state: 'signed', capabilityId: row.capability_id, transactionHash: row.transaction_hash });
  }
  return Object.freeze({ source: 'customer-signer-ledger', executionId, state: row.state as 'consumed' | 'signing-failed', capabilityId: row.capability_id });
}

function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function passesIntegrityCheck(db: { pragma(source: string, options?: { simple?: boolean }): unknown }): boolean {
  return db.pragma('quick_check', { simple: true }) === 'ok';
}

/**
 * Opens the ledger at `path` — a file, never `:memory:`: a ledger that forgets
 * at restart is the replay this exists to refuse. An absent file is refused
 * unless `create: true` says, explicitly, that a new signer's ledger is being
 * initialized (TRADE-04D): a lost ledger is never silently replaced by an
 * empty one.
 */
export async function openReferenceCapabilityLedger(path: string, options: { readonly busyTimeoutMs?: number; readonly create?: boolean } = {}): Promise<ReferenceCapabilityLedger> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The reference capability ledger needs a durable file path.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The reference capability ledger busy timeout is out of bounds.');
  if (options.create !== undefined && typeof options.create !== 'boolean') throw new Error('The reference capability ledger create option is a boolean.');
  const create = options.create === true;
  const file = resolve(path);
  if (!existsSync(file) && !create) {
    throw new Error('The reference capability ledger does not exist at its configured path. It is never recreated implicitly: an empty ledger would forget every consumed capability. Initialize a ledger explicitly only for a new signer.');
  }
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, create ? {} : { fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const initialized = tableExists(db, 'capability_ledger_versions');
    if (!initialized && (tableExists(db, 'consumed_capabilities') || !create)) throw new Error('The reference capability ledger file is not an initialized ledger; refusing to open it.');
    if (initialized && !passesIntegrityCheck(db)) throw new Error('The reference capability ledger failed its integrity check; refusing to open it.');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(SCHEMA);
    db.transaction(() => {
      const version = db.prepare('SELECT schema_version FROM capability_ledger_versions WHERE id = 1').get() as { schema_version: unknown } | undefined;
      if (version === undefined) db.prepare('INSERT INTO capability_ledger_versions (id, schema_version) VALUES (1, ?)').run(REFERENCE_CAPABILITY_LEDGER_SCHEMA_VERSION);
      else if (version.schema_version !== REFERENCE_CAPABILITY_LEDGER_SCHEMA_VERSION) throw new Error('The reference capability ledger is recorded under another schema version; refusing to open it.');
    }).immediate();
  } catch (error) {
    db.close();
    throw error instanceof Error && error.message.startsWith('The reference capability ledger') ? error : new Error('The reference capability ledger could not be opened.');
  }

  const selectCapability = db.prepare('SELECT state, transaction_hash FROM consumed_capabilities WHERE capability_id = ?');
  const selectExecution = db.prepare('SELECT 1 FROM consumed_capabilities WHERE execution_id = ?');
  const selectExecutionRow = db.prepare('SELECT capability_id, state, transaction_hash FROM consumed_capabilities WHERE execution_id = ?');
  const insert = db.prepare(
    `INSERT INTO consumed_capabilities (capability_id, execution_id, bounded_grant_id, signing_preimage_digest, expires_at, consumed_at, state) VALUES (?, ?, ?, ?, ?, ?, 'consumed')`,
  );
  const signed = db.prepare(`UPDATE consumed_capabilities SET state = 'signed', transaction_hash = ? WHERE capability_id = ? AND state = 'consumed'`);
  const failed = db.prepare(`UPDATE consumed_capabilities SET state = 'signing-failed' WHERE capability_id = ? AND state = 'consumed'`);
  const counted = db.prepare('SELECT state, COUNT(*) AS n FROM consumed_capabilities GROUP BY state');

  const consume = db.transaction((entry: ReferenceCapabilityConsumption, at: string): 'consumed' | 'capability-consumed' | 'execution-consumed' => {
    if (selectCapability.get(entry.capabilityId) !== undefined) return 'capability-consumed';
    if (selectExecution.get(entry.executionId) !== undefined) return 'execution-consumed';
    insert.run(entry.capabilityId, entry.executionId, entry.boundedGrantId, entry.signingPreimageDigest, entry.expiresAt, at);
    return 'consumed';
  });

  let closed = false;
  const open = (): void => {
    if (closed) throw new Error('The reference capability ledger is closed.');
  };

  return Object.freeze({
    consume(entry: ReferenceCapabilityConsumption, at: string) {
      open();
      // IMMEDIATE: the write lock is taken before the reads, so a second process cannot interleave between check and insert.
      return consume.immediate(entry, at);
    },
    markSigned(capabilityId: string, transactionHash: string) {
      open();
      signed.run(transactionHash, capabilityId);
    },
    markFailed(capabilityId: string) {
      open();
      failed.run(capabilityId);
    },
    read(capabilityId: string) {
      open();
      const row = selectCapability.get(capabilityId) as Row | undefined;
      return row === undefined ? undefined : Object.freeze({ state: row.state, ...(row.transaction_hash !== null ? { transactionHash: row.transaction_hash } : {}) });
    },
    inspect(executionId: string) {
      open();
      if (typeof executionId !== 'string' || executionId.length === 0) throw new Error('The reference capability ledger inspection needs an execution id.');
      return inspectionOf(executionId, selectExecutionRow.get(executionId) as ExecutionRow | undefined);
    },
    counts() {
      open();
      const out: Record<ReferenceCapabilityState, number> = { consumed: 0, signed: 0, 'signing-failed': 0 };
      for (const row of counted.all() as { state: ReferenceCapabilityState; n: number }[]) out[row.state] = row.n;
      return Object.freeze(out);
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  });
}

/**
 * TRADE-04D — the signer operator's recovery read: what the ledger at `path`
 * holds for one execution. Never creates, migrates or writes (the file must
 * exist; the connection is opened read-only, and is query-only besides).
 * Any failure — missing file, foreign
 * schema, failed integrity check, unreadable row — answers `unavailable`,
 * never `absent`.
 */
export async function inspectReferenceCapabilityLedger(path: string, executionId: string): Promise<ReferenceCapabilityInspection> {
  const unavailable = Object.freeze({ source: 'customer-signer-ledger' as const, executionId, state: 'unavailable' as const });
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:' || typeof executionId !== 'string' || executionId.length === 0) return unavailable;
  const file = resolve(path);
  if (!existsSync(file)) return unavailable;
  let db: import('better-sqlite3').Database | undefined;
  try {
    const { default: Database } = await import('better-sqlite3');
    // TRADE-04D L-2: SQLITE_OPEN_READONLY, not a writable connection asked to behave — inspection on the
    // signer's host never writes, checkpoints or recovers the ledger it reads.
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    if (!tableExists(db, 'capability_ledger_versions') || !tableExists(db, 'consumed_capabilities')) return unavailable;
    const version = db.prepare('SELECT schema_version FROM capability_ledger_versions WHERE id = 1').get() as { schema_version: unknown } | undefined;
    if (version?.schema_version !== REFERENCE_CAPABILITY_LEDGER_SCHEMA_VERSION || !passesIntegrityCheck(db)) return unavailable;
    return inspectionOf(executionId, db.prepare('SELECT capability_id, state, transaction_hash FROM consumed_capabilities WHERE execution_id = ?').get(executionId) as ExecutionRow | undefined);
  } catch {
    return unavailable;
  } finally {
    db?.close();
  }
}
