import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMERGENCY_CONTROL_REASON_CODES,
  emergencyControlPermits,
  type EmergencyControlQuery,
} from '../../features/emergency-control-runtime/index.js';
import { createSqliteEmergencyControlStore, type DurableEmergencyControlStore } from '../emergency-control/index.js';
import { isEmergencyControlStoreError } from '../emergency-control/errors.js';
import { EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, storedEmergencyControlDigest } from '../emergency-control/emergency-control-record.js';

/**
 * The durable interlock's properties, each measured across a **real** process
 * boundary: every "restart" below closes the store and opens a new one over the
 * same file, so nothing is carried across in memory.
 *
 * The asymmetry that organises this suite is the mirror image of the grant
 * store's. There, losing a revocation fails open. Here, losing — or quietly
 * repairing — a *control* fails open: the kill switch stops killing while an
 * operator believes it is on. So the tests that get the most attention are the
 * ones that try to make an active control read as clear, by restarting, by
 * flipping the flag, by corrupting the row and by deleting it.
 */

const ISSUER = 'operator:on-call';
const AT = '2026-01-01T12:00:00.000Z';

const workDir = mkdtempSync(join(tmpdir(), 'aoc-emergency-control-durability-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function tempDbPath(name: string): string {
  dbCounter += 1;
  return join(workDir, `${name}-${dbCounter}.sqlite`);
}

const opened: DurableEmergencyControlStore[] = [];
after(async () => {
  for (const store of opened) await store.close().catch(() => {});
});

async function open(dbPath: string): Promise<DurableEmergencyControlStore> {
  const store = await createSqliteEmergencyControlStore(dbPath, { now: () => AT });
  opened.push(store);
  return store;
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

const QUERY: EmergencyControlQuery = { organizationId: 'org-acme', actorId: 'agent-A', adapterId: 'adapter-a', resource: 'vendor/V123' };

describe('Durable emergency control — a stop survives a restart', () => {
  it('a global control is still active after close and reopen', async () => {
    const dbPath = tempDbPath('global');
    const first = await open(dbPath);
    first.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(first.read(QUERY)), false);
    await first.close();

    const reopened = await open(dbPath);
    const assessment = reopened.read(QUERY);
    assert.equal(assessment.state, 'blocked', 'a stop that does not survive a restart is not a stop');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
  });

  it('a released control is still released after close and reopen', async () => {
    const dbPath = tempDbPath('global-release');
    const first = await open(dbPath);
    first.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    first.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT });
    await first.close();

    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'clear', 'a release that does not survive a restart would strand a deployment');
  });

  it('a scoped control survives a restart, and still matches only what it names', async () => {
    const dbPath = tempDbPath('scoped');
    const first = await open(dbPath);
    first.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    first.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });
    await first.close();

    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'blocked');
    assert.equal(reopened.read({ organizationId: 'org-other', adapterId: 'adapter-b' }).state, 'clear');
    assert.equal(reopened.read({ organizationId: 'org-other', adapterId: 'adapter-a' }).state, 'blocked');
    assert.deepEqual(
      reopened.active().map((match) => `${match.scope}:${match.value ?? ''}`).sort(),
      ['adapter:adapter-a', 'organization:org-acme'],
    );
  });

  it('a scoped release survives a restart', async () => {
    const dbPath = tempDbPath('scoped-release');
    const first = await open(dbPath);
    first.activate({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: AT });
    first.release({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, releasedAt: AT });
    await first.close();

    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'clear');
    assert.deepEqual(reopened.active(), []);
  });

  it('activating twice keeps the first declaration, across a restart', async () => {
    const dbPath = tempDbPath('idempotent');
    const first = await open(dbPath);
    first.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    first.activate({ scope: 'global', issuerRef: 'operator:someone-else', declaredAt: '2026-06-06T00:00:00.000Z' });
    await first.close();

    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'blocked');
    const row = await withRawDb(dbPath, (db) => db.prepare(`SELECT issuer_ref, declared_at FROM emergency_controls WHERE control_key = 'global'`).get() as { issuer_ref: string; declared_at: string });
    assert.equal(row.issuer_ref, ISSUER, 'the moment execution was stopped is a fact; a second activate is not new information about it');
    assert.equal(row.declared_at, AT);
  });
});

