import { isWellFormedMonetaryAmount, type MonetaryAmount } from '../../features/monetary-runtime/index.js';
import { PAYMENT_REFUND_REFUSALS, paymentRefundCounted, paymentRefundRefusal, paymentRefundRemaining } from '../../features/payment-runtime/index.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from './validation.js';
import { PaymentSettlementStoreError } from './errors.js';

/**
 * PAY-05 — durable refund accounting (the "refund ledger").
 *
 * An append-only, hash-chained log of two kinds of entry:
 *
 * ```
 * reserve   refund operation R reserves amount A of settled original O
 *           (before R's refund payment is governed)
 * release   R's refund payment is PROVEN to have moved nothing
 *           (decision denied · P11 confirmed-not-completed / withheld · P12 confirmed-not-completed)
 * ```
 *
 * The refundable balance of O is `O.amount − Σ reserve(R) for every R not
 * released`, in exact P9 arithmetic. A reservation is counted from the moment
 * it is durable until its refund is proven not to have happened; an uncertain
 * refund (unconfirmed, unresolved, crashed, merely pending) stays counted — it
 * may have moved money. Nothing else releases: not a timeout, not an operator's
 * wish, not a restart. A completed refund simply stays reserved: its money left.
 *
 * ## Why this is CORE-07-anchored and settlements are not
 *
 * A rollback, stale restore or loss of this log would **recreate refundable
 * balance**: a refund already sent, or still uncertain, would no longer count,
 * and a second refund could move the same money again. That is money-moving
 * eligibility, so the durable log's history is anchored at the CORE-07 witness
 * in its own slot (`payment-refund-state`): every reservation and release is a
 * witness transition completed before it is acknowledged, and an older, lost,
 * forked or pending history is refused at open and before every reservation —
 * nothing is refunded over a history the witness does not hold as current.
 *
 * This is not the P7 ledger and is never written to it: P7 bounds what the
 * refund's *requester* may spend; this bounds how much of one settled payment
 * may ever be refunded, by anyone.
 */

const ENTRY_DOMAIN = 'aoc.payment-refund.entry.v1';
const CHAIN_DOMAIN = 'aoc.payment-refund.chain.v1';
const OPERATION_DOMAIN = 'aoc.payment-refund.operation.v1';

export const PAYMENT_REFUND_LEDGER_SCHEMA_VERSION = 'aoc.payment-refund-ledger.schema.v1';

/** The CORE-07 slot of the refund accounting history. */
export const PAYMENT_REFUND_STATE_KIND = 'payment-refund-state';

/** What proved a refund moved nothing. Closed; each one a definitive canonical fact. */
export const PAYMENT_REFUND_RELEASE_BASES = ['decision-denied', 'execution-withheld', 'provider-confirmed-not-completed', 'resolution-confirmed-not-completed'] as const;
export type PaymentRefundReleaseBasis = (typeof PAYMENT_REFUND_RELEASE_BASES)[number];

export interface PaymentRefundReserveContent {
  readonly kind: 'reserve';
  readonly organizationId: string;
  readonly refundOperationId: string;
  readonly principalId: string;
  readonly refundKey: string;
  readonly originalSettlementId: string;
  readonly originalExecutionId: string;
  readonly originalReceiptId: string;
  /** The original settled amount — the ceiling every reservation of this original states identically. */
  readonly originalAmount: MonetaryAmount;
  readonly amount: MonetaryAmount;
  /** The governed request the refund payment is made under — derived, so a crash never loses it. */
  readonly refundRequestId: string;
}

export interface PaymentRefundReleaseContent {
  readonly kind: 'release';
  readonly organizationId: string;
  readonly refundOperationId: string;
  readonly basis: PaymentRefundReleaseBasis;
  /** The canonical record that proves it (a decision, observation or resolution), by digest or identifier. */
  readonly basisReference: string;
}

