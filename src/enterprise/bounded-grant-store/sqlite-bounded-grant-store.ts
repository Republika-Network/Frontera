import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  BOUNDED_GRANT_STORE_SCHEMA_VERSION,
  GRANT_REASON_CODES,
  boundedGrantDigestMatches,
  isGrantRevocationReason,
  serializeBoundedGrant,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantRevocation,
  type IssueBoundedGrantInput,
  type IssueBoundedGrantOutcome,
  type ReadBoundedGrantResult,
  type RevokeBoundedGrantInput,
  type RevokeBoundedGrantOutcome,
} from '../../features/grant-runtime/index.js';
import { BoundedGrantStoreError } from './errors.js';
import {
  serializeStoredRevocationRecord,
  storedGrantRecordDigest,
  storedRevocationRecordDigest,
} from './bounded-grant-record.js';

/**
 * The durable authoritative bounded-grant store.
 *
 * `createInMemoryBoundedGrantStore` proves the vertical slice and loses
 * everything on restart — which fails *closed*, because a grant and its
 * revocation disappear together. This implementation keeps both, and the whole
 * design is organised around the one shape that would fail **open**:
 *
 * ```
 * grant survives a restart, its revocation does not  ->  revoked authority usable again
 * ```
 *
 * So the governing rule is that a grant's durability is never stronger than
 * its revocation's, and it is honoured structurally rather than by discipline:
 *
 * 1. **One database file.** A grant and its revocation are rows in the same
 *    SQLite file, so there is no configuration in which one is durable and the
 *    other is not, no second connection to lag, and no replication seam between
 *    them.
 * 2. **One transaction.** Every authority-bearing transition is a single
 *    synchronous `db.transaction(...)`. A revocation's row and the pointer to
 *    it on the grant's row commit together or not at all.
 * 3. **One fsync discipline.** `journal_mode = WAL` with `synchronous = FULL`
 *    means a commit is durable before it returns, so an acknowledgement is
 *    never ahead of the state that preserves it.
 * 4. **Two records that vouch for each other.** The grant row carries the
 *    digest of its revocation record; the revocation row carries the record
 *    itself. Either one missing while the other stands is *inconsistent
 *    authority state*, and the read refuses rather than resolving the
 *    disagreement — and the only direction a disagreement could ever be
 *    resolved in is "usable", which is precisely the direction that must never
 *    be taken.
 *
 * ## No cache, no sweeper, no background job
 *
 * There is no in-process copy of any grant or revocation. Every `read` goes to
 * the database, inside a transaction, and verifies integrity before returning.
 * Expiry is still derived by the caller from the instant it passes in; nothing
 * here schedules, sweeps or polls, and stopping every background job in the
 * deployment changes no answer this store gives.
 *
 * ## Integrity is not authenticity
 *
 * Both record digests are **unkeyed** SHA-256, the same limit
 * `boundedGrantDigest` and the Governance Store's `computeDigest` already
 * state. They detect accidental corruption, partial writes and casual
 * mutation. They do **not** stop a writer who can rewrite a record and
 * recompute its digest, and nothing here may be described as tamper-proof or
 * as a signature. `docs/security/AUTHORITATIVE_GRANT_STORE.md` §10 states the
 * boundary; Prompt 5 owns the key.
 *
 * ## Concurrency
 *
 * `better-sqlite3` is synchronous, so no other in-process caller can interleave
 * inside a transaction — which is what lets `commitGuard` be *honoured* rather
 * than merely called, exactly as the in-memory store's critical section does.
 * Across processes, the `PRIMARY KEY` on both tables and SQLite's own write
 * serialization make duplicate issuance and duplicate revocation deterministic;
 * `busy_timeout` bounds the wait before a locked file fails rather than blocks
 * forever. §12 of the security document states what this does and does not
 * amount to.
 */

