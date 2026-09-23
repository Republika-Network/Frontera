import { compareMonetaryAmounts, isWellFormedMonetaryAmount } from '../../monetary-runtime/index.js';

/**
 * The closed, typed bound algebra layer E compares grants with.
 *
 * Normative source:
 * `docs/architecture/ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4
 * ("**Attenuation only.** A grant ⊆ its decision"), hard invariants 1 and 2,
 * and `ADR-AUTHORITY-CONTROL-LAYERING.md` §5 ("Attenuation only. A grant ⊆ the
 * decision that authorized it").
 *
 * Four bound shapes and no fifth. Each is a *total* comparison over a closed
 * value type, which is what lets the settling invariant be a property of the
 * type system and a table-driven test rather than a sentence in a README:
 *
 * | shape | source states | a grant may |
 * | --- | --- | --- |
 * | `identity` | one exact value | name the same value, and nothing else |
 * | `set` | a set of values | name any subset of it |
 * | `ceiling` | an exact decimal upper limit in one asset | name a limit at or below it, in the same asset |
 * | `window` | an instant nothing may outlive | name an instant at or before it |
 *
 * There is deliberately **no** expression shape, no predicate shape, no
 * wildcard shape and no negation. `ADR-AUTHORITY-CONTROL-LAYERING.md` gives
 * layer B the "no `eval`/`new Function`/dynamic code" rule and
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §9 R3 pins it; a grant bound is
 * strictly less expressive than a policy condition, so nothing here parses,
 * compiles or executes anything. A wildcard is not a bound shape either — a
 * requested `'*'` against a source `'payment'` is simply a different identity
 * value, and the comparison below refuses it for that reason rather than by a
 * special case someone has to remember to write.
 */

/** One exact value. The source authorized this and nothing adjacent to it. */
export interface GrantIdentityBound {
  readonly kind: 'identity';
  readonly value: string;
}

/** A set of values. Order is not data here — the canonical form is sorted and de-duplicated. */
export interface GrantSetBound {
  readonly kind: 'set';
  readonly values: readonly string[];
}

/**
 * An upper limit, with the unit it is denominated in. Units that differ are
 * never compared; see `compareGrantBound`.
 *
 * `limit` is canonical decimal text (`src/features/monetary-runtime`), never a
 * number: a ceiling is authority, and a ceiling held as an IEEE-754 double is
 * one whose exact value nobody authorized. Compared with exact `BigInt`
 * arithmetic. A grant persisted before P9 with a numeric `limit` is not
 * well formed under this contract and is refused — never re-spelled.
 */
export interface GrantCeilingBound {
  readonly kind: 'ceiling';
  readonly limit: string;
  readonly unit: string;
}

/** An instant nothing derived from this bound may outlive. */
export interface GrantWindowBound {
  readonly kind: 'window';
  readonly notAfter: string;
}

export type GrantBound = GrantIdentityBound | GrantSetBound | GrantCeilingBound | GrantWindowBound;

export type GrantBoundKind = GrantBound['kind'];

export const GRANT_BOUND_KINDS: readonly GrantBoundKind[] = ['identity', 'set', 'ceiling', 'window'];

/**
 * How a requested bound stands to the source bound it derives from.
 *
 * Four outcomes, and the fourth is the one that makes the algebra safe.
 * `incomparable` is not "unknown, assume fine" — it is the answer whenever the
 * comparison **cannot be established**, and every caller in this module treats
 * it exactly as it treats `broader`: no grant.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4 invariant 6: "Every
 * unresolvable state has exactly one documented direction, and it is denial or
 * `indeterminate`." At layer E the one direction is *no grant*.
 */
export type GrantBoundComparison = 'equal' | 'narrower' | 'broader' | 'incomparable';

/** Whether a comparison result permits issuance. `equal` and `narrower` do; the other two are the fail-closed pair. */
export function grantBoundComparisonPermits(comparison: GrantBoundComparison): boolean {
  return comparison === 'equal' || comparison === 'narrower';
}

