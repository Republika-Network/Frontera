import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runXrplPreflight, type XrplLedgerClient, type XrplPreflightReader, type XrplTransactionLookup } from '@aoc-enterprise/xrpl-testnet-transport';
import { Wallet, decode } from 'xrpl';

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_TESTNET_ISSUER } from '../../../../dist/src/enterprise/andrew-demo/index.js';
import type { DemoLedgerPorts, DemoTransportBinding } from '../contracts.js';
import { createLedgerPorts, type LedgerConnector } from '../live-wiring.js';

/**
 * ANDREW-P0-11 test fixture: the harness over the **real** P0-08 transport,
 * signer and attempt store, with a scripted XRPL Testnet behind them. The
 * ledger counts every connection and remembers every submitted blob, so tests
 * can prove "zero" and prove that no blob or seed is ever printed.
 */

export interface LedgerScript {
  networkId: number;
  treasuryRlusd: string | undefined;
  recipientTrustLine: boolean;
  /** Engine result the validated transaction reports. */
  engineResult: string;
  /** Overrides what the independent re-read reports as delivered. */
  lookupDeliveredValue?: string;
  /** Overrides the engine result the independent re-read reports. */
  lookupEngineResult?: string;
}

export interface ScriptedLedger {
  readonly script: LedgerScript;
  readonly blobs: string[];
  readonly counts: { transportConnects: number; lookupConnects: number; preflightReads: number; submits: number };
  readonly connector: LedgerConnector;
}

export function scriptedLedger(treasury: Wallet, recipient: Wallet, overrides: Partial<LedgerScript> = {}): ScriptedLedger {
  const script: LedgerScript = { networkId: 1, treasuryRlusd: '100', recipientTrustLine: true, engineResult: 'tesSUCCESS', ...overrides };
  const blobs: string[] = [];
  const counts = { transportConnects: 0, lookupConnects: 0, preflightReads: 0, submits: 0 };
  let ledger = 9000;
  const lookup = (hash: string, forLookup: boolean): XrplTransactionLookup => {
    const blob = blobs.at(-1);
    if (blob === undefined) return { found: false, searchedAll: false };
    const tx = decode(blob) as Record<string, unknown>;
    const amount = tx['Amount'] as { readonly currency: string; readonly issuer: string; readonly value: string };
    const delivered = forLookup && script.lookupDeliveredValue !== undefined ? { ...amount, value: script.lookupDeliveredValue } : amount;
    return {
      found: true,
      validated: true,
      hash,
      ledgerIndex: 9002,
      closeTimeIso: new Date().toISOString(),
      transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'] },
      meta: { TransactionResult: forLookup && script.lookupEngineResult !== undefined ? script.lookupEngineResult : script.engineResult, ...(script.engineResult === 'tesSUCCESS' ? { delivered_amount: delivered } : {}) },
    };
  };
  const client = (forLookup: boolean): XrplLedgerClient => ({
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
      return { engineResult: 'tesSUCCESS' };
    },
    async transaction(hash) {
      return lookup(hash, forLookup);
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
      if (account === treasury.classicAddress) return script.treasuryRlusd === undefined ? undefined : { balance: script.treasuryRlusd, limit: '1000000' };
      return script.recipientTrustLine ? { balance: '0', limit: '1000000' } : undefined;
    },
  };
  const connector: LedgerConnector = {
    connect: async () => ((counts.transportConnects += 1), client(false)),
    connectForLookup: async () => ((counts.lookupConnects += 1), client(true)),
    preflight: (configuration) =>
      runXrplPreflight(reader, { expectedNetworkId: configuration.expectedNetworkId, treasury: configuration.treasury, recipient: configuration.recipient, currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, requiredValue: configuration.amountUsd, minimumXrpDrops: 20_000_000n }),
  };
  return { script, blobs, counts, connector };
}

export interface Fixture {
  readonly root: string;
  readonly treasury: Wallet;
  readonly recipient: Wallet;
  readonly environment: Record<string, string>;
  readonly ledger: ScriptedLedger;
  /** Ports over the scripted ledger; `activityOffset` lets a test simulate transport activity the harness must catch. */
  readonly ports: DemoLedgerPorts;
  readonly activityOffset: { connections: number; signatures: number; submissions: number };
  cleanup(): void;
}

export function fixture(options: { readonly ledger?: Partial<LedgerScript>; readonly environment?: Record<string, string>; readonly secretsMode?: number; readonly secrets?: (treasury: Wallet, recipient: Wallet) => string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'frontera-andrew-p011-'));
  const treasury = Wallet.generate();
  const recipient = Wallet.generate();
  const secretsFile = join(root, 'testnet.env');
  writeFileSync(
    secretsFile,
    options.secrets?.(treasury, recipient) ??
      ['# XRPL TESTNET ONLY — test fixture', `FRONTERA_XRPL_TESTNET_TREASURY_SEED=${String(treasury.seed)}`, `FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS=${treasury.classicAddress}`, `FRONTERA_XRPL_TESTNET_RECIPIENT_SEED=${String(recipient.seed)}`, `FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS=${recipient.classicAddress}`, ''].join('\n'),
  );
  chmodSync(secretsFile, options.secretsMode ?? 0o600);
  const ledger = scriptedLedger(treasury, recipient, options.ledger);
  const base = createLedgerPorts(ledger.connector);
  const activityOffset = { connections: 0, signatures: 0, submissions: 0 };
  const ports: DemoLedgerPorts = {
    ...base,
    openTransport(configuration, secrets, path): DemoTransportBinding {
      const binding = base.openTransport(configuration, secrets, path);
      return {
        ...binding,
        activity: () => {
          const real = binding.activity();
          return { connections: real.connections + activityOffset.connections, signatures: real.signatures + activityOffset.signatures, submissions: real.submissions + activityOffset.submissions };
        },
      };
    },
  };
  return {
    root,
    treasury,
    recipient,
    environment: { FRONTERA_ANDREW_STATE_ROOT: join(root, 'state'), FRONTERA_ANDREW_SECRETS_FILE: secretsFile, ...options.environment },
    ledger,
    ports,
    activityOffset,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
