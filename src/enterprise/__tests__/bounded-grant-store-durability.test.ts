import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GRANT_REASON_CODES,
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
import { type DurableBoundedGrantStore } from '../bounded-grant-store/index.js';
import { openDurableStore } from './authority-authenticity-fixture.js';
import { isBoundedGrantStoreError } from '../bounded-grant-store/errors.js';

/**
 * The durable authoritative store's security properties, each measured across a
 * **real** process boundary: every "restart" below closes the store and reopens
 * a new one over the same file, so nothing is carried across in memory.
 *
 * The suite is organised around the one asymmetry that matters. Losing a grant
 * fails closed; losing a revocation fails open. So the tests that get the most
 * attention are the ones that try to make a revoked grant readable again — by
 * restarting, by deleting the revocation row, by clearing the grant's reference
 * to it, and by corrupting either record.
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

const workDir = mkdtempSync(join(tmpdir(), 'aoc-bounded-grant-durability-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function tempDbPath(name: string): string {
  dbCounter += 1;
  return join(workDir, `${name}-${dbCounter}.sqlite`);
}

async function issueInto(store: BoundedGrantStorePort): Promise<BoundedGrant> {
  const outcome = await createGrantIssuanceService({ store }).issueGrant({
    source: SOURCE,
    subject: 'actor-a',
    correlation: CORRELATION,
    issuedAt: NOW,
    expiresAt: HORIZON,
  });
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return outcome.grant;
}

/** Direct database access, used only to simulate the corruption and deletion a privileged writer could perform. */
async function withRawDb<T>(dbPath: string, run: (db: import('better-sqlite3').Database) => T): Promise<T> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function assertCorrupt(error: unknown): true {
  assert.ok(isBoundedGrantStoreError(error), `expected a BoundedGrantStoreError, got ${String(error)}`);
  assert.equal(error.code, 'BOUNDED_GRANT_STORE_STATE_CORRUPT');
  return true;
}

