import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ApprovalCommandPort } from '../approval-authority/index.js';
import { AUTHORITY_CSRF_HEADER, AUTHORITY_ENROLMENT_COOKIE, AUTHORITY_SESSION_COOKIE, createAuthorityGateway } from '../authority-gateway/index.js';
import type { HumanAuthorityPort } from '../composition/human-authority-composition.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, type RegistrationOptionsJSON } from '../human-identity/index.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { freshnessEnv, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { capturingLogger, logLines, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
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
  type Reply as HostReply,
} from './ctrl04-host-fixture.js';

/**
 * AUTH-04B2 — secure CTO passkey enrolment on the canonical shipped Host.
 *
 * An organization administrator, authenticated by the existing private CTRL-02
 * operator plane, registers a named human and issues a one-time invitation; the
 * named human redeems it on the Authority gateway (loopback, in-process: a
 * private CI fixture) by registering their own passkey. Ceremonies are verified
 * by `@simplewebauthn/server`, driven by the spec-faithful software
 * authenticator. No invitation is delivered anywhere; no DNS or TLS exists.
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const workspace = createWorkspace('frontera-auth04b2-');
const witnesses: StartedWitness[] = [];
const issuedTokens: string[] = [];
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

class Browser {
  readonly jar = new Map<string, string>();
  csrf: string | undefined;
  constructor(private readonly port: number) {}

  async send(method: 'GET' | 'POST', path: string, options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {}): Promise<Reply> {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : method === 'POST' ? '{}' : undefined;
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
      const pair = header.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
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

const errorCode = (reply: Reply | HostReply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];
const failureOf = (reply: HostReply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['failure'];

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly gatewayPort: number;
  readonly authority: HumanAuthorityPort;
  readonly witness: StartedWitness;
  readonly dir: string;
}

const identityPath = (dir: string): string => `${dir}/identity/human-identity.sqlite`;

function enrolmentEnv(dir: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled',
    AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH: identityPath(dir),
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
  witnesses.push(witness);
  const dir = reuse?.dir ?? workspace.dir();
  const env = ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...enrolmentEnv(dir, overrides) });
  const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
  const { port } = await host.listen();
  const gatewayPort = host.authorityGateway?.address()?.port;
  assert.ok(gatewayPort !== undefined);
  const authority = host.enterprise.humanAuthority;
  assert.ok(authority !== undefined);
  return { host, baseUrl: `http://127.0.0.1:${port}`, gatewayPort, authority, witness, dir };
}

// ── The private administrator plane ────────────────────────────────────────────────

const admin = (booted: Booted, method: 'GET' | 'POST', path: string, authorization: string = AUTH.administrator, body?: unknown): Promise<HostReply> =>
  call(booted.baseUrl, method, path, { authorization, ...(body !== undefined ? { body } : method === 'POST' ? { body: {} } : {}) });

async function registerHuman(booted: Booted, operatorId: string): Promise<void> {
  const reply = await admin(booted, 'POST', '/api/admin/passkey-humans', AUTH.administrator, { operatorId, displayName: `Human ${operatorId}` });
  assert.equal(reply.status, 200, reply.text);
}

async function invite(booted: Booted, operatorId: string): Promise<{ readonly token: string; readonly enrolmentId: string; readonly reply: HostReply }> {
  const reply = await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.administrator, { operatorId });
  assert.equal(reply.status, 200, reply.text);
  const invitation = reply.body['invitation'] as Record<string, unknown>;
  const token = invitation['token'] as string;
  issuedTokens.push(token);
  return { token, enrolmentId: invitation['enrolmentId'] as string, reply };
}

// ── The named human on the Authority gateway ────────────────────────────────────────

type RegistrationOverrides = Parameters<SoftwareAuthenticator['register']>[1];

async function enrolOn(browser: Browser, token: string, device: SoftwareAuthenticator, overrides: RegistrationOverrides = {}): Promise<Reply> {
  const options = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
  if (options.status !== 200) return options;
  return browser.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential: device.register(options.body['publicKey'] as RegistrationOptionsJSON, overrides) } });
}

async function signIn(browser: Browser, device: SoftwareAuthenticator): Promise<Reply> {
  const options = await browser.send('POST', '/authority/v1/session/login/options');
  const reply = await browser.send('POST', '/authority/v1/session/login', { body: { assertion: device.assert(options.body['publicKey'] as Parameters<SoftwareAuthenticator['assert']>[0]) } });
  if (reply.status === 200) browser.csrf = reply.body['csrfToken'] as string;
  return reply;
}

const device = (): SoftwareAuthenticator => new SoftwareAuthenticator({ origin: ORIGIN });

async function describeHuman(booted: Booted, operatorId: string): Promise<Record<string, unknown>> {
  const reply = await admin(booted, 'GET', `/api/admin/passkey-humans/${operatorId}`);
  assert.equal(reply.status, 200, reply.text);
  return reply.body['human'] as Record<string, unknown>;
}

/** Issues one invitation over raw HTTP and returns its Cache-Control header. */
async function cacheControlOfInvitation(booted: Booted): Promise<string | undefined> {
  const url = new URL('/api/admin/passkey-invitations', booted.baseUrl);
  const payload = JSON.stringify({ operatorId: 'approver-a' });
  const result = await new Promise<{ cacheControl: string | undefined; text: string }>((resolvePromise, rejectPromise) => {
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: url.pathname, headers: { authorization: AUTH.administrator, 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ cacheControl: typeof res.headers['cache-control'] === 'string' ? res.headers['cache-control'] : undefined, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectPromise);
    req.write(payload);
    req.end();
  });
  const token = (JSON.parse(result.text) as { invitation?: { token?: string } }).invitation?.token;
  if (token !== undefined) issuedTokens.push(token);
  return result.cacheControl;
}

const verdictCount = async (booted: Booted): Promise<number> => (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).reduce((total, view) => total + view.state.verdicts.length, 0);

// ── 1. Administrative boundary ──────────────────────────────────────────────────────

describe('AUTH-04B2 — the administrator issues invitations on the private operator plane; identity only', () => {
  let booted: Booted;
  let org: Organization;
  before(async () => {
    booted = await boot();
    org = await provisionOrganization(booted.baseUrl);
  });

  it('only an organization administrator may register a human or issue an invitation; no other operator, the legacy administrator or a customer key', async () => {
    assert.equal((await admin(booted, 'POST', '/api/admin/passkey-humans', '', { operatorId: 'approver-a', displayName: 'CTO' })).status, 401);
    for (const authorization of [AUTH.observer, AUTH.responder, AUTH.provisioner, AUTH.steward, AUTH.approverA, AUTH.legacyAdministrator]) {
      const human = await admin(booted, 'POST', '/api/admin/passkey-humans', authorization, { operatorId: 'approver-a', displayName: 'CTO' });
      assert.ok(human.status === 403 || human.status === 401, `${human.status} ${human.text}`);
      const invitation = await admin(booted, 'POST', '/api/admin/passkey-invitations', authorization, { operatorId: 'approver-a' });
      assert.ok(invitation.status === 403 || invitation.status === 401, `${invitation.status}`);
      assert.equal(/fre1\./.test(invitation.text), false);
    }
    assert.ok([401, 403].includes((await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.legacyKey, { operatorId: 'approver-a' })).status));
    assert.equal((await admin(booted, 'GET', '/api/admin/passkey-humans/approver-a')).status, 404, 'nothing was created');
  });

  it('the target is explicit and must be an existing, active, configured human; creation is a separate act; no role, organization or authority field is accepted', async () => {
    assert.equal((await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.administrator, { operatorId: 'approver-a' })).status, 404, 'no principal yet: invitation refused');
    assert.equal((await admin(booted, 'POST', '/api/admin/passkey-humans', AUTH.administrator, { operatorId: 'ghost', displayName: 'Ghost' })).status, 404, 'not a configured operator');
    for (const extra of [{ role: 'organization-administrator' }, { organizationId: 'org-other' }, { permissions: ['approval.approve'] }, { standing: 'approve-release' }]) {
      assert.equal((await admin(booted, 'POST', '/api/admin/passkey-humans', AUTH.administrator, { operatorId: 'approver-a', displayName: 'CTO', ...extra })).status, 400, JSON.stringify(extra));
      assert.equal((await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.administrator, { operatorId: 'approver-a', ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.administrator, {})).status, 400, 'the target is explicit');
    await registerHuman(booted, 'approver-a');
    const again = await admin(booted, 'POST', '/api/admin/passkey-humans', AUTH.administrator, { operatorId: 'approver-a', displayName: 'Again' });
    assert.equal(again.status, 409);
    assert.equal(failureOf(again), 'HUMAN_IDENTITY_PRINCIPAL_EXISTS');
  });

  it('an invitation: a one-time token shown once (no-store), ≤ 15 minutes, for one human; at most three open at once; revocable', async () => {
    const issued = await invite(booted, 'approver-a');
    assert.match(issued.token, /^fre1\.enr-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    const invitation = issued.reply.body['invitation'] as Record<string, unknown>;
    assert.equal(invitation['operatorId'], 'approver-a');
    assert.ok(Date.parse(invitation['expiresAt'] as string) - Date.now() <= 15 * 60 * 1000 + 5_000, 'at most 15 minutes');
    // The second invitation, fetched raw to read its headers.
    assert.equal(await cacheControlOfInvitation(booted), 'no-store', 'the token response is never cached');
    const third = await invite(booted, 'approver-a');
    const fourth = await admin(booted, 'POST', '/api/admin/passkey-invitations', AUTH.administrator, { operatorId: 'approver-a' });
    assert.equal(fourth.status, 409);
    assert.equal(failureOf(fourth), 'HUMAN_IDENTITY_ENROLMENT_LIMIT');
    const revoked = await admin(booted, 'POST', `/api/admin/passkey-invitations/${third.enrolmentId}/revoke`, AUTH.administrator, { reason: 'handed to the wrong person' });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((revoked.body['invitation'] as Record<string, unknown>)['state'], 'revoked');
    assert.equal((await admin(booted, 'POST', `/api/admin/passkey-invitations/${third.enrolmentId}/revoke`, AUTH.administrator, { reason: 'again' })).status, 409);
    // The read never carries a token: only states.
    const human = await admin(booted, 'GET', '/api/admin/passkey-humans/approver-a');
    assert.equal(human.text.includes(issued.token) || /fre1\./.test(human.text), false);
    const states = ((human.body['human'] as Record<string, unknown>)['invitations'] as Record<string, unknown>[]).map((entry) => entry['state']).sort();
    assert.deepEqual(states, ['open', 'open', 'revoked']);
    // The revoked invitation is refused on the gateway, indistinguishably from garbage.
    const browser = new Browser(booted.gatewayPort);
    const refused = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: third.token } });
    const garbage = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'fre1.nope' } });
    assert.deepEqual([refused.status, errorCode(refused)], [403, 'AUTHORITY_ENROLMENT_INVALID']);
    assert.equal(refused.text, garbage.text, 'one indistinguishable answer');
    void org;
  });
});

