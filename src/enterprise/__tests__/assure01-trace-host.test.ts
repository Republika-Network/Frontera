import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { RecordingAdapter } from './ctrl02-host-fixture.js';
import { call, expectStatus, type Reply } from './ctrl02-host-fixture.js';
import {
  ACCOUNT,
  ADAPTER_ID,
  CEILING,
  DEPLOY,
  EDGE,
  EVIDENCE_HASH,
  FROZEN,
  LIFETIME_LIMIT,
  MAINTAIN,
  OBLIGATION,
  ORG,
  PAYABLES,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  TRANSFER,
  approvalCommand,
  approvalFor,
  approverStanding,
  authFor,
  backupCli,
  bootProd02,
  bootstrap,
  createDeployment,
  govern,
  key,
  maintain,
  onboard,
  portability,
  readManifest,
  release,
  restart,
  secretsFound,
  transfer,
  transition,
  type BootedProd02,
  type Deployment,
} from './prod02-recovery-fixture.js';

/**
 * ASSURE-01 — the exit criterion, literally: *a third party can fetch and verify
 * one request's full trace via API.*
 *
 * Everything below runs against the shipped secure Host (`bootEnterpriseHost()`,
 * production profile, every durable store, Ed25519-signed authority, the
 * external CORE-07 witness, operators, approvals, obligations, emergency
 * controls). Governed actions, operator actions and the third party's reads are
 * all real HTTP. The third party is the holder of an organization-scoped API
 * key (an auditor's key): it never touches a database, the source, or an
 * in-process service, and learns every request id only from a public
 * `POST /api/governed-actions` response.
 *
 * The one in-process seam the PROD-02 qualification already uses is kept, and
 * named: the configured independent obligation source reports its discharge
 * through the trusted in-process writer (no HTTP route exists for it — CORE-04).
 */

const auditorKey = `ASSURE01AUDITOR${randomBytes(20).toString('hex')}`;
const foreignKey = `ASSURE01FOREIGN${randomBytes(20).toString('hex')}`;
const AUDITOR = `Bearer ${auditorKey}`;
const FOREIGN = `Bearer ${foreignKey}`;

