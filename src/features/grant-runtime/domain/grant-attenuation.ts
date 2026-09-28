import { compareDimensionIds, compareGovernedParameterBound, governedParameterBoundComparisonPermits } from '../../governed-parameter-runtime/index.js';
import { compareGrantBound, grantBoundComparisonPermits, isWellFormedGrantBound, type GrantBound, type GrantBoundComparison } from './grant-bound.js';
import { GRANT_REASON_CODES, type GrantReasonCode } from './grant-reason-codes.js';
import {
  GRANT_BOUND_KEYS,
  GRANT_BOUND_KINDS_BY_KEY,
  canonicalGrantScope,
  grantParameterBound,
  isWellFormedGrantParameterBounds,
  type GrantBoundKey,
  type GrantParameterBound,
  type GrantParameterBounds,
  type GrantScope,
} from './grant-scope.js';

/**
 * The attenuation engine.
 *
 * > **GRANT ⊆ AUTHORIZED AUTHORITY**
 *
 * This is the settling invariant of layer E, and this file is the whole of its
 * enforcement. `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4:
 * "**Attenuation only.** A grant ⊆ its decision, exactly as a `DelegationGrant`
 * ⊆ its source in Authority Graph. Same rule, same reason, now applied one
 * layer down." `ADR-AUTHORITY-CONTROL-LAYERING.md` §5 and
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4 invariant 5 restate it as layer
 * law.
 *
 * ## The rule, exactly
 *
 * For each axis the requester narrows, the requested bound is compared against
 * the source bound and must come back `equal` or `narrower`. For each axis the
 * requester says nothing about, the grant **inherits the source bound
 * unchanged** — ADR §4's "if no requested narrowing is supplied, grant bounds =
 * source authority bounds". Inheriting is safe because ⊆ is reflexive;
 * defaulting an unstated axis to *unbounded* would be the one change that could
 * widen, so it is not what happens.
 *
 * ## Fail-closed, in four places
 *
 * 1. a requested bound **broader** than its source — refused;
 * 2. a requested bound **incomparable** to its source (different shape,
 *    different unit, unparseable instant) — refused, never assumed benign;
 * 3. a requested bound on an axis the source **never stated** — refused. A
 *    source silent on an axis is not a source that bounded it generously; ⊆
 *    cannot be established against a bound that does not exist, and
 *    `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4 invariant 6 gives an
 *    unestablishable state exactly one direction;
 * 4. a requested bound carrying the **wrong shape for its axis** — refused
 *    before comparison, so an `amount` expressed as a set is never "compared"
 *    by set inclusion.
 *
 * ## What this file is not
 *
 * No `eval`, no `new Function`, no parser, no expression language, no
 * user-supplied predicate, no dynamic dispatch on caller data. Every comparison
 * is a total function over a closed union, selected by a `switch` the compiler
 * checks. `tests/grant-layer-boundaries.test.ts` asserts the absence of dynamic
 * evaluation against the sources themselves.
 */

/**
 * What one attenuation report entry is about: an axis, the parameter list as a
 * whole (`parameters`, when the list itself is unusable), or one declared
 * parameter dimension (`parameters.<dimension>`).
 */
export type GrantAttenuationKey = GrantBoundKey | 'parameters' | `parameters.${string}`;

/** One axis's comparison, reported whether it passed or failed, so an operator sees the whole picture rather than the first refusal. */
export interface GrantBoundAttenuation {
  readonly key: GrantAttenuationKey;
  readonly comparison: GrantBoundComparison;
  /** `true` when the requester stated this bound; `false` when the grant inherited the source's. */
  readonly narrowingRequested: boolean;
  readonly permitted: boolean;
}

export interface GrantAttenuationViolation {
  readonly key: GrantAttenuationKey;
  readonly reasonCode: GrantReasonCode;
  readonly comparison: GrantBoundComparison;
}

export type GrantAttenuationOutcome =
  | { readonly outcome: 'attenuated'; readonly scope: GrantScope; readonly bounds: readonly GrantBoundAttenuation[] }
  | { readonly outcome: 'refused'; readonly violations: readonly GrantAttenuationViolation[]; readonly bounds: readonly GrantBoundAttenuation[] };

