import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoPolicyPackRuntime, buildPolicyEvaluationInput } from '../../fixtures/domain-policy-pack-demo.fixture.js';

describe('payments-basic policy pack', () => {
  it('1. approve_payment requires finance_review approval', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'payments-basic-test-1',
        action: 'approve_payment',
        domain: 'payments',
        hasApprovalProof: false,
        hasAuthorityProof: true,
        hasRequiredEvidence: true,
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.ok(result.decision.matchedRuleIds.includes('payments-basic-rule-approve-payment-finance-review'));
    assert.ok(result.decision.approvalRequirements.some((requirement) => requirement.type === 'finance_review'));
  });

  it('2. change_bank_account is denied by default', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'payments-basic-test-2',
        action: 'change_bank_account',
        domain: 'payments',
      }),
    );

    assert.equal(result.decision.type, 'denied');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('payments-basic-rule-change-bank-account-denied'));
    assert.ok(result.decision.obligations.some((obligation) => obligation.type === 'notify_operator'));
  });

  it('3. high-value financial side effect requires dual approval', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'payments-basic-test-3',
        action: 'transfer_funds',
        domain: 'payments',
        sideEffectType: 'financial',
        amount: '25000',
        hasApprovalProof: false,
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.ok(result.decision.matchedRuleIds.includes('payments-basic-rule-high-value-dual-approval'));
    const dualApproval = result.decision.approvalRequirements.find((requirement) => requirement.type === 'dual_approval');
    assert.ok(dualApproval);
    assert.equal(dualApproval!.minimumApprovals, 2);
  });

  it('4. missing invoice evidence requires evidence', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'payments-basic-test-4',
        action: 'approve_payment',
        domain: 'payments',
        hasApprovalProof: true,
        hasAuthorityProof: true,
        hasRequiredEvidence: false,
      }),
    );

    assert.equal(result.decision.type, 'requires_evidence');
    assert.ok(result.decision.matchedRuleIds.includes('payments-basic-rule-invoice-evidence'));
    assert.ok(result.decision.evidenceRequirements.some((requirement) => requirement.type === 'invoice'));
  });

  it('5. missing authority proof requires authority', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'payments-basic-test-5',
        action: 'approve_payment',
        domain: 'payments',
        hasApprovalProof: true,
        hasAuthorityProof: false,
        hasRequiredEvidence: true,
      }),
    );

    assert.equal(result.decision.type, 'requires_authority');
    assert.ok(result.decision.matchedRuleIds.includes('payments-basic-rule-authority-proof-required'));
  });
});
