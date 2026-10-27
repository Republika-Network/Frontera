import { existsSync, statSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalCommandPort } from '../approval-authority/index.js';
import { AUTHORITY_CSRF_HEADER } from '../authority-gateway/index.js';
import type { HumanAuthorityPort } from '../composition/human-authority-composition.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, type AuthenticationOptionsJSON, type IdentityAdministrator } from '../human-identity/index.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { freshnessEnv, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { capturingLogger, logLines, recordingAdapter } from './ctrl02-host-fixture.js';
import { ORG, PROD, approvalPolicy, assertAwaitingApproval, createWorkspace, ctrl04Env, ctrl04File, govern, provisionOrganization, release, releaseKey, type Organization } from './ctrl04-host-fixture.js';

/**
 * AUTH-04D1R — graceful shutdown of the human-decision authority on the shipped
 * Host, with a real witness behind a loopback proxy that can hold the identity
 * store's `prepare` (the moment between witness prepare and local commit).
 *
 * A clean `host.close()` now drains: the gateway stops, new decisions are
 * refused, running decisions and accepted identity writes run to their end
 * within `AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS`, then the identity store closes.
 * A write still running at the bound fails closed, exactly as a crash would.
 * Software authenticators only; no real device.
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const workspace = createWorkspace('frontera-auth04d1r-');
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  await workspace.close();
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

// ── a witness proxy that can hold the identity store's prepare ────────────────────────

type HoldMode = 'before-witness' | 'after-witness' | 'witness-down';

/**
 * Forwards everything to the witness. Armed, it holds the next `prepare` for the
 * `human-identity-state` slot: before the witness sees it, after the witness
 * recorded it (the answer withheld), or answers it with a 503 (the witness is down).
 */
class WitnessProxy {
  private server: Server | undefined;
  private mode: HoldMode | undefined;
  private gate: Promise<void> = Promise.resolve();
  private releaseGate: () => void = () => undefined;
  held = 0;
  constructor(private readonly target: StartedWitness) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolveListen) => this.server?.listen(0, '127.0.0.1', () => resolveListen()));
    cleanups.push(async () => {
      this.release();
      this.server?.closeAllConnections();
      await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()));
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  arm(mode: HoldMode): void {
    this.mode = mode;
    this.held = 0;
    this.gate = new Promise<void>((resolveGate) => {
      this.releaseGate = resolveGate;
    });
  }

  release(): void {
    this.mode = undefined;
    this.releaseGate();
  }

  async reached(): Promise<void> {
    for (let attempt = 0; attempt < 300 && this.held === 0; attempt += 1) await sleep(10);
    assert.ok(this.held > 0, 'the identity write reached its witness prepare');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const mode = this.mode;
    const held = mode !== undefined && req.url === '/v2/checkpoint/prepare' && body.includes('"human-identity-state"');
    if (held) {
      this.mode = undefined;
      this.held += 1;
    }
    if (held && mode === 'witness-down') {
      await this.gate;
      res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (held && mode === 'before-witness') await this.gate;
    const upstream = new URL(this.target.endpoint);
    const answer = await new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolveAnswer, rejectAnswer) => {
      const forward = request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (reply) => {
        const parts: Buffer[] = [];
        reply.on('data', (part: Buffer) => parts.push(part));
        reply.on('end', () => resolveAnswer({ status: reply.statusCode ?? 502, headers: reply.headers, body: Buffer.concat(parts) }));
      });
      forward.on('error', rejectAnswer);
      forward.end(body);
    }).catch(() => ({ status: 502, headers: {}, body: Buffer.from('{}') }));
    if (held && mode === 'after-witness') await this.gate;
    if (!res.destroyed) res.writeHead(answer.status, answer.headers).end(answer.body);
  }
}

// ── the Host ─────────────────────────────────────────────────────────────────────────

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly gatewayPort: number;
  readonly authority: HumanAuthorityPort;
  readonly dir: string;
  readonly witness: StartedWitness;
  readonly proxy: WitnessProxy;
  readonly endpoint: string;
}

