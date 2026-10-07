import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createControlPlaneWebServer, loadControlPlaneWebConfiguration, type ControlPlaneWebServer } from '../../control-plane-web/index.js';
import { Browser, formsOf, freePort, textOf } from '../../control-plane-web/__tests__/web-browser.js';
import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import { GOVERNED_PATH_LOG_EVENTS } from '../operations/governed-path-log.js';
import { call, expectStatus, logLines, type RecordingAdapter, type Reply } from './ctrl02-host-fixture.js';
import {
  ACCOUNT,
  ADAPTER_ID,
  CEILING,
  DEPLOY,
  LIFETIME_LIMIT,
  PAYABLES,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  TRANSFER,
  authFor,
  bootProd02,
  bootstrap,
  createDeployment,
  govern,
  key,
  onboard,
  release,
  restart,
  transfer,
  transition,
  type BootedProd02,
  type Deployment,
  type Prod02Auth,
} from './prod02-recovery-fixture.js';

/**
 * PROD-03-01 — Operational Visibility: the five-case Host qualification.
 *
 * Everything runs against the shipped secure Host (`bootEnterpriseHost()`,
 * production profile, every durable store, Ed25519-signed authority, the
 * external CORE-07 witness, operators, approvals, obligations): governed
 * actions through `POST /api/governed-actions`, operators through the operator
 * plane over HTTP and through the shipped web console (`createControlPlaneWebServer`),
 * HTML and links only. No demo composition, no rail, no testnet.
 *
 * | Case | Path | Expected classification | Attention |
 * |---|---|---|---|
 * | 1 | allowed → executed → confirmed completed | `executed-succeeded` | no |
 * | 2 | Kernel denied | `decision-denied` | no |
 * | 3 | Kernel allowed → issuance withheld (P10 ceiling, LAND-02) | `issuance-withheld` | no |
 * | 4 | approval required → pending | `approval-pending` | no |
 * | 5a | claimed → provider answered unconfirmed | `claimed-outcome-unconfirmed` | yes |
 * | 5b | claimed → no outcome recorded (the adapter has not returned) | `claimed-no-outcome` | yes |
 *
 * The one in-process seam is the PROD-02 fixture's: the provider adapter is a
 * scripted recording adapter (it counts calls and can be held open), because
 * the qualification must observe an execution between its write-ahead claim
 * and its outcome without a real provider.
 */

const OBSERVER_ROLES = ['observer', 'responder', 'administrator'] as const;
const DENIED_ROLES = ['provisioner', 'steward', 'approverA'] as const;

interface GatedAdapter extends RecordingAdapter {
  next: ExecutionAdapterResult[];
  /** Holds the next call open until `release` is called; resolves `started` when the adapter is entered. */
  hold(): { readonly started: Promise<void>; release(result: ExecutionAdapterResult): void };
}

