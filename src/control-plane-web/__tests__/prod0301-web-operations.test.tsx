import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToStaticMarkup } from 'react-dom/server';

import { createConsoleApp } from '../app.js';
import { classifyHostFailure } from '../failures.js';
import { createHostClient, type HostClient, type HostResult } from '../host-client.js';
import { SESSION_COOKIE } from '../security.js';
import { createSessionStore } from '../session.js';
import { shapes, type OperationalExecution, type OperationalTrace, type OrganizationContext } from '../wire.js';
import { NAVIGATION } from '../views/layout.js';
import { AttentionListPage, HostHealthPage, TracePage } from '../views/pages-operations.js';

/**
 * PROD-03-01 — the console's operational pages: closed wire guards, rendering
 * that shows the Host's classification as stated, and a request handler that
 * forwards every read and offers nothing that writes.
 */

const HEALTH = { status: 'healthy', enterpriseVersion: '1', kernelVersion: '1', checkedAt: 't', persistence: { provider: 'sqlite', status: 'connected' } };

const context: OrganizationContext = {
  organization: { organizationId: 'org-pilot', trustDomainId: 'td', agentCredentials: 'enabled', profileLifecycle: 'operator-promoted' },
  operator: { operatorId: 'ops-x', role: 'some-role', credentialClass: 'operator', permissions: ['operations.read', 'trace.read'] },
};

const execution = (overrides: Partial<OperationalExecution> = {}): OperationalExecution => ({
  requestId: 'aoc.gar:0123456789abcdef0123456789abcdef',
  evaluationId: 'evaluation-1',
  decisionId: 'decision-1',
  executionId: 'aoc.exec:1',
  actorId: 'agent-1',
  actionType: 'act',
  classification: 'claimed-no-outcome',
  attentionRequired: true,
  attentionReasons: ['EXECUTION_CLAIMED_NO_OUTCOME'],
  unresolved: true,
  decision: { status: 'allowed', reasonCodes: ['ACTION_ALLOWED'], evaluatedAt: 't', persistedAt: 't' },
  approval: null,
  issuance: { status: 'issued', withheldBy: null, reasonCodes: [], recordedAt: 't' },
  execution: { claim: 'recorded', claimedAt: 't' },
  outcome: { status: 'none', source: null, failure: null, withheldBy: null, reasonCodes: [], recordedAt: null },
  trace: { available: true, finalState: 'claimed-outcome-unrecorded', failure: null },
  ...overrides,
});

const traceView = (level: string, stages: Record<string, unknown>): OperationalTrace => ({
  requestId: 'aoc.gar:0123456789abcdef0123456789abcdef',
  disclosure: { level, policyId: `evidence.disclosure.${level.toLowerCase()}.v2`, hiddenFields: level === 'PUBLIC' ? ['trace.authority'] : [] },
  trace: { requestId: 'aoc.gar:0123456789abcdef0123456789abcdef', evaluationId: 'evaluation-1', decisionId: 'decision-1', summary: { path: 'allowed', finalState: 'claimed-outcome-unrecorded', presence: {} }, stages },
  traceDigest: 'sha256:abc',
  verification: { verified: false, categories: { contract: 'pass', completeness: 'fail' }, checks: [{ check: 'completeness.event:execution.attempt.claimed', category: 'completeness', status: 'fail' }], finalState: 'claimed-outcome-unrecorded', verifiedAt: 't', boundary: 'b' },
  operational: { ...execution(), hidden: [] },
  generatedAt: 't',
});

