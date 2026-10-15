import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { xrplSubmissionClaimOf, type XrplReservedSubmissionAuthority, type XrplReservedSubmissionConfiguration } from '../../features/payment-runtime/rails/xrpl/index.js';
import { compileTradeProposal, createTradeGovernanceBinding, tradeDelegateEntryIndex, validateTradeProposal } from '../../features/trade-runtime/index.js';
import { proposal as riskProposal } from '../../features/trade-runtime/tests/trade-risk-fixture.js';
import type { TradeAttestedProposal, TradeAttestedProposalSource } from '../trade-risk-context/index.js';
import { createDelegatedOfferSigner, createHttpDelegatedOfferSignerTransport, type DelegatedOfferSigner } from '../xrpl-trade-rail/index.js';
import { startReferenceDelegatedOfferSigner } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import type { XrplTradeLedgerClientFactory } from '../xrpl-trade-execution/host-composition.js';
import { createSqliteTradeSequenceInterlock, type DurableTradeSequenceInterlock } from '../xrpl-trade-execution/sqlite-trade-sequence-interlock.js';
import { TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT, createTradeOfferExecutionAdapter, type TradeExecutionTrace, type TradeOfferExecutionAdapter, type TradeOfferExecutorConfiguration } from '../xrpl-trade-execution/trade-offer-executor.js';
import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import { boundaryFor, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { testAccount, testDelegate, type TestDelegate } from './trade04b-xrpl-fixture.js';
import { S1_TRUST_DOMAIN, signerAuthorization, testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import type { DelegatedOfferCapabilityIssuer } from '../authority-authenticity/index.js';

/**
 * TRADE-04C offline qualification fixtures.
 *
 * `FakeXrplLedger` is a **deterministic, labelled fake ledger**: no socket, no
 * XRPL server, no funded account, no network write. It answers the validated
 * reads the executor's shared-transport reader and TRADE-02's verifier make,
 * and it implements `submitReserved` exactly as the real reserved submission
 * client does — the claim is derived from the blob by the real
 * `xrplSubmissionClaimOf` and must be accepted by the real durable interlock
 * before the fake records anything as "sent". Every reservation made through
 * it is recorded with `ledgerProvenance: 'injected-ledger-client'`.
 *
 * Delegate keys are generated per run by TRADE-04B's fixture (memory only,
 * never funded, never persisted); the reference signer runs on loopback.
 */

export const NETWORK = 'xrp-ledger-testnet' as const;
export const NETWORK_ID = 1;
export const ACTION = 'trade.offer-create';
export const ORG = 'org-acme';
export const PRINCIPAL = 'principal-mm-desk';
export const ACTOR = 'actor-trading-engine';
export const SIGNER_ID = 'trade04c-reference-signer';
export const SIGNER_TOKEN = 'FRONTERA_TRADE04C_SIGNER_TOKEN_SENTINEL_2b6f19e0c4d7a835';
export const DELEGATION_SOURCE = 'trade-delegation-verifier';
const HASH = (seed: number): string => seed.toString(16).toUpperCase().padStart(64, '0').slice(-64);
const RIPPLE_EPOCH = 946_684_800;

export type SubmitBehavior =
  /** Accepted provisionally; validated at the next advance with `finalResult`. */
  | { readonly kind: 'accept'; readonly finalResult?: string; readonly provisional?: string }
  /** `tem…`: malformed, never applied. */
  | { readonly kind: 'malformed'; readonly engineResult: string }
  /** The request reached the fake ledger, then the transport failed: possibly sent. */
  | { readonly kind: 'throw-after-send'; readonly includeWith?: string }
  /** The request reached the ledger and the answer is unreadable. */
  | { readonly kind: 'unreadable' }
  /** Accepted, never included (expires at LastLedgerSequence). */
  | { readonly kind: 'drop' };

export interface SubmittedTransaction {
  readonly executionId: string;
  readonly blob: string;
  readonly hash: string;
  readonly account: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  includedAt?: number;
  result?: string;
  pendingResult?: string;
}

interface AccountRoot {
  sequence: number;
  flags: number;
  regularKey?: string;
}

/** Faults a test can switch on, one read at a time. */
export interface LedgerFaults {
  networkId?: number;
  serverInfoThrows?: boolean;
  validatedAge?: number;
  entryNotValidated?: boolean;
  /** Ledger index the next entry answers carry, relative to the validated index (negative: stale). */
  entryLedgerOffset?: number;
  entryHashConflict?: boolean;
  accountRootThrows?: boolean;
  delegateEntryThrows?: boolean;
  malformedSequence?: boolean;
  lookupThrows?: boolean;
  /** Each `ledger_entry` read first validates one more ledger (observations spread over several ledgers). */
  advanceOnEntry?: boolean;
}

export class FakeXrplLedger {
  readonly label = 'FAKE-LEDGER (TRADE-04C offline qualification; never an XRPL network)';
  validatedIndex = 1_000;
  readonly accounts = new Map<string, AccountRoot>();
  readonly delegations = new Map<string, readonly string[]>();
  readonly submitted: SubmittedTransaction[] = [];
  readonly submitCalls: string[] = [];
  readonly faults: LedgerFaults = {};
  behavior: SubmitBehavior = { kind: 'accept' };
  /** When true, every `lookupTransaction` advances one ledger (so a finality loop progresses with real timers). */
  autoAdvance = true;
  private readonly startCloseTime = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
  private readonly firstIndex = 1_000;
  connected = false;

  hashOf(index: number): string {
    return HASH(index * 7919 + 17);
  }

  closeTimeOf(index: number): number {
    return this.startCloseTime + (index - this.firstIndex) * 4;
  }

  /** Validates `count` more ledgers; includes accepted transactions at the first of them. */
  advance(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      this.validatedIndex += 1;
      for (const tx of this.submitted) {
        if (tx.includedAt !== undefined || tx.pendingResult === undefined) continue;
        if (this.validatedIndex > tx.lastLedgerSequence) continue;
        tx.includedAt = this.validatedIndex;
        tx.result = tx.pendingResult;
        const root = this.accounts.get(tx.account);
        // Every validated result consumes the owner's Sequence (tes and tec alike).
        if (root !== undefined && root.sequence === tx.sequence) root.sequence += 1;
      }
    }
  }

  /** Past the restart quarantine: more than 204 ledgers, closing more than 180 s after the executor started. */
  passQuarantine(): void {
    this.advance(260);
  }

  fund(address: string, sequence = 7, options: { readonly flags?: number; readonly regularKey?: string } = {}): void {
    this.accounts.set(address, { sequence, flags: options.flags ?? 0, ...(options.regularKey !== undefined ? { regularKey: options.regularKey } : {}) });
  }

  delegate(owner: string, delegate: string, permissions: readonly string[] = ['OfferCreate']): void {
    this.delegations.set(`${owner}|${delegate}`, permissions);
  }

  revoke(owner: string, delegate: string): void {
    this.delegations.delete(`${owner}|${delegate}`);
  }

  serverInfo(): unknown {
    if (this.faults.serverInfoThrows === true) throw new Error('unreachable');
    return { info: { network_id: this.faults.networkId ?? NETWORK_ID, validated_ledger: { seq: this.validatedIndex, hash: this.hashOf(this.validatedIndex), age: this.faults.validatedAge ?? 1 } } };
  }

  ledgerHeader(index: number): unknown {
    if (index > this.validatedIndex) return { ledger_index: index, validated: false };
    return { ledger_index: index, ledger_hash: this.hashOf(index), close_time: this.closeTimeOf(index), validated: true };
  }

  private bound(): { readonly ledger_index: number; readonly ledger_hash: string; readonly validated: boolean } {
    const index = this.validatedIndex + (this.faults.entryLedgerOffset ?? 0);
    return { ledger_index: index, ledger_hash: this.faults.entryHashConflict === true ? HASH(1) : this.hashOf(index), validated: this.faults.entryNotValidated !== true };
  }

  ledgerEntry(request: Readonly<Record<string, unknown>>): unknown {
    if (request['ledger_index'] !== 'validated') throw new Error('only validated reads');
    if (this.faults.advanceOnEntry === true) this.advance(1);
    const delegate = request['delegate'] as { readonly account: string; readonly authorize: string } | undefined;
    if (delegate !== undefined) {
      if (this.faults.delegateEntryThrows === true) throw new Error('unreachable');
      const index = tradeDelegateEntryIndex(delegate.account, delegate.authorize) as string;
      const permissions = this.delegations.get(`${delegate.account}|${delegate.authorize}`);
      if (permissions === undefined) return { error: 'entryNotFound', index, ...this.bound() };
      return {
        index,
        ...this.bound(),
        node: { Account: delegate.account, Authorize: delegate.authorize, Flags: 0, LedgerEntryType: 'Delegate', OwnerNode: '0', Permissions: permissions.map((value) => ({ Permission: { PermissionValue: value } })), PreviousTxnID: HASH(42), PreviousTxnLgrSeq: 900, index },
      };
    }
    const account = request['account_root'] as string | undefined;
    if (account !== undefined) {
      if (this.faults.accountRootThrows === true) throw new Error('unreachable');
      const root = this.accounts.get(account);
      if (root === undefined) return { error: 'entryNotFound', ...this.bound() };
      return {
        ...this.bound(),
        node: {
          Account: account,
          Balance: '100000000',
          Flags: root.flags,
          LedgerEntryType: 'AccountRoot',
          OwnerCount: 1,
          Sequence: this.faults.malformedSequence === true ? -1 : root.sequence,
          ...(root.regularKey !== undefined ? { RegularKey: root.regularKey } : {}),
        },
      };
    }
    throw new Error('unsupported selector');
  }

  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }): unknown {
    if (this.faults.lookupThrows === true) throw new Error('timeout');
    const before = this.validatedIndex;
    if (this.autoAdvance) this.advance(1);
    const tx = this.submitted.find((entry) => entry.hash === query.hash);
    if (tx?.includedAt !== undefined && tx.includedAt <= before + 1) return { hash: tx.hash, validated: true, ledger_index: tx.includedAt, meta: { TransactionResult: tx.result } };
    return { error: 'txnNotFound', searched_all: true };
  }

  /** The labelled fake's reserved submission: the real claim derivation, the real interlock claim, then a recorded send. */
  async submitReserved(authority: XrplReservedSubmissionAuthority, networkId: number, executionId: string, blob: string): Promise<unknown> {
    if (!this.connected) {
      const error = new Error('not connected') as Error & { code: string };
      error.code = 'XRPL_SUBMISSION_NOT_ATTEMPTED';
      throw error;
    }
    const claim = xrplSubmissionClaimOf(executionId, networkId, blob);
    if (claim === undefined) throw Object.assign(new Error('refused'), { code: 'XRPL_RESERVED_SUBMISSION_REFUSED' });
    try {
      await authority.claimSubmission(claim);
    } catch {
      throw Object.assign(new Error('refused'), { code: 'XRPL_RESERVED_SUBMISSION_REFUSED' });
    }
    // Past the claim: this is "the one submit request".
    this.submitCalls.push(executionId);
    const behavior = this.behavior;
    const tx: SubmittedTransaction = { executionId, blob, hash: claim.transactionHash, account: claim.account, sequence: claim.sequence, lastLedgerSequence: claim.lastLedgerSequence };
    this.submitted.push(tx);
    switch (behavior.kind) {
      case 'accept':
        tx.pendingResult = behavior.finalResult ?? 'tesSUCCESS';
        return { engine_result: behavior.provisional ?? 'tesSUCCESS', tx_json: { hash: claim.transactionHash } };
      case 'malformed':
        return { engine_result: behavior.engineResult, tx_json: { hash: claim.transactionHash } };
      case 'throw-after-send':
        if (behavior.includeWith !== undefined) tx.pendingResult = behavior.includeWith;
        throw new Error('socket reset after write');
      case 'unreadable':
        tx.pendingResult = 'tesSUCCESS';
        return { surprise: true };
      case 'drop':
        return { engine_result: 'tesSUCCESS', tx_json: { hash: claim.transactionHash } };
    }
  }

  /** The `XrplTradeLedgerClientFactory` the Host composition (or a unit test) injects. */
  factory(): XrplTradeLedgerClientFactory {
    return (configuration: XrplReservedSubmissionConfiguration, authority: XrplReservedSubmissionAuthority) => this.client(configuration.networkId, authority);
  }

  client(networkId: number, authority: XrplReservedSubmissionAuthority) {
    return {
      connect: async () => {
        this.connected = true;
      },
      disconnect: async () => {
        this.connected = false;
      },
      serverInfo: async () => this.serverInfo(),
      ledgerHeader: async (index: number) => this.ledgerHeader(index),
      ledgerEntry: async (request: Readonly<Record<string, unknown>>) => this.ledgerEntry(request),
      validatedLedgerIndex: async () => this.validatedIndex,
      lookupTransaction: async (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }) => this.lookupTransaction(query),
      submitReserved: (executionId: string, blob: string) => this.submitReserved(authority, networkId, executionId, blob),
    };
  }
}

