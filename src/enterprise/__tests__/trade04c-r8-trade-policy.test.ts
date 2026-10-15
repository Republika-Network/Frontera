import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApprovalPolicyPackProvider } from '../host/approval-policy.js';
import {
  TRADE_RISK_MANDATORY_POLICY_EFFECTS,
  TRADE_RISK_MANDATORY_POLICY_RULE_IDS,
  TradeRiskPolicyProviderError,
  createTradeRiskPolicyPackProvider,
  tradeRiskPolicyProvenanceOf,
} from '../trade-risk-context/index.js';
import { ORG, TRUST_DOMAIN, call, type Reply } from './core04-host-fixture.js';
import { approvals, as, commandFor, revokeApproverAuthority } from './core05-host-fixture.js';
import { closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { decodeBlob } from './trade04b-xrpl-fixture.js';
import { FakeXrplLedger, NETWORK, pairWorld } from './trade04c-execution-fixture.js';
import {
  ADMIN_BEARER,
  AGENT,
  APPROVER,
  GOVERNANCE_PIN,
  Workspace,
  admit,
  bootTradeHost,
  governTrade,
  handBuiltTradePolicy,
  post,
  proposalFor,
  tradeExecutionSection,
  tradeFile,
  type TradeHost,
  type TradeHostOptions,
} from './trade04c-host-fixture.js';

/**
 * R8 (TRADE-04C, found integrating PROD-03): mandatory trading policy provenance.
 *
 * The defect: TRADE-03's review requirement and proposal-binding rules are policy-pack rules, and the Kernel's
 * policy port is opaque. A trade Host accepted any policy source, so with a PROD-03 `approvalPolicy` ruling only
 * another profile an 800-RLUSD order TRADE-03 marked APPROVAL_REQUIRED was signed and submitted with zero
 * human approvals (reproduced: status executed, 1 signature, 1 submission). That pre-fix behaviour is kept
 * reproducible in `trade04c-r8-mutation.test.ts` (the guard removed, the bypass returns).
 *
 * The fix: a trade-executing Host composes exactly the provider `createTradeRiskPolicyPackProvider` produced,
 * bound to the Host's own TRADE-03 edge, action, trust domain, organization and owners, with the mandatory rule
 * set — or refuses to start, before any XRPL store opens. Every case counts signatures and submissions.
 *
 * OFFLINE: fake ledger, reference signer; no XRPL network.
 */

const workspace = new Workspace();
after(async () => {
  workspace.cleanup();
  await closeDeploymentWitnesses();
});

const counts = (trade: TradeHost): { readonly signatures: number; readonly sends: number } => ({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length });

function assertNoXrplStoreOpened(dir: string): void {
  for (const file of ['xrpl-trade-sequence-interlock.sqlite', 'xrpl-submission-interlock.sqlite']) assert.equal(existsSync(join(dir, file)), false, `${file} was opened`);
}

/** Boot must refuse with `expected` before any XRPL store opens (the signer is never asked: refusal precedes composition). */
async function refused(options: TradeHostOptions, expected: string): Promise<void> {
  const dir = workspace.dir();
  await assert.rejects(bootTradeHost(workspace, { dir, ...options }), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, expected, String(error.message));
    return true;
  });
  assertNoXrplStoreOpened(dir);
}

const APPROVER_OPERATOR = { envOverrides: { FRONTERA_R8_APPROVER: 'FRONTERA_R8_APPROVER_SECRET_7d2a9c4e1b6f3a8e0512' }, operators: [{ operatorId: 'r8-approver', role: 'approver', apiKeyEnv: 'FRONTERA_R8_APPROVER' }] };