function gatedAdapter(): GatedAdapter {
  const calls: ValidatedExecutionAction[] = [];
  let gate: { readonly entered: () => void; readonly answer: Promise<ExecutionAdapterResult> } | undefined;
  const adapter: GatedAdapter = {
    adapterId: ADAPTER_ID,
    calls,
    next: [],
    hold() {
      let entered!: () => void;
      let answer!: (result: ExecutionAdapterResult) => void;
      const started = new Promise<void>((resolvePromise) => (entered = resolvePromise));
      gate = { entered, answer: new Promise<ExecutionAdapterResult>((resolvePromise) => (answer = resolvePromise)) };
      return { started, release: (result) => answer(result) };
    },
    async execute(action) {
      calls.push(action);
      const held = gate;
      if (held !== undefined) {
        gate = undefined;
        held.entered();
        return held.answer;
      }
      return adapter.next.shift() ?? { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
  return adapter;
}

const deployments: Deployment[] = [];
const hosts: BootedProd02[] = [];
const consoles: ControlPlaneWebServer[] = [];
after(async () => {
  for (const server of consoles) await server.close().catch(() => {});
  for (const booted of hosts) await booted.host.close().catch(() => {});
  for (const deployment of deployments) await deployment.close().catch(() => {});
});

let deployment: Deployment;
let dataDir: string;
let booted: BootedProd02;
let adapter: GatedAdapter;
let auth: Prod02Auth;
let payables = '';
let releaseAgent = '';
let browser: Browser;
let refused: Browser;

const cases: Record<string, Reply> = {};
const requestIdOf = (name: string): string => {
  const id = cases[name]?.body['requestId'];
  assert.equal(typeof id, 'string', `${name} has a public requestId`);
  return id as string;
};

const ops = {
  executions: (query = ''): string => `/api/admin/operations/executions${query}`,
  attention: (query = ''): string => `/api/admin/operations/attention${query}`,
  trace: (requestId: string, level?: string): string => `/api/admin/operations/traces/${encodeURIComponent(requestId)}${level !== undefined ? `?level=${level}` : ''}`,
  metrics: '/api/admin/operations/metrics',
  health: '/api/admin/operations/health',
};

async function read(path: string, authorization: string = auth.observer, baseUrl: string = booted.baseUrl): Promise<Record<string, unknown>> {
  return expectStatus(await call(baseUrl, 'GET', path, { authorization }), 200, path).body;
}

type View = Record<string, unknown> & { readonly classification: string; readonly attentionRequired: boolean; readonly unresolved: boolean };

async function viewOf(requestId: string, baseUrl: string = booted.baseUrl): Promise<View> {
  const page = await read(ops.executions(`?requestId=${encodeURIComponent(requestId)}`), auth.observer, baseUrl);
  const views = page['executions'] as View[];
  assert.equal(views.length, 1, `exactly one record for ${requestId}`);
  return views[0] as View;
}

async function attentionIds(baseUrl: string = booted.baseUrl): Promise<string[]> {
  const page = await read(ops.attention('?limit=50'), auth.observer, baseUrl);
  return (page['attention'] as View[]).map((view) => view['requestId'] as string);
}

interface Counts {
  readonly metrics: Record<string, unknown>;
  readonly decisions: Record<string, number>;
  readonly health: Record<string, unknown>;
}

async function counts(baseUrl: string = booted.baseUrl): Promise<Counts> {
  const metrics = await read(ops.metrics, auth.observer, baseUrl);
  const health = await read(ops.health, auth.observer, baseUrl);
  return { metrics, decisions: metrics['decisions'] as Record<string, number>, health: health['operations'] as Record<string, unknown> };
}

function assertAgree(c: Counts, where: string): void {
  assert.equal(c.health['unresolvedExecutions'], c.metrics['unresolvedExecutions'], `${where}: health and metrics agree on unresolved`);
  assert.equal(c.health['attentionRequired'], c.metrics['attentionRequired'], `${where}: health and metrics agree on attention`);
  assert.equal((c.metrics['scan'] as Record<string, unknown>)['complete'], true, `${where}: the scan is complete`);
}

async function verifiedTrace(requestId: string): Promise<Record<string, unknown>> {
  const view = await read(ops.trace(requestId));
  const verification = view['verification'] as { verified: boolean; checks: { check: string; status: string }[] };
  assert.deepEqual(
    verification.checks.filter((entry) => entry.status === 'fail'),
    [],
    `${requestId}: every trace check passes`,
  );
  assert.equal(verification.verified, true);
  return view;
}

const governedPathLines = (requestId: string): Record<string, unknown>[] =>
  logLines
    .map((line) => JSON.parse(line) as { message: string; fields?: Record<string, unknown> })
    .filter((entry) => entry.message.startsWith('governed_path.') && entry.fields?.['requestId'] === requestId)
    .map((entry) => ({ message: entry.message, ...entry.fields }));

/** Every byte of every durable store file (SQLite databases and their write-ahead logs; the shared-memory index is a reader structure, not data). */
function storeBytes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (!name.name.endsWith('-shm')) out.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dataDir);
  return out;
}

/** Waits until background evidence projection (P8) is idle: two identical snapshots in a row. */
async function quiescentBytes(): Promise<Map<string, string>> {
  let previous = storeBytes();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const current = storeBytes();
    if (JSON.stringify([...current]) === JSON.stringify([...previous])) return current;
    previous = current;
  }
  assert.fail('the stores did not settle');
}

async function startConsole(baseUrl: string): Promise<{ readonly origin: string }> {
  const port = await freePort();
  const configuration = loadControlPlaneWebConfiguration({ FRONTERA_CONSOLE_HOST_URL: baseUrl, FRONTERA_CONSOLE_HTTP_HOST: '127.0.0.1', FRONTERA_CONSOLE_HTTP_PORT: String(port) });
  const server = createControlPlaneWebServer(configuration);
  consoles.push(server);
  await server.listen();
  return { origin: configuration.publicOrigin };
}

