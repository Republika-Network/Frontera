import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * FV-P4C-2A — a durable `StatusHighWaterMarkStore` on SQLite, for the
 * document-use freshness gate of `@aoc-enterprise/sovereign-receiver-verification`.
 *
 * The gate and its store contract live in that portable package, which has no
 * Node or database dependency. This module is the Node-side adapter. It
 * implements the contract structurally: the types below mirror the package's
 * `StatusHighWaterMark`, `StatusHighWaterMarkEntry` and `StatusHistoryKey`
 * field for field. The gate validates every entry it reads strictly, so any
 * drift is refused at run time (`HISTORY_STORE_INVALID`), and the FV-P4C-2A
 * end-to-end test runs the real gate on this store.
 *
 * ## What it guarantees
 *
 * - **Durability across restarts and connections.** One file is one receiver
 *   history namespace, pinned when it is created. Every write is one
 *   `BEGIN IMMEDIATE` transaction under `journal_mode = WAL` and
 *   `synchronous = FULL`, so connections and processes sharing the file
 *   serialize on it. A committed write survives a process crash.
 * - **Compare-and-set.** A write succeeds only when the stored revision is still
 *   `expectedRevision` (`null`: no row), checked and applied inside that one
 *   transaction. The revision then rises by exactly one. Two writers expecting
 *   the same revision can never both succeed, whatever process they are in.
 * - **No downgrade, enforced twice.** Independently of the gate, a write never:
 *   - lowers the sequence;
 *   - clears a withdrawal or a conflict latch;
 *   - drops a retired terms digest;
 *   - moves the time floor back.
 *
 *   The adapter refuses such a write, and the table's triggers refuse it again
 *   at the SQL level. Rows are never deleted.
 * - **Fail closed.** A row that does not validate, a schema that is not this
 *   one, missing triggers, a failed integrity check, or a missing row in a
 *   history that recorded one all throw, and the gate reports
 *   `HISTORY_STORE_UNAVAILABLE`. Corruption is never read as an empty history,
 *   and a missing file is never created implicitly.
 *
 * ## What it does not guarantee
 *
 * It is as trustworthy as the host that keeps the file. Whoever can replace,
 * restore or rewrite the whole file, including its bookkeeping, can make the
 * receiver forget statuses it saw:
 * - a deleted database looks like a fresh installation;
 * - a restored old copy looks like an older history.
 *
 * Neither is detectable here: that needs an external anchor (FV-P4C-2B). It
 * says nothing about statuses this receiver never saw, and nothing here is
 * authorization.
 */

export const SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION = 'frontera.sovereign-status-history.v1';

/** At most this many retired terms digests per history; a longer history is refused, never truncated. */
export const SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS = 1_024;

const MAX_ASSET_ID_LENGTH = 256;
const MAX_ISSUER_LENGTH = 2_048;
const MAX_NAMESPACE_LENGTH = 256;

/** Mirrors `StatusHistoryKey` in `@aoc-enterprise/sovereign-receiver-verification`. */
export interface SovereignStatusHistoryKey {
  readonly sovereignAssetId: string;
  readonly issuer: string;
}

/** Mirrors `StatusHighWaterMark` in `@aoc-enterprise/sovereign-receiver-verification`, field for field. */
export interface SovereignStatusHighWaterMark {
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly sequence: number;
  readonly statusDigest: string;
  readonly issuedAt: string;
  readonly currentTermsDigest: string | null;
  readonly timeFloor: string;
  readonly withdrawn: boolean;
  readonly retiredTermsDigests: readonly string[];
  readonly continuity: 'verified' | 'unproven';
  readonly conflict: boolean;
  readonly anchoredAt: string;
}

/** Mirrors `StatusHighWaterMarkEntry`. */
export interface SovereignStatusHighWaterMarkEntry {
  readonly revision: number;
  readonly mark: SovereignStatusHighWaterMark;
}

