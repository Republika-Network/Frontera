import { GrantConfigurationError } from './grant-configuration-errors.js';
import type { GrantValidityCeiling } from '../domain/index.js';

/**
 * How a deployment adopts bounded grants.
 *
 * Operator-provisioned configuration, exactly as `ContextDeclaration` and
 * `ObligationDeclaration` are, and for the same reason: this phase deliberately
 * leaves the policy-authoring surface frozen.
 *
 * Every field is optional, and an empty declaration is valid. That is the
 * point: a deployment adopts the capability by composing it, not by configuring
 * a limit.
 */
export interface GrantDeclaration {
  /**
   * An **optional** safety cap on how long a grant issued under this deployment
   * may live, measured from the authorization's evaluation instant.
   *
   * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4, "The optional
   * deployment ceiling". Three things follow from *optional*, and each was
   * wrong in an earlier revision of this module:
   *
   * - **It is not the source of a grant's validity.** The trusted issuer
   *   proposes `expiresAt`; this only limits what the issuer may propose.
   * - **Its absence is not a reason to withhold a grant.** A deployment that
   *   configures none still issues grants, on the strength of the issuer's own
   *   finite expiry and whatever upstream ceilings apply. The earlier "no
   *   configured maximum lifetime → no grants" semantic is gone.
   * - **It is not authority.** It is an operator limiting its own trusted
   *   issuers, which is a different kind of thing from a bound a mandate or a
   *   decision imposes. It is reported as its own ceiling `source` so a refusal
   *   says which of the two capped the request.
   *
   * When present it must be a positive, finite number of seconds. There is
   * still no value meaning "unlimited", and none is needed: omitting the field
   * declares no cap, which is not the same as declaring an infinite grant —
   * every grant remains finite because the issuer must state a finite expiry.
   */
  readonly maximumGrantLifetimeSeconds?: number;
}

/** Validates a declaration at wiring time. A *present* lifetime that is zero, negative or non-finite is a configuration fault, refused here rather than discovered at issuance. An absent one is valid. */
export function assertValidGrantDeclaration(declaration: GrantDeclaration): void {
  const { maximumGrantLifetimeSeconds } = declaration;
  if (maximumGrantLifetimeSeconds === undefined) return;
  if (!Number.isFinite(maximumGrantLifetimeSeconds) || maximumGrantLifetimeSeconds <= 0) {
    throw new GrantConfigurationError(
      `grants.declaration.maximumGrantLifetimeSeconds, when supplied, must be a positive, finite number of seconds; received ${String(maximumGrantLifetimeSeconds)}. Omit the field to declare no deployment cap — that is not the same as declaring an unlimited grant, because the issuer must still state a finite expiry.`,
    );
  }
}

/**
 * The deployment ceiling this declaration imposes on a grant derived from an
 * authorization evaluated at `evaluatedAt`, or `undefined` when it imposes
 * none.
 *
 * Total: no declared cap yields no ceiling, and an unparseable anchor yields no
 * ceiling rather than a malformed one. Neither is a fail-open — the issuer's
 * own finite expiry is still required and still checked, and a ceiling that
 * cannot be computed is simply a ceiling that does not exist.
 */
export function deploymentGrantValidityCeiling(declaration: GrantDeclaration, evaluatedAt: string): GrantValidityCeiling | undefined {
  const { maximumGrantLifetimeSeconds } = declaration;
  if (maximumGrantLifetimeSeconds === undefined) return undefined;

  const anchor = Date.parse(evaluatedAt);
  if (Number.isNaN(anchor)) return undefined;
  const horizon = anchor + maximumGrantLifetimeSeconds * 1000;
  if (!Number.isFinite(horizon)) return undefined;
  return { source: 'deployment', notAfter: new Date(horizon).toISOString() };
}