/** The exact R8 reproduction: a second, non-trading profile, and an approvalPolicy ruling only that one. */
function approvalPolicyForAnotherProfile(): TradeHostOptions {
  const ledger = new FakeXrplLedger();
  const pair = pairWorld(ledger);
  const governance = structuredClone(tradeFile(pair, 'http://unused.invalid')['governance']) as { actionClasses: unknown[]; profiles: Record<string, unknown>[] };
  governance.actionClasses.push({ id: 'housekeeping', actions: ['ops.housekeeping'] });
  governance.profiles.push({ ...structuredClone(governance.profiles[0]!), profileId: 'ops-housekeeping', actionClass: 'housekeeping', materialFacts: [], relevantPolicies: [] });
  return {
    ledger,
    pair,
    embedderPolicy: false,
    envOverrides: APPROVER_OPERATOR.envOverrides,
    fileOverrides: { governance, operators: APPROVER_OPERATOR.operators, approvalPolicy: { policyId: 'ops', rules: [{ ruleId: 'housekeeping-review', governanceProfile: 'ops-housekeeping', reasonCode: 'OPS_REVIEW' }] } },
  };
}

const BINDING_RULES = TRADE_RISK_MANDATORY_POLICY_RULE_IDS.filter((id) => id.startsWith('trade-binding-'));

