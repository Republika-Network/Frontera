import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { HUMAN_IDENTITY_RECORD_KINDS, humanIdentityGenesisDigest, humanIdentityRowDigest, nextHumanIdentityChainDigest, type HumanIdentityRecordKind, type HumanIdentityRowContent, type HumanIdentityStateCommitment, type StoredHumanIdentityRow } from './chain.js';
import { HUMAN_IDENTITY_STORE_SCHEMA_VERSION, HumanIdentityError } from './contracts.js';

/**
 * AUTH-02 — the durable human identity store: one SQLite file of its own.
 *
 * - `human_identity_records` is the append-only, hash-chained history of every
 *   principal, enrolment and credential fact (see `chain.ts`). It is the only
 *   source of truth; all state is derived from it on every authoritative read,
 *   after the whole chain has been recomputed against the head.
 * - `human_identity_challenges` holds WebAuthn ceremony challenges. They are
 *   not identity facts and are not chained; they are durable so that a used or
 *   expired challenge stays refused across a restart. A challenge is consumed
 *   by the same transaction that records what it authorized, so a ceremony
 *   either commits both or neither.
 *
 * Writes run under `BEGIN IMMEDIATE`: the guard sees the verified history
 * under the write lock, so two writers on one file — two connections, or two
 * processes — cannot both register one credential id, consume one challenge
 * or consume one enrolment. WAL and `synchronous=FULL` make a committed write
 * durable. Append-only triggers are defense in depth, not the boundary.
 *
 * Nothing secret is stored: public keys, identifiers, counters, timestamps,
 * and SHA-256 verifiers of 256-bit random enrolment secrets.
 *
 * Not yet: a signed head and CORE-07 freshness (see `chain.ts`).
 */