/** One owner/delegate pair on the fake ledger, with a real delegate key held by the reference signer. */
export interface TradePairWorld {
  readonly owner: string;
  readonly delegate: TestDelegate;
}

export function pairWorld(ledger: FakeXrplLedger, options: { readonly permissions?: readonly string[] } = {}): TradePairWorld {
  const owner = testAccount();
  const delegate = testDelegate('ed25519');
  ledger.fund(owner, 41);
  ledger.fund(delegate.address, 5);
  ledger.delegate(owner, delegate.address, options.permissions ?? ['OfferCreate']);
  return { owner, delegate };
}

export interface StartedReferenceSigner {
  readonly endpoint: string;
  /** TRADE-04C-S1: the signer's durable capability consumption ledger. */
  readonly ledgerPath: string;
  signatures(): number;
  close(): Promise<void>;
}

/** The loopback reference signer, pinning the S1 test authority, the S1 trust domain and the rig's organization; its consumption ledger in its own temporary directory. */
export async function startSigner(pairs: readonly TradePairWorld[], options: { readonly signerId?: string; readonly ledgerPath?: string; readonly organizationId?: string; readonly trustDomain?: string } = {}): Promise<StartedReferenceSigner> {
  const space = options.ledgerPath === undefined ? scratch() : undefined;
  const ledgerPath = options.ledgerPath ?? join(space!.dir, 'capability-ledger.sqlite');
  const started = await startReferenceDelegatedOfferSigner({
    signerId: options.signerId ?? SIGNER_ID,
    network: NETWORK,
    credential: SIGNER_TOKEN,
    keys: pairs.map((pair) => ({ ownerAccount: pair.owner, delegateSeed: pair.delegate.seed })),
    maximumFeeDrops: '1000',
    maximumLedgerHorizon: 200,
    clock: () => Date.now(),
    authorization: signerAuthorization(undefined, { organizationId: options.organizationId ?? ORG, trustDomain: options.trustDomain ?? S1_TRUST_DOMAIN }),
    consumptionLedgerPath: ledgerPath,
  });
  started.server.unref();
  return {
    endpoint: `http://127.0.0.1:${started.port}`,
    ledgerPath,
    signatures: started.signatures,
    close: async () => {
      await started.close();
      space?.cleanup();
    },
  };
}

