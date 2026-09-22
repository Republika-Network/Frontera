/**
 * The canonical authority event stream's error taxonomy.
 *
 * Deliberately its own, and deliberately never mapped onto an authorization
 * vocabulary: every one of these is an **evidence** condition. None of them is a
 * reason to allow, deny, withhold, retry or replay anything, and nothing on an
 * authorization path ever catches one to decide.
 *
 * ## What the messages may say
 *
 * The stream or event id, the condition, and nothing else. No SQL, no file
 * path, no driver text, no payload contents.
 */
export type AuthorityEventStreamErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. */
  | 'AUTHORITY_EVENT_STREAM_UNAVAILABLE'
  /** The input is outside the closed contract: unknown event type, missing or undeclared reference or payload key, malformed id, instant or digest, or an unsafe value. Nothing was written. */
  | 'AUTHORITY_EVENT_INPUT_INVALID'
  /** An event with this id already exists with a different canonical fact. The first stands; nothing was written. Never last-write-wins. */
  | 'AUTHORITY_EVENT_CONFLICT'
  /** The call's organization is not the stream's (or the event's) organization. Nothing was read or written. */
  | 'AUTHORITY_EVENT_TENANT_VIOLATION'
  /** The event would break the stream's lifecycle shape: a first event that is not the committed decision, or a second decision. Nothing was written. */
  | 'AUTHORITY_EVENT_SEQUENCE_INVALID'
  /** The persisted chain or its head failed verification. Reported, never repaired, and never appended past. */
  | 'AUTHORITY_EVENT_STREAM_CORRUPT';

export class AuthorityEventStreamError extends Error {
  constructor(
    readonly code: AuthorityEventStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorityEventStreamError';
  }
}

export function isAuthorityEventStreamError(error: unknown): error is AuthorityEventStreamError {
  return error instanceof AuthorityEventStreamError;
}
