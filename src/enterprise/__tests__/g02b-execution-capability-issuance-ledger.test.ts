import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION, type ExecutionCapabilityReservation } from '../execution-capability-issuance/index.js';
import { serializeExecutionCapability } from '../execution-capability/index.js';
import { AUTHORITY_KEY_A } from './authority-authenticity-fixture.js';
import { G02B_ISSUER, LedgerDirectory, NOW, capabilityFor, signCapabilityBytes, signedGrant, type SignedGrant } from './g02b-execution-capability-issuance-fixture.js';

/**
 * G-02B — the Host's durable issuance ledger: one row per execution, the full
 * canonical capability committed before custody is asked, forward-only
 * settlement, integrity checks on every open and every read, and no implicit
 * (re)creation. No custody is involved here: rows are reserved directly.
 */

const ledgers = new LedgerDirectory();
after(() => ledgers.cleanup());

function reservationFor(signed: SignedGrant, overrides: Parameters<typeof capabilityFor>[1] = {}): ExecutionCapabilityReservation {
  const { capability, nonce } = capabilityFor(signed, overrides);
  return { capability, boundedGrantId: signed.grant.id, grantStoreId: signed.storeId, grantDigest: signed.grant.digest, grantReferenceNonce: nonce };
}

function raw(path: string): Database.Database {
  return new Database(path);
}

describe('G-02B issuance ledger — the schema and its transitions', () => {
  it('reserve commits the exact canonical text, grant identity and nonce; issued and uncertain are terminal', async () => {
    const ledger = await ledgers.create();
    const reservation = reservationFor(await signedGrant());
    const { capability } = reservation;
    assert.deepEqual(ledger.reserve(reservation), { outcome: 'reserved', reservedAt: new Date(NOW).toISOString() });
    const reserved = ledger.read(capability.executionId);
    assert.equal(reserved.state, 'reserved');
    assert.equal(reserved.canonical, serializeExecutionCapability(capability));
    assert.equal(reserved.grantReferenceNonce, reservation.grantReferenceNonce);
    assert.equal(reserved.signature, undefined);
    const signature = signCapabilityBytes(capability, AUTHORITY_KEY_A);
    assert.equal(ledger.markIssued(capability.executionId, capability.capabilityId, signature), 'issued');
    const issued = ledger.read(capability.executionId);
    assert.equal(issued.state, 'issued');
    assert.deepEqual(issued.state === 'issued' ? issued.signature : undefined, signature);
    assert.equal(ledger.markIssued(capability.executionId, capability.capabilityId, signature), 'not-reserved', 'issued is terminal');
    assert.equal(ledger.markUncertain(capability.executionId, capability.capabilityId), 'not-reserved', 'issued never becomes uncertain');
    assert.equal(ledger.readCapability(capability.capabilityId).state, 'issued');
  });

  it('one capability per execution: a second reservation — new id, new nonce — is refused and reports the first', async () => {
    const ledger = await ledgers.create();
    const signed = await signedGrant();
    const first = reservationFor(signed);
    ledger.reserve(first);
    const second = reservationFor(signed);
    assert.notEqual(second.capability.capabilityId, first.capability.capabilityId);
    const outcome = ledger.reserve(second);
    assert.equal(outcome.outcome, 'exists');
    assert.equal(outcome.outcome === 'exists' ? outcome.record.capabilityId : '', first.capability.capabilityId);
    assert.equal(ledger.readCapability(second.capability.capabilityId).state, 'absent');
    assert.equal(ledger.markUncertain(first.capability.executionId, first.capability.capabilityId), 'uncertain');
    assert.equal(ledger.reserve(reservationFor(signed)).outcome, 'exists', 'an uncertain execution is never reserved again');
  });

  it('settlement names the reserved capability: another id for the execution settles nothing', async () => {
    const ledger = await ledgers.create();
    const reservation = reservationFor(await signedGrant());
    ledger.reserve(reservation);
    assert.equal(ledger.markIssued(reservation.capability.executionId, 'ab'.repeat(32), signCapabilityBytes(reservation.capability)), 'not-reserved');
    assert.equal(ledger.markUncertain(reservation.capability.executionId, 'ab'.repeat(32)), 'not-reserved');
    assert.equal(ledger.read(reservation.capability.executionId).state, 'reserved');
  });

  it('refuses to reserve a row that would not hold together: another issuer, a reference that does not recompute, a malformed capability', async () => {
    const ledger = await ledgers.create();
    const signed = await signedGrant();
    assert.throws(() => ledger.reserve(reservationFor(signed, { issuer: 'frontera-deployment-other' })), /its own issuer/);
    assert.throws(() => ledger.reserve({ ...reservationFor(signed), grantReferenceNonce: 'ab'.repeat(32) }), /does not recompute/);
    assert.throws(() => ledger.reserve({ ...reservationFor(signed), grantDigest: `sha256:${'0'.repeat(64)}` }), /does not recompute/);
    assert.throws(() => ledger.reserve(reservationFor(signed, { capabilityId: 'not-hex' })), /well-formed/);
    assert.equal(ledger.read(reservationFor(signed).capability.executionId).state, 'absent');
  });

  it('the SQL itself refuses: a row inserted already issued, a backward move, a rewritten text, a delete', async () => {
    const path = ledgers.path();
    const ledger = await ledgers.create(path);
    const reservation = reservationFor(await signedGrant());
    ledger.reserve(reservation);
    const db = raw(path);
    try {
      const id = reservation.capability.executionId;
      assert.throws(() => db.prepare(`INSERT INTO execution_capability_issuances (execution_id, capability_id, grant_reference_nonce, bounded_grant_id, grant_store_id, grant_digest, audience, capability_text, capability_digest, reserved_at, state, signature, settled_at) VALUES ('x', '${'cd'.repeat(32)}', '${'ef'.repeat(32)}', 'g', 's', 'd', 'a', 't', 'h', 'r', 'issued', '{}', 'r')`).run(), /reserved before custody/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_issuances SET capability_text = 'x' WHERE execution_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_issuances SET capability_id = '${'cd'.repeat(32)}' WHERE execution_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`DELETE FROM execution_capability_issuances WHERE execution_id = ?`).run(id), /permanent/);
      db.prepare(`UPDATE execution_capability_issuances SET state = 'uncertain', settled_at = 'now' WHERE execution_id = ?`).run(id);
      assert.throws(() => db.prepare(`UPDATE execution_capability_issuances SET state = 'reserved', settled_at = NULL WHERE execution_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_issuances SET state = 'issued', signature = '{}' WHERE execution_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_issuance_meta SET issuer = 'other'`).run(), /fixed/);
    } finally {
      db.close();
    }
  });
});

