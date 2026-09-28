import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY PLACEHOLDER pack. This is a baseline model showing the *shape*
 * of a jurisdictional policy pack -- it does not encode any real
 * jurisdiction's law. It does not claim to encode Costa Rica, Panama, the
 * EU, the US, or any other real jurisdiction's requirements, and it makes
 * no statutory compliance claim. Because this pack has no real
 * jurisdictional data source, it treats every jurisdiction-tagged action as
 * requiring manual verification -- that is intentional: a real
 * jurisdictional pack must be authored (and counsel-reviewed) per
 * deployment, not inherited from this baseline.
 */
export const JURISDICTIONAL_BASELINE_DEMO_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-jurisdictional-baseline-demo',
  name: 'Jurisdictional Baseline (Demo Placeholder)',
  description: 'Placeholder jurisdictional policy model: legal/contractual side effects require legal review, sign_contract requires authority and approval proof, jurisdiction-tagged actions require source references, and every jurisdiction is treated as unrecognized pending manual verification.',
  kind: 'jurisdiction',
  domain: 'general_enterprise',
};

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'jurisdictional-baseline-demo-source-assumption',
    type: 'demo_assumption',
    title: 'Demo jurisdictional baseline assumption',
    description: 'This pack encodes no real jurisdiction. It exists to demonstrate how a real, customer/counsel-reviewed jurisdictional pack would be loaded and evaluated.',
    authority: 'demo_only',
  },
];

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'jurisdictional-baseline-demo-rule-legal-contractual-review',
    policyPackVersionId: 'policy-pack-jurisdictional-baseline-demo-v1',
    name: 'Legal or contractual side effects require legal review',
    description: 'Side effects of type legal or contractual require legal review.',
    status: 'active',
    priority: 100,
    condition: all(predicate('sideEffectType', 'in', ['legal', 'contractual']), predicate('hasApprovalProof', 'not_equals', true)),
    effect: {
      type: 'require_approval',
      reasonCode: 'LEGAL_OR_CONTRACTUAL_SIDE_EFFECT_REQUIRES_REVIEW',
      reason: 'Legal or contractual side effects require legal review under the jurisdictional-baseline-demo placeholder policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'jurisdictional-baseline-demo-approval-legal-review-side-effect',
        type: 'legal_review',
        description: 'A legal reviewer must approve this legal or contractual side effect.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'jurisdictional-baseline-demo-rule-legal-contractual-review',
      },
    ],
    severity: 'error',
    sourceIds: ['jurisdictional-baseline-demo-source-assumption'],
  },
  {
    id: 'jurisdictional-baseline-demo-rule-sign-contract-authority',
    policyPackVersionId: 'policy-pack-jurisdictional-baseline-demo-v1',
    name: 'sign_contract requires authority proof',
    description: 'sign_contract requires a valid authority proof.',
    status: 'active',
    priority: 25,
    condition: all(predicate('action', 'equals', 'sign_contract'), predicate('hasAuthorityProof', 'not_equals', true)),
    effect: {
      type: 'require_authority',
      reasonCode: 'SIGN_CONTRACT_MISSING_AUTHORITY_PROOF',
      reason: 'sign_contract requires a valid authority proof under the jurisdictional-baseline-demo placeholder policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['jurisdictional-baseline-demo-source-assumption'],
  },
  {
    id: 'jurisdictional-baseline-demo-rule-sign-contract-approval',
    policyPackVersionId: 'policy-pack-jurisdictional-baseline-demo-v1',
    name: 'sign_contract requires approval proof',
    description: 'sign_contract requires legal review approval.',
    status: 'active',
    priority: 100,
    condition: all(predicate('action', 'equals', 'sign_contract'), predicate('hasApprovalProof', 'not_equals', true)),
    effect: {
      type: 'require_approval',
      reasonCode: 'SIGN_CONTRACT_MISSING_APPROVAL_PROOF',
      reason: 'sign_contract requires legal review approval under the jurisdictional-baseline-demo placeholder policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'jurisdictional-baseline-demo-approval-legal-review-sign-contract',
        type: 'legal_review',
        description: 'A legal reviewer must approve this contract signature.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'jurisdictional-baseline-demo-rule-sign-contract-approval',
      },
    ],
    severity: 'error',
    sourceIds: ['jurisdictional-baseline-demo-source-assumption'],
  },
  {
    id: 'jurisdictional-baseline-demo-rule-jurisdiction-source-reference',
    policyPackVersionId: 'policy-pack-jurisdictional-baseline-demo-v1',
    name: 'Jurisdiction-tagged actions require a source reference',
    description: 'Actions tagged with a jurisdiction must attach a source/reference note explaining why that jurisdiction applies.',
    status: 'active',
    priority: 400,
    condition: predicate('jurisdiction', 'exists'),
    effect: {
      type: 'warn',
      reasonCode: 'JURISDICTION_TAGGED_ACTION_REQUIRES_SOURCE_REFERENCE',
      reason: 'Jurisdiction-tagged actions require an attached source reference under the jurisdictional-baseline-demo placeholder policy.',
    },
    obligations: [
      {
        id: 'jurisdictional-baseline-demo-obligation-attach-source-reference',
        type: 'attach_source_reference',
        description: 'Attach a source/reference note documenting why this jurisdiction applies.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'warning',
    sourceIds: ['jurisdictional-baseline-demo-source-assumption'],
  },
  {
    id: 'jurisdictional-baseline-demo-rule-unknown-jurisdiction',
    policyPackVersionId: 'policy-pack-jurisdictional-baseline-demo-v1',
    name: 'Every jurisdiction is unrecognized by this baseline pack',
    description: 'This placeholder pack encodes no real jurisdiction, so every jurisdiction-tagged action requires manual verification.',
    status: 'active',
    priority: 450,
    condition: predicate('jurisdiction', 'exists'),
    effect: {
      type: 'warn',
      reasonCode: 'JURISDICTION_NOT_RECOGNIZED_BY_BASELINE_PACK',
      reason: 'This jurisdiction is not recognized by the jurisdictional-baseline-demo placeholder policy and requires manual verification.',
    },
    obligations: [
      {
        id: 'jurisdictional-baseline-demo-obligation-manual-verification',
        type: 'manual_verification',
        description: 'An operator must manually verify jurisdictional eligibility before this action proceeds; this baseline pack encodes no real jurisdictional rules.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'warning',
    sourceIds: ['jurisdictional-baseline-demo-source-assumption'],
  },
];

export const JURISDICTIONAL_BASELINE_DEMO_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-jurisdictional-baseline-demo-v1',
  policyPackId: 'policy-pack-jurisdictional-baseline-demo',
  version: '1.0.0',
  scope: { domains: ['general_enterprise'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerJurisdictionalBaselineDemoPolicyPack(runtime: PolicyPackRuntime, writer: PolicyPackWriterContext): PolicyPackVersion {
  runtime.registerPolicyPack(writer, JURISDICTIONAL_BASELINE_DEMO_POLICY_PACK);
  runtime.registerPolicyPackVersion(writer, JURISDICTIONAL_BASELINE_DEMO_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(writer, JURISDICTIONAL_BASELINE_DEMO_POLICY_PACK_VERSION_V1.id);
}
