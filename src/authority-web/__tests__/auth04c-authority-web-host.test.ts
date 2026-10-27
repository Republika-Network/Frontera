import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthorityApi } from '../api.js';
import { createController, type Controller } from '../controller.js';
import { base64urlToBytes, browserPasskeys, bytesToBase64url, type BrowserCredential, type CredentialsContainerLike } from '../passkeys.js';
import { render } from '../view.js';
import { textOf } from '../vnode.js';
import type { ApprovalCommandPort } from '../../enterprise/approval-authority/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../../enterprise/host/enterprise-host.js';
import { INTENDED_PRODUCTION_RP_ID, type AuthenticationOptionsJSON, type RegistrationOptionsJSON } from '../../enterprise/human-identity/index.js';
import { SoftwareAuthenticator } from '../../enterprise/__tests__/auth02-software-authenticator.js';
import { freshnessEnv, startWitness, type StartedWitness } from '../../enterprise/__tests__/core07-freshness-fixture.js';
import { capturingLogger, recordingAdapter } from '../../enterprise/__tests__/ctrl02-host-fixture.js';
import {
  AUTH,
  CTRL04_SECRETS,
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
} from '../../enterprise/__tests__/ctrl04-host-fixture.js';
import { browserSession, startAuthorityOrigin, type AuthorityOrigin, type BrowserSession } from './authority-web-origin-fixture.js';

