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
 * Two limits stated here rather than left to be inferred. The signing key is
 * **resident in this process's memory** in the current composition, so anything
 * that can read process memory can mint authority that verifies — AA-001, which
 * Prompt 6 owns. And a signature says a trusted key vouched for these bytes; it
 * says nothing about whether the *policy* that produced them was legitimate,
 * and nothing about a wholesale rollback to an earlier, validly-signed snapshot
 * (GS-002). `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` states both.
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
}

/** The durable store, plus the lifecycle surface a host needs. The exercise path is handed only `BoundedGrantReaderPort`; nothing below widens what it can reach. */
export interface DurableBoundedGrantStore extends BoundedGrantStorePort {
  readonly providerKind: 'sqlite';
  health(): Promise<BoundedGrantStoreHealth>;
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema (`aoc.bounded-grant-store.schema.v2`), two tables:
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
//
// v2 adds four signature columns to each table. They are `NOT NULL`, so the
// database itself refuses to hold an unsigned authority row: "forgot to sign"
// is a write that fails rather than a row that reads as authority. The version
// bump is what makes the change safe — a v1 database is refused at open by the
// guard below, so unsigned rows written before signing existed are never
// reinterpreted as signed, and never auto-signed under the current key.
// ---------------------------------------------------------------------------
const SCHEMA_V2 = `
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
`;

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
  readonly revoked_at: string;
  readonly reason: string;
  readonly issuer_ref: string;
  readonly revocation_digest: string;
  readonly schema_version: string;
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

/**
 * Opens the durable store.
 *
 * `options` has **no default**. It used to, and removing it is deliberate: with
 * a default, a caller that simply forgot the authenticity boundary would get a
 * working store, and the only thing standing between a deployment and unsigned
 * durable authority would be everyone remembering. Now it does not compile.
 */
export async function createSqliteBoundedGrantStore(
  dbPath: string,
  options: CreateSqliteBoundedGrantStoreOptions,
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

  db.exec(SCHEMA_V2);

  const latest = db.prepare(`SELECT schema_version FROM bounded_grant_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(BOUNDED_GRANT_STORE_SCHEMA_VERSION, now());
  } else if (latest.schema_version !== BOUNDED_GRANT_STORE_SCHEMA_VERSION) {
    db.close();
    throw unavailable(
      `The bounded-grant store is recorded under schema version '${latest.schema_version}', which this runtime does not implement (expected '${BOUNDED_GRANT_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
    );
  }

  const selectGrant = db.prepare(
    `SELECT grant_id, grant_json, grant_digest, revocation_digest, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grants WHERE grant_id = ?`,
  );
  const selectRevocation = db.prepare(
    `SELECT grant_id, revoked_at, reason, issuer_ref, revocation_digest, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grant_revocations WHERE grant_id = ?`,
  );
  const insertGrant = db.prepare(
    `INSERT INTO bounded_grants (grant_id, grant_json, grant_digest, revocation_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version) VALUES (@grantId, @grantJson, @grantDigest, NULL, @committedAt, @schemaVersion, @signatureAlgorithm, @signingKeyId, @signature, @signatureVersion)`,
  );
  const insertRevocation = db.prepare(
    `INSERT INTO bounded_grant_revocations (grant_id, revoked_at, reason, issuer_ref, revocation_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version) VALUES (@grantId, @revokedAt, @reason, @issuerRef, @revocationDigest, @committedAt, @schemaVersion, @signatureAlgorithm, @signingKeyId, @signature, @signatureVersion)`,
  );
  const linkRevocation = db.prepare(`UPDATE bounded_grants SET revocation_digest = @revocationDigest WHERE grant_id = @grantId AND revocation_digest IS NULL`);

  // Destructured here so the two halves are named separately from the point
  // they enter this module. `verifier` is reachable from the read path;
  // `signer` is reached only from `issue` and `revoke`, and a structural test
  // pins that `runRead` and its helpers never name it.
  const { signer, verifier } = options.authenticity;

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
    // Authenticity last, and never instead of the checks above: the digests
    // answer "are these the bytes that were written", the signature answers
    // "did a trusted authority key vouch for them". A writer who recomputes
    // every digest above reaches exactly this line and stops here, because the
    // one thing they cannot recompute is a signature over their new bytes.
    //
    // Verified over the grant as parsed, not over the row's raw JSON: the two
    // are already proven byte-identical by `parseStoredGrant`'s round-trip, and
    // signing the parsed artifact is what makes the check independent of how
    // the row happens to be stored.
    const verification = verifier.verifyGrant(grant, signatureEnvelopeOf(row));
    if (!verification.verified) throw unauthentic(row.grant_id, 'grant signature', verification.failure);
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
    // A revocation is authority state, at the same strength as a grant. A
    // deployment where the grant is signed and the revocation is not would make
    // the revocation the cheaper record to forge — and forging a revocation
    // away is how authority comes back, which is the direction that must never
    // be cheap.
    const verification = verifier.verifyRevocation(revocation, signatureEnvelopeOf(row));
    if (!verification.verified) throw unauthentic(row.grant_id, 'revocation signature', verification.failure);
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

  /**
   * The committing half of issuance. Everything here is synchronous and inside
   * one transaction; the signature it persists was produced **before** the
   * transaction opened, and `commitGuard` runs after that signing and
   * immediately before the write. See `issue` below for why that order is the
   * whole point.
   */
  /**
   * Runs a signer call and turns any failure into a refusal to proceed.
   *
   * Every path out of here that is not a signature is a throw. There is no
   * branch in which a missing signature becomes a warning, a retry-with-nothing,
   * or a row written without one — the point at which "the signer did not
   * answer" could become "store it unsigned" is this function, and it does not
   * exist here.
   */
  async function signGrantOrFail(grantId: string, produce: () => Promise<AuthoritySignature>): Promise<AuthoritySignature> {
    try {
      return await produce();
    } catch (error) {
      if (error instanceof AuthoritySigningUnavailableError) throw error;
      throw new AuthoritySigningUnavailableError(`The authority signer could not sign the artifact for grant '${grantId}'.`);
    }
  }

  const runIssue = db.transaction((input: IssueBoundedGrantInput, signature: AuthoritySignature): IssueBoundedGrantOutcome => {
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

  const runRevoke = db.transaction((revocation: GrantRevocation, signature: AuthoritySignature): RevokeBoundedGrantOutcome => {
    const grantRow = selectGrant.get(revocation.grantId) as GrantRow | undefined;
    if (grantRow === undefined) return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] };

    // The grant's own integrity is deliberately *not* required here. Recording
    // a revocation never increases authority, and refusing to revoke a grant
    // whose record is corrupt would be the one direction this store must never
    // take: leaving an untrustworthy grant with no revocation recorded against
    // it. Revocation needs the identity, and the identity is the primary key.
    const existingRow = selectRevocation.get(revocation.grantId) as RevocationRow | undefined;
    if (existingRow !== undefined) {
      const existing = verifiedRevocation(existingRow);
      if (grantRow.revocation_digest !== existingRow.revocation_digest) {
        throw corrupt(revocation.grantId, 'the grant references a different revocation than the one recorded');
      }
      // Idempotent, and the *first* revocation stands. A second call never
      // re-dates it or rewrites its reason: the moment a grant stopped being
      // exercisable is a fact, and a later call is not new information about it.
      return { outcome: 'already-revoked', revocation: existing };
    }
    if (grantRow.revocation_digest !== null) {
      throw corrupt(revocation.grantId, 'a committed revocation is referenced by the grant but its record is absent');
    }

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
      signatureAlgorithm: signature.algorithm,
      signingKeyId: signature.keyId,
      signature: signature.signature,
      signatureVersion: signature.artifactVersion,
    });

    // Same transaction, so the record and the grant's reference to it commit
    // together. A crash between them cannot leave a revoked grant reading as
    // live, because there is no "between them" to crash in.
    const linked = linkRevocation.run({ grantId: revocation.grantId, revocationDigest }).changes;
    if (linked !== 1) throw corrupt(revocation.grantId, 'the revocation could not be linked to its grant');

    return { outcome: 'revoked', revocation };
  });

  return {
    providerKind: 'sqlite',

    /**
     * Sign, then open the transaction, then re-check, then commit.
     *
     * The order is the security property, not an implementation detail. Signing
     * may take time — today it is an in-process Ed25519 call, but the interface
     * is `async` precisely so Prompt 6 can put a KMS round-trip here — and a
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
     */
    async issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome> {
      assertOpen();
      const signature = await signGrantOrFail(input.grant.id, () => signer.signGrant(input.grant));
      // `runIssue` returns only after COMMIT. With `synchronous = FULL` the
      // commit is durable before this resolves, so success is never reported
      // ahead of the state that preserves it.
      return runIssue(input, signature);
    },

    async read(grantId: string): Promise<ReadBoundedGrantResult> {
      assertOpen();
      return runRead(grantId);
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
     * Prompt 6 — an external signing boundary makes this dependency a network
     * dependency, which is worse, and is something that prompt must design for
     * rather than discover.
     */
    async revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome> {
      assertOpen();
      // Parity with the in-memory store: a reason outside the closed vocabulary
      // is refused before anything is read, written or signed.
      if (!isGrantRevocationReason(input.reason)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }
      // Fully determined by the input, so it can be built and signed before the
      // transaction opens. `revokedAt` is the caller's instant, never the
      // store's clock, so signing outside the transaction cannot shift it.
      const revocation: GrantRevocation = {
        grantId: input.grantId,
        revokedAt: input.revokedAt,
        reason: input.reason,
        issuerRef: input.issuerRef,
      };
      const signature = await signGrantOrFail(input.grantId, () => signer.signRevocation(revocation));
      return runRevoke(revocation, signature);
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
