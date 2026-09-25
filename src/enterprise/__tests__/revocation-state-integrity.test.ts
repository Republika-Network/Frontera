import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import { createGrantExecutionService } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { isExecutionGovernanceError } from '../execution-governance/index.js';
import { AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID } from '../modules/authority-controlled-execution-module.js';
import {
  isAuthenticatedDurableBoundedGrantStore,
  revocationSetDigest,
  storedGrantRecordDigest,
  type RevocationStateCommitment,
} from '../bounded-grant-store/index.js';
import { isBoundedGrantStoreError, type BoundedGrantStoreErrorCode } from '../bounded-grant-store/errors.js';
import { AuthorityAuthenticityConfigurationError, type AuthorityArtifactSigner } from '../authority-authenticity/index.js';
import {
  AUTHORITY_KEY_A,
  AUTHORITY_KEY_B,
  AUTHORITY_KEY_UNTRUSTED,
  authorityAuthenticityEnv,
  dropAuthorityStoreTriggers,
  openDurableStore,
  storeIdOf,
  testAuthenticity,
  testSigner,
  trustedKeyOf,
} from './authority-authenticity-fixture.js';
import { buildTestKernelProviders } from './support.js';

/**
 * CORE-01 — revocation state integrity.
 *
 * ## The defect this suite exists for
 *
 * Before CORE-01, a signed revocation proved that a revocation was genuine, and
 * nothing proved that a genuine revocation had not been *removed*. The only
 * statement "this grant has a revocation" was an unsigned pointer on the grant
 * row. A database-only writer who deleted the revocation row and cleared that
 * pointer returned the grant row to exactly the bytes it held before it was
 * revoked — genuinely signed, internally consistent — and the store read it as
 * live, and the execution path **executed** it. Case E is that attack, verbatim.
 *
 * ## The attacker every test here simulates
 *
 * Can open the SQLite file and run any SQL: drop the store's triggers, update,
 * delete and insert rows, recompute any unkeyed digest. Cannot produce an
 * Ed25519 signature under a trusted authority key, cannot change code, cannot
 * change the trusted key configuration, and does not control the process.
 * `withAttacker` below *is* that attacker: it drops the triggers first, so no
 * test here passes because a trigger happened to block a write.
 *
 * ## The boundary this suite also pins
 *
 * A writer who kept a copy of an earlier, genuinely signed state and restores
 * it wholesale has rolled the store back. The running process detects that; a
 * restarted one cannot, and that is CORE-07. The RESIDUAL test at the end
 * asserts the limitation exactly as documented, so the claim cannot quietly
 * drift in either direction.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const BEFORE_HORIZON = '2026-01-01T12:05:00.000Z';

const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const SOURCE_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: '10000', unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};

const SOURCE: GrantSourceAuthorization = {
  correlation: CORRELATION,
  subject: 'actor-a',
  scope: SOURCE_SCOPE,
  authorizationPermitsExercise: true,
  allBlockingObligationsSatisfied: true,
  evaluatedAt: NOW,
  validityCeilings: [],
};

const workDir = mkdtempSync(join(tmpdir(), 'aoc-revocation-state-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function tempDbPath(name: string): string {
  dbCounter += 1;
  return join(workDir, `${name}-${dbCounter}.sqlite`);
}

function correlationFor(n: number): GrantCorrelation {
  return n === 1 ? CORRELATION : { ...CORRELATION, requestId: `req-${n}`, decisionId: `dec-${n}` };
}

async function issueInto(store: BoundedGrantStorePort, n = 1): Promise<BoundedGrant> {
  const correlation = correlationFor(n);
  const outcome = await createGrantIssuanceService({ store }).issueGrant({ source: { ...SOURCE, correlation }, subject: 'actor-a', correlation, issuedAt: NOW, expiresAt: HORIZON });
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return outcome.grant;
}

function revoke(store: BoundedGrantStorePort, grantId: string, overrides: { readonly reason?: 'security-incident' | 'manual-revocation'; readonly revokedAt?: string; readonly issuerRef?: string } = {}) {
  return store.revoke({ grantId, reason: overrides.reason ?? 'security-incident', revokedAt: overrides.revokedAt ?? BEFORE_HORIZON, issuerRef: overrides.issuerRef ?? 'operator-a' });
}

/** The database-only attacker. Drops the defense-in-depth triggers first — this attacker can. */
async function withAttacker<T>(dbPath: string, run: (db: import('better-sqlite3').Database) => T): Promise<T> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    dropAuthorityStoreTriggers(db);
    return run(db);
  } finally {
    db.close();
  }
}

/** A plain connection that does NOT drop triggers — an ordinary client, not the attacker. */
async function withOrdinaryConnection<T>(dbPath: string, run: (db: import('better-sqlite3').Database) => T): Promise<T> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

interface StateRow {
  readonly store_id: string;
  readonly sequence: number;
  readonly revocation_set_digest: string;
  readonly signature_algorithm: string;
  readonly signing_key_id: string;
  readonly signature: string;
  readonly signature_version: string;
}

