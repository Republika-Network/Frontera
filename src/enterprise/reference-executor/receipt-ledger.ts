import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { executorReceiptDigest, parseExecutorReceipt, positionExecutorReceipt, serializeExecutorReceipt, type ExecutorReceipt, type ExecutorReceiptDraft } from '../executor-receipt/index.js';

/**
 * G-02C1C — the reference executor's **receipt ledger**: one SQLite file per
 * executor identity, separate from the G-02A consumption ledger (which is not
 * changed), holding every receipt it ever fixed.
 *
 * ## Reserve, then issue
 *
 * A receipt's whole canonical text is committed (`reserved`) before anyone
 * signs it, under an `IMMEDIATE` transaction that also decides its position.
 * Signing is deterministic (Ed25519), so whoever signs a reserved text — the
 * first attempt, a retry after a crash, a competing process — produces the
 * same signature; `issued` records it. No two different texts can ever be
 * signed for one position, and a signature lost in a crash is reproduced
 * byte for byte, never replaced by a different one.
 *
 * ## One chain per capability, forward only
 *
 * - `(capability_id, sequence)` and `receipt_id` are unique; the id is the
 *   digest of (executor, capability, sequence), so it is never re-minted.
 * - A new receipt is reserved only when the consumption state it rests on has
 *   changed since the newest one, and only to supersede an
 *   `attempted-outcome-unknown` receipt with a definite outcome (a trigger
 *   enforces the predecessor, its position and its outcome). The same state
 *   returns the receipt already there; every other change is a conflict.
 * - Nothing is deleted; a reserved row may only become issued, with every other
 *   column unchanged; the identity row is fixed.
 *
 * ## Integrity at open
 *
 * A missing file is never an empty ledger (`create: true` initializes one,
 * never over an existing file). At open: tables, triggers, `quick_check`,
 * schema version, executor and audience, and every row's text re-parsed,
 * re-digested and matched to its columns. A ledger that fails is refused.
 *
 * Like the consumption ledger it is as trustworthy as the host that keeps it:
 * restoring an older copy forgets receipts. Two SQLite files are never one
 * atomic transaction.
 */

export const EXECUTOR_RECEIPT_LEDGER_SCHEMA_VERSION = 'frontera.executor-receipt-ledger.v1';

export class ExecutorReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorReceiptConflictError';
  }
}

export interface StoredExecutorReceipt {
  readonly receiptId: string;
  readonly capabilityId: string;
  readonly sequence: number;
  readonly state: 'reserved' | 'issued';
  readonly canonical: string;
  readonly digest: string;
  readonly receipt: ExecutorReceipt;
  /** The CORE-02 envelope, once issued. */
  readonly signature: Readonly<Record<string, string>> | null;
}

/** An issued receipt, as a verifier is handed it. */
export interface IssuedExecutorReceipt {
  readonly receipt: string;
  readonly signature: Readonly<Record<string, string>>;
}

