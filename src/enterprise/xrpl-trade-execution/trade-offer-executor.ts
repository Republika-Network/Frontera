import { createHash } from 'node:crypto';

import { EXECUTION_FAILURE_REASONS, type ExecutionAdapter, type ExecutionAdapterResult, type ExecutionFailureReason, type ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import {
  TRADE_NETWORKS,
  TRADE_PARAMETER_DIMENSION_IDS,
  canonicalTradeJson,
  compileTradeProposal,
  createTradeGovernanceBinding,
  parseTradeDelegationPolicy,
  tradeDelegationRequestFor,
  validateTradeProposal,
  type TradeDelegationAssessment,
  type TradeDelegationPolicy,
  type TradeNetwork,
  type TradeProposal,
} from '../../features/trade-runtime/index.js';
import { assessXrplDelegateSigningKey, createXrplDelegationVerifier, readXrplOwnerSequence } from '../../features/trade-runtime/rails/xrpl/index.js';
import {
  XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET,
  createXrplRestartQuarantine,
  createXrplValidatedLedgerReader,
  readXrplLedgerIndex,
  readXrplSubmission,
  xrplNonInclusionProven,
  type XrplValidatedLedgerReader,
} from '../../features/xrpl-transport/index.js';
import { DelegatedOfferCapabilityError, type DelegatedOfferCapabilityIssuer, type IssuedDelegatedOfferCapability } from '../authority-authenticity/delegated-offer-capability-issuer.js';
import type { TradeAttestedProposal, TradeAttestedProposalSource } from '../trade-risk-context/index.js';
import {
  DelegatedOfferSignerError,
  delegatedOfferSigningPreimageDigest,
  preparedDelegatedOfferFromProposal,
  type DelegatedOfferSigningPort,
  type PreparedDelegatedOffer,
  type VerifiedDelegatedOfferSignature,
} from '../xrpl-trade-rail/index.js';
import type { DurableTradeSequenceInterlock, TradeIntentOutcome, TradeInterlockSettlement, TradeReservationEvidence } from './sqlite-trade-sequence-interlock.js';
import { TRADE_EXECUTION_DETAILS as D, type TradeExecutionDetail } from './trade-execution-details.js';
import { readTradeInclusion, type TradeTransactionIdentity } from './trade-ledger-evidence.js';

/**
 * TRADE-04C — the governed XRPL **delegated OfferCreate executor**: the first
 * Trade execution adapter, and the only thing that can reach the protected
 * delegated signer (TRADE-04B) and the reservation-gated submission client
 * (gate G2).
 *
 * It is an `ExecutionAdapter`: the existing governed path (customer identity
 * → TRADE-03 admission → Kernel with the CORE-04 trade provider → policy →
 * CORE-05 approvals → emergency control → P10 grant → P7 → P11 claim) calls it
 * with a `ValidatedExecutionAction`, and nothing else can. It decides nothing
 * about authority; it refuses whatever it cannot bind exactly.
 *
 * ```
 * 1 bind       action, resource, amount, organization, subject and all seven trade parameters
 *              ↔ the TRADE-03 attested proposal whose digest the grant names; recompiled: exact
 * 2 pair       owner and delegate are a configured pair; network is the configured network
 * 3 recorded   an execution the interlock holds is never prepared, signed or submitted again
 * 4 ledger     validated reference ledger V on the configured network; restart quarantine
 * 5 delegation TRADE-02 verifier, fresh validated read, pinned at ≥ V: AUTHORIZED or refuse
 * 6 key        the delegate's validated AccountRoot authorizes the pinned delegate key
 * 7 sequence   the OWNER's validated AccountRoot Sequence (never the delegate's)
 * 8 window     every observation within [V, V + span]; Expiration after V's close time
 * 9 build      the closed OfferCreate from the attested proposal only; Fee and LLS from configuration and V
 * 10 blocking  the durable interlock (witness probed) has no open window on that Sequence
 * 10a intent   TRADE-04D D-1: the execution's intent (owner, Sequence, Fee, LLS, window, preimage
 *              digest, evidence) durable and CORE-07-anchored; it holds the Sequence window from here
 * 11 authorize TRADE-04C-S1: a CORE-02 delegated-offer signing capability for exactly this
 *              transaction, issued for the authenticated grant (revoked/expired → refused)
 * 11b signing  D-1: intent → signing (anchored, binding the capability id) before the signer is contacted;
 *              no refusal ever releases an intent: issuance is external (CORE-02 custody), so a valid
 *              capability may exist even when the Host saw a failure — only the ledger releases it
 * 11 sign      DelegatedOfferSigningPort, carrying the capability → verified, SIGNED_NOT_SUBMITTED
 * 12 reserve   durable, CORE-07-anchored, continuing exactly the signing intent, before anything is sent
 * 13 submit    submitReserved ONCE: the submit site claims the reservation for exactly this blob
 * 14 finality  validated reads only; tesSUCCESS = the transaction applied (NOT a fill)
 * ```
 *
 * No retry anywhere: not of a read that failed, not of a signature, not of a
 * submission. An execution that was signed is never signed again.
 */

/** The only value that lets the executor run on facts from a profile admitting simulated sources. Passed in code by qualification tests — never read from configuration. */
export const TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT = 'simulated-facts-offline-qualification-only' as const;

export const TRADE_EXECUTOR_LIMITS = Object.freeze({
  /** ≤ the historical bound every XRPL domain's restart quarantine assumes (shared with PAY-03). */
  lastLedgerOffset: Object.freeze({ minimum: 2, maximum: XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET }),
  observationSpanLedgers: Object.freeze({ minimum: 0, maximum: 10 }),
  finalityTimeoutMs: Object.freeze({ minimum: 0, maximum: 600_000 }),
  pollIntervalMs: Object.freeze({ minimum: 1, maximum: 60_000 }),
  maxValidatedLedgerAgeSeconds: Object.freeze({ minimum: 1, maximum: 60 }),
  requestTimeoutMs: Object.freeze({ minimum: 1, maximum: 60_000 }),
  /** 1 XRP: the same ceiling the TRADE-04B signer client enforces. */
  maximumFeeDrops: 1_000_000n,
});

export interface TradeExecutionPair {
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  /** The delegate's pinned signing public key (the TRADE-04B signer pin). */
  readonly signingPublicKey: string;
}

export interface TradeOfferExecutorConfiguration {
  /** The adapter id the Host routes the trade action to. */
  readonly adapterId: string;
  /** The governed action that is a delegated OfferCreate in this deployment. */
  readonly action: string;
  readonly network: TradeNetwork;
  readonly pairs: readonly TradeExecutionPair[];
  /** The fee every order carries, in drops. Never autofilled, never escalated. */
  readonly feeDrops: string;
  readonly maximumFeeDrops: string;
  readonly lastLedgerOffset: number;
  /** How many ledgers past the reference V a delegation / account observation may be (0 = the same ledger). */
  readonly observationSpanLedgers: number;
  readonly maxValidatedLedgerAgeSeconds: number;
  readonly requestTimeoutMs: number;
  readonly finalityTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** TRADE-02 delegation policy (source id and freshness bound) the execution-time verification applies. */
  readonly delegationPolicy: TradeDelegationPolicy;
}

/** The ledger capability the executor holds: validated reads, and the one reservation-gated write. */
export interface TradeExecutionLedger {
  connect(): Promise<void>;
  serverInfo(): Promise<unknown>;
  ledgerHeader(index: number): Promise<unknown>;
  ledgerEntry(request: Readonly<Record<string, unknown>>): Promise<unknown>;
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
  submitReserved(executionId: string, signedTransaction: string): Promise<unknown>;
}

export type TradeExecutionInterlock = Pick<DurableTradeSequenceInterlock, 'recorded' | 'readIntent' | 'blocking' | 'recordIntent' | 'markSigning' | 'reserve' | 'markUnconfirmed' | 'settle'>;

export interface TradeExecutionLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** One governed execution's preflight facts and outcome — public identifiers, digests and ledger references only. */
export interface TradeExecutionTrace {
  readonly executionId: string;
  readonly detail?: TradeExecutionDetail | string;
  readonly outcome: ExecutionAdapterResult['outcome'];
  readonly transactionHash?: string;
  readonly signingRequests: number;
  readonly submissionRequests: number;
  /** TRADE-04C-S1: the capability issued for this execution (also the key of the signer's consumption ledger, beside the execution id). */
  readonly capabilityId?: string;
  readonly evidence?: TradeReservationEvidence;
  readonly timings: Readonly<Record<string, number>>;
}

export interface TradeOfferExecutorOptions {
  readonly configuration: TradeOfferExecutorConfiguration;
  readonly attested: TradeAttestedProposalSource;
  readonly signer: DelegatedOfferSigningPort;
  /**
   * TRADE-04C-S1 — the per-order signing authorization: the CORE-02 capability
   * issuer (bound by the Host composition once the authenticated grant store
   * and the authority signer exist) and the deployment's trust-domain id every
   * capability names. No capability, no signature.
   */
  readonly authorization: { readonly trustDomain: string; readonly issuer: DelegatedOfferCapabilityIssuer };
  readonly ledger: TradeExecutionLedger;
  readonly interlock: TradeExecutionInterlock;
  /** Whether the ledger client is the configured network's SDK client or a trusted in-process injection (recorded in every reservation's evidence). */
  readonly ledgerProvenance: 'xrpl-network' | 'injected-ledger-client';
  /** Required to execute on facts from a profile admitting simulated sources (qualification only). */
  readonly simulation?: typeof TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT;
  readonly logger?: TradeExecutionLogger;
  /** Receives every execution's trace. Errors are swallowed; it can never change an outcome. */
  readonly onTrace?: (trace: TradeExecutionTrace) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Injected for deterministic qualification (the reader's per-request timer). */
  readonly timer?: { set(callback: () => void, milliseconds: number): unknown; clear(handle: unknown): void };
}

export interface TradeOfferExecutionAdapter extends ExecutionAdapter {
  /** Boot readiness: the configured network answers a validated ledger (also starts the restart quarantine's progress floor). */
  readiness(): Promise<{ readonly status: 'ready' } | { readonly status: 'unavailable'; readonly detail: string }>;
}

export class TradeExecutorConfigurationError extends Error {
  readonly code = 'TRADE_EXECUTOR_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TradeExecutorConfigurationError';
  }
}

const F = EXECUTION_FAILURE_REASONS;
const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FEE = /^[1-9][0-9]{0,15}$/;
const TRADE_DIMENSIONS = Object.values(TRADE_PARAMETER_DIMENSION_IDS);

/** Leaves the preflight with a definitive refusal: nothing was signed or submitted. */
class Refusal {
  constructor(
    readonly reason: ExecutionFailureReason,
    readonly detail: TradeExecutionDetail,
  ) {}
}

function boundedInteger(value: unknown, limits: { readonly minimum: number; readonly maximum: number }, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < limits.minimum || value > limits.maximum) throw new TradeExecutorConfigurationError(`${name} must be an integer from ${limits.minimum} to ${limits.maximum}.`);
  return value;
}

