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
 * The largest `LastLedgerSequence` offset any configuration this rail has
 * ever accepted could have used (`XRPL_RAIL_LIMITS.lastLedgerOffset.maximum`
 * since PAY-02). A historical bound: it may grow, it must **never** shrink —
 * a transaction an older process signed under it may still be live after a
 * restart (structurally tested against the configuration limit).
 */
export const XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET = 200;

/** Ledgers of margin past the historical window (servers on one network may disagree on the validated index by a ledger or two). */
export const XRPL_RESTART_QUARANTINE_MARGIN = 4;

/**
 * The restart quarantine's window, in validated ledgers. Independent of the
 * **current** `lastLedgerOffset`: lowering the offset can never shorten it
 * below the window of a transaction an earlier process signed.
 */
export const XRPL_RESTART_QUARANTINE_LEDGERS = XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET + XRPL_RESTART_QUARANTINE_MARGIN;

/**
 * How long after the rail started (its own clock) the ledger that opens the
 * quarantine must have closed (the network's consensus `close_time`). Covers
 * close-time rounding (at most half the largest close-time resolution, 120 s)
 * plus up to 120 s of disagreement between this host's clock and the
 * network's close time.
 */
export const XRPL_RESTART_ANCHOR_SLACK_SECONDS = 180;

/** Unix time of the Ripple epoch, 2000-01-01T00:00:00Z: ledger `close_time` counts seconds from it. */
export const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800;

/*
 * ## The restart quarantine (PAY-03; the ledger is its own freshness witness)
 *
 * With a durable interlock composed, the rail prepares a payment at validated
 * index `V` only when
 *
 * ```
 * (a) close_time(validated ledger V − XRPL_RESTART_QUARANTINE_LEDGERS) ≥ start + XRPL_RESTART_ANCHOR_SLACK_SECONDS
 * (b) V ≥ F + XRPL_RESTART_QUARANTINE_LEDGERS, F = the first validated index the rail observed
 * ```
 *
 * ((a) is one ledger read by index; once true for some ledger, every later `V`
 * past it by the window passes without another read. `F` is read by the
 * Host's boot readiness, or else by the first preparation.) Otherwise —
 * including when that ledger cannot be read, is not validated, or is
 * malformed — it refuses with nothing signed.
 *
 * Why this holds even when the interlock file was rolled back, restored from
 * an old backup, or the configuration changed:
 *
 * 1. A transaction any earlier process signed was prepared at that process's
 *    validated index `vP`, with `LastLedgerSequence = vP + oP` and
 *    `oP ≤ XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET` — whatever the offset was
 *    then, and whatever it is now.
 * 2. `vP ≤ N0`, the network's last validated ledger when this rail started:
 *    the earlier process ran before it, and no server reports a validated
 *    ledger the network has not validated.
 * 3. Ledger close times never decrease with the sequence, and `N0` closed
 *    before this rail started; so a validated ledger that closed after the
 *    start plus slack has a sequence above `N0` — **however far behind the
 *    server was when the rail started** (a lagging server's ledgers simply
 *    closed too early to pass the check).
 * 4. Hence `V − window > N0 ≥ vP`, i.e. `V > vP + oP + margin`: every earlier
 *    transaction's `LastLedgerSequence` has been validated, and it can never
 *    be included.
 *
 * Step 3 trusts this host's clock not to be behind the network's close time
 * by more than the slack allows. Rule (b) is an independent proof of the same
 * conclusion that trusts the server instead: `F` was observed after the start,
 * so if that server was current then, `F ≥ N0 ≥ vP` and `V ≥ F + window`
 * again gives `V > vP + oP + margin`. Both must hold, so the quarantine ends
 * early only if this host's clock is slow **and** the server it read `F` from
 * was lagging — never through either fault alone, and never through the
 * configuration.
 *
 * Assumptions: the configured XRPL server is trusted to report validated
 * ledgers (the rail's general trust in it) and keeps at least the window's
 * worth of recent history (every rippled does); and at least one of the two
 * independent witnesses above holds.
 *
 * Cost: XRPL payments are refused (`xrpl-restart-quarantine`) for roughly the
 * slack plus 204 ledgers (≈ 15–17 min) after each start.
 */
