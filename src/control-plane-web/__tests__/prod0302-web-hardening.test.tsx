import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { renderToStaticMarkup } from 'react-dom/server';

import { createConsoleApp } from '../app.js';
import { classifyHostFailure } from '../failures.js';
import type { HostClient, HostResult } from '../host-client.js';
import { SESSION_COOKIE } from '../security.js';
import { createSessionStore } from '../session.js';
import {
  RESOLUTION_CAPACITY_RESULTS,
  RESOLUTION_FAILURE_REASONS,
  RESOLUTION_FORM_ERRORS,
  resolutionFormError,
  type OperationalExecution,
  type OperationalTrace,
  type OperatorResolutionBody,
  type OperatorResolutionResponse,
  type OrganizationContext,
} from '../wire.js';
import { CAPACITY_RESULT_NOTICES, TracePage, capacityReconciliationMissing, identicalResolutionOf } from '../views/pages-operations.js';

/**
 * PROD-03-02 — post-merge review hardening, the console half:
 *
 * - C: the resolution form is closed exactly as the Host API's body is — a
 *   completion with a failure reason, a non-completion without one, and an
 *   unknown reason are refused **before** the Host is asked, and the page is
 *   re-read with the form empty. The console runs no script (its CSP forbids
 *   it), so the stale reason is cleared by that re-render, never by
 *   normalizing what was submitted.
 * - D: after a durable resolution, P12's capacity result is shown beside it.
 *   Only `adjusted` / `no-reservation` read as a plain success; `pending`
 *   offers running the capacity reconciliation again by re-submitting the
 *   identical resolution; the trace keeps a warning while the reservation
 *   holds no matching reconciliation.
 */

const REQUEST = 'aoc.gar:0123456789abcdef0123456789abcdef';
const EXECUTION = `aoc.exec:${'ab'.repeat(16)}`;
const ORIGIN = 'http://127.0.0.1:9';

const context: OrganizationContext = {
  organization: { organizationId: 'org-pilot', trustDomainId: 'td', agentCredentials: 'enabled', profileLifecycle: 'operator-promoted' },
  operator: { operatorId: 'ops-admin', role: 'organization-administrator', credentialClass: 'operator', permissions: ['operations.read', 'trace.read', 'operations.resolve'] },
};

const execution = (overrides: Partial<OperationalExecution> = {}): OperationalExecution => ({
  requestId: REQUEST,
  evaluationId: 'evaluation-1',
  decisionId: 'decision-1',
  executionId: EXECUTION,
  actorId: 'agent-1',
  actionType: 'act',
  classification: 'claimed-no-outcome',
  attentionRequired: true,
  attentionReasons: ['EXECUTION_CLAIMED_NO_OUTCOME'],
  unresolved: true,
  resolvable: true,
  decision: { status: 'allowed', reasonCodes: ['ACTION_ALLOWED'], evaluatedAt: 't', persistedAt: 't' },
  approval: null,
  issuance: { status: 'issued', withheldBy: null, reasonCodes: [], recordedAt: 't' },
  execution: { claim: 'recorded', claimedAt: 't' },
  outcome: { status: 'none', source: null, failure: null, withheldBy: null, reasonCodes: [], recordedAt: null },
  trace: { available: true, finalState: 'claimed-outcome-unrecorded', failure: null },
  ...overrides,
});

const traceView = (stages: Record<string, unknown> = {}, operational: Partial<OperationalExecution> = {}): OperationalTrace => ({
  requestId: REQUEST,
  disclosure: { level: 'AUDITOR', policyId: 'evidence.disclosure.auditor.v2', hiddenFields: [] },
  trace: { requestId: REQUEST, evaluationId: 'evaluation-1', decisionId: 'decision-1', summary: { path: 'allowed', finalState: 'claimed-outcome-unrecorded', presence: {} }, stages },
  traceDigest: 'sha256:abc',
  verification: { verified: true, categories: { contract: 'pass' }, checks: [], finalState: 'claimed-outcome-unrecorded', verifiedAt: 't', boundary: 'b' },
  operational: { ...execution(operational), hidden: [] },
  generatedAt: 't',
});

const ok = <T,>(body: T): Promise<HostResult<T>> => Promise.resolve({ ok: true, status: 200, body });

