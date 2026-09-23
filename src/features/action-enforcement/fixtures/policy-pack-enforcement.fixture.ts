import { buildDemoPolicyPackRuntime } from '../../domain-policy-pack-runtime/fixtures/domain-policy-pack-demo.fixture.js';
import { createActionEnforcementPolicyPackIntegration } from '../../domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyPackRuntime } from '../../domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { EnforcementPolicyPackEvaluationInput, EnforcementPolicyPackEvaluationResult, EnforcementPolicyPackIntegration } from '../domain/policy-pack-enforcement.js';
import { createActionEnforcementRuntime, type ActionEnforcementRuntime } from '../runtime/action-enforcement-runtime.js';
import { createEnforcementRuntimeContext } from '../runtime/enforcement-runtime-context.js';
import { AocGuard, createAocGuard } from '../sdk/aoc-guard.js';
import type { GuardActionRequestInput } from '../sdk/aoc-guard.js';
import {
  APPROVE_PAYMENT,
  CHANGE_BANK_ACCOUNT,
  NOW,
  PMFREAK_ACTOR_ID,
  PMFREAK_DRAFTING_TOKEN_ID,
  PMFREAK_INVOICE_TOKEN_ID,
  PMFREAK_PAYMENT_TOKEN_ID,
  PREPARE_INVOICE_SUPPORT,
  PROJECT_SCOPE,
  SIGN_CONTRACT,
  SUMMARIZE_PROJECT_STATUS,
  TRUST_DOMAIN_ID,
  VICTOR_ACTOR_ID,
  VICTOR_FINANCIAL_TOKEN_ID,
  VICTOR_LEGAL_TOKEN_ID,
  bridgeRecognitionRuntime,
  buildDatasysEnforcementFixture,
  type DatasysEnforcementFixture,
} from './datasys-enforcement.fixture.js';

export const EXPORT_CLIENT_DATA = 'export_client_data';
export const SETTLE_EVENT_PAYMENT = 'settle_event_payment';

const VICTOR_DATA_EXPORT_TOKEN_ID = 'cap-victor-data-export';
const PMFREAK_EVENT_SETTLEMENT_TOKEN_ID = 'cap-pmfreak-event-settlement';

/**
 * Adapts a real `PolicyPackRuntime` (through its own
 * `ActionEnforcementPolicyPackIntegration` structural adapter) onto Action
 * Enforcement's local `EnforcementPolicyPackIntegration` shape -- mirrors
 * `bridgeRecognitionRuntime` in ./datasys-enforcement.fixture.ts. The two
 * evaluation-input shapes are structurally identical by design, so this
 * bridge only needs to enrich the result with `policyPackVersionIds`/
 * `matchedRuleIds` (which the Domain Policy Pack Runtime integration keeps
 * on the underlying `PolicyPackDecision`, not on its own result type) by
 * looking the decision back up.
 */
export function bridgePolicyPackIntegration(policyPackRuntime: PolicyPackRuntime): EnforcementPolicyPackIntegration {
  const integration = createActionEnforcementPolicyPackIntegration(policyPackRuntime);
  return {
    evaluatePolicyForEnforcement(input: EnforcementPolicyPackEvaluationInput): EnforcementPolicyPackEvaluationResult {
      const result = integration.evaluatePolicyForEnforcement(input);
      const decision = result.policyDecisionId !== undefined ? policyPackRuntime.getPolicyPackDecision(result.policyDecisionId) : undefined;

      return {
        type: result.type,
        allowed: result.allowed,
        reasonCode: result.reasonCode,
        reason: result.reason,
        ...(result.policyDecisionId !== undefined ? { policyDecisionId: result.policyDecisionId } : {}),
        ...(result.policyProofId !== undefined ? { policyProofId: result.policyProofId } : {}),
        ...(decision !== undefined ? { policyPackVersionIds: decision.applicablePackVersionIds, matchedRuleIds: decision.matchedRuleIds } : {}),
        ...(decision?.limitedActions !== undefined ? { limitedActions: decision.limitedActions } : {}),
        ...(decision?.limitedCapabilities !== undefined ? { limitedCapabilities: decision.limitedCapabilities } : {}),
        ...(decision?.limitedResourceScopes !== undefined ? { limitedResourceScopes: decision.limitedResourceScopes } : {}),
        ...(result.evidenceRequirements !== undefined ? { evidenceRequirements: result.evidenceRequirements } : {}),
        ...(result.approvalRequirements !== undefined ? { approvalRequirements: result.approvalRequirements } : {}),
        ...(result.obligations !== undefined ? { obligations: result.obligations } : {}),
        ...(result.effectiveRiskLevel !== undefined ? { effectiveRiskLevel: result.effectiveRiskLevel } : {}),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      };
    },
  };
}