describe('G-02B issuance ledger — durability, integrity and no implicit history', () => {
  it('a reservation survives a restart (crash after reservation): the reopened ledger still refuses a second identity', async () => {
    const path = ledgers.path();
    const first = await ledgers.create(path);
    const signed = await signedGrant();
    const reservation = reservationFor(signed);
    first.reserve(reservation);
    first.close();
    const reopened = await ledgers.reopen(path);
    assert.equal(reopened.read(reservation.capability.executionId).state, 'reserved', 'outcome unknown, never forgotten');
    assert.equal(reopened.reserve(reservationFor(signed)).outcome, 'exists');
  });

  it('a missing ledger is never recreated; create refuses an existing file; a non-ledger file is refused', async () => {
    const path = ledgers.path();
    await assert.rejects(ledgers.reopen(path), /never recreated implicitly/);
    assert.equal(existsSync(path), false);
    (await ledgers.create(path)).close();
    await assert.rejects(ledgers.create(path), /never re-initialized/);
    const foreign = ledgers.path();
    writeFileSync(foreign, '');
    await assert.rejects(ledgers.reopen(foreign), /not an initialized ledger|could not be opened/);
  });

  it('a ledger recorded for another issuer, under another schema version or without its triggers is refused', async () => {
    const path = ledgers.path();
    (await ledgers.create(path)).close();
    await assert.rejects(ledgers.reopen(path, { issuer: 'frontera-deployment-other' }), /another issuer/);
    const stripped = ledgers.path();
    copyFileSync(path, stripped);
    const db = raw(stripped);
    db.exec('DROP TRIGGER execution_capability_issuances_forward_only');
    db.close();
    await assert.rejects(ledgers.reopen(stripped), /missing its integrity triggers/);
    const versioned = ledgers.path();
    copyFileSync(path, versioned);
    const other = raw(versioned);
    other.exec('DROP TRIGGER execution_capability_issuance_meta_fixed_update');
    other.prepare(`UPDATE execution_capability_issuance_meta SET schema_version = 'frontera.execution-capability-issuance-ledger.v0'`).run();
    other.exec(`CREATE TRIGGER execution_capability_issuance_meta_fixed_update BEFORE UPDATE ON execution_capability_issuance_meta BEGIN SELECT RAISE(ABORT, 'the issuance ledger identity is fixed'); END;`);
    other.close();
    await assert.rejects(ledgers.reopen(versioned), /another schema version/);
    assert.equal(EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION, 'frontera.execution-capability-issuance-ledger.v1');
  });

  it('a row tampered with by a raw writer (triggers dropped) is refused on read — text, digest, ids, nonce or signature', async () => {
    const tampers: readonly [string, (db: Database.Database, id: string) => void][] = [
      ['capability text', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET capability_text = replace(capability_text, '"audience":"', '"audience":"x') WHERE execution_id = ?`).run(id)],
      ['digest', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET capability_digest = 'sha256:${'0'.repeat(64)}' WHERE execution_id = ?`).run(id)],
      ['audience column', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET audience = 'executor-other' WHERE execution_id = ?`).run(id)],
      ['nonce', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET grant_reference_nonce = '${'ab'.repeat(32)}' WHERE execution_id = ?`).run(id)],
      ['grant id', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET bounded_grant_id = 'aoc.grant:other' WHERE execution_id = ?`).run(id)],
      ['issued without a signature', (db, id) => db.prepare(`UPDATE execution_capability_issuances SET state = 'issued', signature = 'not-json', settled_at = 'x' WHERE execution_id = ?`).run(id)],
    ];
    for (const [name, tamper] of tampers) {
      const path = ledgers.path();
      const ledger = await ledgers.create(path);
      const reservation = reservationFor(await signedGrant());
      ledger.reserve(reservation);
      ledger.close();
      const db = raw(path);
      db.exec('DROP TRIGGER execution_capability_issuances_forward_only');
      try {
        tamper(db, reservation.capability.executionId);
      } catch {
        // A CHECK constraint refusing the tamper outright is the stronger outcome.
        db.close();
        continue;
      }
      db.exec(`CREATE TRIGGER execution_capability_issuances_forward_only BEFORE UPDATE ON execution_capability_issuances WHEN 0 BEGIN SELECT 1; END;`);
      db.close();
      const reopened = await ledgers.reopen(path);
      assert.throws(() => reopened.read(reservation.capability.executionId), /does not hold together/, name);
      assert.throws(() => reopened.reserve(reservation), /does not hold together/, `${name}: the tampered row is never answered as absent`);
    }
  });

  it('D7 — rollback: a restored older copy forgets a reservation, and the ledger alone cannot tell', async () => {
    const path = ledgers.path();
    const ledger = await ledgers.create(path);
    ledger.close();
    const backup = ledgers.path();
    copyFileSync(path, backup);
    const live = await ledgers.reopen(path);
    const signed = await signedGrant();
    const first = reservationFor(signed);
    live.reserve(first);
    live.markIssued(first.capability.executionId, first.capability.capabilityId, signCapabilityBytes(first.capability));
    live.close();
    // The operator restores the backup over the live file.
    rmSync(path);
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    copyFileSync(backup, path);
    const restored = await ledgers.reopen(path);
    assert.equal(restored.read(first.capability.executionId).state, 'absent', 'the restored ledger has no record of the issued capability');
    const second = reservationFor(signed);
    assert.equal(restored.reserve(second).outcome, 'reserved', 'same execution, new capability id, new nonce: accepted — this is the unanchored-rollback residual (G02B-R1)');
    assert.notEqual(second.capability.capabilityId, first.capability.capabilityId);
    assert.notEqual(second.grantReferenceNonce, first.grantReferenceNonce);
    assert.equal(second.capability.executionId, first.capability.executionId, 'both name the one execution the grant derives');
  });
});

describe('G-02B issuance ledger — concurrent reservation', () => {
  it('two connections on one file: exactly one reservation for the execution', async () => {
    const path = ledgers.path();
    const a = await ledgers.create(path);
    const b = await ledgers.reopen(path);
    const signed = await signedGrant();
    const outcomes = [a.reserve(reservationFor(signed)).outcome, b.reserve(reservationFor(signed)).outcome];
    assert.deepEqual(outcomes.sort(), ['exists', 'reserved']);
  });

  it('four threads released at one instant against one file: exactly one reservation, three see it', async () => {
    const path = ledgers.path();
    (await ledgers.create(path)).close();
    const signed = await signedGrant();
    const threads = 4;
    const barrier = new Int32Array(new SharedArrayBuffer(4));
    const reservations = Array.from({ length: threads }, () => {
      const reservation = reservationFor(signed);
      return { capability: JSON.parse(serializeExecutionCapability(reservation.capability)) as unknown, boundedGrantId: reservation.boundedGrantId, grantStoreId: reservation.grantStoreId, grantDigest: reservation.grantDigest, grantReferenceNonce: reservation.grantReferenceNonce };
    });
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { openExecutionCapabilityIssuanceLedger } = require(workerData.ledgerModule);
      (async () => {
        const ledger = await openExecutionCapabilityIssuanceLedger(workerData.path, { issuer: workerData.issuer, clock: () => workerData.now });
        Atomics.add(workerData.barrier, 0, 1);
        while (Atomics.load(workerData.barrier, 0) < workerData.threads) Atomics.wait(workerData.barrier, 0, Atomics.load(workerData.barrier, 0), 5);
        const outcome = ledger.reserve(workerData.reservation);
        ledger.close();
        parentPort.postMessage(outcome.outcome);
      })().catch((error) => parentPort.postMessage('error:' + String(error && error.message)));
    `;
    const ledgerModule = join(__dirname, '..', 'execution-capability-issuance', 'issuance-ledger.js');
    const outcomes = await Promise.all(
      reservations.map(
        (reservation) =>
          new Promise<string>((resolve, reject) => {
            const worker = new Worker(source, { eval: true, workerData: { ledgerModule, path, issuer: G02B_ISSUER, now: NOW, barrier, threads, reservation } });
            worker.once('message', (message: unknown) => {
              resolve(String(message));
              void worker.terminate();
            });
            worker.once('error', reject);
          }),
      ),
    );
    assert.deepEqual(outcomes.sort(), ['exists', 'exists', 'exists', 'reserved'], outcomes.join(', '));
    const ledger = await ledgers.reopen(path);
    const record = ledger.read(reservations[0] !== undefined ? (reservations[0].capability as { executionId: string }).executionId : '');
    assert.equal(record.state, 'reserved');
  });
});
