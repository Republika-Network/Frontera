import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY sample pack. Basic financial approval policy -- not a complete
 * SOX, financial-controls, or banking-regulatory compliance pack.
 */
export const FINANCIAL_APPROVAL_BASIC_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-financial-approval-basic',
  name: 'Financial Approval Basic (Demo)',
  description: 'Basic financial approval policy: finance review for the finance_approval capability, deny-by-default bank details management, approval proof for financial side effects, dual approval for critical financial risk.',
  kind: 'demo',
  domain: 'financial_approval',
};

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'financial-approval-basic-source-internal-control',
    type: 'internal_control',
    title: 'Demo financial approval control',
    description: 'Illustrative internal control used for demo scenarios only.',
    authority: 'demo_only',
  },
];

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'financial-approval-basic-rule-bank-details-denied',
    policyPackVersionId: 'policy-pack-financial-approval-basic-v1',
    name: 'Bank details management denied by default',
    description: 'The bank_details_management capability is denied by default.',
    status: 'active',
    priority: 25,
    condition: predicate('capability', 'equals', 'bank_details_management'),
    effect: {
      type: 'deny',
      reasonCode: 'BANK_DETAILS_MANAGEMENT_DENIED_BY_DEFAULT',
      reason: 'The bank_details_management capability is denied by default under the financial-approval-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['financial-approval-basic-source-internal-control'],
  },
  {
    id: 'financial-approval-basic-rule-finance-approval-capability',
    policyPackVersionId: 'policy-pack-financial-approval-basic-v1',
    name: 'finance_approval capability requires finance review',
    description: 'Actions carrying the finance_approval capability require a finance_review approval.',
    status: 'active',
    priority: 100,
    condition: all(predicate('capability', 'equals', 'finance_approval'), predicate('hasApprovalProof', 'not_equals', true)),
    effect: {
      type: 'require_approval',
      reasonCode: 'FINANCE_APPROVAL_CAPABILITY_REQUIRES_REVIEW',
      reason: 'The finance_approval capability requires a finance_review approval under the financial-approval-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'financial-approval-basic-approval-finance-review',
        type: 'finance_review',
        description: 'A finance reviewer must approve this action.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        requiredAuthorityCapability: 'approve_financial_action',
        sourceRuleId: 'financial-approval-basic-rule-finance-approval-capability',
      },
    ],
    severity: 'error',
    sourceIds: ['financial-approval-basic-source-internal-control'],
  },
  {
    id: 'financial-approval-basic-rule-financial-side-effect-approval',
    policyPackVersionId: 'policy-pack-financial-approval-basic-v1',
    name: 'Financial side effects require approval proof',
    description: 'Side effects of type financial require an approval proof.',
    status: 'active',
    priority: 200,
    condition: all(predicate('sideEffectType', 'equals', 'financial'), predicate('hasApprovalProof', 'not_equals', true)),
    effect: {
      type: 'require_approval',
      reasonCode: 'FINANCIAL_SIDE_EFFECT_REQUIRES_APPROVAL',
      reason: 'Financial side effects require an approval proof under the financial-approval-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'financial-approval-basic-approval-single',
        type: 'single_approval',
        description: 'An approver must approve this financial side effect.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'financial-approval-basic-rule-financial-side-effect-approval',
      },
    ],
    severity: 'error',
    sourceIds: ['financial-approval-basic-source-internal-control'],
  },
  {
    id: 'financial-approval-basic-rule-critical-risk-dual-approval',
    policyPackVersionId: 'policy-pack-financial-approval-basic-v1',
    name: 'Critical financial risk requires dual approval',
    description: 'Financial side effects at critical risk level require dual approval.',
    status: 'active',
    priority: 50,
    condition: all(
      predicate('sideEffectType', 'equals', 'financial'),
      predicate('riskLevel', 'equals', 'critical'),
      predicate('hasApprovalProof', 'not_equals', true),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'CRITICAL_FINANCIAL_RISK_REQUIRES_DUAL_APPROVAL',
      reason: 'Critical-risk financial side effects require dual approval under the financial-approval-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'financial-approval-basic-approval-dual',
        type: 'dual_approval',
        description: 'Two independent approvers must approve this critical-risk financial side effect.',
        required: true,
        minimumApprovals: 2,
        requiresSegregationOfDuties: true,
        sourceRuleId: 'financial-approval-basic-rule-critical-risk-dual-approval',
      },
    ],
    severity: 'critical',
    sourceIds: ['financial-approval-basic-source-internal-control'],
  },
];

export const FINANCIAL_APPROVAL_BASIC_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-financial-approval-basic-v1',
  policyPackId: 'policy-pack-financial-approval-basic',
  version: '1.0.0',
  scope: { domains: ['financial_approval'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerFinancialApprovalBasicPolicyPack(runtime: PolicyPackRuntime, writer: PolicyPackWriterContext): PolicyPackVersion {
  runtime.registerPolicyPack(writer, FINANCIAL_APPROVAL_BASIC_POLICY_PACK);
  runtime.registerPolicyPackVersion(writer, FINANCIAL_APPROVAL_BASIC_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(writer, FINANCIAL_APPROVAL_BASIC_POLICY_PACK_VERSION_V1.id);
}