export type PaymentRefundEntryContent = PaymentRefundReserveContent | PaymentRefundReleaseContent;

export type PaymentRefundEntry = PaymentRefundEntryContent & {
  readonly schemaVersion: string;
  /** 1-based position in the ledger's history. */
  readonly sequence: number;
  readonly recordedAt: string;
  readonly entryDigest: string;
  /** The hash chain over every entry up to and including this one. */
  readonly chainDigest: string;
};

/** The deterministic identity of one refund operation: one principal's refund key against one settled original. */
export function paymentRefundOperationId(input: { readonly organizationId: string; readonly principalId: string; readonly originalSettlementId: string; readonly refundKey: string }): string {
  return `payment-refund:${computeDigest({ domain: OPERATION_DOMAIN, organizationId: input.organizationId, principalId: input.principalId, originalSettlementId: input.originalSettlementId, refundKey: input.refundKey }).slice('sha256:'.length)}`;
}

/** The governed idempotency key and business reference a refund payment carries — derived from its operation, never the original's. */
export function paymentRefundGovernedKey(refundOperationId: string): string {
  return `refund-${refundOperationId.slice('payment-refund:'.length)}`;
}

export function paymentRefundGenesisDigest(storeId: string, organizationId: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, storeId, organizationId, sequence: 0 });
}

function copyContent(content: PaymentRefundEntryContent): PaymentRefundEntryContent {
  if (content.kind === 'release') {
    return { kind: 'release', organizationId: content.organizationId, refundOperationId: content.refundOperationId, basis: content.basis, basisReference: content.basisReference };
  }
  return {
    kind: 'reserve',
    organizationId: content.organizationId,
    refundOperationId: content.refundOperationId,
    principalId: content.principalId,
    refundKey: content.refundKey,
    originalSettlementId: content.originalSettlementId,
    originalExecutionId: content.originalExecutionId,
    originalReceiptId: content.originalReceiptId,
    originalAmount: { value: content.originalAmount.value, unit: content.originalAmount.unit },
    amount: { value: content.amount.value, unit: content.amount.unit },
    refundRequestId: content.refundRequestId,
  };
}

export function paymentRefundEntryDigest(content: PaymentRefundEntryContent, sequence: number, recordedAt: string): string {
  return computeDigest({ domain: ENTRY_DOMAIN, schemaVersion: PAYMENT_REFUND_LEDGER_SCHEMA_VERSION, sequence, recordedAt, ...copyContent(content) });
}

export function nextPaymentRefundChainDigest(previous: string, entryDigest: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, previous, entryDigest });
}

export function buildPaymentRefundEntry(content: PaymentRefundEntryContent, sequence: number, recordedAt: string, previousChain: string): PaymentRefundEntry {
  const entryDigest = paymentRefundEntryDigest(content, sequence, recordedAt);
  return deepFreeze({ ...copyContent(content), schemaVersion: PAYMENT_REFUND_LEDGER_SCHEMA_VERSION, sequence, recordedAt, entryDigest, chainDigest: nextPaymentRefundChainDigest(previousChain, entryDigest) }) as PaymentRefundEntry;
}

const RESERVE_KEYS = ['kind', 'organizationId', 'refundOperationId', 'principalId', 'refundKey', 'originalSettlementId', 'originalExecutionId', 'originalReceiptId', 'originalAmount', 'amount', 'refundRequestId'];
const RELEASE_KEYS = ['kind', 'organizationId', 'refundOperationId', 'basis', 'basisReference'];
const ENTRY_KEYS = ['schemaVersion', 'sequence', 'recordedAt', 'entryDigest', 'chainDigest'];

