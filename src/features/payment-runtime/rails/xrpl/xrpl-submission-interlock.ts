/**
 * The durable submission interlock port (PAY-03) — what the rail asks before
 * and after its one submission, so that knowledge needed to keep a second
 * payment from competing with an earlier, still-live XRPL transaction
 * survives a process restart and is shared by every process on one state.
 *
 * It is a **safety interlock**, not a transaction database. Its one question:
 *
 * > Is there an earlier submitted-but-unsettled payment from this source
 * > account whose sequence window can still affect a new one?
 *
 * ## The blocking rule (a pure function of ledger facts)
 *
 * An open record — `submitting` or `unconfirmed` — **blocks** a candidate
 * `Sequence` S on the same account exactly when
 *
 * ```
 * record.lastLedgerSequence > validatedLedgerIndex   (its window is still open)
 * and record.sequence >= S                            (the candidate could take, or precede, its sequence)
 * ```
 *
 * Both releases are ledger facts, never local beliefs:
 *
 * - once the validated ledger has reached `LastLedgerSequence`, the earlier
 *   transaction can never be included (the protocol forbids it), so its
 *   sequence is settled either way;
 * - once the earlier transaction is in a validated ledger (success **or**
 *   `tec`), the account's sequence has moved past it, so autofill answers a
 *   higher one and the rule no longer matches.
 *
 * So releasing never depends on a write anyone must remember to make, and a
 * P12 resolution and this interlock cannot diverge into an unsafe state:
 * `settle` is bookkeeping that can only move a record **toward** closed, and
 * its loss only keeps a record open until the ledger closes its window.
 *
 * ## Write order (see `docs/payments/XRPL_PRODUCTION_COMPOSITION.md` §6)
 *
 * ```
 * prepare → sign → verify → reserve (durable, atomic check-and-record) → submit ONCE → settle | markUnconfirmed
 * ```
 *
 * `reserve` commits before `submit` is called. A crash after it and before the
 * outcome leaves a `submitting` record, which blocks exactly like
 * `unconfirmed` until the ledger proves the window closed. A crash before it
 * means nothing was submitted.
 */

/** Everything recorded about the one transaction an execution signed, before it is submitted. All public ledger facts; no key, no blob. */
export interface XrplSubmissionRecordInput {
  readonly executionId: string;
  /** Source classic address. */
  readonly account: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  /** The first ledger the transaction could appear in: the validated index at preparation + 1. */
  readonly minLedger: number;
  readonly transactionHash: string;
  readonly amount: { readonly currency: string; readonly issuer: string; readonly value: string };
}

/** Why a record was closed. Every value is a ledger fact the rail or a read-only lookup observed. */
export const XRPL_INTERLOCK_SETTLEMENTS = ['validated-success', 'validated-failure', 'malformed', 'expired', 'not-submitted'] as const;
export type XrplInterlockSettlement = (typeof XRPL_INTERLOCK_SETTLEMENTS)[number];

export type XrplSubmissionReservation =
  /** Durable on return: the record exists and the one submission may begin. */
  | { readonly outcome: 'reserved' }
  /** An open record still blocks this sequence. Nothing was written. */
  | { readonly outcome: 'blocked' }
  /** This execution already has a record — a transaction was signed, and possibly submitted, for it. Nothing was written. */
  | { readonly outcome: 'execution-recorded'; readonly transactionHash: string };

export interface XrplSubmissionInterlock {
  /** The transaction hash already recorded for this execution, if any. Checked first: such an execution is never prepared, signed or submitted again. Throws when the state cannot be read. */
  recorded(executionId: string): Promise<string | undefined>;
  /** Non-binding pre-signing check under the blocking rule. Throws when the state cannot be read: the caller refuses. */
  blocking(query: { readonly account: string; readonly sequence: number; readonly validatedLedgerIndex: number }): Promise<boolean>;
  /** One atomic check-and-record under the blocking rule (and one record per execution, ever). Throws when it cannot: the caller refuses, nothing is submitted. */
  reserve(record: XrplSubmissionRecordInput, validatedLedgerIndex: number): Promise<XrplSubmissionReservation>;
  /** After the one submission: the outcome is unknown. The record stays open. */
  markUnconfirmed(executionId: string, transactionHash: string): Promise<void>;
  /** After a definitive ledger fact. Moves a record to `settled`; never reopens one. */
  settle(executionId: string, transactionHash: string, settlement: XrplInterlockSettlement): Promise<void>;
}

/**
 * Ledgers the rail waits after it first observes the validated ledger before it
 * prepares any payment, when composed with a durable interlock: the configured
 * `lastLedgerOffset` plus this margin (servers on one network may disagree on
 * the validated index by a ledger or two).
 *
 * This is the ledger acting as its own freshness witness. A transaction a
 * previous process submitted — even one whose interlock record was lost to a
 * rollback or a stale restore — had `LastLedgerSequence ≤` (that process's
 * validated index + offset) `≤` (this process's first validated index +
 * offset). Once the validated ledger passes that, no such transaction can
 * still be included, whatever the local state says.
 */
export const XRPL_RESTART_QUARANTINE_MARGIN = 4;
