import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
  createInMemoryAuthorityEventStreamStore,
  createSqliteAuthorityEventStreamStore,
  isAuthorityEventStreamError,
} from '../authority-event-stream/index.js';
import { ORG_A, attempt, bodies, decision, describeAuthorityEventStreamStoreContract, eventInput, rejectsWith, steppingClock } from './authority-event-stream-support.js';

/**
 * §14 / §27 / §29 — the store contract against both implementations, then what
 * only the durable store has: restart, append-only triggers, schema refusal
 * before mutation, and fail-closed verification of every raw-SQLite corruption.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-authority-events-'));
  directories.push(directory);
  return join(directory, 'authority-event-stream.sqlite');
}

describeAuthorityEventStreamStoreContract('In-memory authority event stream', async (now) => {
  const store = createInMemoryAuthorityEventStreamStore({ now });
  return { store, close: () => store.close() };
});

describeAuthorityEventStreamStoreContract('SQLite authority event stream', async (now) => {
  const path = freshPath();
  const store = await createSqliteAuthorityEventStreamStore(path, { now });
  return {
    store,
    close: () => store.close(),
    reopen: async () => {
      await store.close();
      return createSqliteAuthorityEventStreamStore(path, { now });
    },
  };
});

const A = { organizationId: ORG_A };

/** A raw writer on the same file, standing in for someone with filesystem access. The append-only triggers are dropped first, exactly as such a writer could. */
function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

/** Three events on disk: decision, grant issued, one attempt. */
async function seeded(): Promise<{ readonly path: string; readonly streamId: string; readonly eventIds: readonly string[] }> {
  const path = freshPath();
  const store = await createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now });
  const events = [(await store.append(A, decision())).event, (await store.append(A, eventInput(bodies()['grant.issued']))).event, (await store.append(A, attempt('aoc.exec:seed'))).event];
  await store.close();
  return { path, streamId: decision().streamId, eventIds: events.map((event) => event.eventId) };
}

describe('SQLite authority event stream — append-only at the storage layer', () => {
  it('triggers refuse UPDATE and DELETE on events and DELETE on heads', async () => {
    const { path } = await seeded();
    const db = new Database(path);
    try {
      assert.throws(() => db.exec(`UPDATE authority_events SET payload_json = '{}'`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM authority_events`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM authority_event_stream_heads`), /never deleted/);
    } finally {
      db.close();
    }
  });

  it('uses no AUTOINCREMENT for event order: the sequence is per stream and unique per stream', async () => {
    const { path } = await seeded();
    const db = new Database(path, { readonly: true });
    try {
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'authority_events'`).get() as { sql: string }).sql;
      assert.equal(/AUTOINCREMENT/i.test(ddl), false);
      assert.ok(/UNIQUE \(stream_id, sequence\)/.test(ddl));
    } finally {
      db.close();
    }
  });

  it('refuses a file recorded under another schema version, before mutating it', async () => {
    const { path } = await seeded();
    tamper(path, [`INSERT INTO authority_event_stream_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.authority-event-stream.schema.v0', 'current', '2026-01-01T00:00:00.000Z')`]);
    await rejectsWith(createSqliteAuthorityEventStreamStore(path, { now: steppingClock().now }), 'AUTHORITY_EVENT_STREAM_UNAVAILABLE');
    const db = new Database(path, { readonly: true });
    try {
      const triggers = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get() as { n: number }).n;
      assert.equal(triggers, 0, 'the refused file was not touched: the dropped triggers were not re-created');
    } finally {
      db.close();
    }
  });

  it('requires an injected clock — there is no ambient default', async () => {
    await rejectsWith(createSqliteAuthorityEventStreamStore(freshPath(), undefined as unknown as { now: () => string }), 'AUTHORITY_EVENT_STREAM_UNAVAILABLE');
    assert.throws(() => createInMemoryAuthorityEventStreamStore(undefined as unknown as { now: () => string }), (error: unknown) => isAuthorityEventStreamError(error));
  });

  it('reports honest health, and unhealthy once closed', async () => {
    const store = await createSqliteAuthorityEventStreamStore(freshPath(), { now: steppingClock().now });
    const healthy = await store.health();
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.schemaVersion, AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION);
    await store.close();
    assert.equal((await store.health()).status, 'unhealthy');
    await rejectsWith(store.append(A, decision()), 'AUTHORITY_EVENT_STREAM_UNAVAILABLE');
  });
});

