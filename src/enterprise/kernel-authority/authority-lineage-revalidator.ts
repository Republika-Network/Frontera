import type { AuthorityGraphRuntime } from '../../features/authority-graph/runtime/authority-graph-runtime.js';

/**
 * CORE-04 — exercise-time lineage revalidation for **every** action class.
 *
 * Before CORE-04 the authority lineage behind a grant was re-resolved at
 * exercise only for financial actions (P10's resolver); a non-financial grant
 * was exercised on the strength of a decision whose delegation or authority
 * grant might since have been revoked or expired. CORE-04 makes that gap
 * sharper — an obligation-withheld decision can now be issued and exercised
 * after a verified discharge, some time after it was decided — so it closes it:
 * the exercise gate re-resolves the actor's authority chain for exactly the
 * grant's action and resource, from the same durable Kernel-Authority world the
 * Kernel decided against, and refuses (`EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE`)
 * unless the chain is still valid and every hop is still active and unexpired.
 *
 * Deterministic and read-only: no network, no store write, the instant passed in.
 */
export interface AuthorityLineageQuery {
  readonly subject: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly organizationId?: string;
  readonly at: string;
}

export type AuthorityLineageRevalidator = (query: AuthorityLineageQuery) => boolean;

export interface CreateKernelAuthorityLineageRevalidatorOptions {
  readonly organizationId: string;
  readonly trustDomainId: string;
  readonly authority: () => AuthorityGraphRuntime;
}

function isLive(status: string, expiresAt: string | undefined, at: number): boolean {
  if (status !== 'active') return false;
  if (expiresAt === undefined) return true;
  const expires = Date.parse(expiresAt);
  return !Number.isNaN(expires) && expires > at;
}

export function createKernelAuthorityLineageRevalidator(options: CreateKernelAuthorityLineageRevalidatorOptions): AuthorityLineageRevalidator {
  const { organizationId, trustDomainId } = options;
  return (query) => {
    if (query.organizationId !== organizationId) return false;
    const at = Date.parse(query.at);
    if (Number.isNaN(at)) return false;
    const chain = options.authority().resolveAuthorityChain({
      id: 'authority-lineage:exercise',
      actorId: query.subject,
      trustDomainId,
      action: query.action,
      resourceScope: query.resourceScope,
      requestedAt: query.at,
    });
    if (chain.status !== 'valid' || chain.grants.length === 0) return false;
    return chain.grants.every((grant) => isLive(grant.status, grant.expiresAt, at)) && chain.delegations.every((delegation) => isLive(delegation.status, delegation.expiresAt, at));
  };
}