export function signerClient(endpoint: string, pairs: readonly TradePairWorld[], options: { readonly signerId?: string; readonly lastLedgerOffset?: number } = {}): DelegatedOfferSigner {
  return createDelegatedOfferSigner({
    transport: createHttpDelegatedOfferSignerTransport({ endpoint, credential: SIGNER_TOKEN }),
    pin: { signerId: options.signerId ?? SIGNER_ID, network: NETWORK, pairs: pairs.map((pair) => ({ ownerAccount: pair.owner, delegateAccount: pair.delegate.address, signingPublicKey: pair.delegate.publicKey })) },
    timeoutMs: 5_000,
    maximumFeeDrops: '100',
    maximumLedgerHorizon: options.lastLedgerOffset ?? 20,
    probeIntervalMs: 0,
  });
}

export function executorConfiguration(pairs: readonly TradePairWorld[], overrides: Partial<TradeOfferExecutorConfiguration> = {}): TradeOfferExecutorConfiguration {
  return {
    adapterId: XRPL_TRADE_EXECUTOR_ID,
    action: ACTION,
    network: NETWORK,
    pairs: pairs.map((pair) => ({ ownerAccount: pair.owner, delegateAccount: pair.delegate.address, signingPublicKey: pair.delegate.publicKey })),
    feeDrops: '12',
    maximumFeeDrops: '100',
    lastLedgerOffset: 20,
    observationSpanLedgers: 2,
    maxValidatedLedgerAgeSeconds: 10,
    requestTimeoutMs: 1_000,
    finalityTimeoutMs: 2_000,
    pollIntervalMs: 1,
    delegationPolicy: { sourceId: DELEGATION_SOURCE, maxAgeSeconds: 10 },
    ...overrides,
  };
}