export interface ExecutorReceiptLedger {
  readonly executorId: string;
  readonly audience: string;
  /** Whether `value` is a receipt this ledger instance returned. The receipt signer is bound to one ledger and signs only these. */
  owns(value: unknown): boolean;
  /** The key ids named by reservations still waiting for a signature. */
  pendingKeyIds(): readonly string[];
  /**
   * The authoritative receipt for `draft`'s capability: a reservation still waiting for its signature (always first: a
   * receipt is never superseded before it is signed), the one already there when the consumption state is unchanged, or
   * a newly reserved one superseding an unknown. Throws `ExecutorReceiptConflictError` otherwise.
   */
  reserve(draft: ExecutorReceiptDraft): StoredExecutorReceipt;
  /** Records the signature over a reserved receipt. Idempotent for the same signature; a different signature is a conflict. */
  issue(reservation: StoredExecutorReceipt, signature: Readonly<Record<string, string>>): StoredExecutorReceipt;
  read(receiptId: string): StoredExecutorReceipt | undefined;
  /** The newest receipt for a capability, reserved or issued. */
  latest(capabilityId: string): StoredExecutorReceipt | undefined;
  /** Every issued receipt for a capability, oldest first: the history a verifier needs. */
  history(capabilityId: string): readonly IssuedExecutorReceipt[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executor_receipt_ledger_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  audience TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executor_receipts (
  receipt_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  supersedes TEXT UNIQUE REFERENCES executor_receipts (receipt_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('consumed-not-attempted', 'attempted-outcome-unknown', 'completed-observed', 'failed-observed')),
  ledger_state TEXT NOT NULL CHECK (ledger_state IN ('claimed', 'completed', 'failed', 'outcome-unknown')),
  key_id TEXT NOT NULL,
  canonical TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'issued')),
  signature TEXT,
  reserved_at TEXT NOT NULL,
  issued_at TEXT,
  UNIQUE (capability_id, sequence),
  CHECK ((sequence = 1 AND supersedes IS NULL) OR (sequence > 1 AND supersedes IS NOT NULL)),
  CHECK ((state = 'reserved' AND signature IS NULL AND issued_at IS NULL) OR (state = 'issued' AND signature IS NOT NULL AND issued_at IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS executor_receipt_ledger_meta_fixed_update BEFORE UPDATE ON executor_receipt_ledger_meta
BEGIN SELECT RAISE(ABORT, 'the receipt ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS executor_receipt_ledger_meta_fixed_delete BEFORE DELETE ON executor_receipt_ledger_meta
BEGIN SELECT RAISE(ABORT, 'the receipt ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS executor_receipts_never_deleted BEFORE DELETE ON executor_receipts
BEGIN SELECT RAISE(ABORT, 'a receipt is permanent'); END;
CREATE TRIGGER IF NOT EXISTS executor_receipts_issue_only BEFORE UPDATE ON executor_receipts
WHEN NOT (OLD.state = 'reserved' AND NEW.state = 'issued')
  OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.capability_id IS NOT OLD.capability_id OR NEW.execution_id IS NOT OLD.execution_id
  OR NEW.issuer IS NOT OLD.issuer OR NEW.sequence IS NOT OLD.sequence OR NEW.supersedes IS NOT OLD.supersedes
  OR NEW.outcome IS NOT OLD.outcome OR NEW.ledger_state IS NOT OLD.ledger_state OR NEW.key_id IS NOT OLD.key_id
  OR NEW.canonical IS NOT OLD.canonical OR NEW.digest IS NOT OLD.digest OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT, 'a reserved receipt only becomes issued'); END;
CREATE TRIGGER IF NOT EXISTS executor_receipts_forward_supersession BEFORE INSERT ON executor_receipts
WHEN NEW.supersedes IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM executor_receipts AS prior
  WHERE prior.receipt_id = NEW.supersedes AND prior.capability_id = NEW.capability_id AND prior.execution_id = NEW.execution_id
    AND prior.issuer = NEW.issuer AND prior.sequence = NEW.sequence - 1 AND prior.outcome = 'attempted-outcome-unknown'
    AND NEW.outcome <> 'attempted-outcome-unknown'
)
BEGIN SELECT RAISE(ABORT, 'a receipt supersedes only its unknown predecessor, forward'); END;
`;

const TRIGGERS: readonly string[] = [
  'executor_receipt_ledger_meta_fixed_update',
  'executor_receipt_ledger_meta_fixed_delete',
  'executor_receipts_never_deleted',
  'executor_receipts_issue_only',
  'executor_receipts_forward_supersession',
];

interface ReceiptRow {
  readonly receipt_id: unknown;
  readonly capability_id: unknown;
  readonly execution_id: unknown;
  readonly issuer: unknown;
  readonly sequence: unknown;
  readonly supersedes: unknown;
  readonly outcome: unknown;
  readonly ledger_state: unknown;
  readonly key_id: unknown;
  readonly canonical: unknown;
  readonly digest: unknown;
  readonly state: unknown;
  readonly signature: unknown;
}

type Database = import('better-sqlite3').Database;

const SIGNATURE_FIELDS = ['algorithm', 'artifactVersion', 'keyId', 'signature'];

/** A row read back and checked against its own text: a changed column, text or digest is corruption, never data. */
function storedOf(row: ReceiptRow, executorId: string, audience: string): StoredExecutorReceipt {
  const corrupt = (): never => {
    throw new Error('The executor receipt ledger holds a corrupted receipt.');
  };
  const parsed = parseExecutorReceipt(row.canonical);
  if (!parsed.ok) return corrupt();
  const receipt = parsed.receipt;
  if (row.digest !== executorReceiptDigest(row.canonical as string)) return corrupt();
  const columnsMatch =
    row.receipt_id === receipt.receiptId &&
    row.capability_id === receipt.capabilityId &&
    row.execution_id === receipt.executionId &&
    row.issuer === receipt.issuer &&
    row.sequence === receipt.sequence &&
    row.supersedes === receipt.supersedes &&
    row.outcome === receipt.outcome &&
    row.ledger_state === receipt.consumption.ledgerState &&
    row.key_id === receipt.executorKeyId &&
    receipt.executorId === executorId &&
    receipt.audience === audience;
  if (!columnsMatch) return corrupt();
  let signature: Readonly<Record<string, string>> | null = null;
  if (row.state === 'issued') {
    let envelope: unknown;
    try {
      envelope = JSON.parse(String(row.signature));
    } catch {
      return corrupt();
    }
    const fields = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) ? Object.keys(envelope).sort() : [];
    if (JSON.stringify(fields) !== JSON.stringify(SIGNATURE_FIELDS) || !Object.values(envelope as Record<string, unknown>).every((value) => typeof value === 'string')) return corrupt();
    if ((envelope as Record<string, string>)['keyId'] !== receipt.executorKeyId) return corrupt();
    signature = Object.freeze({ ...(envelope as Record<string, string>) });
  } else if (row.state !== 'reserved' || row.signature !== null) {
    return corrupt();
  }
  return Object.freeze({ receiptId: receipt.receiptId, capabilityId: receipt.capabilityId, sequence: receipt.sequence, state: signature === null ? ('reserved' as const) : ('issued' as const), canonical: row.canonical as string, digest: row.digest as string, receipt, signature });
}

export async function openExecutorReceiptLedger(
  path: string,
  options: { readonly executorId: string; readonly audience: string; readonly clock: () => number; readonly create?: boolean; readonly busyTimeoutMs?: number },
): Promise<ExecutorReceiptLedger> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The executor receipt ledger needs a durable file path.');
  const { executorId, audience, clock } = options;
  if (typeof executorId !== 'string' || executorId.length === 0 || typeof audience !== 'string' || audience.length === 0) throw new Error('The executor receipt ledger needs its executor and audience.');
  if (typeof clock !== 'function') throw new Error('The executor receipt ledger needs a clock.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The executor receipt ledger busy timeout is out of bounds.');
  const create = options.create === true;
  const file = resolve(path);
  if (create && existsSync(file)) throw new Error('The executor receipt ledger already exists at that path. It is never re-initialized over existing receipts.');
  if (!create && !existsSync(file)) throw new Error('The executor receipt ledger does not exist at its configured path. It is never created implicitly.');
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  /** The file and its directory belong to this user and no one else can write them: whoever can rewrite receipts can make the executor sign theirs. */
  const private_ = (target: string, kind: 'file' | 'directory'): boolean => {
    try {
      const stat = lstatSync(target);
      const shape = kind === 'file' ? stat.isFile() : stat.isDirectory();
      return shape && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0;
    } catch {
      return false;
    }
  };
  if (uid === undefined || !private_(dirname(file), 'directory') || (!create && !private_(file, 'file'))) {
    throw new Error('The executor receipt ledger and its directory must belong to this user and be writable by no one else.');
  }
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db: Database = new SqliteDatabase(file, create ? {} : { fileMustExist: true });
  const statements = (() => {
    try {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      if (!create) {
        const table = (name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
        if (!table('executor_receipt_ledger_meta') || !table('executor_receipts')) throw new Error('The executor receipt ledger file is not an initialized receipt ledger; refusing to open it.');
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The executor receipt ledger failed its integrity check; refusing to open it.');
        const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})`).get(...TRIGGERS) as { n: unknown };
        if (triggers.n !== TRIGGERS.length) throw new Error('The executor receipt ledger is missing its integrity triggers; refusing to open it.');
      }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      if (create) {
        db.transaction(() => {
          db.exec(SCHEMA);
          db.prepare('INSERT INTO executor_receipt_ledger_meta (id, schema_version, executor_id, audience) VALUES (1, ?, ?, ?)').run(EXECUTOR_RECEIPT_LEDGER_SCHEMA_VERSION, executorId, audience);
        }).immediate();
      }
      const meta = db.prepare('SELECT schema_version, executor_id, audience FROM executor_receipt_ledger_meta WHERE id = 1').get() as { schema_version: unknown; executor_id: unknown; audience: unknown } | undefined;
      if (meta?.schema_version !== EXECUTOR_RECEIPT_LEDGER_SCHEMA_VERSION) throw new Error('The executor receipt ledger is recorded under another schema version; refusing to open it.');
      if (meta.executor_id !== executorId || meta.audience !== audience) throw new Error('The executor receipt ledger belongs to another executor or audience; refusing to open it.');
      const all = db.prepare('SELECT * FROM executor_receipts ORDER BY capability_id, sequence').all() as ReceiptRow[];
      // Every receipt, re-read against its own text: a ledger that was edited underneath is refused, not trusted.
      for (const row of all) storedOf(row, executorId, audience);
      return {
        byCapability: db.prepare('SELECT * FROM executor_receipts WHERE capability_id = ? ORDER BY sequence'),
        byId: db.prepare('SELECT * FROM executor_receipts WHERE receipt_id = ?'),
        insert: db.prepare(
          `INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, signature, reserved_at, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL)`,
        ),
        pendingKeys: db.prepare("SELECT DISTINCT key_id FROM executor_receipts WHERE state = 'reserved' ORDER BY key_id"),
        markIssued: db.prepare(`UPDATE executor_receipts SET state = 'issued', signature = ?, issued_at = ? WHERE receipt_id = ? AND state = 'reserved' AND canonical = ?`),
      };
    } catch (error) {
      db.close();
      throw error instanceof Error && error.message.startsWith('The executor receipt ledger') ? error : new Error('The executor receipt ledger could not be opened.');
    }
  })();

  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error('The executor receipt ledger is closed.');
  };
  const instant = (): string => {
    const now = clock();
    if (!Number.isSafeInteger(now)) throw new Error('The executor receipt ledger clock did not answer.');
    return new Date(now).toISOString();
  };
  const rowsOf = (capabilityId: string): StoredExecutorReceipt[] => (statements.byCapability.all(capabilityId) as ReceiptRow[]).map((row) => storedOf(row, executorId, audience));
  // Receipts this instance returned: the one signer bound to this ledger signs only these.
  const owned = new WeakSet<object>();
  const brand = (stored: StoredExecutorReceipt): StoredExecutorReceipt => {
    owned.add(stored);
    return stored;
  };

  const reserveInTransaction = db.transaction((draft: ExecutorReceiptDraft): StoredExecutorReceipt => {
    const rows = rowsOf(draft.capabilityId);
    const newest = rows[rows.length - 1];
    let position: { readonly sequence: number; readonly supersedes: string | null };
    if (newest === undefined) {
      position = { sequence: 1, supersedes: null };
    } else {
      // A reservation waiting for its signature is signed before anything supersedes it, whatever the state is now.
      if (newest.state === 'reserved') return newest;
      const sameState = newest.receipt.consumption.ledgerState === draft.consumption.ledgerState;
      if (sameState) return newest;
      const unknownBefore = newest.receipt.outcome === 'attempted-outcome-unknown';
      if (unknownBefore && draft.outcome === 'attempted-outcome-unknown') return newest;
      // Not earlier than the unknown it resolves (a claim and its outcome can share a millisecond).
      const forward = unknownBefore && draft.observedAt >= newest.receipt.observedAt;
      if (!forward) throw new ExecutorReceiptConflictError('The consumption state no longer matches the newest receipt, and the change is not a forward resolution of an unknown outcome.');
      position = { sequence: newest.sequence + 1, supersedes: newest.receiptId };
    }
    const receipt = positionExecutorReceipt(draft, position.sequence, position.supersedes);
    const canonical = serializeExecutorReceipt(receipt);
    statements.insert.run(receipt.receiptId, receipt.capabilityId, receipt.executionId, receipt.issuer, receipt.sequence, receipt.supersedes, receipt.outcome, receipt.consumption.ledgerState, receipt.executorKeyId, canonical, executorReceiptDigest(canonical), instant());
    return storedOf(statements.byId.get(receipt.receiptId) as ReceiptRow, executorId, audience);
  });

  const ledger: ExecutorReceiptLedger = {
    executorId,
    audience,
    owns: (value: unknown): boolean => typeof value === 'object' && value !== null && owned.has(value),
    pendingKeyIds(): readonly string[] {
      ensureOpen();
      return Object.freeze((statements.pendingKeys.all() as { key_id: unknown }[]).map((row) => String(row.key_id)));
    },
    reserve(draft: ExecutorReceiptDraft): StoredExecutorReceipt {
      ensureOpen();
      if (draft.executorId !== executorId || draft.audience !== audience) throw new ExecutorReceiptConflictError('A receipt for another executor or audience does not belong in this ledger.');
      return brand(reserveInTransaction.immediate(draft));
    },
    issue(reservation: StoredExecutorReceipt, signature: Readonly<Record<string, string>>): StoredExecutorReceipt {
      ensureOpen();
      const text = JSON.stringify(Object.fromEntries(SIGNATURE_FIELDS.map((field) => [field, signature[field]])));
      const issueInTransaction = db.transaction((): StoredExecutorReceipt => {
        statements.markIssued.run(text, instant(), reservation.receiptId, reservation.canonical);
        const current = statements.byId.get(reservation.receiptId) as ReceiptRow | undefined;
        if (current === undefined) throw new ExecutorReceiptConflictError('The reserved receipt is not in the ledger.');
        const stored = storedOf(current, executorId, audience);
        const same = stored.state === 'issued' && stored.canonical === reservation.canonical && JSON.stringify(stored.signature) === JSON.stringify(Object.fromEntries(SIGNATURE_FIELDS.map((field) => [field, signature[field]])));
        if (!same) throw new ExecutorReceiptConflictError('The receipt was issued with another signature.');
        return stored;
      });
      return issueInTransaction.immediate();
    },
    read(receiptId: string): StoredExecutorReceipt | undefined {
      ensureOpen();
      const row = statements.byId.get(receiptId) as ReceiptRow | undefined;
      return row === undefined ? undefined : storedOf(row, executorId, audience);
    },
    latest(capabilityId: string): StoredExecutorReceipt | undefined {
      ensureOpen();
      const rows = rowsOf(capabilityId);
      return rows[rows.length - 1];
    },
    history(capabilityId: string): readonly IssuedExecutorReceipt[] {
      ensureOpen();
      return Object.freeze(
        rowsOf(capabilityId)
          .filter((stored) => stored.state === 'issued' && stored.signature !== null)
          .map((stored) => Object.freeze({ receipt: stored.canonical, signature: stored.signature as Readonly<Record<string, string>> })),
      );
    },
    close(): void {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  return Object.freeze(ledger);
}
