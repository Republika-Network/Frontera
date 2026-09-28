import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';

/**
 * CORE-04 — the **effective** Governance Profile of a request, established by
 * trusted configuration and never by the request.
 *
 * `request.action.semantics.governanceProfile` is a *claim*. On the governed
 * path the orchestrator fills it from the trusted registry, but the Kernel is
 * also reachable by direct callers, and a claim is not a selector: a request
 * that could name its own profile could name a permissive one — or a bogus
 * one that matches nothing — and stand under fewer facts and fewer
 * obligations than its action and resource are governed by.
 *
 * So the profile a request's context requirements and obligations are drawn
 * from is resolved here, from the request's action and resource, by a
 * resolver trusted composition supplies (the CORE-03 Governance Profile
 * registry). The caller's semantics may only *agree* with it:
 *
 * | trusted resolution | caller semantics            | selection   |
 * |--------------------|-----------------------------|-------------|
 * | resolved to P      | absent, or exactly P        | P           |
 * | resolved to P      | any other id/version/digest | refused     |
 * | unclassified       | absent                      | deployment  |
 * | unclassified       | present                     | refused     |
 * | refused / throws   | anything                    | refused     |
 *
 * `refused` fails closed in both consumers: the context step denies
 * (`CONTEXT_PROFILE_UNTRUSTED`) and every blocking obligation stays
 * unsatisfied. There is no fallback from a profile the caller named to a
 * weaker declaration.
 */
export interface KernelGovernanceProfileKey {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

export type KernelEffectiveProfileResolution =
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'resolved'; readonly profile: KernelGovernanceProfileKey }
  | { readonly kind: 'refused' };

/** Trusted: resolves an action and resource to the profile that governs them. Composition supplies it; a request never does. */
export type KernelEffectiveProfileResolver = (action: string, resourceScope: string) => KernelEffectiveProfileResolution;

export type KernelEffectiveProfileSelection = { readonly kind: 'deployment' } | { readonly kind: 'profile'; readonly key: string } | { readonly kind: 'refused' };

export function governanceProfileKey(profile: KernelGovernanceProfileKey): string {
  return `${profile.id}@${profile.version}#${profile.digest}`;
}

function sameResolution(left: KernelEffectiveProfileResolution, right: KernelEffectiveProfileResolution): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'resolved' && right.kind === 'resolved') return governanceProfileKey(left.profile) === governanceProfileKey(right.profile);
  return true;
}

/**
 * Wiring rule: profile-keyed declarations are only ever selected through a
 * trusted resolver. A capability given declarations and no resolver would have
 * nothing to select with but the caller's claim, and is refused at
 * construction.
 */
export function assertEffectiveProfileResolver(declarations: number, resolver: KernelEffectiveProfileResolver | undefined, what: string): void {
  if (declarations > 0 && typeof resolver !== 'function') {
    throw new TypeError(`${what} are declared per Governance Profile, and no trusted effective-profile resolver was supplied; a request's own semantics never select a profile.`);
  }
}

export function selectEffectiveProfile(resolver: KernelEffectiveProfileResolver | undefined, request: KernelEvaluationRequest): KernelEffectiveProfileSelection {
  const claimed = request.action.semantics?.governanceProfile;
  // No profile-keyed declarations exist (the constructor enforces this), so
  // there is nothing any claim could select: the deployment-wide declaration.
  if (resolver === undefined) return { kind: 'deployment' };

  let resolution: KernelEffectiveProfileResolution;
  try {
    resolution = resolver(request.action.type, request.action.resourceScope);
    // The action a grant would authorize is `capability ?? type`: both must
    // resolve alike, or which profile governs the request is ambiguous.
    const capability = request.action.capability;
    if (capability !== undefined && capability !== request.action.type && !sameResolution(resolution, resolver(capability, request.action.resourceScope))) {
      return { kind: 'refused' };
    }
  } catch {
    return { kind: 'refused' };
  }

  switch (resolution?.kind) {
    case 'resolved': {
      const key = governanceProfileKey(resolution.profile);
      if (claimed !== undefined && governanceProfileKey(claimed) !== key) return { kind: 'refused' };
      return { kind: 'profile', key };
    }
    case 'unclassified':
      return claimed === undefined ? { kind: 'deployment' } : { kind: 'refused' };
    default:
      return { kind: 'refused' };
  }
}
