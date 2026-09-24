import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import type { ExerciseReservationRequest, ExerciseReservationResolutionInput } from '../../features/exercise-control-runtime/index.js';
import { amount, at, reservation } from '../../features/exercise-control-runtime/tests/exercise-control-ledger-contract.js';
import { describeExerciseReservationResolutionContract, resolutionOf } from '../../features/exercise-control-runtime/tests/exercise-reservation-resolution-contract.js';
import { createSqliteExerciseControlLedger, isExerciseControlLedgerError } from '../exercise-control-ledger/index.js';

/**
 * P12 — the production P7 ledger's resolution row: the shared contract, then
 * what only the durable ledger has — restart survival, append-only triggers,
 * verify-before-filter under tampering, and the shared `BEGIN IMMEDIATE`
 * locking domain between returned capacity and new admissions.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p12-ledger-'));
  directories.push(directory);
  return join(directory, 'exercise-ledger.sqlite');
}

describeExerciseReservationResolutionContract('SQLite exercise-control ledger', async (now) => {
  const ledger = await createSqliteExerciseControlLedger(freshPath(), { now });
  return { ledger, close: () => ledger.close() };
});

const usd = (maximum: string) => amount('lifetime-usd', 'org:org-a', maximum, 'USD');
const hundred = { value: '100', unit: 'USD' } as const;

function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

async function unconfirmedHundred(path: string, executionId: string): Promise<ExerciseReservationRequest> {
  const ledger = await createSqliteExerciseControlLedger(path);
  const first = reservation({ executionId, limits: [usd('100')], amount: hundred });
  assert.equal((await ledger.reserve(first)).outcome, 'reserved');
  await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
  await ledger.close();
  return first;
}

describe('P12 SQLite ledger — §140 lifetime capacity survives restart in both directions', () => {
  it('100 lifetime, unconfirmed 100, restart, resolve not-completed, restart, a new 100 succeeds', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-restart');
    let ledger = await createSqliteExerciseControlLedger(path);
    assert.equal((await ledger.reserve(reservation({ executionId: 'exec-blocked', limits: [usd('100')], amount: hundred }))).outcome, 'refused', 'still consumed after restart');
    assert.equal((await ledger.reconcileResolution(resolutionOf(first))).outcome, 'applied');
    await ledger.close();
    ledger = await createSqliteExerciseControlLedger(path);
    assert.equal((await ledger.read(first.reservationId))?.resolution?.resolution, 'confirmed-not-completed');
    assert.equal((await ledger.read(first.reservationId))?.terminal?.reason, 'execution-unconfirmed', 'the original settlement is still there');
    assert.equal((await ledger.reserve(reservation({ executionId: 'exec-after-restart', limits: [usd('100')], amount: hundred }))).outcome, 'reserved');
    await ledger.close();
  });
});

describe('P12 SQLite ledger — immutability and verify-before-filter', () => {
  it('UPDATE and DELETE of a resolution row are refused by the database', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-immutable');
    const ledger = await createSqliteExerciseControlLedger(path);
    await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed' }));
    await ledger.close();
    const db = new Database(path);
    try {
      assert.throws(() => db.exec(`UPDATE exercise_control_reservation_resolutions SET resolution = 'confirmed-not-completed'`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM exercise_control_reservation_resolutions`), /append-only/);
      assert.throws(() => db.exec(`UPDATE exercise_control_terminal_events SET terminal_kind = 'released', reason = 'execution-failed'`), /append-only/);
    } finally {
      db.close();
    }
  });

  it('§60 / §135 a completed resolution edited to not-completed without re-sealing fails the bucket closed — it never excludes its own usage', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-tampered');
    let ledger = await createSqliteExerciseControlLedger(path);
    await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed' }));
    await ledger.close();
    tamper(path, [`UPDATE exercise_control_reservation_resolutions SET resolution = 'confirmed-not-completed'`]);
    ledger = await createSqliteExerciseControlLedger(path);
    await assert.rejects(ledger.reserve(reservation({ executionId: 'exec-would-overspend', limits: [usd('100')], amount: hundred })), (error: unknown) => isExerciseControlLedgerError(error) && error.code === 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT');
    await ledger.close();
  });

  it('a forged resolution row naming another resolution digest without re-sealing, or an orphan row, fails closed', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-forged');
    let ledger = await createSqliteExerciseControlLedger(path);
    await ledger.reconcileResolution(resolutionOf(first));
    await ledger.close();
    tamper(path, [`UPDATE exercise_control_reservation_resolutions SET resolution_digest = 'sha256:${'f'.repeat(64)}'`]);
    ledger = await createSqliteExerciseControlLedger(path);
    await assert.rejects(ledger.read(first.reservationId), (error: unknown) => isExerciseControlLedgerError(error) && error.code === 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT');
    await ledger.close();

    const orphanPath = freshPath();
    await unconfirmedHundred(orphanPath, 'exec-orphan-host');
    tamper(orphanPath, [
      `PRAGMA foreign_keys = OFF`,
      `INSERT INTO exercise_control_reservation_resolutions VALUES ('aoc.exercise-reservation:orphan', 'exec-none', 'sha256:${'a'.repeat(64)}', 'confirmed-not-completed', '${at(2)}', 'sha256:${'b'.repeat(64)}', '${at(2)}', 'aoc.exercise-control-ledger.schema.v1')`,
    ]);
    ledger = await createSqliteExerciseControlLedger(orphanPath);
    await assert.rejects(ledger.read('aoc.exercise-reservation:orphan'), (error: unknown) => isExerciseControlLedgerError(error) && error.code === 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT');
    await ledger.close();
  });

  it('a deleted resolution row only ever makes capacity consumed again — the conservative direction', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-deleted');
    let ledger = await createSqliteExerciseControlLedger(path);
    await ledger.reconcileResolution(resolutionOf(first));
    await ledger.close();
    tamper(path, [`DELETE FROM exercise_control_reservation_resolutions`]);
    ledger = await createSqliteExerciseControlLedger(path);
    assert.equal((await ledger.reserve(reservation({ executionId: 'exec-after-delete', limits: [usd('100')], amount: hundred }))).outcome, 'refused');
    await ledger.close();
  });
});

async function race(path: string, participants: readonly (readonly ({ readonly kind: 'reserve'; readonly request: ExerciseReservationRequest } | { readonly kind: 'resolve'; readonly input: ExerciseReservationResolutionInput })[])[]): Promise<readonly string[]> {
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = participants.map((operations) => new Worker(join(__dirname, 'exercise-control-resolution-worker.js'), { workerData: { path, barrier, operations } }));
  const results = workers.map(
    (worker) =>
      new Promise<readonly string[]>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (message: { kind: string; outcomes?: readonly string[] }) => {
          if (message.kind === 'ready') {
            ready += 1;
            if (ready === workers.length) {
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
            }
          } else if (message.kind === 'done') {
            resolve(message.outcomes ?? []);
          }
        });
      }),
  );
  const outcomes = (await Promise.all(results)).flat();
  await Promise.all(workers.map((worker) => worker.terminate()));
  return outcomes;
}

describe('P12 SQLite ledger — §61 / §137 / §138 returned capacity and new admissions share one lock', () => {
  it('confirmed-not-completed racing two new 100 USD reservations in parallel threads: at most one is ever admitted, never both', async () => {
    for (let round = 0; round < 6; round += 1) {
      const path = freshPath();
      const first = await unconfirmedHundred(path, `exec-race-${round}`);
      const outcomes = await race(path, [
        [{ kind: 'resolve', input: resolutionOf(first) }],
        [{ kind: 'reserve', request: reservation({ executionId: `exec-race-${round}-a`, limits: [usd('100')], amount: hundred }) }],
        [{ kind: 'reserve', request: reservation({ executionId: `exec-race-${round}-b`, limits: [usd('100')], amount: hundred }) }],
      ]);
      assert.ok(outcomes.includes('resolve:applied'), outcomes.join(','));
      const admitted = outcomes.filter((outcome) => outcome === 'reserve:reserved').length;
      assert.ok(admitted <= 1, `over-admission after returned capacity: ${outcomes.join(',')}`);
      // Whatever the interleaving, the ledger holds no more than the limit.
      const ledger = await createSqliteExerciseControlLedger(path);
      assert.equal((await ledger.reserve(reservation({ executionId: `exec-race-${round}-late`, limits: [usd('100')], amount: hundred }))).outcome, admitted === 1 ? 'refused' : 'reserved');
      await ledger.close();
    }
  });

  it('confirmed-completed racing new reservations creates no capacity at all', async () => {
    const path = freshPath();
    const first = await unconfirmedHundred(path, 'exec-race-completed');
    const outcomes = await race(path, [
      [{ kind: 'resolve', input: resolutionOf(first, { resolution: 'confirmed-completed' }) }],
      [{ kind: 'reserve', request: reservation({ executionId: 'exec-race-completed-a', limits: [usd('100')], amount: hundred }) }],
      [{ kind: 'reserve', request: reservation({ executionId: 'exec-race-completed-b', limits: [usd('100')], amount: hundred }) }],
    ]);
    assert.equal(outcomes.filter((outcome) => outcome === 'reserve:reserved').length, 0, outcomes.join(','));
  });
});
