import {
  isXrplLedgerHash,
  readXrplInclusion,
  readXrplLedgerIndex,
  readXrplNetworkId,
  xrplNonInclusionProven,
  xrplWindowClosed,
  type XrplInclusionReading,
} from '../../features/xrpl-transport/index.js';

/**
 * TRADE-04D — the trade vertical's **validated-ledger evidence contract** for
 * the one transaction a trade interlock row names. Read-only.
 *
 * It wraps, never replaces, the shared transport's qualified semantics:
 * `readXrplInclusion` decides what a `tx` answer says, and
 * `xrplNonInclusionProven` alone decides non-inclusion (a complete search,
 * read only after the validated index — read first — reached
 * `LastLedgerSequence`). On top it binds the answer to the row:
 *
 * | check | on mismatch |
 * | --- | --- |
 * | the server's network id, before **and** after the lookup | `network-mismatch` / `network-changed` |
 * | `hash` is the row's hash | `transaction-hash-mismatch` |
 * | `Account` (owner), `Delegate`, `TransactionType = OfferCreate`, `Sequence`, `LastLedgerSequence` | `wrong-account`, `wrong-delegate`, `wrong-transaction-type`, `sequence-mismatch`, `last-ledger-sequence-mismatch` |
 * | the including ledger lies in `[minLedger, LastLedgerSequence]` | `ledger-outside-window` |
 * | the including ledger is not past the validated index read after the lookup; that index did not regress | `ledger-index-disagreement` |
 * | a `ledger_hash`, when the server states one, is a ledger hash | `ledger-hash-malformed` |
 * | a validated result is `tesSUCCESS` or `tec…` (the only classes a validated ledger holds) | `result-unrecognized` |
 *
 * Every mismatch is **unresolved** — never a closure. Absence is never read
 * from an incomplete search, an `entryNotFound`, a timeout or elapsed time.
 *
 * What this cannot do: an XRPL server is trusted to report what it validated
 * (ADR-XRPL-SHARED-TRANSPORT). The binding detects inconsistent, misrouted or
 * mismatched answers; it does not turn a malicious server's fabrication into
 * a detectable one. Ledger proofs are not verified here.
 */

/** The only ledger capability the trade P12 reading holds: four reads. No submit, no signer, no reserved-submission client. */
export interface TradeLedgerReader {
  connect(): Promise<void>;
  serverInfo(): Promise<unknown>;
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
}

/** What a trade interlock row fixes about its one transaction: the identity a ledger answer must match exactly. */
export interface TradeTransactionIdentity {
  readonly transactionHash: string;
  /** The owner: the account whose `Sequence` the transaction consumes. */
  readonly account: string;
  readonly delegateAccount: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  readonly minLedger: number;
}

export const TRADE_INCLUSION_PROBLEMS = [
  'transaction-unreadable',
  'transaction-hash-mismatch',
  'transaction-body-missing',
  'wrong-account',
  'wrong-delegate',
  'wrong-transaction-type',
  'sequence-mismatch',
  'last-ledger-sequence-mismatch',
  'ledger-outside-window',
  'ledger-hash-malformed',
  'result-unrecognized',
] as const;
export type TradeInclusionProblem = (typeof TRADE_INCLUSION_PROBLEMS)[number];

/**
 * A `tx` answer read for one trade transaction. `reading` is the shared
 * transport's reading, demoted to `unreadable` when the answer does not bind
 * to the identity (`problem` says why) — so every existing caller that treats
 * `unreadable` as "not an outcome" stays conservative unchanged.
 */
export interface TradeInclusionReading {
  readonly reading: XrplInclusionReading;
  readonly problem?: TradeInclusionProblem;
  /** The including ledger's hash, when the server stated one (API v2). */
  readonly ledgerHash?: string;
  /** The validated transaction body and metadata, exactly as answered (frozen copies). Present only for a bound validated reading. */
  readonly transaction?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

function frozenCopy(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const deep = (item: unknown): unknown => {
    if (Array.isArray(item)) return Object.freeze(item.map(deep));
    const record = recordOf(item);
    if (record === undefined) return item;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) out[key] = deep(record[key]);
    return Object.freeze(out);
  };
  return deep(value) as Readonly<Record<string, unknown>>;
}