let sequence = 0;

/** A raw proposal for a pair: sells 100 of an issued token for 200 XRP unless overridden. */
export function rawProposal(pair: TradePairWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  const id = `trade04c-${process.pid}-${sequence}`;
  return riskProposal({ organizationId: ORG, principalId: PRINCIPAL, requestId: `${id}-req`, idempotencyKey: id, ownerAccount: pair.owner, delegateAccount: pair.delegate.address, ...overrides });
}

/** An in-memory attested-proposal source standing in for TRADE-03's edge (unit level; the Host tests use the real edge). */
export class AttestationBook implements TradeAttestedProposalSource {
  readonly records = new Map<string, TradeAttestedProposal>();

  attest(raw: Record<string, unknown>, options: { readonly simulatedSources?: boolean; readonly actorId?: string } = {}): TradeAttestedProposal {
    const validation = validateTradeProposal(raw);
    if (!validation.valid) throw new Error(`fixture proposal invalid: ${JSON.stringify(validation.violations)}`);
    const proposal = validation.accepted.proposal;
    const record: TradeAttestedProposal = Object.freeze({
      proposalDigest: validation.accepted.digest,
      proposal,
      organizationId: proposal.organizationId,
      principalId: proposal.principalId,
      actorId: options.actorId ?? ACTOR,
      action: ACTION,
      resource: `${proposal.network}:${proposal.ownerAccount}`,
      attestedAt: new Date().toISOString(),
      assessmentDigest: `sha256:${'c'.repeat(64)}`,
      simulatedSources: options.simulatedSources ?? true,
    });
    this.records.set(record.proposalDigest, record);
    return record;
  }