/** Exact decimal equality without floating point: "100", "100.0" and "1e2"-free canonical forms compare by value. */
function sameDecimal(left: string, right: string): boolean {
  const normalize = (text: string): string | undefined => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (match === null) return undefined;
    const integer = match[1]!.replace(/^0+(?=\d)/, '');
    const fraction = (match[2] ?? '').replace(/0+$/, '');
    return fraction.length > 0 ? `${integer}.${fraction}` : integer;
  };
  const a = normalize(left);
  return a !== undefined && a === normalize(right);
}

function digestOf(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(`${domain}\n${canonicalTradeJson(value)}`).digest('hex')}`;
}

/** The OfferCreate prepared from the attested proposal's terms alone, plus the operational fields the executor fixed — the one derivation the signer re-checks (`preparedDelegatedOfferFromProposal`). */
const buildOffer = preparedDelegatedOfferFromProposal;

/**
 * Every bound term of the validated action, against the attested proposal.
 * Answers the proposal and its terms, or `undefined`: nothing is read, signed
 * or submitted for an action that does not bind exactly.
 */
function bind(action: ValidatedExecutionAction, attested: TradeAttestedProposal | undefined, binding: { readonly action: string }): { readonly proposal: TradeProposal; readonly flagsValue: number; readonly digest: string } | 'unbound' | 'unattested' {
  const parameters = action.parameters;
  if (action.action !== binding.action || !Array.isArray(parameters) || parameters.length !== TRADE_DIMENSIONS.length) return 'unbound';
  const values = new Map<string, string>();
  for (const parameter of parameters) {
    if (parameter?.type !== 'token' || typeof parameter.value !== 'string' || !TRADE_DIMENSIONS.includes(parameter.dimension as never) || values.has(parameter.dimension)) return 'unbound';
    values.set(parameter.dimension, parameter.value);
  }
  const digest = values.get(TRADE_PARAMETER_DIMENSION_IDS.proposalDigest);
  if (digest === undefined) return 'unbound';
  if (attested === undefined || attested.proposalDigest !== digest) return 'unattested';
  // Re-validated and recompiled here, for the attested identity: the grant's digest names exactly this proposal.
  const validation = validateTradeProposal(attested.proposal);
  if (!validation.valid || validation.accepted.digest !== digest) return 'unbound';
  let intent;
  try {
    intent = compileTradeProposal(validation.accepted.proposal, binding, { organizationId: attested.organizationId, principalId: attested.principalId }).intent;
  } catch {
    return 'unbound';
  }
  if (intent.action !== action.action || intent.resource !== action.resource || attested.resource !== action.resource || attested.action !== action.action) return 'unbound';
  if (action.organization !== attested.organizationId || action.subject !== attested.actorId) return 'unbound';
  const amount = action.amount;
  if (amount === undefined || amount.unit !== intent.amount.currency || !sameDecimal(amount.value, intent.amount.value)) return 'unbound';
  for (const dimension of TRADE_DIMENSIONS) if (values.get(dimension) !== intent.parameters[dimension]) return 'unbound';
  return { proposal: validation.accepted.proposal, flagsValue: validation.accepted.terms.flagsValue, digest };
}

export function createTradeOfferExecutionAdapter(options: TradeOfferExecutorOptions): TradeOfferExecutionAdapter {
  const configuration = options?.configuration;
  if (configuration === null || typeof configuration !== 'object') throw new TradeExecutorConfigurationError('The trade executor needs its configuration.');
  if (typeof configuration.adapterId !== 'string' || !ADAPTER_ID.test(configuration.adapterId)) throw new TradeExecutorConfigurationError('adapterId must be a semantic identifier.');
  const binding = createTradeGovernanceBinding({ action: configuration.action });
  if (!Object.prototype.hasOwnProperty.call(TRADE_NETWORKS, configuration.network)) throw new TradeExecutorConfigurationError('network must be an XRPL Testnet or Devnet trade network.');
  const networkId = TRADE_NETWORKS[configuration.network].networkId;
  const L = TRADE_EXECUTOR_LIMITS;
  const lastLedgerOffset = boundedInteger(configuration.lastLedgerOffset, L.lastLedgerOffset, 'lastLedgerOffset');
  const span = boundedInteger(configuration.observationSpanLedgers, L.observationSpanLedgers, 'observationSpanLedgers');
  const finalityTimeoutMs = boundedInteger(configuration.finalityTimeoutMs, L.finalityTimeoutMs, 'finalityTimeoutMs');
  const pollIntervalMs = boundedInteger(configuration.pollIntervalMs, L.pollIntervalMs, 'pollIntervalMs');
  const maxAge = boundedInteger(configuration.maxValidatedLedgerAgeSeconds, L.maxValidatedLedgerAgeSeconds, 'maxValidatedLedgerAgeSeconds');
  const requestTimeoutMs = boundedInteger(configuration.requestTimeoutMs, L.requestTimeoutMs, 'requestTimeoutMs');
  if (typeof configuration.maximumFeeDrops !== 'string' || !FEE.test(configuration.maximumFeeDrops) || BigInt(configuration.maximumFeeDrops) > L.maximumFeeDrops) throw new TradeExecutorConfigurationError('maximumFeeDrops must be a positive whole number of drops, at most 1 XRP.');
  if (typeof configuration.feeDrops !== 'string' || !FEE.test(configuration.feeDrops) || BigInt(configuration.feeDrops) > BigInt(configuration.maximumFeeDrops)) throw new TradeExecutorConfigurationError('feeDrops must be a positive whole number of drops within maximumFeeDrops.');
  const delegationPolicy = parseTradeDelegationPolicy(configuration.delegationPolicy);
  if (delegationPolicy === undefined) throw new TradeExecutorConfigurationError('delegationPolicy must be a TRADE-02 delegation policy.');
  if (!Array.isArray(configuration.pairs) || configuration.pairs.length === 0) throw new TradeExecutorConfigurationError('At least one owner/delegate pair is required.');
  const pairs = new Map<string, TradeExecutionPair>();
  for (const pair of configuration.pairs) {
    if (pairs.has(pair.ownerAccount)) throw new TradeExecutorConfigurationError('An owner account may have exactly one configured delegate.');
    pairs.set(pair.ownerAccount, Object.freeze({ ownerAccount: pair.ownerAccount, delegateAccount: pair.delegateAccount, signingPublicKey: pair.signingPublicKey }));
  }
  const attestedSource = options.attested;
  if (typeof attestedSource?.attestedProposal !== 'function') throw new TradeExecutorConfigurationError('The TRADE-03 attested-proposal source is required.');
  const signer = options.signer;
  if (typeof signer?.signDelegatedOffer !== 'function') throw new TradeExecutorConfigurationError('The TRADE-04B signing port is required.');
  const authorization = options.authorization;
  if (typeof authorization?.issuer?.issue !== 'function' || typeof authorization.trustDomain !== 'string' || authorization.trustDomain.length === 0) {
    throw new TradeExecutorConfigurationError('The TRADE-04C-S1 signing authorization (capability issuer and trust domain) is required.');
  }
  const ledger = options.ledger;
  for (const method of ['connect', 'serverInfo', 'ledgerHeader', 'ledgerEntry', 'validatedLedgerIndex', 'lookupTransaction', 'submitReserved'] as const) {
    if (typeof ledger?.[method] !== 'function') throw new TradeExecutorConfigurationError(`The ledger capability must implement ${method}.`);
  }
  const interlock = options.interlock;
  for (const method of ['recorded', 'readIntent', 'blocking', 'recordIntent', 'markSigning', 'reserve', 'markUnconfirmed', 'settle'] as const) {
    if (typeof interlock?.[method] !== 'function') throw new TradeExecutorConfigurationError(`The trade interlock must implement ${method}.`);
  }
  if (options.ledgerProvenance !== 'xrpl-network' && options.ledgerProvenance !== 'injected-ledger-client') throw new TradeExecutorConfigurationError('ledgerProvenance must be stated.');
  if (options.simulation !== undefined && options.simulation !== TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT) throw new TradeExecutorConfigurationError('The simulation acknowledgement is a fixed value.');
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const iso = (): string => new Date(now()).toISOString();
  const logger = options.logger;
  const log = (level: 'info' | 'warn', event: string, fields: Readonly<Record<string, unknown>>): void => {
    try {
      logger?.[level](event, { adapterId: configuration.adapterId, ...fields });
    } catch {
      // A logger defect never changes an outcome.
    }
  };

  // The validated reader and the TRADE-02 verifier, over the same ledger capability's three reads.
  const readPort = Object.freeze({
    serverInfo: () => ledger.serverInfo(),
    ledgerHeader: (index: number) => ledger.ledgerHeader(index),
    ledgerEntry: (request: Readonly<Record<string, unknown>>) => ledger.ledgerEntry(request),
  });
  const reader: XrplValidatedLedgerReader = createXrplValidatedLedgerReader({
    port: readPort,
    networkId,
    maxValidatedLedgerAgeSeconds: maxAge,
    requestTimeoutMs,
    maxResponseBytes: 65_536,
    ...(options.timer !== undefined ? { timer: options.timer } : {}),
  });
  const verifier = createXrplDelegationVerifier({
    port: { serverInfo: () => ledger.serverInfo(), ledgerEntryDelegate: (request) => ledger.ledgerEntry({ ...request }) },
    network: configuration.network,
    clock: iso,
    maxValidatedLedgerAgeSeconds: maxAge,
    policy: delegationPolicy,
  });
  const quarantine = createXrplRestartQuarantine(now());
  const closeTimeOf = async (index: number): Promise<number | undefined> => {
    const header = await reader.ledgerHeader(index);
    return header.outcome === 'read' ? header.value.closeTime : undefined;
  };

  /** One order at a time per owner, preparation through submission, so this process never reads one Sequence for two orders. */
  const ownerQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const previous = ownerQueues.get(owner) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    ownerQueues.set(owner, settled);
    void settled.then(() => {
      if (ownerQueues.get(owner) === settled) ownerQueues.delete(owner);
    });
    return next;
  }

  const failed = (reason: ExecutionFailureReason, detail: string): ExecutionAdapterResult => Object.freeze({ outcome: 'failed', reason, detail });
  const unconfirmed = (hash: string, detail: string): ExecutionAdapterResult => Object.freeze({ outcome: 'unconfirmed', providerRef: hash, detail });

  async function readiness(): Promise<{ readonly status: 'ready' } | { readonly status: 'unavailable'; readonly detail: string }> {
    try {
      await ledger.connect();
    } catch {
      return { status: 'unavailable', detail: D.NETWORK_UNAVAILABLE };
    }
    const validated = await reader.validatedLedger();
    if (validated.outcome !== 'read') return { status: 'unavailable', detail: validated.failure };
    quarantine.observe(validated.value.ledgerIndex);
    return { status: 'ready' };
  }

  interface Prepared {
    readonly offer: PreparedDelegatedOffer;
    readonly validated: number;
    readonly evidence: Omit<TradeReservationEvidence, 'signerId' | 'signerRequestId' | 'preparedDigest'>;
  }

  /** Steps 4–10. Throws `Refusal` only; nothing here signs or writes. */
  async function preflight(action: ValidatedExecutionAction, bound: { readonly proposal: TradeProposal; readonly flagsValue: number; readonly digest: string }, pair: TradeExecutionPair, timings: Record<string, number>): Promise<Prepared> {
    const t0 = now();
    try {
      await ledger.connect();
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.NETWORK_UNAVAILABLE);
    }
    const reference = await reader.validatedLedger();
    if (reference.outcome !== 'read') throw new Refusal(F.PROVIDER_UNAVAILABLE, D.LEDGER_UNVALIDATED);
    const V = reference.value.ledgerIndex;
    quarantine.observe(V);
    if (await quarantine.quarantined(V, closeTimeOf)) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.RESTART_QUARANTINE);
    const t1 = now();
    timings['ledgerReference'] = t1 - t0;

    // TRADE-02, fresh: never the assessment the governed path relied on.
    const request = tradeDelegationRequestFor(bound.proposal, bound.digest);
    if (!request.valid) throw new Refusal(F.ADAPTER_ERROR, D.NOT_BOUND);
    let delegation: TradeDelegationAssessment;
    try {
      delegation = await verifier.verify(request.request, { minimumValidatedLedgerIndex: V });
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.DELEGATION_UNAVAILABLE);
    }
    if (delegation.status === 'NOT_AUTHORIZED') throw new Refusal(F.PROVIDER_REJECTED, D.DELEGATION_NOT_AUTHORIZED);
    if (delegation.status !== 'AUTHORIZED' || delegation.facts === undefined || delegation.factsDigest === undefined) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.DELEGATION_UNAVAILABLE);
    const facts = delegation.facts;
    if (facts.owner !== pair.ownerAccount || facts.delegate !== pair.delegateAccount || facts.networkId !== networkId || facts.state !== 'granted' || delegation.permissionReading?.offerCreateGranted !== true || delegation.permissionReading.withinTradingScope !== true) {
      throw new Refusal(F.PROVIDER_REJECTED, D.DELEGATION_NOT_AUTHORIZED);
    }
    const t2 = now();
    timings['delegation'] = t2 - t1;

    // The delegate's key binding and the owner's Sequence, each from a validated AccountRoot.
    const [delegateRoot, ownerRoot] = [await reader.ledgerEntry({ account_root: pair.delegateAccount }), await reader.ledgerEntry({ account_root: pair.ownerAccount })];
    if (delegateRoot.outcome !== 'read' || delegateRoot.value.entry.state !== 'present') throw new Refusal(F.PROVIDER_UNAVAILABLE, D.DELEGATE_KEY_NOT_AUTHORIZED);
    const key = assessXrplDelegateSigningKey(delegateRoot.value.entry.node, { delegate: pair.delegateAccount, signingPublicKey: pair.signingPublicKey });
    if (!key.authorized) throw new Refusal(F.PROVIDER_REJECTED, D.DELEGATE_KEY_NOT_AUTHORIZED);
    if (ownerRoot.outcome !== 'read' || ownerRoot.value.entry.state !== 'present') throw new Refusal(F.PROVIDER_UNAVAILABLE, D.OWNER_SEQUENCE_UNAVAILABLE);
    const sequence = readXrplOwnerSequence(ownerRoot.value.entry.node, pair.ownerAccount);
    if (sequence === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.OWNER_SEQUENCE_UNAVAILABLE);
    // One bounded window of ledgers: never facts from before the reference, never far after it.
    for (const index of [facts.validatedLedgerIndex, delegateRoot.value.ledgerIndex, ownerRoot.value.ledgerIndex]) {
      if (index < V || index > V + span) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.OBSERVATION_INCONSISTENT);
    }
    if (bound.proposal.expiration !== undefined) {
      const closeTime = await closeTimeOf(V);
      if (closeTime === undefined) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.LEDGER_UNVALIDATED);
      if (bound.proposal.expiration <= closeTime) throw new Refusal(F.PROVIDER_REJECTED, D.OFFER_EXPIRED);
    }
    // The grant's own lifetime bounds the order: nothing is signed after notAfter.
    if (!(Date.parse(action.notAfter) > now())) throw new Refusal(F.ADAPTER_ERROR, D.NOT_BOUND);
    const t3 = now();
    timings['accounts'] = t3 - t2;

    const offer = buildOffer(bound.proposal, bound.flagsValue, { sequence, fee: configuration.feeDrops, lastLedgerSequence: V + lastLedgerOffset });
    let blocked: boolean;
    try {
      blocked = (await interlock.blocking({ account: pair.ownerAccount, sequence, validatedLedgerIndex: V })) === true;
    } catch {
      throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
    }
    if (blocked) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SEQUENCE_IN_FLIGHT);
    timings['blocking'] = now() - t3;
    return {
      offer,
      validated: V,
      evidence: {
        organizationId: action.organization ?? '',
        subject: action.subject,
        requestId: action.correlation.requestId,
        decisionId: action.correlation.decisionId,
        boundedGrantId: action.boundedGrantId,
        proposalDigest: bound.digest,
        delegateAccount: pair.delegateAccount,
        signingPublicKey: pair.signingPublicKey,
        keyAuthority: key.via,
        delegationAssessmentDigest: delegation.digest,
        delegationFactsDigest: delegation.factsDigest,
        referenceLedgerIndex: V,
        referenceLedgerHash: reference.value.ledgerHash,
        delegationLedgerIndex: facts.validatedLedgerIndex,
        delegateRootLedgerIndex: delegateRoot.value.ledgerIndex,
        ownerRootLedgerIndex: ownerRoot.value.ledgerIndex,
        fee: configuration.feeDrops,
        ledgerProvenance: options.ledgerProvenance,
      },
    };
  }

  /**
   * After the one submission: validated reads until a ledger fact or the budget.
   * TRADE-04D: each answer is bound to the transaction's identity (owner,
   * delegate, type, `Sequence`, `LastLedgerSequence`, window); one that does
   * not bind is unreadable — not an outcome.
   */
  async function awaitFinality(executionId: string, identity: TradeTransactionIdentity): Promise<{ readonly result: ExecutionAdapterResult; readonly settlement?: TradeInterlockSettlement; readonly detail?: string }> {
    const hash = identity.transactionHash;
    const window = { minLedger: identity.minLedger, maxLedger: identity.lastLedgerSequence };
    const deadline = now() + finalityTimeoutMs;
    const remaining = (): number => deadline - now();
    for (;;) {
      if (remaining() <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining()));
      let before: number | undefined;
      let reading: ReturnType<typeof readTradeInclusion>['reading'];
      try {
        // The validated index FIRST: if it already reached the window's end, every ledger the lookup searches was validated before it ran.
        before = readXrplLedgerIndex(await ledger.validatedLedgerIndex(Math.max(1, Math.min(requestTimeoutMs, remaining()))));
        reading = readTradeInclusion(await ledger.lookupTransaction({ hash, ...window }, Math.max(1, Math.min(requestTimeoutMs, remaining()))), identity).reading;
      } catch {
        continue; // a failed read is not an outcome
      }
      if (reading.kind === 'validated') {
        if (reading.engineResult === 'tesSUCCESS') {
          log('info', 'trade.offer.validated', { executionId, transactionHash: hash });
          return { result: Object.freeze({ outcome: 'completed', providerRef: hash }), settlement: 'validated-success', detail: reading.engineResult };
        }
        if (reading.engineResult.startsWith('tec')) {
          log('warn', 'trade.offer.failed', { executionId, transactionHash: hash, engineResult: reading.engineResult });
          return { result: Object.freeze({ outcome: 'failed', reason: F.PROVIDER_REJECTED, providerRef: hash, detail: reading.engineResult }), settlement: 'validated-failure', detail: reading.engineResult };
        }
        return { result: unconfirmed(hash, D.RESULT_UNRECOGNIZED) };
      }
      if (xrplNonInclusionProven(reading, before, window.maxLedger)) {
        return { result: Object.freeze({ outcome: 'failed', reason: F.PROVIDER_REJECTED, providerRef: hash, detail: D.TRANSACTION_EXPIRED }), settlement: 'expired', detail: D.TRANSACTION_EXPIRED };
      }
    }
    return { result: unconfirmed(hash, D.FINALITY_UNKNOWN) };
  }

  async function settleQuietly(executionId: string, hash: string, settlement: TradeInterlockSettlement | undefined, detail: string | undefined): Promise<void> {
    try {
      if (settlement === undefined) await interlock.markUnconfirmed(executionId, hash, detail);
      else await interlock.settle(executionId, hash, settlement, detail);
    } catch {
      log('warn', 'trade.interlock.update_failed', { executionId, transactionHash: hash });
    }
  }

  function emit(trace: TradeExecutionTrace): void {
    try {
      options.onTrace?.(Object.freeze(trace));
    } catch {
      // Observers never change an outcome.
    }
  }

  async function execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
    const executionId = action?.correlation?.executionId;
    const timings: Record<string, number> = {};
    let signingRequests = 0;
    let submissionRequests = 0;
    let capabilityId: string | undefined;
    const started = now();
    const finish = (result: ExecutionAdapterResult, extra: { readonly transactionHash?: string; readonly evidence?: TradeReservationEvidence } = {}): ExecutionAdapterResult => {
      timings['total'] = now() - started;
      emit({
        executionId: String(executionId),
        outcome: result.outcome,
        ...('detail' in result && result.detail !== undefined ? { detail: result.detail } : {}),
        signingRequests,
        submissionRequests,
        ...(capabilityId !== undefined ? { capabilityId } : {}),
        timings: Object.freeze({ ...timings }),
        ...extra,
      });
      return result;
    };
    if (typeof executionId !== 'string') return finish(failed(F.ADAPTER_ERROR, D.NOT_BOUND));

    // ── 1–2: the grant-bound action, exactly ──
    const digestParameter = Array.isArray(action.parameters) ? action.parameters.find((parameter) => parameter?.dimension === TRADE_PARAMETER_DIMENSION_IDS.proposalDigest) : undefined;
    const attested = typeof digestParameter?.value === 'string' ? attestedSource.attestedProposal(digestParameter.value) : undefined;
    const bound = bind(action, attested, binding);
    timings['binding'] = now() - started;
    if (bound === 'unbound') return finish(failed(F.ADAPTER_ERROR, D.NOT_BOUND));
    if (bound === 'unattested') return finish(failed(F.ADAPTER_ERROR, D.PROPOSAL_UNAVAILABLE));
    if (attested!.simulatedSources && options.simulation !== TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT) return finish(failed(F.ADAPTER_ERROR, D.SIMULATED_FACTS));
    const pair = pairs.get(bound.proposal.ownerAccount);
    if (pair === undefined || pair.delegateAccount !== bound.proposal.delegateAccount || bound.proposal.network !== configuration.network) return finish(failed(F.ADAPTER_ERROR, D.PAIR_NOT_CONFIGURED));

    try {
      return await serialized(pair.ownerAccount, async () => {
        // ── 3: never twice ──
        let earlier: string | undefined;
        let attempted: boolean;
        try {
          earlier = await interlock.recorded(executionId);
          // D-1: an intent alone (no reservation) is an attempt too — its signer may already have been contacted.
          attempted = earlier !== undefined || (await interlock.readIntent(executionId)) !== undefined;
        } catch {
          return finish(failed(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE));
        }
        if (typeof earlier === 'string') return finish(unconfirmed(earlier, D.PREVIOUSLY_RECORDED), { transactionHash: earlier });
        if (attempted) return finish(Object.freeze({ outcome: 'unconfirmed', detail: D.PREVIOUSLY_RECORDED }));

        // ── 4–10 ──
        const prepared = await preflight(action, bound, pair, timings);

        const signingPreimageDigest = delegatedOfferSigningPreimageDigest(prepared.offer, pair.signingPublicKey);
        if (signingPreimageDigest === undefined) throw new Refusal(F.ADAPTER_ERROR, D.NOT_BOUND);
        const preparedDigest = digestOf('frontera.trade-prepared-offer.v1', prepared.offer);

        // ── 10a (TRADE-04D D-1): the durable, anchored intent — before any capability exists ──
        const ti = now();
        let intent: TradeIntentOutcome;
        try {
          intent = await interlock.recordIntent(
            {
              executionId,
              account: pair.ownerAccount,
              sequence: prepared.offer.Sequence,
              lastLedgerSequence: prepared.offer.LastLedgerSequence,
              minLedger: prepared.validated + 1,
              signingPreimageDigest,
              evidence: { ...prepared.evidence, preparedDigest, trustDomain: authorization.trustDomain, network: configuration.network },
            },
            prepared.validated,
          );
        } catch {
          throw new Refusal(F.ADAPTER_ERROR, D.INTENT_FAILED);
        }
        timings['intent'] = now() - ti;
        if (intent?.outcome === 'blocked') throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SEQUENCE_IN_FLIGHT);
        // Attempted before (by this or another process): never prepared, issued or signed again.
        if (intent?.outcome === 'execution-recorded') {
          return finish(Object.freeze({ outcome: 'unconfirmed', ...(intent.transactionHash !== undefined ? { providerRef: intent.transactionHash } : {}), detail: D.PREVIOUSLY_RECORDED }), intent.transactionHash !== undefined ? { transactionHash: intent.transactionHash } : {});
        }
        if (intent?.outcome !== 'recorded') throw new Refusal(F.ADAPTER_ERROR, D.INTENT_FAILED);
        // From here every refusal leaves the intent open: it holds the owner Sequence until the validated ledger
        // reaches LastLedgerSequence or P12 records the owner-Sequence proof. A capability request that failed,
        // timed out or was refused is never read as "no capability exists" (the authority signer is external).

        // ── 11a (TRADE-04C-S1): the CORE-02 signing capability for exactly this transaction ──
        const tc = now();
        let issued: IssuedDelegatedOfferCapability;
        try {
          issued = await authorization.issuer.issue({
            trustDomain: authorization.trustDomain,
            executionId,
            boundedGrantId: action.boundedGrantId,
            organizationId: action.organization ?? '',
            proposalDigest: bound.digest,
            network: configuration.network,
            ownerAccount: pair.ownerAccount,
            delegateAccount: pair.delegateAccount,
            signingPreimageDigest,
            sequence: prepared.offer.Sequence,
            fee: prepared.offer.Fee,
            lastLedgerSequence: prepared.offer.LastLedgerSequence,
          });
        } catch (error) {
          const code = error instanceof DelegatedOfferCapabilityError ? error.code : undefined;
          // An authority that answered "no" (revoked, absent, not this grant's terms) is a refusal; anything else is unavailability.
          if (code === 'CAPABILITY_REFUSED' || code === 'CAPABILITY_GRANT_REVOKED' || code === 'CAPABILITY_GRANT_NOT_FOUND' || code === 'CAPABILITY_REQUEST_INVALID') throw new Refusal(F.PROVIDER_REJECTED, D.CAPABILITY_REFUSED);
          throw new Refusal(F.PROVIDER_UNAVAILABLE, D.CAPABILITY_UNAVAILABLE);
        }
        if (issued.capability.executionId !== executionId || issued.capability.boundedGrantId !== action.boundedGrantId || issued.capability.signingPreimageDigest !== signingPreimageDigest) throw new Refusal(F.ADAPTER_ERROR, D.CAPABILITY_REFUSED);
        capabilityId = issued.capability.capabilityId;
        timings['capability'] = now() - tc;

        // ── 11b (D-1): the point of no return, durable and anchored BEFORE the signer is contacted ──
        try {
          await interlock.markSigning(executionId, issued.capability.capabilityId);
        } catch {
          // Not provably recorded: the signer is never contacted, and the intent stays open.
          throw new Refusal(F.ADAPTER_ERROR, D.INTENT_FAILED);
        }

        // ── 11: the protected signer, below the bounded grant ──
        const t0 = now();
        let signature: VerifiedDelegatedOfferSignature;
        try {
          signingRequests += 1;
          signature = await signer.signDelegatedOffer({ transaction: prepared.offer, proposal: bound.proposal, authorization: { capability: issued.canonical, signature: issued.signature }, validatedLedgerIndex: prepared.validated });
        } catch (error) {
          const reason = error instanceof DelegatedOfferSignerError ? error.reason : undefined;
          if (reason === 'OFFER_SIGNER_SIGNATURE_INVALID' || reason === 'OFFER_SIGNER_RESPONSE_MISMATCH' || reason === 'OFFER_SIGNER_IDENTITY_MISMATCH') throw new Refusal(F.ADAPTER_ERROR, D.SIGNATURE_REJECTED);
          if (reason === 'OFFER_SIGNER_REFUSED' || reason === 'OFFER_SIGNER_REQUEST_INVALID') throw new Refusal(F.PROVIDER_REJECTED, D.SIGNER_REFUSED);
          throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SIGNER_UNAVAILABLE);
        }
        // Independently of the client's own verification: the signature is for exactly this owner, delegate, key, offer and capability.
        if (
          signature?.status !== 'signed-not-submitted' ||
          signature.capabilityId !== issued.capability.capabilityId ||
          signature.executionId !== executionId ||
          signature.ownerAccount !== pair.ownerAccount ||
          signature.delegateAccount !== pair.delegateAccount ||
          signature.signingPublicKey !== pair.signingPublicKey ||
          canonicalTradeJson(signature.transaction) !== canonicalTradeJson(prepared.offer) ||
          typeof signature.hash !== 'string' ||
          typeof signature.signedTransaction !== 'string'
        ) {
          throw new Refusal(F.ADAPTER_ERROR, D.SIGNATURE_REJECTED);
        }
        timings['signing'] = now() - t0;
        log('info', 'trade.offer.signed', { executionId, transactionHash: signature.hash });

        // ── 12: durable before the submission, or no submission ──
        const t1 = now();
        // From here every refusal leaves the intent `signing`: it holds the window until a ledger fact, never released by this process.
        const evidence: TradeReservationEvidence = { ...prepared.evidence, signerId: signature.signerId, signerRequestId: signature.requestId, preparedDigest };
        let reservation: Awaited<ReturnType<TradeExecutionInterlock['reserve']>>;
        try {
          reservation = await interlock.reserve(
            { executionId, account: pair.ownerAccount, sequence: prepared.offer.Sequence, lastLedgerSequence: prepared.offer.LastLedgerSequence, minLedger: prepared.validated + 1, transactionHash: signature.hash, evidence },
            prepared.validated,
          );
        } catch {
          throw new Refusal(F.ADAPTER_ERROR, D.RESERVATION_FAILED);
        }
        timings['reservation'] = now() - t1;
        if (reservation?.outcome === 'blocked') throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SEQUENCE_IN_FLIGHT);
        if (reservation?.outcome === 'execution-recorded') return finish(unconfirmed(reservation.transactionHash, D.PREVIOUSLY_RECORDED), { transactionHash: reservation.transactionHash });
        if (reservation?.outcome !== 'reserved') throw new Refusal(F.ADAPTER_ERROR, D.RESERVATION_FAILED);

        // ── 13: the one submission ── from here every failure is unconfirmed: the blob may have reached the network.
        const t2 = now();
        let answer: unknown;
        try {
          submissionRequests += 1;
          answer = await ledger.submitReserved(executionId, signature.signedTransaction);
        } catch (error) {
          const code = (error as { readonly code?: unknown } | null)?.code;
          const notSent = code === 'XRPL_SUBMISSION_NOT_ATTEMPTED' || code === 'XRPL_RESERVED_SUBMISSION_REFUSED';
          timings['submission'] = now() - t2;
          // Not sent by Frontera — but a signed blob exists outside this process: kept open, reconciled from the ledger, never reported as failed.
          if (notSent) return finish(unconfirmed(signature.hash, D.SIGNED_NOT_SUBMITTED), { transactionHash: signature.hash, evidence });
          await settleQuietly(executionId, signature.hash, undefined, D.SUBMISSION_OUTCOME_UNKNOWN);
          return finish(unconfirmed(signature.hash, D.SUBMISSION_OUTCOME_UNKNOWN), { transactionHash: signature.hash, evidence });
        }
        timings['submission'] = now() - t2;
        try {
          const submission = readXrplSubmission(answer, signature.hash);
          if (submission.kind === 'unreadable') {
            await settleQuietly(executionId, signature.hash, undefined, D.SUBMISSION_RESPONSE_UNREADABLE);
            return finish(unconfirmed(signature.hash, D.SUBMISSION_RESPONSE_UNREADABLE), { transactionHash: signature.hash, evidence });
          }
          log('info', 'trade.offer.submitted', { executionId, transactionHash: signature.hash, engineResult: submission.engineResult });
          if (submission.kind === 'malformed') {
            await settleQuietly(executionId, signature.hash, 'malformed', submission.engineResult);
            return finish(Object.freeze({ outcome: 'failed', reason: F.PROVIDER_REJECTED, providerRef: signature.hash, detail: submission.engineResult }), { transactionHash: signature.hash, evidence });
          }
          // A provisional answer is never an outcome (ADR-XRPL-SHARED-TRANSPORT): wait for a validated one.
          const t3 = now();
          const identity: TradeTransactionIdentity = { transactionHash: signature.hash, account: pair.ownerAccount, delegateAccount: pair.delegateAccount, sequence: prepared.offer.Sequence, lastLedgerSequence: prepared.offer.LastLedgerSequence, minLedger: prepared.validated + 1 };
          const final = await awaitFinality(executionId, identity);
          timings['finality'] = now() - t3;
          await settleQuietly(executionId, signature.hash, final.settlement, final.settlement === undefined ? ('detail' in final.result ? final.result.detail : undefined) : final.detail);
          return finish(final.result, { transactionHash: signature.hash, evidence });
        } catch {
          await settleQuietly(executionId, signature.hash, undefined, D.ERROR_AFTER_SUBMISSION);
          return finish(unconfirmed(signature.hash, D.ERROR_AFTER_SUBMISSION), { transactionHash: signature.hash, evidence });
        }
      });
    } catch (error) {
      // Reached only before anything was submitted.
      const refusal = error instanceof Refusal ? error : new Refusal(F.ADAPTER_ERROR, D.NOT_BOUND);
      log('warn', 'trade.offer.refused', { executionId, detail: refusal.detail });
      return finish(failed(refusal.reason, refusal.detail));
    }
  }

  return Object.freeze({ adapterId: configuration.adapterId, execute, readiness });
}

