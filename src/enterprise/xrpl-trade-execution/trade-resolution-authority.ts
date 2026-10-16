import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';
import type { TradeIntentRecord, TradeIntentState, TradeInterlockSettlement, TradeSubmissionRecord } from './sqlite-trade-sequence-interlock.js';
import { readTradeLedgerEvidence, type TradeLedgerReader, type TradeTransactionIdentity } from './trade-ledger-evidence.js';
import { readTradeSequenceEvidence, type TradeSequenceEntryReader } from './trade-sequence-evidence.js';

export type { TradeLedgerReader } from './trade-ledger-evidence.js';

/** The P12 authority id under which governed trade executions are bound before their claim. */
export const TRADE_RESOLUTION_AUTHORITY_ID = 'frontera.xrpl-trade-ledger';

/** Builds a fresh object carrying exactly the four reads, so the resolver cannot reach a write even by accident. */
export function readOnlyTradeLedger(client: TradeLedgerReader): TradeLedgerReader {
  return Object.freeze({
    connect: () => client.connect(),
    serverInfo: () => client.serverInfo(),
    validatedLedgerIndex: (timeoutMs?: number) => client.validatedLedgerIndex(timeoutMs),
    lookupTransaction: (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number) => client.lookupTransaction(query, timeoutMs),
  });
}

export interface TradeResolutionInterlockAccess {
  read(executionId: string): Promise<TradeSubmissionRecord | undefined>;
  settle(executionId: string, transactionHash: string, settlement: TradeInterlockSettlement, detail?: string): Promise<void>;
  /** TRADE-04D D-1 (all three, or none): the intent of an execution no reservation continued. */
  readIntent?(executionId: string): Promise<TradeIntentRecord | undefined>;
  abandonIntent?(executionId: string, detail?: string): Promise<TradeIntentState>;
  expireIntent?(executionId: string, detail?: string): Promise<TradeIntentState>;
}

/** D-1: the validated `AccountRoot` read the owner-`Sequence` proof needs — the shared validated reader, built by the composition. Read-only. */
export type TradeResolutionEntryReader = TradeSequenceEntryReader;

export interface TradeResolutionAuthorityOptions {
  readonly networkId: number;
  readonly action: string;
  readonly requestTimeoutMs: number;
  readonly ledger: TradeLedgerReader;
  readonly interlock: TradeResolutionInterlockAccess;
  /** D-1: with it, a `signing` intent can be closed on the owner-`Sequence` proof; without it, it stays unresolved. */
  readonly entries?: TradeResolutionEntryReader;
}

const UNRESOLVED: ExecutionResolutionAuthorityResult = Object.freeze({ outcome: 'unresolved' });

/** The identity a ledger answer must match: exactly what the verified interlock row fixed. */
export function tradeTransactionIdentityOf(record: TradeSubmissionRecord): TradeTransactionIdentity {
  return Object.freeze({
    transactionHash: record.transactionHash,
    account: record.account,
    delegateAccount: record.evidence.delegateAccount,
    sequence: record.sequence,
    lastLedgerSequence: record.lastLedgerSequence,
    minLedger: record.minLedger,
  });
}

/**
 * TRADE-04C — the governed trade executor's P12 `ExecutionResolutionAuthority`:
 * read-only and conservative, inside the **existing** P12 flow.
 *
 * | ledger fact about the one transaction the interlock reserved | answer |
 * | --- | --- |
 * | validated `tesSUCCESS` | `confirmed-completed` — the OfferCreate **applied**; whether it rested, crossed or filled is TRADE-04D's reading |
 * | validated `tec…` | `confirmed-not-completed PROVIDER_REJECTED` |
 * | complete search finds nothing, validated index (read first) ≥ `LastLedgerSequence` | `confirmed-not-completed PROVIDER_REJECTED` (expired) |
 * | anything else — pending, partial history, wrong network, unreadable, no record, a record for another hash or action | `unresolved` |
 *
 * TRADE-04D: the ledger answer is read through the trade evidence contract
 * (`trade-ledger-evidence.ts`): the same qualified inclusion and
 * non-inclusion semantics, bound to the row — network before and after,
 * hash, owner, delegate, type, `Sequence`, `LastLedgerSequence`, a window
 * containing the including ledger, and validated-index ordering. Any
 * mismatch is `unresolved`.
 *
 * TRADE-04D D-1 — an execution with an **intent** and no reservation:
 *
 * | intent | answer |
 * | --- | --- |
 * | `intended` | abandoned by compare-and-set (it fails if the executor marked `signing` first) → `confirmed-not-completed PROVIDER_UNAVAILABLE`: the signer was provably never contacted |
 * | `abandoned` | `confirmed-not-completed PROVIDER_UNAVAILABLE` |
 * | `signing` / `expired` | the owner's validated `Sequence` unconsumed at or past `LastLedgerSequence` → `confirmed-not-completed PROVIDER_REJECTED` (expired); anything else → `unresolved` |
 *
 * Absence of a record is never evidence (a record is written before anything
 * can be sent). It never submits, re-signs or rebuilds anything: an
 * uncertain trade is resolved from the ledger or stays uncertain.
 */