describe('PROD-03-01 web — closed wire guards', () => {
  it('a well-formed operational body passes; a body missing what the pages rely on is a contract failure, never data', () => {
    assert.equal(shapes.executions({ executions: [execution()], nextCursor: null, coverage: 'c' }), true);
    assert.equal(shapes.attention({ attention: [execution()], nextCursor: null, resolvedOnRead: 0, coverage: 'c' }), true);
    assert.equal(shapes.executions({ executions: [{ ...execution(), attentionRequired: 'yes' }], nextCursor: null }), false);
    assert.equal(shapes.attention({ attention: [execution()], nextCursor: null }), false);
    assert.equal(shapes.trace(traceView('AUDITOR', {})), true);
    assert.equal(shapes.trace({ ...traceView('AUDITOR', {}), verification: { verified: 'true', checks: [] } }), false);
    const scan = { candidates: 1, examined: 1, complete: true, limit: 500 };
    const decisions = { total: 1, allowed: 1, denied: 0, approvalRequired: 0, indeterminate: 0 };
    assert.equal(shapes.metrics({ decisions, issuanceWithheld: 0, executionClaims: 1, confirmedOutcomes: null, unresolvedExecutions: 1, attentionRequired: 1, scan, consistent: true, computedAt: 't' }), true);
    assert.equal(shapes.metrics({ decisions, issuanceWithheld: 0, executionClaims: 1, confirmedOutcomes: 'n/a', unresolvedExecutions: 1, attentionRequired: 1, scan, consistent: true, computedAt: 't' }), false);
    assert.equal(shapes.operationsHealth({ health: HEALTH, operations: { unresolvedExecutions: 0, attentionRequired: 0, scan, checkedAt: 't' } }), true);
  });

  it('review fix — every nested field the pages read is checked: a partial or version-skewed entry is a contract failure', () => {
    const valid = execution();
    const malformed: Record<string, OperationalExecution | Record<string, unknown>> = {
      'empty outcome': { ...valid, outcome: {} },
      'outcome without reasonCodes': { ...valid, outcome: { ...valid.outcome, reasonCodes: undefined } },
      'outcome failure not a string': { ...valid, outcome: { ...valid.outcome, failure: 7 } },
      'empty issuance': { ...valid, issuance: {} },
      'issuance reasonCodes not strings': { ...valid, issuance: { ...valid.issuance, reasonCodes: [1] } },
      'execution claim missing': { ...valid, execution: { claimedAt: 't' } },
      'execution claimedAt not a string': { ...valid, execution: { claim: 'recorded', claimedAt: 5 } },
      'trace availability missing': { ...valid, trace: { finalState: 'x', failure: null } },
      'trace finalState not a string': { ...valid, trace: { available: true, finalState: 1, failure: null } },
      'decision without reasonCodes': { ...valid, decision: { status: 'allowed', evaluatedAt: 't', persistedAt: 't' } },
      'approval without verdicts': { ...valid, approval: { presence: 'recorded' } },
      'approval missing': Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'approval')),
      'actorId missing': { ...valid, actorId: undefined },
    };
    for (const [name, entry] of Object.entries(malformed)) {
      assert.equal(shapes.executions({ executions: [entry], nextCursor: null, coverage: 'c' }), false, `executions: ${name}`);
      assert.equal(shapes.attention({ attention: [entry], nextCursor: null, resolvedOnRead: 0, coverage: 'c' }), false, `attention: ${name}`);
    }
    const trace = traceView('AUDITOR', {});
    const malformedTraces: Record<string, unknown> = {
      'operational outcome empty': { ...trace, operational: { ...trace.operational, outcome: {} } },
      'operational issuance empty': { ...trace, operational: { ...trace.operational, issuance: {} } },
      'operational execution empty': { ...trace, operational: { ...trace.operational, execution: {} } },
      'operational hidden missing': { ...trace, operational: execution() },
      'operational classification not a string': { ...trace, operational: { ...trace.operational, classification: 3 } },
      'summary without finalState': { ...trace, trace: { ...trace.trace, summary: { path: 'allowed', presence: {} } } },
      'categories not strings': { ...trace, verification: { ...trace.verification, categories: { contract: true } } },
      'check without category': { ...trace, verification: { ...trace.verification, checks: [{ check: 'c', status: 'fail' }] } },
      'verification without boundary': { ...trace, verification: { ...trace.verification, boundary: undefined } },
      'disclosure without hiddenFields': { ...trace, disclosure: { level: 'AUDITOR', policyId: 'p' } },
    };
    for (const [name, body] of Object.entries(malformedTraces)) assert.equal(shapes.trace(body), false, `trace: ${name}`);
    // A level below AUDITOR leaves sections out; absent is well formed, present-but-partial is not.
    const disclosed = { requestId: valid.requestId, evaluationId: valid.evaluationId, decisionId: valid.decisionId, executionId: null, classification: null, attentionRequired: false, attentionReasons: [], unresolved: null, trace: valid.trace, hidden: ['request', 'decision', 'approval', 'issuance', 'execution', 'outcome'] };
    assert.equal(shapes.trace({ ...trace, operational: disclosed }), true);
    assert.equal(shapes.trace({ ...trace, operational: { ...disclosed, outcome: {} } }), false);
  });

  it('review fix — a malformed Host answer reaches the operator as a contract failure, never as a crashed page', async () => {
    const valid = execution();
    const bodies: Record<string, unknown> = {
      '/api/admin/organization': context,
      '/api/admin/operations/executions': { executions: [{ ...valid, outcome: {} }], nextCursor: null, coverage: 'c' },
      '/api/admin/operations/attention': { attention: [{ ...valid, issuance: { status: 'issued' } }], nextCursor: null, resolvedOnRead: 0, coverage: 'c' },
      '/api/admin/operations/traces/aoc.gar%3A0123456789abcdef0123456789abcdef': { ...traceView('AUDITOR', {}), operational: { ...execution(), hidden: [], execution: {} } },
    };
    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const body = bodies[path];
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { error: { code: 'NOT_FOUND', message: 'no' } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const { port } = server.address() as AddressInfo;
      const { app, cookie } = signedIn(createHostClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 }));
      for (const path of ['/executions', '/attention', '/traces/aoc.gar%3A0123456789abcdef0123456789abcdef']) {
        const response = await app.handle(get(path, cookie));
        assert.notEqual(response.status, 200, path);
        assert.match(response.body ?? '', /does not recognize/, `${path}: the contract failure is shown`);
        assert.doesNotMatch(response.body ?? '', /data-classification=|data-testid="trace-classification"/, `${path}: nothing is shown as state`);
      }
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe('PROD-03-01 web — the pages show the Host’s answer as stated', () => {
  it('navigation offers Attention, Executions, Trace and Host Health beside the existing sections', () => {
    const paths = NAVIGATION.map((item) => item.path);
    for (const path of ['/attention', '/executions', '/traces', '/host-health', '/activity', '/evidence', '/approvals']) assert.ok(paths.includes(path as (typeof paths)[number]), path);
  });

  it('attention shows each entry’s classification and reasons, links the trace, and posts nothing', () => {
    const html = renderToStaticMarkup(<AttentionListPage context={context} csrfToken="t" page={{ attention: [execution()], nextCursor: 'next-1', resolvedOnRead: 0, coverage: 'c' }} />);
    assert.match(html, /data-classification="claimed-no-outcome"/);
    assert.match(html, /EXECUTION_CLAIMED_NO_OUTCOME/);
    assert.match(html, /href="\/traces\/aoc\.gar%3A0123456789abcdef0123456789abcdef"/);
    assert.match(html, /href="\/attention\?cursor=next-1"/);
    assert.equal([...html.matchAll(/<form method="post"/g)].length, 1, 'only sign-out posts');
    assert.doesNotMatch(html, /<script|\b(Resolve|Retry|Reconcile|Resend)\b/);
  });

  it('a trace states a failed verification as failed and renders only the stages the disclosure level returned', () => {
    const audited = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={traceView('AUDITOR', { decision: { presence: 'recorded' }, authority: { presence: 'recorded', grants: [] }, execution: { presence: 'recorded' } })} />);
    assert.match(audited, /Verification FAILED/);
    assert.doesNotMatch(audited, /title">Verified</);
    assert.match(audited, /data-stage="authority"/);
    assert.match(audited, /Attention required/);
    const pub = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={traceView('PUBLIC', {})} />);
    assert.doesNotMatch(pub, /data-stage=/);
    assert.match(pub, /Hidden at this level/);
    assert.doesNotMatch(pub, /href="[^"]*level=FULL/, 'FULL is never offered');
  });

  it('an incomplete scan is shown as lower bounds, and an unstated counter as not stated', () => {
    const scan = { candidates: 900, examined: 500, complete: false, limit: 500 };
    const html = renderToStaticMarkup(
      <HostHealthPage
        context={context}
        csrfToken="t"
        health={{ health: { status: 'healthy', enterpriseVersion: '1', kernelVersion: '1', checkedAt: 't', persistence: { provider: 'sqlite', status: 'connected' } }, operations: { unresolvedExecutions: 7, attentionRequired: 7, scan, checkedAt: 't' } }}
        metrics={{ decisions: { total: 1, allowed: 1, denied: 0, approvalRequired: 0, indeterminate: 0 }, issuanceWithheld: 0, executionClaims: 900, confirmedOutcomes: null, unresolvedExecutions: 7, attentionRequired: 7, scan, consistent: false, computedAt: 't', coverage: 'c' }}
      />,
    );
    assert.match(html, /Lower bounds: 500 of 900 open claims/);
    assert.match(html, /not stated \(scan incomplete\)/);
    assert.match(html, /data-testid="unresolved-count">7</);
    assert.match(html, /data-testid="metrics-moving"/, 'a read the store moved under says so');
  });

  it('review fix — a trace below AUDITOR renders the disclosed classification and marks every hidden section, never a hidden value', () => {
    const base = traceView('PUBLIC', {});
    const view: OperationalTrace = {
      ...base,
      operational: { requestId: base.requestId, evaluationId: 'evaluation-1', decisionId: 'decision-1', executionId: null, classification: null, attentionRequired: false, attentionReasons: [], unresolved: null, trace: { available: true, finalState: 'not-executed', failure: null }, hidden: ['request', 'decision', 'approval', 'issuance', 'execution', 'outcome'] },
    };
    const html = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={view} />);
    assert.match(html, /data-testid="trace-classification-hidden"/);
    assert.equal([...html.matchAll(/hidden at this level/g)].length, 4, 'decision, issuance, claim and outcome');
    assert.doesNotMatch(html, /agent-1|ACTION_ALLOWED/);
  });
});