function keysExactly(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

/** Why an entry's content is outside the closed contract, or `undefined`. */
export function paymentRefundContentViolation(content: unknown): string | undefined {
  if (content === null || typeof content !== 'object') return 'not a record';
  const entry = content as Record<string, unknown>;
  if (!isOpaqueExecutionIdentifier(entry['organizationId']) || !isOpaqueExecutionIdentifier(entry['refundOperationId'])) return 'an identifier is malformed';
  if (entry['kind'] === 'release') {
    if (!keysExactly(entry, RELEASE_KEYS)) return 'a release is not a closed record';
    if (!(PAYMENT_REFUND_RELEASE_BASES as readonly unknown[]).includes(entry['basis'])) return 'the release basis is unknown';
    if (!isOpaqueExecutionIdentifier(entry['basisReference']) && !(typeof entry['basisReference'] === 'string' && isWellFormedDigest(entry['basisReference']))) return 'the release reference is malformed';
    return undefined;
  }
  if (entry['kind'] !== 'reserve' || !keysExactly(entry, RESERVE_KEYS)) return 'a reservation is not a closed record';
  for (const key of ['principalId', 'refundKey', 'originalSettlementId', 'originalExecutionId', 'originalReceiptId', 'refundRequestId']) {
    if (!isOpaqueExecutionIdentifier(entry[key])) return `${key} is malformed`;
  }
  const original = entry['originalAmount'];
  const amount = entry['amount'];
  if (!isWellFormedMonetaryAmount(original) || !isWellFormedMonetaryAmount(amount) || original.value === '0' || amount.value === '0') return 'an amount is not canonical and positive';
  if (amount.unit !== original.unit) return 'the refund asset is not the original asset';
  return undefined;
}

/** Why a persisted entry fails verification against the chain it extends, or `undefined`. */
export function paymentRefundEntryFailure(entry: PaymentRefundEntry, expectedSequence: number, previousChain: string): string | undefined {
  if (entry === null || typeof entry !== 'object') return 'not a record';
  const { schemaVersion, sequence, recordedAt, entryDigest, chainDigest, ...content } = entry;
  if (!keysExactly(entry, [...(content.kind === 'release' ? RELEASE_KEYS : RESERVE_KEYS), ...ENTRY_KEYS])) return 'the entry is not a closed record';
  if (schemaVersion !== PAYMENT_REFUND_LEDGER_SCHEMA_VERSION) return 'unknown schema version';
  if (sequence !== expectedSequence) return 'the entry is out of sequence';
  if (!isCanonicalOutcomeInstant(recordedAt)) return 'recordedAt is not a canonical instant';
  const violation = paymentRefundContentViolation(content);
  if (violation !== undefined) return violation;
  if (entryDigest !== paymentRefundEntryDigest(content as PaymentRefundEntryContent, sequence, recordedAt)) return 'the entry digest does not match';
  if (chainDigest !== nextPaymentRefundChainDigest(previousChain, entryDigest)) return 'the chain does not continue';
  return undefined;
}

// -- decisions ----------------------------------------------------------------

export interface ReservePaymentRefundInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly refundKey: string;
  readonly originalSettlementId: string;
  readonly originalExecutionId: string;
  readonly originalReceiptId: string;
  readonly originalAmount: MonetaryAmount;
  readonly amount: MonetaryAmount;
  readonly refundRequestId: string;
}

export interface PaymentRefundReservation {
  readonly refundOperationId: string;
  readonly reserve: PaymentRefundEntry & PaymentRefundReserveContent;
  readonly release?: PaymentRefundEntry & PaymentRefundReleaseContent;
}

export interface PaymentRefundBalance {
  readonly originalSettlementId: string;
  readonly originalAmount: MonetaryAmount;
  /** Σ of every reservation still counted. */
  readonly counted: MonetaryAmount;
  readonly remaining: MonetaryAmount;
  readonly reservations: readonly PaymentRefundReservation[];
}

