import {
  RIPPLE_EPOCH_UNIX_SECONDS,
  isXrplRlusdRailConfiguration,
  parseXrplDestination,
  readLedgerHeader,
  readNetworkId,
  readXrplPaymentFinality,
  type XrplRlusdRailConfiguration,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import type { PaymentFinalityAnswer, PaymentFinalityAuthority, PaymentFinalityFact, PaymentFinalityQuery } from '../../features/payment-runtime/index.js';
import type { XrplSubmissionRecord } from './sqlite-xrpl-submission-interlock.js';
import type { XrplLedgerReader } from './xrpl-resolution-authority.js';

/** The PAY-05 finality authority id for XRPL / RLUSD payments. */
export const XRPL_FINALITY_AUTHORITY_ID = 'frontera.xrpl-rlusd-finality';

/** How finality is established: inclusion, with every governed field verified, in a validated (immutable) XRPL ledger. Versioned. */
export const XRPL_FINALITY_METHOD = 'xrpl.validated-ledger.v1';

/**
 * The ledger capability the finality authority holds: PAY-03's read-only
 * `XrplLedgerReader` (connection, network identity, validated index, `tx`
 * lookups) plus, optionally, the validated ledger header read the restart
 * quarantine already uses. No `submit`, no `autofill`, no signer.
 */
export interface XrplFinalityLedgerReader extends XrplLedgerReader {
  ledgerHeader?(index: number, timeoutMs?: number): Promise<unknown>;
}

/** What the authority reads from the local interlock: one record, by execution. It never writes the interlock. */
export interface XrplFinalityInterlockAccess {
  read(executionId: string): Promise<XrplSubmissionRecord | undefined>;
}

export interface XrplFinalityAuthorityOptions {
  readonly configuration: XrplRlusdRailConfiguration;
  readonly ledger: XrplFinalityLedgerReader;
  readonly interlock: XrplFinalityInterlockAccess;
}

const NOT_FINAL: PaymentFinalityAnswer = Object.freeze({ outcome: 'not-final' });

/**
 * The read-only capability the finality authority is composed with, built
 * from an SDK client exactly like the P12 resolver's: a fresh frozen object
 * carrying only reads.
 */
export function readOnlyXrplFinalityLedger(client: XrplFinalityLedgerReader): XrplFinalityLedgerReader {
  const header = client.ledgerHeader;
  return Object.freeze({
    connect: () => client.connect(),
    serverInfo: () => client.serverInfo(),
    validatedLedgerIndex: (timeoutMs?: number) => client.validatedLedgerIndex(timeoutMs),
    lookupTransaction: (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number) => client.lookupTransaction(query, timeoutMs),
    ...(typeof header === 'function' ? { ledgerHeader: (index: number, timeoutMs?: number) => header.call(client, index, timeoutMs) } : {}),
  });
}

/**
 * PAY-05 — the XRPL / RLUSD rail's `PaymentFinalityAuthority`: read-only and
 * conservative.
 *
 * Asked about one completed governed payment, it locates the one transaction
 * the interlock recorded for that execution (strictly before submission — the
 * hash the P11 / P12 record names must be that transaction's), re-reads it from
 * the configured network, and answers `final` only when the ledger itself
 * proves every governed field (`readXrplPaymentFinality`):
 *
 * | ledger fact | answer |
 * | --- | --- |
 * | validated `tesSUCCESS`; `Payment`; `Account` = the mapped source; `Destination` / `DestinationTag` = the governed destination; amount, currency, issuer and `delivered_amount` exactly the governed amount; no flags; server on the configured `network_id` | `final`, with normalized evidence |
 * | validated failure, delivered ≠ governed, unrecognized result, any field different | `contradicted` (nothing is recorded; P11 / P12 are never rewritten) |
 * | not validated yet, not found, incomplete history, network failure or mismatch, unreadable answer, no interlock record, a record that disagrees with the query | `not-final` |
 *
 * Unknown is never a negative and absence is never evidence. It never signs,
 * submits, autofills, builds a payment or writes the interlock, and it is asked
 * only from an explicit settlement verification — no timer, no polling.
 */
export function createXrplFinalityAuthority(options: XrplFinalityAuthorityOptions): PaymentFinalityAuthority {
  const configuration = options?.configuration;
  if (!isXrplRlusdRailConfiguration(configuration)) throw new TypeError('The XRPL finality authority needs a validated rail configuration.');
  const ledger = options.ledger;
  const interlock = options.interlock;
  for (const method of ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction'] as const) {
    if (typeof ledger?.[method] !== 'function') throw new TypeError(`The XRPL finality authority's ledger must implement ${method}.`);
  }
  if (typeof interlock?.read !== 'function') throw new TypeError('The XRPL finality authority needs read access to the interlock.');
  const sourceAddresses = new Map(configuration.sourceAccounts.map((entry) => [entry.accountId, entry.address]));

  async function verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer> {
    const payment = query.payment;
    // Only this rail's payments, in its configured asset.
    if (query.railId !== undefined && query.railId !== configuration.railId) return NOT_FINAL;
    if (payment.amount.unit !== configuration.asset.paymentAsset) return NOT_FINAL;
    const account = sourceAddresses.get(payment.source.accountId);
    const destination = parseXrplDestination(payment.destination);
    if (account === undefined || destination === undefined) return NOT_FINAL;

    let record: XrplSubmissionRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return NOT_FINAL;
    }
    // The interlock record, the P11 / P12 record and the canonical payment must describe the same transaction.
    if (record === undefined || record.executionId !== query.executionId || record.account !== account) return NOT_FINAL;
    if (query.providerRef !== undefined && query.providerRef !== record.transactionHash) return NOT_FINAL;
    if (record.amount.currency !== configuration.asset.currency || record.amount.issuer !== configuration.asset.issuer || record.amount.value !== payment.amount.value) return NOT_FINAL;

    try {
      await ledger.connect();
      const networkId = readNetworkId(await ledger.serverInfo());
      if (networkId !== configuration.networkId) return NOT_FINAL;
      const reading = readXrplPaymentFinality(
        await ledger.lookupTransaction({ hash: record.transactionHash, minLedger: record.minLedger, maxLedger: record.lastLedgerSequence }, configuration.requestTimeoutMs),
        {
          hash: record.transactionHash,
          currency: configuration.asset.currency,
          issuer: configuration.asset.issuer,
          value: payment.amount.value,
          account,
          destination: destination.address,
          ...(destination.tag !== undefined ? { destinationTag: destination.tag } : {}),
        },
      );
      if (reading.kind === 'contradicted') return Object.freeze({ outcome: 'contradicted', reason: reading.reason });
      if (reading.kind !== 'final') return NOT_FINAL;
      const finalizedAt = await closeInstant(reading.ledgerIndex);
      const facts: PaymentFinalityFact[] = [
        { name: 'xrpl.network-id', value: String(networkId) },
        { name: 'xrpl.ledger-index', value: String(reading.ledgerIndex) },
        ...(reading.ledgerHash !== undefined ? [{ name: 'xrpl.ledger-hash', value: reading.ledgerHash }] : []),
        { name: 'xrpl.transaction-result', value: 'tesSUCCESS' },
        { name: 'xrpl.source-address', value: account },
        { name: 'xrpl.destination-address', value: destination.address },
        ...(destination.tag !== undefined ? [{ name: 'xrpl.destination-tag', value: String(destination.tag) }] : []),
        { name: 'xrpl.currency', value: configuration.asset.currency },
        { name: 'xrpl.issuer', value: configuration.asset.issuer },
        { name: 'xrpl.delivered-value', value: payment.amount.value },
      ];
      return Object.freeze({
        outcome: 'final',
        evidence: {
          executionId: query.executionId,
          method: XRPL_FINALITY_METHOD,
          providerRef: record.transactionHash,
          amount: { value: payment.amount.value, unit: payment.amount.unit },
          source: { accountId: payment.source.accountId },
          destination: { kind: payment.destination.kind, reference: payment.destination.reference },
          ...(finalizedAt !== undefined ? { finalizedAt } : {}),
          facts,
        },
      });
    } catch {
      return NOT_FINAL;
    }
  }

  /** The validated ledger's consensus close time — an instant the network established, never a local clock. Omitted when it cannot be read. */
  async function closeInstant(index: number): Promise<string | undefined> {
    if (typeof ledger.ledgerHeader !== 'function') return undefined;
    try {
      const header = readLedgerHeader(await ledger.ledgerHeader(index, configuration.requestTimeoutMs));
      if (header === undefined || header.index !== index) return undefined;
      return new Date((header.closeTime + RIPPLE_EPOCH_UNIX_SECONDS) * 1000).toISOString().replace(/\.000Z$/, 'Z');
    } catch {
      return undefined;
    }
  }

  return Object.freeze({ authorityId: XRPL_FINALITY_AUTHORITY_ID, verifyFinality });
}
