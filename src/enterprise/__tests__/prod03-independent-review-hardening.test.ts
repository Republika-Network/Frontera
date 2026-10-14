import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { readFileSync } from 'node:fs';

import { compileApprovalPolicyRuntime, createApprovalPolicyPackProvider, liveApprovalPolicyContext, parseApprovalPolicySection } from '../host/approval-policy.js';
import type { PolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { LEGACY_ADMINISTRATOR_ROLE, OPERATOR_ROLES, permissionsOf } from '../operator-control/roles.js';
import { loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { capturingLogger, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
  CTRL04_SECRETS,
  GOVERNANCE,
  PROD,
  QUORUM_1,
  approvalFor,
  assertAwaitingApproval,
  call,
  command,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  expectStatus,
  govern,
  provisionOrganization,
  release,
  releaseKey,
} from './ctrl04-host-fixture.js';

/**
 * PROD-03 independent-review hardening — `approvalPolicy`.
 *
 * P1-2  approvalPolicy accepted any non-zero operator count, even when no
 *       configured operator could reach `approval.approve`.
 * P1-4  approvalPolicy matched a profile id while the operator-promoted
 *       catalog could hold a version of that id with no CORE-05 `approval`.
 * P2-1  the compiled runtime ran on a 1970 manual clock with sequential ids
 *       that restarted at 000001 on every boot.
 * P2-2  the compiled runtime retained every evaluation, decision, proof and
 *       event for the Host's lifetime.
 *
 * Each is reproduced through the surface a pilot actually uses — the Host's
 * own configuration loader, the Host itself, or the provider the launcher
 * composes — and fails on the code before the fix.
 */

const workspace = createWorkspace('frontera-prod03-review-hardening-');
after(() => workspace.close());

const POLICY = { policyId: 'pilot-approvals', rules: [{ ruleId: 'release-review', governanceProfile: 'release-production', reasonCode: 'RELEASE_REVIEW_REQUIRED' }] };
const APPROVER_REQUIRED = /approvalPolicy requires an operator with approval\.approve/;
const ALL_SECRETS = Object.values(CTRL04_SECRETS);

const OPERATOR = {
  admin: { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_CTRL02_ADMIN' },
  provisioner: { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' },
  observer: { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' },
  responder: { operatorId: 'ops-responder', role: 'responder', apiKeyEnv: 'FRONTERA_CTRL02_RESPONDER' },
  steward: { operatorId: 'ops-steward', role: 'profile-steward', apiKeyEnv: 'FRONTERA_CTRL02_STEWARD' },
  approver: { operatorId: 'approver-a', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_A' },
} as const;

async function load(file: Record<string, unknown>): Promise<ReturnType<typeof loadEnterpriseHostConfiguration>> {
  return loadEnterpriseHostConfiguration(await withDeploymentWitness(ctrl04Env(workspace.dir(), file)));
}

async function refusal(file: Record<string, unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await load(file);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'the configuration must be refused');
  assert.equal((caught as { code?: string }).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID', (caught as Error).message);
  for (const secret of ALL_SECRETS) assert.equal((caught as Error).message.includes(secret), false, 'a refusal never names a credential');
  return caught as Error;
}

const withOperators = (operators: readonly Record<string, string>[]): Record<string, unknown> => ({ ...ctrl04File(), operators, approvalPolicy: POLICY });

describe('P1-2 — approvalPolicy boots only when a configured operator can reach approval.approve', () => {
  const refused: readonly (readonly [string, readonly Record<string, string>[]])[] = [
    ['observer only', [OPERATOR.observer]],
    ['responder only', [OPERATOR.responder]],
    ['provisioner only', [OPERATOR.provisioner]],
    ['profile-steward only', [OPERATOR.steward]],
    ['every non-approving role at once (plus the CTRL-01 legacy administrators the fixture declares)', [OPERATOR.observer, OPERATOR.responder, OPERATOR.provisioner, OPERATOR.steward]],
  ];
  for (const [name, operators] of refused) {
    it(`refuses: ${name}`, async () => {
      assert.match((await refusal(withOperators(operators))).message, APPROVER_REQUIRED);
    });
  }

  const accepted: readonly (readonly [string, readonly Record<string, string>[]])[] = [
    ['an approver', [OPERATOR.approver]],
    ['an organization administrator', [OPERATOR.admin]],
    ['an approver among unrelated roles', [OPERATOR.observer, OPERATOR.responder, OPERATOR.approver, OPERATOR.provisioner]],
  ];
  for (const [name, operators] of accepted) {
    it(`accepts: ${name}`, async () => {
      assert.ok((await load(withOperators(operators))).governedActions?.approvalPolicy !== undefined);
    });
  }

  it('the parser itself: the CTRL-01 legacy administrator alone, or no operator at all, is refused', () => {
    for (const operatorRoles of [[LEGACY_ADMINISTRATOR_ROLE], []] as const) {
      assert.throws(() => parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles }), APPROVER_REQUIRED);
    }
  });

  it('the parser judges each role exactly as the canonical operator-plane policy does (no role list of its own)', () => {
    for (const role of [...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE]) {
      const canApprove = permissionsOf(role).includes('approval.approve');
      const parse = (): unknown => parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: [role] });
      if (canApprove) assert.doesNotThrow(parse, role);
      else assert.throws(parse, APPROVER_REQUIRED, role);
    }
    assert.deepEqual(
      [...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE].filter((role) => permissionsOf(role).includes('approval.approve')),
      ['approver', 'organization-administrator'],
      'CTRL-04 role matrix: only approver and organization-administrator can reach approval.approve',
    );
  });
});

// -- P1-4 ------------------------------------------------------------------------------------------

type Profile = Record<string, unknown>;
const productionV1 = (GOVERNANCE.profiles[0] as unknown) as Profile;
const criticalV1 = (GOVERNANCE.profiles[1] as unknown) as Profile;
const version = (profile: Profile, number: number, approval: unknown): Profile => {
  const { approval: _drop, ...rest } = profile;
  return { ...rest, version: number, relevantPolicies: [...(profile['relevantPolicies'] as string[]), `v${number}`], ...(approval !== undefined ? { approval } : {}) };
};
const catalog = (profiles: readonly Profile[]): Record<string, unknown> => ({ ...ctrl04File({ ...GOVERNANCE, profiles }), profileLifecycle: 'operator-promoted', approvalPolicy: POLICY });
const QUORUM_1_SHORT = { ...QUORUM_1, requestTtlSeconds: 1800 };

describe('P1-4 — every declared version of a ruled profile declares how it is approved (static and operator-promoted)', () => {
  it('C1: a single version with approval → accepted (static lifecycle)', async () => {
    assert.ok((await load({ ...ctrl04File(), approvalPolicy: POLICY })).governedActions?.approvalPolicy !== undefined);
  });

  it('C2: a single version with no approval → refused', async () => {
    assert.match((await refusal({ ...ctrl04File({ ...GOVERNANCE, profiles: [version(productionV1, 1, undefined), criticalV1] }), approvalPolicy: POLICY })).message, /declares no 'approval'/);
  });

  it('C3: two catalog versions, both with approval (even different approval terms) → accepted', async () => {
    assert.ok((await load(catalog([version(productionV1, 1, QUORUM_1), version(productionV1, 2, QUORUM_1_SHORT), criticalV1]))).governedActions?.approvalPolicy !== undefined);
  });

  it('C4 (the reproduction): v1 with approval, v2 without → refused before anything opens', async () => {
    const error = await refusal(catalog([version(productionV1, 1, QUORUM_1), version(productionV1, 2, undefined), criticalV1]));
    assert.match(error.message, /release-production.*version 2.*declares no 'approval'/);
  });

  it('C5: v1 without approval, v2 with → refused', async () => {
    assert.match((await refusal(catalog([version(productionV1, 1, undefined), version(productionV1, 2, QUORUM_1), criticalV1]))).message, /release-production.*version 1.*declares no 'approval'/);
  });

  it('C6: only ruled profile ids are constrained — an unruled profile\'s versions may omit approval', async () => {
    assert.ok((await load(catalog([version(productionV1, 1, QUORUM_1), version(productionV1, 2, QUORUM_1), version(criticalV1, 1, undefined), version(criticalV1, 2, undefined)]))).governedActions?.approvalPolicy !== undefined);
  });
});

describe('P1-4 — C7: under the operator-promoted lifecycle, promoting another approval-bearing version keeps the approval workflow resolvable', () => {
  it('v1 active: review → approve → exactly one effect; v2 promoted: an in-flight v1 request never executes, a new request is reviewed under v2 and executes once after approval', async () => {
    const file = catalog([version(productionV1, 1, QUORUM_1), version(productionV1, 2, QUORUM_1_SHORT), criticalV1]);
    const adapter = recordingAdapter();
    const env = await withDeploymentWitness(ctrl04Env(workspace.dir(), file));
    const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger }));
    const { port } = await host.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const profiles = async (): Promise<readonly Record<string, unknown>[]> => expectStatus(await call(baseUrl, 'GET', '/api/admin/governance-profiles', { authorization: AUTH.observer }), 200, 'profiles').body['profiles'] as Record<string, unknown>[];
    const activate = async (profileId: string, number: number): Promise<void> => {
      const view = (await profiles()).find((entry) => entry['profileId'] === profileId && entry['version'] === number);
      assert.ok(view !== undefined);
      expectStatus(await call(baseUrl, 'POST', `/api/admin/governance-profiles/${profileId}/versions/${number}/activate`, { authorization: AUTH.steward, body: { digest: view['digest'], reason: 'review' } }), 200, `activate ${profileId}@${number}`);
    };
    await activate('release-production', 1);
    await activate('release-critical', 1);
    const org = await provisionOrganization(baseUrl);

    const approveAndResume = async (key: string): Promise<void> => {
      const first = await govern(baseUrl, org.agentCredential, release(PROD, key));
      assertAwaitingApproval(first);
      const approval = await approvalFor(baseUrl, first);
      // Operator permission is necessary, not sufficient: an observer cannot reach the command, and an approver with
      // no Kernel-Authority standing reaches it but is never counted (CORE-05 decides whether an approval counts).
      assert.equal((await command(baseUrl, AUTH.observer, approval['approvalRequestId'] as string, 'approve', { subjectDigest: approval['subjectDigest'] })).status, 403);
      assert.notEqual((await command(baseUrl, AUTH.approverNoStanding, approval['approvalRequestId'] as string, 'approve', { subjectDigest: approval['subjectDigest'] })).status, 200);
      assert.notEqual((await govern(baseUrl, org.agentCredential, release(PROD, key))).body['status'], 'executed', 'refused approvals count for nothing');
      expectStatus(await command(baseUrl, AUTH.approverA, approval['approvalRequestId'] as string, 'approve', { subjectDigest: approval['subjectDigest'] }), 200, 'approve');
      const resumed = await govern(baseUrl, org.agentCredential, release(PROD, key));
      assert.equal(resumed.body['status'], 'executed', resumed.text);
    };

    await approveAndResume(releaseKey('c7-v1'));
    assert.equal(adapter.calls.length, 1);

    // In flight under v1 when v2 is promoted.
    const inFlightKey = releaseKey('c7-in-flight');
    const inFlight = await govern(baseUrl, org.agentCredential, release(PROD, inFlightKey));
    assertAwaitingApproval(inFlight);
    await activate('release-production', 2);
    assert.deepEqual(
      (await profiles()).filter((entry) => entry['profileId'] === 'release-production').map((entry) => [entry['version'], entry['state']]),
      [[1, 'retired'], [2, 'active']],
    );
    const stale = await approvalFor(baseUrl, inFlight);
    await command(baseUrl, AUTH.approverA, stale['approvalRequestId'] as string, 'approve', { subjectDigest: stale['subjectDigest'] });
    const afterPromotion = await govern(baseUrl, org.agentCredential, release(PROD, inFlightKey));
    assert.notEqual(afterPromotion.body['status'], 'executed', `a request decided under the retired version never executes: ${afterPromotion.text}`);
    assert.equal(adapter.calls.length, 1);

    // A new request under v2: reviewed (v2 declares approval), approved, exactly one effect.
    await approveAndResume(releaseKey('c7-v2'));
    assert.equal(adapter.calls.length, 2, 'exactly one effect per approved request');
  });
});

