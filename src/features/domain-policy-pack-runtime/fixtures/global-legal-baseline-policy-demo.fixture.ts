import { DEMO_POLICY_PACK_WRITER } from './domain-policy-pack-demo.fixture.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../services/policy-pack-runtime.js';
import { registerGlobalLegalBaselinePolicyPack } from '../packs/global-legal-baseline.policy-pack.js';

export const GLOBAL_LEGAL_BASELINE_DEMO_NOW = '2026-01-01T00:00:00.000Z';
export const GLOBAL_LEGAL_BASELINE_TRUST_DOMAIN_ID = 'trust-domain-demo-global-legal-baseline';
export const GLOBAL_LEGAL_BASELINE_ACTOR_ID = 'actor-demo-global-legal-baseline';
export const GLOBAL_LEGAL_BASELINE_RESOURCE_SCOPE = 'project:demo-global-legal-baseline';

/**
 * A PolicyPackRuntime with only `aoc.global_legal_baseline.v1` registered
 * and activated. Kept separate from `buildDemoPolicyPackRuntime()` (the
 * shared seed the other six sample packs' tests reuse) deliberately: this
 * pack's scope is intentionally unconstrained (a global baseline), so
 * folding it into that shared seed would start matching those packs'
 * existing demo inputs and silently changing their asserted decisions. See
 * the module doc comment on `global-legal-baseline.policy-pack.ts`.
 */
export function buildGlobalLegalBaselineDemoPolicyPackRuntime(initialIso: string = GLOBAL_LEGAL_BASELINE_DEMO_NOW): PolicyPackRuntime {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(initialIso));
  registerGlobalLegalBaselinePolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  return runtime;
}

/**
 * A "quiet" baseline PolicyEvaluationInput: every field this pack's rules
 * inspect is set to a value that keeps every rule un-matched (authority/
 * approval/evidence proofs present, a known counterparty, low risk, no
 * legally sensitive side effect, no legal-baseline metadata flags, and no
 * jurisdiction -- pass `jurisdiction` explicitly in `overrides` for any test
 * that isn't specifically exercising the jurisdiction-unknown rule). Each
 * test overrides only the field(s) needed to isolate exactly the rule(s)
 * under test, so cross-rule interaction stays deliberate and visible rather
 * than accidental. `jurisdiction` is intentionally omitted from these
 * defaults (rather than set and overridable to `undefined`) because
 * `PolicyEvaluationInput.jurisdiction` is optional under
 * `exactOptionalPropertyTypes`, which forbids assigning `undefined` to it
 * explicitly.
 */
export function buildQuietGlobalLegalBaselineInput(
  overrides: Partial<PolicyEvaluationInput> & Pick<PolicyEvaluationInput, 'id' | 'action'>,
): PolicyEvaluationInput {
  return {
    trustDomainId: GLOBAL_LEGAL_BASELINE_TRUST_DOMAIN_ID,
    actorId: GLOBAL_LEGAL_BASELINE_ACTOR_ID,
    resourceScope: GLOBAL_LEGAL_BASELINE_RESOURCE_SCOPE,
    riskLevel: 'low',
    requestedAt: GLOBAL_LEGAL_BASELINE_DEMO_NOW,
    counterpartyId: 'counterparty-1',
    hasAuthorityProof: true,
    hasApprovalProof: true,
    hasRequiredEvidence: true,
    ...overrides,
  };
}