/** Canonical set form: sorted, de-duplicated. Two sets with the same members always serialize and compare identically. */
export function canonicalGrantSetValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function setsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Whether a bound is well formed at all.
 *
 * Malformedness is not a comparison outcome, it is a precondition: a bound that
 * is not well formed is refused before any comparison is attempted, so an
 * unparseable instant or a non-finite limit can never be *compared* into
 * permission. Total, and every rejection is the fail-closed direction.
 */
export function isWellFormedGrantBound(bound: GrantBound): boolean {
  switch (bound.kind) {
    case 'identity':
      return bound.value.length > 0;
    case 'set':
      // An empty set is refused rather than treated as the trivially-included
      // subset. A grant naming no resources is not a narrower grant, it is a
      // malformed one, and admitting it would put a permanently unusable
      // artifact into the store under the name of an attenuation.
      return bound.values.length > 0 && bound.values.every((value) => value.length > 0);
    case 'ceiling':
      return isWellFormedMonetaryAmount({ value: bound.limit, unit: bound.unit });
    case 'window':
      return !Number.isNaN(Date.parse(bound.notAfter));
    default:
      return false;
  }
}

/**
 * Compares a requested bound against the source bound it claims to derive from.
 *
 * Total over every pair of `GrantBound` values, including pairs of different
 * kinds — which answer `incomparable`, because a set is not a narrowing of a
 * ceiling and pretending otherwise is how an attenuation check becomes a type
 * confusion. Deterministic: no clock, no randomness, no ambient state.
 *
 * Note the direction of every comparison. `requested` is the child; `source` is
 * the parent. The function never asks whether the parent is acceptable — the
 * parent is what was authorized, and layer E does not get to have an opinion
 * about it.
 */
export function compareGrantBound(source: GrantBound, requested: GrantBound): GrantBoundComparison {
  if (!isWellFormedGrantBound(source) || !isWellFormedGrantBound(requested)) return 'incomparable';
  if (source.kind !== requested.kind) return 'incomparable';

  switch (source.kind) {
    case 'identity': {
      const child = requested as GrantIdentityBound;
      // Equal or nothing. A different single value is neither narrower nor
      // broader — it is a *different* authority — so it is refused as
      // incomparable rather than silently ranked. This is what makes a
      // requested `'*'` against a source `'payment'` fail without a wildcard
      // rule existing anywhere in this module.
      return source.value === child.value ? 'equal' : 'incomparable';
    }
    case 'set': {
      const child = requested as GrantSetBound;
      const parentValues = canonicalGrantSetValues(source.values);
      const childValues = canonicalGrantSetValues(child.values);
      if (!childValues.every((value) => parentValues.includes(value))) return 'broader';
      return setsEqual(parentValues, childValues) ? 'equal' : 'narrower';
    }
    case 'ceiling': {
      const child = requested as GrantCeilingBound;
      // Units are compared exactly and never converted. A conversion table is a
      // place for a rate to be wrong, and a wrong rate here widens authority.
      const order = compareMonetaryAmounts({ value: child.limit, unit: child.unit }, { value: source.limit, unit: source.unit });
      if (order === 'incomparable') return 'incomparable';
      if (order > 0) return 'broader';
      return order === 0 ? 'equal' : 'narrower';
    }
    case 'window': {
      const child = requested as GrantWindowBound;
      const parentInstant = Date.parse(source.notAfter);
      const childInstant = Date.parse(child.notAfter);
      if (Number.isNaN(parentInstant) || Number.isNaN(childInstant)) return 'incomparable';
      if (childInstant > parentInstant) return 'broader';
      return childInstant === parentInstant ? 'equal' : 'narrower';
    }
    default:
      return 'incomparable';
  }
}

/** The canonical form of a bound: sorted set members, everything else verbatim. Two bounds that mean the same thing canonicalize identically. */
export function canonicalGrantBound(bound: GrantBound): GrantBound {
  return bound.kind === 'set' ? { kind: 'set', values: canonicalGrantSetValues(bound.values) } : bound;
}
