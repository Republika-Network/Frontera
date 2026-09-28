import {
  governedParameterValuesEqual,
  isGovernedParameterInteger,
  isWellFormedGovernedParameterValue,
  type GovernedParameterType,
  type GovernedParameterValue,
} from './parameter-value.js';

/**
 * The typed bound algebra for governed-action parameter dimensions.
 *
 * Two bound kinds and no third, each a *total* comparison over a closed value
 * type — the same discipline the grant runtime's `identity`/`set`/`ceiling`/
 * `window` algebra keeps, extended to typed parameters:
 *
 * | kind | types | source states | a narrower bound may |
 * | --- | --- | --- | --- |
 * | `exact` | integer, token, boolean | one exact value | name the same value, and nothing else |
 * | `maximum` | integer | an inclusive upper limit | name a limit at or below it |
 *
 * `maximum` is a statement a **domain** makes about a dimension — "less of this
 * is always within the authority for more" (records read, instances touched) —
 * and it is made once, by the trusted dimension declaration, never by a
 * caller. A dimension for which that is not true is declared `exact`, and then
 * nothing but the evaluated value is ever within its bound.
 *
 * No expression, no predicate, no wildcard, no negation, no range language and
 * nothing that parses: a parameter bound is strictly less expressive than a
 * policy condition. Different kinds, different types and malformed values are
 * `incomparable`, which every caller treats exactly as `broader` — the
 * fail-closed pair.
 */
export const GOVERNED_PARAMETER_BOUND_KINDS = ['exact', 'maximum'] as const;
export type GovernedParameterBoundKind = (typeof GOVERNED_PARAMETER_BOUND_KINDS)[number];

export type GovernedParameterBound =
  | { readonly kind: 'exact'; readonly type: 'integer'; readonly value: number }
  | { readonly kind: 'exact'; readonly type: 'token'; readonly value: string }
  | { readonly kind: 'exact'; readonly type: 'boolean'; readonly value: boolean }
  | { readonly kind: 'maximum'; readonly type: 'integer'; readonly limit: number };

export type GovernedParameterBoundComparison = 'equal' | 'narrower' | 'broader' | 'incomparable';

export function isGovernedParameterBoundKind(value: unknown): value is GovernedParameterBoundKind {
  return typeof value === 'string' && (GOVERNED_PARAMETER_BOUND_KINDS as readonly string[]).includes(value);
}

/** Which bound kinds a value type supports. `maximum` needs an order, and only integers have one here. */
export function governedParameterBoundKindSupports(kind: GovernedParameterBoundKind, type: GovernedParameterType): boolean {
  return kind === 'exact' || (kind === 'maximum' && type === 'integer');
}

export function isWellFormedGovernedParameterBound(bound: GovernedParameterBound): boolean {
  if (bound === null || typeof bound !== 'object') return false;
  switch (bound.kind) {
    case 'exact':
      return isWellFormedGovernedParameterValue({ type: bound.type, value: bound.value } as GovernedParameterValue);
    case 'maximum':
      return bound.type === 'integer' && isGovernedParameterInteger(bound.limit);
    default:
      return false;
  }
}

/**
 * The bound a *decision* stands under for one evaluated value — the source of
 * every attenuation. `exact` pins the evaluated value; `maximum` admits the
 * evaluated value and anything below it. `undefined` when the declared kind
 * cannot bound the value's type, which a caller treats as no authority.
 */
export function governedParameterBoundFor(kind: GovernedParameterBoundKind, value: GovernedParameterValue): GovernedParameterBound | undefined {
  if (!isWellFormedGovernedParameterValue(value) || !governedParameterBoundKindSupports(kind, value.type)) return undefined;
  if (kind === 'maximum') return value.type === 'integer' ? { kind: 'maximum', type: 'integer', limit: value.value } : undefined;
  switch (value.type) {
    case 'integer':
      return { kind: 'exact', type: 'integer', value: value.value };
    case 'token':
      return { kind: 'exact', type: 'token', value: value.value };
    case 'boolean':
      return { kind: 'exact', type: 'boolean', value: value.value };
    default:
      return undefined;
  }
}

/**
 * How a requested (child) bound stands to the source (parent) bound it claims
 * to derive from. Deterministic and total; the parent is never judged.
 */
export function compareGovernedParameterBound(source: GovernedParameterBound, requested: GovernedParameterBound): GovernedParameterBoundComparison {
  if (!isWellFormedGovernedParameterBound(source) || !isWellFormedGovernedParameterBound(requested)) return 'incomparable';
  if (source.kind !== requested.kind || source.type !== requested.type) return 'incomparable';
  if (source.kind === 'exact' && requested.kind === 'exact') {
    // Equal or nothing: a different exact value is a *different* authority,
    // not a narrower one.
    return source.value === requested.value ? 'equal' : 'incomparable';
  }
  if (source.kind === 'maximum' && requested.kind === 'maximum') {
    if (requested.limit > source.limit) return 'broader';
    return requested.limit === source.limit ? 'equal' : 'narrower';
  }
  return 'incomparable';
}

export function governedParameterBoundComparisonPermits(comparison: GovernedParameterBoundComparison): boolean {
  return comparison === 'equal' || comparison === 'narrower';
}

/**
 * Whether an attempted value is inside a bound. Types must match exactly — a
 * token `"5"` is never inside an integer bound — and a malformed value is never
 * inside anything.
 */
export function governedParameterBoundAdmits(bound: GovernedParameterBound, value: GovernedParameterValue): boolean {
  if (!isWellFormedGovernedParameterBound(bound) || !isWellFormedGovernedParameterValue(value)) return false;
  if (bound.type !== value.type) return false;
  if (bound.kind === 'exact') return governedParameterValuesEqual({ type: bound.type, value: bound.value } as GovernedParameterValue, value);
  return value.type === 'integer' && value.value <= bound.limit;
}

/**
 * The canonical serialization of one bound: keys in lexicographic order, no
 * whitespace — the bytes `aoc.canonical-json.v1` produces for the same value.
 * Safe integers serialize identically under `JSON.stringify` everywhere, and
 * `-0` cannot reach here (refused as malformed).
 */
export function serializeGovernedParameterBound(bound: GovernedParameterBound): string {
  if (bound.kind === 'maximum') return `{"kind":"maximum","limit":${JSON.stringify(bound.limit)},"type":"integer"}`;
  return `{"kind":"exact","type":${JSON.stringify(bound.type)},"value":${JSON.stringify(bound.value)}}`;
}