export function createTradeResolutionAuthority(options: TradeResolutionAuthorityOptions): ExecutionResolutionAuthority {
  const { ledger, interlock, networkId, action, requestTimeoutMs } = options;
  for (const method of ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction'] as const) {
    if (typeof ledger?.[method] !== 'function') throw new TypeError(`The trade resolution authority's ledger must implement ${method}.`);
  }
  if (typeof interlock?.read !== 'function' || typeof interlock.settle !== 'function') throw new TypeError('The trade resolution authority needs the trade interlock.');
  const intents = typeof interlock.readIntent === 'function' && typeof interlock.abandonIntent === 'function' && typeof interlock.expireIntent === 'function';
  if (!intents && (interlock.readIntent !== undefined || interlock.abandonIntent !== undefined || interlock.expireIntent !== undefined)) throw new TypeError('The trade resolution authority takes the intent access whole, or not at all.');
  const reader = options.entries;
  if (reader !== undefined && typeof reader.ledgerEntry !== 'function') throw new TypeError('The trade resolution authority’s validated entry reader must implement ledgerEntry.');

  async function settleQuietly(record: TradeSubmissionRecord, settlement: TradeInterlockSettlement, detail: string): Promise<void> {
    try {
      await interlock.settle(record.executionId, record.transactionHash, settlement, detail);
    } catch {
      // Bookkeeping; the blocking rule already released on the ledger fact.
    }
  }

  /** D-1: an execution whose intent no reservation continued. Never a guess: abandoned by compare-and-set, or expired on the owner-Sequence proof. */
  async function resolveIntent(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult> {
    if (!intents) return UNRESOLVED;
    let intent: TradeIntentRecord | undefined;
    try {
      intent = await interlock.readIntent!(query.executionId);
    } catch {
      return UNRESOLVED;
    }
    if (intent === undefined || intent.executionId !== query.executionId || intent.state === 'bound') return UNRESOLVED;
    // No hash was ever recorded for it: a reference names something this execution never reserved.
    if (query.providerRef !== undefined) return UNRESOLVED;
    if (intent.evidence.boundedGrantId !== query.boundedGrantId || intent.evidence.decisionId !== query.decisionId || intent.evidence.requestId !== query.requestId) return UNRESOLVED;
    try {
      if (intent.state === 'intended' || intent.state === 'abandoned') {
        // The compare-and-set and the executor's `signing` marker exclude each other: exactly one commits.
        const state = intent.state === 'abandoned' ? 'abandoned' : await interlock.abandonIntent!(intent.executionId, 'trade-intent-never-signed');
        if (state !== 'abandoned') return UNRESOLVED;
        return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE });
      }
      if (reader === undefined) return UNRESOLVED;
      const evidence = await readTradeSequenceEvidence(reader, intent);
      if (evidence.status !== 'not-included') return UNRESOLVED;
      if (intent.state === 'signing') {
        const state = await interlock.expireIntent!(intent.executionId, 'trade-intent-sequence-unconsumed');
        if (state !== 'expired') return UNRESOLVED;
      }
      return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
    } catch {
      return UNRESOLVED;
    }
  }

  async function resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult> {
    if (query.action !== action) return UNRESOLVED;
    let record: TradeSubmissionRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return UNRESOLVED;
    }
    if (record === undefined) return resolveIntent(query);
    if (record.executionId !== query.executionId) return UNRESOLVED;
    if (query.providerRef !== undefined && query.providerRef !== record.transactionHash) return UNRESOLVED;
    if (record.evidence.boundedGrantId !== query.boundedGrantId || record.evidence.decisionId !== query.decisionId || record.evidence.requestId !== query.requestId) return UNRESOLVED;
    try {
      const evidence = await readTradeLedgerEvidence(ledger, tradeTransactionIdentityOf(record), { networkId, requestTimeoutMs });
      const reference = { providerRef: record.transactionHash };
      if (evidence.status === 'included') {
        if (evidence.resultClass === 'tesSUCCESS') {
          await settleQuietly(record, 'validated-success', evidence.engineResult);
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
        }
        await settleQuietly(record, 'validated-failure', evidence.engineResult);
        return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
      }
      if (evidence.status === 'not-included') {
        await settleQuietly(record, 'expired', 'trade-transaction-expired');
        return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
      }
      return UNRESOLVED;
    } catch {
      return UNRESOLVED;
    }
  }

  return Object.freeze({ authorityId: TRADE_RESOLUTION_AUTHORITY_ID, resolve });
}
