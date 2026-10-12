import { isPositiveMonetaryAmount, isWellFormedMonetaryAmount } from '../../features/monetary-runtime/index.js';
import {
  isPaymentBusinessReference,
  isPaymentDestinationKind,
  isPaymentEnvelopeIdentifier,
  isPaymentProtocolId,
  isPaymentPurpose,
  isPaymentRailId,
  isPaymentReference,
  parsePaymentContentDigest,
  readPaymentProtocolChallengeEvidence,
} from '../../features/payment-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  computePaymentBusinessSemanticDigest,
  computePaymentChallengeDigest,
  computePaymentChallengeIdentity,
  derivePaymentBusinessOperationKey,
  derivePaymentBusinessOperationRequestId,
  type PaymentBusinessTerms,
} from './business-operation.js';
import {
  PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  PAYMENT_CHALLENGES_PER_OPERATION_MAX,
  type PaymentBusinessOperationAccessContext,
  type PaymentBusinessOperationInput,
  type PaymentBusinessOperationRecord,
  type PaymentBusinessOperationState,
  type PaymentChallengeInput,
  type PaymentChallengeRecord,
  type RecordPaymentChallengeInput,
} from './store-contracts.js';
import { PaymentBusinessOperationStoreError } from './store-errors.js';

/**
 * Integrity for the payment business-operation store: the same
 * canonicalization and digest primitive as the Governance Store, P11 and P12
 * (`aoc.canonical-json.v1`, SHA-256), each record domain-separated.
 *
 * Beyond each row's own digest, every read **recomputes what is derived**: the
 * semantic digest from the operation's terms, the governed key and request id
 * from its scope, and each challenge's identity and digest from its exact
 * fields. A row whose derived values disagree with its terms is corrupt,
 * whatever its record digest says. Integrity is not authenticity.
 */

const OPERATION_RECORD_DOMAIN = 'aoc.payment.business-operation.record.v1';
const CHALLENGE_RECORD_DOMAIN = 'aoc.payment.protocol-challenge.record.v1';
const HTTP_METHOD = /^[A-Z]{1,16}$/;
/** The canonical instant the host clock answers: `Date#toISOString()` exactly. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalPaymentInstant(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_INSTANT.test(value) && new Date(value).toISOString() === value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactly(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/** Why a set of business terms is outside the contract, or `undefined`. Registry-free, as P9's downstream re-check is. */
export function paymentBusinessTermsViolation(terms: unknown): string | undefined {
  if (!isPlainObject(terms) || !hasExactly(terms, ['action', 'source', 'destination', 'amount', 'purpose', 'binding'], ['reference', 'rail'])) return 'terms are not exactly the declared fields';
  const { action, source, destination, amount, purpose, reference, rail, binding } = terms;
  if (!isPaymentEnvelopeIdentifier(action)) return 'action';
  if (!isPlainObject(source) || !hasExactly(source, ['accountId']) || !isPaymentReference(source['accountId'])) return 'source';
  if (!isPlainObject(destination) || !hasExactly(destination, ['kind', 'reference']) || !isPaymentDestinationKind(destination['kind']) || !isPaymentReference(destination['reference'])) return 'destination';
  if (!isPlainObject(amount) || !hasExactly(amount, ['value', 'unit']) || !isWellFormedMonetaryAmount(amount) || !isPositiveMonetaryAmount(amount)) return 'amount';
  if (!isPaymentPurpose(purpose)) return 'purpose';
  if (reference !== undefined && !isPaymentBusinessReference(reference)) return 'reference';
  if (rail !== undefined && !isPaymentRailId(rail)) return 'rail';
  if (!isPlainObject(binding) || !hasExactly(binding, ['target', 'method'], ['contentDigest'])) return 'binding';
  if (!isPaymentEnvelopeIdentifier(binding['target']) || typeof binding['method'] !== 'string' || !HTTP_METHOD.test(binding['method'])) return 'binding';
  const contentDigest = binding['contentDigest'];
  if (contentDigest !== undefined && parsePaymentContentDigest(contentDigest)?.canonical !== contentDigest) return 'binding.contentDigest';
  return undefined;
}

