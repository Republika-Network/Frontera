import { Wallet, decode, hashes } from 'xrpl';
import { createXrplRlusdRailConfiguration, type XrplClientPort, type XrplPaymentTransaction, type XrplRlusdRailConfiguration, type XrplRlusdRailConfigurationInput, type XrplTransactionSigner } from '../index.js';

/**
 * PAY-02 test fixtures — test-only, never production sources.
 *
 * - `createTestSoftwareXrplSigner` is the **non-production** software signer
 *   used for deterministic qualification and the optional testnet smoke run.
 *   It holds a key in process memory, which is exactly what a production
 *   signer must not do; it lives under `tests/` so no production source can
 *   import it (`xrpl-rail-boundaries.test.ts`).
 * - `createFakeXrplClient` is a deterministic, in-memory `XrplClientPort`. It
 *   opens no socket and moves nothing; every answer is scripted, and every
 *   call is counted so a test can prove how many submissions happened.
 */

/** A deterministic key pair from fixed entropy: no seed literal in source, and never funded on any network. */
export function testWallet(label: number): Wallet {
  return Wallet.fromEntropy(new Uint8Array(16).fill(label));
}

export interface TestSoftwareXrplSigner extends XrplTransactionSigner {
  /** For canary tests only: the secret this signer holds, so a test can prove it never appears anywhere. */
  readonly canarySecret: string;
  readonly signCount: number;
}

export function createTestSoftwareXrplSigner(wallet: Wallet): TestSoftwareXrplSigner {
  let signCount = 0;
  return {
    address: wallet.classicAddress,
    canarySecret: wallet.seed ?? wallet.privateKey,
    get signCount(): number {
      return signCount;
    },
    async sign(transaction) {
      signCount += 1;
      const { tx_blob, hash } = wallet.sign({ ...transaction, Amount: { ...transaction.Amount } });
      return { signedTransaction: tx_blob, hash };
    },
  };
}

export const ISSUER = testWallet(1);
export const TREASURY = testWallet(2);
export const VENDOR = testWallet(3);
export const OTHER_SOURCE = testWallet(4);

/** RLUSD's XRPL currency code: "RLUSD" in ASCII, zero-padded to 160 bits. */
export const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';
export const RLUSD_ASSET = 'stable:RLUSD/test-issuer';
export const GOVERNED_ACCOUNT = 'treasury-ops';

export function testConfigurationInput(overrides: Partial<Record<keyof XrplRlusdRailConfigurationInput, unknown>> = {}): XrplRlusdRailConfigurationInput {
  return {
    network: 'testnet',
    endpoint: 'wss://xrpl-test.invalid:51233',
    asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress },
    sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }],
    finalityTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    ...overrides,
  } as XrplRlusdRailConfigurationInput;
}

export function testConfiguration(overrides: Partial<Record<keyof XrplRlusdRailConfigurationInput, unknown>> = {}): XrplRlusdRailConfiguration {
  return createXrplRlusdRailConfiguration(testConfigurationInput(overrides));
}

/** A clock that only moves when the rail sleeps — so a finality deadline is reached in microseconds, deterministically. */
export function testClock(start = 1_000_000): { readonly now: () => number; readonly sleep: (milliseconds: number) => Promise<void> } {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  };
}

export interface FakeLookupContext {
  readonly hash: string;
  /** The decoded signed transaction, so a script can answer with the amount that was actually signed. */
  readonly transaction: Readonly<Record<string, unknown>>;
  /** 1 for the first lookup after the submission. */
  readonly attempt: number;
  readonly minLedger: number;
  readonly maxLedger: number;
}

export interface FakeXrplScript {
  readonly connect?: () => void;
  readonly networkId?: number | undefined;
  /** Validated ledger index for the n-th call (1-based). Default 1000 + n. */
  readonly validatedLedgerIndex?: (call: number) => unknown;
  readonly autofill?: (transaction: XrplPaymentTransaction) => unknown;
  /** The submit answer, or a throw. Default a provisional `tesSUCCESS` echoing the hash. */
  readonly submit?: (blob: string, hash: string) => unknown;
  /** The lookup answer, or a throw. Default validated `tesSUCCESS`, delivering exactly the signed amount. */
  readonly lookup?: (context: FakeLookupContext) => unknown;
}

export interface FakeXrplClient extends XrplClientPort {
  readonly calls: { connect: number; disconnect: number; serverInfo: number; validatedLedgerIndex: number; autofill: number; submit: number; lookup: number };
  readonly submitted: readonly string[];
}

export function validatedSuccess(context: FakeLookupContext): unknown {
  return { hash: context.hash, validated: true, ledger_index: context.minLedger + 1, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: context.transaction['Amount'] } };
}

export function validatedFailure(engineResult: string): (context: FakeLookupContext) => unknown {
  return (context) => ({ hash: context.hash, validated: true, ledger_index: context.minLedger + 1, meta: { TransactionResult: engineResult } });
}

export function createFakeXrplClient(script: FakeXrplScript = {}): FakeXrplClient {
  const calls = { connect: 0, disconnect: 0, serverInfo: 0, validatedLedgerIndex: 0, autofill: 0, submit: 0, lookup: 0 };
  const submitted: string[] = [];
  let lastHash: string | undefined;
  let lastTransaction: Readonly<Record<string, unknown>> = {};
  return {
    calls,
    submitted,
    async connect() {
      calls.connect += 1;
      script.connect?.();
    },
    async disconnect() {
      calls.disconnect += 1;
    },
    async serverInfo() {
      calls.serverInfo += 1;
      return { info: 'networkId' in script ? (script.networkId === undefined ? {} : { network_id: script.networkId }) : { network_id: 1 } };
    },
    async validatedLedgerIndex() {
      calls.validatedLedgerIndex += 1;
      return script.validatedLedgerIndex ? script.validatedLedgerIndex(calls.validatedLedgerIndex) : 1000 + calls.validatedLedgerIndex;
    },
    async autofill(transaction) {
      calls.autofill += 1;
      if (script.autofill) return script.autofill(transaction);
      // What the SDK does on a network ≤ 1024: NetworkID assigned `undefined`.
      return { ...transaction, NetworkID: undefined, Sequence: 7, Fee: '12' };
    },
    async submit(blob) {
      calls.submit += 1;
      submitted.push(blob);
      lastHash = hashes.hashSignedTx(blob);
      lastTransaction = decode(blob) as Readonly<Record<string, unknown>>;
      if (script.submit) return script.submit(blob, lastHash);
      return { engine_result: 'tesSUCCESS', engine_result_code: 0, accepted: true, applied: true, broadcast: true, kept: true, queued: false, tx_json: { hash: lastHash } };
    },
    async lookupTransaction(query) {
      calls.lookup += 1;
      const context: FakeLookupContext = { hash: query.hash, transaction: query.hash === lastHash ? lastTransaction : {}, attempt: calls.lookup, minLedger: query.minLedger, maxLedger: query.maxLedger };
      return script.lookup ? script.lookup(context) : validatedSuccess(context);
    },
  };
}