const UNREADABLE: XrplInclusionReading = Object.freeze({ kind: 'unreadable' });

function demoted(problem: TradeInclusionProblem): TradeInclusionReading {
  return Object.freeze({ reading: UNREADABLE, problem });
}

/**
 * Reads a raw `tx` answer for the trade transaction `identity` names. Pure and
 * total. API v2 carries the transaction fields in `tx_json`; API v1 at the top
 * level — the fields are read from exactly one of the two, never merged.
 */
export function readTradeInclusion(raw: unknown, identity: TradeTransactionIdentity): TradeInclusionReading {
  const reading = readXrplInclusion(raw, identity.transactionHash);
  const result = recordOf(raw);
  if (reading.kind === 'unreadable') {
    const echoed = result?.['hash'];
    return demoted(typeof echoed === 'string' && echoed !== identity.transactionHash ? 'transaction-hash-mismatch' : 'transaction-unreadable');
  }
  if (reading.kind !== 'validated') return Object.freeze({ reading });
  // Validated: bind the body to the row.
  const body = result!['tx_json'] !== undefined ? recordOf(result!['tx_json']) : result;
  if (body === undefined || body['Account'] === undefined || body['TransactionType'] === undefined || body['Sequence'] === undefined || body['LastLedgerSequence'] === undefined) return demoted('transaction-body-missing');
  if (body['TransactionType'] !== 'OfferCreate') return demoted('wrong-transaction-type');
  if (body['Account'] !== identity.account) return demoted('wrong-account');
  if (body['Delegate'] !== identity.delegateAccount) return demoted('wrong-delegate');
  if (body['Sequence'] !== identity.sequence) return demoted('sequence-mismatch');
  if (body['LastLedgerSequence'] !== identity.lastLedgerSequence) return demoted('last-ledger-sequence-mismatch');
  if (reading.ledgerIndex < identity.minLedger || reading.ledgerIndex > identity.lastLedgerSequence) return demoted('ledger-outside-window');
  if (reading.engineResult !== 'tesSUCCESS' && !reading.engineResult.startsWith('tec')) return demoted('result-unrecognized');
  const ledgerHash = result!['ledger_hash'];
  if (ledgerHash !== undefined && !isXrplLedgerHash(ledgerHash)) return demoted('ledger-hash-malformed');
  const meta = recordOf(result!['meta']);
  return Object.freeze({
    reading,
    ...(typeof ledgerHash === 'string' ? { ledgerHash } : {}),
    transaction: frozenCopy(body),
    ...(meta !== undefined ? { meta: frozenCopy(meta) } : {}),
  });
}

export const TRADE_LEDGER_EVIDENCE_REASONS = [
  'ledger-unavailable',
  'network-mismatch',
  'network-changed',
  'validated-index-unreadable',
  'read-timeout',
  'read-failed',
  'window-open',
  'history-incomplete',
  'transaction-not-validated',
  'ledger-index-disagreement',
  ...TRADE_INCLUSION_PROBLEMS,
] as const;
export type TradeLedgerEvidenceReason = (typeof TRADE_LEDGER_EVIDENCE_REASONS)[number];

/**
 * What validated evidence establishes about the one transaction — and
 * nothing more. `included` is a fact about the **transaction** (applied or
 * failed with its fee), never about an order's fill.
 */
export type TradeLedgerEvidence =
  | {
      readonly status: 'included';
      readonly networkId: number;
      readonly transactionHash: string;
      readonly engineResult: string;
      /** `tesSUCCESS`: the OfferCreate applied. `tec`: it failed in a validated ledger, its fee consumed (by the fee payer: the delegate, XLS-75). */
      readonly resultClass: 'tesSUCCESS' | 'tec';
      readonly ledgerIndex: number;
      readonly ledgerHash?: string;
      readonly validatedIndexBefore: number;
      readonly validatedIndexAfter: number;
      readonly transaction: Readonly<Record<string, unknown>>;
      readonly meta?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Proven: a complete search over `[minLedger, LastLedgerSequence]`, after the validated index reached `LastLedgerSequence`. */
      readonly status: 'not-included';
      readonly networkId: number;
      readonly transactionHash: string;
      readonly searchedFrom: number;
      readonly searchedTo: number;
      readonly validatedIndexBefore: number;
      readonly validatedIndexAfter: number;
    }
  | { readonly status: 'unresolved'; readonly reason: TradeLedgerEvidenceReason; readonly validatedIndexBefore?: number };

