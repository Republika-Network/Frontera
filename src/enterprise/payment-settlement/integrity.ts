import { isRecordableProviderRef } from '../../features/execution-runtime/index.js';
import {
  PAYMENT_FINALITY_EVIDENCE_LIMITS,
  PAYMENT_SETTLEMENT_BASES,
  isPaymentFinalityFactName,
  isPaymentFinalityFactValue,
  isPaymentFinalityInstant,
  isPaymentFinalityMethod,
  isPaymentRailId,
  isPaymentSettlementTerms,
  type PaymentFinalityFact,
  type PaymentSettlementTerms,
} from '../../features/payment-runtime/index.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from './validation.js';
import {
  PAYMENT_RECEIPT_FORMAT,
  PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION,
  type PaymentReceipt,
  type PaymentReceiptDisclosureLevel,
  type PaymentSettlementBasis,
  type PaymentSettlementFinality,
  type PaymentSettlementRecord,
  type RecordPaymentSettlementInput,
} from './contracts.js';

/**
 * PAY-05 integrity: deterministic identities, what each digest commits to,
 * closed-contract verification of a persisted settlement, and the pure
 * settlement → receipt derivation.
 *
 * One canonicalization and one digest primitive — `aoc.canonical-json.v1` and
 * SHA-256 from the Governance Store — reused verbatim; every digest input is
 * domain-separated by a versioned tag. Integrity is not authenticity: a writer
 * able to rewrite a record and its digests consistently is not detected here
 * (the same posture as P11 and P12).
 */

const SETTLEMENT_ID_DOMAIN = 'aoc.payment-settlement.identity.v1';
const RECEIPT_ID_DOMAIN = 'aoc.payment-receipt.identity.v1';
const PROOF_DOMAIN = 'aoc.payment-settlement.proof.v1';
const CONTENT_DOMAIN = 'aoc.payment-settlement.content.v1';
const RECORD_DOMAIN = 'aoc.payment-settlement.record.v1';
const RECEIPT_DOMAIN = 'aoc.payment-receipt.v1';

const ACTION = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;

function hexOf(digest: string): string {
  return digest.slice('sha256:'.length);
}

/** The one settlement identity of an execution: derived, never chosen. One execution can never hold two settlement truths. */
export function paymentSettlementId(organizationId: string, executionId: string): string {
  return `payment-settlement:${hexOf(computeDigest({ domain: SETTLEMENT_ID_DOMAIN, organizationId, executionId }))}`;
}

/** The one receipt identity of a settlement: derived from it, never random. */
export function paymentReceiptId(organizationId: string, settlementId: string): string {
  return `payment-receipt:${hexOf(computeDigest({ domain: RECEIPT_ID_DOMAIN, organizationId, settlementId }))}`;
}

/** What the proof digest commits to: the method, the handle, the rail's own instant and every normalized fact. A verifier with the rail can re-derive it. */
export function paymentFinalityProofDigest(finality: { readonly method: string; readonly providerRef: string; readonly finalizedAt?: string; readonly facts: readonly PaymentFinalityFact[] }): string {
  return computeDigest({
    domain: PROOF_DOMAIN,
    method: finality.method,
    providerRef: finality.providerRef,
    finalizedAt: finality.finalizedAt ?? null,
    facts: finality.facts.map(({ name, value }) => ({ name, value })),
  });
}

function copyTerms(terms: PaymentSettlementTerms): PaymentSettlementTerms {
  return {
    source: { accountId: terms.source.accountId },
    destination: { kind: terms.destination.kind, reference: terms.destination.reference },
    amount: { value: terms.amount.value, unit: terms.amount.unit },
    purpose: terms.purpose,
    ...(terms.reference !== undefined ? { reference: terms.reference } : {}),
    ...(terms.rail !== undefined ? { rail: terms.rail } : {}),
  };
}

function copyBasis(basis: PaymentSettlementBasis): PaymentSettlementBasis {
  return {
    kind: basis.kind,
    attemptDigest: basis.attemptDigest,
    ...(basis.observationDigest !== undefined ? { observationDigest: basis.observationDigest } : {}),
    ...(basis.resolutionDigest !== undefined ? { resolutionDigest: basis.resolutionDigest } : {}),
  };
}

function copyFinality(finality: PaymentSettlementFinality): PaymentSettlementFinality {
  return {
    authorityId: finality.authorityId,
    method: finality.method,
    providerRef: finality.providerRef,
    ...(finality.finalizedAt !== undefined ? { finalizedAt: finality.finalizedAt } : {}),
    facts: finality.facts.map(({ name, value }) => ({ name, value })),
    proofDigest: finality.proofDigest,
  };
}

