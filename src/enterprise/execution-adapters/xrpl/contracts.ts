/**
 * The XRPL Execution Adapter's **public contract** (ANDREW-P0-06): its trusted
 * configuration, the canonical Payment instruction it produces, and the narrow
 * transport port a later integration implements.
 *
 * ```
 * ValidatedExecutionAction  +  this configuration (operator-pinned)
 *   -> one canonical XRPL Payment instruction           (pure translation, no I/O)
 *   -> XrplPaymentTransport.submitPayment(...)          (at most once per execute)
 * ```
 *
 * ## What the adapter owns, and what it does not
 *
 * The adapter owns **rail translation**: which destination namespace it serves,
 * whether the grant-bound counterparty is a usable XRPL classic address, which
 * XRPL amount an authorized Frontera asset maps to, and how a transport
 * observation becomes an `ExecutionAdapterResult`.
 *
 * It does not own the sending account, signing, fees, sequence numbers,
 * `LastLedgerSequence`, network selection or ledger validation. Those are
 * live-ledger and key-custody concerns that belong behind the transport port
 * (ANDREW-P0-07 / P0-08). So the instruction carries no `Account`, and the
 * configuration has no endpoint, seed or secret field — a key this contract
 * does not declare is refused at construction. Its one network-related option
 * (`network`, P0-07) is a label the transport must match, never a selector.
 *
 * See `docs/demo/andrew/ANDREW-P0-06-XRPL-ADAPTER.md`.
 */

/** The canonical XRPL rail namespace for destination identity (ANDREW-P0-01 `ExecutionDestination.namespace`). */
export const XRPL_DESTINATION_NAMESPACE = 'xrpl';

/**
 * How one Frontera asset is represented on XRPL. Stated explicitly by the
 * operator, per asset; there is no default, no inference from the asset id and
 * no conversion between representations.
 *
 * - `issued`: a token issued on XRPL — `{ currency, issuer, value }` in the
 *   Payment. `currency` is a standard three-character XRPL currency code; the
 *   issuer is a classic address. The Frontera asset's own code must equal
 *   `currency`, so `EUR` can never be configured to send issued `USD`.
 * - `native`: XRP, sent as a string of drops. Only an asset whose code is
 *   `XRP` may map to it, so `USD` can never be configured to send XRP.
 * - `pinned` (ANDREW-P0-07): an **operator-pinned rail representation** — the
 *   governed asset is settled on this rail as one specific issued token, with
 *   the identical decimal value. Governed `USD` represented as RLUSD is the
 *   case it exists for. It is a statement about *which token carries the
 *   governed unit here*, never a rate: there is no factor, no oracle and no
 *   arithmetic, and the grant, ceilings and policy stay in the governed unit.
 *   Accepted only when `denominates` restates the mapping's asset id exactly,
 *   that asset id is a bare governed unit (no rail namespace, no issuer), and
 *   `currency` is a 160-bit token code — a standard three-character code must
 *   use `issued`, where it has to equal the asset, so this kind can never turn
 *   `EUR` into issued `USD`.
 */
export type XrplAssetRepresentation =
  | { readonly kind: 'issued'; readonly currency: string; readonly issuer: string }
  | { readonly kind: 'native' }
  | { readonly kind: 'pinned'; readonly denominates: string; readonly currency: string; readonly issuer: string };

/** One explicit mapping: the Frontera asset id (P9 `MonetaryAmount.unit`, exactly) and its XRPL representation. */
export interface XrplAssetMapping {
  readonly assetId: string;
  readonly representation: XrplAssetRepresentation;
}

export interface XrplExecutionAdapterOptions {
  /** The identity the registry routes by, emergency control scopes to, and the execution record names. Must be recordable. */
  readonly adapterId: string;
  /**
   * The one destination namespace this adapter serves, compared exactly.
   * Defaults to `xrpl`. A deployment that keeps a test network in its own
   * namespace (ANDREW-P0-01 §namespace strategy) states it here; the value
   * must be `xrpl` or `xrpl.<label>`. It selects nothing about the network —
   * that is the transport's configuration.
   */
  readonly namespace?: string;
  /**
   * ANDREW-P0-07: the operator's label for the one ledger network this
   * adapter's payments belong to (lowercase, e.g. a deployment's own name for
   * a test network). It selects nothing here — the adapter has no endpoint —
   * but it travels on every submission so the transport can refuse to submit
   * on any other network: a transport connected elsewhere fails closed instead
   * of settling. Absent, submissions carry no network and a transport that
   * requires one must refuse them.
   */
  readonly network?: string;
  /** Every Frontera asset this adapter may move, each with its explicit XRPL representation. At least one. */
  readonly assets: readonly XrplAssetMapping[];
}

