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

export interface ReferenceCapabilityLedger {
  /** Consumes durably, or reports why it cannot: the capability, or another capability for the same execution, was consumed before. */
  consume(entry: ReferenceCapabilityConsumption, at: string): 'consumed' | 'capability-consumed' | 'execution-consumed';
  /** Records the signed transaction's hash for a consumed capability. Forward only. */
  markSigned(capabilityId: string, transactionHash: string): void;
  /** Records that signing failed after consumption. The capability stays consumed. */
  markFailed(capabilityId: string): void;
  read(capabilityId: string): { readonly state: ReferenceCapabilityState; readonly transactionHash?: string } | undefined;
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

/**
 * Opens (creating when absent) the ledger at `path` — a file, never `:memory:`:
 * a ledger that forgets at restart is the replay this exists to refuse.
 */
export async function openReferenceCapabilityLedger(path: string, options: { readonly busyTimeoutMs?: number } = {}): Promise<ReferenceCapabilityLedger> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The reference capability ledger needs a durable file path.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The reference capability ledger busy timeout is out of bounds.');
  const file = resolve(path);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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