export interface SqliteStatusHighWaterMarkStoreOptions {
  /** The receiver history namespace this file holds, pinned at creation. Opening it under another is refused. */
  readonly namespace: string;
  /** Create a new, empty store. Refused if the file exists; never implied. */
  readonly create?: boolean;
  /** How long a write waits for a lock held by another connection before it fails. 0–60 000 ms, default 5 000. */
  readonly busyTimeoutMs?: number;
  /** Open for reading only: every `compareAndSet` throws. */
  readonly readOnly?: boolean;
}

/** The `StatusHighWaterMarkStore` contract, plus an explicit lifecycle. */
export interface SqliteStatusHighWaterMarkStore {
  read(key: SovereignStatusHistoryKey): Promise<SovereignStatusHighWaterMarkEntry | undefined>;
  compareAndSet(key: SovereignStatusHistoryKey, expectedRevision: number | null, next: SovereignStatusHighWaterMark): Promise<boolean>;
  /** The pinned namespace. */
  readonly namespace: string;
  close(): void;
}

/** Every failure of this store. The gate treats any throw as `HISTORY_STORE_UNAVAILABLE`. */
export class SovereignStatusHistoryStoreError extends Error {
  constructor(
    readonly code: 'OPEN_REFUSED' | 'INTEGRITY' | 'INVALID_WRITE' | 'DOWNGRADE' | 'READ_ONLY' | 'CLOSED' | 'DATABASE',
    message: string,
  ) {
    super(message);
    this.name = 'SovereignStatusHistoryStoreError';
  }
}

const SCHEMA = `
CREATE TABLE sovereign_status_history_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  namespace TEXT NOT NULL,
  created_rows INTEGER NOT NULL CHECK (created_rows >= 0)
) STRICT;
CREATE TABLE sovereign_status_history (
  sovereign_asset_id TEXT NOT NULL CHECK (length(sovereign_asset_id) BETWEEN 1 AND ${MAX_ASSET_ID_LENGTH}),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND ${MAX_ISSUER_LENGTH}),
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 9007199254740991),
  status_digest TEXT NOT NULL CHECK (length(status_digest) = 64 AND status_digest NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  current_terms_digest TEXT CHECK (current_terms_digest IS NULL OR (length(current_terms_digest) = 64 AND current_terms_digest NOT GLOB '*[^0-9a-f]*')),
  time_floor TEXT NOT NULL,
  withdrawn INTEGER NOT NULL CHECK (withdrawn IN (0, 1)),
  retired_terms_digests TEXT NOT NULL CHECK (json_valid(retired_terms_digests) AND json_type(retired_terms_digests) = 'array'),
  continuity TEXT NOT NULL CHECK (continuity IN ('verified', 'unproven')),
  conflict INTEGER NOT NULL CHECK (conflict IN (0, 1)),
  anchored_at TEXT NOT NULL,
  PRIMARY KEY (sovereign_asset_id, issuer)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER sovereign_status_history_meta_fixed BEFORE UPDATE ON sovereign_status_history_meta
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.namespace IS NOT OLD.namespace OR NEW.created_rows <> OLD.created_rows + 1
BEGIN SELECT RAISE(ABORT, 'the history identity is fixed and its row count only grows by one'); END;
CREATE TRIGGER sovereign_status_history_meta_never_deleted BEFORE DELETE ON sovereign_status_history_meta
BEGIN SELECT RAISE(ABORT, 'the history identity is permanent'); END;
CREATE TRIGGER sovereign_status_history_never_deleted BEFORE DELETE ON sovereign_status_history
BEGIN SELECT RAISE(ABORT, 'a trusted status history is never deleted'); END;
CREATE TRIGGER sovereign_status_history_forward_only BEFORE UPDATE ON sovereign_status_history
WHEN NOT (
  NEW.sovereign_asset_id = OLD.sovereign_asset_id
  AND NEW.issuer = OLD.issuer
  AND NEW.revision = OLD.revision + 1
  AND NEW.sequence >= OLD.sequence
  AND NEW.withdrawn >= OLD.withdrawn
  AND NEW.conflict >= OLD.conflict
  AND NOT EXISTS (
    SELECT 1 FROM json_each(OLD.retired_terms_digests) AS old
    WHERE old.value NOT IN (SELECT value FROM json_each(NEW.retired_terms_digests))
  )
)
BEGIN SELECT RAISE(ABORT, 'a trusted status history only moves forward'); END;
`;

