import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { canonicalInstant, isDigest, isIdentifier } from './bootstrap-contract.js';
import { exclusiveCloser, exclusivitySupported } from './executor-exclusivity.js';
import { readHistoryContinuityRecord } from './history-continuity.js';
import type { BootstrapIntent, HistoryContinuityRecord } from './history-continuity.js';
import type { HistoryContinuityRecordPort } from './host-inventory.js';

/**
 * FV-P4C-2B3B — the protected, durable store of continuity records and bootstrap intents (not
 * composed into the running Host).
 *
 * It implements B3A's `HistoryContinuityRecordPort` over one SQLite file that the FV executor owns:
 * - **Durable before success.** WAL with `synchronous = FULL`: every write transaction's WAL frame is
 *   synced before it returns. A method that returns has committed durably.
 * - **Atomic.** Each record save and each intent transition is one `IMMEDIATE` transaction.
 * - **Exclusive.** Opened with `locking_mode = EXCLUSIVE` and its lock taken at once. That lock *is*
 *   the executor's authority: a second Host cannot open the store (`EXECUTOR_HELD`) while this one
 *   lives (`executor-exclusivity.ts`). Each acquisition durably increments the store's **epoch**,
 *   and every intent records the epoch that began it.
 * - **Fenced.** `beforeWrite` runs synchronously before every write transaction (the composition's
 *   cross-process lock check). If it throws, nothing is written.
 * - **Never implicit.** An absent file is never created unless `create: true`, and `create` over an
 *   existing file is refused. No record is reset, no intent is cleared, nothing is restored.
 * - **Validated.** At open: SQLite's `quick_check`, exactly this schema's tables and triggers, its
 *   schema version. Each row is validated again whenever it is read. A malformed record is returned as
 *   stored, so the continuity assessment classifies it `RECORD_INVALID`; a malformed intent row
 *   throws, which fails closed (the namespace is `UNAVAILABLE`).
 *
 * **Intents are never deleted.** `beginIntent` inserts a `pending` row. `completeIntent` moves it to
 * `completed`, exactly once. Triggers forbid deleting either table's rows, re-opening a completed
 * intent, or changing an intent's identity. A record row may only be replaced by a valid record of
 * the same namespace.
 *
 * **Ambiguous outcomes.** A write that throws may still have reached the disk (an I/O error at sync).
 * Callers treat a throw as "maybe written": a failed `beginIntent` refuses the consumption, and the
 * possibly-pending intent then quarantines its namespace; a failed `completeIntent` leaves it
 * pending. Neither ever fabricates an outcome.
 */

export const PROTECTED_CONTINUITY_STORE_SCHEMA = 'frontera.fv-protected-continuity-store/1' as const;

export class ProtectedContinuityStoreError extends Error {
  constructor(
    readonly code: 'OPEN_REFUSED' | 'EXECUTOR_HELD' | 'INTEGRITY' | 'INVALID_WRITE' | 'CONFLICT' | 'CLOSED' | 'DATABASE' | 'FENCED',
    message: string,
  ) {
    super(message);
    this.name = 'ProtectedContinuityStoreError';
  }
}

export interface ProtectedContinuityStoreOptions {
  /** Create a new, empty store. Refused if the file exists; never implied. */
  readonly create?: boolean;
  /** The Host's trusted clock, as a canonical UTC instant (recorded, never used for authority). */
  readonly now: () => string;
  /** The write fence, called synchronously immediately before every write transaction. */
  readonly beforeWrite?: () => void;
}

export interface ProtectedContinuityStore extends HistoryContinuityRecordPort {
  /** This acquisition's epoch: strictly greater than every earlier one of this store. */
  readonly epoch: number;
  /** The resolved path of the store file. */
  readonly path: string;
  /** Every intent, pending or completed, for operators. */
  intentLog(namespace: string): readonly { readonly requestId: string; readonly bindingDigest: string; readonly state: 'pending' | 'completed'; readonly epoch: number; readonly begunAt: string; readonly completedAt: string | null }[];
  close(): void;
}

const TABLES = ['fv_protected_meta', 'fv_continuity_records', 'fv_bootstrap_intents'] as const;
const TRIGGERS = [
  'fv_continuity_records_no_delete',
  'fv_continuity_records_same_namespace',
  'fv_bootstrap_intents_no_delete',
  'fv_bootstrap_intents_identity_fixed',
  'fv_bootstrap_intents_complete_once',
  'fv_protected_meta_no_delete',
  'fv_protected_meta_epoch_monotonic',
] as const;