/** The provider adapter, scripted per call so outcomes other than "completed" are real adapter answers. */
interface ScriptedAdapter extends RecordingAdapter {
  next: ExecutionAdapterResult[];
}
function scriptedAdapter(): ScriptedAdapter {
  const calls: ValidatedExecutionAction[] = [];
  const adapter: ScriptedAdapter = {
    adapterId: ADAPTER_ID,
    calls,
    next: [],
    async execute(action) {
      calls.push(action);
      return adapter.next.shift() ?? { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
  return adapter;
}

const tracePath = (requestId: string, level = 'AUDITOR'): string => `/api/evidence/traces/${encodeURIComponent(requestId)}?level=${level}`;
const verifyPath = (requestId: string): string => `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`;

interface TraceView {
  readonly status: number;
  readonly trace: Record<string, unknown>;
  readonly stages: Record<string, Record<string, unknown>>;
  readonly summary: Record<string, unknown>;
  readonly traceDigest: string;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function fetchTrace(baseUrl: string, requestId: string, level = 'AUDITOR', authorization = AUDITOR): Promise<TraceView> {
  const reply = expectStatus(await call(baseUrl, 'GET', tracePath(requestId, level), { authorization }), 200, `trace ${level}`);
  const trace = reply.body['trace'] as Record<string, unknown>;
  return { status: reply.status, trace, stages: trace['stages'] as Record<string, Record<string, unknown>>, summary: trace['summary'] as Record<string, unknown>, traceDigest: reply.body['traceDigest'] as string, body: reply.body, text: reply.text };
}

async function verifyTrace(baseUrl: string, requestId: string, authorization = AUDITOR): Promise<Record<string, unknown>> {
  return expectStatus(await call(baseUrl, 'GET', verifyPath(requestId), { authorization }), 200, 'verify trace').body;
}

function assertVerified(verification: Record<string, unknown>, where: string): void {
  const failures = (verification['checks'] as { check: string; status: string; detail?: string }[]).filter((entry) => entry.status === 'fail');
  assert.deepEqual(failures, [], `${where}: every check passes`);
  assert.equal(verification['verified'], true, where);
  assert.deepEqual(verification['categories'], { contract: 'pass', integrity: 'pass', authenticity: 'pass', correlation: 'pass', completeness: 'pass' }, where);
}

const eventTypes = (view: TraceView): string[] => (view.stages['events']?.['events'] as { eventType: string }[]).map((event) => event.eventType);

const deployments: Deployment[] = [];
const hosts: BootedProd02[] = [];
after(async () => {
  for (const booted of hosts) await booted.host.close().catch(() => {});
  for (const deployment of deployments) await deployment.close().catch(() => {});
});

let deployment: Deployment;
let dataDir: string;
let envFor: (dir: string) => Record<string, string | undefined>;
let booted: BootedProd02;
let adapter: ScriptedAdapter;
let auth: ReturnType<typeof authFor>;
let payables = '';
let releaseAgent = '';

/** The public responses each case produced: the only place the third party learns its ids from. */
const cases: Record<string, Reply> = {};

async function boot(dir: string): Promise<BootedProd02> {
  adapter = scriptedAdapter();
  const host = await bootProd02(envFor(dir), adapter);
  hosts.push(host);
  return host;
}

const requestIdOf = (name: string): string => {
  const id = cases[name]?.body['requestId'];
  assert.equal(typeof id, 'string', `${name} has a public requestId`);
  return id as string;
};

before(async () => {
  deployment = await createDeployment('software');
  deployments.push(deployment);
  // The deployment's own organization-scoped keys: the operator's legacy key, and the auditor's (the third party). Plus another organization's key.
  envFor = (dir) => {
    const env = deployment.envFor(dir);
    return { ...env, AOC_ENTERPRISE_API_KEYS: `${env['AOC_ENTERPRISE_API_KEYS'] ?? ''},${auditorKey}:${ORG},${foreignKey}:org-foreign-assure01` };
  };
  dataDir = deployment.dir('data');
  auth = authFor(deployment.secrets);
  booted = await boot(dataDir);
  const { baseUrl } = booted;
  assert.equal(booted.host.posture.evidenceStore, 'durable', 'the secure Host composes the durable Evidence Bundle Store');

  await bootstrap(baseUrl, auth);
  for (const profileId of ['release-production', 'edge-maintenance']) await transition(baseUrl, auth, profileId, 'activate');
  await approverStanding(baseUrl, auth, 'approver-a');
  payables = (
    await onboard(baseUrl, auth, {
      agentId: PAYABLES,
      subjectId: 'assure01-payables',
      actions: [TRANSFER],
      resources: [ACCOUNT, FROZEN],
      constraints: [
        { type: 'max_amount', currency: 'USD', value: CEILING },
        { type: 'spending_limit', limitId: 'payables-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
      ],
    })
  ).credential;
  releaseAgent = (await onboard(baseUrl, auth, { agentId: RELEASE, subjectId: 'assure01-release', actions: [DEPLOY, MAINTAIN, RESTART], resources: [PROD, EDGE, STAGING] })).credential;

  // 1. ALLOW, executed, confirmed-completed — monetary.
  cases['monetary'] = await govern(baseUrl, payables, transfer('100', key('money')));
  assert.equal(cases['monetary'].body['status'], 'executed', cases['monetary'].text);
  // 2. ALLOW, executed — materially non-financial (a service restart).
  cases['nonFinancial'] = await govern(baseUrl, releaseAgent, restart(key('restart')));
  assert.equal(cases['nonFinancial'].body['status'], 'executed', cases['nonFinancial'].text);
  // 3. DENY before any grant: a resource the agent holds no authority over.
  cases['denied'] = await govern(baseUrl, payables, transfer('10', key('deny'), 'reserve-account-unprovisioned'));
  assert.equal(cases['denied'].body['status'], 'denied', cases['denied'].text);
  // 4. Approval required → pending (bundle sealed now) → approved → resumed → executed.
  const approvalKey = key('approval');
  cases['approvalPending'] = await govern(baseUrl, releaseAgent, release(PROD, approvalKey));
  assert.equal(cases['approvalPending'].body['withheldBy'], 'approval', cases['approvalPending'].text);
  // 5. Obligation required → discharged by the configured independent source → resumed → executed.
  const obligationKey = key('obligation');
  cases['obligationWithheld'] = await govern(baseUrl, releaseAgent, maintain(obligationKey));
  assert.equal(cases['obligationWithheld'].body['withheldBy'], 'obligations', cases['obligationWithheld'].text);
  // 6. Executed, then its grant revoked by an operator.
  cases['revoked'] = await govern(baseUrl, releaseAgent, restart(key('revoked')));
  assert.equal(cases['revoked'].body['status'], 'executed');
  // 7. The provider answers "failed": confirmed-not-completed.
  adapter.next.push({ outcome: 'failed', reason: 'PROVIDER_REJECTED', providerRef: 'provider-rejected-1' });
  cases['notCompleted'] = await govern(baseUrl, releaseAgent, restart(key('failed')));
  assert.equal(cases['notCompleted'].body['status'], 'execution_failed', cases['notCompleted'].text);
  // 8. The provider cannot say: unconfirmed (no P12 resolver composed on the shipped Host).
  adapter.next.push({ outcome: 'unconfirmed', providerRef: 'provider-unknown-1' });
  cases['unconfirmed'] = await govern(baseUrl, releaseAgent, restart(key('unconfirmed')));
  assert.equal(cases['unconfirmed'].body['status'], 'execution_unconfirmed', cases['unconfirmed'].text);
  // 9. An active emergency stop withholds before any execution.
  expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.responder, body: { scope: 'resource', value: FROZEN } }), 200, 'stop');
  cases['emergency'] = await govern(baseUrl, payables, transfer('5', key('frozen'), FROZEN));
  assert.equal(cases['emergency'].body['withheldBy'], 'emergency-control', cases['emergency'].text);

  // Resume 4 and 5, and revoke 6 — each through its real channel.
  const pendingView = await approvalFor(baseUrl, auth, requestIdOf('approvalPending'));
  const pendingBundle = expectStatus(await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId: requestIdOf('approvalPending'), level: 'AUDITOR' } }), 201, 'pending bundle');
  cases['pendingBundle'] = pendingBundle;
  expectStatus(await approvalCommand(baseUrl, auth.approverA, pendingView, 'approve', { evidence: [{ type: 'source_document', hash: EVIDENCE_HASH }] }), 200, 'approve');
  cases['approved'] = await govern(baseUrl, releaseAgent, release(PROD, approvalKey));
  assert.equal(cases['approved'].body['status'], 'executed', cases['approved'].text);

  const discharges = booted.host.enterprise.obligationDischarges;
  assert.ok(discharges !== undefined);
  await discharges.record(
    { system: true, actorId: 'operator:change-board-integration' },
    { correlation: { requestId: requestIdOf('obligationWithheld'), action: MAINTAIN, resourceScope: EDGE }, obligationType: OBLIGATION, sourceId: 'change-approvals', outcome: 'discharged', observedAt: new Date(Date.now() - 60_000).toISOString(), reference: 'CAB-ASSURE01' },
  );
  cases['obligationDischarged'] = await govern(baseUrl, releaseAgent, maintain(obligationKey));
  assert.equal(cases['obligationDischarged'].body['status'], 'executed', cases['obligationDischarged'].text);

  // The operator learns the grant of 6 from the trace itself, then revokes it.
  const revokedTrace = await fetchTrace(baseUrl, requestIdOf('revoked'));
  const revokedGrantId = ((revokedTrace.stages['authority']?.['grants'] as Record<string, unknown>[])[0] ?? {})['grantId'] as string;
  cases['revokedBundle'] = expectStatus(await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId: requestIdOf('revoked'), level: 'AUDITOR' } }), 201, 'pre-revocation bundle');
  expectStatus(await call(baseUrl, 'POST', `/api/admin/authority/grants/${encodeURIComponent(revokedGrantId)}/revoke`, { authorization: auth.responder, body: { reason: 'security-incident' } }), 200, 'revoke grant');
});