before(async () => {
  deployment = await createDeployment('software');
  deployments.push(deployment);
  dataDir = deployment.dir('data');
  auth = authFor(deployment.secrets);
  adapter = gatedAdapter();
  booted = await bootProd02(deployment.envFor(dataDir), adapter);
  hosts.push(booted);
  const { baseUrl } = booted;
  assert.equal(booted.host.posture.persistence, 'durable');
  assert.equal(booted.host.posture.governedActions, 'composed');

  await bootstrap(baseUrl, auth);
  await transition(baseUrl, auth, 'release-production', 'activate');
  payables = (
    await onboard(baseUrl, auth, {
      agentId: PAYABLES,
      subjectId: 'prod0301-payables',
      actions: [TRANSFER],
      resources: [ACCOUNT],
      constraints: [
        { type: 'max_amount', currency: 'USD', value: CEILING },
        { type: 'spending_limit', limitId: 'prod0301-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
      ],
    })
  ).credential;
  releaseAgent = (await onboard(baseUrl, auth, { agentId: RELEASE, subjectId: 'prod0301-release', actions: [DEPLOY, RESTART], resources: [PROD, STAGING] })).credential;

  const { origin } = await startConsole(baseUrl);
  browser = new Browser(origin, 'observer');
  await browser.signIn(deployment.secrets.observer);
  refused = new Browser(origin, 'provisioner');
  await refused.signIn(deployment.secrets.provisioner);
});

describe('PROD-03-01 — before any governed action, nothing needs attention', () => {
  it('the operational surfaces are mounted on the secure Host and report zero', async () => {
    const c = await counts();
    assert.deepEqual(c.decisions, { total: 0, allowed: 0, denied: 0, approvalRequired: 0, indeterminate: 0 });
    assert.equal(c.metrics['executionClaims'], 0);
    assert.equal(c.metrics['confirmedOutcomes'], 0);
    assert.equal(c.health['unresolvedExecutions'], 0);
    assert.equal(c.health['attentionRequired'], 0);
    assertAgree(c, 'empty');
    assert.deepEqual(await attentionIds(), []);
    const health = await read(ops.health);
    assert.equal((health['health'] as Record<string, unknown>)['status'], 'healthy');
  });
});

describe('PROD-03-01 — CASE 1: allowed, executed, confirmed completed', () => {
  it('is visible, classified executed-succeeded, carries its claim and confirmed outcome, needs no attention, and its trace verifies', async () => {
    const before = await counts();
    const callsBefore = adapter.calls.length;
    cases['executed'] = await govern(booted.baseUrl, payables, transfer('100', key('prod0301-executed')));
    assert.equal(cases['executed'].body['status'], 'executed', cases['executed'].text);
    assert.equal(adapter.calls.length, callsBefore + 1);

    const view = await viewOf(requestIdOf('executed'));
    assert.equal(view.classification, 'executed-succeeded');
    assert.equal(view.attentionRequired, false);
    assert.equal(view.unresolved, false);
    assert.deepEqual(view['decision'] && (view['decision'] as Record<string, unknown>)['status'], 'allowed');
    assert.equal((view['issuance'] as Record<string, unknown>)['status'], 'issued');
    assert.equal((view['execution'] as Record<string, unknown>)['claim'], 'recorded');
    assert.equal(typeof (view['execution'] as Record<string, unknown>)['claimedAt'], 'string');
    assert.deepEqual(view['outcome'], { status: 'confirmed-completed', source: 'initial-observation', failure: null, withheldBy: null, reasonCodes: [], recordedAt: (view['outcome'] as Record<string, unknown>)['recordedAt'] });
    assert.equal(view['executionId'], cases['executed'].body['executionId']);
    assert.ok(!(await attentionIds()).includes(requestIdOf('executed')));

    const trace = await verifiedTrace(requestIdOf('executed'));
    assert.equal((trace['operational'] as View).classification, 'executed-succeeded');

    const after = await counts();
    assertAgree(after, 'case 1');
    assert.equal(after.decisions['total'], before.decisions['total']! + 1);
    assert.equal(after.decisions['allowed'], before.decisions['allowed']! + 1);
    assert.equal(after.metrics['executionClaims'], (before.metrics['executionClaims'] as number) + 1);
    assert.equal(after.metrics['confirmedOutcomes'], (before.metrics['confirmedOutcomes'] as number) + 1);
    assert.equal(after.health['unresolvedExecutions'], before.health['unresolvedExecutions']);
    assert.equal(after.health['attentionRequired'], before.health['attentionRequired']);

    const lines = governedPathLines(requestIdOf('executed'));
    assert.deepEqual(
      lines.map((line) => line['message']),
      [GOVERNED_PATH_LOG_EVENTS.decision, GOVERNED_PATH_LOG_EVENTS.executionClaimed, GOVERNED_PATH_LOG_EVENTS.executionOutcome],
    );
    assert.equal(lines[2]?.['operationalState'], 'executed-succeeded');
    assert.equal(lines[2]?.['attentionRequired'], false);
  });
});

describe('PROD-03-01 — CASE 2: Kernel denied', () => {
  it('the denial is visible, no issuance stage is invented, nothing executes, no attention, and the trace verifies', async () => {
    const before = await counts();
    const callsBefore = adapter.calls.length;
    cases['denied'] = await govern(booted.baseUrl, payables, transfer('10', key('prod0301-denied'), 'reserve-account-unprovisioned'));
    assert.equal(cases['denied'].body['status'], 'denied', cases['denied'].text);
    assert.equal(adapter.calls.length, callsBefore, 'no adapter call');

    const view = await viewOf(requestIdOf('denied'));
    assert.equal(view.classification, 'decision-denied');
    assert.equal(view.attentionRequired, false);
    assert.equal((view['decision'] as Record<string, unknown>)['status'], 'denied');
    assert.ok(((view['decision'] as Record<string, unknown>)['reasonCodes'] as string[]).length > 0, 'the Kernel’s reason codes are shown');
    assert.deepEqual(view['issuance'], { status: 'not-applicable', withheldBy: null, reasonCodes: [], recordedAt: null }, 'no issuance stage is invented for a denial');
    assert.deepEqual(view['execution'], { claim: 'absent', claimedAt: null });
    assert.equal((view['outcome'] as Record<string, unknown>)['status'], 'none');
    assert.equal(view['executionId'], null);
    assert.ok(!(await attentionIds()).includes(requestIdOf('denied')));

    const trace = await verifiedTrace(requestIdOf('denied'));
    const stages = (trace['trace'] as Record<string, unknown>)['stages'] as Record<string, Record<string, unknown>>;
    assert.equal(stages['authority']?.['presence'], 'not-applicable');
    assert.equal(stages['authority']?.['issuance'], undefined);

    const after = await counts();
    assertAgree(after, 'case 2');
    assert.equal(after.decisions['denied'], before.decisions['denied']! + 1);
    assert.equal(after.metrics['executionClaims'], before.metrics['executionClaims']);
    assert.equal(after.metrics['issuanceWithheld'], before.metrics['issuanceWithheld']);
    assert.equal(after.health['attentionRequired'], before.health['attentionRequired']);
    const lines = governedPathLines(requestIdOf('denied'));
    assert.deepEqual(lines.map((line) => line['message']), [GOVERNED_PATH_LOG_EVENTS.decision]);
    assert.equal(lines[0]?.['operationalState'], 'decision-denied');
    assert.equal(lines[0]?.['attentionRequired'], false);
  });
});

describe('PROD-03-01 — CASE 3: Kernel allowed, issuance withheld (LAND-02, durable authority ceiling)', () => {
  it('shows the allowed decision, the withholding and its closed reason code, with no adapter call, no attention and the issuance on the trace', async () => {
    const before = await counts();
    const callsBefore = adapter.calls.length;
    cases['withheld'] = await govern(booted.baseUrl, payables, transfer('600', key('prod0301-ceiling')));
    assert.equal(cases['withheld'].body['status'], 'withheld', cases['withheld'].text);
    assert.equal(cases['withheld'].body['withheldBy'], 'authority-binding');
    assert.equal(adapter.calls.length, callsBefore, 'no adapter call');

    const view = await viewOf(requestIdOf('withheld'));
    assert.equal(view.classification, 'issuance-withheld');
    assert.equal(view.attentionRequired, false, 'a withholding is governance working, not an incident');
    assert.equal((view['decision'] as Record<string, unknown>)['status'], 'allowed', 'Kernel allowed — distinguishable from a denial');
    const issuance = view['issuance'] as Record<string, unknown>;
    assert.equal(issuance['status'], 'withheld');
    assert.equal(issuance['withheldBy'], 'authority-binding');
    assert.deepEqual(issuance['reasonCodes'], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED], 'the recorded code, not a reinterpretation');
    assert.equal(typeof issuance['recordedAt'], 'string');
    assert.deepEqual(view['execution'], { claim: 'absent', claimedAt: null });
    assert.ok(!(await attentionIds()).includes(requestIdOf('withheld')));

    const trace = await verifiedTrace(requestIdOf('withheld'));
    const authority = ((trace['trace'] as Record<string, unknown>)['stages'] as Record<string, Record<string, unknown>>)['authority'];
    const traced = authority?.['issuance'] as Record<string, unknown>;
    assert.equal(traced['withheldBy'], 'authority-binding');
    assert.deepEqual(traced['reasonCodes'], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);

    const after = await counts();
    assertAgree(after, 'case 3');
    assert.equal(after.metrics['issuanceWithheld'], (before.metrics['issuanceWithheld'] as number) + 1);
    assert.equal(after.decisions['allowed'], before.decisions['allowed']! + 1);
    assert.equal(after.metrics['executionClaims'], before.metrics['executionClaims']);
    assert.equal(after.health['attentionRequired'], before.health['attentionRequired']);
    const lines = governedPathLines(requestIdOf('withheld'));
    assert.deepEqual(lines.map((line) => line['message']), [GOVERNED_PATH_LOG_EVENTS.decision, GOVERNED_PATH_LOG_EVENTS.issuanceWithheld]);
    assert.deepEqual(lines[1]?.['reasonCodes'], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(lines[1]?.['withheldBy'], 'authority-binding');
  });
});

describe('PROD-03-01 — CASE 4: approval pending', () => {
  it('is visible as pending, never as an execution failure, with no adapter call and no attention', async () => {
    const before = await counts();
    const callsBefore = adapter.calls.length;
    cases['pending'] = await govern(booted.baseUrl, releaseAgent, release(PROD, key('prod0301-approval')));
    assert.equal(cases['pending'].body['withheldBy'], 'approval', cases['pending'].text);
    assert.equal(adapter.calls.length, callsBefore, 'no adapter call');

    const view = await viewOf(requestIdOf('pending'));
    assert.equal(view.classification, 'approval-pending');
    assert.equal(view.attentionRequired, false);
    assert.equal(view.unresolved, false);
    assert.equal((view['decision'] as Record<string, unknown>)['status'], 'approval_required');
    assert.deepEqual(view['approval'], { presence: 'recorded', verdicts: ['requested'] });
    assert.equal((view['outcome'] as Record<string, unknown>)['status'], 'none');
    assert.ok(!(await attentionIds()).includes(requestIdOf('pending')));
    await verifiedTrace(requestIdOf('pending'));

    const after = await counts();
    assertAgree(after, 'case 4');
    assert.equal(after.decisions['approvalRequired'], before.decisions['approvalRequired']! + 1);
    assert.equal(after.metrics['executionClaims'], before.metrics['executionClaims']);
    assert.equal(after.health['attentionRequired'], before.health['attentionRequired']);
  });
});

describe('PROD-03-01 — CASE 5: claimed, no confirmed outcome', () => {
  it('5a — the provider answered unconfirmed: claim recorded, no confirmed outcome, unresolved, attention, counted, never retried', async () => {
    const before = await counts();
    adapter.next.push({ outcome: 'unconfirmed', providerRef: 'provider-unknown-1' });
    const callsBefore = adapter.calls.length;
    cases['unconfirmed'] = await govern(booted.baseUrl, releaseAgent, restart(key('prod0301-unconfirmed')));
    assert.equal(cases['unconfirmed'].body['status'], 'execution_unconfirmed', cases['unconfirmed'].text);
    assert.equal(adapter.calls.length, callsBefore + 1);

    const view = await viewOf(requestIdOf('unconfirmed'));
    assert.equal(view.classification, 'claimed-outcome-unconfirmed');
    assert.equal(view.attentionRequired, true);
    assert.deepEqual(view['attentionReasons'], ['EXECUTION_OUTCOME_UNCONFIRMED']);
    assert.equal(view.unresolved, true);
    assert.equal((view['execution'] as Record<string, unknown>)['claim'], 'recorded');
    assert.equal((view['outcome'] as Record<string, unknown>)['status'], 'unconfirmed');
    assert.ok((await attentionIds()).includes(requestIdOf('unconfirmed')), 'listed under attention');
    const trace = await verifiedTrace(requestIdOf('unconfirmed'));
    assert.equal(((trace['trace'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['finalState'], 'executed-unconfirmed');

    const after = await counts();
    assertAgree(after, 'case 5a');
    assert.equal(after.health['unresolvedExecutions'], (before.health['unresolvedExecutions'] as number) + 1);
    assert.equal(after.health['attentionRequired'], (before.health['attentionRequired'] as number) + 1);
    assert.equal(after.metrics['executionClaims'], (before.metrics['executionClaims'] as number) + 1);
    assert.equal(after.metrics['confirmedOutcomes'], before.metrics['confirmedOutcomes'], 'an unconfirmed answer is not a confirmed outcome');

    // Reading it — many times, at every surface — never retries it and never resolves it.
    for (let round = 0; round < 3; round += 1) {
      await read(ops.attention());
      await read(ops.trace(requestIdOf('unconfirmed')));
      await counts();
    }
    assert.equal(adapter.calls.length, callsBefore + 1, 'no read retried the execution');
    assert.equal((await viewOf(requestIdOf('unconfirmed'))).classification, 'claimed-outcome-unconfirmed', 'nothing resolved it');

    const lines = governedPathLines(requestIdOf('unconfirmed'));
    assert.deepEqual(
      lines.map((line) => line['message']),
      [GOVERNED_PATH_LOG_EVENTS.decision, GOVERNED_PATH_LOG_EVENTS.executionClaimed, GOVERNED_PATH_LOG_EVENTS.executionOutcome, GOVERNED_PATH_LOG_EVENTS.unconfirmedExecution],
    );
    assert.equal(lines[2]?.['operationalState'], 'claimed-outcome-unconfirmed');
    assert.equal(lines[3]?.['attentionRequired'], true);
  });

  it('5b — the adapter has not returned: the claim is durable, no outcome exists, it is attention now, and clears only when the outcome is recorded', async () => {
    const before = await counts();
    const gate = adapter.hold();
    const pending = govern(booted.baseUrl, releaseAgent, restart(key('prod0301-in-flight')));
    await gate.started;

    const open = await read(ops.attention('?limit=50'));
    const entry = (open['attention'] as View[]).find((candidate) => candidate.classification === 'claimed-no-outcome');
    assert.ok(entry !== undefined, 'the claimed execution with no outcome is listed under attention');
    assert.equal(entry.attentionRequired, true);
    assert.deepEqual(entry['attentionReasons'], ['EXECUTION_CLAIMED_NO_OUTCOME']);
    assert.equal(entry.unresolved, true);
    assert.equal((entry['execution'] as Record<string, unknown>)['claim'], 'recorded');
    assert.equal((entry['outcome'] as Record<string, unknown>)['status'], 'none');
    const inFlightId = entry['requestId'] as string;
    const during = await counts();
    assertAgree(during, 'case 5b in flight');
    assert.equal(during.health['unresolvedExecutions'], (before.health['unresolvedExecutions'] as number) + 1, 'health counts it');
    assert.equal(during.metrics['executionClaims'], (before.metrics['executionClaims'] as number) + 1);
    const traced = await read(ops.trace(inFlightId));
    assert.equal(((traced['trace'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['finalState'], 'claimed-outcome-unrecorded');
    assert.equal(adapter.calls.length, (before.metrics['executionClaims'] as number) + 1, 'one adapter call per claim — reads add none');

    gate.release({ outcome: 'completed', providerRef: 'provider-ref-in-flight' });
    cases['inFlight'] = await pending;
    assert.equal(cases['inFlight'].body['status'], 'executed', cases['inFlight'].text);
    assert.equal(cases['inFlight'].body['requestId'], inFlightId);
    assert.equal((await viewOf(inFlightId)).classification, 'executed-succeeded');
    assert.ok(!(await attentionIds()).includes(inFlightId), 'the recorded outcome clears it — nothing on the read side did');
    const settled = await counts();
    assertAgree(settled, 'case 5b settled');
    assert.equal(settled.health['unresolvedExecutions'], before.health['unresolvedExecutions']);
    assert.equal(settled.metrics['confirmedOutcomes'], (before.metrics['confirmedOutcomes'] as number) + 1);
  });
});

describe('PROD-03-01 — the operator console shows Attention, Executions, Trace and Host Health from the Host', () => {
  it('Attention lists exactly the unconfirmed execution; Executions classifies every case; neither offers a form that changes anything', async () => {
    const attention = await browser.get('/attention');
    assert.equal(attention.status, 200);
    const rows = [...attention.html.matchAll(/data-request="([^"]+)" data-classification="([^"]+)"/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(rows, [[requestIdOf('unconfirmed'), 'claimed-outcome-unconfirmed']]);
    assert.match(textOf(attention.html), /EXECUTION_OUTCOME_UNCONFIRMED/);

    const executions = await browser.get('/executions');
    assert.equal(executions.status, 200);
    const classified = new Map([...executions.html.matchAll(/data-request="([^"]+)" data-classification="([^"]+)"/g)].map((match) => [match[1], match[2]]));
    assert.equal(classified.get(requestIdOf('executed')), 'executed-succeeded');
    assert.equal(classified.get(requestIdOf('denied')), 'decision-denied');
    assert.equal(classified.get(requestIdOf('withheld')), 'issuance-withheld');
    assert.equal(classified.get(requestIdOf('pending')), 'approval-pending');
    assert.equal(classified.get(requestIdOf('unconfirmed')), 'claimed-outcome-unconfirmed');
    assert.match(textOf(executions.html), new RegExp(F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED));

    for (const page of [attention, executions]) {
      const posting = formsOf(page.html).filter((form) => form.method === 'post').map((form) => form.action);
      assert.deepEqual(posting, ['/logout'], `${page.url}: the only POST form is sign-out`);
      assert.doesNotMatch(textOf(page.html), /\b(Resolve|Retry|Reconcile|Resend)\b/);
    }
  });

  it('Trace shows the stages of the ASSURE-01 trace under the chosen disclosure, and Host Health the counts', async () => {
    const trace = await browser.get(`/traces?requestId=${encodeURIComponent(requestIdOf('withheld'))}`);
    assert.equal(trace.status, 200);
    assert.match(trace.html, /data-testid="trace-level">AUDITOR</);
    assert.match(trace.html, /data-testid="trace-classification">issuance-withheld</);
    for (const stage of ['decision', 'authority', 'execution', 'outcome']) assert.match(trace.html, new RegExp(`data-stage="${stage}"`), stage);
    assert.match(textOf(trace.html), new RegExp(F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED));
    const pub = await browser.get(`/traces/${encodeURIComponent(requestIdOf('withheld'))}?level=PUBLIC`);
    assert.equal(pub.status, 200);
    assert.match(pub.html, /data-testid="trace-level">PUBLIC</);
    assert.doesNotMatch(pub.html, /data-stage="authority"/, 'PUBLIC hides the authority stage');

    const health = await browser.get('/host-health');
    assert.equal(health.status, 200);
    assert.match(health.html, /data-testid="unresolved-count">1</);
    assert.match(health.html, /data-testid="attention-count">1</);
  });

  it('an operator without the operational read permission sees the Host’s refusal, not the data', async () => {
    for (const path of ['/attention', '/executions', '/host-health', `/traces/${encodeURIComponent(requestIdOf('executed'))}`]) {
      const page = await refused.get(path);
      assert.equal(page.status, 403, path);
      assert.doesNotMatch(page.html, new RegExp(requestIdOf('unconfirmed').replace('.', '\\.')), `${path} shows no request`);
    }
  });
});

describe('PROD-03-01 — authorization, disclosure and the trace model', () => {
  it('observer, responder and organization-administrator read; provisioner, profile steward, approver, the CTRL-01 administrator, API keys and agents do not', async () => {
    for (const role of OBSERVER_ROLES) {
      for (const path of [ops.executions(), ops.attention(), ops.trace(requestIdOf('executed')), ops.metrics, ops.health]) expectStatus(await call(booted.baseUrl, 'GET', path, { authorization: auth[role] }), 200, `${role} ${path}`);
    }
    for (const role of DENIED_ROLES) {
      for (const path of [ops.executions(), ops.attention(), ops.trace(requestIdOf('executed')), ops.metrics, ops.health]) {
        const reply = expectStatus(await call(booted.baseUrl, 'GET', path, { authorization: auth[role] }), 403, `${role} ${path}`);
        assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'OPERATOR_PERMISSION_DENIED');
      }
    }
    const others = [`Bearer ${deployment.secrets.legacyAdministrator}`, `Bearer ${deployment.secrets.legacyKey}`, `Bearer ${deployment.secrets.customerKey}`, `Bearer ${payables}`];
    for (const authorization of others) {
      for (const path of [ops.executions(), ops.attention(), ops.metrics, ops.health]) {
        const reply = await call(booted.baseUrl, 'GET', path, { authorization });
        assert.ok(reply.status === 401 || reply.status === 403, `${path}: ${reply.status}`);
      }
    }
    expectStatus(await call(booted.baseUrl, 'GET', ops.executions()), 401, 'no credential');
  });

  it('the operator trace is the ASSURE-01 trace: the same disclosed digest a third party fetches; FULL is refused; lower levels hide what they hide', async () => {
    for (const name of ['executed', 'denied', 'withheld', 'pending', 'unconfirmed']) {
      const requestId = requestIdOf(name);
      const operator = await read(ops.trace(requestId, 'AUDITOR'));
      const thirdParty = expectStatus(await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: `Bearer ${deployment.secrets.legacyKey}` }), 200, 'third-party trace');
      assert.equal(operator['traceDigest'], thirdParty.body['traceDigest'], `${name}: one trace implementation`);
      assert.deepEqual(operator['trace'], thirdParty.body['trace'], `${name}: the same disclosed trace`);
    }
    const full = expectStatus(await call(booted.baseUrl, 'GET', ops.trace(requestIdOf('executed'), 'FULL'), { authorization: auth.administrator }), 403, 'FULL');
    assert.equal((full.body['error'] as Record<string, unknown>)['code'], 'EVIDENCE_DISCLOSURE_NOT_PERMITTED');
    expectStatus(await call(booted.baseUrl, 'GET', ops.trace(requestIdOf('executed'), 'SECRET'), { authorization: auth.observer }), 400, 'unknown level');
    const partner = await read(ops.trace(requestIdOf('withheld'), 'PARTNER'));
    const issuance = (((partner['trace'] as Record<string, unknown>)['stages'] as Record<string, Record<string, unknown>>)['authority']?.['issuance'] ?? {}) as Record<string, unknown>;
    assert.equal(issuance['requested'], undefined, 'PARTNER hides the requested amount');
    assert.equal(issuance['ceiling'], undefined, 'PARTNER hides the ceiling');
    const pub = await read(ops.trace(requestIdOf('executed'), 'PUBLIC'));
    assert.deepEqual(Object.keys((pub['trace'] as Record<string, unknown>)['stages'] as object), []);
    assert.equal((pub['verification'] as Record<string, unknown>)['traceDigest'], undefined, 'below AUDITOR the canonical digest is withheld');
    expectStatus(await call(booted.baseUrl, 'GET', ops.trace('aoc.gar:00000000000000000000000000000000'), { authorization: auth.observer }), 404, 'unknown request');
    expectStatus(await call(booted.baseUrl, 'GET', ops.trace('not-a-request'), { authorization: auth.observer }), 400, 'malformed request id');
  });

  it('no operational response, console page or governed-path log line carries a secret, a credential, a provider reference or an amount field', async () => {
    const bodies: string[] = [];
    for (const path of [ops.executions('?limit=50'), ops.attention('?limit=50'), ops.metrics, ops.health]) bodies.push((await call(booted.baseUrl, 'GET', path, { authorization: auth.observer })).text);
    for (const name of ['executed', 'withheld', 'unconfirmed']) bodies.push((await call(booted.baseUrl, 'GET', ops.trace(requestIdOf(name)), { authorization: auth.observer })).text);
    for (const path of ['/attention', '/executions', '/host-health']) bodies.push((await browser.get(path)).html);
    const logs = logLines.filter((line) => line.includes('governed_path.'));
    assert.ok(logs.length >= 10, 'the governed path was logged');
    const secrets = [...deployment.secretValues(), payables, releaseAgent];
    for (const text of [...bodies, ...logs]) {
      for (const secret of secrets) assert.equal(text.includes(secret), false, 'no secret value');
      assert.doesNotMatch(text, /Bearer\s/);
    }
    for (const text of [bodies[0], bodies[1], ...logs]) {
      assert.doesNotMatch(text ?? '', /"(amount|requested|ceiling|providerRef|adapterId|routedBy|parameters|payload|authorization)"\s*:/, 'the list views and logs carry no amount, provider or payload field');
      assert.doesNotMatch(text ?? '', /provider-ref-|provider-unknown-/);
    }
  });
});

describe('PROD-03-01 — operational reads change nothing', () => {
  it('every operational read, at every surface and role, leaves every durable store byte for byte as it was and calls no adapter', async () => {
    const before = await quiescentBytes();
    assert.ok([...before.keys()].some((file) => file.endsWith('.sqlite')), 'the durable stores are measured');
    const callsBefore = adapter.calls.length;
    const approvalsBefore = await read('/api/admin/approvals?view=all');
    const emergencyBefore = await read('/api/admin/emergency-controls', auth.administrator);
    const grantBefore = await read(`/api/admin/authority/executions/${encodeURIComponent(cases['executed']?.body['executionId'] as string)}`);
    for (const role of OBSERVER_ROLES) {
      for (const path of [ops.executions('?limit=50'), ops.attention('?limit=50'), ops.metrics, ops.health]) await read(path, auth[role]);
      for (const name of Object.keys(cases)) for (const level of ['AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC']) await read(ops.trace(requestIdOf(name), level), auth[role]);
    }
    for (const path of ['/attention', '/executions', '/host-health', `/traces/${encodeURIComponent(requestIdOf('unconfirmed'))}`]) await browser.get(path);
    const afterBytes = storeBytes();
    assert.deepEqual([...afterBytes.keys()].sort(), [...before.keys()].sort(), 'no store file appeared or disappeared');
    for (const [file, digest] of before) assert.equal(afterBytes.get(file), digest, `${file} unchanged`);
    assert.equal(adapter.calls.length, callsBefore, 'no adapter call');
    assert.deepEqual(await read('/api/admin/approvals?view=all'), approvalsBefore, 'approval state unchanged');
    assert.deepEqual(await read('/api/admin/emergency-controls', auth.administrator), emergencyBefore, 'emergency controls unchanged');
    assert.deepEqual(await read(`/api/admin/authority/executions/${encodeURIComponent(cases['executed']?.body['executionId'] as string)}`), grantBefore, 'the grant is unchanged');
  });

  it('there is no write route: every method other than GET on the operational paths is unrouted', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of [ops.executions(), ops.attention(), ops.trace(requestIdOf('unconfirmed')), ops.metrics, ops.health, `${ops.trace(requestIdOf('unconfirmed'))}/resolve`, '/api/admin/operations/executions/retry']) {
        const reply = await call(booted.baseUrl, method, path, { authorization: auth.administrator, body: {} });
        assert.equal(reply.status, 404, `${method} ${path}`);
        assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
      }
    }
  });
});

describe('PROD-03-01 — the read model is durable state, not process memory', () => {
  it('after a restart the same classifications, attention and counts are read back, with zero adapter calls', async () => {
    const beforeViews = await read(ops.executions('?limit=50'));
    const beforeCounts = await counts();
    const beforeAttention = await attentionIds();
    await booted.host.close();
    const restarted = await bootProd02(deployment.envFor(dataDir), adapter);
    hosts.push(restarted);
    const callsBefore = adapter.calls.length;
    const afterViews = await read(ops.executions('?limit=50'), auth.observer, restarted.baseUrl);
    assert.deepEqual(afterViews, beforeViews);
    assert.deepEqual(await attentionIds(restarted.baseUrl), beforeAttention);
    const afterCounts = await counts(restarted.baseUrl);
    assert.deepEqual({ ...afterCounts.metrics, computedAt: null }, { ...beforeCounts.metrics, computedAt: null });
    assert.equal(afterCounts.health['unresolvedExecutions'], beforeCounts.health['unresolvedExecutions']);
    assert.equal(adapter.calls.length, callsBefore);
    assert.ok(existsSync(dataDir));
  });
});
