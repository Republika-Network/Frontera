import { parentPort, workerData } from 'node:worker_threads';

import type { ExerciseReservationRequest, ExerciseReservationResolutionInput } from '../../features/exercise-control-runtime/index.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/index.js';

/**
 * One independent participant in a P12 capacity race: its own thread, its own
 * `better-sqlite3` connection, the same ledger file. It opens the ledger,
 * reports ready, waits on a shared barrier, then runs its operations — new
 * reservations competing for capacity, or the P12 resolution row that returns
 * it. Test scaffolding only.
 */
type Operation = { readonly kind: 'reserve'; readonly request: ExerciseReservationRequest } | { readonly kind: 'resolve'; readonly input: ExerciseReservationResolutionInput };

interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly operations: readonly Operation[];
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  const ledger = await createSqliteExerciseControlLedger(input.path, { busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  const outcomes: string[] = [];
  for (const operation of input.operations) {
    try {
      outcomes.push(operation.kind === 'reserve' ? `reserve:${(await ledger.reserve(operation.request)).outcome}` : `resolve:${(await ledger.reconcileResolution(operation.input)).outcome}`);
    } catch (error) {
      outcomes.push(`error:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ledger.close();
  parentPort?.postMessage({ kind: 'done', outcomes });
}

void main();
