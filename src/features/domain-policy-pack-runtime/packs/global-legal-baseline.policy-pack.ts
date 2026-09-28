import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRuntime, RegisterPolicyPackParams, RegisterPolicyPackVersionParams } from '../services/policy-pack-runtime.js';
import { all, any, predicate } from './policy-pack-builders.js';

/**
 * Soberanía Global Legal Baseline Pack v1 (`aoc.global_legal_baseline.v1`).
 *
 * This pack is a **baseline legal-awareness layer**, not a legal compliance
 * engine. It gives Soberanía a reusable, deterministic baseline for jurisdiction
 * awareness, legal-review triggers, required evidence signals, authority
 * boundary flags, regulated-action warnings, prohibited-action baseline
 * patterns, approval escalation requirements, and customer/counsel
 * validation metadata -- evaluated entirely through the existing Domain
 * Policy Pack Runtime, exactly like every other pack in `packs/`. It creates
 * no separate legal engine, legal interpreter, or jurisdictional law
 * resolver: every rule below is the same `condition` -> `effect` shape used
 * by `payments-basic`, `procurement-basic`, and the other sample packs, and
 * every decision it can produce collapses onto this runtime's existing
 * `PolicyPackDecisionType` vocabulary (see the mapping note below).
 *
 * This pack does NOT claim: legal advice, legal completeness, jurisdictional
 * compliance (Costa Rica/US/EU/Panama/or any other real jurisdiction),
 * banking/healthcare/labor/commercial/civil/criminal compliance, global
 * legal coverage, autonomous legal interpretation, or replacement of
 * counsel. Every rule's effect is a *review/evidence/approval escalation*,
 * never a compliance conclusion -- see "Never overriding core denials" and
 * "Legal / compliance disclaimer" in this module's README, which this pack
 * follows to the letter.
 *
 * Required framing labels (preserved on every rule's evaluation via this
 * pack's `PolicyPackVersion.metadata`, never invented ad hoc per decision):
 * `not_legal_advice`, `partial_policy_model`, `baseline_legal_awareness`,
 * `requires_customer_validation`, `requires_counsel_review_when_applicable`,
 * `not_jurisdiction_specific`, `not_compliance_certification`.
 *
 * Decision-type mapping note: this runtime's `PolicyPackDecisionType` has no
 * literal `hold` value. Wherever the pack's own design language says "hold"
 * or "require review", the concrete effect below is `require_evidence` or
 * `require_approval` (both non-blocking-only in the sense that they stop
 * execution until satisfied, exactly like every other pack's evidence/
 * approval requirements) -- never `allow`. `deny` is reserved for hard
 * prohibited-action baseline patterns (operational safety rules, not legal
 * conclusions) and authority-boundary violations.
 *
 * Scope is intentionally left unconstrained (`{}`): this is a *global*
 * baseline meant to apply across every domain/jurisdiction/industry, not one
 * particular vertical. Because of that, this pack is registered on its own
 * `PolicyPackRuntime` via `registerGlobalLegalBaselinePolicyPack()` /
 * `buildGlobalLegalBaselineDemoPolicyPackRuntime()` rather than folded into
 * the shared `buildDemoPolicyPackRuntime()` seed used by the other six
 * sample packs' tests -- an unconstrained-scope pack added to that shared
 * seed would start matching unrelated packs' existing demo inputs and
 * silently change their asserted decisions. Wiring this pack into the
 * shared demo runtime, `action-enforcement`, `aoc-enterprise-demo`, or the
 * Enterprise Pilot Template is deliberately left as a follow-up once a real
 * deployment has decided which of this pack's triggers it wants active
 * enterprise-wide (see "Adding a new policy pack" in the README).
 */
export const GLOBAL_LEGAL_BASELINE_POLICY_PACK_ID = 'aoc.global_legal_baseline.v1';
export const GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID = 'aoc.global_legal_baseline.v1-r1';

