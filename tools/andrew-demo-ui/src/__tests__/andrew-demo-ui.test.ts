import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createSqliteXrplAttemptStore } from '@aoc-enterprise/xrpl-testnet-transport';
import { Wallet } from 'xrpl';

import { createLedgerPorts } from '../../../andrew-demo-harness/dist/live-wiring.js';
import { DEMO_IDENTITY } from '../../../andrew-demo-harness/dist/run-infrastructure.js';
import { ActionRefused, DemoController } from '../controller.js';
import type { DemoStateDto } from '../dto.js';
import { startAndrewDemoUi } from '../main.js';
import { createRehearsalLedger, type RehearsalLedger, type RehearsalScript } from '../rehearsal-ledger.js';
import { DEMO_REQUEST_HEADER, startDemoServer, type DemoServer } from '../server.js';

/**
 * ANDREW-DEMO-UI-01 — the visual demo's backend, offline.
 *
 * LIVE mode is exercised with the real P0-11 configuration loader, the real
 * P0-08 transport, signer and attempt store, and a scripted XRPL Testnet behind
 * them (no network). REHEARSAL mode is exercised as shipped. Every governed
 * step is the real Andrew composition.
 */

const SEED_SHAPE = /\bs[1-9A-HJ-NP-Za-km-z]{28,30}\b/;
const BLOB_SHAPE = /\b[0-9A-Fa-f]{200,}\b/;
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'frontera-andrew-ui-'));
  roots.push(root);
  return root;
};

interface LiveFixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly secretsFile: string;
  readonly treasury: Wallet;
  readonly recipient: Wallet;
  readonly ledger: RehearsalLedger;
  readonly environment: Record<string, string>;
  controller(): DemoController;
}

/** LIVE mode over a scripted Testnet: a real owner-only secrets file, the real configuration loader and transport. */
function liveFixture(options: { readonly ledger?: Partial<RehearsalScript>; readonly environment?: Record<string, string>; readonly secretsMode?: number } = {}): LiveFixture {
  const root = tempRoot();
  const treasury = Wallet.generate();
  const recipient = Wallet.generate();
  const secretsFile = join(root, 'testnet.env');
  writeFileSync(secretsFile, [`FRONTERA_XRPL_TESTNET_TREASURY_SEED=${String(treasury.seed)}`, `FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS=${treasury.classicAddress}`, `FRONTERA_XRPL_TESTNET_RECIPIENT_SEED=${String(recipient.seed)}`, `FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS=${recipient.classicAddress}`, ''].join('\n'));
  chmodSync(secretsFile, options.secretsMode ?? 0o600);
  const ledger = createRehearsalLedger(treasury.classicAddress, options.ledger);
  const stateRoot = join(root, 'state');
  const environment = { FRONTERA_ANDREW_STATE_ROOT: stateRoot, FRONTERA_ANDREW_SECRETS_FILE: secretsFile, ...options.environment };
  return { root, stateRoot, secretsFile, treasury, recipient, ledger, environment, controller: () => new DemoController({ mode: 'live', environment, ports: createLedgerPorts(ledger.connector) }) };
}

