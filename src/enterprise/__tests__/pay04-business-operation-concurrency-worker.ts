import { parentPort, workerData } from 'node:worker_threads';

import { createSqlitePaymentBusinessOperationStore } from '../payment-protocol-ingress/sqlite-payment-business-operation-store.js';
import { isPaymentBusinessOperationStoreError } from '../payment-protocol-ingress/store-errors.js';
import { STORE_ORG, storeEntry, type StoreChallenge, type StoreTerms } from './pay04-protocol-support.js';

/**
 * One independent participant in a business-operation race (PAY-04 M29 / I8 /
 * I9): its own thread, its own `better-sqlite3` connection, the same database
 * file. It opens the store, reports ready, blocks on a shared barrier until
 * every participant is ready, then records. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly terms: StoreTerms;
  readonly challenge: StoreChallenge;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  const now = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();
  const store = await createSqlitePaymentBusinessOperationStore(input.path, { now, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  let outcome: string;
  try {
    const result = await store.record({ organizationId: STORE_ORG }, storeEntry(input.terms, input.challenge));
    outcome = `${result.operationOutcome}:${result.challengeOutcome}:${String(result.challenge.challengeSequence)}:${result.operation.governedRequestId}`;
  } catch (error) {
    outcome = isPaymentBusinessOperationStoreError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}`;
  }
  await store.close();
  parentPort?.postMessage({ kind: 'done', outcome });
}

void main();
