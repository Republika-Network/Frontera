/**
 * ANDREW-P0-08 — the contracts of the real XRPL Testnet transport.
 *
 * The submission and observation shapes below are **structurally identical**
 * to the XRPL execution adapter's `XrplPaymentSubmission` /
 * `XrplSubmissionObservation` (src/enterprise/execution-adapters/xrpl): this
 * package imports nothing from the runtime, and the runtime imports nothing
 * from it — a test in the runtime proves the transport satisfies the adapter's
 * `XrplPaymentTransport` port. The composition that wires them is the only
 * place both are named.
 */

export interface XrplIssuedAmount {
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
}

/** What the adapter hands the transport: business intent and authorization correlation, never an account, key or ledger field. */
export interface XrplPaymentSubmission {
  readonly instruction: { readonly TransactionType: 'Payment'; readonly Destination: string; readonly Amount: string | XrplIssuedAmount };
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly notAfter: string;
  readonly network?: string;
}

/** Ledger evidence reported with an outcome (P0-07 `XrplLedgerEvidence`). */
export interface XrplLedgerEvidence {
  readonly ledgerIndex?: string;
  readonly engineResult?: string;
  readonly deliveredAmount?: string | XrplIssuedAmount;
}

export type XrplSubmissionObservation =
  | { readonly kind: 'not-submitted' }
  | ({ readonly kind: 'rejected'; readonly transactionHash?: string } & XrplLedgerEvidence)
  | { readonly kind: 'unconfirmed'; readonly transactionHash?: string }
  | ({ readonly kind: 'validated'; readonly transactionHash?: string } & XrplLedgerEvidence);

/** The P0-07 settlement check, injected by the composition (`checkXrplSettlement` bound to the deployment's profile). */
export type XrplSettlementGate = (submission: XrplPaymentSubmission) => { readonly ok: true } | { readonly ok: false; readonly refusal: string };

/**
 * The signer boundary. The transport prepares the complete transaction; the
 * signer signs exactly that and returns only what execution needs. It never
 * returns key material, and an implementation backed by an environment
 * variable, a KMS, an HSM or a hardware device is interchangeable.
 */
export interface XrplTransactionSigner {
  /** The classic address whose key signs. Public. */
  readonly account: string;
  sign(prepared: Readonly<Record<string, unknown>>): Promise<XrplSignedTransaction>;
}

export interface XrplSignedTransaction {
  /** The signed transaction blob. Replay-sensitive: persisted before submit, never logged, never returned to a caller. */
  readonly txBlob: string;
  readonly hash: string;
}

/** What the transport needs from a ledger connection — narrow, so tests can supply every network behaviour. */
export interface XrplLedgerClient {
  serverInfo(): Promise<{ readonly networkId?: number; readonly validatedLedgerIndex?: number; readonly completeLedgers?: string }>;
  validatedLedgerIndex(): Promise<number>;
  autofill(transaction: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  submit(txBlob: string): Promise<{ readonly engineResult?: string }>;
  /** Look a transaction up; `range` asks the server whether it searched every ledger in it. */
  transaction(hash: string, range?: { readonly minLedger: number; readonly maxLedger: number }): Promise<XrplTransactionLookup>;
  disconnect(): Promise<void>;
}

export type XrplTransactionLookup =
  | { readonly found: false; readonly searchedAll: boolean }
  | {
      readonly found: true;
      readonly validated: boolean;
      readonly hash?: string;
      readonly ledgerIndex?: number;
      /** ISO-8601 close time of the including ledger, when the server reports it. */
      readonly closeTimeIso?: string;
      readonly transaction: Readonly<Record<string, unknown>>;
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/** A structured, non-secret transport event. Never carries a seed, a signed blob or a prepared transaction. */
export interface XrplTransportEvent {
  readonly event: string;
  readonly executionId?: string;
  readonly transactionHash?: string;
  readonly detail?: string;
}

export class XrplTransportConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XrplTransportConfigurationError';
  }
}