export const GLOBAL_LEGAL_BASELINE_POLICY_PACK: RegisterPolicyPackParams = {
  id: GLOBAL_LEGAL_BASELINE_POLICY_PACK_ID,
  name: 'Soberanía Global Legal Baseline Pack v1',
  description:
    'Deterministic, non-jurisdiction-specific baseline for legal awareness: jurisdiction-unknown/conflict handling, authority-boundary flags, legal-review triggers, regulated-action-pattern warnings, prohibited-action baseline patterns, and customer/counsel validation gating. Not legal advice. Not a compliance certification. Does not interpret law or replace counsel.',
  kind: 'domain',
  domain: 'legal',
  metadata: {
    legalAdvice: false,
    complianceCertification: false,
    jurisdictionSpecific: false,
    completenessClaimed: false,
    policyModelStatus: 'partial_policy_model',
    validationStatus: 'demo_baseline',
    requiredDisclaimer: 'not_legal_advice',
    safeFramingLabels: [
      'not_legal_advice',
      'partial_policy_model',
      'baseline_legal_awareness',
      'requires_customer_validation',
      'requires_counsel_review_when_applicable',
      'not_jurisdiction_specific',
      'not_compliance_certification',
    ],
  },
};

const SOURCES: readonly PolicyPackSource[] = [
  {
    id: 'global-legal-baseline-source-assumption',
    type: 'demo_assumption',
    title: 'Global legal baseline demo assumption',
    description:
      'This pack encodes a reusable baseline shape (jurisdiction awareness, authority boundaries, review triggers, evidence signals, approval escalation, prohibited patterns) -- not any real jurisdiction, regulation, or industry compliance regime. Every real deployment must author jurisdiction-/customer-/counsel-reviewed packs on top of this baseline.',
    authority: 'demo_only',
  },
];

/** Legal-review-trigger and regulated-action-pattern side effect types this pack treats as legally sensitive. */
const LEGALLY_SENSITIVE_SIDE_EFFECT_TYPES = ['legal', 'contractual', 'financial'];

/** Baseline demo/global regulated-action-pattern labels this pack recognizes as warranting compliance review -- it never asserts that any regulation definitively applies or has been satisfied. */
const REGULATED_ACTION_PATTERNS = [
  'payment_services_pattern',
  'healthcare_data_pattern',
  'employment_decision_pattern',
  'financial_advice_pattern',
  'consumer_credit_pattern',
  'insurance_pattern',
  'gambling_or_prize_pattern',
  'minor_data_pattern',
  'biometric_data_pattern',
  'cross_border_transfer_pattern',
];

