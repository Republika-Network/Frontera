import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import {
  isXrplRlusdRailConfiguration,
  readLedgerIndex,
  readLookup,
  readNetworkId,
  type XrplClientPort,
  type XrplInterlockSettlement,
  type XrplRlusdRailConfiguration,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';
import type { XrplSubmissionRecord } from './sqlite-xrpl-submission-interlock.js';

/** The P12 authority id under which XRPL / RLUSD executions are bound before their claim. */
export const XRPL_RESOLUTION_AUTHORITY_ID = 'frontera.xrpl-rlusd-ledger';

/**
 * The **only** ledger capability the resolver holds: connection, network
 * identity, the validated ledger index and transaction lookups. No `submit`,
 * no `autofill`, no signer exists on it — `readOnlyXrplLedger` builds a
 * fresh object carrying exactly these methods, so the resolver cannot reach a
 * write even by accident (structurally tested).
 */
export interface XrplLedgerReader {
  connect(): Promise<void>;
  serverInfo(): Promise<unknown>;
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
}

export function readOnlyXrplLedger(client: XrplClientPort): XrplLedgerReader {
  return Object.freeze({
    connect: () => client.connect(),
    serverInfo: () => client.serverInfo(),
    validatedLedgerIndex: (timeoutMs?: number) => client.validatedLedgerIndex(timeoutMs),
    lookupTransaction: (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number) => client.lookupTransaction(query, timeoutMs),
  });
}

/** What the resolver reads from, and the one bookkeeping write it may make, on the local interlock. */
export interface XrplResolutionInterlockAccess {
  read(executionId: string): Promise<XrplSubmissionRecord | undefined>;
  settle(executionId: string, transactionHash: string, settlement: XrplInterlockSettlement): Promise<void>;
}

export interface XrplResolutionAuthorityOptions {
  readonly configuration: XrplRlusdRailConfiguration;
  readonly ledger: XrplLedgerReader;
  readonly interlock: XrplResolutionInterlockAccess;
}

const UNRESOLVED: ExecutionResolutionAuthorityResult = Object.freeze({ outcome: 'unresolved' });

/**
 * PAY-03 — the XRPL rail's P12 `ExecutionResolutionAuthority`: read-only,
 * conservative, and composed into the **existing** P12 flow (no second
 * reconciliation model, no second outcome store, no timer).
 *
 * Given an uncertain execution it looks up the one transaction the interlock
 * recorded for it — strictly before submission, so every transaction that
 * could have been submitted has a record — and answers:
 *
 * | ledger fact | answer |
 * | --- | --- |
 * | validated `tesSUCCESS`, `delivered_amount` exactly the recorded amount, currency and issuer | `confirmed-completed`, ref = hash |
 * | validated `tec…` | `confirmed-not-completed PROVIDER_REJECTED`, ref = hash |
 * | `txnNotFound`, `searched_all`, over `[minLedger, LastLedgerSequence]`, validated index ≥ `LastLedgerSequence` | `confirmed-not-completed PROVIDER_REJECTED` (expired) |
 * | pending, incomplete history, network failure or mismatch, malformed answer, delivered ≠ recorded, wrong currency / issuer, unrecognized result | `unresolved` |
 * | no interlock record for the execution, or one that disagrees with the P11 attempt (hash, asset, amount) | `unresolved` |
 *
 * **Absence is never evidence.** A missing record would prove "never
 * submitted" only if the file could not have been rolled back, so the
 * resolver never answers from absence (`docs/payments/XRPL_PRODUCTION_COMPOSITION.md` §10).
 *
 * After a definitive answer it records the same ledger fact on the interlock
 * (`settle`, bookkeeping only — the interlock's blocking rule already
 * released on that fact). Failure of that write never changes the answer.
 *
 * It **never** submits, signs, autofills or prepares anything, and is never
 * asked to: P12 calls it only from an explicit reconciliation.
 */
export function createXrplResolutionAuthority(options: XrplResolutionAuthorityOptions): ExecutionResolutionAuthority {
  const configuration = options?.configuration;
  if (!isXrplRlusdRailConfiguration(configuration)) throw new TypeError('The XRPL resolution authority needs a validated rail configuration.');
  const ledger = options.ledger;
  const interlock = options.interlock;
  for (const method of ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction'] as const) {
    if (typeof ledger?.[method] !== 'function') throw new TypeError(`The XRPL resolution authority's ledger must implement ${method}.`);
  }
  if (typeof interlock?.read !== 'function' || typeof interlock.settle !== 'function') throw new TypeError('The XRPL resolution authority needs the interlock.');

  async function resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult> {
    let record: XrplSubmissionRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return UNRESOLVED;
    }
    if (record === undefined || record.executionId !== query.executionId) return UNRESOLVED;
    // The P11 attempt and the interlock must describe the same payment.
    if (query.providerRef !== undefined && query.providerRef !== record.transactionHash) return UNRESOLVED;
    if (query.amount !== undefined && (query.amount.unit !== configuration.asset.paymentAsset || query.amount.value !== record.amount.value)) return UNRESOLVED;
    if (record.amount.currency !== configuration.asset.currency || record.amount.issuer !== configuration.asset.issuer) return UNRESOLVED;

    try {
      await ledger.connect();
      if (readNetworkId(await ledger.serverInfo()) !== configuration.networkId) return UNRESOLVED;
      // The validated index FIRST: if it has reached the window's end, every ledger the lookup searches was validated before it ran.
      const validated = readLedgerIndex(await ledger.validatedLedgerIndex(configuration.requestTimeoutMs));
      const reading = readLookup(
        await ledger.lookupTransaction({ hash: record.transactionHash, minLedger: record.minLedger, maxLedger: record.lastLedgerSequence }, configuration.requestTimeoutMs),
        { hash: record.transactionHash, currency: record.amount.currency, issuer: record.amount.issuer, value: record.amount.value },
      );
      const reference = { providerRef: record.transactionHash };
      switch (reading.kind) {
        case 'validated-success':
          await settleQuietly(record, 'validated-success');
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
        case 'validated-failure':
          await settleQuietly(record, 'validated-failure');
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
        case 'not-found-complete':
          if (validated === undefined || validated < record.lastLedgerSequence) return UNRESOLVED;
          await settleQuietly(record, 'expired');
          return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
        default:
          return UNRESOLVED;
      }
    } catch {
      return UNRESOLVED;
    }
  }

  async function settleQuietly(record: XrplSubmissionRecord, settlement: XrplInterlockSettlement): Promise<void> {
    try {
      await interlock.settle(record.executionId, record.transactionHash, settlement);
    } catch {
      // Bookkeeping; the blocking rule already released on the ledger fact.
    }
  }

  return Object.freeze({ authorityId: XRPL_RESOLUTION_AUTHORITY_ID, resolve });
}
