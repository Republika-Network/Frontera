import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
  type BindExecutionResolutionAuthorityInput,
  type ExecutionResolutionBinding,
  type ExecutionResolutionRecord,
  type RecordExecutionResolutionInput,
} from './contracts.js';
import { executionResolutionBindingViolation, executionResolutionViolation, isCanonicalResolutionInstant } from './validation.js';

/**
 * Integrity for the execution resolution store.
 *
 * The same canonicalization and digest primitive as P11 and the Governance
 * Store — `aoc.canonical-json.v1`, SHA-256 — reused verbatim, each input
 * domain-separated by a versioned tag, so a binding digest can never equal a
 * resolution digest, or a P11 digest, over the same bytes.
 *
 * - The **binding digest** commits to the organization, the execution, the
 *   P11 attempt digest, the authority, the origin, both instants and the schema.
 * - The **resolution digest** commits to all of that resolution's fields —
 *   including the binding digest and, when present, the P11 observation digest
 *   it resolved — so a resolution cannot be re-pointed at another attempt,
 *   another binding, another authority or another uncertainty without failing
 *   verification.
 *
 * Integrity is not authenticity (P20).
 */

const BINDING_DOMAIN = 'aoc.execution-resolution.binding.v1';
const RESOLUTION_DOMAIN = 'aoc.execution-resolution.resolution.v1';

/** A fresh, plain copy with only the declared fields. */
export function bindingFact(input: BindExecutionResolutionAuthorityInput): BindExecutionResolutionAuthorityInput {
  return {
    organizationId: input.organizationId,
    executionId: input.executionId,
    attemptDigest: input.attemptDigest,
    authorityId: input.authorityId,
    origin: input.origin,
    boundAt: input.boundAt,
  };
}

/** A fresh, plain copy with only the declared fields, and only the arm's own optional ones. */
export function resolutionFact(input: RecordExecutionResolutionInput): RecordExecutionResolutionInput {
  return {
    organizationId: input.organizationId,
    executionId: input.executionId,
    attemptDigest: input.attemptDigest,
    bindingDigest: input.bindingDigest,
    ...(input.basisObservationDigest !== undefined ? { basisObservationDigest: input.basisObservationDigest } : {}),
    authorityId: input.authorityId,
    certainty: input.certainty,
    ...(input.certainty === 'confirmed-not-completed' && input.failure !== undefined ? { failure: input.failure } : {}),
    ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    resolvedAt: input.resolvedAt,
  };
}

function bindingDigestOf(fact: BindExecutionResolutionAuthorityInput, schemaVersion: string, recordedAt: string): string {
  return computeDigest({ domain: BINDING_DOMAIN, schemaVersion, ...fact, recordedAt });
}

function resolutionDigestOf(fact: RecordExecutionResolutionInput, schemaVersion: string, recordedAt: string): string {
  return computeDigest({
    domain: RESOLUTION_DOMAIN,
    schemaVersion,
    ...fact,
    basisObservationDigest: fact.basisObservationDigest ?? null,
    failure: fact.failure ?? null,
    providerRef: fact.providerRef ?? null,
    recordedAt,
  });
}

export function buildExecutionResolutionBinding(input: BindExecutionResolutionAuthorityInput, recordedAt: string): ExecutionResolutionBinding {
  const fact = bindingFact(input);
  const schemaVersion = EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, recordedAt, bindingDigest: bindingDigestOf(fact, schemaVersion, recordedAt) });
}

export function buildExecutionResolutionRecord(input: RecordExecutionResolutionInput, recordedAt: string): ExecutionResolutionRecord {
  const fact = resolutionFact(input);
  const schemaVersion = EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, recordedAt, resolutionDigest: resolutionDigestOf(fact, schemaVersion, recordedAt) });
}

/**
 * Whether a repeated binding is the same binding: the same execution, attempt
 * and authority. Not the instant and not the origin — a governed request
 * retried after a crash before its claim finds its own binding, and an
 * operator adopting the authority already bound finds it too.
 */
export function sameExecutionResolutionBinding(recorded: ExecutionResolutionBinding, input: BindExecutionResolutionAuthorityInput): boolean {
  return (
    recorded.organizationId === input.organizationId &&
    recorded.executionId === input.executionId &&
    recorded.attemptDigest === input.attemptDigest &&
    recorded.authorityId === input.authorityId
  );
}

/**
 * Whether a repeated resolution is the same definitive fact — every field but
 * the instant. Two explicit reconciliations racing through two read-only
 * lookups sample two different `resolvedAt`s; when they learned the same
 * answer that is one fact, and the first stands. Any other difference — the
 * certainty, the failure, the reference, the basis — is a conflict.
 */
export function sameExecutionResolution(recorded: ExecutionResolutionRecord, input: RecordExecutionResolutionInput): boolean {
  const { resolvedAt: _left, ...left } = resolutionFact(recorded);
  const { resolvedAt: _right, ...right } = resolutionFact(input);
  return canonicalSerialize(left) === canonicalSerialize(right);
}

/** Why a persisted binding fails verification, or `undefined` when it verifies. */
export function executionResolutionBindingFailure(record: ExecutionResolutionBinding): string | undefined {
  if (record.schemaVersion !== EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION) return 'the binding carries an unknown schema version';
  const { schemaVersion, recordedAt, bindingDigest, ...fact } = record;
  const violation = executionResolutionBindingViolation(fact);
  if (violation !== undefined) return `the binding is outside the contract (${violation})`;
  if (!isCanonicalResolutionInstant(recordedAt)) return 'the binding recordedAt is not a canonical instant';
  if (typeof bindingDigest !== 'string' || !isWellFormedDigest(bindingDigest)) return 'the binding digest is malformed';
  if (bindingDigestOf(bindingFact(fact), schemaVersion, recordedAt) !== bindingDigest) return 'the binding digest does not recompute';
  return undefined;
}

/** Why a persisted resolution fails verification against its binding, or `undefined` when it verifies. */
export function executionResolutionRecordFailure(record: ExecutionResolutionRecord, binding: ExecutionResolutionBinding): string | undefined {
  if (record.schemaVersion !== EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION) return 'the resolution carries an unknown schema version';
  const { schemaVersion, recordedAt, resolutionDigest, ...fact } = record;
  const violation = executionResolutionViolation(fact);
  if (violation !== undefined) return `the resolution is outside the contract (${violation})`;
  if (record.organizationId !== binding.organizationId || record.executionId !== binding.executionId) return 'the resolution does not belong to its binding';
  if (record.attemptDigest !== binding.attemptDigest || record.bindingDigest !== binding.bindingDigest || record.authorityId !== binding.authorityId) {
    return 'the resolution names a different attempt, binding or authority';
  }
  if (!isCanonicalResolutionInstant(recordedAt)) return 'the resolution recordedAt is not a canonical instant';
  if (typeof resolutionDigest !== 'string' || !isWellFormedDigest(resolutionDigest)) return 'the resolution digest is malformed';
  if (resolutionDigestOf(resolutionFact(fact), schemaVersion, recordedAt) !== resolutionDigest) return 'the resolution digest does not recompute';
  return undefined;
}
