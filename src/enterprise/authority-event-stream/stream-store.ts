import {
  AUTHORITY_EVENT_GENESIS_TYPE,
  type AppendAuthorityEventInput,
  type AppendAuthorityEventResult,
  type AuthorityEvent,
  type AuthorityEventStreamAccessContext,
  type AuthorityEventStreamStoreHealth,
  type AuthorityEventStreamVerification,
} from './contracts.js';
import { AuthorityEventStreamError } from './errors.js';
import { authorityEventIdentityHolds, sameAuthorityEventFact, verifyAuthorityEventStream, type PersistedAuthorityEventStreamHead } from './event-chain.js';
import { authorityEventInputViolation, isOpaqueEventIdentifier } from './validation.js';

/**
 * The read half. Handed to trusted in-process operator code, never to anything
 * that authorizes, issues, exercises, routes or replays.
 *
 * Verify-first: `readStream` returns a stream only after the whole chain and its
 * head verified, and throws `AUTHORITY_EVENT_STREAM_CORRUPT` otherwise — it never
 * returns a prefix, a best-effort subset or a repaired copy. `verifyStream`
 * reports instead of throwing.
 */
export interface AuthorityEventStreamReader {
  readStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<readonly AuthorityEvent[]>;
  verifyStream(context: AuthorityEventStreamAccessContext, streamId: string): Promise<AuthorityEventStreamVerification>;
}

/**
 * The write half — append only. There is no update, no delete, no truncate, no
 * repair and no cleanup, in this port or in any implementation of it.
 *
 * `append` assigns the sequence, the previous digest, `recordedAt` (its own
 * injected clock) and the event digest inside one critical section, after the
 * stream it extends has been verified. The same event id with a byte-equivalent
 * fact returns the event already recorded (`existing`); the same id with any
 * other fact throws `AUTHORITY_EVENT_CONFLICT` and writes nothing.
 */
export interface AuthorityEventStreamWriter {
  append(context: AuthorityEventStreamAccessContext, input: AppendAuthorityEventInput): Promise<AppendAuthorityEventResult>;
}

/**
 * The canonical authority event stream store.
 *
 * ## It is evidence storage, and nothing reads it to decide
 *
 * No Kernel, policy, grant, exercise-control, emergency-control, routing,
 * adapter or replay module imports this port — `authority-event-stream-boundaries.test.ts`
 * fails the build if one does. Lifecycle modules reach the stream only through
 * the write-only `AuthorityEventRecorder`, whose methods return nothing.
 *
 * ## What an implementation must guarantee
 *
 * 1. **Atomic append.** Verify the stream, resolve idempotency, choose the next
 *    sequence and write the event and its head in one critical section (SQLite:
 *    one `BEGIN IMMEDIATE` transaction; memory: one synchronous section).
 * 2. **Contiguous, unforked order.** Sequence 1, 2, 3… per stream; each event
 *    names the one before it; no gap, no duplicate, no fork.
 * 3. **Deterministic identity.** Resolve an id already present to the recorded
 *    event when the fact is equivalent, refuse it otherwise.
 * 4. **Tenant confinement.** A stream belongs to one organization forever; a
 *    call under any other organization reads nothing and writes nothing.
 * 5. **Verify before trusting a head.** The head is a sealed summary of the
 *    chain, checked against it on every append and every read.
 * 6. **Fail closed, never repair.** Corruption throws or is reported; nothing is
 *    skipped, truncated, rewritten or normalized.
 */
export interface AuthorityEventStreamStore extends AuthorityEventStreamReader, AuthorityEventStreamWriter {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<AuthorityEventStreamStoreHealth>;
  close(): Promise<void>;
}

/** What one stream holds, as loaded inside a critical section. */
export interface LoadedAuthorityEventStream {
  readonly events: readonly AuthorityEvent[];
  readonly head: PersistedAuthorityEventStreamHead | undefined;
}