describe('Durable grant store — committed state survives a restart', () => {
  it('a committed issuance is readable from a freshly opened store (GS-INV-001)', async () => {
    const dbPath = tempDbPath('issue-survives');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    const second = await openDurableStore(dbPath);
    const read = await second.read(grant.id);
    assert.deepEqual(read.grant, grant, 'the grant that comes back must be the grant that was written, field for field');
    assert.equal(read.revocation, undefined);
    await second.close();
  });

  it('a committed revocation survives a restart — the half that must never be lost (GS-INV-003, GS-INV-005)', async () => {
    const dbPath = tempDbPath('revoke-survives');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    const revoked = await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    assert.equal(revoked.outcome, 'revoked');
    await first.close();

    const second = await openDurableStore(dbPath);
    const read = await second.read(grant.id);
    assert.ok(read.grant !== undefined, 'the grant itself is still there');
    assert.deepEqual(read.revocation, { grantId: grant.id, revokedAt: BEFORE_HORIZON, reason: 'security-incident', issuerRef: 'operator-a' });
    await second.close();
  });

  it('a restart never increases authority: a revoked grant is still unusable to the execution path (GS-INV-014)', async () => {
    const dbPath = tempDbPath('restart-monotonic');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'administrator-revoked', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    const second = await openDurableStore(dbPath);
    const adapter = createRecordingExecutionAdapter();
    const execution = createGrantExecutionService({ store: second, adapter, now: () => BEFORE_HORIZON });

    const outcome = await execution.exercise({
      boundedGrantId: grant.id,
      correlation: CORRELATION,
      executionId: 'exec-1',
      subject: 'actor-a',
      action: 'payment.send',
      resource: 'record:contract',
      amount: { value: '100', unit: 'USD' },
    });

    assert.equal(outcome.status, 'withheld');
    assert.equal(adapter.callCount, 0, 'a revocation that survived the restart must still withhold the adapter');
    await second.close();
  });

  it('the revocation is idempotent across a restart — the first one stands (GS-INV-010)', async () => {
    const dbPath = tempDbPath('revoke-idempotent');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    const second = await openDurableStore(dbPath);
    const again = await second.revoke({ grantId: grant.id, reason: 'policy-changed', revokedAt: HORIZON, issuerRef: 'operator-b' });
    assert.equal(again.outcome, 'already-revoked');
    assert.equal(again.outcome === 'already-revoked' ? again.revocation.reason : undefined, 'security-incident', 'a later call is not new information about when a grant stopped being exercisable');
    assert.equal(again.outcome === 'already-revoked' ? again.revocation.revokedAt : undefined, BEFORE_HORIZON);
    await second.close();
  });

  it('a re-delivered issuance across a restart resolves to the existing grant rather than a second one', async () => {
    const dbPath = tempDbPath('duplicate-issue');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    const second = await openDurableStore(dbPath);
    const repeat = await createGrantIssuanceService({ store: second }).issueGrant({
      source: SOURCE,
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW,
      expiresAt: HORIZON,
    });
    assert.equal(repeat.outcome, 'already-issued');
    assert.deepEqual(repeat.outcome === 'already-issued' ? repeat.grant : undefined, grant);

    const rows = await withRawDb(dbPath, (db) => (db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { n: number }).n);
    assert.equal(rows, 1, 'a deterministic identity must collide rather than duplicate');
    await second.close();
  });

  it('a grant revoked before re-issuance is precluded, and stays precluded across a restart', async () => {
    const dbPath = tempDbPath('revoked-preclusion');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    const second = await openDurableStore(dbPath);
    const repeat = await createGrantIssuanceService({ store: second }).issueGrant({
      source: SOURCE,
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW,
      expiresAt: HORIZON,
    });
    // The grant row still stands, so the store reports the existing artifact
    // rather than minting a second one — and the revocation beside it keeps it
    // unusable. Either way no new authority appears.
    assert.equal(repeat.outcome, 'already-issued');
    const read = await second.read(grant.id);
    assert.ok(read.revocation !== undefined, 'the revocation must still be the thing that governs');
    await second.close();
  });
});

describe('Durable grant store — nothing is acknowledged before it is committed', () => {
  it('a refused commit guard writes no grant, and the refusal is not a partial issuance (GS-INV-013)', async () => {
    const dbPath = tempDbPath('guard-refused');

    const store = await openDurableStore(dbPath);
    const outcome = await createGrantIssuanceService({
      store,
      revalidateSource: () => undefined,
    }).issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });

    assert.equal(outcome.outcome, 'refused');
    const rows = await withRawDb(dbPath, (db) => (db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { n: number }).n);
    assert.equal(rows, 0, 'a refusal must leave no row behind');
    await store.close();
  });

  it('a commit guard that throws leaves the database untouched — the transaction rolls back', async () => {
    const dbPath = tempDbPath('guard-throws');

    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });

    await assert.rejects(
      () =>
        store.issue({
          grant: { ...grant, id: `${grant.id}-other` },
          commitGuard: () => {
            throw new Error('the authoritative source could not be read');
          },
        }),
      /authoritative source/,
    );

    const rows = await withRawDb(dbPath, (db) => (db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { n: number }).n);
    assert.equal(rows, 1, 'only the original grant may remain');
    await store.close();
  });

  it('revocation is never reported as successful without a committed record', async () => {
    const dbPath = tempDbPath('revoke-commit');

    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    const outcome = await store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    assert.equal(outcome.outcome, 'revoked');

    // Read through a *different* connection, so what is asserted is the
    // committed state rather than anything held by the writing handle.
    const committed = await withRawDb(dbPath, (db) => db.prepare('SELECT revocation_digest FROM bounded_grant_revocations WHERE grant_id = ?').get(grant.id));
    assert.ok(committed !== undefined, 'the acknowledgement must not precede the commit');
    await store.close();
  });

  it('revoking a grant that does not exist is refused, not silently recorded', async () => {
    const dbPath = tempDbPath('revoke-unknown');
    const store = await openDurableStore(dbPath);

    const outcome = await store.revoke({ grantId: 'aoc.grant:nothing', reason: 'security-incident', revokedAt: NOW, issuerRef: 'operator-a' });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(outcome.outcome === 'refused' ? outcome.reasonCodes : [], [GRANT_REASON_CODES.GRANT_NOT_FOUND]);

    const rows = await withRawDb(dbPath, (db) => (db.prepare('SELECT COUNT(*) AS n FROM bounded_grant_revocations').get() as { n: number }).n);
    assert.equal(rows, 0);
    await store.close();
  });
});

