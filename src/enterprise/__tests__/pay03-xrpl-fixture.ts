import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decode, hashes } from 'xrpl';

import { XrplSubmissionNotAttemptedError, type XrplClientPort, type XrplPaymentTransaction } from '../../features/payment-runtime/rails/xrpl/index.js';
import { TREASURY } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';

/**
 * PAY-03 qualification fixtures — test-only.
 *
 * `createLedgerSimulator` is a deterministic `XrplClientPort` that behaves
 * like one XRPL account on one ledger closely enough to qualify the interlock,
 * the restart quarantine and the resolver: a mutable validated ledger index, an
 * account sequence that advances only when a transaction is validated, every
 * submitted transaction kept **by hash** (so a later process, or the resolver,
 * can look an older one up), and scripted submit / lookup behaviour. It opens
 * no socket and moves nothing; every call is counted.
 */

export type SimulatedOutcome = 'success' | 'tec' | 'pending' | 'dropped' | 'delivered-mismatch' | 'wrong-issuer';
export type SubmitMode = 'accept' | 'lost-after-send' | 'not-attempted' | 'tem' | 'unreadable';

export interface SimulatedTransaction {
  readonly hash: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  readonly amount: { readonly currency: string; readonly issuer: string; readonly value: string };
  outcome: SimulatedOutcome;
}

export interface LedgerSimulator extends XrplClientPort {
  /** The validated ledger index the server reports. */
  index: number;
  /** The account's next sequence, as autofill reads it. Advances when a transaction validates (success or tec). */
  sequence: number;
  networkId: number;
  submitMode: SubmitMode;
  /** The outcome a newly accepted submission will eventually have. */
  nextOutcome: SimulatedOutcome;
  /** Every read throws (an unreachable server). */
  unavailable: boolean;
  /** Whether `txnNotFound` answers carry `searched_all: true`. */
  searchedAll: boolean;
  /** The lookup answers anything that is not a `tx` answer. */
  malformedLookups: boolean;
  readonly transactions: Map<string, SimulatedTransaction>;
  readonly submitted: string[];
  readonly calls: { connect: number; serverInfo: number; validatedLedgerIndex: number; autofill: number; submit: number; lookup: number; disconnect: number };
  /** Moves a transaction to a validated outcome (advancing the sequence when it validates). */
  validate(hash: string, outcome: 'success' | 'tec'): void;
}

export function createLedgerSimulator(initial: Partial<Pick<LedgerSimulator, 'index' | 'sequence' | 'networkId'>> = {}): LedgerSimulator {
  const calls = { connect: 0, serverInfo: 0, validatedLedgerIndex: 0, autofill: 0, submit: 0, lookup: 0, disconnect: 0 };
  const transactions = new Map<string, SimulatedTransaction>();
  const submitted: string[] = [];
  const unreachable = (): never => {
    throw new Error('simulated: server unreachable');
  };
  const simulator: LedgerSimulator = {
    index: initial.index ?? 1000,
    sequence: initial.sequence ?? 7,
    networkId: initial.networkId ?? 1,
    submitMode: 'accept',
    nextOutcome: 'success',
    unavailable: false,
    searchedAll: true,
    malformedLookups: false,
    transactions,
    submitted,
    calls,
    validate(hash, outcome) {
      const tx = transactions.get(hash);
      if (tx === undefined) throw new Error('simulated: no such transaction');
      tx.outcome = outcome;
      if (simulator.sequence <= tx.sequence) simulator.sequence = tx.sequence + 1;
    },
    async connect() {
      calls.connect += 1;
      if (simulator.unavailable) unreachable();
    },
    async disconnect() {
      calls.disconnect += 1;
    },
    async serverInfo() {
      calls.serverInfo += 1;
      if (simulator.unavailable) unreachable();
      return { info: { network_id: simulator.networkId } };
    },
    async validatedLedgerIndex() {
      calls.validatedLedgerIndex += 1;
      if (simulator.unavailable) unreachable();
      return simulator.index;
    },
    async autofill(transaction: XrplPaymentTransaction) {
      calls.autofill += 1;
      if (simulator.unavailable) unreachable();
      return { ...transaction, NetworkID: undefined, Sequence: simulator.sequence, Fee: '12' };
    },
    async submit(blob: string) {
      calls.submit += 1;
      if (simulator.submitMode === 'not-attempted') throw new XrplSubmissionNotAttemptedError();
      submitted.push(blob);
      const hash = hashes.hashSignedTx(blob);
      const decoded = decode(blob) as Record<string, unknown>;
      if (simulator.submitMode === 'tem') return { engine_result: 'temBAD_AMOUNT', tx_json: { hash } };
      const amount = decoded['Amount'] as { currency: string; issuer: string; value: string };
      transactions.set(hash, { hash, sequence: decoded['Sequence'] as number, lastLedgerSequence: decoded['LastLedgerSequence'] as number, amount: { ...amount }, outcome: 'pending' });
      const eventual = simulator.nextOutcome;
      if (eventual === 'success' || eventual === 'tec') simulator.validate(hash, eventual);
      else transactions.get(hash)!.outcome = eventual;
      if (simulator.submitMode === 'lost-after-send') throw new Error('simulated: connection reset after the blob was written');
      if (simulator.submitMode === 'unreadable') return { surprise: true };
      return { engine_result: 'tesSUCCESS', tx_json: { hash } };
    },
    async lookupTransaction(query) {
      calls.lookup += 1;
      if (simulator.unavailable) unreachable();
      if (simulator.malformedLookups) return { hash: query.hash, validated: 'yes', meta: 7 };
      const tx = transactions.get(query.hash);
      if (tx === undefined || tx.outcome === 'dropped') return { error: 'txnNotFound', searched_all: simulator.searchedAll };
      switch (tx.outcome) {
        case 'pending':
          return { hash: tx.hash, validated: false };
        case 'success':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount } } };
        case 'delivered-mismatch':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount, value: '0.01' } } };
        case 'wrong-issuer':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount, issuer: TREASURY.classicAddress } } };
        case 'tec':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tecPATH_DRY' } };
      }
    },
  };
  return simulator;
}

/** A temporary directory per test file, removed at the end. */
export function scratch(prefix: string): { dir(): string; cleanup(): void } {
  const made: string[] = [];
  return {
    dir() {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      made.push(directory);
      return directory;
    },
    cleanup() {
      for (const directory of made) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The reference signer's credential in qualification. A canary: it must never appear in any Host output. */
export const SIGNER_TOKEN = 'FRONTERA_PAY03_SIGNER_TOKEN_CANARY_6f1e09d2b7a4c853e0';
export const SIGNER_ID = 'pay03-reference-signer';
export const SIGNER_TOKEN_ENV = 'FRONTERA_PAY03_XRPL_SIGNER_TOKEN';
