import { EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS } from '../../features/exercise-control-runtime/index.js';
import {
  canonicalDecimalScale,
  isCanonicalDecimal,
  isCanonicalMonetaryAssetId,
  type MonetaryAssetRegistry,
} from '../../features/monetary-runtime/index.js';
import type { KernelAuthorityEntityKind, KernelAuthorityMonetaryConstraint } from './contracts.js';
import { KernelAuthorityError } from './errors.js';

/**
 * P10 — validation of the monetary authority a Kernel Authority record may
 * carry.
 *
 * ## Where it runs
 *
 * On **every append** (both store implementations share
 * `validateKernelAuthorityAppendInput`, so a caller that bypasses the
 * provisioning service and writes to the store directly is held to it too) and
 * again on **every hydration** (`hydration.ts`), so a record that reached the
 * durable log by any other route — an older build, a hand-edited file whose
 * digests were re-sealed — never replays into usable authority. A malformed
 * record fails hydration closed; it is never skipped, repaired or re-spelled.
 *
 * ## What it proves, and what it cannot
 *
 * Registry-free by necessity: the store holds no `MonetaryAssetRegistry`, and
 * an asset's scale is deployment configuration, not authority. So the store
 * proves *shape* — the closed constraint vocabulary, exact keys, canonical
 * decimal text, a canonical asset identifier, a strictly positive quantity, a
 * valid window, no duplicate limit identity — and refuses any field that would
 * let a record state its own scale. Whether the asset is recognized and the
 * value fits its trusted scale is checked where a registry exists: at
 * provisioning (`assertKernelAuthorityMonetaryConstraintsWithinRegistry`, when
 * the provisioning service is composed with one) and, always, at resolution,
 * which fails closed.
 */

/** A spending-limit id. Deliberately narrower than P7's own limit-id grammar so the namespaced P7 limit id derived from it always fits. */
export const KERNEL_AUTHORITY_SPENDING_LIMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** At most this many monetary constraints on one authority record. Bounded so one record cannot exhaust P7's per-exercise limit budget. */
export const KERNEL_AUTHORITY_MAXIMUM_MONETARY_CONSTRAINTS = 16;

const MONETARY_CONSTRAINT_ENTITY_KINDS: readonly KernelAuthorityEntityKind[] = ['authority-grant', 'delegation-grant'];

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}

function isPositiveCanonicalDecimal(value: unknown): value is string {
  return isCanonicalDecimal(value) && value !== '0';
}

function isValidWindow(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'lifetime') return hasExactlyKeys(value, ['kind']);
  if (value.kind === 'rolling') {
    const seconds = value.seconds;
    return hasExactlyKeys(value, ['kind', 'seconds']) && typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS;
  }
  return false;
}

/** Why one constraint is not a well-formed monetary constraint, or `undefined` when it is. */
function constraintViolation(constraint: unknown): string | undefined {
  if (!isPlainRecord(constraint)) return 'is not a plain object';
  if (constraint.type === 'max_amount') {
    if (!hasExactlyKeys(constraint, ['type', 'currency', 'value'])) return "max_amount must carry exactly 'type', 'currency' and 'value' (an asset's scale is never authority data)";
    if (!isCanonicalMonetaryAssetId(constraint.currency)) return 'max_amount.currency is not a canonical asset identifier';
    if (!isPositiveCanonicalDecimal(constraint.value)) return 'max_amount.value is not strictly positive canonical decimal text';
    return undefined;
  }
  if (constraint.type === 'spending_limit') {
    if (!hasExactlyKeys(constraint, ['type', 'limitId', 'currency', 'maximum', 'window'])) {
      return "spending_limit must carry exactly 'type', 'limitId', 'currency', 'maximum' and 'window' (no usage, remaining or scale field exists)";
    }
    if (typeof constraint.limitId !== 'string' || !KERNEL_AUTHORITY_SPENDING_LIMIT_ID_PATTERN.test(constraint.limitId)) return 'spending_limit.limitId is not canonical';
    if (!isCanonicalMonetaryAssetId(constraint.currency)) return 'spending_limit.currency is not a canonical asset identifier';
    if (!isPositiveCanonicalDecimal(constraint.maximum)) return 'spending_limit.maximum is not strictly positive canonical decimal text';
    if (!isValidWindow(constraint.window)) return 'spending_limit.window is not a lifetime window or a rolling window of 1 to 31536000 whole seconds';
    return undefined;
  }
  return `type '${String(constraint.type)}' is not a durable monetary constraint (only 'max_amount' and 'spending_limit' are enforced, so only they may be provisioned)`;
}

/**
 * Refuses a payload whose monetary constraints are not well formed.
 *
 * Total over the payload: no `constraints` key is valid (no monetary
 * authority); a `constraints` key on any kind other than an authority or
 * delegation grant is refused; so is anything that is not a bounded array of
 * well-formed constraints, or that states the same spending-limit identity
 * (`limitId`, `currency`) twice — "which of the two maxima did the operator
 * mean?" is not a question to answer by picking one.
 */
export function validateKernelAuthorityMonetaryConstraints(entityKind: KernelAuthorityEntityKind, payload: Readonly<Record<string, unknown>>, where: string): void {
  if (!Object.prototype.hasOwnProperty.call(payload, 'constraints')) return;
  const fail = (reason: string): never => {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `${where}: monetary authority constraints are malformed — ${reason}. Refused rather than stored or replayed as narrower- or wider-than-provisioned authority.`, {
      entityKind,
    });
  };
  if (!MONETARY_CONSTRAINT_ENTITY_KINDS.includes(entityKind)) fail(`a '${entityKind}' record cannot carry authority constraints`);
  const constraints = payload.constraints;
  if (!Array.isArray(constraints)) return fail('constraints must be an array');
  if (constraints.length > KERNEL_AUTHORITY_MAXIMUM_MONETARY_CONSTRAINTS) fail(`at most ${KERNEL_AUTHORITY_MAXIMUM_MONETARY_CONSTRAINTS} constraints may be stated`);
  const limitIdentities = new Set<string>();
  constraints.forEach((constraint: unknown, index: number) => {
    const violation = constraintViolation(constraint);
    if (violation !== undefined) fail(`constraints[${index}] ${violation}`);
    const typed = constraint as KernelAuthorityMonetaryConstraint;
    if (typed.type === 'spending_limit') {
      const identity = JSON.stringify([typed.limitId, typed.currency]);
      if (limitIdentities.has(identity)) fail(`constraints[${index}] repeats spending limit '${typed.limitId}' in '${typed.currency}'`);
      limitIdentities.add(identity);
    }
  });
}

/**
 * The provisioning-time half: every monetary constraint names an asset the
 * deployment's trusted registry recognizes, and states no more fractional
 * digits than that asset's trusted scale. Refused, never rounded.
 */
export function assertKernelAuthorityMonetaryConstraintsWithinRegistry(constraints: readonly KernelAuthorityMonetaryConstraint[] | undefined, assets: MonetaryAssetRegistry): void {
  for (const constraint of constraints ?? []) {
    const asset = assets.resolve(constraint.currency);
    const value = constraint.type === 'max_amount' ? constraint.value : constraint.maximum;
    if (asset === undefined) {
      throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `Monetary authority names asset '${constraint.currency}', which this deployment's trusted asset registry does not recognize.`);
    }
    if (!isCanonicalDecimal(value) || canonicalDecimalScale(value) > asset.scale) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_VALIDATION_ERROR',
        `Monetary authority '${value}' ${constraint.currency} states more fractional digits than the asset's trusted scale (${asset.scale}). Refused, never rounded.`,
      );
    }
  }
}