describe('Durable grant store — corrupt authority state fails closed', () => {
  it('a mutated grant record is refused, never repaired (GS-INV-007, GS-INV-011)', async () => {
    const dbPath = tempDbPath('grant-corrupt');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    // Widen the grant's ceiling without touching either digest — the casual
    // mutation an unkeyed digest is genuinely able to detect.
    await withRawDb(dbPath, (db) => {
      const changes = db.prepare('UPDATE bounded_grants SET grant_json = replace(grant_json, \'"limit":"10000"\', \'"limit":"99000"\') WHERE grant_id = ?').run(grant.id).changes;
      assert.equal(changes, 1, 'the mutation the test depends on must actually have happened');
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a grant record whose bytes are not canonical is refused rather than normalized', async () => {
    const dbPath = tempDbPath('grant-noncanonical');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    // Same values, extra whitespace: a round trip that would silently succeed
    // if the store trusted `JSON.parse` instead of the canonical bytes.
    await withRawDb(dbPath, (db) => {
      const row = db.prepare('SELECT grant_json FROM bounded_grants WHERE grant_id = ?').get(grant.id) as { grant_json: string };
      db.prepare('UPDATE bounded_grants SET grant_json = ? WHERE grant_id = ?').run(`${row.grant_json} `, grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a mutated revocation record is refused — the grant does not become usable again (GS-INV-009)', async () => {
    const dbPath = tempDbPath('revocation-corrupt');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare(`UPDATE bounded_grant_revocations SET reason = 'expired' WHERE grant_id = ?`).run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a revocation carrying a reason outside the closed vocabulary is refused', async () => {
    const dbPath = tempDbPath('revocation-vocabulary');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare(`UPDATE bounded_grant_revocations SET reason = 'because-i-said-so' WHERE grant_id = ?`).run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('DELETING the revocation row does not restore authority — the grant stops being readable (GS-INV-006)', async () => {
    const dbPath = tempDbPath('revocation-deleted');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(
      () => second.read(grant.id),
      assertCorrupt,
    );
    await second.close();
  });

  it('CLEARING the grant’s reference to its revocation does not restore authority either', async () => {
    const dbPath = tempDbPath('pointer-cleared');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a revocation record for a grant that does not exist is refused rather than ignored', async () => {
    const dbPath = tempDbPath('orphan-revocation');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM bounded_grants WHERE grant_id = ?').run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a record written under an unrecognized schema version is refused, never reinterpreted (GS-INV-011)', async () => {
    const dbPath = tempDbPath('row-schema');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare(`UPDATE bounded_grants SET schema_version = 'aoc.bounded-grant-store.schema.v9' WHERE grant_id = ?`).run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertCorrupt);
    await second.close();
  });

  it('a database recorded under a foreign schema version is not opened at all, and is not mutated by the attempt', async () => {
    const dbPath = tempDbPath('db-schema');

    await withRawDb(dbPath, (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS bounded_grant_store_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
      db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run('aoc.bounded-grant-store.schema.v9', NOW);
    });

    await assert.rejects(
      () => openDurableStore(dbPath),
      (error: unknown) => isBoundedGrantStoreError(error) && error.code === 'BOUNDED_GRANT_STORE_UNAVAILABLE',
    );

    const tables = await withRawDb(dbPath, (db) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((row) => row.name));
    for (const table of ['bounded_grants', 'bounded_grant_revocations']) {
      assert.equal(tables.includes(table), false, `a refused store must not gain this runtime’s data tables (${table})`);
    }
  });

  it('an exercise against corrupt state withholds rather than raising — the execution path reads a throw as “no grant”', async () => {
    const dbPath = tempDbPath('exercise-corrupt');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();
    await withRawDb(dbPath, (db) => {
      db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id);
    });

    const second = await openDurableStore(dbPath);
    const adapter = createRecordingExecutionAdapter();
    const outcome = await createGrantExecutionService({ store: second, adapter, now: () => BEFORE_HORIZON }).exercise({
      boundedGrantId: grant.id,
      correlation: CORRELATION,
      executionId: 'exec-1',
      subject: 'actor-a',
      action: 'payment.send',
      resource: 'record:contract',
      amount: { value: '100', unit: 'USD' },
    });

    assert.equal(outcome.status, 'withheld');
    assert.equal(adapter.callCount, 0);
    await second.close();
  });
});

describe('Durable grant store — an unavailable store withholds, it never falls back', () => {
  it('a closed store refuses every operation rather than answering from anywhere else (GS-INV-004)', async () => {
    const dbPath = tempDbPath('closed');

    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.close();

    const unavailable = (error: unknown): boolean => isBoundedGrantStoreError(error) && error.code === 'BOUNDED_GRANT_STORE_UNAVAILABLE';
    await assert.rejects(() => store.read(grant.id), unavailable);
    await assert.rejects(() => store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: NOW, issuerRef: 'operator-a' }), unavailable);
    await assert.rejects(() => store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) }), unavailable);
  });

  it('an exercise against an unavailable store withholds, and the adapter is not called (GS-INV-007)', async () => {
    const dbPath = tempDbPath('unavailable-exercise');

    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.close();

    const adapter = createRecordingExecutionAdapter();
    const outcome = await createGrantExecutionService({ store, adapter, now: () => BEFORE_HORIZON }).exercise({
      boundedGrantId: grant.id,
      correlation: CORRELATION,
      executionId: 'exec-1',
      subject: 'actor-a',
      action: 'payment.send',
      resource: 'record:contract',
      amount: { value: '100', unit: 'USD' },
    });

    assert.equal(outcome.status, 'withheld');
    assert.equal(adapter.callCount, 0, 'a store outage must never be mistaken for an authorization');
  });

  it('reports itself unhealthy once closed', async () => {
    const store = await openDurableStore(tempDbPath('health'));
    assert.equal((await store.health()).status, 'healthy');
    await store.close();
    assert.equal((await store.health()).status, 'unhealthy');
  });
});

describe('Durable grant store — the same contract as the in-memory store', () => {
  /**
   * The durable store is not a second set of semantics. Every outcome below is
   * asserted against both implementations from the same script, so a divergence
   * shows up here rather than in production.
   */
  async function bothStores(): Promise<readonly { readonly label: string; readonly store: BoundedGrantStorePort; readonly close: () => Promise<void> }[]> {
    const durable: DurableBoundedGrantStore = await openDurableStore(tempDbPath('parity'));
    return [
      { label: 'in-memory', store: createInMemoryBoundedGrantStore(), close: async () => {} },
      { label: 'sqlite', store: durable, close: () => durable.close() },
    ];
  }

  it('issue, read, revoke, re-read and re-revoke agree on every outcome', async () => {
    for (const { label, store, close } of await bothStores()) {
      const grant = await issueInto(store);

      const read = await store.read(grant.id);
      assert.deepEqual(read.grant, grant, `${label}: read returns the issued grant`);
      assert.equal(read.revocation, undefined, `${label}: nothing is revoked yet`);

      const revoked = await store.revoke({ grantId: grant.id, reason: 'manual-revocation', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
      assert.equal(revoked.outcome, 'revoked', `${label}: first revocation`);

      const afterRevoke = await store.read(grant.id);
      assert.deepEqual(afterRevoke.grant, grant, `${label}: revocation never rewrites the artifact`);
      assert.deepEqual(afterRevoke.revocation, { grantId: grant.id, revokedAt: BEFORE_HORIZON, reason: 'manual-revocation', issuerRef: 'operator-a' }, `${label}: revocation is visible`);

      const again = await store.revoke({ grantId: grant.id, reason: 'policy-changed', revokedAt: HORIZON, issuerRef: 'operator-b' });
      assert.equal(again.outcome, 'already-revoked', `${label}: revocation is idempotent`);

      const unknown = await store.read('aoc.grant:absent');
      assert.deepEqual(unknown, {}, `${label}: an unknown id resolves to nothing, never to a near match`);

      await close();
    }
  });

  it('a refused commit guard produces the same refusal, with the guard’s own reason codes', async () => {
    for (const { label, store, close } of await bothStores()) {
      const grant = await issueInto(store);
      const outcome = await store.issue({
        grant: { ...grant, id: `${grant.id}-second` },
        commitGuard: () => ({ permitted: false, reasonCodes: [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED] }),
      });
      assert.equal(outcome.outcome, 'refused', `${label}: a refused guard refuses`);
      assert.deepEqual(outcome.outcome === 'refused' ? outcome.reasonCodes : [], [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED], `${label}: the guard’s reasons are reported`);
      await close();
    }
  });

  it('a refused guard with no reason codes falls back to GRANT_ELIGIBILITY_CHANGED in both', async () => {
    for (const { label, store, close } of await bothStores()) {
      const grant = await issueInto(store);
      const outcome = await store.issue({ grant: { ...grant, id: `${grant.id}-third` }, commitGuard: () => ({ permitted: false, reasonCodes: [] }) });
      assert.deepEqual(outcome.outcome === 'refused' ? outcome.reasonCodes : [], [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED], `${label}`);
      await close();
    }
  });

  it('a revocation reason outside the closed vocabulary is refused by both', async () => {
    for (const { label, store, close } of await bothStores()) {
      const grant = await issueInto(store);
      // Cast at the boundary only: the point of the test is what a store does
      // with a value the type system would have stopped.
      const outcome = await store.revoke({ grantId: grant.id, reason: 'made-up' as never, revokedAt: NOW, issuerRef: 'operator-a' });
      assert.equal(outcome.outcome, 'refused', `${label}`);
      await close();
    }
  });
});

describe('Durable grant store — repeated exercise stays exactly as permissive as it was', () => {
  it('a usable grant may still be exercised repeatedly, and durability changes nothing about that (NB-006)', async () => {
    const dbPath = tempDbPath('repeated-exercise');

    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    const second = await openDurableStore(dbPath);
    const adapter = createRecordingExecutionAdapter();
    const execution = createGrantExecutionService({ store: second, adapter, now: () => BEFORE_HORIZON });
    const request = {
      boundedGrantId: grant.id,
      correlation: CORRELATION,
      executionId: 'exec-1',
      subject: 'actor-a',
      action: 'payment.send',
      resource: 'record:contract',
      amount: { value: '100', unit: 'USD' },
    } as const;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await execution.exercise({ ...request, executionId: `exec-${attempt}` });
      assert.equal(outcome.status, 'executed', 'the store must not have invented a consumption model');
    }
    assert.equal(adapter.callCount, 3);

    const rowShape = await withRawDb(dbPath, (db) => (db.prepare('PRAGMA table_info(bounded_grants)').all() as { name: string }[]).map((row) => row.name));
    for (const forbidden of ['use_count', 'uses_remaining', 'consumed', 'exercise_count']) {
      assert.equal(rowShape.includes(forbidden), false, `the durable schema must invent no consumption model (${forbidden})`);
    }
    await second.close();
  });
});
