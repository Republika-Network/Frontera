import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decode, hashes } from 'xrpl';

import {
  RIPPLE_EPOCH_UNIX_SECONDS,
  XRPL_RESTART_ANCHOR_SLACK_SECONDS,
  XRPL_RESTART_QUARANTINE_LEDGERS,
  XrplSubmissionNotAttemptedError,
  type XrplClientPort,
  type XrplPaymentTransaction,
} from '../../features/payment-runtime/rails/xrpl/index.js';
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
  /** PAY-05: the decoded signed transaction, answered as `tx_json` (API v2) so a settlement verifier can read its own fields. */
  readonly transaction?: Readonly<Record<string, unknown>>;
  /** PAY-05: the validated ledger it was included in, once it validated. */
  validatedIn?: number;
}

export interface LedgerSimulator extends XrplClientPort {
  /**
   * The validated ledger index the server reports. Raising it beyond any index
   * reported before **closes** the new ledgers, one every
   * `SIMULATED_LEDGER_SECONDS` on the simulator's clock, which moves forward
   * with them; lowering it plays a server lagging behind ledgers that already
   * closed (their close times stay what they were).
   */
  index: number;
  /** The simulator's wall clock (ms since the Unix epoch): real time plus the time the simulated ledgers took to close. The rail's restart quarantine reads it (the client port's `now`). */
  now(): number;
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
  readonly calls: { connect: number; serverInfo: number; validatedLedgerIndex: number; ledgerHeader: number; autofill: number; submit: number; lookup: number; disconnect: number };
  /** Moves a transaction to a validated outcome (advancing the sequence when it validates). */
  validate(hash: string, outcome: 'success' | 'tec'): void;
}

/** Seconds between simulated ledger closes. */
export const SIMULATED_LEDGER_SECONDS = 4;

/**
 * Validated ledgers past a rail's start before its restart quarantine is over
 * on the simulator: the ledgers that close during the anchor slack, plus the
 * quarantine window.
 */
export const SIMULATED_RESTART_QUARANTINE = XRPL_RESTART_QUARANTINE_LEDGERS + Math.ceil(XRPL_RESTART_ANCHOR_SLACK_SECONDS / SIMULATED_LEDGER_SECONDS);

export function createLedgerSimulator(initial: Partial<Pick<LedgerSimulator, 'index' | 'sequence' | 'networkId'>> = {}): LedgerSimulator {
  const calls = { connect: 0, serverInfo: 0, validatedLedgerIndex: 0, ledgerHeader: 0, autofill: 0, submit: 0, lookup: 0, disconnect: 0 };
  // The simulated wall clock: real time plus the seconds the simulated ledgers took to close.
  let advancedMs = 0;
  const clockNow = (): number => Date.now() + advancedMs;
  const rippleSeconds = (ms: number): number => Math.floor(ms / 1000) - RIPPLE_EPOCH_UNIX_SECONDS;
  let reported = initial.index ?? 1000;
  let highest = reported;
  // Ledgers up to the initial index closed in the past, one every SIMULATED_LEDGER_SECONDS, the last one now.
  const genesis = { index: highest, closeTime: rippleSeconds(clockNow()) };
  const closed = new Map<number, number>();
  const closeTimeOf = (index: number): number => closed.get(index) ?? genesis.closeTime - SIMULATED_LEDGER_SECONDS * (genesis.index - index);
  const transactions = new Map<string, SimulatedTransaction>();
  const submitted: string[] = [];
  const unreachable = (): never => {
    throw new Error('simulated: server unreachable');
  };
  const simulator: LedgerSimulator = {
    get index(): number {
      return reported;
    },
    set index(next: number) {
      for (let index = highest + 1; index <= next; index += 1) {
        advancedMs += SIMULATED_LEDGER_SECONDS * 1000;
        closed.set(index, rippleSeconds(clockNow()));
      }
      highest = Math.max(highest, next);
      reported = next;
    },
    now: clockNow,
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
      tx.validatedIn = Math.max(1, Math.min(tx.lastLedgerSequence, highest));
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
    async ledgerHeader(index: number) {
      calls.ledgerHeader += 1;
      if (simulator.unavailable) unreachable();
      if (index > reported) return { ledger_index: index, validated: false };
      return { ledger_index: index, close_time: closeTimeOf(index), validated: true };
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
      transactions.set(hash, { hash, sequence: decoded['Sequence'] as number, lastLedgerSequence: decoded['LastLedgerSequence'] as number, amount: { ...amount }, outcome: 'pending', transaction: decoded });
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
          return { ...validatedShape(tx), meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount } } };
        case 'delivered-mismatch':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount, value: '0.01' } } };
        case 'wrong-issuer':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...tx.amount, issuer: TREASURY.classicAddress } } };
        case 'tec':
          return { hash: tx.hash, validated: true, meta: { TransactionResult: 'tecPATH_DRY' } };
      }
    },
  };
  /**
   * What rippled (API v2, the SDK's default) answers for a validated transaction: the hash, the validated ledger's
   * index and hash, and the transaction itself under `tx_json`, its instructed amount as `DeliverMax`.
   */
  function validatedShape(tx: SimulatedTransaction): Record<string, unknown> {
    const { Amount: instructed, TxnSignature: _signature, SigningPubKey: _key, ...fields } = (tx.transaction ?? {}) as Record<string, unknown>;
    const ledgerIndex = tx.validatedIn ?? Math.max(1, highest);
    return {
      hash: tx.hash,
      validated: true,
      ledger_index: ledgerIndex,
      // A deterministic stand-in for the validated ledger's hash: 64 uppercase hex digits.
      ledger_hash: ledgerIndex.toString(16).toUpperCase().padStart(64, '0'),
      tx_json: { ...fields, ...(instructed !== undefined ? { DeliverMax: instructed } : {}) },
    };
  }

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