const SCHEMA = `
CREATE TABLE fv_protected_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE fv_continuity_records (
  namespace TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  saved_epoch INTEGER NOT NULL
) STRICT;
CREATE TABLE fv_bootstrap_intents (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  epoch INTEGER NOT NULL,
  begun_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (namespace, request_id),
  CHECK ((state = 'pending') = (completed_at IS NULL))
) STRICT;
CREATE TRIGGER fv_continuity_records_no_delete BEFORE DELETE ON fv_continuity_records BEGIN SELECT RAISE(ABORT, 'continuity records are never deleted'); END;
CREATE TRIGGER fv_continuity_records_same_namespace BEFORE UPDATE OF namespace ON fv_continuity_records BEGIN SELECT RAISE(ABORT, 'a record keeps its namespace'); END;
CREATE TRIGGER fv_bootstrap_intents_no_delete BEFORE DELETE ON fv_bootstrap_intents BEGIN SELECT RAISE(ABORT, 'bootstrap intents are never deleted'); END;
CREATE TRIGGER fv_bootstrap_intents_identity_fixed BEFORE UPDATE OF namespace, request_id, binding_digest, epoch, begun_at ON fv_bootstrap_intents BEGIN SELECT RAISE(ABORT, 'an intent keeps its identity'); END;
CREATE TRIGGER fv_bootstrap_intents_complete_once BEFORE UPDATE OF state, completed_at ON fv_bootstrap_intents WHEN OLD.state <> 'pending' OR NEW.state <> 'completed' BEGIN SELECT RAISE(ABORT, 'an intent is completed once, from pending'); END;
CREATE TRIGGER fv_protected_meta_no_delete BEFORE DELETE ON fv_protected_meta BEGIN SELECT RAISE(ABORT, 'the store meta is never deleted'); END;
CREATE TRIGGER fv_protected_meta_epoch_monotonic BEFORE UPDATE ON fv_protected_meta WHEN NEW.epoch <= OLD.epoch OR NEW.schema_version <> OLD.schema_version OR NEW.created_at <> OLD.created_at BEGIN SELECT RAISE(ABORT, 'the epoch only increases'); END;
`;

const MAX_REQUEST_ID_LENGTH = 512;

