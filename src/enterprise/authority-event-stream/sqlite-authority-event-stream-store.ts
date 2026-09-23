import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { canonicalSerialize } from '../governance-store/canonical-json.js';
import {
  AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
  type AppendAuthorityEventInput,
  type AppendAuthorityEventResult,
  type AuthorityEvent,
  type AuthorityEventStreamAccessContext,
  type AuthorityEventStreamStoreHealth,
  type AuthorityEventStreamVerification,
} from './contracts.js';
import { AuthorityEventStreamError } from './errors.js';
import { authorityEventStreamHeadDigest, buildAuthorityEvent, verifyAuthorityEventStream, type PersistedAuthorityEventStreamHead } from './event-chain.js';
import {
  planAuthorityEventAppend,
  requireStreamAccessContext,
  requireStreamOwnedBy,
  requireValidAppend,
  type AuthorityEventStreamStore,
  type LoadedAuthorityEventStream,
} from './stream-store.js';
import { isCanonicalEventInstant } from './validation.js';

/**
 * The durable canonical authority event stream — the production implementation
 * of `AuthorityEventStreamStore`.
 *
 * ## The property everything else serves
 *
 * ```
 * two writers appending to the SAME stream cannot fork it
 * ```
 *
 * Every append is one `BEGIN IMMEDIATE` transaction (`better-sqlite3`'s
 * `transaction(...).immediate(...)`): the write lock is taken **before** the
 * stream is read, so "load every event and the head → verify them → resolve the
 * event id → choose head + 1 → sample `recordedAt` → insert the event → advance
 * the head" happens with no other writer able to interleave, in this process or
 * any other sharing the file. There is no read, then `await`, then write across
 * two transactions. `UNIQUE (stream_id, sequence)` is a second, independent
 * refusal of a duplicate position — not the mechanism, which is the lock.
 * `authority-event-stream-concurrency.test.ts` races independent connections in
 * worker threads and verifies the chain afterwards.
 *
 * ## Two tables, one of them a sealed summary
 *
 * ```
 * authority_events               one immutable row per event: the chain
 * authority_event_stream_heads   one row per stream: sequence + head digest, sealed
 * ```
 *
 * The head is an optimization and a cross-check, never a source of truth: every
 * append and every read loads the whole stream and verifies the chain and the
 * head against each other before believing either. A deleted, inserted,
 * reordered or edited event, a re-pointed previous digest, or a head that no
 * longer names the last event all fail verification. Triggers refuse `UPDATE`
 * and `DELETE` on events and `DELETE` on heads; nothing here issues either.
 *
 * ## What this is not
 *
 * - **Not authenticity.** Unkeyed SHA-256: a writer able to rewrite a whole
 *   stream and its head consistently, or to delete a whole stream with its head,
 *   is not detected from inside this file (the anti-rollback gap every store
 *   here records). Signatures and an external anchor are later work.
 * - **Not authority.** Nothing on any authorization path opens this file.
 * - **Not global order.** Order is per stream; there is no cross-stream or
 *   cross-host sequence.
 * - **No TTL, no sweeper, no cleanup, no repair.**
 */

