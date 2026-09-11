import { GrantConfigurationError } from './grant-configuration-errors.js';

/**
 * How a deployment adopts bounded grants.
 *
 * Operator-provisioned configuration, exactly as `ContextDeclaration` and
 * `ObligationDeclaration` are, and for the same two reasons: this phase
 * deliberately leaves the policy-authoring surface frozen, and a bound a
 * requester could set is not a bound.
 *
 * ## `maximumGrantLifetimeSeconds`, and the ADR ambiguity it resolves
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.5 requires that "the
 * grant's `expiresAt` must not exceed any bound the decision set", and hard
 * invariant 2 restates it as "a grant's lifetime ⊆ any bound its decision set".
 * Both are conditional on the decision having set one — and **no decision
 * record in this repository carries a validity bound.**
 * `EnterpriseAccessDecision` has `evaluatedAt` and no horizon;
 * `GovernanceEvaluationRecord` has `evaluatedAt`/`persistedAt` and no horizon;
 * `KernelEvaluationResult` has `evaluatedAt` and no horizon. Read literally,
 * §4.5 is therefore vacuous for time, and a grant could be issued with any
 * expiry at all — or with none.
 *
 * That is an underdetermination, not a contradiction, and it is resolved in the
 * one direction every other unresolvable state in this architecture is resolved
 * in (`TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4 invariant 6): **closed**.
 * The horizon is operator configuration, the source authorization's validity
 * bound is `evaluatedAt + maximumGrantLifetimeSeconds`, and a deployment that
 * declares no horizon gets no grants rather than unbounded ones. It reaches the
 * layer by the same route an obligation deadline does — trusted operator
 * configuration and never caller-controlled request data, which is ADR hard
 * invariant 8 applied one layer over. See the README's "Expiry" section and the
 * architecture note recorded there.
 */
export interface GrantDeclaration {
  /**
   * The longest a grant derived from an authorization may live, measured from
   * when that authorization was evaluated.
   *
   * Required, and required to be a positive, finite number of seconds. There is
   * no "unlimited" value and no way to express one: a grant with no horizon is
   * not a bounded grant, and `ADR-ACCESS-GRANT.md` already makes
   * `issuedAt`/`expiresAt` the sole representation of a grant's lifetime with
   * `expiresAt` strictly after `issuedAt`.
   */
  readonly maximumGrantLifetimeSeconds: number;
}

/** Validates a declaration at wiring time. A horizon that is zero, negative, non-finite or absent is a configuration fault, refused here rather than discovered at issuance. */
export function assertValidGrantDeclaration(declaration: GrantDeclaration): void {
  const { maximumGrantLifetimeSeconds } = declaration;
  if (!Number.isFinite(maximumGrantLifetimeSeconds) || maximumGrantLifetimeSeconds <= 0) {
    throw new GrantConfigurationError(
      `grants.declaration.maximumGrantLifetimeSeconds must be a positive, finite number of seconds; received ${String(maximumGrantLifetimeSeconds)}. There is deliberately no value meaning "unlimited": a grant with no horizon is not a bounded grant.`,
    );
  }
}

/**
 * The horizon a grant derived from an authorization evaluated at `evaluatedAt`
 * may not outlive.
 *
 * Total: an unparseable `evaluatedAt` yields `undefined`, which makes the
 * source authorization state no `validity` bound, which makes it underivable,
 * which makes it ineligible. Closed at every step, and never an unbounded
 * grant.
 */
export function grantValidityHorizon(declaration: GrantDeclaration, evaluatedAt: string): string | undefined {
  const anchor = Date.parse(evaluatedAt);
  if (Number.isNaN(anchor)) return undefined;
  const horizon = anchor + declaration.maximumGrantLifetimeSeconds * 1000;
  if (!Number.isFinite(horizon)) return undefined;
  return new Date(horizon).toISOString();
}