function scopeViolation(value: { readonly organizationId?: unknown; readonly principalId?: unknown; readonly businessOperationId?: unknown }): string | undefined {
  if (!isCanonicalCustomerIdentifier(value.organizationId)) return 'organizationId';
  if (!isCanonicalCustomerIdentifier(value.principalId)) return 'principalId';
  if (!isPaymentEnvelopeIdentifier(value.businessOperationId)) return 'businessOperationId';
  return undefined;
}

/** Why an operation input is outside the closed contract, or `undefined`. */
export function paymentBusinessOperationViolation(input: unknown): string | undefined {
  if (!isPlainObject(input)) return 'not an object';
  if (!hasExactly(input, ['organizationId', 'principalId', 'businessOperationId', 'businessSemanticDigest', 'terms', 'governedIdempotencyKey', 'governedRequestId', 'createdAt'])) return 'not exactly the declared fields';
  const scope = scopeViolation(input);
  if (scope !== undefined) return scope;
  if (typeof input['businessSemanticDigest'] !== 'string' || !isWellFormedDigest(input['businessSemanticDigest'])) return 'businessSemanticDigest';
  const terms = paymentBusinessTermsViolation(input['terms']);
  if (terms !== undefined) return `terms.${terms}`;
  if (!isPaymentEnvelopeIdentifier(input['governedIdempotencyKey'])) return 'governedIdempotencyKey';
  if (typeof input['governedRequestId'] !== 'string') return 'governedRequestId';
  if (!isCanonicalPaymentInstant(input['createdAt'])) return 'createdAt';
  return undefined;
}

/** Why a challenge input is outside the closed contract, or `undefined`. */
export function paymentChallengeViolation(input: unknown): string | undefined {
  if (!isPlainObject(input)) return 'not an object';
  if (!hasExactly(input, ['organizationId', 'principalId', 'businessOperationId', 'businessSemanticDigest', 'protocolId', 'challengeKey', 'challengeIdentity', 'challengeDigest', 'fields', 'observedAt'])) return 'not exactly the declared fields';
  const scope = scopeViolation(input);
  if (scope !== undefined) return scope;
  for (const digest of ['businessSemanticDigest', 'challengeIdentity', 'challengeDigest'] as const) {
    if (typeof input[digest] !== 'string' || !isWellFormedDigest(input[digest])) return digest;
  }
  if (!isPaymentProtocolId(input['protocolId'])) return 'protocolId';
  const evidence = readPaymentProtocolChallengeEvidence({ key: input['challengeKey'], fields: input['fields'] });
  if (evidence === undefined) return 'challenge evidence';
  if (!isCanonicalPaymentInstant(input['observedAt'])) return 'observedAt';
  return undefined;
}

function termsFact(terms: PaymentBusinessTerms): PaymentBusinessTerms {
  return {
    action: terms.action,
    source: { accountId: terms.source.accountId },
    destination: { kind: terms.destination.kind, reference: terms.destination.reference },
    amount: { value: terms.amount.value, unit: terms.amount.unit },
    purpose: terms.purpose,
    ...(terms.reference !== undefined ? { reference: terms.reference } : {}),
    ...(terms.rail !== undefined ? { rail: terms.rail } : {}),
    binding: { target: terms.binding.target, method: terms.binding.method, ...(terms.binding.contentDigest !== undefined ? { contentDigest: terms.binding.contentDigest } : {}) },
  };
}

/** A fresh, plain copy with only the declared fields. */
function operationFact(input: PaymentBusinessOperationInput): PaymentBusinessOperationInput {
  return {
    organizationId: input.organizationId,
    principalId: input.principalId,
    businessOperationId: input.businessOperationId,
    businessSemanticDigest: input.businessSemanticDigest,
    terms: termsFact(input.terms),
    governedIdempotencyKey: input.governedIdempotencyKey,
    governedRequestId: input.governedRequestId,
    createdAt: input.createdAt,
  };
}

/** A fresh, plain copy with only the declared fields; the evidence fields sorted, in a null-prototype record. */
function challengeFact(input: PaymentChallengeInput): PaymentChallengeInput {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(input.fields).sort()) fields[name] = input.fields[name] as string;
  return {
    organizationId: input.organizationId,
    principalId: input.principalId,
    businessOperationId: input.businessOperationId,
    businessSemanticDigest: input.businessSemanticDigest,
    protocolId: input.protocolId,
    challengeKey: input.challengeKey,
    challengeIdentity: input.challengeIdentity,
    challengeDigest: input.challengeDigest,
    fields,
    observedAt: input.observedAt,
  };
}

