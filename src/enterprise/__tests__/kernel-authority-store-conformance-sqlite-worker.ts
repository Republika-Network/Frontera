import { parentPort, workerData } from 'node:worker_threads';

import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { runConformanceAppends, type ConformanceRaceParticipant } from './kernel-authority-store-conformance.js';

/**
 * One independent participant in a Kernel Authority Store conformance race:
 * its own thread, its own `better-sqlite3` connection, the same database file.
 * It opens the store, reports ready, blocks on a shared barrier until every
 * participant is ready, then appends. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly participant: ConformanceRaceParticipant;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  const store = await createSqliteKernelAuthorityStore(input.path, { busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  const outcomes = await runConformanceAppends(store, input.participant);
  await store.close();
  parentPort?.postMessage({ kind: 'done', outcomes });
}

void main();
