import { isSemanticIdentifier, isWellFormedGovernedParameterBound, type GovernedParameterBound } from '../../features/governed-parameter-runtime/index.js';
import type { KernelAuthorityEntityKind, KernelAuthorityParameterBound } from './contracts.js';
import { KernelAuthorityError } from './errors.js';

/**
 * CTRL-02 — validation of the typed governed-parameter authority a Kernel
 * Authority record may carry (`parameterBounds`).
 *
 * The value is the canonical CORE-03 bound — `{ dimension } &
 * GovernedParameterBound`, the exact shape a signed BoundedGrant's
 * `scope.parameters` already uses — and nothing here restates its algebra:
 * well-formedness is `isWellFormedGovernedParameterBound`, the dimension grammar
 * is `isSemanticIdentifier`. What this module adds is only what durable storage
 * needs: closed keys, plain data-only objects (no accessor, no prototype), a
 * bounded list in canonical order (strictly increasing dimension id, so no
 * duplicate and one spelling per set of bounds).
 *
 * Runs on **every append** (both store implementations, whoever the caller is)
 * and on **every hydration**: a record that reached the log by any other route
 * never replays into usable authority. Absent `parameterBounds` is the historical
 * meaning — no parameter restriction beyond the record's other scope — and is
 * never reinterpreted.
 */

/** At most this many parameter bounds on one authority record. */
export const KERNEL_AUTHORITY_MAXIMUM_PARAMETER_BOUNDS = 32;

const PARAMETER_BOUND_ENTITY_KINDS: readonly KernelAuthorityEntityKind[] = ['authority-grant', 'delegation-grant'];

function isPlainDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  // Data properties only: an accessor could answer one value to validation and another to replay.
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}

/** Why one entry is not a well-formed canonical parameter bound, or `undefined` when it is. */
function boundViolation(entry: unknown): string | undefined {
  if (!isPlainDataRecord(entry)) return 'is not a plain data object';
  const keys = entry['kind'] === 'maximum' ? ['dimension', 'kind', 'type', 'limit'] : ['dimension', 'kind', 'type', 'value'];
  if (!hasExactlyKeys(entry, keys)) return `must carry exactly ${keys.join(', ')}`;
  if (!isSemanticIdentifier(entry['dimension'])) return 'dimension is not a canonical dimension id';
  const { dimension: _dimension, ...bound } = entry;
  if (!isWellFormedGovernedParameterBound(bound as unknown as GovernedParameterBound)) return 'is not a well-formed governed parameter bound (CORE-03: exact integer/token/boolean, or maximum integer; safe integers, no -0, token grammar, no coercion)';
  return undefined;
}

/**
 * Refuses a payload whose `parameterBounds` are not well formed. Total over the
 * payload: no `parameterBounds` key is valid (no parameter authority); the key on
 * any kind other than an authority or delegation grant is refused; so is
 * anything but a non-empty, bounded, canonically ordered list of canonical bounds.
 */
export function validateKernelAuthorityParameterBounds(entityKind: KernelAuthorityEntityKind, payload: Readonly<Record<string, unknown>>, where: string): void {
  if (!Object.prototype.hasOwnProperty.call(payload, 'parameterBounds')) return;
  const fail = (reason: string): never => {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `${where}: parameter authority bounds are malformed — ${reason}. Refused rather than stored or replayed as narrower- or wider-than-provisioned authority.`, {
      entityKind,
    });
  };
  if (!PARAMETER_BOUND_ENTITY_KINDS.includes(entityKind)) fail(`a '${entityKind}' record cannot carry parameter bounds`);
  const bounds = payload['parameterBounds'];
  if (!Array.isArray(bounds) || bounds.length === 0) return fail('parameterBounds must be a non-empty array');
  if (bounds.length > KERNEL_AUTHORITY_MAXIMUM_PARAMETER_BOUNDS) fail(`at most ${KERNEL_AUTHORITY_MAXIMUM_PARAMETER_BOUNDS} parameter bounds may be stated`);
  let previous: string | undefined;
  bounds.forEach((entry: unknown, index: number) => {
    const violation = boundViolation(entry);
    if (violation !== undefined) fail(`parameterBounds[${index}] ${violation}`);
    const dimension = (entry as KernelAuthorityParameterBound).dimension;
    // Canonical order, strictly increasing: no duplicate dimension, one spelling.
    if (previous !== undefined && !(previous < dimension)) fail(`parameterBounds[${index}] is out of canonical order or repeats dimension '${dimension}'`);
    previous = dimension;
  });
}

/** The record's parameter bounds, already validated; empty when it states none. */
export function readKernelAuthorityParameterBounds(payload: Readonly<Record<string, unknown>>): readonly KernelAuthorityParameterBound[] {
  const bounds = payload['parameterBounds'];
  return Array.isArray(bounds) ? (bounds as readonly KernelAuthorityParameterBound[]) : [];
}
