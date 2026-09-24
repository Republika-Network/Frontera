import { parentPort, workerData } from 'node:worker_threads';

import type { ExecutionTerminalObservation, PrepareExecutionAttemptInput } from '../execution-outcome-store/contracts.js';
import { isExecutionOutcomeStoreError } from '../execution-outcome-store/errors.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';

/**
 * One independent participant in an execution-outcome race: its own thread,
 * its own `better-sqlite3` connection, the same database file. It opens the
 * store, reports ready, blocks on a shared barrier until every participant is
 * ready, then prepares and records. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly attempt: PrepareExecutionAttemptInput;
  readonly observation: ExecutionTerminalObservation;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  const now = () => new Date(Date.parse('2026-03-01T12:00:00.000Z') + (tick += 1)).toISOString();
  const store = await createSqliteExecutionOutcomeStore(input.path, { now, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  const context = { organizationId: input.attempt.organizationId };
  const outcomes: string[] = [];
  for (const step of ['prepare', 'record'] as const) {
    try {
      const result =
        step === 'prepare'
          ? await store.prepareAttempt(context, input.attempt)
          : await store.recordTerminal(context, { organizationId: input.attempt.organizationId, executionId: input.attempt.executionId, observation: input.observation });
      outcomes.push(`${step}:${result.outcome}`);
    } catch (error) {
      outcomes.push(`${step}:${isExecutionOutcomeStoreError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}`}`);
    }
  }
  await store.close();
  parentPort?.postMessage({ kind: 'done', outcomes });
}

void main();