function operationDigestOf(fact: PaymentBusinessOperationInput, schemaVersion: string, recordedAt: string): string {
  return computeDigest({ domain: OPERATION_RECORD_DOMAIN, schemaVersion, ...fact, recordedAt });
}

function challengeRecordDigestOf(fact: PaymentChallengeInput, schemaVersion: string, challengeSequence: number, recordedAt: string): string {
  return computeDigest({ domain: CHALLENGE_RECORD_DOMAIN, schemaVersion, ...fact, challengeSequence, recordedAt });
}

export function buildPaymentBusinessOperationRecord(input: PaymentBusinessOperationInput, recordedAt: string): PaymentBusinessOperationRecord {
  const fact = operationFact(input);
  const schemaVersion = PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, recordedAt, recordDigest: operationDigestOf(fact, schemaVersion, recordedAt) });
}

export function buildPaymentChallengeRecord(input: PaymentChallengeInput, challengeSequence: number, recordedAt: string): PaymentChallengeRecord {
  const fact = challengeFact(input);
  const schemaVersion = PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, challengeSequence, recordedAt, recordDigest: challengeRecordDigestOf(fact, schemaVersion, challengeSequence, recordedAt) });
}

/** Why an operation's own terms disagree with what is derived from them, or `undefined`. Run before anything is written and on every read. */
export function paymentBusinessOperationDerivationFailure(input: PaymentBusinessOperationInput): string | undefined {
  const scope = { organizationId: input.organizationId, principalId: input.principalId, businessOperationId: input.businessOperationId };
  if (computePaymentBusinessSemanticDigest(scope, input.terms) !== input.businessSemanticDigest) return 'the business semantic digest does not recompute from the terms';
  if (derivePaymentBusinessOperationKey(scope) !== input.governedIdempotencyKey) return 'the governed idempotency key does not derive from the scope';
  if (derivePaymentBusinessOperationRequestId(scope) !== input.governedRequestId) return 'the governed request id does not derive from the scope';
  return undefined;
}

/** Why a challenge's identity or digest disagrees with its exact fields, or `undefined`. */
export function paymentChallengeDerivationFailure(input: PaymentChallengeInput): string | undefined {
  const evidence = { protocolId: input.protocolId, key: input.challengeKey, fields: input.fields };
  if (computePaymentChallengeIdentity(evidence) !== input.challengeIdentity) return 'the challenge identity does not recompute';
  if (computePaymentChallengeDigest(evidence) !== input.challengeDigest) return 'the challenge digest does not recompute from the exact fields';
  return undefined;
}

/** Why a persisted operation fails verification, or `undefined` when it verifies. */
export function paymentBusinessOperationRecordFailure(record: PaymentBusinessOperationRecord): string | undefined {
  if (record.schemaVersion !== PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) return 'the operation carries an unknown schema version';
  const { schemaVersion, recordedAt, recordDigest, ...fact } = record;
  const violation = paymentBusinessOperationViolation(fact);
  if (violation !== undefined) return `the operation is outside the contract (${violation})`;
  if (!isCanonicalPaymentInstant(recordedAt)) return 'the operation recordedAt is not a canonical instant';
  if (typeof recordDigest !== 'string' || !isWellFormedDigest(recordDigest)) return 'the operation digest is malformed';
  if (operationDigestOf(operationFact(fact), schemaVersion, recordedAt) !== recordDigest) return 'the operation digest does not recompute';
  return paymentBusinessOperationDerivationFailure(fact);
}

