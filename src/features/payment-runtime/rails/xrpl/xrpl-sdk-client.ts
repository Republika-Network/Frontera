import { Client, NotConnectedError, RippledError } from 'xrpl';
import { XrplRailConfigurationError, isXrplRlusdRailConfiguration, type XrplRlusdRailConfiguration } from './xrpl-config.js';
import { XrplSubmissionNotAttemptedError, type XrplClientPort, type XrplPaymentTransaction } from './xrpl-client-port.js';

/**
 * The `XrplClientPort` over the official XRPL JavaScript SDK (`xrpl`) — the
 * **only** production source that opens an XRPL connection or submits a
 * transaction (EP-069 in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`).
 *
 * One WebSocket client to the one configured endpoint, opened on demand by the
 * rail (`connect`) and closed by `disconnect`. No background loop of its own;
 * the SDK may re-establish a dropped socket, but it never re-sends a request
 * that was in flight — a request interrupted by a disconnect is rejected, and
 * the rail treats a rejected `submit` as possibly submitted.
 *
 * `submit` sends `fail_hard: true`, so a transaction that fails locally is
 * neither held nor relayed by the server. It is the single `submit` request in
 * this repository and is made at most once per call — no retry.
 */
export function createXrplSdkClient(configuration: XrplRlusdRailConfiguration): XrplClientPort {
  if (!isXrplRlusdRailConfiguration(configuration)) throw new XrplRailConfigurationError('configuration', 'must come from createXrplRlusdRailConfiguration');
  const client = new Client(configuration.endpoint, { timeout: configuration.requestTimeoutMs, connectionTimeout: configuration.requestTimeoutMs });

  return Object.freeze({
    async connect(): Promise<void> {
      if (!client.isConnected()) await client.connect();
    },
    async disconnect(): Promise<void> {
      if (client.isConnected()) await client.disconnect();
    },
    async serverInfo(): Promise<unknown> {
      return (await client.request({ command: 'server_info' })).result;
    },
    async validatedLedgerIndex(): Promise<unknown> {
      return client.getLedgerIndex();
    },
    async autofill(transaction: XrplPaymentTransaction): Promise<unknown> {
      // A copy: the SDK fills the object it is handed.
      return client.autofill({ ...transaction, Amount: { ...transaction.Amount } });
    },
    async submit(signedTransaction: string): Promise<unknown> {
      if (!client.isConnected()) throw new XrplSubmissionNotAttemptedError();
      try {
        return (await client.request({ command: 'submit', tx_blob: signedTransaction, fail_hard: true })).result;
      } catch (error) {
        // The SDK raises NotConnectedError before writing to the socket; nothing left the process.
        if (error instanceof NotConnectedError) throw new XrplSubmissionNotAttemptedError();
        throw error;
      }
    },
    async lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }): Promise<unknown> {
      try {
        return (await client.request({ command: 'tx', transaction: query.hash, min_ledger: query.minLedger, max_ledger: query.maxLedger })).result;
      } catch (error) {
        if (error instanceof RippledError) {
          const data = (error as { readonly data?: unknown }).data;
          const record = data !== null && typeof data === 'object' ? (data as Readonly<Record<string, unknown>>) : {};
          return { error: record['error'], searched_all: record['searched_all'] };
        }
        throw error;
      }
    },
  });
}
