import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EnforcementRequest } from '../domain/enforcement-request.js';
import type { EnforcementPolicyPackEvaluationInput, EnforcementPolicyPackEvaluationResult, EnforcementPolicyPackIntegration } from '../domain/policy-pack-enforcement.js';
import {
  PolicyPackEnforcementService,
  mapPolicyResultToEnforcementDecisionType,
  shouldBlockForPolicy,
} from '../services/policy-pack-enforcement-service.js';
import { createEnforcementRuntimeContext } from '../runtime/enforcement-runtime-context.js';

const NOW = '2026-01-01T00:00:00.000Z';

function buildRequest(overrides: Partial<EnforcementRequest> = {}): EnforcementRequest {
  return {
    id: 'enforcement-request-1',
    mode: 'execute',
    status: 'submitted',
    trustDomainId: 'trust-domain-1',
    actorId: 'actor-1',
    action: 'approve_payment',
    resourceScope: 'project:1',
    target: { id: 'target-1', type: 'tool_call', name: 'approve_payment' },
    intent: { id: 'intent-1', action: 'approve_payment', resourceScope: 'project:1', riskLevel: 'critical', sideEffectType: 'financial' },
    sideEffects: [],
    submittedAt: NOW,
    ...overrides,
  };
}

function stubIntegration(result: EnforcementPolicyPackEvaluationResult, capture?: (input: EnforcementPolicyPackEvaluationInput) => void): EnforcementPolicyPackIntegration {
  return {
    evaluatePolicyForEnforcement(input) {
      capture?.(input);
      return result;
    },
  };
}

function allowedResult(overrides: Partial<EnforcementPolicyPackEvaluationResult> = {}): EnforcementPolicyPackEvaluationResult {
  return { type: 'policy_allowed', allowed: true, reasonCode: 'OK', reason: 'ok', ...overrides };
}