type Database = import('better-sqlite3').Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS human_identity_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    store_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS human_identity_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL,
    chain_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS human_identity_records (
    sequence INTEGER PRIMARY KEY,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    object_id TEXT,
    payload TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    row_digest TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS human_identity_one_registration_per_credential
    ON human_identity_records (object_id) WHERE kind = 'credential_registered';
  CREATE UNIQUE INDEX IF NOT EXISTS human_identity_one_authorization_per_enrolment
    ON human_identity_records (object_id) WHERE kind = 'enrolment_authorized';
  CREATE TRIGGER IF NOT EXISTS human_identity_records_no_update
    BEFORE UPDATE ON human_identity_records
    BEGIN SELECT RAISE(ABORT, 'human identity records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS human_identity_records_no_delete
    BEFORE DELETE ON human_identity_records
    BEGIN SELECT RAISE(ABORT, 'human identity records are append-only'); END;
  CREATE TABLE IF NOT EXISTS human_identity_challenges (
    challenge TEXT PRIMARY KEY,
    ceremony TEXT NOT NULL,
    operator_id TEXT,
    enrolment_id TEXT,
    target_credential_id TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );
`;

interface RecordRow {
  readonly sequence: number;
  readonly organization_id: string;
  readonly kind: string;
  readonly operator_id: string;
  readonly object_id: string | null;
  readonly payload: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly row_digest: string;
}

export type CeremonyKind = 'registration' | 'authentication' | 'owner-revocation';

export interface CeremonyChallenge {
  readonly challenge: string;
  readonly ceremony: CeremonyKind;
  readonly operatorId: string | null;
  readonly enrolmentId: string | null;
  readonly targetCredentialId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface SqliteHumanIdentityStoreOptions {
  /** The one organization this Host serves. A file created for another is refused. */
  readonly organizationId: string;
  readonly now: () => string;
  /** Create the file (and its directory) if absent. Never passed when opening an existing store. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
}

export interface HumanIdentityStore {
  readonly organizationId: string;
  readonly storeId: string;
  /** The verified history, oldest first. Throws `HUMAN_IDENTITY_STORE_CORRUPT` rather than return a history that does not verify. */
  history(): readonly StoredHumanIdentityRow[];
  head(): HumanIdentityStateCommitment;
  /**
   * Appends `rows` atomically, after `guard` has accepted the verified history
   * under the write lock and, when `consume` is given, after that challenge was
   * still unused and unexpired at `consume.at` — and consumes it in the same
   * transaction. Any refusal records nothing.
   */
  append(
    rows: readonly Omit<HumanIdentityRowContent, 'organizationId'>[],
    guard: (history: readonly StoredHumanIdentityRow[]) => void,
    consume?: { readonly challenge: string; readonly ceremony: CeremonyKind; readonly at: string },
  ): readonly StoredHumanIdentityRow[];
  saveChallenge(challenge: Omit<CeremonyChallenge, 'consumedAt'>): void;
  challenge(challenge: string): CeremonyChallenge | undefined;
  close(): void;
}

function corrupt(message: string): never {
  throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', message);
}

const isKind = (value: string): value is HumanIdentityRecordKind => (HUMAN_IDENTITY_RECORD_KINDS as readonly string[]).includes(value);

function toStored(row: RecordRow): StoredHumanIdentityRow {
  if (!isKind(row.kind)) corrupt('A human identity row is not a known record kind.');
  return {
    sequence: row.sequence,
    digest: row.row_digest,
    organizationId: row.organization_id,
    kind: row.kind,
    operatorId: row.operator_id,
    objectId: row.object_id,
    payload: row.payload,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

/** Recomputes the whole history against the committed head. A history that does not verify is not partially believed. */
export function verifyHumanIdentityHistory(rows: readonly StoredHumanIdentityRow[], state: HumanIdentityStateCommitment): void {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || rows.length !== state.sequence) corrupt('The human identity history does not have the committed length.');
  let chain = humanIdentityGenesisDigest(state.storeId, state.organizationId);
  for (const [index, row] of rows.entries()) {
    const { sequence, digest, ...content } = row;
    if (sequence !== index + 1) corrupt('The human identity history is not contiguous.');
    if (row.organizationId !== state.organizationId) corrupt('A human identity row belongs to another organization.');
    if (digest !== humanIdentityRowDigest(state.storeId, sequence, content)) corrupt('A human identity row does not match its digest.');
    chain = nextHumanIdentityChainDigest(chain, digest);
  }
  if (chain !== state.chainDigest) corrupt('The human identity history does not match the committed head.');
}

export async function openSqliteHumanIdentityStore(path: string, options: SqliteHumanIdentityStoreOptions): Promise<HumanIdentityStore> {
  const file = resolve(path);
  if (options.create !== true && !existsSync(file)) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `No human identity store exists at ${file}; it is created only by an explicit initialization.`);
  if (options.create === true) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db: Database = new SqliteDatabase(file, options.create === true ? {} : { fileMustExist: true });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 2_000)}`);
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const meta = (): { readonly schema_version: number; readonly store_id: string; readonly organization_id: string } | undefined =>
    db.prepare('SELECT schema_version, store_id, organization_id FROM human_identity_meta WHERE id = 1').get() as { schema_version: number; store_id: string; organization_id: string } | undefined;

  let identity = meta();
  if (identity === undefined) {
    if (options.create !== true) {
      db.close();
      corrupt('The human identity store has no identity record.');
    }
    const storeId = `his-${randomUUID()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (meta() === undefined) {
        const at = options.now();
        db.prepare('INSERT INTO human_identity_meta (id, schema_version, store_id, organization_id, created_at) VALUES (1, ?, ?, ?, ?)').run(HUMAN_IDENTITY_STORE_SCHEMA_VERSION, storeId, options.organizationId, at);
        db.prepare('INSERT INTO human_identity_head (id, sequence, chain_digest, updated_at) VALUES (1, 0, ?, ?)').run(humanIdentityGenesisDigest(storeId, options.organizationId), at);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
    identity = meta();
  }
  if (identity === undefined) {
    db.close();
    return corrupt('The human identity store has no identity record.');
  }
  if (identity.schema_version !== HUMAN_IDENTITY_STORE_SCHEMA_VERSION) {
    db.close();
    corrupt(`The human identity store has schema version ${String(identity.schema_version)}; this runtime implements ${String(HUMAN_IDENTITY_STORE_SCHEMA_VERSION)}.`);
  }
  if (identity.organization_id !== options.organizationId) {
    db.close();
    corrupt('The human identity store belongs to another organization.');
  }
  const storeId = identity.store_id;
  const organizationId = identity.organization_id;

  const readHead = (): HumanIdentityStateCommitment => {
    const head = db.prepare('SELECT sequence, chain_digest FROM human_identity_head WHERE id = 1').get() as { sequence: number; chain_digest: string } | undefined;
    if (head === undefined) corrupt('The human identity store has no head.');
    return { storeId, organizationId, sequence: head.sequence, chainDigest: head.chain_digest };
  };

  const readVerified = (): { readonly rows: readonly StoredHumanIdentityRow[]; readonly head: HumanIdentityStateCommitment } => {
    const head = readHead();
    const rows = (db.prepare('SELECT * FROM human_identity_records ORDER BY sequence').all() as RecordRow[]).map(toStored);
    verifyHumanIdentityHistory(rows, head);
    return { rows, head };
  };

  readVerified();

  const toChallenge = (row: { challenge: string; ceremony: string; operator_id: string | null; enrolment_id: string | null; target_credential_id: string | null; issued_at: string; expires_at: string; consumed_at: string | null }): CeremonyChallenge => {
    if (row.ceremony !== 'registration' && row.ceremony !== 'authentication' && row.ceremony !== 'owner-revocation') corrupt('A ceremony challenge is of an unknown kind.');
    return {
      challenge: row.challenge,
      ceremony: row.ceremony as CeremonyKind,
      operatorId: row.operator_id,
      enrolmentId: row.enrolment_id,
      targetCredentialId: row.target_credential_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  };

  return {
    organizationId,
    storeId,
    history: () => readVerified().rows,
    head: () => readVerified().head,
    append(rows, guard, consume) {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `The human identity store could not take its write lock; nothing was recorded. (${(error as Error).message})`);
      }
      try {
        const { rows: history, head } = readVerified();
        guard(history);
        if (consume !== undefined) {
          const result = db
            .prepare('UPDATE human_identity_challenges SET consumed_at = ? WHERE challenge = ? AND ceremony = ? AND consumed_at IS NULL AND expires_at > ?')
            .run(consume.at, consume.challenge, consume.ceremony, consume.at);
          if (result.changes !== 1) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge is unknown, expired or already used.');
        }
        const insert = db.prepare('INSERT INTO human_identity_records (sequence, organization_id, kind, operator_id, object_id, payload, recorded_by, recorded_at, row_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const appended: StoredHumanIdentityRow[] = [];
        let sequence = head.sequence;
        let chain = head.chainDigest;
        for (const row of rows) {
          sequence += 1;
          const content: HumanIdentityRowContent = { ...row, organizationId };
          const digest = humanIdentityRowDigest(storeId, sequence, content);
          insert.run(sequence, organizationId, content.kind, content.operatorId, content.objectId, content.payload, content.recordedBy, content.recordedAt, digest);
          chain = nextHumanIdentityChainDigest(chain, digest);
          appended.push({ ...content, sequence, digest });
        }
        if (rows.length > 0) {
          const updated = db.prepare('UPDATE human_identity_head SET sequence = ?, chain_digest = ?, updated_at = ? WHERE id = 1 AND sequence = ?').run(sequence, chain, options.now(), head.sequence);
          if (updated.changes !== 1) corrupt('The human identity head moved during a locked append.');
        }
        db.exec('COMMIT');
        return appended;
      } catch (error) {
        db.exec('ROLLBACK');
        if (error instanceof HumanIdentityError) throw error;
        const message = (error as Error).message;
        if (/UNIQUE constraint failed/.test(message)) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_DUPLICATE', 'That credential or enrolment is already recorded; nothing was recorded.');
        throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `The human identity store could not commit; nothing was recorded. (${message})`);
      }
    },
    saveChallenge(challenge) {
      try {
        db.prepare('INSERT INTO human_identity_challenges (challenge, ceremony, operator_id, enrolment_id, target_credential_id, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(
          challenge.challenge,
          challenge.ceremony,
          challenge.operatorId,
          challenge.enrolmentId,
          challenge.targetCredentialId,
          challenge.issuedAt,
          challenge.expiresAt,
        );
      } catch (error) {
        throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `The ceremony challenge could not be recorded. (${(error as Error).message})`);
      }
    },
    challenge(challenge) {
      const row = db.prepare('SELECT * FROM human_identity_challenges WHERE challenge = ?').get(challenge) as Parameters<typeof toChallenge>[0] | undefined;
      return row === undefined ? undefined : toChallenge(row);
    },
    close: () => db.close(),
  };
}
