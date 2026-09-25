import { randomUUID } from 'node:crypto';
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
import { BoundedGrantStoreError, type BoundedGrantStoreErrorCode } from './errors.js';
import {
  revocationSetDigest,
  storedGrantRecordDigest,
  storedRevocationRecordDigest,
  type RevocationSetEntry,
  type RevocationStateCommitment,
} from './bounded-grant-record.js';
import {
  AuthoritySigningUnavailableError,
  type AuthorityArtifactSigner,
  type AuthorityArtifactVerifier,
  type AuthoritySignature,
} from '../authority-authenticity/index.js';

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
 * 5. **One signed statement of the whole revocation set (CORE-01).** Point 4
 *    alone is a cross-check between two *unsigned* facts, and deleting both
 *    halves of it — the revocation row and the pointer — used to return the
 *    grant to exactly the bytes it had before it was revoked, where it read as
 *    live. The store now also holds a signed revocation-state commitment
 *    (`bounded-grant-record.ts`): the store's identity, the number of
 *    revocations ever committed, and a digest over all of them in order. Every
 *    revocation re-signs it inside the same transaction that writes the row;
 *    every read verifies its signature and recomputes it from the rows present.
 *    "This grant was never revoked" is therefore a positive, signed statement
 *    rather than the absence of a row — and removing a revocation without the
 *    signing key produces a set the signed statement does not describe.
 *
 * ## No cache, no sweeper, no background job
 *
 * There is no in-process copy of any grant or revocation. Every `read` goes to
 * the database, inside a transaction, and verifies integrity before returning.
 * Expiry is still derived by the caller from the instant it passes in; nothing
 * here schedules, sweeps or polls, and stopping every background job in the
 * deployment changes no answer this store gives.
 *
 * ## Integrity and authenticity, side by side
 *
 * Both record digests are **unkeyed** SHA-256. They detect accidental
 * corruption, partial writes and casual mutation, with no key present — and
 * they do **not** stop a writer who can rewrite a record and recompute them.
 *
 * Beside each digest is now a **detached Ed25519 signature** over the same
 * canonical bytes, under an artifact-specific signing domain. It is verified on
 * every authoritative read, against a public key resolved from the
 * composition-supplied trusted registry, and a read whose signature does not
 * verify refuses exactly as a failed digest does. That is what closes the gap
 * the digests leave: a writer who can alter this database and recompute every
 * unkeyed digest still cannot produce authority this store will return, because
 * producing one requires a private key the database does not contain.
 *
 * Three limits stated here rather than left to be inferred. The signing key is
 * **resident in this process's memory** in the current composition, so anything
 * that can read process memory can mint authority that verifies — AA-001;
 * external key custody is CORE-02. A signature says a trusted key vouched for
 * these bytes; it says nothing about whether the *policy* that produced them
 * was legitimate. And the revocation-state commitment proves the revocation set
 * is one this store's key signed, not that it is the *latest* one: a writer who
 * kept a copy of an earlier commitment and restores it together with the rows
 * it covered has rolled the store back to an earlier authentic state (GS-002).
 * This process refuses a commitment older than one it has already verified,
 * which catches that while it runs; across a restart nothing here can, and
 * freshness/anchoring is CORE-07. `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md`
 * states all three.
 *
 * ## There is no unsigned mode
 *
 * Not a flag, not a default, not a legacy path. A row without a verifying
 * signature is refused, and a database written under the previous, unsigned
 * schema version is refused at open by the version guard rather than being
 * reinterpreted or auto-signed under the current key. Auto-signing legacy rows
 * would turn whatever a database happens to contain into authority this
 * deployment vouches for, which is the one migration that must never be
 * automatic.
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
  /**
   * The authenticity boundary, and the reason it is **required** rather than
   * optional.
   *
   * An optional signer would be a configuration in which durable authority is
   * accepted unsigned, and an optional verifier one in which it is accepted
   * unverified. Either is a permanent downgrade seam: the kind of flag that
   * exists "for compatibility" and is still there, switched off, three years
   * later. There is no such flag. A deployment that cannot supply both does not
   * get a durable authority store.
   *
   * The two halves are supplied **separately**, never as one object that can do
   * both, because that separation is the security property — see
   * `authority-authenticity/`.
   */
  readonly authenticity: {
    /** Holds private material. Reached only from `issue` and `revoke`; never from `read`. */
    readonly signer: AuthorityArtifactSigner;
    /** Public material only. This is what the authoritative read path uses, and it cannot mint authority. */
    readonly verifier: AuthorityArtifactVerifier;
  };
}

export interface BoundedGrantStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
  /**
   * Whether the signed revocation-state commitment verified against the rows
   * present (CORE-01). A store whose revocation state cannot be proven answers
   * no authoritative read, so it is never reported healthy.
   */
  readonly revocationState: 'verified' | 'failed';
  /** Why it failed: an error code, never key material, signature bytes or row contents. */
  readonly revocationStateFailure?: BoundedGrantStoreErrorCode;
  /** The number of revocations the verified commitment covers. */
  readonly revocationSequence?: number;
}

