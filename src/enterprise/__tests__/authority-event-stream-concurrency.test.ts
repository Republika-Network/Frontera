import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { createSqliteAuthorityEventStreamStore, type AppendAuthorityEventInput } from '../authority-event-stream/index.js';
import { ORG_A, attempt, decision, steppingClock } from './authority-event-stream-support.js';

/**
 * §14 / §28 — the load-bearing SQLite property:
 *
 * ```
 * concurrent appends into the SAME stream can never fork it
 * ```
 *
 * Genuinely parallel participants — worker threads, each with its own
 * connection to one file, released together from a shared barrier and repeated
 * many times — so an append that read the head and wrote in separate
 * transactions would duplicate a sequence, fork the chain, skip a sequence or
 * lose an event reliably. After every race the whole chain is verified.
 */

const A = { organizationId: ORG_A };
const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-authority-event-race-'));
  directories.push(directory);
  return join(directory, 'authority-event-stream.sqlite');
}

interface Outcome {
  readonly outcome: string;
  readonly sequence?: number;
  readonly eventId?: string;
}

/** The genesis decision is appended up front, so every race is over the stream's next positions. */
async function prepared(): Promise<string> {
  const path = freshPath();
  const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
  await store.append(A, decision());
  await store.close();
  return path;
}

async function race(path: string, participants: readonly (readonly AppendAuthorityEventInput[])[]): Promise<readonly Outcome[]> {
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = participants.map((inputs) => new Worker(join(__dirname, 'authority-event-stream-concurrency-worker.js'), { workerData: { path, barrier, organizationId: ORG_A, inputs } }));
  const results = workers.map(
    (worker) =>
      new Promise<readonly Outcome[]>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (message: { kind: string; outcomes?: readonly Outcome[] }) => {
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
  const outcomes = (await Promise.all(results)).flat();
  await Promise.all(workers.map((worker) => worker.terminate()));
  return outcomes;
}

function rows(path: string): { readonly sequence: number; readonly previous: string | null; readonly digest: string }[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT sequence, previous_event_digest AS previous, event_digest AS digest FROM authority_events WHERE stream_id = ? ORDER BY sequence`).all(decision().streamId) as { sequence: number; previous: string | null; digest: string }[]).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function verified(path: string): Promise<{ readonly valid: boolean; readonly count: number; readonly failures: readonly string[] }> {
  const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
  try {
    const verification = await store.verifyStream(A, decision().streamId);
    return { valid: verification.valid, count: verification.eventCount, failures: verification.failures };
  } finally {
    await store.close();
  }
}

function assertUnforked(path: string, expected: number): void {
  const chain = rows(path);
  assert.deepEqual(
    chain.map((row) => row.sequence),
    Array.from({ length: expected }, (_, index) => index + 1),
    'contiguous: no gap, no duplicate',
  );
  const previous = chain.map((row) => row.previous).filter((value) => value !== null);
  assert.equal(new Set(previous).size, previous.length, 'no two events point at the same previous digest — no fork');
  chain.forEach((row, index) => assert.equal(row.previous, index === 0 ? null : chain[index - 1]?.digest));
}

describe('Authority event stream — §28 concurrency on one SQLite file', () => {
  it('two independently opened stores racing unique facts into one stream: sequences 2 and 3, one chain', async () => {
    for (let round = 0; round < 20; round += 1) {
      const path = await prepared();
      const left = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
      const right = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
      const outcomes = await Promise.all([left.append(A, attempt(`aoc.exec:l-${round}`)), right.append(A, attempt(`aoc.exec:r-${round}`))]);
      await left.close();
      await right.close();
      assert.deepEqual(outcomes.map((outcome) => outcome.event.sequence).sort(), [2, 3], `round ${round}`);
      assertUnforked(path, 3);
      assert.equal((await verified(path)).valid, true);
    }
  });

  it('two worker threads racing unique facts: N+1 and N+2, never the same sequence twice, never a fork, never a lost event', async () => {
    for (let round = 0; round < 25; round += 1) {
      const path = await prepared();
      const outcomes = await race(path, [[attempt(`aoc.exec:left-${round}`)], [attempt(`aoc.exec:right-${round}`)]]);
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['appended', 'appended'], `round ${round}: ${JSON.stringify(outcomes)}`);
      assert.deepEqual(outcomes.map((outcome) => outcome.sequence).sort(), [2, 3]);
      assertUnforked(path, 3);
      const verification = await verified(path);
      assert.equal(verification.valid, true, verification.failures.join('; '));
    }
  });

  it('eight threads racing twenty-four unique facts: exactly twenty-five contiguous events, one verified chain', async () => {
    for (let round = 0; round < 5; round += 1) {
      const path = await prepared();
      const participants = Array.from({ length: 8 }, (_, worker) => Array.from({ length: 3 }, (_, index) => attempt(`aoc.exec:many-${round}-${worker}-${index}`)));
      const outcomes = await race(path, participants);
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'appended').length, 24, JSON.stringify(outcomes.filter((outcome) => outcome.outcome !== 'appended')));
      assert.equal(new Set(outcomes.map((outcome) => outcome.sequence)).size, 24, 'twenty-four distinct positions');
      assertUnforked(path, 25);
      const verification = await verified(path);
      assert.equal(verification.valid, true, verification.failures.join('; '));
      assert.equal(verification.count, 25);
    }
  });

  it('the same fact raced from three threads exists exactly once; the losers read back the same event', async () => {
    for (let round = 0; round < 10; round += 1) {
      const path = await prepared();
      const fact = attempt(`aoc.exec:dup-${round}`);
      const outcomes = await race(path, [[fact], [fact], [fact]]);
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['appended', 'existing', 'existing'], `round ${round}`);
      assert.equal(new Set(outcomes.map((outcome) => outcome.eventId)).size, 1);
      assert.deepEqual(outcomes.map((outcome) => outcome.sequence), [2, 2, 2]);
      assertUnforked(path, 2);
    }
  });

  it('one event id raced with two different facts: exactly one stands, every loser gets a closed conflict', async () => {
    for (let round = 0; round < 10; round += 1) {
      const path = await prepared();
      const id = `aoc.exec:conflict-${round}`;
      const first = attempt(id, {}, { occurredAt: '2026-03-01T10:00:01.000Z' });
      const second = attempt(id, {}, { occurredAt: '2026-03-01T10:00:02.000Z' });
      assert.equal(first.eventId, second.eventId);
      const outcomes = await race(path, [[first], [second], [first]]);
      const tally = outcomes.map((outcome) => outcome.outcome).sort();
      assert.equal(tally.filter((outcome) => outcome === 'appended').length, 1, `round ${round}: ${tally.join(',')}`);
      assert.ok(tally.includes('AUTHORITY_EVENT_CONFLICT'), `round ${round}: ${tally.join(',')}`);
      assert.ok(tally.every((outcome) => ['appended', 'existing', 'AUTHORITY_EVENT_CONFLICT'].includes(outcome)));
      assertUnforked(path, 2);
    }
  });
});
