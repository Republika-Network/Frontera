import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  AUTHORITY_EVENT_STREAM_MAX_READ_BOUND,
  createInMemoryAuthorityEventStreamStore,
  createSqliteAuthorityEventStreamStore,
  type AuthorityEventStreamStore,
} from '../authority-event-stream/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { AUTHORITY_TRACE_LIMITS, buildAuthorityTrace } from '../evidence/index.js';
import { ORG_A, ORG_B, attempt, decision, steppingClock } from './authority-event-stream-support.js';

/**
 * ASSURE-01 — the bounded event-stream read.
 *
 * A trace is complete for its request or refused; it is never truncated. The
 * bound is enforced by the P8 store itself: a stream over the bound is refused
 * from its row count, highest sequence and sealed head **before any event row
 * is loaded**. These tests prove that on the real SQLite store (where every
 * event row of the oversized stream is made unparseable, so loading even one
 * would fail differently) and on the in-memory store, and through the trace.
 */

const A = { organizationId: ORG_A };
const B = { organizationId: ORG_B };
const BOUND = AUTHORITY_TRACE_LIMITS.maxEvents;
const STREAM = decision().streamId;

const directories: string[] = [];
const stores: AuthorityEventStreamStore[] = [];
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-assure01-bounded-'));
  directories.push(directory);
  return join(directory, 'authority-event-stream.sqlite');
}

async function filled(store: AuthorityEventStreamStore, count: number): Promise<void> {
  await store.append(A, decision());
  for (let index = 1; index < count; index += 1) await store.append(A, attempt(`aoc.exec:bounded-${index}`));
}

/**
 * Counts the event rows SQLite actually hands back from any statement over
 * `authority_events` — the store's own statements included (it imports the same
 * `better-sqlite3` module). This is what "materialized" means below.
 */
const materialized = { rows: 0 };
{
  const probe = new Database(':memory:');
  const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown };
  probe.close();
  const all = statementPrototype.all;
  statementPrototype.all = function (this: { source: string }, ...args: unknown[]): unknown[] {
    const rows = all.apply(this, args);
    if (/SELECT event_id[\s\S]*FROM authority_events/.test(this.source)) materialized.rows += rows.length;
    return rows;
  };
}

/** A raw writer on the same file (append-only triggers dropped first, as a filesystem writer could). */
function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

const providers: readonly [string, () => Promise<{ store: AuthorityEventStreamStore; path?: string }>][] = [
  ['SQLite', async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    return { store, path };
  }],
  ['in-memory', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    stores.push(store);
    return { store };
  }],
];

for (const [name, open] of providers) {
  describe(`ASSURE-01 bounded stream read — ${name} store`, () => {
    it(`a stream at the bound (${BOUND} events) reads complete and verified — exactly what the unbounded read returns`, async () => {
      const { store } = await open();
      await filled(store, BOUND);
      const read = await store.readStreamBounded(A, STREAM, { maxEvents: BOUND });
      assert.equal(read.outcome, 'within-bound');
      assert.ok(read.outcome === 'within-bound');
      assert.equal(read.verification.valid, true);
      assert.equal(read.events.length, BOUND, 'no truncation');
      assert.deepEqual(read.events, await store.readStream(A, STREAM));
    });

    it(`a stream one over the bound (${BOUND + 1} events) is refused, with its size — never a prefix, suffix or sample`, async () => {
      const { store } = await open();
      await filled(store, BOUND + 1);
      materialized.rows = 0;
      const read = await store.readStreamBounded(A, STREAM, { maxEvents: BOUND });
      assert.deepEqual(read, { outcome: 'exceeds-bound', maxEvents: BOUND, eventCount: BOUND + 1 });
      assert.equal(materialized.rows, 0, 'no event row was materialized');
      assert.equal('events' in read, false, 'no events at all accompany a refusal');
    });

    it('another organization is refused — before, and regardless of, the stream’s size', async () => {
      const { store } = await open();
      await filled(store, BOUND + 1);
      await assert.rejects(store.readStreamBounded(B, STREAM, { maxEvents: BOUND }), { code: 'AUTHORITY_EVENT_TENANT_VIOLATION' });
      await assert.rejects(store.readStreamBounded(B, STREAM, { maxEvents: AUTHORITY_EVENT_STREAM_MAX_READ_BOUND }), { code: 'AUTHORITY_EVENT_TENANT_VIOLATION' });
      await assert.rejects(store.readStreamBounded({} as never, STREAM, { maxEvents: BOUND }), { code: 'AUTHORITY_EVENT_TENANT_VIOLATION' });
    });

    it('a malformed or excessive bound is refused before any state is read — there is no unbounded bounded read', async () => {
      const { store } = await open();
      await filled(store, 3);
      for (const maxEvents of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, AUTHORITY_EVENT_STREAM_MAX_READ_BOUND + 1, Number.MAX_SAFE_INTEGER, '256', null, undefined]) {
        await assert.rejects(store.readStreamBounded(A, STREAM, { maxEvents } as never), { code: 'AUTHORITY_EVENT_INPUT_INVALID' }, String(maxEvents));
      }
      await assert.rejects(store.readStreamBounded(A, STREAM, undefined as never), { code: 'AUTHORITY_EVENT_INPUT_INVALID' });
      assert.equal((await store.readStreamBounded(A, STREAM, { maxEvents: AUTHORITY_EVENT_STREAM_MAX_READ_BOUND })).outcome, 'within-bound');
      assert.equal((await store.readStreamBounded(A, STREAM, { maxEvents: 2 })).outcome, 'exceeds-bound', 'a smaller bound refuses a larger stream');
    });

    it('an unknown stream is an empty, valid, within-bound read', async () => {
      const { store } = await open();
      const read = await store.readStreamBounded(A, 'aoc.aes:unknown-stream', { maxEvents: BOUND });
      assert.equal(read.outcome, 'within-bound');
      assert.ok(read.outcome === 'within-bound');
      assert.deepEqual([read.verification.valid, read.events.length], [true, 0]);
    });
  });
}

