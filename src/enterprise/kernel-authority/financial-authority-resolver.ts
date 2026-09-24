import type { AuthorityConstraint } from '../../features/authority-graph/domain/authority-grant.js';
import type { AuthorityGraphRuntime } from '../../features/authority-graph/runtime/authority-graph-runtime.js';
import { canonicalDecimalScale, compareCanonicalDecimals, isCanonicalDecimal, type MonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  FINANCIAL_AUTHORITY_REASON_CODES as F,
  type FinancialAuthorityQuery,
  type FinancialAuthorityResolution,
  type FinancialAuthorityResolver,
  type FinancialSpendingLimit,
} from '../execution-governance/financial-authority.js';

/**
 * P10 — the monetary authority behind a financial action, resolved from the
 * durable Kernel Authority world and from nowhere else.
 *
 * ```
 * Kernel Authority Store (SQLite / memory)   durable source of truth
 *   -> hydration                             pure projection, rebuilt on every committed write
 *   -> Authority Graph (in memory)           AuthorityGrant / DelegationGrant, with constraints
 *   -> this resolver                         synchronous, read-only
 *   -> ceiling + durable spending limits     to issuance, the commit guard and P7
 * ```
 *
 * ## The same lineage that authorized the action
 *
 * The resolver never searches for "any authority of this actor that mentions
 * this asset". It resolves the authority chain with the Authority Graph's own
 * deterministic rule — the rule recognition used when it produced the decision
 * — and, at **issuance**, proves that chain is exactly the one the decision's
 * own Authority Graph proof evaluated (`authorityDecisionId` → `AuthorityProof`
 * → `evaluatedGrantIds` / `evaluatedDelegationIds`, compared id for id, in
 * order). A decision with no Authority Graph proof — an actor recognition did
 * not require a chain for — has no lineage to take monetary authority from, and
 * is unresolved. At **commit** and **exercise** the chain is re-resolved against
 * the live world, and the lineage identity is part of the digest the caller
 * compares, so a chain that resolves differently now — a replaced or
 * re-provisioned authority with identical terms included — never matches.
 *
 * ## Delegation cannot escape
 *
 * Every monetary constraint on **every** hop of the lineage applies: the
 * delegation(s), the grant they derive from, and that grant's parents. A
 * delegate may add a narrower ceiling or an extra limit; it can never drop,
 * raise or re-denominate one held upstream, because nothing upstream is
 * skipped. The effective ceiling is the narrowest; limits accumulate.
 *
 * ## Fail closed
 *
 * Revoked, suspended or expired hop; no ceiling; ceilings or limits only in
 * other assets; a malformed constraint, an unrecognized asset or a value beyond
 * its trusted scale anywhere on the lineage; no aggregate limit in the asset;
 * an organization that is not this world's; a proof that does not match — each
 * is an unresolved answer, never a default, never `Number.MAX_SAFE_INTEGER`,
 * never the request's own amount.
 *
 * ## Exact
 *
 * Canonical decimal text end to end. Comparisons are `compareCanonicalDecimals`
 * (BigInt); there is no `Number(...)`, `parseFloat`, rounding or conversion on
 * this path.
 */
export interface CreateKernelFinancialAuthorityResolverOptions {
  /** The one organization this authority world serves. A query for any other is unresolved. */
  readonly organizationId: string;
  /** The trust domain governed actions are evaluated in — the Kernel's own enforcement boundary. */
  readonly trustDomainId: string;
  /** P9's trusted asset registry — the only source of an asset's scale. */
  readonly assets: MonetaryAssetRegistry;
  /** Live view of the hydrated Authority Graph. Read on every call, so a re-hydration after provisioning or revocation is observed immediately. */
  readonly authority: () => AuthorityGraphRuntime;
}

type MonetaryConstraint = Extract<AuthorityConstraint, { readonly type: 'max_amount' | 'spending_limit' }>;

interface LineageHop {
  readonly ref: string;
  readonly entityKind: 'authority-grant' | 'delegation-grant';
  readonly entityId: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly constraints: readonly AuthorityConstraint[];
}

/** The versioned namespace of an authority-derived P7 bucket. Distinct from anything a host names, and stable across processes, restarts, grants and executions. */
export const FINANCIAL_SPENDING_BUCKET_NAMESPACE = 'aoc.kernel-authority.spending-limit.v1';

/** The P7 limit id an authority spending limit is enforced under: namespaced, so a host policy limit cannot share it by accident. */
export function financialSpendingLimitId(limitId: string): string {
  return `authority:${limitId}`;
}

/**
 * The P7 bucket of one durable spending limit: the organization, the exact
 * authority record that carries the limit, and the asset. Never a request id,
 * decision id, grant id, execution id or process id — any of those would give
 * every payment a fresh budget.
 */
export function financialSpendingScopeKey(input: { readonly organizationId: string; readonly entityKind: string; readonly entityId: string; readonly currency: string }): string {
  return JSON.stringify([FINANCIAL_SPENDING_BUCKET_NAMESPACE, input.organizationId, input.entityKind, input.entityId, input.currency]);
}

