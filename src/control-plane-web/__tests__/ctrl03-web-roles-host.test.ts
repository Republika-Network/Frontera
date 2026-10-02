import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bearer, bootstrapOrganization, create, expectStatus } from '../../enterprise/__tests__/ctrl02-host-fixture.js';
import { AGENT, AGENT_SUBJECT, AUTH, bootQualification, call, consoleLogLines, ISSUER, logLines, OPERATOR_SECRETS, OWNER, revealedSecret, TRUST_DOMAIN, type Qualification } from './ctrl03-web-fixture.js';
import { Browser, formsOf, textOf, type PageView } from './web-browser.js';

/**
 * CTRL-03 — the role × operation matrix THROUGH THE WEB, against the real Host.
 *
 * For every operator class: (a) which controls the console shows — derived only
 * from the permissions the Host reported — and, independently, (b) that a
 * forged form for every operation the role does not hold reaches the Host and
 * is refused **there** (403 `OPERATOR_PERMISSION_DENIED`), with the Host's
 * state unchanged. A hidden control is never the evidence; the Host's refusal
 * is. Also: who can sign in at all (credential planes), the session and CSRF
 * controls, rotation's one-time reveal, and organization smuggling from the
 * browser.
 */

let q: Qualification;
const AGENT2 = 'actor-agent-without-credential';
const THROWAWAY = 'actor-throwaway';
let agentSecret = '';

type Role = 'administrator' | 'provisioner' | 'responder' | 'steward' | 'observer';
const ROLES: readonly Role[] = ['administrator', 'provisioner', 'responder', 'steward', 'observer'];
const browsers = new Map<Role, Browser>();

before(async () => {
  q = await bootQualification('frontera-ctrl03-roles-');
  const { baseUrl } = q.host;
  // The world, over the Host's operator API (HTTP only): bootstrap, an owner, two agents, one credential.
  await bootstrapOrganization(baseUrl);
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: AGENT_SUBJECT });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT2, type: 'agent', displayName: 'Agent Two', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pilot-ci', subjectId: 'agent-two' } });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: THROWAWAY, type: 'human', displayName: 'Throwaway', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'roles-agent-cred-1' } }), 200, 'credential');
  agentSecret = issued.body['bearerCredential'] as string;
  for (const role of ROLES) {
    const browser = q.browser(role);
    const signedIn = await browser.signIn(OPERATOR_SECRETS[role]);
    assert.equal(signedIn.status, 200, `${role} signs in: ${textOf(signedIn.html).slice(0, 300)}`);
    browsers.set(role, browser);
  }
});
after(() => q.close());

const as = (role: Role): Browser => {
  const browser = browsers.get(role);
  assert.ok(browser !== undefined);
  return browser;
};

/** Ground truth the matrix must leave unchanged. */
async function hostState(): Promise<string> {
  const [entities, agents, profiles, emergency] = await Promise.all([
    q.truth('/api/admin/authority/entities'),
    q.truth('/api/admin/agents'),
    q.truth('/api/admin/governance-profiles'),
    call(q.host.baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: AUTH.observer }),
  ]);
  return JSON.stringify([entities.body, agents.body, (profiles.body['profiles'] as { state: string }[]).map((profile) => profile.state), emergency.body]);
}

const csrfOf = (page: PageView): string => Browser.hidden(page, 'csrf');
const form = (entries: Record<string, string>): string => new URLSearchParams(entries).toString();