  attestedProposal(digest: string): TradeAttestedProposal | undefined {
    return this.records.get(digest);
  }
}

let executionCounter = 0;

/** The validated action the governed path would hand the adapter for `raw` (the grant bounds all seven parameters exactly). */
export function validatedAction(raw: Record<string, unknown>, overrides: Partial<ValidatedExecutionAction> = {}): ValidatedExecutionAction {
  executionCounter += 1;
  const { intent } = compileTradeProposal(raw, createTradeGovernanceBinding({ action: ACTION }), { organizationId: raw['organizationId'] as string, principalId: raw['principalId'] as string });
  return Object.freeze({
    boundedGrantId: `grant-trade04c-${executionCounter}`,
    subject: ACTOR,
    action: intent.action,
    resource: intent.resource,
    organization: ORG,
    amount: Object.freeze({ value: intent.amount.value, unit: intent.amount.currency }),
    parameters: Object.freeze(Object.keys(intent.parameters).sort().map((dimension) => Object.freeze({ dimension, type: 'token' as const, value: intent.parameters[dimension]! }))),
    notAfter: new Date(Date.now() + 3_600_000).toISOString(),
    correlation: Object.freeze({ requestId: `req-trade04c-${executionCounter}`, decisionId: `dec-trade04c-${executionCounter}`, executionId: `aoc.exec:trade04c-${process.pid}-${executionCounter}` }),
    ...overrides,
  });
}

