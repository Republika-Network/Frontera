import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  AUTHORITY_EVENT_GENESIS_TYPE,
  AUTHORITY_EVENT_SCHEMA_VERSION,
  AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
  type AppendAuthorityEventInput,
  type AuthorityEvent,
  type AuthorityEventBody,
  type AuthorityEventStreamHead,
  type AuthorityEventStreamVerification,
} from './contracts.js';
import { deriveAuthorityEventId, deriveAuthorityEventStreamId } from './identifiers.js';
import { authorityEventInputViolation } from './validation.js';

/**
 * The event chain: what one event's digest covers, how an event is built, how
 * two facts are compared, and how a persisted stream and its head are verified.
 *
 * Shared verbatim by the in-memory and SQLite stores, so the two can never
 * disagree about what "intact" means. Reuses the Governance Store's canonical
 * serializer and digest (`aoc.canonical-json.v1`, `sha256:`) exactly as the
 * Agent Passport chain does; there is no second canonicalization.
 */

/**
 * Every stored field except the digest itself. The *set* of fields is the
 * contract: payload, type, sequence, tenant, stream, references, both instants
 * and the previous digest are all inside it, so a change to any of them — or a
 * re-pointing of the chain — no longer matches the recorded digest.
 */
export function authorityEventDigestInput(event: Omit<AuthorityEvent, 'eventDigest'>): Record<string, unknown> {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    streamId: event.streamId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    references: event.references,
    payload: event.payload,
    previousEventDigest: event.previousEventDigest ?? null,
  };
}

export function computeAuthorityEventDigest(event: Omit<AuthorityEvent, 'eventDigest'>): string {
  return computeDigest(authorityEventDigestInput(event));
}

/**
 * The canonical bytes of the *fact* an event reports — everything a projector
 * supplied, nothing the store assigned. Two appends of one event id are the same
 * fact exactly when these bytes are equal; `recordedAt`, `sequence` and the chain
 * position are deliberately outside it, because a retry of the same fact must
 * resolve to the event already recorded, not conflict with it.
 */
export function canonicalAuthorityEventFact(event: AppendAuthorityEventInput): string {
  return canonicalSerialize({
    schemaVersion: AUTHORITY_EVENT_SCHEMA_VERSION,
    eventId: event.eventId,
    streamId: event.streamId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    references: event.references,
    payload: event.payload,
  });
}

export function sameAuthorityEventFact(left: AppendAuthorityEventInput, right: AppendAuthorityEventInput): boolean {
  return canonicalAuthorityEventFact(left) === canonicalAuthorityEventFact(right);
}

/** A plain, prototype-free, undefined-free copy — what is stored is exactly what is digested. */
function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalSerialize(value)) as T;
}

/** Builds one fully formed, digested, deep-frozen event. Only a store calls this, once per append, inside its critical section. */
export function buildAuthorityEvent(input: AppendAuthorityEventInput, position: { readonly sequence: number; readonly recordedAt: string; readonly previousEventDigest?: string }): AuthorityEvent {
  const base = {
    schemaVersion: AUTHORITY_EVENT_SCHEMA_VERSION,
    eventId: input.eventId,
    streamId: input.streamId,
    organizationId: input.organizationId,
    eventType: input.eventType,
    sequence: position.sequence,
    occurredAt: input.occurredAt,
    recordedAt: position.recordedAt,
    references: canonicalCopy(input.references),
    payload: canonicalCopy(input.payload),
    ...(position.previousEventDigest !== undefined ? { previousEventDigest: position.previousEventDigest } : {}),
  } as Omit<AuthorityEvent, 'eventDigest'>;
  return deepFreeze({ ...base, eventDigest: computeAuthorityEventDigest(base) } as AuthorityEvent);
}

/**
 * The identity of the authoritative artifact an event is about. Event ids are
 * derived from it, so verification can prove an event's id belongs to its own
 * content rather than having been moved from another fact.
 */
