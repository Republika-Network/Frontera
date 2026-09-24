import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { createSqliteExecutionOutcomeStore, type ExecutionTerminalObservation, type PrepareExecutionAttemptInput } from '../execution-outcome-store/index.js';

/**
 * P11 §105–§107 — the SQLite property the JavaScript event loop cannot prove:
 *
 * ```
 * genuinely parallel writers on one file can never fork an execution's
 * attempt or its initial observation
 * ```
 *
 * Worker threads, each with its own connection, released together from a
 * shared barrier and repeated. Identical facts converge on one row with every
 * writer told `prepared|existing` / `recorded|existing`; different facts
 * produce exactly one winner and conflicts for the rest — never two rows, never
 * a last-write-wins.
 */

const ORG = 'org-a';
const AT = '2026-03-01T12:00:00.000Z';
const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-execution-outcome-race-'));
  directories.push(directory);
  return join(directory, 'execution-outcomes.sqlite');
}

const ATTEMPT: PrepareExecutionAttemptInput = {
  organizationId: ORG,
  executionId: 'aoc.exec:race',
  evaluationId: 'eval-race',
  requestId: 'aoc.gar:race',
  decisionId: 'dec-race',
  boundedGrantId: 'grant-race',
  action: 'payment.send',
  amount: { value: '9007199254740993.01', unit: 'USD' },
  preparedAt: AT,
};

function completed(providerRef: string): ExecutionTerminalObservation {
  return { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'provider.a', providerRef, observedAt: AT };
}

async function race(path: string, participants: readonly { readonly attempt: PrepareExecutionAttemptInput; readonly observation: ExecutionTerminalObservation }[]): Promise<readonly (readonly string[])[]> {
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = participants.map((participant) => new Worker(join(__dirname, 'execution-outcome-concurrency-worker.js'), { workerData: { path, barrier, ...participant } }));
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
  const outcomes = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  return outcomes;
}

function rowCounts(path: string): { readonly attempts: number; readonly terminals: number } {
  const db = new Database(path, { readonly: true });
  try {
    return {
      attempts: (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as { n: number }).n,
      terminals: (db.prepare(`SELECT COUNT(*) AS n FROM execution_terminal_observations`).get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

async function initialized(): Promise<string> {
  const path = freshPath();
  const store = await createSqliteExecutionOutcomeStore(path, { now: () => AT });
  await store.close();
  return path;
}

describe('execution outcome store — cross-thread SQLite races', () => {
  it('identical attempts and identical observations from six threads converge on one attempt and one observation', async () => {
    for (let round = 0; round < 3; round += 1) {
      const path = await initialized();
      const outcomes = await race(path, Array.from({ length: 6 }, () => ({ attempt: ATTEMPT, observation: completed('payment-123') })));
      const flat = outcomes.flat();
      assert.equal(flat.filter((entry) => entry === 'prepare:prepared').length, 1);
      assert.equal(flat.filter((entry) => entry === 'prepare:existing').length, 5);
      assert.equal(flat.filter((entry) => entry === 'record:recorded').length, 1);
      assert.equal(flat.filter((entry) => entry === 'record:existing').length, 5);
      assert.deepEqual(rowCounts(path), { attempts: 1, terminals: 1 });
    }
  });

  it('different observations race: exactly one wins, every other writer conflicts, and nothing forks', async () => {
    for (let round = 0; round < 3; round += 1) {
      const path = await initialized();
      const outcomes = await race(path, Array.from({ length: 6 }, (_, index) => ({ attempt: ATTEMPT, observation: completed(`payment-${String(index)}`) })));
      const flat = outcomes.flat();
      assert.equal(flat.filter((entry) => entry === 'record:recorded').length, 1);
      assert.equal(flat.filter((entry) => entry === 'record:EXECUTION_OUTCOME_CONFLICT').length, 5);
      assert.deepEqual(rowCounts(path), { attempts: 1, terminals: 1 });
      const store = await createSqliteExecutionOutcomeStore(path, { now: () => AT });
      const read = await store.read({ organizationId: ORG }, ATTEMPT.executionId);
      assert.equal(read?.attempt.amount?.value, '9007199254740993.01');
      assert.ok(read?.terminal !== undefined, 'the one winner verifies');
      await store.close();
    }
  });

  it('different attempts race: exactly one is prepared, the rest conflict', async () => {
    const path = await initialized();
    const outcomes = await race(
      path,
      Array.from({ length: 4 }, (_, index) => ({ attempt: { ...ATTEMPT, amount: { value: String(index + 1), unit: 'USD' } }, observation: completed('payment-1') })),
    );
    const flat = outcomes.flat();
    assert.equal(flat.filter((entry) => entry === 'prepare:prepared').length, 1);
    assert.equal(flat.filter((entry) => entry === 'prepare:EXECUTION_OUTCOME_CONFLICT').length, 3);
    assert.deepEqual(rowCounts(path), { attempts: 1, terminals: 1 });
  });
});