export interface PolicyPackEnforcementFixture extends DatasysEnforcementFixture {
  readonly policyPackRuntime: PolicyPackRuntime;
  readonly policyPackIntegration: EnforcementPolicyPackIntegration;
  /** A second ActionEnforcementRuntime, sharing the Datasys world's Recognition/Authority/Approval/Handshake runtimes, configured *with* the policy pack integration -- `fixture.enforcementRuntime` (and its `aocGuard`) stays unconfigured so callers can still exercise the "no policy pack integration" baseline from the very same world. */
  readonly policyPackEnforcementRuntime: ActionEnforcementRuntime;
  readonly policyPackAocGuard: AocGuard;
}

/**
 * Composes the Datasys Agent Republic enforcement fixture with all six
 * Domain Policy Pack Runtime demo packs (payments-basic, procurement-basic,
 * data-boundary-basic, sports-event-settlement-basic, financial-approval-
 * basic, jurisdictional-baseline-demo), wired into a *second*
 * ActionEnforcementRuntime via `policyPackIntegration`. Also issues two
 * additional capability tokens (export_client_data, settle_event_payment)
 * and one additional authority grant/delegation so data-boundary and
 * sports-event-settlement scenarios can be exercised end to end without
 * touching Recognition Runtime/Authority Graph internals directly.
 */
export function buildPolicyPackEnforcementFixture(): PolicyPackEnforcementFixture {
  const datasys = buildDatasysEnforcementFixture();
  const { recognitionRuntime, authorityRuntime, world } = datasys;

  recognitionRuntime.issueCapabilityToken({
    id: VICTOR_DATA_EXPORT_TOKEN_ID,
    subjectActorId: world.victor.id,
    principalActorId: world.victor.id,
    issuerActorId: world.datasys.id,
    trustDomainId: world.trustDomainId,
    capability: 'data.export',
    actions: [EXPORT_CLIENT_DATA],
    resourceScopes: [PROJECT_SCOPE],
    riskLevel: 'high',
  });

  const eventSettlementGrant = authorityRuntime.issueAuthorityGrant({
    id: 'authority-grant-victor-event-settlement',
    issuerActorId: world.datasys.id,
    subjectActorId: world.victor.id,
    trustDomainId: world.trustDomainId,
    roleId: 'role-event-settlement-manager',
    capability: 'events.settlement',
    actions: [SETTLE_EVENT_PAYMENT],
    resourceScopes: [PROJECT_SCOPE],
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
  });
  authorityRuntime.createDelegationGrant({
    id: 'delegation-grant-pmfreak-event-settlement',
    delegatorActorId: world.victor.id,
    delegateActorId: world.pmfreak.id,
    delegateActorType: 'agent',
    trustDomainId: world.trustDomainId,
    sourceAuthorityGrantId: eventSettlementGrant.id,
    capability: 'events.settlement',
    actions: [SETTLE_EVENT_PAYMENT],
    resourceScopes: [PROJECT_SCOPE],
    canRedelegate: false,
  });
  recognitionRuntime.issueCapabilityToken({
    id: PMFREAK_EVENT_SETTLEMENT_TOKEN_ID,
    subjectActorId: world.pmfreak.id,
    principalActorId: world.victor.id,
    issuerActorId: world.victor.id,
    trustDomainId: world.trustDomainId,
    capability: 'events.settlement',
    actions: [SETTLE_EVENT_PAYMENT],
    resourceScopes: [PROJECT_SCOPE],
    riskLevel: 'critical',
  });

  const policyPackRuntime = buildDemoPolicyPackRuntime(NOW);
  const policyPackIntegration = bridgePolicyPackIntegration(policyPackRuntime);

  const enforcementCtx = createEnforcementRuntimeContext(NOW);
  const recognitionIntegration = bridgeRecognitionRuntime(recognitionRuntime);
  const policyPackEnforcementRuntime = createActionEnforcementRuntime(enforcementCtx, recognitionIntegration, { policyPackIntegration });
  const policyPackAocGuard = createAocGuard(policyPackEnforcementRuntime);

  return { ...datasys, policyPackRuntime, policyPackIntegration, policyPackEnforcementRuntime, policyPackAocGuard };
}

/** payments-basic: approve_payment with authority proof (via delegation) and evidence present, but no approval proof -- requires finance review. */
export function buildApprovePaymentRequiresFinanceReviewInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: PMFREAK_ACTOR_ID,
    principalActorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: APPROVE_PAYMENT,
    resourceScope: PROJECT_SCOPE,
    capability: 'payments.approval',
    sideEffectType: 'financial',
    riskLevel: 'critical',
    metadata: { passportId: 'passport-pmfreak', capabilityTokenId: PMFREAK_PAYMENT_TOKEN_ID },
    policyEvaluationInput: { domain: 'payments', evidenceIds: ['invoice-1'] },
    ...overrides,
  };
}

/** payments-basic: change_bank_account is denied by default regardless of proofs. */
export function buildChangeBankAccountDeniedInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: CHANGE_BANK_ACCOUNT,
    resourceScope: PROJECT_SCOPE,
    capability: 'finance.bank_details',
    sideEffectType: 'financial',
    riskLevel: 'critical',
    metadata: { passportId: 'passport-victor', capabilityTokenId: VICTOR_FINANCIAL_TOKEN_ID },
    policyEvaluationInput: { domain: 'payments' },
    ...overrides,
  };
}

