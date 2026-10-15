import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import { readXrplInclusion, readXrplLedgerIndex, readXrplNetworkId, xrplNonInclusionProven } from '../../features/xrpl-transport/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';
import type { TradeInterlockSettlement, TradeSubmissionRecord } from './sqlite-trade-sequence-interlock.js';

/** The P12 authority id under which governed trade executions are bound before their claim. */
export const TRADE_RESOLUTION_AUTHORITY_ID = 'frontera.xrpl-trade-ledger';

/** The only ledger capability the resolver holds. No submit, no signer, no reserved-submission client. */
export interface TradeLedgerReader {
  connect(): Promise<void>;
  serverInfo(): Promise<unknown>;
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
}

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
}

export interface TradeResolutionAuthorityOptions {
  readonly networkId: number;
  readonly action: string;
  readonly requestTimeoutMs: number;
  readonly ledger: TradeLedgerReader;
  readonly interlock: TradeResolutionInterlockAccess;
}

const UNRESOLVED: ExecutionResolutionAuthorityResult = Object.freeze({ outcome: 'unresolved' });

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

  async function settleQuietly(record: TradeSubmissionRecord, settlement: TradeInterlockSettlement, detail: string): Promise<void> {
    try {
      await interlock.settle(record.executionId, record.transactionHash, settlement, detail);
    } catch {
      // Bookkeeping; the blocking rule already released on the ledger fact.
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
    if (record === undefined || record.executionId !== query.executionId) return UNRESOLVED;
    if (query.providerRef !== undefined && query.providerRef !== record.transactionHash) return UNRESOLVED;
    if (record.evidence.boundedGrantId !== query.boundedGrantId || record.evidence.decisionId !== query.decisionId || record.evidence.requestId !== query.requestId) return UNRESOLVED;
    try {
      await ledger.connect();
      if (readXrplNetworkId(await ledger.serverInfo()) !== networkId) return UNRESOLVED;
      const before = readXrplLedgerIndex(await ledger.validatedLedgerIndex(requestTimeoutMs));
      const reading = readXrplInclusion(await ledger.lookupTransaction({ hash: record.transactionHash, minLedger: record.minLedger, maxLedger: record.lastLedgerSequence }, requestTimeoutMs), record.transactionHash);
      const reference = { providerRef: record.transactionHash };
      if (reading.kind === 'validated') {
        if (reading.engineResult === 'tesSUCCESS') {
          await settleQuietly(record, 'validated-success', reading.engineResult);
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
        }
        if (reading.engineResult.startsWith('tec')) {
          await settleQuietly(record, 'validated-failure', reading.engineResult);
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
        }
        return UNRESOLVED;
      }
      if (xrplNonInclusionProven(reading, before, record.lastLedgerSequence)) {
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