describe('Durable emergency control — corrupt state is never repaired into clear', () => {
  async function activeGlobal(name: string): Promise<string> {
    const dbPath = tempDbPath(name);
    const store = await open(dbPath);
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(store.read(QUERY).state, 'blocked');
    await store.close();
    return dbPath;
  }

  it('flipping the active flag under the digest is detected, and reads unavailable rather than clear', async () => {
    const dbPath = await activeGlobal('flip');
    // The exact attack this design exists to catch: a privileged writer turns
    // the kill switch off without re-sealing the record.
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET active = 0 WHERE control_key = 'global'`).run());

    const reopened = await open(dbPath);
    const assessment = reopened.read(QUERY);
    assert.equal(assessment.state, 'unavailable');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(emergencyControlPermits(assessment), false, 'the only direction a repair could take is "clear", which is the one direction that must never be taken');
  });

  it('a tampered digest reads unavailable', async () => {
    const dbPath = await activeGlobal('digest');
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET record_digest = 'sha256:deadbeef' WHERE control_key = 'global'`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a scope outside the closed vocabulary reads unavailable', async () => {
    const dbPath = await activeGlobal('scope');
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET scope = 'everything' WHERE control_key = 'global'`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a row filed under a key that does not match its own scope and value reads unavailable', async () => {
    const dbPath = tempDbPath('mismatched-key');
    const store = await open(dbPath);
    store.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    await store.close();
    // Re-file the row so it would be found by a query for a different tenant.
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET control_key = 'organization:org-other' WHERE control_key = 'organization:org-acme'`).run());

    const reopened = await open(dbPath);
    assert.equal(reopened.read({ organizationId: 'org-other' }).state, 'unavailable', 'a mis-filed control is state that cannot be established');
    assert.equal(reopened.read({ organizationId: 'org-acme' }).state, 'clear', 'and it no longer exists under the identity it was declared for');
  });

  it('a row recorded under an unknown record schema version reads unavailable', async () => {
    const dbPath = await activeGlobal('row-schema');
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET schema_version = 'aoc.emergency-control-store.schema.v99' WHERE control_key = 'global'`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a corrupt row for an unrelated scope does not block an unrelated query', async () => {
    const dbPath = tempDbPath('unrelated');
    const store = await open(dbPath);
    store.activate({ scope: 'organization', value: 'org-other', issuerRef: ISSUER, declaredAt: AT });
    await store.close();
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_controls SET record_digest = 'sha256:deadbeef' WHERE control_key = 'organization:org-other'`).run());

    const reopened = await open(dbPath);
    // Fail-closed is about the controls that *apply*. Stopping every tenant
    // because one unrelated row is unreadable would be an availability failure
    // nobody chose, and it would not make anyone safer.
    assert.equal(reopened.read({ organizationId: 'org-acme' }).state, 'clear');
    assert.equal(reopened.read({ organizationId: 'org-other' }).state, 'unavailable');
  });

  it('deleting an active control removes it — durability protects the record, not the intent behind it', async () => {
    const dbPath = await activeGlobal('deleted');
    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_controls WHERE control_key = 'global'`).run());
    const reopened = await open(dbPath);
    // Stated plainly rather than papered over: an unkeyed digest detects a
    // *modified* row, and cannot detect a *deleted* one. A writer with raw
    // database access can clear a control, and this store does not claim
    // otherwise. See docs/enterprise/AOC_EMERGENCY_CONTROL.md.
    assert.equal(reopened.read(QUERY).state, 'clear');
  });

  it('a database recorded under an unknown store schema version is refused rather than migrated', async () => {
    const dbPath = await activeGlobal('store-schema');
    await withRawDb(dbPath, (db) => db.prepare(`INSERT INTO emergency_control_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.emergency-control-store.schema.v99', 'current', ?)`).run(AT));
    await assert.rejects(
      () => createSqliteEmergencyControlStore(dbPath, { now: () => AT }),
      (error: unknown) => isEmergencyControlStoreError(error) && error.code === 'EMERGENCY_CONTROL_STORE_UNAVAILABLE',
    );
  });

  it('the digest covers the active flag, which is what makes a flipped flag detectable', () => {
    const base = { controlKey: 'global', scope: 'global', active: true, issuerRef: ISSUER, declaredAt: AT } as const;
    assert.notEqual(storedEmergencyControlDigest(base), storedEmergencyControlDigest({ ...base, active: false }));
    assert.equal(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, 'aoc.emergency-control-store.schema.v1');
  });
});

describe('Durable emergency control — a closed store withholds, and refuses to be written', () => {
  it('reads report unavailable rather than throwing, because the read runs inside a commit guard', async () => {
    const dbPath = tempDbPath('closed');
    const store = await open(dbPath);
    await store.close();
    const assessment = store.read(QUERY);
    assert.equal(assessment.state, 'unavailable');
    assert.equal(emergencyControlPermits(assessment), false);
  });

  it('operator mutations throw loudly, because an operator is entitled to know a stop did not take', async () => {
    const dbPath = tempDbPath('closed-write');
    const store = await open(dbPath);
    await store.close();
    assert.throws(() => store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT }), (error: unknown) => isEmergencyControlStoreError(error));
    assert.throws(() => store.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT }), (error: unknown) => isEmergencyControlStoreError(error));
  });

  it('a malformed declaration or release is refused at write time', async () => {
    const store = await open(tempDbPath('malformed'));
    for (const declaration of [
      { scope: 'organization', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'global', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'nonsense', value: 'x', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'actor', value: 'agent-A', issuerRef: '', declaredAt: AT },
    ]) {
      assert.throws(
        () => store.activate(declaration as never),
        (error: unknown) => isEmergencyControlStoreError(error) && error.code === 'EMERGENCY_CONTROL_DECLARATION_INVALID',
      );
    }
    for (const release of [
      { scope: 'organization', issuerRef: ISSUER, releasedAt: AT },
      { scope: 'nonsense', value: 'x', issuerRef: ISSUER, releasedAt: AT },
      { scope: 'global', issuerRef: ISSUER, releasedAt: '' },
    ]) {
      assert.throws(
        () => store.release(release as never),
        (error: unknown) => isEmergencyControlStoreError(error) && error.code === 'EMERGENCY_CONTROL_DECLARATION_INVALID',
      );
    }
    assert.deepEqual(store.active(), []);
  });

  it('a malformed query reads unavailable rather than matching nothing', async () => {
    const store = await open(tempDbPath('malformed-query'));
    assert.equal(store.read({ organizationId: '' }).state, 'unavailable');
  });

  it('health reports what it can read, and never claims health it did not check', async () => {
    const dbPath = tempDbPath('health');
    const store = await open(dbPath);
    assert.deepEqual(
      { status: store.health().status, readable: store.health().readable, activeControls: store.health().activeControls },
      { status: 'healthy', readable: true, activeControls: 0 },
    );
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(store.health().activeControls, 1);
    await store.close();
    assert.equal(store.health().status, 'unhealthy');
    assert.equal(store.health().readable, false);
  });
});