/**
 * AUTH-04C — the Frontera Authority web client against the real Host contracts.
 *
 * The canonical shipped Host (production profile, SQLite, CORE-07 witness)
 * with the AUTH-04B gateway and AUTH-04B2 enrolment; the client built by the
 * real build script; one loopback origin that serves the client and routes
 * `/authority/v1/*` to the gateway (the AUTH-04C same-origin topology). The
 * client code is the shipped code — controller, gateway client, WebAuthn codec,
 * view. Only `navigator.credentials` is replaced, by the spec-faithful software
 * authenticator, and its binary results flow through the client's own codec.
 * This qualifies the integration; it is **not** a real-iPhone test.
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const NOW = (): number => Date.now();
const workspace = createWorkspace('frontera-auth04c-');
const witnesses: StartedWitness[] = [];
const origins: AuthorityOrigin[] = [];
let distDir: string;

before(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'frontera-auth04c-dist-'));
  const builder = (await import(resolve('scripts/authority-web/build.mjs'))) as { buildAuthorityWeb(options: { outDir: string }): Promise<{ files: string[] }> };
  await builder.buildAuthorityWeb({ outDir: distDir });
});
after(async () => {
  for (const origin of origins.splice(0)) await origin.close().catch(() => {});
  await workspace.close();
  for (const witness of witnesses.splice(0)) await witness.close().catch(() => {});
  rmSync(distDir, { recursive: true, force: true });
});

/** `navigator.credentials`, answered by a software authenticator: binary in, binary out — exactly what Safari hands the client. */
function softwareCredentials(device: SoftwareAuthenticator, gate: { delayMs: number } = { delayMs: 0 }): CredentialsContainerLike {
  const bytes = (value: BufferSource): string => bytesToBase64url(value instanceof ArrayBuffer ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  const binary = (value: unknown): ArrayBuffer => {
    const decoded = base64urlToBytes(String(value));
    const copy = new ArrayBuffer(decoded.byteLength);
    new Uint8Array(copy).set(decoded);
    return copy;
  };
  const credentialOf = (json: Record<string, unknown>): BrowserCredential => {
    const response = json['response'] as Record<string, unknown>;
    const transports = response['transports'];
    return {
      id: String(json['id']),
      rawId: binary(json['rawId']),
      type: 'public-key',
      response: {
        clientDataJSON: binary(response['clientDataJSON']),
        ...(response['attestationObject'] !== undefined ? { attestationObject: binary(response['attestationObject']) } : {}),
        ...(response['authenticatorData'] !== undefined ? { authenticatorData: binary(response['authenticatorData']), signature: binary(response['signature']) } : {}),
        ...(response['userHandle'] !== undefined ? { userHandle: binary(response['userHandle']) } : {}),
        ...(Array.isArray(transports) ? { getTransports: () => transports.map(String) } : {}),
      },
    };
  };
  return {
    async create({ publicKey }) {
      const options: RegistrationOptionsJSON = {
        rp: { id: publicKey.rp.id ?? '', name: publicKey.rp.name },
        user: { id: bytes(publicKey.user.id), name: publicKey.user.name, displayName: publicKey.user.displayName },
        challenge: bytes(publicKey.challenge),
        pubKeyCredParams: publicKey.pubKeyCredParams.map((param) => ({ type: 'public-key' as const, alg: param.alg })),
        timeout: publicKey.timeout ?? 0,
        attestation: 'none',
        excludeCredentials: (publicKey.excludeCredentials ?? []).map((entry) => ({ type: 'public-key' as const, id: bytes(entry.id) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      };
      return credentialOf(device.register(options));
    },
    async get({ publicKey }) {
      if (gate.delayMs > 0) await sleep(gate.delayMs);
      const options: AuthenticationOptionsJSON = {
        rpId: publicKey.rpId ?? '',
        challenge: bytes(publicKey.challenge),
        timeout: publicKey.timeout ?? 0,
        userVerification: 'required',
        allowCredentials: (publicKey.allowCredentials ?? []).map((entry) => ({ type: 'public-key' as const, id: bytes(entry.id) })),
      };
      return credentialOf(device.assert(options));
    },
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

interface Pilot {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly origin: AuthorityOrigin;
  readonly org: Organization;
  readonly witness: StartedWitness;
}

async function bootPilot(overrides: Record<string, string | undefined> = {}): Promise<Pilot> {
  const witness = await startWitness();
  witnesses.push(witness);
  const dir = workspace.dir();
  const env = ctrl04Env(dir, ctrl04File(), {
    ...freshnessEnv(witness),
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
  });
  const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
  const { port } = await host.listen();
  const gatewayPort = host.authorityGateway?.address()?.port ?? assert.fail('no gateway');
  const origin = await startAuthorityOrigin({ distDir, gatewayPort });
  origins.push(origin);
  const baseUrl = `http://127.0.0.1:${port}`;
  return { host, baseUrl, origin, org: await provisionOrganization(baseUrl), witness };
}

async function invite(pilot: Pilot, operatorId: string): Promise<string> {
  const human = await call(pilot.baseUrl, 'POST', '/api/admin/passkey-humans', { authorization: AUTH.administrator, body: { operatorId, displayName: `Human ${operatorId}` } });
  assert.ok(human.status === 200 || human.status === 409, human.text);
  const invitation = await call(pilot.baseUrl, 'POST', '/api/admin/passkey-invitations', { authorization: AUTH.administrator, body: { operatorId } });
  assert.equal(invitation.status, 200, invitation.text);
  return (invitation.body['invitation'] as Record<string, string>)['token'] ?? assert.fail('no token');
}

interface Client {
  readonly controller: Controller;
  readonly browser: BrowserSession;
  readonly device: SoftwareAuthenticator;
  readonly view: () => string;
}

function client(pilot: Pilot, device: SoftwareAuthenticator = new SoftwareAuthenticator({ origin: ORIGIN }), gate?: { delayMs: number }): Client {
  const browser = browserSession(pilot.origin.port, INTENDED_PRODUCTION_RP_ID);
  const controller = createController({ api: createAuthorityApi(browser.transport), passkeys: browserPasskeys(softwareCredentials(device, gate), true), digest: sha256 });
  return { controller, browser, device, view: () => textOf(render(controller.state(), controller, NOW())) };
}

async function pending(pilot: Pilot): Promise<{ readonly key: string; readonly approvalRequestId: string }> {
  const key = releaseKey('auth04c');
  const reply = await govern(pilot.baseUrl, pilot.org.agentCredential, release(PROD, key));
  assertAwaitingApproval(reply);
  const view = (await (pilot.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === reply.body['requestId']) ?? assert.fail('missing');
  return { key, approvalRequestId: view.approvalRequestId };
}

const verdictCount = async (pilot: Pilot, approvalRequestId: string): Promise<number> => ((await (pilot.host.enterprise.approvals as ApprovalCommandPort).list()).find((view) => view.approvalRequestId === approvalRequestId)?.state.verdicts.length ?? 0);

async function enrolAndSignIn(pilot: Pilot, operatorId: string): Promise<Client> {
  const human = client(pilot);
  await human.controller.start();
  human.controller.showEnrolment();
  human.controller.setInvitation(await invite(pilot, operatorId));
  await human.controller.enrol();
  assert.equal(human.controller.state().screen.name, 'enrolled', human.controller.state().notice?.message);
  await human.controller.signIn();
  assert.equal(human.controller.state().screen.name, 'inbox', human.controller.state().notice?.message);
  return human;
}

describe('AUTH-04C — the Authority web client on the shipped Host, through one same-origin Authority origin', () => {
  let pilot: Pilot;
  before(async () => {
    pilot = await bootPilot();
  });

  it('the origin serves the built client with strict headers: no inline code, no external source, no bearer or secret in any asset', async () => {
    const browser = browserSession(pilot.origin.port, INTENDED_PRODUCTION_RP_ID);
    const index = await browser.get('/');
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-security-policy']), /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/);
    assert.equal(index.headers['x-frame-options'], 'DENY');
    assert.equal(index.headers['access-control-allow-origin'], undefined, 'no CORS: same origin only');
    assert.match(index.text, /<script type="module" src="\.\/js\/main\.js"><\/script>/);
    const manifest = JSON.parse(readFileSync(join(distDir, 'asset-manifest.json'), 'utf8')) as { files: { path: string }[] };
    let bundle = '';
    for (const file of manifest.files) {
      const asset = await browser.get(`/${file.path}`);
      if (file.path === 'security-headers.json') {
        assert.equal(asset.status, 404, 'the header file is configuration, not served');
        continue;
      }
      assert.equal(asset.status, 200, file.path);
      bundle += asset.text;
    }
    assert.ok(bundle.includes('/authority/v1'));
    for (const secret of Object.values(CTRL04_SECRETS)) assert.equal(bundle.includes(secret), false);
    assert.equal(/Bearer |authorization:|localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|eval\(/i.test(bundle), false, 'no bearer, no storage, no HTML injection sink');
  });

  it('enrolment by invitation registers a passkey through the client codec, opens no session, and sign-in then works', async () => {
    const human = client(pilot);
    await human.controller.start();
    assert.equal(human.controller.state().screen.name, 'welcome');
    human.controller.showEnrolment();
    human.controller.setInvitation(await invite(pilot, 'approver-a'));
    await human.controller.enrol();
    assert.equal(human.controller.state().screen.name, 'enrolled', human.controller.state().notice?.message);
    assert.equal(human.browser.jar.has('__Host-frontera_authority_session'), false, 'no session cookie after registration');
    assert.equal((await human.browser.transport('GET', '/authority/v1/session', undefined, undefined)).status, 401);
    await human.controller.signIn();
    assert.equal(human.controller.state().screen.name, 'inbox', human.controller.state().notice?.message);
    assert.equal(human.controller.state().session?.operatorId, 'approver-a');
    assert.ok(human.browser.jar.has('__Host-frontera_authority_session'), 'the session is the server-set HttpOnly cookie');
  });

  it('an invalid or reused invitation is refused with a clear explanation', async () => {
    const token = await invite(pilot, 'approver-b');
    const first = client(pilot);
    await first.controller.start();
    first.controller.showEnrolment();
    first.controller.setInvitation(token);
    await first.controller.enrol();
    assert.equal(first.controller.state().screen.name, 'enrolled');
    const second = client(pilot);
    await second.controller.start();
    second.controller.showEnrolment();
    second.controller.setInvitation(token);
    await second.controller.enrol();
    assert.equal(second.controller.state().screen.name, 'enrol');
    assert.equal(second.controller.state().notice?.code, 'AUTHORITY_ENROLMENT_INVALID');
    second.controller.setInvitation('fre1.not-an-invitation');
    await second.controller.enrol();
    assert.equal(second.controller.state().notice?.code, 'AUTHORITY_ENROLMENT_INVALID');
  });

  it('sign-in with an unregistered passkey is rejected', async () => {
    const stranger = client(pilot);
    await stranger.controller.start();
    await stranger.controller.signIn();
    assert.equal(stranger.controller.state().session, null);
    assert.equal(stranger.controller.state().notice?.code, 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
  });

  it('approve: the inbox lists the request, the detail is the canonical subject (digest verified in the client), the passkey decision is recorded, and execution is never claimed', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-a');
    const { key, approvalRequestId } = await pending(pilot);
    await human.controller.loadInbox();
    assert.ok(human.controller.state().inbox?.some((item) => item.approvalRequestId === approvalRequestId));
    await human.controller.openRequest(approvalRequestId);
    const detail = human.controller.state().detail ?? assert.fail('no detail');
    assert.equal(human.controller.state().digestCheck, 'verified', 'the canonical bytes hash to the Host’s digest');
    assert.equal(detail.subject.action, 'deploy-release');
    assert.ok(human.view().includes(detail.canonicalSubject), 'the exact canonical subject is rendered');
    human.controller.chooseVerdict('approve');
    await human.controller.confirmDecision();
    const state = human.controller.state();
    assert.equal(state.screen.name, 'result', state.notice?.message);
    assert.equal(state.status?.decision, 'approved');
    assert.equal(state.status?.request?.status, 'approved');
    assert.equal(state.status?.execution, 'not_observed');
    assert.match(human.view(), /Approval recorded/);
    assert.equal(/executed successfully/i.test(human.view()), false);
    assert.equal(await verdictCount(pilot, approvalRequestId), 1);
    // The agent resumes through the canonical path; the client never reported it.
    const resumed = await govern(pilot.baseUrl, pilot.org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
  });

  it('reject records a rejection', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-a');
    const { approvalRequestId } = await pending(pilot);
    await human.controller.openRequest(approvalRequestId);
    human.controller.chooseVerdict('reject');
    await human.controller.confirmDecision();
    assert.equal(human.controller.state().status?.decision, 'rejected', human.controller.state().notice?.message);
    assert.equal(human.controller.state().status?.request?.status, 'rejected');
  });

  it('role: a responder is offered reject only; approve cannot be chosen', async () => {
    const responder = await enrolAndSignIn(pilot, 'ops-responder');
    const { approvalRequestId } = await pending(pilot);
    await responder.controller.openRequest(approvalRequestId);
    assert.deepEqual(responder.controller.state().detail?.verdicts, ['reject']);
    responder.controller.chooseVerdict('approve');
    assert.equal(responder.controller.state().screen.name, 'request');
  });

  it('a lost submission response: the client reads the authoritative status and never resubmits; exactly one verdict exists', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-a');
    const { approvalRequestId } = await pending(pilot);
    await human.controller.openRequest(approvalRequestId);
    human.controller.chooseVerdict('approve');
    human.browser.loseNextResponse((method, path) => method === 'POST' && path === '/authority/v1/decisions');
    await human.controller.confirmDecision();
    assert.equal(human.controller.state().status?.decision, 'approved', human.controller.state().notice?.message);
    assert.equal(await verdictCount(pilot, approvalRequestId), 1);
  });

  it('a double activation sends one decision', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-a');
    const { approvalRequestId } = await pending(pilot);
    await human.controller.openRequest(approvalRequestId);
    human.controller.chooseVerdict('reject');
    await Promise.all([human.controller.confirmDecision(), human.controller.confirmDecision()]);
    assert.equal(await verdictCount(pilot, approvalRequestId), 1);
  });

  it('standing revoked before the decision: the verified passkey is refused by CORE-05 and shown as not recorded', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-b');
    const { approvalRequestId } = await pending(pilot);
    await human.controller.openRequest(approvalRequestId);
    human.controller.chooseVerdict('approve');
    const revoked = await call(pilot.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-b/revoke', { authorization: AUTH.responder, body: { reason: 'left the release board' } });
    assert.equal(revoked.status, 200, revoked.text);
    await human.controller.confirmDecision();
    // Standing is read live: either the challenge is refused (the request left the human's inbox) or CORE-05 refuses the verdict.
    const state = human.controller.state();
    assert.ok(state.status?.decision === 'refused' || state.notice?.code === 'AUTHORITY_NOT_FOUND', `${String(state.status?.decision)} ${String(state.notice?.code)}`);
    assert.equal(/Approval recorded/.test(human.view()), false);
    assert.equal(await verdictCount(pilot, approvalRequestId), 0, 'no verdict was recorded');
  });

  it('sign-out ends the server session', async () => {
    const human = await enrolAndSignIn(pilot, 'approver-a');
    await human.controller.signOut();
    assert.equal(human.controller.state().screen.name, 'welcome');
    assert.equal((await human.browser.transport('GET', '/authority/v1/session', undefined, undefined)).status, 401);
  });
});

describe('AUTH-04C — expiry and session lifetime against the real gateway', () => {
  it('an expired decision challenge is explained and nothing is recorded; an idle session returns the human to sign-in', async () => {
    const pilot = await bootPilot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_DECISION_TTL_SECONDS: '1', AOC_ENTERPRISE_AUTHORITY_SESSION_TTL_SECONDS: '6', AOC_ENTERPRISE_AUTHORITY_SESSION_IDLE_SECONDS: '4' });
    const gate = { delayMs: 0 };
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    const human = client(pilot, device, gate);
    await human.controller.start();
    human.controller.showEnrolment();
    human.controller.setInvitation(await invite(pilot, 'approver-a'));
    await human.controller.enrol();
    await human.controller.signIn();
    const { approvalRequestId } = await pending(pilot);
    await human.controller.openRequest(approvalRequestId);
    human.controller.chooseVerdict('approve');
    gate.delayMs = 1_600; // the human takes longer than the decision window
    await human.controller.confirmDecision();
    assert.equal(human.controller.state().notice?.code, 'HUMAN_IDENTITY_CHALLENGE_INVALID', human.controller.state().notice?.message);
    assert.equal(await verdictCount(pilot, approvalRequestId), 0);
    await sleep(4_500);
    await human.controller.loadInbox();
    assert.equal(human.controller.state().screen.name, 'welcome');
    assert.match(human.controller.state().notice?.message ?? '', /session has ended/);
    await pilot.host.close();
  });
});
