import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { bindStoreSignerCustody } from '../authority-authenticity/custody.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import { obligationDischargeStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateFreshnessBoundary,
  markComposedUnderFreshness,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
} from '../authority-state-freshness/session.js';
import {
  OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION,
  type ObligationDischargeContent,
  type ObligationDischargeCorrelation,
  type ObligationDischargeStore,
  type StoredObligationDischarge,
} from './contracts.js';
import { ObligationDischargeError } from './errors.js';
import { rowsForCorrelation, verifyObligationDischargeHistory } from './integrity.js';
import {
  nextObligationDischargeChainDigest,
  obligationDischargeGenesisDigest,
  obligationDischargeRowDigest,
  type ObligationDischargeStateCommitment,
} from './state-commitment.js';

/**
 * The durable, **authenticated** obligation discharge store (CORE-04).
 *
 * One SQLite file of its own. Its authority boundary is cryptographic, not
 * operational: every append advances a hash chain over the store's whole
 * history, and the chain head `{storeId, organizationId, sequence, chainDigest}`
 * is signed by the deployment's authority key (the same signer boundary that
 * signs grants, revocations and CORE-01's revocation state, under its own
 * domain). Every authoritative read — at open, and before every issuance
 * decision — verifies that signature against the trusted verification keys and
 * recomputes the chain over every row. A database-only writer without the key
 * can therefore neither insert, alter, delete, reorder nor transplant a
 * discharge: each changes the chain, and it cannot sign a new head.
 *
 * Append-only triggers remain as defense in depth; they are not the boundary.
 *
 * Rollback — a restore of an older, genuinely signed state — is refused while
 * the process lives by an in-process witness (sequence and digest), and across
 * restarts **only** when `freshness` is composed (CORE-07): the head is then
 * anchored at an external witness outside this file's restore domain, compared
 * at open before the store is returned, and advanced by prepare → local commit
 * → finalize on every append. What this does **not** give: protection when the
 * witness itself is restored together with this file, or against anyone who
 * holds the signing key or controls this process (CORE-02).
 */