function readState(db: import('better-sqlite3').Database): StateRow {
  return db.prepare('SELECT store_id, sequence, revocation_set_digest, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grant_revocation_state WHERE singleton = 1').get() as StateRow;
}

function writeState(db: import('better-sqlite3').Database, row: StateRow): void {
  db.prepare(
    'UPDATE bounded_grant_revocation_state SET store_id = ?, sequence = ?, revocation_set_digest = ?, signature_algorithm = ?, signing_key_id = ?, signature = ?, signature_version = ? WHERE singleton = 1',
  ).run(row.store_id, row.sequence, row.revocation_set_digest, row.signature_algorithm, row.signing_key_id, row.signature, row.signature_version);
}

/** The canonical un-revocation: delete the revocation row and clear the grant's pointer to it. Nothing unkeyed on the grant row needs recomputing — it is exactly the row that existed before the revocation. */
function unrevoke(db: import('better-sqlite3').Database, grantId: string): void {
  db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grantId);
  db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grantId);
}

function refusedWith(...codes: readonly BoundedGrantStoreErrorCode[]) {
  return (error: unknown): true => {
    assert.ok(isBoundedGrantStoreError(error), `expected a BoundedGrantStoreError, got ${String(error)}`);
    assert.ok(codes.includes(error.code), `expected one of ${codes.join(', ')}, got ${error.code}: ${error.message}`);
    return true;
  };
}

const INCONSISTENT = refusedWith('BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT');
const UNAUTHENTIC = refusedWith('BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED');
const CORRUPT = refusedWith('BOUNDED_GRANT_STORE_STATE_CORRUPT');

/** Exercises `grant` through the real execution service. Returns the outcome status and whether the adapter was reached. */
async function exercise(store: BoundedGrantStorePort, grant: BoundedGrant, executionId = 'exec-1'): Promise<{ readonly status: string; readonly adapterCalls: number }> {
  const adapter = createRecordingExecutionAdapter();
  const outcome = await createGrantExecutionService({ store, adapter, now: () => BEFORE_HORIZON }).exercise({
    boundedGrantId: grant.id,
    correlation: grant.correlation,
    executionId,
    subject: 'actor-a',
    action: 'payment.send',
    resource: 'record:contract',
    amount: { value: '100', unit: 'USD' },
  });
  return { status: outcome.status, adapterCalls: adapter.callCount };
}

async function assertNotExercisable(store: BoundedGrantStorePort, grant: BoundedGrant): Promise<void> {
  const result = await exercise(store, grant);
  assert.equal(result.status, 'withheld', `the grant must not execute (status ${result.status})`);
  assert.equal(result.adapterCalls, 0, 'nothing may reach the provider');
}

/** A revoked grant in a closed durable store, ready for the attacker. */
async function revokedGrantOnDisk(name: string): Promise<{ readonly dbPath: string; readonly grant: BoundedGrant }> {
  const dbPath = tempDbPath(name);
  const store = await openDurableStore(dbPath);
  const grant = await issueInto(store);
  assert.equal((await revoke(store, grant.id)).outcome, 'revoked');
  await store.close();
  return { dbPath, grant };
}

// ---------------------------------------------------------------------------
// A, B — the legitimate lifecycle
// ---------------------------------------------------------------------------

describe('CORE-01 — the legitimate lifecycle', () => {
  it('A. an issued grant is authenticated, reads as active, and executes', async () => {
    const store = await openDurableStore(tempDbPath('a-active'));
    const grant = await issueInto(store);
    const read = await store.read(grant.id);
    assert.equal(read.grant?.id, grant.id);
    assert.equal(read.revocation, undefined);
    const result = await exercise(store, grant);
    assert.equal(result.status, 'executed');
    assert.equal(result.adapterCalls, 1);
    await store.close();
  });

  it('B. a signed revocation reads as revoked, advances the signed commitment, and withholds execution', async () => {
    const dbPath = tempDbPath('b-revoked');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    const before = await withOrdinaryConnection(dbPath, readState);
    assert.equal(before.sequence, 0, 'a new store starts at a signed genesis commitment, sequence 0');

    assert.equal((await revoke(store, grant.id)).outcome, 'revoked');
    assert.equal((await store.read(grant.id)).revocation?.reason, 'security-incident');
    await assertNotExercisable(store, grant);

    const afterRevoke = await withOrdinaryConnection(dbPath, readState);
    assert.equal(afterRevoke.sequence, 1);
    assert.equal(afterRevoke.store_id, before.store_id);
    assert.notEqual(afterRevoke.signature, before.signature, 'the commitment is re-signed on revocation');
    await store.close();
  });

  it('a store with no revocations still holds a SIGNED statement that nothing was revoked — absence is never the evidence', async () => {
    const dbPath = tempDbPath('genesis');
    await (await openDurableStore(dbPath)).close();
    const state = await withOrdinaryConnection(dbPath, readState);
    assert.equal(state.sequence, 0);
    assert.equal(state.revocation_set_digest, revocationSetDigest(state.store_id, []));
    assert.equal(state.signing_key_id, AUTHORITY_KEY_A.keyId);
    assert.ok(state.signature.length > 0);
  });
});

