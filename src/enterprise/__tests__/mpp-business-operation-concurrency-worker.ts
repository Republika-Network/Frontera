import { parentPort, workerData } from 'node:worker_threads';

import { isMppBusinessOperationStoreError } from '../mpp-business-operation-store/errors.js';
import { createSqliteMppBusinessOperationStore } from '../mpp-business-operation-store/sqlite-mpp-business-operation-store.js';
import type { MppChallengeFields } from '../mpp-challenge/protocol.js';
import { storeEntry, type StoreTerms } from './mpp-challenge-support.js';

/**
 * One independent participant in a business-operation race: its own thread,
 * its own `better-sqlite3` connection, the same database file. It opens the
 * store, reports ready, blocks on a shared barrier until every participant is
 * ready, then records. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly terms: StoreTerms;
  readonly fields: Partial<MppChallengeFields>;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  const now = () => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();
  const store = await createSqliteMppBusinessOperationStore(input.path, { now, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  let outcome: string;
  try {
    const result = await store.record({ organizationId: 'org-a' }, storeEntry(input.terms, input.fields));
    outcome = `${result.operationOutcome}:${result.challengeOutcome}:${String(result.challenge.challengeSequence)}:${result.operation.governedRequestId}`;
  } catch (error) {
    outcome = isMppBusinessOperationStoreError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}`;
  }
  await store.close();
  parentPort?.postMessage({ kind: 'done', outcome });
}

void main();
