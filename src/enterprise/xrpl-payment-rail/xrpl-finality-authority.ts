import {
  RIPPLE_EPOCH_UNIX_SECONDS,
  isXrplRlusdRailConfiguration,
  parseXrplDestination,
  readNetworkId,
  readXrplFinalLedger,
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
 * lookups) plus the validated ledger header read the restart quarantine
 * already uses — **required**: the header is where the ledger hash and close
 * time every `final` answer carries come from. No `submit`, no `autofill`, no
 * signer.
 */
export interface XrplFinalityLedgerReader extends XrplLedgerReader {
  ledgerHeader(index: number, timeoutMs?: number): Promise<unknown>;
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
export function readOnlyXrplFinalityLedger(client: XrplLedgerReader & { ledgerHeader?(index: number, timeoutMs?: number): Promise<unknown> }): XrplFinalityLedgerReader {
  const header = client.ledgerHeader;
  if (typeof header !== 'function') throw new TypeError("The XRPL finality authority's ledger must implement ledgerHeader.");
  return Object.freeze({
    connect: () => client.connect(),
    serverInfo: () => client.serverInfo(),
    validatedLedgerIndex: (timeoutMs?: number) => client.validatedLedgerIndex(timeoutMs),
    lookupTransaction: (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number) => client.lookupTransaction(query, timeoutMs),
    ledgerHeader: (index: number, timeoutMs?: number) => header.call(client, index, timeoutMs),
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
 * | validated `tesSUCCESS`; `Payment`; `Account` = the mapped source; `Destination` / `DestinationTag` = the governed destination; amount, currency, issuer and `delivered_amount` exactly the governed amount; no flags; server on the configured `network_id`; that ledger's validated header (hash, close time) read and consistent | `final`, with normalized evidence |
 * | validated failure, delivered ≠ governed, unrecognized result, any field different | `contradicted` (nothing is recorded; P11 / P12 are never rewritten) |
 * | not validated yet, not found, incomplete history, network failure or mismatch, unreadable answer, no interlock record, a record that disagrees with the query, the ledger header unreadable or disagreeing | `not-final` |
 *
 * **Deterministic evidence.** Every `final` answer for one transaction carries
 * the same facts, in the same form: network id, ledger index, ledger **hash**
 * and close time (`finalizedAt`) are always present, the last two from the
 * validated ledger header — never from whichever optional field a `tx` answer
 * shape happened to include. Evidence never depends on what was momentarily
 * available, so a settlement rebuilt after its store is lost is byte-identical.
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
  for (const method of ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction', 'ledgerHeader'] as const) {
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
      // Required, from the validated header: no header, no `final` — never a final answer with less evidence.
      const finalLedger = readXrplFinalLedger(await ledger.ledgerHeader(reading.ledgerIndex, configuration.requestTimeoutMs), reading);
      if (finalLedger === undefined) return NOT_FINAL;
      // The validated ledger's consensus close time — an instant the network established, never a local clock.
      const finalizedAt = new Date((finalLedger.closeTime + RIPPLE_EPOCH_UNIX_SECONDS) * 1000).toISOString().replace(/\.000Z$/, 'Z');
      const facts: PaymentFinalityFact[] = [
        { name: 'xrpl.network-id', value: String(networkId) },
        { name: 'xrpl.ledger-index', value: String(finalLedger.ledgerIndex) },
        { name: 'xrpl.ledger-hash', value: finalLedger.ledgerHash },
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
          finalizedAt,
          facts,
        },
      });
    } catch {
      return NOT_FINAL;
    }
  }

  return Object.freeze({ authorityId: XRPL_FINALITY_AUTHORITY_ID, verifyFinality });
}
