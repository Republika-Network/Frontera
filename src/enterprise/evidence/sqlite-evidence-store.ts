import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import { EVIDENCE_BUNDLE_SCHEMA_VERSION, EVIDENCE_BUNDLE_SCHEMA_VERSION_V2, type EvidenceBundle, type EvidenceBundleRecord, type EvidenceBundleState } from './contracts.js';
import { EvidenceError } from './errors.js';
import { EVIDENCE_STORE_LIST_LIMIT, canSeeEvidenceBundle, isActivePredecessor, isForwardEvidenceTransition, requireEvidenceReadScope, type EvidenceStore, type EvidenceStoreHealth, type StoreEvidenceBundleOptions } from './evidence-store.js';
import { bundleDigestInput, bundleDigestInputV2 } from './projector.js';

/**
 * ASSURE-01 — the durable Evidence Bundle Store.
 *
 * Its own SQLite file (never the Governance Store's: bundles are projections,
 * not the record). One row per bundle holds the bundle's exact canonical bytes
 * and the identities it was stored under, sealed by a row digest; the only
 * mutable columns are the lifecycle bookkeeping (`state`, `superseded_by`),
 * moved forward only by SQL triggers and mirrored by an append-only transition
 * log. Every read re-derives the bundle's own digest from its bytes, re-checks
 * the row digest, the identity columns and the lifecycle against the log, and
 * refuses — never repairs — anything that does not hold
 * (`EVIDENCE_STORE_CORRUPT`).
 *
 * The digests are unkeyed: a writer able to rewrite a row *and* recompute its
 * digests defeats them (integrity, not authenticity — ASSURE-02).
 */
export const EVIDENCE_STORE_SCHEMA_VERSION = 'aoc.evidence-bundle-store.schema.v1';

