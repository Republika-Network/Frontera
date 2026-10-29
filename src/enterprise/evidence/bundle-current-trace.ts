import type { GovernanceRecord, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { EvidenceBundle } from './contracts.js';
import { authorityTraceVerificationOf, buildAuthorityTrace, type AuthorityTraceSources } from './trace-builder.js';
import { discloseAuthorityTrace, discloseTraceVerification, findDisclosurePolicyV2ById } from './trace-disclosure.js';
import type { EvidenceBundleCurrentTrace } from './verifier.js';

/**
 * What the canonical records say now about a v2 bundle's request, read in
 * `context`: the Governance Record the trace was built over and, when the
 * bundle names a registered v2 policy, the current trace disclosed under that
 * policy with its verification -- exactly what `verifyEvidenceBundle` needs as
 * `record` and `currentTrace`. The trace is rebuilt from the canonical stores,
 * never from the bundle being verified.
 *
 * - `rebuilt`: the request is a governed request visible in `context`.
 * - `not-found`: no such governed request in `context` (absent, another
 *   organization's, or not on the governed-action path).
 * - `read-failed`: a canonical store could not be read.
 *
 * Neither `not-found` nor `read-failed` says anything about the bundle's
 * integrity; the caller verifies without a current trace, and a v2 bundle
 * then never verifies.
 */
export type EvidenceBundleCurrentTraceLookup =
  | { readonly status: 'rebuilt'; readonly record: GovernanceRecord; readonly currentTrace?: EvidenceBundleCurrentTrace }
  | { readonly status: 'not-found' }
  | { readonly status: 'read-failed' };

export async function rebuildEvidenceBundleCurrentTrace(
  sources: AuthorityTraceSources,
  context: GovernanceStoreAccessContext,
  bundle: EvidenceBundle,
  now: () => string,
): Promise<EvidenceBundleCurrentTraceLookup> {
  const policy = findDisclosurePolicyV2ById(bundle.disclosure.policyId);
  try {
    const build = await buildAuthorityTrace(sources, context, bundle.source.requestId);
    if (build === null) return { status: 'not-found' };
    if (policy === undefined) return { status: 'rebuilt', record: build.record };
    return {
      status: 'rebuilt',
      record: build.record,
      currentTrace: { disclosed: discloseAuthorityTrace(build.trace, policy), verification: discloseTraceVerification(authorityTraceVerificationOf(build, now()), policy) },
    };
  } catch {
    return { status: 'read-failed' };
  }
}
