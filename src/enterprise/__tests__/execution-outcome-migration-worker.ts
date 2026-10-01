import { parentPort, workerData } from 'node:worker_threads';

import { isExecutionOutcomeStoreError } from '../execution-outcome-store/errors.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';

/**
 * One independent opener in a schema-migration race: its own thread, its own
 * `better-sqlite3` connection, the same database file. It reports when it
 * starts opening and every time the store samples its clock (the store samples
 * it only for a version row it is about to write), then reports how the open
 * ended. Test scaffolding only.
 */
interface MigrationOpenerInput {
  readonly path: string;
  readonly at: string;
}

async function main(): Promise<void> {
  const input = workerData as MigrationOpenerInput;
  let samples = 0;
  const now = (): string => {
    samples += 1;
    parentPort?.postMessage({ kind: 'clock' });
    return input.at;
  };
  parentPort?.postMessage({ kind: 'opening' });
  try {
    const store = await createSqliteExecutionOutcomeStore(input.path, { now, busyTimeoutMs: 30_000 });
    await store.close();
    parentPort?.postMessage({ kind: 'done', result: 'opened', message: '', samples });
  } catch (error) {
    parentPort?.postMessage({
      kind: 'done',
      result: isExecutionOutcomeStoreError(error) ? error.code : 'error',
      message: error instanceof Error ? error.message : String(error),
      samples,
    });
  }
}

void main();
