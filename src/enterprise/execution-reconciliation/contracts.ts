import type { ExecutionResolutionBinding, ExecutionResolutionRecord } from '../execution-resolution-store/contracts.js';

/**
 * P12 — the trusted, in-process reconciliation surface and its closed results.
 *
 * Every domain condition is a **result**, never a throw: an operator asking
 * "reconcile execution X" always learns exactly what happened, including when
 * nothing could.
 */

export interface ExecutionReconciliationRequest {
  readonly organizationId: string;
  readonly executionId: string;
}

export interface ExecutionResolutionAdoptionRequest {
  readonly organizationId: string;
  readonly executionId: string;
  readonly authorityId: string;
}

/**
 * What happened to P7 capacity once a definitive resolution stood.
 *
 * - `adjusted` — the P7 resolution row is recorded (now, or already by an
 *   earlier call). For `confirmed-not-completed` the reservation no longer
 *   consumes in any bucket; for `confirmed-completed` it stays consumed.
 * - `no-reservation` — this execution holds no P7 reservation (no exercise
 *   controls, or the crash came before admission). Nothing to adjust, and the
 *   resolution stands.
 * - `not-composed` — the deployment's P7 ledger offers no reconciliation
 *   capability. Capacity stays as it is: conservatively consumed.
 * - `pending` — the ledger could not be reached. The resolution stands and the
 *   capacity stays conservatively consumed; the next explicit reconcile
 *   applies it without asking the authority again.
 * - `conflict` — the ledger already holds a different resolution row.
 * - `inconsistent` — the ledger's own terminal history contradicts the
 *   resolution (for example, capacity was released for an effect now resolved
 *   completed). Reported, never repaired.
 */
export type ExecutionReconciliationCapacity = 'adjusted' | 'no-reservation' | 'not-composed' | 'pending' | 'conflict' | 'inconsistent';

export type ExecutionReconciliationResult =
  /** A definitive resolution stands. `established: 'previously'` means it was already on record and the authority was **not** asked again. */
  | {
      readonly outcome: 'resolved';
      readonly established: 'now' | 'previously';
      readonly resolution: ExecutionResolutionRecord;
      readonly capacity: ExecutionReconciliationCapacity;
    }
  /** The authority could not say. Nothing was written; the execution stays uncertain and its capacity consumed. A later explicit call may ask again. */
  | { readonly outcome: 'unresolved' }
  /**
   * Nothing to reconcile, and the authority was not asked:
   * `no-attempt` (no P11 attempt — including every pre-P11 execution),
   * `not-claimed` (prepared but never claimed: still retryable under P11, never a provider uncertainty),
   * `initial-observation-definitive` (P11 already holds confirmed-completed or confirmed-not-completed),
   * `withheld` (never crossed the provider boundary).
   */
  | { readonly outcome: 'not-eligible'; readonly reason: 'no-attempt' | 'not-claimed' | 'initial-observation-definitive' | 'withheld' }
  /**
   * No trusted answer could be obtained: `unbound` (no durable binding — adopt one first),
   * `not-composed` (the bound authority is not composed in this deployment — never substituted),
   * `failed` (the authority threw or rejected), `invalid-answer` (its answer was outside the closed contract).
   */
  | { readonly outcome: 'authority-unavailable'; readonly reason: 'unbound' | 'not-composed' | 'failed' | 'invalid-answer' }
  /**
   * The durable basis cannot be trusted, and the authority was not asked:
   * P11 unreadable or corrupt (never repaired), the claim unverifiable, P12
   * state unreadable or corrupt, or a binding / resolution that does not match
   * the attempt and observation it names.
   */
  | {
      readonly outcome: 'basis-unavailable';
      readonly reason: 'outcome-unreadable' | 'outcome-corrupt' | 'claim-unverifiable' | 'resolution-unreadable' | 'resolution-corrupt' | 'binding-inconsistent' | 'resolution-inconsistent';
    }
  /** The authority answered definitively, and the answer could not be made durable. No capacity moved and no replay changed; nothing is retried. */
  | { readonly outcome: 'resolution-unrecorded' }
  /** A different definitive resolution was recorded first. The first stands; no second P7 transition happens. */
  | { readonly outcome: 'conflict' };

export type ExecutionResolutionAdoptionResult =
  | { readonly outcome: 'bound' | 'existing'; readonly binding: ExecutionResolutionBinding }
  /** The named authority is not one this deployment composed. Nothing was written. */
  | { readonly outcome: 'authority-not-composed' }
  | { readonly outcome: 'not-eligible'; readonly reason: 'no-attempt' | 'not-claimed' | 'initial-observation-definitive' | 'withheld' }
  | { readonly outcome: 'basis-unavailable'; readonly reason: Extract<ExecutionReconciliationResult, { readonly outcome: 'basis-unavailable' }>['reason'] }
  /** A different authority is already bound. Bindings are never replaced. */
  | { readonly outcome: 'conflict' };

/**
 * The trusted in-process reconciliation service — `AocEnterprise.executionReconciliation`.
 *
 * Not a customer surface: no HTTP route, no SDK method and no governed-action
 * path reaches it. Ordinary customer replay reads durable state only and never
 * calls it.
 */
export interface ExecutionReconciliationService {
  /**
   * One explicit reconciliation of one execution: at most **one** query to its
   * bound authority, and none at all when a definitive resolution is already on
   * record. Never an execution, a resubmission or a retry of the original
   * effect. No polling, no timer, no background job.
   */
  reconcile(request: ExecutionReconciliationRequest): Promise<ExecutionReconciliationResult>;
  /**
   * For an execution that predates P12 and is still unresolved: bind it to one
   * composed authority. Binds; never declares an outcome — that authority must
   * still answer through `reconcile`.
   */
  adoptResolutionAuthority(request: ExecutionResolutionAdoptionRequest): Promise<ExecutionResolutionAdoptionResult>;
}