export function authorityEventSourceId(body: AuthorityEventBody): string | undefined {
  const references = body.references;
  switch (body.eventType) {
    case 'governance.decision.committed':
      return references.evaluationId;
    case 'grant.issued':
    case 'grant.revoked':
    case 'grant.expiry.observed':
      return references.boundedGrantId;
    case 'execution.attempt.claimed':
    case 'execution.outcome.observed':
    case 'execution.outcome.resolved':
      return references.executionId;
    case 'exercise.reservation.reserved':
    case 'exercise.reservation.settled':
    case 'exercise.reservation.released':
    case 'exercise.reservation.reconciled':
      return references.reservationId;
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
}

/** Whether an input's stream and event ids are the ones its own organization, request and source artifact derive. */
export function authorityEventIdentityHolds(input: AppendAuthorityEventInput): boolean {
  const sourceId = authorityEventSourceId(input);
  if (sourceId === undefined) return false;
  const streamId = deriveAuthorityEventStreamId({ organizationId: input.organizationId, requestId: input.references.requestId });
  return input.streamId === streamId && input.eventId === deriveAuthorityEventId({ streamId, eventType: input.eventType, sourceId });
}

/** The sealed head. Its digest covers the stream, the tenant, the sequence and the head event's digest. */
export function authorityEventStreamHeadDigest(head: AuthorityEventStreamHead): string {
  return computeDigest({
    kind: 'authority-event-stream-head',
    schemaVersion: AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
    streamId: head.streamId,
    organizationId: head.organizationId,
    sequence: head.sequence,
    eventDigest: head.eventDigest,
  });
}

export interface PersistedAuthorityEventStreamHead {
  readonly head: AuthorityEventStreamHead;
  readonly headDigest: string;
}

function factOf(event: AuthorityEvent): AppendAuthorityEventInput {
  return {
    eventId: event.eventId,
    streamId: event.streamId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    references: event.references,
    payload: event.payload,
  } as AppendAuthorityEventInput;
}

/**
 * Verifies a persisted stream end to end: the chain from sequence 1, and the
 * head against the chain it claims to summarize.
 *
 * `events` must be every row the store holds for `streamId`, in the order the
 * store read them by sequence. Nothing is sorted, skipped, normalized or
 * repaired here, and the result never presents a verified prefix as the whole
 * stream: one failure anywhere makes the stream invalid.
 */
export function verifyAuthorityEventStream(streamId: string, events: readonly AuthorityEvent[], persistedHead: PersistedAuthorityEventStreamHead | undefined): AuthorityEventStreamVerification {
  const failures: string[] = [];
  const organizationId = events[0]?.organizationId;
  let previousDigest: string | undefined;

  events.forEach((event, index) => {
    const label = `event #${String(index + 1)}`;
    const expected = index + 1;
    if (event.sequence !== expected) failures.push(`${label} has sequence ${String(event.sequence)}, expected ${String(expected)} (gap, duplicate or reordering).`);
    if (event.streamId !== streamId) failures.push(`${label} belongs to another stream.`);
    if (event.organizationId !== organizationId) failures.push(`${label} changes the stream's organization.`);
    if (event.schemaVersion !== AUTHORITY_EVENT_SCHEMA_VERSION) failures.push(`${label} carries an unknown schema version.`);
    if (index === 0 && event.eventType !== AUTHORITY_EVENT_GENESIS_TYPE) failures.push(`${label} is not the committed decision the stream must begin with.`);
    if (index > 0 && event.eventType === AUTHORITY_EVENT_GENESIS_TYPE) failures.push(`${label} is a second committed decision.`);
    const violation = authorityEventInputViolation(factOf(event));
    if (violation !== undefined) failures.push(`${label} is outside the event contract (${violation}).`);
    else if (!authorityEventIdentityHolds(factOf(event))) failures.push(`${label} carries an id its own content does not derive.`);
    if (!isWellFormedDigest(event.eventDigest)) {
      failures.push(`${label} has a malformed eventDigest.`);
    } else {
      let recomputed: string | undefined;
      try {
        recomputed = computeAuthorityEventDigest(event);
      } catch {
        recomputed = undefined;
      }
      if (recomputed !== event.eventDigest) failures.push(`${label} does not match its recorded digest (mutation detected).`);
    }
    if (index === 0) {
      if (event.previousEventDigest !== undefined) failures.push(`${label} is the first event but carries a previousEventDigest.`);
    } else if (event.previousEventDigest !== previousDigest) {
      failures.push(`${label} does not point at the preceding event's digest (chain break).`);
    }
    previousDigest = event.eventDigest;
  });

  const last = events[events.length - 1];
  if (persistedHead === undefined) {
    if (events.length > 0) failures.push('the stream has events but no head.');
  } else {
    const { head, headDigest } = persistedHead;
    if (events.length === 0) failures.push('the stream has a head but no events.');
    if (head.streamId !== streamId) failures.push('the head belongs to another stream.');
    if (organizationId !== undefined && head.organizationId !== organizationId) failures.push("the head's organization is not the stream's.");
    if (head.sequence !== events.length) failures.push(`the head says sequence ${String(head.sequence)} but ${String(events.length)} event(s) exist.`);
    if (last !== undefined && head.eventDigest !== last.eventDigest) failures.push("the head's digest is not the last event's digest.");
    if (!isWellFormedDigest(headDigest) || authorityEventStreamHeadDigest(head) !== headDigest) failures.push('the head does not match its recorded digest.');
  }

  return deepFreeze({
    streamId,
    valid: failures.length === 0,
    eventCount: events.length,
    ...(persistedHead !== undefined ? { head: { ...persistedHead.head } } : {}),
    failures,
  });
}