const RULES: readonly PolicyPackRule[] = [
  // --- Prohibited-action baseline patterns (operational safety, not legal conclusions) ---
  {
    id: 'global-legal-baseline-rule-prohibited-action-pattern',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Prohibited action pattern is denied',
    description:
      'An action tagged with a baseline prohibited-action pattern (e.g. execute_without_authority, execute_without_audit_trail, settle_payment_with_unknown_beneficiary, bind_unknown_principal, override_active_dispute, use_expired_policy_pack, use_demo_policy_as_customer_approved, use_modified_contract_template_under_old_attestation, represent_demo_pack_as_legal_compliance) is denied outright. This is an operational safety hard-stop, not a legal conclusion.',
    status: 'active',
    priority: 5,
    condition: predicate('metadata', 'exists', undefined, 'prohibitedActionPattern'),
    effect: {
      type: 'deny',
      reasonCode: 'PROHIBITED_ACTION_PATTERN_DETECTED',
      reason: 'This action matches a baseline prohibited-action pattern and is denied under the global-legal-baseline policy. This is an operational safety rule, not a legal conclusion.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-active-dispute-blocks-execution',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Active dispute blocks execution',
    description: 'A legal/contractual/financial side effect is denied while an active dispute is recorded against it.',
    status: 'active',
    priority: 10,
    condition: all(predicate('metadata', 'equals', true, 'activeDispute'), predicate('sideEffectType', 'in', LEGALLY_SENSITIVE_SIDE_EFFECT_TYPES)),
    effect: {
      type: 'deny',
      reasonCode: 'ACTIVE_DISPUTE_BLOCKS_EXECUTION',
      reason: 'An active dispute is recorded against this action; execution is blocked under the global-legal-baseline policy until the dispute is resolved.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-dispute-resolution-record',
        type: 'event_record',
        description: 'A dispute resolution record evidencing the current status of the active dispute must be attached before this action can be reconsidered.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-active-dispute-blocks-execution',
      },
    ],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-settlement-unknown-beneficiary',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Settlement with unknown beneficiary is denied',
    description: 'A financial side effect is denied when no counterpartyId is known.',
    status: 'active',
    priority: 15,
    condition: all(predicate('sideEffectType', 'equals', 'financial'), predicate('counterpartyId', 'not_exists')),
    effect: {
      type: 'deny',
      reasonCode: 'SETTLEMENT_WITH_UNKNOWN_BENEFICIARY_PROHIBITED',
      reason: 'Settling a payment with an unknown beneficiary is a baseline prohibited pattern under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Authority boundary flags ---
  {
    id: 'global-legal-baseline-rule-authority-missing-proof-binds-principal',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Binding a principal without authority proof is denied',
    description: 'An action that binds a principal (principalActorId present) is denied when no valid authority proof is attached.',
    status: 'active',
    priority: 20,
    condition: all(predicate('principalActorId', 'exists'), predicate('hasAuthorityProof', 'not_equals', true)),
    effect: {
      type: 'deny',
      reasonCode: 'AUTHORITY_BOUNDARY_MISSING_PROOF_FOR_PRINCIPAL_BINDING',
      reason: 'This action would bind a principal without a valid authority proof on file -- denied under the global-legal-baseline authority-boundary check. This is a boundary check, not a legal conclusion about the agent\'s authorization under any law.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-authority-scope-mismatch',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Authority scope mismatch requires operator review',
    description: 'A flagged authority scope mismatch requires operator review before the action proceeds.',
    status: 'active',
    priority: 25,
    condition: predicate('metadata', 'equals', true, 'authorityScopeMismatch'),
    effect: {
      type: 'require_approval',
      reasonCode: 'AUTHORITY_SCOPE_MISMATCH_REQUIRES_APPROVAL',
      reason: 'This action appears to exceed the actor\'s delegated authority scope and requires operator review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-authority-scope-mismatch',
        type: 'operator_review',
        description: 'An operator must review this possible authority scope mismatch before the action proceeds.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-authority-scope-mismatch',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-principal-not-identified',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Unidentified principal on a legally sensitive action requires authority proof',
    description: 'A legal/contractual/financial side effect with no identified principal requires authority proof before proceeding.',
    status: 'active',
    priority: 30,
    condition: all(predicate('sideEffectType', 'in', LEGALLY_SENSITIVE_SIDE_EFFECT_TYPES), predicate('principalActorId', 'not_exists')),
    effect: {
      type: 'require_authority',
      reasonCode: 'PRINCIPAL_NOT_IDENTIFIED_REQUIRES_HOLD',
      reason: 'No principal is identified for this legally sensitive action; it is held pending authority/identity verification under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-authority-proof-evidence',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Legally sensitive actions require authority-proof evidence',
    description: 'A legal/contractual/financial side effect requires authority-proof evidence to be attached.',
    status: 'active',
    priority: 40,
    condition: all(predicate('sideEffectType', 'in', LEGALLY_SENSITIVE_SIDE_EFFECT_TYPES), predicate('hasAuthorityProof', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'AUTHORITY_PROOF_REQUIRED_AS_EVIDENCE',
      reason: 'A valid authority proof evidencing the actor\'s delegated authority for this action must be attached under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-authority-proof',
        type: 'authority_proof',
        description: 'A valid authority proof evidencing the actor\'s delegated authority for this action must be attached.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-authority-proof-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Contract-related evidence and re-review ---
  {
    id: 'global-legal-baseline-rule-contract-acceptance-evidence',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Contractual actions require acceptance evidence',
    description: 'A contractual side effect requires contract acceptance evidence to be attached.',
    status: 'active',
    priority: 50,
    condition: all(predicate('sideEffectType', 'equals', 'contractual'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'CONTRACT_ACTION_REQUIRES_ACCEPTANCE_EVIDENCE',
      reason: 'Contract acceptance evidence must be attached before this contractual action can proceed under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-contract-acceptance',
        type: 'contract',
        description: 'Contract acceptance evidence (the executed/accepted contract record) must be attached.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-contract-acceptance-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-modified-contract-template-re-review',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Modified contract template requires re-review',
    description: 'A contract template modified after a prior attestation requires a fresh legal review; the old attestation cannot be reused.',
    status: 'active',
    priority: 90,
    condition: predicate('metadata', 'equals', true, 'contractTemplateModifiedAfterAttestation'),
    effect: {
      type: 'require_approval',
      reasonCode: 'MODIFIED_CONTRACT_TEMPLATE_REQUIRES_RE_REVIEW',
      reason: 'This contract template was modified after its prior attestation; a fresh legal review is required under the global-legal-baseline policy.',
    },
    obligations: [
      {
        id: 'global-legal-baseline-obligation-old-attestation-void',
        type: 'require_review',
        description: 'The prior attestation for this contract template is void after modification and cannot be reused as approval for the modified version.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-modified-template-legal-review',
        type: 'legal_review',
        description: 'A legal reviewer must approve the modified contract template before it is used again.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-modified-contract-template-re-review',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Customer/counsel validation metadata (critical merge gate: demo/customer-provided policy can never satisfy a counsel-reviewed requirement) ---
  {
    id: 'global-legal-baseline-rule-demo-baseline-cannot-satisfy-counsel-review',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Demo-baseline policy source cannot satisfy a counsel-reviewed requirement',
    description: 'When an action requires counsel review, a policy source whose validationStatus is demo_baseline can never satisfy that requirement -- it always requires legal review instead of passing.',
    status: 'active',
    priority: 95,
    condition: all(predicate('metadata', 'equals', 'demo_baseline', 'validationStatus'), predicate('metadata', 'equals', true, 'requiresCounselReview')),
    effect: {
      type: 'require_approval',
      reasonCode: 'DEMO_BASELINE_CANNOT_SATISFY_COUNSEL_REVIEWED_REQUIREMENT',
      reason: 'This action requires counsel review, but its policy source is only demo_baseline; a demo/global baseline can never be treated as counsel-reviewed under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-demo-baseline-legal-review',
        type: 'legal_review',
        description: 'A legal/counsel reviewer must approve this action; the demo-baseline policy source cannot substitute for counsel review.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-demo-baseline-cannot-satisfy-counsel-review',
      },
    ],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-customer-provided-cannot-auto-satisfy-counsel-review',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Customer-provided policy source does not automatically satisfy a counsel-reviewed requirement',
    description: 'When an action requires counsel review, a policy source whose validationStatus is customer_provided does not automatically satisfy that requirement -- customer-provided status is preserved, counsel-reviewed status is not implied.',
    status: 'active',
    priority: 96,
    condition: all(predicate('metadata', 'equals', 'customer_provided', 'validationStatus'), predicate('metadata', 'equals', true, 'requiresCounselReview')),
    effect: {
      type: 'require_approval',
      reasonCode: 'CUSTOMER_PROVIDED_POLICY_CANNOT_AUTO_SATISFY_COUNSEL_REVIEWED_REQUIREMENT',
      reason: 'This action requires counsel review; its policy source is customer_provided, which is preserved as-is and does not automatically count as counsel_reviewed under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-customer-provided-legal-review',
        type: 'legal_review',
        description: 'A legal/counsel reviewer must approve this action; customer-provided policy status does not substitute for counsel review.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-customer-provided-cannot-auto-satisfy-counsel-review',
      },
    ],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-counsel-reviewed-claim-requires-attestation-evidence',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'A counsel-reviewed claim requires attestation evidence',
    description: 'A policy source claiming validationStatus counsel_reviewed must have counsel-attestation evidence attached -- the claim alone is not self-proving.',
    status: 'active',
    priority: 97,
    condition: all(predicate('metadata', 'equals', 'counsel_reviewed', 'validationStatus'), predicate('hasRequiredEvidence', 'not_equals', true)),
    effect: {
      type: 'require_evidence',
      reasonCode: 'COUNSEL_REVIEWED_CLAIM_REQUIRES_ATTESTATION_EVIDENCE',
      reason: 'A policy source cannot be treated as counsel_reviewed without attached counsel-attestation evidence under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-counsel-attestation',
        type: 'external_reference',
        description: 'A counsel attestation source document (customer/counsel-provided, not generated by this baseline pack) confirming legal review must be attached.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-counsel-reviewed-claim-requires-attestation-evidence',
      },
    ],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-counsel-review-missing-for-regulated-action',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Counsel review missing for a detected regulated action',
    description: 'A detected regulated action with no completed counsel review requires legal review; a detected pattern is never itself treated as approved or compliant.',
    status: 'active',
    priority: 100,
    condition: all(predicate('metadata', 'equals', true, 'regulatedActionDetected'), predicate('metadata', 'not_equals', 'completed', 'counselReviewStatus')),
    effect: {
      type: 'require_approval',
      reasonCode: 'COUNSEL_REVIEW_MISSING_FOR_REGULATED_ACTION',
      reason: 'A regulated-action pattern was detected and counsel review has not been completed; this action requires legal review under the global-legal-baseline policy. Detection alone is never approval or compliance.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-regulated-action-legal-review',
        type: 'legal_review',
        description: 'A legal reviewer must complete counsel review of this detected regulated action.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-counsel-review-missing-for-regulated-action',
      },
    ],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Legal-review triggers ---
  {
    id: 'global-legal-baseline-rule-high-value-contract',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'High-value contract requires legal review',
    description: 'A flagged high-value contract requires legal review before proceeding.',
    status: 'active',
    priority: 110,
    condition: predicate('metadata', 'equals', true, 'highValueContract'),
    effect: {
      type: 'require_approval',
      reasonCode: 'HIGH_VALUE_CONTRACT_REQUIRES_LEGAL_REVIEW',
      reason: 'This is flagged as a high-value contract and requires legal review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-high-value-contract',
        type: 'legal_review',
        description: 'A legal reviewer must approve this high-value contract.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-high-value-contract',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-cross-border-payment',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Cross-border payment requires compliance review',
    description: 'A flagged cross-border payment requires compliance review and a jurisdiction-basis source reference.',
    status: 'active',
    priority: 115,
    condition: predicate('metadata', 'equals', true, 'crossBorderPayment'),
    effect: {
      type: 'require_approval',
      reasonCode: 'CROSS_BORDER_PAYMENT_REQUIRES_COMPLIANCE_REVIEW',
      reason: 'This is flagged as a cross-border payment and requires compliance review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-jurisdiction-basis-cross-border',
        type: 'external_reference',
        description: 'A jurisdiction-basis source reference documenting why the cross-border transfer is treated as it is must be attached.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-cross-border-payment',
      },
    ],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-cross-border-payment',
        type: 'compliance_review',
        description: 'A compliance reviewer must approve this cross-border payment.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-cross-border-payment',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-minor-involved',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Minor involvement requires legal review',
    description: 'A flagged minor-involved action requires legal review before proceeding.',
    status: 'active',
    priority: 105,
    condition: predicate('metadata', 'equals', true, 'minorInvolved'),
    effect: {
      type: 'require_approval',
      reasonCode: 'MINOR_INVOLVED_REQUIRES_LEGAL_REVIEW',
      reason: 'A minor is flagged as involved in this action; it requires legal review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-minor-involved',
        type: 'legal_review',
        description: 'A legal reviewer must approve this action given the flagged minor involvement.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-minor-involved',
      },
    ],
    severity: 'critical',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-consumer-refund-rights-unclear',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Unclear consumer refund rights require compliance review',
    description: 'A flagged unclear-consumer-refund-rights action requires compliance review and a refund-policy source document.',
    status: 'active',
    priority: 120,
    condition: predicate('metadata', 'equals', true, 'consumerRefundRightsUnclear'),
    effect: {
      type: 'require_approval',
      reasonCode: 'CONSUMER_REFUND_RIGHTS_UNCLEAR_REQUIRES_REVIEW',
      reason: 'Consumer refund rights are flagged as unclear for this action; it requires compliance review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [
      {
        id: 'global-legal-baseline-evidence-refund-policy-source',
        type: 'customer_policy',
        description: 'A refund policy source document must be attached before proceeding.',
        required: true,
        sourceRuleId: 'global-legal-baseline-rule-consumer-refund-rights-unclear',
      },
    ],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-consumer-refund-rights',
        type: 'compliance_review',
        description: 'A compliance reviewer must approve this action given the unclear consumer refund rights.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-consumer-refund-rights-unclear',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-employment-classification-risk',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Employment classification risk requires legal review',
    description: 'A flagged employment classification risk requires legal review before proceeding.',
    status: 'active',
    priority: 125,
    condition: predicate('metadata', 'equals', true, 'employmentClassificationRisk'),
    effect: {
      type: 'require_approval',
      reasonCode: 'EMPLOYMENT_CLASSIFICATION_RISK_REQUIRES_LEGAL_REVIEW',
      reason: 'This action is flagged with an employment classification risk and requires legal review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-employment-classification-risk',
        type: 'legal_review',
        description: 'A legal reviewer must approve this action given the flagged employment classification risk.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-employment-classification-risk',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-regulated-activity-detected',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Detected regulated activity requires compliance review',
    description: 'A flagged regulated-activity action requires compliance review before proceeding.',
    status: 'active',
    priority: 130,
    condition: predicate('metadata', 'equals', true, 'regulatedActivityDetected'),
    effect: {
      type: 'require_approval',
      reasonCode: 'REGULATED_ACTIVITY_DETECTED_REQUIRES_COMPLIANCE_REVIEW',
      reason: 'This action is flagged as involving regulated activity and requires compliance review under the global-legal-baseline policy.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-regulated-activity',
        type: 'compliance_review',
        description: 'A compliance reviewer must approve this action given the flagged regulated activity.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-regulated-activity-detected',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Regulated-action-pattern warnings (flag the pattern; never interpret whether the regulation applies or is satisfied) ---
  {
    id: 'global-legal-baseline-rule-regulated-action-pattern-detected',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Regulated-action pattern detected requires compliance review',
    description:
      'A recognized regulated-action pattern (payment services, healthcare data, employment decision, financial advice, consumer credit, insurance, gambling/prize, minor data, biometric data, cross-border transfer) requires compliance review. This flags the pattern only -- it never states that any regulation definitively applies or has been satisfied.',
    status: 'active',
    priority: 135,
    condition: predicate('metadata', 'in', REGULATED_ACTION_PATTERNS, 'regulatedActionPattern'),
    effect: {
      type: 'require_approval',
      reasonCode: 'REGULATED_ACTION_PATTERN_DETECTED_REQUIRES_COMPLIANCE_REVIEW',
      reason: 'A regulated-action pattern was detected for this action and requires compliance review under the global-legal-baseline policy. This is a pattern warning, not a determination that any specific regulation applies or has been satisfied.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-regulated-action-pattern',
        type: 'compliance_review',
        description: 'A compliance reviewer must review this detected regulated-action pattern.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-regulated-action-pattern-detected',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },

  // --- Jurisdiction awareness (declares/holds on unknown jurisdiction; never decides whether a jurisdiction is legally satisfied) ---
  {
    id: 'global-legal-baseline-rule-jurisdiction-unknown',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Unknown jurisdiction on a legally sensitive action requires legal review',
    description: 'A legally sensitive action with no declared jurisdiction requires legal review; this pack never decides whether an undeclared jurisdiction would be satisfied.',
    status: 'active',
    priority: 200,
    condition: all(
      any(predicate('sideEffectType', 'in', LEGALLY_SENSITIVE_SIDE_EFFECT_TYPES), predicate('metadata', 'equals', true, 'legalSensitivity')),
      predicate('jurisdiction', 'not_exists'),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'JURISDICTION_UNKNOWN_REQUIRES_LEGAL_REVIEW',
      reason: 'This legally sensitive action has no declared jurisdiction; it is held for legal review under the global-legal-baseline policy. This pack does not decide whether any jurisdiction would be satisfied.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-jurisdiction-unknown',
        type: 'legal_review',
        description: 'A legal reviewer must determine and record the applicable jurisdiction before this action proceeds.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-jurisdiction-unknown',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-jurisdiction-conflict-detected',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Jurisdiction conflict detected requires legal review',
    description: 'A flagged conflict between candidate jurisdictions requires legal review; this pack never resolves the conflict itself.',
    status: 'active',
    priority: 205,
    condition: predicate('metadata', 'equals', true, 'jurisdictionConflictDetected'),
    effect: {
      type: 'require_approval',
      reasonCode: 'JURISDICTION_CONFLICT_DETECTED_REQUIRES_LEGAL_REVIEW',
      reason: 'Multiple candidate jurisdictions were flagged for this action; it requires legal review under the global-legal-baseline policy. This pack does not resolve the conflict itself.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-jurisdiction-conflict',
        type: 'legal_review',
        description: 'A legal reviewer must resolve the flagged jurisdiction conflict before this action proceeds.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-jurisdiction-conflict-detected',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-jurisdiction-pack-missing-high-risk',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'High-risk action with no registered jurisdiction-specific pack requires legal review',
    description:
      'A high/critical-risk action tagged with a jurisdiction, but with no jurisdiction-specific pack registered for it (this pack\'s extension point), requires legal review rather than silently passing.',
    status: 'active',
    priority: 210,
    condition: all(
      predicate('riskLevel', 'in', ['high', 'critical']),
      predicate('jurisdiction', 'exists'),
      predicate('metadata', 'not_equals', true, 'jurisdictionPackRegistered'),
    ),
    effect: {
      type: 'require_approval',
      reasonCode: 'JURISDICTION_PACK_MISSING_FOR_HIGH_RISK_ACTION',
      reason: 'This high-risk action is tagged with a jurisdiction, but no jurisdiction-specific policy pack is registered for it; it requires legal review under the global-legal-baseline policy rather than proceeding unreviewed.',
    },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [
      {
        id: 'global-legal-baseline-approval-jurisdiction-pack-missing',
        type: 'legal_review',
        description: 'A legal reviewer must review this high-risk action given the absence of a registered jurisdiction-specific policy pack.',
        required: true,
        minimumApprovals: 1,
        requiresSegregationOfDuties: false,
        sourceRuleId: 'global-legal-baseline-rule-jurisdiction-pack-missing-high-risk',
      },
    ],
    severity: 'error',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
  {
    id: 'global-legal-baseline-rule-jurisdiction-tagged-source-reference',
    policyPackVersionId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
    name: 'Jurisdiction-tagged actions require a source reference',
    description: 'Any action tagged with a jurisdiction must attach a source/reference note explaining why that jurisdiction applies -- a low-precedence warning, never a compliance claim.',
    status: 'active',
    priority: 400,
    condition: predicate('jurisdiction', 'exists'),
    effect: {
      type: 'warn',
      reasonCode: 'JURISDICTION_TAGGED_ACTION_REQUIRES_SOURCE_REFERENCE',
      reason: 'Jurisdiction-tagged actions require an attached source reference under the global-legal-baseline policy. This is a baseline awareness prompt, not a jurisdictional compliance determination.',
    },
    obligations: [
      {
        id: 'global-legal-baseline-obligation-attach-source-reference',
        type: 'attach_source_reference',
        description: 'Attach a source/reference note documenting why this jurisdiction applies.',
        required: true,
      },
    ],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'warning',
    sourceIds: ['global-legal-baseline-source-assumption'],
  },
];

export const GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1: RegisterPolicyPackVersionParams = {
  id: GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
  policyPackId: GLOBAL_LEGAL_BASELINE_POLICY_PACK_ID,
  version: '1.0.0',
  scope: {},
  rules: RULES,
  sources: SOURCES,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  demoOnly: true,
  legalCompleteness: 'partial_policy_model',
  metadata: {
    legalAdvice: false,
    complianceCertification: false,
    jurisdictionSpecific: false,
    completenessClaimed: false,
    policyModelStatus: 'partial_policy_model',
    validationStatus: 'demo_baseline',
    requiredDisclaimer: 'not_legal_advice',
    safeFramingLabels: [
      'not_legal_advice',
      'partial_policy_model',
      'baseline_legal_awareness',
      'requires_customer_validation',
      'requires_counsel_review_when_applicable',
      'not_jurisdiction_specific',
      'not_compliance_certification',
    ],
    // Extension hooks for future jurisdiction-/domain-/use-case-specific packs layered on top of
    // this baseline (e.g. aoc.jurisdiction.costa_rica.base.v1, aoc.jurisdiction.panama.base.v1,
    // aoc.jurisdiction.usa_delaware.base.v1). This pack never populates these with a real claim
    // of jurisdictional compliance -- they are empty extension points, not implementations.
    requiredJurisdictionPackIds: [] as readonly string[],
    jurisdictionPackStatus: 'not_registered',
    jurisdictionSpecificPolicyRefs: [] as readonly string[],
    counselReviewedPolicyRefs: [] as readonly string[],
  },
};

export function registerGlobalLegalBaselinePolicyPack(runtime: PolicyPackRuntime, writer: PolicyPackWriterContext): PolicyPackVersion {
  runtime.registerPolicyPack(writer, GLOBAL_LEGAL_BASELINE_POLICY_PACK);
  runtime.registerPolicyPackVersion(writer, GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1);
  return runtime.activatePolicyPackVersion(writer, GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.id);
}