// -- P2-1 ------------------------------------------------------------------------------------------

describe('P2-1 — the compiled approval policy\'s identities are not recycled across Host restarts', () => {
  const policyOf = async (): Promise<NonNullable<NonNullable<ReturnType<typeof loadEnterpriseHostConfiguration>['governedActions']>['approvalPolicy']>> => {
    const declared = (await load({ ...ctrl04File(), approvalPolicy: POLICY })).governedActions?.approvalPolicy;
    assert.ok(declared !== undefined);
    return declared;
  };
  const input = { trustDomainId: 'trust-domain-pilot', actorId: 'actor-a', action: 'deploy-release', resourceScope: PROD, riskLevel: 'medium' as const, requestedAt: '2026-10-14T00:00:00.000Z', governanceProfile: 'release-production' };

  it('D3/D4/D5 (the reproduction): two Host boots (two providers) never hand out the same policy decision or proof id', async () => {
    const firstBoot = createApprovalPolicyPackProvider(await policyOf(), 'trust-domain-pilot').evaluatePolicyForEnforcement(input);
    const secondBoot = createApprovalPolicyPackProvider(await policyOf(), 'trust-domain-pilot').evaluatePolicyForEnforcement(input);
    assert.equal(firstBoot.type, 'policy_requires_approval');
    assert.equal(secondBoot.type, 'policy_requires_approval');
    assert.ok(firstBoot.policyDecisionId !== undefined && firstBoot.policyProofId !== undefined);
    assert.notEqual(firstBoot.policyDecisionId, secondBoot.policyDecisionId, 'decision ids differ across a restart');
    assert.notEqual(firstBoot.policyProofId, secondBoot.policyProofId, 'proof ids differ across a restart');
  });

  it('D2: two evaluations in one boot have distinct ids', async () => {
    const provider = createApprovalPolicyPackProvider(await policyOf(), 'trust-domain-pilot');
    const a = provider.evaluatePolicyForEnforcement(input);
    const b = provider.evaluatePolicyForEnforcement(input);
    assert.notEqual(a.policyDecisionId, b.policyDecisionId);
    assert.notEqual(a.policyProofId, b.policyProofId);
  });
});

