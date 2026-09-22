import type { ExerciseControlObserver } from '../../features/exercise-control-runtime/index.js';
import type { ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';

/**
 * The **write-only, non-blocking** boundary through which lifecycle modules
 * report facts they have already established — and the only part of the
 * canonical authority event stream an authority-bearing module may name (as a
 * type, never a value).
 *
 * ## Why every method returns `void`
 *
 * Reporting a fact **enqueues** it and returns. Nothing here represents durable
 * projection: there is no promise to await, no completion to observe and no
 * answer to branch on, so "wait for the evidence before continuing" and
 * "consult the evidence before acting" are both inexpressible.
 *
 * That is stronger than the earlier `Promise<void>`-with-a-`catch` shape, which
 * was wrong: a rejected projection was caught, but a projection that simply
 * **never settled** would have held the authority path — a decision that never
 * issued a grant, a durable execution claim whose adapter was never invoked, a
 * reservation that consumed capacity while `admit()` never returned, a
 * revocation that never reported back. A pending promise disproves "we await it
 * but catch errors, therefore it cannot affect the path". So the promise is
 * gone: the projector owns ordering and durability **after** the caller has
 * moved on (`projector.ts`).
 *
 * A method must therefore never block, never do I/O and never throw into its
 * caller; each one builds a bounded fact synchronously and hands it to the
 * projector's per-stream queue. Call sites still wrap the call, so even a
 * hostile implementation that throws synchronously changes nothing.
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
  decisionCommitted(record: GovernanceRecord): void;
  /** A grant the bounded-grant store returned from issuance (`issued` or `already-issued`). */
  grantIssued(grant: BoundedGrant): void;
  /** A revocation the bounded-grant store returned (`revoked` or `already-revoked`). */
  grantRevoked(revocation: GrantRevocation): void;
  /** An exercise assessment of this grant reported `GRANT_EXERCISE_EXPIRED`. An observation of a clock-derived condition — no grant state changed. */
  grantExpiryObserved(grant: BoundedGrant): void;
  /** The durable write-ahead claim for this execution identity was appended by this call. */
  executionClaimed(fact: { readonly evaluationId: string; readonly executionId: string; readonly grant: BoundedGrant; readonly claimedAt: string }): void;
  /** The execution runtime returned this outcome for this execution identity. `outcomeRecorded` says whether the Governance Store outcome reference was written. */
  executionOutcomeObserved(fact: { readonly evaluationId: string; readonly executionId: string; readonly grant: BoundedGrant; readonly outcome: ExecutionOutcome; readonly outcomeRecorded: boolean }): void;
}
