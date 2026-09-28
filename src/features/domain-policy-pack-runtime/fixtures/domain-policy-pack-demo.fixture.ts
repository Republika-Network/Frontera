import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../services/policy-pack-runtime.js';
import { registerPaymentsBasicPolicyPack } from '../packs/payments-basic.policy-pack.js';
import { registerProcurementBasicPolicyPack } from '../packs/procurement-basic.policy-pack.js';
import { registerDataBoundaryBasicPolicyPack } from '../packs/data-boundary-basic.policy-pack.js';
import { registerSportsEventSettlementBasicPolicyPack } from '../packs/sports-event-settlement-basic.policy-pack.js';
import { registerFinancialApprovalBasicPolicyPack } from '../packs/financial-approval-basic.policy-pack.js';
import { registerJurisdictionalBaselineDemoPolicyPack } from '../packs/jurisdictional-baseline-demo.policy-pack.js';

export const DEMO_POLICY_PACK_NOW = '2026-01-01T00:00:00.000Z';
export const DEMO_TRUST_DOMAIN_ID = 'trust-domain-demo-policy-packs';
export const DEMO_ACTOR_ID = 'actor-demo-policy-packs';
export const DEMO_RESOURCE_SCOPE = 'project:demo-policy-packs';

/** A PolicyPackRuntime with every sample pack registered and activated -- the shared seed for demo scenarios and integration tests. */
/** NB-008: the trusted writer the demo packs are registered by. A demo operator identity, recorded on every pack, version and lifecycle event. */
export const DEMO_POLICY_PACK_WRITER: PolicyPackWriterContext = Object.freeze({ system: true, actorId: 'operator:policy-pack-demo' });

export function buildDemoPolicyPackRuntime(initialIso: string = DEMO_POLICY_PACK_NOW): PolicyPackRuntime {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(initialIso));
  registerPaymentsBasicPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  registerProcurementBasicPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  registerDataBoundaryBasicPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  registerSportsEventSettlementBasicPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  registerFinancialApprovalBasicPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  registerJurisdictionalBaselineDemoPolicyPack(runtime, DEMO_POLICY_PACK_WRITER);
  return runtime;
}

export function buildPolicyEvaluationInput(
  overrides: Partial<PolicyEvaluationInput> & Pick<PolicyEvaluationInput, 'id' | 'action'>,
): PolicyEvaluationInput {
  return {
    trustDomainId: DEMO_TRUST_DOMAIN_ID,
    actorId: DEMO_ACTOR_ID,
    resourceScope: DEMO_RESOURCE_SCOPE,
    riskLevel: 'low',
    requestedAt: DEMO_POLICY_PACK_NOW,
    ...overrides,
  };
}