/** Why a persisted challenge fails verification against its operation, or `undefined` when it verifies. */
export function paymentChallengeRecordFailure(record: PaymentChallengeRecord, operation: PaymentBusinessOperationRecord): string | undefined {
  if (record.schemaVersion !== PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) return 'the challenge carries an unknown schema version';
  const { schemaVersion, challengeSequence, recordedAt, recordDigest, ...fact } = record;
  const violation = paymentChallengeViolation(fact);
  if (violation !== undefined) return `the challenge is outside the contract (${violation})`;
  if (typeof challengeSequence !== 'number' || !Number.isSafeInteger(challengeSequence) || challengeSequence < 1) return 'the challenge sequence is not a positive integer';
  if (!isCanonicalPaymentInstant(recordedAt)) return 'the challenge recordedAt is not a canonical instant';
  if (typeof recordDigest !== 'string' || !isWellFormedDigest(recordDigest)) return 'the challenge record digest is malformed';
  if (challengeRecordDigestOf(challengeFact(fact), schemaVersion, challengeSequence, recordedAt) !== recordDigest) return 'the challenge record digest does not recompute';
  const derivation = paymentChallengeDerivationFailure(fact);
  if (derivation !== undefined) return derivation;
  if (
    fact.organizationId !== operation.organizationId ||
    fact.principalId !== operation.principalId ||
    fact.businessOperationId !== operation.businessOperationId ||
    fact.businessSemanticDigest !== operation.businessSemanticDigest
  ) {
    return 'the challenge does not belong to its operation';
  }
  return undefined;
}

// ─── the shared store core ───────────────────────────────────────────────────

export function corruptPaymentBusinessOperation(subject: string, what: string): PaymentBusinessOperationStoreError {
  return new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_CORRUPT', `The persisted business-operation state for '${subject}' failed verification (${what}). Refused, never repaired.`);
}

export function requirePaymentAccessContext(context: PaymentBusinessOperationAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  const system = (context as { readonly system?: unknown } | undefined)?.system;
  if (!isCanonicalCustomerIdentifier(organizationId) || system !== undefined) {
    throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION', 'A business-operation call requires exactly one organization scope.');
  }
  return organizationId;
}

export function requirePaymentIdentifier(value: unknown, what: string): string {
  if (!isCanonicalCustomerIdentifier(value)) throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_INPUT_INVALID', `${what} is not a canonical identifier.`);
  return value;
}

/**
 * The one verification every implementation runs over a loaded operation and
 * **all** of its challenge rows. Integrity first: a row that does not verify is
 * corrupt whoever asks, and only then is its organization compared. Positions
 * must run 1…n without a gap, and an operation has at least one challenge (the
 * two are written in one transaction).
 */
export function verifyLoadedPaymentOperationState(
  subject: string,
  organizationId: string,
  operation: PaymentBusinessOperationRecord | undefined,
  challenges: readonly PaymentChallengeRecord[],
): PaymentBusinessOperationState | undefined {
  if (operation === undefined) {
    if (challenges.length > 0) throw corruptPaymentBusinessOperation(subject, 'challenges exist with no operation');
    return undefined;
  }
  const failure = paymentBusinessOperationRecordFailure(operation);
  if (failure !== undefined) throw corruptPaymentBusinessOperation(subject, failure);
  for (const challenge of challenges) {
    const challengeFailure = paymentChallengeRecordFailure(challenge, operation);
    if (challengeFailure !== undefined) throw corruptPaymentBusinessOperation(subject, challengeFailure);
  }
  const ordered = [...challenges].sort((left, right) => left.challengeSequence - right.challengeSequence);
  for (const [index, challenge] of ordered.entries()) {
    if (challenge.challengeSequence !== index + 1) throw corruptPaymentBusinessOperation(subject, 'the challenge order has a gap or a repeat');
  }
  if (new Set(ordered.map((challenge) => challenge.challengeIdentity)).size !== ordered.length) throw corruptPaymentBusinessOperation(subject, 'one challenge identity is recorded twice');
  if (ordered.length === 0) throw corruptPaymentBusinessOperation(subject, 'an operation exists with no accepted challenge');
  if (operation.organizationId !== organizationId) {
    throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION', `The caller is not authorized to access business operation '${subject}'.`);
  }
  return deepFreeze({ operation, challenges: ordered });
}