// ── 2. Registration on the gateway ──────────────────────────────────────────────────

describe('AUTH-04B2 — the named human registers one passkey with the invitation; no session, no authority', () => {
  let booted: Booted;
  let org: Organization;
  before(async () => {
    booted = await boot();
    org = await provisionOrganization(booted.baseUrl);
    for (const operatorId of ['approver-a', 'approver-b', 'approver-c', 'approver-nostanding']) await registerHuman(booted, operatorId);
  });

  it('valid registration binds the passkey to the named human, opens no session, and grants nothing: roles, standing and approvals are unchanged', async () => {
    const { view } = await (async () => {
      const key = releaseKey('auth04b2');
      const reply = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
      assertAwaitingApproval(reply);
      return { view: (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === reply.body['requestId']) };
    })();
    assert.ok(view !== undefined);
    const permissionsOf = async (): Promise<unknown> => ((await call(booted.baseUrl, 'GET', '/api/admin/organization', { authorization: AUTH.approverA })).body['operator'] as Record<string, unknown> | undefined)?.['permissions'];
    const permissionsBefore = await permissionsOf();
    assert.ok(Array.isArray(permissionsBefore));
    const verdictsBefore = await verdictCount(booted);
    const cto = device();
    const { token } = await invite(booted, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    const options = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.equal(options.status, 200, options.text);
    const publicKey = options.body['publicKey'] as RegistrationOptionsJSON;
    assert.equal(publicKey.user.name, 'approver-a', 'the passkey is created for the predetermined human');
    assert.equal(publicKey.rp.id, INTENDED_PRODUCTION_RP_ID);
    assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
    assert.ok(options.setCookies.some((header) => header.startsWith(`${AUTHORITY_ENROLMENT_COOKIE}=`) && /HttpOnly/.test(header) && /Secure/.test(header) && /SameSite=Strict/.test(header)));
    const registered = await browser.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential: cto.register(publicKey) } });
    assert.equal(registered.status, 201, registered.text);
    assert.deepEqual(registered.body, { registered: true });
    assert.equal(registered.setCookies.some((header) => header.startsWith(`${AUTHORITY_SESSION_COOKIE}=`)), false, 'no implicit session');
    assert.equal((await browser.send('GET', '/authority/v1/session')).status, 401);
    // Bound to approver-a only.
    const human = await describeHuman(booted, 'approver-a');
    assert.deepEqual((human['credentials'] as Record<string, unknown>[]).map((credential) => [credential['credentialId'], credential['state']]), [[cto.id, 'active']]);
    assert.deepEqual((await describeHuman(booted, 'approver-b'))['credentials'], []);
    // Nothing else changed: the operator's permissions, CORE-05's verdicts.
    assert.deepEqual(await permissionsOf(), permissionsBefore);
    assert.equal(await verdictCount(booted), verdictsBefore);
    // The human signs in separately; what they see is exactly their existing standing.
    const signedIn = new Browser(booted.gatewayPort);
    assert.equal((await signIn(signedIn, cto)).status, 200);
    const inbox = await signedIn.send('GET', '/authority/v1/approvals');
    assert.ok((inbox.body['approvals'] as Record<string, unknown>[]).some((entry) => entry['approvalRequestId'] === view.approvalRequestId));
    // A human with no approval standing gains none by enrolling.
    const noStanding = device();
    const { token: nsToken } = await invite(booted, 'approver-nostanding');
    assert.equal((await enrolOn(new Browser(booted.gatewayPort), nsToken, noStanding)).status, 201);
    const ns = new Browser(booted.gatewayPort);
    await signIn(ns, noStanding);
    assert.deepEqual((await ns.send('GET', '/authority/v1/approvals')).body['approvals'], []);
    // The invitation is single-use.
    const reused = await new Browser(booted.gatewayPort).send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.deepEqual([reused.status, errorCode(reused)], [403, 'AUTHORITY_ENROLMENT_INVALID']);
  });

  it('a missing or wrong-shaped invitation, a revoked principal, and an invitation from another Host are refused alike', async () => {
    const browser = new Browser(booted.gatewayPort);
    for (const body of [{}, { invitation: '' }, { invitation: 42 }, { invitation: `fre1.enr-${'0'.repeat(32)}.${'A'.repeat(43)}` }]) {
      const reply = await browser.send('POST', '/authority/v1/enrolment/options', { body });
      assert.deepEqual([reply.status, errorCode(reply)], [403, 'AUTHORITY_ENROLMENT_INVALID'], JSON.stringify(body));
    }
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'x', organizationId: 'org-other' } })), 'AUTHORITY_REQUEST_INVALID');
    const { token } = await invite(booted, 'approver-c');
    await booted.authority.identity.revokePrincipal(identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' }), 'approver-c', 'left');
    const revokedHuman = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.deepEqual([revokedHuman.status, errorCode(revokedHuman)], [403, 'AUTHORITY_ENROLMENT_INVALID']);
    // Another Host (another identity store): its invitation means nothing here.
    const other = await boot();
    await provisionOrganization(other.baseUrl);
    await registerHuman(other, 'approver-b');
    const { token: foreign } = await invite(other, 'approver-b');
    const crossHost = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: foreign } });
    assert.deepEqual([crossHost.status, errorCode(crossHost)], [403, 'AUTHORITY_ENROLMENT_INVALID']);
    await other.host.close();
  });

  for (const [name, overrides] of [
    ['a wrong origin', { origin: 'https://evil.example' }],
    ['a wrong RP ID', { rpId: 'evil.example' }],
    ['missing user verification', { userVerified: false }],
    ['an invalid registration (forged attestation)', { fmt: 'packed' }],
    ['a cross-origin ceremony', { crossOrigin: true }],
  ] as const) {
    it(`refuses ${name}; the invitation remains usable`, async () => {
      const { token } = await invite(booted, 'approver-b');
      const refused = await enrolOn(new Browser(booted.gatewayPort), token, device(), overrides);
      assert.ok(refused.status === 400 || refused.status === 401, `${refused.status} ${refused.text}`);
      const credentials = (await describeHuman(booted, 'approver-b'))['credentials'] as unknown[];
      const ok = await enrolOn(new Browser(booted.gatewayPort), token, device());
      assert.equal(ok.status, 201, ok.text);
      assert.equal(((await describeHuman(booted, 'approver-b'))['credentials'] as unknown[]).length, credentials.length + 1);
    });
  }

  it('a request from another Origin or Host is refused before any ceremony', async () => {
    const browser = new Browser(booted.gatewayPort);
    assert.equal(errorCode(await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'x' }, headers: { origin: 'https://evil.example' } })), 'AUTHORITY_ORIGIN_INVALID');
    assert.equal((await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'x' }, headers: { host: 'evil.example' } })).status, 421);
    assert.equal((await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'x' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  });

  it('challenge replay and cross-browser or cross-invitation substitution are refused', async () => {
    const { token } = await invite(booted, 'approver-b');
    const { token: second } = await invite(booted, 'approver-b');
    const a = new Browser(booted.gatewayPort);
    const options = await a.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    const credential = device().register(options.body['publicKey'] as RegistrationOptionsJSON);
    // Another browser, with its own ceremony, cannot submit A's registration.
    const b = new Browser(booted.gatewayPort);
    await b.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.equal(errorCode(await b.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential } })), 'AUTHORITY_ENROLMENT_CEREMONY_INVALID');
    // A's ceremony cannot be completed under another invitation.
    const c = new Browser(booted.gatewayPort);
    const optionsC = await c.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.equal(errorCode(await c.send('POST', '/authority/v1/enrolment', { body: { invitation: second, credential: device().register(optionsC.body['publicKey'] as RegistrationOptionsJSON) } })), 'AUTHORITY_ENROLMENT_CEREMONY_INVALID');
    // A completes; the same registration replayed is refused (ceremony consumed), and so is a new ceremony with the old response.
    assert.equal((await a.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential } })).status, 201);
    assert.equal(errorCode(await a.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential } })), 'AUTHORITY_ENROLMENT_CEREMONY_INVALID');
    const d = new Browser(booted.gatewayPort);
    await d.send('POST', '/authority/v1/enrolment/options', { body: { invitation: second } });
    assert.equal(errorCode(await d.send('POST', '/authority/v1/enrolment', { body: { invitation: second, credential } })), 'AUTHORITY_ENROLMENT_CEREMONY_INVALID');
  });

  it('a duplicate credential is refused; concurrent use of one invitation registers exactly one passkey', async () => {
    const authenticator = device();
    const { token } = await invite(booted, 'approver-b');
    assert.equal((await enrolOn(new Browser(booted.gatewayPort), token, authenticator)).status, 201);
    const { token: again } = await invite(booted, 'approver-b');
    const duplicate = await enrolOn(new Browser(booted.gatewayPort), again, authenticator);
    assert.deepEqual([duplicate.status, errorCode(duplicate)], [409, 'HUMAN_IDENTITY_CREDENTIAL_DUPLICATE']);
    const before = ((await describeHuman(booted, 'approver-b'))['credentials'] as unknown[]).length;
    const { token: raced } = await invite(booted, 'approver-b');
    const one = new Browser(booted.gatewayPort);
    const two = new Browser(booted.gatewayPort);
    const [optionsOne, optionsTwo] = await Promise.all([one.send('POST', '/authority/v1/enrolment/options', { body: { invitation: raced } }), two.send('POST', '/authority/v1/enrolment/options', { body: { invitation: raced } })]);
    const replies = await Promise.all([
      one.send('POST', '/authority/v1/enrolment', { body: { invitation: raced, credential: device().register(optionsOne.body['publicKey'] as RegistrationOptionsJSON) } }),
      two.send('POST', '/authority/v1/enrolment', { body: { invitation: raced, credential: device().register(optionsTwo.body['publicKey'] as RegistrationOptionsJSON) } }),
    ]);
    assert.deepEqual(replies.map((reply) => reply.status === 201).sort(), [false, true], replies.map((reply) => reply.text).join(' | '));
    assert.equal(((await describeHuman(booted, 'approver-b'))['credentials'] as unknown[]).length, before + 1);
  });

  it('the rate-limiting hook refuses sign-in and enrolment ceremonies with 429 before any work', async () => {
    const limited = createAuthorityGateway({ authority: booted.authority, publicOrigin: ORIGIN, sessionTtlSeconds: 60, sessionIdleSeconds: 60, loginTtlSeconds: 60, logger: capturingLogger, admit: () => false });
    const { port } = await limited.listen('127.0.0.1', 0);
    try {
      const browser = new Browser(port);
      assert.equal((await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: 'x' } })).status, 429);
      assert.equal((await browser.send('POST', '/authority/v1/session/login/options')).status, 429);
    } finally {
      await limited.close();
    }
  });
});