/**
 * A requested narrowing: at most one bound per axis, every axis optional, and
 * optionally a parameter bound list — at most one bound per declared dimension,
 * each attenuated exactly like an axis.
 */
export type RequestedGrantBounds = { readonly [K in GrantBoundKey]?: GrantBound } & { readonly parameters?: GrantParameterBounds };

function violationFor(key: GrantAttenuationKey, comparison: GrantBoundComparison): GrantAttenuationViolation {
  return {
    key,
    comparison,
    reasonCode: comparison === 'broader' ? GRANT_REASON_CODES.GRANT_SCOPE_BROADENING : GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE,
  };
}

/**
 * Derives the bounds a grant would carry, or refuses to.
 *
 * Deterministic and order-independent: axes are visited in `GRANT_BOUND_KEYS`
 * order, every axis is visited exactly once, and the result depends on nothing
 * but the two arguments. Called twice with the same inputs it produces the same
 * scope, the same bound report and the same violations, byte for byte — which
 * is what `tests/grant-determinism.test.ts` pins and what lets an issued grant's
 * identity be derived rather than generated.
 */
export function attenuateGrantScope(source: GrantScope, requested: RequestedGrantBounds = {}): GrantAttenuationOutcome {
  const bounds: GrantBoundAttenuation[] = [];
  const violations: GrantAttenuationViolation[] = [];
  const derived: { -readonly [K in GrantBoundKey]?: GrantBound } = {};

  for (const key of GRANT_BOUND_KEYS) {
    const sourceBound = source[key];
    const requestedBound = requested[key];

    if (requestedBound === undefined) {
      // Nothing requested on this axis: inherit the source bound exactly. An
      // axis the source did not state stays unstated — inheriting nothing is
      // not the same as granting everything, and no later reader treats it as
      // such.
      if (sourceBound !== undefined) {
        if (!isWellFormedGrantBound(sourceBound) || sourceBound.kind !== GRANT_BOUND_KINDS_BY_KEY[key]) {
          // A malformed *source* bound is refused too. A parent nobody can read
          // is not a parent a child can be proven to sit inside.
          const violation = violationFor(key, 'incomparable');
          violations.push(violation);
          bounds.push({ key, comparison: 'incomparable', narrowingRequested: false, permitted: false });
          continue;
        }
        derived[key] = sourceBound;
        bounds.push({ key, comparison: 'equal', narrowingRequested: false, permitted: true });
      }
      continue;
    }

    if (sourceBound === undefined) {
      // Requesting a bound on an axis the source never bounded. Refused: there
      // is no parent to prove ⊆ against, and treating the absence as
      // "unbounded, so anything is narrower" is precisely the fail-open this
      // layer exists to prevent.
      const violation = violationFor(key, 'incomparable');
      violations.push(violation);
      bounds.push({ key, comparison: 'incomparable', narrowingRequested: true, permitted: false });
      continue;
    }

    if (requestedBound.kind !== GRANT_BOUND_KINDS_BY_KEY[key] || sourceBound.kind !== GRANT_BOUND_KINDS_BY_KEY[key]) {
      const violation = violationFor(key, 'incomparable');
      violations.push(violation);
      bounds.push({ key, comparison: 'incomparable', narrowingRequested: true, permitted: false });
      continue;
    }

    const comparison = compareGrantBound(sourceBound, requestedBound);
    const permitted = grantBoundComparisonPermits(comparison);
    bounds.push({ key, comparison, narrowingRequested: true, permitted });
    if (!permitted) {
      violations.push(violationFor(key, comparison));
      continue;
    }
    derived[key] = requestedBound;
  }

  const parameters = attenuateParameterBounds(source.parameters, requested.parameters, bounds, violations);

  if (violations.length > 0) return { outcome: 'refused', violations, bounds };
  return { outcome: 'attenuated', scope: canonicalGrantScope({ ...derived, ...(parameters !== undefined ? { parameters } : {}) }), bounds };
}

