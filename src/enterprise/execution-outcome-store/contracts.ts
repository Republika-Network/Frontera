import type { ExecutionFailureReason } from '../../features/execution-runtime/index.js';

/**
 * P11 — durable monetary outcomes and provider certainty: the record shapes.
 *
 * ## What this store holds
 *
 * For every governed execution identity, two immutable facts:
 *
 * ```
 * ExecutionAttemptRecord      the exact execution context PREPARED before the
 *                             write-ahead claim and the provider crossing:
 *                             which tenant, which authorization (by reference),
 *                             which action, which exact amount and asset
 *
 * ExecutionTerminalRecord     the INITIAL observation of what that attempt did:
 *                             the provider's certainty (confirmed-completed,
 *                             confirmed-not-completed, unconfirmed) with its
 *                             attribution and opaque reference — or the layer
 *                             that withheld it before any provider was reached
 * ```
 *
 * Neither is ever updated or deleted. A later process that learns more (P12
 * reconciliation) records a **new** fact elsewhere; it never rewrites the
 * initial observation, because the original uncertainty genuinely existed.
 *
 * ## Prepared is not attempted
 *
 * An attempt record says only "this is the exact context prepared for
 * execution X". It is written **before** the Governance Store's write-ahead
 * claim, so it may exist for an execution that never became load-bearing (a
 * crash between the two, or a claim that failed). The claim remains the one
 * durable fact that an attempt crossed into the adapter path, and the one
 * at-most-once guard.
 *
 * ## What it is not
 *
 * - **Not authority.** Nothing that allows, denies, issues, reserves or routes
 *   reads this store; a past success is never permission for a new action.
 * - **Not settlement, a receipt or proof of payment.** Provider certainty says
 *   what the execution provider confirmed about its own effect, nothing more.
 * - **Not P8.** The canonical authority event stream may mirror these facts as
 *   evidence; it is never their only copy, and never read back.
 * - **Not P7.** Aggregate consumption stays in the exercise-control ledger.
 * - **Not authenticity.** Unkeyed SHA-256 over `aoc.canonical-json.v1`:
 *   tamper *detection* under the store's digest model, not a signature, not
 *   non-repudiation, not an external anchor (P20 owns KMS/HSM authenticity).
 */

/** Frozen identifier for this record format. A file written under any other version is refused unopened. */
export const EXECUTION_OUTCOME_STORE_SCHEMA_VERSION = 'aoc.execution-outcome-store.schema.v1';

/** Tenant scope. There is deliberately no `system` escape: every call is confined to one organization. */
export interface ExecutionOutcomeAccessContext {
  readonly organizationId: string;
}

/** P9 canonical money: exact decimal text and a canonical asset identifier. Never a JavaScript number. */
export interface ExecutionAttemptAmount {
  readonly value: string;
  readonly unit: string;
}

/**
 * The exact execution context, as prepared by the governed-action path from
 * trusted, already-committed values. The authorization it runs under is named
 * by identifier only — the decision, the evaluation, the grant — and never
 * embedded: those records have their own authoritative owners.
 */
export interface PrepareExecutionAttemptInput {
  readonly organizationId: string;
  readonly executionId: string;
  readonly evaluationId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly boundedGrantId: string;
  readonly action: string;
  /** Present exactly when the action carries a quantity — the amount the adapter receives, verbatim. */
  readonly amount?: ExecutionAttemptAmount;
  /** The host-injected clock at the preparation step. */
  readonly preparedAt: string;
}

export interface ExecutionAttemptRecord extends PrepareExecutionAttemptInput {
  readonly schemaVersion: string;
  /** The store's own clock, sampled inside the write's critical section. */
  readonly recordedAt: string;
  readonly attemptDigest: string;
}

/** Which layer withheld an effect at exercise time, before any provider was reached. */
export type ExecutionWithholdingLayer = 'grant-exercise' | 'emergency-control' | 'exercise-control';

/**
 * The initial observation of what an attempt did.
 *
 * Two kinds, kept apart on purpose:
 *
 * - `provider` — the adapter path ran and the provider boundary was (or may
 *   have been) crossed. It carries the provider's **certainty**, the trusted
 *   attribution the runtime established, and an opaque `providerRef` when one
 *   was legitimately observed. A reference never changes certainty.
 * - `withheld` — a layer stopped the effect after the claim and **before** any
 *   provider was reached. It carries that layer and its own reason codes, and
 *   no adapter, reference or certainty: no provider spoke.
 *
 * No `detail`: adapter diagnostic text is not a durable financial fact. No
 * amount and no correlation: both are inherited from the attempt this names.
 */
export type ExecutionTerminalObservation =
  | {
      readonly kind: 'provider';
      readonly certainty: 'confirmed-completed';
      readonly adapterId: string;
      readonly routedBy?: string;
      readonly providerRef?: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'provider';
      readonly certainty: 'confirmed-not-completed';
      readonly adapterId: string;
      readonly routedBy?: string;
      readonly providerRef?: string;
      readonly failure: ExecutionFailureReason;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'provider';
      readonly certainty: 'unconfirmed';
      readonly adapterId: string;
      readonly routedBy?: string;
      readonly providerRef?: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'withheld';
      readonly withheldBy: ExecutionWithholdingLayer;
      readonly reasonCodes: readonly string[];
      readonly observedAt: string;
    };

export interface RecordExecutionTerminalInput {
  readonly organizationId: string;
  readonly executionId: string;
  readonly observation: ExecutionTerminalObservation;
}

export interface ExecutionTerminalRecord {
  readonly schemaVersion: string;
  readonly organizationId: string;
  readonly executionId: string;
  /** The immutable attempt this observation belongs to. Its amount and correlation are inherited, never restated. */
  readonly attemptDigest: string;
  readonly observation: ExecutionTerminalObservation;
  readonly recordedAt: string;
  readonly observationDigest: string;
}

/** Everything durably known about one execution identity. `terminal` absent means no initial observation was recorded. */
export interface ExecutionOutcomeRecord {
  readonly attempt: ExecutionAttemptRecord;
  readonly terminal?: ExecutionTerminalRecord;
}

/** `existing`: the same canonical attempt was already prepared; the first one is returned unchanged, never re-dated. */
export interface PrepareExecutionAttemptResult {
  readonly outcome: 'prepared' | 'existing';
  readonly attempt: ExecutionAttemptRecord;
}

/** `existing`: the identical observation was already recorded; returned unchanged. */
export interface RecordExecutionTerminalResult {
  readonly outcome: 'recorded' | 'existing';
  readonly terminal: ExecutionTerminalRecord;
}

export interface ExecutionOutcomeStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}
