import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve as resolvePath } from 'node:path';

import { createEnterpriseHostClient } from '../src/client.js';
import { EnterpriseHostApiError, EnterpriseHostNetworkError, EnterpriseHostTimeoutError } from '../src/errors.js';
import * as sdk from '../src/index.js';
import type { GovernedActionDecisionRef, GovernedActionExecutionFailure, GovernedActionIntent, GovernedActionResult } from '../src/index.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const DECISION = { decisionId: 'dec-9', evaluationId: 'eval-9', status: 'allowed', reasonCodes: [] };

/** Host replies for `POST /api/governed-actions`, keyed by the intent's idempotencyKey. */
const GOVERNED_REPLIES: Readonly<Record<string, { readonly status: number; readonly body: unknown }>> = {
  executed: { status: 200, body: { status: 'executed', requestId: 'r-1', decision: DECISION, executionId: 'x-1', reasonCodes: [], providerRef: 'p-1', replayed: false, outcomeRecorded: true } },
  withheld: { status: 409, body: { status: 'withheld', withheldBy: 'emergency-control', requestId: 'r-2', decision: DECISION, reasonCodes: ['EMERGENCY_CONTROL_ACTIVE'] } },
  denied: { status: 422, body: { status: 'denied', requestId: 'r-3', decision: { ...DECISION, status: 'denied', reasonCodes: ['X'] }, reasonCodes: ['X'] } },
  failed: { status: 502, body: { status: 'execution_failed', requestId: 'r-4', decision: DECISION, executionId: 'x-4', failure: 'PROVIDER_REJECTED', reasonCodes: ['PROVIDER_REJECTED'], replayed: false, outcomeRecorded: true } },
  unconfirmed: { status: 409, body: { status: 'execution_unconfirmed', requestId: 'r-5', reasonCodes: ['GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED'] } },
  conflict: { status: 409, body: { status: 'rejected', requestId: 'r-6', reasonCodes: ['GOVERNED_ACTION_IDEMPOTENCY_CONFLICT'] } },
  indeterminate: { status: 503, body: { status: 'indeterminate', requestId: 'r-7', reasonCodes: ['KERNEL_INDETERMINATE'] } },
  'system-error': { status: 500, body: { status: 'system_error', requestId: 'r-8', reasonCodes: ['GOVERNED_ACTION_KERNEL_FAILED'] } },
  unauthenticated: { status: 401, body: { error: { code: 'AUTHENTICATION_FAILED', message: 'A valid customer credential is required.' } } },
  unmounted: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No route for POST /api/governed-actions.' } } },
  'unknown-body': { status: 500, body: { surprise: true } },
  'unknown-status': { status: 409, body: { status: 'approved-by-sdk', reasonCodes: [] } },
  // Malformed or drifted responses: each must throw, never be returned as a typed result.
  'drift-200-surprise': { status: 200, body: { surprise: true } },
  'drift-200-envelope': { status: 200, body: { error: { code: 'AUTHENTICATION_FAILED', message: 'nope' } } },
  'drift-withheld-no-gate': { status: 409, body: { status: 'withheld', reasonCodes: [] } },
  'drift-failure-unknown': { status: 502, body: { status: 'execution_failed', failure: 'PROVIDER_ON_FIRE', reasonCodes: [], replayed: false, outcomeRecorded: true } },
  'drift-failure-flags': { status: 502, body: { status: 'execution_failed', failure: 'PROVIDER_REJECTED', reasonCodes: [], replayed: 'no', outcomeRecorded: 1 } },
  'drift-reason-not-string': { status: 422, body: { status: 'denied', reasonCodes: ['X', 7] } },
  'drift-decision-status': { status: 422, body: { status: 'denied', reasonCodes: [], decision: { ...DECISION, status: 'approved-by-sdk' } } },
  'drift-executed-no-replayed': { status: 200, body: { status: 'executed', reasonCodes: [], outcomeRecorded: true } },
  'drift-executed-no-recorded': { status: 200, body: { status: 'executed', reasonCodes: [], replayed: false } },
  'drift-denied-as-500': { status: 500, body: { status: 'denied', requestId: 'r-3', reasonCodes: ['X'] } },
  'drift-system-error-as-401': { status: 401, body: { status: 'system_error', reasonCodes: [] } },
  'drift-executed-as-201': { status: 201, body: { status: 'executed', reasonCodes: [], replayed: false, outcomeRecorded: true } },
  'drift-request-id-number': { status: 200, body: { status: 'executed', requestId: 42, reasonCodes: [], replayed: false, outcomeRecorded: true } },
  'drift-provider-ref-number': { status: 200, body: { status: 'executed', providerRef: 7, reasonCodes: [], replayed: false, outcomeRecorded: true } },
  'drift-rejected-identity-as-400': { status: 400, body: { status: 'rejected', reasonCodes: ['GOVERNED_ACTION_IDENTITY_INVALID'] } },
  additive: { status: 200, body: { status: 'executed', requestId: 'r-10', reasonCodes: [], replayed: false, outcomeRecorded: true, futureField: { anything: [1, 2] }, decision: { ...DECISION, futureDecisionField: true } } },
  'rejected-identity': { status: 403, body: { status: 'rejected', reasonCodes: ['GOVERNED_ACTION_IDENTITY_INVALID'] } },
  'rejected-invalid': { status: 400, body: { status: 'rejected', reasonCodes: ['GOVERNED_ACTION_INTENT_INVALID'] } },
};

