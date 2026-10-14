import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition } from '../../domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../../domain-policy-pack-runtime/domain/policy-pack-evaluation.js';
import { createPolicyPackRuntimeContext } from '../../domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { PolicyConditionEvaluator } from '../../domain-policy-pack-runtime/services/policy-condition-evaluator.js';
import { createPolicyPackRuntime } from '../../domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { TRADE_RISK_FACT_CLASSES as F } from '../index.js';

/**
 * TRADE-03 Phase 1 — characterization, not change. Pins the CORE policy
 * semantics the TRADE-03 composition depends on (the TRADE-01 spike pins the
 * decimal ordering ones). If CORE changes, this suite names the TRADE-03
 * assumption that moved. Conclusions: TRADE-03 doc §5.
 *
 * The finding that shapes the design: the **policy layer is not a gate for
 * absence**. A rule comparing against a fact (`valueFrom`) does not match when
 * the fact is missing, and a pack whose rules all miss is `not_applicable`,
 * which is non-blocking. Required trading facts are therefore made
 * **material** in the Governance Profile — the Kernel denies before policy on
 * a missing, stale, conflicting or untrusted one (proven on the shipped Host
 * in `trade03-governed-risk-host.test.ts`) — and policy adds bindings and a
 * defence-in-depth absence rule on top.
 */

const NOW = '2026-10-13T12:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const evaluator = new PolicyConditionEvaluator();

function input(contextFacts: PolicyEvaluationInput['contextFacts'] = [], amount = '100'): PolicyEvaluationInput {
  return {
    id: 'trade03',
    trustDomainId: 'td',
    actorId: 'agent',
    action: 'trade.offer-create',
    resourceScope: 'xrp-ledger-testnet:owner',
    riskLevel: 'low',
    requestedAt: NOW,
    amount,
    currency: 'xrp-ledger-testnet:XRP',
    governedParameters: [{ dimension: 'tradeProposalDigest', type: 'token', value: DIGEST }],
    contextFacts,
  } as PolicyEvaluationInput;
}

const matched = (condition: PolicyCondition, at: PolicyEvaluationInput): boolean => evaluator.evaluate(condition, at).matched;
const digestBinding: PolicyCondition = { type: 'predicate', field: 'parameter', parameterId: 'tradeProposalDigest', operator: 'not_equals', valueFrom: { field: 'contextFact', factClass: F.assessedProposal } };
const amountBinding: PolicyCondition = { type: 'predicate', field: 'amount', operator: 'not_equals', valueFrom: { field: 'contextFact', factClass: F.assessedAmount } };

describe('TRADE-03 characterization — what a missing fact does to each predicate shape', () => {
  it('a valueFrom binding (deny when request ≠ fact) does NOT fire when the fact is missing — it is no gate on its own', () => {
    assert.equal(matched(digestBinding, input()), false, 'comparand not admitted → no match');
    assert.equal(matched(digestBinding, input([{ factClass: F.assessedProposal, value: DIGEST }])), false, 'bound: no deny');
    assert.equal(matched(digestBinding, input([{ factClass: F.assessedProposal, value: `sha256:${'b'.repeat(64)}` }])), true, 'another proposal: deny');
  });

  it('`not_exists` and `not_equals` against a literal DO fire on a missing fact — usable as absence belts in deny rules', () => {
    assert.equal(matched({ type: 'predicate', field: 'contextFact', factClass: F.profile, operator: 'not_exists' }, input()), true);
    assert.equal(matched({ type: 'predicate', field: 'contextFact', factClass: F.profile, operator: 'not_equals', value: 'mm-desk@3' }, input()), true);
    assert.equal(matched({ type: 'predicate', field: 'contextFact', factClass: F.profile, operator: 'not_equals', value: 'mm-desk@3' }, input([{ factClass: F.profile, value: 'mm-desk@3' }])), false);
  });

  it('`equals true` does not fire on a missing fact — so an approval flag must be material, or a missing flag would skip approval', () => {
    const review: PolicyCondition = { type: 'predicate', field: 'contextFact', factClass: F.approvalRequired, operator: 'equals', value: true };
    assert.equal(matched(review, input()), false);
    assert.equal(matched(review, input([{ factClass: F.approvalRequired, value: true }])), true);
    assert.equal(matched(review, input([{ factClass: F.approvalRequired, value: 'true' }])), false, 'a string is not the boolean');
  });

  it('the amount binding is exact text equality of canonical decimals: a non-canonical spelling is a mismatch and denies (fail-closed direction)', () => {
    assert.equal(matched(amountBinding, input([{ factClass: F.assessedAmount, value: '100' }], '100')), false);
    assert.equal(matched(amountBinding, input([{ factClass: F.assessedAmount, value: '100.0' }], '100')), true);
    assert.equal(matched(amountBinding, input([{ factClass: F.assessedAmount, value: '99.999999' }], '100')), true);
  });
});

describe('TRADE-03 characterization — the policy layer is non-blocking when nothing matches', () => {
  it('a pack whose deny rules all miss yields `not_applicable`, which is allowed', () => {
    const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(NOW));
    const writer = { system: true, actorId: 'operator:trade03' } as const;
    runtime.registerPolicyPack(writer, { id: 'p', name: 'p', description: 'p', kind: 'data_boundary', domain: 'general_enterprise' });
    runtime.registerPolicyPackVersion(writer, {
      id: 'v',
      policyPackId: 'p',
      version: '1.0.0',
      scope: {},
      rules: [
        {
          id: 'bound',
          policyPackVersionId: 'v',
          name: 'bound',
          description: 'bound',
          status: 'active',
          priority: 100,
          condition: digestBinding,
          effect: { type: 'deny', reasonCode: 'NOT_ASSESSED', reason: 'Not assessed.' },
          obligations: [],
          evidenceRequirements: [],
          approvalRequirements: [],
          severity: 'error',
          sourceIds: [],
        },
      ],
      sources: [],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      demoOnly: true,
      legalCompleteness: 'not_legal_advice',
    });
    runtime.activatePolicyPackVersion(writer, 'v');
    const result = runtime.evaluatePolicy(input());
    assert.equal(result.decision.allowed, true, 'no admitted fact, no match, no deny');
    assert.equal(result.decision.type, 'not_applicable');
  });
});
