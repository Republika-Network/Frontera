/**
 * An immutable record that a grant is no longer to be exercised.
 *
 * ## Reusing the existing revocation architecture, not building a second one
 *
 * The repository already has one: `EnterpriseGrantRevocation`
 * (`@aoc-enterprise/grant-revocation`, `ADR-GRANT-REVOCATION.md`) — an
 * immutable event referencing a grant by opaque id, carrying a closed
 * seven-value reason vocabulary and a single `revokedAt` instant, which
 * "records that a category of cause applies, never how to act on it". This type
 * is that contract's shape at layer E: the **same closed reason vocabulary**,
 * the same event-not-status modelling, the same refusal to orchestrate.
 *
 * It is a layer-E projection rather than a direct import because
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` §2 lets E read only A, B and D, and the
 * package is composed at the Enterprise host. The vocabulary is asserted
 * identical to `ENTERPRISE_GRANT_REVOCATION_REASONS` by
 * `tests/grant-revocation.test.ts`, so the two can never drift into a second,
 * incompatible revocation subsystem — the outcome `ADR-GRANT-REVOCATION.md`
 * itself warns against when it records `AuthorityGrant`/`RevocationLink` as
 * "evaluated and not reused".
 *
 * ## What revocation does not do
 *
 * It does not change the historical authorization.
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3's distinction runs in both
 * directions: a decision that concluded allow concluded allow, permanently, and
 * a grant revoked afterwards leaves that record exactly as it was. What changes
 * is whether the grant may still be exercised.
 *
 * It also does not notify, route, escalate or schedule anything, and there is
 * no code here that could. Provider-side enforcement of a revocation —
 * measuring when it truly becomes effective against an already-issued provider
 * credential — is `src/enterprise/access-governance`'s existing, separate
 * concern and is untouched by this layer.
 */

/** The closed vocabulary, identical to `ENTERPRISE_GRANT_REVOCATION_REASONS`. No provider-specific reason is introduced, per `ADR-GRANT-REVOCATION.md`'s non-negotiable rule. */
export const GRANT_REVOCATION_REASONS = [
  'administrator-revoked',
  'expired',
  'manual-revocation',
  'policy-changed',
  'principal-disabled',
  'resource-removed',
  'security-incident',
] as const;

export type GrantRevocationReason = (typeof GRANT_REVOCATION_REASONS)[number];

export function isGrantRevocationReason(value: string): value is GrantRevocationReason {
  return (GRANT_REVOCATION_REASONS as readonly string[]).includes(value);
}

export interface GrantRevocation {
  readonly grantId: string;
  readonly revokedAt: string;
  readonly reason: GrantRevocationReason;
  /** Who or what recorded the revocation. Operator- or system-supplied; never read from a requester's bag. */
  readonly issuerRef: string;
}
