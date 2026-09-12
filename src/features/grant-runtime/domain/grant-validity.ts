import { compareGrantBound, grantBoundComparisonPermits, type GrantWindowBound } from './grant-bound.js';
import { GRANT_REASON_CODES, type GrantReasonCode } from './grant-reason-codes.js';

/**
 * Where a grant's validity comes from, and what may cap it.
 *
 * Normative source: `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4, "Where
 * a grant's validity comes from", and hard invariants 9 and 10. Four rules:
 *
 * 1. **Every bounded grant is finite.** `issuedAt` and `expiresAt` are both
 *    required and `expiresAt` is strictly after `issuedAt`. There is no
 *    unlimited grant and no value meaning "no expiry".
 * 2. **`expiresAt` is proposed by the trusted issuer**, at issuance time. Not
 *    derived from deployment configuration, not defaulted, and never read from
 *    caller-controlled request data.
 * 3. **The proposal is contained by every applicable upstream ceiling that
 *    exists** — the decision's validity bound if the decision carries one, the
 *    mandate or representative authority's window where one governs the action,
 *    and the deployment's optional safety cap where one is configured.
 * 4. **No upstream bound is invented where none exists.** No decision record in
 *    this repository carries a validity window, so on the generic Kernel path
 *    there is frequently nothing to contain against — and that is not a reason
 *    to withhold a grant, only a reason to check one fewer thing.
 *
 * An earlier revision of this module had it backwards: the horizon was
 * *derived* as `evaluatedAt + maximumGrantLifetimeSeconds`, and a deployment
 * that configured no maximum could issue no grants at all. That made a
 * configuration value into what a grant's lifetime *is* rather than a limit on
 * it, and inverted the direction the ADR states.
 */

/** Which kind of thing imposed a ceiling. Closed, and reported so "what capped this grant?" is answerable from the refusal. */
export type GrantValidityCeilingSource = 'decision' | 'authority' | 'deployment';

export const GRANT_VALIDITY_CEILING_SOURCES: readonly GrantValidityCeilingSource[] = ['authority', 'decision', 'deployment'];

/**
 * One upstream bound a grant may not outlive.
 *
 * `authority` is the mandate or representative-authority window — the case ADR
 * hard invariant 10 and `ADR-GOVERNED-AUTHORITY-RESERVATION.md`'s "a
 * reservation never outlives the authorization justifying it" govern.
 * `decision` is the decision's own validity bound, which no decision record in
 * this repository carries today. `deployment` is the optional operator safety
 * cap, which is not authority and is not a source of validity.
 */
export interface GrantValidityCeiling {
  readonly source: GrantValidityCeilingSource;
  readonly notAfter: string;
}

export interface GrantValidityResolution {
  readonly outcome: 'accepted' | 'refused';
  /** The accepted expiry. Present only on `accepted`, and always exactly the issuer's proposal — a request within every bound is never rewritten. */
  readonly expiresAt?: string;
  /** The strictest applicable ceiling, or `undefined` when none exists. Reported either way, so "was anything capping this?" is answerable. */
  readonly effectiveCeiling?: GrantValidityCeiling;
  readonly reasonCodes: readonly GrantReasonCode[];
}

/** Canonical ceiling order: by instant, then by source name, so the report is deterministic when two ceilings coincide. */
function orderedCeilings(ceilings: readonly GrantValidityCeiling[]): readonly GrantValidityCeiling[] {
  return [...ceilings].sort((left, right) => {
    const byInstant = Date.parse(left.notAfter) - Date.parse(right.notAfter);
    return byInstant !== 0 ? byInstant : left.source.localeCompare(right.source);
  });
}

/**
 * The strictest applicable bound — the `min` of every ceiling that exists.
 *
 * Total. A malformed ceiling yields `undefined` *together with* a refusal from
 * `resolveGrantValidity`; it is never skipped, because silently ignoring a
 * ceiling nobody can parse is how a cap stops capping.
 */
export function effectiveGrantValidityCeiling(ceilings: readonly GrantValidityCeiling[]): GrantValidityCeiling | undefined {
  const parseable = ceilings.filter((ceiling) => !Number.isNaN(Date.parse(ceiling.notAfter)));
  if (parseable.length !== ceilings.length) return undefined;
  return orderedCeilings(parseable)[0];
}

/**
 * Resolves the expiry a grant will carry, or refuses to issue one.
 *
 * Pure, total and deterministic: no clock, no store, no ambient state. The
 * instant comparisons are all between values passed in, so a replay and a live
 * issuance agree.
 *
 * **A request above the effective ceiling is refused, never silently clamped.**
 * One rule, no special case by which ceiling was strictest — ADR §4, "The
 * optional deployment ceiling". An issuer asking for more time than it may have
 * has a defect, and an issuance that quietly succeeds with a value the issuer
 * did not ask for hides it. The repository reports rather than repairs
 * everywhere else: an illegal obligation transition, an unclassifiable
 * constraint, a representation containment breach.
 */
export function resolveGrantValidity(input: {
  readonly issuedAt: string;
  /** The issuer's proposal. Required — there is no default and no fallback. */
  readonly requestedExpiresAt: string | undefined;
  readonly ceilings: readonly GrantValidityCeiling[];
}): GrantValidityResolution {
  const { issuedAt, requestedExpiresAt, ceilings } = input;

  if (requestedExpiresAt === undefined || requestedExpiresAt.length === 0) {
    // Rule 2: the issuer proposes it, and nothing proposes one on its behalf.
    return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID] };
  }

  const issued = Date.parse(issuedAt);
  const requested = Date.parse(requestedExpiresAt);
  if (Number.isNaN(issued) || Number.isNaN(requested)) {
    return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID] };
  }
  if (requested <= issued) {
    // Rule 1, and the one temporal consistency check
    // `validateEnterpriseAccessGrant` already performs on the frozen contract.
    return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID] };
  }

  if (ceilings.some((ceiling) => Number.isNaN(Date.parse(ceiling.notAfter)))) {
    // A ceiling nobody can parse is not an absent ceiling. Fail closed rather
    // than issue under a cap that silently stopped capping.
    return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID] };
  }

  const effectiveCeiling = effectiveGrantValidityCeiling(ceilings);
  if (effectiveCeiling === undefined) {
    // Rule 4: nothing to contain against, and none is invented. The issuer's
    // finite proposal is sufficient on its own.
    return { outcome: 'accepted', expiresAt: requestedExpiresAt, reasonCodes: [] };
  }

  const ceilingBound: GrantWindowBound = { kind: 'window', notAfter: effectiveCeiling.notAfter };
  const requestedBound: GrantWindowBound = { kind: 'window', notAfter: requestedExpiresAt };
  if (!grantBoundComparisonPermits(compareGrantBound(ceilingBound, requestedBound))) {
    // Rule 3. `GRANT_SCOPE_BROADENING` rather than `GRANT_VALIDITY_INVALID`:
    // the proposal is perfectly well formed, it simply asks for more authority
    // in time than the thing above it has to give.
    return { outcome: 'refused', effectiveCeiling, reasonCodes: [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING] };
  }

  return { outcome: 'accepted', expiresAt: requestedExpiresAt, effectiveCeiling, reasonCodes: [] };
}
