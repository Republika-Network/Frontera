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
  | 'BOUNDED_GRANT_STORE_STATE_CORRUPT';

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