/** Forged operations — what no page offers a role that lacks the permission — each with the permission the Host checks. */
const FORGED: readonly { readonly name: string; readonly allowed: readonly Role[]; readonly path: string; readonly body: (csrf: string) => string }[] = [
  {
    name: 'provision an agent actor (authority.provision)',
    allowed: ['administrator', 'provisioner'],
    path: '/agents',
    body: (csrf) => form({ csrf, idempotencyKey: `forged-${Math.random().toString(16).slice(2)}aa`, actorId: 'actor-forged', type: 'agent', displayName: 'Forged', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN }),
  },
  {
    name: 'bootstrap a trust domain (authority.bootstrap)',
    allowed: ['administrator'],
    path: '/authority/new/trust-domain',
    body: (csrf) => form({ csrf, trustDomainId: 'td-forged', name: 'Forged', issuerActorId: ISSUER, acceptedIssuerIds: ISSUER, acceptedActorTypes: 'agent' }),
  },
  { name: 'issue an agent credential (agent-credential.manage)', allowed: ['administrator', 'provisioner'], path: `/agents/${AGENT2}/credentials`, body: (csrf) => form({ csrf, idempotencyKey: 'forged-issue-0001' }) },
  { name: 'revoke authority (authority.revoke)', allowed: ['administrator', 'provisioner', 'responder'], path: `/authority/entities/actor/${THROWAWAY}/revoke`, body: (csrf) => form({ csrf, confirm: 'yes', reason: 'forged' }) },
  { name: 'activate a Governance Profile (profile.promote)', allowed: ['administrator', 'steward'], path: '/profiles/deploy-production/1/activate', body: (csrf) => form({ csrf, confirm: 'yes', digest: 'sha256:' + '0'.repeat(64) }) },
  { name: 'declare an emergency stop (emergency.stop)', allowed: ['administrator', 'responder'], path: '/emergency/activate', body: (csrf) => form({ csrf, confirm: 'yes', scope: 'actor', value: 'actor-nobody' }) },
  { name: 'release an emergency control (emergency.release)', allowed: ['administrator'], path: '/emergency/release', body: (csrf) => form({ csrf, confirm: 'yes', scope: 'actor', value: 'actor-nobody' }) },
];