// ── 3. Expiry, restart, rollback, outage, disclosure ────────────────────────────────

describe('AUTH-04B2 — expiry, durability across restarts, rollback, witness outage and no disclosure', () => {
  it('an expired invitation is refused', async () => {
    const booted = await boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_ENROLMENT_TTL_SECONDS: '2' });
    await provisionOrganization(booted.baseUrl);
    await registerHuman(booted, 'approver-a');
    const { token } = await invite(booted, 'approver-a');
    await sleep(2_500);
    const reply = await new Browser(booted.gatewayPort).send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    assert.deepEqual([reply.status, errorCode(reply)], [403, 'AUTHORITY_ENROLMENT_INVALID']);
    assert.deepEqual(((await describeHuman(booted, 'approver-a'))['invitations'] as Record<string, unknown>[]).map((entry) => entry['state']), ['expired']);
    await booted.host.close();
  });

  it('interruption (witness outage during persistence), restart before enrolment, restart after enrolment, and a rollback attempt', async () => {
    const first = await boot();
    await provisionOrganization(first.baseUrl);
    await registerHuman(first, 'approver-a');
    const { token } = await invite(first, 'approver-a');
    const cto = device();
    // Interrupted: the witness is unreachable when the registration would be recorded. Nothing is registered; the invitation is not consumed.
    const browser = new Browser(first.gatewayPort);
    const options = await browser.send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } });
    await first.witness.close();
    const interrupted = await browser.send('POST', '/authority/v1/enrolment', { body: { invitation: token, credential: cto.register(options.body['publicKey'] as RegistrationOptionsJSON) } });
    assert.ok(interrupted.status >= 500 && interrupted.status < 600, interrupted.text);
    await first.host.close();
    // Restart before enrolment (witness back): the same invitation still works, once.
    const witness = await first.witness.restart();
    const pre = `${identityPath(first.dir)}.pre-enrolment`;
    checkpointCopy(identityPath(first.dir), pre);
    const second = await boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }, { dir: first.dir, witness });
    assert.equal((await enrolOn(new Browser(second.gatewayPort), token, cto)).status, 201);
    await second.host.close();
    // Restart after enrolment: the passkey persists, the invitation stays consumed, sign-in works.
    const third = await boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }, { dir: first.dir, witness });
    assert.deepEqual(((await describeHuman(third, 'approver-a'))['credentials'] as Record<string, unknown>[]).map((credential) => credential['credentialId']), [cto.id]);
    assert.equal(errorCode(await new Browser(third.gatewayPort).send('POST', '/authority/v1/enrolment/options', { body: { invitation: token } })), 'AUTHORITY_ENROLMENT_INVALID');
    assert.equal((await signIn(new Browser(third.gatewayPort), cto)).status, 200);
    await third.host.close();
    // Rollback: restoring the identity file from before the enrolment (to make the invitation usable again) is refused at startup.
    checkpointCopy(pre, identityPath(first.dir), true);
    const dir = first.dir;
    const env = ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...enrolmentEnv(dir, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }) });
    await assert.rejects(bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }), (error: unknown) => (error as { code?: unknown }).code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || assert.fail(String((error as { code?: unknown }).code)));
  });

  it('no invitation token or operator secret appears in any log line, and no error response echoes a token', () => {
    assert.ok(issuedTokens.length > 5, 'tokens were issued in this run');
    const logs = logLines.join('\n');
    for (const token of issuedTokens) {
      assert.equal(logs.includes(token), false, 'a token was logged');
      assert.equal(logs.includes(token.split('.')[2] ?? token), false, 'a token secret was logged');
    }
    for (const secret of Object.values(CTRL04_SECRETS)) assert.equal(logs.includes(secret), false);
  });
});

/** Folds the WAL into the main file of a closed store, then copies it; with `replace`, the target's WAL files are removed first. */
function checkpointCopy(source: string, target: string, replace = false): void {
  if (!replace) {
    const db = new Database(source);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`) && !replace) rmSync(`${source}${suffix}`);
    if (existsSync(`${target}${suffix}`)) rmSync(`${target}${suffix}`);
  }
  copyFileSync(source, target);
}
