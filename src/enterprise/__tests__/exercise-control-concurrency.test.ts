import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import type { ExerciseReservationRequest } from '../../features/exercise-control-runtime/index.js';
import { amount, count, reservation } from '../../features/exercise-control-runtime/tests/exercise-control-ledger-contract.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/index.js';

/**
 * §18 / §43 — the load-bearing SQLite property:
 *
 * ```
 * two processes racing for the LAST remaining unit of quota cannot both win
 * ```
 *
 * Measured two ways. First with two independently opened ledger instances in
 * one process — the same file, two connections. Then with genuinely parallel
 * participants: worker threads, each with its own connection, released
 * together from a shared barrier and repeated many times, so an admission that
 * read usage and inserted in separate transactions would over-admit reliably.
 * No public network is involved.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-exercise-race-'));
  directories.push(directory);
  return join(directory, 'exercise-ledger.sqlite');
}

async function race(path: string, participants: readonly (readonly ExerciseReservationRequest[])[]): Promise<readonly string[]> {
  // Create the schema once, up front, so the race is over admission and not
  // over who creates the tables.
  await (await createSqliteExerciseControlLedger(path)).close();
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = participants.map((requests) => new Worker(join(__dirname, 'exercise-control-concurrency-worker.js'), { workerData: { path, barrier, requests } }));
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

function tally(outcomes: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

function committedReservations(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM exercise_control_reservations`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('Exercise-control ledger — §43 concurrency on one SQLite file', () => {
  it('A. two independently opened ledgers on the same file, max 1: exactly one reserved, exactly one refused — every time', async () => {
    for (let round = 0; round < 20; round += 1) {
      const path = freshPath();
      const left = await createSqliteExerciseControlLedger(path);
      const right = await createSqliteExerciseControlLedger(path);
      const limits = [count('last-unit', 'grant:race', 1)];
      const outcomes = await Promise.all([left.reserve(reservation({ executionId: `a-${round}`, limits })), right.reserve(reservation({ executionId: `b-${round}`, limits }))]);
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['refused', 'reserved'], `round ${round}`);
      await left.close();
      await right.close();
      assert.equal(committedReservations(path), 1);
    }
  });

  it('A (parallel). two worker threads racing for the last unit: never two winners', async () => {
    for (let round = 0; round < 25; round += 1) {
      const path = freshPath();
      const limits = [count('last-unit', 'grant:race', 1)];
      const outcomes = await race(path, [[reservation({ executionId: `left-${round}`, limits })], [reservation({ executionId: `right-${round}`, limits })]]);
      assert.deepEqual(tally(outcomes), { reserved: 1, refused: 1 }, `round ${round}: ${outcomes.join(', ')}`);
      assert.equal(committedReservations(path), 1);
    }
  });

  it('B. max 5, eight threads racing twenty-four reservations: exactly five are admitted', async () => {
    for (let round = 0; round < 6; round += 1) {
      const path = freshPath();
      const limits = [count('five', 'grant:race', 5)];
      const participants = Array.from({ length: 8 }, (_, worker) => Array.from({ length: 3 }, (_, index) => reservation({ executionId: `b-${round}-${worker}-${index}`, limits })));
      const outcomes = await race(path, participants);
      assert.deepEqual(tally(outcomes), { reserved: 5, refused: 19 }, `round ${round}`);
      assert.equal(committedReservations(path), 5);
    }
  });

  it('C. amount max 100, ten threads each reserving 20: no more than five are admitted', async () => {
    for (let round = 0; round < 6; round += 1) {
      const path = freshPath();
      const limits = [amount('spend', 'grant:race', '100', 'USD')];
      const participants = Array.from({ length: 10 }, (_, worker) => [reservation({ executionId: `c-${round}-${worker}`, limits, amount: { value: '20', unit: 'USD' } })]);
      const outcomes = await race(path, participants);
      assert.deepEqual(tally(outcomes), { reserved: 5, refused: 5 }, `round ${round}`);
      assert.equal(committedReservations(path), 5);
    }
  });

  it('the same execution identity raced from two threads is admitted once and never duplicated', async () => {
    for (let round = 0; round < 10; round += 1) {
      const path = freshPath();
      const request = reservation({ executionId: `dup-${round}`, limits: [count('dup', 'grant:race', 100)] });
      const outcomes = await race(path, [[request], [request], [request]]);
      assert.deepEqual(tally(outcomes), { reserved: 1, 'already-reserved': 2 }, `round ${round}`);
      assert.equal(committedReservations(path), 1);
    }
  });
});
