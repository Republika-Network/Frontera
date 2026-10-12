import {
  createPaymentGovernanceBinding,
  isPaymentRailId,
  normalizePaymentFinalityAnswer,
  paymentFinalityMismatch,
  type PaymentFinalityAuthority,
  type PaymentFinalityQuery,
  type PaymentGovernanceBinding,
  type PaymentSettlementMismatch,
  type PaymentSettlementState,
  type PaymentSettlementTerms,
} from '../../features/payment-runtime/index.js';
import { isOpaqueExecutionIdentifier } from './validation.js';
import { readPaymentSettlementBasis, type CanonicalSettlementBasis, type PaymentSettlementBasisSources, type PaymentSettlementBasisUnavailable } from './basis.js';
import type { PaymentReceipt, PaymentSettlementRecord } from './contracts.js';
import { isPaymentSettlementStoreError } from './errors.js';
import { derivePaymentReceipt, paymentFinalityProofDigest } from './integrity.js';
import type { PaymentSettlementStore } from './settlement-store.js';

/**
 * PAY-05 — the payment settlement service: explicit settlement verification,
 * and pure local reads of settlement status and receipts.
 *
 * ```
 * verifySettlement(executionId)
 *   → settlement on record?            verified, its basis re-checked against P11 / P12 → settled (authority NOT asked)
 *   → canonical basis (P11 → P12 → committed decision)
 *                                      not completed / uncertain / unreadable → that answer; authority NOT asked
 *   → the trusted selector names one composed finality authority
 *   → ask it ONCE, outside every transaction; normalize closed
 *        not-final / unavailable / throws / not an answer → nothing written, state unchanged
 *        contradicted                                     → nothing written (P11 / P12 never rewritten)
 *        final → evidence compared EXACTLY with the basis → mismatch: nothing written
 *   → record the settlement (BEGIN IMMEDIATE; same content → existing; different → conflict)
 *   → the receipt, derived from the recorded settlement
 * ```
 *
 * ## It never executes, and never creates execution
 *
 * This file holds no execution adapter, no rail, no signer, no grant writer,
 * no orchestrator and no P7 port; no path here can reach one. Verification
 * observes an execution that already happened. It never retries, resubmits or
 * repeats the original payment, never releases or consumes capacity, never
 * issues or reads authority, and never changes P11 or P12.
 *
 * ## No background work
 *
 * Nothing here polls or schedules. A settlement is established only by an
 * explicit `verifySettlement` from trusted in-process code (an operator, a job
 * the embedder owns, the obligation bridge's caller). `readSettlement` and
 * `receipt` never contact anything.
 *
 * ## Concurrency
 *
 * Calls for the same execution in this process share one in-flight
 * verification. Across processes, two read-only verifications may race; the
 * store's `BEGIN IMMEDIATE` admits one settlement, identical content
 * converges, a different one is `conflict`. No transaction is held across a
 * network call. An established settlement is never overwritten by a later
 * "not final".
 */

/** Trusted, host-side, synchronous selection of the finality authority for one completed payment. Anything but one composed id selects none. */
export type PaymentFinalityAuthoritySelector = (context: { readonly organizationId: string; readonly executionId: string; readonly action: string; readonly railId?: string; readonly rail?: string }) => string;

export interface PaymentSettlementServiceOptions extends PaymentSettlementBasisSources {
  readonly store: PaymentSettlementStore;
  readonly authorities: readonly PaymentFinalityAuthority[];
  readonly selectAuthority: PaymentFinalityAuthoritySelector;
  readonly now: () => string;
}

export interface PaymentSettlementRequest {
  readonly organizationId: string;
  readonly executionId: string;
}

export type PaymentSettlementBasisFailure = PaymentSettlementBasisUnavailable | 'settlement-unreadable' | 'settlement-corrupt' | 'settlement-inconsistent';