const ROW_DIGEST_DOMAIN = 'aoc.evidence-bundle-store.row.v1';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS evidence_bundle_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence_bundles (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL UNIQUE,
    organization_id TEXT,
    evaluation_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    bundle_version TEXT NOT NULL,
    bundle_json TEXT NOT NULL,
    bundle_digest TEXT NOT NULL,
    stored_at TEXT NOT NULL,
    row_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('GENERATED', 'VERIFIED', 'EXPORTED', 'SUPERSEDED')),
    superseded_by TEXT,
    CHECK ((state = 'SUPERSEDED') = (superseded_by IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS evidence_bundles_by_evaluation ON evidence_bundles(evaluation_id, sequence);
  CREATE INDEX IF NOT EXISTS evidence_bundles_by_decision ON evidence_bundles(decision_id, sequence);
  CREATE INDEX IF NOT EXISTS evidence_bundles_by_request ON evidence_bundles(request_id, sequence);

  CREATE TABLE IF NOT EXISTS evidence_bundle_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    superseded_by TEXT,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS evidence_bundle_transitions_by_bundle ON evidence_bundle_transitions(bundle_id, id);

  CREATE TRIGGER IF NOT EXISTS evidence_bundles_no_delete
    BEFORE DELETE ON evidence_bundles
    BEGIN SELECT RAISE(ABORT, 'evidence bundles are never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS evidence_bundles_content_immutable
    BEFORE UPDATE OF sequence, bundle_id, organization_id, evaluation_id, decision_id, request_id, bundle_version, bundle_json, bundle_digest, stored_at, row_digest ON evidence_bundles
    BEGIN SELECT RAISE(ABORT, 'evidence bundle content is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS evidence_bundles_lifecycle_forward_only
    BEFORE UPDATE OF state, superseded_by ON evidence_bundles
    WHEN OLD.state = 'SUPERSEDED'
      OR NOT ((OLD.state = 'GENERATED' AND NEW.state IN ('VERIFIED', 'EXPORTED', 'SUPERSEDED'))
           OR (OLD.state = 'VERIFIED' AND NEW.state IN ('EXPORTED', 'SUPERSEDED'))
           OR (OLD.state = 'EXPORTED' AND NEW.state = 'SUPERSEDED'))
    BEGIN SELECT RAISE(ABORT, 'evidence bundle lifecycle moves forward only'); END;
  CREATE TRIGGER IF NOT EXISTS evidence_bundle_transitions_append_only_update
    BEFORE UPDATE ON evidence_bundle_transitions
    BEGIN SELECT RAISE(ABORT, 'evidence bundle transitions are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS evidence_bundle_transitions_append_only_delete
    BEFORE DELETE ON evidence_bundle_transitions
    BEGIN SELECT RAISE(ABORT, 'evidence bundle transitions are append-only'); END;
`;

export interface CreateSqliteEvidenceStoreOptions {
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurableEvidenceStore extends EvidenceStore {
  readonly providerKind: 'sqlite';
  /**
   * Re-verifies every stored row (digests, identities, lifecycle against its
   * log) and returns how many there are. A maintenance read for restore
   * verification (PROD-02 registry), never exposed over HTTP. Throws
   * `EVIDENCE_STORE_CORRUPT` on the first row that does not hold.
   */
  verifyAll(): Promise<{ readonly bundles: number }>;
}

interface BundleRow {
  readonly sequence: unknown;
  readonly bundle_id: unknown;
  readonly organization_id: unknown;
  readonly evaluation_id: unknown;
  readonly decision_id: unknown;
  readonly request_id: unknown;
  readonly bundle_version: unknown;
  readonly bundle_json: unknown;
  readonly bundle_digest: unknown;
  readonly stored_at: unknown;
  readonly row_digest: unknown;
  readonly state: unknown;
  readonly superseded_by: unknown;
}

interface TransitionRow {
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly superseded_by: unknown;
}

function unavailable(message: string): EvidenceError {
  return new EvidenceError('EVIDENCE_STORE_UNAVAILABLE', message);
}

function corrupt(bundleId: string, what: string): EvidenceError {
  return new EvidenceError('EVIDENCE_STORE_CORRUPT', `The stored Evidence Bundle '${bundleId}' failed validation (${what}). Refused, never repaired.`, { bundleId, check: what });
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}, received '${String(value)}'.`);
  }
  return timeout;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

interface RowIdentity {
  readonly bundleId: string;
  readonly organizationId: string | null;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly bundleVersion: string;
  readonly bundleJson: string;
  readonly bundleDigest: string;
  readonly storedAt: string;
}

/** The row digest seals every immutable column, including the exact stored bytes. */
export function evidenceBundleRowDigest(row: RowIdentity): string {
  return computeDigest({ domain: ROW_DIGEST_DOMAIN, ...row });
}

/** The bundle's own self-digest, recomputed from its content under its own version's rule. */
function recomputedBundleDigest(bundle: EvidenceBundle): string | undefined {
  const { integrity: _integrity, ...rest } = bundle;
  void _integrity;
  if (bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION) return computeDigest(bundleDigestInput(rest));
  if (bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION_V2) return computeDigest(bundleDigestInputV2(rest));
  return undefined;
}

const STATES: ReadonlySet<string> = new Set(['GENERATED', 'VERIFIED', 'EXPORTED', 'SUPERSEDED']);

export async function createSqliteEvidenceStore(dbPath: string, options: CreateSqliteEvidenceStoreOptions): Promise<DurableEvidenceStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The Evidence Bundle Store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The Evidence Bundle Store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);

    // The version guard runs before `CREATE TABLE IF NOT EXISTS`, so a file
    // written under a schema this runtime does not implement is refused unmutated.
    if (tableExists(db, 'evidence_bundle_store_versions')) {
      const existing = db.prepare(`SELECT schema_version FROM evidence_bundle_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
      if (existing !== undefined && existing.schema_version !== EVIDENCE_STORE_SCHEMA_VERSION) {
        throw unavailable(`The Evidence Bundle Store is recorded under schema version '${String(existing.schema_version)}', which this runtime does not implement (expected '${EVIDENCE_STORE_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (existing === undefined && tableExists(db, 'evidence_bundles') && db.prepare('SELECT 1 FROM evidence_bundles LIMIT 1').get() !== undefined) {
        throw unavailable('The Evidence Bundle Store holds bundle rows but an empty schema version record. Refusing to open it.');
      }
    } else if (tableExists(db, 'evidence_bundles')) {
      throw unavailable('The Evidence Bundle Store holds bundle rows but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA_V1);
    const latest = db.prepare(`SELECT schema_version FROM evidence_bundle_store_versions ORDER BY id DESC LIMIT 1`).get();
    if (latest === undefined) {
      db.prepare(`INSERT INTO evidence_bundle_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EVIDENCE_STORE_SCHEMA_VERSION, now());
    }
  } catch (error) {
    db.close();
    throw error instanceof EvidenceError ? error : unavailable(`The Evidence Bundle Store could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }

  const COLUMNS = 'sequence, bundle_id, organization_id, evaluation_id, decision_id, request_id, bundle_version, bundle_json, bundle_digest, stored_at, row_digest, state, superseded_by';
  const selectById = db.prepare(`SELECT ${COLUMNS} FROM evidence_bundles WHERE bundle_id = ?`);
  // Bounded: the newest LIMIT rows, returned oldest first.
  const listBy = (column: 'evaluation_id' | 'decision_id' | 'request_id') =>
    db.prepare(`SELECT * FROM (SELECT ${COLUMNS} FROM evidence_bundles WHERE ${column} = ? ORDER BY sequence DESC LIMIT ${EVIDENCE_STORE_LIST_LIMIT}) ORDER BY sequence ASC`);
  const listByEvaluation = listBy('evaluation_id');
  const listByDecision = listBy('decision_id');
  const listByRequest = listBy('request_id');
  const selectTransitions = db.prepare(`SELECT from_state, to_state, superseded_by FROM evidence_bundle_transitions WHERE bundle_id = ? ORDER BY id ASC`);
  const insertBundle = db.prepare(
    `INSERT INTO evidence_bundles (bundle_id, organization_id, evaluation_id, decision_id, request_id, bundle_version, bundle_json, bundle_digest, stored_at, row_digest, state, superseded_by)
     VALUES (@bundleId, @organizationId, @evaluationId, @decisionId, @requestId, @bundleVersion, @bundleJson, @bundleDigest, @storedAt, @rowDigest, 'GENERATED', NULL)`,
  );
  const updateState = db.prepare(`UPDATE evidence_bundles SET state = @state, superseded_by = @supersededBy WHERE bundle_id = @bundleId`);
  const insertTransition = db.prepare(`INSERT INTO evidence_bundle_transitions (bundle_id, from_state, to_state, superseded_by, recorded_at) VALUES (?, ?, ?, ?, ?)`);

  let closed = false;
  function assertOpen(): void {
    if (closed) throw unavailable('The Evidence Bundle Store has been closed.');
  }

  /** Decodes and fully verifies one row. Anything that does not hold is refused. */
  function decode(row: BundleRow): EvidenceBundleRecord {
    const bundleId = typeof row.bundle_id === 'string' ? row.bundle_id : '<unknown>';
    const textOf = (value: unknown, column: string): string => {
      if (typeof value !== 'string') throw corrupt(bundleId, `${column} is not text`);
      return value;
    };
    const organizationId = row.organization_id === null ? null : textOf(row.organization_id, 'organization_id');
    const identity: RowIdentity = {
      bundleId,
      organizationId,
      evaluationId: textOf(row.evaluation_id, 'evaluation_id'),
      decisionId: textOf(row.decision_id, 'decision_id'),
      requestId: textOf(row.request_id, 'request_id'),
      bundleVersion: textOf(row.bundle_version, 'bundle_version'),
      bundleJson: textOf(row.bundle_json, 'bundle_json'),
      bundleDigest: textOf(row.bundle_digest, 'bundle_digest'),
      storedAt: textOf(row.stored_at, 'stored_at'),
    };
    if (evidenceBundleRowDigest(identity) !== textOf(row.row_digest, 'row_digest')) throw corrupt(bundleId, 'row-digest');
    let bundle: EvidenceBundle;
    try {
      bundle = JSON.parse(identity.bundleJson) as EvidenceBundle;
    } catch {
      throw corrupt(bundleId, 'bundle-json');
    }
    if (typeof bundle !== 'object' || bundle === null || typeof bundle.integrity !== 'object' || bundle.integrity === null) throw corrupt(bundleId, 'bundle-shape');
    if (
      bundle.bundleId !== bundleId ||
      bundle.bundleVersion !== identity.bundleVersion ||
      bundle.source?.evaluationId !== identity.evaluationId ||
      bundle.source?.decisionId !== identity.decisionId ||
      bundle.source?.requestId !== identity.requestId ||
      bundle.integrity.bundleDigest !== identity.bundleDigest
    ) {
      throw corrupt(bundleId, 'identity');
    }
    if (recomputedBundleDigest(bundle) !== identity.bundleDigest) throw corrupt(bundleId, 'bundle-digest');

    const state = textOf(row.state, 'state');
    if (!STATES.has(state)) throw corrupt(bundleId, 'state');
    const supersededBy = row.superseded_by === null ? undefined : textOf(row.superseded_by, 'superseded_by');
    if ((state === 'SUPERSEDED') !== (supersededBy !== undefined)) throw corrupt(bundleId, 'lifecycle');
    // The lifecycle is the replay of its own append-only log.
    let replayed: EvidenceBundleState = 'GENERATED';
    let replayedBy: string | undefined;
    for (const transition of selectTransitions.all(bundleId) as TransitionRow[]) {
      if (transition.from_state !== replayed || typeof transition.to_state !== 'string' || !STATES.has(transition.to_state) || !isForwardEvidenceTransition(replayed, transition.to_state as EvidenceBundleState)) {
        throw corrupt(bundleId, 'lifecycle-log');
      }
      replayed = transition.to_state as EvidenceBundleState;
      replayedBy = typeof transition.superseded_by === 'string' ? transition.superseded_by : undefined;
    }
    if (replayed !== state || replayedBy !== supersededBy) throw corrupt(bundleId, 'lifecycle-log');

    return {
      bundle,
      state: state as EvidenceBundleState,
      storedAt: identity.storedAt,
      ...(organizationId !== null ? { organizationId } : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
    };
  }

  function load(bundleId: string): EvidenceBundleRecord | undefined {
    const row = selectById.get(bundleId) as BundleRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  function transitionNow(bundleId: string, to: EvidenceBundleState, supersededBy?: string): EvidenceBundleRecord {
    const current = load(bundleId);
    if (current === undefined) throw new EvidenceError('EVIDENCE_BUNDLE_NOT_FOUND', `No Evidence Bundle for bundleId '${bundleId}'.`);
    if (!isForwardEvidenceTransition(current.state, to)) return current;
    updateState.run({ bundleId, state: to, supersededBy: supersededBy ?? null });
    insertTransition.run(bundleId, current.state, to, supersededBy ?? null, now());
    return { ...current, state: to, ...(supersededBy !== undefined ? { supersededBy } : {}) };
  }

  const runStore = db.transaction((bundle: EvidenceBundle, organizationId: string | undefined, requested: readonly string[], supersedeActive: boolean): EvidenceBundleRecord => {
    if (selectById.get(bundle.bundleId) !== undefined) {
      throw new EvidenceError('EVIDENCE_BUNDLE_ALREADY_EXISTS', `bundleId '${bundle.bundleId}' was already stored; Bundles are immutable and never overwritten.`);
    }
    // Read under the write lock, so a concurrent build is seen.
    const active = supersedeActive ? (selectActiveByRequest.all(bundle.source.requestId, organizationId ?? null, bundle.bundleVersion) as BundleRow[]).map(decode).filter((entry) => isActivePredecessor(entry, bundle, organizationId)).map((entry) => entry.bundle.bundleId) : [];
    const supersedes = [...new Set([...requested, ...active])];
    const predecessors = supersedes.map((id) => {
      const previous = load(id);
      if (previous === undefined) throw new EvidenceError('EVIDENCE_BUNDLE_NOT_FOUND', `No Evidence Bundle for bundleId '${id}'.`);
      if (previous.organizationId !== organizationId || previous.bundle.source.requestId !== bundle.source.requestId) {
        throw new EvidenceError('EVIDENCE_ACCESS_SCOPE_VIOLATION', 'A Bundle may only supersede an earlier Bundle of the same organization and request.');
      }
      return previous;
    });
    const identity: RowIdentity = {
      bundleId: bundle.bundleId,
      organizationId: organizationId ?? null,
      evaluationId: bundle.source.evaluationId,
      decisionId: bundle.source.decisionId,
      requestId: bundle.source.requestId,
      bundleVersion: bundle.bundleVersion,
      bundleJson: JSON.stringify(bundle),
      bundleDigest: bundle.integrity.bundleDigest,
      storedAt: now(),
    };
    insertBundle.run({ ...identity, rowDigest: evidenceBundleRowDigest(identity) });
    for (const previous of predecessors) transitionNow(previous.bundle.bundleId, 'SUPERSEDED', bundle.bundleId);
    // Read back through the verifying decoder: what was written is what is returned.
    const stored = load(bundle.bundleId);
    if (stored === undefined) throw unavailable('The stored Evidence Bundle could not be read back.');
    return stored;
  });

  // Active bundles of one request, organization and version: at most one per disclosure policy (five), never a scan of history.
  const selectActiveByRequest = db.prepare(
    `SELECT ${COLUMNS} FROM evidence_bundles WHERE request_id = ? AND organization_id IS ? AND bundle_version = ? AND state != 'SUPERSEDED' ORDER BY sequence DESC LIMIT ${EVIDENCE_STORE_LIST_LIMIT}`,
  );
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM evidence_bundles ORDER BY sequence ASC`);
  const runVerifyAll = db.transaction(() => (selectAll.all() as BundleRow[]).map(decode).length);
  const runTransition = db.transaction((bundleId: string, to: EvidenceBundleState, supersededBy?: string) => transitionNow(bundleId, to, supersededBy));
  const runRead = db.transaction((bundleId: string) => load(bundleId));
  const runList = db.transaction((statement: 'evaluation' | 'decision' | 'request', id: string) =>
    ((statement === 'evaluation' ? listByEvaluation : statement === 'decision' ? listByDecision : listByRequest).all(id) as BundleRow[]).map(decode),
  );

  const list = (context: GovernanceStoreAccessContext, statement: 'evaluation' | 'decision' | 'request', id: string): readonly EvidenceBundleRecord[] => {
    assertOpen();
    requireEvidenceReadScope(context);
    if (typeof id !== 'string' || id.length === 0) return [];
    return runList(statement, id).filter((record) => canSeeEvidenceBundle(context, record.organizationId));
  };

  return {
    providerKind: 'sqlite',

    async store(bundle: EvidenceBundle, storeOptions: StoreEvidenceBundleOptions = {}) {
      assertOpen();
      if (typeof bundle?.bundleId !== 'string' || bundle.bundleId.length === 0 || typeof bundle.source !== 'object' || typeof bundle.integrity !== 'object') {
        throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'Only a built Evidence Bundle can be stored.');
      }
      if (recomputedBundleDigest(bundle) !== bundle.integrity.bundleDigest) {
        throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'The Bundle does not match its own digest; it is not stored.');
      }
      const organizationId = storeOptions.organizationId ?? bundle.source.organizationId;
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return runStore.immediate(bundle, organizationId, storeOptions.supersedes ?? [], storeOptions.supersedeActive === true);
    },

    async getByBundleId(context, bundleId) {
      assertOpen();
      requireEvidenceReadScope(context);
      if (typeof bundleId !== 'string' || bundleId.length === 0) return null;
      const record = runRead(bundleId);
      return record !== undefined && canSeeEvidenceBundle(context, record.organizationId) ? record : null;
    },

    async listByEvaluationId(context, evaluationId) {
      return list(context, 'evaluation', evaluationId);
    },
    async listByDecisionId(context, decisionId) {
      return list(context, 'decision', decisionId);
    },
    async listByRequestId(context, requestId) {
      return list(context, 'request', requestId);
    },

    async markVerified(bundleId) {
      assertOpen();
      return runTransition.immediate(bundleId, 'VERIFIED');
    },
    async markExported(bundleId) {
      assertOpen();
      return runTransition.immediate(bundleId, 'EXPORTED');
    },
    async supersede(bundleId, replacementBundleId) {
      assertOpen();
      if (runRead(replacementBundleId) === undefined) throw new EvidenceError('EVIDENCE_BUNDLE_NOT_FOUND', `No Evidence Bundle for bundleId '${replacementBundleId}'.`);
      return runTransition.immediate(bundleId, 'SUPERSEDED', replacementBundleId);
    },

    async verifyAll() {
      assertOpen();
      return { bundles: runVerifyAll() };
    },

    async health(): Promise<EvidenceStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM evidence_bundle_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
          readable = version?.schema_version === EVIDENCE_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: EVIDENCE_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
