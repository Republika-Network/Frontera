import { Client } from 'xrpl';

import type { XrplLedgerClient, XrplTransactionLookup } from './contracts.js';

/**
 * The real ledger connection: `xrpl.Client` over the configured WebSocket
 * endpoint. EP-XRPL-01 in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §7.6 —
 * the only outbound XRPL network site in this repository.
 */
export async function connectXrplLedgerClient(endpoint: string): Promise<XrplLedgerClient> {
  const client = new Client(endpoint);
  await client.connect();

  const ledger: XrplLedgerClient = {
    async serverInfo() {
      const response = await client.request({ command: 'server_info' });
      const info = response.result.info as { readonly network_id?: number; readonly validated_ledger?: { readonly seq?: number }; readonly complete_ledgers?: string };
      return {
        ...(typeof info.network_id === 'number' ? { networkId: info.network_id } : {}),
        ...(typeof info.validated_ledger?.seq === 'number' ? { validatedLedgerIndex: info.validated_ledger.seq } : {}),
        ...(typeof info.complete_ledgers === 'string' ? { completeLedgers: info.complete_ledgers } : {}),
      };
    },
    async validatedLedgerIndex() {
      const response = await client.request({ command: 'ledger', ledger_index: 'validated' });
      return response.result.ledger_index;
    },
    async autofill(transaction) {
      return (await client.autofill(transaction as Parameters<Client['autofill']>[0])) as unknown as Record<string, unknown>;
    },
    async submit(txBlob) {
      const response = await client.request({ command: 'submit', tx_blob: txBlob });
      return typeof response.result.engine_result === 'string' ? { engineResult: response.result.engine_result } : {};
    },
    async transaction(hash, range): Promise<XrplTransactionLookup> {
      try {
        const response = await client.request({ command: 'tx', transaction: hash, ...(range !== undefined ? { min_ledger: range.minLedger, max_ledger: range.maxLedger } : {}) });
        const result = response.result as unknown as {
          readonly hash?: string;
          readonly validated?: boolean;
          readonly ledger_index?: number;
          readonly close_time_iso?: string;
          readonly tx_json?: Record<string, unknown>;
          readonly meta?: Record<string, unknown>;
        };
        return {
          found: true,
          validated: result.validated === true,
          ...(typeof result.hash === 'string' ? { hash: result.hash } : {}),
          ...(typeof result.ledger_index === 'number' ? { ledgerIndex: result.ledger_index } : {}),
          ...(typeof result.close_time_iso === 'string' ? { closeTimeIso: result.close_time_iso } : {}),
          transaction: result.tx_json ?? {},
          ...(result.meta !== undefined && typeof result.meta === 'object' ? { meta: result.meta } : {}),
        };
      } catch (error) {
        const data = (error as { readonly data?: { readonly error?: string; readonly searched_all?: boolean } }).data;
        if (data?.error === 'txnNotFound') return { found: false, searchedAll: data.searched_all === true };
        throw error;
      }
    },
    async disconnect() {
      await client.disconnect();
    },
  };
  return Object.freeze(ledger);
}