/** An HTTP client that keeps every response body, so the whole conversation can be scanned for secrets. */
class Client {
  readonly bodies: string[] = [];
  constructor(readonly server: DemoServer) {}
  async get(path: string): Promise<{ readonly status: number; readonly text: string; readonly json: () => Record<string, unknown> }> {
    const response = await fetch(`${this.server.url.replace(/\/$/, '')}${path}`);
    const text = await response.text();
    this.bodies.push(text);
    return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  }
  async state(): Promise<DemoStateDto> {
    return (await this.get('/api/status')).json() as unknown as DemoStateDto;
  }
  async post(path: string, init: { readonly headers?: Record<string, string>; readonly body?: string } = {}): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const response = await fetch(`${this.server.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { [DEMO_REQUEST_HEADER]: '1', ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) });
    const text = await response.text();
    this.bodies.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  }
  /** The browser's view of the real lifecycle: poll until the backend has left `executing`. */
  async untilSettled(): Promise<DemoStateDto> {
    for (let i = 0; i < 400; i += 1) {
      const s = await this.state();
      if (s.busy === undefined && s.scenarioA.phase !== 'executing') return s;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('execution did not settle');
  }
}

const refused = async (promise: Promise<unknown>): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof ActionRefused);
};
const runsOf = (stateRoot: string): readonly string[] => (existsSync(join(stateRoot, 'runs')) ? readdirSync(join(stateRoot, 'runs')) : []);

// ── LIVE mode: the whole demo over HTTP ──────────────────────────────────────

describe('ANDREW-DEMO-UI-01 — LIVE mode (scripted Testnet behind the real transport), end to end over HTTP', () => {
  let f: LiveFixture;
  let controller: DemoController;
  let server: DemoServer;
  let client: Client;
  const seen: Record<string, DemoStateDto> = {};

  before(async () => {
    f = liveFixture();
    controller = f.controller();
    server = await startDemoServer(controller, { port: 0 });
    client = new Client(server);
  });
  after(async () => {
    await controller.close();
    await server.close();
  });

  it('binds to 127.0.0.1 only and labels the mode LIVE • XRPL TESTNET (28)', async () => {
    assert.equal((server.server.address() as { address: string }).address, '127.0.0.1');
    const s = await client.state();
    assert.equal(s.mode, 'live');
    assert.equal(s.modeLabel, 'LIVE • XRPL TESTNET');
    assert.equal(s.network.name, 'XRPL Testnet');
    assert.equal(s.preflight.status, 'not-run');
  });

  it('refuses every governed action before a READY preflight and a session (3, 13)', async () => {
    for (const path of ['/api/scenario-a/request', '/api/scenario-a/approve', '/api/scenario-a/reconsider', '/api/scenario-a/execute', '/api/scenario-b/run']) {
      const r = await client.post(path);
      assert.equal(r.status, 409, path);
      assert.equal(r.body['error'], 'ACTION_NOT_ALLOWED');
    }
    assert.equal(f.ledger.counts.submits + f.ledger.counts.transportConnects, 0);
  });

  it('preflight READY, then a fresh session: destination not approved, nothing granted (7)', async () => {
    const pre = await client.post('/api/preflight');
    assert.equal(pre.status, 200);
    const s1 = pre.body as unknown as DemoStateDto;
    assert.equal(s1.preflight.status, 'READY');
    assert.equal(s1.preflight.treasury, f.treasury.classicAddress);
    assert.equal(s1.preflight.treasuryTestRlusd, '100');
    assert.equal(s1.preflight.attemptState, 'clean');
    assert.equal(s1.preflight.secrets, 'configured securely (backend only)');
    // LIVE governs and settles the configured Testnet amount, and says it is a scaled run of the USD 75,000 scenario.
    assert.deepEqual(s1.story, { businessAmountUsd: '75000', governedAmountUsd: '10', settlementAmount: '10', settlementAsset: 'Test RLUSD', settlementNetwork: 'XRPL Testnet', scaled: true, ceilingUsd: '100000', secondTestUsd: '125000' });
    const session = await client.post('/api/session');
    assert.equal(session.status, 200);
    const s = session.body as unknown as DemoStateDto;
    assert.equal(s.session?.status, 'active');
    assert.match(String(s.session?.runId), /^andrew-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.equal(s.allowed.request, true);
    assert.equal(s.allowed.approve, false);
    assert.equal(s.allowed.scenarioB, false, 'Scenario B needs the approval first');
    assert.equal((await client.post('/api/scenario-b/run')).status, 409);
  });

  it('A1–A2: the request produces the canonical destination-policy denial — no grant, signature or submission (8)', async () => {
    const r = await client.post('/api/scenario-a/request');
    assert.equal(r.status, 200);
    const s = (seen['A2'] = r.body as unknown as DemoStateDto);
    assert.equal(s.scenarioA.phase, 'denied');
    assert.equal(s.scenarioA.request?.initialApprovalState, 'never-approved');
    assert.equal(s.scenarioA.request?.decision.status, 'denied');
    assert.ok(s.scenarioA.request?.decision.reasonCodes.includes('DOMAIN_POLICY_DENIED'));
    assert.deepEqual(s.scenarioA.request?.counters, { grants: 0, connections: 0, signatures: 0, submissions: 0, attempts: 0 });
    assert.equal(s.scenarioA.request?.traceVerified, true);
    assert.equal(s.checkpoints.find((c) => c.step === 'A2')?.result, 'EXPECTED GOVERNANCE DENIAL');
  });

  it('A3: replay returns the same request and the same decision (9)', async () => {
    assert.equal((await client.post('/api/scenario-a/approve')).status, 409, 'approval waits for the replay step');
    const s = (await client.post('/api/scenario-a/replay')).body as unknown as DemoStateDto;
    assert.equal(s.scenarioA.replay?.requestId, seen['A2']?.scenarioA.request?.requestId);
    assert.equal(s.scenarioA.replay?.decisionId, seen['A2']?.scenarioA.request?.decision.decisionId);
    assert.equal(s.scenarioA.replay?.sameDecision, true);
  });

  it('A4: approval executes nothing and does not continue into the payment (10)', async () => {
    const s = (await client.post('/api/scenario-a/approve')).body as unknown as DemoStateDto;
    assert.equal(s.scenarioA.phase, 'approved');
    assert.equal(s.scenarioA.approval?.state, 'approved');
    assert.equal(s.scenarioA.approval?.approvedBy, 'operator:andrew-admin');
    assert.equal(s.scenarioA.approval?.role, 'organization-administrator');
    assert.match(String(s.scenarioA.approval?.authorityBasis), /destination\.approve/);
    assert.deepEqual(s.scenarioA.approval?.counters, { grants: 0, connections: 0, signatures: 0, submissions: 0, attempts: 0 });
    assert.equal(s.allowed.execute, false);
    assert.equal(s.allowed.reconsider, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await client.state()).scenarioA.phase, 'approved', 'nothing advanced on its own');
    assert.equal(f.ledger.counts.transportConnects + f.ledger.counts.submits, 0);
  });

  it('A5–A6: reconsideration keeps the business-intent linkage; AUTHORIZED shows exactly one grant and nothing signed (11, 12)', async () => {
    const s = (seen['A6'] = (await client.post('/api/scenario-a/reconsider')).body as unknown as DemoStateDto);
    assert.equal(s.scenarioA.phase, 'authorized');
    const au = s.scenarioA.authorization;
    assert.equal(au?.originalRequestId, seen['A2']?.scenarioA.request?.requestId);
    assert.notEqual(au?.reconsiderationRequestId, au?.originalRequestId);
    assert.match(String(au?.businessIntentId), /^aoc\.intent:/);
    assert.equal(au?.reason, 'destination-approved');
    assert.match(String(au?.grantId), /^aoc\.grant:/);
    assert.deepEqual(au?.grantCeiling, { limit: '100000', unit: 'USD' });
    assert.deepEqual(au?.counters, { grants: 1, connections: 0, signatures: 0, submissions: 0, attempts: 0 });
    assert.ok(Date.parse(String(au?.releaseDeadline)) < Date.parse(String(au?.grantNotAfter)));
    assert.equal(s.allowed.execute, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.ledger.counts.submits, 0, 'authorization alone never executes');
    assert.equal((await client.state()).scenarioA.phase, 'authorized');
    const grants = new Database(join(f.stateRoot, 'runs', String(s.session?.runId), 'host', 'bounded-grants.sqlite'), { readonly: true });
    try {
      assert.deepEqual((grants.prepare('SELECT grant_id FROM bounded_grants').all() as { grant_id: string }[]).map((row) => row.grant_id), [au?.grantId]);
    } finally {
      grants.close();
    }
  });

  it('browser refresh restores the authorized state from the backend (23)', async () => {
    const a = await client.state();
    const b = await client.state();
    assert.deepEqual(a.scenarioA, b.scenarioA);
    assert.equal(a.scenarioA.authorization?.grantId, seen['A6']?.scenarioA.authorization?.grantId);
  });

  it('A7: an explicit EXECUTE yields exactly one signature and one submission, with the real lifecycle (15)', async () => {
    const r = await client.post('/api/scenario-a/execute');
    assert.equal(r.status, 200);
    const s = await client.untilSettled();
    assert.equal(s.scenarioA.phase, 'confirmed', JSON.stringify(s.verdict));
    assert.equal(f.ledger.counts.submits, 1);
    assert.equal(f.ledger.blobs.length, 1);
    const ex = s.scenarioA.execution;
    assert.equal(ex?.engineResult, 'tesSUCCESS');
    assert.equal(ex?.deliveredValue, '10');
    assert.equal(ex?.deliveredValue, s.story.settlementAmount, 'the screen\'s settlement amount is what was delivered');
    assert.equal(s.story.scaled, true);
    assert.equal(ex?.deliveredAsset, 'Test RLUSD');
    assert.equal(ex?.sourceAccount, f.treasury.classicAddress);
    assert.equal(ex?.destinationAccount, f.recipient.classicAddress);
    assert.equal(ex?.counters.signatures, 1);
    assert.equal(ex?.counters.submissions, 1);
    assert.equal(ex?.scripted, false, 'LIVE mode never labels its transport scripted');
    assert.deepEqual(
      s.scenarioA.lifecycle.map((entry) => entry.state),
      ['AUTHORIZED', 'RELEASED', 'SIGNING', 'SUBMITTING', 'VALIDATING', 'VALIDATED', 'CONFIRMED'],
    );
    seen['A7'] = s;
  });

  it('execution cannot occur twice (14)', async () => {
    const r = await client.post('/api/scenario-a/execute');
    assert.equal(r.status, 409);
    assert.equal(f.ledger.counts.submits, 1);
  });

  it('A8: evidence verified from the canonical trace; values match the attempt store (16)', async () => {
    const s = (await client.post('/api/scenario-a/verify-evidence')).body as unknown as DemoStateDto;
    assert.equal(s.scenarioA.evidence?.verified, true);
    assert.equal(s.scenarioA.evidence?.finalState, 'executed-confirmed-completed');
    assert.ok((s.scenarioA.evidence?.checks ?? 0) > 10);
    assert.equal(s.scenarioA.evidence?.results.filter((c) => c.status === 'fail').length, 0);
    const store = createSqliteXrplAttemptStore(join(f.stateRoot, 'runs', String(s.session?.runId), 'xrpl-attempts.sqlite'));
    try {
      const record = store.find(String(s.scenarioA.authorization?.executionId));
      assert.equal(record?.attempt.transactionHash, s.scenarioA.execution?.transactionHash);
      assert.equal(record?.state, 'validated-success');
    } finally {
      store.close();
    }
  });

  it('A9: a second reconsideration is refused — no new grant, signature or submission (17)', async () => {
    const s = (await client.post('/api/scenario-a/reconsider-again')).body as unknown as DemoStateDto;
    assert.equal(s.scenarioA.phase, 'refused-second');
    assert.deepEqual(s.scenarioA.second?.reasonCodes, ['GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED']);
    assert.deepEqual([s.scenarioA.second?.newGrants, s.scenarioA.second?.newSignatures, s.scenarioA.second?.newSubmissions], [0, 0, 0]);
    assert.equal(f.ledger.counts.submits, 1);
  });

  it('Scenario B: approved destination, USD 125,000 vs USD 100,000, FINANCIAL_AUTHORITY_CEILING_EXCEEDED, zero XRPL activity (19–22)', async () => {
    const before = { ...f.ledger.counts };
    const s0 = await client.state();
    assert.equal(s0.scenarioB.destinationApproved, true);
    assert.equal(s0.scenarioB.status, 'ready');
    assert.equal(s0.scenarioB.requestedUsd, '125000');
    assert.equal(s0.scenarioB.ceilingUsd, '100000');
    const s = (await client.post('/api/scenario-b/run')).body as unknown as DemoStateDto;
    const b = s.scenarioB.result;
    assert.equal(s.scenarioB.status, 'blocked');
    assert.equal(b?.decisionStatus, 'allowed');
    assert.equal(b?.reasonCode, 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED');
    assert.equal(b?.withheldBy, 'authority-binding');
    assert.equal(b?.issuanceOutcome, 'withheld');
    assert.deepEqual(b?.requested, { value: '125000', unit: 'USD' });
    assert.deepEqual(b?.ceiling, { value: '100000', unit: 'USD' });
    assert.deepEqual([b?.grants, b?.connections, b?.signatures, b?.submissions, b?.attemptRows], [0, 0, 0, 0, 0]);
    assert.equal(b?.transaction, null);
    assert.equal(b?.assureVerified, true);
    assert.deepEqual(f.ledger.counts, before, 'Scenario B never touched the XRPL transport');
    assert.equal(s.verdict.status, 'IN PROGRESS', 'no PASS before A10');
  });

  it('A10: the original denial is unchanged; then — and only then — PASS, with summary and report (18)', async () => {
    const s = (await client.post('/api/scenario-a/historical')).body as unknown as DemoStateDto;
    assert.equal(s.scenarioA.historical?.status, 'denied');
    assert.equal(s.scenarioA.historical?.decisionId, seen['A2']?.scenarioA.request?.decision.decisionId);
    assert.equal(s.scenarioA.historical?.unchanged, true);
    assert.equal(s.verdict.status, 'PASS');
    assert.equal(s.session?.status, 'complete');
    assert.equal(s.verdict.summaryAvailable, true);
    assert.equal(s.verdict.reportAvailable, true);
    for (const action of ['request', 'replay', 'approve', 'reconsider', 'execute', 'verifyEvidence', 'reconsiderAgain', 'historical', 'scenarioB'] as const) assert.equal(s.allowed[action], false, action);
  });

  it('summary and report are the run\'s own safe artifacts, and agree with the displayed evidence (16, 26)', async () => {
    const s = await client.state();
    const summary = (await client.get('/api/summary')).json();
    assert.equal(summary['schema'], 'frontera.andrew-demo.summary.v1');
    assert.equal(summary['runId'], s.session?.runId);
    assert.equal(summary['finalVerdict'], 'PASS');
    const a = summary['scenarioA'] as Record<string, unknown>;
    assert.equal(a['transactionHash'], s.scenarioA.execution?.transactionHash);
    assert.equal(a['grantId'], s.scenarioA.authorization?.grantId);
    assert.equal(a['businessIntentId'], s.scenarioA.authorization?.businessIntentId);
    assert.equal((summary['scenarioB'] as Record<string, unknown>)['reasonCode'], s.scenarioB.result?.reasonCode);
    const report = await client.get('/api/report');
    assert.equal(report.status, 200);
    assert.match(report.text, /^# Andrew \/ LUMX demo — run/);
    const download = await fetch(`${server.url}api/report?download=1`);
    assert.match(String(download.headers.get('content-disposition')), /attachment; filename="ANDREW-DEMO-andrew-/);
    for (const path of ['/api/report/../../testnet.env', '/../testnet.env', '/testnet.env', '/api/files', '/run.json', '/app.ts', '/dist/server.js']) assert.equal((await client.get(path)).status, 404, path);
  });

  it('no API response ever carried a seed, private key, credential, signed blob, secret name or local path (4, 5, 6)', async () => {
    const texts = client.bodies;
    assert.ok(texts.length > 25);
    const secrets = [String(f.treasury.seed), String(f.recipient.seed), f.treasury.privateKey, f.recipient.privateKey, ...f.ledger.blobs];
    assert.ok(f.ledger.blobs[0] !== undefined && f.ledger.blobs[0].length > 200, 'a real signed blob existed during the run');
    for (const text of texts) {
      for (const secret of secrets) assert.equal(text.includes(secret), false, 'secret material leaked');
      assert.doesNotMatch(text, SEED_SHAPE);
      assert.doesNotMatch(text, BLOB_SHAPE);
      assert.doesNotMatch(text, /PRIVATE KEY/);
      assert.doesNotMatch(text, /frontera-andrew-(agent|operator|auditor)-[0-9a-f]{20,}/, 'a generated credential');
      assert.doesNotMatch(text, /FRONTERA_XRPL_TESTNET_TREASURY_SEED|AOC_ENTERPRISE_/);
      assert.equal(text.includes(f.secretsFile), false, 'the secrets file path');
      assert.equal(text.includes(f.root), false, 'a local filesystem path');
    }
  });

  it('a new session after PASS starts again on fresh, unapproved state with a new run id (7)', async () => {
    const first = (await client.state()).session?.runId;
    const s = (await client.post('/api/session')).body as unknown as DemoStateDto;
    assert.notEqual(s.session?.runId, first);
    assert.equal(s.scenarioA.phase, 'not-started');
    assert.equal(s.scenarioA.approval, undefined);
    assert.equal(s.verdict.status, 'IN PROGRESS');
    const r = (await client.post('/api/scenario-a/request')).body as unknown as DemoStateDto;
    assert.equal(r.scenarioA.request?.initialApprovalState, 'never-approved');
    assert.equal(r.scenarioA.request?.decision.status, 'denied');
  });
});

// ── The HTTP boundary ───────────────────────────────────────────────────────

describe('ANDREW-DEMO-UI-01 — the local API accepts no input and cannot be driven cross-site', () => {
  let controller: DemoController;
  let server: DemoServer;
  let client: Client;
  before(async () => {
    controller = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: join(tempRoot(), 'state') } });
    server = await startDemoServer(controller, { port: 0 });
    client = new Client(server);
  });
  after(async () => {
    await controller.close();
    await server.close();
  });

  it('PASS cannot be fabricated by a client: bodies are refused, finishing steps are refused out of order (25)', async () => {
    const withBody = await client.post('/api/scenario-a/historical', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'PASS', finalVerdict: 'PASS', phase: 'complete' }) });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.body['error'], 'BODY_REFUSED');
    assert.equal((await client.post('/api/scenario-a/historical')).status, 409);
    assert.equal((await client.post('/api/scenario-b/run')).status, 409);
    const s = await client.state();
    assert.equal(s.verdict.status, 'NOT STARTED');
    assert.equal((await fetch(`${server.url}api/status`, { method: 'PUT' })).status, 405);
    assert.equal((await client.post('/api/execute-command')).status, 404);
  });

  it('refuses a POST without the demo header, from another origin, or for another Host (DNS rebinding)', async () => {
    const noHeader = await fetch(`${server.url}api/preflight`, { method: 'POST' });
    assert.equal(noHeader.status, 403);
    assert.equal((await client.post('/api/preflight', { headers: { origin: 'https://evil.example' } })).status, 403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/api/status', headers: { host: 'attacker.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  it('serves only its three static files, with a strict content security policy', async () => {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get('content-security-policy')), /default-src 'none'; script-src 'self'/);
    assert.match(await page.text(), /<script type="module" src="\/app.js">/);
    assert.equal((await fetch(`${server.url}styles.css`)).status, 200);
    assert.equal((await fetch(`${server.url}index.html`)).status, 404);
  });

  it('fails closed when a response would carry registered secret material — and the run can then never PASS', async () => {
    await client.post('/api/preflight');
    const s = await client.state();
    controller.secretGuard().register(String(s.preflight.treasury));
    const withheld = await client.get('/api/status');
    assert.equal(withheld.status, 500);
    assert.equal(withheld.json()['error'], 'RESPONSE_WITHHELD');
    assert.equal(withheld.text.includes(String(s.preflight.treasury)), false);
    assert.equal(controller.allowedActions().session, false, 'no new session after a tripped guard');
  });
});

// ── REHEARSAL mode ──────────────────────────────────────────────────────────

describe('ANDREW-DEMO-UI-01 — REHEARSAL mode', () => {
  it('is labelled rehearsal, never reads the secrets file, and keeps its own run area (27)', async () => {
    const root = tempRoot();
    const unreadable = join(root, 'testnet.env');
    writeFileSync(unreadable, 'FRONTERA_XRPL_TESTNET_TREASURY_SEED=not-a-seed\n');
    chmodSync(unreadable, 0o644); // LIVE would refuse this file; REHEARSAL never opens it.
    const c = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: join(root, 'state'), FRONTERA_ANDREW_SECRETS_FILE: unreadable } });
    try {
      const s0 = c.state();
      assert.equal(s0.modeLabel, 'REHEARSAL — NO XRPL TRANSACTION');
      assert.equal(s0.network.name, 'Scripted rehearsal ledger');
      await c.preflight();
      assert.equal(c.state().preflight.status, 'READY');
      assert.match(c.state().preflight.secrets, /ephemeral rehearsal keys in memory/);
      await c.createSession();
      assert.deepEqual(runsOf(join(root, 'state')), [], 'nothing in the live run area');
      assert.equal(runsOf(join(root, 'state', 'rehearsal')).length, 1);
    } finally {
      await c.close();
    }
  });

  it('runs the whole story to PASS through the same harness steps, and labels its execution scripted (27)', async () => {
    const c = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: join(tempRoot(), 'state') } });
    try {
      await c.preflight();
      // REHEARSAL governs the Andrew/LUMX business scenario itself: USD 75,000, not a scaled amount.
      assert.deepEqual(c.state().story, { businessAmountUsd: '75000', governedAmountUsd: '75000', settlementAmount: '75000', settlementAsset: 'Test RLUSD', settlementNetwork: 'Scripted rehearsal ledger (no network)', scaled: false, ceilingUsd: '100000', secondTestUsd: '125000' });
      assert.equal(c.state().preflight.requiredAmount, '75000');
      assert.equal(c.state().preflight.treasuryTestRlusd, '10000000');
      await c.createSession();
      await c.request();
      assert.equal(c.state().scenarioA.amountUsd, '75000', 'the agent\'s governed request is USD 75,000');
      await c.replay();
      await c.approve();
      await refused(c.verifyEvidence());
      await c.scenarioB(); // allowed once the destination is approved
      const b = c.state().scenarioB.result;
      assert.deepEqual([b?.grants, b?.connections, b?.signatures, b?.submissions, b?.attemptRows, b?.transaction], [0, 0, 0, 0, 0, null], 'the authority-ceiling test never reaches the ledger');
      await c.reconsider();
      await refused(c.reconsider());
      const authorized = c.state().scenarioA;
      assert.equal(authorized.authorization?.payment.value, '75000', 'the held payment is the full USD 75,000 as Test RLUSD');
      assert.deepEqual(authorized.authorization?.counters, { grants: 1, connections: 0, signatures: 0, submissions: 0, attempts: 0 }, 'nothing signed or submitted before EXECUTE');
      assert.deepEqual(authorized.lifecycle.map((entry) => entry.state), ['AUTHORIZED']);
      const { completion } = await c.execute();
      await completion;
      assert.equal(c.state().scenarioA.execution?.deliveredValue, '75000', 'the scripted ledger settled exactly USD 75,000 as Test RLUSD');
      await refused(c.execute().then(async ({ completion: again }) => again));
      await c.verifyEvidence();
      await c.reconsiderAgain();
      await c.historical();
      const s = c.state();
      assert.equal(s.verdict.status, 'PASS', JSON.stringify(s.verdict));
      assert.equal(s.scenarioA.execution?.scripted, true);
      assert.match(s.transcript.join('\n'), /Only authorized execution reached the scripted rehearsal ledger/);
      assert.deepEqual(s.checkpoints.map((entry) => entry.step), ['A1', 'A2', 'A3', 'A4', 'B', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']);
      await c.preflight();
      assert.equal(c.state().preflight.treasuryTestRlusd, '9925000', 'the scripted treasury was debited by exactly 75,000');
    } finally {
      await c.close();
    }
  });

  it('after a backend restart the recovered run shows its own recipient, not the new process\'s generated one (23)', async () => {
    const stateRoot = join(tempRoot(), 'state');
    const first = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: stateRoot } });
    await first.preflight();
    await first.createSession();
    await first.request();
    const before = first.state();
    await first.close();
    const restarted = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: stateRoot } });
    const after = restarted.state();
    assert.equal(after.session?.runId, before.session?.runId);
    assert.notEqual(after.preflight.recipient, before.scenarioA.recipient, 'the restarted rehearsal has new accounts');
    assert.equal(after.scenarioA.recipient, before.scenarioA.recipient);
    assert.deepEqual(after.runAccounts, before.runAccounts, 'the header shows the recovered run\'s accounts');
    assert.equal(before.runAccounts?.recipient, before.scenarioA.recipient);
    assert.equal(after.scenarioA.destinationKey, before.scenarioA.destinationKey);
    assert.deepEqual(after.scenarioA.request, before.scenarioA.request);
  });

  it('stopping at AUTHORIZED signs nothing, submits nothing, and is never a PASS', async () => {
    const c = new DemoController({ mode: 'rehearsal', environment: { FRONTERA_ANDREW_STATE_ROOT: join(tempRoot(), 'state') } });
    try {
      await c.preflight();
      await c.createSession();
      await c.request();
      await c.replay();
      await c.approve();
      await c.reconsider();
      await c.abandon();
      const s = c.state();
      assert.equal(s.verdict.status, 'FAIL');
      assert.equal(s.scenarioA.execution, undefined);
      assert.deepEqual(s.scenarioA.lifecycle.map((entry) => entry.state), ['AUTHORIZED', 'NOT SUBMITTED']);
      assert.match(String(s.verdict.failure?.message), /nothing was signed or submitted \(signatures 0, submissions 0\)/);
      assert.equal(s.review.required, false, 'nothing was signed, so nothing needs review');
    } finally {
      await c.close();
    }
  });
});

// ── Fail closed ─────────────────────────────────────────────────────────────

describe('ANDREW-DEMO-UI-01 — LIVE mode fails closed', () => {
  it('refuses a Mainnet endpoint: preflight NOT READY, no session, no run, no transport activity (1, 3)', async () => {
    const f = liveFixture({ environment: { FRONTERA_XRPL_TESTNET_ENDPOINT: 'wss://s1.ripple.com/' } });
    const c = f.controller();
    await c.preflight();
    const s = c.state();
    assert.equal(s.preflight.status, 'NOT READY');
    assert.ok(s.preflight.reasons.some((reason) => /Mainnet server — this demo is XRPL Testnet only/.test(reason)));
    await refused(c.createSession());
    assert.equal(c.state().allowed.request, false);
    assert.deepEqual(runsOf(f.stateRoot), []);
    assert.equal(f.ledger.counts.transportConnects + f.ledger.counts.submits, 0);
    const lines: string[] = [];
    assert.equal(await startAndrewDemoUi({ mode: 'live', environment: { FRONTERA_XRPL_TESTNET_ENDPOINT: 'wss://xrplcluster.com/' }, port: 0, write: (line) => lines.push(line) }), undefined);
    assert.match(lines.join('\n'), /Refused: the XRPL endpoint is a Mainnet server/);
  });

  it('refuses a server that does not report network_id 1 (2, 3)', async () => {
    const f = liveFixture({ ledger: { networkId: 0 } });
    const c = f.controller();
    await c.preflight();
    assert.equal(c.state().preflight.status, 'NOT READY');
    assert.ok(c.state().preflight.reasons.some((reason) => /reports network_id 0, not XRPL Testnet \(1\)/.test(reason)));
    await refused(c.createSession());
    assert.deepEqual(runsOf(f.stateRoot), []);
  });

  it('insufficient Test RLUSD: NOT READY with a funding instruction; never funds, resets or lowers the amount (3)', async () => {
    const f = liveFixture({ ledger: { treasuryRlusd: '5' } });
    const c = f.controller();
    await c.preflight();
    const s = c.state();
    assert.equal(s.preflight.status, 'NOT READY');
    assert.equal(s.preflight.treasuryTestRlusd, '5');
    assert.equal(s.preflight.requiredAmount, '10');
    assert.ok(s.preflight.reasons.some((reason) => /FUNDING REQUIRED — the demo never refills, resets or faucets the fixture/.test(reason)));
    await refused(c.createSession());
    assert.equal(f.ledger.script.treasuryRlusd, '5');
  });

  it('a secrets file readable by others is refused, and its path is not shown to the browser', async () => {
    const f = liveFixture({ secretsMode: 0o644 });
    const c = f.controller();
    await c.preflight();
    const s = c.state();
    assert.equal(s.preflight.status, 'NOT READY');
    assert.ok(s.preflight.reasons.some((reason) => /<secrets file> must be readable by its owner only/.test(reason)));
    assert.equal(JSON.stringify(s).includes(f.secretsFile), false);
  });

  it('an unresolved XRPL attempt from an earlier run: EXECUTION STATE REQUIRES REVIEW, no new payment (24)', async () => {
    const f = liveFixture();
    const prior = join(f.stateRoot, 'runs', 'andrew-prior');
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, 'run.json'), JSON.stringify({ schema: 'frontera.andrew-demo.run.v1', runId: 'andrew-prior', demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: 1, treasury: f.treasury.classicAddress, recipient: f.recipient.classicAddress, startedAt: new Date().toISOString() }));
    const store = createSqliteXrplAttemptStore(join(prior, 'xrpl-attempts.sqlite'));
    store.record({ executionId: 'aoc.exec:prior', requestId: 'aoc.gar:prior', decisionId: 'd', network: 'xrpl-testnet', sourceAccount: f.treasury.classicAddress, destination: f.recipient.classicAddress, currency: 'RLUSD', issuer: 'i', value: '10', fee: '12', sequence: 1, lastLedgerSequence: 2, transactionHash: 'AB'.repeat(32), validatedLedgerAtPrepare: 1, notAfter: new Date().toISOString(), createdAt: new Date().toISOString() }, 'blob');
    store.append('aoc.exec:prior', 'submit-uncertain');
    store.close();
    const c = f.controller();
    await c.preflight();
    const s = c.state();
    assert.equal(s.preflight.status, 'NOT READY');
    assert.equal(s.preflight.attemptState, 'blocked');
    assert.equal(s.review.required, true);
    assert.ok(s.review.reasons.some((reason) => /aoc\.exec:prior .* is 'submit-uncertain'/.test(reason)));
    assert.equal(s.allowed.session, false);
    await refused(c.createSession());
    assert.deepEqual(runsOf(f.stateRoot), ['andrew-prior']);
  });

  it('a backend restart during execution recovers the run read-only and blocks further payments while its attempt is unresolved (23, 24)', async () => {
    const f = liveFixture();
    const runId = 'andrew-20261006T000000Z-abcdef';
    const run = join(f.stateRoot, 'runs', runId);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'run.json'), JSON.stringify({ schema: 'frontera.andrew-demo.run.v1', runId, demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: 1, treasury: f.treasury.classicAddress, recipient: f.recipient.classicAddress, startedAt: '2026-10-06T00:00:00.000Z' }));
    writeFileSync(join(run, 'ui-state.json'), JSON.stringify({ schema: 'frontera.andrew-demo-ui.session.v1', mode: 'live', runId, startedAt: '2026-10-06T00:00:00.000Z', status: 'active', a: { phase: 'executing', lifecycle: [{ state: 'RELEASED', at: '2026-10-06T00:00:01.000Z' }] }, b: { status: 'locked' }, checkpoints: [] }));
    const store = createSqliteXrplAttemptStore(join(run, 'xrpl-attempts.sqlite'));
    store.record({ executionId: 'aoc.exec:inflight', requestId: 'aoc.gar:r', decisionId: 'd', network: 'xrpl-testnet', sourceAccount: f.treasury.classicAddress, destination: f.recipient.classicAddress, currency: 'RLUSD', issuer: 'i', value: '10', fee: '12', sequence: 1, lastLedgerSequence: 2, transactionHash: 'CD'.repeat(32), validatedLedgerAtPrepare: 1, notAfter: new Date().toISOString(), createdAt: new Date().toISOString() }, 'blob');
    store.append('aoc.exec:inflight', 'submitted');
    store.close();

    const c = f.controller(); // the "restarted" backend
    const s = c.state();
    assert.equal(s.session?.runId, runId);
    assert.equal(s.session?.status, 'interrupted');
    assert.equal(s.scenarioA.phase, 'executing');
    assert.equal(s.verdict.status, 'FAIL');
    assert.match(String(s.notice), /cannot resume/);
    assert.equal(s.review.required, true);
    assert.ok(s.review.reasons.some((reason) => reason.includes(runId) && /'submitted'/.test(reason)));
    for (const action of ['session', 'request', 'reconsider', 'execute'] as const) assert.equal(s.allowed[action], false, action);
    await refused(c.createSession());
    assert.equal(JSON.parse(readFileSync(join(run, 'ui-state.json'), 'utf8')).status, 'interrupted');
  });

  it('an interruption before signing (no attempt row) needs no review: nothing was signed', async () => {
    const f = liveFixture();
    const runId = 'andrew-20261006T000000Z-000001';
    const run = join(f.stateRoot, 'runs', runId);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'run.json'), JSON.stringify({ schema: 'frontera.andrew-demo.run.v1', runId, demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: 1, treasury: f.treasury.classicAddress, recipient: f.recipient.classicAddress, startedAt: '2026-10-06T00:00:00.000Z' }));
    writeFileSync(join(run, 'ui-state.json'), JSON.stringify({ runId, startedAt: '2026-10-06T00:00:00.000Z', status: 'active', a: { phase: 'authorized', lifecycle: [] }, b: { status: 'locked' }, checkpoints: [] }));
    createSqliteXrplAttemptStore(join(run, 'xrpl-attempts.sqlite')).close();
    const s = f.controller().state();
    assert.equal(s.session?.status, 'interrupted');
    assert.equal(s.review.required, false);
    assert.equal(s.allowed.session, true);
  });
});
