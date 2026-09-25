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
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityAuthenticityConfigurationError';
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
  constructor(message: string) {
    super(message);
    this.name = 'AuthoritySigningUnavailableError';
  }
}
