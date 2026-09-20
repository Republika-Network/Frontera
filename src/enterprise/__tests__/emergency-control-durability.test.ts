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
import { EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, emergencyControlEventDigest, storedEmergencyControlDigest } from '../emergency-control/emergency-control-record.js';

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
    // And — this is the part the projection-only schema got wrong — the tenant
    // the control was actually declared for does **not** read clear merely
    // because its row was moved away. History says a control exists for that
    // key; the state it produced is missing; that withholds.
    assert.equal(reopened.read({ organizationId: 'org-acme' }).state, 'unavailable', 'a control cannot be cleared by moving its row elsewhere');
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

  it('REGRESSION — deleting an active control row is detected, and withholds instead of reading clear', async () => {
    // The defect this test pins. Under the projection-only schema the read did
    // `if (row === undefined) continue`, so a deleted ACTIVE control was
    // indistinguishable from "no control was ever declared" and the reader
    // returned `clear` — a kill switch silently failing open. A legitimate
    // resume has its own `release` operation, so a row that simply vanishes is
    // damage, never consent.
    const dbPath = await activeGlobal('deleted-projection');
    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_controls WHERE control_key = 'global'`).run());

    const reopened = await open(dbPath);
    const assessment = reopened.read(QUERY);
    assert.equal(assessment.state, 'unavailable', 'a vanished active control must never read as clear');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(emergencyControlPermits(assessment), false);
    // The history is what makes it detectable: the key still has events.
    const events = await withRawDb(dbPath, (db) => db.prepare(`SELECT COUNT(*) AS c FROM emergency_control_events WHERE control_key = 'global'`).get() as { c: number });
    assert.equal(events.c, 1);
  });

  it('REGRESSION — deleting the events as well is caught by the head anchor', async () => {
    // The natural follow-up move: erase the history too, so the key looks like
    // one that was never declared. The head records how many events must exist
    // and what the highest sequence is, so the table no longer matches it.
    const dbPath = await activeGlobal('deleted-events');
    await withRawDb(dbPath, (db) => {
      db.prepare(`DELETE FROM emergency_controls WHERE control_key = 'global'`).run();
      db.prepare(`DELETE FROM emergency_control_events WHERE control_key = 'global'`).run();
    });
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
    // And it stays unavailable for every query, because the head is global state.
    assert.equal(reopened.read({ organizationId: 'org-unrelated' }).state, 'unavailable');
  });

  it('REGRESSION — deleting the head is damage, not a fresh database', async () => {
    const dbPath = await activeGlobal('deleted-head');
    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_control_head`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable', 'an initialized store always has a head; a missing one is damage');
  });

  it('the three cases a read must tell apart are told apart', async () => {
    // (a) never declared -> clear. (b) explicitly released -> clear.
    // (c) active row that disappeared -> unavailable.
    const dbPath = tempDbPath('three-cases');
    const store = await open(dbPath);
    store.activate({ scope: 'organization', value: 'org-released', issuerRef: ISSUER, declaredAt: AT });
    store.release({ scope: 'organization', value: 'org-released', issuerRef: ISSUER, releasedAt: AT });
    store.activate({ scope: 'organization', value: 'org-deleted', issuerRef: ISSUER, declaredAt: AT });
    await store.close();

    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_controls WHERE control_key = 'organization:org-deleted'`).run());
    const reopened = await open(dbPath);

    assert.equal(reopened.read({ organizationId: 'org-never-declared' }).state, 'clear', '(a) never declared');
    assert.equal(reopened.read({ organizationId: 'org-released' }).state, 'clear', '(b) explicitly released');
    assert.equal(reopened.read({ organizationId: 'org-deleted' }).state, 'unavailable', '(c) active row deleted');
  });

  it('a projection left behind a newer transition cannot stand in for it', async () => {
    // Activate, release, then roll the projection back to the activation event
    // by hand: the row is internally consistent but is no longer the latest
    // transition for its key.
    const dbPath = tempDbPath('stale-projection');
    const store = await open(dbPath);
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    store.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT });
    await store.close();

    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_control_events WHERE sequence = 2`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a projection re-pointed at another key’s event is detected', async () => {
    const dbPath = tempDbPath('repointed');
    const store = await open(dbPath);
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    store.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    await store.close();

    // Point the global projection at the organization's event, re-sealing the
    // row so its own digest still recomputes.
    await withRawDb(dbPath, (db) => {
      const other = db.prepare(`SELECT event_digest FROM emergency_control_events WHERE control_key = 'organization:org-acme'`).get() as { event_digest: string };
      db.prepare(`UPDATE emergency_controls SET event_sequence = 2, event_digest = ? WHERE control_key = 'global'`).run(other.event_digest);
    });
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a tampered event digest is detected', async () => {
    const dbPath = await activeGlobal('event-digest');
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_control_events SET transition = 'released' WHERE sequence = 1`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a head rolled back to genesis is detected', async () => {
    const dbPath = await activeGlobal('rolled-back-head');
    await withRawDb(dbPath, (db) => db.prepare(`UPDATE emergency_control_head SET event_sequence = 0, event_count = 0 WHERE id = 1`).run());
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a control projection with no history behind it is detected', async () => {
    const dbPath = await activeGlobal('orphan-projection');
    await withRawDb(dbPath, (db) => {
      db.prepare(`DELETE FROM emergency_control_events`).run();
      db.prepare(`UPDATE emergency_control_head SET event_sequence = 0, event_count = 0`).run();
    });
    const reopened = await open(dbPath);
    assert.equal(reopened.read(QUERY).state, 'unavailable');
  });

  it('a v1 database — projection only, no history — is refused at open rather than read', async () => {
    const dbPath = tempDbPath('legacy-v1');
    await withRawDb(dbPath, (db) => {
      db.exec(`CREATE TABLE emergency_control_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
      db.prepare(`INSERT INTO emergency_control_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.emergency-control-store.schema.v1', 'current', ?)`).run(AT);
    });
    await assert.rejects(
      () => createSqliteEmergencyControlStore(dbPath, { now: () => AT }),
      (error: unknown) => isEmergencyControlStoreError(error) && error.code === 'EMERGENCY_CONTROL_STORE_UNAVAILABLE',
    );
  });

  it('an operator write into unverifiable state is refused loudly rather than extending it', async () => {
    const dbPath = await activeGlobal('write-into-damage');
    await withRawDb(dbPath, (db) => db.prepare(`DELETE FROM emergency_control_head`).run());
    const reopened = await open(dbPath);
    // Reads withhold; writes refuse. An operator is entitled to learn that the
    // store cannot vouch for what they are writing into.
    assert.equal(reopened.read(QUERY).state, 'unavailable');
    assert.throws(() => reopened.activate({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: AT }), (error: unknown) => isEmergencyControlStoreError(error));
  });

  it('a database recorded under an unknown store schema version is refused rather than migrated', async () => {
    const dbPath = await activeGlobal('store-schema');
    await withRawDb(dbPath, (db) => db.prepare(`INSERT INTO emergency_control_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.emergency-control-store.schema.v99', 'current', ?)`).run(AT));
    await assert.rejects(
      () => createSqliteEmergencyControlStore(dbPath, { now: () => AT }),
      (error: unknown) => isEmergencyControlStoreError(error) && error.code === 'EMERGENCY_CONTROL_STORE_UNAVAILABLE',
    );
  });

  it('the digests cover the state-bearing fields, which is what makes a flipped flag or transition detectable', () => {
    const base = { controlKey: 'global', scope: 'global', active: true, issuerRef: ISSUER, declaredAt: AT, eventSequence: 1, eventDigest: 'sha256:aa' } as const;
    assert.notEqual(storedEmergencyControlDigest(base), storedEmergencyControlDigest({ ...base, active: false }));
    assert.notEqual(storedEmergencyControlDigest(base), storedEmergencyControlDigest({ ...base, eventSequence: 2 }));

    const event = { sequence: 1, controlKey: 'global', scope: 'global', transition: 'activated', issuerRef: ISSUER, recordedAt: AT, previousEventDigest: 'sha256:bb' } as const;
    assert.notEqual(emergencyControlEventDigest(event), emergencyControlEventDigest({ ...event, transition: 'released' }));
    assert.notEqual(emergencyControlEventDigest(event), emergencyControlEventDigest({ ...event, previousEventDigest: 'sha256:cc' }));

    assert.equal(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION, 'aoc.emergency-control-store.schema.v2');
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