describe('ASSURE-01 — a third party fetches and verifies one request’s full trace via the Host API', () => {
  it('ALLOW → executed → confirmed-completed: every canonical stage is reached, recorded and verifies', async () => {
    const { baseUrl } = booted;
    const requestId = requestIdOf('monetary');
    const view = await fetchTrace(baseUrl, requestId);
    assert.equal(view.trace['requestId'], requestId);
    assert.equal(view.trace['decisionId'], (cases['monetary']?.body['decision'] as Record<string, unknown>)['decisionId'], 'the decision the public response named');
    assert.equal(view.trace['evaluationId'], (cases['monetary']?.body['decision'] as Record<string, unknown>)['evaluationId']);
    assert.equal(view.trace['executionId'], cases['monetary']?.body['executionId'], 'the execution the public response named');
    assert.equal(view.summary['finalState'], 'executed-confirmed-completed');
    assert.equal(view.stages['decision']?.['status'], 'allowed');
    assert.equal(view.stages['request']?.['actorId'], PAYABLES, 'WHO requested');
    assert.equal(view.stages['request']?.['actionType'], TRANSFER, 'WHAT action');
    assert.equal(view.stages['request']?.['resourceScope'], ACCOUNT, 'WHAT resource');
    assert.equal(view.trace['organizationId'], ORG, 'UNDER WHICH organization');
    const grants = view.stages['authority']?.['grants'] as Record<string, unknown>[];
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.['presence'], 'recorded');
    assert.equal(grants[0]?.['exercised'], true, 'WHICH grant authorized it');
    assert.equal(grants[0]?.['referenceDigest'], grants[0]?.['grantDigest']);
    assert.equal(view.stages['authority']?.['storeKind'], 'authenticated-durable');
    const execution = view.stages['execution'] as Record<string, Record<string, unknown>>;
    assert.equal(execution['claim']?.['presence'], 'recorded', 'execution was claimed');
    assert.equal(execution['attempt']?.['boundedGrantId'], grants[0]?.['grantId']);
    assert.deepEqual(view.stages['parameters']?.['amount'], { value: '100', unit: 'USD' }, 'the exercised amount, from the P11 attempt');
    assert.equal(view.stages['reservation']?.['state'], 'settled');
    assert.equal(view.stages['outcome']?.['certainty'], 'confirmed-completed', 'the initial outcome');
    assert.equal(view.stages['outcome']?.['adapterId'], ADAPTER_ID, 'WHICH adapter execution identity');
    assert.equal(view.stages['resolution']?.['presence'], 'not-applicable', 'a confirmed outcome needs no reconciliation');
    assert.deepEqual(
      eventTypes(view).filter((type) => !type.startsWith('exercise.reservation')),
      ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed'],
      'WHICH canonical events prove the progression, in order',
    );
    assertVerified(await verifyTrace(baseUrl, requestId), 'monetary');
  });

  it('action neutrality: a materially non-financial action traces through the same contract, with no amount and no domain field', async () => {
    const { baseUrl } = booted;
    const view = await fetchTrace(baseUrl, requestIdOf('nonFinancial'));
    assert.equal(view.summary['finalState'], 'executed-confirmed-completed');
    assert.equal(view.stages['request']?.['actionType'], RESTART);
    assert.equal(view.stages['parameters']?.['amount'], undefined, 'no money where there is none');
    assert.deepEqual(Object.keys(view.stages).sort(), Object.keys((await fetchTrace(baseUrl, requestIdOf('monetary'))).stages).sort(), 'the same stages for both');
    assertVerified(await verifyTrace(baseUrl, requestIdOf('nonFinancial')), 'non-financial');
  });

  it('DENY: the trace says denied — no fictional grant, execution, outcome or resolution — and the adapter was never called for it', async () => {
    const { baseUrl } = booted;
    const view = await fetchTrace(baseUrl, requestIdOf('denied'));
    assert.equal(view.summary['finalState'], 'denied');
    assert.equal(view.trace['executionId'], undefined, 'a denial has no execution identity');
    for (const stage of ['authority', 'execution', 'parameters', 'reservation', 'outcome', 'resolution']) assert.equal(view.stages[stage]?.['presence'], 'not-applicable', stage);
    assert.deepEqual(eventTypes(view), ['governance.decision.committed']);
    assert.equal(adapter.calls.some((action) => action.resource === 'reserve-account-unprovisioned'), false);
    assertVerified(await verifyTrace(baseUrl, requestIdOf('denied')), 'denied');
  });

  it('approval: the pending request traced as approval-pending; once approved and resumed, the same request traces the approval, the grant and the execution', async () => {
    const { baseUrl } = booted;
    const pending = await fetchTrace(baseUrl, requestIdOf('approvalPending'));
    const approved = await fetchTrace(baseUrl, requestIdOf('approved'));
    assert.equal(requestIdOf('approvalPending'), requestIdOf('approved'), 'one request, resumed');
    assert.equal(approved.summary['finalState'], 'executed-confirmed-completed');
    assert.equal(approved.summary['path'], 'approval_required');
    const records = approved.stages['approval']?.['records'] as { kind: string; actorId?: string }[];
    assert.deepEqual(records.map((record) => record.kind), ['requested', 'approved']);
    assert.equal(records[1]?.actorId, 'operator:approver-a', 'WHO approved');
    assert.equal(approved.stages['approval']?.['storeKind'], 'durable-authenticated');
    assert.equal((approved.stages['authority']?.['grants'] as unknown[]).length, 1);
    assertVerified(await verifyTrace(baseUrl, requestIdOf('approved')), 'approved');
    assert.equal(pending.summary['finalState'], 'executed-confirmed-completed', 'a fetch is always now: the same request has since progressed');
  });

  it('the bundle sealed while approval was pending stays valid, says what it said, and reports that the request has since moved on', async () => {
    const { baseUrl } = booted;
    const bundle = cases['pendingBundle']?.body['bundle'] as Record<string, unknown>;
    assert.equal(bundle['bundleVersion'], 'evidence.bundle.v2');
    const trace = bundle['trace'] as Record<string, unknown>;
    assert.equal((trace['summary'] as Record<string, unknown>)['finalState'], 'approval-pending', 'historical truth: at sealing, approval was pending');
    assert.equal(((trace['stages'] as Record<string, Record<string, unknown>>)['authority'])?.['presence'], 'not-reached', 'no grant had been issued');
    const verified = expectStatus(await call(baseUrl, 'POST', '/api/evidence/verify', { authorization: AUDITOR, body: { bundleId: bundle['bundleId'] } }), 200, 'verify bundle').body;
    assert.equal(verified['valid'], true, JSON.stringify(verified['failures']));
    assert.equal(verified['freshness'], 'superseded-by-later-facts');
    assert.equal((verified['traceComparison'] as Record<string, unknown>)['result'], 'progressed');
    // Rebuilding seals the current trace in a new bundle and supersedes the old one, which is unchanged.
    const rebuilt = expectStatus(await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId: requestIdOf('approved'), level: 'AUDITOR' } }), 201, 'rebuild').body;
    assert.notEqual((rebuilt['bundle'] as Record<string, unknown>)['bundleId'], bundle['bundleId']);
    const old = expectStatus(await call(baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundle['bundleId'] as string)}`, { authorization: AUDITOR }), 200, 'old bundle').body;
    assert.equal(old['state'], 'SUPERSEDED');
    assert.equal(old['supersededBy'], (rebuilt['bundle'] as Record<string, unknown>)['bundleId']);
    assert.deepEqual(old['bundle'], bundle, 'supersession changed not one byte of the old bundle');
    // Idempotent: the same disclosure of an unchanged trace is the bundle already stored.
    const again = expectStatus(await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId: requestIdOf('approved'), level: 'AUDITOR' } }), 201, 'rebuild again').body;
    assert.equal((again['bundle'] as Record<string, unknown>)['bundleId'], (rebuilt['bundle'] as Record<string, unknown>)['bundleId']);
    const current = expectStatus(await call(baseUrl, 'POST', '/api/evidence/verify', { authorization: AUDITOR, body: { bundleId: (rebuilt['bundle'] as Record<string, unknown>)['bundleId'] } }), 200, 'verify current').body;
    assert.equal(current['valid'], true, JSON.stringify(current['failures']));
    assert.equal(current['freshness'], 'current');
  });

  it('obligations: the discharge that released the request is in its trace, with the store’s authenticated chain', async () => {
    const { baseUrl } = booted;
    const view = await fetchTrace(baseUrl, requestIdOf('obligationDischarged'));
    assert.equal(view.summary['finalState'], 'executed-confirmed-completed');
    const discharges = view.stages['obligations']?.['discharges'] as Record<string, unknown>[];
    assert.deepEqual(discharges.map((row) => [row['obligationType'], row['outcome'], row['sourceId']]), [[OBLIGATION, 'discharged', 'change-approvals']]);
    assert.equal(view.stages['obligations']?.['storeKind'], 'durable-authenticated');
    assertVerified(await verifyTrace(baseUrl, requestIdOf('obligationDischarged')), 'obligation');
  });

  it('revocation: the revoked grant carries its signed revocation and its event; the bundle sealed before it progressed, never contradicted', async () => {
    const { baseUrl } = booted;
    const view = await fetchTrace(baseUrl, requestIdOf('revoked'));
    const grant = (view.stages['authority']?.['grants'] as Record<string, unknown>[])[0] ?? {};
    assert.equal((grant['revocation'] as Record<string, unknown>)['reason'], 'security-incident');
    assert.ok(eventTypes(view).includes('grant.revoked'));
    assert.equal(view.summary['finalState'], 'executed-confirmed-completed', 'a later revocation never rewrites what was executed');
    assertVerified(await verifyTrace(baseUrl, requestIdOf('revoked')), 'revoked');
    const bundleId = (cases['revokedBundle']?.body['bundle'] as Record<string, unknown>)['bundleId'];
    const verified = expectStatus(await call(baseUrl, 'POST', '/api/evidence/verify', { authorization: AUDITOR, body: { bundleId } }), 200, 'verify').body;
    assert.equal(verified['valid'], true, JSON.stringify(verified['failures']));
    assert.equal(verified['freshness'], 'superseded-by-later-facts');
    assert.equal(((verified['traceComparison'] as Record<string, unknown>)['stages'] as Record<string, unknown>)['authority'], 'progressed');
  });

  it('confirmed-not-completed and unconfirmed are reported exactly — never as executed, and an unconfirmed outcome stays unconfirmed with no resolver', async () => {
    const { baseUrl } = booted;
    const failed = await fetchTrace(baseUrl, requestIdOf('notCompleted'));
    assert.equal(failed.summary['finalState'], 'executed-confirmed-not-completed');
    assert.equal(failed.stages['outcome']?.['certainty'], 'confirmed-not-completed');
    assert.equal(failed.stages['outcome']?.['failure'], 'PROVIDER_REJECTED');
    assertVerified(await verifyTrace(baseUrl, requestIdOf('notCompleted')), 'not completed');
    const unknown = await fetchTrace(baseUrl, requestIdOf('unconfirmed'));
    assert.equal(unknown.summary['finalState'], 'executed-unconfirmed');
    assert.equal(unknown.stages['outcome']?.['certainty'], 'unconfirmed');
    assert.equal(unknown.stages['resolution']?.['presence'], 'not-composed', 'the shipped Host composes no P12 resolver: unresolved, and said so');
    assertVerified(await verifyTrace(baseUrl, requestIdOf('unconfirmed')), 'unconfirmed');
  });

  it('withheld by an emergency stop: not executed, no claim, no outcome, zero adapter calls', async () => {
    const { baseUrl } = booted;
    const view = await fetchTrace(baseUrl, requestIdOf('emergency'));
    assert.equal(view.summary['finalState'], 'not-executed');
    assert.equal((view.stages['execution']?.['claim'] as Record<string, unknown>)['presence'], 'not-reached');
    assert.equal(view.stages['outcome']?.['presence'], 'not-reached');
    assert.equal(adapter.calls.some((action) => action.resource === FROZEN), false);
    assertVerified(await verifyTrace(baseUrl, requestIdOf('emergency')), 'emergency');
  });

  it('reading and verifying traces calls no adapter and changes no authority', async () => {
    const { baseUrl } = booted;
    const before = adapter.calls.length;
    const pendingBefore = expectStatus(await call(baseUrl, 'GET', '/api/admin/approvals?view=all', { authorization: auth.observer }), 200, 'approvals').text;
    for (const name of Object.keys(cases).filter((entry) => cases[entry]?.body['requestId'] !== undefined)) {
      await fetchTrace(baseUrl, requestIdOf(name), 'FULL');
      await verifyTrace(baseUrl, requestIdOf(name));
    }
    assert.equal(adapter.calls.length, before, 'zero adapter calls from any trace read or verification');
    assert.equal(expectStatus(await call(baseUrl, 'GET', '/api/admin/approvals?view=all', { authorization: auth.observer }), 200, 'approvals').text, pendingBefore, 'approval state unchanged');
  });
});

describe('ASSURE-01 — tenant, authentication and input boundaries', () => {
  it('another organization’s key, an unauthenticated caller, an operator bearer and an agent credential cannot see a trace', async () => {
    const { baseUrl } = booted;
    const requestId = requestIdOf('monetary');
    for (const path of [tracePath(requestId), verifyPath(requestId)]) {
      const foreign = await call(baseUrl, 'GET', path, { authorization: FOREIGN });
      assert.deepEqual([foreign.status, (foreign.body['error'] as Record<string, unknown>)['code']], [404, 'EVIDENCE_TRACE_NOT_FOUND'], 'not found, not forbidden: existence is not disclosed');
      assert.equal((await call(baseUrl, 'GET', path)).status, 401);
      assert.equal((await call(baseUrl, 'GET', path, { authorization: auth.observer })).status, 401, 'an operator bearer is not an evidence credential');
      assert.equal((await call(baseUrl, 'GET', path, { authorization: `Bearer ${payables}` })).status, 401, 'an agent credential is not an evidence credential');
      assert.equal((await call(baseUrl, 'GET', path, { authorization: 'Bearer not-a-key-000000000000000000' })).status, 401);
    }
    const bundleId = (cases['revokedBundle']?.body['bundle'] as Record<string, unknown>)['bundleId'] as string;
    assert.equal((await call(baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundleId)}`, { authorization: FOREIGN })).status, 404);
    assert.equal((await call(baseUrl, 'POST', '/api/evidence/verify', { authorization: FOREIGN, body: { bundleId } })).status, 404);
    assert.equal((await call(baseUrl, 'POST', '/api/evidence/build', { authorization: FOREIGN, body: { requestId, level: 'FULL' } })).status, 404);
  });

  it('malformed and unknown request ids, unknown levels and any other query are refused before a store is read', async () => {
    const { baseUrl } = booted;
    for (const bad of ['not-a-request', 'aoc.gar:XYZ', `aoc.gar:${'0'.repeat(31)}`, `aoc.gar:${'0'.repeat(33)}`, '%E0%A4%A']) {
      const reply = await call(baseUrl, 'GET', `/api/evidence/traces/${bad}?level=AUDITOR`, { authorization: AUDITOR });
      assert.equal(reply.status, 400, `${bad}: ${reply.text}`);
    }
    const unknown = await call(baseUrl, 'GET', tracePath(`aoc.gar:${'0'.repeat(32)}`), { authorization: AUDITOR });
    assert.deepEqual([unknown.status, (unknown.body['error'] as Record<string, unknown>)['code']], [404, 'EVIDENCE_TRACE_NOT_FOUND']);
    const requestId = requestIdOf('monetary');
    for (const query of ['', '?level=SECRET', '?level=AUDITOR&level=FULL', '?level=AUDITOR&organizationId=org-foreign-assure01', '?system=true&level=FULL']) {
      const reply = await call(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}${query}`, { authorization: AUDITOR });
      assert.equal(reply.status, 400, `${query}: ${reply.text}`);
    }
    assert.equal((await call(baseUrl, 'GET', `${verifyPath(requestId)}?organizationId=other`, { authorization: AUDITOR })).status, 400);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call(baseUrl, method, tracePath(requestId), { authorization: AUDITOR, body: {} })).status, 404, `${method} is unrouted`);
    assert.equal((await call(baseUrl, 'GET', '/api/evidence/traces', { authorization: AUDITOR })).status, 404, 'no listing of traces');
    assert.equal((await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId, evaluationId: 'x', level: 'FULL' } })).status, 400, 'exactly one of requestId / evaluationId');
  });
});

describe('ASSURE-01 — disclosure: Truth ≠ Disclosure', () => {
  it('no level ever discloses a secret, a credential, a payload, an approval subject or evidence body, a revocation note or an obligation reference', async () => {
    const { baseUrl } = booted;
    const secrets = [...deployment.secretValues(), auditorKey, foreignKey, payables, releaseAgent];
    for (const name of Object.keys(cases).filter((entry) => cases[entry]?.body['requestId'] !== undefined)) {
      for (const level of ['FULL', 'AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC']) {
        const view = await fetchTrace(baseUrl, requestIdOf(name), level);
        for (const secret of secrets) assert.equal(view.text.includes(secret), false, `${name}@${level} leaks no secret`);
        for (const forbidden of ['requestPayload', 'resultPayload', 'frontera.approval-subject', EVIDENCE_HASH, 'CAB-ASSURE01', 'privateKey', 'bearerCredential', 'erp.example.com']) {
          assert.equal(view.text.includes(forbidden), false, `${name}@${level} carries no '${forbidden}'`);
        }
      }
      const verification = expectStatus(await call(baseUrl, 'GET', verifyPath(requestIdOf(name)), { authorization: AUDITOR }), 200, 'verify').text;
      for (const secret of secrets) assert.equal(verification.includes(secret), false, `${name} verification leaks no secret`);
    }
  });

  it('each level discloses exactly its policy: PUBLIC and CUSTOMER show where the request ended, not who asked, which authority or how it ran', async () => {
    const { baseUrl } = booted;
    const requestId = requestIdOf('approved');
    const pub = await fetchTrace(baseUrl, requestId, 'PUBLIC');
    assert.deepEqual(Object.keys(pub.stages), []);
    assert.equal(pub.trace['organizationId'], undefined);
    assert.equal(pub.summary['finalState'], 'executed-confirmed-completed');
    for (const hidden of [RELEASE, 'operator:approver-a', 'aoc.grant:', ADAPTER_ID, 'provider-ref']) assert.equal(pub.text.includes(hidden), false, `PUBLIC hides ${hidden}`);
    const customer = await fetchTrace(baseUrl, requestId, 'CUSTOMER');
    assert.deepEqual(Object.keys(customer.stages).sort(), ['decision', 'outcome', 'resolution']);
    assert.equal(customer.text.includes(RELEASE), false);
    assert.equal(customer.text.includes('aoc.grant:'), false);
    const partner = await fetchTrace(baseUrl, requestId, 'PARTNER');
    assert.deepEqual(Object.keys(partner.stages).sort(), ['authority', 'decision', 'execution', 'outcome', 'resolution']);
    assert.equal(partner.text.includes(RELEASE), false, 'PARTNER does not learn who asked');
    assert.equal(partner.text.includes('operator:approver-a'), false, 'nor who approved');
    const auditor = await fetchTrace(baseUrl, requestId, 'AUDITOR');
    assert.equal(Object.keys(auditor.stages).length, 11, 'AUDITOR: the whole trace');
    // A PUBLIC bundle verifies like any other.
    const built = expectStatus(await call(baseUrl, 'POST', '/api/evidence/build', { authorization: AUDITOR, body: { requestId, level: 'PUBLIC' } }), 201, 'public bundle').body;
    const verified = expectStatus(await call(baseUrl, 'POST', '/api/evidence/verify', { authorization: AUDITOR, body: { bundleId: (built['bundle'] as Record<string, unknown>)['bundleId'] } }), 200, 'verify public').body;
    assert.equal(verified['valid'], true, JSON.stringify(verified['failures']));
    // The organization reads its own PUBLIC bundle (whose content hides the organization) — and only it does.
    const bundleId = (built['bundle'] as Record<string, unknown>)['bundleId'] as string;
    assert.equal((await call(baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundleId)}`, { authorization: AUDITOR })).status, 200);
    assert.equal((await call(baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundleId)}`, { authorization: FOREIGN })).status, 404);
  });
});

describe('ASSURE-01 — the official exit drill: fetch and verify through HTTP, across restart and a cold backup / restore', () => {
  it('same trace, same verification, same bundles: before, after a restart, and after the data directory is destroyed and restored from backup', async () => {
    const requests = Object.keys(cases)
      .filter((entry) => cases[entry]?.body['requestId'] !== undefined)
      .map(requestIdOf)
      .filter((value, index, all) => all.indexOf(value) === index);
    const snapshot = async (baseUrl: string): Promise<Record<string, string>> => {
      const digests: Record<string, string> = {};
      for (const requestId of requests) {
        digests[requestId] = (await fetchTrace(baseUrl, requestId, 'FULL')).traceDigest;
        assert.equal((await verifyTrace(baseUrl, requestId))['verified'], true, requestId);
      }
      return digests;
    };
    const bundleIds = ['pendingBundle', 'revokedBundle'].map((name) => (cases[name]?.body['bundle'] as Record<string, unknown>)['bundleId'] as string);
    const bundles = async (baseUrl: string): Promise<string[]> =>
      Promise.all(bundleIds.map(async (bundleId) => expectStatus(await call(baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundleId)}`, { authorization: AUDITOR }), 200, 'bundle').text));

    const before = await snapshot(booted.baseUrl);
    const bundlesBefore = await bundles(booted.baseUrl);
    const callsBefore = adapter.calls.length;

    // ── restart on the same stores ───────────────────────────────────────────────
    await booted.host.close();
    booted = await boot(dataDir);
    assert.deepEqual(await snapshot(booted.baseUrl), before, 'a restart changes no canonical component of any trace');
    assert.deepEqual(await bundles(booted.baseUrl), bundlesBefore, 'bundles and their lifecycle survive the restart byte for byte');
    assert.equal(adapter.calls.length, 0, 'nothing re-executed');

    // ── cold backup, destroy, restore, boot ───────────────────────────────────────
    await booted.host.close();
    const backupDir = deployment.dir('backup');
    const cli = backupCli(envFor(dataDir), backupDir, ['--cold']);
    assert.equal(cli.status, 0, cli.stderr);
    const manifest = readManifest(backupDir);
    assert.ok(manifest.stores.some((store) => store.name === 'evidence-bundles'), 'the Evidence Bundle Store is in the backup');
    assert.equal(manifest.coverage?.stores.find((store) => store.name === 'evidence-bundles')?.required, true, 'and required: the secure Host always composes it');
    assert.equal(manifest.coverage?.complete, true);
    assert.deepEqual(secretsFound(backupDir, [...deployment.secretValues(), auditorKey, foreignKey]), [], 'no secret in the backup');
    rmSync(dataDir, { recursive: true, force: true });
    assert.equal(existsSync(dataDir), false);
    const { runRestore } = await portability();
    const recovered = deployment.dir('data-recovered');
    const report = await runRestore({ backup: backupDir, target: recovered, env: envFor(recovered) });
    assert.equal(report.status, 'restored');
    booted = await boot(recovered);
    assert.deepEqual(await snapshot(booted.baseUrl), before, 'the restored deployment yields the same trace for every request, and it verifies');
    assert.deepEqual(await bundles(booted.baseUrl), bundlesBefore, 'every issued bundle, with its lifecycle, is restored byte for byte');
    for (const bundleId of bundleIds) {
      const verified = expectStatus(await call(booted.baseUrl, 'POST', '/api/evidence/verify', { authorization: AUDITOR, body: { bundleId } }), 200, 'verify restored bundle').body;
      assert.equal(verified['valid'], true, JSON.stringify(verified['failures']));
    }
    assert.equal(adapter.calls.length, 0, 'zero adapter calls across restore and every read');
    assert.ok(callsBefore > 0);
  });
});