describe('P2-1 — live evaluation time; deterministic compiled metadata', () => {
  const input = { id: 'enforcement-request-1', trustDomainId: 'trust-domain-pilot', actorId: 'actor-a', action: 'deploy-release', resourceScope: PROD, riskLevel: 'medium' as const, requestedAt: new Date().toISOString(), hasAuthorityProof: true, hasApprovalProof: false, hasHandshakeProof: false, hasRequiredEvidence: false, governanceProfile: 'release-production' };
  const parsed = (): ReturnType<typeof parseApprovalPolicySection> => parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: ['approver'] });

  it('D1: evaluation, decision, proof and every ledger event are stamped by the wall clock, never 1970', () => {
    const before = Date.now();
    const result = compileApprovalPolicyRuntime(parsed(), 'trust-domain-pilot', liveApprovalPolicyContext()).evaluatePolicy(input);
    const after = Date.now();
    assert.equal(result.decision.type, 'requires_approval');
    assert.ok(result.proof !== undefined);
    const stamps = [result.decision.decidedAt, result.proof.createdAt, ...result.events.map((event) => event.timestamp)];
    for (const stamp of stamps) {
      const at = Date.parse(stamp);
      assert.ok(at >= before - 1000 && at <= after + 1000, `live: ${stamp}`);
    }
  });

  it('D1b: the Host\'s provider composes the live context by default — the module names no fixed clock or sequential id source', () => {
    const source = readFileSync('src/enterprise/host/approval-policy.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/createPolicyPackRuntimeContext/, /createManualPolicyPackClock/, /createSequentialPolicyPackIdGenerator/]) assert.equal(forbidden.test(source), false, String(forbidden));
    assert.match(source, /context: PolicyPackRuntimeContext = liveApprovalPolicyContext\(\)/);
    assert.match(source, /clock: \{ now: \(\) => new Date\(\)\.toISOString\(\) \}/);
    assert.match(source, /nextId: \(prefix: string\) => `\$\{prefix\}-\$\{randomUUID\(\)\}`/);
  });

  it('D6: the compiled version\'s effectiveFrom stays the fixed configuration instant (deterministic metadata)', () => {
    const runtime = compileApprovalPolicyRuntime(parsed(), 'trust-domain-pilot', liveApprovalPolicyContext());
    assert.deepEqual(runtime.listActivePolicyPackVersions().map((version) => version.effectiveFrom), ['1970-01-01T00:00:00.000Z']);
  });

  it('D3-D5 via the live context: identifiers carry a random UUID, so two boots cannot collide', () => {
    const uuid = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const a = createApprovalPolicyPackProvider(parsed(), 'trust-domain-pilot').evaluatePolicyForEnforcement(input);
    const b = createApprovalPolicyPackProvider(parsed(), 'trust-domain-pilot').evaluatePolicyForEnforcement(input);
    for (const id of [a.policyDecisionId, a.policyProofId, b.policyDecisionId, b.policyProofId]) assert.match(String(id), uuid);
    assert.equal(new Set([a.policyDecisionId, a.policyProofId, b.policyDecisionId, b.policyProofId]).size, 4);
  });

  it('D7: across a real Host restart, a review opened before it and one opened after it stay distinct and each resolves once', async () => {
    const dir = workspace.dir();
    const file = { ...ctrl04File(), approvalPolicy: POLICY };
    const adapter = recordingAdapter();
    const boot = async (): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
      const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(ctrl04Env(dir, file)), executionAdapters: [adapter], logger: capturingLogger }));
      const { port } = await host.listen();
      return { baseUrl: `http://127.0.0.1:${port}`, close: () => host.close() };
    };
    const first = await boot();
    const org = await provisionOrganization(first.baseUrl);
    const beforeKey = releaseKey('d7-before');
    const pendingBefore = await govern(first.baseUrl, org.agentCredential, release(PROD, beforeKey));
    assertAwaitingApproval(pendingBefore);
    const approvalBefore = await approvalFor(first.baseUrl, pendingBefore);
    await first.close();

    const second = await boot();
    const afterKey = releaseKey('d7-after');
    const pendingAfter = await govern(second.baseUrl, org.agentCredential, release(PROD, afterKey));
    assertAwaitingApproval(pendingAfter);
    const approvalAfter = await approvalFor(second.baseUrl, pendingAfter);
    assert.notEqual(approvalAfter['approvalRequestId'], approvalBefore['approvalRequestId']);
    assert.notEqual(approvalAfter['subjectDigest'], approvalBefore['subjectDigest']);
    for (const [approval, key] of [[approvalBefore, beforeKey], [approvalAfter, afterKey]] as const) {
      expectStatus(await command(second.baseUrl, AUTH.approverA, approval['approvalRequestId'] as string, 'approve', { subjectDigest: approval['subjectDigest'] }), 200, 'approve');
      assert.equal((await govern(second.baseUrl, org.agentCredential, release(PROD, key))).body['status'], 'executed');
    }
    assert.equal(adapter.calls.length, 2, 'each approved request executed exactly once, across the restart');
  });
});

