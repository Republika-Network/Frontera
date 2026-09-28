import type { ObligationDischargeOutcome } from '../../features/obligation-runtime/index.js';

/**
 * CORE-04 — the authoritative, durable record of what was reported about the
 * obligations governed decisions stand under.
 *
 * ## What this store is, and what it is not
 *
 * It is the **discharge provider's backing store**: an append-only log of
 * observations — "configured source S reported outcome O for obligation K of
 * decision correlation C, at T, on reference R" — each attributed to the
 * trusted writer that recorded it. It is **not** the obligation state. State is
 * never stored and never written: it is derived, every time it is read, by the
 * obligation runtime's closed transition table from these observations and the
 * *registry's* classification of each source (`independent` vs
 * `self_reported`). So nothing written here can mark an obligation satisfied:
 * a `discharged` report from a self-reported source leaves it `discharged`
 * (unsatisfied), exactly as the lifecycle says, whoever wrote the row.
 *
 * ## Why append-only
 *
 * A discharge is an event about the world. Rewriting one would rewrite the
 * history a withheld or released execution is explained by. Rows are never
 * updated or deleted (the SQLite store enforces this with triggers), and every
 * row carries a digest over its content that is verified on every read — a row
 * that fails it makes the whole read fail, and a failed read leaves every
 * blocking obligation unsatisfied (fail closed).
 */

/** The decision correlation an obligation is bound to — the obligation runtime's own `ObligationCorrelation`. */
export interface ObligationDischargeCorrelation {
  readonly requestId: string;
  readonly action: string;
  readonly resourceScope: string;
}

/**
 * The trusted writer. Constructible only by in-process trusted code — the same
 * posture as the Kernel-Authority system context and CORE-03's
 * `PolicyPackWriterContext` (NB-008): there is no HTTP route to this, and a
 * caller of the governed-action API has no way to produce one.
 */
export interface ObligationDischargeWriterContext {
  readonly system: true;
  /** Who is recording this report — an operator or service identity. Recorded on the row, digested, never interpreted. */
  readonly actorId: string;
}

/** What a trusted writer submits. */
export interface ObligationDischargeRecordInput {
  readonly correlation: ObligationDischargeCorrelation;
  readonly obligationType: string;
  /** Must name a configured discharge source. What the report is worth is that source's configured verification class, never anything in this input. */
  readonly sourceId: string;
  readonly outcome: ObligationDischargeOutcome;
  /** When the source observed it. Never in the future. */
  readonly observedAt: string;
  /** An opaque reference into the source (an approval id, a ticket). Recorded, never interpreted. */
  readonly reference?: string;
  /** Who, at the source, acted — an approver id. Recorded, never interpreted. */
  readonly subjectId?: string;
}

/** One stored row: the input, the organization, the attribution and the integrity digest. */
export interface StoredObligationDischarge extends ObligationDischargeRecordInput {
  readonly organizationId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** `sha256:<hex>` over the canonical row content (every field above). Verified on every read. */
  readonly digest: string;
}

export interface ObligationDischargeStore {
  /** `durable` survives a restart; `ephemeral` does not. */
  readonly kind: 'durable' | 'ephemeral';
  append(row: StoredObligationDischarge): Promise<void>;
  /** Every verified row for one organization and one decision correlation, in append order. Throws when any row fails verification. */
  read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]>;
  close(): Promise<void>;
}

export const OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION = 1;
