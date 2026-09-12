import { grantCorrelationMatches, isWellFormedGrantCorrelation, type GrantCorrelation } from './grant-correlation.js';
import { isWellFormedGrantScope, serializeGrantScope, statedGrantBoundKeys, type GrantBoundKey, type GrantScope } from './grant-scope.js';
import type { GrantValidityCeiling } from './grant-validity.js';

/**
 * The authority a grant may be derived from, projected into the only shape
 * layer E is allowed to see.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4 calls this "the referenced
 * decision", read from the authoritative store and not trusted. This type is
 * that read, reduced to the four things issuance turns on: who it authorized,
 * what it bounded, whether it permitted exercise, and whether every blocking
 * condition on it is met.
 *
 * ## What is *not* on this type, and why
 *
 * There is **no status, no outcome, no effect and no reason code from the
 * authorization vocabulary.** `authorizationPermitsExercise` is a boolean the
 * *Kernel adapter* computes from the decision, because
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` §4 makes the Kernel the only decision
 * producer and gives layer E no standing to read, re-derive or reinterpret one.
 * Handing this layer an `'allowed' | 'denied'` would have given it the
 * vocabulary to form an opinion; handing it a boolean the decision already
 * settled gives it nothing to do but obey.
 *
 * `tests/grant-layer-boundaries.test.ts` fails the build if a decision status,
 * a policy effect or an authorization reason code ever appears in this module.
 *
 * ## Immutability
 *
 * A grant is a *derived* artifact. Nothing in this module mutates a source
 * authorization, a decision, a policy result, a context result or an obligation
 * result — there is no code path that could: every field here is `readonly`,
 * the projection is built by the adapter that reads the result, and issuance
 * consumes it by value.
 */
export interface GrantSourceAuthorization {
  readonly correlation: GrantCorrelation;
  /**
   * The party the authorization was evaluated for, and the only party a grant
   * derived from it may be held by.
   *
   * There is **no delegation at this layer.** No accepted ADR defines one for
   * grants — `ADR-NATIVE-DELEGATED-CAPABILITIES.md` and Authority Graph's
   * `DelegationGrant` define delegation over *authority*, upstream of a
   * decision, and neither gives a grant the power to name a different holder
   * than the decision authorized. Absent that, converting an authorized
   * subject into a different grant subject is broadening, and it is refused.
   */
  readonly subject: string;
  /** The bounds the authorization stood under. The parent of every attenuation comparison. */
  readonly scope: GrantScope;
  /**
   * Whether the authorizing layers concluded this action may proceed.
   *
   * Computed by the Kernel adapter from the decision status. Layer E reads it
   * and never re-derives it: `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
   * §4.2 requires an `allow`, and hard invariant 3 requires that a grant bound
   * to a decision that did not allow is not issued.
   */
  readonly authorizationPermitsExercise: boolean;
  /**
   * Whether every *blocking* obligation on the authorization is satisfied —
   * `verified` or `waived`, per ADR §1.
   *
   * `true` when the deployment declared no obligations at all, because there is
   * then nothing outstanding. This is the aggregate ADR §3 makes issuance turn
   * on, and it is read, never recomputed: layer E cannot discharge an
   * obligation, and `tests/grant-layer-boundaries.test.ts` proves it has no
   * import path by which it could.
   */
  readonly allBlockingObligationsSatisfied: boolean;
  /** When the authorization was evaluated. */
  readonly evaluatedAt: string;
  /**
   * Every upstream bound a grant derived from this authorization may not
   * outlive — ADR §4, "Where a grant's validity comes from", rule 3.
   *
   * **Empty is a first-class, ordinary answer**, and rule 4 is why: no decision
   * record in this repository carries a validity window, so on the generic
   * Kernel path there is frequently nothing to contain against. An empty list
   * means exactly that, and never "unbounded" — the grant's finite expiry still
   * comes from the issuer, and `resolveGrantValidity` still requires one.
   *
   * A host that knows the action is governed by a mandate or a representative
   * authority adds that artifact's own `expiresAt` here, through
   * `withGrantValidityCeiling`, before issuing. That is the route by which ADR
   * hard invariant 10 — "a grant never outlives the authority justifying it" —
   * becomes enforceable, and it mirrors how a reservation's expiry "is set from
   * the mandate's own expiry".
   */
  readonly validityCeilings: readonly GrantValidityCeiling[];
}