function hostEnv(dir: string, witness: StartedWitness, endpoint: string, overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return ctrl04Env(dir, ctrl04File(), {
    ...freshnessEnv({ endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }),
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
  });
}

const identityPath = (dir: string): string => `${dir}/identity/human-identity.sqlite`;

async function boot(overrides: Record<string, string | undefined> = {}, reuse?: Pick<Booted, 'dir' | 'witness' | 'proxy' | 'endpoint'>): Promise<Booted> {
  const witness = reuse?.witness ?? (await startWitness());
  if (reuse === undefined) cleanups.push(() => witness.close());
  const proxy = reuse?.proxy ?? new WitnessProxy(witness);
  const endpoint = reuse?.endpoint ?? (await proxy.start());
  const dir = reuse?.dir ?? workspace.dir();
  const host = workspace.track(await bootEnterpriseHost({ env: hostEnv(dir, witness, endpoint, overrides), executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
  const { port } = await host.listen();
  const gatewayPort = host.authorityGateway?.address()?.port;
  assert.ok(gatewayPort !== undefined);
  const authority = host.enterprise.humanAuthority;
  assert.ok(authority !== undefined);
  return { host, baseUrl: `http://127.0.0.1:${port}`, gatewayPort, authority, dir, witness, proxy, endpoint };
}

/** Restarts on the same data and witness. */
const restart = (booted: Booted): Promise<Booted> => boot({ AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }, booted);

async function bootRefused(booted: Booted): Promise<unknown> {
  try {
    const host = await bootEnterpriseHost({ env: hostEnv(booted.dir, booted.witness, booted.endpoint, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' }), executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: approvalPolicy() });
    await host.close();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return assert.fail('the Host started, but it must refuse');
}

const administrator = (): IdentityAdministrator =>
  identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' });

async function enrol(authority: HumanAuthorityPort, operatorId: string): Promise<SoftwareAuthenticator> {
  const device = new SoftwareAuthenticator({ origin: ORIGIN });
  const admin = administrator();
  if (authority.identity.principal(operatorId) === undefined) await authority.identity.createPrincipal(admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = await authority.identity.authorizeEnrolment(admin, operatorId);
  await authority.identity.finishRegistration(issued.enrolmentToken, device.register(authority.identity.beginRegistration(issued.enrolmentToken)));
  return device;
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

class Browser {
  private readonly jar = new Map<string, string>();
  private csrf: string | undefined;
  constructor(private readonly port: number) {}

  async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
    const payload = body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined;
    const headers: Record<string, string> = {
      host: INTENDED_PRODUCTION_RP_ID,
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      ...(this.csrf !== undefined ? { [AUTHORITY_CSRF_HEADER]: this.csrf } : {}),
      ...(this.jar.size > 0 ? { cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
    };
    const reply = await new Promise<{ status: number; text: string; setCookies: string[] }>((resolveReply, rejectReply) => {
      const req = request({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveReply({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookies: res.headers['set-cookie'] ?? [] }));
      });
      req.on('error', rejectReply);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    for (const header of reply.setCookies) {
      const pair = header.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (/Max-Age=0/.test(header) || pair.slice(index + 1) === '') this.jar.delete(pair.slice(0, index));
      else this.jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(reply.text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: reply.status, text: reply.text, body: parsed };
  }

  async loginAssertion(device: SoftwareAuthenticator): Promise<Record<string, unknown>> {
    const options = await this.send('POST', '/authority/v1/session/login/options');
    assert.equal(options.status, 200, options.text);
    return device.assert(options.body['publicKey'] as AuthenticationOptionsJSON);
  }

  async signIn(device: SoftwareAuthenticator): Promise<Reply> {
    const reply = await this.send('POST', '/authority/v1/session/login', { assertion: await this.loginAssertion(device) });
    if (reply.status === 200) this.csrf = reply.body['csrfToken'] as string;
    return reply;
  }
}

const verdicts = async (booted: Booted, approvalRequestId: string): Promise<number> =>
  ((await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((view) => view.approvalRequestId === approvalRequestId)?.state.verdicts.length ?? 0);

async function pending(booted: Booted, org: Organization): Promise<{ readonly approvalRequestId: string; readonly subjectDigest: string }> {
  const reply = await govern(booted.baseUrl, org.agentCredential, release(PROD, releaseKey('auth04d1r')));
  assertAwaitingApproval(reply);
  const view = (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === reply.body['requestId']);
  assert.ok(view !== undefined);
  return { approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest };
}

/** The identity store closed with the Host: no un-checkpointed WAL beside it. */
function assertClosedClean(booted: Booted): void {
  const wal = `${identityPath(booted.dir)}-wal`;
  assert.equal(existsSync(wal) && statSync(wal).size > 0, false, 'the identity store was closed with the Host (no WAL left)');
}

const identitySlot = async (booted: Booted): Promise<Record<string, unknown> | undefined> => (await witnessRows(booted.witness.databasePath)).find((row) => row['state_kind'] === 'human-identity-state');

/** Starts `host.close()` and proves it is still waiting `ms` later. Wrapped, so awaiting this helper does not await the close. */
async function closeStillWaiting(booted: Booted, ms = 250): Promise<{ readonly closing: Promise<void> }> {
  let done = false;
  const closing = booted.host.close().then(() => {
    done = true;
  });
  await sleep(ms);
  assert.equal(done, false, 'shutdown waits for the running identity write');
  return { closing };
}

// ── the drills ───────────────────────────────────────────────────────────────────────

describe('AUTH-04D1R — graceful shutdown drains the human-decision authority', () => {
  it('normal shutdown: the authority drains (logged), the identity store closes, a restart is ready', async () => {
    const booted = await boot();
    await provisionOrganization(booted.baseUrl);
    await enrol(booted.authority, 'approver-a');
    await booted.host.close();
    assertClosedClean(booted);
    assert.ok(logLines.some((line) => line.includes('enterprise.human_authority.drained')));
    const again = await restart(booted);
    assert.equal(again.host.posture.humanAuthority, 'composed');
    await again.host.close();
  });

  it('a decision mid-submission (identity prepare held) runs to its end during shutdown: recorded once, readable after restart, never replayed; new decisions are refused while draining', async () => {
    const booted = await boot();
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const request = await pending(booted, org);
    const browser = new Browser(booted.gatewayPort);
    assert.equal((await browser.signIn(cto)).status, 200);
    const issued = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(request.approvalRequestId)}/decision-challenges`, { subjectDigest: request.subjectDigest, verdict: 'approve' });
    assert.equal(issued.status, 200, issued.text);
    const commitment = issued.body['commitment'] as string;
    const assertion = cto.assert(issued.body['publicKey'] as AuthenticationOptionsJSON);
    booted.proxy.arm('before-witness');
    const submission = browser.send('POST', '/authority/v1/decisions', { assertion }).catch(() => undefined);
    await booted.proxy.reached();
    const { closing } = await closeStillWaiting(booted);
    // Draining: the port starts nothing new.
    await assert.rejects(booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: request.approvalRequestId, subjectDigest: request.subjectDigest, verdict: 'reject' }));
    booted.proxy.release();
    await closing;
    await submission;
    assertClosedClean(booted);
    const slot = await identitySlot(booted);
    assert.equal(slot?.['pending_sequence'], null, 'nothing is left prepared at the witness');
    const again = await restart(booted);
    const outcome = await again.authority.decisions.outcome(commitment);
    assert.equal(outcome?.state, 'recorded', 'the decision completed durably during the drain');
    assert.equal(await verdicts(again, request.approvalRequestId), 1);
    // Not replayable after restart, and still exactly one verdict.
    await assert.rejects(again.authority.identity.authorizeDecision(assertion), (error: unknown) => (error as { code?: unknown }).code === 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED');
    await assert.rejects(again.authority.decisions.decide(assertion));
    assert.equal(await verdicts(again, request.approvalRequestId), 1);
    await again.host.close();
  });

  it('an active sign-in during shutdown completes; a new identity write is refused before it reaches the witness', async () => {
    const booted = await boot();
    await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    const assertion = await browser.loginAssertion(cto);
    booted.proxy.arm('before-witness');
    const signIn = browser.send('POST', '/authority/v1/session/login', { assertion }).catch(() => undefined);
    await booted.proxy.reached();
    const { closing } = await closeStillWaiting(booted);
    await assert.rejects(booted.authority.identity.createPrincipal(administrator(), { operatorId: 'approver-b', displayName: 'Late' }), (error: unknown) => (error as { code?: unknown }).code === 'HUMAN_IDENTITY_STORE_UNAVAILABLE' || assert.fail(String((error as { code?: unknown }).code)));
    booted.proxy.release();
    await closing;
    await signIn;
    assertClosedClean(booted);
    const again = await restart(booted);
    assert.equal(again.authority.identity.principal('approver-b'), undefined, 'the refused write never happened');
    assert.equal((await new Browser(again.gatewayPort).signIn(cto)).status, 200);
    await again.host.close();
  });

  it('an active enrolment during shutdown completes; the passkey is registered after restart', async () => {
    const booted = await boot();
    await provisionOrganization(booted.baseUrl);
    const admin = administrator();
    await booted.authority.identity.createPrincipal(admin, { operatorId: 'approver-a', displayName: 'CTO' });
    const issued = await booted.authority.identity.authorizeEnrolment(admin, 'approver-a');
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    const registration = device.register(booted.authority.identity.beginRegistration(issued.enrolmentToken));
    booted.proxy.arm('before-witness');
    const registering = booted.authority.identity.finishRegistration(issued.enrolmentToken, registration);
    await booted.proxy.reached();
    const { closing } = await closeStillWaiting(booted);
    booted.proxy.release();
    await closing;
    assert.equal((await registering).operatorId, 'approver-a');
    assertClosedClean(booted);
    const again = await restart(booted);
    assert.deepEqual(again.authority.identity.credentialsOf('approver-a').map((credential) => credential.credentialId), [device.id]);
    await again.host.close();
  });

  it('a witness outage during the drain: the write fails as it would, nothing is left prepared, the Host restarts', async () => {
    const booted = await boot();
    await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    const assertion = await browser.loginAssertion(cto);
    booted.proxy.arm('witness-down');
    const signIn = browser.send('POST', '/authority/v1/session/login', { assertion }).catch(() => undefined);
    await booted.proxy.reached();
    const { closing } = await closeStillWaiting(booted);
    booted.proxy.release();
    await closing;
    await signIn;
    assertClosedClean(booted);
    assert.equal((await identitySlot(booted))?.['pending_sequence'], null);
    const again = await restart(booted);
    assert.equal((await new Browser(again.gatewayPort).signIn(cto)).status, 200, 'a fresh sign-in works');
    await again.host.close();
  });

  it('BOUNDED and CHARACTERIZED: a write whose witness answer is lost (a pre-existing CORE-07 mode) is cut at AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS; shutdown never hangs, the incomplete drain is logged, and the next start fails closed (PENDING_RECOVERY), as after a crash', async () => {
    const booted = await boot({ AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS: '500' });
    await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const browser = new Browser(booted.gatewayPort);
    const assertion = await browser.loginAssertion(cto);
    // The witness records the prepare; its answer is withheld (the Host's transport gives up after 2 s).
    booted.proxy.arm('after-witness');
    const signIn = browser.send('POST', '/authority/v1/session/login', { assertion }).catch(() => undefined);
    await booted.proxy.reached();
    const started = Date.now();
    await booted.host.close();
    assert.ok(Date.now() - started < 10_000, 'bounded');
    assert.ok(logLines.some((line) => line.includes('enterprise.human_authority.drain_incomplete')), 'an incomplete drain is logged');
    booted.proxy.release();
    await signIn;
    await sleep(2_500);
    assert.notEqual((await identitySlot(booted))?.['pending_sequence'], null, 'the witness holds a prepared successor the file never got');
    assert.equal(await bootRefused(booted), 'AUTHORITY_FRESHNESS_PENDING_RECOVERY', 'fail closed: indistinguishable from commit-then-rollback; no ceremony resolves it for this store yet (AUTH-04D1R)');
  });
});
