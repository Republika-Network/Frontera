import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { KernelEvaluationResult } from '../contracts/kernel-result.js';
import { KernelInvariantError } from '../errors/kernel-errors.js';

/**
 * Mechanically-checkable invariants from `docs/kernel/AOC_KERNEL_INVARIANTS_V1.md`.
 * Asserted on every `AocKernel.evaluate()`/`enforce()` call; a violation here
 * means the wrapped engine (or the kernel's own adapters) produced output
 * inconsistent with a documented invariant -- a bug, not a governance
 * outcome, hence a thrown `KernelInvariantError` rather than a result field.
 */

/** Invariant 1: no action may be allowed for an unrecognized actor. */
export function assertRecognitionPrecedesAllow(result: KernelEvaluationResult): void {
  if (result.status === 'allowed' && (!result.recognition.performed || result.recognition.recognized !== true)) {
    throw new KernelInvariantError(
      `Kernel invariant violated: decision ${result.decisionId} was 'allowed' without a performed, recognized recognition evaluation.`,
    );
  }
}

/** Invariant 8: every terminal result must contain machine-readable reasons. */
export function assertReasonCodesPresent(result: KernelEvaluationResult): void {
  if (result.reasonCodes.length === 0) {
    throw new KernelInvariantError(`Kernel invariant violated: decision ${result.decisionId} carries no reason codes.`);
  }
}

/**
 * Deliberately not JSON-based: `KernelEvaluationRequest.context`/
 * `action.parameters` are typed `Record<string, unknown>`, so a caller may
 * legitimately put a `Date`, `NaN`, or `BigInt` in there. A JSON round-trip
 * would silently coerce a `Date` to a string, drop `undefined`, and throw on
 * `BigInt` -- turning an untouched request into a false "mutated" positive
 * (or a crash) before evaluation ever runs. `Object.is` (not `===`) makes
 * `NaN` compare equal to itself; `Date` is compared by epoch value.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
    return false;
  }
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}

/**
 * Clones a `KernelEvaluationRequest` for the "no mutation of input"
 * invariant check without lossy JSON coercion (see `deepEqual` above for
 * why JSON round-tripping is unsafe here). Recurses through plain objects
 * and arrays, copies `Date` instances, and otherwise keeps the original
 * reference (functions, `Map`/`Set`/`RegExp`, symbols, `BigInt`) -- those
 * are never mutated by the kernel's own adapters, so a reference copy is
 * sufficient for detecting kernel-caused mutation.
 */
export function cloneKernelEvaluationRequest(request: KernelEvaluationRequest): KernelEvaluationRequest {
  return cloneValue(request) as KernelEvaluationRequest;
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const cloned: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      // Defined, never assigned: an own `__proto__` key in a request's context
      // is data, and assignment would invoke the prototype setter — the
      // snapshot would then differ from the request it was taken of.
      Object.defineProperty(cloned, key, { value: cloneValue(entryValue), enumerable: true, writable: true, configurable: true });
    }
    return cloned;
  }
  return value;
}

/**
 * No mutation of input: compares the request as originally received against
 * its state after evaluation completed. Structural (order-independent),
 * not a reference check, since the adapters legitimately build new objects
 * from the request's fields rather than mutating it in place.
 */
export function assertRequestNotMutated(before: KernelEvaluationRequest, after: KernelEvaluationRequest): void {
  if (!deepEqual(before, after)) {
    throw new KernelInvariantError(`Kernel invariant violated: KernelEvaluationRequest ${before.requestId} was mutated during evaluation.`);
  }
}

export function assertKernelInvariants(request: KernelEvaluationRequest, requestSnapshot: KernelEvaluationRequest, result: KernelEvaluationResult): void {
  assertRequestNotMutated(requestSnapshot, request);
  assertReasonCodesPresent(result);
  assertRecognitionPrecedesAllow(result);
}
