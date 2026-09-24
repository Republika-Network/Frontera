import type { ExecutionFailureReason } from '../../features/execution-runtime/index.js';

/**
 * P12 — execution reconciliation and resolution authority: the record shapes.
 *
 * ## What this store holds
 *
 * For every governed execution identity whose outcome may later need a
 * trusted answer, at most two immutable facts:
 *
 * ```
 * ExecutionResolutionBinding   WHICH trusted resolution authority may later
 *                              resolve this execution — bound to the exact P11
 *                              attempt by digest, durable BEFORE the write-ahead
 *                              claim (or, for a pre-P12 execution, adopted by a
 *                              trusted operator)
 *
 * ExecutionResolutionRecord    WHAT that authority later established:
 *                              confirmed-completed, or confirmed-not-completed
 *                              with a provider-neutral failure reason — bound to
 *                              the attempt, the binding and, when there was one,
 *                              the P11 initial observation it resolved
 * ```
 *
 * Neither is ever updated or deleted.
 *
 * ## What it is not
 *
 * - **Not the initial observation.** P11 records what Frontera initially
 *   observed and keeps it forever. A resolution is a new, later fact; it never
 *   rewrites P11.
 * - **Not authority.** A resolution answers "what happened?", never "was it
 *   authorized?". Nothing that allows, issues, reserves or routes reads it.
 * - **Not settlement.** `confirmed-completed` says the provider effect
 *   completed — not that funds settled, that a ledger reached finality, that a
 *   receipt was verified or an obligation discharged (P15).
 * - **Not money.** No amount, asset, grant or budget: every one of them is the
 *   P11 attempt's, inherited by digest, and cannot be restated here.
 * - **Not authenticity.** Unkeyed SHA-256 over `aoc.canonical-json.v1`; P20
 *   owns signatures, KMS/HSM and non-repudiation.
 */

/** Frozen identifier for this record format. A file written under any other version is refused unopened. */
export const EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION = 'aoc.execution-resolution-store.schema.v1';

/** Tenant scope. No `system` escape: every call is confined to one organization. */
export interface ExecutionResolutionAccessContext {
  readonly organizationId: string;
}

/**
 * How a binding came to exist.
 *
 * - `pre-claim` — written by the governed-action path after P11 prepared the
 *   attempt and before the write-ahead claim, from the host's trusted selector.
 * - `adopted` — written later by a trusted in-process operator for an
 *   execution that predates P12 and is still unresolved. Adoption binds an
 *   authority; it never declares an outcome.
 */
export type ExecutionResolutionBindingOrigin = 'pre-claim' | 'adopted';

export interface BindExecutionResolutionAuthorityInput {
  readonly organizationId: string;
  readonly executionId: string;
  /** The P11 attempt this binding belongs to. Its amount, asset and correlation are inherited, never restated. */
  readonly attemptDigest: string;
  readonly authorityId: string;
  readonly origin: ExecutionResolutionBindingOrigin;
  /** The host-injected clock at the binding step. */
  readonly boundAt: string;
}

export interface ExecutionResolutionBinding extends BindExecutionResolutionAuthorityInput {
  readonly schemaVersion: string;
  /** The store's own clock, sampled inside the write's critical section. */
  readonly recordedAt: string;
  readonly bindingDigest: string;
}

/** The two definitive answers. There is no third: "unresolved" is the absence of a record. */
export type ExecutionResolutionCertainty = 'confirmed-completed' | 'confirmed-not-completed';

export interface RecordExecutionResolutionInput {
  readonly organizationId: string;
  readonly executionId: string;
  readonly attemptDigest: string;
  /** The binding this resolution was obtained under. It must be the one on record. */
  readonly bindingDigest: string;
  /** The P11 initial observation (`unconfirmed`) this resolves. Absent when the claim exists and P11 recorded no observation. */
  readonly basisObservationDigest?: string;
  readonly authorityId: string;
  readonly certainty: ExecutionResolutionCertainty;
  /** Exactly when `certainty` is `confirmed-not-completed`: the existing provider-neutral reason, never a new one. */
  readonly failure?: ExecutionFailureReason;
  /** A handle the authority learned. Never proof, and never able to change certainty. */
  readonly providerRef?: string;
  /** The host-injected clock after the authority answered. */
  readonly resolvedAt: string;
}

export interface ExecutionResolutionRecord extends RecordExecutionResolutionInput {
  readonly schemaVersion: string;
  readonly recordedAt: string;
  readonly resolutionDigest: string;
}

/** Everything durably known about the resolution of one execution identity. */
export interface ExecutionResolutionState {
  readonly binding?: ExecutionResolutionBinding;
  readonly resolution?: ExecutionResolutionRecord;
}

/** `existing`: the same binding was already recorded; the first one is returned unchanged, never re-dated. */
export interface BindExecutionResolutionAuthorityResult {
  readonly outcome: 'bound' | 'existing';
  readonly binding: ExecutionResolutionBinding;
}

/** `existing`: an identical definitive resolution was already recorded — a racing reconciliation that learned the same answer. */
export interface RecordExecutionResolutionResult {
  readonly outcome: 'recorded' | 'existing';
  readonly resolution: ExecutionResolutionRecord;
}

export interface ExecutionResolutionStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}
