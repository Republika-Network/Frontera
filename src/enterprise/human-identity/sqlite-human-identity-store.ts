import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { bindStoreSignerCustody } from '../authority-authenticity/custody.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import { humanIdentityStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateFreshnessBoundary,
  markComposedUnderFreshness,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
} from '../authority-state-freshness/session.js';
import { HUMAN_IDENTITY_RECORD_KINDS, humanIdentityGenesisDigest, humanIdentityRowDigest, nextHumanIdentityChainDigest, type HumanIdentityRecordKind, type HumanIdentityRowContent, type HumanIdentityStateCommitment, type StoredHumanIdentityRow } from './chain.js';
import { HUMAN_IDENTITY_STORE_SCHEMA_VERSION, HumanIdentityError } from './contracts.js';
import type { HumanDecisionChallengeContract } from './decision-challenge.js';

/**
 * The durable, **authenticated** human identity store (AUTH-02, signed by AUTH-03).
 *
 * One SQLite file of its own, built exactly as CORE-05's approval store:
 *
 * - `human_identity_records` is the append-only, hash-chained history of every
 *   principal, enrolment, credential and consumed ceremony or decision
 *   challenge (`chain.ts`). It is the only source of truth.
 * - The head `{storeId, organizationId, sequence, chainDigest}` is **signed by
 *   the deployment's authority key** under its own domain
 *   (`frontera:authority-artifact:human-identity-state:v1`). Every
 *   authoritative read — at open and before every write — verifies that
 *   signature against the trusted verification keys and recomputes the chain
 *   over every row. A database-only writer without the key can neither insert
 *   a passkey, resurrect a revoked one, delete a revocation, reorder rows nor
 *   transplant a row from another store.
 * - **Rollback.** A process-local floor (sequence and digest) refuses an older
 *   or forked state restored underneath a running Host. Across restarts,
 *   **only** when `freshness` is composed (CORE-07): the head is anchored at an
 *   external witness, compared at open before the store is returned, and
 *   advanced by prepare → local commit → finalize on every append. Every
 *   consumed challenge is a chained row, so restoring an older file to make a
 *   used challenge — or a revoked credential — usable again is a rollback the
 *   witness refuses. Nothing protects against restoring the witness together
 *   with this file, or against the holder of the signing key (CORE-02).
 * - `human_identity_challenges` and `human_decision_challenges` hold issued
 *   challenges. Issuance is not authority, so they are not chained. Their
 *   *consumption* is authority, so it is recorded as a chained row (whose
 *   payload names the challenge digest), checked by the caller's guard against
 *   the verified history — not merely by a mutable column.
 *
 * **Refusal discipline.** Under freshness, a local commit that fails after
 * `prepare` leaves the store in pending recovery. So every ordinary refusal
 * (`guard`, challenge consumability) is decided against the verified history
 * **before** signing and before `prepare`; the commit itself only re-verifies
 * that nothing moved and writes. A commit that still fails means tampering or a
 * second writer — the founder-approved pilot runs one Host process.
 *
 * There is no unauthenticated durable mode: a signer that does not offer
 * `signHumanIdentityState` (an external signer whose protocol does not yet
 * carry it) leaves the store unopenable.
 */

type Database = import('better-sqlite3').Database;

