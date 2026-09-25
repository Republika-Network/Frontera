import type {
  BoundedGrant,
  BoundedGrantStorePort,
  GrantRevocation,
  IssueBoundedGrantInput,
  IssueBoundedGrantOutcome,
  ReadBoundedGrantResult,
  RevokeBoundedGrantInput,
  RevokeBoundedGrantOutcome,
} from '../domain/index.js';
import { GRANT_REASON_CODES, isGrantRevocationReason } from '../domain/index.js';

/** The durable store's schema version. v3 (CORE-01) adds the signed revocation-state commitment and binds every signed record to its store. */
export const BOUNDED_GRANT_STORE_SCHEMA_VERSION = 'aoc.bounded-grant-store.schema.v3';

/**
 * The authoritative grant store for the vertical slice.
 *
 * Structured exactly as `createInMemoryAccessGrantStore` and
 * `createInMemoryAuthorityStore` already are: **every mutating method is one
 * synchronous critical section**, with no `await` between the read that decides
 * an outcome and the map mutation that records it, so no interleaving is
 * possible even under concurrent in-process callers. That is not an
 * approximation of a transaction for this layer's purposes — it is the same
 * guarantee, in the same shape the repository already relies on, and it is what
 * lets `commitGuard` be honoured rather than merely called.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 and hard invariant 6 are
 * what this exists to satisfy: the checks that decide issuance run *here*,
 * against the records read *here*, at the instant the write happens.
 *
 * In memory, so nothing survives a restart. `grant-store-port.ts` states what a
 * durable adapter must guarantee instead; `createSqliteAccessGrantStore` is the
 * shape one would follow, and building one is deliberately out of scope for
 * this phase.
 */
export function createInMemoryBoundedGrantStore(): BoundedGrantStorePort {
  const grants = new Map<string, BoundedGrant>();
  const revocations = new Map<string, GrantRevocation>();

  return {
    async issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome> {
      // ---- critical section begins. No `await` below this line. ----
      const existing = grants.get(input.grant.id);
      if (existing !== undefined) {
        // Grant identity is deterministic, so a re-delivered issuance of the
        // same grant over the same authority lands here rather than creating a
        // second artifact that would read as a second grant. The existing one
        // is returned exactly as it stands — never overwritten, never re-dated.
        return { outcome: 'already-issued', grant: existing };
      }

      // A revocation recorded against this identity before issuance precludes
      // it. The identity is derived from the correlation and the bounds, so
      // this is the case where the same grant was issued, revoked, and is now
      // being re-derived from a stale eligibility assumption.
      if (revocations.has(input.grant.id)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }

      // The commit-boundary re-check, inside the section, against the world as
      // it is now. This is where a decision that has since been superseded, an
      // obligation that has since become unsatisfied, or a preclusion that has
      // since appeared stops an issuance that was eligible when it was
      // evaluated.
      const precondition = input.commitGuard();
      if (!precondition.permitted) {
        return {
          outcome: 'refused',
          reasonCodes: precondition.reasonCodes.length > 0 ? precondition.reasonCodes : [GRANT_REASON_CODES.GRANT_ELIGIBILITY_CHANGED],
        };
      }

      grants.set(input.grant.id, input.grant);
      // ---- critical section ends. ----
      return { outcome: 'issued', grant: input.grant };
    },

    async read(grantId: string): Promise<ReadBoundedGrantResult> {
      const grant = grants.get(grantId);
      const revocation = revocations.get(grantId);
      return {
        ...(grant !== undefined ? { grant } : {}),
        ...(revocation !== undefined ? { revocation } : {}),
      };
    },

    async revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome> {
      // ---- critical section begins. No `await` below this line. ----
      if (!isGrantRevocationReason(input.reason)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }
      if (!grants.has(input.grantId)) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] };
      }

      const existing = revocations.get(input.grantId);
      if (existing !== undefined) {
        // Idempotent, and the *first* revocation stands. A second call never
        // re-dates the revocation or rewrites its reason: the moment a grant
        // stopped being exercisable is a fact, and a later call is not new
        // information about it. Mirrors `AccessGrantStore.beginRevocation`'s
        // `already-revoked` outcome exactly.
        return { outcome: 'already-revoked', revocation: existing };
      }

      const revocation: GrantRevocation = {
        grantId: input.grantId,
        revokedAt: input.revokedAt,
        reason: input.reason,
        issuerRef: input.issuerRef,
      };
      revocations.set(input.grantId, revocation);
      // ---- critical section ends. ----
      return { outcome: 'revoked', revocation };
    },
  };
}
