import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { buildPolicyEvaluationInput } from './domain-policy-pack-demo.fixture.js';

export function buildSettleEventPaymentInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return buildPolicyEvaluationInput({
    id: 'policy-eval-settle-event-payment',
    action: 'settle_event_payment',
    domain: 'sports_event_settlement',
    counterpartyId: 'counterparty-demo-league',
    jurisdiction: 'demo-jurisdiction-a',
    amount: '1000',
    currency: 'USD',
    hasAuthorityProof: true,
    hasApprovalProof: true,
    hasRequiredEvidence: true,
    ...overrides,
  });
}