/**
 * The scope bounds a source authorization must state before anything may be
 * attenuated from it.
 *
 * Validity is deliberately absent from this list. It is not a scope axis (see
 * `grant-scope.ts`) and its presence is not a precondition for issuance: a
 * grant's finite expiry comes from the issuer, and an authorization with no
 * upstream temporal ceiling is an ordinary authorization, not a defective one.
 */
export const MANDATORY_GRANT_BOUND_KEYS: readonly GrantBoundKey[] = ['action', 'resources'];

/** Which mandatory bounds this source authorization fails to state, in canonical order. Empty means it states them all. */
export function missingMandatoryGrantBounds(source: GrantSourceAuthorization): readonly GrantBoundKey[] {
  const stated = statedGrantBoundKeys(source.scope);
  return MANDATORY_GRANT_BOUND_KEYS.filter((key) => !stated.includes(key));
}

/**
 * Whether a source authorization is structurally usable as the parent of a
 * grant.
 *
 * This asks nothing about eligibility — a denied authorization can be perfectly
 * well formed. It asks only whether there is enough deterministic, well-shaped
 * scope here to prove ⊆ against, which is the condition
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.4 and §4.5 need in order
 * to mean anything.
 */
export function isDerivableGrantSource(source: GrantSourceAuthorization): boolean {
  return (
    isWellFormedGrantCorrelation(source.correlation) &&
    source.subject.length > 0 &&
    !Number.isNaN(Date.parse(source.evaluatedAt)) &&
    isWellFormedGrantScope(source.scope) &&
    missingMandatoryGrantBounds(source).length === 0
  );
}

/**
 * A stable fingerprint of the authority a grant was derived from.
 *
 * Recorded on the grant so that "what exactly was this narrowed from?" is
 * answerable from the grant alone, and so that a grant can be shown to belong
 * to the source it claims. It is an *integrity* value, not a signature: it
 * detects a bound set that differs, and it is not evidence against a privileged
 * writer who can rewrite both. The same limit the Governance Store's own digest
 * documentation states for itself.
 */
export function serializeGrantSourceAuthorization(source: GrantSourceAuthorization): string {
  return [
    `"allBlockingObligationsSatisfied":${String(source.allBlockingObligationsSatisfied)}`,
    `"authorizationPermitsExercise":${String(source.authorizationPermitsExercise)}`,
    `"correlation":{${[
      `"action":${JSON.stringify(source.correlation.action)}`,
      `"decisionId":${JSON.stringify(source.correlation.decisionId)}`,
      `"requestId":${JSON.stringify(source.correlation.requestId)}`,
      `"resourceScope":${JSON.stringify(source.correlation.resourceScope)}`,
    ].join(',')}}`,
    `"evaluatedAt":${JSON.stringify(source.evaluatedAt)}`,
    `"scope":${serializeGrantScope(source.scope)}`,
    `"validityCeilings":[${orderedValidityCeilings(source.validityCeilings)
      .map((ceiling) => `{"notAfter":${JSON.stringify(ceiling.notAfter)},"source":${JSON.stringify(ceiling.source)}}`)
      .join(',')}]`,
    `"subject":${JSON.stringify(source.subject)}`,
  ].join(',');
}

/** Canonical ceiling order — by source name, then instant — so a source authorization serializes and digests identically however its ceilings were assembled. */
function orderedValidityCeilings(ceilings: readonly GrantValidityCeiling[]): readonly GrantValidityCeiling[] {
  return [...ceilings].sort((left, right) => (left.source === right.source ? left.notAfter.localeCompare(right.notAfter) : left.source.localeCompare(right.source)));
}

/**
 * Adds an upstream ceiling to a source authorization.
 *
 * The route a host takes when it knows the action is governed by a mandate or a
 * representative authority: the Kernel adapter cannot know about either, so it
 * projects what it can and the composition root adds what it knows. Returns a
 * new value; the source handed in is never mutated.
 */
export function withGrantValidityCeiling(source: GrantSourceAuthorization, ceiling: GrantValidityCeiling): GrantSourceAuthorization {
  return { ...source, validityCeilings: [...source.validityCeilings, ceiling] };
}

/** Whether a correlation names the same authorization this source describes. */
export function grantSourceMatchesCorrelation(source: GrantSourceAuthorization, correlation: GrantCorrelation): boolean {
  return grantCorrelationMatches(source.correlation, correlation);
}