describe('CTRL-03 web role matrix — what each role is shown follows the Host’s reported permissions', () => {
  const shown = async (role: Role) => {
    const browser = as(role);
    const authority = await browser.get('/authority');
    const agent = await browser.get(`/agents/${AGENT}`);
    const agent2 = await browser.get(`/agents/${AGENT2}`);
    const profiles = await browser.get('/profiles');
    const emergency = await browser.get('/emergency');
    return {
      provision: authority.html.includes('href="/authority/new/actor"'),
      bootstrap: authority.html.includes('href="/authority/new/trust-domain"'),
      issue: formsOf(agent2.html).some((candidate) => candidate.action === `/agents/${AGENT2}/credentials`),
      rotate: agent.html.includes('Rotate credential…'),
      revokeCredential: agent.html.includes('Revoke credential…'),
      revokeActor: agent.html.includes('Revoke agent actor…'),
      activateProfile: profiles.html.includes('Activate profile…'),
      emergencyStop: emergency.html.includes('Review emergency stop…'),
    };
  };

  const EXPECTED: Readonly<Record<Role, Readonly<Record<string, boolean>>>> = {
    administrator: { provision: true, bootstrap: true, issue: true, rotate: true, revokeCredential: true, revokeActor: true, activateProfile: true, emergencyStop: true },
    provisioner: { provision: true, bootstrap: false, issue: true, rotate: true, revokeCredential: true, revokeActor: true, activateProfile: false, emergencyStop: false },
    responder: { provision: false, bootstrap: false, issue: false, rotate: false, revokeCredential: true, revokeActor: true, activateProfile: false, emergencyStop: true },
    steward: { provision: false, bootstrap: false, issue: false, rotate: false, revokeCredential: false, revokeActor: false, activateProfile: true, emergencyStop: false },
    observer: { provision: false, bootstrap: false, issue: false, rotate: false, revokeCredential: false, revokeActor: false, activateProfile: false, emergencyStop: false },
  };

  for (const role of ROLES) {
    it(`${role}: controls shown exactly per its Host-reported permissions`, async () => {
      assert.deepEqual(await shown(role), EXPECTED[role]);
      const overview = textOf((await as(role).get('/')).html);
      const reported = (await call(q.host.baseUrl, 'GET', '/api/admin/organization', { authorization: bearer(OPERATOR_SECRETS[role]) })).body['operator'] as { permissions: string[]; role: string };
      for (const permission of reported.permissions) assert.ok(overview.includes(permission), `${role}: the Host’s permission ${permission} is shown`);
      assert.ok(overview.includes(`(${reported.role})`));
    });
  }

  it('every section renders for every role (reads are inventory.read), with no script anywhere', async () => {
    for (const role of ROLES) {
      for (const path of ['/', '/agents', `/agents/${AGENT}`, '/authority', '/activity', '/evidence', '/profiles', '/emergency', `/authority/entities/actor/${OWNER}`]) {
        const page = await as(role).get(path);
        assert.equal(page.status, 200, `${role} ${path}`);
        assert.doesNotMatch(page.html, /<script|\son[a-z]+="|javascript:/i, `${role} ${path} carries no script`);
      }
    }
  });
});

describe('CTRL-03 web role matrix — independently, the Host refuses every forged operation a role does not hold', () => {
  for (const operation of FORGED) {
    for (const role of ROLES.filter((candidate) => !operation.allowed.includes(candidate))) {
      it(`${role} → ${operation.name}: the Host answers 403 OPERATOR_PERMISSION_DENIED and nothing changes`, async () => {
        const before = await hostState();
        const browser = as(role);
        const csrf = csrfOf(await browser.get('/'));
        const page = await browser.post(operation.path, operation.body(csrf));
        assert.equal(page.status, 403, textOf(page.html).slice(0, 400));
        assert.ok(page.html.includes('OPERATOR_PERMISSION_DENIED'), 'the refusal is the Host’s own — the console forwarded the operation');
        assert.ok(textOf(page.html).includes('Not permitted'));
        assert.equal(await hostState(), before, 'the Host state is unchanged');
      });
    }
  }

  it('allowed roles are not refused: a responder narrows (revoke, stop), an administrator releases, a steward promotes', async () => {
    const responder = as('responder');
    let csrf = csrfOf(await responder.get('/'));
    const revoked = await responder.post(`/authority/entities/actor/${THROWAWAY}/revoke`, form({ csrf, confirm: 'yes', reason: 'responder narrows' }));
    assert.equal(revoked.status, 200, textOf(revoked.html).slice(0, 400));
    assert.equal((await q.truth(`/api/admin/authority/entities/actor/${THROWAWAY}`)).body['status'], 'revoked');
    const stopped = await responder.post('/emergency/activate', form({ csrf, confirm: 'yes', scope: 'actor', value: 'actor-nobody' }));
    assert.equal(stopped.status, 200);
    assert.ok(stopped.html.includes('actor-nobody'));
    const administrator = as('administrator');
    csrf = csrfOf(await administrator.get('/'));
    const released = await administrator.post('/emergency/release', form({ csrf, confirm: 'yes', scope: 'actor', value: 'actor-nobody' }));
    assert.equal(released.status, 200);
    assert.ok(textOf(released.html).includes('No emergency control is active.'));
    const steward = as('steward');
    const confirm = await steward.get('/profiles/deploy-production/1/activate');
    const activated = await steward.submit(confirm, (candidate) => candidate.action === '/profiles/deploy-production/1/activate', { confirm: 'yes' });
    assert.equal(activated.status, 200);
    assert.equal(((await q.truth('/api/admin/governance-profiles')).body['profiles'] as { state: string }[])[0]?.state, 'active');
  });
});

describe('CTRL-03 web — who may sign in: the credential-plane matrix', () => {
  const attempt = async (credential: string): Promise<{ readonly page: PageView; readonly browser: Browser }> => {
    const browser = q.browser('outsider');
    return { page: await browser.signIn(credential), browser };
  };

  it('a CTRL-01 administrator does not become a web operator', async () => {
    const { page, browser } = await attempt(OPERATOR_SECRETS.legacyAdministrator);
    assert.equal(page.status, 403);
    assert.ok(textOf(page.html).includes('a CTRL-01 administrator credential'));
    assert.equal([...browser.cookies.keys()].includes('frontera_console_session'), false, 'no session is created');
    assert.equal((await browser.get('/')).url.endsWith('/login'), true);
  });

  it('an unknown credential, an agent credential and an API key are refused; none gets a session', async () => {
    for (const [credential, status] of [
      ['not-an-operator-secret-000000000000000000', 401],
      [agentSecret, 401],
      [OPERATOR_SECRETS.legacyKey, 403],
    ] as const) {
      const { page, browser } = await attempt(credential);
      assert.equal(page.status, status, credential.slice(0, 12));
      assert.equal(browser.cookies.has('frontera_console_session'), false);
      assert.equal(page.html.includes(credential), false, 'a refused credential is never echoed');
    }
  });

  it('planes stay separate at the Host: an agent credential on the operator plane is 401; an operator credential as a customer is 401', async () => {
    assert.equal((await call(q.host.baseUrl, 'GET', '/api/admin/organization', { authorization: bearer(agentSecret) })).status, 401);
    for (const secret of [OPERATOR_SECRETS.administrator, OPERATOR_SECRETS.provisioner]) {
      const reply = await call(q.host.baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(secret), body: { action: 'deploy-release', resource: 'production-cluster', parameters: { replicaCount: 1, deploymentStrategy: 'rolling' }, idempotencyKey: 'plane-check-0001' } });
      assert.equal(reply.status, 401);
    }
  });
});

