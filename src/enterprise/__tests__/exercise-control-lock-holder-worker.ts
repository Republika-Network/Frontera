import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

/**
 * Holds the SQLite write lock on an exercise-control ledger file for a fixed
 * time, from its own thread and its own connection — standing in for another
 * process mid-admission. Test scaffolding only.
 */
interface HoldInput {
  readonly path: string;
  readonly holdMs: number;
}

const input = workerData as HoldInput;
const db = new Database(input.path);
db.exec('BEGIN IMMEDIATE');
parentPort?.postMessage({ kind: 'locked' });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.holdMs);
db.exec('COMMIT');
db.close();
