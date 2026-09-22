import { parentPort, workerData } from 'node:worker_threads';

import type { AppendAuthorityEventInput } from '../authority-event-stream/contracts.js';
import { isAuthorityEventStreamError } from '../authority-event-stream/errors.js';
import { createSqliteAuthorityEventStreamStore } from '../authority-event-stream/sqlite-authority-event-stream-store.js';

/**
 * One independent participant in an append race: its own thread, its own
 * `better-sqlite3` connection, the same database file. It opens the store,
 * reports ready, blocks on a shared barrier until every participant is ready,
 * then appends as fast as it can. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly organizationId: string;
  readonly inputs: readonly AppendAuthorityEventInput[];
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  // Each worker's own clock; recordedAt only has to be a canonical instant.
  const now = () => new Date(Date.parse('2026-03-01T12:00:00.000Z') + (tick += 1)).toISOString();
  const store = await createSqliteAuthorityEventStreamStore(input.path, { now, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  const outcomes: { readonly outcome: string; readonly sequence?: number; readonly eventId?: string }[] = [];
  for (const event of input.inputs) {
    try {
      const result = await store.append({ organizationId: input.organizationId }, event);
      outcomes.push({ outcome: result.outcome, sequence: result.event.sequence, eventId: result.event.eventId });
    } catch (error) {
      outcomes.push({ outcome: isAuthorityEventStreamError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}` });
    }
  }
  await store.close();
  parentPort?.postMessage({ kind: 'done', outcomes });
}

void main();
