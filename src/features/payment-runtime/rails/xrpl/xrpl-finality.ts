import { canonicalDecimalOfLedgerValue } from './xrpl-amount.js';
import { readLookup, type XrplExpectedPayment } from './xrpl-result-normalizer.js';

/**
 * XRPL settlement finality (PAY-05) — pure, total and conservative.
 *
 * ## Why validated inclusion is funds finality on the XRPL
 *
 * A transaction in a **validated** ledger is final: validated ledgers are the
 * output of the network's consensus and are immutable — there is no fork, no
 * reorganization and no later ledger that can remove or change it. An issued
 * currency `Payment` with `meta.TransactionResult` `tesSUCCESS` there has moved
 * exactly `meta.delivered_amount` from `Account` to `Destination`, irreversibly.
 * Nothing short of that is final: a submit answer is provisional, an
 * unvalidated `tx` answer can still change, and elapsed time proves nothing.
 *
 * ## What is proven, beyond what P12 reads
 *
 * P12's `readLookup` (PAY-03) establishes the *execution*: the transaction with
 * this hash is validated with `tesSUCCESS` and delivered exactly the amount, in
 * the currency and from the issuer configured. This reader reuses it, unchanged,
 * for that half and adds what settlement of **this governed payment** needs —
 * the transaction's own fields, read from the ledger, not from Frontera's
 * records:
 *
 * - `TransactionType` is `Payment`;
 * - `Account` is exactly the source account the trusted mapping names;
 * - `Destination` is exactly the governed destination, and `DestinationTag` is
 *   exactly its tag — or absent exactly when the destination is untagged;
 * - the instructed amount (`Amount`, and `DeliverMax` where the server reports
 *   it) is exactly the governed amount, currency and issuer;
 * - no `tfPartialPayment` (or any) flag;
 * - the ledger it was validated in, by index.
 *
 * A hash alone proves nothing here: it only locates the transaction whose
 * fields are then compared exactly. No fuzzy matching, and never "the same
 * amount, so the same payment".
 *
 * The reading is `final` (every check passed), `pending` (not provably final
 * yet: not found, not validated, an incomplete search), `contradicted` (the
 * ledger proves the governed transfer is **not** final as governed — a
 * validated failure, a field that differs), or `unreadable`.
 */

export interface XrplExpectedSettlement extends XrplExpectedPayment {
  /** The source account's classic address, from the trusted source mapping. */
  readonly account: string;
  readonly destination: string;
  /** Present exactly when the governed destination is tagged. */
  readonly destinationTag?: number;
}

export type XrplFinalityReading =
  | { readonly kind: 'final'; readonly ledgerIndex: number; readonly ledgerHash?: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'contradicted'; readonly reason: XrplFinalityContradiction }
  | { readonly kind: 'unreadable' };

/** Why a validated transaction contradicts the governed payment. Closed. */
export const XRPL_FINALITY_CONTRADICTIONS = Object.freeze({
  validatedFailure: 'xrpl.validated-failure',
  deliveredMismatch: 'xrpl.delivered-mismatch',
  unrecognizedResult: 'xrpl.result-unrecognized',
  fieldMismatch: 'xrpl.transaction-mismatch',
} as const);

export type XrplFinalityContradiction = (typeof XRPL_FINALITY_CONTRADICTIONS)[keyof typeof XRPL_FINALITY_CONTRADICTIONS];

const LEDGER_HASH = /^[0-9A-F]{64}$/;

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

function amountMatches(raw: unknown, expected: XrplExpectedSettlement): boolean {
  const amount = recordOf(raw);
  if (amount === undefined || Object.keys(amount).length !== 3) return false;
  return amount['currency'] === expected.currency && amount['issuer'] === expected.issuer && canonicalDecimalOfLedgerValue(amount['value']) === expected.value;
}

/**
 * Reads a raw `tx` answer as a settlement proof. API v2 answers carry the
 * transaction under `tx_json` (and the instructed amount as `DeliverMax`); API
 * v1 answers carry it at the top level. Both are read; neither is guessed.
 */
export function readXrplPaymentFinality(raw: unknown, expected: XrplExpectedSettlement): XrplFinalityReading {
  const lookup = readLookup(raw, expected);
  switch (lookup.kind) {
    case 'pending':
    case 'not-found-complete':
      return { kind: 'pending' };
    case 'unreadable':
      return { kind: 'unreadable' };
    case 'validated-failure':
      return { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.validatedFailure };
    case 'validated-delivered-mismatch':
      return { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.deliveredMismatch };
    case 'validated-unrecognized':
      return { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.unrecognizedResult };
    case 'validated-success':
      break;
  }
  const result = recordOf(raw);
  if (result === undefined) return { kind: 'unreadable' };
  const ledgerIndex = result['ledger_index'];
  if (typeof ledgerIndex !== 'number' || !Number.isSafeInteger(ledgerIndex) || ledgerIndex <= 0) return { kind: 'unreadable' };
  const ledgerHash = result['ledger_hash'];
  if (ledgerHash !== undefined && (typeof ledgerHash !== 'string' || !LEDGER_HASH.test(ledgerHash))) return { kind: 'unreadable' };

  const nested = result['tx_json'];
  const transaction = nested === undefined ? result : recordOf(nested);
  if (transaction === undefined) return { kind: 'unreadable' };
  const instructed = [transaction['Amount'], transaction['DeliverMax']].filter((value) => value !== undefined);
  const flags = transaction['Flags'];
  const tag = transaction['DestinationTag'];
  const fieldsMatch =
    transaction['TransactionType'] === 'Payment' &&
    transaction['Account'] === expected.account &&
    transaction['Destination'] === expected.destination &&
    (expected.destinationTag === undefined ? tag === undefined : tag === expected.destinationTag) &&
    instructed.length > 0 &&
    instructed.every((amount) => amountMatches(amount, expected)) &&
    (flags === undefined || flags === 0);
  if (!fieldsMatch) return { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.fieldMismatch };
  return { kind: 'final', ledgerIndex, ...(typeof ledgerHash === 'string' ? { ledgerHash } : {}) };
}