describe('CTRL-03 web — session, CSRF, origin and browser-input controls', () => {
  it('the session cookie is opaque, HttpOnly, SameSite=Strict; every response carries the security headers', async () => {
    const browser = q.browser('cookie-check');
    await browser.signIn(OPERATOR_SECRETS.observer);
    const setCookies = browser.transcript.flatMap((entry) => entry.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value));
    const session = setCookies.find((value) => value.startsWith('frontera_console_session=') && !value.includes('Max-Age=0'));
    assert.ok(session !== undefined);
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Strict/);
    for (const entry of browser.transcript) {
      const headers = new Map(entry.headers);
      assert.match(headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.equal(headers.get('x-frame-options'), 'DENY');
      assert.equal(headers.get('cache-control'), 'no-store');
      assert.equal(headers.get('access-control-allow-origin'), undefined, 'no cross-origin reader is allowed');
    }
    // Nor does the Host grant one: the console reaches it server-to-server.
    const hostReply = await fetch(`${q.host.baseUrl}/api/admin/organization`, { headers: { origin: 'https://attacker.example', authorization: AUTH.observer } });
    await hostReply.text();
    assert.equal(hostReply.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`${q.host.baseUrl}/api/admin/organization`, { method: 'OPTIONS', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' } });
    await preflight.text();
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });

  it('a POST without the session’s CSRF token, from another origin, or with no origin is refused and writes nothing', async () => {
    const browser = as('provisioner');
    const before = await hostState();
    const body = form({ idempotencyKey: 'csrf-check-00001', actorId: 'actor-csrf', type: 'agent', displayName: 'CSRF', issuerId: ISSUER });
    assert.equal((await browser.post('/agents', body)).status, 403, 'no token');
    const csrf = csrfOf(await browser.get('/'));
    assert.equal((await browser.post('/agents', `${body}&csrf=${csrf}`, { origin: 'https://attacker.example' })).status, 403, 'cross-origin');
    assert.equal((await browser.post('/agents', `${body}&csrf=${csrf}`, {})).status, 403, 'no origin');
    assert.equal((await browser.post('/agents', `${body}&csrf=${csrf}`, { origin: 'null' })).status, 403, 'an opaque (null) origin');
    const otherCsrf = csrfOf(await as('administrator').get('/'));
    assert.equal((await browser.post('/agents', `${body}&csrf=${otherCsrf}`)).status, 403, 'another session’s token');
    assert.equal(await hostState(), before);
  });

  it('sign-out needs the CSRF token, destroys the server-side session, and the old cookie no longer opens anything', async () => {
    const browser = q.browser('logout-check');
    const overview = await browser.signIn(OPERATOR_SECRETS.observer);
    const cookie = browser.cookies.get('frontera_console_session');
    assert.ok(cookie !== undefined);
    assert.equal((await browser.post('/logout', '')).status, 403);
    const signedOut = await browser.submit(overview, (candidate) => candidate.action === '/logout');
    assert.ok(signedOut.url.includes('/login'));
    const replay = new Browser(q.consoleOrigin, 'stolen-cookie');
    replay.cookies.set('frontera_console_session', cookie);
    const page = await replay.get('/agents');
    assert.ok(page.url.includes('/login'), 'the destroyed session opens nothing');
  });

  it('the organization is the Host’s: organization, operator, system and provenance fields smuggled into a form or a query change nothing', async () => {
    const browser = as('provisioner');
    const formPage = await browser.get('/authority/new/actor?organizationId=org-evil');
    assert.ok(textOf(formPage.html).includes('Organization org-pilot'));
    const created = await browser.submit(formPage, (candidate) => candidate.action === '/authority/new/actor', {
      actorId: 'actor-smuggle',
      type: 'human',
      displayName: 'Smuggle',
      issuerId: ISSUER,
      organizationId: 'org-evil',
      operatorId: 'ops-admin',
      system: 'true',
      provisionedBy: 'operator:ops-admin',
      tenantId: 'org-evil',
    });
    assert.equal(created.status, 200, textOf(created.html).slice(0, 400));
    const truth = (await q.truth('/api/admin/authority/entities/actor/actor-smuggle')).body;
    assert.equal(truth['organizationId'], 'org-pilot');
    assert.equal(truth['provisionedBy'], 'operator:ops-provisioner');
    const authority = await browser.get('/authority?organizationId=org-evil&kind=actor');
    assert.equal(authority.status, 200);
    assert.ok(textOf(authority.html).includes('Organization org-pilot'));
  });
});

describe('CTRL-03 web — rotation reveals the new secret once and the previous one stops working', () => {
  it('rotate through the web: confirmation, one reveal, old credential revoked at the Host, never re-shown', async () => {
    const browser = as('provisioner');
    const agent = await browser.get(`/agents/${AGENT}`);
    const credentialId = /data-credential="(agc-[0-9a-f]{32})"/.exec(agent.html)?.[1];
    assert.ok(credentialId !== undefined);
    const confirm = await browser.get(`/agents/${AGENT}/credentials/${credentialId}/rotate`);
    assert.ok(textOf(confirm.html).includes('The current credential stops authenticating the agent immediately.'));
    const rotated = await browser.submit(confirm, (candidate) => candidate.action === `/agents/${AGENT}/credentials/${credentialId}/rotate`, { confirm: 'yes' });
    assert.equal(rotated.status, 200, textOf(rotated.html).slice(0, 400));
    const fresh = revealedSecret(rotated.html);
    assert.ok(fresh !== undefined && fresh !== agentSecret);
    assert.equal(rotated.html.split(fresh).length - 1, 1);
    assert.ok(textOf(rotated.html).includes(`The previous credential ${credentialId} is now`));
    const oldUse = await call(q.host.baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(agentSecret), body: { action: 'deploy-release', resource: 'production-cluster', parameters: { replicaCount: 1, deploymentStrategy: 'rolling' }, idempotencyKey: 'rotation-old-0001' } });
    assert.equal(oldUse.status, 401, 'the rotated-out credential no longer authenticates');
    const newUse = await call(q.host.baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(fresh), body: { action: 'deploy-release', resource: 'production-cluster', parameters: { replicaCount: 1, deploymentStrategy: 'rolling' }, idempotencyKey: 'rotation-new-0001' } });
    assert.notEqual(newUse.status, 401, 'the new credential authenticates (what the agent may do is the Kernel’s decision)');
    const after = await browser.get(`/agents/${AGENT}`);
    assert.equal(after.html.includes(fresh), false);
    for (const line of [...consoleLogLines, ...logLines]) assert.equal(line.includes(fresh) || line.includes(agentSecret), false);
    for (const entry of [...browsers.values()].flatMap((candidate) => candidate.transcript)) {
      if (entry === browser.transcript.find((candidate) => candidate.body.includes(fresh))) continue;
      assert.equal(entry.body.includes(fresh), false, 'the new secret appears in exactly one response');
    }
  });
});