describe('PolicyPackEnforcementService', () => {
  it('1. returns policy_not_applicable when no integration configured', () => {
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW));
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(result.type, 'policy_not_applicable');
    assert.equal(result.allowed, true);
    assert.equal(result.reasonCode, 'POLICY_PACK_NOT_CONFIGURED');
  });

  it('2. builds input from EnforcementRequest actor/action/scope', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(buildRequest({ actorId: 'actor-9', action: 'sign_contract', resourceScope: 'project:9' }), NOW);
    assert.equal(captured?.actorId, 'actor-9');
    assert.equal(captured?.action, 'sign_contract');
    assert.equal(captured?.resourceScope, 'project:9');
  });

  it('3. includes sideEffectType from ExecutionIntent', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(captured?.sideEffectType, 'financial');
  });

  it('4. includes riskLevel from ExecutionIntent', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(captured?.riskLevel, 'critical');
  });

  it('5. includes domain/jurisdiction/country/industry/customerId when provided', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(
      buildRequest({ policyEvaluationInput: { domain: 'payments', jurisdiction: 'jur-1', country: 'CR', industry: 'fintech', customerId: 'customer-1' } }),
      NOW,
    );
    assert.equal(captured?.domain, 'payments');
    assert.equal(captured?.jurisdiction, 'jur-1');
    assert.equal(captured?.country, 'CR');
    assert.equal(captured?.industry, 'fintech');
    assert.equal(captured?.customerId, 'customer-1');
  });

  it('6. includes amount/currency/counterpartyId/dataDomains when provided', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(
      buildRequest({ policyEvaluationInput: { amount: '5000', currency: 'USD', counterpartyId: 'vendor-1', dataDomains: ['pii'] } }),
      NOW,
    );
    assert.equal(captured?.amount, '5000');
    assert.equal(captured?.currency, 'USD');
    assert.equal(captured?.counterpartyId, 'vendor-1');
    assert.deepEqual(captured?.dataDomains, ['pii']);
  });

  it('7. includes authorityProofId/approvalProofId/handshakeProofId when provided by recognition', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(buildRequest(), NOW, {
      type: 'allow',
      reasonCode: 'OK',
      reason: 'ok',
      authorityProofId: 'authority-proof-1',
      approvalProofId: 'approval-proof-1',
      handshakeProofId: 'handshake-proof-1',
    });
    assert.equal(captured?.authorityProofId, 'authority-proof-1');
    assert.equal(captured?.approvalProofId, 'approval-proof-1');
    assert.equal(captured?.handshakeProofId, 'handshake-proof-1');
  });

  it('8. includes evidenceIds when provided', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult(), (input) => (captured = input)));
    service.evaluatePolicyPackForRequest(buildRequest({ policyEvaluationInput: { evidenceIds: ['evidence-1', 'evidence-2'] } }), NOW);
    assert.deepEqual(captured?.evidenceIds, ['evidence-1', 'evidence-2']);
  });

  it('9. maps policy_allowed to non-blocking', () => {
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult()));
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(shouldBlockForPolicy(result), false);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), undefined);
  });

  it('10. maps policy_warning to non-blocking warning', () => {
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult({ type: 'policy_warning' })));
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(shouldBlockForPolicy(result), false);
  });

  it('11. maps policy_not_applicable to non-blocking', () => {
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), stubIntegration(allowedResult({ type: 'policy_not_applicable' })));
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(shouldBlockForPolicy(result), false);
  });

  it('12. maps policy_denied to blocking', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration({ type: 'policy_denied', allowed: false, reasonCode: 'DENY', reason: 'denied' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(shouldBlockForPolicy(result), true);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), 'execution_blocked');
  });

  it('13. maps policy_requires_evidence to blocking evidence-required', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration({ type: 'policy_requires_evidence', allowed: false, reasonCode: 'EVIDENCE', reason: 'evidence' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), 'evidence_required');
  });

  it('14. maps policy_requires_approval to blocking approval-required', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration({ type: 'policy_requires_approval', allowed: false, reasonCode: 'APPROVAL', reason: 'approval' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), 'approval_required');
  });

  it('15. maps policy_requires_authority to blocking authority-required', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration({ type: 'policy_requires_authority', allowed: false, reasonCode: 'AUTHORITY', reason: 'authority' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), 'execution_blocked');
  });

  it('16. maps policy_requires_external_standing to blocking external-standing-required', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration({ type: 'policy_requires_external_standing', allowed: false, reasonCode: 'STANDING', reason: 'standing' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(mapPolicyResultToEnforcementDecisionType(result), 'external_handshake_required');
  });

  it('17. defaults to blocking on malformed result', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      // Deliberately malformed: 'allowed: true' contradicts the inherently-blocking 'policy_denied' type.
      stubIntegration({ type: 'policy_denied', allowed: true, reasonCode: 'X', reason: 'x' }),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'POLICY_PACK_INVALID_RESULT');
  });

  it('18. defaults to blocking on integration error', () => {
    const service = new PolicyPackEnforcementService(createEnforcementRuntimeContext(NOW), {
      evaluatePolicyForEnforcement() {
        throw new Error('boom');
      },
    });
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'POLICY_PACK_INTEGRATION_ERROR');
    assert.ok(result.reason.includes('boom'));
  });

  it('19. creates a deterministic PolicyPackEnforcementEvaluation', () => {
    const ctx = createEnforcementRuntimeContext(NOW);
    const service = new PolicyPackEnforcementService(ctx, stubIntegration(allowedResult({ policyDecisionId: 'policy-decision-1' })));
    const request = buildRequest();
    const result = service.evaluatePolicyPackForRequest(request, NOW);
    const evaluationA = service.toPolicyPackEnforcementEvaluation(request, result, NOW);
    const evaluationB = service.toPolicyPackEnforcementEvaluation(request, result, NOW);
    assert.equal(evaluationA.enforcementRequestId, request.id);
    assert.equal(evaluationA.type, 'policy_allowed');
    assert.equal(evaluationA.reasonCode, evaluationB.reasonCode);
    assert.equal(evaluationA.evaluatedAt, NOW);
  });

  it('20. preserves policyDecisionId and policyProofId', () => {
    const service = new PolicyPackEnforcementService(
      createEnforcementRuntimeContext(NOW),
      stubIntegration(allowedResult({ policyDecisionId: 'policy-decision-42', policyProofId: 'policy-proof-42' })),
    );
    const result = service.evaluatePolicyPackForRequest(buildRequest(), NOW);
    assert.equal(result.policyDecisionId, 'policy-decision-42');
    assert.equal(result.policyProofId, 'policy-proof-42');
  });
});
