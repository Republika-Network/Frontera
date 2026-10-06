import Database from 'better-sqlite3';
import {
  connectXrplLedgerClient,
  connectXrplPreflightReader,
  createEnvXrplSigner,
  createSqliteXrplAttemptStore,
  createXrplTestnetTransport,
  issuedValuesEqual,
  runXrplPreflight,
  type XrplLedgerClient,
  type XrplTransactionSigner,
} from '@aoc-enterprise/xrpl-testnet-transport';

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_MAINNET_ISSUER, RLUSD_XRPL_TESTNET_ISSUER, andrewSettlementProfile } from '../../../dist/src/enterprise/andrew-demo/index.js';
import { checkXrplSettlement } from '../../../dist/src/enterprise/execution-adapters/xrpl/index.js';
import { SECRET_VARIABLES } from './configuration.js';
import type { DemoConfiguration, DemoLedgerPorts, DemoLedgerLookup, DemoTransportBinding } from './contracts.js';

/**
 * ANDREW-P0-11 — the live XRPL Testnet ports, for `npm run demo:andrew` only.
 * The one module of the harness that imports the P0-08 transport package; the
 * harness core receives these ports by injection. The transport, its
 * settlement gate, signer boundary, attempt store and Testnet checks are the
 * P0-08 ones, unchanged. This module only measures: every ledger connection,
 * signature and submission the transport makes is counted at the boundary.
 */

/** Each demo account needs this much XRP beyond reserves (fees), as in P0-08/P0-09. */
const MINIMUM_XRP_DROPS = 20_000_000n;

export interface LedgerConnector {
  /** Opens a transport ledger connection (counted). */
  connect(endpoint: string): Promise<XrplLedgerClient>;
  /** Opens an independent connection for the after-the-fact re-read (not transport activity). */
  connectForLookup(endpoint: string): Promise<XrplLedgerClient>;
  preflight(configuration: DemoConfiguration): ReturnType<DemoLedgerPorts['preflight']>;
}

export const LIVE_LEDGER: LedgerConnector = {
  connect: (endpoint) => connectXrplLedgerClient(endpoint),
  connectForLookup: (endpoint) => connectXrplLedgerClient(endpoint),
  async preflight(configuration) {
    const reader = await connectXrplPreflightReader(configuration.endpoint);
    try {
      return await runXrplPreflight(reader, {
        expectedNetworkId: configuration.expectedNetworkId,
        treasury: configuration.treasury,
        recipient: configuration.recipient,
        currency: RLUSD_CURRENCY_CODE,
        issuer: RLUSD_XRPL_TESTNET_ISSUER,
        requiredValue: configuration.amountUsd,
        minimumXrpDrops: MINIMUM_XRP_DROPS,
      });
    } finally {
      await reader.disconnect();
    }
  },
};

/** The ports over a ledger connector: the real Testnet for the demo, a scripted ledger in tests. */
export function createLedgerPorts(ledger: LedgerConnector = LIVE_LEDGER): DemoLedgerPorts {
  const signerFor = (configuration: DemoConfiguration, secrets: Readonly<Record<string, string>>) => createEnvXrplSigner({ environment: secrets, seedVariable: SECRET_VARIABLES.treasurySeed, expectedAccount: configuration.treasury });
  return {
    preflight: (configuration) => ledger.preflight(configuration),
    verifySignerAccount(configuration, secrets) {
      signerFor(configuration, secrets);
    },
    openTransport(configuration, secrets, attemptStorePath, observe): DemoTransportBinding {
      const counts = { connections: 0, signatures: 0, submissions: 0 };
      // An observer is told what happened; it can never change it, and a throwing observer is ignored.
      const tell = (event: { readonly event: string; readonly executionId?: string; readonly transactionHash?: string; readonly detail?: string }): void => {
        try {
          observe?.(event);
        } catch {
          // Observation only.
        }
      };
      const attempts = createSqliteXrplAttemptStore(attemptStorePath);
      const base = signerFor(configuration, secrets);
      const signer: XrplTransactionSigner = { account: base.account, sign: async (prepared) => ((counts.signatures += 1), tell({ event: 'signing' }), base.sign(prepared)) };
      const profile = andrewSettlementProfile();
      const transport = createXrplTestnetTransport({
        configuration: { endpoint: configuration.endpoint, sourceAccount: configuration.treasury, forbiddenSourceAccounts: [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER] },
        settlementGate: (submission) => checkXrplSettlement(profile, submission),
        signer,
        attempts,
        onEvent: (event) => tell(event),
        connect: async (endpoint) => {
          counts.connections += 1;
          const client = await ledger.connect(endpoint);
          return { ...client, submit: async (blob: string) => ((counts.submissions += 1), tell({ event: 'submitting' }), client.submit(blob)) };
        },
      });
      const count = (): number => {
        const db = new Database(attemptStorePath, { readonly: true, fileMustExist: true });
        try {
          return (db.prepare('SELECT COUNT(*) AS n FROM xrpl_submission_attempts').get() as { readonly n: number }).n;
        } finally {
          db.close();
        }
      };
      return {
        transport,
        activity: () => ({ ...counts }),
        findAttempt: (executionId) => attempts.find(executionId),
        attemptCount: count,
        close: () => attempts.close(),
      };
    },
    async lookupTransaction(configuration, hash): Promise<DemoLedgerLookup> {
      const client = await ledger.connectForLookup(configuration.endpoint);
      try {
        const info = await client.serverInfo();
        if (info.networkId !== configuration.expectedNetworkId) return { found: false };
        const lookup = await client.transaction(hash);
        if (!lookup.found) return { found: false };
        const delivered = lookup.meta?.['delivered_amount'] as { readonly currency?: string; readonly issuer?: string; readonly value?: string } | undefined;
        return {
          found: true,
          validated: lookup.validated,
          ...(lookup.hash !== undefined ? { hash: lookup.hash } : {}),
          ...(lookup.ledgerIndex !== undefined ? { ledgerIndex: lookup.ledgerIndex } : {}),
          ...(typeof lookup.meta?.['TransactionResult'] === 'string' ? { engineResult: lookup.meta['TransactionResult'] } : {}),
          ...(typeof lookup.transaction['Account'] === 'string' ? { account: lookup.transaction['Account'] } : {}),
          ...(typeof lookup.transaction['Destination'] === 'string' ? { destination: lookup.transaction['Destination'] } : {}),
          ...(delivered !== undefined && typeof delivered === 'object' ? { delivered } : {}),
        };
      } finally {
        await client.disconnect();
      }
    },
    issuedValuesEqual: (left, right) => issuedValuesEqual(left, right),
  };
}
