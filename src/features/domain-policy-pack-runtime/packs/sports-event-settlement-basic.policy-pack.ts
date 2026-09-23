import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, predicate } from './policy-pack-builders.js';

/**
 * DEMO-ONLY sample pack. Basic policy for agent-managed sports event
 * settlement under smart contracts -- not a complete sports-betting,
 * gaming, or financial-settlement compliance pack, and not tied to any
 * real jurisdiction's licensing regime.
 */
export const SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK: RegisterPolicyPackParams = {
  id: 'policy-pack-sports-event-settlement-basic',
  name: 'Sports Event Settlement Basic (Demo)',
  description: 'Basic policy for agent-managed sports event settlement: event record evidence, authority proof, value-threshold approval, unsupported-jurisdiction manual verification, counterparty requirement.',
  kind: 'demo',
  domain: 'sports_event_settlement',
};

const SUPPORTED_DEMO_JURISDICTIONS = ['demo-jurisdiction-a', 'demo-jurisdiction-b'];
/** Canonical decimal text (P9): a monetary threshold is never a JavaScript number. */
const SETTLEMENT_APPROVAL_THRESHOLD = '5000';

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'sports-settlement-basic-source-internal-control',
    type: 'internal_control',
    title: 'Demo sports event settlement control',
    description: 'Illustrative internal control used for demo scenarios only.',
    authority: 'demo_only',
  },
];

const RULES: readonly PolicyPackRule[] = [
  {
    id: 'sports-settlement-basic-rule-event-record-evidence',
    policyPackVersionId: 'policy-pack-sports-event-settlement-basic-v1',
    name: 'Settlement requires event record evidence',
    description: 'settle_event_payment requires event_record evidence.',
    status: 'active',
    priority: 100,
    condition: all(predicate('action', 'equals', 'settle_event_payment'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'SETTLEMENT_REQUIRES_EVENT_RECORD',
      reason: 'settle_event_payment requires event_record evidence under the sports-event-settlement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'sports-settlement-basic-evidence-event-record',
        type: 'event_record',
        description: 'A verified event record evidencing the settlement outcome must be attached.',
        required: true,
        sourceRuleId: 'sports-settlement-basic-rule-event-record-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['sports-settlement-basic-source-internal-control'],
  },
  {
    id: 'sports-settlement-basic-rule-authority-proof-required',
    policyPackVersionId: 'policy-pack-sports-event-settlement-basic-v1',
    name: 'Settlement requires authority proof',
    description: 'settle_event_payment requires a valid authority proof.',
    status: 'active',
    priority: 25,
    condition: all(predicate('action', 'equals', 'settle_event_payment'), predicate('hasAuthorityProof', 'not_equals', true)),
    effect: {
      type: 'require_authority',
      reasonCode: 'SETTLEMENT_MISSING_AUTHORITY_PROOF',
      reason: 'settle_event_payment requires a valid authority proof under the sports-event-settlement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['sports-settlement-basic-source-internal-control'],
  },
  {
    id: 'sports-settlement-basic-rule-value-threshold-approval',
    policyPackVersionId: 'policy-pack-sports-event-settlement-basic-v1',
    name: 'High-value settlement requires approval',
    description: `settle_event_payment at or above ${SETTLEMENT_APPROVAL_THRESHOLD} requires approval.`,
    status: 'active',
    priority: 150,
    condition: all(
      predicate('action', 'equals', 'settle_event_payment'),
      predicate('amount', 'greater_than_or_equal', SETTLEMENT_APPROVAL_THRESHOLD),
      predicate('hasApprovalProof', 'not_equals', true),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'SETTLEMENT_VALUE_REQUIRES_APPROVAL',
      reason: `settle_event_payment at or above ${SETTLEMENT_APPROVAL_THRESHOLD} requires approval under the sports-event-settlement-basic demo policy.`,
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'sports-settlement-basic-approval-finance-review',
        type: 'finance_review',
        description: 'A finance reviewer must approve this high-value settlement.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'sports-settlement-basic-rule-value-threshold-approval',
      },
    ],
    severity: 'error',
    sourceIds: ['sports-settlement-basic-source-internal-control'],
  },
  {
    id: 'sports-settlement-basic-rule-unsupported-jurisdiction',
    policyPackVersionId: 'policy-pack-sports-event-settlement-basic-v1',
    name: 'Unsupported jurisdiction requires manual verification',
    description: 'Settlement in a jurisdiction outside the demo-supported list requires manual verification.',
    status: 'active',
    priority: 300,
    condition: all(
      predicate('action', 'equals', 'settle_event_payment'),
      predicate('jurisdiction', 'exists'),
      predicate('jurisdiction', 'not_in', SUPPORTED_DEMO_JURISDICTIONS),
    ),
    effect: {
      type: 'warn',
      reasonCode: 'UNSUPPORTED_JURISDICTION_REQUIRES_MANUAL_VERIFICATION',
      reason: 'This settlement jurisdiction is outside the demo-supported list and requires manual verification.',
    },
    obligations: [
      {
        id: 'sports-settlement-basic-obligation-manual-verification',
        type: 'manual_verification',
        description: 'An operator must manually verify settlement eligibility for this jurisdiction before proceeding.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'warning',
    sourceIds: ['sports-settlement-basic-source-internal-control'],
  },
  {
    id: 'sports-settlement-basic-rule-counterparty-required',
    policyPackVersionId: 'policy-pack-sports-event-settlement-basic-v1',
    name: 'Settlement requires a counterparty',
    description: 'settle_event_payment is denied when no counterpartyId is present.',
    status: 'active',
    priority: 50,
    condition: all(predicate('action', 'equals', 'settle_event_payment'), predicate('counterpartyId', 'not_exists')),
    effect: {
      type: 'deny',
      reasonCode: 'SETTLEMENT_MISSING_COUNTERPARTY',
      reason: 'settle_event_payment requires a known counterpartyId under the sports-event-settlement-basic demo policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['sports-settlement-basic-source-internal-control'],
  },
];

export const SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: 'policy-pack-sports-event-settlement-basic-v1',
  policyPackId: 'policy-pack-sports-event-settlement-basic',
  version: '1.0.0',
  scope: { domains: ['sports_event_settlement'] },
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'not_legal_advice',
};

export function registerSportsEventSettlementBasicPolicyPack(runtime: PolicyPackRuntime): PolicyPackVersion {
  runtime.registerPolicyPack(SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK);
  runtime.registerPolicyPackVersion(SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(SPORTS_EVENT_SETTLEMENT_BASIC_POLICY_PACK_VERSION_V1.id);
}