export interface SqliteObligationDischargeStoreOptions {
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
  CREATE TABLE IF NOT EXISTS obligation_discharge_store_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    store_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS obligation_discharge_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL,
    chain_digest TEXT NOT NULL,
    signature_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS obligation_discharges (
    sequence INTEGER PRIMARY KEY,
    organization_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_scope TEXT NOT NULL,
    obligation_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    reference TEXT,
    subject_id TEXT,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    row_digest TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS obligation_discharges_no_update
    BEFORE UPDATE ON obligation_discharges
    BEGIN SELECT RAISE(ABORT, 'obligation discharges are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS obligation_discharges_no_delete
    BEFORE DELETE ON obligation_discharges
    BEGIN SELECT RAISE(ABORT, 'obligation discharges are append-only'); END;
`;

interface Row {
  readonly sequence: number;
  readonly organization_id: string;
  readonly request_id: string;
  readonly action: string;
  readonly resource_scope: string;
  readonly obligation_type: string;
  readonly source_id: string;
  readonly outcome: string;
  readonly observed_at: string;
  readonly reference: string | null;
  readonly subject_id: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly row_digest: string;
}

const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

function corrupt(message: string): never {
  throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CORRUPT', message);
}

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** Whether the file holds no schema object at all — the only state in which a new genesis may be created. */
function isEmptyDatabase(db: import('better-sqlite3').Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1`).get() === undefined;
}

function toStored(row: Row): StoredObligationDischarge {
  return {
    organizationId: row.organization_id,
    correlation: { requestId: row.request_id, action: row.action, resourceScope: row.resource_scope },
    obligationType: row.obligation_type,
    sourceId: row.source_id,
    outcome: row.outcome as StoredObligationDischarge['outcome'],
    observedAt: row.observed_at,
    ...(row.reference !== null ? { reference: row.reference } : {}),
    ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
    digest: row.row_digest,
  };
}

export async function createSqliteObligationDischargeStore(path: string, options: SqliteObligationDischargeStoreOptions): Promise<ObligationDischargeStore> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  }
  const { signer, verifier } = options.authenticity ?? {};
  if (signer === undefined || verifier === undefined || typeof signer.signObligationDischargeState !== 'function' || typeof verifier.verifyObligationDischargeState !== 'function') {
    throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_UNSUPPORTED', 'The durable obligation discharge store requires the authority signer and verifier; there is no unauthenticated durable mode.');
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
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The obligation discharge store freshness option must carry a boundary built by createAuthorityStateFreshnessBoundary for the same organization.');
  }

  function verifiedState(): { readonly state: ObligationDischargeStateCommitment; readonly rows: readonly StoredObligationDischarge[]; readonly keyId: string } {
    for (const table of ['obligation_discharge_store_meta', 'obligation_discharge_head', 'obligation_discharges']) {
      if (!tableExists(db, table)) corrupt(`The obligation discharge store is missing '${table}'; it is refused, never re-initialized.`);
    }
    const meta = db.prepare('SELECT schema_version, store_id, organization_id FROM obligation_discharge_store_meta WHERE id = 1').get() as
      | { readonly schema_version: number; readonly store_id: string; readonly organization_id: string }
      | undefined;
    if (meta === undefined) corrupt('The obligation discharge store has no identity.');
    if (meta.schema_version !== OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION) {
      throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_UNSUPPORTED', `The obligation discharge store is schema version ${String(meta.schema_version)}; this build reads only version ${String(OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION)}.`);
    }
    if (meta.organization_id !== organizationId) corrupt('The obligation discharge store belongs to another organization.');
    const head = db.prepare('SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head WHERE id = 1').get() as
      | { readonly sequence: number; readonly chain_digest: string; readonly signature_json: string }
      | undefined;
    if (head === undefined) corrupt('The obligation discharge store has no committed state.');
    const state: ObligationDischargeStateCommitment = { storeId: meta.store_id, organizationId: meta.organization_id, sequence: head.sequence, chainDigest: head.chain_digest };
    let signature: unknown;
    try {
      signature = JSON.parse(head.signature_json);
    } catch {
      signature = undefined;
    }
    const verification = verifier.verifyObligationDischargeState(state, signature);
    if (!verification.verified) corrupt(`The obligation discharge store's committed state is not authentic (${verification.failure}).`);
    const keyId = verification.keyId;
    const rows = (db.prepare('SELECT * FROM obligation_discharges ORDER BY sequence ASC').all() as Row[]).map(toStored);
    verifyObligationDischargeHistory(rows, state);
    // CORE-07: the floor established against the external witness at open. Local, synchronous, no network. First, so the freshness session records what it refused.
    session?.observe(obligationDischargeStateCheckpoint(state));
    if (witnessed !== undefined) {
      if (state.sequence < witnessed.sequence) corrupt('The obligation discharge store regressed to an earlier committed state while this process was running.');
      if (state.sequence === witnessed.sequence && state.chainDigest !== witnessed.chainDigest) corrupt('The obligation discharge store holds a different committed state at the same sequence while this process was running.');
    }
    if (witnessed === undefined || state.sequence > witnessed.sequence) witnessed = { sequence: state.sequence, chainDigest: state.chainDigest };
    return { state, rows, keyId };
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (tableExists(db, 'obligation_discharge_store_versions')) {
      throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_UNSUPPORTED', 'This obligation discharge store uses the unauthenticated v1 format, which is never upgraded into trusted authority. Remove it; no shipped release wrote it.');
    }
    if (!tableExists(db, 'obligation_discharge_store_meta')) {
      // A genesis is created only for a file that holds nothing at all. A file
      // that already has tables — rows, a head, anything — but no identity is
      // never re-initialized: that would sign a fresh, empty authority state
      // over whatever someone left there.
      if (!isEmptyDatabase(db)) corrupt('The obligation discharge store has content but no authenticated identity; it is never re-initialized.');
      // A new store: its identity and signed genesis are created together, and
      // the signature is produced before anything is written.
      // CORE-07: under freshness the genesis is enrolled at the witness before
      // it is committed here; a crash in between is adopted on the next open
      // (genesis is deterministic from the store id), and a witness holding
      // this organization's state beyond genesis refuses the empty file.
      const storeId =
        freshness === undefined
          ? `obligation-discharge-store:${randomUUID()}`
          : await freshness.boundary.genesisStoreId('obligation-discharge-state', { newStoreId: () => `obligation-discharge-store:${randomUUID()}`, genesisDigest: (id) => obligationDischargeGenesisDigest(id, organizationId) });
      const genesis: ObligationDischargeStateCommitment = { storeId, organizationId, sequence: 0, chainDigest: obligationDischargeGenesisDigest(storeId, organizationId) };
      const signature = await signer.signObligationDischargeState(genesis);
      const createdAt = options.now();
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO obligation_discharge_store_meta (id, schema_version, store_id, organization_id, created_at) VALUES (1, ?, ?, ?, ?)').run(OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION, storeId, organizationId, createdAt);
        db.prepare('INSERT INTO obligation_discharge_head (id, sequence, chain_digest, signature_json, updated_at) VALUES (1, 0, ?, ?, ?)').run(genesis.chainDigest, JSON.stringify(signature), createdAt);
      })();
    }
    // Verified before the store is handed to anything: a forged or foreign
    // store refuses the Host at startup, not at the first issuance.
    const opened = verifiedState();
    // CORE-07: freshness is established before the store is re-attested or
    // handed to anything. A rollback, fork, unheld pending transition,
    // unenrolled store or unreachable witness refuses the open.
    if (freshness !== undefined) {
      session = await freshness.boundary.establish(obligationDischargeStateCheckpoint(opened.state), () => obligationDischargeStateCheckpoint(verifiedState().state), freshness.enrollment !== undefined ? { enrollment: freshness.enrollment } : {});
    }
    // Key rotation — the CORE-01 rule, reused unchanged: a state that verifies
    // under a trusted key other than the active one is re-signed, *unchanged*,
    // under the active key, inside a transaction that verifies it again and
    // writes only if it is still exactly that state; then read back. Best
    // effort: an unavailable signer leaves a still-valid state, and the next
    // append signs under the active key anyway.
    if (opened.keyId !== signer.activeKeyId) {
      try {
        const signature = await signer.signObligationDischargeState(opened.state);
        db.transaction(() => {
          const current = verifiedState().state;
          if (current.sequence !== opened.state.sequence || current.chainDigest !== opened.state.chainDigest || current.storeId !== opened.state.storeId) return;
          db.prepare('UPDATE obligation_discharge_head SET signature_json = ? WHERE id = 1').run(JSON.stringify(signature));
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
    `INSERT INTO obligation_discharges (sequence, organization_id, request_id, action, resource_scope, obligation_type, source_id, outcome, observed_at, reference, subject_id, recorded_by, recorded_at, row_digest)
     VALUES (@sequence, @organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @row_digest)`,
  );
  const updateHead = db.prepare('UPDATE obligation_discharge_head SET sequence = ?, chain_digest = ?, signature_json = ?, updated_at = ? WHERE id = 1');

  let closed = false;
  const open = (): void => {
    if (closed) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CLOSED', 'The obligation discharge store is closed.');
  };
  // Appends are serialized in-process: each one extends exactly the head it verified.
  let tail: Promise<unknown> = Promise.resolve();

  async function appendOnce(content: ObligationDischargeContent): Promise<StoredObligationDischarge> {
    open();
    if (content.organizationId !== organizationId) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_INVALID', 'The report belongs to another organization than this store.');
    // Never extend a state that does not verify: a forged history is not a base to build on.
    const { state } = verifiedState();
    const sequence = state.sequence + 1;
    const digest = obligationDischargeRowDigest(state.storeId, sequence, content);
    const next: ObligationDischargeStateCommitment = { ...state, sequence, chainDigest: nextObligationDischargeChainDigest(state.chainDigest, digest) };
    // Signed before the write transaction; nothing is written if signing fails.
    const signature = await signer.signObligationDischargeState(next);
    const recordedAt = options.now();
    const commitLocal = (): void => db.transaction(() => {
      // Under the write lock, the whole history is verified again — signature,
      // exact row set and chain — and must still be exactly the state the new
      // head was signed over. A row tampered between planning and commit can
      // therefore never be laundered into a new valid signature.
      const current = verifiedState().state;
      if (current.sequence !== state.sequence || current.chainDigest !== state.chainDigest || current.storeId !== state.storeId) {
        corrupt('The obligation discharge store changed while a report was being recorded; nothing was written.');
      }
      insert.run({
        sequence,
        organization_id: content.organizationId,
        request_id: content.correlation.requestId,
        action: content.correlation.action,
        resource_scope: content.correlation.resourceScope,
        obligation_type: content.obligationType,
        source_id: content.sourceId,
        outcome: content.outcome,
        observed_at: content.observedAt,
        reference: content.reference ?? null,
        subject_id: content.subjectId ?? null,
        recorded_by: content.recordedBy,
        recorded_at: content.recordedAt,
        row_digest: digest,
      });
      updateHead.run(sequence, next.chainDigest, JSON.stringify(signature), recordedAt);
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
    else await session.transition(obligationDischargeStateCheckpoint(state), obligationDischargeStateCheckpoint(next), () => (commitLocal(), { value: undefined, state: obligationDischargeStateCheckpoint(next) }));
    return Object.freeze({ ...content, correlation: Object.freeze({ ...content.correlation }), sequence, digest });
  }

  const store: ObligationDischargeStore = {
    kind: 'durable-authenticated',
    append(content: ObligationDischargeContent): Promise<StoredObligationDischarge> {
      const result = tail.then(() => appendOnce(content));
      tail = result.catch(() => undefined);
      return result;
    },
    read(readOrganizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]> {
      try {
        open();
        if (readOrganizationId !== organizationId) return Promise.resolve([]);
        return Promise.resolve(rowsForCorrelation(verifiedState().rows, correlation));
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
