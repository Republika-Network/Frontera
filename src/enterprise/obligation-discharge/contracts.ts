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

/** What the recorder hands a store to append: the report, its organization and its attribution. */
export interface ObligationDischargeContent extends ObligationDischargeRecordInput {
  readonly organizationId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** One stored row: its content, its position in the store's history, and the digest that position binds. */
export interface StoredObligationDischarge extends ObligationDischargeContent {
  /** 1-based position in the store's append-only history. */
  readonly sequence: number;
  /** `sha256:<hex>` over the row bound to its store and sequence (`obligationDischargeRowDigest`). */
  readonly digest: string;
}

export interface ObligationDischargeStore {
  /**
   * `durable-authenticated` — SQLite, every append advances a hash chain whose
   * head is signed by the deployment's authority key, and every read verifies
   * the signature and the whole chain. `ephemeral` — process memory only (no
   * database a writer could reach; lost on restart); refused by the secure
   * profile.
   */
  readonly kind: 'durable-authenticated' | 'ephemeral';
  /** Appends one report and advances the committed state. Nothing is written if the committed state cannot first be verified, or the new state cannot be signed. */
  append(content: ObligationDischargeContent): Promise<StoredObligationDischarge>;
  /**
   * The authoritative read: verifies the store's committed state — signature,
   * chain over every row, organization, store identity — and only then returns
   * the rows for one decision correlation, in append order. Throws when
   * anything fails; nothing read from an unverifiable store is believed.
   */
  read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]>;
  close(): Promise<void>;
}

/** v2: the authenticated format (signed chain head). v1 — an unauthenticated format that existed only on the unshipped CORE-04 branch — is refused, never upgraded. */
export const OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION = 2;
