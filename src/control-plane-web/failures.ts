/**
 * CTRL-03 — the closed failure taxonomy of the web control plane.
 *
 * Every Host answer that is not a well-formed 2xx becomes exactly one of these
 * kinds. Nothing here turns a refusal into a success, and nothing turns a
 * recorded write into "nothing changed": a `503 AUTHORITY_STATE_REFRESH_FAILED`
 * carrying `recorded: true` means the durable write **committed** (CTRL-02
 * SEC-INV-199), so it has its own kind and its own recovery text.
 */

export type FailureKind =
  /** 401 — the credential is missing, unknown or not valid on the operator plane. */
  | 'unauthenticated'
  /** 403 — authenticated, but the role lacks the permission (or a wrong-plane credential the Host recognizes). */
  | 'unauthorized'
  /** 400 / 413 / 415 — the Host refused the request as malformed. Nothing was written. */
  | 'validation'
  /** 409 OPERATOR_IDEMPOTENCY_CONFLICT — this idempotency key was used for a different request. Nothing was written. */
  | 'idempotency-conflict'
  /** 409 — the authoritative store refused the operation (`failure` names why). Nothing was written. */
  | 'refused'
  /** 404 — the target does not exist in this organization, or the capability is not composed. */
  | 'not-found'
  /** 503 AUTHORITY_STATE_REFRESH_FAILED with `recorded: true` — the write COMMITTED; the projection fails closed until a refresh. */
  | 'recorded-refresh-failed'
  /** 500 AUTHORITY_STATE_INTEGRITY_FAILED / GOVERNANCE_RECORD_CORRUPTED — state could not be verified; a security incident. */
  | 'integrity-failed'
  /** 503 (other) or the Host could not be reached at all. Whether anything was written is unknown for a write. */
  | 'unavailable'
  /** A 2xx whose body is not the documented shape, or any other answer. Never rendered as state. */
  | 'unknown';

export interface HostFailure {
  readonly kind: FailureKind;
  /** HTTP status, or `null` when no response was received. */
  readonly status: number | null;
  /** The Host's error code, when it sent one. */
  readonly code: string | null;
  /** The Host's own message (safe operator text), or the console's when there was none. */
  readonly message: string;
  /** `failure` detail of a 409 / 500 envelope, when present. */
  readonly failure: string | null;
  /** `recorded` exactly as the Host stated it: `true`, `false`, or not stated (`null`). */
  readonly recorded: boolean | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Classifies one non-2xx Host answer. `body` is the parsed JSON (or `undefined`). */
export function classifyHostFailure(status: number, body: unknown): HostFailure {
  const error = asRecord(asRecord(body)?.['error']);
  const code = asString(error?.['code']);
  const message = asString(error?.['message']) ?? `The Host answered HTTP ${status}.`;
  const failure = asString(error?.['failure']);
  const recordedValue = error?.['recorded'];
  const recorded = recordedValue === true ? true : recordedValue === false ? false : null;
  const base = { status, code, message, failure, recorded };
  if (status === 401) return { kind: 'unauthenticated', ...base };
  if (status === 403) return { kind: 'unauthorized', ...base };
  if (status === 400 || status === 413 || status === 415) return { kind: 'validation', ...base };
  if (status === 404) return { kind: 'not-found', ...base };
  if (status === 409) return { kind: code === 'OPERATOR_IDEMPOTENCY_CONFLICT' ? 'idempotency-conflict' : 'refused', ...base };
  // Only the Host's explicit statement makes a 503 "recorded". Anything else is
  // unknown for a write — never assumed written, never assumed unwritten.
  if (status === 503) return { kind: code === 'AUTHORITY_STATE_REFRESH_FAILED' && recorded === true ? 'recorded-refresh-failed' : 'unavailable', ...base };
  if (status === 500 && (code === 'AUTHORITY_STATE_INTEGRITY_FAILED' || code === 'GOVERNANCE_RECORD_CORRUPTED')) return { kind: 'integrity-failed', ...base };
  return { kind: 'unknown', ...base };
}

export function unreachableFailure(): HostFailure {
  return { kind: 'unavailable', status: null, code: null, message: 'The Frontera Host could not be reached.', failure: null, recorded: null };
}

export function contractFailure(status: number): HostFailure {
  return { kind: 'unknown', status, code: null, message: 'The Host answered with a body this console does not recognize. Nothing is shown as state.', failure: null, recorded: null };
}

/** What the operator is told, per kind. Short, exact, and never "nothing changed" for a recorded write. */
export const FAILURE_GUIDANCE: Readonly<Record<FailureKind, { readonly title: string; readonly guidance: string }>> = {
  unauthenticated: { title: 'Not signed in', guidance: 'The Host did not accept this session’s operator credential. Sign in again.' },
  unauthorized: { title: 'Not permitted', guidance: 'Your operator role does not hold the permission this operation requires. The Host refused it; nothing was changed.' },
  validation: { title: 'Request refused as invalid', guidance: 'The Host refused the request as malformed. Nothing was written. Correct the highlighted input and submit again.' },
  'idempotency-conflict': {
    title: 'Idempotency conflict',
    guidance: 'This request’s idempotency key was already used for a different request. Nothing was written. Start a new form to make a different request.',
  },
  refused: { title: 'Refused by the authoritative store', guidance: 'The Host refused the operation. Nothing was written. The reason code says why.' },
  'not-found': { title: 'Not found', guidance: 'Nothing with that identifier exists in this organization, or the capability is not composed on this Host.' },
  'recorded-refresh-failed': {
    title: 'Recorded — refresh failed',
    guidance:
      'The write WAS durably recorded, but the Host could not refresh its in-memory authority projection, which now fails closed (decisions are denied) until a refresh succeeds. Retry the SAME request — same target, same terms, same idempotency key — to replay the committed record and refresh. Do not submit a different request.',
  },
  'integrity-failed': {
    title: 'Authoritative state could not be verified',
    guidance:
      'The Host could not verify the authoritative state, so it reported none. A read changed nothing; for a write, the Host’s message below says whether it may have been recorded — never assume it was not. Treat this as a security incident and follow the operator runbook.',
  },
  unavailable: {
    title: 'Host unavailable',
    guidance: 'The Host is unavailable or could not be reached. For a write, whether it was recorded is unknown: reload the canonical state before retrying, and retry only the same request.',
  },
  unknown: { title: 'Unexpected answer', guidance: 'The Host answered in a way this console does not recognize. Nothing is shown as state; reload the canonical state.' },
};
