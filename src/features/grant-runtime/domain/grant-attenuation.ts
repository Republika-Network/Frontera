import { compareGrantBound, grantBoundComparisonPermits, isWellFormedGrantBound, type GrantBound, type GrantBoundComparison } from './grant-bound.js';
import { GRANT_REASON_CODES, type GrantReasonCode } from './grant-reason-codes.js';
import { GRANT_BOUND_KEYS, GRANT_BOUND_KINDS_BY_KEY, canonicalGrantScope, type GrantBoundKey, type GrantScope } from './grant-scope.js';

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

/** One axis's comparison, reported whether it passed or failed, so an operator sees the whole picture rather than the first refusal. */
export interface GrantBoundAttenuation {
  readonly key: GrantBoundKey;
  readonly comparison: GrantBoundComparison;
  /** `true` when the requester stated this bound; `false` when the grant inherited the source's. */
  readonly narrowingRequested: boolean;
  readonly permitted: boolean;
}

export interface GrantAttenuationViolation {
  readonly key: GrantBoundKey;
  readonly reasonCode: GrantReasonCode;
  readonly comparison: GrantBoundComparison;
}

export type GrantAttenuationOutcome =
  | { readonly outcome: 'attenuated'; readonly scope: GrantScope; readonly bounds: readonly GrantBoundAttenuation[] }
  | { readonly outcome: 'refused'; readonly violations: readonly GrantAttenuationViolation[]; readonly bounds: readonly GrantBoundAttenuation[] };

/** A requested narrowing: at most one bound per axis, every axis optional. */
export type RequestedGrantBounds = { readonly [K in GrantBoundKey]?: GrantBound };

function violationFor(key: GrantBoundKey, comparison: GrantBoundComparison): GrantAttenuationViolation {
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

  if (violations.length > 0) return { outcome: 'refused', violations, bounds };
  return { outcome: 'attenuated', scope: canonicalGrantScope(derived), bounds };
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
  return GRANT_BOUND_KEYS.every((key) => {
    const parentBound = parent[key];
    const childBound = child[key];
    if (childBound === undefined) return true;
    if (parentBound === undefined) return false;
    return grantBoundComparisonPermits(compareGrantBound(parentBound, childBound));
  });
}
