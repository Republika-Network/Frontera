/**
 * The two capabilities the XRPL / RLUSD rail is composed with (PAY-02): a
 * ledger client and a transaction signer. Both are trusted host composition;
 * neither is reachable from a payment request.
 */

/** The only transaction this rail constructs: an XRPL `Payment` of an issued currency. No other transaction type exists here. */
export interface XrplPaymentTransaction {
  readonly TransactionType: 'Payment';
  readonly Account: string;
  readonly Destination: string;
  readonly DestinationTag?: number;
  readonly Amount: { readonly currency: string; readonly issuer: string; readonly value: string };
  /** Always 0: never `tfPartialPayment`, never any other flag. */
  readonly Flags: 0;
  /** Set by the rail from the current validated ledger and its trusted offset — never by a caller. */
  readonly LastLedgerSequence: number;
}

/** The payment after trusted preparation: the account sequence and network fee the client autofilled, checked by the rail. */
export interface XrplPreparedPayment extends XrplPaymentTransaction {
  readonly Sequence: number;
  readonly Fee: string;
}

/**
 * The ledger client — the smallest surface the rail needs, so the SDK stays
 * behind one file (`xrpl-sdk-client.ts`) and every rail rule can be qualified
 * against a deterministic double with no network.
 *
 * Every method answers the server's **raw** result object as `unknown`; the
 * rail reads it through `xrpl-result-normalizer.ts` and treats anything it
 * cannot read conservatively.
 *
 * Only `submit` writes. Everything else is a read, and a read may be repeated;
 * `submit` may not (`XrplSubmissionNotAttemptedError`).
 */
export interface XrplClientPort {
  /** Opens the connection if it is not open. Never submits anything. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** The raw `server_info` result (`{ info: { network_id, … } }`). */
  serverInfo(): Promise<unknown>;
  /**
   * The index of the most recent validated ledger. `timeoutMs`, when given,
   * bounds this one request below the client's own request timeout: the
   * rail passes what is left of its finality budget, so no read outlives it.
   */
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  /** Fills `Sequence` and `Fee` from the ledger. Must not change any field the rail set. */
  autofill(transaction: XrplPaymentTransaction): Promise<unknown>;
  /**
   * Submits one signed transaction blob, **once**. No retry, no resubmission,
   * no reconnect-and-resend. Throws `XrplSubmissionNotAttemptedError` only
   * when it can prove the blob was never written to the connection; every
   * other failure is thrown as-is and treated as possibly submitted.
   */
  submit(signedTransaction: string): Promise<unknown>;
  /**
   * Looks a transaction up by hash in `[minLedger, maxLedger]`. Answers the
   * raw `tx` result, or — for a server error answer such as `txnNotFound` —
   * the raw error object `{ error, searched_all? }`. Throws for a transport
   * failure or when `timeoutMs` (bounding this one request, as for
   * `validatedLedgerIndex`) elapses.
   */
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
}

/** Thrown by a client's `submit` only when the blob provably never left the process (for example, no open connection). */
export class XrplSubmissionNotAttemptedError extends Error {
  readonly code: 'XRPL_SUBMISSION_NOT_ATTEMPTED';

  constructor() {
    super('The XRPL submission was not attempted: no connection was open.');
    this.name = 'XrplSubmissionNotAttemptedError';
    this.code = 'XRPL_SUBMISSION_NOT_ATTEMPTED';
  }
}

/**
 * The signing boundary.
 *
 * Domain-aware, in the manner of the CORE-02 external authority signer: it
 * signs exactly the prepared XRPL Payment the rail hands it, for the one
 * account it holds, and nothing else — no raw bytes, no key export. The rail
 * never sees key material; it verifies that what came back is a signature of
 * exactly the transaction it prepared (`xrpl-codec.ts`) before submitting.
 *
 * PAY-02 ships **no** production signer. A host composes one backed by its
 * own custody (an HSM, an external signing service). The software signer used
 * for testnet qualification lives under `tests/` and is never a production
 * source.
 */
export interface XrplTransactionSigner {
  /** The classic address this signer signs for. Must equal the source account mapping it is composed for. */
  readonly address: string;
  sign(transaction: XrplPreparedPayment): Promise<{ readonly signedTransaction: string; readonly hash: string }>;
}