export interface ReadTradeLedgerEvidenceOptions {
  readonly networkId: number;
  readonly requestTimeoutMs: number;
}

function unresolved(reason: TradeLedgerEvidenceReason, validatedIndexBefore?: number): TradeLedgerEvidence {
  return Object.freeze({ status: 'unresolved', reason, ...(validatedIndexBefore !== undefined ? { validatedIndexBefore } : {}) });
}

function isTimeout(error: unknown): boolean {
  const record = recordOf(error);
  const name = record?.['name'];
  const code = record?.['code'];
  return (typeof name === 'string' && /timeout/i.test(name)) || (typeof code === 'string' && /timeout/i.test(code));
}

/**
 * Reads the validated evidence for one trade transaction: network identity,
 * the validated index **first**, the bounded `tx` lookup, then the validated
 * index and the network identity again. One pass; no retry, no wait.
 */
export async function readTradeLedgerEvidence(ledger: TradeLedgerReader, identity: TradeTransactionIdentity, options: ReadTradeLedgerEvidenceOptions): Promise<TradeLedgerEvidence> {
  const { networkId, requestTimeoutMs } = options;
  try {
    await ledger.connect();
    if (readXrplNetworkId(await ledger.serverInfo()) !== networkId) return unresolved('network-mismatch');
  } catch {
    return unresolved('ledger-unavailable');
  }
  let before: number | undefined;
  try {
    before = readXrplLedgerIndex(await ledger.validatedLedgerIndex(requestTimeoutMs));
  } catch {
    return unresolved('ledger-unavailable');
  }
  if (before === undefined) return unresolved('validated-index-unreadable');
  let raw: unknown;
  try {
    raw = await ledger.lookupTransaction({ hash: identity.transactionHash, minLedger: identity.minLedger, maxLedger: identity.lastLedgerSequence }, requestTimeoutMs);
  } catch (error) {
    return unresolved(isTimeout(error) ? 'read-timeout' : 'read-failed', before);
  }
  let after: number | undefined;
  try {
    after = readXrplLedgerIndex(await ledger.validatedLedgerIndex(requestTimeoutMs));
    if (readXrplNetworkId(await ledger.serverInfo()) !== networkId) return unresolved('network-changed', before);
  } catch {
    return unresolved('ledger-unavailable', before);
  }
  if (after === undefined) return unresolved('validated-index-unreadable', before);
  if (after < before) return unresolved('ledger-index-disagreement', before);

  const bound = readTradeInclusion(raw, identity);
  const { reading } = bound;
  if (bound.problem !== undefined) return unresolved(bound.problem, before);
  if (reading.kind === 'validated') {
    if (reading.ledgerIndex > after) return unresolved('ledger-index-disagreement', before);
    return Object.freeze({
      status: 'included',
      networkId,
      transactionHash: identity.transactionHash,
      engineResult: reading.engineResult,
      resultClass: reading.engineResult === 'tesSUCCESS' ? 'tesSUCCESS' : 'tec',
      ledgerIndex: reading.ledgerIndex,
      ...(bound.ledgerHash !== undefined ? { ledgerHash: bound.ledgerHash } : {}),
      validatedIndexBefore: before,
      validatedIndexAfter: after,
      transaction: bound.transaction!,
      ...(bound.meta !== undefined ? { meta: bound.meta } : {}),
    });
  }
  if (xrplNonInclusionProven(reading, before, identity.lastLedgerSequence)) {
    return Object.freeze({
      status: 'not-included',
      networkId,
      transactionHash: identity.transactionHash,
      searchedFrom: identity.minLedger,
      searchedTo: identity.lastLedgerSequence,
      validatedIndexBefore: before,
      validatedIndexAfter: after,
    });
  }
  // Not proven. Before the window closed, nothing is final; after it, say exactly what is missing.
  if (!xrplWindowClosed(before, identity.lastLedgerSequence)) return unresolved('window-open', before);
  const result = recordOf(raw);
  if (result?.['error'] === 'txnNotFound') return unresolved('history-incomplete', before);
  return unresolved('transaction-not-validated', before);
}
