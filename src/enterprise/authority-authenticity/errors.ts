/**
 * Why an authority artifact's signature was not accepted.
 *
 * A closed vocabulary, deliberately separate from `BoundedGrantStoreErrorCode`.
 * Prompt 4's taxonomy distinguishes "this store cannot be opened" from "this
 * persisted state failed validation" because an operator responds to them
 * differently. The same reasoning splits authenticity off from integrity: a
 * record whose *digest* disagrees with its bytes is corruption, and the
 * response is to restore it; a record whose *signature* does not verify is a
 * record that no trusted authority key vouches for, and the response is to
 * find out who wrote it. Folding the two together would report a forgery as a
 * disk fault.
 *
 * Every value below is a refusal. There is no reason code here that means
 * "accepted with reservations", because there is no such outcome — the read
 * path turns any of these into no usable authority.
 *
 * ## What these may carry
 *
 * The failure reason, the artifact kind, and the key id that was *claimed*.
 * Never the signature bytes, never the signed payload, and never any key
 * material: an error that echoed the payload back would hand a caller the
 * canonical bytes it needs to shop for a signature that verifies over them.
 */
export const AUTHORITY_SIGNATURE_FAILURES = [
  /** No signature accompanied an artifact on a path that requires one. Never read as "this artifact predates signing". */
  'AUTHORITY_SIGNATURE_MISSING',
  /** The envelope is structurally unusable: a missing field, a non-string field, or signature bytes that are not the exact width the algorithm defines. */
  'AUTHORITY_SIGNATURE_MALFORMED',
  /** The envelope is well formed and the key is trusted, but the signature does not verify over the artifact's canonical bytes. */
  'AUTHORITY_SIGNATURE_INVALID',
  /** The envelope names a key id the trusted verification registry does not hold. Never a reason to consult the artifact for a key. */
  'AUTHORITY_SIGNING_KEY_UNKNOWN',
  /** The envelope names an algorithm outside the closed supported registry. Never a reason to try another one. */
  'AUTHORITY_SIGNATURE_ALGORITHM_UNSUPPORTED',
  /** The envelope names an artifact version this runtime does not implement. Unknown authority formats are refused, never reinterpreted under the current one. */
  'AUTHORITY_ARTIFACT_VERSION_UNSUPPORTED',
  /** The envelope's algorithm disagrees with the algorithm the trusted registry records for that key id. A key is trusted *for one algorithm*, never for whichever one an artifact asks for. */
  'AUTHORITY_SIGNATURE_KEY_ALGORITHM_MISMATCH',
] as const;

export type AuthoritySignatureFailure = (typeof AUTHORITY_SIGNATURE_FAILURES)[number];

/**
 * A misconfigured authenticity boundary: a duplicate key id, a key whose
 * material does not match the algorithm it is registered under, an active
 * signing key absent from the verification registry.
 *
 * Thrown at composition, never at read time, and never recoverable by falling
 * back to an unsigned path — a deployment that cannot build a key boundary
 * does not get a durable authority store.
 */
export class AuthorityAuthenticityConfigurationError extends Error {
  /** CORE-02: when an external signer's identity handshake refused the deployment, which closed reason. */
  readonly reason: AuthoritySigningFailureReason | undefined;

  constructor(message: string, reason?: AuthoritySigningFailureReason) {
    super(message);
    this.name = 'AuthorityAuthenticityConfigurationError';
    this.reason = reason;
  }
}

/**
 * The signer could not produce a signature.
 *
 * Its own type because of what it must *not* become. An issuance that cannot be
 * signed is an issuance that does not happen, and a revocation that cannot be
 * signed is a revocation that is **not** recorded and must not be acknowledged
 * — see `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §19.2, which states
 * the availability cost of that rule rather than paying it with an unsigned
 * fallback.
 */
export class AuthoritySigningUnavailableError extends Error {
  /**
   * Why, when the signer can say (CORE-02). A closed, repository-owned code —
   * never a provider exception, status text or response body. Absent for a
   * signer that does not classify its failures (the in-process one).
   */
  readonly reason: AuthoritySigningFailureReason | undefined;

  constructor(message: string, reason?: AuthoritySigningFailureReason) {
    super(message);
    this.name = 'AuthoritySigningUnavailableError';
    this.reason = reason;
  }
}

/**
 * CORE-02: why an **external** authority signer did not produce a signature
 * this deployment will persist. Vendor-neutral and closed, so a provider's own
 * vocabulary (a KMS error class, an HTTP status, an SDK exception) never leaks
 * into the authority domain — the adapter at the edge maps onto these.
 *
 * Two families, kept apart because an operator answers them differently:
 * *availability* (`TIMEOUT`, `UNREACHABLE`, `UNAVAILABLE`) — the signer may
 * answer later, a bounded retry is permitted — and *integrity/configuration*
 * (everything else) — the signer answered and what it said is not acceptable;
 * retrying cannot help and is never attempted.
 */
export const AUTHORITY_SIGNING_FAILURE_REASONS = [
  /** No answer within the per-attempt budget. The remote may or may not have signed; nothing it signed was persisted, so it confers nothing. */
  'EXTERNAL_SIGNER_TIMEOUT',
  /** The transport could not reach the signer (connection refused, reset, DNS). */
  'EXTERNAL_SIGNER_UNREACHABLE',
  /** The signer said it cannot sign now (5xx, rate-limited / throttled). */
  'EXTERNAL_SIGNER_UNAVAILABLE',
  /** The signer refused this deployment's credential. Never retried, never reported as a key or signature problem. */
  'EXTERNAL_SIGNER_AUTHENTICATION_FAILED',
  /** The signer understood the request and refused it (4xx other than authentication). */
  'EXTERNAL_SIGNER_REFUSED',
  /** The signer answered under a key id, algorithm or public key other than the one this deployment pinned. */
  'EXTERNAL_SIGNER_IDENTITY_MISMATCH',
  /** The answer was not the protocol's shape: not JSON, missing or extra fields, malformed signature encoding or width. */
  'EXTERNAL_SIGNER_MALFORMED_RESPONSE',
  /** The signer does not offer the protocol version, artifact version or one of the five authority operations this deployment requires. */
  'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED',
  /** A well-formed signature that does not verify, under the pinned trusted key, over the exact artifact that was sent. */
  'EXTERNAL_SIGNER_SIGNATURE_INVALID',
] as const;

export type AuthoritySigningFailureReason = (typeof AUTHORITY_SIGNING_FAILURE_REASONS)[number];

/** The availability family: the only reasons a bounded retry may be attempted for. */
export function isRetryableAuthoritySigningFailure(reason: AuthoritySigningFailureReason): boolean {
  return reason === 'EXTERNAL_SIGNER_TIMEOUT' || reason === 'EXTERNAL_SIGNER_UNREACHABLE' || reason === 'EXTERNAL_SIGNER_UNAVAILABLE';
}