describe('ASSURE-01 bounded stream read — the SQLite store sizes the stream before loading a single row', () => {
  it('every row of an oversized stream made unparseable: the unbounded read fails on them, the bounded read refuses without touching them', async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    await filled(store, BOUND + 1);
    tamper(path, [`UPDATE authority_events SET payload_json = 'not json', references_json = 'not json' WHERE stream_id = '${STREAM}'`]);
    materialized.rows = 0;
    await assert.rejects(store.readStream(A, STREAM), { code: 'AUTHORITY_EVENT_STREAM_CORRUPT' }, 'loading any row would fail');
    assert.equal(materialized.rows, BOUND + 1, 'the unbounded read materializes every row (the probe is live)');
    materialized.rows = 0;
    assert.deepEqual(await store.readStreamBounded(A, STREAM, { maxEvents: BOUND }), { outcome: 'exceeds-bound', maxEvents: BOUND, eventCount: BOUND + 1 }, 'refused from the size alone');
    assert.equal(materialized.rows, 0, 'not one event row of the oversized stream was materialized');
  });

  it('a head rewritten to claim a short stream does not let the full stream through: the row count still decides', async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    await filled(store, BOUND + 1);
    tamper(path, [`UPDATE authority_event_stream_heads SET sequence = 1 WHERE stream_id = '${STREAM}'`]);
    materialized.rows = 0;
    assert.equal((await store.readStreamBounded(A, STREAM, { maxEvents: BOUND })).outcome, 'exceeds-bound');
    assert.equal(materialized.rows, 0);
  });

  it('rows deleted under a high sequence, with the head rewritten short, do not shrink the stream below its highest sequence', async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    await filled(store, BOUND + 1);
    // Rows deleted *and* the head rewritten short: neither the row count nor the
    // head now says 257 — the highest surviving sequence still does.
    tamper(path, [`DELETE FROM authority_events WHERE stream_id = '${STREAM}' AND sequence BETWEEN 2 AND 100`, `UPDATE authority_event_stream_heads SET sequence = 1 WHERE stream_id = '${STREAM}'`]);
    materialized.rows = 0;
    assert.deepEqual(await store.readStreamBounded(A, STREAM, { maxEvents: BOUND }), { outcome: 'exceeds-bound', maxEvents: BOUND, eventCount: BOUND + 1 });
    assert.equal(materialized.rows, 0);
  });

  it('within the bound, a corrupted stream is reported as invalid with no events — never repaired, never partial', async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    await filled(store, 5);
    tamper(path, [`UPDATE authority_events SET payload_json = 'not json' WHERE stream_id = '${STREAM}' AND sequence = 3`]);
    const read = await store.readStreamBounded(A, STREAM, { maxEvents: BOUND });
    assert.equal(read.outcome, 'within-bound');
    assert.ok(read.outcome === 'within-bound');
    assert.equal(read.verification.valid, false);
    assert.deepEqual(read.events, []);
  });
});

describe('ASSURE-01 bounded stream read — the trace, on the real SQLite store', () => {
  function sources(store: AuthorityEventStreamStore) {
    const requestId = decision().references.requestId;
    const record = {
      request: { requestId, organizationId: ORG_A, actorId: 'actor', actionType: 'act', resourceScope: 'res', requestedAt: 'x', receivedAt: 'x', payloadDigest: 'sha256:p' },
      evaluation: { evaluationId: 'evaluation-bounded', decisionId: 'decision-bounded', requestId, status: 'denied', reasonCodes: [], evaluatedAt: 'x', kernelVersion: 'k' },
      integrity: { aggregateDigest: 'sha256:a', chainPosition: 1 },
      references: [],
    } as unknown as GovernanceRecord;
    return {
      requestId,
      sources: {
        governance: { getByRequestId: async () => record, verify: async () => ({ valid: true, failures: [] }) as never },
        events: { readStreamBounded: (context: { readonly organizationId: string }, streamId: string, options: { readonly maxEvents: number }) => store.readStreamBounded(context, streamId, options) },
      },
    };
  }

  it(`a request with ${BOUND + 1} events is refused as too large; with ${BOUND} its whole stream is in the trace`, async () => {
    const path = freshPath();
    const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
    stores.push(store);
    await filled(store, BOUND);
    const within = sources(store);
    const built = await buildAuthorityTrace(within.sources, { system: true }, within.requestId);
    assert.equal(built?.trace.stages.events.events.length, BOUND);
    await store.append(A, attempt('aoc.exec:bounded-over'));
    tamper(path, [`UPDATE authority_events SET payload_json = 'not json' WHERE stream_id = '${STREAM}'`]);
    materialized.rows = 0;
    await assert.rejects(buildAuthorityTrace(within.sources, { system: true }, within.requestId), { code: 'EVIDENCE_TRACE_TOO_LARGE' }, 'refused from the size, without loading the (now unparseable) rows');
    assert.equal(materialized.rows, 0);
  });
});
