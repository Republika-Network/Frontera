import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { APPROVAL_POLICY_WRITER, approvalPolicyRules, createApprovalPolicyPackProvider, parseApprovalPolicySection } from '../host/approval-policy.js';
import { loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { capturingLogger, recordingAdapter, type RecordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
  CRITICAL,
  GOVERNANCE,
  PROD,
  approvalFor,
  approvalPolicy,
  assertAwaitingApproval,
  call,
  command,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  govern,
  inbox,
  provisionOrganization,
  release,
  releaseKey,
  type Organization,
} from './ctrl04-host-fixture.js';

/**
 * PROD-03 — `approvalPolicy`: human approval on the shipped launcher's
 * composition, with no in-process code.
 *
 * Every Host here boots through `bootEnterpriseHost()` exactly as
 * `npm run start:enterprise` does — **no `policyPackProvider`** — so the only
 * thing that can send a decision to review is the governed-action file. The
 * CTRL-04 fixture provisions the organization, the release agent and the
 * approvers over HTTP; approvals are decided over the operator plane; the
 * recording adapter counts executions.
 *
 * The file declares one rule, for `release-production`. `release-critical`
 * also declares *how* it would be approved, but no rule says it *must* be:
 * the rule's scope is exactly its profile.
 */

const workspace = createWorkspace('frontera-prod03-approval-policy-');
after(() => workspace.close());

const POLICY = { policyId: 'pilot-approvals', rules: [{ ruleId: 'release-review', governanceProfile: 'release-production', reasonCode: 'RELEASE_REVIEW_REQUIRED' }] };

function fileWith(approvalPolicyValue: unknown = POLICY, governance: Record<string, unknown> = GOVERNANCE): Record<string, unknown> {
  return { ...ctrl04File(governance), approvalPolicy: approvalPolicyValue };
}

async function bootLauncherShaped(file: Record<string, unknown>, adapter: RecordingAdapter = recordingAdapter()): Promise<{ baseUrl: string; adapter: RecordingAdapter }> {
  const env = await withDeploymentWitness(ctrl04Env(workspace.dir(), file));
  const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger }));
  const { port } = await host.listen();
  return { baseUrl: `http://127.0.0.1:${port}`, adapter };
}

const subjectOf = (approval: Record<string, unknown>): string => approval['subjectDigest'] as string;
const idOf = (approval: Record<string, unknown>): string => approval['approvalRequestId'] as string;

describe('PROD-03 approvalPolicy — the shipped composition sends a decision to a human with no code', () => {
  let baseUrl: string;
  let adapter: RecordingAdapter;
  let org: Organization;

  before(async () => {
    ({ baseUrl, adapter } = await bootLauncherShaped(fileWith()));
    org = await provisionOrganization(baseUrl);
  });

  it('a request under the ruled profile waits for approval (zero effect); approved over the operator plane, the same request executes exactly once', async () => {
    const posture = (await call(baseUrl, 'GET', '/health')).body['posture'] as Record<string, unknown>;
    assert.equal(posture['approvals'], 'durable');
    const key = releaseKey('prod03-approve');
    const first = await govern(baseUrl, org.agentCredential, release(PROD, key));
    assertAwaitingApproval(first);
    assert.ok((first.body['reasonCodes'] as string[]).includes('RELEASE_REVIEW_REQUIRED') || (first.body['reasonCodes'] as string[]).includes('GOVERNED_ACTION_APPROVAL_PENDING'), first.text);
    assert.equal(adapter.calls.length, 0, 'awaiting approval: no adapter effect');

    const approval = await approvalFor(baseUrl, first);
    const approved = await command(baseUrl, AUTH.approverA, idOf(approval), 'approve', { subjectDigest: subjectOf(approval) });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(adapter.calls.length, 0, 'an approval is not an execution');

    const resumed = await govern(baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(adapter.calls.length, 1, 'approved: exactly one effect');
    const again = await govern(baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(again.body['replayed'], true, again.text);
    assert.equal(adapter.calls.length, 1, 'a replay of the approved request is not a second effect');
  });

  it('rejected: the request never executes', async () => {
    const before = adapter.calls.length;
    const key = releaseKey('prod03-reject');
    const first = await govern(baseUrl, org.agentCredential, release(PROD, key));
    assertAwaitingApproval(first);
    const approval = await approvalFor(baseUrl, first);
    const rejected = await command(baseUrl, AUTH.approverA, idOf(approval), 'reject', { subjectDigest: subjectOf(approval), reason: 'not in the change window' });
    assert.equal(rejected.status, 200, rejected.text);
    const after = await govern(baseUrl, org.agentCredential, release(PROD, key));
    assert.notEqual(after.body['status'], 'executed', after.text);
    assert.equal(adapter.calls.length, before, 'rejected: zero effect');
  });

  it('restrict-only and exactly scoped: a profile no rule names executes without review; a request with no authority is still denied, never sent to review', async () => {
    const before = adapter.calls.length;
    const pendingBefore = (await inbox(baseUrl, AUTH.observer, 'all')).length;
    // release-critical declares how it would be approved (quorum 2), but no rule requires it.
    const critical = await govern(baseUrl, org.agentCredential, release(CRITICAL, releaseKey('prod03-unruled')));
    assert.equal(critical.body['status'], 'executed', critical.text);
    assert.equal(adapter.calls.length, before + 1);
    // An approval requirement never rescues a request the authority does not allow.
    const denied = await govern(baseUrl, org.agentCredential, { ...release(PROD, releaseKey('prod03-denied')), resource: 'staging-cluster' });
    assert.notEqual(denied.body['status'], 'executed', denied.text);
    assert.notEqual(denied.body['withheldBy'], 'approval', denied.text);
    assert.equal(adapter.calls.length, before + 1, 'denied: zero effect');
    assert.equal((await inbox(baseUrl, AUTH.observer, 'all')).length, pendingBefore, 'no approval request for an unruled profile or a denied request');
  });
});

describe('PROD-03 approvalPolicy — configuration is closed and fails before anything opens', () => {
  const refusals: readonly (readonly [string, unknown, Record<string, unknown> | undefined, RegExp])[] = [
    ['not an object', [], undefined, /approvalPolicy must be an object/],
    ['unknown field', { ...POLICY, effect: 'allow' }, undefined, /unsupported field 'effect'/],
    ['unknown rule field', { policyId: 'p', rules: [{ ...POLICY.rules[0], effect: 'allow' }] }, undefined, /unsupported field 'effect'/],
    ['empty rules', { policyId: 'p', rules: [] }, undefined, /non-empty array/],
    ['bad policy id', { ...POLICY, policyId: 'Not Valid' }, undefined, /policyId must be/],
    ['unknown profile', { policyId: 'p', rules: [{ ...POLICY.rules[0], governanceProfile: 'release-staging' }] }, undefined, /not a profile declared/],
    ['duplicate rule id', { policyId: 'p', rules: [POLICY.rules[0], { ...POLICY.rules[0], governanceProfile: 'release-critical' }] }, undefined, /declared twice/],
    ['two rules for one profile', { policyId: 'p', rules: [POLICY.rules[0], { ...POLICY.rules[0], ruleId: 'other' }] }, undefined, /named by two rules/],
    ['bad reason code', { policyId: 'p', rules: [{ ...POLICY.rules[0], reasonCode: 'lower-case' }] }, undefined, /reasonCode must be/],
    ['too many rules', { policyId: 'p', rules: Array.from({ length: 33 }, (_, index) => ({ ...POLICY.rules[0], ruleId: `r${index}` })) }, undefined, /at most 32/],
    [
      'profile declares no approval',
      POLICY,
      { ...GOVERNANCE, profiles: GOVERNANCE.profiles.map((profile) => (profile.profileId === 'release-production' ? { ...profile, approval: undefined } : profile)) },
      /declares no 'approval'/,
    ],
  ];
  for (const [name, value, governance, message] of refusals) {
    it(`refuses: ${name}`, () => {
      const file = governance === undefined ? fileWith(value) : fileWith(value, JSON.parse(JSON.stringify(governance)) as Record<string, unknown>);
      assert.throws(
        () => loadEnterpriseHostConfiguration(ctrl04Env(workspace.dir(), file)),
        (error: unknown) => (error as { code?: string }).code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID' && message.test((error as Error).message),
      );
    });
  }

  it('refuses without operators: nobody could ever approve', () => {
    assert.throws(() => parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: [] }), /approvalPolicy requires an operator with approval\.approve/);
  });

  it('refuses two policy sources: the file approvalPolicy and an embedder policyPackProvider (HOST_POLICY_SOURCE_AMBIGUOUS), before any store opens', async () => {
    const env = await withDeploymentWitness(ctrl04Env(workspace.dir(), fileWith()));
    await assert.rejects(
      bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }),
      (error: unknown) => (error as { code?: string }).code === 'HOST_POLICY_SOURCE_AMBIGUOUS',
    );
  });
});

