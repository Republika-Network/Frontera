import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoPolicyPackRuntime, buildPolicyEvaluationInput } from '../../fixtures/domain-policy-pack-demo.fixture.js';

describe('sports-event-settlement-basic policy pack', () => {
  it('1. settlement requires event_record evidence', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'sports-settlement-basic-test-1',
        action: 'settle_event_payment',
        domain: 'sports_event_settlement',
        counterpartyId: 'counterparty-1',
        hasAuthorityProof: true,
        hasApprovalProof: true,
        hasRequiredEvidence: false,
        jurisdiction: 'demo-jurisdiction-a',
        amount: '1000',
      }),
    );

    assert.equal(result.decision.type, 'requires_evidence');
    assert.ok(result.decision.matchedRuleIds.includes('sports-settlement-basic-rule-event-record-evidence'));
    assert.ok(result.decision.evidenceRequirements.some((requirement) => requirement.type === 'event_record'));
  });

  it('2. settlement requires authority proof', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'sports-settlement-basic-test-2',
        action: 'settle_event_payment',
        domain: 'sports_event_settlement',
        counterpartyId: 'counterparty-1',
        hasAuthorityProof: false,
        hasApprovalProof: true,
        hasRequiredEvidence: true,
        jurisdiction: 'demo-jurisdiction-a',
        amount: '1000',
      }),
    );

    assert.equal(result.decision.type, 'requires_authority');
    assert.ok(result.decision.matchedRuleIds.includes('sports-settlement-basic-rule-authority-proof-required'));
  });

  it('3. settlement over value threshold requires approval', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'sports-settlement-basic-test-3',
        action: 'settle_event_payment',
        domain: 'sports_event_settlement',
        counterpartyId: 'counterparty-1',
        hasAuthorityProof: true,
        hasApprovalProof: false,
        hasRequiredEvidence: true,
        jurisdiction: 'demo-jurisdiction-a',
        amount: '5000',
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.ok(result.decision.matchedRuleIds.includes('sports-settlement-basic-rule-value-threshold-approval'));
    assert.ok(result.decision.approvalRequirements.some((requirement) => requirement.type === 'finance_review'));
  });

  it('4. unsupported jurisdiction requires manual verification', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'sports-settlement-basic-test-4',
        action: 'settle_event_payment',
        domain: 'sports_event_settlement',
        counterpartyId: 'counterparty-1',
        hasAuthorityProof: true,
        hasApprovalProof: true,
        hasRequiredEvidence: true,
        jurisdiction: 'some-unsupported-jurisdiction',
        amount: '1000',
      }),
    );

    assert.equal(result.decision.type, 'warning');
    assert.ok(result.decision.matchedRuleIds.includes('sports-settlement-basic-rule-unsupported-jurisdiction'));
    assert.ok(result.decision.obligations.some((obligation) => obligation.type === 'manual_verification'));
  });

  it('5. missing counterparty denies settlement', () => {
    const runtime = buildDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildPolicyEvaluationInput({
        id: 'sports-settlement-basic-test-5',
        action: 'settle_event_payment',
        domain: 'sports_event_settlement',
        hasAuthorityProof: true,
        hasApprovalProof: true,
        hasRequiredEvidence: true,
        amount: '1000',
      }),
    );

    assert.equal(result.decision.type, 'denied');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('sports-settlement-basic-rule-counterparty-required'));
  });
});