describe('R8 — a trade Host refuses to start without TRADE-03’s mandatory policy (nothing opened)', () => {
  it('R8-A: an unrelated policy pack — even one that sends every trade to review — is refused (HOST_TRADE_POLICY_REQUIRED)', async () => {
    const unrelated = () => createApprovalPolicyPackProvider({ policyId: 'unrelated', rules: [{ ruleId: 'review-all', governanceProfile: GOVERNANCE_PIN.id, reasonCode: 'UNRELATED_REVIEW' }] }, TRUST_DOMAIN);
    await refused({ policyProvider: unrelated }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('R8-A: no policy provider at all is refused (HOST_TRADE_POLICY_REQUIRED, before composition)', async () => {
    await refused({ embedderPolicy: false }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('R8-A: the complete TRADE-03 rules, hand-built (the pre-R8 embedder construction), are refused — provenance, not resemblance', async () => {
    await refused({ policyProvider: ({ resource }) => handBuiltTradePolicy(resource) }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('R8-B: approvalPolicy-only, ruling another profile (the exact reproduction) — refused (HOST_TRADE_POLICY_SOURCE_CONFLICT)', async () => {
    await refused(approvalPolicyForAnotherProfile(), 'HOST_TRADE_POLICY_SOURCE_CONFLICT');
  });

  it('R8-B: approvalPolicy ruling the trading profile itself, alone or beside the mandatory provider — refused (one policy source: TRADE-03’s)', async () => {
    const fileOverrides = { operators: APPROVER_OPERATOR.operators, approvalPolicy: { policyId: 'desk', rules: [{ ruleId: 'trades-reviewed', governanceProfile: GOVERNANCE_PIN.id, reasonCode: 'DESK_REVIEW' }] } };
    await refused({ embedderPolicy: false, envOverrides: APPROVER_OPERATOR.envOverrides, fileOverrides }, 'HOST_TRADE_POLICY_SOURCE_CONFLICT');
    await refused({ envOverrides: APPROVER_OPERATOR.envOverrides, fileOverrides }, 'HOST_TRADE_POLICY_SOURCE_CONFLICT');
  });

  it('R8-C: a provider without trade-risk-review is not trade governance — refused', async () => {
    await refused({ policyProvider: ({ resource }) => handBuiltTradePolicy(resource, ['trade-risk-review']) }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('R8-D: a provider without the proposal-binding rules is not trade governance — refused', async () => {
    assert.ok(BINDING_RULES.length >= 9, 'seven parameter dimensions, amount and asset');
    await refused({ policyProvider: ({ resource }) => handBuiltTradePolicy(resource, BINDING_RULES) }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('forgery: a wrapper around the genuine provider, a prototype-inheriting look-alike, and a wrapper that drops its rules are all refused', async () => {
    await refused({ policyProvider: ({ mandatory }) => { const genuine = mandatory(); return Object.freeze({ evaluatePolicyForEnforcement: (input: Parameters<typeof genuine.evaluatePolicyForEnforcement>[0]) => genuine.evaluatePolicyForEnforcement(input) }); } }, 'HOST_TRADE_POLICY_REQUIRED');
    await refused({ policyProvider: ({ mandatory }) => Object.create(mandatory()) }, 'HOST_TRADE_POLICY_REQUIRED');
    await refused({ policyProvider: ({ mandatory, resource }) => { void mandatory(); const weak = handBuiltTradePolicy(resource, ['trade-risk-review']); return { evaluatePolicyForEnforcement: (input: Parameters<typeof weak.evaluatePolicyForEnforcement>[0]) => weak.evaluatePolicyForEnforcement(input) } as never; } }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('binding: a genuine provider for another edge (another profile version), another trust domain, or an owner outside its scope is refused', async () => {
    await refused({ policyEdgeProfileVersion: 4 }, 'HOST_TRADE_POLICY_REQUIRED');
    await refused({ policyProvider: ({ edge }) => createTradeRiskPolicyPackProvider(edge, { trustDomainId: 'trust-other' }) }, 'HOST_TRADE_POLICY_REQUIRED');
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const stranger = pairWorld(new FakeXrplLedger());
    const pairs = [...(tradeExecutionSection(pair, 'http://unused.invalid')['pairs'] as unknown[]), { ownerAccount: stranger.owner, delegateAccount: stranger.delegate.address, signingPublicKey: stranger.delegate.publicKey }];
    await refused({ ledger, pair, sectionOverrides: { pairs } }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('the factory binds only to an edge createTradeRiskContext composed, and its provider and provenance are immutable', async () => {
    let captured: { edge: unknown; provider: unknown } | undefined;
    const trade = await bootTradeHost(workspace, {
      policyProvider: ({ edge, mandatory }) => {
        const provider = mandatory();
        captured = { edge, provider };
        return provider;
      },
    });
    try {
      const { edge, provider } = captured!;
      assert.throws(() => createTradeRiskPolicyPackProvider({ ...(edge as object) } as never, { trustDomainId: TRUST_DOMAIN }), TradeRiskPolicyProviderError, 'a copy of the edge is not the edge');
      assert.throws(() => createTradeRiskPolicyPackProvider(edge as never, { trustDomainId: 'not a domain!' }), TradeRiskPolicyProviderError);
      assert.ok(Object.isFrozen(provider));
      assert.throws(() => {
        (provider as { evaluatePolicyForEnforcement: unknown }).evaluatePolicyForEnforcement = () => ({});
      }, TypeError);
      const provenance = tradeRiskPolicyProvenanceOf(provider)!;
      assert.ok(Object.isFrozen(provenance) && Object.isFrozen(provenance.ruleIds) && Object.isFrozen(provenance.resourceScopes));
      assert.deepEqual(provenance.ruleIds, TRADE_RISK_MANDATORY_POLICY_RULE_IDS);
      assert.equal(TRADE_RISK_MANDATORY_POLICY_EFFECTS['trade-risk-review'], 'require_approval');
      assert.ok(BINDING_RULES.every((id) => TRADE_RISK_MANDATORY_POLICY_EFFECTS[id] === 'deny'));
      assert.deepEqual(provenance.resourceScopes, [`${NETWORK}:${trade.pair.owner}`]);
      assert.equal(provenance.organizationId, ORG);
      assert.equal(provenance.edge, edge);
      assert.equal(tradeRiskPolicyProvenanceOf(Object.create(provider as object)), undefined);
      assert.equal(tradeRiskPolicyProvenanceOf({ ...(provider as object) }), undefined);
    } finally {
      await trade.signer.close();
    }
  });
});

describe('R8-E / R8-F — the mandatory provider on the shipped Host: legitimate trades execute; review is enforced', () => {
  let trade: TradeHost;

  before(async () => {
    trade = await bootTradeHost(workspace);
  });
  after(async () => {
    await trade?.signer.close().catch(() => {});
  });

  async function withheld(value: string): Promise<{ readonly intent: Awaited<ReturnType<typeof admit>>; readonly reply: Reply; readonly before: ReturnType<typeof counts> }> {
    const before = counts(trade);
    const intent = await admit(trade, proposalFor(trade, value));
    const reply = await post(trade, intent);
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'approval', reply.text);
    assert.equal(trade.assessments.at(-1)?.disposition, 'APPROVAL_REQUIRED');
    // The Kernel reply carries its generic codes; trade-risk-review is the pack's only require_approval rule, and the same pair's in-limit order (R8-E) is not reviewed.
    assert.ok((reply.body['reasonCodes'] as string[]).includes('APPROVAL_REQUIRED'), reply.text);
    assert.deepEqual(counts(trade), before, 'no signature and no submission before approval');
    return { intent, reply, before };
  }

  it('R8-E: an in-limit order executes exactly once (1 signature, 1 submission)', async () => {
    const before = counts(trade);
    const reply = await governTrade(trade, proposalFor(trade, '100'));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(counts(trade), { signatures: before.signatures + 1, sends: before.sends + 1 });
  });

  it('R8-F: 800 RLUSD, APPROVAL_REQUIRED — withheld; unauthorized and self approvals refused; a valid approval executes exactly the grant-bound transaction once', async () => {
    const raw = proposalFor(trade, '800');
    const before = counts(trade);
    const intent = await admit(trade, raw);
    const first = await post(trade, intent);
    assert.equal(first.body['withheldBy'], 'approval', first.text);
    assert.equal(trade.assessments.at(-1)?.disposition, 'APPROVAL_REQUIRED');
    assert.deepEqual(counts(trade), before);
    const view = await approvals(trade.host).describe(first.body['requestId'] as string);
    assert.ok(view !== undefined);
    for (const actor of ['actor-stranger', AGENT]) {
      await assert.rejects(approvals(trade.host).approve(as(actor), commandFor(view)), Error, `${actor} cannot approve`);
      const again = await post(trade, intent);
      assert.equal(again.body['withheldBy'], 'approval', again.text);
      assert.deepEqual(counts(trade), before, `still nothing signed or sent after ${actor}'s attempt`);
    }
    await approvals(trade.host).approve(as(APPROVER), commandFor(view));
    const resumed = await post(trade, intent);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(trade), { signatures: before.signatures + 1, sends: before.sends + 1 });
    const tx = trade.ledger.submitted.at(-1)!;
    assert.equal(tx.executionId, resumed.body['executionId']);
    const fields = decodeBlob(tx.blob);
    assert.equal(fields['Account'], trade.pair.owner);
    assert.deepEqual(fields['TakerGets'], raw['takerGets']);
    assert.equal(fields['TakerPays'], (raw['takerPays'] as { drops: string }).drops);
    const lookup = await call(trade.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(resumed.body['executionId'] as string)}`, { authorization: ADMIN_BEARER });
    assert.equal(lookup.status, 200, lookup.text);
    const replay = await post(trade, intent);
    assert.equal(replay.body['executionId'], resumed.body['executionId']);
    assert.deepEqual(counts(trade), { signatures: before.signatures + 1, sends: before.sends + 1 }, 'a replay never signs or sends again');
  });

  it('R8-F: a rejected approval never executes (0 signatures, 0 submissions)', async () => {
    const { intent, reply, before } = await withheld('900');
    const view = await approvals(trade.host).describe(reply.body['requestId'] as string);
    await approvals(trade.host).reject(as(APPROVER), commandFor(view!));
    const resumed = await post(trade, intent);
    assert.notEqual(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(trade), before);
  });

  it('R8-F: an approval revoked before the request resumes never executes (0 / 0)', async () => {
    const { intent, reply, before } = await withheld('850');
    const view = await approvals(trade.host).describe(reply.body['requestId'] as string);
    await approvals(trade.host).approve(as(APPROVER), commandFor(view!));
    await approvals(trade.host).revoke(as(APPROVER), commandFor((await approvals(trade.host).describe(reply.body['requestId'] as string))!));
    const resumed = await post(trade, intent);
    assert.notEqual(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(trade), before);
  });

  it('R8-F: an approver whose authority was revoked cannot approve; the order stays unexecuted (0 / 0) — expiry and quorum: CORE-05 approval-lifecycle / approval-authenticity / CTRL-04 suites', async () => {
    const { intent, reply, before } = await withheld('820');
    const view = await approvals(trade.host).describe(reply.body['requestId'] as string);
    await revokeApproverAuthority(trade.host, APPROVER);
    await assert.rejects(approvals(trade.host).approve(as(APPROVER), commandFor(view!)));
    const resumed = await post(trade, intent);
    assert.notEqual(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(trade), before);
  });
});

describe('R8-G — a trading-profile or policy-source change never carries approval under the old rules', () => {
  /**
   * The trading-risk profile is pinned in the edge, and the policy is bound to that edge's profile reference, so a
   * profile change is a new edge and a new provider at boot — verified here: a provider bound to another profile
   * version is refused, and so is any other policy source. Within CORE-05, an approval names the subject digest,
   * which binds the effective Governance Profile key and digest, the admitted-context digest (the profile
   * reference is one of its facts) and a snapshot of the requirement; another decision, context or requirement is
   * superseded, never approved — qualified by approval-lifecycle.test.ts ("another decision, parameter, context,
   * record digest or action under the same request is superseded, never approved"; "the requirement is
   * snapshotted: a configuration change supersedes an open or completed request"). An end-to-end restart on the
   * same state was attempted and is not used as evidence: the fixture's restart path does not restore P10
   * financial authority (FINANCIAL_AUTHORITY_UNRESOLVED with the profile unchanged too), so it cannot isolate the
   * profile's effect.
   */
  it('a provider qualified for another profile version (@4) cannot serve a Host whose edge pins @3; nor can a provider re-pointed at another edge', async () => {
    await refused({ policyEdgeProfileVersion: 4 }, 'HOST_TRADE_POLICY_REQUIRED');
    await refused({ profileVersion: 4, policyEdgeProfileVersion: 3 }, 'HOST_TRADE_POLICY_REQUIRED');
  });

  it('a Host whose edge and provider both pin @4 composes, and its assessments carry @4 — the reference the pinned-profile rule and the approval context bind', async () => {
    let reference: string | undefined;
    const trade = await bootTradeHost(workspace, {
      profileVersion: 4,
      policyProvider: ({ mandatory }) => {
        const provider = mandatory();
        reference = tradeRiskPolicyProvenanceOf(provider)?.profileReference;
        return provider;
      },
    });
    try {
      assert.equal(reference, 'mm-desk@4');
      const before = counts(trade);
      const reply = await governTrade(trade, proposalFor(trade, '800'));
      assert.equal(reply.body['withheldBy'], 'approval', reply.text);
      assert.deepEqual(counts(trade), before);
    } finally {
      await trade.signer.close();
    }
  });
});

describe('R8 — structure: the provider the Kernel receives is the one the guard verified', () => {
  const host = readFileSync(join(__dirname, '..', 'host', 'enterprise-host.js'), 'utf8');

  it('the guard runs in the pre-composition block, before any XRPL composition, and returns only when trade is not configured', () => {
    const guard = host.indexOf('await assertTradePolicyComposed(host, options);');
    assert.ok(guard > 0);
    assert.ok(guard < host.indexOf("import('../xrpl-payment-rail/host-composition.js')") && guard < host.indexOf("import('../xrpl-trade-execution/host-composition.js')"));
    const body = host.slice(host.indexOf('async function assertTradePolicyComposed('), host.indexOf('function secureProfileShortfalls('));
    assert.ok(/if \(governed === undefined \|\| trade === undefined\)\s*return;/.test(body));
    assert.ok(body.includes('const effective = policyPackProviderOf(host, options);'), 'the guard verifies exactly what policyPackProviderOf hands on');
  });

  it('toCreateEnterpriseOptions passes policyPackProviderOf’s value, unchanged, to the composition', () => {
    const options = host.slice(host.indexOf('function toCreateEnterpriseOptions('), host.indexOf('function executionReconciliationOf('));
    assert.ok(options.includes('const policyPackProvider = policyPackProviderOf(host, options);'));
    assert.equal([...options.matchAll(/policyPackProvider/g)].length, 4, 'declared once, tested once, passed once (shorthand key and value)');
  });
});