/** Closed, and every domain condition a result — never a throw. */
export type PaymentSettlementVerification =
  /** Settled. `established: 'previously'` means it was on record and no authority was asked. */
  | { readonly outcome: 'settled'; readonly established: 'now' | 'previously'; readonly settlement: PaymentSettlementRecord; readonly receipt: PaymentReceipt }
  /** The execution completed; the authority could not establish finality. Nothing written; ask again later, explicitly. */
  | { readonly outcome: 'not-final' }
  /** No finality answer could be obtained. Nothing written. Availability lost; no fact changed. */
  | { readonly outcome: 'authority-unavailable'; readonly reason: 'unselected' | 'failed' | 'invalid-answer' }
  /** The rail contradicts the completed execution. Nothing written; P11 / P12 unchanged; an operator's question. */
  | { readonly outcome: 'finality-contradicted'; readonly reason: string }
  /** A final answer about a different transfer than the canonical one. Refused; nothing written. */
  | { readonly outcome: 'evidence-mismatch'; readonly field: PaymentSettlementMismatch }
  /** The canonical basis does not permit a settlement now (`execution-uncertain`) or ever (`not-settleable`). The authority was not asked. */
  | { readonly outcome: 'not-eligible'; readonly state: 'execution-uncertain' | 'not-settleable' }
  /** No governed execution with this id in this organization (another organization's is indistinguishable from none). */
  | { readonly outcome: 'not-found' }
  /** The execution is not of a payment action. */
  | { readonly outcome: 'not-a-payment' }
  /** Durable state that cannot be believed. The authority was not asked. */
  | { readonly outcome: 'basis-unavailable'; readonly reason: PaymentSettlementBasisFailure }
  /** Final and exact, but the settlement could not be made durable. Nothing is claimed. */
  | { readonly outcome: 'settlement-unrecorded' }
  /** A different settlement was recorded first. The first stands. */
  | { readonly outcome: 'conflict' };

/** The local, read-only status. Never contacts anything. */
export type PaymentSettlementStatus =
  | { readonly outcome: 'status'; readonly state: PaymentSettlementState; readonly settlement?: PaymentSettlementRecord; readonly receipt?: PaymentReceipt }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-a-payment' }
  | { readonly outcome: 'basis-unavailable'; readonly reason: PaymentSettlementBasisFailure };

export interface PaymentSettlementService {
  /** One explicit verification of one execution: at most one finality query, none when a settlement is already on record. */
  verifySettlement(request: PaymentSettlementRequest): Promise<PaymentSettlementVerification>;
  /** The current state, derived from verified durable state. No network, no write. */
  readSettlement(request: PaymentSettlementRequest): Promise<PaymentSettlementStatus>;
  /** The receipt of a recorded settlement, derived from it; `undefined` when not settled or not believable. No network, no write. */
  receipt(request: PaymentSettlementRequest): Promise<PaymentReceipt | undefined>;
}

export class PaymentSettlementConfigurationError extends Error {
  readonly code = 'PAYMENT_SETTLEMENT_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PaymentSettlementConfigurationError';
  }
}

interface ComposedFinalityAuthority {
  readonly authorityId: string;
  readonly verify: (query: PaymentFinalityQuery) => Promise<unknown>;
}

/** Snapshots the trusted authorities once, at composition: membership never changes afterwards and nothing is discovered per request. */
function snapshotFinalityAuthorities(authorities: unknown): ReadonlyMap<string, ComposedFinalityAuthority> {
  if (!Array.isArray(authorities) || authorities.length === 0) throw new PaymentSettlementConfigurationError('authorities must be a non-empty array of finality authorities.');
  const snapshot = new Map<string, ComposedFinalityAuthority>();
  for (const [index, candidate] of [...authorities].entries()) {
    const authorityId = (candidate as { readonly authorityId?: unknown } | null)?.authorityId;
    const verify = (candidate as { readonly verifyFinality?: unknown } | null)?.verifyFinality;
    if (!isOpaqueExecutionIdentifier(authorityId)) throw new PaymentSettlementConfigurationError(`authorities[${String(index)}].authorityId is not a recordable identifier.`);
    if (typeof verify !== 'function') throw new PaymentSettlementConfigurationError(`authorities[${String(index)}].verifyFinality is not a function.`);
    if (snapshot.has(authorityId)) throw new PaymentSettlementConfigurationError(`authorities declares '${authorityId}' more than once.`);
    snapshot.set(authorityId, Object.freeze({ authorityId, verify: (query: PaymentFinalityQuery) => Promise.resolve().then(() => (verify as (query: PaymentFinalityQuery) => unknown).call(candidate, query)) }));
  }
  return snapshot;
}

/** Every axis of two canonical payments, exactly. */
function sameTerms(left: PaymentSettlementTerms, right: PaymentSettlementTerms): boolean {
  return (
    left.source.accountId === right.source.accountId &&
    left.destination.kind === right.destination.kind &&
    left.destination.reference === right.destination.reference &&
    left.amount.value === right.amount.value &&
    left.amount.unit === right.amount.unit &&
    left.purpose === right.purpose &&
    left.reference === right.reference &&
    left.rail === right.rail
  );
}

