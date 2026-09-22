import type { ExerciseControlObserver } from '../../features/exercise-control-runtime/index.js';
import type { ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';

/**
 * The **write-only** boundary through which lifecycle modules report facts they
 * have already established — and the only part of the canonical authority event
 * stream an authority-bearing module may name (as a type, never a value).
 *
 * ## Why every method returns `Promise<void>`
 *
 * There is nothing to read back. A recorder cannot answer "yes", "no",
 * "already seen", "healthy" or "retry", so no caller can branch on it: the
 * shape itself makes "consult the evidence before acting" inexpressible. Every
 * call site additionally awaits it inside its own `try`/`catch` and discards
 * failure, so a recorder that throws, rejects or is absent changes no decision,
 * no grant, no reservation, no routing and no outcome.
 *
 * ## Called after, never before
 *
 * Each method is called only once the fact it reports is established in its
 * authoritative home: the decision committed **and re-verified**; the grant
 * returned by the store's issuance; the revocation returned by the store; the
 * write-ahead claim appended; the outcome returned by the execution runtime; a
 * reservation or its terminal event returned by the ledger. There is no
 * "about to" method.
 *
 * `reservationObserved` is the exercise-control gate's observer port, satisfied
 * structurally, so the gate stays unaware that this layer exists.
 */
export interface AuthorityEventRecorder extends ExerciseControlObserver {
  /** A committed, re-read and digest-verified Governance Record — any status. */
  decisionCommitted(record: GovernanceRecord): Promise<void>;
  /** A grant the bounded-grant store returned from issuance (`issued` or `already-issued`). */
  grantIssued(grant: BoundedGrant): Promise<void>;
  /** A revocation the bounded-grant store returned (`revoked` or `already-revoked`). */
  grantRevoked(revocation: GrantRevocation): Promise<void>;
  /** An exercise assessment of this grant reported `GRANT_EXERCISE_EXPIRED`. An observation of a clock-derived condition — no grant state changed. */
  grantExpiryObserved(grant: BoundedGrant): Promise<void>;
  /** The durable write-ahead claim for this execution identity was appended by this call. */
  executionClaimed(fact: { readonly evaluationId: string; readonly executionId: string; readonly grant: BoundedGrant; readonly claimedAt: string }): Promise<void>;
  /** The execution runtime returned this outcome for this execution identity. `outcomeRecorded` says whether the Governance Store outcome reference was written. */
  executionOutcomeObserved(fact: { readonly evaluationId: string; readonly executionId: string; readonly grant: BoundedGrant; readonly outcome: ExecutionOutcome; readonly outcomeRecorded: boolean }): Promise<void>;
}
