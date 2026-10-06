import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyCondition, PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/index.js';
import type { PolicyEvaluationInput } from '../../features/domain-policy-pack-runtime/domain/policy-pack-evaluation.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import {
  DESTINATION_CONTEXT_FACT_CLASSES as F,
  DESTINATION_POLICY_MATERIAL_FACTS,
  DESTINATION_POLICY_REASON_CODES as R,
  assertDestinationPolicyGovernance,
  destinationApprovalPolicyRules,
} from '../trusted-context/index.js';

/**
 * ANDREW-P0-05 — the destination approval rules, evaluated by the real policy
 * engine (validator, applicability, rule evaluator, effect precedence) and the
 * real Kernel-facing integration. The Host path is
 * `destination-approval-policy-host.test.ts`. Synthetic identifiers only.
 */

const WRITER = { system: true, actorId: 'operator:policy-p005' } as const;
const VERSION = 'policy-pack-p005-v1';
const SOURCE = 'p005-source';
const CLASS = 'transfer';
const RESOURCE = 'treasury-operating-account';

const DESTINATION_RULES = destinationApprovalPolicyRules({ actionClass: CLASS, policyPackVersionId: VERSION, sourceIds: [SOURCE] });

function runtimeWith(rules: readonly PolicyPackRule[] = DESTINATION_RULES): PolicyPackRuntime {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(WRITER, { id: 'p005-policy', name: 'P0-05 proof policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(WRITER, {
    id: VERSION,
    policyPackId: 'p005-policy',
    version: '1.0.0',
    scope: { resourceScopes: [RESOURCE, 'production-cluster'] },
    rules,
    sources: [{ id: SOURCE, type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(WRITER, VERSION);
  return runtime;
}

type Facts = Readonly<Record<string, string | number | boolean>>;

let sequence = 0;
function input(facts: Facts, extra: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  sequence += 1;
  return {
    id: `p005-eval-${sequence}`,
    trustDomainId: 'trust-domain-p005',
    actorId: 'actor-agent',
    action: 'transfer-funds',
    resourceScope: RESOURCE,
    riskLevel: 'medium',
    requestedAt: '2026-06-01T00:00:00.000Z',
    actionClass: CLASS,
    amount: '75000',
    currency: 'USD',
    contextFacts: Object.entries(facts).map(([factClass, value]) => ({ factClass, value })),
    ...extra,
  };
}

const APPROVED: Facts = { [F.key]: 'network-a:abc123', [F.known]: true, [F.approvalState]: 'approved', [F.approved]: true };
const NEVER: Facts = { [F.key]: 'network-a:abc123', [F.known]: true, [F.approvalState]: 'never-approved', [F.approved]: false };
const REVOKED: Facts = { ...NEVER, [F.approvalState]: 'revoked' };
const EXPIRED: Facts = { ...NEVER, [F.approvalState]: 'expired' };
const UNKNOWN: Facts = { [F.key]: 'network-a:never-registered', [F.known]: false, [F.approvalState]: 'never-approved', [F.approved]: false };

const runtime = runtimeWith();
const evaluate = (facts: Facts, extra: Partial<PolicyEvaluationInput> = {}) => runtime.evaluatePolicy(input(facts, extra)).decision;
const destinationRuleIds = new Set(DESTINATION_RULES.map((rule) => rule.id));
const matchedDestinationRules = (decision: { readonly matchedRuleIds: readonly string[] }) => decision.matchedRuleIds.filter((id) => destinationRuleIds.has(id));

describe('ANDREW-P0-05 policy — the canonical states', () => {
  it('registers under the real policy pack validator', () => {
    assert.equal(DESTINATION_RULES.length, 5);
    assert.ok(runtime);
  });

  for (const [label, facts, code, ruleId] of [
    ['known, never approved', NEVER, R.notApproved, 'destination-approval-never-approved'],
    ['unknown', UNKNOWN, R.unknown, 'destination-approval-unknown'],
    ['revoked', REVOKED, R.approvalInactive, 'destination-approval-revoked'],
    ['expired', EXPIRED, R.approvalInactive, 'destination-approval-expired'],
  ] as const) {
    it(`${label} → denied ${code}, by exactly one rule`, () => {
      const decision = evaluate(facts);
      assert.equal(decision.type, 'denied');
      assert.equal(decision.allowed, false);
      assert.equal(decision.reasonCode, code);
      assert.deepEqual(matchedDestinationRules(decision), [ruleId]);
    });
  }

  it('known and actively approved → no destination rule matches', () => {
    const decision = evaluate(APPROVED);
    assert.notEqual(decision.type, 'denied');
    assert.equal(decision.allowed, true);
    assert.deepEqual(matchedDestinationRules(decision), []);
  });

  it('the reason states the fact, the required condition and the observed state — and no approval provenance', () => {
    const never = evaluate(NEVER).reason;
    assert.match(never, /not approved for this organization/);
    assert.match(never, /Required: destination\.approvalState = approved; observed: never-approved\./);
    assert.match(evaluate(REVOKED).reason, /observed: revoked\./);
    assert.match(evaluate(EXPIRED).reason, /observed: expired\./);
    assert.match(evaluate(UNKNOWN).reason, /Required: destination\.known = true; observed: false\./);
    for (const facts of [NEVER, REVOKED, EXPIRED, UNKNOWN]) assert.equal(/sequence|operator:|approvedBy|actorRef|network-a/.test(evaluate(facts).reason), false);
  });

  it('through the Kernel-facing integration a destination denial is policy_denied, allowed=false', () => {
    const integration = createActionEnforcementPolicyPackIntegration(runtimeWith());
    const base = { trustDomainId: 'trust-domain-p005', actorId: 'actor-agent', action: 'transfer-funds', resourceScope: RESOURCE, riskLevel: 'medium' as const, requestedAt: '2026-06-01T00:00:00.000Z', actionClass: CLASS, amount: '75000', currency: 'USD' };
    const denied = integration.evaluatePolicyForEnforcement({ ...base, contextFacts: Object.entries(NEVER).map(([factClass, value]) => ({ factClass, value })) });
    assert.equal(denied.type, 'policy_denied');
    assert.equal(denied.allowed, false);
    assert.equal(denied.reasonCode, R.notApproved);
    const satisfied = integration.evaluatePolicyForEnforcement({ ...base, contextFacts: Object.entries(APPROVED).map(([factClass, value]) => ({ factClass, value })) });
    assert.equal(satisfied.allowed, true);
    assert.notEqual(satisfied.type, 'policy_denied');
  });
});

describe('ANDREW-P0-05 policy — exhaustive and fail-closed over every fact combination', () => {
  const ABSENT = Symbol('absent');
  const knownValues = [true, false, ABSENT, 'true'] as const;
  const stateValues = ['never-approved', 'approved', 'revoked', 'expired', ABSENT, 'APPROVED', 'active'] as const;
  const approvedValues = [true, false, ABSENT, 'true', 1] as const;

  it('only known=true ∧ approvalState=approved ∧ approved=true passes; every other combination is denied by exactly one destination rule', () => {
    let combinations = 0;
    for (const known of knownValues) {
      for (const state of stateValues) {
        for (const approved of approvedValues) {
          combinations += 1;
          const facts: Record<string, string | number | boolean> = { [F.key]: 'network-a:abc123' };
          if (known !== ABSENT) facts[F.known] = known;
          if (state !== ABSENT) facts[F.approvalState] = state;
          if (approved !== ABSENT) facts[F.approved] = approved;
          const decision = evaluate(facts);
          const label = JSON.stringify({ known: String(known), state: String(state), approved: String(approved) });
          const passes = known === true && state === 'approved' && approved === true;
          if (passes) {
            assert.equal(decision.allowed, true, label);
            assert.deepEqual(matchedDestinationRules(decision), [], label);
          } else {
            assert.equal(decision.type, 'denied', label);
            assert.equal(matchedDestinationRules(decision).length, 1, `${label} matched ${matchedDestinationRules(decision).join(',')}`);
            assert.ok(Object.values(R).includes(decision.reasonCode as (typeof R)[keyof typeof R]), label);
          }
        }
      }
    }
    assert.equal(combinations, knownValues.length * stateValues.length * approvedValues.length);
  });

  it('no destination fact admitted at all → no destination rule matches: unavailability is left to the required-context step, never relabelled', () => {
    const decision = evaluate({});
    assert.deepEqual(matchedDestinationRules(decision), []);
    const { contextFacts: _facts, ...factless } = input({});
    assert.deepEqual(matchedDestinationRules(runtime.evaluatePolicy({ ...factless, id: 'p005-factless' }).decision), []);
  });

  it('a single admitted destination fact is enough for the rules to decide: incomplete facts are refused, never approved', () => {
    assert.equal(evaluate({ [F.key]: 'network-a:abc123' }).reasonCode, R.unverified);
    assert.equal(evaluate({ [F.approved]: true }).reasonCode, R.unverified);
    assert.equal(evaluate({ [F.approvalState]: 'approved', [F.approved]: true }).reasonCode, R.unverified, 'approval without known membership');
    assert.equal(evaluate({ [F.known]: true, [F.approved]: true }).reasonCode, R.unverified, 'approval state missing');
  });

  it('inconsistent facts are refused: approved=true with a non-active state, or an active state with approved=false', () => {
    assert.equal(evaluate({ ...NEVER, [F.approved]: true }).reasonCode, R.notApproved);
    assert.equal(evaluate({ ...REVOKED, [F.approved]: true }).reasonCode, R.approvalInactive);
    assert.equal(evaluate({ ...APPROVED, [F.approved]: false }).reasonCode, R.unverified);
    assert.equal(evaluate({ ...APPROVED, [F.known]: false }).reasonCode, R.unknown);
    const { [F.approvalState]: _state, ...stateless } = APPROVED;
    assert.equal(evaluate(stateless).reasonCode, R.unverified, 'known=true but approval state missing');
  });

  it('values are compared exactly: no case folding, no truthiness', () => {
    assert.equal(evaluate({ ...APPROVED, [F.approvalState]: 'Approved' }).type, 'denied');
    assert.equal(evaluate({ ...APPROVED, [F.approved]: 'true' }).type, 'denied');
    assert.equal(evaluate({ ...APPROVED, [F.known]: 1 }).type, 'denied');
  });
});

describe('ANDREW-P0-05 policy — the amount is the scenario, never the threshold', () => {
  const AMOUNTS = ['0.01', '1', '74999', '74999.99', '75000', '75000.01', '75001', '100000', '125000', '999999999999.99'];

  it('a known, unapproved destination is denied at every amount — 74,999 does not slip under, 75,001 is not treated differently', () => {
    for (const amount of AMOUNTS) {
      const decision = evaluate(NEVER, { amount });
      assert.equal(decision.type, 'denied', amount);
      assert.equal(decision.reasonCode, R.notApproved, amount);
      assert.deepEqual(matchedDestinationRules(decision), ['destination-approval-never-approved'], amount);
    }
  });

  it('an actively approved destination is satisfied at every amount — the destination rules apply no ceiling', () => {
    for (const amount of AMOUNTS) assert.equal(evaluate(APPROVED, { amount }).allowed, true, amount);
  });

  it('the asset does not matter either, and nothing is converted', () => {
    for (const currency of ['USD', 'EUR', 'xrpl:USD/rIssuerA']) {
      assert.equal(evaluate(NEVER, { currency }).reasonCode, R.notApproved, currency);
      assert.equal(evaluate(APPROVED, { currency }).allowed, true, currency);
    }
    const { amount: _a, currency: _c, ...unpriced } = input(NEVER);
    assert.equal(runtime.evaluatePolicy({ ...unpriced, id: 'p005-unpriced' }).decision.reasonCode, R.notApproved, 'no amount at all');
  });

  it('structurally: the rules read only the action class and the four destination facts — no amount, currency, counterparty, metadata or request field', () => {
    const fields = new Set<string>();
    const facts = new Set<string>();
    const walk = (condition: PolicyCondition): void => {
      if (condition.type === 'group') return condition.conditions.forEach(walk);
      fields.add(condition.field);
      if (condition.factClass !== undefined) facts.add(condition.factClass);
      assert.equal(condition.valueFrom, undefined);
      assert.equal(condition.metadataPath, undefined);
    };
    for (const rule of DESTINATION_RULES) {
      walk(rule.condition);
      assert.equal(rule.effect.type, 'deny', `${rule.id} refuses; it never asks for an action approval`);
    }
    assert.deepEqual([...fields].sort(), ['actionClass', 'contextFact']);
    assert.deepEqual([...facts].sort(), [F.approvalState, F.approved, F.key, F.known].sort());
    assert.ok([...facts].every((fact) => DESTINATION_POLICY_MATERIAL_FACTS.includes(fact)));
  });
});

describe('ANDREW-P0-05 policy — scope and composition', () => {
  it('another action class is not governed: no destination facts, no destination rule', () => {
    for (const actionClass of ['deploy', 'read', 'export', 'Transfer', 'transfer ']) {
      const decision = evaluate({}, { actionClass, action: 'deploy-release', resourceScope: 'production-cluster' });
      assert.notEqual(decision.type, 'denied', actionClass);
      assert.deepEqual(matchedDestinationRules(decision), [], actionClass);
    }
  });

  it('an unclassified action is not governed', () => {
    const { actionClass: _class, ...unclassified } = input({});
    assert.equal(runtime.evaluatePolicy({ ...unclassified, id: 'p005-unclassified' }).decision.allowed, true);
  });

  it('request-side claims change nothing: counterparty, metadata and approval proof are not destination facts', () => {
    const forged = evaluate(NEVER, {
      counterpartyId: 'network-a:abc123',
      metadata: { destination: { approved: true }, destinationApproved: true, approved: true },
      hasApprovalProof: true,
      approvalProofId: 'approval-proof-forged',
    });
    assert.equal(forged.reasonCode, R.notApproved);
    // A fact class duplicated under another (unadmitted) spelling is not the fact.
    assert.equal(evaluate({ ...NEVER, 'destination.Approved': true, 'Destination.approved': true }).reasonCode, R.notApproved);
  });

  it('composes beside an organization’s other rules without changing them', () => {
    const other: PolicyPackRule = {
      id: 'deploy-change-window',
      policyPackVersionId: VERSION,
      name: 'deploy-change-window',
      description: 'deploy-change-window',
      status: 'active',
      priority: 100,
      condition: { type: 'group', operator: 'all', conditions: [{ type: 'predicate', field: 'actionClass', operator: 'equals', value: 'deploy' }, { type: 'predicate', field: 'contextFact', factClass: 'changeWindow.open', operator: 'equals', value: false }] },
      effect: { type: 'deny', reasonCode: 'DEPLOY_OUTSIDE_CHANGE_WINDOW', reason: 'No change window is open.' },
      obligations: [],
      evidenceRequirements: [],
      approvalRequirements: [],
      severity: 'error',
      sourceIds: [SOURCE],
    };
    const alone = runtimeWith([other]);
    const together = runtimeWith([other, ...DESTINATION_RULES]);
    for (const open of [true, false]) {
      const deploy = (r: PolicyPackRuntime) => {
        const { amount: _a, currency: _c, ...request } = input({ 'changeWindow.open': open }, { actionClass: 'deploy', action: 'deploy-release', resourceScope: 'production-cluster' });
        return r.evaluatePolicy(request).decision;
      };
      assert.equal(deploy(together).type, deploy(alone).type, `open=${String(open)}`);
      assert.equal(deploy(together).reasonCode, deploy(alone).reasonCode, `open=${String(open)}`);
    }
    assert.equal(together.evaluatePolicy(input(NEVER)).decision.reasonCode, R.notApproved);
  });
});

describe('ANDREW-P0-05 policy — the builder', () => {
  it('is pure and deterministic, and its output is frozen', () => {
    const again = destinationApprovalPolicyRules({ actionClass: CLASS, policyPackVersionId: VERSION, sourceIds: [SOURCE] });
    assert.deepEqual(again, DESTINATION_RULES);
    assert.ok(Object.isFrozen(DESTINATION_RULES));
    for (const rule of DESTINATION_RULES) {
      assert.ok(Object.isFrozen(rule));
      assert.equal(rule.policyPackVersionId, VERSION);
      assert.deepEqual(rule.sourceIds, [SOURCE]);
      assert.equal(rule.status, 'active');
    }
  });

  it('scopes by the class it is given, and honors a rule id prefix and priority', () => {
    const rules = destinationApprovalPolicyRules({ actionClass: 'payout', policyPackVersionId: VERSION, sourceIds: [SOURCE], ruleIdPrefix: 'payout-destination', priority: 5 });
    assert.deepEqual(rules.map((rule) => rule.id), ['payout-destination-unknown', 'payout-destination-never-approved', 'payout-destination-revoked', 'payout-destination-expired', 'payout-destination-unverified']);
    assert.ok(rules.every((rule) => rule.priority === 5));
    const r = runtimeWith(rules);
    assert.equal(r.evaluatePolicy(input(NEVER, { actionClass: 'payout' })).decision.reasonCode, R.notApproved);
    assert.equal(r.evaluatePolicy(input(NEVER)).decision.allowed, true, 'the transfer class is not governed by a payout composition');
  });

  it('refuses incomplete options', () => {
    assert.throws(() => destinationApprovalPolicyRules({ actionClass: '', policyPackVersionId: VERSION, sourceIds: [SOURCE] }), TypeError);
    assert.throws(() => destinationApprovalPolicyRules({ actionClass: CLASS, policyPackVersionId: '', sourceIds: [SOURCE] }), TypeError);
    assert.throws(() => destinationApprovalPolicyRules({ actionClass: CLASS, policyPackVersionId: VERSION, sourceIds: [] }), TypeError);
    assert.throws(() => destinationApprovalPolicyRules({ actionClass: CLASS, policyPackVersionId: VERSION, sourceIds: [''] }), TypeError);
  });

  it('declares the material facts a governed profile needs: exactly the four P0-04 fact classes', () => {
    assert.deepEqual(DESTINATION_POLICY_MATERIAL_FACTS, [F.approvalState, F.approved, F.key, F.known].sort());
  });
});

describe('ANDREW-P0-05 policy — the composition guard', () => {
  const profile = (profileId: string, actionClass: string, materialFacts: readonly string[]) => ({
    profileId,
    version: 1,
    owner: 'org-p005',
    provenance: { authoredBy: 'operator:p005', approvedBy: 'operator:security' },
    actionClass,
    resourceClass: 'treasury_account',
    parameters: [],
    materialFacts,
    relevantPolicies: ['p005-policy'],
  });
  const governance = (...profiles: ReturnType<typeof profile>[]): GovernanceConfiguration => ({ profiles });

  it('accepts a configuration whose every profile of the governed class declares the four facts material', () => {
    assert.doesNotThrow(() => assertDestinationPolicyGovernance(governance(profile('a', CLASS, DESTINATION_POLICY_MATERIAL_FACTS), profile('b', 'deploy', [])), CLASS));
    assert.doesNotThrow(() => assertDestinationPolicyGovernance(governance(profile('a', CLASS, [...DESTINATION_POLICY_MATERIAL_FACTS, 'invoice.exists'])), CLASS));
  });

  it('refuses a governed class no profile declares', () => {
    assert.throws(() => assertDestinationPolicyGovernance(governance(profile('b', 'deploy', [])), CLASS), /no Governance Profile declares it/);
    assert.throws(() => assertDestinationPolicyGovernance({}, CLASS), TypeError);
  });

  it('refuses any profile of the class that omits a destination fact — exact spelling, no folding', () => {
    for (const omitted of DESTINATION_POLICY_MATERIAL_FACTS) {
      const facts = DESTINATION_POLICY_MATERIAL_FACTS.filter((fact) => fact !== omitted);
      assert.throws(() => assertDestinationPolicyGovernance(governance(profile('a', CLASS, DESTINATION_POLICY_MATERIAL_FACTS), profile('c', CLASS, facts)), CLASS), new RegExp(omitted.replace('.', '\\.')));
    }
    assert.throws(() => assertDestinationPolicyGovernance(governance(profile('a', CLASS, DESTINATION_POLICY_MATERIAL_FACTS.map((fact) => fact.toUpperCase()))), CLASS), TypeError);
  });
});
