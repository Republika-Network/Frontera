import { runXrplPreflight, type XrplLedgerClient, type XrplPreflightReader, type XrplTransactionLookup } from '@aoc-enterprise/xrpl-testnet-transport';
import { Wallet, decode } from 'xrpl';

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_TESTNET_ISSUER } from '../../../dist/src/enterprise/andrew-demo/index.js';
import { XRPL_TESTNET_ENDPOINT, XRPL_TESTNET_NETWORK_ID } from '../../andrew-demo-harness/dist/configuration.js';
import type { DemoConfiguration, DemoLedgerPorts } from '../../andrew-demo-harness/dist/contracts.js';
import { createLedgerPorts, type LedgerConnector } from '../../andrew-demo-harness/dist/live-wiring.js';
import { PRODUCTION_MOTIVATING_EXAMPLE_USD } from '../../andrew-demo-harness/dist/scenarios.js';

/**
 * ANDREW-DEMO-UI-01 — the REHEARSAL ledger.
 *
 * A scripted XRPL Testnet behind the **real** P0-08 transport, signer boundary
 * and attempt store, bound through the same `createLedgerPorts` the live demo
 * uses. Nothing here opens a socket: every "connection" is an in-process
 * object, so a rehearsal can never reach XRPL.
 *
 * The rehearsal accounts are generated in memory when the UI backend starts.
 * No secrets file is read, no real seed exists in the process, and the
 * generated keys are never written anywhere. The P0-08 signer does sign the
 * scripted transaction with that ephemeral key (so the real settlement gate,
 * signer check and durable attempt store are exercised); the signed blob goes
 * only to this scripted ledger and is never displayed.
 */

export interface RehearsalScript {
  networkId: number;
  /** Treasury Test RLUSD balance the scripted ledger reports; debited by each validated payment. */
  treasuryRlusd: string | undefined;
  recipientTrustLine: boolean;
  /** Engine result the scripted ledger validates the transaction with. */
  engineResult: string;
}

export interface RehearsalLedger {
  readonly script: RehearsalScript;
  /** Every connection, preflight read and submission the scripted ledger served. */
  readonly counts: { transportConnects: number; lookupConnects: number; preflightReads: number; submits: number };
  /** Held for tests only: the signed blobs the scripted ledger received (never displayed). */
  readonly blobs: readonly string[];
  readonly connector: LedgerConnector;
}

/** Trust-line limit the scripted ledger reports; far above any rehearsal payment. */
const SCRIPTED_TRUST_LIMIT = '1000000000';

/**
 * The rehearsal governs the Andrew/LUMX business scenario itself: USD 75,000,
 * settled 1:1 as 75,000 Test RLUSD on the scripted ledger. The scripted
 * treasury starts with enough for many full runs per backend start.
 */
export const REHEARSAL_AMOUNT_USD = PRODUCTION_MOTIVATING_EXAMPLE_USD;
export const REHEARSAL_TREASURY_RLUSD = '10000000';

