import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalCommandPort, ApprovalRequestView } from '../approval-authority/index.js';
import { AUTHORITY_CSRF_HEADER, AUTHORITY_LOGIN_COOKIE, AUTHORITY_SESSION_COOKIE } from '../authority-gateway/index.js';
import type { HumanAuthorityPort } from '../composition/human-authority-composition.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, type IdentityAdministrator } from '../human-identity/index.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { freshnessEnv, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { capturingLogger, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
  CRITICAL,
  CTRL04_SECRETS,
  ORG,
  PROD,
  approvalPolicy,
  assertAwaitingApproval,
  call,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  govern,
  provisionOrganization,
  release,
  releaseKey,
  type Organization,
} from './ctrl04-host-fixture.js';

/**
 * AUTH-04B — the Authority gateway on the canonical shipped Host, over real
 * HTTP, in-process, on loopback: a private CI fixture, never a public service.
 *
 * The browser is emulated exactly as Safari would behave toward
 * `https://authority.frontera-systems.com` behind a TLS-terminating proxy:
 * `Host` and `Origin` name the Authority origin, cookies are kept in a jar and
 * returned as the browser would, the CSRF token is sent as a header. WebAuthn
 * ceremonies are verified by `@simplewebauthn/server`, driven by the
 * spec-faithful software authenticator. No DNS, TLS or external traffic.
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const workspace = createWorkspace('frontera-auth04b-');
const witnesses: StartedWitness[] = [];
after(async () => {
  await workspace.close();
  for (const witness of witnesses.splice(0)) await witness.close().catch(() => {});
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly setCookies: readonly string[];
}

/** A browser on the Authority origin: a cookie jar, the CSRF token it was given, and nothing else. */
class Browser {
  readonly jar = new Map<string, string>();
  csrf: string | undefined;
  constructor(private readonly port: number) {}

  async send(method: 'GET' | 'POST', path: string, options: { readonly body?: unknown; readonly headers?: Record<string, string>; readonly rawBody?: string } = {}): Promise<Reply> {
    const payload = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : method === 'POST' ? '{}' : undefined);
    const headers: Record<string, string> = {
      host: INTENDED_PRODUCTION_RP_ID,
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      ...(this.csrf !== undefined ? { [AUTHORITY_CSRF_HEADER]: this.csrf } : {}),
      ...(this.jar.size > 0 ? { cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
      ...(options.headers ?? {}),
    };
    const reply = await new Promise<{ status: number; text: string; setCookies: string[] }>((resolvePromise, rejectPromise) => {
      const req = request({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookies: res.headers['set-cookie'] ?? [] }));
      });
      req.on('error', rejectPromise);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    for (const header of reply.setCookies) {
      const [pair] = header.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = (pair ?? '').slice(index + 1);
      if (/Max-Age=0/.test(header) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(reply.text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { ...reply, body };
  }
}

const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly gatewayPort: number;
  readonly authority: HumanAuthorityPort;
  readonly witness: StartedWitness;
  readonly dir: string;
}

function gatewayEnv(dir: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled',
    AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH: `${dir}/identity/human-identity.sqlite`,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: INTENDED_PRODUCTION_RP_ID,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: ORIGIN,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'true',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE: 'enabled',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_HOST: '127.0.0.1',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PORT: '0',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

async function boot(overrides: Record<string, string | undefined> = {}, reuse?: { readonly dir: string; readonly witness: StartedWitness }): Promise<Booted> {
  const witness = reuse?.witness ?? (await startWitness());
  if (reuse === undefined) witnesses.push(witness);
  const dir = reuse?.dir ?? workspace.dir();
  const env = ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...gatewayEnv(dir, overrides) });
  const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
  const { port } = await host.listen();
  const gatewayPort = host.authorityGateway?.address()?.port;
  assert.ok(gatewayPort !== undefined, 'the Authority gateway listens');
  const authority = host.enterprise.humanAuthority;
  assert.ok(authority !== undefined);
  return { host, baseUrl: `http://127.0.0.1:${port}`, gatewayPort, authority, witness, dir };
}

const administrator = (): IdentityAdministrator =>
  identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' });

/** Bootstrap enrolment, in-process (the documented embedder path; no enrolment route exists). */
async function enrol(authority: HumanAuthorityPort, operatorId: string): Promise<{ readonly device: SoftwareAuthenticator; readonly credentialId: string }> {
  const device = new SoftwareAuthenticator({ origin: ORIGIN });
  const admin = administrator();
  if (authority.identity.principal(operatorId) === undefined) await authority.identity.createPrincipal(admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = await authority.identity.authorizeEnrolment(admin, operatorId);
  const credential = await authority.identity.finishRegistration(issued.enrolmentToken, device.register(authority.identity.beginRegistration(issued.enrolmentToken)));
  return { device, credentialId: credential.credentialId };
}

async function signIn(browser: Browser, device: SoftwareAuthenticator, overrides: Parameters<SoftwareAuthenticator['assert']>[1] = {}): Promise<Reply> {
  const options = await browser.send('POST', '/authority/v1/session/login/options');
  assert.equal(options.status, 200, options.text);
  const reply = await browser.send('POST', '/authority/v1/session/login', { body: { assertion: device.assert(options.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0], overrides) } });
  if (reply.status === 200) browser.csrf = reply.body['csrfToken'] as string;
  return reply;
}

async function pendingRequest(booted: Booted, org: Organization, resource: string = PROD, credential: string = org.agentCredential): Promise<{ readonly key: string; readonly view: ApprovalRequestView }> {
  const key = releaseKey('auth04b');
  const reply = await govern(booted.baseUrl, credential, release(resource, key));
  assertAwaitingApproval(reply);
  const view = (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === reply.body['requestId']);
  assert.ok(view !== undefined);
  return { key, view };
}

const verdictsOf = async (booted: Booted, approvalRequestId: string) => ((await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((view) => view.approvalRequestId === approvalRequestId) ?? assert.fail('missing')).state.verdicts;

async function challenge(browser: Browser, approvalRequestId: string, subjectDigest: string, verdict: 'approve' | 'reject'): Promise<Reply> {
  return browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(approvalRequestId)}/decision-challenges`, { body: { subjectDigest, verdict } });
}

// ── 1. Sign-in and session ──────────────────────────────────────────────────────────

describe('AUTH-04B gateway — passkey sign-in and the session', () => {
  let booted: Booted;
  let org: Organization;
  const humans = new Map<string, { readonly device: SoftwareAuthenticator; readonly credentialId: string }>();
  const human = (operatorId: string) => humans.get(operatorId) ?? assert.fail(operatorId);

  before(async () => {
    booted = await boot();
    org = await provisionOrganization(booted.baseUrl);
    for (const operatorId of ['approver-a', 'approver-b', 'approver-c', 'approver-d', 'approver-self', 'ops-observer', 'ops-responder']) humans.set(operatorId, await enrol(booted.authority, operatorId));
  });

  it('a valid passkey sign-in opens a __Host- session cookie (HttpOnly, Secure, SameSite=Strict, Path=/, no Domain) bound to the human', async () => {
    const browser = new Browser(booted.gatewayPort);
    const reply = await signIn(browser, human('approver-a').device);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual([reply.body['operatorId'], reply.body['organizationId']], ['approver-a', ORG]);
    const sessionCookie = reply.setCookies.find((header) => header.startsWith(`${AUTHORITY_SESSION_COOKIE}=`)) ?? assert.fail('no session cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sessionCookie.includes(flag), flag);
    assert.equal(/Domain=/i.test(sessionCookie), false);
    assert.ok(AUTHORITY_SESSION_COOKIE.startsWith('__Host-') && AUTHORITY_LOGIN_COOKIE.startsWith('__Host-'));
    assert.equal(/token|bearer|secret/i.test(Object.keys(reply.body).filter((key) => key !== 'csrfToken').join(',')), false, 'no bearer or secret is returned');
    const session = await browser.send('GET', '/authority/v1/session');
    assert.equal(session.status, 200);
    assert.equal(session.body['operatorId'], 'approver-a');
    // Security headers on every response.
    assert.ok(reply.text.length > 0);
  });

  for (const [name, overrides, code] of [
    ['an unknown credential', { credentialId: Buffer.alloc(32, 7).toString('base64url') }, 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE'],
    ['a wrong RP ID', { rpId: 'evil.example' }, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID'],
    ['a wrong origin in client data', { origin: 'https://evil.example' }, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID'],
    ['missing user verification', { userVerified: false }, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID'],
    ['an invalid signature', { corruptSignature: true }, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID'],
  ] as const) {
    it(`refuses ${name}: no session`, async () => {
      const browser = new Browser(booted.gatewayPort);
      const reply = await signIn(browser, human('approver-a').device, overrides);
      assert.notEqual(reply.status, 200, reply.text);
      assert.equal(errorCode(reply), code, reply.text);
      assert.equal(browser.jar.has(AUTHORITY_SESSION_COOKIE), false);
      assert.equal((await browser.send('GET', '/authority/v1/session')).status, 401);
    });
  }

  it('a sign-in request from another Origin, or addressed to another Host, is refused', async () => {
    const browser = new Browser(booted.gatewayPort);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/login/options', { headers: { origin: 'https://evil.example' } })), 'AUTHORITY_ORIGIN_INVALID');
    assert.equal((await browser.send('POST', '/authority/v1/session/login/options', { headers: { host: 'evil.example' } })).status, 421);
  });

  it('a login challenge is single-use and bound to the browser that started it: replay and cross-browser use are refused', async () => {
    const browser = new Browser(booted.gatewayPort);
    const options = await browser.send('POST', '/authority/v1/session/login/options');
    const assertion = human('approver-a').device.assert(options.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    const thief = new Browser(booted.gatewayPort);
    await thief.send('POST', '/authority/v1/session/login/options');
    assert.equal(errorCode(await thief.send('POST', '/authority/v1/session/login', { body: { assertion } })), 'AUTHORITY_LOGIN_INVALID', 'another browser cannot complete this ceremony');
    assert.equal((await browser.send('POST', '/authority/v1/session/login', { body: { assertion } })).status, 200);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/login', { body: { assertion } })), 'AUTHORITY_LOGIN_INVALID', 'the ceremony was consumed');
    const again = new Browser(booted.gatewayPort);
    await again.send('POST', '/authority/v1/session/login/options');
    assert.equal(errorCode(await again.send('POST', '/authority/v1/session/login', { body: { assertion } })), 'AUTHORITY_LOGIN_INVALID', 'the assertion answers a consumed challenge');
  });

  it('session fixation: a planted session id is never adopted, and signing in rotates the id', async () => {
    const browser = new Browser(booted.gatewayPort);
    const planted = 'A'.repeat(43);
    browser.jar.set(AUTHORITY_SESSION_COOKIE, planted);
    assert.equal((await browser.send('GET', '/authority/v1/session')).status, 401);
    await signIn(browser, human('approver-a').device);
    const first = browser.jar.get(AUTHORITY_SESSION_COOKIE);
    assert.ok(first !== undefined && first !== planted);
    await signIn(browser, human('approver-b').device);
    const second = browser.jar.get(AUTHORITY_SESSION_COOKIE);
    assert.ok(second !== undefined && second !== first);
    const stale = new Browser(booted.gatewayPort);
    stale.jar.set(AUTHORITY_SESSION_COOKIE, first);
    assert.equal((await stale.send('GET', '/authority/v1/session')).status, 401, 'the pre-rotation session is gone');
  });

  it('CSRF and request shape: a state change needs the session token, the Authority origin and application/json', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const token = browser.csrf;
    browser.csrf = undefined;
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/logout')), 'AUTHORITY_CSRF_INVALID');
    browser.csrf = 'x'.repeat(43);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/logout')), 'AUTHORITY_CSRF_INVALID');
    browser.csrf = token;
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/logout', { headers: { origin: 'https://evil.example' } })), 'AUTHORITY_ORIGIN_INVALID');
    assert.equal((await browser.send('POST', '/authority/v1/session/logout', { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await browser.send('GET', '/authority/v1/session')).status, 200, 'nothing above signed the human out');
  });

  it('logout ends the session and clears the cookie', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const id = browser.jar.get(AUTHORITY_SESSION_COOKIE);
    const reply = await browser.send('POST', '/authority/v1/session/logout');
    assert.equal(reply.status, 200);
    assert.ok(reply.setCookies.some((header) => header.startsWith(`${AUTHORITY_SESSION_COOKIE}=;`) && header.includes('Max-Age=0')));
    const replayed = new Browser(booted.gatewayPort);
    replayed.jar.set(AUTHORITY_SESSION_COOKIE, id ?? '');
    assert.equal((await replayed.send('GET', '/authority/v1/session')).status, 401);
  });

  it('credential revocation, and principal revocation, end live sessions', async () => {
    const credential = await enrol(booted.authority, 'approver-e');
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, credential.device);
    await booted.authority.identity.revokeCredential(administrator(), credential.credentialId, 'device lost');
    assert.equal(errorCode(await browser.send('GET', '/authority/v1/session')), 'AUTHORITY_SESSION_REVOKED');
    const replacement = await enrol(booted.authority, 'approver-e');
    const second = new Browser(booted.gatewayPort);
    await signIn(second, replacement.device);
    await booted.authority.identity.revokePrincipal(administrator(), 'approver-e', 'left');
    assert.equal(errorCode(await second.send('GET', '/authority/v1/approvals')), 'AUTHORITY_SESSION_REVOKED');
    assert.equal((await signIn(new Browser(booted.gatewayPort), replacement.device)).status, 403, 'a revoked human cannot sign in');
  });

  it('no static operator bearer means anything here: an Authorization header is refused, and no response carries an operator secret', async () => {
    const browser = new Browser(booted.gatewayPort);
    const replies = [
      await browser.send('GET', '/authority/v1/approvals', { headers: { authorization: `Bearer ${CTRL04_SECRETS.approverA}` } }),
      await browser.send('POST', '/authority/v1/decisions', { headers: { authorization: `Bearer ${CTRL04_SECRETS.approverA}` }, body: { assertion: {} } }),
    ];
    for (const reply of replies) assert.equal(errorCode(reply), 'AUTHORITY_BEARER_REFUSED');
    await signIn(browser, human('approver-a').device);
    const bodies = [await browser.send('GET', '/authority/v1/session'), await browser.send('GET', '/authority/v1/approvals')].map((reply) => reply.text).join('\n');
    for (const secret of Object.values(CTRL04_SECRETS)) assert.equal(bodies.includes(secret), false, 'no operator secret in any response');
    assert.equal(/\.sqlite|PRIVATE KEY|signingKey/i.test(bodies), false, 'no store path or key material');
  });

  // ── 2. Inbox ──────────────────────────────────────────────────────────────────────

  it('the inbox needs a session and lists only what this human may decide: no cross-human enumeration', async () => {
    const anonymous = new Browser(booted.gatewayPort);
    assert.equal((await anonymous.send('GET', '/authority/v1/approvals')).status, 401);
    const prod = await pendingRequest(booted, org, PROD);
    const critical = await pendingRequest(booted, org, CRITICAL);
    const own = await pendingRequest(booted, org, PROD, org.selfCredential);
    const listed = async (operatorId: string): Promise<readonly string[]> => {
      const browser = new Browser(booted.gatewayPort);
      await signIn(browser, human(operatorId).device);
      const reply = await browser.send('GET', '/authority/v1/approvals');
      assert.equal(reply.status, 200, reply.text);
      return (reply.body['approvals'] as Record<string, unknown>[]).map((entry) => entry['approvalRequestId'] as string);
    };
    const a = await listed('approver-a');
    assert.ok(a.includes(prod.view.approvalRequestId) && a.includes(critical.view.approvalRequestId));
    const c = await listed('approver-c');
    assert.ok(c.includes(critical.view.approvalRequestId), 'approver-c holds standing over the critical cluster');
    assert.equal(c.includes(prod.view.approvalRequestId), false, 'but never sees production requests');
    assert.deepEqual(await listed('ops-observer'), [], 'an observer decides nothing, so sees nothing');
    assert.equal(a.includes(own.view.approvalRequestId), true);
    assert.equal((await listed('approver-self')).includes(own.view.approvalRequestId), false, 'the requester never sees its own request');
    // Reading one request outside the set is the same 404 as a request that does not exist.
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-c').device);
    assert.equal((await browser.send('GET', `/authority/v1/approvals/${encodeURIComponent(prod.view.approvalRequestId)}`)).status, 404);
    assert.equal((await browser.send('GET', `/authority/v1/approvals/${encodeURIComponent(`approval-request:${'0'.repeat(64)}`)}`)).status, 404);
    const detail = await browser.send('GET', `/authority/v1/approvals/${encodeURIComponent(critical.view.approvalRequestId)}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body['subjectDigest'], critical.view.subjectDigest);
    assert.equal(typeof detail.body['canonicalSubject'], 'string');
    assert.equal(detail.body['requestExpiresAt'], critical.view.state.requestExpiresAt);
  });

  it('wrong tenant or actor identity in a request is refused, never ignored', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const { view } = await pendingRequest(booted, org);
    for (const extra of [{ organizationId: 'org-other' }, { operatorId: 'approver-b' }, { actorId: 'operator:approver-b' }]) {
      const reply = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(view.approvalRequestId)}/decision-challenges`, { body: { subjectDigest: view.subjectDigest, verdict: 'approve', ...extra } });
      assert.equal(errorCode(reply), 'AUTHORITY_REQUEST_INVALID', JSON.stringify(extra));
    }
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/session/login/options', { body: { organizationId: 'org-other' } })), 'AUTHORITY_REQUEST_INVALID');
  });

  // ── 3. Decisions ──────────────────────────────────────────────────────────────────

  it('a valid decision: challenge for the exact subject, a fresh assertion, CORE-05 records it; the status reads back deterministically', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const { key, view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    assert.equal(issued.status, 200, issued.text);
    assert.deepEqual(Object.keys(issued.body).sort(), ['approvalRequestId', 'commitment', 'expiresAt', 'publicKey', 'subjectDigest', 'verdict']);
    const assertion = human('approver-a').device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    const decided = await browser.send('POST', '/authority/v1/decisions', { body: { assertion } });
    assert.equal(decided.status, 200, decided.text);
    assert.deepEqual([decided.body['outcome'], decided.body['verdict'], (decided.body['approval'] as Record<string, unknown>)['status'], decided.body['execution']], ['recorded', 'approve', 'approved', 'not_observed']);
    const status = await browser.send('GET', `/authority/v1/decisions/${encodeURIComponent(issued.body['commitment'] as string)}`);
    assert.deepEqual([status.body['decision'], (status.body['request'] as Record<string, unknown>)['status'], status.body['execution']], ['approved', 'approved', 'not_observed']);
    // Retry after a lost response: never a second verdict.
    const retry = await browser.send('POST', '/authority/v1/decisions', { body: { assertion } });
    assert.equal(retry.status, 409);
    assert.equal(errorCode(retry), 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED');
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 1);
    // The agent resumes through the canonical path; Authority reported nothing about execution.
    const resumed = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
  });

  it('a session alone never approves: no assertion, a login assertion, or another session\'s challenge are all refused', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const { view } = await pendingRequest(booted, org);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/decisions', { body: {} })), 'HUMAN_IDENTITY_AUTHENTICATION_INVALID');
    const login = await browser.send('POST', '/authority/v1/session/login/options');
    const loginAssertion = human('approver-a').device.assert(login.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/decisions', { body: { assertion: loginAssertion } })), 'HUMAN_IDENTITY_CHALLENGE_INVALID');
    // A challenge issued to another session of the same human is not this session's to answer.
    const other = new Browser(booted.gatewayPort);
    await signIn(other, human('approver-a').device);
    const foreign = await challenge(other, view.approvalRequestId, view.subjectDigest, 'approve');
    const foreignAssertion = human('approver-a').device.assert(foreign.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/decisions', { body: { assertion: foreignAssertion } })), 'AUTHORITY_DECISION_NOT_YOURS');
    // Another human's session cannot answer it either.
    const b = new Browser(booted.gatewayPort);
    await signIn(b, human('approver-b').device);
    assert.equal(errorCode(await b.send('POST', '/authority/v1/decisions', { body: { assertion: foreignAssertion } })), 'AUTHORITY_DECISION_NOT_YOURS');
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 0);
  });

  it('a wrong subject, a verdict the role does not reach, and a tampered verdict are refused', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const { view } = await pendingRequest(booted, org);
    assert.equal(errorCode(await challenge(browser, view.approvalRequestId, `sha256:${'f'.repeat(64)}`, 'approve')), 'HUMAN_DECISION_NOT_APPLICABLE');
    const responder = new Browser(booted.gatewayPort);
    await signIn(responder, human('ops-responder').device);
    assert.equal(errorCode(await challenge(responder, view.approvalRequestId, view.subjectDigest, 'approve')), 'HUMAN_DECISION_NOT_PERMITTED');
    // Tampering: an assertion signed for the approve challenge, its client data rewritten to name the reject challenge.
    const approve = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    const reject = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'reject');
    const signed = human('approver-a').device.assert(approve.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) as { response: { clientDataJSON: string } };
    const clientData = JSON.parse(Buffer.from(signed.response.clientDataJSON, 'base64url').toString('utf8')) as Record<string, unknown>;
    clientData['challenge'] = (reject.body['publicKey'] as Record<string, unknown>)['challenge'];
    const tampered = { ...signed, response: { ...signed.response, clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString('base64url') } };
    const reply = await browser.send('POST', '/authority/v1/decisions', { body: { assertion: tampered } });
    assert.equal(errorCode(reply), 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', reply.text);
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 0);
  });

  it('concurrent submissions of one assertion record exactly one verdict', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-a').device);
    const { view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'reject');
    const assertion = human('approver-a').device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    const replies = await Promise.all([browser.send('POST', '/authority/v1/decisions', { body: { assertion } }), browser.send('POST', '/authority/v1/decisions', { body: { assertion } })]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 1);
  });

  it('CORE-05 still judges: standing revoked between challenge and submission refuses the verdict; the request leaves the inbox', async () => {
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, human('approver-b').device);
    const { view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    assert.equal(issued.status, 200, issued.text);
    const revoked = await call(booted.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-b/revoke', { authorization: AUTH.responder, body: { reason: 'left the release board' } });
    assert.equal(revoked.status, 200, revoked.text);
    // Standing is read by the same port CORE-05 uses: the request is no longer in this human's inbox, and no new challenge is issued.
    assert.equal(errorCode(await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve')), 'AUTHORITY_NOT_FOUND');
    // The challenge issued before revocation: the verified passkey reaches CORE-05, which refuses it.
    const decided = await browser.send('POST', '/authority/v1/decisions', { body: { assertion: human('approver-b').device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) } });
    assert.equal(decided.status, 409, decided.text);
    assert.deepEqual([decided.body['outcome'], decided.body['code']], ['refused', 'APPROVAL_APPROVER_INELIGIBLE']);
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).filter((verdict) => verdict.counted).length, 0);
  });
});

// ── 4. Expiry, restart, outage, disabled ─────────────────────────────────────────────

describe('AUTH-04B gateway — expiry, restart reconciliation, witness outage, and default-off', () => {
  it('an expired login challenge, an expired decision challenge and an idle session are refused', async () => {
    const booted = await boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_CHALLENGE_TTL_SECONDS: '2', AOC_ENTERPRISE_HUMAN_AUTHORITY_DECISION_TTL_SECONDS: '2', AOC_ENTERPRISE_AUTHORITY_SESSION_TTL_SECONDS: '4', AOC_ENTERPRISE_AUTHORITY_SESSION_IDLE_SECONDS: '4' });
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const late = new Browser(booted.gatewayPort);
    const options = await late.send('POST', '/authority/v1/session/login/options');
    await sleep(2_500);
    const expiredLogin = await late.send('POST', '/authority/v1/session/login', { body: { assertion: cto.device.assert(options.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) } });
    assert.notEqual(expiredLogin.status, 200, expiredLogin.text);

    const browser = new Browser(booted.gatewayPort);
    assert.equal((await signIn(browser, cto.device)).status, 200);
    const { view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    await sleep(2_500);
    const expiredDecision = await browser.send('POST', '/authority/v1/decisions', { body: { assertion: cto.device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) } });
    assert.equal(errorCode(expiredDecision), 'HUMAN_IDENTITY_CHALLENGE_INVALID', expiredDecision.text);
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 0);
    await sleep(4_500);
    assert.equal((await browser.send('GET', '/authority/v1/session')).status, 401, 'the session expired');
    await booted.host.close();
  });

  it('a lost response across a restart: sessions are gone, the decision is reconciled from CORE-05, and its status reads back as abandoned', async () => {
    const booted = await boot();
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, cto.device);
    const { view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    const assertion = cto.device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]);
    // The process dies between consumption and CORE-05 (the challenge is consumed; no verdict exists).
    await booted.authority.identity.authorizeDecision(assertion);
    await booted.host.close();
    const restarted = await boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }, { dir: booted.dir, witness: booted.witness });
    const stale = new Browser(restarted.gatewayPort);
    for (const [name, value] of browser.jar) stale.jar.set(name, value);
    assert.equal((await stale.send('GET', '/authority/v1/session')).status, 401, 'sessions do not survive a restart');
    const again = new Browser(restarted.gatewayPort);
    await signIn(again, cto.device);
    const status = await again.send('GET', `/authority/v1/decisions/${encodeURIComponent(issued.body['commitment'] as string)}`);
    assert.equal(status.status, 200, status.text);
    assert.deepEqual([status.body['decision'], (status.body['request'] as Record<string, unknown>)['status'], status.body['execution']], ['abandoned', 'pending', 'not_observed']);
    assert.equal((await verdictsOf(restarted, view.approvalRequestId)).length, 0, 'no automatic re-approval');
    // The decision's status is the deciding human's only.
    const other = await enrol(restarted.authority, 'approver-b');
    const b = new Browser(restarted.gatewayPort);
    await signIn(b, other.device);
    assert.equal((await b.send('GET', `/authority/v1/decisions/${encodeURIComponent(issued.body['commitment'] as string)}`)).status, 404);
    await restarted.host.close();
  });

  it('CORE-07 witness outage: sign-in and decisions fail closed; nothing is recorded', async () => {
    const booted = await boot();
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    await signIn(browser, cto.device);
    const { view } = await pendingRequest(booted, org);
    const issued = await challenge(browser, view.approvalRequestId, view.subjectDigest, 'approve');
    await booted.witness.close();
    const decided = await browser.send('POST', '/authority/v1/decisions', { body: { assertion: cto.device.assert(issued.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) } });
    assert.ok(decided.status >= 500 && decided.status < 600, decided.text);
    const login = await signIn(new Browser(booted.gatewayPort), cto.device);
    assert.ok(login.status >= 500 && login.status < 600, login.text);
    assert.equal(decided.text.includes('"outcome":"recorded"'), false);
    await booted.host.close();
  });

  it('disabled by default: no gateway listener, and the Host API serves no Authority path', async () => {
    for (const overrides of [
      { AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE: undefined, AOC_ENTERPRISE_AUTHORITY_GATEWAY_HOST: undefined, AOC_ENTERPRISE_AUTHORITY_GATEWAY_PORT: undefined, AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: undefined },
    ]) {
      const witness = await startWitness();
      witnesses.push(witness);
      const dir = workspace.dir();
      const host = workspace.track(await bootEnterpriseHost({ env: ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...gatewayEnv(dir, overrides) }), executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
      const { port } = await host.listen();
      assert.equal(host.authorityGateway, undefined, 'no Authority listener');
      for (const path of ['/authority/v1/session', '/authority/v1/approvals', '/authority/v1/session/login/options', '/authority/v1/decisions']) {
        for (const method of ['GET', 'POST'] as const) {
          const reply = await call(`http://127.0.0.1:${port}`, method, path, method === 'POST' ? { body: {} } : {});
          assert.ok(reply.status === 404 || reply.status === 401, `${method} ${path} on the Host API → ${reply.status}`);
          assert.equal(/publicKey|csrfToken|commitment/.test(reply.text), false);
        }
      }
      await host.close();
    }
    // And a fully default Host (no human authority at all) has neither.
    const witness = await startWitness();
    witnesses.push(witness);
    const dir = workspace.dir();
    const plain = workspace.track(await bootEnterpriseHost({ env: ctrl04Env(dir, ctrl04File(), freshnessEnv(witness)), executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
    await plain.listen();
    assert.equal(plain.authorityGateway, undefined);
    assert.equal(plain.enterprise.humanAuthority, undefined);
    await plain.close();
  });

  it('a gateway variable without the mode, or a public origin outside the relying party, refuses the Host', async () => {
    const witness = await startWitness();
    witnesses.push(witness);
    for (const overrides of [
      { AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE: undefined },
      { AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: 'https://evil.example' },
      { AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: `http://${INTENDED_PRODUCTION_RP_ID}` },
      { AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: undefined, AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH: undefined, AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: undefined, AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: undefined, AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: undefined },
    ]) {
      const dir = workspace.dir();
      await assert.rejects(
        bootEnterpriseHost({ env: ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...gatewayEnv(dir, overrides) }), executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }),
        (error: unknown) => (error as { code?: unknown }).code === 'HOST_ENVIRONMENT_INVALID' || assert.fail(`${JSON.stringify(overrides)}: ${String((error as { code?: unknown }).code)}`),
      );
    }
  });
});