export async function openProtectedContinuityStore(path: string, options: ProtectedContinuityStoreOptions): Promise<ProtectedContinuityStore> {
  const refuse = (message: string, code: 'OPEN_REFUSED' | 'EXECUTOR_HELD' = 'OPEN_REFUSED'): never => {
    throw new ProtectedContinuityStoreError(code, `The FV protected continuity store ${message}`);
  };
  if (typeof path !== 'string' || path.trim() === '' || path.trim() === ':memory:' || path.includes('\0')) refuse('needs a durable file path.');
  if (typeof options !== 'object' || options === null || typeof options.now !== 'function') refuse('needs the Host clock.');
  if (options.create !== undefined && typeof options.create !== 'boolean') refuse('create option is a boolean.');
  if (options.beforeWrite !== undefined && typeof options.beforeWrite !== 'function') refuse('write fence is a function.');
  const { now, beforeWrite } = options;
  const create = options.create === true;
  const file = resolve(path);
  if (create && existsSync(file)) refuse('already exists at that path. It is never re-initialized over itself.');
  if (!create && !existsSync(file)) refuse('does not exist at its configured path. It is never recreated implicitly: an empty store would forget every pending intent.');
  const instant = (): string => {
    const at = now();
    if (canonicalInstant(at) === undefined) throw new ProtectedContinuityStoreError('INVALID_WRITE', 'The Host clock did not give a canonical instant.');
    return at;
  };

  if (!exclusivitySupported()) refuse('cannot be held exclusively here (Linux /proc/self/fdinfo of this process’s own /proc, main thread only).');
  const { default: SqliteDatabase } = await import('better-sqlite3');
  let db: InstanceType<typeof SqliteDatabase>;
  // Review R2-L: once the exclusive lock is taken, every close goes through the guarded closer.
  let closeHeld: (() => void) | undefined;
  try {
    db = new SqliteDatabase(file, create ? {} : { fileMustExist: true });
  } catch {
    return refuse('could not be opened.');
  }
  let epoch: number;
  try {
    db.pragma('busy_timeout = 0');
    // Before the first access: no shared-memory index, and every lock taken is kept until close.
    db.pragma('locking_mode = EXCLUSIVE');
    if (create) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort; the composition's filesystem policy refuses a file writable by others.
      }
      db.pragma('journal_mode = WAL');
    } else {
      let mode: unknown;
      try {
        mode = db.pragma('journal_mode', { simple: true });
      } catch {
        refuse('is held by another executor.', 'EXECUTOR_HELD');
      }
      if (mode !== 'wal') refuse('is not in WAL mode; refusing to open it.');
    }
    db.pragma('synchronous = FULL');
    try {
      db.exec('BEGIN EXCLUSIVE');
      db.exec('COMMIT');
    } catch {
      refuse('is held by another executor.', 'EXECUTOR_HELD');
    }
    closeHeld = exclusiveCloser(file, db);
    if (create) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO fv_protected_meta (id, schema_version, epoch, created_at) VALUES (1, ?, 0, ?)').run(PROTECTED_CONTINUITY_STORE_SCHEMA, instant());
      }).immediate();
    } else {
      const has = (type: string, name: string) => db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined;
      for (const table of TABLES) if (!has('table', table)) refuse('file is not an initialized protected store; refusing to open it.');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') refuse('failed its integrity check; refusing to open it.');
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: unknown }>).map((row) => row.name);
      if (JSON.stringify(triggers) !== JSON.stringify([...TRIGGERS].sort())) refuse('does not carry exactly its integrity triggers; refusing to open it.');
    }
    const meta = db.prepare('SELECT schema_version, epoch FROM fv_protected_meta WHERE id = 1').safeIntegers(true).get() as { schema_version: unknown; epoch: unknown } | undefined;
    if (meta?.schema_version !== PROTECTED_CONTINUITY_STORE_SCHEMA) refuse('is recorded under another schema version; refusing to open it.');
    if (typeof meta!.epoch !== 'bigint' || meta!.epoch < 0n || meta!.epoch >= BigInt(Number.MAX_SAFE_INTEGER)) refuse('records an invalid epoch; refusing to open it.');
    // This acquisition's epoch, durable before the store is handed out (fenced like every write).
    beforeWrite?.();
    epoch = Number(meta!.epoch) + 1;
    db.prepare('UPDATE fv_protected_meta SET epoch = ? WHERE id = 1').run(epoch);
  } catch (error) {
    if (closeHeld !== undefined) closeHeld();
    else db.close();
    if (error instanceof ProtectedContinuityStoreError) throw error;
    return refuse('could not be opened.');
  }

  const selectRecord = db.prepare('SELECT record FROM fv_continuity_records WHERE namespace = ?');
  const upsertRecord = db.prepare(
    'INSERT INTO fv_continuity_records (namespace, record, saved_at, saved_epoch) VALUES (?, ?, ?, ?) ON CONFLICT (namespace) DO UPDATE SET record = excluded.record, saved_at = excluded.saved_at, saved_epoch = excluded.saved_epoch',
  );
  const selectIntents = db.prepare('SELECT request_id, binding_digest, state, epoch, begun_at, completed_at FROM fv_bootstrap_intents WHERE namespace = ? ORDER BY begun_at, request_id').safeIntegers(true);
  const selectIntent = db.prepare('SELECT binding_digest, state FROM fv_bootstrap_intents WHERE namespace = ? AND request_id = ?');
  const insertIntent = db.prepare("INSERT INTO fv_bootstrap_intents (namespace, request_id, binding_digest, state, epoch, begun_at, completed_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL)");
  const completeIntentRow = db.prepare("UPDATE fv_bootstrap_intents SET state = 'completed', completed_at = ? WHERE namespace = ? AND request_id = ? AND state = 'pending'");

  let closed = false;
  // Release review C1: closed only while this process holds its lock; otherwise retained, never closed.
  const closeConnection = closeHeld!;
  const ensureOpen = (): void => {
    if (closed) throw new ProtectedContinuityStoreError('CLOSED', 'The FV protected continuity store is closed.');
  };
  const fence = (): void => {
    if (beforeWrite === undefined) return;
    try {
      beforeWrite();
    } catch {
      throw new ProtectedContinuityStoreError('FENCED', 'Refused: this process no longer holds exclusive execution of the protected store.');
    }
  };
  const guarded = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof ProtectedContinuityStoreError) throw error;
      throw new ProtectedContinuityStoreError('DATABASE', 'The FV protected continuity store could not complete the operation.');
    }
  };
  const namespaceOf = (namespace: unknown): string => {
    if (!isIdentifier(namespace, 256)) throw new ProtectedContinuityStoreError('INVALID_WRITE', 'A namespace is a non-empty identifier.');
    return namespace;
  };
  const readIntentRows = (namespace: string) =>
    (selectIntents.all(namespace) as Array<Record<string, unknown>>).map((row) => {
      const { request_id: requestId, binding_digest: bindingDigest, state, epoch: rowEpoch, begun_at: begunAt, completed_at: completedAt } = row;
      if (
        !isIdentifier(requestId, MAX_REQUEST_ID_LENGTH)
        || !isDigest(bindingDigest)
        || (state !== 'pending' && state !== 'completed')
        || typeof rowEpoch !== 'bigint'
        || rowEpoch < 1n
        || rowEpoch > BigInt(epoch)
        || canonicalInstant(begunAt) === undefined
        || (state === 'pending' ? completedAt !== null : canonicalInstant(completedAt) === undefined)
      ) {
        throw new ProtectedContinuityStoreError('INTEGRITY', 'A bootstrap intent row does not validate; refusing the store.');
      }
      return Object.freeze({ requestId: requestId as string, bindingDigest: bindingDigest as string, state: state as 'pending' | 'completed', epoch: Number(rowEpoch), begunAt: begunAt as string, completedAt: (completedAt ?? null) as string | null });
    });

  const store: ProtectedContinuityStore = Object.freeze({
    epoch,
    path: file,
    load(namespace: string): unknown {
      ensureOpen();
      const ns = namespaceOf(namespace);
      return guarded(() => {
        const row = selectRecord.get(ns) as { record: unknown } | undefined;
        if (row === undefined) return undefined;
        if (typeof row.record !== 'string') return null;
        try {
          return JSON.parse(row.record) as unknown;
        } catch {
          // Stored but unreadable: the assessment classifies it RECORD_INVALID, never UNREGISTERED.
          return null;
        }
      });
    },
    save(record: HistoryContinuityRecord): void {
      ensureOpen();
      const valid = readHistoryContinuityRecord(record);
      if (valid === undefined) throw new ProtectedContinuityStoreError('INVALID_WRITE', 'Only a well-formed, self-consistent continuity record is saved.');
      const at = instant();
      fence();
      guarded(() => db.transaction(() => void upsertRecord.run(valid.namespace, JSON.stringify(valid), at, epoch)).immediate());
    },
    pendingIntents(namespace: string): readonly BootstrapIntent[] {
      ensureOpen();
      const ns = namespaceOf(namespace);
      return guarded(() => Object.freeze(readIntentRows(ns).filter((row) => row.state === 'pending').map((row) => Object.freeze({ requestId: row.requestId, bindingDigest: row.bindingDigest }))));
    },
    beginIntent(namespace: string, intent: BootstrapIntent): void {
      ensureOpen();
      const ns = namespaceOf(namespace);
      const { requestId, bindingDigest } = (intent ?? {}) as Partial<BootstrapIntent>;
      if (!isIdentifier(requestId, MAX_REQUEST_ID_LENGTH) || !isDigest(bindingDigest)) throw new ProtectedContinuityStoreError('INVALID_WRITE', 'An intent names one request id and its binding digest.');
      const at = instant();
      fence();
      guarded(() =>
        db
          .transaction(() => {
            const existing = selectIntent.get(ns, requestId) as { binding_digest: unknown; state: unknown } | undefined;
            if (existing !== undefined) {
              // The same pending intent again is the same fact; anything else is a conflict, never overwritten.
              if (existing.binding_digest === bindingDigest && existing.state === 'pending') return;
              throw new ProtectedContinuityStoreError('CONFLICT', 'That request id already has an intent under another binding or state.');
            }
            insertIntent.run(ns, requestId, bindingDigest, epoch, at);
          })
          .immediate(),
      );
    },
    completeIntent(namespace: string, requestId: string): void {
      ensureOpen();
      const ns = namespaceOf(namespace);
      if (!isIdentifier(requestId, MAX_REQUEST_ID_LENGTH)) throw new ProtectedContinuityStoreError('INVALID_WRITE', 'A request id is a non-empty identifier.');
      const at = instant();
      fence();
      guarded(() =>
        db
          .transaction(() => {
            const changed = completeIntentRow.run(at, ns, requestId).changes;
            if (changed !== 1) throw new ProtectedContinuityStoreError('CONFLICT', 'No pending intent with that request id.');
          })
          .immediate(),
      );
    },
    intentLog(namespace: string) {
      ensureOpen();
      const ns = namespaceOf(namespace);
      return guarded(() => Object.freeze(readIntentRows(ns)));
    },
    close(): void {
      if (!closed) {
        closed = true;
        closeConnection();
      }
    },
  });
  return store;
}