describe('PROD-03 approvalPolicy — the compiled policy can only require approval', () => {
  it('compiles each rule to one require_approval on the profile id, written by the configuration writer, and nothing else', () => {
    const parsed = parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: ['approver'] });
    const rules = approvalPolicyRules(parsed, 'v');
    assert.equal(rules.length, 1);
    for (const rule of rules) {
      assert.equal(rule.effect.type, 'require_approval');
      assert.deepEqual(rule.condition, { type: 'predicate', field: 'governanceProfile', operator: 'equals', value: 'release-production' });
    }
    assert.equal(APPROVAL_POLICY_WRITER.system, true);
    assert.match(APPROVAL_POLICY_WRITER.actorId, /^configuration:/);
  });

  it('evaluates: the ruled profile → requires approval; any other profile, or none → not applicable (never allowed, never denied by this pack)', () => {
    const provider = createApprovalPolicyPackProvider(parseApprovalPolicySection(POLICY, { governance: GOVERNANCE as never, operatorRoles: ['approver'] }), 'trust-domain-pilot');
    const base = { trustDomainId: 'trust-domain-pilot', actorId: 'actor-a', action: 'deploy-release', resourceScope: PROD, riskLevel: 'medium' as const, requestedAt: '2026-10-13T00:00:00.000Z' };
    assert.equal(provider.evaluatePolicyForEnforcement({ ...base, governanceProfile: 'release-production' }).type, 'policy_requires_approval');
    assert.equal(provider.evaluatePolicyForEnforcement({ ...base, governanceProfile: 'release-critical' }).type, 'policy_not_applicable');
    assert.equal(provider.evaluatePolicyForEnforcement(base).type, 'policy_not_applicable');
    assert.equal(provider.evaluatePolicyForEnforcement({ ...base, trustDomainId: 'another-domain', governanceProfile: 'release-production' }).type, 'policy_not_applicable');
  });

  it('structurally: the module compiles no effect other than require_approval and opens no store, route or adapter', () => {
    const source = readFileSync('src/enterprise/host/approval-policy.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
    const effects = [...source.matchAll(/effect:\s*\{\s*type:\s*'([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual(effects, ['require_approval']);
    for (const forbidden of [/better-sqlite3/, /node:http/, /fetch\(/, /execute\(/, /ExecutionAdapter/, /provision/i, /'allow'/, /'deny'/, /limit_scope/]) {
      assert.equal(forbidden.test(source), false, `${String(forbidden)} must not appear in approval-policy.ts`);
    }
  });
});
