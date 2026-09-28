import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, any, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY sample pack. Basic data export / data domain boundary policy --
 * not a complete data protection or privacy compliance pack (not GDPR,
 * HIPAA, CCPA, or any other statutory data protection certification).
 */
export const DATA_BOUNDARY_BASIC_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-data-boundary-basic',
  name: 'Data Boundary Basic (Demo)',
  description: 'Basic data export/data domain policy: compliance review for sensitive exports, denial of prohibited exports, evidence for data classification.',
  kind: 'demo',
  domain: 'data_boundary',
};

const SENSITIVE_DATA_DOMAINS = ['pii', 'health_records', 'financial_records'];
const PROHIBITED_DATA_DOMAINS = ['classified', 'export_controlled'];

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'data-boundary-basic-source-internal-control',
    type: 'internal_control',
    title: 'Demo data boundary control',
    description: 'Illustrative internal control used for demo scenarios only.',
    authority: 'demo_only',
  },
];

function includesAnyDataDomain(domains: readonly string[]) {
  return any(...domains.map((domain) => predicate('dataDomains', 'includes', domain)));
}

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'data-boundary-basic-rule-sensitive-export-compliance-review',
    policyPackVersionId: 'policy-pack-data-boundary-basic-v1',
    name: 'Sensitive data export requires compliance review',
    description: 'export_client_data touching sensitive data domains requires compliance review.',
    status: 'active',
    priority: 100,
    condition: all(
      predicate('action', 'equals', 'export_client_data'),
      includesAnyDataDomain(SENSITIVE_DATA_DOMAINS),
      predicate('hasApprovalProof', 'not_equals', true),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'SENSITIVE_DATA_EXPORT_REQUIRES_COMPLIANCE_REVIEW',
      reason: 'Exports touching sensitive data domains require compliance review under the data-boundary-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'data-boundary-basic-approval-compliance-review',
        type: 'compliance_review',
        description: 'A compliance reviewer must approve this sensitive data export.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'data-boundary-basic-rule-sensitive-export-compliance-review',
      },
    ],
    severity: 'error',
    sourceIds: ['data-boundary-basic-source-internal-control'],
  },
  {
    id: 'data-boundary-basic-rule-prohibited-export-denied',
    policyPackVersionId: 'policy-pack-data-boundary-basic-v1',
    name: 'Prohibited data export denied',
    description: 'export_client_data touching prohibited data domains is denied.',
    status: 'active',
    priority: 50,
    condition: all(predicate('action', 'equals', 'export_client_data'), includesAnyDataDomain(PROHIBITED_DATA_DOMAINS)),
    effect: {
      type: 'deny',
      reasonCode: 'PROHIBITED_DATA_DOMAIN_EXPORT_DENIED',
      reason: 'Exports touching prohibited data domains are denied under the data-boundary-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['data-boundary-basic-source-internal-control'],
  },
  {
    id: 'data-boundary-basic-rule-non-sensitive-read-allowed',
    policyPackVersionId: 'policy-pack-data-boundary-basic-v1',
    name: 'Non-sensitive project summary reads are allowed',
    description: 'read_project_summary is explicitly allowed when it touches no sensitive or prohibited data domain.',
    status: 'active',
    priority: 500,
    condition: all(
      predicate('action', 'equals', 'read_project_summary'),
      { type: 'group', operator: 'not', conditions: [includesAnyDataDomain([...SENSITIVE_DATA_DOMAINS, ...PROHIBITED_DATA_DOMAINS])] },
    ),
    effect: {
      type: 'allow',
      reasonCode: 'NON_SENSITIVE_PROJECT_SUMMARY_READ_ALLOWED',
      reason: 'read_project_summary is allowed under the data-boundary-basic demo policy when it touches no sensitive or prohibited data domain.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'info',
    sourceIds: ['data-boundary-basic-source-internal-control'],
  },
  {
    id: 'data-boundary-basic-rule-data-export-classification-evidence',
    policyPackVersionId: 'policy-pack-data-boundary-basic-v1',
    name: 'Data export side effects require data classification evidence',
    description: 'Side effects of type data_export require data classification evidence.',
    status: 'active',
    priority: 150,
    condition: all(predicate('sideEffectType', 'equals', 'data_export'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'DATA_EXPORT_REQUIRES_CLASSIFICATION_EVIDENCE',
      reason: 'Data export side effects require data classification evidence under the data-boundary-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'data-boundary-basic-evidence-data-classification',
        type: 'data_classification',
        description: 'A data classification record for the exported data must be attached.',
        required: true,
        sourceRuleId: 'data-boundary-basic-rule-data-export-classification-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['data-boundary-basic-source-internal-control'],
  },
];

export const DATA_BOUNDARY_BASIC_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-data-boundary-basic-v1',
  policyPackId: 'policy-pack-data-boundary-basic',
  version: '1.0.0',
  scope: { domains: ['data_boundary'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerDataBoundaryBasicPolicyPack(runtime: PolicyPackRuntime, writer: PolicyPackWriterContext): PolicyPackVersion {
  runtime.registerPolicyPack(writer, DATA_BOUNDARY_BASIC_POLICY_PACK);
  runtime.registerPolicyPackVersion(writer, DATA_BOUNDARY_BASIC_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(writer, DATA_BOUNDARY_BASIC_POLICY_PACK_VERSION_V1.id);
}