export type ReservePaymentRefundResult =
  | { readonly outcome: 'reserved' | 'existing'; readonly reservation: PaymentRefundReservation; readonly balance: PaymentRefundBalance }
  /** The operation exists and was released: it is closed for good. A new refund needs a new refund key. */
  | { readonly outcome: 'closed'; readonly reservation: PaymentRefundReservation }
  /** The same operation names a different refund. The first stands. */
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'refused'; readonly refusal: (typeof PAYMENT_REFUND_REFUSALS)[keyof typeof PAYMENT_REFUND_REFUSALS]; readonly balance?: PaymentRefundBalance };

export type ReleasePaymentRefundResult = { readonly outcome: 'released' | 'existing'; readonly reservation: PaymentRefundReservation } | { readonly outcome: 'not-found' };

/** The reservations of one original (or one operation) from verified entries. Throws `PAYMENT_SETTLEMENT_CORRUPT` on an inconsistent history. */
export function paymentRefundReservations(entries: readonly PaymentRefundEntry[]): readonly PaymentRefundReservation[] {
  const byOperation = new Map<string, { reserve?: PaymentRefundEntry & PaymentRefundReserveContent; release?: PaymentRefundEntry & PaymentRefundReleaseContent }>();
  for (const entry of entries) {
    const slot = byOperation.get(entry.refundOperationId) ?? {};
    if (entry.kind === 'reserve') {
      if (slot.reserve !== undefined) throw corruptLedger('an operation is reserved twice');
      slot.reserve = entry;
    } else {
      if (slot.release !== undefined) throw corruptLedger('an operation is released twice');
      if (slot.reserve === undefined) throw corruptLedger('a release precedes its reservation');
      slot.release = entry;
    }
    byOperation.set(entry.refundOperationId, slot);
  }
  return [...byOperation.entries()].map(([refundOperationId, slot]) => {
    if (slot.reserve === undefined) throw corruptLedger('a release names no reservation');
    if (slot.reserve.refundOperationId !== paymentRefundOperationId(slot.reserve)) throw corruptLedger('an operation id is not derived from its reservation');
    return deepFreeze({ refundOperationId, reserve: slot.reserve, ...(slot.release !== undefined ? { release: slot.release } : {}) });
  });
}

/** The balance of one original from all of its reservations. Every reservation must state the same original. */
export function paymentRefundBalance(originalSettlementId: string, reservations: readonly PaymentRefundReservation[], originalAmount: MonetaryAmount): PaymentRefundBalance {
  for (const reservation of reservations) {
    const stated = reservation.reserve.originalAmount;
    if (reservation.reserve.originalSettlementId !== originalSettlementId || stated.value !== originalAmount.value || stated.unit !== originalAmount.unit) throw corruptLedger('reservations of one original disagree about it');
  }
  const counted = paymentRefundCounted(reservations.filter((reservation) => reservation.release === undefined).map((reservation) => reservation.reserve.amount.value));
  let remaining: MonetaryAmount;
  try {
    remaining = paymentRefundRemaining(originalAmount, counted);
  } catch {
    throw corruptLedger('the reservations of an original exceed it');
  }
  return deepFreeze({ originalSettlementId, originalAmount: { ...originalAmount }, counted: { value: counted, unit: originalAmount.unit }, remaining, reservations: [...reservations] });
}

export type RefundReservePlan =
  | { readonly kind: 'append'; readonly content: PaymentRefundReserveContent }
  | { readonly kind: 'answer'; readonly result: ReservePaymentRefundResult };

