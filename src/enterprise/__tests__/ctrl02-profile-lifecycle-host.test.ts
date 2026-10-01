import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { CLUSTER as CORE08_CLUSTER, DEPLOY as CORE08_DEPLOY, observedPolicy } from './core08-reference-domains-fixture.js';
import {
  ACCOUNT,
  AUTH,
  ORG,
  TRANSFER,
  AGENT,
  ISSUER,
  OWNER,
  TRUST_DOMAIN,
  bootCtrl02,
  bootstrapOrganization,
  create,
  recordingAdapter,
  call,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  errorCode,
  expectStatus,
  govern,
  onboardAgent,
  transfer,
  type Booted,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-02 — the Governance Profile lifecycle (OQ-2's human half): draft →
 * active → retired, promoted by an identified operator, durable, and binding
 * on decisions exactly as CORE-03 binds a profile — through the shipped Host.
 */

const workspace = createWorkspace('frontera-ctrl02-profiles-');
after(() => workspace.close());

const PROFILE = 'payables-transfer';

function profile(version: number, policies: readonly string[] = ['payables-baseline']): Record<string, unknown> {
  return {
    profileId: PROFILE,
    version,
    owner: ORG,
    provenance: { authoredBy: 'policy-team', approvedBy: 'risk-committee' },
    actionClass: 'payment',
    resourceClass: 'operating-funds',
    parameters: [],
    materialFacts: [],
    relevantPolicies: version === 1 ? [...policies] : [...policies, `payables-v${version}`],
  };
}

function governance(profiles: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    actionClasses: [{ id: 'payment', actions: [TRANSFER] }],
    resourceClasses: [{ id: 'operating-funds', resources: [ACCOUNT] }],
    profiles,
  };
}

const lifecycleFile = (profiles: readonly Record<string, unknown>[] = [profile(1), profile(2)]): Record<string, unknown> =>
  ctrl02File({ governance: governance(profiles), profileLifecycle: 'operator-promoted' });

interface ProfileView {
  readonly profileId: string;
  readonly version: number;
  readonly digest: string;
  readonly state: string;
  readonly activatedBy: string | null;
  readonly retiredBy: string | null;
  readonly retirementReason: string | null;
}

async function profiles(baseUrl: string): Promise<readonly ProfileView[]> {
  const reply = expectStatus(await call(baseUrl, 'GET', '/api/admin/governance-profiles', { authorization: AUTH.observer }), 200, 'list profiles');
  return reply.body['profiles'] as ProfileView[];
}

async function versionOf(baseUrl: string, version: number): Promise<ProfileView> {
  const found = (await profiles(baseUrl)).find((candidate) => candidate.version === version);
  assert.ok(found !== undefined, `version ${version} is in the catalog`);
  return found;
}

const transitionPath = (version: number | string, transition: 'activate' | 'retire', id = PROFILE): string => `/api/admin/governance-profiles/${id}/versions/${version}/${transition}`;

/** The Governance Profile identity the grant behind an execution is bound to. */
async function boundProfile(baseUrl: string, executionId: string): Promise<string> {
  const execution = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: AUTH.observer }), 200, 'execution');
  const grant = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(execution.body['grantId'] as string)}`, { authorization: AUTH.observer }), 200, 'grant');
  const bound = (grant.body['bounds'] as Record<string, { kind: string; value: string }>)['governanceProfile'];
  assert.ok(bound !== undefined && bound.kind === 'identity', grant.text);
  return bound.value;
}

async function prepared(env: Record<string, string | undefined>): Promise<Booted & { readonly credential: string }> {
  const booted = await bootCtrl02(workspace, env);
  await bootstrapOrganization(booted.baseUrl);
  const agent = await onboardAgent(booted.baseUrl);
  return { ...booted, credential: agent.credential };
}

describe('CTRL-02 Governance Profile lifecycle — draft → active → retired, promoted by an identified human operator', () => {
  it('drafts govern nothing; only a profile steward or organization administrator promotes; the promotion names the operator; decisions bind the active version; supersession, retirement and restart behave', async () => {
    const dir = workspace.dir();
    const env = ctrl02Env(dir, lifecycleFile());
    const host = await prepared(env);
    const { baseUrl, credential } = host;

    // Draft: both catalog versions, neither active — and a governed action under the class resolves no profile.
    const drafts = await profiles(baseUrl);
    assert.deepEqual(drafts.map((view) => [view.version, view.state]), [[1, 'draft'], [2, 'draft']]);
    const underDraft = await govern(baseUrl, credential, transfer('10'));
    // Classified, and no active profile governs the pair: refused before any decision (the CORE-03 refusal).
    assert.equal(underDraft.body['status'], 'rejected', underDraft.text);
    assert.equal(host.adapter.calls.length, 0, 'a draft profile never lets an action through');

    const v1 = await versionOf(baseUrl, 1);
    const v2 = await versionOf(baseUrl, 2);
    assert.notEqual(v1.digest, v2.digest);

    // Only the promotion permission promotes.
    for (const header of [AUTH.observer, AUTH.provisioner, AUTH.responder, AUTH.legacyAdministrator]) {
      const refused = await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: header, body: { digest: v1.digest } });
      assert.equal(refused.status, 403, refused.text);
    }
    assert.equal((await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.legacyKey, body: { digest: v1.digest } })).status, 403);
    assert.equal((await call(baseUrl, 'POST', transitionPath(1, 'activate'), { body: { digest: v1.digest } })).status, 401);
    // Provenance and organization cannot be stated; content must be the reviewed content; the target must exist.
    for (const field of ['approvedBy', 'authoredBy', 'activatedBy', 'operatorId', 'organizationId', 'role', 'provenance', 'definition']) {
      const forged = await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest, [field]: 'ops-somebody-else' } });
      assert.equal(forged.status, 400, field);
    }
    const wrongDigest = await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v2.digest } });
    assert.equal(wrongDigest.status, 409);
    assert.equal(errorCode(wrongDigest), 'OPERATOR_OPERATION_REFUSED');
    assert.equal((await call(baseUrl, 'POST', transitionPath(9, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest } })).status, 404);
    assert.equal((await call(baseUrl, 'POST', transitionPath('one', 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest } })).status, 400);
    assert.equal((await call(baseUrl, 'POST', transitionPath(1, 'activate', 'other-profile'), { authorization: AUTH.steward, body: { digest: v1.digest } })).status, 404);
    assert.equal((await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: 'not-a-digest' } })).status, 400);
    assert.ok((await profiles(baseUrl)).every((view) => view.state === 'draft'), 'nothing was promoted by any refused request');

    // The steward promotes version 1: recorded under the authenticated operator, never a body value.
    const activated = expectStatus(await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest, reason: 'reviewed CR-101' } }), 200, 'activate v1');
    assert.equal(activated.body['outcome'], 'activated');
    assert.equal((activated.body['profile'] as ProfileView).state, 'active');
    assert.equal((activated.body['profile'] as ProfileView).activatedBy, 'operator:ops-steward');
    assert.equal(expectStatus(await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest } }), 200, 'repeat').body['outcome'], 'already-active');

    // The active version governs; the grant binds its id, version and digest.
    const first = await govern(baseUrl, credential, transfer('10'));
    assert.equal(first.body['status'], 'executed', first.text);
    const firstBinding = await boundProfile(baseUrl, first.body['executionId'] as string);
    assert.ok(firstBinding.includes(PROFILE) && firstBinding.includes('1') && firstBinding.includes(v1.digest), firstBinding);

    // Promoting version 2 supersedes version 1 atomically: v1 retired, v2 active, no gap.
    const second = expectStatus(await call(baseUrl, 'POST', transitionPath(2, 'activate'), { authorization: AUTH.administrator, body: { digest: v2.digest } }), 200, 'activate v2');
    assert.equal((second.body['superseded'] as ProfileView).version, 1);
    assert.equal((second.body['superseded'] as ProfileView).state, 'retired');
    assert.equal((second.body['superseded'] as ProfileView).retiredBy, 'operator:ops-admin');
    assert.match(String((second.body['superseded'] as ProfileView).retirementReason), /superseded by version 2/);
    const next = await govern(baseUrl, credential, transfer('10'));
    assert.equal(next.body['status'], 'executed', next.text);
    assert.ok((await boundProfile(baseUrl, next.body['executionId'] as string)).includes(v2.digest));
    // The historical grant stays bound to what governed it.
    assert.equal(await boundProfile(baseUrl, first.body['executionId'] as string), firstBinding);

    // A retired version is never active again.
    const reactivate = await call(baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest } });
    assert.equal(reactivate.status, 409);

    // Retiring the active version leaves nothing active: new requests resolve no profile, and reach nothing.
    const retired = expectStatus(await call(baseUrl, 'POST', transitionPath(2, 'retire'), { authorization: AUTH.steward, body: { digest: v2.digest, reason: 'withdrawn' } }), 200, 'retire v2');
    assert.equal(retired.body['outcome'], 'retired');
    const calls = host.adapter.calls.length;
    const afterRetire = await govern(baseUrl, credential, transfer('10'));
    assert.equal(afterRetire.body['status'], 'rejected', afterRetire.text);
    assert.equal(host.adapter.calls.length, calls);

    // Durable: a fresh process image reads the same lifecycle.
    await host.host.close();
    const restarted = await bootCtrl02(workspace, env);
    assert.deepEqual((await profiles(restarted.baseUrl)).map((view) => [view.version, view.state, view.activatedBy]), [
      [1, 'retired', 'operator:ops-steward'],
      [2, 'retired', 'operator:ops-admin'],
    ]);
    assert.notEqual((await govern(restarted.baseUrl, credential, transfer('10'))).body['status'], 'executed');
    assert.equal(restarted.adapter.calls.length, 0);
  });

  it('a version is immutable content: editing the catalog under an activated version number deactivates it, and the edit cannot be promoted under that number', async () => {
    const dir = workspace.dir();
    const host = await prepared(ctrl02Env(dir, lifecycleFile([profile(1)])));
    const v1 = await versionOf(host.baseUrl, 1);
    expectStatus(await call(host.baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: v1.digest } }), 200, 'activate');
    assert.equal((await govern(host.baseUrl, host.credential, transfer('10'))).body['status'], 'executed');
    await host.host.close();

    // The file is edited: version 1 now says something else.
    const edited = await bootCtrl02(workspace, ctrl02Env(dir, lifecycleFile([profile(1, ['a-different-policy'])])));
    const changed = await versionOf(edited.baseUrl, 1);
    assert.notEqual(changed.digest, v1.digest);
    assert.equal(changed.state, 'draft', 'the edited content was never activated');
    assert.notEqual((await govern(edited.baseUrl, host.credential, transfer('10'))).body['status'], 'executed', 'the activated digest no longer resolves');
    assert.equal(edited.adapter.calls.length, 0);
    const promote = await call(edited.baseUrl, 'POST', transitionPath(1, 'activate'), { authorization: AUTH.steward, body: { digest: changed.digest } });
    assert.equal(promote.status, 409, 'promote the edit as a new version instead');
  });

  it('static profiles (no lifecycle) stay exactly as CORE-03 composed them: active, and not transitionable', async () => {
    const host = await prepared(ctrl02Env(workspace.dir(), ctrl02File({ governance: governance([profile(1)]) })));
    const [only] = await profiles(host.baseUrl);
    assert.equal(only?.state, 'active');
    assert.equal((await govern(host.baseUrl, host.credential, transfer('10'))).body['status'], 'executed');
    const refused = await call(host.baseUrl, 'POST', transitionPath(1, 'retire'), { authorization: AUTH.steward, body: { digest: only?.digest } });
    assert.equal(refused.status, 409);
    assert.equal(((refused.body['error'] as Record<string, unknown>)['failure']), 'PROFILE_LIFECYCLE_STATIC');
  });

  it('the catalog is declarative and closed: executable-looking content, ambiguous governance and malformed versions refuse the Host', async () => {
    const refusal = async (file: Record<string, unknown>): Promise<string> => {
      try {
        await bootEnterpriseHost({ env: await withDeploymentWitness(ctrl02Env(workspace.dir(), file)) });
      } catch (error) {
        assert.ok(error instanceof EnterpriseHostConfigurationError, String(error));
        return error.code;
      }
      return assert.fail('expected a refusal');
    };
    for (const bad of [
      { ...profile(1), script: 'function () { return true; }' },
      { ...profile(1), rules: [{ when: 'amount > 10', then: 'allow' }] },
      { ...profile(1), relevantPolicies: ['() => true'] },
      { ...profile(1), relevantPolicies: ['${process.env.SECRET}'] },
      { ...profile(1), owner: '<script>' },
      { ...profile(1), version: 0 },
      { ...profile(1), version: 1.5 },
      { ...profile(1), provenance: { authoredBy: 'a', approvedBy: 'b', signedBy: 'c' } },
    ]) {
      assert.equal(await refusal(lifecycleFile([bad])), 'HOST_GOVERNED_ACTIONS_FILE_INVALID', JSON.stringify(bad).slice(0, 80));
    }
    // The same version twice; versions of one profile on different combinations; two profiles on one combination.
    assert.equal(await refusal(lifecycleFile([profile(1), profile(1)])), 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    const otherResource = governance([profile(1), { ...profile(2), resourceClass: 'reserve-funds' }]);
    (otherResource['resourceClasses'] as unknown[]).push({ id: 'reserve-funds', resources: ['reserve-account'] });
    assert.equal(await refusal(ctrl02File({ governance: otherResource, profileLifecycle: 'operator-promoted' })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal(await refusal(lifecycleFile([profile(1), { ...profile(1), profileId: 'second-profile' }])), 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
  });
});

describe('CTRL-02 Governance Profile promotion is a permitting governance operation — and still never authority', () => {
  const deployProfile = (version: number, requireStrategy: boolean): Record<string, unknown> => ({
    profileId: 'deploy-production',
    version,
    owner: ORG,
    provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
    actionClass: 'deploy',
    resourceClass: 'production',
    parameters: [{ dimension: 'replicaCount', required: true }, ...(requireStrategy ? [{ dimension: 'deploymentStrategy', required: true }] : [{ dimension: 'deploymentStrategy', required: false }])],
    materialFacts: [],
    relevantPolicies: ['core08-policy'],
  });
  const deployGovernance = {
    parameterDimensions: [
      { id: 'replicaCount', type: 'integer', bound: 'maximum' },
      { id: 'deploymentStrategy', type: 'token', bound: 'exact' },
    ],
    actionClasses: [{ id: 'deploy', actions: [CORE08_DEPLOY] }],
    resourceClasses: [{ id: 'production', resources: [CORE08_CLUSTER] }],
    profiles: [deployProfile(1, true), deployProfile(2, false)],
  };

  it('a steward activating a less-demanding catalog version relaxes that profile’s own requirements — and nothing else: no authority is created, and independent policy requirements still deny', async () => {
    const dir = workspace.dir();
    const adapter = recordingAdapter();
    const env = ctrl02Env(dir, ctrl02File({ monetary: undefined, governance: deployGovernance, profileLifecycle: 'operator-promoted', routes: [{ action: CORE08_DEPLOY, adapterId: 'pilot.recording' }] }));
    const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], policyPackProvider: observedPolicy().provider }));
    const { port } = await host.listen();
    const baseUrl = `http://127.0.0.1:${port}`;
    await bootstrapOrganization(baseUrl);
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'ci', subjectId: 'deployer-1' } });
    const credential = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'deployer-cred-0001' } }), 200, 'credential').body['bearerCredential'] as string;
    await create(baseUrl, AUTH.provisioner, 'authority-grant', { authorityGrantId: 'g-deploy', issuerActorId: ISSUER, subjectActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: 'release.manage', actions: [CORE08_DEPLOY], resourceScopes: [CORE08_CLUSTER], canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1 });
    await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'p-deployer', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'capability-token', { capabilityTokenId: 'c-deployer', subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: 'release.execute', actions: [CORE08_DEPLOY], resourceScopes: [CORE08_CLUSTER], riskLevel: 'high' });
    await create(baseUrl, AUTH.provisioner, 'delegation-grant', { delegationGrantId: 'd-deployer', delegatorActorId: OWNER, delegateActorId: AGENT, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: 'g-deploy', capability: 'release.execute', actions: [CORE08_DEPLOY], resourceScopes: [CORE08_CLUSTER] });
    const entitiesBefore = JSON.stringify((await call(baseUrl, 'GET', '/api/admin/authority/entities', { authorization: AUTH.observer })).body['entities']);

    let n = 0;
    const deploy = (parameters: Record<string, unknown>) => govern(baseUrl, credential, { action: CORE08_DEPLOY, resource: CORE08_CLUSTER, parameters, idempotencyKey: `promotion-${(n += 1)}` });
    const v1 = await versionOf(baseUrl, 1);
    const v2 = await versionOf(baseUrl, 2);
    expectStatus(await call(baseUrl, 'POST', transitionPath(1, 'activate', 'deploy-production'), { authorization: AUTH.steward, body: { digest: v1.digest } }), 200, 'activate v1');
    assert.equal((await deploy({ replicaCount: 3 })).body['status'], 'rejected', 'v1 requires deploymentStrategy');
    const withStrategy = await deploy({ replicaCount: 3, deploymentStrategy: 'rolling' });
    assert.equal(withStrategy.body['status'], 'executed', withStrategy.text);

    // The permitting step, stated plainly: v2 no longer requires the strategy.
    expectStatus(await call(baseUrl, 'POST', transitionPath(2, 'activate', 'deploy-production'), { authorization: AUTH.steward, body: { digest: v2.digest } }), 200, 'activate v2');
    // v1 refused the request at the envelope (a required parameter missing); under v2 the profile no longer requires it, so the request now reaches a decision — the relaxation is real …
    const relaxed = await deploy({ replicaCount: 3 });
    assert.notEqual(relaxed.body['status'], 'rejected', `the profile requirement was relaxed: ${relaxed.text}`);
    // … and the organization's independent policy, which also requires an approved strategy, still denies it.
    assert.equal(relaxed.body['status'], 'denied', relaxed.text);
    assert.match(relaxed.text, /DOMAIN_POLICY_DENIED/);
    const v2Executes = await deploy({ replicaCount: 3, deploymentStrategy: 'blue-green' });
    assert.equal(v2Executes.body['status'], 'executed', v2Executes.text);
    // …but it created no authority …
    assert.equal(JSON.stringify((await call(baseUrl, 'GET', '/api/admin/authority/entities', { authorization: AUTH.observer })).body['entities']), entitiesBefore, 'activation wrote nothing to the Kernel Authority');
    // … and an independently binding policy requirement still denies, whatever profile is active.
    const tooMany = await deploy({ replicaCount: 11, deploymentStrategy: 'rolling' });
    assert.equal(tooMany.body['status'], 'denied', tooMany.text);
    assert.match(tooMany.text, /DOMAIN_POLICY_DENIED/);
    assert.equal(adapter.calls.length, 2);
    // The promotion permission is the steward's and the organization administrator's only.
    for (const header of [AUTH.provisioner, AUTH.observer, AUTH.responder, AUTH.legacyAdministrator]) {
      assert.equal((await call(baseUrl, 'POST', transitionPath(1, 'retire', 'deploy-production'), { authorization: header, body: { digest: v1.digest } })).status, 403);
    }
  });
});