/** A fresh, plain copy with only the declared fields — nothing the caller's object carries survives. */
function inputFact(input: RecordPaymentSettlementInput): RecordPaymentSettlementInput {
  return {
    organizationId: input.organizationId,
    executionId: input.executionId,
    requestId: input.requestId,
    decisionId: input.decisionId,
    evaluationId: input.evaluationId,
    boundedGrantId: input.boundedGrantId,
    action: input.action,
    ...(input.railId !== undefined ? { railId: input.railId } : {}),
    basis: copyBasis(input.basis),
    payment: copyTerms(input.payment),
    finality: copyFinality(input.finality),
    verifiedAt: input.verifiedAt,
  };
}

/** Everything but the local instants. */
function contentDigestOf(fact: RecordPaymentSettlementInput, settlementId: string): string {
  const { verifiedAt: _local, ...content } = fact;
  return computeDigest({ domain: CONTENT_DOMAIN, schemaVersion: PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION, settlementId, ...content, railId: content.railId ?? null });
}

function recordDigestOf(record: Omit<PaymentSettlementRecord, 'settlementDigest'>): string {
  return computeDigest({ domain: RECORD_DOMAIN, ...record, railId: record.railId ?? null });
}

export function buildPaymentSettlementRecord(input: RecordPaymentSettlementInput, recordedAt: string): PaymentSettlementRecord {
  const fact = inputFact(input);
  const settlementId = paymentSettlementId(fact.organizationId, fact.executionId);
  const unsigned = { schemaVersion: PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION, settlementId, ...fact, contentDigest: contentDigestOf(fact, settlementId), recordedAt };
  return deepFreeze({ ...unsigned, settlementDigest: recordDigestOf(unsigned) });
}

const RECORD_KEYS = new Set(['schemaVersion', 'settlementId', 'organizationId', 'executionId', 'requestId', 'decisionId', 'evaluationId', 'boundedGrantId', 'action', 'railId', 'basis', 'payment', 'finality', 'verifiedAt', 'contentDigest', 'recordedAt', 'settlementDigest']);
const INPUT_KEYS = new Set(['organizationId', 'executionId', 'requestId', 'decisionId', 'evaluationId', 'boundedGrantId', 'action', 'railId', 'basis', 'payment', 'finality', 'verifiedAt']);
const BASIS_KEYS = new Set(['kind', 'attemptDigest', 'observationDigest', 'resolutionDigest']);
const FINALITY_KEYS = new Set(['authorityId', 'method', 'providerRef', 'finalizedAt', 'facts', 'proofDigest']);

function plain(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, keys: ReadonlySet<string>): value is Readonly<Record<string, unknown>> {
  return plain(value) && Object.keys(value).every((key) => keys.has(key)) && Object.getOwnPropertySymbols(value).length === 0;
}

function basisViolation(basis: unknown): string | undefined {
  if (!closed(basis, BASIS_KEYS)) return 'the basis is not a closed record';
  if (!(PAYMENT_SETTLEMENT_BASES as readonly unknown[]).includes(basis['kind'])) return 'the basis kind is unknown';
  const digests = ['attemptDigest', 'observationDigest', 'resolutionDigest'].map((key) => basis[key]);
  if (digests.some((digest) => digest !== undefined && (typeof digest !== 'string' || !isWellFormedDigest(digest)))) return 'a basis digest is malformed';
  if (basis['attemptDigest'] === undefined) return 'the basis names no attempt';
  if (basis['kind'] === 'provider-confirmed-completed' && (basis['observationDigest'] === undefined || basis['resolutionDigest'] !== undefined)) return 'a provider basis names exactly its observation';
  if (basis['kind'] === 'resolution-confirmed-completed' && basis['resolutionDigest'] === undefined) return 'a resolution basis names its resolution';
  return undefined;
}

function factsViolation(facts: unknown): string | undefined {
  if (!Array.isArray(facts) || facts.length > PAYMENT_FINALITY_EVIDENCE_LIMITS.factCount) return 'the facts are not a bounded list';
  let previous: string | undefined;
  for (const fact of facts as unknown[]) {
    if (!closed(fact, new Set(['name', 'value'])) || !isPaymentFinalityFactName(fact['name']) || !isPaymentFinalityFactValue(fact['value'])) return 'a fact is outside the contract';
    if (previous !== undefined && !(previous < (fact['name'] as string))) return 'the facts are not sorted and unique';
    previous = fact['name'] as string;
  }
  return undefined;
}