/** The one reservation decision, over verified entries of this original, taken inside the critical section. */
export function planPaymentRefundReservation(input: ReservePaymentRefundInput, entriesOfOriginal: readonly PaymentRefundEntry[]): RefundReservePlan {
  const refundOperationId = paymentRefundOperationId(input);
  const reservations = paymentRefundReservations(entriesOfOriginal);
  const balance = paymentRefundBalance(input.originalSettlementId, reservations, input.originalAmount);
  const existing = reservations.find((reservation) => reservation.refundOperationId === refundOperationId);
  if (existing !== undefined) {
    const reserve = existing.reserve;
    const same =
      reserve.amount.value === input.amount.value &&
      reserve.amount.unit === input.amount.unit &&
      reserve.originalExecutionId === input.originalExecutionId &&
      reserve.originalReceiptId === input.originalReceiptId &&
      reserve.refundRequestId === input.refundRequestId;
    if (!same) return { kind: 'answer', result: { outcome: 'conflict' } };
    if (existing.release !== undefined) return { kind: 'answer', result: { outcome: 'closed', reservation: existing } };
    return { kind: 'answer', result: { outcome: 'existing', reservation: existing, balance } };
  }
  const refusal = paymentRefundRefusal(input.originalAmount, balance.counted.value, input.amount);
  if (refusal !== undefined) return { kind: 'answer', result: { outcome: 'refused', refusal, balance } };
  return {
    kind: 'append',
    content: {
      kind: 'reserve',
      organizationId: input.organizationId,
      refundOperationId,
      principalId: input.principalId,
      refundKey: input.refundKey,
      originalSettlementId: input.originalSettlementId,
      originalExecutionId: input.originalExecutionId,
      originalReceiptId: input.originalReceiptId,
      originalAmount: { value: input.originalAmount.value, unit: input.originalAmount.unit },
      amount: { value: input.amount.value, unit: input.amount.unit },
      refundRequestId: input.refundRequestId,
    },
  };
}

export interface ReleasePaymentRefundInput {
  readonly organizationId: string;
  readonly refundOperationId: string;
  readonly basis: PaymentRefundReleaseBasis;
  readonly basisReference: string;
}

export type RefundReleasePlan = { readonly kind: 'append'; readonly content: PaymentRefundReleaseContent } | { readonly kind: 'answer'; readonly result: ReleasePaymentRefundResult };

export function planPaymentRefundRelease(input: ReleasePaymentRefundInput, entriesOfOperation: readonly PaymentRefundEntry[]): RefundReleasePlan {
  const reservation = paymentRefundReservations(entriesOfOperation).find((candidate) => candidate.refundOperationId === input.refundOperationId);
  if (reservation === undefined) return { kind: 'answer', result: { outcome: 'not-found' } };
  if (reservation.release !== undefined) {
    if (reservation.release.basis !== input.basis || reservation.release.basisReference !== input.basisReference) throw corruptLedger('an operation was released on another basis');
    return { kind: 'answer', result: { outcome: 'existing', reservation } };
  }
  return { kind: 'append', content: { kind: 'release', organizationId: input.organizationId, refundOperationId: input.refundOperationId, basis: input.basis, basisReference: input.basisReference } };
}

export function corruptLedger(what: string): PaymentSettlementStoreError {
  return new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_CORRUPT', `The refund accounting failed verification (${what}). Refused, never repaired.`);
}

export function requireRefundReserveInput(input: ReservePaymentRefundInput): void {
  // The content contract, checked before any state is read; the operation id is derived later, never supplied.
  const violation = paymentRefundContentViolation({
    kind: 'reserve',
    organizationId: input?.organizationId,
    refundOperationId: 'payment-refund:probe',
    principalId: input?.principalId,
    refundKey: input?.refundKey,
    originalSettlementId: input?.originalSettlementId,
    originalExecutionId: input?.originalExecutionId,
    originalReceiptId: input?.originalReceiptId,
    originalAmount: input?.originalAmount,
    amount: input?.amount,
    refundRequestId: input?.refundRequestId,
  });
  if (violation !== undefined) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_INPUT_INVALID', `The refund reservation is outside the closed contract: ${violation}.`);
}

export function requireRefundReleaseInput(input: ReleasePaymentRefundInput): void {
  const violation = paymentRefundContentViolation({ kind: 'release', organizationId: input?.organizationId, refundOperationId: input?.refundOperationId, basis: input?.basis, basisReference: input?.basisReference });
  if (violation !== undefined) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_INPUT_INVALID', `The refund release is outside the closed contract: ${violation}.`);
}

