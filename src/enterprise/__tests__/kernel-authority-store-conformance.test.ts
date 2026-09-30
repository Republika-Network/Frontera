import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import type { KernelAuthorityEntityStatus } from '../kernel-authority/contracts.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import {
  runConformanceAppends,
  runKernelAuthorityStoreConformance,
  type ConformanceAppendOutcome,
  type ConformanceEntityKey,
  type ConformanceRaceParticipant,
  type KernelAuthorityStoreTamper,
} from './kernel-authority-store-conformance.js';

/**
 * Runs the one Kernel Authority Store conformance suite against every provider
 * this runtime ships. Each provider below supplies setup, teardown and access
 * to its own persisted representation -- never an assertion. A new provider is
 * added here, and nowhere else, and passes or fails the same cases.
 */

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

runKernelAuthorityStoreConformance({
  providerName: 'memory',
  expectedProviderKind: 'memory',
  createStore: async (_label, options) => {
    const store = createInMemoryKernelAuthorityStore(options);
    return {
      store,
      // No `tamper` and no `reopen`: the in-memory store has no state outside
      // the store object, so there is nothing to damage and nothing to restore.
      race: (participants) => Promise.all(participants.map((participant) => runConformanceAppends(store, participant))),
      raceIsolation: 'in-process only: concurrent calls on one store object',
    };
  },
  cleanup: async () => {},
});

// ---------------------------------------------------------------------------
// sqlite
// ---------------------------------------------------------------------------

const sqliteDirectories: string[] = [];

function freshSqlitePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-kernel-authority-conformance-'));
  sqliteDirectories.push(directory);
  return join(directory, `${label}.sqlite`);
}

/** Direct edits to the SQLite file through a separate connection -- what someone with write access to the file could do. */
function sqliteTamper(path: string): KernelAuthorityStoreTamper {
  async function edit(sql: string, ...params: unknown[]): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    try {
      const changes = db.prepare(sql).run(...params).changes;
      if (changes !== 1) throw new Error(`tamper statement changed ${changes} rows, expected exactly 1: ${sql}`);
    } finally {
      db.close();
    }
  }
  const where = 'organization_id = ? AND entity_kind = ? AND entity_id = ?';
  const keyParams = (key: ConformanceEntityKey) => [key.organizationId, key.entityKind, key.entityId];

  return {
    rewriteEventPayload: (key, sequence, payload) =>
      edit(`UPDATE kernel_authority_events SET payload_json = ? WHERE ${where} AND sequence = ?`, JSON.stringify(payload), ...keyParams(key), sequence),
    rewriteEventPreviousDigest: (key, sequence, previousEventDigest) =>
      edit(`UPDATE kernel_authority_events SET previous_event_digest = ? WHERE ${where} AND sequence = ?`, previousEventDigest, ...keyParams(key), sequence),
    renumberEvent: (key, fromSequence, toSequence) =>
      edit(`UPDATE kernel_authority_events SET sequence = ? WHERE ${where} AND sequence = ?`, toSequence, ...keyParams(key), fromSequence),
    deleteEvent: (key, sequence) => edit(`DELETE FROM kernel_authority_events WHERE ${where} AND sequence = ?`, ...keyParams(key), sequence),
    rewriteHead: async (key, head) => {
      if (head.latestSequence !== undefined) await edit(`UPDATE kernel_authority_records SET latest_sequence = ? WHERE ${where}`, head.latestSequence, ...keyParams(key));
      if (head.latestEventDigest !== undefined) await edit(`UPDATE kernel_authority_records SET latest_event_digest = ? WHERE ${where}`, head.latestEventDigest, ...keyParams(key));
    },
    rewriteProjection: async (key, projection: { readonly status?: KernelAuthorityEntityStatus; readonly payload?: Readonly<Record<string, unknown>> }) => {
      if (projection.status !== undefined) await edit(`UPDATE kernel_authority_records SET status = ? WHERE ${where}`, projection.status, ...keyParams(key));
      if (projection.payload !== undefined) await edit(`UPDATE kernel_authority_records SET payload_json = ? WHERE ${where}`, JSON.stringify(projection.payload), ...keyParams(key));
    },
  };
}

/** Each participant gets its own worker thread and its own connection to the same file, released together by a barrier. */
async function sqliteRace(path: string, participants: readonly ConformanceRaceParticipant[]): Promise<readonly (readonly ConformanceAppendOutcome[])[]> {
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = participants.map((participant) => new Worker(join(__dirname, 'kernel-authority-store-conformance-sqlite-worker.js'), { workerData: { path, barrier, participant } }));
  const results = workers.map(
    (worker) =>
      new Promise<readonly ConformanceAppendOutcome[]>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (message: { kind: string; outcomes?: readonly ConformanceAppendOutcome[] }) => {
          if (message.kind === 'ready') {
            ready += 1;
            if (ready === workers.length) {
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
            }
          } else if (message.kind === 'done') {
            resolve(message.outcomes ?? []);
          }
        });
      }),
  );
  try {
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

runKernelAuthorityStoreConformance({
  providerName: 'sqlite',
  expectedProviderKind: 'sqlite',
  createStore: async (label, options) => {
    const path = freshSqlitePath(label);
    const store = await createSqliteKernelAuthorityStore(path, options);
    return {
      store,
      tamper: sqliteTamper(path),
      race: (participants) => sqliteRace(path, participants),
      raceIsolation: 'independent worker threads, one better-sqlite3 connection each, one database file',
      reopen: () => createSqliteKernelAuthorityStore(path),
    };
  },
  cleanup: async () => {
    for (const directory of sqliteDirectories) rmSync(directory, { recursive: true, force: true });
  },
});