/**
 * The parameter half of attenuation — the same four fail-closed rules, one
 * declared dimension at a time, in canonical dimension order:
 *
 * 1. a requested bound broader than its source bound — refused;
 * 2. an incomparable one (another kind, another type, a malformed value) — refused;
 * 3. a requested bound on a dimension the source never bounded — refused;
 * 4. an unusable list on either side (unsorted, duplicated, malformed) — refused
 *    as a whole, because "which of the two `recordCount` bounds is the real
 *    one?" has no safe answer.
 *
 * A dimension the requester says nothing about inherits the source bound
 * unchanged — never "unbounded".
 */
function attenuateParameterBounds(
  source: GrantParameterBounds | undefined,
  requested: GrantParameterBounds | undefined,
  bounds: GrantBoundAttenuation[],
  violations: GrantAttenuationViolation[],
): GrantParameterBounds | undefined {
  if (source === undefined && requested === undefined) return undefined;
  if ((source !== undefined && !isWellFormedGrantParameterBounds(source)) || (requested !== undefined && !isWellFormedGrantParameterBounds(requested))) {
    violations.push(violationFor('parameters', 'incomparable'));
    bounds.push({ key: 'parameters', comparison: 'incomparable', narrowingRequested: requested !== undefined, permitted: false });
    return undefined;
  }
  const dimensions = [...new Set([...(source ?? []), ...(requested ?? [])].map((entry) => entry.dimension))].sort(compareDimensionIds);
  const derived: GrantParameterBound[] = [];
  for (const dimension of dimensions) {
    const key: GrantAttenuationKey = `parameters.${dimension}`;
    const sourceBound = grantParameterBound(source, dimension);
    const requestedBound = grantParameterBound(requested, dimension);
    if (requestedBound === undefined) {
      if (sourceBound !== undefined) {
        derived.push(sourceBound);
        bounds.push({ key, comparison: 'equal', narrowingRequested: false, permitted: true });
      }
      continue;
    }
    if (sourceBound === undefined) {
      violations.push(violationFor(key, 'incomparable'));
      bounds.push({ key, comparison: 'incomparable', narrowingRequested: true, permitted: false });
      continue;
    }
    const comparison = compareGovernedParameterBound(sourceBound, requestedBound);
    const permitted = governedParameterBoundComparisonPermits(comparison);
    bounds.push({ key, comparison, narrowingRequested: true, permitted });
    if (!permitted) {
      violations.push(violationFor(key, comparison));
      continue;
    }
    derived.push(requestedBound);
  }
  return derived.length > 0 ? derived : undefined;
}

/**
 * Whether `child` is equal to or narrower than `parent` on every axis `parent`
 * states — the settling invariant as a single predicate.
 *
 * Used by the issuance path as a final, independent re-check of what
 * `attenuateGrantScope` produced, and by the property tests as the statement of
 * the invariant itself. Deliberately re-derived rather than trusting the
 * earlier result: the whole point of the invariant is that it holds of the
 * artifact, not of the process that made it.
 */
export function grantScopeIsWithin(parent: GrantScope, child: GrantScope): boolean {
  const axes = GRANT_BOUND_KEYS.every((key) => {
    const parentBound = parent[key];
    const childBound = child[key];
    if (childBound === undefined) return true;
    if (parentBound === undefined) return false;
    return grantBoundComparisonPermits(compareGrantBound(parentBound, childBound));
  });
  return axes && parameterBoundsAreWithin(parent.parameters, child.parameters);
}

/**
 * Parameter containment, strictly: the child must bound **every** dimension the
 * parent bounds (dropping a parameter bound is a broadening — the child would
 * then admit any value on that dimension), may bound no dimension the parent
 * does not, and each bound must be equal or narrower.
 */
function parameterBoundsAreWithin(parent: GrantParameterBounds | undefined, child: GrantParameterBounds | undefined): boolean {
  if (child === undefined) return parent === undefined;
  if (parent === undefined) return false;
  if (!isWellFormedGrantParameterBounds(parent) || !isWellFormedGrantParameterBounds(child)) return false;
  if (child.length !== parent.length) return false;
  return parent.every((parentBound) => {
    const childBound = grantParameterBound(child, parentBound.dimension);
    return childBound !== undefined && governedParameterBoundComparisonPermits(compareGovernedParameterBound(parentBound, childBound));
  });
}
