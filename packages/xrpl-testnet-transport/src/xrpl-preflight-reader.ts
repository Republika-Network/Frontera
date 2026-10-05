import { Client } from 'xrpl';

import type { XrplPreflightReader } from './preflight.js';

/** The read-only preflight over a real connection (EP-XRPL-01): `server_info`, `account_info`, `account_lines`. */
export async function connectXrplPreflightReader(endpoint: string): Promise<XrplPreflightReader & { disconnect(): Promise<void> }> {
  const client = new Client(endpoint);
  await client.connect();
  return Object.freeze({
    async serverInfo() {
      const info = (await client.request({ command: 'server_info' })).result.info as { readonly network_id?: number; readonly validated_ledger?: { readonly seq?: number } };
      return { ...(typeof info.network_id === 'number' ? { networkId: info.network_id } : {}), ...(typeof info.validated_ledger?.seq === 'number' ? { validatedLedgerIndex: info.validated_ledger.seq } : {}) };
    },
    async xrpBalanceDrops(account: string) {
      try {
        const response = await client.request({ command: 'account_info', account, ledger_index: 'validated' });
        return BigInt(response.result.account_data.Balance);
      } catch (error) {
        if ((error as { readonly data?: { readonly error?: string } }).data?.error === 'actNotFound') return undefined;
        throw error;
      }
    },
    async trustLine(account: string, issuer: string, currency: string) {
      const response = await client.request({ command: 'account_lines', account, peer: issuer, ledger_index: 'validated' });
      const line = response.result.lines.find((candidate) => candidate.currency === currency);
      return line === undefined ? undefined : { balance: line.balance, limit: line.limit };
    },
    async disconnect() {
      await client.disconnect();
    },
  });
}
