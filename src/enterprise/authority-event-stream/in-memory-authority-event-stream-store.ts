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

export interface InMemoryAuthorityEventStreamStoreOptions {
  /** The injected clock. Sampled once per append, inside the synchronous critical section, as `recordedAt`. Required: there is no ambient default. */
  readonly now: () => string;
}

/**
 * The reference implementation of `AuthorityEventStreamStore`, and the one the
 * shared contract suite measures the SQLite store against.
 *
 * Every append is **one synchronous section** — no `await` between reading the
 * stream and writing the event and its head — which is what makes it atomic in
 * one process. **Not durable**: a restart loses every stream. The composition
 * root selects it only when `persistence.provider` is `memory`.
 */
export function createInMemoryAuthorityEventStreamStore(options: InMemoryAuthorityEventStreamStoreOptions): AuthorityEventStreamStore {
  if (typeof options?.now !== 'function') throw new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_UNAVAILABLE', 'The authority event stream store requires an injected clock.');
  const now = options.now;
  const streams = new Map<string, { events: AuthorityEvent[]; head: PersistedAuthorityEventStreamHead | undefined }>();
  const streamOfEvent = new Map<string, string>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_UNAVAILABLE', 'The authority event stream store has been closed.');
  }

  function load(streamId: string): LoadedAuthorityEventStream {
    const stream = streams.get(streamId);
    return { events: stream === undefined ? [] : [...stream.events], head: stream?.head };
  }

  return {
    providerKind: 'memory',

    async append(context: AuthorityEventStreamAccessContext, input: AppendAuthorityEventInput): Promise<AppendAuthorityEventResult> {
      assertOpen();
      requireValidAppend(context, input);
      // One synchronous critical section from here to the return.
      const stream = load(input.streamId);
      const existingStreamId = streamOfEvent.get(input.eventId);
      const existingById = existingStreamId === undefined ? undefined : streams.get(existingStreamId)?.events.find((event) => event.eventId === input.eventId);
      const plan = planAuthorityEventAppend(input, stream, existingById);
      if (plan.kind === 'existing') return { outcome: 'existing', event: plan.event };

      const recordedAt = now();
      if (!isCanonicalEventInstant(recordedAt)) throw new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_UNAVAILABLE', 'The store clock did not answer a canonical instant; nothing was appended.');
      const event = buildAuthorityEvent(input, { sequence: plan.sequence, recordedAt, ...(plan.previousEventDigest !== undefined ? { previousEventDigest: plan.previousEventDigest } : {}) });
      const head = { streamId: input.streamId, organizationId: input.organizationId, sequence: event.sequence, eventDigest: event.eventDigest };
      streams.set(input.streamId, { events: [...stream.events, event], head: { head, headDigest: authorityEventStreamHeadDigest(head) } });
      streamOfEvent.set(event.eventId, input.streamId);
      return { outcome: 'appended', event };
    },

    async readStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<readonly AuthorityEvent[]> {
      assertOpen();
      const organizationId = requireStreamAccessContext(context);
      const stream = load(streamId);
      requireStreamOwnedBy(streamId, stream, organizationId);
      const verification = verifyAuthorityEventStream(streamId, stream.events, stream.head);
      if (!verification.valid) throw new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_CORRUPT', `Authority event stream '${streamId}' failed verification.`);
      return Object.freeze([...stream.events]);
    },

    async verifyStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<AuthorityEventStreamVerification> {
      assertOpen();
      const organizationId = requireStreamAccessContext(context);
      const stream = load(streamId);
      requireStreamOwnedBy(streamId, stream, organizationId);
      return verifyAuthorityEventStream(streamId, stream.events, stream.head);
    },

    async health(): Promise<AuthorityEventStreamStoreHealth> {
      return {
        status: closed ? 'unhealthy' : 'healthy',
        readable: !closed,
        writable: !closed,
        schemaVersion: AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
        checkedAt: now(),
      };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