const TRIGGERS: readonly string[] = [
  'sovereign_status_history_meta_fixed',
  'sovereign_status_history_meta_never_deleted',
  'sovereign_status_history_never_deleted',
  'sovereign_status_history_forward_only',
];
const TABLES: readonly string[] = ['sovereign_status_history', 'sovereign_status_history_meta'];

const COLUMNS =
  'sovereign_asset_id, issuer, revision, sequence, status_digest, issued_at, current_terms_digest, time_floor, withdrawn, retired_terms_digests, continuity, conflict, anchored_at';

/**
 * Opens the store at `path`, a file and never `:memory:`, because a history
 * that forgets at restart is the replay it exists to refuse.
 * - **Absent file:** refused unless `create: true`.
 * - **`create: true` over an existing file:** refused too, so a history is never
 *   re-initialized over itself.
 *
 * Creating the schema establishes no asset history: until the host
 * bootstraps an asset, the gate refuses it as `HISTORY_UNINITIALIZED`.
 * `path` must come from the host's trusted configuration, never from a request.
 */
export async function openSqliteStatusHighWaterMarkStore(path: string, options: SqliteStatusHighWaterMarkStoreOptions): Promise<SqliteStatusHighWaterMarkStore> {
  const refuse = (message: string): never => {
    throw new SovereignStatusHistoryStoreError('OPEN_REFUSED', `The sovereign status history ${message}`);
  };
  if (typeof path !== 'string' || path.trim() === '' || path.trim() === ':memory:' || path.includes('\0')) refuse('needs a durable file path.');
  if (typeof options !== 'object' || options === null) refuse('needs options.');
  const { namespace } = options;
  if (!isIdentifier(namespace) || namespace.length > MAX_NAMESPACE_LENGTH) refuse('needs exactly one namespace.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) refuse('busy timeout is out of bounds.');
  for (const flag of ['create', 'readOnly'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') refuse(`${flag} option is a boolean.`);
  }
  const create = options.create === true;
  const readOnly = options.readOnly === true;
  if (create && readOnly) refuse('cannot be created read-only.');
  const file = resolve(path);
  if (create && existsSync(file)) refuse('already exists at that path. A history is never re-initialized over itself.');
  if (!create && !existsSync(file)) refuse('does not exist at its configured path. It is never recreated implicitly: an empty history would forget every status it saw.');
  if (create && !existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  const { default: SqliteDatabase } = await import('better-sqlite3');
  let db: InstanceType<typeof SqliteDatabase>;
  try {
    db = new SqliteDatabase(file, create ? {} : { fileMustExist: true, readonly: readOnly });
  } catch {
    return refuse('could not be opened.');
  }
  try {
    // Before WAL: the journal-mode change itself must wait on a busy file rather than fail.
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (!create) {
      for (const table of TABLES) if (!objectExists(db, 'table', table)) refuse('file is not an initialized history; refusing to open it.');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') refuse('failed its integrity check; refusing to open it.');
      // Exactly this schema's triggers: missing ones would let history move backwards, extra ones could rewrite it.
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: unknown }>).map((row) => row.name);
      if (JSON.stringify(triggers) !== JSON.stringify([...TRIGGERS].sort())) refuse('does not carry exactly its integrity triggers; refusing to open it.');
    }
    if (!readOnly) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
    }
    if (create) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO sovereign_status_history_meta (id, schema_version, namespace, created_rows) VALUES (1, ?, ?, 0)').run(SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION, namespace);
      }).immediate();
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
    }
    const meta = db.prepare('SELECT schema_version, namespace FROM sovereign_status_history_meta WHERE id = 1').get() as { schema_version: unknown; namespace: unknown } | undefined;
    if (meta?.schema_version !== SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION) refuse('is recorded under another schema version; refusing to open it.');
    if (meta!.namespace !== namespace) refuse('is pinned to another namespace; refusing to open it.');
  } catch (error) {
    db.close();
    if (error instanceof SovereignStatusHistoryStoreError) throw error;
    return refuse('could not be opened.');
  }

  const selectRow = db.prepare(`SELECT ${COLUMNS} FROM sovereign_status_history WHERE sovereign_asset_id = ? AND issuer = ?`).safeIntegers(true);
  const selectCounts = db.prepare('SELECT (SELECT COUNT(*) FROM sovereign_status_history) AS rows_now, created_rows FROM sovereign_status_history_meta WHERE id = 1').safeIntegers(true);
  const insertRow = readOnly
    ? undefined
    : db.prepare(`INSERT INTO sovereign_status_history (${COLUMNS}) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const countRow = readOnly ? undefined : db.prepare('UPDATE sovereign_status_history_meta SET created_rows = created_rows + 1 WHERE id = 1');
  const updateRow = readOnly
    ? undefined
    : db.prepare(
        `UPDATE sovereign_status_history
         SET revision = revision + 1, sequence = ?, status_digest = ?, issued_at = ?, current_terms_digest = ?, time_floor = ?,
             withdrawn = ?, retired_terms_digests = ?, continuity = ?, conflict = ?, anchored_at = ?
         WHERE sovereign_asset_id = ? AND issuer = ? AND revision = ?`,
      );

  /** Reads one key; a row that does not validate, or a row the history recorded but no longer holds, throws. */
  const readEntry = (key: SovereignStatusHistoryKey): SovereignStatusHighWaterMarkEntry | undefined => {
    const row = selectRow.get(key.sovereignAssetId, key.issuer) as Record<string, unknown> | undefined;
    if (row !== undefined) return decodeRow(row, key);
    const counts = selectCounts.get() as { rows_now: unknown; created_rows: unknown } | undefined;
    if (counts === undefined || counts.rows_now !== counts.created_rows) {
      throw new SovereignStatusHistoryStoreError('INTEGRITY', 'The sovereign status history lost a row it recorded; refusing to treat it as uninitialized.');
    }
    return undefined;
  };

  const casTransaction = db.transaction((key: SovereignStatusHistoryKey, expectedRevision: number | null, next: SovereignStatusHighWaterMark): boolean => {
    const current = readEntry(key);
    if (expectedRevision === null) {
      if (current !== undefined) return false;
      insertRow!.run(...encodeMark(next));
      countRow!.run();
      return true;
    }
    if (current === undefined || current.revision !== expectedRevision) return false;
    assertForward(current.mark, next);
    const [, , ...fields] = encodeMark(next);
    const changes = updateRow!.run(...fields, key.sovereignAssetId, key.issuer, expectedRevision).changes;
    if (changes !== 1) throw new SovereignStatusHistoryStoreError('DATABASE', 'The sovereign status history update did not apply exactly once.');
    return true;
  });

  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new SovereignStatusHistoryStoreError('CLOSED', 'The sovereign status history is closed.');
  };
  const guarded = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof SovereignStatusHistoryStoreError) throw error;
      // SQLITE_BUSY after the busy timeout, I/O errors, a full disk, a trigger refusal: never a result.
      throw new SovereignStatusHistoryStoreError('DATABASE', 'The sovereign status history could not complete the operation.');
    }
  };

  return Object.freeze({
    namespace,
    async read(rawKey: SovereignStatusHistoryKey) {
      ensureOpen();
      const key = validateKey(rawKey);
      return guarded(() => readEntry(key));
    },
    async compareAndSet(rawKey: SovereignStatusHistoryKey, expectedRevision: number | null, rawNext: SovereignStatusHighWaterMark) {
      ensureOpen();
      if (readOnly) throw new SovereignStatusHistoryStoreError('READ_ONLY', 'The sovereign status history is open read-only.');
      const key = validateKey(rawKey);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
        throw new SovereignStatusHistoryStoreError('INVALID_WRITE', 'The expected revision is not a revision.');
      }
      const next = validateMark(rawNext, 'INVALID_WRITE');
      if (next.sovereignAssetId !== key.sovereignAssetId || next.issuer !== key.issuer) {
        throw new SovereignStatusHistoryStoreError('INVALID_WRITE', 'The mark does not belong to that history.');
      }
      // One IMMEDIATE transaction: the write lock is taken before the revision is read.
      return guarded(() => casTransaction.immediate(key, expectedRevision, next));
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
 * The store's own no-downgrade rules, independent of the gate's state machine:
 * the facts a trusted history has learned never go away. Continuity is the
 * gate's to judge (a trusted re-anchor may restore it after a gap).
 */
function assertForward(current: SovereignStatusHighWaterMark, next: SovereignStatusHighWaterMark): void {
  const downgrade = (what: string): never => {
    throw new SovereignStatusHistoryStoreError('DOWNGRADE', `Refused: the write would ${what}.`);
  };
  if (next.sequence < current.sequence) downgrade('lower the sequence');
  if (current.withdrawn && !next.withdrawn) downgrade('reopen a withdrawal');
  if (current.conflict && !next.conflict) downgrade('clear a latched conflict');
  for (const digest of current.retiredTermsDigests) if (!next.retiredTermsDigests.includes(digest)) downgrade('forget a retired terms digest');
  if (instant(next.timeFloor)! < instant(current.timeFloor)!) downgrade('move the time floor back');
}

function encodeMark(mark: SovereignStatusHighWaterMark): Array<string | number | null> {
  return [
    mark.sovereignAssetId,
    mark.issuer,
    mark.sequence,
    mark.statusDigest,
    mark.issuedAt,
    mark.currentTermsDigest,
    mark.timeFloor,
    mark.withdrawn ? 1 : 0,
    JSON.stringify(mark.retiredTermsDigests),
    mark.continuity,
    mark.conflict ? 1 : 0,
    mark.anchoredAt,
  ];
}

function decodeRow(row: Record<string, unknown>, key: SovereignStatusHistoryKey): SovereignStatusHighWaterMarkEntry {
  const corrupt = (): never => {
    throw new SovereignStatusHistoryStoreError('INTEGRITY', 'A sovereign status history row does not validate; refusing it.');
  };
  const integer = (value: unknown): number => {
    if (typeof value !== 'bigint' || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) return corrupt();
    return Number(value);
  };
  const flag = (value: unknown): boolean => (value === 0n ? false : value === 1n ? true : corrupt());
  let retired: unknown;
  try {
    retired = JSON.parse(row['retired_terms_digests'] as string);
  } catch {
    return corrupt();
  }
  const candidate = {
    sovereignAssetId: row['sovereign_asset_id'],
    issuer: row['issuer'],
    sequence: integer(row['sequence']),
    statusDigest: row['status_digest'],
    issuedAt: row['issued_at'],
    currentTermsDigest: row['current_terms_digest'],
    timeFloor: row['time_floor'],
    withdrawn: flag(row['withdrawn']),
    retiredTermsDigests: retired,
    continuity: row['continuity'],
    conflict: flag(row['conflict']),
    anchoredAt: row['anchored_at'],
  };
  let mark: SovereignStatusHighWaterMark;
  try {
    mark = validateMark(candidate, 'INTEGRITY');
  } catch {
    return corrupt();
  }
  if (mark.sovereignAssetId !== key.sovereignAssetId || mark.issuer !== key.issuer) corrupt();
  return deepFreeze({ revision: integer(row['revision']), mark });
}

const MARK_KEYS = [
  'sovereignAssetId',
  'issuer',
  'sequence',
  'statusDigest',
  'issuedAt',
  'currentTermsDigest',
  'timeFloor',
  'withdrawn',
  'retiredTermsDigests',
  'continuity',
  'conflict',
  'anchoredAt',
] as const;

/** The same rules the gate applies to a stored mark, applied here on the way in and on the way out. */
function validateMark(value: unknown, code: 'INVALID_WRITE' | 'INTEGRITY'): SovereignStatusHighWaterMark {
  const invalid = (): never => {
    throw new SovereignStatusHistoryStoreError(code, 'The status history mark is not well formed.');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...MARK_KEYS].sort())) invalid();
  for (const key of MARK_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor)) invalid();
  }
  const { sovereignAssetId, issuer, sequence, statusDigest, issuedAt, currentTermsDigest, timeFloor, withdrawn, retiredTermsDigests, continuity, conflict, anchoredAt } = record;
  if (!isIdentifier(sovereignAssetId) || sovereignAssetId.length > MAX_ASSET_ID_LENGTH) invalid();
  if (!isIdentifier(issuer) || issuer.length > MAX_ISSUER_LENGTH) invalid();
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) invalid();
  if (!isDigest(statusDigest) || (currentTermsDigest !== null && !isDigest(currentTermsDigest))) invalid();
  for (const time of [issuedAt, timeFloor, anchoredAt]) if (instant(time) === undefined) invalid();
  if (instant(timeFloor)! < instant(issuedAt)!) invalid();
  if (typeof withdrawn !== 'boolean' || typeof conflict !== 'boolean') invalid();
  if (continuity !== 'verified' && continuity !== 'unproven') invalid();
  if (!Array.isArray(retiredTermsDigests) || retiredTermsDigests.length > SOVEREIGN_STATUS_HISTORY_MAX_RETIRED_TERMS || !retiredTermsDigests.every(isDigest)) invalid();
  const retired = retiredTermsDigests as string[];
  for (let index = 1; index < retired.length; index += 1) if (!(retired[index - 1]! < retired[index]!)) invalid();
  return {
    sovereignAssetId: sovereignAssetId as string,
    issuer: issuer as string,
    sequence: sequence as number,
    statusDigest: statusDigest as string,
    issuedAt: issuedAt as string,
    currentTermsDigest: currentTermsDigest as string | null,
    timeFloor: timeFloor as string,
    withdrawn: withdrawn as boolean,
    retiredTermsDigests: [...retired],
    continuity: continuity as 'verified' | 'unproven',
    conflict: conflict as boolean,
    anchoredAt: anchoredAt as string,
  };
}

function validateKey(value: unknown): SovereignStatusHistoryKey {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const sovereignAssetId = record?.['sovereignAssetId'];
  const issuer = record?.['issuer'];
  if (!isIdentifier(sovereignAssetId) || sovereignAssetId.length > MAX_ASSET_ID_LENGTH || !isIdentifier(issuer) || issuer.length > MAX_ISSUER_LENGTH) {
    throw new SovereignStatusHistoryStoreError('INVALID_WRITE', 'The status history key is not well formed.');
  }
  return { sovereignAssetId, issuer };
}

function objectExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, type: string, name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * A canonical UTC timestamp (`aoc-canonical-json/1`) as nanoseconds since the
 * epoch, or `undefined`. The same rules as the receiver package's: calendar
 * arithmetic, no Date, no millisecond rounding.
 */
function instant(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day < 1 || day > days) return undefined;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const civil = era * 146_097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719_468;
  const seconds = BigInt(civil) * 86_400n + BigInt(hour * 3600 + minute * 60 + second);
  return seconds * 1_000_000_000n + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
