import { canonicalGrantBound, isWellFormedGrantBound, type GrantBound, type GrantBoundKind } from './grant-bound.js';

/**
 * The axes a bounded grant is bounded on.
 *
 * A closed union of six, each justified by something the current architecture
 * already carries rather than by an enterprise wish list:
 *
 * | key | shape | where the source value comes from |
 * | --- | --- | --- |
 * | `action` | `identity` | the capability/action the authorization evaluated |
 * | `resources` | `set` | the resource scope(s) the authorization evaluated |
 * | `counterparty` | `identity` | the counterparty the authorization evaluated |
 * | `organization` | `identity` | the tenant the authorization was scoped to |
 * | `amount` | `ceiling` | the quantity the authorization evaluated, with its currency |
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4 names two of these
 * explicitly — resource identity (§4.3) and the evaluated scope (§4.4). The
 * other three follow from the same section's settling rule, "a grant ⊆ its
 * decision", applied to the remaining fields the decision actually evaluated.
 * None of them is a new *fact*: every source value is read out of an
 * authorization that already happened.
 *
 * Two things are deliberately **not** axes here.
 *
 * **Subject** is a top-level field on the grant, checked by its own rule,
 * exactly as `EnterpriseAccessGrant.principalId` is a top-level field rather
 * than part of a scope — see `bounded-grant.ts`.
 *
 * **Validity** is likewise top-level, and for the same reason plus one more: a
 * scope says *what* a grant may act over, a validity window says *when*, and
 * `ADR-ACCESS-GRANT.md` models expiry as `issuedAt`/`expiresAt` on the grant
 * itself rather than as part of any scope. An earlier revision of this module
 * carried `validity` as a scope axis, which forced a grant to state both an
 * inherited ceiling and its own expiry — two temporal values on one artifact,
 * the "second, independently-settable source of truth" that same ADR refuses.
 * Temporal bounds now live in `grant-validity.ts`, where the issuer proposes
 * and the ceilings contain.
 */
export type GrantBoundKey = 'action' | 'amount' | 'counterparty' | 'organization' | 'resources';

/**
 * Every key, in canonical order.
 *
 * Lexicographic, so iteration order matches the key order canonical JSON
 * produces and the serialized form of a scope is the same whichever way it was
 * built. Iterating this constant — never `Object.keys` — is what keeps
 * `serializeGrantScope` deterministic across runtimes.
 */
export const GRANT_BOUND_KEYS: readonly GrantBoundKey[] = ['action', 'amount', 'counterparty', 'organization', 'resources'];

/**
 * Which bound shape each axis is expressed in. Total over the closed key set.
 *
 * A scope carrying the wrong shape for an axis is refused rather than compared:
 * an `amount` expressed as a set would otherwise be "compared" by set
 * inclusion, which is not a limit at all.
 */
export const GRANT_BOUND_KINDS_BY_KEY: Readonly<Record<GrantBoundKey, GrantBoundKind>> = {
  action: 'identity',
  amount: 'ceiling',
  counterparty: 'identity',
  organization: 'identity',
  resources: 'set',
};

/**
 * A set of bounds, at most one per axis.
 *
 * Absence of a key means *this authorization stated no bound on that axis*, and
 * it is never read as "unbounded, so anything goes": `attenuateGrantScope`
 * refuses a requested bound on an axis the source left unstated, because ⊆
 * cannot be established against a bound that does not exist. See
 * `grant-attenuation.ts`.
 */
export interface GrantScope {
  readonly action?: GrantBound;
  readonly amount?: GrantBound;
  readonly counterparty?: GrantBound;
  readonly organization?: GrantBound;
  readonly resources?: GrantBound;
}

export function grantScopeBound(scope: GrantScope, key: GrantBoundKey): GrantBound | undefined {
  return scope[key];
}

/** The axes this scope actually states, in canonical order. */
export function statedGrantBoundKeys(scope: GrantScope): readonly GrantBoundKey[] {
  return GRANT_BOUND_KEYS.filter((key) => scope[key] !== undefined);
}

/** Whether every stated bound carries the shape its axis requires and is itself well formed. Total; fail-closed on anything unrecognized. */
export function isWellFormedGrantScope(scope: GrantScope): boolean {
  return statedGrantBoundKeys(scope).every((key) => {
    const bound = scope[key];
    if (bound === undefined) return false;
    return bound.kind === GRANT_BOUND_KINDS_BY_KEY[key] && isWellFormedGrantBound(bound);
  });
}

/** The canonical form of a scope: canonical bounds, keys emitted in `GRANT_BOUND_KEYS` order, unstated axes omitted rather than written as `undefined`. */
export function canonicalGrantScope(scope: GrantScope): GrantScope {
  const canonical: { -readonly [K in GrantBoundKey]?: GrantBound } = {};
  for (const key of GRANT_BOUND_KEYS) {
    const bound = scope[key];
    if (bound !== undefined) canonical[key] = canonicalGrantBound(bound);
  }
  return canonical;
}

function serializeBound(bound: GrantBound): string {
  switch (bound.kind) {
    case 'identity':
      return `{"kind":"identity","value":${JSON.stringify(bound.value)}}`;
    case 'set':
      return `{"kind":"set","values":[${bound.values.map((value) => JSON.stringify(value)).join(',')}]}`;
    case 'ceiling':
      // `limit` is canonical decimal text, so one quantity has one spelling and
      // two scopes that mean the same limit never digest differently.
      return `{"kind":"ceiling","limit":${JSON.stringify(bound.limit)},"unit":${JSON.stringify(bound.unit)}}`;
    case 'window':
      return `{"kind":"window","notAfter":${JSON.stringify(bound.notAfter)}}`;
    default:
      return '{}';
  }
}

/**
 * The deterministic serialization of a scope.
 *
 * Written to be byte-identical to what the Governance Store's
 * `aoc.canonical-json.v1` produces for the same value — sorted keys, no
 * whitespace, absent rather than `null` for an unstated axis — without this
 * layer importing it. Layer E may not depend on layer F
 * (`ADR-AUTHORITY-CONTROL-LAYERING.md` §2: "F reads A B C D E", never the
 * reverse), and the governance canonicalizer lives inside the evidence-bearing
 * store. `tests/grant-canonicalization.test.ts` pins the byte equality against
 * the real canonicalizer so the two can never drift silently.
 */
export function serializeGrantScope(scope: GrantScope): string {
  const canonical = canonicalGrantScope(scope);
  const parts = GRANT_BOUND_KEYS.filter((key) => canonical[key] !== undefined).map((key) => {
    const bound = canonical[key];
    return `${JSON.stringify(key)}:${bound === undefined ? '{}' : serializeBound(bound)}`;
  });
  return `{${parts.join(',')}}`;
}

/** Whether two scopes state exactly the same bounds. Canonical on both sides, so set order never makes two equal scopes differ. */
export function grantScopeEquals(left: GrantScope, right: GrantScope): boolean {
  return serializeGrantScope(left) === serializeGrantScope(right);
}
