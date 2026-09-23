import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY sample pack. This is a basic enterprise payment safety model,
 * not a complete payments compliance or regulatory pack. Do not represent
 * it as PCI-DSS, AML, or any statutory payments compliance certification.
 */
export const PAYMENTS_BASIC_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-payments-basic',
  name: 'Payments Basic (Demo)',
  description: 'Basic enterprise payment safety policy: finance review on payment approval, deny-by-default bank account changes, dual approval above a value threshold.',
  kind: 'demo',
  domain: 'payments',
};

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'payments-basic-source-internal-control',
    type: 'internal_control',
    title: 'Demo payment safety control',
    description: 'Illustrative internal control used for demo scenarios only.',
    authority: 'demo_only',
  },
];

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'payments-basic-rule-approve-payment-finance-review',
    policyPackVersionId: 'policy-pack-payments-basic-v1',
    name: 'Payment approval requires finance review',
    description: 'approve_payment actions require a finance_review approval before they may proceed.',
    status: 'active',
    priority: 100,
    condition: all(predicate('action', 'equals', 'approve_payment'), predicate('hasApprovalProof', 'not_equals', true)),
    effect: {
      type: 'require_approval',
      reasonCode: 'PAYMENT_REQUIRES_FINANCE_REVIEW',
      reason: 'Payment approval actions require a finance_review approval under the payments-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'payments-basic-approval-finance-review',
        type: 'finance_review',
        description: 'A finance reviewer must approve this payment action.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        requiredAuthorityCapability: 'approve_financial_action',
        sourceRuleId: 'payments-basic-rule-approve-payment-finance-review',
      },
    ],
    severity: 'error',
    sourceIds: ['payments-basic-source-internal-control'],
  },
  {
    id: 'payments-basic-rule-change-bank-account-denied',
    policyPackVersionId: 'policy-pack-payments-basic-v1',
    name: 'Bank account changes denied by default',
    description: 'change_bank_account is denied unless explicitly allowed by customer policy metadata.',
    status: 'active',
    priority: 50,
    condition: all(
      predicate('action', 'equals', 'change_bank_account'),
      predicate('metadata', 'not_equals', true, 'customerPolicyAllowsBankAccountChange'),
    ),
    effect: {
      type: 'deny',
      reasonCode: 'BANK_ACCOUNT_CHANGE_DENIED_BY_DEFAULT',
      reason: 'Bank account changes are denied by default under the payments-basic demo policy unless customer policy metadata explicitly allows them.',
    },
    obligations: [
      {
        id: 'payments-basic-obligation-notify-operator',
        type: 'notify_operator',
        description: 'Notify an operator whenever a bank account change is attempted.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['payments-basic-source-internal-control'],
  },
  {
    id: 'payments-basic-rule-high-value-dual-approval',
    policyPackVersionId: 'policy-pack-payments-basic-v1',
    name: 'High-value financial side effects require dual approval',
    description: 'Financial side effects at or above 10,000 in the requested currency require dual approval.',
    status: 'active',
    priority: 150,
    condition: all(
      predicate('sideEffectType', 'equals', 'financial'),
      predicate('amount', 'greater_than_or_equal', '10000'),
      predicate('hasApprovalProof', 'not_equals', true),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'HIGH_VALUE_FINANCIAL_SIDE_EFFECT_REQUIRES_DUAL_APPROVAL',
      reason: 'Financial side effects of 10,000 or more require dual approval under the payments-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'payments-basic-approval-dual-approval',
        type: 'dual_approval',
        description: 'Two independent approvers must approve this high-value financial side effect.',
        required: true,
        minimumApprovals: 2,
        requiresSegregationOfDuties: true,
        sourceRuleId: 'payments-basic-rule-high-value-dual-approval',
      },
    ],
    severity: 'critical',
    sourceIds: ['payments-basic-source-internal-control'],
  },
  {
    id: 'payments-basic-rule-invoice-evidence',
    policyPackVersionId: 'policy-pack-payments-basic-v1',
    name: 'Payments require invoice evidence',
    description: 'approve_payment actions require invoice (or approval memo) evidence.',
    status: 'active',
    priority: 200,
    condition: all(predicate('action', 'equals', 'approve_payment'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'PAYMENT_REQUIRES_INVOICE_EVIDENCE',
      reason: 'Payment approval actions require invoice or approval-memo evidence under the payments-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'payments-basic-evidence-invoice',
        type: 'invoice',
        description: 'An invoice or approval memo evidencing the payment must be attached.',
        required: true,
        sourceRuleId: 'payments-basic-rule-invoice-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['payments-basic-source-internal-control'],
  },
  {
    id: 'payments-basic-rule-authority-proof-required',
    policyPackVersionId: 'policy-pack-payments-basic-v1',
    name: 'Payments require authority proof',
    description: 'approve_payment actions with no authority proof require authority before proceeding.',
    status: 'active',
    priority: 25,
    condition: all(predicate('action', 'equals', 'approve_payment'), predicate('hasAuthorityProof', 'not_equals', true)),
    effect: {
      type: 'require_authority',
      reasonCode: 'PAYMENT_MISSING_AUTHORITY_PROOF',
      reason: 'Payment approval actions require a valid authority proof under the payments-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['payments-basic-source-internal-control'],
  },
];

export const PAYMENTS_BASIC_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-payments-basic-v1',
  policyPackId: 'policy-pack-payments-basic',
  version: '1.0.0',
  scope: { domains: ['payments'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerPaymentsBasicPolicyPack(runtime: PolicyPackRuntime): PolicyPackVersion {
  runtime.registerPolicyPack(PAYMENTS_BASIC_POLICY_PACK);
  runtime.registerPolicyPackVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);
}
