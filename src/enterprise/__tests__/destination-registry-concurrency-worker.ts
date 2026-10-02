import { parentPort, workerData } from 'node:worker_threads';

import type { ExecutionDestination } from '../../features/destination-runtime/index.js';
import { isDestinationRegistryError } from '../../features/destination-runtime/registry/index.js';
import { createSqliteDestinationRegistry } from '../destination-registry/sqlite-destination-registry.js';

/**
 * One independent participant in a destination-registration race: its own
 * thread, its own `better-sqlite3` connection, the same database file. It
 * opens the registry, reports ready, blocks on a shared barrier until every
 * participant is ready, then registers. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly destination: ExecutionDestination;
  readonly registeredBy: string;
  readonly clockStart: string;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  const now = () => new Date(Date.parse(input.clockStart) + (tick += 1)).toISOString();
  const registry = await createSqliteDestinationRegistry(input.path, { now, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  try {
    const result = registry.register({ destination: input.destination, registeredBy: input.registeredBy });
    parentPort?.postMessage({ kind: 'done', outcome: result.outcome, registeredBy: result.registration.registeredBy, registeredAt: result.registration.registeredAt });
  } catch (error) {
    parentPort?.postMessage({ kind: 'done', outcome: isDestinationRegistryError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}` });
  } finally {
    await registry.close();
  }
}

void main();
