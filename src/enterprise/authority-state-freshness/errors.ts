/**
 * CORE-07 — the closed failure vocabulary of authority-state freshness.
 *
 * A caller has to be able to tell these apart, because they call for different
 * responses: an outage is retried or waited out, a rollback is an incident, a
 * pending transition needs trusted operational recovery, and an unenrolled
 * store needs the enrollment ceremony. A message names the rule that failed —
 * never a credential, a signature, a raw receipt, a path or an endpoint.
 */
export const AUTHORITY_STATE_FRESHNESS_ERROR_CODES = [
  /** The witness could not be reached in time (timeout, connection failure, HTTP 429 or 5xx). The only retryable code. */
  'AUTHORITY_FRESHNESS_UNAVAILABLE',
  /** The witness refused this deployment's credential (HTTP 401/403). */
  'AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED',
  /** The witness refused the request as malformed (other HTTP 4xx), or redirected. */
  'AUTHORITY_FRESHNESS_REFUSED',
  /** The witness answered with something that is not a well-formed protocol response. */
  'AUTHORITY_FRESHNESS_MALFORMED_RESPONSE',
  /** A receipt that does not verify under the pinned witness key, names another witness, answers another operation or challenge. */
  'AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC',
  /** The witness speaks another protocol version or lacks a required operation. */
  'AUTHORITY_FRESHNESS_PROTOCOL_UNSUPPORTED',
  /** The witness's binding for this organization and state kind names another store, organization or kind. */
  'AUTHORITY_FRESHNESS_BINDING_MISMATCH',
  /** The local authority state is older than the state the witness holds. */
  'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED',
  /** The local authority state and the witnessed state disagree at the same position, or the local state is ahead of anything witnessed. */
  'AUTHORITY_FRESHNESS_FORK_DETECTED',
  /** The witness holds a prepared transition the local store does not hold; it is ambiguous between "crashed before commit" and "committed, then rolled back". */
  'AUTHORITY_FRESHNESS_PENDING_RECOVERY',
  /** The local store holds authority state the witness has no binding for. Never auto-enrolled; the enrollment ceremony is explicit. */
  'AUTHORITY_FRESHNESS_UNBOUND_STORE',
  /** The binding already exists; enrollment never rebinds it. */
  'AUTHORITY_FRESHNESS_ALREADY_ENROLLED',
  /** Another writer advanced or prepared the witnessed state first (compare-and-advance lost). Nothing was written. */
  'AUTHORITY_FRESHNESS_CONFLICT',
  /** The freshness boundary is misconfigured. */
  'AUTHORITY_FRESHNESS_CONFIGURATION_INVALID',
] as const;

export type AuthorityStateFreshnessErrorCode = (typeof AUTHORITY_STATE_FRESHNESS_ERROR_CODES)[number];

export class AuthorityStateFreshnessError extends Error {
  readonly code: AuthorityStateFreshnessErrorCode;

  constructor(code: AuthorityStateFreshnessErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityStateFreshnessError';
    this.code = code;
  }
}

export function isAuthorityStateFreshnessError(error: unknown): error is AuthorityStateFreshnessError {
  return error instanceof AuthorityStateFreshnessError;
}

/**
 * Only availability is retried. Everything else is an answer — an
 * authentication failure, a refusal, a malformed or unauthentic receipt, a
 * binding mismatch, a rollback or a fork — and asking again cannot make it
 * true.
 */
export function isRetryableAuthorityStateFreshnessFailure(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_UNAVAILABLE';
}