// ---------------------------------------------------------------------------
// C, D, E, K — removing a revocation
// ---------------------------------------------------------------------------

describe('CORE-01 — a database-only writer cannot remove a revocation', () => {
  it('C. deleting the revocation row fails closed, and execution stays withheld', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('c-delete-row');
    await withAttacker(dbPath, (db) => db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), INCONSISTENT);
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('D. clearing the grant’s pointer alone fails closed, and execution stays withheld', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('d-clear-pointer');
    await withAttacker(dbPath, (db) => db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), CORRUPT);
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('e-unrevoke');
    await withAttacker(dbPath, (db) => unrevoke(db, grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), INCONSISTENT);
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('E+K. … and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('ek-rehash');
    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      const state = readState(db);
      // Every unkeyed value recomputed exactly as the store would: the set
      // digest of the now-empty set, and the sequence that matches it.
      writeState(db, { ...state, sequence: 0, revocation_set_digest: revocationSetDigest(state.store_id, []) });
    });
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), UNAUTHENTIC);
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('E+. … and splice in a genuine genesis commitment from a DIFFERENT store signed by the same key — the store binding refuses it', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('e-foreign-genesis');
    // A freshly created store under the same trusted key: the exact thing an
    // attacker gets by deleting the file and waiting for a restart. Its
    // genesis commitment is a perfectly valid signature over "nothing revoked".
    const foreignPath = tempDbPath('e-foreign-source');
    await (await openDurableStore(foreignPath)).close();
    const foreign = await withOrdinaryConnection(foreignPath, readState);
    assert.equal(foreign.sequence, 0);

    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      writeState(db, foreign);
      // And re-seal the grant row's unkeyed record digest for the foreign store
      // id, so no integrity check stands between the splice and the signature.
      db.prepare('UPDATE bounded_grants SET grant_digest = ? WHERE grant_id = ?').run(storedGrantRecordDigest(grant, foreign.store_id), grant.id);
    });

    const store = await openDurableStore(dbPath);
    // The commitment itself verifies — it is genuine — but this store's grant
    // was signed for this store's id, not the foreign one.
    await assert.rejects(() => store.read(grant.id), UNAUTHENTIC);
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('deleting the commitment row itself fails every read closed, and a reopen does not mint a fresh genesis over existing authority', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('commitment-deleted');
    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      db.prepare('DELETE FROM bounded_grant_revocation_state').run();
    });
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), INCONSISTENT);
    await assertNotExercisable(store, grant);
    await store.close();
    const rows = await withOrdinaryConnection(dbPath, (db) => (db.prepare('SELECT COUNT(*) AS n FROM bounded_grant_revocation_state').get() as { n: number }).n);
    assert.equal(rows, 0, 'opening an existing store must never re-initialize its revocation state');
  });

  it('dropping every table but the grants does not make the file look like a new store', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('tables-dropped');
    await withAttacker(dbPath, (db) => {
      db.exec('DROP TABLE bounded_grant_revocations; DROP TABLE bounded_grant_revocation_state; DROP TABLE bounded_grant_store_versions;');
      db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id);
    });
    await assert.rejects(() => openDurableStore(dbPath), refusedWith('BOUNDED_GRANT_STORE_UNAVAILABLE'));
  });

  it('removing one of several revocations and renumbering the rest fails closed', async () => {
    const dbPath = tempDbPath('renumber');
    const store = await openDurableStore(dbPath);
    const first = await issueInto(store, 1);
    const second = await issueInto(store, 2);
    await revoke(store, first.id);
    await revoke(store, second.id);
    await store.close();

    await withAttacker(dbPath, (db) => {
      unrevoke(db, first.id);
      db.prepare('UPDATE bounded_grant_revocations SET sequence = 1 WHERE grant_id = ?').run(second.id);
    });
    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(first.id), INCONSISTENT);
    await assert.rejects(() => reopened.read(second.id), INCONSISTENT, 'an untouched grant is not readable either — the store cannot answer for any of them');
    await assertNotExercisable(reopened, first);
    await reopened.close();
  });
});

// ---------------------------------------------------------------------------
// F, G, H — altering or moving a revocation
// ---------------------------------------------------------------------------