export type AuthorityEventAppendPlan =
  | { readonly kind: 'existing'; readonly event: AuthorityEvent }
  | { readonly kind: 'append'; readonly sequence: number; readonly previousEventDigest?: string };

export function requireStreamAccessContext(context: AuthorityEventStreamAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  if (!isOpaqueEventIdentifier(organizationId)) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_TENANT_VIOLATION', 'An authority event stream call requires an organization scope.');
  }
  return organizationId;
}

/** The organization a persisted stream belongs to: its sealed head's, or — with no head — its first event's. */
export function streamOwner(stream: LoadedAuthorityEventStream): string | undefined {
  return stream.head?.head.organizationId ?? stream.events[0]?.organizationId;
}

/** Refuses a read of a stream owned by another organization, without revealing anything about it. */
export function requireStreamOwnedBy(streamId: string, stream: LoadedAuthorityEventStream, organizationId: string): void {
  const owner = streamOwner(stream);
  if (owner !== undefined && owner !== organizationId) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_TENANT_VIOLATION', `The caller is not authorized to access authority event stream '${streamId}'.`);
  }
}

/** Refuses a malformed append before any state is read. */
export function requireValidAppend(context: AuthorityEventStreamAccessContext, input: AppendAuthorityEventInput): void {
  const organizationId = requireStreamAccessContext(context);
  const violation = authorityEventInputViolation(input);
  if (violation !== undefined) throw new AuthorityEventStreamError('AUTHORITY_EVENT_INPUT_INVALID', `The authority event is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_TENANT_VIOLATION', `An event for another organization cannot be appended under this scope.`);
  }
  if (!authorityEventIdentityHolds(input)) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_INPUT_INVALID', 'The event or stream id is not the one its organization, request and source artifact derive.');
  }
}

/**
 * The one append decision, shared by every implementation and taken **inside**
 * its critical section, over state read there:
 *
 * ```
 * verify the whole stream + head   → corrupt: throw, append nothing
 * stream owned by another tenant   → throw, append nothing
 * event id already recorded        → same fact: existing   | other fact: conflict
 * lifecycle shape                  → first must be the decision; only one decision
 * otherwise                        → append at head + 1, pointing at the head digest
 * ```
 *
 * `existingById` is the event any stream holds under `input.eventId`, if one does.
 */
export function planAuthorityEventAppend(input: AppendAuthorityEventInput, stream: LoadedAuthorityEventStream, existingById: AuthorityEvent | undefined): AuthorityEventAppendPlan {
  const verification = verifyAuthorityEventStream(input.streamId, stream.events, stream.head);
  if (!verification.valid) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_STREAM_CORRUPT', `Authority event stream '${input.streamId}' failed verification; nothing was appended.`);
  }
  requireStreamOwnedBy(input.streamId, stream, input.organizationId);

  if (existingById !== undefined) {
    const recorded = stream.events.find((event) => event.eventId === input.eventId);
    if (recorded === undefined || existingById.streamId !== input.streamId || !sameAuthorityEventFact(recorded, input)) {
      throw new AuthorityEventStreamError('AUTHORITY_EVENT_CONFLICT', `Authority event '${input.eventId}' is already recorded with a different fact; the recorded event stands.`);
    }
    return { kind: 'existing', event: recorded };
  }

  const length = stream.events.length;
  if (length === 0 && input.eventType !== AUTHORITY_EVENT_GENESIS_TYPE) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_SEQUENCE_INVALID', `Authority event stream '${input.streamId}' must begin with its committed decision.`);
  }
  if (length > 0 && input.eventType === AUTHORITY_EVENT_GENESIS_TYPE) {
    throw new AuthorityEventStreamError('AUTHORITY_EVENT_SEQUENCE_INVALID', `Authority event stream '${input.streamId}' already holds its committed decision.`);
  }
  const previous = stream.events[length - 1];
  return { kind: 'append', sequence: length + 1, ...(previous !== undefined ? { previousEventDigest: previous.eventDigest } : {}) };
}