const ORIGIN = 'http://127.0.0.1:9';
const ok = <T,>(body: T): Promise<HostResult<T>> => Promise.resolve({ ok: true, status: 200, body });

function scriptedHost(overrides: Partial<HostClient>, calls: string[]): HostClient {
  const base: Partial<HostClient> = { organization: () => ok(context) };
  return new Proxy({ ...base, ...overrides } as HostClient, {
    get(target, name: string) {
      const value = (target as unknown as Record<string, unknown>)[name];
      if (typeof value !== 'function') return () => Promise.resolve({ ok: false, failure: classifyHostFailure(404, undefined) });
      return (...args: unknown[]) => {
        calls.push(`${name}:${JSON.stringify(args.slice(1))}`);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

function get(url: string, cookie: string): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(stream, { method: 'GET', url, headers: { cookie } });
  return stream;
}

function signedIn(host: HostClient): { app: ReturnType<typeof createConsoleApp>; cookie: string } {
  const sessions = createSessionStore();
  const app = createConsoleApp({ host, sessions, publicOrigin: ORIGIN });
  const session = sessions.create('operator-bearer-value', 'ops-x');
  return { app, cookie: `${SESSION_COOKIE}=${session.id}` };
}

describe('PROD-03-01 web — the request handler forwards reads and decides nothing', () => {
  it('a trace search redirects to the trace page; an unknown level is refused before the Host is asked; FULL is never forwarded', async () => {
    const calls: string[] = [];
    const { app, cookie } = signedIn(scriptedHost({ trace: () => ok(traceView('AUDITOR', {})) }, calls));
    const search = await app.handle(get('/traces?requestId=aoc.gar%3A0123456789abcdef0123456789abcdef&level=PARTNER', cookie));
    assert.equal(search.status, 303);
    assert.equal(search.location, '/traces/aoc.gar%3A0123456789abcdef0123456789abcdef?level=PARTNER');
    const full = await app.handle(get('/traces/aoc.gar%3A0123456789abcdef0123456789abcdef?level=FULL', cookie));
    assert.equal(full.status, 400);
    // Review fix: the search form refuses exactly as the trace page does — FULL and unknown levels are never redirected to AUDITOR.
    for (const level of ['FULL', 'SECRET', 'auditor', '']) {
      const refused = await app.handle(get(`/traces?requestId=aoc.gar%3A0123456789abcdef0123456789abcdef&level=${encodeURIComponent(level)}`, cookie));
      assert.equal(refused.status, 400, `search level '${level}'`);
      assert.equal(refused.location, undefined, `search level '${level}' is not redirected`);
    }
    for (const level of ['AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC']) {
      const accepted = await app.handle(get(`/traces?requestId=aoc.gar%3A0123456789abcdef0123456789abcdef&level=${level}`, cookie));
      assert.equal(accepted.status, 303, level);
      assert.equal(accepted.location, `/traces/aoc.gar%3A0123456789abcdef0123456789abcdef${level === 'AUDITOR' ? '' : `?level=${level}`}`);
    }
    const defaulted = await app.handle(get('/traces?requestId=aoc.gar%3A0123456789abcdef0123456789abcdef', cookie));
    assert.equal(defaulted.location, '/traces/aoc.gar%3A0123456789abcdef0123456789abcdef', 'no level asked is the default level');
    assert.equal(calls.some((call) => call.startsWith('trace:')), false, 'nothing was sent for FULL or an unknown level');
    const page = await app.handle(get('/traces/aoc.gar%3A0123456789abcdef0123456789abcdef', cookie));
    assert.equal(page.status, 200);
    assert.ok(calls.includes('trace:["aoc.gar:0123456789abcdef0123456789abcdef","AUDITOR"]'));
  });

  it('a Host refusal on a read is rendered as the Host’s refusal', async () => {
    const calls: string[] = [];
    const denied = (): Promise<HostResult<never>> => Promise.resolve({ ok: false, failure: classifyHostFailure(403, { error: { code: 'OPERATOR_PERMISSION_DENIED', message: 'denied' } }) });
    const { app, cookie } = signedIn(scriptedHost({ attention: denied, executions: denied, operationsHealth: denied, operationsMetrics: denied }, calls));
    for (const path of ['/attention', '/executions', '/host-health']) {
      const response = await app.handle(get(path, cookie));
      assert.equal(response.status, 403, path);
      assert.match(response.body ?? '', /OPERATOR_PERMISSION_DENIED/);
    }
  });

  it('the executions filter is forwarded as the Host’s closed query', async () => {
    const calls: string[] = [];
    const { app, cookie } = signedIn(scriptedHost({ executions: () => ok({ executions: [], nextCursor: null, coverage: 'c' }) }, calls));
    const response = await app.handle(get('/executions?status=denied&requestId=r-1', cookie));
    assert.equal(response.status, 200);
    assert.ok(calls.includes('executions:[{"status":"denied","requestId":"r-1","limit":50}]'), calls.join(' | '));
  });
});