/** The durable store, plus the lifecycle surface a host needs. The exercise path is handed only `BoundedGrantReaderPort`; nothing below widens what it can reach. */
export interface DurableBoundedGrantStore extends BoundedGrantStorePort {
  readonly providerKind: 'sqlite';
  health(): Promise<BoundedGrantStoreHealth>;
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * How many times a revocation re-plans after another writer advanced the
 * revocation-state commitment while this one was signing. In-process callers
 * are serialized and never retry; this bounds cross-process contention, and
 * exhausting it throws rather than committing over a state nobody verified.
 */
const MAX_REVOCATION_ATTEMPTS = 3;

/**
 * Stores produced by `createSqliteBoundedGrantStore`, and nothing else.
 *
 * A runtime brand rather than a type: a TypeScript interface is satisfied by
 * any object of the right shape, including the in-memory store and a host's own
 * wrapper, and composition has to be able to tell those apart *at runtime* to
 * refuse a silent downgrade from authenticated durable authority to one of
 * them. Module-private, so membership cannot be granted from outside this file,
 * and the branded object is frozen, so its methods cannot be swapped afterwards.
 *
 * This is a guard against an honest composition mistake, not against a
 * malicious host: code running in the same process can replace this module
 * outright. `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` states that
 * boundary.
 */
const AUTHENTICATED_DURABLE_STORES = new WeakSet<object>();

/**
 * Whether `store` is an authenticated durable bounded-grant store — built by
 * `createSqliteBoundedGrantStore`, with a signer and a verifier, and unaltered
 * since. Anything else, including a wrapper around one, is not.
 */
export function isAuthenticatedDurableBoundedGrantStore(store: unknown): store is DurableBoundedGrantStore {
  return typeof store === 'object' && store !== null && AUTHENTICATED_DURABLE_STORES.has(store);
}

// ---------------------------------------------------------------------------
// Schema (`aoc.bounded-grant-store.schema.v3`), three tables:
//
//   bounded_grants           one row per issued grant, immutable except for
//                            `revocation_digest`, which is set once, inside the
//                            same transaction that writes the revocation row.
//   bounded_grant_revocations  one row per revoked grant, `grant_id` as the
//                            primary key so at most one revocation per grant is
//                            enforced by the database and not only by the
//                            application check performed before insert, and a
//                            `sequence` giving its position in the store's
//                            revocation order (1, 2, 3, ... with no gaps).
//   bounded_grant_revocation_state  exactly one row: the signed revocation-state
//                            commitment (store id, sequence, set digest).
//
// `revocation_digest` is deliberately *not* a status field. It never says
// anything the revocation row does not; it is kept as a cross-check whose only
// possible effect is a refusal. It is **not** what proves a grant unrevoked —
// before CORE-01 it effectively was, and clearing it together with deleting the
// revocation row made a revoked grant read as live. The signed commitment is
// what proves it now.
//
// v2 added `NOT NULL` signature columns, so the database refuses to hold an
// unsigned authority row. v3 (CORE-01) adds the commitment table and the
// `sequence` column, and binds every signed record to the store's id. A v2
// database is refused at open by the version guard below: its rows are bound
// to no store, and it holds no commitment from which the completeness of its
// revocation set could be proven. Minting one for it would sign whatever the
// file happens to contain — including a revocation set someone has already
// pruned — so there is no automatic migration, by design.
//
// The triggers are **defense in depth only**. They stop an accidental UPDATE or
// DELETE through an ordinary connection. They do not stop anyone who can write
// the file, because that person can drop them; the signature on the
// commitment is what stops that person, and the tests simulate exactly that
// attacker by dropping the triggers first.
// ---------------------------------------------------------------------------
const SCHEMA_V3 = `
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
    schema_version TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signing_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    signature_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bounded_grant_revocations (
    grant_id TEXT PRIMARY KEY REFERENCES bounded_grants(grant_id),
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
    revoked_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    issuer_ref TEXT NOT NULL,
    revocation_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signing_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    signature_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bounded_grant_revocation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    store_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    revocation_set_digest TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signing_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    signature_version TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS bounded_grants_no_delete
    BEFORE DELETE ON bounded_grants
    BEGIN SELECT RAISE(ABORT, 'bounded_grants is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS bounded_grants_link_once
    BEFORE UPDATE ON bounded_grants
    WHEN OLD.revocation_digest IS NOT NULL
      OR NEW.revocation_digest IS NULL
      OR NEW.grant_id IS NOT OLD.grant_id
      OR NEW.grant_json IS NOT OLD.grant_json
      OR NEW.grant_digest IS NOT OLD.grant_digest
      OR NEW.schema_version IS NOT OLD.schema_version
      OR NEW.signature IS NOT OLD.signature
    BEGIN SELECT RAISE(ABORT, 'a grant row changes only by linking its revocation, once'); END;

  CREATE TRIGGER IF NOT EXISTS bounded_grant_revocations_no_update
    BEFORE UPDATE ON bounded_grant_revocations
    BEGIN SELECT RAISE(ABORT, 'bounded_grant_revocations is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS bounded_grant_revocations_no_delete
    BEFORE DELETE ON bounded_grant_revocations
    BEGIN SELECT RAISE(ABORT, 'bounded_grant_revocations is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS bounded_grant_revocation_state_no_delete
    BEFORE DELETE ON bounded_grant_revocation_state
    BEGIN SELECT RAISE(ABORT, 'the revocation-state commitment is never deleted'); END;

  CREATE TRIGGER IF NOT EXISTS bounded_grant_revocation_state_advances
    BEFORE UPDATE ON bounded_grant_revocation_state
    WHEN NEW.store_id IS NOT OLD.store_id
      OR NOT (
        NEW.sequence IS OLD.sequence + 1
        OR (NEW.sequence IS OLD.sequence AND NEW.revocation_set_digest IS OLD.revocation_set_digest)
      )
    BEGIN SELECT RAISE(ABORT, 'the revocation-state commitment only advances, one revocation at a time, or is re-signed unchanged'); END;
`;

/** The tables this runtime creates. A file holding any of them without a version record is not a fresh store and is not treated as one. */
const STORE_TABLES = ['bounded_grants', 'bounded_grant_revocations', 'bounded_grant_revocation_state'] as const;

/** The four columns that carry a detached signature. Shared by both tables, because a revocation's authenticity is worth exactly as much as a grant's. */
interface SignatureColumns {
  readonly signature_algorithm: string | null;
  readonly signing_key_id: string | null;
  readonly signature: string | null;
  readonly signature_version: string | null;
}

interface GrantRow extends SignatureColumns {
  readonly grant_id: string;
  readonly grant_json: string;
  readonly grant_digest: string;
  readonly revocation_digest: string | null;
  readonly schema_version: string;
}

interface RevocationRow extends SignatureColumns {
  readonly grant_id: string;
  readonly sequence: number;
  readonly revoked_at: string;
  readonly reason: string;
  readonly issuer_ref: string;
  readonly revocation_digest: string;
  readonly schema_version: string;
}

interface RevocationStateRow extends SignatureColumns {
  readonly store_id: string;
  readonly sequence: number;
  readonly revocation_set_digest: string;
  readonly schema_version: string;
}

interface RevocationEntryRow {
  readonly sequence: number;
  readonly grant_id: string;
  readonly revocation_digest: string;
}

/**
 * The revocation state as a read has proven it: the signed commitment, and the
 * committed revocations it covers, keyed by grant id. Only ever built by
 * `verifiedRevocationState`, so holding one means every check there passed.
 */
interface VerifiedRevocationState {
  readonly commitment: RevocationStateCommitment;
  readonly entries: readonly RevocationSetEntry[];
  readonly byGrantId: ReadonlyMap<string, RevocationSetEntry>;
}

/**
 * Rebuilds the signature envelope from a row's columns.
 *
 * Returns `undefined` — which the verifier reports as
 * `AUTHORITY_SIGNATURE_MISSING` — when the signature column is absent, so a
 * `NULL` is never read as a present-but-odd signature, and never as a legacy
 * row to be trusted. The columns are `NOT NULL` in v2, so this can only be
 * reached by a writer who went around the schema; that it is reachable at all
 * is why it is checked.
 */
function signatureEnvelopeOf(row: SignatureColumns): unknown {
  if (row.signature === null || row.signature === undefined) return undefined;
  return {
    algorithm: row.signature_algorithm,
    keyId: row.signing_key_id,
    signature: row.signature,
    artifactVersion: row.signature_version,
  };
}

function corrupt(grantId: string, what: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError(
    'BOUNDED_GRANT_STORE_STATE_CORRUPT',
    `Persisted authority state for grant '${grantId}' failed validation (${what}). The store refuses to answer from state it cannot validate.`,
  );
}

/**
 * The revocation state cannot be proven complete. Not about one grant — about
 * whether the store can answer "was this revoked?" for any of them — so it
 * names no grant id.
 */
function inconsistentRevocationState(what: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError(
    'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT',
    `The bounded-grant store's revocation state cannot be proven complete (${what}). The store refuses to answer authority reads until it is restored from a trusted copy.`,
  );
}

/** The revocation-state commitment carries no signature this deployment trusts. The same code as an unauthentic record, because it calls for the same response: find out who wrote it. */
function unauthenticRevocationState(failure: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError(
    'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED',
    `The bounded-grant store's revocation-state commitment is not authentic (${failure}). The store refuses to answer from revocation state no trusted key vouches for.`,
  );
}

function unavailable(message: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError('BOUNDED_GRANT_STORE_UNAVAILABLE', message);
}

/**
 * A record no trusted authority key vouches for.
 *
 * Distinct from `corrupt` because the two mean different things to whoever
 * reads the message. A digest mismatch says the bytes moved; this says the
 * bytes may be exactly what someone intended, and that someone could not sign
 * them. The failure reason is included — it separates "unknown key" from "bad
 * signature" from "no signature", which an operator needs in order to tell a
 * mis-rotated key from a forgery attempt — and nothing else is: no signature
 * bytes and no signed payload, so an error can never hand back the canonical
 * bytes a forgery would have to be produced over.
 */
function unauthentic(grantId: string, what: string, failure: string): BoundedGrantStoreError {
  return new BoundedGrantStoreError(
    'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED',
    `Persisted authority state for grant '${grantId}' is not authentic (${what}: ${failure}). The store refuses to answer from authority no trusted key vouches for.`,
  );
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
  // Optional provenance (P7). Absent on every pre-P7 row, which therefore
  // parses exactly as before; present, it must be a string — and the
  // round-trip equality below proves it is exactly the value that was written.
  const hasProvenance = Object.prototype.hasOwnProperty.call(parsed, 'authorityBindingDigest');
  const authorityBindingDigest = stringField(parsed, 'authorityBindingDigest');
  if (hasProvenance && authorityBindingDigest === undefined) return undefined;

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
    ...(authorityBindingDigest !== undefined ? { authorityBindingDigest } : {}),
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

/**
 * Opens the durable store.
 *
 * `options` has **no default**. It used to, and removing it is deliberate: with
 * a default, a caller that simply forgot the authenticity boundary would get a
 * working store, and the only thing standing between a deployment and unsigned
 * durable authority would be everyone remembering. Now it does not compile.
 *
 * A **new** store signs its genesis revocation-state commitment here — sequence
 * 0, the empty set, under a freshly generated store id — so opening a new store
 * needs the signer. An existing store is never given a new genesis: a missing
 * commitment on an existing store is inconsistent state, not a store to
 * re-initialize, because re-initializing it would sign "nothing was revoked"
 * over whatever the file happens to contain.
 */
export async function createSqliteBoundedGrantStore(
  dbPath: string,
  options: CreateSqliteBoundedGrantStoreOptions,
): Promise<DurableBoundedGrantStore> {
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());

  // Destructured here so the two halves are named separately from the point
  // they enter this module. `verifier` is reachable from the read path;
  // `signer` is reached only from genesis, `issue` and `revoke`, and a
  // structural test pins that `runRead` and its helpers never name it.
  const { signer, verifier } = options.authenticity;

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // FULL rather than NORMAL, unlike a pure audit store: an acknowledged
  // revocation that a power loss could still lose is the one failure mode this
  // whole implementation exists to remove.
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  function refuseToOpen(message: string): never {
    db.close();
    throw unavailable(message);
  }

  // The version guard runs *before* `CREATE TABLE IF NOT EXISTS`, so a database
  // written by a runtime this one does not implement is refused without being
  // mutated. Unknown authority state is never reinterpreted under the current
  // schema; a migration, if one is ever needed, is explicit work.
  const selectLatestVersion = () =>
    tableExists(db, 'bounded_grant_store_versions')
      ? (db.prepare(`SELECT schema_version FROM bounded_grant_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined)
      : undefined;

  const fresh = !tableExists(db, 'bounded_grant_store_versions');
  if (!fresh) {
    const existing = selectLatestVersion();
    if (existing === undefined) {
      refuseToOpen('The bounded-grant store holds a version table with no version recorded. Refusing to open it rather than guessing what wrote it.');
    }
    if (existing.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) {
      refuseToOpen(
        `The bounded-grant store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${BOUNDED_GRANT_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
    db.exec(SCHEMA_V3);
  } else {
    if (STORE_TABLES.some((table) => tableExists(db, table))) {
      refuseToOpen('The bounded-grant store holds authority tables but no version record. Refusing to open it, and refusing to initialize it as a new store.');
    }

    // Genesis. Signed before the transaction opens, like every other signature
    // here; committed only if no other process initialized the file meanwhile.
    const storeId = randomUUID();
    const genesis: RevocationStateCommitment = { storeId, sequence: 0, revocationSetDigest: revocationSetDigest(storeId, []) };
    let genesisSignature: AuthoritySignature;
    try {
      genesisSignature = await signOrFail('(genesis)', () => signer.signRevocationState(genesis));
    } catch (error) {
      db.close();
      throw error;
    }
    const initialize = db.transaction(() => {
      if (tableExists(db, 'bounded_grant_store_versions')) return;
      db.exec(SCHEMA_V3);
      db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(BOUNDED_GRANT_STORE_SCHEMA_VERSION, now());
      db.prepare(
        `INSERT INTO bounded_grant_revocation_state (singleton, store_id, sequence, revocation_set_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version) VALUES (1, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(storeId, genesis.revocationSetDigest, now(), BOUNDED_GRANT_STORE_SCHEMA_VERSION, genesisSignature.algorithm, genesisSignature.keyId, genesisSignature.signature, genesisSignature.artifactVersion);
    });
    initialize.immediate();
    const recorded = selectLatestVersion();
    if (recorded === undefined || recorded.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) {
      refuseToOpen(
        `The bounded-grant store was initialized concurrently under schema version '${String(recorded?.schema_version)}', which this runtime does not implement (expected '${BOUNDED_GRANT_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  const selectGrant = db.prepare(
    `SELECT grant_id, grant_json, grant_digest, revocation_digest, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grants WHERE grant_id = ?`,
  );
  const selectRevocation = db.prepare(
    `SELECT grant_id, sequence, revoked_at, reason, issuer_ref, revocation_digest, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grant_revocations WHERE grant_id = ?`,
  );
  const selectRevocationEntries = db.prepare(`SELECT sequence, grant_id, revocation_digest FROM bounded_grant_revocations ORDER BY sequence ASC`);
  const selectRevocationState = db.prepare(
    `SELECT store_id, sequence, revocation_set_digest, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grant_revocation_state WHERE singleton = 1`,
  );
  const insertGrant = db.prepare(
    `INSERT INTO bounded_grants (grant_id, grant_json, grant_digest, revocation_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version) VALUES (@grantId, @grantJson, @grantDigest, NULL, @committedAt, @schemaVersion, @signatureAlgorithm, @signingKeyId, @signature, @signatureVersion)`,
  );
  const insertRevocation = db.prepare(
    `INSERT INTO bounded_grant_revocations (grant_id, sequence, revoked_at, reason, issuer_ref, revocation_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version) VALUES (@grantId, @sequence, @revokedAt, @reason, @issuerRef, @revocationDigest, @committedAt, @schemaVersion, @signatureAlgorithm, @signingKeyId, @signature, @signatureVersion)`,
  );
  const linkRevocation = db.prepare(`UPDATE bounded_grants SET revocation_digest = @revocationDigest WHERE grant_id = @grantId AND revocation_digest IS NULL`);
  const reattestRevocationState = db.prepare(
    `UPDATE bounded_grant_revocation_state SET signature_algorithm = @signatureAlgorithm, signing_key_id = @signingKeyId, signature = @signature, signature_version = @signatureVersion WHERE singleton = 1 AND store_id = @storeId AND sequence = @sequence AND revocation_set_digest = @revocationSetDigest`,
  );
  const advanceRevocationState = db.prepare(
    `UPDATE bounded_grant_revocation_state SET sequence = @sequence, revocation_set_digest = @revocationSetDigest, committed_at = @committedAt, signature_algorithm = @signatureAlgorithm, signing_key_id = @signingKeyId, signature = @signature, signature_version = @signatureVersion WHERE singleton = 1 AND store_id = @storeId AND sequence = @previousSequence`,
  );

  let closed = false;

  /**
   * The newest revocation-state commitment this process has verified and seen
   * committed. A limited, in-process freshness witness: a later read that finds
   * an *older* commitment — or a different one at the same sequence — has
   * found the store rolled back underneath it, and refuses. It is not a cache:
   * nothing is ever answered from it, it only ever causes a refusal, and it is
   * lost on restart, which is exactly why cross-restart rollback remains
   * CORE-07's problem.
   */
  let newestVerified: { readonly sequence: number; readonly revocationSetDigest: string } | undefined;

  function noteVerified(commitment: RevocationStateCommitment): void {
    if (newestVerified === undefined || commitment.sequence > newestVerified.sequence) {
      newestVerified = { sequence: commitment.sequence, revocationSetDigest: commitment.revocationSetDigest };
    }
  }

  function assertOpen(): void {
    if (closed) throw unavailable('The bounded-grant store has been closed.');
  }

  /**
   * The store's revocation state, proven, or a throw. Runs inside every
   * authoritative transaction, before any grant is answered for.
   *
   * The order is fixed: the commitment must exist, verify under a trusted key,
   * and then describe *exactly* the revocation rows present — same count, a
   * contiguous sequence from 1, same digest. The rows are digested by their
   * stored `revocation_digest`; each row's own content is checked against that
   * digest, and its own signature verified, when the grant it revokes is read.
   * So a row can be neither removed, added, reordered nor rewritten without the
   * commitment or that row's own checks failing — and producing a commitment
   * that agrees with a pruned set needs the authority signing key.
   */
  function verifiedRevocationState(): VerifiedRevocationState {
    const row = selectRevocationState.get() as RevocationStateRow | undefined;
    if (row === undefined) throw inconsistentRevocationState('the signed revocation-state commitment is absent');
    if (row.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) throw inconsistentRevocationState('the revocation-state commitment carries an unrecognized schema version');
    if (typeof row.store_id !== 'string' || row.store_id.length === 0) throw inconsistentRevocationState('the revocation-state commitment names no store');
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 0) throw inconsistentRevocationState('the revocation-state sequence is not a non-negative integer');

    const commitment: RevocationStateCommitment = { storeId: row.store_id, sequence: row.sequence, revocationSetDigest: row.revocation_set_digest };
    const verification = verifier.verifyRevocationState(commitment, signatureEnvelopeOf(row));
    if (!verification.verified) throw unauthenticRevocationState(verification.failure);

    const rows = selectRevocationEntries.all() as RevocationEntryRow[];
    if (rows.length !== commitment.sequence) {
      throw inconsistentRevocationState(`the signed commitment covers ${commitment.sequence} revocation(s) but ${rows.length} are recorded`);
    }
    const entries: RevocationSetEntry[] = rows.map((entry, index) => {
      if (entry.sequence !== index + 1) throw inconsistentRevocationState('the recorded revocation sequence has a gap or a duplicate');
      return { sequence: entry.sequence, grantId: entry.grant_id, revocationDigest: entry.revocation_digest };
    });
    if (revocationSetDigest(commitment.storeId, entries) !== commitment.revocationSetDigest) {
      throw inconsistentRevocationState('the recorded revocations disagree with the signed revocation-state commitment');
    }

    if (newestVerified !== undefined) {
      if (commitment.sequence < newestVerified.sequence) {
        throw inconsistentRevocationState(`the revocation-state commitment regressed from sequence ${newestVerified.sequence} to ${commitment.sequence}`);
      }
      if (commitment.sequence === newestVerified.sequence && commitment.revocationSetDigest !== newestVerified.revocationSetDigest) {
        throw inconsistentRevocationState(`the revocation-state commitment at sequence ${commitment.sequence} differs from the one already verified`);
      }
    }

    return { commitment, entries, byGrantId: new Map(entries.map((entry) => [entry.grantId, entry])) };
  }

  /** The grant a row holds, proven to be the grant that was written into this store. Throws rather than returning anything a caller could mistake for "no such grant". */
  function verifiedGrant(row: GrantRow, storeId: string): BoundedGrant {
    if (row.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) throw corrupt(row.grant_id, 'unrecognized record schema version');
    const grant = parseStoredGrant(row.grant_json);
    if (grant === undefined) throw corrupt(row.grant_id, 'the stored grant is not a canonical bounded grant');
    if (grant.id !== row.grant_id) throw corrupt(row.grant_id, 'the stored grant is filed under a different identity');
    if (storedGrantRecordDigest(grant, storeId) !== row.grant_digest) throw corrupt(row.grant_id, 'record digest mismatch');
    // The artifact's own digest as well as the record envelope's. They detect
    // different substitutions, so passing one is not evidence about the other.
    if (!boundedGrantDigestMatches(grant)) throw corrupt(row.grant_id, 'grant digest mismatch');
    // Authenticity last, and never instead of the checks above: the digests
    // answer "are these the bytes that were written", the signature answers
    // "did a trusted authority key vouch for them, in this store". A writer who
    // recomputes every digest above reaches exactly this line and stops here,
    // because the one thing they cannot recompute is a signature over their
    // new bytes.
    //
    // Verified over the grant as parsed, not over the row's raw JSON: the two
    // are already proven byte-identical by `parseStoredGrant`'s round-trip, and
    // signing the parsed artifact is what makes the check independent of how
    // the row happens to be stored.
    const verification = verifier.verifyGrant(grant, storeId, signatureEnvelopeOf(row));
    if (!verification.verified) throw unauthentic(row.grant_id, 'grant signature', verification.failure);
    return grant;
  }

  function verifiedRevocation(row: RevocationRow, storeId: string): GrantRevocation {
    if (row.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) throw corrupt(row.grant_id, 'unrecognized revocation schema version');
    if (!isGrantRevocationReason(row.reason)) throw corrupt(row.grant_id, 'the stored revocation carries a reason outside the closed vocabulary');
    const revocation: GrantRevocation = {
      grantId: row.grant_id,
      revokedAt: row.revoked_at,
      reason: row.reason,
      issuerRef: row.issuer_ref,
    };
    if (storedRevocationRecordDigest(revocation, storeId) !== row.revocation_digest) throw corrupt(row.grant_id, 'revocation record digest mismatch');
    // A revocation is authority state, at the same strength as a grant. A
    // deployment where the grant is signed and the revocation is not would make
    // the revocation the cheaper record to forge — and forging a revocation
    // away is how authority comes back, which is the direction that must never
    // be cheap.
    const verification = verifier.verifyRevocation(revocation, storeId, signatureEnvelopeOf(row));
    if (!verification.verified) throw unauthentic(row.grant_id, 'revocation signature', verification.failure);
    return revocation;
  }

  /**
   * The current revocation state for a grant, as the verified commitment
   * states it, cross-checked against the revocation row and the pointer the
   * grant row carries.
   *
   * "Not revoked" is returned only when the **signed** commitment lists no
   * revocation for this grant — a positive statement, not the absence of a row.
   * Every disagreement below throws, and none is repaired — `GS-INV-011`.
   */
  function currentRevocation(grantId: string, pointer: string | null, state: VerifiedRevocationState): GrantRevocation | undefined {
    const committed = state.byGrantId.get(grantId);
    const row = selectRevocation.get(grantId) as RevocationRow | undefined;
    if (committed === undefined) {
      if (row !== undefined) throw inconsistentRevocationState(`a revocation record for grant '${grantId}' is not covered by the signed commitment`);
      if (pointer !== null) throw corrupt(grantId, 'a committed revocation is referenced by the grant but its record is absent');
      return undefined;
    }
    if (row === undefined) throw inconsistentRevocationState(`the signed commitment covers a revocation of grant '${grantId}' whose record is absent`);
    const revocation = verifiedRevocation(row, state.commitment.storeId);
    if (row.sequence !== committed.sequence || row.revocation_digest !== committed.revocationDigest) {
      throw inconsistentRevocationState(`the revocation record for grant '${grantId}' is not the one the signed commitment covers`);
    }
    if (pointer === null) throw corrupt(grantId, 'a revocation record exists that the grant does not reference');
    if (pointer !== row.revocation_digest) throw corrupt(grantId, 'the grant references a different revocation than the one recorded');
    return revocation;
  }

  /**
   * Runs a signer call and turns any failure into a refusal to proceed.
   *
   * Every path out of here that is not a signature is a throw. There is no
   * branch in which a missing signature becomes a warning, a retry-with-nothing,
   * or a row written without one — the point at which "the signer did not
   * answer" could become "store it unsigned" is this function, and it does not
   * exist here.
   */
  async function signOrFail(grantId: string, produce: () => Promise<AuthoritySignature>): Promise<AuthoritySignature> {
    try {
      return await produce();
    } catch (error) {
      if (error instanceof AuthoritySigningUnavailableError) throw error;
      throw new AuthoritySigningUnavailableError(`The authority signer could not sign the artifact for grant '${grantId}'.`);
    }
  }

  /** The revocation state alone, proven, in its own read transaction. Used to learn the store id before signing, and by `health`. */
  const runVerifyRevocationState = db.transaction((): RevocationStateCommitment => verifiedRevocationState().commitment);

  /**
   * Key rotation for the commitment.
   *
   * Grants and revocations keep the key that signed them, and stay readable for
   * as long as that key stays trusted. The commitment is different: it is one
   * row, re-signed only when something is revoked, so a store that saw no
   * revocation since a rotation would still hold a commitment signed by the
   * *previous* key — and retiring that key would make every read in the store
   * refuse, including reads of grants signed by the new key.
   *
   * So on open, a commitment that verifies under a trusted key other than the
   * active one is re-signed, **unchanged**, under the active key. Only a
   * commitment that has just passed `verifiedRevocationState` is ever
   * re-signed, and the update is conditional on it still being exactly that
   * commitment, so this cannot sign a state nobody verified. It is best-effort:
   * a signer that is unavailable at open leaves a commitment that is still
   * valid, and the next revocation re-signs it anyway.
   */
  const runReadCommitmentKey = db.transaction((): { readonly commitment: RevocationStateCommitment; readonly keyId: string } => {
    const commitment = verifiedRevocationState().commitment;
    const { signing_key_id: keyId } = selectRevocationState.get() as RevocationStateRow;
    return { commitment, keyId: keyId ?? '' };
  });
  const runReattest = db.transaction((commitment: RevocationStateCommitment, signature: AuthoritySignature): void => {
    const current = verifiedRevocationState().commitment;
    if (current.storeId !== commitment.storeId || current.sequence !== commitment.sequence || current.revocationSetDigest !== commitment.revocationSetDigest) return;
    reattestRevocationState.run({
      storeId: commitment.storeId,
      sequence: commitment.sequence,
      revocationSetDigest: commitment.revocationSetDigest,
      signatureAlgorithm: signature.algorithm,
      signingKeyId: signature.keyId,
      signature: signature.signature,
      signatureVersion: signature.artifactVersion,
    });
    // Read back: a re-signature this deployment would refuse rolls back.
    verifiedRevocationState();
  });

  if (!fresh) {
    try {
      const { commitment, keyId } = runReadCommitmentKey();
      if (keyId !== signer.activeKeyId) {
        const signature = await signer.signRevocationState(commitment);
        runReattest.immediate(commitment, signature);
      }
    } catch {
      // Deliberately swallowed, and deliberately narrow in what it swallows:
      // nothing above writes unless verification passed. A commitment that does
      // not verify stays exactly as found, and every read reports why.
    }
  }

  /**
   * The committing half of issuance. Everything here is synchronous and inside
   * one transaction; the signature it persists was produced **before** the
   * transaction opened, and `commitGuard` runs after that signing and
   * immediately before the write. See `issue` below for why that order is the
   * whole point.
   */
  const runIssue = db.transaction((input: IssueBoundedGrantInput, signature: AuthoritySignature, storeId: string): { readonly outcome: IssueBoundedGrantOutcome; readonly state: RevocationStateCommitment } => {
    // Issuance into a store whose revocation state cannot be proven would
    // produce a grant no read could ever return; refuse it here instead.
    const state = verifiedRevocationState();
    if (state.commitment.storeId !== storeId) throw inconsistentRevocationState('the store identity changed while the grant was being signed');
    const settle = (outcome: IssueBoundedGrantOutcome) => ({ outcome, state: state.commitment });

    const existingRow = selectGrant.get(input.grant.id) as GrantRow | undefined;
    if (existingRow !== undefined) {
      // Grant identity is deterministic, so a re-delivered issuance lands here
      // rather than creating a second artifact. The existing grant is returned
      // exactly as it stands — never overwritten, never re-dated — and it is
      // verified first, because returning a corrupt grant as `already-issued`
      // would hand a caller an artifact this store cannot vouch for.
      return settle({ outcome: 'already-issued', grant: verifiedGrant(existingRow, storeId) });
    }

    // A revocation recorded against this identity precludes issuance. Under the
    // foreign key this can only be an orphan left by tampering, and the closed
    // reading of an orphan is "this identity is revoked".
    if (state.byGrantId.has(input.grant.id) || (selectRevocation.get(input.grant.id) as RevocationRow | undefined) !== undefined) {
      return settle({ outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] });
    }

    // The commit-boundary re-check, inside the transaction, against the records
    // read there. Synchronous by contract: there is no `await` between the read
    // that decides and the write that records, so no interleaving is possible.
    const precondition = input.commitGuard();
    if (!precondition.permitted) {
      return settle({
        outcome: 'refused',
        reasonCodes: precondition.reasonCodes.length > 0 ? precondition.reasonCodes : [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED],
      });
    }

    insertGrant.run({
      grantId: input.grant.id,
      grantJson: serializeBoundedGrant(input.grant),
      grantDigest: storedGrantRecordDigest(input.grant, storeId),
      committedAt: now(),
      schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
      signatureAlgorithm: signature.algorithm,
      signingKeyId: signature.keyId,
      signature: signature.signature,
      signatureVersion: signature.artifactVersion,
    });

    // Read back through the same verification path a later exercise will use —
    // signature included. A row that cannot be read back as authentic is not an
    // issuance to acknowledge, so a signature over the wrong bytes, or one this
    // deployment's own verifier does not trust, fails the issuance here rather
    // than becoming a grant that cannot be exercised later.
    return settle({ outcome: 'issued', grant: verifiedGrant(selectGrant.get(input.grant.id) as GrantRow, storeId) });
  });

  const runRead = db.transaction((grantId: string): { readonly result: ReadBoundedGrantResult; readonly state: RevocationStateCommitment } => {
    // The revocation state first, for every read — including a read of a grant
    // that does not exist. There is one answer to "is this store's revocation
    // state trustworthy", and every read gets it before anything else.
    const state = verifiedRevocationState();
    const grantRow = selectGrant.get(grantId) as GrantRow | undefined;
    if (grantRow === undefined) {
      if (state.byGrantId.has(grantId) || (selectRevocation.get(grantId) as RevocationRow | undefined) !== undefined) {
        throw corrupt(grantId, 'a revocation record exists for a grant that does not');
      }
      return { result: {}, state: state.commitment };
    }

    const grant = verifiedGrant(grantRow, state.commitment.storeId);
    const revocation = currentRevocation(grantId, grantRow.revocation_digest, state);
    return { result: { grant, ...(revocation !== undefined ? { revocation } : {}) }, state: state.commitment };
  });

  /** The outcome for a grant that already has a committed revocation. The first revocation stands, verified, exactly as it was recorded. */
  function alreadyRevoked(grantRow: GrantRow, grantId: string, state: VerifiedRevocationState): RevokeBoundedGrantOutcome {
    const existing = currentRevocation(grantId, grantRow.revocation_digest, state);
    if (existing === undefined) throw inconsistentRevocationState(`the committed revocation of grant '${grantId}' could not be read back`);
    // Idempotent, and the *first* revocation stands. A second call never
    // re-dates it or rewrites its reason: the moment a grant stopped being
    // exercisable is a fact, and a later call is not new information about it.
    return { outcome: 'already-revoked', revocation: existing };
  }

  type RevocationPlan =
    | { readonly kind: 'settled'; readonly outcome: RevokeBoundedGrantOutcome; readonly state: RevocationStateCommitment }
    | { readonly kind: 'sign'; readonly previous: RevocationStateCommitment; readonly next: RevocationStateCommitment; readonly revocationDigest: string };

  /**
   * Decides, against verified state, whether a revocation needs signing at
   * all, and if so what the next commitment is. Read-only.
   *
   * The next commitment is computed from the **verified** set plus the new
   * entry, never from rows that have not passed `verifiedRevocationState`. That
   * is the rule that stops a revocation from laundering tampering: if someone
   * had pruned the set, the verification above throws, and nothing is signed
   * over the pruned set — a new signature would otherwise turn their deletion
   * into state this store vouches for.
   */
  const runPlanRevocation = db.transaction((revocation: GrantRevocation): RevocationPlan => {
    const state = verifiedRevocationState();
    const grantRow = selectGrant.get(revocation.grantId) as GrantRow | undefined;
    if (grantRow === undefined) {
      return { kind: 'settled', outcome: { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] }, state: state.commitment };
    }
    // The grant's own integrity is deliberately *not* required here. Recording
    // a revocation never increases authority, and refusing to revoke a grant
    // whose record is corrupt would be the one direction this store must never
    // take: leaving an untrustworthy grant with no revocation recorded against
    // it. Revocation needs the identity, and the identity is the primary key.
    if (state.byGrantId.has(revocation.grantId)) {
      return { kind: 'settled', outcome: alreadyRevoked(grantRow, revocation.grantId, state), state: state.commitment };
    }
    if ((selectRevocation.get(revocation.grantId) as RevocationRow | undefined) !== undefined) {
      throw inconsistentRevocationState(`a revocation record for grant '${revocation.grantId}' is not covered by the signed commitment`);
    }
    if (grantRow.revocation_digest !== null) {
      throw corrupt(revocation.grantId, 'a committed revocation is referenced by the grant but its record is absent');
    }

    const { storeId, sequence } = state.commitment;
    const revocationDigest = storedRevocationRecordDigest(revocation, storeId);
    const nextEntries: RevocationSetEntry[] = [...state.entries, { sequence: sequence + 1, grantId: revocation.grantId, revocationDigest }];
    return {
      kind: 'sign',
      previous: state.commitment,
      next: { storeId, sequence: sequence + 1, revocationSetDigest: revocationSetDigest(storeId, nextEntries) },
      revocationDigest,
    };
  });

  const STALE = Symbol('stale revocation plan');

  /**
   * The committing half of revocation: the revocation row, the grant's pointer
   * to it and the advanced, signed commitment, in **one** transaction. There is
   * no instant at which the row exists and the commitment does not cover it, or
   * the commitment covers a row that does not exist — so there is no
   * intermediate state a crash could leave behind that reads as live.
   *
   * Returns `STALE` if another writer advanced the commitment after the plan
   * was made; the caller re-plans and re-signs rather than committing over a
   * state the signature was not computed for.
   */
  const runRevoke = db.transaction(
    (
      revocation: GrantRevocation,
      plan: Extract<RevocationPlan, { kind: 'sign' }>,
      revocationSignature: AuthoritySignature,
      stateSignature: AuthoritySignature,
    ): { readonly outcome: RevokeBoundedGrantOutcome; readonly state: RevocationStateCommitment } | typeof STALE => {
      const state = verifiedRevocationState();
      if (
        state.commitment.storeId !== plan.previous.storeId ||
        state.commitment.sequence !== plan.previous.sequence ||
        state.commitment.revocationSetDigest !== plan.previous.revocationSetDigest
      ) {
        return STALE;
      }

      const grantRow = selectGrant.get(revocation.grantId) as GrantRow | undefined;
      if (grantRow === undefined) return { outcome: { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] }, state: state.commitment };
      if (state.byGrantId.has(revocation.grantId)) return { outcome: alreadyRevoked(grantRow, revocation.grantId, state), state: state.commitment };
      if (grantRow.revocation_digest !== null) {
        throw corrupt(revocation.grantId, 'a committed revocation is referenced by the grant but its record is absent');
      }

      const committedAt = now();
      insertRevocation.run({
        grantId: revocation.grantId,
        sequence: plan.next.sequence,
        revokedAt: revocation.revokedAt,
        reason: revocation.reason,
        issuerRef: revocation.issuerRef,
        revocationDigest: plan.revocationDigest,
        committedAt,
        schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
        signatureAlgorithm: revocationSignature.algorithm,
        signingKeyId: revocationSignature.keyId,
        signature: revocationSignature.signature,
        signatureVersion: revocationSignature.artifactVersion,
      });

      const linked = linkRevocation.run({ grantId: revocation.grantId, revocationDigest: plan.revocationDigest }).changes;
      if (linked !== 1) throw corrupt(revocation.grantId, 'the revocation could not be linked to its grant');

      const advanced = advanceRevocationState.run({
        storeId: plan.next.storeId,
        previousSequence: plan.previous.sequence,
        sequence: plan.next.sequence,
        revocationSetDigest: plan.next.revocationSetDigest,
        committedAt,
        signatureAlgorithm: stateSignature.algorithm,
        signingKeyId: stateSignature.keyId,
        signature: stateSignature.signature,
        signatureVersion: stateSignature.artifactVersion,
      }).changes;
      if (advanced !== 1) throw inconsistentRevocationState('the revocation-state commitment could not be advanced');

      // Read back through the same verification every later read will use:
      // the new commitment, the set it covers, and this revocation's own row.
      // A commitment this deployment's verifier would refuse is not a
      // revocation to acknowledge — and the transaction rolls back rather than
      // leaving a store every later read refuses.
      const after = verifiedRevocationState();
      const recorded = alreadyRevoked(selectGrant.get(revocation.grantId) as GrantRow, revocation.grantId, after);
      if (recorded.outcome !== 'already-revoked') throw inconsistentRevocationState('the committed revocation could not be read back');
      return { outcome: { outcome: 'revoked', revocation: recorded.revocation }, state: after.commitment };
    },
  );

  /**
   * In-process revocations run one at a time. The plan-sign-commit sequence
   * has an `await` in the middle, and two interleaved revocations would each
   * sign a successor to the same commitment; one would then always go stale.
   * Serializing them here means only a *different process* can make a plan
   * stale, and that is what the bounded retry below is for.
   */
  let revocationQueue: Promise<unknown> = Promise.resolve();

  async function revokeSerialized(revocation: GrantRevocation): Promise<RevokeBoundedGrantOutcome> {
    for (let attempt = 0; attempt < MAX_REVOCATION_ATTEMPTS; attempt += 1) {
      assertOpen();
      const plan = runPlanRevocation(revocation);
      if (plan.kind === 'settled') {
        noteVerified(plan.state);
        return plan.outcome;
      }
      noteVerified(plan.previous);
      // Both signatures before the transaction opens, like every other
      // signature here. `revokedAt` is the caller's instant, never the store's
      // clock, so signing outside the transaction cannot shift it.
      const revocationSignature = await signOrFail(revocation.grantId, () => signer.signRevocation(revocation, plan.previous.storeId));
      const stateSignature = await signOrFail(revocation.grantId, () => signer.signRevocationState(plan.next));
      assertOpen();
      const committed = runRevoke.immediate(revocation, plan, revocationSignature, stateSignature);
      if (committed !== STALE) {
        noteVerified(committed.state);
        return committed.outcome;
      }
    }
    throw unavailable(
      `The revocation of grant '${revocation.grantId}' could not be committed: the revocation-state commitment kept advancing under concurrent writers. Nothing was recorded; retry the revocation.`,
    );
  }

  const store: DurableBoundedGrantStore = {
    providerKind: 'sqlite',

    /**
     * Sign, then open the transaction, then re-check, then commit.
     *
     * The order is the security property, not an implementation detail. Signing
     * may take time — today it is an in-process Ed25519 call, but the interface
     * is `async` precisely so a deferred external signer (KMS/HSM) can put a
     * network round-trip here — and a
     * signer call cannot happen *inside* the transaction, because
     * `better-sqlite3` transactions are synchronous and holding one open across
     * a network call would make the availability of a signing service into the
     * availability of the authority store.
     *
     * So the signature is produced first, outside the transaction. That creates
     * exactly one question worth answering: could eligibility change while the
     * signer is working, so that a grant is committed under an authorization
     * that has since been withdrawn? It cannot, and the reason is that
     * `commitGuard` still runs **inside** the transaction, **after** the
     * signing, immediately before the insert. The window between signing and
     * committing is re-checked at its far end, which is the same discipline
     * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 already required —
     * unchanged in kind, and unchanged in type: the guard is still synchronous,
     * and there is still no `await` between the read that decides and the write
     * that records.
     *
     * A signature over a grant that is then refused is simply discarded. It
     * never reaches storage, and a signature that was never persisted confers
     * nothing: authority is a *committed row*, not a signature someone holds.
     *
     * The store id the grant is signed for is read, verified, before signing and
     * re-checked inside the transaction.
     */
    async issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome> {
      assertOpen();
      const before = runVerifyRevocationState();
      noteVerified(before);
      const signature = await signOrFail(input.grant.id, () => signer.signGrant(input.grant, before.storeId));
      assertOpen();
      // `runIssue` returns only after COMMIT. With `synchronous = FULL` the
      // commit is durable before this resolves, so success is never reported
      // ahead of the state that preserves it.
      const { outcome, state } = runIssue(input, signature, before.storeId);
      noteVerified(state);
      return outcome;
    },

    async read(grantId: string): Promise<ReadBoundedGrantResult> {
      assertOpen();
      const { result, state } = runRead(grantId);
      noteVerified(state);
      return result;
    },

    /**
     * The same sign-then-commit order, and a harder tradeoff.
     *
     * If the signer is unavailable, this **throws**, and the grant stays
     * exercisable. That is uncomfortable and it is still correct: the two
     * alternatives are to write an unsigned revocation — which would mean the
     * read path must accept unsigned authority state, destroying the property
     * this whole file exists to establish — or to report success without
     * persisting anything, which tells an operator a grant is revoked when it is
     * not. The honest failure is the loud one.
     *
     * The cost is real and is recorded as **AA-004**: signer availability is now
     * on the critical path of the emergency operation. `docs/security/
     * AUTHORITY_ARTIFACT_AUTHENTICITY.md` §19.2 states it, and it is an input to
     * the deferred external key-custody work — an external signing boundary
     * makes this dependency a network dependency, which is worse, and is
     * something that work must design for rather than discover.
     *
     * CORE-01 adds a second signature to the same operation: the advanced
     * revocation-state commitment. It is produced by the same signer, in the
     * same window, and a failure of either leaves nothing recorded. A
     * revocation of a grant that is unknown or already revoked is settled before
     * the signer is called at all.
     */
    async revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome> {
      assertOpen();
      // Parity with the in-memory store: a reason outside the closed vocabulary
      // is refused before anything is read, written or signed.
      if (!isGrantRevocationReason(input.reason)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }
      const revocation: GrantRevocation = {
        grantId: input.grantId,
        revokedAt: input.revokedAt,
        reason: input.reason,
        issuerRef: input.issuerRef,
      };
      const run = revocationQueue.then(() => revokeSerialized(revocation));
      revocationQueue = run.catch(() => undefined);
      return run;
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

      // A store that is reachable but whose revocation state cannot be proven
      // answers no authority read, so reachability alone is not health.
      let revocationState: Pick<BoundedGrantStoreHealth, 'revocationState' | 'revocationStateFailure' | 'revocationSequence'> = {
        revocationState: 'failed',
        revocationStateFailure: 'BOUNDED_GRANT_STORE_UNAVAILABLE',
      };
      if (readable) {
        try {
          const verified = runVerifyRevocationState();
          noteVerified(verified);
          revocationState = { revocationState: 'verified', revocationSequence: verified.sequence };
        } catch (error) {
          revocationState = {
            revocationState: 'failed',
            revocationStateFailure: error instanceof BoundedGrantStoreError ? error.code : 'BOUNDED_GRANT_STORE_UNAVAILABLE',
          };
        }
      }

      return {
        status: readable && writable && revocationState.revocationState === 'verified' ? 'healthy' : 'unhealthy',
        readable,
        writable,
        schemaVersion: BOUNDED_GRANT_STORE_SCHEMA_VERSION,
        checkedAt: now(),
        ...revocationState,
      };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };

  Object.freeze(store);
  AUTHENTICATED_DURABLE_STORES.add(store);
  return store;
}