export interface CreateSqliteBoundedGrantStoreOptions {
  /** Records when a row was committed. Bookkeeping only: no authorization decision reads it, and expiry is still derived from the instant a caller passes to the assessment. */
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface BoundedGrantStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}

/** The durable store, plus the lifecycle surface a host needs. The exercise path is handed only `BoundedGrantReaderPort`; nothing below widens what it can reach. */
export interface DurableBoundedGrantStore extends BoundedGrantStorePort {
  readonly providerKind: 'sqlite';
  health(): Promise<BoundedGrantStoreHealth>;
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema (`aoc.bounded-grant-store.schema.v1`), two tables:
//
//   bounded_grants           one row per issued grant, immutable except for
//                            `revocation_digest`, which is set once, inside the
//                            same transaction that writes the revocation row.
//   bounded_grant_revocations  one row per revoked grant, `grant_id` as the
//                            primary key so at most one revocation per grant is
//                            enforced by the database and not only by the
//                            application check performed before insert.
//
// `revocation_digest` is deliberately *not* a status field. It never says
// anything the revocation row does not; its only job is that deleting the
// revocation row leaves evidence a read can detect. The two are written
// together and disagreement is refused, so this is a cross-check, never a
// second settable source of truth — the thing `bounded-grant.ts` refuses when
// it declines to put a lifecycle status on the artifact.
// ---------------------------------------------------------------------------
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS bounded_grant_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bounded_grants (
    grant_id TEXT PRIMARY KEY,
    grant_json TEXT NOT NULL,
    grant_digest TEXT NOT NULL,
    revocation_digest TEXT,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bounded_grant_revocations (
    grant_id TEXT PRIMARY KEY REFERENCES bounded_grants(grant_id),
    revoked_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    issuer_ref TEXT NOT NULL,
    revocation_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );
`;

interface GrantRow {
  readonly grant_id: string;
  readonly grant_json: string;
  readonly grant_digest: string;
  readonly revocation_digest: string | null;
  readonly schema_version: string;
}

interface RevocationRow {
  readonly grant_id: string;
  readonly revoked_at: string;
  readonly reason: string;
  readonly issuer_ref: string;
  readonly revocation_digest: string;
  readonly schema_version: string;
}

function corrupt(grantId: string, what: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError(
    'BOUNDED_GRANT_STORE_STATE_CORRUPT',
    `Persisted authority state for grant '${grantId}' failed validation (${what}). The store refuses to answer from state it cannot validate.`,
  );
}

function unavailable(message: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError('BOUNDED_GRANT_STORE_UNAVAILABLE', message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reconstructs a grant from its persisted bytes, or reports that it cannot.
 *
 * Deliberately total and deliberately unforgiving. A field of the wrong type, a
 * missing field, an extra field, a different key order — every one of them
 * makes this return `undefined`, and the caller turns that into a refusal. The
 * final equality is what makes the rule complete: whatever is returned must
 * re-serialize to **exactly** the bytes on disk, so there is no shape this can
 * quietly normalize into a usable grant. That is `GS-INV-011`, "no silent
 * repair", expressed as code rather than as a promise.
 */
function parseStoredGrant(grantJson: string): BoundedGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(grantJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const correlation = parsed.correlation;
  const scope = parsed.scope;
  if (!isRecord(correlation) || !isRecord(scope)) return undefined;

  const id = stringField(parsed, 'id');
  const subject = stringField(parsed, 'subject');
  const issuedAt = stringField(parsed, 'issuedAt');
  const expiresAt = stringField(parsed, 'expiresAt');
  const sourceDigest = stringField(parsed, 'sourceDigest');
  const digest = stringField(parsed, 'digest');
  const requestId = stringField(correlation, 'requestId');
  const decisionId = stringField(correlation, 'decisionId');
  const action = stringField(correlation, 'action');
  const resourceScope = stringField(correlation, 'resourceScope');

  if (
    id === undefined ||
    subject === undefined ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    sourceDigest === undefined ||
    digest === undefined ||
    requestId === undefined ||
    decisionId === undefined ||
    action === undefined ||
    resourceScope === undefined
  ) {
    return undefined;
  }

  // The scope's bounds are carried through without re-typing their interiors:
  // the round-trip equality below is what proves they are exactly what was
  // written, and it proves it for every axis at once rather than one predicate
  // per bound kind that a new kind could outrun.
  const grant = {
    id,
    correlation: { requestId, decisionId, action, resourceScope },
    subject,
    scope: scope as BoundedGrant['scope'],
    issuedAt,
    expiresAt,
    sourceDigest,
    digest,
  } satisfies BoundedGrant;

  return serializeBoundedGrant(grant) === grantJson ? grant : undefined;
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, received '${String(value)}'.`);
  }
  return timeout;
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

