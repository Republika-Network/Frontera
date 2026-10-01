import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACCOUNT,
  AGENT,
  AGENT_SUBJECT,
  AUTH,
  CEILING,
  ISSUER,
  ORG,
  OTHER_ACCOUNT,
  OWNER,
  TRUST_DOMAIN,
  assertNoSecretIn,
  bootCtrl02,
  bootstrapOrganization,
  call,
  create,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  errorCode,
  expectStatus,
  govern,
  logLines,
  responses,
  assignAuthority,
  pilotConstraints,
  transfer,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-02 — THE EXIT CRITERION, LITERALLY.
 *
 * > A pilot organization onboards an agent and assigns it bounded authority
 * > without source code, a REPL or direct DB access, as an identified human
 * > operator.
 *
 * One shipped Host (`bootEnterpriseHost()`), a clean durable store, and HTTP
 * only. The governed-action file names **no customer principal**: the agent
 * this test onboards exists nowhere in configuration, source or the database
 * before an operator creates it over the API. Nothing in this file provisions
 * in-process, opens a database, edits configuration after boot or reaches into
 * the composed Enterprise — a structural check at the bottom proves it.
 */

const workspace = createWorkspace('frontera-ctrl02-pilot-');
after(() => workspace.close());

describe('CTRL-02 EXIT — a pilot organization onboards an agent and assigns it bounded authority, as identified human operators, over HTTP only', () => {
  it('operator authenticates → sees the organization → bootstraps → onboards the agent → issues its credential → assigns bounded authority → the agent acts in bounds, is held out of bounds, and is stopped by revocation (across a restart)', async () => {
    const dir = workspace.dir();
    const file = ctrl02File();
    assert.deepEqual(file['customerPrincipals'], [], 'precondition: no static customer principal is configured');
    const env = ctrl02Env(dir, file);
    for (const value of Object.values(env)) assert.equal(typeof value === 'string' && value.includes(AGENT_SUBJECT.subjectId), false, 'precondition: the agent is not in the environment');
    const first = await bootCtrl02(workspace, env);
    const { baseUrl } = first;

    // 0. A clean durable store: no authority exists.
    const empty = expectStatus(await call(baseUrl, 'GET', '/api/admin/authority/entities', { authorization: AUTH.observer }), 200, 'list entities');
    assert.deepEqual(empty.body['entities'], [], 'the Kernel Authority store starts empty');
    assert.deepEqual(expectStatus(await call(baseUrl, 'GET', '/api/admin/agents', { authorization: AUTH.observer }), 200, 'list agents').body['agents'], []);

    // 1 + 2. The identified operator authenticates and observes the organization the Host serves.
    const who = expectStatus(await call(baseUrl, 'GET', '/api/admin/organization', { authorization: AUTH.provisioner }), 200, 'organization');
    assert.deepEqual(who.body['organization'], { organizationId: ORG, trustDomainId: TRUST_DOMAIN, agentCredentials: 'enabled', profileLifecycle: 'static' });
    const operator = who.body['operator'] as Record<string, unknown>;
    assert.equal(operator['operatorId'], 'ops-provisioner');
    assert.equal(operator['role'], 'provisioner');
    assert.equal(operator['credentialClass'], 'operator');
    assert.ok((operator['permissions'] as string[]).includes('authority.provision'));
    assert.ok(!(operator['permissions'] as string[]).includes('authority.bootstrap'), 'a provisioner does not bootstrap the organization');

    // Organization bootstrap is the organization administrator's, never the provisioner's.
    const notBootstrap = await call(baseUrl, 'POST', '/api/admin/authority/entities/trust-domain', {
      authorization: AUTH.provisioner,
      body: { trustDomainId: TRUST_DOMAIN, name: 'x', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['agent'] },
    });
    assert.equal(notBootstrap.status, 403, notBootstrap.text);
    assert.equal(errorCode(notBootstrap), 'OPERATOR_PERMISSION_DENIED');
    await bootstrapOrganization(baseUrl, AUTH.administrator);

    // 3 + 5. The provisioner onboards the agent: the canonical Kernel-Authority actor, bound to its external subject.
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Pilot Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    const agentCreated = await create(baseUrl, AUTH.provisioner, 'actor', {
      actorId: AGENT,
      type: 'agent',
      displayName: 'Payables Agent',
      issuerId: ISSUER,
      trustDomainId: TRUST_DOMAIN,
      externalSubject: AGENT_SUBJECT,
      idempotencyKey: 'onboard-payables-agent-1',
    });
    const agentEntity = agentCreated.body['entity'] as Record<string, unknown>;
    assert.equal(agentEntity['provisionedBy'], 'operator:ops-provisioner', 'the durable record names the identified operator');
    assert.equal(agentEntity['organizationId'], ORG);

    // Before a credential: the agent cannot authenticate at all.
    const inventoryBefore = expectStatus(await call(baseUrl, 'GET', `/api/admin/agents/${AGENT}`, { authorization: AUTH.observer }), 200, 'inspect agent');
    assert.deepEqual(inventoryBefore.body['onboarding'], { actor: 'active', credential: 'none', standingAuthority: 'none' });

    // 4. The agent's customer-plane principal: an operator-issued credential, revealed once.
    const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'payables-agent-credential-1' } }), 200, 'issue credential');
    assert.equal(issued.body['outcome'], 'issued');
    assert.equal(issued.body['principalId'], `agent:${AGENT}`);
    const credential = issued.body['bearerCredential'] as string;
    assert.match(credential, /^fra1\.agc-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    const credentialView = issued.body['credential'] as Record<string, unknown>;
    assert.equal(credentialView['createdBy'], 'operator:ops-provisioner');

    // With a credential and no authority: admitted as the agent, refused by the Kernel; the adapter is never reached.
    const unauthorized = await govern(baseUrl, credential, transfer('100'));
    assert.equal(unauthorized.status, 422, unauthorized.text);
    assert.equal(unauthorized.body['status'], 'denied', unauthorized.text);
    assert.equal(first.adapter.calls.length, 0);

    // 6 + 7. Bounded standing authority: one action, one resource, a P10 ceiling — owner grant, passport, capability token, delegation.
    const authority = await assignAuthority(baseUrl, AUTH.provisioner, { agentId: AGENT, ownerId: OWNER, ceiling: CEILING });
    const grant = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/entities/authority-grant/${authority.authorityGrantId}`, { authorization: AUTH.observer }), 200, 'inspect grant');
    assert.deepEqual((grant.body['terms'] as Record<string, unknown>)['constraints'], pilotConstraints(CEILING));
    assert.equal(grant.body['provisionedBy'], 'operator:ops-provisioner');

    // 8. The inventory shows the canonical actor and everything bound to it.
    const inventory = expectStatus(await call(baseUrl, 'GET', '/api/admin/agents', { authorization: AUTH.observer }), 200, 'list agents');
    const agents = inventory.body['agents'] as Record<string, unknown>[];
    assert.equal(agents.length, 1);
    const view = agents[0] as Record<string, unknown>;
    assert.equal(view['actorId'], AGENT);
    assert.deepEqual(view['externalSubject'], AGENT_SUBJECT);
    assert.equal(view['principalId'], `agent:${AGENT}`);
    assert.deepEqual(view['onboarding'], { actor: 'active', credential: 'active', standingAuthority: 'assigned' });
    const refs = view['authority'] as Record<string, { entityId: string; status: string }[]>;
    assert.deepEqual(refs['passports']?.map((ref) => ref.entityId), [authority.passportId]);
    assert.deepEqual(refs['capabilityTokens']?.map((ref) => ref.entityId), [authority.capabilityTokenId]);
    assert.deepEqual(refs['delegationGrants']?.map((ref) => ref.entityId), [authority.delegationGrantId]);

    // 9 + 10. The agent authenticates with its operator-issued credential; an in-bound action reaches the adapter once.
    const inBound = await govern(baseUrl, credential, transfer('120'));
    assert.equal(inBound.status, 200, inBound.text);
    assert.equal(inBound.body['status'], 'executed', inBound.text);
    assert.equal(first.adapter.calls.length, 1, 'the in-bound action reached the adapter exactly once');
    assert.equal(first.adapter.calls[0]?.action, 'transfer-funds');

    // 11. Over the P10 ceiling: withheld, never sent. Another resource: denied, never sent.
    const overBound = await govern(baseUrl, credential, transfer('900'));
    assert.equal(overBound.body['status'], 'withheld', overBound.text);
    assert.ok((overBound.body['reasonCodes'] as string[]).includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), overBound.text);
    const otherResource = await govern(baseUrl, credential, transfer('50', OTHER_ACCOUNT));
    assert.equal(otherResource.body['status'], 'denied', otherResource.text);
    assert.equal(first.adapter.calls.length, 1, 'out-of-bound actions reached the adapter zero times');

    // A fresh process image over the same files: the onboarded agent and its credential are durable.
    await first.host.close();
    const second = await bootCtrl02(workspace, env);
    const afterRestart = await govern(second.baseUrl, credential, transfer('80'));
    assert.equal(afterRestart.body['status'], 'executed', afterRestart.text);
    assert.equal(second.adapter.calls.length, 1);

    // 12. Revoking the actor — a responder can, through the CTRL-01 route — makes the same credential fail safely.
    const revoked = expectStatus(
      await call(second.baseUrl, 'POST', `/api/admin/authority/entities/actor/${AGENT}/revoke`, { authorization: AUTH.responder, body: { reason: 'pilot agent offboarded' } }),
      200,
      'revoke actor',
    );
    assert.equal(revoked.body['outcome'], 'revoked');
    assert.equal((revoked.body['entity'] as Record<string, unknown>)['revokedBy'], 'operator:ops-responder');
    const afterRevocation = await govern(second.baseUrl, credential, transfer('10'));
    assert.equal(afterRevocation.status, 403, afterRevocation.text);
    assert.equal(errorCode(afterRevocation), 'AUTHORIZATION_FAILED');
    assert.equal(second.adapter.calls.length, 1, 'after revocation the adapter is never reached');
    const offboarded = expectStatus(await call(second.baseUrl, 'GET', `/api/admin/agents/${AGENT}`, { authorization: AUTH.observer }), 200, 'inspect');
    assert.equal(offboarded.body['status'], 'revoked');
    assert.equal((offboarded.body['onboarding'] as Record<string, unknown>)['actor'], 'revoked');
    // Actor revocation and credential revocation are distinct facts: the credential still reads active — and still admits no one.
    assert.equal(((offboarded.body['credentials'] as Record<string, unknown>[])[0] as Record<string, unknown>)['status'], 'active');

    // Across one more restart: still refused.
    await second.host.close();
    const third = await bootCtrl02(workspace, env);
    const stillRefused = await govern(third.baseUrl, credential, transfer('10'));
    assert.equal(stillRefused.status, 403, stillRefused.text);
    assert.equal(third.adapter.calls.length, 0);

    // The bearer credential appeared in exactly one response — the one that revealed it — and in no log line.
    assert.equal(responses.filter((text) => text.includes(credential)).length, 1, 'revealed exactly once');
    for (const line of logLines) assertNoSecretIn(line, 'the Host log', [credential, credential.split('.')[2] ?? credential]);
    for (const text of responses) assertNoSecretIn(text, 'a response');
    // Attribution: every write is an identified operator's.
    const operatorLines = logLines.filter((line) => line.includes('enterprise.operator.control'));
    assert.ok(operatorLines.length >= 10);
    for (const line of operatorLines) assert.match(line, /"operatorId":"ops-(admin|provisioner)"/);
  });
});

describe('CTRL-02 EXIT — the proof itself used HTTP only', () => {
  it('this suite never provisions in-process, opens a database, edits configuration after boot or reaches into the composed Enterprise', () => {
    // The proof is everything above this structural check (which must name what it forbids).
    const sources = ['src/enterprise/__tests__/ctrl02-pilot-onboarding-host.test.ts', 'src/enterprise/__tests__/ctrl02-host-fixture.ts'].map((file) =>
      (readFileSync(file, 'utf8').split("describe('CTRL-02 EXIT — the proof itself")[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ''),
    );
    assert.ok((sources[0] ?? '').includes('bootCtrl02(') && (sources[1] ?? '').includes('bootEnterpriseHost('), 'the scanned sources are the proof and its harness');
    for (const source of sources) {
      for (const forbidden of [/kernelAuthorityProvisioning/, /kernelAuthorityStore/, /better-sqlite3/, /new Database\(/, /\.provision(Actor|Passport|CapabilityToken|AuthorityGrant|DelegationGrant|TrustDomain|RootIssuer)\(/, /appendEvent/, /host\.enterprise/, /\.enterprise\./, /createEnterprise\(/]) {
        assert.equal(forbidden.test(source), false, `${String(forbidden)} must not appear in the exit proof`);
      }
    }
    // Configuration is written once, before boot, by `ctrl02Env`.
    const fixture = sources[1] ?? '';
    assert.equal((fixture.match(/writeFileSync\(/g) ?? []).length, 1);
    assert.equal(ACCOUNT.length > 0, true);
  });
});