describe('CORE-01 — a revocation cannot be altered or moved', () => {
  it('F. tampered revocation contents, re-digested, fail closed', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('f-contents');
    await withAttacker(dbPath, (db) => db.prepare(`UPDATE bounded_grant_revocations SET reason = 'expired' WHERE grant_id = ?`).run(grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), refusedWith('BOUNDED_GRANT_STORE_STATE_CORRUPT', 'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED'));
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('G. two revoked grants exchanging revocation rows fail closed', async () => {
    const dbPath = tempDbPath('g-swap');
    const store = await openDurableStore(dbPath);
    const first = await issueInto(store, 1);
    const second = await issueInto(store, 2);
    await revoke(store, first.id);
    await revoke(store, second.id);
    await store.close();

    await withAttacker(dbPath, (db) => {
      db.pragma('foreign_keys = OFF');
      db.prepare(`UPDATE bounded_grant_revocations SET grant_id = 'swap' WHERE grant_id = ?`).run(first.id);
      db.prepare('UPDATE bounded_grant_revocations SET grant_id = ? WHERE grant_id = ?').run(first.id, second.id);
      db.prepare(`UPDATE bounded_grant_revocations SET grant_id = ? WHERE grant_id = 'swap'`).run(second.id);
    });
    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(first.id), INCONSISTENT);
    await assert.rejects(() => reopened.read(second.id), INCONSISTENT);
    await reopened.close();
  });

  it('H. moving a revocation from the revoked grant onto a live one does not free the revoked grant', async () => {
    const dbPath = tempDbPath('h-move');
    const store = await openDurableStore(dbPath);
    const revoked = await issueInto(store, 1);
    const live = await issueInto(store, 2);
    await revoke(store, revoked.id);
    await store.close();

    await withAttacker(dbPath, (db) => {
      db.pragma('foreign_keys = OFF');
      const digest = (db.prepare('SELECT revocation_digest FROM bounded_grant_revocations WHERE grant_id = ?').get(revoked.id) as { revocation_digest: string }).revocation_digest;
      db.prepare('UPDATE bounded_grant_revocations SET grant_id = ? WHERE grant_id = ?').run(live.id, revoked.id);
      db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(revoked.id);
      db.prepare('UPDATE bounded_grants SET revocation_digest = ? WHERE grant_id = ?').run(digest, live.id);
    });
    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(revoked.id), INCONSISTENT);
    await assertNotExercisable(reopened, revoked);
    await reopened.close();
  });

  it('H. changing a revocation’s sequence position fails closed', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('h-sequence');
    await withAttacker(dbPath, (db) => db.prepare('UPDATE bounded_grant_revocations SET sequence = 7 WHERE grant_id = ?').run(grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), INCONSISTENT);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// I, J — the commitment's own signature
// ---------------------------------------------------------------------------

describe('CORE-01 — the commitment must carry a trusted signature', () => {
  it('I. a commitment re-signed by an untrusted key over the pruned set is refused as an unknown key', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('i-unknown-key');
    const storeId = await withOrdinaryConnection(dbPath, storeIdOf);
    const pruned: RevocationStateCommitment = { storeId, sequence: 0, revocationSetDigest: revocationSetDigest(storeId, []) };
    // A real Ed25519 signature over exactly the right bytes — by a key no
    // registry trusts.
    const attacker = await testSigner(AUTHORITY_KEY_UNTRUSTED).signRevocationState(pruned);
    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      writeState(db, {
        store_id: storeId,
        sequence: 0,
        revocation_set_digest: pruned.revocationSetDigest,
        signature_algorithm: attacker.algorithm,
        signing_key_id: attacker.keyId,
        signature: attacker.signature,
        signature_version: attacker.artifactVersion,
      });
    });
    const store = await openDurableStore(dbPath);
    await assert.rejects(
      () => store.read(grant.id),
      (error: unknown) => UNAUTHENTIC(error) && error instanceof Error && error.message.includes('AUTHORITY_SIGNING_KEY_UNKNOWN'),
    );
    await assertNotExercisable(store, grant);
    await store.close();
  });

  it('I. naming the trusted key id on that forged commitment does not help — the signature does not verify', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('i-claimed-key');
    const storeId = await withOrdinaryConnection(dbPath, storeIdOf);
    const pruned: RevocationStateCommitment = { storeId, sequence: 0, revocationSetDigest: revocationSetDigest(storeId, []) };
    const attacker = await testSigner(AUTHORITY_KEY_UNTRUSTED).signRevocationState(pruned);
    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      const state = readState(db);
      writeState(db, { ...state, sequence: 0, revocation_set_digest: pruned.revocationSetDigest, signature: attacker.signature });
    });
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), (error: unknown) => UNAUTHENTIC(error) && error instanceof Error && error.message.includes('AUTHORITY_SIGNATURE_INVALID'));
    await store.close();
  });

  it('J. a commitment with its signature removed is refused as MISSING — never trusted as legacy', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('j-missing');
    // The column is NOT NULL, so the attacker rebuilds the table without the
    // constraint — a writer who can drop triggers can do this too.
    await withAttacker(dbPath, (db) => {
      const state = readState(db);
      db.exec(`DROP TABLE bounded_grant_revocation_state;
        CREATE TABLE bounded_grant_revocation_state (singleton INTEGER PRIMARY KEY, store_id TEXT, sequence INTEGER, revocation_set_digest TEXT, committed_at TEXT, schema_version TEXT, signature_algorithm TEXT, signing_key_id TEXT, signature TEXT, signature_version TEXT);`);
      db.prepare(`INSERT INTO bounded_grant_revocation_state VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(
        state.store_id,
        state.sequence,
        state.revocation_set_digest,
        NOW,
        'aoc.bounded-grant-store.schema.v3',
      );
    });
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), (error: unknown) => UNAUTHENTIC(error) && error instanceof Error && error.message.includes('AUTHORITY_SIGNATURE_MISSING'));
    await assertNotExercisable(store, grant);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// L — restart; the in-process witness; the documented residual
// ---------------------------------------------------------------------------

describe('CORE-01 — restart and rollback', () => {
  it('L. a revoked grant stays revoked across restarts, and tampering after a restart still fails closed', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('l-restart');
    for (let restart = 0; restart < 3; restart += 1) {
      const store = await openDurableStore(dbPath);
      assert.ok((await store.read(grant.id)).revocation !== undefined);
      await assertNotExercisable(store, grant);
      await store.close();
    }
    await withAttacker(dbPath, (db) => unrevoke(db, grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => store.read(grant.id), INCONSISTENT);
    await store.close();
  });

  it('a RUNNING store detects a restore of an earlier, genuinely signed state (in-process freshness witness)', async () => {
    const dbPath = tempDbPath('live-rollback');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    // The attacker captures the pre-revocation commitment while it is current.
    const captured = await withOrdinaryConnection(dbPath, readState);
    await revoke(store, grant.id);
    assert.ok((await store.read(grant.id)).revocation !== undefined);

    // …then, while the process is still running, restores it wholesale along
    // with the rows it covered: a complete, authentic, earlier state.
    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      writeState(db, captured);
    });

    await assert.rejects(() => store.read(grant.id), (error: unknown) => INCONSISTENT(error) && error instanceof Error && /regressed/.test(error.message));
    await assertNotExercisable(store, grant);
    const health = await store.health();
    assert.equal(health.status, 'unhealthy');
    assert.equal(health.revocationStateFailure, 'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT');
    await store.close();
  });

  it('RESIDUAL (CORE-07): a full restore of an earlier authentic state is NOT detected by a restarted process', async () => {
    // This pins the documented boundary rather than a desired behaviour. A
    // writer who kept a copy of the complete pre-revocation state — commitment
    // and rows — and restores it before a restart has rolled the store back to
    // something this key genuinely signed. Nothing inside the file can tell
    // "never revoked" from "restored to before the revocation"; that needs a
    // freshness anchor outside the database, which is CORE-07. When CORE-07
    // lands, this test must be inverted, not deleted.
    const dbPath = tempDbPath('residual-rollback');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    const captured = await withOrdinaryConnection(dbPath, readState);
    await revoke(store, grant.id);
    await store.close();

    await withAttacker(dbPath, (db) => {
      unrevoke(db, grant.id);
      writeState(db, captured);
    });

    const restarted = await openDurableStore(dbPath);
    assert.equal((await restarted.read(grant.id)).revocation, undefined, 'if this now fails closed, CORE-07 has landed: invert this test and update the threat model');
    await restarted.close();
  });
});

// ---------------------------------------------------------------------------
// M, N — idempotency, conflicts and concurrency
// ---------------------------------------------------------------------------

describe('CORE-01 — revocation is monotonic, idempotent and deterministic', () => {
  function countingSigner(): AuthorityArtifactSigner & { readonly calls: { grant: number; revocation: number; state: number } } {
    const inner = testSigner(AUTHORITY_KEY_A);
    const calls = { grant: 0, revocation: 0, state: 0 };
    return {
      activeKeyId: inner.activeKeyId,
      algorithm: inner.algorithm,
      calls,
      async signGrant(grant, storeId) {
        calls.grant += 1;
        return inner.signGrant(grant, storeId);
      },
      async signRevocation(revocation, storeId) {
        calls.revocation += 1;
        return inner.signRevocation(revocation, storeId);
      },
      async signRevocationState(state) {
        calls.state += 1;
        return inner.signRevocationState(state);
      },
    };
  }

  it('M. a repeated identical revocation returns the first, signs nothing, and leaves the commitment unchanged', async () => {
    const dbPath = tempDbPath('m-idempotent');
    const signer = countingSigner();
    const store = await openDurableStore(dbPath, { authenticity: { signer, verifier: testAuthenticity().verifier } });
    const grant = await issueInto(store);
    const first = await revoke(store, grant.id);
    const before = await withOrdinaryConnection(dbPath, readState);
    const callsBefore = { ...signer.calls };

    const second = await revoke(store, grant.id);
    assert.equal(first.outcome, 'revoked');
    assert.equal(second.outcome, 'already-revoked');
    assert.deepEqual(second.outcome === 'already-revoked' && second.revocation, first.outcome === 'revoked' && first.revocation);
    assert.deepEqual(signer.calls, callsBefore, 'an already-revoked grant is settled before the signer is reached');
    assert.deepEqual(await withOrdinaryConnection(dbPath, readState), before);
    await store.close();
  });

  it('N. a conflicting second revocation (other reason, time and issuer) is deterministic: the first stands, unchanged', async () => {
    const dbPath = tempDbPath('n-conflict');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await revoke(store, grant.id, { reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    const conflicting = await revoke(store, grant.id, { reason: 'manual-revocation', revokedAt: NOW, issuerRef: 'operator-b' });
    assert.equal(conflicting.outcome, 'already-revoked');
    assert.equal(conflicting.outcome === 'already-revoked' && conflicting.revocation.issuerRef, 'operator-a');
    assert.equal((await store.read(grant.id)).revocation?.reason, 'security-incident');
    assert.equal((await withOrdinaryConnection(dbPath, readState)).sequence, 1);
    await store.close();
  });

  it('there is no reverse transition: no un-revoke operation exists on the port or the store', async () => {
    const store = await openDurableStore(tempDbPath('no-unrevoke'));
    for (const name of ['unRevoke', 'unrevoke', 'restoreGrant', 'reactivate', 'reactivateRevokedGrant', 'reinstate']) {
      assert.equal(name in store, false, `the store must not expose '${name}'`);
    }
    await store.close();
  });

  it('concurrent in-process revocations of different grants both commit, in sequence', async () => {
    const dbPath = tempDbPath('concurrent-in-process');
    const store = await openDurableStore(dbPath);
    const grants = await Promise.all([1, 2, 3, 4].map((n) => issueInto(store, n)));
    const outcomes = await Promise.all(grants.map((grant) => revoke(store, grant.id)));
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['revoked', 'revoked', 'revoked', 'revoked']);
    assert.equal((await withOrdinaryConnection(dbPath, readState)).sequence, 4);
    for (const grant of grants) assert.ok((await store.read(grant.id)).revocation !== undefined);
    await store.close();
  });

  it('concurrent revocations of the SAME grant yield exactly one revoked and one already-revoked', async () => {
    const dbPath = tempDbPath('concurrent-same');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    const outcomes = await Promise.all([revoke(store, grant.id), revoke(store, grant.id, { issuerRef: 'operator-b' })]);
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['already-revoked', 'revoked']);
    assert.equal((await withOrdinaryConnection(dbPath, readState)).sequence, 1);
    await store.close();
  });

  it('two store instances on one file (separate writers) both commit — a stale plan is re-planned, never committed', async () => {
    const dbPath = tempDbPath('concurrent-writers');
    const writerA = await openDurableStore(dbPath);
    const writerB = await openDurableStore(dbPath);
    const first = await issueInto(writerA, 1);
    const second = await issueInto(writerA, 2);
    const outcomes = await Promise.all([revoke(writerA, first.id), revoke(writerB, second.id)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['revoked', 'revoked']);
    assert.equal((await withOrdinaryConnection(dbPath, readState)).sequence, 2);
    assert.ok((await writerB.read(first.id)).revocation !== undefined);
    assert.ok((await writerA.read(second.id)).revocation !== undefined);
    await writerA.close();
    await writerB.close();
  });

  it('a revocation is never committed over a state that does not verify — tampering is not laundered into a new signature', async () => {
    const dbPath = tempDbPath('no-laundering');
    const store = await openDurableStore(dbPath);
    const revoked = await issueInto(store, 1);
    const other = await issueInto(store, 2);
    await revoke(store, revoked.id);
    await store.close();

    await withAttacker(dbPath, (db) => unrevoke(db, revoked.id));
    const reopened = await openDurableStore(dbPath);
    // Revoking another grant would re-sign the commitment. If it were signed
    // over the rows as found, the deletion above would become authentic.
    await assert.rejects(() => revoke(reopened, other.id), INCONSISTENT);
    await assert.rejects(() => reopened.read(revoked.id), INCONSISTENT);
    await reopened.close();
    const state = await withOrdinaryConnection(dbPath, readState);
    assert.equal(state.sequence, 1, 'nothing was signed over the tampered state');
  });

  it('issuance into a store whose revocation state cannot be proven is refused', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('issue-refused');
    await withAttacker(dbPath, (db) => unrevoke(db, grant.id));
    const store = await openDurableStore(dbPath);
    await assert.rejects(() => issueInto(store, 2), INCONSISTENT);
    await store.close();
  });

  it('the append-only triggers stop an ordinary connection (defense in depth — not the security boundary)', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('triggers');
    await withOrdinaryConnection(dbPath, (db) => {
      assert.throws(() => db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id), /append-only/);
      assert.throws(() => db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id), /linking its revocation/);
      assert.throws(() => db.prepare('DELETE FROM bounded_grant_revocation_state').run(), /never deleted/);
      assert.throws(() => db.prepare('UPDATE bounded_grant_revocation_state SET sequence = 0').run(), /only advances/);
    });
  });
});

// ---------------------------------------------------------------------------
// Key rotation, legacy state and health
// ---------------------------------------------------------------------------

describe('CORE-01 — rotation, legacy state and health', () => {
  it('after a key rotation the unchanged commitment is re-attested under the active key, so the old key can be retired', async () => {
    const dbPath = tempDbPath('rotation');
    const era1 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A] }) });
    const grant = await issueInto(era1);
    await revoke(era1, grant.id);
    await era1.close();
    const before = await withOrdinaryConnection(dbPath, readState);
    assert.equal(before.signing_key_id, AUTHORITY_KEY_A.keyId);

    const era2 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) });
    await era2.close();
    const after = await withOrdinaryConnection(dbPath, readState);
    assert.equal(after.signing_key_id, AUTHORITY_KEY_B.keyId);
    assert.equal(after.sequence, before.sequence, 're-attestation changes the signature, never the state');
    assert.equal(after.revocation_set_digest, before.revocation_set_digest);
  });

  it('re-attestation never signs a state that does not verify', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('rotation-tampered');
    await withAttacker(dbPath, (db) => unrevoke(db, grant.id));
    const before = await withOrdinaryConnection(dbPath, readState);
    const era2 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) });
    await assert.rejects(() => era2.read(grant.id), INCONSISTENT);
    await era2.close();
    assert.deepEqual(await withOrdinaryConnection(dbPath, readState), before, 'a tampered state is left exactly as found');
  });

  it('a v2 (pre-CORE-01) database is refused at open and not migrated — its revocation set cannot be proven complete', async () => {
    const dbPath = tempDbPath('legacy-v2');
    await withOrdinaryConnection(dbPath, (db) => {
      db.exec(`CREATE TABLE bounded_grant_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);
        CREATE TABLE bounded_grants (grant_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, grant_digest TEXT NOT NULL, revocation_digest TEXT, committed_at TEXT NOT NULL, schema_version TEXT NOT NULL, signature_algorithm TEXT NOT NULL, signing_key_id TEXT NOT NULL, signature TEXT NOT NULL, signature_version TEXT NOT NULL);`);
      db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run('aoc.bounded-grant-store.schema.v2', NOW);
    });
    await assert.rejects(() => openDurableStore(dbPath), refusedWith('BOUNDED_GRANT_STORE_UNAVAILABLE'));
    const tables = await withOrdinaryConnection(dbPath, (db) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((row) => row.name));
    assert.equal(tables.includes('bounded_grant_revocation_state'), false, 'no commitment may be minted for legacy state');
  });

  it('health reports a verified revocation state when it is, and unhealthy with the failure code when it is not', async () => {
    const { dbPath, grant } = await revokedGrantOnDisk('health');
    const healthy = await openDurableStore(dbPath);
    const good = await healthy.health();
    assert.equal(good.status, 'healthy');
    assert.equal(good.revocationState, 'verified');
    assert.equal(good.revocationSequence, 1);
    await healthy.close();

    await withAttacker(dbPath, (db) => unrevoke(db, grant.id));
    const tampered = await openDurableStore(dbPath);
    const bad = await tampered.health();
    assert.equal(bad.status, 'unhealthy');
    assert.equal(bad.revocationState, 'failed');
    assert.equal(bad.revocationStateFailure, 'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT');
    assert.equal(JSON.stringify(bad).includes('PRIVATE KEY'), false);
    await tampered.close();
  });
});

// ---------------------------------------------------------------------------
// O, P — composition: no silent authenticity downgrade
// ---------------------------------------------------------------------------

describe('CORE-01 — composition refuses a silent authenticity downgrade', () => {
  const RESOLVE_BINDING = () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }) as const;

  function durableConfiguration(dir: string) {
    return loadEnterpriseConfiguration({
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      ...authorityAuthenticityEnv(),
      AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
      AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
      AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
      AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
      AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency.sqlite'),
      AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
      AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'outcomes.sqlite'),
      AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'resolutions.sqlite'),
      AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'events.sqlite'),
    });
  }

  function hostDir(name: string): string {
    return mkdtempSync(join(workDir, `${name}-`));
  }

  async function compose(configuration: ReturnType<typeof loadEnterpriseConfiguration> | undefined, grantStore?: BoundedGrantStorePort) {
    return createEnterprise({
      ...(configuration !== undefined ? { configuration } : {}),
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: RESOLVE_BINDING,
        ...(grantStore !== undefined ? { grantStore } : {}),
      },
    });
  }

  const NOT_AUTHENTICATED = (error: unknown) => isExecutionGovernanceError(error) && error.code === 'EXECUTION_GRANT_STORE_NOT_AUTHENTICATED';

  it('O. a durable deployment refuses a host-supplied in-memory grant store', async () => {
    await assert.rejects(() => compose(durableConfiguration(hostDir('o-memory')), createInMemoryBoundedGrantStore()), NOT_AUTHENTICATED);
  });

  it('O. a durable deployment refuses a custom store that merely has the right shape', async () => {
    const custom: BoundedGrantStorePort = { read: async () => ({}), issue: async () => ({ outcome: 'refused', reasonCodes: [] }), revoke: async () => ({ outcome: 'refused', reasonCodes: [] }) };
    await assert.rejects(() => compose(durableConfiguration(hostDir('o-custom')), custom), NOT_AUTHENTICATED);
  });

  it('O. a durable deployment refuses a WRAPPER around a genuine authenticated store — a wrapper can drop what the store verifies', async () => {
    const dir = hostDir('o-wrapper');
    const real = await openDurableStore(join(dir, 'host-grants.sqlite'));
    const wrapper: BoundedGrantStorePort = { read: (id) => real.read(id), issue: (input) => real.issue(input), revoke: (input) => real.revoke(input) };
    await assert.rejects(() => compose(durableConfiguration(dir), wrapper), NOT_AUTHENTICATED);
    await real.close();
  });

  it('O. the branded store cannot be patched after the fact — it is frozen', async () => {
    const store = await openDurableStore(tempDbPath('frozen'));
    assert.ok(isAuthenticatedDurableBoundedGrantStore(store));
    assert.ok(Object.isFrozen(store));
    assert.throws(() => {
      (store as { read: unknown }).read = async () => ({});
    }, TypeError);
    assert.equal(isAuthenticatedDurableBoundedGrantStore({ ...store }), false, 'a copy is not the authenticated store');
    await store.close();
  });

  it('O. a durable deployment accepts a host-supplied authenticated durable store, and reports it as such', async () => {
    const dir = hostDir('o-accepted');
    const store = await openDurableStore(join(dir, 'host-grants.sqlite'));
    const enterprise = await compose(durableConfiguration(dir), store);
    const health = await enterprise.health();
    const module = health.modules?.[AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID]?.health;
    assert.equal(module?.details?.grantStore, 'authenticated-durable');
    assert.equal(module?.details?.revocationState, 'verified');
    await enterprise.close();
    await store.close();
  });

  it('O. a durable deployment that supplies no store opens the authenticated one itself, and its health says so', async () => {
    const enterprise = await compose(durableConfiguration(hostDir('o-default')));
    const health = await enterprise.health();
    const module = health.modules?.[AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID]?.health;
    assert.equal(module?.details?.grantStore, 'authenticated-durable');
    await enterprise.close();
  });

  it('P. a memory deployment keeps accepting the in-memory store — and says it is unauthenticated rather than looking identical', async () => {
    const enterprise = await compose(undefined, createInMemoryBoundedGrantStore());
    const health = await enterprise.health();
    const module = health.modules?.[AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID]?.health;
    assert.equal(module?.details?.grantStore, 'unauthenticated');
    await enterprise.close();
  });

  it('P. the in-memory store remains a working store for unit tests and ephemeral development', async () => {
    const store = createInMemoryBoundedGrantStore();
    const grant = await issueInto(store);
    assert.equal((await exercise(store, grant)).status, 'executed');
    await revoke(store, grant.id);
    await assertNotExercisable(store, grant);
    assert.equal(isAuthenticatedDurableBoundedGrantStore(store), false);
  });
});

// ---------------------------------------------------------------------------
// Composition fail-closed branches of the key boundary (MASTER-00 CORE-01 (c))
// ---------------------------------------------------------------------------

describe('CORE-01 — every fail-closed branch of the composed key boundary is tested', () => {
  function sqliteConfiguration(env: Readonly<Record<string, string>>) {
    const dir = mkdtempSync(join(workDir, 'keys-'));
    return loadEnterpriseConfiguration({
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
      AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
      AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
      AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
      AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency.sqlite'),
      ...env,
    });
  }

  async function composeWith(env: Readonly<Record<string, string>>) {
    return createEnterprise({
      configuration: sqliteConfiguration(env),
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      },
    });
  }

  it('an active signing key that is not in the trusted verification set is refused', async () => {
    await assert.rejects(
      () =>
        composeWith({
          AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: AUTHORITY_KEY_A.keyId,
          AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem,
          AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([trustedKeyOf(AUTHORITY_KEY_B)]),
        }),
      (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /not present in the trusted verification set/.test(error.message),
    );
  });

  it('a signing key whose public half does not match the key registered under its id is refused', async () => {
    await assert.rejects(
      () =>
        composeWith({
          AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: AUTHORITY_KEY_A.keyId,
          AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem,
          AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([{ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_B.publicKeyPem }]),
        }),
      (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /does not match/.test(error.message),
    );
  });

  it('malformed verification-key JSON never yields a durable store', async () => {
    let outcome: unknown;
    try {
      const enterprise = await composeWith({
        AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: AUTHORITY_KEY_A.keyId,
        AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem,
        AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: '{not json',
      });
      await enterprise.close();
      outcome = 'composed';
    } catch (error) {
      outcome = error;
    }
    // Malformed JSON parses to an empty trusted set, so the active key is not
    // trusted and composition refuses — it never yields a store that trusts
    // nothing, or anything.
    assert.ok(outcome instanceof AuthorityAuthenticityConfigurationError, `malformed trusted-key configuration must fail composition, got ${String(outcome)}`);
    assert.match(outcome.message, /not present in the trusted verification set/);
    assert.equal(outcome.message.includes('PRIVATE KEY'), false, 'the refusal must not echo key material');
  });
});