describe('P2-2 — the compiled approval policy retains nothing between evaluations', () => {
  /** The live context, observed: counts every identifier issued, by prefix. */
  function observedContext(): { readonly context: PolicyPackRuntimeContext; readonly issued: Map<string, number> } {
    const live = liveApprovalPolicyContext();
    const issued = new Map<string, number>();
    return { issued, context: { clock: live.clock, ids: { nextId: (prefix: string) => (issued.set(prefix, (issued.get(prefix) ?? 0) + 1), live.ids.nextId(prefix)) } } };
  }
  const input = { trustDomainId: 'trust-domain-pilot', actorId: 'actor-a', action: 'deploy-release', resourceScope: PROD, riskLevel: 'medium' as const, requestedAt: '2026-10-14T00:00:00.000Z' };
  const parsed = (): ReturnType<typeof parseApprovalPolicySection> => parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: ['approver'] });

  it('every evaluation runs on its own freshly compiled, frozen runtime: the per-evaluation work is constant over 3,000 evaluations — nothing accumulates', () => {
    const { context, issued } = observedContext();
    const provider = createApprovalPolicyPackProvider(parsed(), 'trust-domain-pilot', context);
    const perEvaluation = (): number => [...issued.values()].reduce((sum, count) => sum + count, 0);
    const atBoot = perEvaluation();
    // What one compile issues, and what one evaluation on a compiled runtime issues.
    const probe = observedContext();
    const compiled = compileApprovalPolicyRuntime(parsed(), 'trust-domain-pilot', probe.context);
    const compileCost = [...probe.issued.values()].reduce((sum, count) => sum + count, 0);
    compiled.evaluatePolicy({ id: 'probe', ...input, hasAuthorityProof: true, hasApprovalProof: false, hasHandshakeProof: false, hasRequiredEvidence: false, governanceProfile: 'release-production' });
    const evaluationCost = [...probe.issued.values()].reduce((sum, count) => sum + count, 0) - compileCost;
    const sizes: number[] = [];
    for (let index = 0; index < 3000; index += 1) {
      const before = perEvaluation();
      const result = provider.evaluatePolicyForEnforcement({ ...input, governanceProfile: index % 2 === 0 ? 'release-production' : 'release-critical' });
      assert.equal(result.type, index % 2 === 0 ? 'policy_requires_approval' : 'policy_not_applicable');
      sizes.push(perEvaluation() - before);
    }
    assert.equal(atBoot, compileCost, 'the section is compiled once at boot');
    // Every ruled evaluation = one fresh compile + one evaluation. A runtime shared across evaluations (whose store
    // would keep every evaluation, decision, proof and event) would cost only the evaluation.
    assert.deepEqual([...new Set(sizes.filter((_, index) => index % 2 === 0))], [compileCost + evaluationCost]);
    assert.equal(issued.get('policy-evaluation'), 3000);
  });

  it('a compiled runtime holds exactly the evaluation it was compiled for: its store never shows another', () => {
    const runtime = compileApprovalPolicyRuntime(parsed(), 'trust-domain-pilot', liveApprovalPolicyContext());
    runtime.evaluatePolicy({ id: 'only', ...input, hasAuthorityProof: true, hasApprovalProof: false, hasHandshakeProof: false, hasRequiredEvidence: false, governanceProfile: 'release-production' });
    assert.equal(runtime.store.listEvaluations().length, 1);
    assert.equal(runtime.store.listDecisions().length, 1);
  });

  it('parity: the compiled policy only ever requires approval for the ruled profile; never allows, denies, or applies elsewhere; reason code preserved', () => {
    const provider = createApprovalPolicyPackProvider(parsed(), 'trust-domain-pilot');
    const ruled = provider.evaluatePolicyForEnforcement({ ...input, governanceProfile: 'release-production' });
    assert.equal(ruled.type, 'policy_requires_approval');
    assert.equal(ruled.reasonCode, 'RELEASE_REVIEW_REQUIRED');
    for (const other of [{ governanceProfile: 'release-critical' }, {}, { governanceProfile: 'release-production', trustDomainId: 'another-domain' }]) {
      assert.equal(provider.evaluatePolicyForEnforcement({ ...input, ...other }).type, 'policy_not_applicable');
    }
  });
});