/** The scripted ledger for a treasury and a recipient address. */
export function createRehearsalLedger(treasury: string, overrides: Partial<RehearsalScript> = {}): RehearsalLedger {
  const script: RehearsalScript = { networkId: XRPL_TESTNET_NETWORK_ID, treasuryRlusd: '100', recipientTrustLine: true, engineResult: 'tesSUCCESS', ...overrides };
  const blobs: string[] = [];
  const counts = { transportConnects: 0, lookupConnects: 0, preflightReads: 0, submits: 0 };
  let ledger = 9000;
  let validatedAt: number | undefined;

  const lookup = (hash: string): XrplTransactionLookup => {
    const blob = blobs.at(-1);
    if (blob === undefined) return { found: false, searchedAll: false };
    const tx = decode(blob) as Record<string, unknown>;
    const amount = tx['Amount'] as { readonly currency: string; readonly issuer: string; readonly value: string };
    return {
      found: true,
      validated: true,
      hash,
      ledgerIndex: validatedAt ?? ledger,
      closeTimeIso: new Date().toISOString(),
      transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'] },
      meta: { TransactionResult: script.engineResult, ...(script.engineResult === 'tesSUCCESS' ? { delivered_amount: amount } : {}) },
    };
  };
  const client = (): XrplLedgerClient => ({
    async serverInfo() {
      return { networkId: script.networkId, validatedLedgerIndex: ledger };
    },
    async validatedLedgerIndex() {
      ledger += 1;
      return ledger;
    },
    async autofill(tx) {
      return { ...tx, Flags: 0, NetworkID: undefined, Sequence: 99, Fee: '12', LastLedgerSequence: ledger + 20 };
    },
    async submit(blob) {
      counts.submits += 1;
      blobs.push(blob);
      validatedAt = ledger + 2;
      if (script.engineResult === 'tesSUCCESS' && script.treasuryRlusd !== undefined) {
        const value = String(((decode(blob) as Record<string, unknown>)['Amount'] as { readonly value: string }).value);
        script.treasuryRlusd = String(Number(script.treasuryRlusd) - Number(value));
      }
      return { engineResult: 'tesSUCCESS' };
    },
    async transaction(hash) {
      return lookup(hash);
    },
    async disconnect() {},
  });
  const reader: XrplPreflightReader = {
    async serverInfo() {
      counts.preflightReads += 1;
      return { networkId: script.networkId, validatedLedgerIndex: ledger };
    },
    async xrpBalanceDrops() {
      return 100_000_000n;
    },
    async trustLine(account) {
      if (account === treasury) return script.treasuryRlusd === undefined ? undefined : { balance: script.treasuryRlusd, limit: SCRIPTED_TRUST_LIMIT };
      return script.recipientTrustLine ? { balance: '0', limit: SCRIPTED_TRUST_LIMIT } : undefined;
    },
  };
  const connector: LedgerConnector = {
    connect: async () => ((counts.transportConnects += 1), client()),
    connectForLookup: async () => ((counts.lookupConnects += 1), client()),
    preflight: (configuration) =>
      runXrplPreflight(reader, { expectedNetworkId: configuration.expectedNetworkId, treasury: configuration.treasury, recipient: configuration.recipient, currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, requiredValue: configuration.amountUsd, minimumXrpDrops: 20_000_000n }),
  };
  return { script, blobs, counts, connector };
}

export interface RehearsalWorld {
  readonly configuration: DemoConfiguration;
  /** In-memory only: the ephemeral treasury seed the P0-08 signer needs. Registered with the secret guard by the caller. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly ports: DemoLedgerPorts;
  readonly ledger: RehearsalLedger;
}

/**
 * A complete rehearsal world: two generated accounts, the scripted ledger and
 * the ports over it. `stateRoot` is the rehearsal's own run area, never the
 * live one.
 */
export function createRehearsalWorld(stateRoot: string, overrides: Partial<RehearsalScript> = {}): RehearsalWorld {
  const treasury = Wallet.generate();
  const recipient = Wallet.generate();
  const ledger = createRehearsalLedger(treasury.classicAddress, overrides);
  const configuration: DemoConfiguration = Object.freeze({
    // Named only because the P0-08 transport validates its configuration; the scripted connector never dials it.
    endpoint: XRPL_TESTNET_ENDPOINT,
    expectedNetworkId: XRPL_TESTNET_NETWORK_ID,
    treasury: treasury.classicAddress,
    recipient: recipient.classicAddress,
    amountUsd: REHEARSAL_AMOUNT_USD,
    stateRoot,
    secretsFile: '(none — rehearsal keys are generated in memory)',
  });
  return {
    configuration,
    secrets: Object.freeze({ FRONTERA_XRPL_TESTNET_TREASURY_SEED: String(treasury.seed), FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS: treasury.classicAddress, FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS: recipient.classicAddress }),
    ports: createLedgerPorts(ledger.connector),
    ledger,
  };
}
