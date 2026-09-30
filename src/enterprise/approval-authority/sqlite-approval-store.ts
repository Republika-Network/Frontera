import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { bindStoreSignerCustody } from '../authority-authenticity/custody.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import { approvalStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateFreshnessBoundary,
  markComposedUnderFreshness,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
} from '../authority-state-freshness/session.js';
import { APPROVAL_STORE_SCHEMA_VERSION, type ApprovalStore, type StoredApprovalRecord } from './contracts.js';
import { ApprovalAuthorityError } from './errors.js';
import { rowsForRequest, verifyApprovalHistory } from './integrity.js';
import { approvalGenesisDigest, approvalRowDigest, nextApprovalChainDigest, type ApprovalRecordKind, type ApprovalRowContent, type ApprovalStateCommitment } from './state-commitment.js';

/**
 * The durable, **authenticated** approval store (CORE-05).
 *
 * One SQLite file of its own, built exactly as CORE-04's obligation discharge
 * store is: every append advances a hash chain over the store's whole history,
 * and the chain head `{storeId, organizationId, sequence, chainDigest}` is
 * signed by the deployment's authority key under its own domain. Every
 * authoritative read — at open, before every recorded verdict and before every
 * resumption — verifies that signature against the trusted verification keys
 * and recomputes the chain over every row. A database-only writer without the
 * key can therefore neither insert an approval, alter one, delete a rejection
 * or a revocation, reorder rows, nor transplant one from another store.
 *
 * Append-only triggers remain as defense in depth; they are not the boundary.
 *
 * Rollback matters here more than anywhere: a genuine history's *prefix* can
 * be more permissive than its whole (an approval before its revocation or a
 * later rejection). It is refused while the process lives by an in-process
 * witness (sequence and digest), and across restarts **only** when `freshness`
 * is composed (CORE-07): the head is then anchored at an external witness
 * outside this file's restore domain, compared at open before the store is
 * returned, and advanced by prepare → local commit → finalize on every append.
 * What this does **not** give: protection when the witness itself is restored
 * together with this file, or against anyone who holds the signing key or
 * controls this process (CORE-02).
 */

