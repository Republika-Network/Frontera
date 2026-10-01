import type { AuthorityGraphRuntime } from '../../features/authority-graph/runtime/authority-graph-runtime.js';
import {
  PARAMETER_AUTHORITY_REASON_CODES as P,
  type ParameterAuthorityBound,
  type ParameterAuthorityResolution,
  type ParameterAuthorityResolver,
} from '../execution-governance/parameter-authority.js';
import type { KernelAuthorityRecord } from './contracts.js';
import { readKernelAuthorityParameterBounds } from './parameter-bounds.js';

/**
 * CTRL-02 — standing typed-parameter authority, resolved from the durable
 * Kernel Authority world and from nowhere else. P10's financial resolver is the
 * template, rule for rule:
 *
 * - **The lineage that authorized the action.** The Authority Graph's own
 *   deterministic `resolveAuthorityChain` — the rule recognition used — and, at
 *   issuance, proven identical (id for id, in order) to the chain the decision's
 *   Authority Graph proof evaluated. Parameters never select a lineage: there is
 *   no search for a lineage that would admit the request, and no minimum taken
 *   across independent records; a second, independent grant is an alternative
 *   only if the graph would choose it.
 * - **Every hop applies.** Bounds on the delegation(s), the grant they derive
 *   from and its parents all constrain the request; a delegate can add or
 *   narrow, never drop or widen, because nothing upstream is skipped.
 * - **Fail closed.** While any parameter authority exists in this organization,
 *   an unresolvable chain, a proof mismatch or an inactive hop is unresolved,
 *   never "unbounded". A world that states no parameter bound anywhere is
 *   `unbounded` — exactly the behaviour before CTRL-02.
 *
 * The bounds are read from the hydrated records by lineage id — the same
 * projection the graph was built from — never from a request.
 */
export interface CreateKernelParameterAuthorityResolverOptions {
  readonly organizationId: string;
  readonly trustDomainId: string;
  /** Live view of the hydrated Authority Graph. */
  readonly authority: () => AuthorityGraphRuntime;
  /** Live view of the hydrated records the graph was built from (same projection, same reload). */
  readonly records: () => readonly KernelAuthorityRecord[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isLive(status: string, expiresAt: string | undefined, at: number): boolean {
  if (status !== 'active') return false;
  if (expiresAt === undefined) return true;
  const expires = Date.parse(expiresAt);
  return !Number.isNaN(expires) && expires > at;
}

export function createKernelParameterAuthorityResolver(options: CreateKernelParameterAuthorityResolverOptions): ParameterAuthorityResolver {
  const { organizationId, trustDomainId } = options;

  return (query): ParameterAuthorityResolution => {
    const records = options.records().filter((record) => record.organizationId === organizationId);
    const anyBounds = records.some((record) => readKernelAuthorityParameterBounds(record.payload).length > 0);
    const unresolved = (reasonCode: (typeof P)[keyof typeof P]): ParameterAuthorityResolution => (anyBounds ? { kind: 'unresolved', reasonCode } : { kind: 'unbounded' });

    if (query.organizationId !== organizationId) return { kind: 'unresolved', reasonCode: P.PARAMETER_AUTHORITY_UNRESOLVED };
    const at = Date.parse(query.at);
    if (Number.isNaN(at)) return unresolved(P.PARAMETER_AUTHORITY_UNRESOLVED);

    const runtime = options.authority();
    const chain = runtime.resolveAuthorityChain({
      id: `parameter-authority:${query.phase}`,
      actorId: query.subject,
      trustDomainId,
      action: query.action,
      resourceScope: query.resourceScope,
      requestedAt: query.at,
    });
    if (chain.status !== 'valid' || chain.grants.length === 0) return unresolved(P.PARAMETER_AUTHORITY_UNRESOLVED);

    if (query.phase === 'issuance') {
      const proof = query.authorityDecisionId === undefined ? undefined : runtime.getAuthorityProof(query.authorityDecisionId);
      if (
        proof === undefined ||
        !proof.valid ||
        proof.actorId !== query.subject ||
        proof.trustDomainId !== trustDomainId ||
        !sameIds(proof.evaluatedGrantIds, chain.grants.map((grant) => grant.id)) ||
        !sameIds(proof.evaluatedDelegationIds, chain.delegations.map((delegation) => delegation.id))
      ) {
        return unresolved(P.PARAMETER_AUTHORITY_UNRESOLVED);
      }
    }

    const byRef = new Map(records.map((record) => [`${record.entityKind}:${record.entityId}`, record]));
    const hops = [
      ...chain.delegations.map((delegation) => ({ ref: `delegation-grant:${delegation.id}`, status: delegation.status, expiresAt: delegation.expiresAt })),
      ...chain.grants.map((grant) => ({ ref: `authority-grant:${grant.id}`, status: grant.status, expiresAt: grant.expiresAt })),
    ];
    const bounds: ParameterAuthorityBound[] = [];
    for (const hop of hops) {
      const record = byRef.get(hop.ref);
      // A hop the graph knows and the records do not is a projection that disagrees with itself.
      if (record === undefined) return unresolved(P.PARAMETER_AUTHORITY_UNRESOLVED);
      for (const entry of readKernelAuthorityParameterBounds(record.payload)) {
        const { dimension, ...bound } = entry;
        bounds.push({ ref: hop.ref, dimension, bound });
      }
    }
    if (bounds.length === 0) return { kind: 'unbounded' };
    if (!hops.every((hop) => isLive(hop.status, hop.expiresAt, at))) return { kind: 'unresolved', reasonCode: P.PARAMETER_AUTHORITY_INACTIVE };
    return {
      kind: 'bounded',
      authority: { organizationId, trustDomainId, subject: query.subject, lineage: hops.map((hop) => hop.ref), bounds },
    };
  };
}