/** The refund accounting port. Every call is confined to one organization. */
export interface PaymentRefundLedger {
  readonly providerKind: 'memory' | 'sqlite';
  /** Reserves a refund against a settled original, iff it fits the refundable balance — atomically with every other reservation of that original. */
  reserve(input: ReservePaymentRefundInput): Promise<ReservePaymentRefundResult>;
  /** Releases a reservation whose refund is proven to have moved nothing. Terminal for that operation. */
  release(input: ReleasePaymentRefundInput): Promise<ReleasePaymentRefundResult>;
  readOperation(organizationId: string, refundOperationId: string): Promise<PaymentRefundReservation | undefined>;
  /** The balance of one original, or `undefined` when nothing was ever reserved against it. */
  readBalance(organizationId: string, originalSettlementId: string, originalAmount: MonetaryAmount): Promise<PaymentRefundBalance>;
  close(): Promise<void>;
}

/**
 * The volatile refund accounting — tests and development only: it is lost on
 * restart, which would recreate refundable balance, so it is never a
 * production composition (the refund service refuses to compose with it
 * unless told the deployment is volatile on purpose).
 */
export function createInMemoryPaymentRefundLedger(options: { readonly now: () => string }): PaymentRefundLedger {
  const entries: PaymentRefundEntry[] = [];
  let chain = paymentRefundGenesisDigest('memory', 'memory');
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_STORE_UNAVAILABLE', 'The refund accounting has been closed.');
  };
  const append = (content: PaymentRefundEntryContent): PaymentRefundEntry => {
    const entry = buildPaymentRefundEntry(content, entries.length + 1, options.now(), chain);
    entries.push(entry);
    chain = entry.chainDigest;
    return entry;
  };
  const ofOriginal = (organizationId: string, originalSettlementId: string): readonly PaymentRefundEntry[] => {
    const operations = new Set(entries.filter((entry) => entry.organizationId === organizationId && entry.kind === 'reserve' && entry.originalSettlementId === originalSettlementId).map((entry) => entry.refundOperationId));
    return entries.filter((entry) => entry.organizationId === organizationId && operations.has(entry.refundOperationId));
  };
  const ofOperation = (organizationId: string, refundOperationId: string): readonly PaymentRefundEntry[] => entries.filter((entry) => entry.organizationId === organizationId && entry.refundOperationId === refundOperationId);
  return {
    providerKind: 'memory',
    async reserve(input) {
      assertOpen();
      requireRefundReserveInput(input);
      const plan = planPaymentRefundReservation(input, ofOriginal(input.organizationId, input.originalSettlementId));
      if (plan.kind === 'answer') return plan.result;
      append(plan.content);
      const after = planPaymentRefundReservation(input, ofOriginal(input.organizationId, input.originalSettlementId));
      if (after.kind !== 'answer' || after.result.outcome !== 'existing') throw corruptLedger('a reservation did not take effect');
      return { ...after.result, outcome: 'reserved' };
    },
    async release(input) {
      assertOpen();
      requireRefundReleaseInput(input);
      const plan = planPaymentRefundRelease(input, ofOperation(input.organizationId, input.refundOperationId));
      if (plan.kind === 'answer') return plan.result;
      append(plan.content);
      const reservation = paymentRefundReservations(ofOperation(input.organizationId, input.refundOperationId))[0];
      if (reservation === undefined) throw corruptLedger('a release did not take effect');
      return { outcome: 'released', reservation };
    },
    async readOperation(organizationId, refundOperationId) {
      assertOpen();
      return paymentRefundReservations(ofOperation(organizationId, refundOperationId))[0];
    },
    async readBalance(organizationId, originalSettlementId, originalAmount) {
      assertOpen();
      return paymentRefundBalance(originalSettlementId, paymentRefundReservations(ofOriginal(organizationId, originalSettlementId)), originalAmount);
    },
    async close() {
      closed = true;
    },
  };
}
