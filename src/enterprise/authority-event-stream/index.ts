/**
 * P8 — the canonical authority event stream: a durable, append-only, ordered,
 * hash-chained, tenant-confined record of facts the governed-action /
 * bounded-grant lifecycle has already established.
 *
 * See `docs/architecture/ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md` and
 * `docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md`. The three things to
 * know from here: it is **evidence, never authority** — nothing that decides,
 * issues, exercises, admits, routes or replays reads it; lifecycle modules reach
 * it only through the write-only `AuthorityEventRecorder`, whose failure changes
 * nothing; and its digests are integrity, not authenticity.
 */
export {
  AUTHORITY_EVENT_GENESIS_TYPE,
  AUTHORITY_EVENT_REFERENCE_KEYS,
  AUTHORITY_EVENT_SCHEMA_VERSION,
  AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION,
  AUTHORITY_EVENT_TYPES,
  isAuthorityEventType,
} from './contracts.js';
export type {
  AppendAuthorityEventInput,
  AppendAuthorityEventResult,
  AuthorityEvent,
  AuthorityEventBody,
  AuthorityEventDecisionStatus,
  AuthorityEventExecutionStatus,
  AuthorityEventReferenceKey,
  AuthorityEventReferences,
  AuthorityEventStreamAccessContext,
  AuthorityEventStreamHead,
  AuthorityEventStreamStoreHealth,
  AuthorityEventStreamVerification,
  AuthorityEventType,
  AuthorityEventWithholdingLayer,
  DecisionCommittedPayload,
  ExecutionAttemptClaimedPayload,
  ExecutionOutcomeObservedPayload,
  GrantExpiryObservedPayload,
  GrantIssuedPayload,
  GrantRevokedPayload,
  ReservationReleasedPayload,
  ReservationReservedPayload,
  ReservationSettledPayload,
} from './contracts.js';
export { AuthorityEventStreamError, isAuthorityEventStreamError } from './errors.js';
export type { AuthorityEventStreamErrorCode } from './errors.js';
export { deriveAuthorityEventId, deriveAuthorityEventStreamId } from './identifiers.js';
export { authorityEventInputViolation, isCanonicalEventInstant, isSafeEvidenceString, isValidAuthorityEventInput } from './validation.js';
export {
  authorityEventDigestInput,
  authorityEventIdentityHolds,
  authorityEventSourceId,
  authorityEventStreamHeadDigest,
  buildAuthorityEvent,
  canonicalAuthorityEventFact,
  computeAuthorityEventDigest,
  sameAuthorityEventFact,
  verifyAuthorityEventStream,
} from './event-chain.js';
export type { PersistedAuthorityEventStreamHead } from './event-chain.js';
export type { AuthorityEventStreamReader, AuthorityEventStreamStore, AuthorityEventStreamWriter } from './stream-store.js';
export type { AuthorityEventRecorder } from './recorder.js';
export { createInMemoryAuthorityEventStreamStore } from './in-memory-authority-event-stream-store.js';
export type { InMemoryAuthorityEventStreamStoreOptions } from './in-memory-authority-event-stream-store.js';
export { createSqliteAuthorityEventStreamStore } from './sqlite-authority-event-stream-store.js';
export type { CreateSqliteAuthorityEventStreamStoreOptions, DurableAuthorityEventStreamStore } from './sqlite-authority-event-stream-store.js';
export { createAuthorityEventProjector } from './projector.js';
export type { AuthorityEventProjectionHealth, AuthorityEventProjector, AuthorityEventProjectorOptions } from './projector.js';