export interface ExecutorRig {
  readonly ledger: FakeXrplLedger;
  readonly pairs: readonly TradePairWorld[];
  readonly book: AttestationBook;
  readonly interlock: DurableTradeSequenceInterlock;
  readonly adapter: TradeOfferExecutionAdapter;
  readonly signer: StartedReferenceSigner;
  readonly signerClient: DelegatedOfferSigner;
  readonly traces: TradeExecutionTrace[];
  readonly witness: StartedWitness;
  readonly path: string;
  /** TRADE-04C-S1: the capability issuer the executor asks (the unit-level test issuer unless one was injected). */
  readonly issuer: DelegatedOfferCapabilityIssuer;
  close(): Promise<void>;
}

export const scratch = (): { readonly dir: string; cleanup(): void } => {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-trade04c-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * A full unit-level executor: the real executor, the real SQLite trade
 * interlock anchored at a real loopback reference witness, the real TRADE-04B
 * signer client over HTTP to a loopback reference signer, and the labelled
 * fake ledger. Past the restart quarantine unless `quarantine: true`.
 */
export async function executorRig(options: { readonly pairs?: number | readonly TradePairWorld[]; readonly configuration?: Partial<TradeOfferExecutorConfiguration>; readonly quarantine?: boolean; readonly simulation?: boolean; readonly dir?: string; readonly witness?: StartedWitness; readonly ledger?: FakeXrplLedger; readonly create?: typeof createTradeOfferExecutionAdapter; readonly createInterlock?: typeof createSqliteTradeSequenceInterlock; readonly issuer?: DelegatedOfferCapabilityIssuer } = {}): Promise<ExecutorRig> {
  const ledger = options.ledger ?? new FakeXrplLedger();
  const pairs = Array.isArray(options.pairs) ? (options.pairs as readonly TradePairWorld[]) : Array.from({ length: (options.pairs as number | undefined) ?? 1 }, () => pairWorld(ledger));
  const space = options.dir === undefined ? scratch() : { dir: options.dir, cleanup: () => {} };
  const witness = options.witness ?? (await startWitness());
  const boundary = await boundaryFor(witness, ORG);
  const path = join(space.dir, 'trade-interlock.sqlite');
  const interlock = await (options.createInterlock ?? createSqliteTradeSequenceInterlock)(path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: NETWORK_ID }, sequenceAccounts: pairs.map((pair) => pair.owner), now: () => new Date().toISOString(), freshness: { boundary } });
  const signer = await startSigner(pairs);
  const client = signerClient(signer.endpoint, pairs, { lastLedgerOffset: options.configuration?.lastLedgerOffset ?? 20 });
  const book = new AttestationBook();
  const traces: TradeExecutionTrace[] = [];
  const issuer = options.issuer ?? testCapabilityIssuer();
  const adapter = (options.create ?? createTradeOfferExecutionAdapter)({
    configuration: executorConfiguration(pairs, options.configuration),
    attested: book,
    signer: client,
    authorization: { trustDomain: S1_TRUST_DOMAIN, issuer },
    ledger: ledger.client(NETWORK_ID, interlock),
    interlock,
    ledgerProvenance: 'injected-ledger-client',
    ...(options.simulation === false ? {} : { simulation: TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT }),
    onTrace: (trace) => traces.push(trace),
  });
  await adapter.readiness();
  if (options.quarantine !== true) ledger.passQuarantine();
  return {
    ledger,
    pairs,
    book,
    interlock,
    adapter,
    signer,
    signerClient: client,
    traces,
    witness,
    path,
    issuer,
    async close() {
      await interlock.close().catch(() => {});
      await signer.close().catch(() => {});
      if (options.witness === undefined) await witness.close().catch(() => {});
      space.cleanup();
    },
  };
}