export interface CreateSqliteAuthorityEventStreamStoreOptions {
  /** The injected clock: sampled once inside every append's `BEGIN IMMEDIATE`, after the write lock is held, as `recordedAt`. Required — there is no ambient default. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

/** The durable store, plus the lifecycle surface a host needs. */
export interface DurableAuthorityEventStreamStore extends AuthorityEventStreamStore {
  readonly providerKind: 'sqlite';
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS authority_event_stream_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS authority_events (
    event_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    references_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_event_digest TEXT,
    event_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    UNIQUE (stream_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS authority_event_stream_heads (
    stream_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    head_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS authority_events_append_only_update
    BEFORE UPDATE ON authority_events
    BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS authority_events_append_only_delete
    BEFORE DELETE ON authority_events
    BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS authority_event_stream_heads_no_delete
    BEFORE DELETE ON authority_event_stream_heads
    BEGIN SELECT RAISE(ABORT, 'authority event stream heads are never deleted'); END;
`;

interface EventRow {
  readonly event_id: string;
  readonly stream_id: string;
  readonly organization_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly references_json: string;
  readonly payload_json: string;
  readonly previous_event_digest: string | null;
  readonly event_digest: string;
  readonly schema_version: string;
}

interface HeadRow {
  readonly stream_id: string;
  readonly organization_id: string;
  readonly sequence: number;
  readonly event_digest: string;
  readonly head_digest: string;
  readonly schema_version: string;
}

function unavailable(message: string): AuthorityEventStreamError {
  return new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_UNAVAILABLE', message);
}

function corrupt(streamId: string, what: string): AuthorityEventStreamError {
  return new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_CORRUPT', `Persisted authority event stream '${streamId}' failed validation (${what}). Refused, never repaired.`);
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}, received '${String(value)}'.`);
  }
  return timeout;
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

/** A row, read back literally. Unparseable JSON is corruption, never a skipped row. Everything else is left for the chain verifier to judge. */
function eventOf(row: EventRow): AuthorityEvent {
  let references: unknown;
  let payload: unknown;
  try {
    references = JSON.parse(row.references_json);
    payload = JSON.parse(row.payload_json);
  } catch {
    throw corrupt(row.stream_id, 'an event row does not decode');
  }
  return {
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    streamId: row.stream_id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    references,
    payload,
    ...(row.previous_event_digest !== null ? { previousEventDigest: row.previous_event_digest } : {}),
    eventDigest: row.event_digest,
  } as AuthorityEvent;
}

function headOf(row: HeadRow): PersistedAuthorityEventStreamHead {
  if (row.schema_version !== AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION) throw corrupt(row.stream_id, 'the head carries an unknown schema version');
  return { head: { streamId: row.stream_id, organizationId: row.organization_id, sequence: row.sequence, eventDigest: row.event_digest }, headDigest: row.head_digest };
}

export async function createSqliteAuthorityEventStreamStore(dbPath: string, options: CreateSqliteAuthorityEventStreamStoreOptions): Promise<DurableAuthorityEventStreamStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The authority event stream path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The authority event stream store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // FULL: an acknowledged event that a power loss could still lose would leave
  // the evidence trail silently shorter than what the runtime reported.
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version guard runs before `CREATE TABLE IF NOT EXISTS`, so a file written
  // under a schema this runtime does not implement is refused unmutated.
  if (tableExists(db, 'authority_event_stream_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM authority_event_stream_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The authority event stream is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);
  const latest = db.prepare(`SELECT schema_version FROM authority_event_stream_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    const openedAt = now();
    if (!isCanonicalEventInstant(openedAt)) {
      db.close();
      throw unavailable('The store clock did not answer a canonical instant.');
    }
    db.prepare(`INSERT INTO authority_event_stream_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION, openedAt);
  }

  const selectStream = db.prepare(
    `SELECT event_id, stream_id, organization_id, sequence, event_type, occurred_at, recorded_at, references_json, payload_json, previous_event_digest, event_digest, schema_version
       FROM authority_events WHERE stream_id = ? ORDER BY sequence ASC, event_id ASC`,
  );
  const selectEvent = db.prepare(
    `SELECT event_id, stream_id, organization_id, sequence, event_type, occurred_at, recorded_at, references_json, payload_json, previous_event_digest, event_digest, schema_version
       FROM authority_events WHERE event_id = ?`,
  );
  const selectHead = db.prepare(`SELECT stream_id, organization_id, sequence, event_digest, head_digest, schema_version FROM authority_event_stream_heads WHERE stream_id = ?`);
  const insertEvent = db.prepare(
    `INSERT INTO authority_events
       (event_id, stream_id, organization_id, sequence, event_type, occurred_at, recorded_at, references_json, payload_json, previous_event_digest, event_digest, schema_version)
     VALUES (@eventId, @streamId, @organizationId, @sequence, @eventType, @occurredAt, @recordedAt, @referencesJson, @payloadJson, @previousEventDigest, @eventDigest, @schemaVersion)`,
  );
  const upsertHead = db.prepare(
    `INSERT INTO authority_event_stream_heads (stream_id, organization_id, sequence, event_digest, head_digest, schema_version)
     VALUES (@streamId, @organizationId, @sequence, @eventDigest, @headDigest, @schemaVersion)
     ON CONFLICT (stream_id) DO UPDATE SET organization_id = excluded.organization_id, sequence = excluded.sequence, event_digest = excluded.event_digest, head_digest = excluded.head_digest, schema_version = excluded.schema_version`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The authority event stream store has been closed.');
  }

  function load(streamId: string): LoadedAuthorityEventStream {
    const events = (selectStream.all(streamId) as EventRow[]).map(eventOf);
    const headRow = selectHead.get(streamId) as HeadRow | undefined;
    return { events, head: headRow === undefined ? undefined : headOf(headRow) };
  }

  const runAppend = db.transaction((input: AppendAuthorityEventInput): AppendAuthorityEventResult => {
    const stream = load(input.streamId);
    const existingRow = selectEvent.get(input.eventId) as EventRow | undefined;
    const plan = planAuthorityEventAppend(input, stream, existingRow === undefined ? undefined : eventOf(existingRow));
    if (plan.kind === 'existing') return { outcome: 'existing', event: plan.event };

    // Sampled here: after the write lock is held, however long it waited.
    const recordedAt = now();
    if (!isCanonicalEventInstant(recordedAt)) throw unavailable('The store clock did not answer a canonical instant; nothing was appended.');
    const event = buildAuthorityEvent(input, { sequence: plan.sequence, recordedAt, ...(plan.previousEventDigest !== undefined ? { previousEventDigest: plan.previousEventDigest } : {}) });
    insertEvent.run({
      eventId: event.eventId,
      streamId: event.streamId,
      organizationId: event.organizationId,
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      referencesJson: canonicalSerialize(event.references),
      payloadJson: canonicalSerialize(event.payload),
      previousEventDigest: event.previousEventDigest ?? null,
      eventDigest: event.eventDigest,
      schemaVersion: event.schemaVersion,
    });
    const head = { streamId: event.streamId, organizationId: event.organizationId, sequence: event.sequence, eventDigest: event.eventDigest };
    upsertHead.run({ ...head, headDigest: authorityEventStreamHeadDigest(head), schemaVersion: AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION });
    return { outcome: 'appended', event };
  });

  const runRead = db.transaction((streamId: string): LoadedAuthorityEventStream => load(streamId));

  return {
    providerKind: 'sqlite',

    async append(context: AuthorityEventStreamAccessContext, input: AppendAuthorityEventInput): Promise<AppendAuthorityEventResult> {
      assertOpen();
      requireValidAppend(context, input);
      // BEGIN IMMEDIATE: the write lock is held from before the stream is read
      // until COMMIT. With `synchronous = FULL` the event is durable before this
      // resolves.
      return runAppend.immediate(input);
    },

    async readStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<readonly AuthorityEvent[]> {
      assertOpen();
      const organizationId = requireStreamAccessContext(context);
      const stream = runRead(streamId);
      requireStreamOwnedBy(streamId, stream, organizationId);
      const verification = verifyAuthorityEventStream(streamId, stream.events, stream.head);
      if (!verification.valid) throw corrupt(streamId, verification.failures[0] ?? 'verification failed');
      return Object.freeze(stream.events.map((event) => Object.freeze(event)));
    },

    async verifyStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<AuthorityEventStreamVerification> {
      assertOpen();
      const organizationId = requireStreamAccessContext(context);
      let stream: LoadedAuthorityEventStream;
      try {
        stream = runRead(streamId);
      } catch (error) {
        if (error instanceof AuthorityEventStreamError && error.code === 'AUTHORITY_EVENT_STREAM_CORRUPT') {
          return { streamId, valid: false, eventCount: 0, failures: [error.message] };
        }
        throw error;
      }
      requireStreamOwnedBy(streamId, stream, organizationId);
      return verifyAuthorityEventStream(streamId, stream.events, stream.head);
    },

    async health(): Promise<AuthorityEventStreamStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM authority_event_stream_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return {
        status: readable && writable ? 'healthy' : 'unhealthy',
        readable,
        writable,
        schemaVersion: AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
        checkedAt: now(),
      };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
