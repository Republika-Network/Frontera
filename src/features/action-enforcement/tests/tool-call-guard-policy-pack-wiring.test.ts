import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EnforcementRecognitionIntegration, RecognitionVerificationResult } from '../domain/enforcement-context.js';
import type { EnforcementPolicyPackEvaluationInput, EnforcementPolicyPackEvaluationResult, EnforcementPolicyPackIntegration } from '../domain/policy-pack-enforcement.js';
import { createActionEnforcementRuntime } from '../runtime/action-enforcement-runtime.js';
import { createEnforcementRuntimeContext } from '../runtime/enforcement-runtime-context.js';
import { createAocGuard } from '../sdk/aoc-guard.js';
import { createToolCallGuard } from '../sdk/tool-call-guard.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ALLOW_RECOGNITION: RecognitionVerificationResult = { type: 'allow', reasonCode: 'OK', reason: 'ok' };

function fakeRecognition(): EnforcementRecognitionIntegration {
  return { verifyAction: () => ALLOW_RECOGNITION };
}

/** Deny-when-payments-and-bank-account-change, approve-required-when-payments-approval, warning-otherwise -- a minimal stand-in for a real payments policy pack, isolating ToolCallGuard's own wiring behavior from Domain Policy Pack Runtime's rule engine (covered separately in policy-pack-sample-wiring-scenarios.test.ts). */
function toyPaymentsPolicyPack(capture?: (input: EnforcementPolicyPackEvaluationInput) => void): EnforcementPolicyPackIntegration {
  return {
    evaluatePolicyForEnforcement(input): EnforcementPolicyPackEvaluationResult {
      capture?.(input);
      if (input.action === 'change_bank_account') {
        return { type: 'policy_denied', allowed: false, reasonCode: 'BANK_ACCOUNT_CHANGE_DENIED', reason: 'denied by default' };
      }
      if (input.action === 'approve_payment') {
        return { type: 'policy_requires_approval', allowed: false, reasonCode: 'FINANCE_REVIEW_REQUIRED', reason: 'requires finance review' };
      }
      return { type: 'policy_warning', allowed: true, reasonCode: 'WARNING_ONLY', reason: 'warning only, does not block' };
    },
  };
}

function buildToolCallGuard(policyPackIntegration: EnforcementPolicyPackIntegration) {
  const ctx = createEnforcementRuntimeContext(NOW);
  const runtime = createActionEnforcementRuntime(ctx, fakeRecognition(), { policyPackIntegration });
  return createToolCallGuard(createAocGuard(runtime));
}

describe('ToolCallGuard <-> Domain Policy Pack Runtime wiring', () => {
  it('1. blocks approve_payment when the policy pack requires approval', async () => {
    let ran = 0;
    const toolCallGuard = buildToolCallGuard(toyPaymentsPolicyPack());
    const outcome = await toolCallGuard.execute({
      actorId: 'actor-1',
      trustDomainId: 'trust-domain-1',
      toolName: 'approve_payment_tool',
      action: 'approve_payment',
      resourceScope: 'project:1',
      sideEffectType: 'write',
      execute: () => (ran += 1, 'done'),
    });
    assert.equal(ran, 0);
    assert.equal(outcome.decision.type, 'approval_required');
  });

  it('2. blocks change_bank_account when the policy pack denies', async () => {
    let ran = 0;
    const toolCallGuard = buildToolCallGuard(toyPaymentsPolicyPack());
    const outcome = await toolCallGuard.execute({
      actorId: 'actor-1',
      trustDomainId: 'trust-domain-1',
      toolName: 'change_bank_account_tool',
      action: 'change_bank_account',
      resourceScope: 'project:1',
      sideEffectType: 'write',
      execute: () => (ran += 1, 'done'),
    });
    assert.equal(ran, 0);
    assert.equal(outcome.decision.type, 'execution_blocked');
  });

  it('3. allows a warning-only policy result', async () => {
    let ran = 0;
    const toolCallGuard = buildToolCallGuard(toyPaymentsPolicyPack());
    const outcome = await toolCallGuard.execute({
      actorId: 'actor-1',
      trustDomainId: 'trust-domain-1',
      toolName: 'read_project_summary_tool',
      action: 'read_project_summary',
      resourceScope: 'project:1',
      sideEffectType: 'read',
      execute: () => (ran += 1, 'done'),
    });
    assert.equal(ran, 1);
    assert.equal(outcome.decision.type, 'execute_allowed');
  });

  it('4. passes amount/currency/counterpartyId through policyEvaluationInput', async () => {
    let captured: EnforcementPolicyPackEvaluationInput | undefined;
    const toolCallGuard = buildToolCallGuard(toyPaymentsPolicyPack((input) => (captured = input)));
    await toolCallGuard.execute({
      actorId: 'actor-1',
      trustDomainId: 'trust-domain-1',
      toolName: 'read_project_summary_tool',
      action: 'read_project_summary',
      resourceScope: 'project:1',
      sideEffectType: 'read',
      policyEvaluationInput: { amount: '2500', currency: 'USD', counterpartyId: 'vendor-9' },
      execute: () => 'done',
    });
    assert.equal(captured?.amount, '2500');
    assert.equal(captured?.currency, 'USD');
    assert.equal(captured?.counterpartyId, 'vendor-9');
  });

  it('5. tool executor does not run on policy block', async () => {
    let ran = 0;
    const toolCallGuard = buildToolCallGuard(toyPaymentsPolicyPack());
    await toolCallGuard.execute({
      actorId: 'actor-1',
      trustDomainId: 'trust-domain-1',
      toolName: 'change_bank_account_tool',
      action: 'change_bank_account',
      resourceScope: 'project:1',
      sideEffectType: 'write',
      execute: () => (ran += 1, 'done'),
    });
    assert.equal(ran, 0);
  });
});
