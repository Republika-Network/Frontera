import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';
import { buildPolicyEvaluationInput } from './domain-policy-pack-demo.fixture.js';

export function buildApprovePaymentInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return buildPolicyEvaluationInput({
    id: 'policy-eval-approve-payment',
    action: 'approve_payment',
    domain: 'payments',
    hasAuthorityProof: true,
    hasApprovalProof: false,
    hasRequiredEvidence: true,
    ...overrides,
  });
}

export function buildChangeBankAccountInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return buildPolicyEvaluationInput({
    id: 'policy-eval-change-bank-account',
    action: 'change_bank_account',
    domain: 'payments',
    ...overrides,
  });
}

export function buildHighValueFinancialSideEffectInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return buildPolicyEvaluationInput({
    id: 'policy-eval-high-value-financial-side-effect',
    action: 'transfer_funds',
    domain: 'payments',
    sideEffectType: 'financial',
    amount: '25000',
    currency: 'USD',
    hasApprovalProof: false,
    ...overrides,
  });
}
