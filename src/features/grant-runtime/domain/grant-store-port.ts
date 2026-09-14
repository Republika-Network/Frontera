import type { BoundedGrant } from './bounded-grant.js';
import type { GrantReasonCode } from './grant-reason-codes.js';
import type { GrantRevocation, GrantRevocationReason } from './grant-revocation.js';

/**
 * The authoritative home of issued grants, and the commit boundary issuance
 * happens inside.
 *
 * ## Why this is a port with a guard rather than a map with a setter
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 requires every issuance
 * check to happen "inside the store's own transaction, against the records read
 * there — the same commit-boundary discipline
 * `ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §3 established for
 * `acquireReservation`, so no check is performed against a world that has since
 * moved." Hard invariant 6 restates it.
 *
 * That is a statement about *where* a check runs, so it has to be expressible
 * in the port's shape rather than in a comment. `issue` therefore takes a
 * **synchronous** `commitGuard`, which the store calls inside its critical
 * section, after the records it decides on have been read there. A guard that
 * were `async` would reintroduce exactly the interleaving the discipline
 * exists to prevent, so the type forbids it.
 *
 * The TOCTOU this closes, concretely:
 *
 * ```
 * 1. evaluate      decision = permits, obligations satisfied
 * 2. ...           the approval is withdrawn, or a revocation is recorded
 * 3. issue         a grant minted from the stale assumption at step 1
 * ```
 *
 * With the guard, step 3 re-asks step 1's question against the world as it is
 * at commit, and refuses with `GRANT_ELIGIBILITY_CHANGED` when the answer has
 * changed.
 *
 * ## What a production adapter must guarantee
 *
 * The in-memory implementation in `services/` proves the vertical slice; a
 * durable adapter (SQLite, Postgres) must provide, and the repository's
 * existing `createSqliteAccessGrantStore` is the shape to follow:
 *
 * 1. **Atomic issuance.** The guard, the duplicate check, the preclusion check
 *    and the write commit together or not at all. In SQLite that is one
 *    `db.transaction(...)`; in memory it is one synchronous section with no
 *    `await` inside it.
 * 2. **Idempotency on grant identity.** Grant ids are deterministic, so a
 *    re-delivered issuance must resolve to the existing grant rather than
 *    create a second row that would read as a second grant.
 * 3. **Deterministic lookup.** `read` returns exactly the grant named, or
 *    nothing. Returning a near match is worse than returning nothing.
 * 4. **Revocation visibility.** A revocation committed before a read is visible
 *    to that read. A revocation is never lost to a cache.
 * 5. **Expiry evaluated from the passed-in instant**, never from the database's
 *    own clock, so a replay and a live read agree.
 * 6. **Concurrency safety.** Two concurrent issuances of the same identity
 *    produce one grant and one `GRANT_ALREADY_ISSUED`, never two grants.
 * 7. **Correlation integrity.** The stored correlation is the one issuance
 *    computed; the store never rewrites, defaults or normalizes it.
 *
 * A store that cannot honour these must fail by **throwing** rather than by
 * returning a permissive result — the layer above turns a throw into "no
 * grant", which is the closed direction.
 */

/** What the guard reports, evaluated inside the store's critical section against the records read there. */
export interface GrantCommitPrecondition {
  readonly permitted: boolean;
  /** Why not. Empty when permitted. */
  readonly reasonCodes: readonly GrantReasonCode[];
}

export interface IssueBoundedGrantInput {
  readonly grant: BoundedGrant;
  /**
   * Re-asks, at the commit boundary, whether this grant may still be issued.
   *
   * Synchronous on purpose: a store must be able to call it with no `await`
   * between the read that decides and the write that records, which is the only
   * way the check and the commit see the same world.
   */
  readonly commitGuard: () => GrantCommitPrecondition;
}

export type IssueBoundedGrantOutcome =
  | { readonly outcome: 'issued'; readonly grant: BoundedGrant }
  /** The identity already stands. The existing grant is returned unchanged — never overwritten, never re-dated. */
  | { readonly outcome: 'already-issued'; readonly grant: BoundedGrant }
  | { readonly outcome: 'refused'; readonly reasonCodes: readonly GrantReasonCode[] };

export interface ReadBoundedGrantResult {
  readonly grant?: BoundedGrant;
  readonly revocation?: GrantRevocation;
}

export interface RevokeBoundedGrantInput {
  readonly grantId: string;
  readonly reason: GrantRevocationReason;
  readonly revokedAt: string;
  readonly issuerRef: string;
}

export type RevokeBoundedGrantOutcome =
  | { readonly outcome: 'revoked'; readonly revocation: GrantRevocation }
  /** Idempotent: a second revocation of the same grant returns the first one unchanged, exactly as `AccessGrantStore.beginRevocation` already does. */
  | { readonly outcome: 'already-revoked'; readonly revocation: GrantRevocation }
  | { readonly outcome: 'refused'; readonly reasonCodes: readonly GrantReasonCode[] };

/**
 * The authoritative read, and nothing else.
 *
 * The exercise path needs exactly one capability from the store: resolve a
 * grant id to the current grant and the current revocation state. It has never
 * needed `issue` or `revoke`, and
 * `execution-runtime/tests/execution-layer-boundaries.test.ts` already fails
 * the build if either appears there. This interface makes that a *type* rule
 * rather than only a textual one: a service that depends on this cannot call a
 * mutation it was never handed.
 *
 * `BoundedGrantStorePort` extends it, so every existing caller that injects the
 * full port satisfies this unchanged — the narrowing is on the consuming side,
 * where the capability is used, not on the producing side, where it is built.
 */
export interface BoundedGrantReaderPort {
  /**
   * The current authoritative state for one grant id.
   *
   * A durable implementation verifies integrity here, before returning: an
   * authoritative read whose record fails validation must **throw** rather than
   * return a usable grant, and must never repair, skip or normalize the record
   * into a usable one. The layer above turns a throw into "no grant", which is
   * the closed direction.
   */
  read(grantId: string): Promise<ReadBoundedGrantResult>;
}

export interface BoundedGrantStorePort extends BoundedGrantReaderPort {
  issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome>;
  revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome>;
}
