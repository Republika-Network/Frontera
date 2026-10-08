import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createControlPlaneWebServer, loadControlPlaneWebConfiguration, type ControlPlaneWebServer } from '../../control-plane-web/index.js';
import { Browser, formsOf, freePort, textOf } from '../../control-plane-web/__tests__/web-browser.js';
import { deriveGovernedActionExecutionId } from '../governed-action/identifiers.js';
import { OPERATOR_RESOLUTION_LOG_EVENTS } from '../operations/governed-path-log.js';
import { call, errorCode, expectStatus, logLines, type RecordingAdapter, type Reply } from './ctrl02-host-fixture.js';
import { buildDeniedRequestBody } from './support.js';
import {
  ACCOUNT,
  ADAPTER_ID,
  CEILING,
  DEPLOY,
  LIFETIME_LIMIT,
  ORG,
  PAYABLES,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  TRANSFER,
  authFor,
  bearer,
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
 * PROD-03-02 — Operator Resolution of Unconfirmed Executions: the Host
 * qualification.
 *
 * Everything runs against the shipped secure Host (`bootEnterpriseHost()`,
 * production profile, every durable store, operators, the CORE-07 witness),
 * through `POST /api/governed-actions`, the operator plane over HTTP and the
 * shipped web console. The one in-process seam is the PROD-02 fixture's
 * scripted provider adapter, which counts every call and can be held open.
 *
 * "Claimed, no outcome" with nothing in flight is produced the only honest
 * way: a crash. The adapter is held, the client disconnects, the Host is
 * closed with the provider call still pending, and a new Host boots on the
 * same stores — exactly what a process killed between the write-ahead claim
 * and the provider's answer leaves behind.
 *
 * | Case | Expected |
 * |---|---|
 * | R1 | claimed / no outcome → confirmed-completed: recorded, attributed, no adapter call, leaves Attention, trace verifies, counts agree, survives restart |
 * | R2 | claimed / no outcome → confirmed-not-completed + closed failure: the same, and the reservation is corrected |
 * | R3 | a definitive provider outcome → refused, nothing appended, the provider outcome stays canonical |
 * | R4 | the provider answers while the operator would resolve → the operator is refused while the call is live, and the outcome wins |
 * | R5 | the identical resolution again → replayed, one durable row |
 * | R6 | a conflicting resolution → refused, the first unchanged |
 * | R7 | every role without `operations.resolve` → 403, nothing changes |
 * | R8 | denied, issuance withheld, approval pending, withheld at exercise, evaluation-only → nothing can be recorded |
 */

interface GatedAdapter extends RecordingAdapter {
  next: ExecutionAdapterResult[];
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

type View = Record<string, unknown> & { readonly classification: string; readonly attentionRequired: boolean; readonly unresolved: boolean; readonly resolvable?: boolean };

const ops = {
  executions: (query = ''): string => `/api/admin/operations/executions${query}`,
  attention: (query = ''): string => `/api/admin/operations/attention${query}`,
  trace: (requestId: string, level?: string): string => `/api/admin/operations/traces/${encodeURIComponent(requestId)}${level !== undefined ? `?level=${level}` : ''}`,
  resolution: (executionId: string): string => `/api/admin/operations/executions/${encodeURIComponent(executionId)}/resolution`,
  metrics: '/api/admin/operations/metrics',
  health: '/api/admin/operations/health',
};

async function read(path: string, authorization: string = auth.observer): Promise<Record<string, unknown>> {
  return expectStatus(await call(booted.baseUrl, 'GET', path, { authorization }), 200, path).body;
}

async function viewOf(requestId: string): Promise<View> {
  const views = (await read(ops.executions(`?requestId=${encodeURIComponent(requestId)}`)))['executions'] as View[];
  assert.equal(views.length, 1, `exactly one record for ${requestId}`);
  return views[0] as View;
}

async function attentionIds(): Promise<string[]> {
  return ((await read(ops.attention('?limit=50')))['attention'] as View[]).map((view) => view['requestId'] as string);
}

interface Counts {
  readonly metrics: Record<string, unknown>;
  readonly health: Record<string, unknown>;
}

async function counts(): Promise<Counts> {
  return { metrics: await read(ops.metrics), health: (await read(ops.health))['operations'] as Record<string, unknown> };
}

function assertAgree(c: Counts, where: string): void {
  assert.equal(c.health['unresolvedExecutions'], c.metrics['unresolvedExecutions'], `${where}: health and metrics agree on unresolved`);
  assert.equal(c.health['attentionRequired'], c.metrics['attentionRequired'], `${where}: health and metrics agree on attention`);
  assert.equal((c.metrics['scan'] as Record<string, unknown>)['complete'], true, `${where}: complete scan`);
  assert.equal(c.metrics['consistent'], true, `${where}: one consistent read`);
}

async function verifiedTrace(requestId: string, level?: string): Promise<Record<string, unknown>> {
  const view = await read(ops.trace(requestId, level));
  const verification = view['verification'] as { verified: boolean; checks: { check: string; status: string }[] };
  assert.deepEqual(verification.checks.filter((entry) => entry.status === 'fail'), [], `${requestId}: every trace check passes`);
  assert.equal(verification.verified, true);
  return view;
}

const stagesOf = (view: Record<string, unknown>): Record<string, Record<string, unknown>> => (view['trace'] as Record<string, unknown>)['stages'] as Record<string, Record<string, unknown>>;
const summaryOf = (view: Record<string, unknown>): Record<string, unknown> => (view['trace'] as Record<string, unknown>)['summary'] as Record<string, unknown>;

function resolve(executionId: string, body: unknown, authorization: string = auth.administrator): Promise<Reply> {
  return call(booted.baseUrl, 'POST', ops.resolution(executionId), { authorization, body });
}

/** Rows of the durable P12 resolution table for one execution, read straight from the file. */
function resolutionRows(executionId: string): Record<string, unknown>[] {
  const db = new Database(join(dataDir, 'execution-resolutions.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM execution_resolutions WHERE execution_id = ?`).all(executionId) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function bindingRows(executionId: string): Record<string, unknown>[] {
  const db = new Database(join(dataDir, 'execution-resolutions.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM execution_resolution_bindings WHERE execution_id = ?`).all(executionId) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const resolutionLines = (executionId: string): Record<string, unknown>[] =>
  logLines
    .map((line) => JSON.parse(line) as { message: string; fields?: Record<string, unknown> })
    .filter((entry) => entry.message.startsWith('operator_resolution.') && entry.fields?.['executionId'] === executionId)
    .map((entry) => ({ message: entry.message, ...entry.fields }));

async function restartHost(): Promise<void> {
  await booted.host.close();
  booted = await bootProd02(deployment.envFor(dataDir), adapter);
  hosts.push(booted);
}

/**
 * A crash between the write-ahead claim and the provider's answer: the adapter
 * is entered and never returns, the client goes away, and the process is
 * replaced by a new Host on the same stores. Returns the request and execution
 * of the claim it left behind. While the call is live, an operator resolution
 * is refused (`EXECUTION_IN_FLIGHT`) and nothing is written.
 */
async function crashBetweenClaimAndOutcome(credential: string, body: Record<string, unknown>): Promise<{ readonly requestId: string; readonly executionId: string }> {
  const gate = adapter.hold();
  const client = new AbortController();
  const pending = fetch(`${booted.baseUrl}/api/governed-actions`, {
    method: 'POST',
    headers: { authorization: bearer(credential), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: client.signal,
  }).catch(() => undefined);
  await gate.started;
  const entry = ((await read(ops.attention('?limit=50')))['attention'] as View[]).find((candidate) => candidate.classification === 'claimed-no-outcome');
  assert.ok(entry !== undefined, 'the live claim is under attention');
  const requestId = entry['requestId'] as string;
  const executionId = entry['executionId'] as string;
  assert.equal(entry.resolvable, false, 'a claim whose provider call is live in this process is not offered for resolution');
  // The provider call is live in this process: the operator is refused, and nothing is written.
  const refusedWhileLive = await resolve(executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' });
  assert.equal(refusedWhileLive.status, 409, refusedWhileLive.text);
  assert.equal(errorCode(refusedWhileLive), 'EXECUTION_IN_FLIGHT');
  assert.deepEqual(resolutionRows(executionId), []);
  assert.equal(bindingRows(executionId).length, 1, 'bound before the claim, durably');
  assert.equal(bindingRows(executionId)[0]?.['authority_id'], 'frontera.operator-attestation');
  client.abort();
  await pending;
  await restartHost();
  return { requestId, executionId };
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
  await bootstrap(baseUrl, auth);
  await transition(baseUrl, auth, 'release-production', 'activate');
  payables = (
    await onboard(baseUrl, auth, {
      agentId: PAYABLES,
      subjectId: 'prod0302-payables',
      actions: [TRANSFER],
      resources: [ACCOUNT],
      constraints: [
        { type: 'max_amount', currency: 'USD', value: CEILING },
        { type: 'spending_limit', limitId: 'prod0302-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
      ],
    })
  ).credential;
  releaseAgent = (await onboard(baseUrl, auth, { agentId: RELEASE, subjectId: 'prod0302-release', actions: [DEPLOY, RESTART], resources: [PROD, STAGING] })).credential;
});

describe('PROD-03-02 — the secure Host composes operator attestation and nothing else', () => {
  it('every new governed execution is bound to operator attestation before its claim; nothing is resolvable before it is claimed', async () => {
    const executed = await govern(booted.baseUrl, payables, transfer('100', key('prod0302-bound')));
    assert.equal(executed.body['status'], 'executed', executed.text);
    const executionId = executed.body['executionId'] as string;
    const [binding] = bindingRows(executionId);
    assert.equal(binding?.['authority_id'], 'frontera.operator-attestation');
    assert.equal(binding?.['origin'], 'pre-claim');
    assert.deepEqual(resolutionRows(executionId), []);
    const view = await viewOf(executed.body['requestId'] as string);
    assert.equal(view.classification, 'executed-succeeded');
    assert.equal(view.resolvable, false);
    assert.equal(view['resolution'], null);
    assert.equal(booted.host.enterprise.executionReconciliation !== undefined, true);
    // Asked on its own, operator attestation answers nothing.
    assert.deepEqual(await booted.host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId }), { outcome: 'not-eligible', reason: 'initial-observation-definitive' });
  });
});

describe('PROD-03-02 — R1: claimed, no outcome → confirmed completed', () => {
  let target: { readonly requestId: string; readonly executionId: string };

  it('the crashed claim is under attention, resolvable, unresolved in its trace and bound to operator attestation', async () => {
    target = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-r1')));
    assert.ok((await attentionIds()).includes(target.requestId));
    const view = await viewOf(target.requestId);
    assert.equal(view.classification, 'claimed-no-outcome');
    assert.equal(view.unresolved, true);
    assert.equal(view.resolvable, true, 'after the crash nothing holds it: it is offered for resolution');
    const trace = await verifiedTrace(target.requestId);
    assert.equal(summaryOf(trace)['finalState'], 'claimed-outcome-unrecorded');
    assert.equal(stagesOf(trace)['resolution']?.['presence'], 'unresolved');
    assert.equal((stagesOf(trace)['resolution']?.['binding'] as Record<string, unknown>)['authorityId'], 'frontera.operator-attestation');
  });

  it('an organization administrator records it: durable, attributed to the authenticated operator, and the adapter is not called', async () => {
    const before = await counts();
    const callsBefore = adapter.calls.length;
    const reply = expectStatus(await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' }), 200, 'R1 resolve');
    assert.equal(reply.body['outcome'], 'recorded');
    assert.equal(reply.body['effect'], 'resolution-recorded-no-action-performed');
    assert.equal(reply.body['requestId'], target.requestId);
    assert.equal(reply.body['executionId'], target.executionId);
    const resolution = reply.body['resolution'] as Record<string, unknown>;
    assert.equal(resolution['resolvedBy'], 'operator-attestation');
    assert.equal(resolution['attestedBy'], 'operator:ops-admin', 'the operator comes from the credential');
    assert.equal(resolution['certainty'], 'confirmed-completed');
    assert.equal(resolution['failure'], null);
    assert.equal(adapter.calls.length, callsBefore, 'ZERO adapter calls');

    const rows = resolutionRows(target.executionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['authority_id'], 'frontera.operator-attestation');
    assert.equal(rows[0]?.['attested_by'], 'operator:ops-admin');
    assert.equal(rows[0]?.['certainty'], 'confirmed-completed');
    assert.equal(rows[0]?.['basis_observation_digest'], null, 'it resolved the absence of an observation');
    assert.equal(rows[0]?.['resolution_digest'], resolution['resolutionDigest']);
    assert.equal(bindingRows(target.executionId)[0]?.['origin'], 'pre-claim');

    // It leaves Attention; the execution view shows it resolved — by an operator, not by the provider.
    assert.ok(!(await attentionIds()).includes(target.requestId));
    const view = await viewOf(target.requestId);
    assert.equal(view.classification, 'executed-succeeded');
    assert.equal(view.attentionRequired, false);
    assert.equal(view.unresolved, false);
    assert.equal(view.resolvable, false);
    assert.equal((view['outcome'] as Record<string, unknown>)['source'], 'resolution');
    assert.deepEqual(view['resolution'], { resolvedBy: 'operator-attestation', attestedBy: 'operator:ops-admin', certainty: 'confirmed-completed', failure: null, resolvedAt: resolution['resolvedAt'] });

    // ASSURE-01: the original decision and claim unchanged, no provider outcome, the operator resolution, the resolved state.
    const trace = await verifiedTrace(target.requestId);
    const stages = stagesOf(trace);
    assert.equal(summaryOf(trace)['finalState'], 'resolved-confirmed-completed');
    assert.equal(stages['decision']?.['status'], 'allowed');
    assert.equal((stages['execution']?.['claim'] as Record<string, unknown>)['presence'], 'recorded');
    assert.notEqual(stages['outcome']?.['presence'], 'recorded', 'no provider outcome is invented');
    assert.equal(stages['outcome']?.['certainty'], undefined);
    const traced = stages['resolution']?.['resolution'] as Record<string, unknown>;
    assert.equal(traced['authorityId'], 'frontera.operator-attestation');
    assert.equal(traced['attestedBy'], 'operator:ops-admin');
    assert.equal(traced['resolutionDigest'], resolution['resolutionDigest']);
    assert.equal(stages['resolution']?.['governanceSummary'], 'resolved:confirmed-completed');
    assert.ok(((stages['events']?.['events'] as { eventType: string }[]) ?? []).some((event) => event.eventType === 'execution.outcome.resolved'));

    const after = await counts();
    assertAgree(after, 'R1');
    assert.equal(after.health['unresolvedExecutions'], (before.health['unresolvedExecutions'] as number) - 1);
    assert.equal(after.health['attentionRequired'], (before.health['attentionRequired'] as number) - 1);
    assert.equal(after.metrics['confirmedOutcomes'], (before.metrics['confirmedOutcomes'] as number) + 1);
    assert.equal(after.metrics['executionClaims'], before.metrics['executionClaims'], 'no new claim');

    // Structured logging: the refusal while the call was live, then the request and the recording — closed fields only.
    const lines = resolutionLines(target.executionId);
    assert.deepEqual(
      lines.map((line) => line['message']),
      [OPERATOR_RESOLUTION_LOG_EVENTS.requested, OPERATOR_RESOLUTION_LOG_EVENTS.rejected, OPERATOR_RESOLUTION_LOG_EVENTS.requested, OPERATOR_RESOLUTION_LOG_EVENTS.recorded],
    );
    assert.equal(lines[1]?.['outcome'], 'in-flight');
    const recordedLine = lines[3] ?? {};
    assert.deepEqual(Object.keys(recordedLine).sort(), ['attentionRequired', 'capacity', 'certainty', 'evaluationId', 'executionId', 'message', 'operationalState', 'operatorId', 'outcome', 'requestId', 'resolutionDigest'].sort());
    assert.equal(recordedLine['capacity'], reply.body['capacity'], 'the closed capacity result is logged as the response states it');
    assert.equal(recordedLine['operatorId'], 'ops-admin');
    assert.equal(recordedLine['outcome'], 'recorded');
    assert.equal(recordedLine['resolutionDigest'], resolution['resolutionDigest']);
    for (const line of lines) assert.doesNotMatch(JSON.stringify(line), /Bearer|authorization|providerRef|amount/i);
  });

  it('restart preserves it: the same trace, still resolved, still out of Attention, nothing executed', async () => {
    const beforeRestart = await read(ops.trace(target.requestId));
    const callsBefore = adapter.calls.length;
    await restartHost();
    const afterRestart = await verifiedTrace(target.requestId);
    assert.equal(afterRestart['traceDigest'], beforeRestart['traceDigest']);
    assert.ok(!(await attentionIds()).includes(target.requestId));
    assert.equal((await viewOf(target.requestId)).classification, 'executed-succeeded');
    assert.equal(adapter.calls.length, callsBefore);
  });

  it('R5 — the identical resolution again is a replay: one durable row, nothing new written', async () => {
    const before = resolutionRows(target.executionId);
    const replay = expectStatus(await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' }), 200, 'R5 replay');
    assert.equal(replay.body['outcome'], 'replayed');
    assert.equal((replay.body['resolution'] as Record<string, unknown>)['resolutionDigest'], before[0]?.['resolution_digest']);
    assert.deepEqual(resolutionRows(target.executionId), before, 'one row, byte-for-byte unchanged');
    await verifiedTrace(target.requestId);
  });

  it('R6 — a conflicting resolution is refused deterministically; the recorded one stands', async () => {
    const before = resolutionRows(target.executionId);
    const conflict = await resolve(target.executionId, { resolution: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'none' });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(errorCode(conflict), 'EXECUTION_ALREADY_RESOLVED');
    assert.match(conflict.text, /no action was performed/);
    assert.deepEqual(resolutionRows(target.executionId), before);
    assert.equal(summaryOf(await verifiedTrace(target.requestId))['finalState'], 'resolved-confirmed-completed');
  });
});

describe('PROD-03-02 — R2: claimed, no outcome → confirmed not completed', () => {
  it('requires a closed failure reason; records it; the reservation is corrected; the adapter is not called', async () => {
    const target = await crashBetweenClaimAndOutcome(payables, transfer('200', key('prod0302-r2')));
    const callsBefore = adapter.calls.length;
    const before = await counts();

    const missing = await resolve(target.executionId, { resolution: 'confirmed-not-completed', observedOutcome: 'none' });
    assert.equal(missing.status, 400, missing.text);
    const invented = await resolve(target.executionId, { resolution: 'confirmed-not-completed', failure: 'BANK_SAID_NO', observedOutcome: 'none' });
    assert.equal(invented.status, 400, invented.text);
    assert.deepEqual(resolutionRows(target.executionId), []);

    const reply = expectStatus(await resolve(target.executionId, { resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' }), 200, 'R2 resolve');
    assert.equal(reply.body['outcome'], 'recorded');
    assert.equal(reply.body['capacity'], 'adjusted', 'the P7 reservation no longer consumes: the effect did not complete');
    assert.equal((reply.body['resolution'] as Record<string, unknown>)['failure'], 'PROVIDER_UNAVAILABLE');
    assert.equal(adapter.calls.length, callsBefore, 'ZERO adapter calls');

    const view = await viewOf(target.requestId);
    assert.equal(view.classification, 'executed-failed');
    assert.equal((view['outcome'] as Record<string, unknown>)['failure'], 'PROVIDER_UNAVAILABLE');
    assert.equal((view['resolution'] as Record<string, unknown>)['resolvedBy'], 'operator-attestation');
    assert.ok(!(await attentionIds()).includes(target.requestId));
    const trace = await verifiedTrace(target.requestId);
    assert.equal(summaryOf(trace)['finalState'], 'resolved-confirmed-not-completed');
    assert.equal(stagesOf(trace)['resolution']?.['governanceSummary'], 'resolved:confirmed-not-completed:PROVIDER_UNAVAILABLE');
    assert.equal(stagesOf(trace)['reservation']?.['resolution'], 'confirmed-not-completed', 'the reservation names the resolution');

    const after = await counts();
    assertAgree(after, 'R2');
    assert.equal(after.health['unresolvedExecutions'], (before.health['unresolvedExecutions'] as number) - 1);
    await restartHost();
    assert.equal(summaryOf(await verifiedTrace(target.requestId))['finalState'], 'resolved-confirmed-not-completed');
  });
});

describe('PROD-03-02 — an unconfirmed provider answer is resolvable; the reviewed state must still be the current one', () => {
  it('a stale review is refused (EXECUTION_RESOLUTION_BASIS_CHANGED); the reviewed one is recorded over the unconfirmed observation, which stays historical truth', async () => {
    adapter.next.push({ outcome: 'unconfirmed', providerRef: 'provider-unknown-prod0302' });
    const unknown = await govern(booted.baseUrl, releaseAgent, restart(key('prod0302-unconfirmed')));
    assert.equal(unknown.body['status'], 'execution_unconfirmed', unknown.text);
    const executionId = unknown.body['executionId'] as string;
    const requestId = unknown.body['requestId'] as string;
    assert.equal((await viewOf(requestId)).resolvable, true);

    const stale = await resolve(executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(errorCode(stale), 'EXECUTION_RESOLUTION_BASIS_CHANGED');
    assert.deepEqual(resolutionRows(executionId), []);

    const callsBefore = adapter.calls.length;
    expectStatus(await resolve(executionId, { resolution: 'confirmed-completed', observedOutcome: 'unconfirmed' }), 200, 'resolve unconfirmed');
    assert.equal(adapter.calls.length, callsBefore);
    const trace = await verifiedTrace(requestId);
    assert.equal(summaryOf(trace)['finalState'], 'resolved-confirmed-completed');
    assert.equal(stagesOf(trace)['outcome']?.['certainty'], 'unconfirmed', 'the provider outcome is never rewritten');
    assert.equal((stagesOf(trace)['resolution']?.['resolution'] as Record<string, unknown>)['basisObservationDigest'], stagesOf(trace)['outcome']?.['observationDigest']);
  });
});

describe('PROD-03-02 — R3: a definitive provider outcome is never overwritten', () => {
  it('confirmed completed and confirmed not completed are refused (EXECUTION_OUTCOME_ALREADY_DEFINITIVE); nothing is appended', async () => {
    adapter.next.push({ outcome: 'failed', reason: 'PROVIDER_REJECTED' } as ExecutionAdapterResult);
    for (const [name, body] of [
      ['completed', restart(key('prod0302-r3-completed'))],
      ['failed', restart(key('prod0302-r3-failed'))],
    ] as const) {
      const done = await govern(booted.baseUrl, releaseAgent, body);
      const executionId = done.body['executionId'] as string;
      const requestId = done.body['requestId'] as string;
      const finalBefore = summaryOf(await verifiedTrace(requestId))['finalState'];
      assert.match(String(finalBefore), /^executed-confirmed-/, `${name}: ${done.text}`);
      for (const resolution of ['confirmed-completed', 'confirmed-not-completed'] as const) {
        const reply = await resolve(executionId, { resolution, ...(resolution === 'confirmed-not-completed' ? { failure: 'PROVIDER_REJECTED' } : {}), observedOutcome: 'none' });
        assert.equal(reply.status, 409, reply.text);
        assert.equal(errorCode(reply), 'EXECUTION_OUTCOME_ALREADY_DEFINITIVE');
      }
      assert.deepEqual(resolutionRows(executionId), [], `${name}: no resolution evidence appended`);
      const after = await verifiedTrace(requestId);
      assert.equal(summaryOf(after)['finalState'], finalBefore, `${name}: the provider outcome stays canonical`);
      assert.equal((await viewOf(requestId)).resolvable, false);
    }
  });
});

describe('PROD-03-02 — R4: the provider outcome wins the race', () => {
  it('while the provider call is live the operator is refused; the outcome then commits; the late resolution is refused; no contradictory evidence', async () => {
    const gate = adapter.hold();
    const pending = govern(booted.baseUrl, releaseAgent, restart(key('prod0302-r4')));
    await gate.started;
    const entry = ((await read(ops.attention('?limit=50')))['attention'] as View[]).find((candidate) => candidate.classification === 'claimed-no-outcome');
    assert.ok(entry !== undefined);
    const executionId = entry['executionId'] as string;
    const requestId = entry['requestId'] as string;

    // T0: the operator sees claimed / no outcome. T1: the operator submits while the call is live.
    const early = await resolve(executionId, { resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' });
    assert.equal(early.status, 409, early.text);
    assert.equal(errorCode(early), 'EXECUTION_IN_FLIGHT');
    // T2: the provider answers and its outcome commits.
    gate.release({ outcome: 'completed', providerRef: 'provider-ref-r4' });
    assert.equal((await pending).body['status'], 'executed');
    // T3: the operator's (stale) resolution arrives: the durable provider outcome wins.
    const late = await resolve(executionId, { resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' });
    assert.equal(late.status, 409, late.text);
    assert.equal(errorCode(late), 'EXECUTION_OUTCOME_ALREADY_DEFINITIVE');
    assert.deepEqual(resolutionRows(executionId), []);
    assert.equal(summaryOf(await verifiedTrace(requestId))['finalState'], 'executed-confirmed-completed');
  });
});

describe('PROD-03-02 — R7: only operations.resolve may record a resolution', () => {
  it('every other role is refused before the body is read, and nothing changes; no credential is refused as 401', async () => {
    const target = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-r7')));
    const body = { resolution: 'confirmed-completed', observedOutcome: 'none' };
    for (const [role, authorization] of [
      ['observer', auth.observer],
      ['responder', auth.responder],
      ['provisioner', auth.provisioner],
      ['profile-steward', auth.steward],
      ['approver', auth.approverA],
      ['legacy-administrator', bearer(deployment.secrets.legacyAdministrator)],
    ] as const) {
      const reply = await resolve(target.executionId, body, authorization);
      assert.equal(reply.status, 403, `${role}: ${reply.text}`);
      assert.equal(errorCode(reply), 'OPERATOR_PERMISSION_DENIED', role);
    }
    // Not even a body is read for a refused caller: a malformed one is still 403, not 400.
    const malformed = await call(booted.baseUrl, 'POST', ops.resolution(target.executionId), { authorization: auth.observer, rawBody: '{not json' });
    assert.equal(malformed.status, 403);
    assert.equal((await call(booted.baseUrl, 'POST', ops.resolution(target.executionId), { body })).status, 401);
    const agent = await call(booted.baseUrl, 'POST', ops.resolution(target.executionId), { authorization: bearer(payables), body });
    assert.ok(agent.status === 401 || agent.status === 403, `an agent credential is not an operator credential: ${agent.status}`);
    assert.deepEqual(resolutionRows(target.executionId), []);
    assert.equal((await viewOf(target.requestId)).classification, 'claimed-no-outcome');
    assert.ok((await attentionIds()).includes(target.requestId));
  });

  it('the request names no operator, organization, time or final state: every such field is refused, and the operator is the credential’s', async () => {
    const target = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-forged')));
    for (const forged of [
      { attestedBy: 'operator:someone-else' },
      { operatorId: 'ops-other' },
      { organizationId: 'org-other' },
      { resolvedAt: '2020-01-01T00:00:00.000Z' },
      { finalState: 'executed-confirmed-completed' },
      { providerRef: 'receipt-123' },
      { note: 'checked with the bank' },
      { executionId: 'aoc.exec:00000000000000000000000000000000' },
    ]) {
      const reply = await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none', ...forged });
      assert.equal(reply.status, 400, `${JSON.stringify(forged)}: ${reply.text}`);
    }
    for (const bad of [{ resolution: 'completed', observedOutcome: 'none' }, { resolution: 'confirmed-completed', observedOutcome: 'done' }, { resolution: 'confirmed-completed' }, { resolution: 'confirmed-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'none' }, [], 'confirmed-completed']) {
      assert.equal((await resolve(target.executionId, bad)).status, 400, JSON.stringify(bad));
    }
    // An oversized body is refused by the administration body limit (413, or the connection is reset before it is read).
    const oversized = await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none', padding: 'x'.repeat(2 * 1024 * 1024) }).then(
      (reply) => reply.status,
      () => 'reset',
    );
    assert.ok(oversized === 413 || oversized === 'reset', `oversized: ${String(oversized)}`);
    assert.deepEqual(resolutionRows(target.executionId), []);
    const recorded = expectStatus(await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' }), 200, 'clean');
    assert.equal((recorded.body['resolution'] as Record<string, unknown>)['attestedBy'], 'operator:ops-admin');
  });
});

describe('PROD-03-02 — R8: nothing else can be resolved', () => {
  it('denied, issuance withheld, approval pending, withheld at exercise and evaluation-only: no resolution, no evidence, never 2xx', async () => {
    const executionOf = async (reply: Reply): Promise<string> => deriveGovernedActionExecutionId({ requestId: reply.body['requestId'] as string, decisionId: (await viewOf(reply.body['requestId'] as string))['decisionId'] as string });
    const denied = await govern(booted.baseUrl, payables, transfer('10', key('prod0302-r8-denied'), 'reserve-account-unprovisioned'));
    assert.equal((await viewOf(denied.body['requestId'] as string)).classification, 'decision-denied', denied.text);
    const withheld = await govern(booted.baseUrl, payables, transfer('600', key('prod0302-r8-ceiling')));
    assert.equal(withheld.body['withheldBy'], 'authority-binding', withheld.text);
    const pending = await govern(booted.baseUrl, releaseAgent, release(PROD, key('prod0302-r8-approval')));
    assert.equal(pending.body['withheldBy'], 'approval', pending.text);

    for (const [name, reply] of [
      ['denied', denied],
      ['issuance withheld', withheld],
      ['approval pending', pending],
    ] as const) {
      const view = await viewOf(reply.body['requestId'] as string);
      assert.equal(view.resolvable, false, name);
      const executionId = deriveGovernedActionExecutionId({ requestId: reply.body['requestId'] as string, decisionId: view['decisionId'] as string });
      const attempt = await resolve(executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' });
      assert.equal(attempt.status, 404, `${name}: ${attempt.text}`);
      assert.equal(errorCode(attempt), 'EXECUTION_NOT_FOUND', name);
      assert.deepEqual(resolutionRows(executionId), [], name);
    }

    // Withheld at the exercise boundary (an emergency stop between authority and effect): claimed, never reached a provider.
    expectStatus(await call(booted.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.responder, body: { scope: 'resource', value: STAGING } }), 200, 'stop');
    const stopped = await govern(booted.baseUrl, releaseAgent, restart(key('prod0302-r8-stopped')));
    expectStatus(await call(booted.baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: auth.administrator, body: { scope: 'resource', value: STAGING } }), 200, 'release');
    assert.equal(stopped.body['withheldBy'], 'emergency-control', stopped.text);
    const stoppedView = await viewOf(stopped.body['requestId'] as string);
    assert.equal(stoppedView.resolvable, false);
    const stoppedExecution = (stopped.body['executionId'] as string | undefined) ?? (await executionOf(stopped));
    const stoppedAttempt = await resolve(stoppedExecution, { resolution: 'confirmed-completed', observedOutcome: 'none' });
    // Withheld at exercise (claimed, nothing ran) is not resolvable; withheld before preparation has no execution at all.
    assert.ok(stoppedAttempt.status === 409 || stoppedAttempt.status === 404, stoppedAttempt.text);
    assert.match(String(errorCode(stoppedAttempt)), /^EXECUTION_(NOT_RESOLVABLE|NOT_FOUND)$/);
    assert.deepEqual(resolutionRows(stoppedExecution), []);

    // Evaluation-only: a Kernel decision with no governed path, whatever its request id looks like.
    const spoofedRequestId = `aoc.gar:${'cd'.repeat(16)}`;
    const evaluated = await call(booted.baseUrl, 'POST', '/api/governance/evaluate', { authorization: `Bearer ${deployment.secrets.legacyKey}`, body: buildDeniedRequestBody({ requestId: spoofedRequestId, organization: { id: ORG } }) });
    assert.ok(evaluated.status === 200 || evaluated.status === 422, evaluated.text);
    const evaluationView = await viewOf(spoofedRequestId);
    assert.equal(evaluationView.classification, 'evaluation-only');
    assert.equal(evaluationView.resolvable, false);
    const evaluationExecution = deriveGovernedActionExecutionId({ requestId: spoofedRequestId, decisionId: evaluationView['decisionId'] as string });
    const evaluationAttempt = await resolve(evaluationExecution, { resolution: 'confirmed-completed', observedOutcome: 'none' });
    assert.equal(evaluationAttempt.status, 404, evaluationAttempt.text);
    assert.deepEqual(resolutionRows(evaluationExecution), []);

    // A request id is not an execution id; an unknown execution is not found; neither is ever created.
    const spoofed = await resolve(withheld.body['requestId'] as string, { resolution: 'confirmed-completed', observedOutcome: 'none' });
    assert.equal(spoofed.status, 400, spoofed.text);
    const unknown = await resolve(`aoc.exec:${'ab'.repeat(16)}`, { resolution: 'confirmed-completed', observedOutcome: 'none' });
    assert.equal(unknown.status, 404, unknown.text);
    assert.deepEqual(resolutionRows(`aoc.exec:${'ab'.repeat(16)}`), []);
    assert.deepEqual(bindingRows(`aoc.exec:${'ab'.repeat(16)}`), [], 'refusing it bound nothing either');
  });
});

describe('PROD-03-02 — disclosure', () => {
  it('who attested it is shown at AUDITOR only; the mechanism where the authority stage is; the answer wherever the resolution is', async () => {
    const target = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-disclosure')));
    expectStatus(await resolve(target.executionId, { resolution: 'confirmed-completed', observedOutcome: 'none' }), 200, 'resolve');
    const at = async (level: string): Promise<{ readonly body: Record<string, unknown>; readonly text: string }> => {
      const reply = expectStatus(await call(booted.baseUrl, 'GET', ops.trace(target.requestId, level), { authorization: auth.observer }), 200, level);
      return { body: reply.body, text: reply.text };
    };
    const auditor = await at('AUDITOR');
    assert.equal(((stagesOf(auditor.body)['resolution']?.['resolution']) as Record<string, unknown>)['attestedBy'], 'operator:ops-admin');
    assert.equal(((auditor.body['operational'] as Record<string, unknown>)['resolution'] as Record<string, unknown>)['attestedBy'], 'operator:ops-admin');

    const partner = await at('PARTNER');
    assert.equal(partner.text.includes('ops-admin'), false, 'PARTNER hides the people who acted');
    assert.equal((partner.body['operational'] as Record<string, unknown>)['resolution'] !== undefined, true);
    assert.equal(((partner.body['operational'] as Record<string, unknown>)['resolution'] as Record<string, unknown>)['resolvedBy'], 'operator-attestation');

    const customer = await at('CUSTOMER');
    assert.equal(customer.text.includes('ops-admin'), false);
    assert.equal(customer.text.includes('frontera.operator-attestation'), false, 'CUSTOMER hides the mechanism, as it hides every authority id');
    const resolution = (customer.body['operational'] as Record<string, unknown>)['resolution'] as Record<string, unknown>;
    assert.equal(resolution['certainty'], 'confirmed-completed');
    assert.equal(resolution['resolvedBy'], null);
    assert.equal(resolution['attestedBy'], null);
    assert.equal('resolvable' in (customer.body['operational'] as Record<string, unknown>), false);

    const pub = await at('PUBLIC');
    assert.equal(pub.text.includes('ops-admin'), false);
    assert.equal(pub.text.includes('operator-attestation'), false);
    assert.equal('resolution' in (pub.body['operational'] as Record<string, unknown>), false);
    assert.equal(summaryOf(pub.body)['finalState'], 'resolved-confirmed-completed', 'where it ended is public; who and how is not');
  });
});

describe('PROD-03-02 — CTRL-03: the console workflow', () => {
  it('Attention → trace → Record resolution → explicit confirmation → recorded, out of Attention, shown as an operator resolution', async () => {
    const target = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-console')));
    // A console in front of the Host as it runs now (the crash replaced the process and its port).
    const consoleFor = async (baseUrl: string): Promise<string> => {
      const port = await freePort();
      const configuration = loadControlPlaneWebConfiguration({ FRONTERA_CONSOLE_HOST_URL: baseUrl, FRONTERA_CONSOLE_HTTP_HOST: '127.0.0.1', FRONTERA_CONSOLE_HTTP_PORT: String(port) });
      const server = createControlPlaneWebServer(configuration);
      consoles.push(server);
      await server.listen();
      return configuration.publicOrigin;
    };
    const admin = new Browser(await consoleFor(booted.baseUrl), 'admin');
    await admin.signIn(deployment.secrets.administrator);
    const callsBefore = adapter.calls.length;

    const attention = await admin.get('/attention');
    assert.ok(attention.html.includes(target.requestId), 'the crashed claim is listed under Attention');
    const trace = await admin.get(`/traces/${encodeURIComponent(target.requestId)}`);
    assert.match(trace.html, /data-testid="record-resolution"/);
    for (const word of [/\bRetry\b/, /\bReplay\b/, /\bResend\b/, /Re-execute/, /Mark successful/]) assert.doesNotMatch(trace.html, word);

    const page = await admin.get(`/traces/${encodeURIComponent(target.requestId)}/resolution`);
    assert.equal(page.status, 200);
    const text = textOf(page.html);
    assert.match(text, /This records evidence\. It performs no action\./);
    assert.match(text, /Confirm this execution was completed/);
    assert.match(text, /Confirm this execution was not completed/);
    assert.match(text, /Why a resolution is allowed/);
    assert.match(page.html, /data-testid="resolution-form"/);
    const form = formsOf(page.html).find((candidate) => candidate.action.endsWith('/resolution'));
    assert.ok(form !== undefined);
    assert.deepEqual(form.fields.find(([name]) => name === 'observedOutcome'), ['observedOutcome', 'none']);

    // Without the explicit confirmation nothing is sent to the Host.
    const unconfirmed = await admin.submit(page, (candidate) => candidate.action.endsWith('/resolution'), { resolution: 'confirmed-completed' });
    assert.equal(unconfirmed.status, 200);
    assert.deepEqual(resolutionRows(target.executionId), []);

    const done = await admin.submit(page, (candidate) => candidate.action.endsWith('/resolution'), { resolution: 'confirmed-completed', confirm: 'yes' });
    assert.equal(done.status, 200);
    assert.match(textOf(done.html), /Evidence only — no action was performed/);
    assert.match(done.html, /data-resolved-by="operator-attestation"/);
    assert.match(textOf(done.html), /Operator resolution \(recorded attestation — not a provider confirmation\)/);
    assert.equal(resolutionRows(target.executionId).length, 1);
    assert.equal(adapter.calls.length, callsBefore, 'the console performed nothing');
    assert.equal((await admin.get('/attention')).html.includes(target.requestId), false, 'resolved: no longer under Attention');
    assert.doesNotMatch((await admin.get(`/traces/${encodeURIComponent(target.requestId)}`)).html, /data-testid="record-resolution"/, 'nothing left to resolve');

    // An observer sees no control, and a forged post is refused by the Host.
    const second = await crashBetweenClaimAndOutcome(releaseAgent, restart(key('prod0302-console-observer')));
    const observer = new Browser(await consoleFor(booted.baseUrl), 'observer');
    await observer.signIn(deployment.secrets.observer);
    const observerTrace = await observer.get(`/traces/${encodeURIComponent(second.requestId)}`);
    assert.equal(observerTrace.status, 200);
    assert.doesNotMatch(observerTrace.html, /data-testid="record-resolution"/, 'no control for a role without operations.resolve (presentation only — the Host decides)');
    const forged = await observer.post(`/traces/${encodeURIComponent(second.requestId)}/resolution`, new URLSearchParams({ csrf: formsOf(observerTrace.html)[0]?.fields.find(([name]) => name === 'csrf')?.[1] ?? '', resolution: 'confirmed-completed', observedOutcome: 'none', confirm: 'yes' }).toString());
    assert.equal(forged.status, 403, forged.html.slice(0, 300));
    assert.deepEqual(resolutionRows(second.executionId), []);
  });
});