export async function createSqliteBoundedGrantStore(
  dbPath: string,
  options: CreateSqliteBoundedGrantStoreOptions = {},
): Promise<DurableBoundedGrantStore> {
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // FULL rather than NORMAL, unlike a pure audit store: an acknowledged
  // revocation that a power loss could still lose is the one failure mode this
  // whole implementation exists to remove.
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  // The version guard runs *before* `CREATE TABLE IF NOT EXISTS`, so a database
  // written by a runtime this one does not implement is refused without being
  // mutated. Unknown authority state is never reinterpreted under the current
  // schema; a migration, if one is ever needed, is explicit work.
  if (tableExists(db, 'bounded_grant_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM bounded_grant_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The bounded-grant store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${BOUNDED_GRANT_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);

  const latest = db.prepare(`SELECT schema_version FROM bounded_grant_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(BOUNDED_GRANT_STORE_SCHEMA_VERSION, now());
  } else if (latest.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) {
    db.close();
    throw unavailable(
      `The bounded-grant store is recorded under schema version '${latest.schema_version}', which this runtime does not implement (expected '${BOUNDED_GRANT_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
    );
  }

  const selectGrant = db.prepare(`SELECT grant_id, grant_json, grant_digest, revocation_digest, schema_version FROM bounded_grants WHERE grant_id = ?`);
  const selectRevocation = db.prepare(`SELECT grant_id, revoked_at, reason, issuer_ref, revocation_digest, schema_version FROM bounded_grant_revocations WHERE grant_id = ?`);
  const insertGrant = db.prepare(
    `INSERT INTO bounded_grants (grant_id, grant_json, grant_digest, revocation_digest, committed_at, schema_version) VALUES (@grantId, @grantJson, @grantDigest, NULL, @committedAt, @schemaVersion)`,
  );
  const insertRevocation = db.prepare(
    `INSERT INTO bounded_grant_revocations (grant_id, revoked_at, reason, issuer_ref, revocation_digest, committed_at, schema_version) VALUES (@grantId, @revokedAt, @reason, @issuerRef, @revocationDigest, @committedAt, @schemaVersion)`,
  );
  const linkRevocation = db.prepare(`UPDATE bounded_grants SET revocation_digest = @revocationDigest WHERE grant_id = @grantId AND revocation_digest IS NULL`);

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The bounded-grant store has been closed.');
  }

  /** The grant a row holds, proven to be the grant that was written. Throws rather than returning anything a caller could mistake for "no such grant". */
  function verifiedGrant(row: GrantRow): BoundedGrant {
    if (row.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) throw corrupt(row.grant_id, 'unrecognized record schema version');
    const grant = parseStoredGrant(row.grant_json);
    if (grant === undefined) throw corrupt(row.grant_id, 'the stored grant is not a canonical bounded grant');
    if (grant.id !== row.grant_id) throw corrupt(row.grant_id, 'the stored grant is filed under a different identity');
    if (storedGrantRecordDigest(grant) !== row.grant_digest) throw corrupt(row.grant_id, 'record digest mismatch');
    // The artifact's own digest as well as the record envelope's. They detect
    // different substitutions, so passing one is not evidence about the other.
    if (!boundedGrantDigestMatches(grant)) throw corrupt(row.grant_id, 'grant digest mismatch');
    return grant;
  }

  function verifiedRevocation(row: RevocationRow): GrantRevocation {
    if (row.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) throw corrupt(row.grant_id, 'unrecognized revocation schema version');
    if (!isGrantRevocationReason(row.reason)) throw corrupt(row.grant_id, 'the stored revocation carries a reason outside the closed vocabulary');
    const revocation: GrantRevocation = {
      grantId: row.grant_id,
      revokedAt: row.revoked_at,
      reason: row.reason,
      issuerRef: row.issuer_ref,
    };
    if (storedRevocationRecordDigest(revocation) !== row.revocation_digest) throw corrupt(row.grant_id, 'revocation record digest mismatch');
    return revocation;
  }

  /**
   * The current revocation state for a grant, cross-checked against the pointer
   * the grant row carries.
   *
   * Every disagreement throws, and that is the whole point: a revocation row
   * deleted out from under a grant leaves the pointer behind, and a pointer
   * cleared out from under a revocation leaves the row behind. Either way the
   * grant stops being readable rather than becoming exercisable again. Neither
   * is repaired — `GS-INV-011`.
   */
  function currentRevocation(grantId: string, pointer: string | null): GrantRevocation | undefined {
    const row = selectRevocation.get(grantId) as RevocationRow | undefined;
    if (row === undefined) {
      if (pointer !== null) throw corrupt(grantId, 'a committed revocation is referenced by the grant but its record is absent');
      return undefined;
    }
    const revocation = verifiedRevocation(row);
    if (pointer === null) throw corrupt(grantId, 'a revocation record exists that the grant does not reference');
    if (pointer !== row.revocation_digest) throw corrupt(grantId, 'the grant references a different revocation than the one recorded');
    return revocation;
  }

  const runIssue = db.transaction((input: IssueBoundedGrantInput): IssueBoundedGrantOutcome => {
    const existingRow = selectGrant.get(input.grant.id) as GrantRow | undefined;
    if (existingRow !== undefined) {
      // Grant identity is deterministic, so a re-delivered issuance lands here
      // rather than creating a second artifact. The existing grant is returned
      // exactly as it stands — never overwritten, never re-dated — and it is
      // verified first, because returning a corrupt grant as `already-issued`
      // would hand a caller an artifact this store cannot vouch for.
      return { outcome: 'already-issued', grant: verifiedGrant(existingRow) };
    }

    // A revocation recorded against this identity precludes issuance. Under the
    // foreign key this can only be an orphan left by tampering, and the closed
    // reading of an orphan is "this identity is revoked".
    if ((selectRevocation.get(input.grant.id) as RevocationRow | undefined) !== undefined) {
      return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
    }

    // The commit-boundary re-check, inside the transaction, against the records
    // read there. Synchronous by contract: there is no `await` between the read
    // that decides and the write that records, so no interleaving is possible.
    const precondition = input.commitGuard();
    if (!precondition.permitted) {
      return {
        outcome: 'refused',
        reasonCodes: precondition.reasonCodes.length > 0 ? precondition.reasonCodes : [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED],
      };
    }

    insertGrant.run({
      grantId: input.grant.id,
      grantJson: serializeBoundedGrant(input.grant),
      grantDigest: storedGrantRecordDigest(input.grant),
      committedAt: now(),
      schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
    });

    // Read back through the same verification path a later exercise will use.
    // A row that cannot be read as the grant that was just written is not an
    // issuance to acknowledge.
    return { outcome: 'issued', grant: verifiedGrant(selectGrant.get(input.grant.id) as GrantRow) };
  });

  const runRead = db.transaction((grantId: string): ReadBoundedGrantResult => {
    const grantRow = selectGrant.get(grantId) as GrantRow | undefined;
    if (grantRow === undefined) {
      if ((selectRevocation.get(grantId) as RevocationRow | undefined) !== undefined) {
        throw corrupt(grantId, 'a revocation record exists for a grant that does not');
      }
      return {};
    }

    const grant = verifiedGrant(grantRow);
    const revocation = currentRevocation(grantId, grantRow.revocation_digest);
    return { grant, ...(revocation !== undefined ? { revocation } : {}) };
  });

  const runRevoke = db.transaction((input: RevokeBoundedGrantInput): RevokeBoundedGrantOutcome => {
    const grantRow = selectGrant.get(input.grantId) as GrantRow | undefined;
    if (grantRow === undefined) return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] };

    // The grant's own integrity is deliberately *not* required here. Recording
    // a revocation never increases authority, and refusing to revoke a grant
    // whose record is corrupt would be the one direction this store must never
    // take: leaving an untrustworthy grant with no revocation recorded against
    // it. Revocation needs the identity, and the identity is the primary key.
    const existingRow = selectRevocation.get(input.grantId) as RevocationRow | undefined;
    if (existingRow !== undefined) {
      const existing = verifiedRevocation(existingRow);
      if (grantRow.revocation_digest !== existingRow.revocation_digest) {
        throw corrupt(input.grantId, 'the grant references a different revocation than the one recorded');
      }
      // Idempotent, and the *first* revocation stands. A second call never
      // re-dates it or rewrites its reason: the moment a grant stopped being
      // exercisable is a fact, and a later call is not new information about it.
      return { outcome: 'already-revoked', revocation: existing };
    }
    if (grantRow.revocation_digest !== null) {
      throw corrupt(input.grantId, 'a committed revocation is referenced by the grant but its record is absent');
    }

    const revocation: GrantRevocation = {
      grantId: input.grantId,
      revokedAt: input.revokedAt,
      reason: input.reason,
      issuerRef: input.issuerRef,
    };
    const revocationDigest = storedRevocationRecordDigest(revocation);
    const committedAt = now();

    insertRevocation.run({
      grantId: revocation.grantId,
      revokedAt: revocation.revokedAt,
      reason: revocation.reason,
      issuerRef: revocation.issuerRef,
      revocationDigest,
      committedAt,
      schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
    });

    // Same transaction, so the record and the grant's reference to it commit
    // together. A crash between them cannot leave a revoked grant reading as
    // live, because there is no "between them" to crash in.
    const linked = linkRevocation.run({ grantId: revocation.grantId, revocationDigest }).changes;
    if (linked !== 1) throw corrupt(input.grantId, 'the revocation could not be linked to its grant');

    return { outcome: 'revoked', revocation };
  });

  return {
    providerKind: 'sqlite',

    async issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome> {
      assertOpen();
      // `runIssue` returns only after COMMIT. With `synchronous = FULL` the
      // commit is durable before this resolves, so success is never reported
      // ahead of the state that preserves it.
      return runIssue(input);
    },

    async read(grantId: string): Promise<ReadBoundedGrantResult> {
      assertOpen();
      return runRead(grantId);
    },

    async revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome> {
      assertOpen();
      // Parity with the in-memory store: a reason outside the closed vocabulary
      // is refused before anything is read or written.
      if (!isGrantRevocationReason(input.reason)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }
      return runRevoke(input);
    },

    async health(): Promise<BoundedGrantStoreHealth> {
      let readable = false;
      try {
        db.prepare(`SELECT schema_version FROM bounded_grant_store_versions ORDER BY id DESC LIMIT 1`).get();
        readable = !closed;
      } catch {
        readable = false;
      }
      const writable = readable && !closed;
      return {
        status: readable && writable ? 'healthy' : 'unhealthy',
        readable,
        writable,
        schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
        checkedAt: now(),
      };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
