import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { executionCapabilityGrantReferenceV2, isExecutionCapabilityGrantReferenceNonce } from '../authority-authenticity/execution-capability-issuance.js';
import { isWellFormedAuthoritySignature } from '../authority-authenticity/signature-envelope.js';
import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { isExecutionCapabilityIdentifier, isWellFormedExecutionCapability, parseExecutionCapability, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/capability.js';

/**
 * G-02B — the Host's **durable execution-capability issuance ledger**: one row
 * per execution a capability was ever reserved for, written **before** the
 * custody boundary is asked to sign. Its own SQLite file and its own schema;
 * no existing store or schema is touched.
 *
 * ## What one row means
 *
 * The full canonical capability text — every field, including its random id,
 * its window and its grant reference — is committed in the reservation, with
 * the grant identity and the grant-reference nonce it was derived from. The
 * custody boundary is asked only after that commit, and only for exactly that
 * text. So a capability id that may exist outside this process always has a
 * row here, and there is never a second identity for one execution:
 *
 * ```
 * reserved ──signature returned and verified locally──▶ issued
 *    └───────custody call failed, timed out or returned an unverifiable answer──▶ uncertain
 * ```
 *
 * - `reserved` with no settlement is **outcome unknown**: the process stopped
 *   (or is still waiting) after the reservation; custody may or may not have
 *   signed. It is never re-reserved, re-signed or replaced.
 * - `uncertain` is **possibly signed**: custody was asked and no verified
 *   signature was committed. Terminal.
 * - `issued` is **signed and committed**: a signature that verified locally
 *   under the active key is stored with the row. Terminal.
 * - No row is **never requested**: every refusal before the reservation
 *   commits leaves nothing here, and custody was never asked.
 *
 * `execution_id` is the primary key (one capability per execution) and
 * `capability_id` and the nonce are unique. Triggers refuse a row inserted in
 * any state but `reserved`, any change to its identity or text, any backward
 * or sideways move, and any delete. Every read re-derives the row's
 * consistency — canonical text, digest, ids, audience, issuer and grant
 * reference — and refuses a row that does not hold together.
 *
 * ## What it is not
 *
 * As trustworthy as the host that keeps it. The triggers stop an ordinary
 * `UPDATE` or `DELETE`; a raw writer can still rewrite the file, and a
 * restored older copy simply does not contain later reservations — the Host
 * would then reserve, and custody would sign, a second capability for an
 * execution that already has one. The ledger is **not anchored against
 * rollback** (G-02B D7): it is the reference issuance record, not a global
 * uniqueness guarantee. A missing file is never an empty ledger: it is created
 * only by an explicit `create: true`, which refuses any existing file.
 */

export const EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION = 'frontera.execution-capability-issuance-ledger.v1';

export const EXECUTION_CAPABILITY_ISSUANCE_STATES = Object.freeze(['reserved', 'issued', 'uncertain'] as const);
export type ExecutionCapabilityIssuanceState = (typeof EXECUTION_CAPABILITY_ISSUANCE_STATES)[number];

/** What the Host commits before it asks custody: the exact capability, and the grant identity and nonce its reference was derived from. */
export interface ExecutionCapabilityReservation {
  readonly capability: ExecutionCapability;
  readonly boundedGrantId: string;
  readonly grantStoreId: string;
  readonly grantDigest: string;
  readonly grantReferenceNonce: string;
}

export type ExecutionCapabilityIssuanceRecord =
  | { readonly state: 'absent' }
  | {
      readonly state: ExecutionCapabilityIssuanceState;
      readonly executionId: string;
      readonly capabilityId: string;
      readonly audience: string;
      readonly boundedGrantId: string;
      readonly grantStoreId: string;
      readonly grantDigest: string;
      /** Host-internal evidence: recomputes `capability.grantReference` from the grant identity. Never part of the capability. */
      readonly grantReferenceNonce: string;
      readonly capability: ExecutionCapability;
      /** The canonical text custody was (or was to be) asked to sign. */
      readonly canonical: string;
      readonly reservedAt: string;
      readonly settledAt?: string;
      /** Present exactly when `issued`. */
      readonly signature?: AuthoritySignature;
    };

export type ExecutionCapabilityReserveOutcome =
  | { readonly outcome: 'reserved'; readonly reservedAt: string }
  /** The execution already has a row — in whatever state. Nothing was written. */
  | { readonly outcome: 'exists'; readonly record: Exclude<ExecutionCapabilityIssuanceRecord, { readonly state: 'absent' }> };

export interface ExecutionCapabilityIssuanceLedger {
  /** The issuer every row is recorded for. Pinned at creation. */
  readonly issuer: string;
  /** Commits the reservation durably, or reports the execution's existing row. */
  reserve(reservation: ExecutionCapabilityReservation): ExecutionCapabilityReserveOutcome;
  /** `reserved` → `issued`, with the locally verified signature. */
  markIssued(executionId: string, capabilityId: string, signature: AuthoritySignature): 'issued' | 'not-reserved';
  /** `reserved` → `uncertain`. */
  markUncertain(executionId: string, capabilityId: string): 'uncertain' | 'not-reserved';
  read(executionId: string): ExecutionCapabilityIssuanceRecord;
  readCapability(capabilityId: string): ExecutionCapabilityIssuanceRecord;
  close(): void;
}

export interface ExecutionCapabilityIssuanceLedgerOptions {
  /** The deployment issuer. Recorded at creation; a ledger recorded for another issuer is refused. */
  readonly issuer: string;
  /** Wall clock, ms since the epoch: reservation and settlement instants. */
  readonly clock: () => number;
  /** `true` only to initialize a **new** ledger. Refused over an existing file. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_capability_issuance_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  issuer TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_capability_issuances (
  execution_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL UNIQUE,
  grant_reference_nonce TEXT NOT NULL UNIQUE,
  bounded_grant_id TEXT NOT NULL,
  grant_store_id TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  audience TEXT NOT NULL,
  capability_text TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'issued', 'uncertain')),
  signature TEXT,
  settled_at TEXT,
  CHECK ((state = 'issued') = (signature IS NOT NULL)),
  CHECK ((state = 'reserved') = (settled_at IS NULL))
);
CREATE TRIGGER IF NOT EXISTS execution_capability_issuance_meta_fixed_update BEFORE UPDATE ON execution_capability_issuance_meta
BEGIN SELECT RAISE(ABORT, 'the issuance ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_issuance_meta_fixed_delete BEFORE DELETE ON execution_capability_issuance_meta
BEGIN SELECT RAISE(ABORT, 'the issuance ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_issuances_reserved_first BEFORE INSERT ON execution_capability_issuances
WHEN NEW.state IS NOT 'reserved' OR NEW.signature IS NOT NULL OR NEW.settled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an issuance is reserved before custody is asked'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_issuances_never_deleted BEFORE DELETE ON execution_capability_issuances
BEGIN SELECT RAISE(ABORT, 'an issuance record is permanent'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_issuances_forward_only BEFORE UPDATE ON execution_capability_issuances
WHEN NOT (OLD.state = 'reserved' AND NEW.state IN ('issued', 'uncertain'))
  OR NEW.execution_id IS NOT OLD.execution_id OR NEW.capability_id IS NOT OLD.capability_id
  OR NEW.grant_reference_nonce IS NOT OLD.grant_reference_nonce OR NEW.bounded_grant_id IS NOT OLD.bounded_grant_id
  OR NEW.grant_store_id IS NOT OLD.grant_store_id OR NEW.grant_digest IS NOT OLD.grant_digest
  OR NEW.audience IS NOT OLD.audience OR NEW.capability_text IS NOT OLD.capability_text
  OR NEW.capability_digest IS NOT OLD.capability_digest OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT, 'an issuance record only moves forward'); END;
`;

const LEDGER_TRIGGERS: readonly string[] = [
  'execution_capability_issuance_meta_fixed_update',
  'execution_capability_issuance_meta_fixed_delete',
  'execution_capability_issuances_reserved_first',
  'execution_capability_issuances_never_deleted',
  'execution_capability_issuances_forward_only',
];

const COLUMNS =
  'execution_id, capability_id, grant_reference_nonce, bounded_grant_id, grant_store_id, grant_digest, audience, capability_text, capability_digest, reserved_at, state, signature, settled_at';

interface IssuanceRow {
  readonly execution_id: unknown;
  readonly capability_id: unknown;
  readonly grant_reference_nonce: unknown;
  readonly bounded_grant_id: unknown;
  readonly grant_store_id: unknown;
  readonly grant_digest: unknown;
  readonly audience: unknown;
  readonly capability_text: unknown;
  readonly capability_digest: unknown;
  readonly reserved_at: unknown;
  readonly state: unknown;
  readonly signature: unknown;
  readonly settled_at: unknown;
}

type Database = import('better-sqlite3').Database;

function tableExists(db: Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function textDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function instantOf(ms: number): string {
  return new Date(ms).toISOString();
}

class MalformedIssuanceRow extends Error {
  constructor() {
    super('The execution capability issuance ledger holds a row that does not hold together; refusing to answer from it.');
    this.name = 'MalformedIssuanceRow';
  }
}

function signatureOf(value: unknown): AuthoritySignature | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isWellFormedAuthoritySignature(parsed)) return undefined;
  const envelope = parsed as AuthoritySignature;
  return Object.freeze({ algorithm: envelope.algorithm, keyId: envelope.keyId, signature: envelope.signature, artifactVersion: envelope.artifactVersion });
}

/** A row, re-derived: every column must agree with the canonical text it holds and the grant reference must recompute. Throws on the first disagreement. */
function recordOf(row: IssuanceRow | undefined, issuer: string): ExecutionCapabilityIssuanceRecord {
  if (row === undefined) return Object.freeze({ state: 'absent' as const });
  const { execution_id: executionId, capability_id: capabilityId, grant_reference_nonce: nonce, bounded_grant_id: boundedGrantId, grant_store_id: grantStoreId, grant_digest: grantDigest, audience, capability_text: canonical, reserved_at: reservedAt, state, settled_at: settledAt } = row;
  if (
    typeof executionId !== 'string' ||
    typeof capabilityId !== 'string' ||
    !isExecutionCapabilityGrantReferenceNonce(nonce) ||
    typeof boundedGrantId !== 'string' ||
    typeof grantStoreId !== 'string' ||
    typeof grantDigest !== 'string' ||
    typeof audience !== 'string' ||
    typeof canonical !== 'string' ||
    typeof reservedAt !== 'string' ||
    !(EXECUTION_CAPABILITY_ISSUANCE_STATES as readonly unknown[]).includes(state) ||
    (settledAt !== null && typeof settledAt !== 'string')
  ) {
    throw new MalformedIssuanceRow();
  }
  if (row.capability_digest !== textDigest(canonical)) throw new MalformedIssuanceRow();
  const parsed = parseExecutionCapability(canonical);
  if (!parsed.ok) throw new MalformedIssuanceRow();
  const capability = parsed.capability;
  if (capability.executionId !== executionId || capability.capabilityId !== capabilityId || capability.audience !== audience || capability.issuer !== issuer) throw new MalformedIssuanceRow();
  let reference: string;
  try {
    reference = executionCapabilityGrantReferenceV2({ nonce, grantStoreId, boundedGrantId, grantDigest });
  } catch {
    throw new MalformedIssuanceRow();
  }
  if (capability.grantReference !== reference) throw new MalformedIssuanceRow();
  const signature = state === 'issued' ? signatureOf(row.signature) : undefined;
  if (state === 'issued' && signature === undefined) throw new MalformedIssuanceRow();
  return Object.freeze({
    state: state as ExecutionCapabilityIssuanceState,
    executionId,
    capabilityId,
    audience,
    boundedGrantId,
    grantStoreId,
    grantDigest,
    grantReferenceNonce: nonce,
    capability,
    canonical,
    reservedAt,
    ...(typeof settledAt === 'string' ? { settledAt } : {}),
    ...(signature !== undefined ? { signature } : {}),
  });
}

/**
 * Opens the issuance ledger at `path` — a file, never `:memory:`: a ledger
 * that forgets at restart would let an execution be issued twice. An absent
 * file is refused unless `create: true`; `create: true` over an existing file
 * is refused too, so a ledger is never re-initialized over its own history.
 */
export async function openExecutionCapabilityIssuanceLedger(path: string, options: ExecutionCapabilityIssuanceLedgerOptions): Promise<ExecutionCapabilityIssuanceLedger> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The execution capability issuance ledger needs a durable file path.');
  const { issuer, clock } = options;
  if (!isExecutionCapabilityIdentifier(issuer) || issuer.includes('*')) throw new Error('The execution capability issuance ledger needs exactly one issuer.');
  if (typeof clock !== 'function') throw new Error('The execution capability issuance ledger needs a clock.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The execution capability issuance ledger busy timeout is out of bounds.');
  if (options.create !== undefined && typeof options.create !== 'boolean') throw new Error('The execution capability issuance ledger create option is a boolean.');
  const create = options.create === true;
  const file = resolve(path);
  if (create && existsSync(file)) throw new Error('The execution capability issuance ledger already exists at that path. A ledger is never re-initialized over existing history.');
  if (!create && !existsSync(file)) {
    throw new Error('The execution capability issuance ledger does not exist at its configured path. It is never recreated implicitly: an empty ledger would forget every reserved capability.');
  }
  if (create && !existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db = new SqliteDatabase(file, create ? {} : { fileMustExist: true });
  try {
    // Before WAL: the journal-mode change itself must wait on a busy file rather than fail.
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (!create) {
      if (!tableExists(db, 'execution_capability_issuance_meta') || !tableExists(db, 'execution_capability_issuances')) throw new Error('The execution capability issuance ledger file is not an initialized ledger; refusing to open it.');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The execution capability issuance ledger failed its integrity check; refusing to open it.');
      // The reserved-first, forward-only and never-deleted rules live in triggers; a file without them is not this ledger.
      const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${LEDGER_TRIGGERS.map(() => '?').join(', ')})`).get(...LEDGER_TRIGGERS) as { n: unknown };
      if (triggers.n !== LEDGER_TRIGGERS.length) throw new Error('The execution capability issuance ledger is missing its integrity triggers; refusing to open it.');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (create) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO execution_capability_issuance_meta (id, schema_version, issuer) VALUES (1, ?, ?)').run(EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION, issuer);
      }).immediate();
    }
    const meta = db.prepare('SELECT schema_version, issuer FROM execution_capability_issuance_meta WHERE id = 1').get() as { schema_version: unknown; issuer: unknown } | undefined;
    if (meta?.schema_version !== EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION) throw new Error('The execution capability issuance ledger is recorded under another schema version; refusing to open it.');
    if (meta.issuer !== issuer) throw new Error('The execution capability issuance ledger is recorded for another issuer; refusing to open it.');
  } catch (error) {
    db.close();
    throw error instanceof Error && error.message.startsWith('The execution capability issuance ledger') ? error : new Error('The execution capability issuance ledger could not be opened.');
  }

  const selectExecution = db.prepare(`SELECT ${COLUMNS} FROM execution_capability_issuances WHERE execution_id = ?`);
  const selectCapability = db.prepare(`SELECT ${COLUMNS} FROM execution_capability_issuances WHERE capability_id = ?`);
  const insert = db.prepare(
    `INSERT INTO execution_capability_issuances (execution_id, capability_id, grant_reference_nonce, bounded_grant_id, grant_store_id, grant_digest, audience, capability_text, capability_digest, reserved_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
  );
  const settleIssued = db.prepare(`UPDATE execution_capability_issuances SET state = 'issued', signature = ?, settled_at = ? WHERE execution_id = ? AND capability_id = ? AND state = 'reserved'`);
  const settleUncertain = db.prepare(`UPDATE execution_capability_issuances SET state = 'uncertain', settled_at = ? WHERE execution_id = ? AND capability_id = ? AND state = 'reserved'`);

  const reserveInTransaction = db.transaction((row: { readonly executionId: string; readonly capabilityId: string; readonly nonce: string; readonly boundedGrantId: string; readonly grantStoreId: string; readonly grantDigest: string; readonly audience: string; readonly canonical: string; readonly reservedAt: string }): ExecutionCapabilityReserveOutcome => {
    const existing = selectExecution.get(row.executionId) as IssuanceRow | undefined;
    if (existing !== undefined) return { outcome: 'exists', record: recordOf(existing, issuer) as Exclude<ExecutionCapabilityIssuanceRecord, { readonly state: 'absent' }> };
    insert.run(row.executionId, row.capabilityId, row.nonce, row.boundedGrantId, row.grantStoreId, row.grantDigest, row.audience, row.canonical, textDigest(row.canonical), row.reservedAt);
    return { outcome: 'reserved', reservedAt: row.reservedAt };
  });

  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error('The execution capability issuance ledger is closed.');
  };
  const nowInstant = (): string => {
    const now = clock();
    if (!Number.isSafeInteger(now)) throw new Error('The execution capability issuance ledger clock did not answer.');
    return instantOf(now);
  };

  const ledger: ExecutionCapabilityIssuanceLedger = {
    issuer,
    reserve(reservation: ExecutionCapabilityReservation): ExecutionCapabilityReserveOutcome {
      ensureOpen();
      const { capability, boundedGrantId, grantStoreId, grantDigest, grantReferenceNonce } = reservation;
      if (!isWellFormedExecutionCapability(capability)) throw new Error('The execution capability issuance ledger reserves only a well-formed capability.');
      if (capability.issuer !== issuer) throw new Error('The execution capability issuance ledger reserves only capabilities of its own issuer.');
      // The row must hold together before it is written, exactly as every read will require.
      if (capability.grantReference !== executionCapabilityGrantReferenceV2({ nonce: grantReferenceNonce, grantStoreId, boundedGrantId, grantDigest })) {
        throw new Error('The execution capability issuance ledger refuses a reservation whose grant reference does not recompute.');
      }
      // IMMEDIATE: the write lock is taken before the read, so no other connection can interleave between check and insert.
      const outcome = reserveInTransaction.immediate({
        executionId: capability.executionId,
        capabilityId: capability.capabilityId,
        nonce: grantReferenceNonce,
        boundedGrantId,
        grantStoreId,
        grantDigest,
        audience: capability.audience,
        canonical: serializeExecutionCapability(capability),
        reservedAt: nowInstant(),
      });
      return Object.freeze(outcome);
    },
    markIssued(executionId: string, capabilityId: string, signature: AuthoritySignature): 'issued' | 'not-reserved' {
      ensureOpen();
      if (!isWellFormedAuthoritySignature(signature)) throw new Error('The execution capability issuance ledger records only a well-formed signature envelope.');
      const envelope = JSON.stringify({ algorithm: signature.algorithm, keyId: signature.keyId, signature: signature.signature, artifactVersion: signature.artifactVersion });
      return settleIssued.run(envelope, nowInstant(), executionId, capabilityId).changes === 1 ? 'issued' : 'not-reserved';
    },
    markUncertain(executionId: string, capabilityId: string): 'uncertain' | 'not-reserved' {
      ensureOpen();
      return settleUncertain.run(nowInstant(), executionId, capabilityId).changes === 1 ? 'uncertain' : 'not-reserved';
    },
    read(executionId: string): ExecutionCapabilityIssuanceRecord {
      ensureOpen();
      return recordOf(selectExecution.get(executionId) as IssuanceRow | undefined, issuer);
    },
    readCapability(capabilityId: string): ExecutionCapabilityIssuanceRecord {
      ensureOpen();
      return recordOf(selectCapability.get(capabilityId) as IssuanceRow | undefined, issuer);
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
