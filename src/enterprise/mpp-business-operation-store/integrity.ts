import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import { computeMppBusinessSemanticDigest, computeMppChallengeDigest, deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from '../mpp-challenge/business-identity.js';
import {
  MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  type MppBusinessOperationInput,
  type MppBusinessOperationRecord,
  type MppChallengeInstanceInput,
  type MppChallengeInstanceRecord,
} from './contracts.js';
import { isCanonicalMppInstant, mppBusinessOperationViolation, mppChallengeInstanceViolation } from './validation.js';

/**
 * Integrity for the MPP business-operation store.
 *
 * The same canonicalization and digest primitive as the Governance Store, P11
 * and P12 — `aoc.canonical-json.v1`, SHA-256 — each record domain-separated by
 * a versioned tag.
 *
 * Beyond each row's own digest, every read **recomputes what is derived**:
 * the business semantic digest from the operation's terms, the governed
 * idempotency key and request id from its scope, and each challenge digest
 * from its exact fields. A row whose derived values disagree with its terms is
 * corrupt, whatever its record digest says.
 *
 * Integrity is not authenticity (P20).
 */

const OPERATION_RECORD_DOMAIN = 'aoc.mpp.business-operation.record.v1';
const CHALLENGE_RECORD_DOMAIN = 'aoc.mpp.challenge-instance.record.v1';

/** A fresh, plain copy with only the declared fields. */
export function operationFact(input: MppBusinessOperationInput): MppBusinessOperationInput {
  return {
    organizationId: input.organizationId,
    principalId: input.principalId,
    businessOperationId: input.businessOperationId,
    businessSemanticDigest: input.businessSemanticDigest,
    action: input.action,
    resource: input.resource,
    counterparty: input.counterparty,
    amount: { value: input.amount.value, unit: input.amount.unit },
    intent: input.intent,
    httpMethod: input.httpMethod,
    ...(input.contentDigest !== undefined ? { contentDigest: input.contentDigest } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    governedIdempotencyKey: input.governedIdempotencyKey,
    governedRequestId: input.governedRequestId,
    createdAt: input.createdAt,
  };
}

/** A fresh, plain copy with only the declared fields. */
export function challengeFact(input: MppChallengeInstanceInput): MppChallengeInstanceInput {
  return {
    organizationId: input.organizationId,
    principalId: input.principalId,
    businessOperationId: input.businessOperationId,
    businessSemanticDigest: input.businessSemanticDigest,
    challengeDigest: input.challengeDigest,
    id: input.id,
    realm: input.realm,
    method: input.method,
    intent: input.intent,
    request: input.request,
    ...(input.expires !== undefined ? { expires: input.expires } : {}),
    ...(input.digest !== undefined ? { digest: input.digest } : {}),
    ...(input.opaque !== undefined ? { opaque: input.opaque } : {}),
    ...(input.header !== undefined ? { header: input.header } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    observedAt: input.observedAt,
  };
}

function operationDigestOf(fact: MppBusinessOperationInput, schemaVersion: string, recordedAt: string): string {
  return computeDigest({ domain: OPERATION_RECORD_DOMAIN, schemaVersion, ...fact, contentDigest: fact.contentDigest ?? null, externalId: fact.externalId ?? null, recordedAt });
}

function challengeDigestOf(fact: MppChallengeInstanceInput, schemaVersion: string, challengeSequence: number, recordedAt: string): string {
  return computeDigest({
    domain: CHALLENGE_RECORD_DOMAIN,
    schemaVersion,
    ...fact,
    expires: fact.expires ?? null,
    digest: fact.digest ?? null,
    opaque: fact.opaque ?? null,
    header: fact.header ?? null,
    description: fact.description ?? null,
    challengeSequence,
    recordedAt,
  });
}

export function buildMppBusinessOperationRecord(input: MppBusinessOperationInput, recordedAt: string): MppBusinessOperationRecord {
  const fact = operationFact(input);
  const schemaVersion = MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, recordedAt, recordDigest: operationDigestOf(fact, schemaVersion, recordedAt) });
}

export function buildMppChallengeInstanceRecord(input: MppChallengeInstanceInput, challengeSequence: number, recordedAt: string): MppChallengeInstanceRecord {
  const fact = challengeFact(input);
  const schemaVersion = MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, challengeSequence, recordedAt, recordDigest: challengeDigestOf(fact, schemaVersion, challengeSequence, recordedAt) });
}

/**
 * Why an operation's own terms disagree with what is derived from them, or
 * `undefined`. Run before anything is written, so a caller cannot store a
 * semantic digest, key or request id that its terms do not produce.
 */
export function mppBusinessOperationDerivationFailure(input: MppBusinessOperationInput): string | undefined {
  const scope = { organizationId: input.organizationId, principalId: input.principalId, businessOperationId: input.businessOperationId };
  if (computeMppBusinessSemanticDigest({ ...scope, ...operationFact(input) }) !== input.businessSemanticDigest) return 'the business semantic digest does not recompute from the terms';
  if (deriveMppGovernedIdempotencyKey(scope) !== input.governedIdempotencyKey) return 'the governed idempotency key does not derive from the scope';
  if (deriveMppGovernedRequestId(scope) !== input.governedRequestId) return 'the governed request id does not derive from the scope';
  return undefined;
}

/** Why a challenge's digest disagrees with its exact fields, or `undefined`. */
export function mppChallengeDerivationFailure(input: MppChallengeInstanceInput): string | undefined {
  return computeMppChallengeDigest(input) === input.challengeDigest ? undefined : 'the challenge digest does not recompute from the exact fields';
}

/** Why a persisted operation fails verification, or `undefined` when it verifies. */
export function mppBusinessOperationRecordFailure(record: MppBusinessOperationRecord): string | undefined {
  if (record.schemaVersion !== MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) return 'the operation carries an unknown schema version';
  const { schemaVersion, recordedAt, recordDigest, ...fact } = record;
  const violation = mppBusinessOperationViolation(fact);
  if (violation !== undefined) return `the operation is outside the contract (${violation})`;
  if (!isCanonicalMppInstant(recordedAt)) return 'the operation recordedAt is not a canonical instant';
  if (typeof recordDigest !== 'string' || !isWellFormedDigest(recordDigest)) return 'the operation digest is malformed';
  if (operationDigestOf(operationFact(fact), schemaVersion, recordedAt) !== recordDigest) return 'the operation digest does not recompute';
  return mppBusinessOperationDerivationFailure(fact);
}

/** Why a persisted challenge fails verification against its operation, or `undefined` when it verifies. */
export function mppChallengeInstanceRecordFailure(record: MppChallengeInstanceRecord, operation: MppBusinessOperationRecord): string | undefined {
  if (record.schemaVersion !== MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) return 'the challenge carries an unknown schema version';
  const { schemaVersion, challengeSequence, recordedAt, recordDigest, ...fact } = record;
  const violation = mppChallengeInstanceViolation(fact);
  if (violation !== undefined) return `the challenge is outside the contract (${violation})`;
  if (typeof challengeSequence !== 'number' || !Number.isSafeInteger(challengeSequence) || challengeSequence < 1) return 'the challenge sequence is not a positive integer';
  if (!isCanonicalMppInstant(recordedAt)) return 'the challenge recordedAt is not a canonical instant';
  if (typeof recordDigest !== 'string' || !isWellFormedDigest(recordDigest)) return 'the challenge digest is malformed';
  if (challengeDigestOf(challengeFact(fact), schemaVersion, challengeSequence, recordedAt) !== recordDigest) return 'the challenge record digest does not recompute';
  const derivation = mppChallengeDerivationFailure(fact);
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