const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
const MAXIMUM_REPLANS = 3;

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
    signature_json TEXT NOT NULL,
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
  CREATE UNIQUE INDEX IF NOT EXISTS human_identity_one_authorization_per_decision
    ON human_identity_records (object_id) WHERE kind = 'decision_authorized';
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
  CREATE TABLE IF NOT EXISTS human_decision_challenges (
    challenge TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    approval_request_id TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    verdict TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
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

interface ChallengeRow {
  readonly challenge: string;
  readonly ceremony: string;
  readonly operator_id: string | null;
  readonly enrolment_id: string | null;
  readonly target_credential_id: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface DecisionChallengeRow {
  readonly challenge: string;
  readonly format: string;
  readonly organization_id: string;
  readonly approval_request_id: string;
  readonly subject_digest: string;
  readonly verdict: string;
  readonly operator_id: string;
  readonly nonce: string;
  readonly issued_at: string;
  readonly expires_at: string;
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

/** A stored decision challenge: the WebAuthn challenge string and the contract whose commitment it must be. */
export interface StoredDecisionChallenge {
  readonly challenge: string;
  readonly contract: HumanDecisionChallengeContract;
}

export interface SqliteHumanIdentityStoreOptions {
  /** The one organization this Host serves. A file created for another is refused. */
  readonly organizationId: string;
  readonly now: () => string;
  /** Create the file (and its directory) if absent. Never passed when opening an existing store. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
  /** The deployment's authority signer and verifier. Never optional: there is no unauthenticated durable mode. */
  readonly authenticity: { readonly signer: AuthorityArtifactSigner; readonly verifier: AuthorityArtifactVerifier };
  /** CORE-07 — cross-restart freshness of the signed head, anchored at an external witness. `enrollment` is the explicit ceremony only. */
  readonly freshness?: { readonly boundary: AuthorityStateFreshnessBoundary; readonly enrollment?: AuthorityStateEnrollmentContext };
}

export interface HumanIdentityStore {
  readonly organizationId: string;
  readonly storeId: string;
  /** The verified history, oldest first. Throws `HUMAN_IDENTITY_STORE_CORRUPT` rather than return a history that does not verify. */
  history(): readonly StoredHumanIdentityRow[];
  head(): HumanIdentityStateCommitment;
  /**
   * Appends one row and advances the signed head by exactly one position (the
   * CORE-07 transition rule: every witnessed transition is one step). `guard` decides
   * every refusal against the verified history before anything is signed or
   * prepared; when `consume` is given, that challenge must also be unused and
   * unexpired at `consume.at`, and is marked used in the same transaction.
   * Any refusal records nothing.
   */
  append(
    row: Omit<HumanIdentityRowContent, 'organizationId'>,
    guard: (history: readonly StoredHumanIdentityRow[]) => void,
    consume?: { readonly challenge: string; readonly ceremony: CeremonyKind; readonly at: string },
  ): Promise<StoredHumanIdentityRow>;
  saveChallenge(challenge: Omit<CeremonyChallenge, 'consumedAt'>): void;
  challenge(challenge: string): CeremonyChallenge | undefined;
  saveDecisionChallenge(challenge: StoredDecisionChallenge): void;
  decisionChallenge(challenge: string): StoredDecisionChallenge | undefined;
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

function tableExists(db: Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** Whether the file holds no schema object at all — the only state in which a new genesis may be created. */
function isEmptyDatabase(db: Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1`).get() === undefined;
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
  const busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', `busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  }
  const signer = options.authenticity?.signer;
  const verifier = options.authenticity?.verifier;
  if (signer === undefined || verifier === undefined || typeof signer.signHumanIdentityState !== 'function' || typeof verifier.verifyHumanIdentityState !== 'function') {
    throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNSUPPORTED', 'The human identity store requires an authority signer that signs human identity state, and its verifier; there is no unauthenticated durable mode.');
  }
  const signState = signer.signHumanIdentityState.bind(signer);
  const verifyState = verifier.verifyHumanIdentityState.bind(verifier);
  const activeKeyId = signer.activeKeyId;
  const organizationId = options.organizationId;
  const freshness = options.freshness;
  if (freshness !== undefined && (!isAuthorityStateFreshnessBoundary(freshness.boundary) || freshness.boundary.organizationId !== organizationId)) {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The human identity store freshness option must carry a boundary built by createAuthorityStateFreshnessBoundary for the same organization.');
  }
  const file = resolve(path);
  if (options.create !== true && !existsSync(file)) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `No human identity store exists at ${file}; it is created only by an explicit initialization.`);
  if (options.create === true) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db: Database = new SqliteDatabase(file, options.create === true ? {} : { fileMustExist: true });

  // The newest committed state this process has verified (sequence and digest). Across restarts, the freshness session is what refuses an older state.
  let witnessed: { readonly sequence: number; readonly chainDigest: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;

  const verifiedState = (): { readonly state: HumanIdentityStateCommitment; readonly rows: readonly StoredHumanIdentityRow[]; readonly keyId: string } => {
    for (const table of ['human_identity_meta', 'human_identity_head', 'human_identity_records', 'human_identity_challenges', 'human_decision_challenges']) {
      if (!tableExists(db, table)) corrupt(`The human identity store is missing '${table}'; it is refused, never re-initialized.`);
    }
    const meta = db.prepare('SELECT schema_version, store_id, organization_id FROM human_identity_meta WHERE id = 1').get() as
      | { readonly schema_version: number; readonly store_id: string; readonly organization_id: string }
      | undefined;
    if (meta === undefined) return corrupt('The human identity store has no identity.');
    if (meta.schema_version !== HUMAN_IDENTITY_STORE_SCHEMA_VERSION) {
      throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNSUPPORTED', `The human identity store is schema version ${String(meta.schema_version)}; this build reads only version ${String(HUMAN_IDENTITY_STORE_SCHEMA_VERSION)}.`);
    }
    if (meta.organization_id !== organizationId) corrupt('The human identity store belongs to another organization.');
    const head = db.prepare('SELECT sequence, chain_digest, signature_json FROM human_identity_head WHERE id = 1').get() as
      | { readonly sequence: number; readonly chain_digest: string; readonly signature_json: string }
      | undefined;
    if (head === undefined) return corrupt('The human identity store has no committed state.');
    const state: HumanIdentityStateCommitment = { storeId: meta.store_id, organizationId: meta.organization_id, sequence: head.sequence, chainDigest: head.chain_digest };
    let signature: unknown;
    try {
      signature = JSON.parse(head.signature_json);
    } catch {
      signature = undefined;
    }
    const verification = verifyState(state, signature);
    if (!verification.verified) return corrupt(`The human identity store's committed state is not authentic (${verification.failure}).`);
    const rows = (db.prepare('SELECT * FROM human_identity_records ORDER BY sequence ASC').all() as RecordRow[]).map(toStored);
    verifyHumanIdentityHistory(rows, state);
    // CORE-07: the floor established against the external witness at open. Local, synchronous, no network.
    session?.observe(humanIdentityStateCheckpoint(state));
    if (witnessed !== undefined) {
      if (state.sequence < witnessed.sequence) corrupt('The human identity store regressed to an earlier committed state while this process was running.');
      if (state.sequence === witnessed.sequence && state.chainDigest !== witnessed.chainDigest) corrupt('The human identity store holds a different committed state at the same sequence while this process was running.');
    }
    if (witnessed === undefined || state.sequence > witnessed.sequence) witnessed = { sequence: state.sequence, chainDigest: state.chainDigest };
    return { state, rows, keyId: verification.keyId };
  };

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    if (!tableExists(db, 'human_identity_meta')) {
      // A genesis is created only for a file that holds nothing at all, and only by an explicit initialization.
      if (options.create !== true || !isEmptyDatabase(db)) corrupt('The human identity store has content but no authenticated identity; it is never re-initialized.');
      const storeId =
        freshness === undefined
          ? `human-identity-store:${randomUUID()}`
          : await freshness.boundary.genesisStoreId('human-identity-state', { newStoreId: () => `human-identity-store:${randomUUID()}`, genesisDigest: (id) => humanIdentityGenesisDigest(id, organizationId) });
      const genesis: HumanIdentityStateCommitment = { storeId, organizationId, sequence: 0, chainDigest: humanIdentityGenesisDigest(storeId, organizationId) };
      const signature = await signState(genesis);
      const createdAt = options.now();
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO human_identity_meta (id, schema_version, store_id, organization_id, created_at) VALUES (1, ?, ?, ?, ?)').run(HUMAN_IDENTITY_STORE_SCHEMA_VERSION, storeId, organizationId, createdAt);
        db.prepare('INSERT INTO human_identity_head (id, sequence, chain_digest, signature_json, updated_at) VALUES (1, 0, ?, ?, ?)').run(genesis.chainDigest, JSON.stringify(signature), createdAt);
      })();
    }
    // Verified before the store is handed to anything: a forged or foreign store refuses at open.
    const opened = verifiedState();
    if (freshness !== undefined) {
      session = await freshness.boundary.establish(humanIdentityStateCheckpoint(opened.state), () => humanIdentityStateCheckpoint(verifiedState().state), freshness.enrollment !== undefined ? { enrollment: freshness.enrollment } : {});
    }
    // Key rotation (the CORE-01 rule, as CORE-05 applies it): a head verified under a trusted non-active key is re-signed unchanged. Best effort.
    if (opened.keyId !== activeKeyId) {
      try {
        const signature = await signState(opened.state);
        db.transaction(() => {
          const current = verifiedState().state;
          if (current.sequence !== opened.state.sequence || current.chainDigest !== opened.state.chainDigest || current.storeId !== opened.state.storeId) return;
          db.prepare('UPDATE human_identity_head SET signature_json = ? WHERE id = 1').run(JSON.stringify(signature));
          verifiedState();
        }).immediate();
      } catch {
        // Nothing was written unless the re-signed state verified on read-back.
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const storeId = verifiedState().state.storeId;
  const insert = db.prepare('INSERT INTO human_identity_records (sequence, organization_id, kind, operator_id, object_id, payload, recorded_by, recorded_at, row_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const updateHead = db.prepare('UPDATE human_identity_head SET sequence = ?, chain_digest = ?, signature_json = ?, updated_at = ? WHERE id = 1 AND sequence = ?');

  let closed = false;
  const open = (): void => {
    if (closed) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', 'The human identity store is closed.');
  };

  const challengeUsable = (consume: { readonly challenge: string; readonly ceremony: CeremonyKind; readonly at: string }): boolean => {
    const row = db.prepare('SELECT ceremony, expires_at, consumed_at FROM human_identity_challenges WHERE challenge = ?').get(consume.challenge) as { ceremony: string; expires_at: string; consumed_at: string | null } | undefined;
    return row !== undefined && row.ceremony === consume.ceremony && row.consumed_at === null && row.expires_at > consume.at;
  };

  const appendOnce = async (
    row: Omit<HumanIdentityRowContent, 'organizationId'>,
    guard: (history: readonly StoredHumanIdentityRow[]) => void,
    consume: { readonly challenge: string; readonly ceremony: CeremonyKind; readonly at: string } | undefined,
  ): Promise<StoredHumanIdentityRow> => {
    for (let attempt = 0; ; attempt += 1) {
      open();
      // Every refusal is decided here, against the verified history, before anything is signed or prepared.
      const { state, rows: history } = verifiedState();
      guard(history);
      if (consume !== undefined && !challengeUsable(consume)) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge is unknown, expired or already used.');
      const sequence = state.sequence + 1;
      const content: HumanIdentityRowContent = { ...row, organizationId };
      const digest = humanIdentityRowDigest(state.storeId, sequence, content);
      const planned: StoredHumanIdentityRow = { ...content, sequence, digest };
      const next: HumanIdentityStateCommitment = { ...state, sequence, chainDigest: nextHumanIdentityChainDigest(state.chainDigest, digest) };
      // Signed before the write transaction; nothing is written if signing fails.
      const signature = await signState(next);
      // A second connection may have committed while we signed: re-plan before preparing anything at the witness.
      const latest = verifiedState().state;
      if (latest.sequence !== state.sequence || latest.chainDigest !== state.chainDigest) {
        if (attempt + 1 >= MAXIMUM_REPLANS) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', 'The human identity store kept changing while a record was being appended; nothing was written.');
        continue;
      }
      const updatedAt = options.now();
      const commitLocal = (): void =>
        db.transaction(() => {
          // Under the write lock: still exactly the planned state, so the signature covers what is written.
          const current = verifiedState().state;
          if (current.sequence !== state.sequence || current.chainDigest !== state.chainDigest || current.storeId !== state.storeId) {
            corrupt('The human identity store changed while a record was being appended; nothing was written.');
          }
          if (consume !== undefined) {
            const result = db
              .prepare('UPDATE human_identity_challenges SET consumed_at = ? WHERE challenge = ? AND ceremony = ? AND consumed_at IS NULL AND expires_at > ?')
              .run(consume.at, consume.challenge, consume.ceremony, consume.at);
            if (result.changes !== 1) corrupt('A ceremony challenge changed while a record was being appended; nothing was written.');
          }
          insert.run(planned.sequence, organizationId, planned.kind, planned.operatorId, planned.objectId, planned.payload, planned.recordedBy, planned.recordedAt, planned.digest);
          const updated = updateHead.run(next.sequence, next.chainDigest, JSON.stringify(signature), updatedAt, state.sequence);
          if (updated.changes !== 1) corrupt('The human identity head moved during a locked append.');
          // Read back through the same verification every later read runs.
          verifiedState();
        }).immediate();
      try {
        if (session === undefined) commitLocal();
        else await session.transition(humanIdentityStateCheckpoint(state), humanIdentityStateCheckpoint(next), () => (commitLocal(), { value: undefined, state: humanIdentityStateCheckpoint(next) }));
      } catch (error) {
        if (error instanceof HumanIdentityError || error instanceof AuthorityStateFreshnessError) throw error;
        throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `The human identity store could not commit; nothing was recorded. (${(error as Error).message})`);
      }
      return planned;
    }
  };

  // Appends are serialized in-process: each one extends exactly the head it verified.
  let tail: Promise<unknown> = Promise.resolve();

  const toDecisionChallenge = (row: DecisionChallengeRow): StoredDecisionChallenge => {
    if (row.verdict !== 'approve' && row.verdict !== 'reject') corrupt('A decision challenge has an unknown verdict.');
    return {
      challenge: row.challenge,
      contract: {
        format: row.format,
        organizationId: row.organization_id,
        approvalRequestId: row.approval_request_id,
        subjectDigest: row.subject_digest,
        verdict: row.verdict as 'approve' | 'reject',
        operatorId: row.operator_id,
        nonce: row.nonce,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      },
    };
  };

  const store: HumanIdentityStore = {
    organizationId,
    storeId,
    history: () => (open(), verifiedState().rows),
    head: () => (open(), verifiedState().state),
    append(row, guard, consume) {
      const result = tail.then(() => appendOnce(row, guard, consume));
      tail = result.catch(() => undefined);
      return result;
    },
    saveChallenge(challenge) {
      open();
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
      open();
      const row = db.prepare('SELECT * FROM human_identity_challenges WHERE challenge = ?').get(challenge) as ChallengeRow | undefined;
      if (row === undefined) return undefined;
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
    },
    saveDecisionChallenge({ challenge, contract }) {
      open();
      try {
        db.prepare(
          'INSERT INTO human_decision_challenges (challenge, format, organization_id, approval_request_id, subject_digest, verdict, operator_id, nonce, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(challenge, contract.format, contract.organizationId, contract.approvalRequestId, contract.subjectDigest, contract.verdict, contract.operatorId, contract.nonce, contract.issuedAt, contract.expiresAt);
      } catch (error) {
        throw new HumanIdentityError('HUMAN_IDENTITY_STORE_UNAVAILABLE', `The decision challenge could not be recorded. (${(error as Error).message})`);
      }
    },
    decisionChallenge(challenge) {
      open();
      const row = db.prepare('SELECT * FROM human_decision_challenges WHERE challenge = ?').get(challenge) as DecisionChallengeRow | undefined;
      return row === undefined ? undefined : toDecisionChallenge(row);
    },
    close: () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  // CORE-02: which custody signs for this store (software or external).
  bindStoreSignerCustody(store, signer);
  // CORE-07: which freshness boundary this store was composed under, if any.
  if (freshness !== undefined) markComposedUnderFreshness(store, freshness.boundary);
  return store;
}
