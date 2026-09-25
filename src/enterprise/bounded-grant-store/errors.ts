/**
 * The durable bounded-grant store's error taxonomy.
 *
 * Deliberately **not** `ExecutionGovernanceError`. Every code in that taxonomy
 * is a wiring defect — a host composed something that cannot work — and its
 * own doc comment says so. These are runtime conditions of the authoritative
 * store: it cannot be opened, it has been closed, or the authority state it
 * holds failed validation. Folding them into a wiring vocabulary would make
 * "this deployment is misconfigured" and "this grant's persisted state is not
 * trustworthy" indistinguishable to an operator, and they call for opposite
 * responses.
 *
 * ## Why these are thrown rather than returned
 *
 * `grant-store-port.ts` states it as the port's contract: "A store that cannot
 * honour these must fail by **throwing** rather than by returning a permissive
 * result — the layer above turns a throw into 'no grant', which is the closed
 * direction." A store that returned `{}` from a failed authoritative read would
 * be reporting "this grant does not exist" when the truth is "this grant's
 * state could not be validated", and on the revocation side those two answers
 * differ by exactly the authority a revocation was meant to remove.
 *
 * ## What the messages may say
 *
 * The grant id, the condition, and nothing else. No SQL, no file path, no
 * driver text, no row contents: a caller that can read the store's internals
 * from an error message has been handed a map of the authoritative state.
 */
export type BoundedGrantStoreErrorCode =
  /** The authoritative store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. Never a reason to fall back to another source of grants. */
  | 'BOUNDED_GRANT_STORE_UNAVAILABLE'
  /** Persisted authority state failed integrity validation, or the grant and revocation records disagree. The store refuses to answer rather than answering from state it cannot validate. */
  | 'BOUNDED_GRANT_STORE_STATE_CORRUPT'
  /**
   * Persisted authority state carries no signature this deployment trusts:
   * missing, malformed, invalid, under an unknown key, or under an unsupported
   * algorithm or artifact version.
   *
   * Separate from `STATE_CORRUPT` because the two call for opposite responses.
   * Corruption says the bytes moved and the fix is to restore them. This says
   * the bytes may be exactly what somebody meant to write, and that somebody
   * could not produce a signature over them — so the fix is to find out who
   * wrote them, or to discover that a key was rotated out of the trusted set
   * while records signed by it were still live. Reporting a forgery attempt as a
   * disk fault would send an operator looking in the wrong place.
   *
   * Like every other code here, this is thrown, never returned, and the layer
   * above turns it into "no grant" — the closed direction.
   */
  | 'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED'
  /**
   * The store's revocation state cannot be proven complete (CORE-01): the
   * signed revocation-state commitment is absent, the revocation records
   * actually present disagree with it, their sequence has a gap or a duplicate,
   * or the commitment is older than one this process has already verified.
   *
   * Its own code because it is neither of the above. No single record need be
   * corrupt or unsigned for this to fire — the canonical case is a genuine
   * revocation that has been *deleted*, leaving every remaining record
   * perfectly valid. What it tells an operator is that the store can no longer
   * answer "was this grant revoked?", and so it answers nothing. Recovery is a
   * restore from a trusted copy; the store never repairs or re-signs the state
   * it found, because re-signing it would launder the deletion into authority.
   */
  | 'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT';

export class BoundedGrantStoreError extends Error {
  constructor(
    readonly code: BoundedGrantStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BoundedGrantStoreError';
  }
}

export function isBoundedGrantStoreError(error: unknown): error is BoundedGrantStoreError {
  return error instanceof BoundedGrantStoreError;
}
