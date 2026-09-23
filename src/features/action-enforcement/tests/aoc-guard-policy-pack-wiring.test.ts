import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EnforcementRecognitionIntegration, RecognitionVerificationResult } from '../domain/enforcement-context.js';
import type { EnforcementPolicyPackEvaluationInput, EnforcementPolicyPackEvaluationResult, EnforcementPolicyPackIntegration } from '../domain/policy-pack-enforcement.js';
import { createActionEnforcementRuntime } from '../runtime/action-enforcement-runtime.js';
import { createEnforcementRuntimeContext } from '../runtime/enforcement-runtime-context.js';
import { createAocGuard, type GuardActionRequestInput } from '../sdk/aoc-guard.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ALLOW_RECOGNITION: RecognitionVerificationResult = { type: 'allow', reasonCode: 'OK', reason: 'ok' };

function fakeRecognition(): EnforcementRecognitionIntegration {
  return { verifyAction: () => ALLOW_RECOGNITION };
}

function buildGuard(policyPackIntegration?: EnforcementPolicyPackIntegration) {
  const ctx = createEnforcementRuntimeContext(NOW);
  const runtime = createActionEnforcementRuntime(ctx, fakeRecognition(), {
    ...(policyPackIntegration !== undefined ? { policyPackIntegration } : {}),
  });
  return createAocGuard(runtime);
}

/**
 * `sideEffectType: 'write'` deliberately avoids the core `side_effect_boundary`
 * policy's approval-proof requirement (which applies to financial/legal/
 * data_export side effects) -- this suite is about the `domain_policy_pack`
 * policy specifically, so allow-path scenarios must not trip an unrelated
 * core policy later in the chain.
 */
function guardInput(overrides: Partial<GuardActionRequestInput> = {}): GuardActionRequestInput {
  return {
    actorId: 'actor-1',
    trustDomainId: 'trust-domain-1',
    action: 'approve_payment',
    resourceScope: 'project:1',
    riskLevel: 'medium',
    sideEffectType: 'write',
    ...overrides,
  };
}

describe('AocGuard <-> Domain Policy Pack Runtime wiring', () => {
  it('1-2. AocGuard accepts and passes policyEvaluationInput through to the EnforcementRequest', () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const guard = buildGuard({
      evaluatePolicyForEnforcement(input) {
        captured = input;
        return { type: 'policy_allowed', allowed: true, reasonCode: 'OK', reason: 'ok' };
      },
    });
    guard.preflight(guardInput({ policyEvaluationInput: { domain: 'payments', amount: '5000', currency: 'USD' } }));
    assert.equal(captured?.domain, 'payments');
    assert.equal(captured?.amount, '5000');
    assert.equal(captured?.currency, 'USD');
  });

  it('3. AocGuard blocks on policy_denied', () => {
    const guard = buildGuard({ evaluatePolicyForEnforcement: () => ({ type: 'policy_denied', allowed: false, reasonCode: 'DENY', reason: 'deny' }) });
    const decision = guard.preflight(guardInput());
    assert.equal(decision.allowedToExecute, false);
    assert.equal(decision.type, 'execution_blocked');
  });

  it('4. AocGuard blocks on policy_requires_approval', () => {
    const guard = buildGuard({
      evaluatePolicyForEnforcement: () => ({ type: 'policy_requires_approval', allowed: false, reasonCode: 'APPROVAL', reason: 'approval' }),
    });
    const decision = guard.preflight(guardInput());
    assert.equal(decision.allowedToExecute, false);
    assert.equal(decision.type, 'approval_required');
  });

  it('5. AocGuard blocks on policy_requires_evidence', () => {
    const guard = buildGuard({
      evaluatePolicyForEnforcement: () => ({ type: 'policy_requires_evidence', allowed: false, reasonCode: 'EVIDENCE', reason: 'evidence' }),
    });
    const decision = guard.preflight(guardInput());
    assert.equal(decision.allowedToExecute, false);
    assert.equal(decision.type, 'evidence_required');
  });

  it('6. AocGuard executes on policy_warning', async () => {
    const guard = buildGuard({ evaluatePolicyForEnforcement: () => ({ type: 'policy_warning', allowed: true, reasonCode: 'WARN', reason: 'warn' }) });
    let ran = 0;
    const outcome = await guard.enforce(guardInput(), () => (ran += 1, 'done'));
    assert.equal(ran, 1);
    assert.equal(outcome.decision.allowedToExecute, true);
  });

  it('7. AocGuard outcome includes policy metadata', () => {
    const guard = buildGuard({
      evaluatePolicyForEnforcement: () => ({
        type: 'policy_denied',
        allowed: false,
        reasonCode: 'DENY',
        reason: 'deny',
        policyDecisionId: 'policy-decision-1',
        policyProofId: 'policy-proof-1',
      }),
    });
    const decision = guard.preflight(guardInput());
    assert.equal(decision.policyDecisionId, 'policy-decision-1');
    assert.equal(decision.policyProofId, 'policy-proof-1');
  });

  it('8. AocGuard behavior is unchanged without a policy pack integration', () => {
    const guard = buildGuard(undefined);
    const decision = guard.preflight(guardInput());
    assert.equal(decision.type, 'execute_allowed');
    assert.equal(decision.policyDecisionId, undefined);
    assert.equal(decision.policyProofId, undefined);
    assert.equal(decision.policyPackVersionIds, undefined);
    assert.equal(decision.policyMatchedRuleIds, undefined);
  });
});