function finalityViolation(finality: unknown): string | undefined {
  if (!closed(finality, FINALITY_KEYS)) return 'the finality is not a closed record';
  if (!isOpaqueExecutionIdentifier(finality['authorityId'])) return 'the finality authority id is malformed';
  if (!isPaymentFinalityMethod(finality['method'])) return 'the finality method is malformed';
  if (!isRecordableProviderRef(finality['providerRef'])) return 'the provider reference is not recordable';
  if (finality['finalizedAt'] !== undefined && !isPaymentFinalityInstant(finality['finalizedAt'])) return 'the finality instant is malformed';
  const facts = factsViolation(finality['facts']);
  if (facts !== undefined) return facts;
  if (typeof finality['proofDigest'] !== 'string' || finality['proofDigest'] !== paymentFinalityProofDigest(finality as unknown as PaymentSettlementFinality)) return 'the proof digest does not match the evidence';
  return undefined;
}

/** Why a settlement input is outside the closed contract, or `undefined`. Names the rule, never the value. */
export function paymentSettlementInputViolation(input: unknown): string | undefined {
  if (!closed(input, INPUT_KEYS)) return 'the settlement is not a closed record';
  for (const key of ['organizationId', 'executionId', 'requestId', 'decisionId', 'evaluationId', 'boundedGrantId'] as const) {
    if (!isOpaqueExecutionIdentifier(input[key])) return `${key} is not an opaque identifier`;
  }
  if (typeof input['action'] !== 'string' || !ACTION.test(input['action'])) return 'the action is malformed';
  if (input['railId'] !== undefined && !isPaymentRailId(input['railId'])) return 'the rail id is malformed';
  const basis = basisViolation(input['basis']);
  if (basis !== undefined) return basis;
  if (!isPaymentSettlementTerms(input['payment'])) return 'the payment terms are outside the contract';
  const finality = finalityViolation(input['finality']);
  if (finality !== undefined) return finality;
  if (!isCanonicalOutcomeInstant(input['verifiedAt'])) return 'verifiedAt is not a canonical instant';
  return undefined;
}

/** Why a persisted settlement fails verification, or `undefined`. Every digest is recomputed; nothing is repaired. */
export function paymentSettlementRecordFailure(record: PaymentSettlementRecord): string | undefined {
  if (!closed(record, RECORD_KEYS)) return 'the record is not a closed record';
  if (record.schemaVersion !== PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION) return 'unknown schema version';
  const { schemaVersion: _schema, settlementId, contentDigest, recordedAt, settlementDigest, ...input } = record;
  const violation = paymentSettlementInputViolation(input);
  if (violation !== undefined) return violation;
  if (!isCanonicalOutcomeInstant(recordedAt)) return 'recordedAt is not a canonical instant';
  if (settlementId !== paymentSettlementId(record.organizationId, record.executionId)) return 'the settlement id is not derived from its execution';
  if (contentDigest !== contentDigestOf(inputFact(input), settlementId)) return 'the content digest does not match';
  const { settlementDigest: _digest, ...unsigned } = record;
  if (settlementDigest !== recordDigestOf(unsigned)) return 'the settlement digest does not match';
  return undefined;
}

/** Whether a recorded settlement and a new input state the same final transfer — every field but the local instants. */
export function sameSettlementContent(recorded: PaymentSettlementRecord, input: RecordPaymentSettlementInput): boolean {
  return recorded.contentDigest === contentDigestOf(inputFact(input), recorded.settlementId);
}

// -- receipts ----------------------------------------------------------------

function receiptDigestOf(receipt: Omit<PaymentReceipt, 'receiptDigest'>): string {
  return computeDigest({ domain: RECEIPT_DOMAIN, ...receipt, railId: receipt.railId ?? null });
}

/**
 * The receipt of a settlement — pure and deterministic. Built only from a
 * settlement record (which the caller has read verified), never from a rail
 * result; it carries no local instant, so the same settlement content always
 * derives the identical receipt.
 */
export function derivePaymentReceipt(settlement: PaymentSettlementRecord): PaymentReceipt {
  const unsigned: Omit<PaymentReceipt, 'receiptDigest'> = {
    format: PAYMENT_RECEIPT_FORMAT,
    receiptId: paymentReceiptId(settlement.organizationId, settlement.settlementId),
    status: 'settled',
    settlementId: settlement.settlementId,
    settlementContentDigest: settlement.contentDigest,
    organizationId: settlement.organizationId,
    executionId: settlement.executionId,
    requestId: settlement.requestId,
    decisionId: settlement.decisionId,
    ...(settlement.railId !== undefined ? { railId: settlement.railId } : {}),
    payment: copyTerms(settlement.payment),
    finality: {
      authorityId: settlement.finality.authorityId,
      method: settlement.finality.method,
      providerRef: settlement.finality.providerRef,
      ...(settlement.finality.finalizedAt !== undefined ? { finalizedAt: settlement.finality.finalizedAt } : {}),
      proofDigest: settlement.finality.proofDigest,
    },
  };
  return deepFreeze({ ...unsigned, receiptDigest: receiptDigestOf(unsigned) });
}

