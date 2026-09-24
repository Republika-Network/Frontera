import { EXECUTION_FAILURE_REASON_VALUES, isRecordableProviderRef } from '../../features/execution-runtime/index.js';
import { isWellFormedDigest } from '../governance-store/digest.js';
import { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from '../execution-outcome-store/validation.js';

/**
 * The closed contract every binding and every resolution must satisfy —
 * checked before anything is written, and again on every read of a persisted
 * row, in memory and in SQLite alike.
 *
 * Identifiers and instants are P11's own primitives, reused verbatim, and the
 * provider reference is P11's `isRecordableProviderRef`: one definition of
 * each, so a reference P11 would refuse is refused here too.
 */

export { isCanonicalOutcomeInstant as isCanonicalResolutionInstant, isOpaqueExecutionIdentifier as isOpaqueResolutionIdentifier };

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function undeclared(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

export function isExecutionFailureReason(value: unknown): boolean {
  return typeof value === 'string' && (EXECUTION_FAILURE_REASON_VALUES as readonly string[]).includes(value);
}

const BINDING_KEYS = ['organizationId', 'executionId', 'attemptDigest', 'authorityId', 'origin', 'boundAt'] as const;

/** Why a binding is outside the contract, or `undefined` when it is inside it. */
export function executionResolutionBindingViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the binding is not a plain object';
  const extra = undeclared(input, BINDING_KEYS);
  if (extra !== undefined) return `undeclared key '${extra}'`;
  for (const key of ['organizationId', 'executionId', 'authorityId'] as const) {
    if (!isOpaqueExecutionIdentifier(input[key])) return `${key} is not an opaque identifier`;
  }
  if (typeof input['attemptDigest'] !== 'string' || !isWellFormedDigest(input['attemptDigest'])) return 'attemptDigest is not a digest';
  if (input['origin'] !== 'pre-claim' && input['origin'] !== 'adopted') return 'origin is neither pre-claim nor adopted';
  if (!isCanonicalOutcomeInstant(input['boundAt'])) return 'boundAt is not a canonical instant';
  return undefined;
}

const RESOLUTION_KEYS = ['organizationId', 'executionId', 'attemptDigest', 'bindingDigest', 'basisObservationDigest', 'authorityId', 'certainty', 'failure', 'providerRef', 'resolvedAt'] as const;

/**
 * Why a resolution is outside the contract, or `undefined` when it is inside
 * it. Exactly the declared keys — no amount, asset, grant, budget, decision or
 * correlation beyond the execution identity: those are the attempt's, and a
 * resolution cannot restate them. A completion never carries a failure; a
 * non-completion always carries one from the existing closed vocabulary.
 */
export function executionResolutionViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the resolution is not a plain object';
  const extra = undeclared(input, RESOLUTION_KEYS);
  if (extra !== undefined) return `undeclared key '${extra}'`;
  for (const key of ['organizationId', 'executionId', 'authorityId'] as const) {
    if (!isOpaqueExecutionIdentifier(input[key])) return `${key} is not an opaque identifier`;
  }
  for (const key of ['attemptDigest', 'bindingDigest'] as const) {
    if (typeof input[key] !== 'string' || !isWellFormedDigest(input[key])) return `${key} is not a digest`;
  }
  const basis = input['basisObservationDigest'];
  if (basis !== undefined && (typeof basis !== 'string' || !isWellFormedDigest(basis))) return 'basisObservationDigest is not a digest';
  const certainty = input['certainty'];
  if (certainty === 'confirmed-not-completed') {
    if (!isExecutionFailureReason(input['failure'])) return 'a confirmed non-completion requires a provider-neutral failure reason';
  } else if (certainty === 'confirmed-completed') {
    if (input['failure'] !== undefined) return 'a confirmed completion may not carry a failure reason';
  } else {
    return 'certainty is neither confirmed-completed nor confirmed-not-completed';
  }
  if (input['providerRef'] !== undefined && !isRecordableProviderRef(input['providerRef'])) return 'providerRef is not a recordable provider reference';
  if (!isCanonicalOutcomeInstant(input['resolvedAt'])) return 'resolvedAt is not a canonical instant';
  return undefined;
}