let server: Server;
let baseUrl: string;
const recorded: RecordedRequest[] = [];

// A scripted stub Host: the SDK is transport-only, so its contract is fully
// testable against canned responses -- no Enterprise runtime is imported.
before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const respond = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
      };

      if (req.url === '/live') return respond(200, { live: true, lifecycleState: 'ready' });
      if (req.url === '/api/governed-actions') {
        // Scripted by the intent's idempotencyKey: each key names the Host reply to give.
        const key = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { idempotencyKey?: string }).idempotencyKey ?? '';
        const scripted = GOVERNED_REPLIES[key];
        if (scripted !== undefined) return respond(scripted.status, scripted.body);
        return respond(400, { status: 'rejected', reasonCodes: ['GOVERNED_ACTION_INTENT_INVALID'] });
      }
      if (req.url === '/api/governance/evaluate' && (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { actor?: { id?: string } }).actor?.id === 'denied-actor') {
        return respond(422, { requestId: 'req-2', decisionId: 'dec-2', status: 'denied', summary: 'denied', reasonCodes: ['RECOGNITION_ACTOR_UNKNOWN'], trace: { steps: [] }, evaluatedAt: '2026-01-01T00:00:00.000Z', kernelVersion: '1.0.0' });
      }
      if (req.url === '/api/governance/evaluate') {
        return respond(200, {
          requestId: 'req-1',
          decisionId: 'dec-1',
          status: 'allowed',
          summary: 'ok',
          reasonCodes: [],
          trace: { steps: [] },
          evaluatedAt: '2026-01-01T00:00:00.000Z',
          kernelVersion: '1.0.0',
          governanceRecord: { evaluationId: 'eval-1', aggregateDigest: 'sha256:0'.padEnd(71, '0') },
        });
      }
      if (req.url?.startsWith('/api/governance/evaluations/')) return respond(404, { error: { code: 'GOVERNANCE_RECORD_NOT_FOUND', message: 'missing', details: ['detail-1'] } });
      if (req.url === '/slow') {
        setTimeout(() => respond(200, {}), 5_000);
        return;
      }
      return respond(404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}.` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an inet address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('createEnterpriseHostClient', () => {
  it('sends bearer credentials and the idempotency key, and parses the evaluate response', async () => {
    const client = createEnterpriseHostClient({ baseUrl: `${baseUrl}/`, apiKey: 'secret-1' });
    const response = await client.evaluate(
      { actor: { id: 'a-1', trustDomainId: 'td-1' }, action: { type: 'act', resourceScope: 'scope' } },
      { idempotencyKey: 'idem-1' },
    );

    assert.equal(response.status, 'allowed');
    assert.equal(response.governanceRecord?.evaluationId, 'eval-1');
    const request = recorded[recorded.length - 1];
    if (request === undefined) throw new Error('no request recorded');
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/governance/evaluate');
    assert.equal(request.headers.authorization, 'Bearer secret-1');
    assert.equal(request.headers['idempotency-key'], 'idem-1');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(request.body).actor.id, 'a-1');
  });

  it('reactivatePassport posts reactivatedBy (the field the Host route actually validates)', async () => {
    const client = createEnterpriseHostClient({ baseUrl });
    await client.reactivatePassport('passport-1', 'actor-1').catch(() => undefined);
    const request = recorded[recorded.length - 1];
    if (request === undefined) throw new Error('no request recorded');
    assert.equal(request.url, '/api/passports/passport-1/reactivate');
    assert.deepEqual(JSON.parse(request.body), { reactivatedBy: 'actor-1' });
  });

  it('URL-encodes path parameters', async () => {
    const client = createEnterpriseHostClient({ baseUrl });
    await client.getEvaluation('needs encoding/../x').catch(() => undefined);
    const request = recorded[recorded.length - 1];
    if (request === undefined) throw new Error('no request recorded');
    assert.equal(request.url, '/api/governance/evaluations/needs%20encoding%2F..%2Fx');
  });

  it('maps enveloped errors to EnterpriseHostApiError with status, code, and details', async () => {
    const client = createEnterpriseHostClient({ baseUrl });
    await assert.rejects(
      () => client.getEvaluation('missing-id'),
      (error: unknown) => {
        if (!(error instanceof EnterpriseHostApiError)) return false;
        assert.equal(error.status, 404);
        assert.equal(error.code, 'GOVERNANCE_RECORD_NOT_FOUND');
        assert.deepEqual(error.details, ['detail-1']);
        return true;
      },
    );
  });

  it('throws EnterpriseHostTimeoutError when timeoutMs elapses on a slow route', async () => {
    // Redirect the client's /live call to the stub's /slow route (answers after 5s).
    const client = createEnterpriseHostClient({
      baseUrl,
      timeoutMs: 150,
      fetch: (input, init) => fetch(input.replace('/live', '/slow'), init as Parameters<typeof fetch>[1]),
    });
    let caught: unknown;
    try {
      await client.live();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof EnterpriseHostTimeoutError)) throw new Error('expected EnterpriseHostTimeoutError');
    assert.equal(caught.timeoutMs, 150);
  });

  it('does not time out fast routes within the budget', async () => {
    const client = createEnterpriseHostClient({ baseUrl, timeoutMs: 2_000 });
    const live = await client.live();
    assert.equal(live.live, true);
  });

  it('throws EnterpriseHostNetworkError when the host is unreachable', async () => {
    const client = createEnterpriseHostClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2_000 });
    await assert.rejects(
      () => client.live(),
      (error: unknown) => error instanceof EnterpriseHostNetworkError,
    );
  });
});

describe('governAction', () => {
  const intent = (idempotencyKey: string): GovernedActionIntent => ({
    action: 'payment.create',
    resource: 'invoice:INV-100',
    counterparty: 'vendor:V123',
    amount: { value: '7500', currency: 'USD' },
    assertedContext: { passportId: 'passport-1' },
    correlationId: 'order-123',
    idempotencyKey,
  });
  const lastRequest = (): RecordedRequest => {
    const request = recorded[recorded.length - 1];
    if (request === undefined) throw new Error('no request recorded');
    return request;
  };

  it('POSTs to /api/governed-actions with the client’s bearer key and exactly the supplied intent', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'customer-key-1' });
    const sent = intent('executed');
    await client.governAction(sent);
    const request = lastRequest();
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/governed-actions');
    assert.equal(request.headers.authorization, 'Bearer customer-key-1');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['idempotency-key'], undefined, 'the body key is canonical; no header is synthesized');
    assert.deepEqual(JSON.parse(request.body), sent);
  });

  it('synthesizes no actor, organization, adapter, provider or grant', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'customer-key-1' });
    await client.governAction({ action: 'a', resource: 'r', idempotencyKey: 'executed' });
    const body = JSON.parse(lastRequest().body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['action', 'idempotencyKey', 'resource']);
    for (const key of ['actor', 'actorId', 'organization', 'organizationId', 'adapter', 'adapterId', 'provider', 'grant', 'grantId', 'system']) {
      assert.equal(key in body, false, key);
    }
  });

  it('GovernedActionIntent is closed at compile time', () => {
    // @ts-expect-error — no adapter selection on the intent.
    const withAdapter: GovernedActionIntent = { action: 'a', resource: 'r', idempotencyKey: 'k', adapterId: 'x' };
    // @ts-expect-error — no caller-supplied actor.
    const withActor: GovernedActionIntent = { action: 'a', resource: 'r', idempotencyKey: 'k', actorId: 'x' };
    // @ts-expect-error — no caller-supplied organization.
    const withOrganization: GovernedActionIntent = { action: 'a', resource: 'r', idempotencyKey: 'k', organizationId: 'x' };
    // @ts-expect-error — no provider URL.
    const withUrl: GovernedActionIntent = { action: 'a', resource: 'r', idempotencyKey: 'k', url: 'https://x' };
    // @ts-expect-error — idempotencyKey is required.
    const withoutKey: GovernedActionIntent = { action: 'a', resource: 'r' };
    assert.ok([withAdapter, withActor, withOrganization, withUrl, withoutKey].length === 5);
  });

  it('GovernedActionResult mirrors the Host’s closed decision-status and failure vocabularies', () => {
    const decision: GovernedActionDecisionRef = { decisionId: 'd', evaluationId: 'e', status: 'allowed', reasonCodes: [] };
    // @ts-expect-error — decision.status is the Kernel's closed vocabulary, not any string.
    const wrongStatus: GovernedActionDecisionRef = { decisionId: 'd', evaluationId: 'e', status: 'approved-by-sdk', reasonCodes: [] };
    const failure: GovernedActionExecutionFailure = 'PROVIDER_REJECTED';
    // @ts-expect-error — execution_failed.failure is the Host's closed execution-failure vocabulary.
    const wrongFailure: GovernedActionExecutionFailure = 'SOMETHING_ELSE';
    const failed: GovernedActionResult = { status: 'execution_failed', failure, reasonCodes: [], replayed: false, outcomeRecorded: true, decision };
    // @ts-expect-error — an arbitrary failure string does not type-check inside a result either.
    const wrongFailedResult: GovernedActionResult = { status: 'execution_failed', failure: 'SOMETHING_ELSE', reasonCodes: [], replayed: false, outcomeRecorded: true };
    // @ts-expect-error — nor an arbitrary decision status inside a result.
    const wrongDecisionResult: GovernedActionResult = { status: 'denied', reasonCodes: [], decision: { ...decision, status: 'approved-by-sdk' } };
    assert.ok([wrongStatus, wrongFailure, failed, wrongFailedResult, wrongDecisionResult].length === 5);
  });

  it('returns a 200 executed result', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
    const result = await client.governAction(intent('executed'));
    assert.equal(result.status, 'executed');
    assert.equal(result.status === 'executed' ? result.providerRef : undefined, 'p-1');
  });

  for (const [key, status, httpStatus] of [
    ['withheld', 'withheld', 409],
    ['denied', 'denied', 422],
    ['failed', 'execution_failed', 502],
    ['unconfirmed', 'execution_unconfirmed', 409],
    ['conflict', 'rejected', 409],
    ['indeterminate', 'indeterminate', 503],
    ['system-error', 'system_error', 500],
  ] as const) {
    it(`returns a ${httpStatus} ${status} result rather than throwing`, async () => {
      const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
      const result: GovernedActionResult = await client.governAction(intent(key));
      assert.equal(result.status, status);
      assert.deepEqual(result, GOVERNED_REPLIES[key]?.body);
    });
  }

  it('the withheld result keeps which gate withheld it', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
    const result = await client.governAction(intent('withheld'));
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'emergency-control');
  });

  for (const [key, httpStatus, code] of [
    ['unauthenticated', 401, 'AUTHENTICATION_FAILED'],
    ['unmounted', 404, 'NOT_FOUND'],
  ] as const) {
    it(`an Enterprise error envelope (${httpStatus} ${code}) still throws EnterpriseHostApiError`, async () => {
      const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
      await assert.rejects(
        () => client.governAction(intent(key)),
        (error: unknown) => error instanceof EnterpriseHostApiError && error.status === httpStatus && error.code === code,
      );
    });
  }

  for (const [key, httpStatus] of [
    ['rejected-identity', 403],
    ['rejected-invalid', 400],
  ] as const) {
    it(`returns a ${httpStatus} rejected result under its mapped status`, async () => {
      const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
      const result = await client.governAction(intent(key));
      assert.equal(result.status, 'rejected');
    });
  }

  it('tolerates unknown ADDITIVE fields on an otherwise valid result', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
    const result = await client.governAction(intent('additive'));
    assert.equal(result.status, 'executed');
    assert.deepEqual((result as unknown as { futureField: unknown }).futureField, { anything: [1, 2] });
  });

  for (const [key, description, code] of [
    ['drift-200-surprise', '1. HTTP 200 { surprise: true }', 'UNKNOWN'],
    ['drift-200-envelope', '2. HTTP 200 Enterprise error envelope', 'AUTHENTICATION_FAILED'],
    ['drift-withheld-no-gate', '3. HTTP 409 withheld without withheldBy', 'UNKNOWN'],
    ['drift-failure-unknown', '4. HTTP 502 execution_failed with an unknown failure reason', 'UNKNOWN'],
    ['drift-failure-flags', '5. HTTP 502 execution_failed with replayed/outcomeRecorded of the wrong types', 'UNKNOWN'],
    ['drift-reason-not-string', '6. reasonCodes containing a non-string', 'UNKNOWN'],
    ['drift-decision-status', '7. decision with an unknown decision.status', 'UNKNOWN'],
    ['drift-executed-no-replayed', '8. executed missing replayed', 'UNKNOWN'],
    ['drift-executed-no-recorded', '9. executed missing outcomeRecorded', 'UNKNOWN'],
    ['drift-denied-as-500', '10. a valid denied body delivered as HTTP 500', 'UNKNOWN'],
    ['drift-system-error-as-401', '11. a valid system_error body delivered as HTTP 401', 'UNKNOWN'],
    ['drift-executed-as-201', 'a valid executed body delivered as HTTP 201', 'UNKNOWN'],
    ['drift-request-id-number', 'a non-string requestId', 'UNKNOWN'],
    ['drift-provider-ref-number', 'a non-string providerRef', 'UNKNOWN'],
    ['drift-rejected-identity-as-400', 'an identity rejection delivered as HTTP 400 instead of 403', 'UNKNOWN'],
  ] as const) {
    it(`throws, never returns a typed result: ${description}`, async () => {
      const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
      const reply = GOVERNED_REPLIES[key];
      await assert.rejects(
        () => client.governAction(intent(key)),
        (error: unknown) => {
          if (!(error instanceof EnterpriseHostApiError)) return false;
          assert.equal(error.status, reply?.status);
          assert.equal(error.code, code);
          assert.deepEqual(error.body, reply?.body, 'the raw body stays inspectable on the error');
          return true;
        },
      );
    });
  }

  it('a non-2xx body that is neither a result nor an envelope throws, rather than being returned as a result', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
    for (const key of ['unknown-body', 'unknown-status']) {
      await assert.rejects(
        () => client.governAction(intent(key)),
        (error: unknown) => error instanceof EnterpriseHostApiError && error.code === 'UNKNOWN',
      );
    }
  });

  it('timeout behaviour is unchanged', async () => {
    const client = createEnterpriseHostClient({
      baseUrl,
      apiKey: 'k',
      timeoutMs: 150,
      fetch: (input, init) => fetch(input.replace('/api/governed-actions', '/slow'), init as Parameters<typeof fetch>[1]),
    });
    await assert.rejects(
      () => client.governAction(intent('executed')),
      (error: unknown) => error instanceof EnterpriseHostTimeoutError && error.timeoutMs === 150,
    );
  });

  it('network error behaviour is unchanged', async () => {
    const client = createEnterpriseHostClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', timeoutMs: 2_000 });
    await assert.rejects(
      () => client.governAction(intent('executed')),
      (error: unknown) => error instanceof EnterpriseHostNetworkError,
    );
  });

  it('evaluate() is unchanged: a 422 denial still throws EnterpriseHostApiError with the body attached', async () => {
    const client = createEnterpriseHostClient({ baseUrl, apiKey: 'k' });
    await assert.rejects(
      () => client.evaluate({ actor: { id: 'denied-actor', trustDomainId: 'td-1' }, action: { type: 'act', resourceScope: 'scope' } }),
      (error: unknown) => {
        if (!(error instanceof EnterpriseHostApiError)) return false;
        assert.equal(error.status, 422);
        assert.equal(error.code, 'UNKNOWN');
        assert.equal((error.body as { status?: string }).status, 'denied');
        return true;
      },
    );
  });
});

describe('SDK surface', () => {
  it('keeps exactly the five frozen runtime exports — the new types are type-only', () => {
    assert.deepEqual(Object.keys(sdk).filter((name) => name !== 'default' && name !== '__esModule').sort(), [
      'EnterpriseHostApiError',
      'EnterpriseHostNetworkError',
      'EnterpriseHostTimeoutError',
      'createEnterpriseHostClient',
      'isEnterpriseHostApiError',
    ]);
  });

  it('stays dependency-free', () => {
    const manifest = JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')) as { name?: string; dependencies?: Record<string, string> };
    assert.equal(manifest.name, '@aoc-enterprise/enterprise-host-sdk');
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  });
});
