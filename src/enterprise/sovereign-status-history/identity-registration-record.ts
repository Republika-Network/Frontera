import { closeSync, existsSync, fsyncSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { checkProtectedFile, confirmExclusivelyHeld, exclusiveCloser } from './executor-exclusivity.js';

/**
 * FV-P4C-2B3C-2A1 — the durable record of one FV bootstrap identity registration (internal, not composed
 * into the running Host; see `docs/integration/FV_IDENTITY_REGISTRATION_AND_OPERATOR_LIFECYCLE.md`).
 *
 * One SQLite file per FV deployment, owned by the registration ceremony (`identity-registration.ts`). It
 * holds at most one registration, and its state only moves forward:
 *
 * `intent-recorded` → `witness-anchored` → `store-created` → `registered`, and from any of the first three to
 * `quarantined`. `registered` and `quarantined` are terminal; nothing is ever deleted, reset or rebound.
 *
 * - **What it is:** the ceremony's evidence of what it was authorized to do (the consumed, signed G-02A
 *   registration capability, kept verbatim) and how far it got. It is written **before** each externally
 *   visible step, so a crash leaves a state whose meaning is exact.
 * - **What it is not:** the authority for the store id. That is the CORE-07 witness's FV slot (bound once,
 *   never rebound, read through signed receipts) together with the issuer's signature over the binding the
 *   record keeps. A raw writer of this file can forget or forge a row, but cannot forge that signature or
 *   rebind the witness; the executor's verification checks both (`verifyFvIdentityRegistration`).
 *
 * **Ownership.** The ceremony opens the file with SQLite `locking_mode = EXCLUSIVE` and takes the lock at
 * once, so a second ceremony, in any process, is refused while one runs, and a crash releases it. Every write
 * confirms, synchronously inside its own transaction, that this process still holds that lock and that the
 * path still passes the FV filesystem policy (`executor-exclusivity.ts`); the connection closes only through
 * the guarded closer. Rollback journal (not WAL), `synchronous = FULL`: a reader opens it read-only with no
 * shared-memory file, and a crash mid-transaction leaves a hot journal that the next writer rolls back and a
 * read-only reader refuses.
 *
 * **Integrity.** The triggers refuse a deleted row, a backward or skipped transition, a change to any intent
 * field and a second value for any progress field. Every read validates every column and recomputes nothing
 * it trusts blindly: a malformed row is `RECORD_CORRUPT`, never partially believed.
 */

export const FV_IDENTITY_REGISTRATION_RECORD_SCHEMA = 'frontera.fv-identity-registration-record.v1';

export const FV_IDENTITY_REGISTRATION_STATES = Object.freeze(['intent-recorded', 'witness-anchored', 'store-created', 'registered', 'quarantined'] as const);
export type FvIdentityRegistrationState = (typeof FV_IDENTITY_REGISTRATION_STATES)[number];

/** Why a registration was quarantined. Closed; each names evidence that disagrees, never a guess. */
export const FV_IDENTITY_REGISTRATION_QUARANTINE_REASONS = Object.freeze([
  /** The witness's FV slot of this organization binds another store id. Never adopted. */
  'WITNESS_BOUND_TO_ANOTHER_STORE',
  /** The witness's FV slot binds this store id beyond its genesis (or holds a prepared successor), though the ceremony never wrote past genesis. */
  'WITNESS_ADVANCED_UNEXPECTEDLY',
  /** The witness refused this store id's genesis: it is already anchored in another identity domain of the organization. */
  'WITNESS_REFUSED_STORE_ID',
  /** A file the ceremony did not reserve stands where the store is to be created. Never taken over. */
  'FOREIGN_FILE_AT_STORE_PATH',
  /** The store file the ceremony reserved is gone, or the path now names another file. */
  'STORE_FILE_REPLACED',
  /** The store at the reserved file is not this registration's genesis (another id, another organization, or beyond genesis). */
  'STORE_NOT_GENESIS',
] as const);
export type FvIdentityRegistrationQuarantineReason = (typeof FV_IDENTITY_REGISTRATION_QUARANTINE_REASONS)[number];

/** What the ceremony was authorized to do: fixed when the intent is recorded, never changed. */
export interface FvIdentityRegistrationIntent {
  readonly registrationId: string;
  readonly organizationId: string;
  readonly stateKind: string;
  readonly deploymentId: string;
  readonly witnessId: string;
  /** `sha256:` over the DER SPKI of the witness's pinned receipt key. */
  readonly witnessKeyDigest: string;
  readonly storeId: string;
  /** The absolute, canonical path of the store file. */
  readonly storePath: string;
  readonly storePolicy: string;
  /** The deployment authority key id that signs the store's head. */
  readonly authenticityKeyId: string;
  /** The registrar's G-02A context. */
  readonly audience: string;
  readonly trustDomain: string;
  /** The consumed G-02A capability, verbatim: its canonical text and its CORE-02 signature envelope (JSON). */
  readonly capabilityId: string;
  readonly capabilityIssuer: string;
  readonly capabilityText: string;
  readonly capabilitySignature: string;
  readonly actionBindingDigest: string;
  readonly intentRecordedAt: string;
}

export interface FvIdentityRegistrationRecord extends FvIdentityRegistrationIntent {
  readonly state: FvIdentityRegistrationState;
  readonly witnessAnchoredAt: string | null;
  /** The genesis digest the witness was verified to hold for this store id. */
  readonly genesisDigest: string | null;
  /** `dev:ino:birthtimeNs` of the file the ceremony reserved (created with `O_EXCL`), before any SQLite content. */
  readonly storeFileIdentity: string | null;
  readonly storeFileReservedAt: string | null;
  readonly storeCreatedAt: string | null;
  readonly registeredAt: string | null;
  readonly quarantinedAt: string | null;
  readonly quarantineReason: FvIdentityRegistrationQuarantineReason | null;
  readonly quarantinedFrom: FvIdentityRegistrationState | null;
}

export interface FvIdentityRegistrationEvent {
  readonly sequence: number;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

export class FvIdentityRegistrationRecordError extends Error {
  constructor(
    readonly code: 'PATH_REFUSED' | 'BUSY' | 'CORRUPT' | 'UNAVAILABLE' | 'ABSENT',
    message: string,
  ) {
    super(message);
    this.name = 'FvIdentityRegistrationRecordError';
  }
}

const INTENT_COLUMNS = [
  'registration_id',
  'organization_id',
  'state_kind',
  'deployment_id',
  'witness_id',
  'witness_key_digest',
  'store_id',
  'store_path',
  'store_policy',
  'authenticity_key_id',
  'audience',
  'trust_domain',
  'capability_id',
  'capability_issuer',
  'capability_text',
  'capability_signature',
  'action_binding_digest',
  'intent_recorded_at',
] as const;

const PROGRESS_COLUMNS = ['witness_anchored_at', 'genesis_digest', 'store_file_identity', 'store_file_reserved_at', 'store_created_at', 'registered_at', 'quarantined_at', 'quarantine_reason', 'quarantined_from'] as const;

const immutable = INTENT_COLUMNS.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ');
const setOnce = PROGRESS_COLUMNS.map((column) => `(OLD.${column} IS NOT NULL AND NEW.${column} IS NOT OLD.${column})`).join(' OR ');

const SCHEMA = `
CREATE TABLE fv_registration_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE fv_registration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ${INTENT_COLUMNS.map((column) => `${column} TEXT NOT NULL`).join(',\n  ')},
  state TEXT NOT NULL CHECK (state IN ('intent-recorded', 'witness-anchored', 'store-created', 'registered', 'quarantined')),
  ${PROGRESS_COLUMNS.map((column) => `${column} TEXT`).join(',\n  ')}
);
CREATE TABLE fv_registration_events (
  sequence INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TRIGGER fv_registration_meta_fixed_update BEFORE UPDATE ON fv_registration_meta
BEGIN SELECT RAISE(ABORT, 'the registration record identity is fixed'); END;
CREATE TRIGGER fv_registration_meta_fixed_delete BEFORE DELETE ON fv_registration_meta
BEGIN SELECT RAISE(ABORT, 'the registration record identity is fixed'); END;
CREATE TRIGGER fv_registration_never_deleted BEFORE DELETE ON fv_registration
BEGIN SELECT RAISE(ABORT, 'a registration is permanent'); END;
CREATE TRIGGER fv_registration_forward_only BEFORE UPDATE ON fv_registration
WHEN NOT (
    (OLD.state = 'witness-anchored' AND NEW.state = 'witness-anchored')
    OR (OLD.state = 'intent-recorded' AND NEW.state IN ('witness-anchored', 'quarantined'))
    OR (OLD.state = 'witness-anchored' AND NEW.state IN ('store-created', 'quarantined'))
    OR (OLD.state = 'store-created' AND NEW.state IN ('registered', 'quarantined'))
  )
  OR ${immutable}
  OR ${setOnce}
BEGIN SELECT RAISE(ABORT, 'a registration only moves forward'); END;
CREATE TRIGGER fv_registration_events_append_only_update BEFORE UPDATE ON fv_registration_events
BEGIN SELECT RAISE(ABORT, 'registration events are append-only'); END;
CREATE TRIGGER fv_registration_events_append_only_delete BEFORE DELETE ON fv_registration_events
BEGIN SELECT RAISE(ABORT, 'registration events are append-only'); END;
`;

const TRIGGERS = [
  'fv_registration_meta_fixed_update',
  'fv_registration_meta_fixed_delete',
  'fv_registration_never_deleted',
  'fv_registration_forward_only',
  'fv_registration_events_append_only_update',
  'fv_registration_events_append_only_delete',
] as const;

type Database = import('better-sqlite3').Database;

const TEXT_LIMIT = 16_384;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= TEXT_LIMIT;
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

function corrupt(message: string): never {
  throw new FvIdentityRegistrationRecordError('CORRUPT', message);
}

/** `dev:ino:birthtimeNs` of the file `path` names now (metadata only, never opened), or `undefined`. */
export function fileIdentityOf(path: string): string | undefined {
  try {
    const st = statSync(path, { bigint: true });
    return st.isFile() ? `${st.dev}:${st.ino}:${st.birthtimeNs}` : undefined;
  } catch {
    return undefined;
  }
}

/** Validates every column of a row read from the file. Anything malformed is corruption; nothing is partially believed. */
function recordOf(row: Readonly<Record<string, unknown>> | undefined, organizationId: string): FvIdentityRegistrationRecord | undefined {
  if (row === undefined) return undefined;
  for (const column of INTENT_COLUMNS) if (!isText(row[column])) corrupt(`The registration record's '${column}' is malformed.`);
  for (const column of PROGRESS_COLUMNS) if (!isTextOrNull(row[column])) corrupt(`The registration record's '${column}' is malformed.`);
  const state = row['state'];
  if (!(FV_IDENTITY_REGISTRATION_STATES as readonly unknown[]).includes(state)) corrupt('The registration record is in an unknown state.');
  const text = (column: string) => row[column] as string;
  const maybe = (column: string) => row[column] as string | null;
  if (text('organization_id') !== organizationId) corrupt('The registration record belongs to another organization.');
  const reason = maybe('quarantine_reason');
  const from = maybe('quarantined_from');
  // The progress columns must be exactly those the state implies: no state without its evidence, no evidence ahead of its state.
  const reached = (target: FvIdentityRegistrationState): boolean => {
    const order: readonly FvIdentityRegistrationState[] = ['intent-recorded', 'witness-anchored', 'store-created', 'registered'];
    const effective = state === 'quarantined' ? from : (state as FvIdentityRegistrationState);
    return effective !== null && order.indexOf(effective as FvIdentityRegistrationState) >= order.indexOf(target);
  };
  if (state === 'quarantined') {
    if (reason === null || !(FV_IDENTITY_REGISTRATION_QUARANTINE_REASONS as readonly string[]).includes(reason) || from === null || !['intent-recorded', 'witness-anchored', 'store-created'].includes(from) || maybe('quarantined_at') === null) {
      corrupt('A quarantined registration does not say why, or from where.');
    }
  } else if (reason !== null || from !== null || maybe('quarantined_at') !== null) {
    corrupt('A registration that is not quarantined carries a quarantine.');
  }
  const consistent =
    reached('witness-anchored') === (maybe('witness_anchored_at') !== null) &&
    reached('witness-anchored') === (maybe('genesis_digest') !== null) &&
    (maybe('store_file_identity') === null) === (maybe('store_file_reserved_at') === null) &&
    (!reached('store-created') || maybe('store_file_identity') !== null) &&
    (maybe('store_file_identity') === null || reached('witness-anchored')) &&
    reached('store-created') === (maybe('store_created_at') !== null) &&
    reached('registered') === (maybe('registered_at') !== null);
  if (!consistent) corrupt('The registration record’s evidence does not match its state.');
  return Object.freeze({
    registrationId: text('registration_id'),
    organizationId: text('organization_id'),
    stateKind: text('state_kind'),
    deploymentId: text('deployment_id'),
    witnessId: text('witness_id'),
    witnessKeyDigest: text('witness_key_digest'),
    storeId: text('store_id'),
    storePath: text('store_path'),
    storePolicy: text('store_policy'),
    authenticityKeyId: text('authenticity_key_id'),
    audience: text('audience'),
    trustDomain: text('trust_domain'),
    capabilityId: text('capability_id'),
    capabilityIssuer: text('capability_issuer'),
    capabilityText: text('capability_text'),
    capabilitySignature: text('capability_signature'),
    actionBindingDigest: text('action_binding_digest'),
    intentRecordedAt: text('intent_recorded_at'),
    state: state as FvIdentityRegistrationState,
    witnessAnchoredAt: maybe('witness_anchored_at'),
    genesisDigest: maybe('genesis_digest'),
    storeFileIdentity: maybe('store_file_identity'),
    storeFileReservedAt: maybe('store_file_reserved_at'),
    storeCreatedAt: maybe('store_created_at'),
    registeredAt: maybe('registered_at'),
    quarantinedAt: maybe('quarantined_at'),
    quarantineReason: reason as FvIdentityRegistrationQuarantineReason | null,
    quarantinedFrom: from as FvIdentityRegistrationState | null,
  });
}

/** Whether the file's SQLite header says WAL (header bytes 18 and 19 are 2 for WAL, 1 for a rollback journal). Read with plain I/O. */
function walHeader(file: string): boolean {
  const header = Buffer.alloc(20);
  const fd = openSync(file, 'r');
  try {
    return readSync(fd, header, 0, 20, 0) === 20 && header.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000' && (header[18] === 2 || header[19] === 2);
  } finally {
    closeSync(fd);
  }
}

/** The file's identity checks: tables, triggers, meta, integrity. Any failure is corruption (or another organization's record). */
function verifyStructure(db: Database, organizationId: string): void {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: unknown }[];
  for (const name of ['fv_registration_meta', 'fv_registration', 'fv_registration_events']) {
    if (!tables.some((t) => t.name === name)) corrupt(`The registration record is missing '${name}'; it is refused, never re-initialized.`);
  }
  const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})`).get(...TRIGGERS) as { n: unknown };
  if (triggers.n !== TRIGGERS.length) corrupt('The registration record is missing its integrity triggers.');
  if (db.pragma('quick_check', { simple: true }) !== 'ok') corrupt('The registration record failed its integrity check.');
  const meta = db.prepare('SELECT schema_version, organization_id FROM fv_registration_meta WHERE id = 1').get() as { schema_version: unknown; organization_id: unknown } | undefined;
  if (meta?.schema_version !== FV_IDENTITY_REGISTRATION_RECORD_SCHEMA) corrupt('The registration record is of another schema.');
  if (meta.organization_id !== organizationId) corrupt('The registration record belongs to another organization.');
}

/** The ceremony's handle on its record. Every write is fenced by the record's own exclusive lock. */
export interface FvRegistrationRecordFile {
  readonly path: string;
  read(): FvIdentityRegistrationRecord | undefined;
  events(): readonly FvIdentityRegistrationEvent[];
  recordIntent(intent: FvIdentityRegistrationIntent): FvIdentityRegistrationRecord;
  markWitnessAnchored(at: string, genesisDigest: string): FvIdentityRegistrationRecord;
  reserveStoreFile(at: string, identity: string): FvIdentityRegistrationRecord;
  markStoreCreated(at: string): FvIdentityRegistrationRecord;
  markRegistered(at: string): FvIdentityRegistrationRecord;
  quarantine(at: string, reason: FvIdentityRegistrationQuarantineReason): FvIdentityRegistrationRecord;
  appendEvent(at: string, kind: string, detail: string): void;
  /** Whether this process still holds the record's lock on the file its path names. */
  held(): boolean;
  /** The guarded close: closed only while held; otherwise retained, and the exit guard stops the process. */
  close(): void;
}

/**
 * Opens (or, with `create`, creates) the record as the ceremony's exclusive owner. `BUSY` when another
 * process holds it; `ABSENT` when it does not exist and `create` is not given; `PATH_REFUSED` when the path
 * fails the FV filesystem policy; `CORRUPT` when the file is not this organization's intact record.
 */
export async function openFvRegistrationRecord(path: string, options: { readonly organizationId: string; readonly now: () => string; readonly create?: boolean }): Promise<FvRegistrationRecordFile> {
  const file = resolve(path);
  const { organizationId, now } = options;
  const exists = existsSync(file);
  const refusal = checkProtectedFile(file, { allowMissing: options.create === true && !exists });
  if (refusal !== undefined) throw new FvIdentityRegistrationRecordError('PATH_REFUSED', `The registration record path is refused (${refusal}).`);
  if (!exists && options.create !== true) throw new FvIdentityRegistrationRecordError('ABSENT', 'No registration record exists; it is created only by a registration.');
  let created = false;
  if (!exists) {
    // O_EXCL: never over anything that appeared meanwhile. Owner-only from its first byte.
    try {
      closeSync(openSync(file, 'wx', 0o600));
      created = true;
    } catch {
      throw new FvIdentityRegistrationRecordError('BUSY', 'The registration record appeared while it was being created; another ceremony is running.');
    }
  }
  // Publication review L2: a record is a rollback-journal database. A WAL database at this path (another owner's
  // ledger, history or store, misconfigured) is refused before SQLite opens it, so it is never checkpointed or converted.
  if (!created && (existsSync(`${file}-wal`) || walHeader(file))) throw new FvIdentityRegistrationRecordError('CORRUPT', 'The file at the registration record path is a WAL database, not a registration record; it was not opened.');
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db: Database = new SqliteDatabase(file, { fileMustExist: true });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch {
    db.close();
    throw new FvIdentityRegistrationRecordError('BUSY', 'Another registration ceremony holds the registration record.');
  }
  const close = exclusiveCloser(file, db);
  const held = (): boolean => checkProtectedFile(file) === undefined && confirmExclusivelyHeld([file]);
  const fence = (): void => {
    if (!held()) throw new FvIdentityRegistrationRecordError('UNAVAILABLE', 'The registration ceremony no longer holds its record; nothing was written.');
  };
  try {
    // An existing file is confirmed to be this organization's record before any pragma changes it.
    if (!created) verifyStructure(db, organizationId);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    const empty = db.prepare(`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1`).get() === undefined;
    if (empty) {
      // Only a file this ceremony just created is initialized; an existing empty file is not a record.
      if (!created) corrupt('The registration record file holds no record; it is never initialized in place.');
      db.transaction(() => {
        fence();
        db.exec(SCHEMA);
        db.prepare('INSERT INTO fv_registration_meta (id, schema_version, organization_id, created_at) VALUES (1, ?, ?, ?)').run(FV_IDENTITY_REGISTRATION_RECORD_SCHEMA, organizationId, now());
      }).immediate();
      // The new file's directory entry is durable before anything relies on it.
      const directory = openSync(dirname(file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    verifyStructure(db, organizationId);
  } catch (error) {
    close();
    if (error instanceof FvIdentityRegistrationRecordError) throw error;
    throw new FvIdentityRegistrationRecordError('CORRUPT', `The registration record could not be read: ${(error as Error).message}`);
  }

  const select = db.prepare('SELECT * FROM fv_registration WHERE id = 1');
  const read = (): FvIdentityRegistrationRecord | undefined => recordOf(select.get() as Record<string, unknown> | undefined, organizationId);
  const insertEvent = db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)');

  /** One fenced write: the update, its event, and a read-back through the same validation every read runs. */
  const write = (mutate: () => void, event: { readonly at: string; readonly kind: string; readonly detail: string }): FvIdentityRegistrationRecord => {
    let result: FvIdentityRegistrationRecord | undefined;
    db.transaction(() => {
      fence();
      mutate();
      insertEvent.run(event.at, event.kind, event.detail);
      result = read();
    }).immediate();
    if (result === undefined) corrupt('The registration record has no registration after a write.');
    return result;
  };

  const update = (expected: FvIdentityRegistrationState, sql: string, ...values: unknown[]): void => {
    const changed = db.prepare(`UPDATE fv_registration SET ${sql} WHERE id = 1 AND state = ?`).run(...values, expected).changes;
    if (changed !== 1) throw new FvIdentityRegistrationRecordError('UNAVAILABLE', `The registration is no longer ${expected}; nothing was written.`);
  };

  const handle: FvRegistrationRecordFile = {
    path: file,
    read,
    events: () =>
      (db.prepare('SELECT sequence, at, kind, detail FROM fv_registration_events ORDER BY sequence').all() as Record<string, unknown>[]).map((row) => {
        if (typeof row['sequence'] !== 'number' || !isText(row['at']) || !isText(row['kind']) || typeof row['detail'] !== 'string') corrupt('A registration event is malformed.');
        return Object.freeze({ sequence: row['sequence'], at: row['at'], kind: row['kind'], detail: row['detail'] });
      }),
    recordIntent(intent) {
      return write(
        () => {
          if (select.get() !== undefined) throw new FvIdentityRegistrationRecordError('UNAVAILABLE', 'The record already holds a registration; nothing was written.');
          const values = [intent.registrationId, intent.organizationId, intent.stateKind, intent.deploymentId, intent.witnessId, intent.witnessKeyDigest, intent.storeId, intent.storePath, intent.storePolicy, intent.authenticityKeyId, intent.audience, intent.trustDomain, intent.capabilityId, intent.capabilityIssuer, intent.capabilityText, intent.capabilitySignature, intent.actionBindingDigest, intent.intentRecordedAt];
          db.prepare(`INSERT INTO fv_registration (id, ${INTENT_COLUMNS.join(', ')}, state) VALUES (1, ${INTENT_COLUMNS.map(() => '?').join(', ')}, 'intent-recorded')`).run(...values);
        },
        { at: intent.intentRecordedAt, kind: 'intent-recorded', detail: JSON.stringify({ capabilityId: intent.capabilityId, storeId: intent.storeId }) },
      );
    },
    markWitnessAnchored(at, genesisDigest) {
      return write(() => update('intent-recorded', `state = 'witness-anchored', witness_anchored_at = ?, genesis_digest = ?`, at, genesisDigest), { at, kind: 'witness-anchored', detail: JSON.stringify({ genesisDigest }) });
    },
    reserveStoreFile(at, identity) {
      return write(() => update('witness-anchored', 'store_file_identity = ?, store_file_reserved_at = ?', identity, at), { at, kind: 'store-file-reserved', detail: JSON.stringify({ identity }) });
    },
    markStoreCreated(at) {
      return write(() => update('witness-anchored', `state = 'store-created', store_created_at = ?`, at), { at, kind: 'store-created', detail: '{}' });
    },
    markRegistered(at) {
      return write(() => update('store-created', `state = 'registered', registered_at = ?`, at), { at, kind: 'registered', detail: '{}' });
    },
    quarantine(at, reason) {
      const current = read();
      if (current === undefined || current.state === 'registered' || current.state === 'quarantined') throw new FvIdentityRegistrationRecordError('UNAVAILABLE', 'Only a registration in progress can be quarantined.');
      return write(() => update(current.state, `state = 'quarantined', quarantined_at = ?, quarantine_reason = ?, quarantined_from = ?`, at, reason, current.state), { at, kind: 'quarantined', detail: JSON.stringify({ reason, from: current.state }) });
    },
    appendEvent(at, kind, detail) {
      db.transaction(() => {
        fence();
        insertEvent.run(at, kind, detail);
      }).immediate();
    },
    held,
    close,
  };
  return Object.freeze(handle);
}

/**
 * The executor's read of the record: read-only, never locking it for writing, never creating, migrating or
 * repairing anything. `BUSY` while a ceremony holds it (or a crash left a transaction to roll back).
 */
export async function readFvRegistrationRecordSnapshot(path: string, organizationId: string): Promise<FvIdentityRegistrationRecord | undefined> {
  const file = resolve(path);
  const refusal = checkProtectedFile(file);
  if (refusal !== undefined) throw new FvIdentityRegistrationRecordError(refusal === 'UNREADABLE' && !existsSync(file) ? 'ABSENT' : 'PATH_REFUSED', `The registration record path is refused (${refusal}).`);
  const { default: SqliteDatabase } = await import('better-sqlite3');
  let db: Database;
  try {
    db = new SqliteDatabase(file, { readonly: true, fileMustExist: true });
  } catch {
    throw new FvIdentityRegistrationRecordError('UNAVAILABLE', 'The registration record could not be opened.');
  }
  try {
    db.pragma('busy_timeout = 0');
    try {
      verifyStructure(db, organizationId);
      return recordOf(db.prepare('SELECT * FROM fv_registration WHERE id = 1').get() as Record<string, unknown> | undefined, organizationId);
    } catch (error) {
      if (error instanceof FvIdentityRegistrationRecordError) throw error;
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && /^SQLITE_(BUSY|LOCKED|READONLY|CANTOPEN)/.test(code)) throw new FvIdentityRegistrationRecordError('BUSY', 'The registration record is held by a registration ceremony.');
      throw new FvIdentityRegistrationRecordError('CORRUPT', `The registration record could not be read: ${(error as Error).message}`);
    }
  } finally {
    db.close();
  }
}