export interface SqliteApprovalStoreOptions {
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
  /** The one organization this Host serves. A store created for another is refused at open. */
  readonly organizationId: string;
  /** The deployment's authority signer (to advance the signed head) and verifier (to believe it). Never optional: there is no unauthenticated durable mode. */
  readonly authenticity: { readonly signer: AuthorityArtifactSigner; readonly verifier: AuthorityArtifactVerifier };
  /**
   * CORE-07 — cross-restart freshness of the signed head, anchored at an
   * external witness outside this file's restore domain. Optional for an
   * embedder; the secure Host always composes it. `enrollment` is the explicit
   * ceremony for an existing store the witness has never seen, and is never
   * passed by any composition path.
   */
  readonly freshness?: { readonly boundary: AuthorityStateFreshnessBoundary; readonly enrollment?: AuthorityStateEnrollmentContext };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS approval_store_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    store_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL,
    chain_digest TEXT NOT NULL,
    signature_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_records (
    sequence INTEGER PRIMARY KEY,
    organization_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT,
    actor_id TEXT,
    evidence TEXT,
    reason TEXT,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    row_digest TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_records_by_request ON approval_records (request_id);
  CREATE TRIGGER IF NOT EXISTS approval_records_no_update
    BEFORE UPDATE ON approval_records
    BEGIN SELECT RAISE(ABORT, 'approval records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS approval_records_no_delete
    BEFORE DELETE ON approval_records
    BEGIN SELECT RAISE(ABORT, 'approval records are append-only'); END;
`;

interface Row {
  readonly sequence: number;
  readonly organization_id: string;
  readonly request_id: string;
  readonly decision_id: string;
  readonly subject_digest: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly actor_id: string | null;
  readonly evidence: string | null;
  readonly reason: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly row_digest: string;
}

const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

function corrupt(message: string): never {
  throw new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', message);
}

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** Whether the file holds no schema object at all — the only state in which a new genesis may be created. */
function isEmptyDatabase(db: import('better-sqlite3').Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1`).get() === undefined;
}

function toStored(row: Row): StoredApprovalRecord {
  return {
    organizationId: row.organization_id,
    requestId: row.request_id,
    decisionId: row.decision_id,
    subjectDigest: row.subject_digest,
    // Checked against the closed set by `verifyApprovalHistory`, never trusted from here.
    kind: row.kind as ApprovalRecordKind,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
    digest: row.row_digest,
  };
}

export async function createSqliteApprovalStore(path: string, options: SqliteApprovalStoreOptions): Promise<ApprovalStore> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  }
  const { signer, verifier } = options.authenticity ?? {};
  if (signer === undefined || verifier === undefined || typeof signer.signApprovalState !== 'function' || typeof verifier.verifyApprovalState !== 'function') {
    throw new ApprovalAuthorityError('APPROVAL_STORE_UNSUPPORTED', 'The durable approval store requires the authority signer and verifier; there is no unauthenticated durable mode.');
  }
  const organizationId = options.organizationId;
  const absolute = resolve(path);
  const dir = dirname(absolute);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(absolute);
  // The newest committed state this process has verified — sequence **and**
  // digest (CORE-07): a read that finds a lower sequence, or a different state
  // at the same sequence, has found an older or forked signed state restored
  // underneath a running Host, and is refused. On its own it lasts only while
  // this process lives; across a restart the freshness session below, anchored
  // at the external witness, is what refuses an older state.
  let witnessed: { readonly sequence: number; readonly chainDigest: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  const freshness = options.freshness;
  if (freshness !== undefined && (!isAuthorityStateFreshnessBoundary(freshness.boundary) || freshness.boundary.organizationId !== organizationId)) {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The approval store freshness option must carry a boundary built by createAuthorityStateFreshnessBoundary for the same organization.');
  }

  function verifiedState(): { readonly state: ApprovalStateCommitment; readonly rows: readonly StoredApprovalRecord[]; readonly keyId: string } {
    for (const table of ['approval_store_meta', 'approval_head', 'approval_records']) {
      if (!tableExists(db, table)) corrupt(`The approval store is missing '${table}'; it is refused, never re-initialized.`);
    }
    const meta = db.prepare('SELECT schema_version, store_id, organization_id FROM approval_store_meta WHERE id = 1').get() as
      | { readonly schema_version: number; readonly store_id: string; readonly organization_id: string }
      | undefined;
    if (meta === undefined) corrupt('The approval store has no identity.');
    if (meta.schema_version !== APPROVAL_STORE_SCHEMA_VERSION) {
      throw new ApprovalAuthorityError('APPROVAL_STORE_UNSUPPORTED', `The approval store is schema version ${String(meta.schema_version)}; this build reads only version ${String(APPROVAL_STORE_SCHEMA_VERSION)}.`);
    }
    if (meta.organization_id !== organizationId) corrupt('The approval store belongs to another organization.');
    const head = db.prepare('SELECT sequence, chain_digest, signature_json FROM approval_head WHERE id = 1').get() as
      | { readonly sequence: number; readonly chain_digest: string; readonly signature_json: string }
      | undefined;
    if (head === undefined) corrupt('The approval store has no committed state.');
    const state: ApprovalStateCommitment = { storeId: meta.store_id, organizationId: meta.organization_id, sequence: head.sequence, chainDigest: head.chain_digest };
    let signature: unknown;
    try {
      signature = JSON.parse(head.signature_json);
    } catch {
      signature = undefined;
    }
    const verification = verifier.verifyApprovalState(state, signature);
    if (!verification.verified) corrupt(`The approval store's committed state is not authentic (${verification.failure}).`);
    const keyId = verification.keyId;
    const rows = (db.prepare('SELECT * FROM approval_records ORDER BY sequence ASC').all() as Row[]).map(toStored);
    verifyApprovalHistory(rows, state);
    // CORE-07: the floor established against the external witness at open. Local, synchronous, no network. First, so the freshness session records what it refused.
    session?.observe(approvalStateCheckpoint(state));
    if (witnessed !== undefined) {
      if (state.sequence < witnessed.sequence) corrupt('The approval store regressed to an earlier committed state while this process was running.');
      if (state.sequence === witnessed.sequence && state.chainDigest !== witnessed.chainDigest) corrupt('The approval store holds a different committed state at the same sequence while this process was running.');
    }
    if (witnessed === undefined || state.sequence > witnessed.sequence) witnessed = { sequence: state.sequence, chainDigest: state.chainDigest };
    return { state, rows, keyId };
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (!tableExists(db, 'approval_store_meta')) {
      // A genesis is created only for a file that holds nothing at all. A file
      // that already has tables but no identity is never re-initialized: that
      // would sign a fresh, empty authority state over whatever is there —
      // and an empty approval state forgets every rejection.
      if (!isEmptyDatabase(db)) corrupt('The approval store has content but no authenticated identity; it is never re-initialized.');
      // CORE-07: under freshness the genesis is enrolled at the witness before
      // it is committed here; a crash in between is adopted on the next open
      // (genesis is deterministic from the store id), and a witness holding
      // this organization's state beyond genesis refuses the empty file.
      const storeId =
        freshness === undefined
          ? `approval-store:${randomUUID()}`
          : await freshness.boundary.genesisStoreId('approval-state', { newStoreId: () => `approval-store:${randomUUID()}`, genesisDigest: (id) => approvalGenesisDigest(id, organizationId) });
      const genesis: ApprovalStateCommitment = { storeId, organizationId, sequence: 0, chainDigest: approvalGenesisDigest(storeId, organizationId) };
      const signature = await signer.signApprovalState(genesis);
      const createdAt = options.now();
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO approval_store_meta (id, schema_version, store_id, organization_id, created_at) VALUES (1, ?, ?, ?, ?)').run(APPROVAL_STORE_SCHEMA_VERSION, storeId, organizationId, createdAt);
        db.prepare('INSERT INTO approval_head (id, sequence, chain_digest, signature_json, updated_at) VALUES (1, 0, ?, ?, ?)').run(genesis.chainDigest, JSON.stringify(signature), createdAt);
      })();
    }
    // Verified before the store is handed to anything: a forged or foreign
    // store refuses the Host at startup, not at the first resumption.
    const opened = verifiedState();
    // CORE-07: freshness is established before the store is re-attested or
    // handed to anything. A rollback, fork, unheld pending transition,
    // unenrolled store or unreachable witness refuses the open.
    if (freshness !== undefined) {
      session = await freshness.boundary.establish(approvalStateCheckpoint(opened.state), () => approvalStateCheckpoint(verifiedState().state), freshness.enrollment !== undefined ? { enrollment: freshness.enrollment } : {});
    }
    // Key rotation — the CORE-01 rule, reused unchanged: a state that verifies
    // under a trusted key other than the active one is re-signed, *unchanged*,
    // under the active key, inside a transaction that verifies it again and
    // writes only if it is still exactly that state. Best effort.
    if (opened.keyId !== signer.activeKeyId) {
      try {
        const signature = await signer.signApprovalState(opened.state);
        db.transaction(() => {
          const current = verifiedState().state;
          if (current.sequence !== opened.state.sequence || current.chainDigest !== opened.state.chainDigest || current.storeId !== opened.state.storeId) return;
          db.prepare('UPDATE approval_head SET signature_json = ? WHERE id = 1').run(JSON.stringify(signature));
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

  const insert = db.prepare(
    `INSERT INTO approval_records (sequence, organization_id, request_id, decision_id, subject_digest, kind, subject, actor_id, evidence, reason, recorded_by, recorded_at, row_digest)
     VALUES (@sequence, @organization_id, @request_id, @decision_id, @subject_digest, @kind, @subject, @actor_id, @evidence, @reason, @recorded_by, @recorded_at, @row_digest)`,
  );
  const updateHead = db.prepare('UPDATE approval_head SET sequence = ?, chain_digest = ?, signature_json = ?, updated_at = ? WHERE id = 1');

  let closed = false;
  const open = (): void => {
    if (closed) throw new ApprovalAuthorityError('APPROVAL_STORE_CLOSED', 'The approval store is closed.');
  };
  // Appends are serialized in-process: each one extends exactly the head it verified.
  let tail: Promise<unknown> = Promise.resolve();

  async function appendOnce(content: ApprovalRowContent): Promise<StoredApprovalRecord> {
    open();
    if (content.organizationId !== organizationId) throw new ApprovalAuthorityError('APPROVAL_INVALID', 'The record belongs to another organization than this store.');
    // Never extend a state that does not verify: a forged history is not a base to build on.
    const { state } = verifiedState();
    const sequence = state.sequence + 1;
    const digest = approvalRowDigest(state.storeId, sequence, content);
    const next: ApprovalStateCommitment = { ...state, sequence, chainDigest: nextApprovalChainDigest(state.chainDigest, digest) };
    // Signed before the write transaction; nothing is written if signing fails.
    const signature = await signer.signApprovalState(next);
    const updatedAt = options.now();
    const commitLocal = (): void => db.transaction(() => {
      // Under the write lock, the whole history is verified again and must
      // still be exactly the state the new head was signed over: a row
      // tampered between planning and commit is never laundered into a new
      // valid signature.
      const current = verifiedState().state;
      if (current.sequence !== state.sequence || current.chainDigest !== state.chainDigest || current.storeId !== state.storeId) {
        corrupt('The approval store changed while a record was being appended; nothing was written.');
      }
      insert.run({
        sequence,
        organization_id: content.organizationId,
        request_id: content.requestId,
        decision_id: content.decisionId,
        subject_digest: content.subjectDigest,
        kind: content.kind,
        subject: content.subject ?? null,
        actor_id: content.actorId ?? null,
        evidence: content.evidence ?? null,
        reason: content.reason ?? null,
        recorded_by: content.recordedBy,
        recorded_at: content.recordedAt,
        row_digest: digest,
      });
      updateHead.run(sequence, next.chainDigest, JSON.stringify(signature), updatedAt);
      // Read back through the same verification every later read runs
      // (CORE-02): a head signature this deployment would refuse — from any
      // signer — rolls the whole append back rather than leaving a store that
      // every later read refuses.
      verifiedState();
    }).immediate();
    // CORE-07: prepare at the witness, commit here, then finalize. `prepare`
    // completes before the write transaction opens and `finalize` runs after it
    // commits — no network call inside it. A witness that does not prepare
    // leaves nothing written.
    if (session === undefined) commitLocal();
    else await session.transition(approvalStateCheckpoint(state), approvalStateCheckpoint(next), () => (commitLocal(), { value: undefined, state: approvalStateCheckpoint(next) }));
    return Object.freeze({ ...content, sequence, digest });
  }

  const store: ApprovalStore = {
    kind: 'durable-authenticated',
    append(content: ApprovalRowContent): Promise<StoredApprovalRecord> {
      const result = tail.then(() => appendOnce(content));
      tail = result.catch(() => undefined);
      return result;
    },
    read(readOrganizationId: string, requestId?: string): Promise<readonly StoredApprovalRecord[]> {
      try {
        open();
        if (readOrganizationId !== organizationId) return Promise.resolve([]);
        return Promise.resolve(rowsForRequest(verifiedState().rows, requestId));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
      return Promise.resolve();
    },
  };
  // CORE-02: which custody signs for this store (software or external).
  bindStoreSignerCustody(store, signer);
  // CORE-07: which freshness boundary this store was composed under, if any.
  if (freshness !== undefined) markComposedUnderFreshness(store, freshness.boundary);
  return store;
}