/** The record input, validated closed and checked against everything it derives from, before any critical section is entered. */
export function requireValidPaymentRecordInput(context: PaymentBusinessOperationAccessContext, input: RecordPaymentChallengeInput): void {
  const organizationId = requirePaymentAccessContext(context);
  const invalid = (message: string): PaymentBusinessOperationStoreError => new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_INPUT_INVALID', message);
  if (input === null || typeof input !== 'object') throw invalid('The record input is not an object.');
  const operationViolation = paymentBusinessOperationViolation(input.operation);
  if (operationViolation !== undefined) throw invalid(`The business operation is outside the closed contract: ${operationViolation}.`);
  const challengeViolation = paymentChallengeViolation(input.challenge);
  if (challengeViolation !== undefined) throw invalid(`The challenge is outside the closed contract: ${challengeViolation}.`);
  const derivation = paymentBusinessOperationDerivationFailure(input.operation) ?? paymentChallengeDerivationFailure(input.challenge);
  if (derivation !== undefined) throw invalid(`The record input is inconsistent: ${derivation}.`);
  const { operation, challenge } = input;
  if (
    challenge.organizationId !== operation.organizationId ||
    challenge.principalId !== operation.principalId ||
    challenge.businessOperationId !== operation.businessOperationId ||
    challenge.businessSemanticDigest !== operation.businessSemanticDigest
  ) {
    throw invalid('The challenge does not belong to the business operation it is recorded with.');
  }
  if (operation.organizationId !== organizationId) {
    throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION', 'A business operation for another organization cannot be recorded under this scope.');
  }
}

/** Where a challenge identity already lives, as read and verified inside the critical section. */
export type PaymentChallengeOwner =
  | { readonly kind: 'none' }
  | { readonly kind: 'this-operation'; readonly record: PaymentChallengeRecord }
  | { readonly kind: 'another-operation' };

export type PaymentRecordPlan = {
  readonly operation: { readonly kind: 'create' } | { readonly kind: 'existing'; readonly record: PaymentBusinessOperationRecord };
  readonly challenge: { readonly kind: 'existing'; readonly record: PaymentChallengeRecord } | { readonly kind: 'append'; readonly sequence: number };
};

/** The one write decision, taken inside the critical section over state read and verified there. */
export function planPaymentRecord(input: RecordPaymentChallengeInput, existing: PaymentBusinessOperationState | undefined, owner: PaymentChallengeOwner): PaymentRecordPlan {
  const conflict = (message: string): PaymentBusinessOperationStoreError => new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT', message);
  if (existing !== undefined && existing.operation.businessSemanticDigest !== input.operation.businessSemanticDigest) {
    throw new PaymentBusinessOperationStoreError(
      'PAYMENT_BUSINESS_OPERATION_CONFLICT',
      `Business operation '${input.operation.businessOperationId}' is already on record with different business semantics; the recorded operation stands.`,
    );
  }
  if (owner.kind === 'another-operation') throw conflict('This challenge is already on record for another business operation; one challenge pays for one operation.');
  if (owner.kind === 'this-operation') {
    if (owner.record.challengeDigest !== input.challenge.challengeDigest) throw conflict('This challenge identity is already on record for this operation as a different challenge.');
    if (existing === undefined) throw corruptPaymentBusinessOperation(input.operation.businessOperationId, 'a challenge exists with no operation');
    return { operation: { kind: 'existing', record: existing.operation }, challenge: { kind: 'existing', record: owner.record } };
  }
  if (existing === undefined) return { operation: { kind: 'create' }, challenge: { kind: 'append', sequence: 1 } };
  if (existing.challenges.length >= PAYMENT_CHALLENGES_PER_OPERATION_MAX) {
    throw new PaymentBusinessOperationStoreError(
      'PAYMENT_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL',
      `Business operation '${input.operation.businessOperationId}' already holds ${String(PAYMENT_CHALLENGES_PER_OPERATION_MAX)} challenges; nothing was recorded.`,
    );
  }
  return { operation: { kind: 'existing', record: existing.operation }, challenge: { kind: 'append', sequence: existing.challenges.length + 1 } };
}

/** The latest accepted challenge of a verified state: the highest store-assigned position. */
export function latestPaymentChallenge(state: PaymentBusinessOperationState): PaymentChallengeRecord {
  const latest = state.challenges[state.challenges.length - 1];
  if (latest === undefined) throw corruptPaymentBusinessOperation(state.operation.businessOperationId, 'an operation exists with no accepted challenge');
  return latest;
}