/** An XRPL issued-currency amount, as the Payment `Amount` field states it. `value` is canonical decimal text. */
export interface XrplIssuedCurrencyAmount {
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
}

/**
 * The business intent of one XRPL Payment, in XRPL's own field names, and
 * nothing else.
 *
 * `Amount` is a drops string for XRP or an issued-currency object. There is
 * deliberately no `Account`, `Fee`, `Sequence`, `LastLedgerSequence`, `Flags`,
 * `SendMax`, `Paths`, `DestinationTag` or `Memos`: the sending account belongs
 * to the signer, the ledger fields to live ledger state, and the absence of
 * `SendMax`, `Paths` and the partial-payment flag is what makes this an
 * exact-amount, same-currency payment.
 */
export interface XrplPaymentInstruction {
  readonly TransactionType: 'Payment';
  readonly Destination: string;
  readonly Amount: string | XrplIssuedCurrencyAmount;
}

/**
 * What the adapter hands its transport: the instruction, and the authorization
 * correlation the transport needs to stay idempotent and inside the grant's
 * horizon. Fresh and frozen per call.
 */
export interface XrplPaymentSubmission {
  readonly instruction: XrplPaymentInstruction;
  /** This exercise attempt's identity — the existing execution idempotency handle. One attempt is one submission. */
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  /** The covering grant's expiry. A transport must not let a transaction become valid after it. */
  readonly notAfter: string;
  /** ANDREW-P0-07: the configured network label, present exactly when the adapter was configured with one. The transport must submit only on that network. */
  readonly network?: string;
}

/**
 * ANDREW-P0-07 — what a transport may report *in addition to* an outcome, as
 * evidence for the execution record and the demo. Defined now so P0-08's
 * transport has one shape to fill; the adapter does not yet read these, and
 * none of them can turn an outcome into another one.
 *
 * - `ledgerIndex`: the validated ledger the transaction was included in, as
 *   decimal text.
 * - `engineResult`: the transaction result code from that ledger (for example
 *   `tesSUCCESS`, or a `tec…` code in a validated ledger).
 * - `deliveredAmount`: the amount the ledger reports as delivered, in the same
 *   form as the instruction's `Amount`.
 */
export interface XrplLedgerEvidence {
  readonly ledgerIndex?: string;
  readonly engineResult?: string;
  readonly deliveredAmount?: string | XrplIssuedCurrencyAmount;
}

/**
 * What a transport observed. Mirrors the three-outcome rule of
 * `ExecutionAdapterResult`: only `not-submitted` and `rejected` are definitive
 * failures, and only `validated` is a completion.
 *
 * `transactionHash` is surfaced only when the transport actually supplied one;
 * the adapter never computes, invents or reformats it.
 */
export type XrplSubmissionObservation =
  /** Proven not to have reached the network: nothing was submitted. */
  | { readonly kind: 'not-submitted' }
  /** The network definitively refused the transaction; it cannot apply. */
  | ({ readonly kind: 'rejected'; readonly transactionHash?: string } & XrplLedgerEvidence)
  /** It may have been applied, and whether it was is not known. */
  | { readonly kind: 'unconfirmed'; readonly transactionHash?: string }
  /** Applied successfully in a validated ledger. */
  | ({ readonly kind: 'validated'; readonly transactionHash?: string } & XrplLedgerEvidence);

/**
 * The network boundary. P0-06 ships **no implementation**: tests inject a fake,
 * and a later task supplies the real client together with the signer,
 * network selection, fee, sequence and validation handling. The adapter calls
 * `submitPayment` at most once per `execute`, never retries, and treats a throw
 * as `unconfirmed`.
 */
export interface XrplPaymentTransport {
  submitPayment(submission: XrplPaymentSubmission): Promise<XrplSubmissionObservation>;
}

export type XrplConfigurationErrorCode =
  | 'XRPL_OPTIONS_INVALID'
  | 'XRPL_ADAPTER_ID_INVALID'
  | 'XRPL_NAMESPACE_INVALID'
  | 'XRPL_NETWORK_INVALID'
  | 'XRPL_ASSET_MAPPING_INVALID'
  | 'XRPL_ISSUER_INVALID'
  | 'XRPL_CURRENCY_INVALID'
  | 'XRPL_TRANSPORT_INVALID';

/**
 * A composition defect: thrown at construction, before any traffic. Messages
 * name the defect and never echo a configured value.
 */
export class XrplConfigurationError extends Error {
  constructor(
    readonly code: XrplConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XrplConfigurationError';
  }
}

export function isXrplConfigurationError(error: unknown): error is XrplConfigurationError {
  return error instanceof XrplConfigurationError;
}