function queryOf(organizationId: string, basis: CanonicalSettlementBasis): PaymentFinalityQuery {
  const { attempt, terms } = basis;
  return Object.freeze({
    organizationId,
    executionId: attempt.executionId,
    requestId: attempt.requestId,
    decisionId: attempt.decisionId,
    basis: basis.kind,
    ...(basis.railId !== undefined ? { railId: basis.railId } : {}),
    ...(basis.providerRef !== undefined ? { providerRef: basis.providerRef } : {}),
    payment: terms,
  });
}

export function createPaymentSettlementService(options: PaymentSettlementServiceOptions): PaymentSettlementService {
  const { store, outcomes, resolutions, governance, now } = options;
  const authorities = snapshotFinalityAuthorities(options.authorities);
  if (typeof options.selectAuthority !== 'function') throw new PaymentSettlementConfigurationError('selectAuthority must be a synchronous function returning a composed authorityId; there is no default.');
  const select = options.selectAuthority;
  if (!Array.isArray(options.payments) || options.payments.length === 0) throw new PaymentSettlementConfigurationError('payments must name at least one PAY-01 payment binding.');
  const payments: readonly PaymentGovernanceBinding[] = Object.freeze(options.payments.map((binding) => createPaymentGovernanceBinding({ action: binding.action })));
  const sources: PaymentSettlementBasisSources = { outcomes, resolutions, governance, payments };
  const inFlight = new Map<string, Promise<PaymentSettlementVerification>>();

  function selectFor(organizationId: string, basis: CanonicalSettlementBasis): ComposedFinalityAuthority | undefined {
    let selected: unknown;
    try {
      selected = select(
        Object.freeze({
          organizationId,
          executionId: basis.attempt.executionId,
          action: basis.attempt.action,
          ...(basis.railId !== undefined ? { railId: basis.railId } : {}),
          ...(basis.terms.rail !== undefined ? { rail: basis.terms.rail } : {}),
        }),
      );
    } catch {
      return undefined;
    }
    return typeof selected === 'string' ? authorities.get(selected) : undefined;
  }

  /**
   * A settlement on record, verified by its store and re-checked against the
   * current canonical basis: the P11 / P12 records it names must still be the
   * ones on record. A settlement whose basis no longer verifies is never
   * believed — defence in depth against a settlement row written by anything
   * but this service.
   */
  async function believed(request: PaymentSettlementRequest): Promise<{ readonly kind: 'none' } | { readonly kind: 'settled'; readonly settlement: PaymentSettlementRecord } | { readonly kind: 'failed'; readonly reason: PaymentSettlementBasisFailure }> {
    let settlement: PaymentSettlementRecord | undefined;
    try {
      settlement = await store.read({ organizationId: request.organizationId }, request.executionId);
    } catch (error) {
      if (isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_TENANT_VIOLATION') return { kind: 'none' };
      return { kind: 'failed', reason: isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_CORRUPT' ? 'settlement-corrupt' : 'settlement-unreadable' };
    }
    if (settlement === undefined) return { kind: 'none' };
    const reading = await readPaymentSettlementBasis(sources, request.organizationId, request.executionId);
    if (reading.kind === 'unavailable') return { kind: 'failed', reason: reading.reason };
    if (reading.kind !== 'eligible') return { kind: 'failed', reason: 'settlement-inconsistent' };
    const current = reading.basis;
    const recorded = settlement.basis;
    if (
      recorded.kind !== current.basis.kind ||
      recorded.attemptDigest !== current.basis.attemptDigest ||
      recorded.observationDigest !== current.basis.observationDigest ||
      recorded.resolutionDigest !== current.basis.resolutionDigest ||
      settlement.requestId !== current.attempt.requestId ||
      settlement.decisionId !== current.attempt.decisionId ||
      !sameTerms(settlement.payment, current.terms) ||
      (current.providerRef !== undefined && settlement.finality.providerRef !== current.providerRef)
    ) {
      return { kind: 'failed', reason: 'settlement-inconsistent' };
    }
    return { kind: 'settled', settlement };
  }

  async function verifyOnce(request: PaymentSettlementRequest): Promise<PaymentSettlementVerification> {
    const { organizationId, executionId } = request;
    const existing = await believed(request);
    if (existing.kind === 'failed') return { outcome: 'basis-unavailable', reason: existing.reason };
    if (existing.kind === 'settled') return { outcome: 'settled', established: 'previously', settlement: existing.settlement, receipt: derivePaymentReceipt(existing.settlement) };

    const reading = await readPaymentSettlementBasis(sources, organizationId, executionId);
    if (reading.kind === 'not-found') return { outcome: 'not-found' };
    if (reading.kind === 'not-a-payment') return { outcome: 'not-a-payment' };
    if (reading.kind === 'unavailable') return { outcome: 'basis-unavailable', reason: reading.reason };
    if (reading.kind === 'state') return { outcome: 'not-eligible', state: reading.state };
    const basis = reading.basis;

    const authority = selectFor(organizationId, basis);
    if (authority === undefined) return { outcome: 'authority-unavailable', reason: 'unselected' };
    const query = queryOf(organizationId, basis);
    let raw: unknown;
    try {
      raw = await authority.verify(query);
    } catch {
      // Unavailable is not "not settled": nothing is written, nothing changes.
      return { outcome: 'authority-unavailable', reason: 'failed' };
    }
    const answer = normalizePaymentFinalityAnswer(raw);
    if (answer === undefined) return { outcome: 'authority-unavailable', reason: 'invalid-answer' };
    if (answer.outcome === 'not-final') return { outcome: 'not-final' };
    if (answer.outcome === 'contradicted') return { outcome: 'finality-contradicted', reason: answer.reason };
    const evidence = answer.evidence;
    const mismatch = paymentFinalityMismatch(evidence, query);
    if (mismatch !== undefined) return { outcome: 'evidence-mismatch', field: mismatch };

    const finality = {
      authorityId: authority.authorityId,
      method: evidence.method,
      providerRef: evidence.providerRef,
      ...(evidence.finalizedAt !== undefined ? { finalizedAt: evidence.finalizedAt } : {}),
      facts: evidence.facts,
    };
    const railId = basis.railId !== undefined && isPaymentRailId(basis.railId) ? basis.railId : undefined;
    try {
      const recorded = await store.record(
        { organizationId },
        {
          organizationId,
          executionId,
          requestId: basis.attempt.requestId,
          decisionId: basis.attempt.decisionId,
          evaluationId: basis.attempt.evaluationId,
          boundedGrantId: basis.attempt.boundedGrantId,
          action: basis.attempt.action,
          ...(railId !== undefined ? { railId } : {}),
          basis: basis.basis,
          payment: basis.terms,
          finality: { ...finality, proofDigest: paymentFinalityProofDigest(finality) },
          verifiedAt: now(),
        },
      );
      return { outcome: 'settled', established: recorded.outcome === 'recorded' ? 'now' : 'previously', settlement: recorded.settlement, receipt: derivePaymentReceipt(recorded.settlement) };
    } catch (error) {
      if (isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_CONFLICT') return { outcome: 'conflict' };
      return { outcome: 'settlement-unrecorded' };
    }
  }

  function requestOf(request: PaymentSettlementRequest): PaymentSettlementRequest | undefined {
    const organizationId = (request as { readonly organizationId?: unknown } | undefined)?.organizationId;
    const executionId = (request as { readonly executionId?: unknown } | undefined)?.executionId;
    return isOpaqueExecutionIdentifier(organizationId) && isOpaqueExecutionIdentifier(executionId) ? { organizationId, executionId } : undefined;
  }

  return Object.freeze({
    verifySettlement(request: PaymentSettlementRequest): Promise<PaymentSettlementVerification> {
      const checked = requestOf(request);
      if (checked === undefined) return Promise.resolve({ outcome: 'not-found' } as const);
      const key = `${checked.organizationId}\u0000${checked.executionId}`;
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const verification = verifyOnce(checked).finally(() => inFlight.delete(key));
      inFlight.set(key, verification);
      return verification;
    },

    async readSettlement(request: PaymentSettlementRequest): Promise<PaymentSettlementStatus> {
      const checked = requestOf(request);
      if (checked === undefined) return { outcome: 'not-found' };
      const existing = await believed(checked);
      if (existing.kind === 'failed') return { outcome: 'basis-unavailable', reason: existing.reason };
      if (existing.kind === 'settled') return { outcome: 'status', state: 'settled', settlement: existing.settlement, receipt: derivePaymentReceipt(existing.settlement) };
      const reading = await readPaymentSettlementBasis(sources, checked.organizationId, checked.executionId);
      if (reading.kind === 'not-found') return { outcome: 'not-found' };
      if (reading.kind === 'not-a-payment') return { outcome: 'not-a-payment' };
      if (reading.kind === 'unavailable') return { outcome: 'basis-unavailable', reason: reading.reason };
      if (reading.kind === 'state') return { outcome: 'status', state: reading.state };
      return { outcome: 'status', state: 'awaiting-finality' };
    },

    async receipt(request: PaymentSettlementRequest): Promise<PaymentReceipt | undefined> {
      const checked = requestOf(request);
      if (checked === undefined) return undefined;
      const existing = await believed(checked);
      return existing.kind === 'settled' ? derivePaymentReceipt(existing.settlement) : undefined;
    },
  });
}
