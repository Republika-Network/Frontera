import { parentPort, workerData } from 'node:worker_threads';

import type { ExerciseReservationRequest } from '../../features/exercise-control-runtime/index.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/index.js';

/**
 * One independent process-like participant in a reservation race: its own
 * thread, its own `better-sqlite3` connection, the same database file. It opens
 * the ledger, reports ready, blocks on a shared barrier until every participant
 * is ready, and then reserves as fast as it can. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly requests: readonly ExerciseReservationRequest[];
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  const ledger = await createSqliteExerciseControlLedger(input.path, { busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  const outcomes: string[] = [];
  for (const request of input.requests) {
    try {
      outcomes.push((await ledger.reserve(request)).outcome);
    } catch (error) {
      outcomes.push(`error:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ledger.close();
  parentPort?.postMessage({ kind: 'done', outcomes });
}

void main();