describe('SQLite authority event stream — §29 corruption fails closed, is never repaired, and never appended past', () => {
  const zero = `sha256:${'0'.repeat(64)}`;
  const cases: readonly (readonly [string, (seed: { readonly streamId: string; readonly eventIds: readonly string[] }) => readonly string[]])[] = [
    ['payload mutation', ({ eventIds }) => [`UPDATE authority_events SET payload_json = '{"expiresAt":"2099-01-01T00:00:00.000Z","grantDigest":"${zero}"}' WHERE event_id = '${eventIds[1]}'`]],
    ['eventType mutation', ({ eventIds }) => [`UPDATE authority_events SET event_type = 'grant.revoked' WHERE event_id = '${eventIds[1]}'`]],
    ['occurredAt mutation', ({ eventIds }) => [`UPDATE authority_events SET occurred_at = '2020-01-01T00:00:00.000Z' WHERE event_id = '${eventIds[1]}'`]],
    ['recordedAt mutation', ({ eventIds }) => [`UPDATE authority_events SET recorded_at = '2020-01-01T00:00:00.000Z' WHERE event_id = '${eventIds[1]}'`]],
    ['organization mutation', ({ eventIds }) => [`UPDATE authority_events SET organization_id = 'org-beta' WHERE event_id = '${eventIds[1]}'`]],
    ['sequence mutation', ({ eventIds }) => [`UPDATE authority_events SET sequence = 9 WHERE event_id = '${eventIds[1]}'`]],
    ['previousEventDigest mutation', ({ eventIds }) => [`UPDATE authority_events SET previous_event_digest = '${zero}' WHERE event_id = '${eventIds[2]}'`]],
    ['eventDigest mutation', ({ eventIds }) => [`UPDATE authority_events SET event_digest = '${zero}' WHERE event_id = '${eventIds[1]}'`]],
    ['references mutation', ({ eventIds }) => [`UPDATE authority_events SET references_json = replace(references_json, 'aoc.grant:', 'aoc.grant:x') WHERE event_id = '${eventIds[1]}'`]],
    ['a middle event deleted', ({ eventIds }) => [`DELETE FROM authority_events WHERE event_id = '${eventIds[1]}'`]],
    ['the last event deleted behind an intact head', ({ eventIds }) => [`DELETE FROM authority_events WHERE event_id = '${eventIds[2]}'`]],
    ['head sequence mutation', ({ streamId }) => [`UPDATE authority_event_stream_heads SET sequence = 2 WHERE stream_id = '${streamId}'`]],
    ['head digest mutation', ({ streamId }) => [`UPDATE authority_event_stream_heads SET event_digest = '${zero}' WHERE stream_id = '${streamId}'`]],
    ['head seal mutation', ({ streamId }) => [`UPDATE authority_event_stream_heads SET head_digest = '${zero}' WHERE stream_id = '${streamId}'`]],
    ['head deleted', ({ streamId }) => [`DELETE FROM authority_event_stream_heads WHERE stream_id = '${streamId}'`]],
    ['an unparseable payload', ({ eventIds }) => [`UPDATE authority_events SET payload_json = '{not json' WHERE event_id = '${eventIds[1]}'`]],
    ['an event schema version rewritten', ({ eventIds }) => [`UPDATE authority_events SET schema_version = 'aoc.authority-event.v0' WHERE event_id = '${eventIds[1]}'`]],
  ];

  for (const [label, statements] of cases) {
    it(`${label}: verify reports it, read refuses it, append refuses it, and the rows are left exactly as found`, async () => {
      const seed = await seeded();
      tamper(seed.path, statements(seed));
      const snapshot = () => {
        const db = new Database(seed.path, { readonly: true });
        try {
          return JSON.stringify([db.prepare(`SELECT * FROM authority_events ORDER BY event_id`).all(), db.prepare(`SELECT * FROM authority_event_stream_heads`).all()]);
        } finally {
          db.close();
        }
      };
      const before = snapshot();
      const store = await createSqliteAuthorityEventStreamStore(seed.path, { now: steppingClock().now });
      try {
        const verification = await store.verifyStream(A, seed.streamId);
        assert.equal(verification.valid, false, 'reported invalid');
        assert.ok(verification.failures.length > 0);
        await rejectsWith(store.readStream(A, seed.streamId), 'AUTHORITY_EVENT_STREAM_CORRUPT');
        await rejectsWith(store.append(A, attempt('aoc.exec:after-corruption')), 'AUTHORITY_EVENT_STREAM_CORRUPT');
        await rejectsWith(store.append(A, decision()), 'AUTHORITY_EVENT_STREAM_CORRUPT');
      } finally {
        await store.close();
      }
      assert.equal(snapshot(), before, 'no repair, no truncation, no append');
    });
  }

  it('the head is never trusted before the chain: a head advanced alone (sequence and digest re-sealed) still fails', async () => {
    const seed = await seeded();
    const store = await createSqliteAuthorityEventStreamStore(seed.path, { now: steppingClock().now });
    const events = await store.readStream(A, seed.streamId);
    await store.close();
    const { authorityEventStreamHeadDigest } = await import('../authority-event-stream/index.js');
    const forged = { streamId: seed.streamId, organizationId: ORG_A, sequence: 2, eventDigest: events[1]?.eventDigest ?? '' };
    tamper(seed.path, [`UPDATE authority_event_stream_heads SET sequence = 2, event_digest = '${forged.eventDigest}', head_digest = '${authorityEventStreamHeadDigest(forged)}' WHERE stream_id = '${seed.streamId}'`]);
    const reopened = await createSqliteAuthorityEventStreamStore(seed.path, { now: steppingClock().now });
    try {
      assert.equal((await reopened.verifyStream(A, seed.streamId)).valid, false, 'a sealed head that hides event 3 is caught by the chain');
    } finally {
      await reopened.close();
    }
  });

  it('a corrupt stream is an evidence failure only: another stream in the same file still appends and reads', async () => {
    const seed = await seeded();
    tamper(seed.path, [`UPDATE authority_events SET event_type = 'grant.revoked' WHERE event_id = '${seed.eventIds[1]}'`]);
    const store = await createSqliteAuthorityEventStreamStore(seed.path, { now: steppingClock().now });
    try {
      const other = { requestId: 'aoc.gar:11111111111111111111111111111111' };
      assert.equal((await store.append(A, decision(other))).event.sequence, 1);
      assert.equal((await store.readStream(A, decision(other).streamId)).length, 1);
    } finally {
      await store.close();
    }
  });
});