/**
 * procurement-basic: prepare_invoice_support with a known vendor
 * counterparty and Recognition Runtime's own `invoice_backup` evidence
 * requirement satisfied (so recognition itself allows), but no
 * `purchase_order` evidence declared for the policy pack -- the
 * procurement-basic pack's own evidence rule is what blocks here, not
 * Recognition Runtime's evidence-required policy.
 */
export function buildPrepareInvoiceSupportRequiresEvidenceInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: PMFREAK_ACTOR_ID,
    principalActorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: PREPARE_INVOICE_SUPPORT,
    resourceScope: PROJECT_SCOPE,
    capability: 'project_closure.invoice_support',
    sideEffectType: 'write',
    riskLevel: 'medium',
    metadata: {
      passportId: 'passport-pmfreak',
      capabilityTokenId: PMFREAK_INVOICE_TOKEN_ID,
      evidence: [{ type: 'invoice_backup', reference: 'invoice:INV-1001' }],
    },
    policyEvaluationInput: { domain: 'procurement', counterpartyId: 'vendor-datasys-supplies' },
    ...overrides,
  };
}

/** data-boundary-basic: export_client_data touching a sensitive (but not prohibited) data domain -- requires compliance review. */
export function buildExportClientDataRequiresComplianceReviewInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: EXPORT_CLIENT_DATA,
    resourceScope: PROJECT_SCOPE,
    capability: 'data.export',
    sideEffectType: 'data_export',
    riskLevel: 'high',
    metadata: { passportId: 'passport-victor', capabilityTokenId: VICTOR_DATA_EXPORT_TOKEN_ID },
    policyEvaluationInput: { domain: 'data_boundary', dataDomains: ['pii'] },
    ...overrides,
  };
}

/** data-boundary-basic: export_client_data touching a prohibited data domain -- denied outright. */
export function buildExportClientDataProhibitedInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return buildExportClientDataRequiresComplianceReviewInput({
    policyEvaluationInput: { domain: 'data_boundary', dataDomains: ['classified'] },
    ...overrides,
  });
}

/** sports-event-settlement-basic: settle_event_payment with authority proof (via delegation) and a known counterparty, below the approval threshold, but no event_record evidence -- requires evidence. */
export function buildSettleEventPaymentRequiresEvidenceInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: PMFREAK_ACTOR_ID,
    principalActorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: SETTLE_EVENT_PAYMENT,
    resourceScope: PROJECT_SCOPE,
    capability: 'events.settlement',
    sideEffectType: 'financial',
    riskLevel: 'critical',
    metadata: { passportId: 'passport-pmfreak', capabilityTokenId: PMFREAK_EVENT_SETTLEMENT_TOKEN_ID },
    policyEvaluationInput: { domain: 'sports_event_settlement', counterpartyId: 'event-counterparty-1', amount: '1000', currency: 'USD' },
    ...overrides,
  };
}

/** financial-approval-basic: a critical-risk financial side effect with no approval proof -- requires (dual) approval. Scoped to financial_approval so payments-basic's own bank-account rule never applies. */
export function buildCriticalFinancialActionRequiresDualApprovalInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: CHANGE_BANK_ACCOUNT,
    resourceScope: PROJECT_SCOPE,
    capability: 'finance.bank_details',
    sideEffectType: 'financial',
    riskLevel: 'critical',
    metadata: { passportId: 'passport-victor', capabilityTokenId: VICTOR_FINANCIAL_TOKEN_ID },
    policyEvaluationInput: { domain: 'financial_approval' },
    ...overrides,
  };
}

/** jurisdictional-baseline-demo: sign_contract with neither authority nor approval proof -- requires authority (which wins precedence over the also-matched requires_approval rule). */
export function buildSignContractRequiresAuthorityInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: SIGN_CONTRACT,
    resourceScope: PROJECT_SCOPE,
    capability: 'legal.contracts',
    sideEffectType: 'legal',
    riskLevel: 'critical',
    metadata: { passportId: 'passport-victor', capabilityTokenId: VICTOR_LEGAL_TOKEN_ID },
    policyEvaluationInput: { domain: 'general_enterprise' },
    ...overrides,
  };
}

/** jurisdictional-baseline-demo: an ordinary recognized action tagged with a jurisdiction this placeholder pack does not recognize -- warns (manual verification), never blocks. */
export function buildUnrecognizedJurisdictionWarningInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: PMFREAK_ACTOR_ID,
    principalActorId: VICTOR_ACTOR_ID,
    trustDomainId: TRUST_DOMAIN_ID,
    action: SUMMARIZE_PROJECT_STATUS,
    resourceScope: PROJECT_SCOPE,
    capability: 'project_closure.drafting',
    sideEffectType: 'write',
    riskLevel: 'low',
    metadata: { passportId: 'passport-pmfreak', capabilityTokenId: PMFREAK_DRAFTING_TOKEN_ID },
    policyEvaluationInput: { domain: 'general_enterprise', jurisdiction: 'some-unrecognized-jurisdiction' },
    ...overrides,
  };
}