export type PaymentReceiptVerification = { readonly valid: true } | { readonly valid: false; readonly failure: 'format' | 'digest' | 'identity' | 'settlement' };

/**
 * Verifies a receipt's integrity and correlation: the format, its own digest
 * recomputed over its canonical content, its identity derived from its
 * settlement, and — given the verified settlement record — that it is exactly
 * the receipt that settlement derives. An altered amount, asset, execution,
 * evidence digest or any other field fails. This is integrity, not
 * authenticity: it does not prove who issued the receipt.
 */
export function verifyPaymentReceipt(receipt: PaymentReceipt, settlement?: PaymentSettlementRecord): PaymentReceiptVerification {
  try {
    if (!plain(receipt) || receipt.format !== PAYMENT_RECEIPT_FORMAT || receipt.status !== 'settled') return { valid: false, failure: 'format' };
    const { receiptDigest, ...unsigned } = receipt;
    if (typeof receiptDigest !== 'string' || receiptDigest !== receiptDigestOf(unsigned)) return { valid: false, failure: 'digest' };
    if (receipt.receiptId !== paymentReceiptId(receipt.organizationId, receipt.settlementId) || receipt.settlementId !== paymentSettlementId(receipt.organizationId, receipt.executionId)) {
      return { valid: false, failure: 'identity' };
    }
    if (settlement !== undefined) {
      const expected = derivePaymentReceipt(settlement);
      if (expected.receiptDigest !== receiptDigest || expected.receiptId !== receipt.receiptId) return { valid: false, failure: 'settlement' };
    }
    return { valid: true };
  } catch {
    return { valid: false, failure: 'format' };
  }
}

/**
 * A receipt view for one disclosure tier, following the payment vertical's
 * disclosure table (`PAYMENT_ARCHITECTURE.md` §6). No tier discloses the
 * destination, the source address of a rail, the finality facts, a signer or
 * anything secret (none exists here). The full receipt is a trusted
 * in-process read; nothing serves it over HTTP.
 *
 * | field | auditor | partner | customer | public |
 * | --- | --- | --- | --- | --- |
 * | receipt id, status | ✓ | ✓ | ✓ | ✓ |
 * | execution id | ✓ | ✓ | ✓ | — |
 * | finalizedAt | ✓ | ✓ | ✓ | — |
 * | provider reference, method, proof digest, receipt digest | ✓ | ✓ | — | — |
 * | amount, asset, purpose, reference, rail, source account, request / decision / settlement ids | ✓ | — | — | — |
 * | destination, finality facts | — | — | — | — |
 */
export function disclosePaymentReceipt(receipt: PaymentReceipt, level: PaymentReceiptDisclosureLevel): Readonly<Record<string, unknown>> {
  const base = { receiptId: receipt.receiptId, status: receipt.status };
  if (level === 'public') return deepFreeze(base);
  const customer = { ...base, executionId: receipt.executionId, ...(receipt.finality.finalizedAt !== undefined ? { finalizedAt: receipt.finality.finalizedAt } : {}) };
  if (level === 'customer') return deepFreeze(customer);
  const partner = { ...customer, providerRef: receipt.finality.providerRef, finalityMethod: receipt.finality.method, proofDigest: receipt.finality.proofDigest, receiptDigest: receipt.receiptDigest };
  if (level === 'partner') return deepFreeze(partner);
  return deepFreeze({
    ...partner,
    settlementId: receipt.settlementId,
    requestId: receipt.requestId,
    decisionId: receipt.decisionId,
    ...(receipt.railId !== undefined ? { railId: receipt.railId } : {}),
    amount: { value: receipt.payment.amount.value, unit: receipt.payment.amount.unit },
    purpose: receipt.payment.purpose,
    ...(receipt.payment.reference !== undefined ? { reference: receipt.payment.reference } : {}),
    ...(receipt.payment.rail !== undefined ? { rail: receipt.payment.rail } : {}),
    sourceAccountId: receipt.payment.source.accountId,
    finalityAuthorityId: receipt.finality.authorityId,
  });
}