function unresolved(reasonCode: (typeof F)[keyof typeof F]): FinancialAuthorityResolution {
  return { resolved: false, reasonCode };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMonetaryConstraint(constraint: AuthorityConstraint): constraint is MonetaryConstraint {
  return constraint.type === 'max_amount' || constraint.type === 'spending_limit';
}

/** Whether one monetary constraint is exact, positive and within its asset's trusted scale. */
function isTrustworthy(constraint: MonetaryConstraint, assets: MonetaryAssetRegistry): boolean {
  const asset = assets.resolve(constraint.currency);
  const value = constraint.type === 'max_amount' ? constraint.value : constraint.maximum;
  if (asset === undefined || !isCanonicalDecimal(value) || value === '0' || canonicalDecimalScale(value) > asset.scale) return false;
  if (constraint.type === 'spending_limit') {
    const window = constraint.window as { readonly kind?: unknown; readonly seconds?: unknown } | undefined;
    if (typeof constraint.limitId !== 'string' || constraint.limitId.length === 0) return false;
    if (window?.kind === 'lifetime') return true;
    return window?.kind === 'rolling' && typeof window.seconds === 'number' && Number.isSafeInteger(window.seconds) && window.seconds >= 1;
  }
  return true;
}

function isLive(hop: LineageHop, at: number): boolean {
  if (hop.status !== 'active') return false;
  if (hop.expiresAt === undefined) return true;
  const expires = Date.parse(hop.expiresAt);
  return !Number.isNaN(expires) && expires > at;
}

export function createKernelFinancialAuthorityResolver(options: CreateKernelFinancialAuthorityResolverOptions): FinancialAuthorityResolver {
  const { organizationId, trustDomainId, assets } = options;

  return (query: FinancialAuthorityQuery): FinancialAuthorityResolution => {
    // Tenant confinement: the organization must be stated and must be this
    // world's. Actor ids of two organizations may legitimately collide.
    if (query.organizationId !== organizationId) return unresolved(F.FINANCIAL_AUTHORITY_UNRESOLVED);
    const at = Date.parse(query.at);
    if (Number.isNaN(at)) return unresolved(F.FINANCIAL_AUTHORITY_UNRESOLVED);

    const runtime = options.authority();
    const chain = runtime.resolveAuthorityChain({
      id: `financial-authority:${query.phase}`,
      actorId: query.subject,
      trustDomainId,
      action: query.action,
      resourceScope: query.resourceScope,
      requestedAt: query.at,
    });
    if (chain.status !== 'valid' || chain.grants.length === 0) return unresolved(F.FINANCIAL_AUTHORITY_UNRESOLVED);

    const grantIds = chain.grants.map((grant) => grant.id);
    const delegationIds = chain.delegations.map((delegation) => delegation.id);

    // Issuance: the lineage must be exactly the one this decision's own
    // Authority Graph proof evaluated. No proof, a failed proof, another actor,
    // another trust domain, or a different chain — unresolved.
    if (query.phase === 'issuance') {
      const proof = query.authorityDecisionId === undefined ? undefined : runtime.getAuthorityProof(query.authorityDecisionId);
      if (
        proof === undefined ||
        !proof.valid ||
        proof.actorId !== query.subject ||
        proof.trustDomainId !== trustDomainId ||
        !sameIds(proof.evaluatedGrantIds, grantIds) ||
        !sameIds(proof.evaluatedDelegationIds, delegationIds)
      ) {
        return unresolved(F.FINANCIAL_AUTHORITY_UNRESOLVED);
      }
    }

    const hops: LineageHop[] = [
      ...chain.delegations.map((delegation) => ({
        ref: `delegation-grant:${delegation.id}`,
        entityKind: 'delegation-grant' as const,
        entityId: delegation.id,
        status: delegation.status,
        ...(delegation.expiresAt !== undefined ? { expiresAt: delegation.expiresAt } : {}),
        constraints: delegation.constraints ?? [],
      })),
      ...chain.grants.map((grant) => ({
        ref: `authority-grant:${grant.id}`,
        entityKind: 'authority-grant' as const,
        entityId: grant.id,
        status: grant.status,
        ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        constraints: grant.constraints ?? [],
      })),
    ];
    if (!hops.every((hop) => isLive(hop, at))) return unresolved(F.FINANCIAL_AUTHORITY_INACTIVE);

    let ceiling: string | undefined;
    let anyCeiling = false;
    const spendingLimits: FinancialSpendingLimit[] = [];
    for (const hop of hops) {
      for (const constraint of hop.constraints) {
        if (!isMonetaryConstraint(constraint)) continue;
        // One malformed monetary constraint anywhere on the lineage makes the
        // whole lineage's monetary authority unknowable, whatever asset it names.
        if (!isTrustworthy(constraint, assets)) return unresolved(F.FINANCIAL_AUTHORITY_MALFORMED);
        if (constraint.type === 'max_amount') {
          anyCeiling = true;
          if (constraint.currency !== query.asset) continue;
          // Intersection: the narrowest ceiling on the lineage wins, never the largest.
          if (ceiling === undefined || compareCanonicalDecimals(constraint.value, ceiling) < 0) ceiling = constraint.value;
          continue;
        }
        if (constraint.currency !== query.asset) continue;
        spendingLimits.push({
          limitId: financialSpendingLimitId(constraint.limitId),
          scopeKey: financialSpendingScopeKey({ organizationId, entityKind: hop.entityKind, entityId: hop.entityId, currency: constraint.currency }),
          maximum: constraint.maximum,
          unit: constraint.currency,
          window: constraint.window.kind === 'lifetime' ? { kind: 'lifetime' } : { kind: 'rolling', seconds: constraint.window.seconds },
        });
      }
    }
    if (ceiling === undefined) return unresolved(anyCeiling ? F.FINANCIAL_AUTHORITY_ASSET_MISMATCH : F.FINANCIAL_AUTHORITY_CEILING_MISSING);
    if (spendingLimits.length === 0) return unresolved(F.FINANCIAL_AUTHORITY_SPENDING_LIMIT_MISSING);

    return {
      resolved: true,
      authority: {
        organizationId,
        trustDomainId,
        subject: query.subject,
        lineage: hops.map((hop) => hop.ref),
        ceiling: { value: ceiling, unit: query.asset },
        spendingLimits,
      },
    };
  };
}
