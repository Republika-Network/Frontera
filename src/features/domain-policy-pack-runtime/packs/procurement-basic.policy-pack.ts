import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY sample pack. Basic procurement/invoice support policy -- not a
 * complete procurement compliance or vendor-management pack.
 */
export const PROCUREMENT_BASIC_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-procurement-basic',
  name: 'Procurement Basic (Demo)',
  description: 'Basic procurement/invoice support policy: purchase order evidence, vendor counterparty identification, operator review for high-risk procurement.',
  kind: 'demo',
  domain: 'procurement',
};

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'procurement-basic-source-internal-control',
    type: 'internal_control',
    title: 'Demo procurement control',
    description: 'Illustrative internal control used for demo scenarios only.',
    authority: 'demo_only',
  },
];

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'procurement-basic-rule-invoice-support-evidence',
    policyPackVersionId: 'policy-pack-procurement-basic-v1',
    name: 'Invoice support requires purchase order evidence',
    description: 'prepare_invoice_support requires purchase order or invoice evidence.',
    status: 'active',
    priority: 100,
    condition: all(predicate('action', 'equals', 'prepare_invoice_support'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'INVOICE_SUPPORT_REQUIRES_PURCHASE_ORDER',
      reason: 'prepare_invoice_support requires purchase order or invoice evidence under the procurement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'procurement-basic-evidence-purchase-order',
        type: 'purchase_order',
        description: 'A purchase order or invoice evidencing the transaction must be attached.',
        required: true,
        sourceRuleId: 'procurement-basic-rule-invoice-support-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['procurement-basic-source-internal-control'],
  },
  {
    id: 'procurement-basic-rule-vendor-counterparty-required',
    policyPackVersionId: 'policy-pack-procurement-basic-v1',
    name: 'Vendor actions require a counterparty',
    description: 'Procurement actions are denied when no counterpartyId is present.',
    status: 'active',
    priority: 50,
    condition: all(predicate('domain', 'equals', 'procurement'), predicate('counterpartyId', 'not_exists')),
    effect: {
      type: 'deny',
      reasonCode: 'VENDOR_ACTION_MISSING_COUNTERPARTY',
      reason: 'Procurement actions require a known vendor counterpartyId under the procurement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['procurement-basic-source-internal-control'],
  },
  {
    id: 'procurement-basic-rule-purchase-order-evidence',
    policyPackVersionId: 'policy-pack-procurement-basic-v1',
    name: 'Purchase orders require evidence',
    description: 'submit_purchase_order requires evidence before it may proceed.',
    status: 'active',
    priority: 100,
    condition: all(predicate('action', 'equals', 'submit_purchase_order'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'PURCHASE_ORDER_REQUIRES_EVIDENCE',
      reason: 'submit_purchase_order requires supporting evidence under the procurement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'procurement-basic-evidence-purchase-order-submission',
        type: 'purchase_order',
        description: 'A purchase order evidencing the requested procurement must be attached.',
        required: true,
        sourceRuleId: 'procurement-basic-rule-purchase-order-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['procurement-basic-source-internal-control'],
  },
  {
    id: 'procurement-basic-rule-high-risk-operator-review',
    policyPackVersionId: 'policy-pack-procurement-basic-v1',
    name: 'High-risk procurement requires operator review',
    description: 'High or critical risk procurement actions require operator review.',
    status: 'active',
    priority: 150,
    condition: all(
      predicate('domain', 'equals', 'procurement'),
      predicate('riskLevel', 'in', ['high', 'critical']),
      predicate('hasApprovalProof', 'not_equals', true),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'HIGH_RISK_PROCUREMENT_REQUIRES_OPERATOR_REVIEW',
      reason: 'High or critical risk procurement actions require operator review under the procurement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'procurement-basic-approval-operator-review',
        type: 'operator_review',
        description: 'An operator must review this high-risk procurement action.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'procurement-basic-rule-high-risk-operator-review',
      },
    ],
    severity: 'error',
    sourceIds: ['procurement-basic-source-internal-control'],
  },
];

export const PROCUREMENT_BASIC_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-procurement-basic-v1',
  policyPackId: 'policy-pack-procurement-basic',
  version: '1.0.0',
  scope: { domains: ['procurement'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerProcurementBasicPolicyPack(runtime: PolicyPackRuntime, writer: PolicyPackWriterContext): PolicyPackVersion {
  runtime.registerPolicyPack(writer, PROCUREMENT_BASIC_POLICY_PACK);
  runtime.registerPolicyPackVersion(writer, PROCUREMENT_BASIC_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(writer, PROCUREMENT_BASIC_POLICY_PACK_VERSION_V1.id);
}