function scriptedHost(overrides: Partial<HostClient>, calls: string[]): HostClient {
  const base: Partial<HostClient> = { organization: () => ok(context), trace: () => ok(traceView()) };
  return new Proxy({ ...base, ...overrides } as HostClient, {
    get(target, name: string) {
      const value = (target as unknown as Record<string, unknown>)[name];
      if (typeof value !== 'function') return () => Promise.resolve({ ok: false, failure: classifyHostFailure(404, undefined) });
      return (...args: unknown[]) => {
        calls.push(name);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

function request(method: string, url: string, headers: Record<string, string>, body = ''): IncomingMessage {
  const stream = Readable.from(body.length > 0 ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(stream, { method, url, headers });
  return stream;
}

function signedIn(host: HostClient): { app: ReturnType<typeof createConsoleApp>; cookie: string; csrf: string } {
  const sessions = createSessionStore();
  const app = createConsoleApp({ host, sessions, publicOrigin: ORIGIN });
  const session = sessions.create('operator-bearer-value', 'ops-admin');
  return { app, cookie: `${SESSION_COOKIE}=${session.id}`, csrf: session.csrfToken };
}

const resolutionUrl = `/traces/${encodeURIComponent(REQUEST)}/resolution`;
const submit = (cookie: string, fields: Record<string, string>): IncomingMessage =>
  request('POST', resolutionUrl, { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(fields).toString());

const recordedBody = (capacity: string, failure: string | null = null): OperatorResolutionResponse => ({
  outcome: 'recorded',
  requestId: REQUEST,
  evaluationId: 'evaluation-1',
  executionId: EXECUTION,
  resolution: { resolvedBy: 'operator-attestation', attestedBy: 'operator:ops-admin', certainty: failure === null ? 'confirmed-completed' : 'confirmed-not-completed', failure, resolvedAt: 't', recordedAt: 't', resolutionDigest: 'sha256:r' },
  capacity,
  effect: 'resolution-recorded-no-action-performed',
});

// -- C: the closed form --------------------------------------------------------------------

describe('PROD-03-02 hardening C — the console enforces the Host’s closed resolution form', () => {
  it('C1 / C2 / C4 / C5 / C6: the pure rule, with explicit operator-safe copy', () => {
    assert.equal(resolutionFormError('confirmed-completed', ''), undefined, 'C1');
    assert.equal(resolutionFormError('confirmed-completed', 'PROVIDER_REJECTED'), RESOLUTION_FORM_ERRORS.completedWithFailure, 'C2');
    assert.equal(resolutionFormError('confirmed-completed', 'BANK_SAID_NO'), RESOLUTION_FORM_ERRORS.completedWithFailure);
    for (const reason of RESOLUTION_FAILURE_REASONS) assert.equal(resolutionFormError('confirmed-not-completed', reason), undefined, `C4 ${reason}`);
    assert.equal(resolutionFormError('confirmed-not-completed', ''), RESOLUTION_FORM_ERRORS.notCompletedWithoutFailure, 'C5');
    for (const malformed of ['BANK_SAID_NO', 'provider_rejected', ' PROVIDER_REJECTED', 'PROVIDER_REJECTED,ADAPTER_ERROR']) {
      assert.equal(resolutionFormError('confirmed-not-completed', malformed), RESOLUTION_FORM_ERRORS.unknownFailure, `C6 ${malformed}`);
    }
    assert.equal(RESOLUTION_FORM_ERRORS.completedWithFailure, 'Failure reason must be empty when recording a completed resolution.');
    assert.equal(RESOLUTION_FORM_ERRORS.notCompletedWithoutFailure, 'A failure reason is required when recording a not-completed resolution.');
  });

  it('C2 / C3: a completion submitted with a retained failure reason is refused before the Host is asked, and the form comes back empty', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = signedIn(scriptedHost({ resolveExecution: () => ok(recordedBody('adjusted')) }, calls));
    const response = await app.handle(submit(cookie, { csrf, resolution: 'confirmed-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'none', confirm: 'yes' }));
    assert.equal(response.status, 400);
    assert.equal(calls.includes('resolveExecution'), false, 'no Host mutation');
    const html = response.body ?? '';
    assert.match(html, /Failure reason must be empty when recording a completed resolution\./);
    assert.match(html, /data-testid="resolution-form"/, 'the page is re-read and the form offered again');
    assert.match(html, /<option value="" selected="">/, 'C3: the failure reason is cleared');
    assert.doesNotMatch(html, /<option value="PROVIDER_REJECTED" selected/, 'C3: the earlier reason is never re-applied');
    assert.doesNotMatch(html, /name="resolution"[^>]*checked/, 'and no resolution is pre-chosen');
  });

  it('C5 / C6: a non-completion without a reason, or with an unknown one, is refused before the Host is asked', async () => {
    for (const [failure, copy] of [
      ['', RESOLUTION_FORM_ERRORS.notCompletedWithoutFailure],
      ['BANK_SAID_NO', RESOLUTION_FORM_ERRORS.unknownFailure],
    ] as const) {
      const calls: string[] = [];
      const { app, cookie, csrf } = signedIn(scriptedHost({ resolveExecution: () => ok(recordedBody('adjusted', 'PROVIDER_REJECTED')) }, calls));
      const response = await app.handle(submit(cookie, { csrf, resolution: 'confirmed-not-completed', failure, observedOutcome: 'none', confirm: 'yes' }));
      assert.equal(response.status, 400, failure);
      assert.equal(calls.includes('resolveExecution'), false, `${failure}: no Host mutation`);
      assert.ok((response.body ?? '').includes(copy), failure);
    }
  });

  it('fresh review of #172 — padded values are refused as submitted, never trimmed into a valid permanent resolution', async () => {
    for (const fields of [
      { resolution: 'confirmed-completed', failure: '  ' },
      { resolution: 'confirmed-not-completed', failure: ' PROVIDER_REJECTED' },
      { resolution: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED ' },
      { resolution: ' confirmed-completed', failure: '' },
    ]) {
      const calls: string[] = [];
      const { app, cookie, csrf } = signedIn(scriptedHost({ resolveExecution: () => ok(recordedBody('adjusted')) }, calls));
      const response = await app.handle(submit(cookie, { csrf, ...fields, observedOutcome: 'none', confirm: 'yes' }));
      assert.equal(response.status, 400, JSON.stringify(fields));
      assert.equal(calls.includes('resolveExecution'), false, `${JSON.stringify(fields)}: no Host mutation`);
    }
    const calls: string[] = [];
    const { app, cookie, csrf } = signedIn(scriptedHost({ resolveExecution: () => ok(recordedBody('adjusted')) }, calls));
    const padded = await app.handle(submit(cookie, { csrf, resolution: 'confirmed-completed', failure: '', observedOutcome: ' none', confirm: 'yes' }));
    assert.equal(padded.status, 400);
    assert.equal(calls.includes('resolveExecution'), false);
  });

  it('C1 / C4: valid forms reach the Host with exactly the closed body', async () => {
    const bodies: OperatorResolutionBody[] = [];
    for (const [fields, expected] of [
      [{ resolution: 'confirmed-completed', failure: '' }, { resolution: 'confirmed-completed', observedOutcome: 'none' }],
      [{ resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' }, { resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' }],
    ] as const) {
      bodies.length = 0;
      const calls: string[] = [];
      const host = scriptedHost(
        {
          resolveExecution: (_bearer, _executionId, body) => {
            bodies.push(body);
            return ok(recordedBody('adjusted', body.failure ?? null));
          },
        },
        calls,
      );
      const { app, cookie, csrf } = signedIn(host);
      const response = await app.handle(submit(cookie, { csrf, ...fields, observedOutcome: 'none', confirm: 'yes' }));
      assert.equal(response.status, 303, JSON.stringify(fields));
      assert.deepEqual(bodies, [expected]);
    }
  });
});

// -- D: the capacity result ---------------------------------------------------------------

describe('PROD-03-02 hardening D — the console states the capacity result beside the recorded resolution', () => {
  it('every capacity result the Host states has its own notice (the list is pinned to the runtime’s in prod0302-review-hardening.test.ts)', () => {
    for (const capacity of RESOLUTION_CAPACITY_RESULTS) assert.ok(CAPACITY_RESULT_NOTICES[capacity] !== undefined, capacity);
  });

  async function resolveWith(capacity: string) {
    const calls: string[] = [];
    const host = scriptedHost({ resolveExecution: () => ok(recordedBody(capacity, 'PROVIDER_UNAVAILABLE')) }, calls);
    const { app, cookie, csrf } = signedIn(host);
    const response = await app.handle(submit(cookie, { csrf, resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none', confirm: 'yes' }));
    return { app, cookie, response, calls };
  }

  for (const capacity of ['adjusted', 'no-reservation'] as const) {
    it(`D1 (${capacity}): the plain success, stated with its capacity result`, async () => {
      const { app, cookie, response } = await resolveWith(capacity);
      assert.equal(response.status, 303);
      const trace = await app.handle(request('GET', `/traces/${encodeURIComponent(REQUEST)}`, { cookie }));
      const html = trace.body ?? '';
      assert.match(html, /Resolution recorded by the Host: confirmed-not-completed \(PROVIDER_UNAVAILABLE\)/);
      assert.ok(html.includes(CAPACITY_RESULT_NOTICES[capacity]?.body ?? '\u0000'), 'the capacity result is part of the success');
    });
  }

  const INCOMPLETE = {
    pending: { tone: 'warning', title: /Resolution recorded\. Capacity reconciliation is still pending\./ },
    conflict: { tone: 'danger', title: /Resolution recorded\. Capacity reconciliation is in conflict and requires investigation\./ },
    inconsistent: { tone: 'danger', title: /Resolution recorded\. The capacity ledger contradicts it\./ },
    'not-composed': { tone: 'warning', title: /Resolution recorded\. Capacity reconciliation is unavailable in this Host\./ },
  } as const;

  for (const [capacity, expected] of Object.entries(INCOMPLETE)) {
    it(`D2–D5 (${capacity}): the resolution is shown as recorded AND capacity as not reconciled — never a plain success`, async () => {
      const { response } = await resolveWith(capacity);
      assert.equal(response.status, 200, 'answered in place: the operator must read it');
      const html = response.body ?? '';
      assert.match(html, /data-testid="resolution-recorded"/, 'the resolution result is not hidden');
      assert.match(html, expected.title);
      assert.match(html, new RegExp(`notice--${expected.tone}`));
      assert.match(html, new RegExp(`data-capacity="${capacity}"`));
      assert.doesNotMatch(html, /Capacity reconciled|No capacity to reconcile/, 'no false full-success copy');
      assert.doesNotMatch(html, /<script|\son[a-z]+="|\b(Retry|Resend|Replay|Re-execute)\b/i, 'no script and no execution-retry wording');
      if (capacity === 'pending') {
        const form = /<form[^>]*data-testid="capacity-reconcile-again-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
        assert.ok(form.length > 0, 'pending: running the capacity reconciliation again is offered');
        assert.match(form, /action="\/traces\/aoc\.gar%3A0123456789abcdef0123456789abcdef\/resolution"/);
        assert.match(form, />\s*Run capacity reconciliation again\s*</);
        assert.match(form, /name="resolution" value="confirmed-not-completed"/);
        assert.match(form, /name="failure" value="PROVIDER_UNAVAILABLE"/);
        assert.match(form, /name="observedOutcome" value="none"/);
        assert.doesNotMatch(form, /<select|type="radio"|type="text"|type="checkbox"/, 'the identical resolution only: nothing can be chosen');
      } else {
        assert.doesNotMatch(html, /capacity-reconcile-again-form/, `${capacity}: nothing to run again — it is investigated, never repaired`);
      }
    });
  }

  it('D6 (console): the pending form re-submits the identical resolution; the Host’s replay with `adjusted` then reads as the success', async () => {
    const bodies: OperatorResolutionBody[] = [];
    let capacity = 'pending';
    const calls: string[] = [];
    const host = scriptedHost(
      {
        resolveExecution: (_bearer, _executionId, body) => {
          bodies.push(body);
          return ok({ ...recordedBody(capacity, 'PROVIDER_UNAVAILABLE'), outcome: bodies.length > 1 ? 'replayed' : 'recorded' });
        },
      },
      calls,
    );
    const { app, cookie, csrf } = signedIn(host);
    const first = await app.handle(submit(cookie, { csrf, resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none', confirm: 'yes' }));
    const form = /<form[^>]*data-testid="capacity-reconcile-again-form"[\s\S]*?<\/form>/.exec(first.body ?? '')?.[0] ?? '';
    const fields = Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    capacity = 'adjusted';
    const again = await app.handle(submit(cookie, fields as Record<string, string>));
    assert.equal(again.status, 303);
    assert.deepEqual(bodies[1], bodies[0], 'the identical resolution, field for field');
  });

  it('an unrecognized capacity value is never read as success', async () => {
    const { response } = await resolveWith('something-new');
    assert.equal(response.status, 200);
    assert.match(response.body ?? '', /notice--danger/);
    assert.match(response.body ?? '', /not one this console recognizes/);
  });

  it('the trace keeps a warning while the reservation holds no reconciliation matching the resolution — and only then', () => {
    const resolved = (certainty: string) => ({ presence: 'resolved', resolution: { certainty } });
    const cases: [Record<string, unknown>, boolean][] = [
      [{ resolution: resolved('confirmed-not-completed'), reservation: { presence: 'recorded', state: 'consumed' } }, true],
      [{ resolution: resolved('confirmed-not-completed'), reservation: { presence: 'recorded', state: 'consumed', resolution: 'confirmed-completed' } }, true],
      [{ resolution: resolved('confirmed-not-completed'), reservation: { presence: 'recorded', state: 'consumed', resolution: 'confirmed-not-completed' } }, false],
      [{ resolution: resolved('confirmed-completed'), reservation: { presence: 'recorded', state: 'consumed', resolution: 'confirmed-completed' } }, false],
      [{ resolution: resolved('confirmed-completed'), reservation: { presence: 'none-recorded' } }, false],
      [{ resolution: { presence: 'unresolved' }, reservation: { presence: 'recorded', state: 'reserved' } }, false],
      [{ resolution: resolved('confirmed-not-completed') }, false],
      // Fresh review of #172: P7's identity is the answer AND the resolution digest it was recorded for.
      [{ resolution: { presence: 'resolved', resolution: { certainty: 'confirmed-not-completed', resolutionDigest: 'sha256:p12' } }, reservation: { presence: 'recorded', resolution: 'confirmed-not-completed', resolutionDigest: 'sha256:p12' } }, false],
      [{ resolution: { presence: 'resolved', resolution: { certainty: 'confirmed-not-completed', resolutionDigest: 'sha256:p12' } }, reservation: { presence: 'recorded', resolution: 'confirmed-not-completed', resolutionDigest: 'sha256:other' } }, true],
      [{ resolution: { presence: 'resolved', resolution: { certainty: 'confirmed-not-completed', resolutionDigest: 'sha256:p12' } }, reservation: { presence: 'recorded', resolution: 'confirmed-not-completed' } }, true],
    ];
    for (const [stages, expected] of cases) {
      assert.equal(capacityReconciliationMissing(stages), expected, JSON.stringify(stages));
      const html = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={traceView(stages, { resolvable: false })} />);
      assert.equal(html.includes('data-testid="trace-capacity-unreconciled"'), expected, JSON.stringify(stages));
    }
  });
});

// -- Fresh review of #172: an incomplete capacity reconciliation stays recoverable from the durable trace --------

describe('PROD-03-02 hardening D — the identical resolution is recoverable from the trace, by the attesting operator', () => {
  const unreconciled = (attestedBy: string, outcome: Record<string, unknown> = { presence: 'unresolved' }): Record<string, unknown> => ({
    outcome,
    resolution: { presence: 'recorded', resolution: { certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', attestedBy, resolutionDigest: 'sha256:p12' } },
    reservation: { presence: 'recorded', state: 'settled' },
  });
  const verified = (stages: Record<string, unknown>, capacityReconcilable = true): OperationalTrace => traceView(stages, { resolvable: false, capacityReconcilable });
  const other: OrganizationContext = { ...context, operator: { ...context.operator, operatorId: 'ops-other' } };
  const observer: OrganizationContext = { ...context, operator: { ...context.operator, permissions: ['operations.read', 'trace.read'] } };

  it('the attesting operator gets exactly the recorded resolution and the reviewed basis; nobody else gets one', () => {
    assert.deepEqual(identicalResolutionOf(verified(unreconciled('operator:ops-admin')), context), { resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' });
    assert.deepEqual(identicalResolutionOf(verified(unreconciled('operator:ops-admin', { presence: 'recorded', certainty: 'unconfirmed' })), context)?.observedOutcome, 'unconfirmed');
    assert.equal(identicalResolutionOf(verified(unreconciled('operator:ops-admin')), other), undefined, 'another operator’s submission would be a different attestation');
    assert.equal(identicalResolutionOf(verified(unreconciled('operator:ops-admin')), observer), undefined, 'operations.resolve only');
    assert.equal(identicalResolutionOf({ ...verified(unreconciled('operator:ops-admin')), verification: { ...verified({}).verification, verified: false } }, context), undefined, 'a contradiction is investigated, never re-run');
    assert.equal(identicalResolutionOf(verified(unreconciled('operator:ops-admin', { presence: 'recorded', certainty: 'confirmed-completed' })), context), undefined, 'no basis an operator could have reviewed');
    assert.equal(identicalResolutionOf(verified(unreconciled('operator:ops-admin'), false), context), undefined, 'the Host says it cannot complete it (not-composed, or a contradiction)');
  });

  it('the trace page offers it inside the capacity warning — and explains, without a form, to anyone else', () => {
    const own = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={verified(unreconciled('operator:ops-admin'))} />);
    assert.match(own, /data-testid="trace-capacity-unreconciled"/);
    const form = /<form[^>]*data-testid="capacity-reconcile-again-form"[\s\S]*?<\/form>/.exec(own)?.[0] ?? '';
    assert.ok(form.length > 0);
    assert.match(form, /name="resolution" value="confirmed-not-completed"/);
    assert.match(form, /name="failure" value="PROVIDER_UNAVAILABLE"/);
    assert.match(form, /name="observedOutcome" value="none"/);
    assert.doesNotMatch(form, /<select|type="radio"|type="text"|type="checkbox"/);
    const theirs = renderToStaticMarkup(<TracePage context={other} csrfToken="t" view={verified(unreconciled('operator:ops-admin'))} />);
    assert.match(theirs, /data-testid="trace-capacity-unreconciled"/);
    assert.doesNotMatch(theirs, /capacity-reconcile-again-form|action="\/traces\/[^"]*\/resolution"/);
    assert.match(theirs, /Only the operator who recorded this resolution/);
  });

  it('where the Host says submitting again cannot complete it (`not-composed`), the warning stays and no form is offered', () => {
    const html = renderToStaticMarkup(<TracePage context={context} csrfToken="t" view={verified(unreconciled('operator:ops-admin'), false)} />);
    assert.match(html, /data-testid="trace-capacity-unreconciled"/);
    assert.doesNotMatch(html, /capacity-reconcile-again-form/);
    assert.match(html, /this Host has no capacity reconciliation, or the capacity ledger must be investigated/);
  });

  it('after navigating away, the trace’s form re-submits the identical resolution to the Host', async () => {
    const bodies: OperatorResolutionBody[] = [];
    const calls: string[] = [];
    const host = scriptedHost(
      {
        trace: () => ok(verified(unreconciled('operator:ops-admin'))),
        resolveExecution: (_bearer, _executionId, body) => {
          bodies.push(body);
          return ok({ ...recordedBody('adjusted', 'PROVIDER_UNAVAILABLE'), outcome: 'replayed' });
        },
      },
      calls,
    );
    const { app, cookie, csrf } = signedIn(host);
    const page = await app.handle(request('GET', `/traces/${encodeURIComponent(REQUEST)}`, { cookie }));
    const form = /<form[^>]*data-testid="capacity-reconcile-again-form"[\s\S]*?<\/form>/.exec(page.body ?? '')?.[0] ?? '';
    const fields = Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    const response = await app.handle(submit(cookie, { ...(fields as Record<string, string>), csrf }));
    assert.equal(response.status, 303);
    assert.deepEqual(bodies, [{ resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' }]);
  });
});
