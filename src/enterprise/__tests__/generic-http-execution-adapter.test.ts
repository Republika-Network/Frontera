import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';

import { EXECUTION_FAILURE_REASONS, type ExecutionAdapterResult, type ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import {
  GENERIC_HTTP_LIMITS,
  GenericHttpConfigurationError,
  type EnterpriseGenericHttpConfigurationErrorCode,
  type EnterpriseGenericHttpExecutionAdapterOptions,
} from '../execution-adapters/generic-http/contracts.js';
import { snapshotGenericHttpOptions, type GenericHttpPlan } from '../execution-adapters/generic-http/configuration.js';
import { classifyGenericHttpStatus, createGenericHttpExecutionAdapter, createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import {
  buildNodeRequestOptions,
  sendOnce,
  type GenericHttpNetworkRuntime,
  type GenericHttpRequestPrimitive,
  type GenericHttpResolution,
  type GenericHttpTransportObservation,
} from '../execution-adapters/generic-http/node-https-transport.js';
import { isPublicIpv4, isPublicIpv6, selectApprovedAddress, type GenericHttpResolvedAddress } from '../execution-adapters/generic-http/public-address-policy.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';

/**
 * The Generic HTTP Execution Adapter, measured at every layer it has:
 * configuration snapshot, pure mapping, address policy, the adapter core over a
 * fake network runtime (so no test touches the internet), the Node transport's
 * phase logic over a fake request primitive, and the transport over **real
 * local sockets** — where a certificate is available, a real TLS server.
 *
 * The properties are counted, never inferred: how many times the resolver was
 * asked, how many requests were sent, which address was dialled, what the
 * provider actually received.
 */

const TOKEN = 'P6BearerSentinel0123456789abcdef';
const API_KEY = 'p6-api-key-sentinel-7f2e';
const PUBLIC_V4: GenericHttpResolvedAddress = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6: GenericHttpResolvedAddress = { address: '2606:4700:4700::1111', family: 6 };

const ACTION: ValidatedExecutionAction = Object.freeze({
  boundedGrantId: 'grant-internal-id-must-not-leave',
  subject: 'actor-pmfreak',
  action: 'invoice.pay',
  resource: 'INV-1001',
  counterparty: 'V123',
  organization: 'org-datasys',
  amount: Object.freeze({ value: '7500', unit: 'USD' }),
  notAfter: '2026-01-01T00:10:00.000Z',
  correlation: Object.freeze({ requestId: 'req-1', decisionId: 'dec-1', executionId: 'exec-1' }),
});

function baseOptions(): EnterpriseGenericHttpExecutionAdapterOptions {
  return {
    adapterId: 'erp.invoice-payment',
    origin: 'https://api.erp.example',
    method: 'POST',
    path: [
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'payments' },
    ],
    headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
    body: {
      kind: 'json-object',
      fields: {
        invoiceId: { kind: 'source', source: 'resource' },
        vendorId: { kind: 'source', source: 'counterparty' },
        amount: { kind: 'source', source: 'amount.value' },
        currency: { kind: 'source', source: 'amount.unit' },
        organization: { kind: 'source', source: 'organization' },
      },
    },
    credential: { kind: 'bearer', token: TOKEN },
    providerRefHeader: 'x-request-id',
  };
}

function withOptions(overrides: Record<string, unknown>): EnterpriseGenericHttpExecutionAdapterOptions {
  return { ...baseOptions(), ...overrides } as EnterpriseGenericHttpExecutionAdapterOptions;
}

function plan(overrides: Record<string, unknown> = {}): GenericHttpPlan {
  return snapshotGenericHttpOptions(withOptions(overrides));
}

function refusedWith(code: EnterpriseGenericHttpConfigurationErrorCode, build: () => unknown): void {
  assert.throws(build, (error: unknown) => {
    assert.ok(error instanceof GenericHttpConfigurationError, `expected a GenericHttpConfigurationError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false, 'a configuration error never echoes the credential');
    assert.equal(error.message.includes(API_KEY), false, 'a configuration error never echoes the credential');
    return true;
  });
}

function mapped(overrides: Record<string, unknown> = {}, action: ValidatedExecutionAction = ACTION): GenericHttpWireRequest {
  const result = mapGenericHttpRequest(plan(overrides), action);
  assert.ok(result.ok, 'the request was expected to be buildable');
  return result.request;
}

function header(request: GenericHttpWireRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key === name)?.[1];
}

/** A scripted network runtime. Counts every resolution and every send; never touches a socket. */
interface FakeRuntime extends GenericHttpNetworkRuntime {
  readonly resolved: string[];
  readonly sent: { readonly request: GenericHttpWireRequest; readonly address: GenericHttpResolvedAddress; readonly timeoutMs: number }[];
}

function fakeRuntime(options: {
  readonly answers?: readonly (GenericHttpResolution | (() => GenericHttpResolution))[];
  readonly observe?: (request: GenericHttpWireRequest) => GenericHttpTransportObservation | Promise<GenericHttpTransportObservation>;
  readonly sendThrows?: true;
} = {}): FakeRuntime {
  const resolved: string[] = [];
  const sent: FakeRuntime['sent'] = [];
  const answers = options.answers ?? [{ kind: 'resolved', answers: [PUBLIC_V4] }];
  return {
    resolved,
    sent,
    async resolve(hostname) {
      resolved.push(hostname);
      const next = answers[Math.min(resolved.length - 1, answers.length - 1)];
      if (next === undefined) return { kind: 'failed' };
      return typeof next === 'function' ? next() : next;
    },
    async send(request, address, timeoutMs) {
      sent.push({ request, address, timeoutMs });
      if (options.sendThrows === true) throw new Error(`socket said ${TOKEN}`);
      return options.observe === undefined ? { kind: 'response', status: 201, providerRefValues: ['prov-77'] } : options.observe(request);
    },
  };
}

async function executeWith(runtime: FakeRuntime, overrides: Record<string, unknown> = {}, action: ValidatedExecutionAction = ACTION): Promise<ExecutionAdapterResult> {
  return createGenericHttpExecutionAdapterCore(plan(overrides), runtime).execute(action);
}

/** A source file with comments removed — what is forbidden is code, not a word in prose. */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const previous = index > 0 ? line[index - 1] : '';
        if (quote !== undefined) {
          if (char === quote && previous !== '\\') quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

const MODULE_DIR = 'src/enterprise/execution-adapters/generic-http';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('Generic HTTP — origin pinning (§39 rows 1–12)', () => {
  it('1. an https DNS origin is accepted and normalized once', () => {
    const snapshot = plan({ origin: 'https://API.Vendor.Example:8443' });
    assert.equal(snapshot.hostname, 'api.vendor.example');
    assert.equal(snapshot.port, 8443);
    assert.equal(plan({ origin: 'https://api.vendor.example/' }).port, 443);
  });

  it('2–3. every scheme but https is refused', () => {
    for (const origin of ['http://api.vendor.example', 'ftp://api.vendor.example', 'ws://api.vendor.example', 'wss://api.vendor.example', 'file:///etc/passwd', 'data:text/plain,x', 'javascript:alert(1)', 'unix:/var/run/x.sock', 'gopher://api.vendor.example', 'api.vendor.example']) {
      refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin }));
    }
  });

  it('4–8. userinfo, password, query, fragment and any non-root path are refused', () => {
    for (const origin of [
      'https://user@api.vendor.example',
      'https://user:pass@api.vendor.example',
      'https://api.vendor.example?x=1',
      'https://api.vendor.example#frag',
      'https://api.vendor.example/v1',
      'https://api.vendor.example/.',
      'https://api.vendor.example\\@evil.example',
      'https://api.vendor.example evil',
      ' https://api.vendor.example',
    ]) {
      refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin }));
    }
  });

  it('9–10. IPv4 and IPv6 literals are refused, including alternate IPv4 spellings', () => {
    for (const origin of ['https://93.184.216.34', 'https://127.0.0.1', 'https://127.1', 'https://0x7f.0.0.1', 'https://2130706433', 'https://[::1]', 'https://[2606:4700::1111]', 'https://169.254.169.254']) {
      refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin }));
    }
  });

  it('11–12. localhost, *.localhost, local-only names, single labels and trailing dots are refused before DNS', () => {
    for (const origin of ['https://localhost', 'https://LOCALHOST', 'https://api.localhost', 'https://localhost.', 'https://api.vendor.example.', 'https://printer.local', 'https://svc.internal', 'https://router.home.arpa', 'https://intranet', 'https://1.2.3.in-addr.arpa']) {
      refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin }));
    }
  });

  it('refuses an out-of-range port and a non-string origin', () => {
    refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin: 'https://api.vendor.example:0' }));
    refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin: 'https://api.vendor.example:70000' }));
    refusedWith('GENERIC_HTTP_ORIGIN_INVALID', () => plan({ origin: 42 }));
  });
});

describe('Generic HTTP — the configuration contract is closed', () => {
  it('refuses every network escape hatch as an unsupported option, rather than ignoring it', () => {
    for (const key of [
      'allowPrivateNetwork',
      'allowLoopback',
      'allowInsecureHttp',
      'followRedirects',
      'maxRedirects',
      'retry',
      'retryCount',
      'proxy',
      'agent',
      'dispatcher',
      'lookup',
      'resolver',
      'transport',
      'fetch',
      'rejectUnauthorized',
      'tlsVerify',
      'customSocket',
      'customRequest',
      'requestBuilder',
      'rawRequest',
      'rawHeaders',
      'rawBody',
      'url',
      'host',
    ]) {
      refusedWith('GENERIC_HTTP_OPTIONS_INVALID', () => plan({ [key]: true }));
    }
  });

  it('refuses unknown keys inside bindings, segments, the body and the credential too', () => {
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { 'X-A': { kind: 'source', source: 'resource', transform: 'x' } } }));
    refusedWith('GENERIC_HTTP_PATH_INVALID', () => plan({ path: [{ kind: 'source', source: 'resource', required: false }] }));
    refusedWith('GENERIC_HTTP_MAPPING_INVALID', () => plan({ body: { kind: 'json-object', fields: {}, merge: true } }));
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'bearer', token: TOKEN, refresh: 'x' } }));
  });

  it('refuses a malformed adapter id, method and timeout', () => {
    for (const adapterId of ['', ' ', 'has space', 'a@b', 'x'.repeat(65), 7]) refusedWith('GENERIC_HTTP_ADAPTER_ID_INVALID', () => plan({ adapterId }));
    for (const method of ['GET', 'post', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', undefined]) refusedWith('GENERIC_HTTP_METHOD_INVALID', () => plan({ method }));
    for (const timeoutMs of [0, 99, 60_001, 1.5, Number.POSITIVE_INFINITY, -1, '1000']) refusedWith('GENERIC_HTTP_LIMIT_INVALID', () => plan({ timeoutMs }));
    assert.equal(plan().timeoutMs, GENERIC_HTTP_LIMITS.defaultTimeoutMs);
    assert.equal(plan({ timeoutMs: 100 }).timeoutMs, 100);
    assert.equal(plan({ timeoutMs: 60_000 }).timeoutMs, 60_000);
  });

  it('enforces the field-count limits at composition', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, { kind: 'literal', value: 'x' }]));
    refusedWith('GENERIC_HTTP_LIMIT_INVALID', () => plan({ query: many(GENERIC_HTTP_LIMITS.maxQueryFields + 1) }));
    refusedWith('GENERIC_HTTP_LIMIT_INVALID', () => plan({ headers: Object.fromEntries(Array.from({ length: GENERIC_HTTP_LIMITS.maxHeaders + 1 }, (_, index) => [`x-h${index}`, { kind: 'literal', value: 'x' }])) }));
    refusedWith('GENERIC_HTTP_LIMIT_INVALID', () => plan({ body: { kind: 'json-object', fields: many(GENERIC_HTTP_LIMITS.maxBodyFields + 1) } }));
    refusedWith('GENERIC_HTTP_LIMIT_INVALID', () => plan({ path: Array.from({ length: GENERIC_HTTP_LIMITS.maxPathSegments + 1 }, () => ({ kind: 'literal', value: 'a' })) }));
  });

  it('a getter or Proxy trap that throws during composition is a composition failure, and its message is not echoed', () => {
    const hostile = withOptions({});
    Object.defineProperty(hostile, 'origin', { enumerable: true, get: () => { throw new Error(`boom ${TOKEN}`); } });
    refusedWith('GENERIC_HTTP_OPTIONS_INVALID', () => snapshotGenericHttpOptions(hostile));
    const trap = new Proxy(withOptions({}), { ownKeys: () => { throw new Error(TOKEN); } });
    refusedWith('GENERIC_HTTP_OPTIONS_INVALID', () => snapshotGenericHttpOptions(trap));
  });
});

describe('Generic HTTP — immutable snapshot (§38 rows 32–35)', () => {
  it('32–35. mutating every original option object after composition changes nothing the adapter sends', async () => {
    const options = baseOptions() as unknown as {
      adapterId: string;
      origin: string;
      path: { kind: string; value?: string; source?: string }[];
      headers: Record<string, unknown>;
      body: { fields: Record<string, unknown> };
      credential: { kind: string; token: string };
      providerRefHeader: string;
      timeoutMs?: number;
      method: string;
    };
    const runtime = fakeRuntime();
    const adapter = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(options), runtime);

    options.adapterId = 'attacker.adapter';
    options.origin = 'https://evil.example';
    options.method = 'DELETE';
    options.path.push({ kind: 'literal', value: 'admin' });
    options.path[0] = { kind: 'literal', value: 'v9' };
    options.headers['X-Injected'] = { kind: 'literal', value: 'yes' };
    options.body.fields['boundedGrantId'] = { kind: 'literal', value: 'leak' };
    options.credential.token = 'attacker-token';
    options.providerRefHeader = 'location';
    options.timeoutMs = 60_000;

    assert.equal(adapter.adapterId, 'erp.invoice-payment');
    const result = await adapter.execute(ACTION);
    assert.equal(result.outcome, 'completed');
    const sent = runtime.sent[0]?.request;
    assert.ok(sent !== undefined);
    assert.equal(sent.hostname, 'api.erp.example');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/v1/payments');
    assert.equal(header(sent, 'x-injected'), undefined);
    assert.equal(header(sent, 'authorization'), `Bearer ${TOKEN}`);
    assert.equal(JSON.parse(sent.body ?? '{}').boundedGrantId, undefined);
    assert.ok((runtime.sent[0]?.timeoutMs ?? 0) <= GENERIC_HTTP_LIMITS.defaultTimeoutMs);
  });

  it('the adapter object exposes its id and execute only — no plan, no credential, no origin', () => {
    const adapter = createGenericHttpExecutionAdapterCore(plan(), fakeRuntime());
    assert.deepEqual(Object.keys(adapter).sort(), ['adapterId', 'execute']);
    assert.ok(Object.isFrozen(adapter));
    assert.equal(JSON.stringify(adapter).includes(TOKEN), false);
  });

  it('the production factory snapshots too', () => {
    const options = baseOptions() as unknown as { adapterId: string };
    const adapter = createGenericHttpExecutionAdapter(options as unknown as EnterpriseGenericHttpExecutionAdapterOptions);
    options.adapterId = 'renamed';
    assert.equal(adapter.adapterId, 'erp.invoice-payment');
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('Generic HTTP — request mapping (§38 rows 1–31)', () => {
  it('the §26 example translation: pinned constants plus proven action values, and nothing else', () => {
    const request = mapped();
    assert.equal(request.method, 'POST');
    assert.equal(request.hostname, 'api.erp.example');
    assert.equal(request.port, 443);
    assert.equal(request.path, '/v1/payments');
    assert.equal(header(request, 'idempotency-key'), 'exec-1');
    assert.equal(header(request, 'authorization'), `Bearer ${TOKEN}`);
    assert.equal(header(request, 'content-type'), 'application/json');
    assert.equal(header(request, 'content-length'), String(Buffer.byteLength(request.body ?? '', 'utf8')));
    assert.deepEqual(JSON.parse(request.body ?? ''), { invoiceId: 'INV-1001', vendorId: 'V123', amount: 7500, currency: 'USD', organization: 'org-datasys' });
  });

  it('1–2. the action cannot change the method or the origin: they are not action values', () => {
    const hostile = { ...ACTION, action: 'DELETE', resource: 'https://evil.example:444/', subject: 'evil.example' } as ValidatedExecutionAction;
    const request = mapped({ path: [{ kind: 'source', source: 'resource' }] }, hostile);
    assert.equal(request.method, 'POST');
    assert.equal(request.hostname, 'api.erp.example');
    assert.equal(request.port, 443);
  });

  it('3–7. a resource carrying a URL, "/", "..", "?" or "#" stays data inside ONE encoded segment', () => {
    const path = [{ kind: 'literal', value: 'v1' }, { kind: 'source', source: 'resource' }, { kind: 'literal', value: 'pay' }];
    const cases: readonly [string, string][] = [
      ['https://evil.example/a/../admin?x=1', '/v1/https%3A%2F%2Fevil.example%2Fa%2F..%2Fadmin%3Fx%3D1/pay'],
      ['a/b', '/v1/a%2Fb/pay'],
      ['../../admin', '/v1/..%2F..%2Fadmin/pay'],
      ['x?admin=true', '/v1/x%3Fadmin%3Dtrue/pay'],
      ['x#frag', '/v1/x%23frag/pay'],
      ['%2e%2e', '/v1/%252e%252e/pay'],
      ['a\\b', '/v1/a%5Cb/pay'],
    ];
    for (const [resource, expected] of cases) {
      const request = mapped({ path }, { ...ACTION, resource });
      assert.equal(request.path, expected, `resource ${resource}`);
      assert.equal(request.path.split('/').length, 4, 'exactly three segments, whatever the value');
      assert.equal(request.path.includes('?'), false);
      assert.equal(request.path.includes('#'), false);
    }
  });

  it('5. a whole-segment "." or ".." from the action, or a control character, makes the request unbuildable', () => {
    const plan1 = plan({ path: [{ kind: 'literal', value: 'v1' }, { kind: 'source', source: 'resource' }] });
    for (const resource of ['..', '.', '', 'a\r\nb', 'a\u0000b']) {
      assert.equal(mapGenericHttpRequest(plan1, { ...ACTION, resource }).ok, false, JSON.stringify(resource));
    }
  });

  it('literal path segments are single segments: ".", "..", "/", "\\" and control characters are refused at composition', () => {
    for (const value of ['.', '..', 'a/b', 'a\\b', 'a\nb', '']) {
      refusedWith('GENERIC_HTTP_PATH_INVALID', () => plan({ path: [{ kind: 'literal', value }] }));
    }
  });

  it('8–9. query keys and values are encoded; the action cannot add a pair', () => {
    const request = mapped({ query: { 'invoice id': { kind: 'source', source: 'resource' }, mode: { kind: 'literal', value: 'final' } } }, { ...ACTION, resource: 'a&admin=1=x' });
    assert.equal(request.path, '/v1/payments?invoice%20id=a%26admin%3D1%3Dx&mode=final');
  });

  it('10. header values reject CR/LF — at composition for literals, before the network for action values', () => {
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { 'X-A': { kind: 'literal', value: 'a\r\nInjected: 1' } } }));
    const withResource = plan({ headers: { 'X-Resource': { kind: 'source', source: 'resource' } } });
    assert.equal(mapGenericHttpRequest(withResource, { ...ACTION, resource: 'a\r\nHost: evil.example' }).ok, false);
    assert.equal(mapGenericHttpRequest(withResource, { ...ACTION, resource: 'café' }).ok, false, 'non-ASCII never reaches a header');
  });

  it('11. header names must be HTTP tokens', () => {
    for (const name of ['Bad Name', 'x:y', 'x\ny', '', 'ü']) refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { [name]: { kind: 'literal', value: 'x' } } }));
  });

  it('12–17. Host, Content-Length, Transfer-Encoding, Connection, Expect, Authorization and friends cannot be configured, in any case', () => {
    for (const name of ['Host', 'HOST', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Expect', 'Authorization', 'authorization', 'Cookie', 'Proxy-Authorization', 'Proxy-Connection', 'Proxy-Anything', 'TE', 'Trailer', 'Upgrade', 'Keep-Alive', 'Content-Type']) {
      refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { [name]: { kind: 'literal', value: 'x' } } }));
    }
  });

  it('duplicate header names after canonicalization are refused', () => {
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { 'X-Trace': { kind: 'literal', value: 'a' }, 'x-trace': { kind: 'literal', value: 'b' } } }));
  });

  it('18. a bearer credential injects Authorization and nowhere else', () => {
    const request = mapped();
    assert.equal(header(request, 'authorization'), `Bearer ${TOKEN}`);
    assert.equal(request.path.includes(TOKEN), false);
    assert.equal((request.body ?? '').includes(TOKEN), false);
  });

  it('19. a header credential injects exactly its one header', () => {
    const request = mapped({ credential: { kind: 'header', name: 'X-API-Key', value: API_KEY } });
    assert.equal(header(request, 'x-api-key'), API_KEY);
    assert.equal(header(request, 'authorization'), undefined);
    assert.equal(request.headers.filter(([, value]) => value === API_KEY).length, 1);
  });

  it('20. a credential colliding with a mapped header, or naming a reserved header, is refused', () => {
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ headers: { 'X-API-Key': { kind: 'literal', value: 'x' } }, credential: { kind: 'header', name: 'x-api-key', value: API_KEY } }));
    for (const name of ['Authorization', 'Cookie', 'Host', 'Proxy-Authorization', 'Content-Length']) {
      refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'header', name, value: API_KEY } }));
    }
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'bearer', token: 'has space' } }));
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'header', name: 'X-Key', value: 'a\r\nb' } }));
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'oauth', token: TOKEN } }));
  });

  it('21–22. amount.value stays a JSON number — spelled exactly as its canonical text, never through a double (P9) — and amount.unit an exact string; literals keep their JSON type', () => {
    const request = mapped({ body: { kind: 'json-object', fields: { v: { kind: 'source', source: 'amount.value' }, u: { kind: 'source', source: 'amount.unit' }, t: { kind: 'literal', value: true }, n: { kind: 'literal', value: null }, s: { kind: 'literal', value: '7500' } } } }, { ...ACTION, amount: { value: '7500.25', unit: 'usd ' } });
    assert.deepEqual(JSON.parse(request.body ?? ''), { v: 7500.25, u: 'usd ', t: true, n: null, s: '7500' });
    assert.ok(
      request.body?.includes('"v":7500.25'),
      `expected exact monetary JSON number in request body; got ${request.body ?? '<undefined>'}`,
    );
  });

  it('numbers become deterministic decimal text in path, query and header positions; booleans become true/false', () => {
    const request = mapped({
      path: [{ kind: 'source', source: 'amount.value' }],
      query: { flag: { kind: 'literal', value: false }, n: { kind: 'literal', value: 12 } },
      headers: { 'X-Amount': { kind: 'source', source: 'amount.value' } },
    }, { ...ACTION, amount: { value: '0.5', unit: 'USD' } });
    assert.equal(request.path, '/0.5?flag=false&n=12');
    assert.equal(header(request, 'x-amount'), '0.5');
  });

  it('a null literal in a path, query or header position is a configuration error', () => {
    refusedWith('GENERIC_HTTP_MAPPING_INVALID', () => plan({ query: { q: { kind: 'literal', value: null } } }));
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ headers: { 'X-Q': { kind: 'literal', value: null } } }));
    refusedWith('GENERIC_HTTP_PATH_INVALID', () => plan({ path: [{ kind: 'literal', value: null }] }));
  });

  it('23 and 25. a missing required counterparty or amount stops before the network', async () => {
    for (const missing of ['counterparty', 'amount'] as const) {
      const { [missing]: _removed, ...rest } = ACTION;
      const runtime = fakeRuntime();
      const result = await executeWith(runtime, {}, rest as ValidatedExecutionAction);
      assert.equal(result.outcome, 'failed');
      assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
      assert.equal(runtime.resolved.length, 0, 'no DNS for an unbuildable request');
      assert.equal(runtime.sent.length, 0, 'no request for an unbuildable request');
    }
  });

  it('24. an optional missing counterparty omits the field', () => {
    const { counterparty: _removed, ...rest } = ACTION;
    const request = mapped({ body: { kind: 'json-object', fields: { vendorId: { kind: 'source', source: 'counterparty', required: false }, invoiceId: { kind: 'source', source: 'resource' } } } }, rest as ValidatedExecutionAction);
    assert.deepEqual(JSON.parse(request.body ?? ''), { invoiceId: 'INV-1001' });
  });

  it('26–28. boundedGrantId, assertedContext, providerPayload and friends are not mapping sources', () => {
    for (const source of ['boundedGrantId', 'assertedContext', 'providerPayload', 'payload', 'grant', 'constructor', '__proto__', 'toString', 'correlation', 'amount', 'process.env.SECRET', 'credential']) {
      refusedWith('GENERIC_HTTP_MAPPING_INVALID', () => plan({ body: { kind: 'json-object', fields: { x: { kind: 'source', source } } } }));
      refusedWith('GENERIC_HTTP_PATH_INVALID', () => plan({ path: [{ kind: 'source', source }] }));
    }
  });

  it('boundedGrantId never reaches the provider under the default example either', () => {
    const request = mapped();
    const everything = JSON.stringify(request);
    assert.equal(everything.includes(ACTION.boundedGrantId), false);
  });

  it('29–31. __proto__, constructor and prototype are refused as destination keys, even from trusted configuration', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const fields = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(fields, key, { enumerable: true, value: { kind: 'literal', value: 'x' } });
      refusedWith('GENERIC_HTTP_MAPPING_INVALID', () => plan({ body: { kind: 'json-object', fields } }));
      const query = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(query, key, { enumerable: true, value: { kind: 'literal', value: 'x' } });
      refusedWith('GENERIC_HTTP_MAPPING_INVALID', () => plan({ query }));
    }
  });

  it('request bounds are enforced before the network: URL length and body size', async () => {
    const long = 'x'.repeat(GENERIC_HTTP_LIMITS.maxUrlLength);
    const runtime = fakeRuntime();
    const result = await executeWith(runtime, { path: [{ kind: 'source', source: 'resource' }] }, { ...ACTION, resource: long });
    assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(runtime.sent.length, 0);
    const fields = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, { kind: 'literal', value: 'y'.repeat(4000) }]));
    assert.equal(mapGenericHttpRequest(plan({ body: { kind: 'json-object', fields } }), ACTION).ok, false, 'a body over 64 KiB is never sent');
  });

  it('the request object is fresh and frozen', () => {
    const request = mapped();
    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(request.headers));
    assert.notEqual(mapped(), request);
  });
});

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

describe('Generic HTTP — public-address policy (§39 rows 13–25, §12)', () => {
  it('public unicast addresses pass', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1']) assert.equal(isPublicIpv4(address), true, address);
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1']) assert.equal(isPublicIpv6(address), true, address);
  });

  it('every forbidden IPv4 range is refused, including cloud metadata', () => {
    for (const address of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isPublicIpv4(address), false, address);
    }
  });

  it('every forbidden IPv6 class is refused, including mapped, compatible, NAT64, 6to4 and Teredo', () => {
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'fec0::1',
      'ff02::1',
      'ff05::2',
      '2001:db8::1',
      '2001:db8:ffff::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:93.184.216.34',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b:1::1',
      '100::1',
      '2002:a00:1::1',
      '2001::1',
      '2001:0:4136:e378::1',
      '3fff::1',
      'fe80::1%eth0',
    ]) {
      assert.equal(isPublicIpv6(address), false, address);
    }
  });

  it('unparseable and ambiguous spellings fail closed', () => {
    for (const address of ['', 'localhost', '127.1', '0x7f000001', '2130706433', '010.0.0.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'not-an-ip', ' 8.8.8.8']) assert.equal(isPublicIpv4(address), false, address);
    for (const address of ['', '1::2::3', 'gggg::1', '8.8.8.8']) assert.equal(isPublicIpv6(address), false, address);
    assert.equal(selectApprovedAddress([{ address: '8.8.8.8', family: 6 }]).kind, 'forbidden', 'the declared family must match the syntax');
  });

  it('26. one public and one private answer rejects the whole lookup', () => {
    assert.equal(selectApprovedAddress([PUBLIC_V4, { address: '10.0.0.5', family: 4 }]).kind, 'forbidden');
    assert.equal(selectApprovedAddress([{ address: '169.254.169.254', family: 4 }, PUBLIC_V4]).kind, 'forbidden');
  });

  it('27. no answers is no-answer; 29. all-public answers approve exactly the first', () => {
    assert.equal(selectApprovedAddress([]).kind, 'no-answer');
    const selection = selectApprovedAddress([PUBLIC_V6, PUBLIC_V4]);
    assert.equal(selection.kind, 'approved');
    assert.deepEqual(selection.kind === 'approved' ? { ...selection.address } : undefined, { ...PUBLIC_V6 });
  });
});

// ---------------------------------------------------------------------------
// Execution semantics over a fake runtime
// ---------------------------------------------------------------------------

describe('Generic HTTP — DNS is re-resolved and bound on every execution (§39 rows 13–34)', () => {
  it('13–25. a hostname resolving to any forbidden address is refused as ADAPTER_ERROR, and nothing is sent', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '100.64.1.1', '169.254.1.1', '172.16.5.5', '192.168.0.10', '169.254.169.254', '224.0.0.251', '192.0.2.10', '198.51.100.1', '203.0.113.1']) {
      const runtime = fakeRuntime({ answers: [{ kind: 'resolved', answers: [{ address, family: 4 }] }] });
      const result = await executeWith(runtime);
      assert.equal(result.outcome, 'failed', address);
      assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, address);
      assert.equal(runtime.sent.length, 0, `${address} must never be dialled`);
    }
    for (const address of ['::1', 'fc00::5', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '2001:db8::5']) {
      const runtime = fakeRuntime({ answers: [{ kind: 'resolved', answers: [{ address, family: 6 }] }] });
      const result = await executeWith(runtime);
      assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, address);
      assert.equal(runtime.sent.length, 0);
    }
  });

  it('26. a mixed public + private answer sends nothing', async () => {
    const runtime = fakeRuntime({ answers: [{ kind: 'resolved', answers: [PUBLIC_V4, { address: '127.0.0.1', family: 4 }] }] });
    const result = await executeWith(runtime);
    assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(runtime.sent.length, 0);
  });

  it('27–28. no answers, a DNS error, or a resolver that throws: PROVIDER_UNAVAILABLE and no request', async () => {
    const empty = fakeRuntime({ answers: [{ kind: 'resolved', answers: [] }] });
    const failed = fakeRuntime({ answers: [{ kind: 'failed' }] });
    const throwing = fakeRuntime({ answers: [() => { throw new Error(`resolver ${TOKEN}`); }] });
    for (const runtime of [empty, failed, throwing]) {
      const result = await executeWith(runtime);
      assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE);
      assert.equal(runtime.resolved.length, 1, 'resolved once — a DNS failure is not retried');
      assert.equal(runtime.sent.length, 0);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    }
  });

  it('29–30. the approved address is what the transport is handed, for the pinned hostname', async () => {
    const runtime = fakeRuntime({ answers: [{ kind: 'resolved', answers: [PUBLIC_V4, { address: '1.1.1.1', family: 4 }] }] });
    await executeWith(runtime);
    assert.deepEqual(runtime.resolved, ['api.erp.example']);
    assert.equal(runtime.sent.length, 1);
    assert.deepEqual({ ...runtime.sent[0]?.address }, { ...PUBLIC_V4 });
    assert.equal(runtime.sent[0]?.request.hostname, 'api.erp.example');
  });

  it('32–33. DNS is resolved again on the next execution, and a rebind to a private address is refused', async () => {
    const runtime = fakeRuntime({
      answers: [
        { kind: 'resolved', answers: [PUBLIC_V4] },
        { kind: 'resolved', answers: [{ address: '169.254.169.254', family: 4 }] },
      ],
    });
    const adapter = createGenericHttpExecutionAdapterCore(plan(), runtime);
    const first = await adapter.execute(ACTION);
    const second = await adapter.execute({ ...ACTION, correlation: { ...ACTION.correlation, executionId: 'exec-2' } });
    assert.equal(first.outcome, 'completed');
    assert.equal(second.outcome === 'failed' ? second.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(runtime.resolved.length, 2, 'no DNS answer is cached across governed executions');
    assert.equal(runtime.sent.length, 1, 'the rebound execution never reached the transport');
  });
});

describe('Generic HTTP — one attempt, no redirect, no retry (§40)', () => {
  it('1. one execute() makes at most one request, on success', async () => {
    const runtime = fakeRuntime();
    await executeWith(runtime);
    assert.equal(runtime.sent.length, 1);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`${status} is unconfirmed — its effect is uncertain — and is never followed`, async () => {
      const runtime = fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: ['https://evil.example/next'] }) });
      const result = await executeWith(runtime);
      assert.equal(result.outcome, 'unconfirmed', 'a redirect is never a definite failure: a 303 may answer an action that already ran');
      assert.equal('reason' in result, false);
      assert.equal(runtime.sent.length, 1, 'no second request');
      assert.equal(runtime.resolved.length, 1, 'no second resolution');
      assert.equal(JSON.stringify(result).includes('evil.example'), false, 'the redirect target is not carried anywhere');
    });
  }

  for (const status of [429, 500, 502, 503, 504]) {
    it(`${status} is never retried`, async () => {
      const runtime = fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: [] }) });
      await executeWith(runtime);
      assert.equal(runtime.sent.length, 1);
      assert.equal(runtime.resolved.length, 1);
    });
  }

  for (const kind of ['unconfirmed', 'not-sent'] as const) {
    it(`a transport outcome of ${kind} (timeout, reset, TLS error) is never retried`, async () => {
      const runtime = fakeRuntime({ observe: () => ({ kind }) });
      await executeWith(runtime);
      assert.equal(runtime.sent.length, 1);
    });
  }

  it('a runtime that throws after being handed the request is unconfirmed — it may have sent — and is not retried', async () => {
    const runtime = fakeRuntime({ sendThrows: true });
    const result = await executeWith(runtime);
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal(runtime.sent.length, 1);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });

  it('16. providerRef is evidence: it is never dereferenced — and since P11 a URL-shaped value is not carried at all', async () => {
    const runtime = fakeRuntime({ observe: () => ({ kind: 'response', status: 200, providerRefValues: ['https://evil.example/follow-me'] }) });
    const result = await executeWith(runtime);
    assert.equal(result.outcome, 'completed', 'the reference never moves the outcome');
    assert.equal('providerRef' in result, false, 'a destination is never a durable reference');
    assert.equal(runtime.sent.length, 1);
    assert.equal(runtime.resolved.length, 1);
    const plain = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status: 200, providerRefValues: ['pay_123'] }) }));
    assert.equal(plain.outcome === 'completed' ? plain.providerRef : undefined, 'pay_123');
  });

  it('the core source contains exactly one send and one resolve, and no loop around them', () => {
    const core = codeOf(`${MODULE_DIR}/generic-http-execution-adapter.ts`);
    assert.equal([...core.matchAll(/runtime\.send\s*\(/g)].length, 1);
    assert.equal([...core.matchAll(/runtime\.resolve\s*\(/g)].length, 1);
    for (const loop of [/\bwhile\s*\(/, /\bfor\s*\(/, /\bretry/i, /\battempts?\b/i]) assert.equal(loop.test(core), false, `the adapter core must not contain ${String(loop)}`);
    const transport = codeOf(`${MODULE_DIR}/node-https-transport.ts`);
    assert.equal([...transport.matchAll(/\bprimitive\s*\(/g)].length, 1, 'the request primitive is invoked from exactly one place');
    for (const forbidden of [/\bretry/i, /location/i, /\bredirect/i, /maxRedirects/, /rejectUnauthorized\s*:\s*false/, /NODE_TLS_REJECT_UNAUTHORIZED/, /\bca\s*:/, /checkServerIdentity/, /process\.env/, /\bproxy\b/i, /keepAlive/]) {
      assert.equal(forbidden.test(transport), false, `the transport must not contain ${String(forbidden)}`);
    }
  });
});

describe('Generic HTTP — confirmed / failed / unconfirmed (§41)', () => {
  const cases: readonly [number, 'completed' | 'unconfirmed' | ExecutionAdapterResult['outcome'], string | undefined][] = [
    // The Stage-A definitive success statuses, and only these.
    [200, 'completed', undefined],
    [201, 'completed', undefined],
    [204, 'completed', undefined],
    // Every other 2xx: 202 Accepted means processing has not finished.
    [202, 'unconfirmed', undefined],
    [203, 'unconfirmed', undefined],
    [205, 'unconfirmed', undefined],
    [206, 'unconfirmed', undefined],
    [207, 'unconfirmed', undefined],
    [208, 'unconfirmed', undefined],
    [226, 'unconfirmed', undefined],
    [299, 'unconfirmed', undefined],
    // Every 3xx: never followed, effect uncertain.
    [300, 'unconfirmed', undefined],
    [301, 'unconfirmed', undefined],
    [302, 'unconfirmed', undefined],
    [303, 'unconfirmed', undefined],
    [304, 'unconfirmed', undefined],
    [307, 'unconfirmed', undefined],
    [308, 'unconfirmed', undefined],
    [399, 'unconfirmed', undefined],
    [400, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [401, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [403, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [404, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [409, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [422, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [429, 'failed', EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED],
    [408, 'unconfirmed', undefined],
    [500, 'unconfirmed', undefined],
    [502, 'unconfirmed', undefined],
    [503, 'unconfirmed', undefined],
    [504, 'unconfirmed', undefined],
    [599, 'unconfirmed', undefined],
    [600, 'unconfirmed', undefined],
    [199, 'unconfirmed', undefined],
  ];
  for (const [status, outcome, reason] of cases) {
    it(`final ${status} → ${outcome}${reason !== undefined ? ` / ${reason}` : ''}`, async () => {
      const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: [] }) }));
      assert.equal(result.outcome, outcome);
      assert.equal(result.outcome === 'failed' ? result.reason : undefined, reason);
      assert.deepEqual({ ...classifyGenericHttpStatus(status) }.outcome, outcome);
    });
  }

  it('before the secure connection: not-sent is PROVIDER_UNAVAILABLE (DNS, TCP refused, TLS/certificate failure)', async () => {
    const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'not-sent' }) }));
    assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE);
  });

  it('after the secure connection, with no final status: unconfirmed — never a failure', async () => {
    const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'unconfirmed' }) }));
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal('reason' in result, false);
  });

  it('a socket that dialled an unapproved address is ADAPTER_ERROR', async () => {
    const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'destination-mismatch' }) }));
    assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
  });

  it('providerRef: exactly one bounded printable value, or omitted — duplicates are never joined', async () => {
    const ref = async (values: readonly string[]) => {
      const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status: 200, providerRefValues: values }) }));
      assert.equal(result.outcome, 'completed');
      return result.outcome === 'completed' ? result.providerRef : 'not completed';
    };
    assert.equal(await ref(['prov-1']), 'prov-1');
    assert.equal(await ref([]), undefined);
    assert.equal(await ref(['a', 'b']), undefined);
    assert.equal(await ref(['x'.repeat(GENERIC_HTTP_LIMITS.maxProviderRefLength + 1)]), undefined);
    assert.equal(await ref(['x'.repeat(GENERIC_HTTP_LIMITS.maxProviderRefLength)]), 'x'.repeat(512));
    assert.equal(await ref(['bad\u0001value']), undefined);
    assert.equal(await ref([' padded ']), undefined);
    const withoutHeader = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status: 200, providerRefValues: [] }) }), { providerRefHeader: undefined });
    assert.deepEqual({ ...withoutHeader }, { outcome: 'completed' });
  });

  it('P11 — a provider that answered keeps its reference on every status, and no status depends on anything but the status', async () => {
    for (const [status, outcome] of [
      [200, 'completed'],
      [201, 'completed'],
      [202, 'unconfirmed'],
      [303, 'unconfirmed'],
      [400, 'failed'],
      [408, 'unconfirmed'],
      [409, 'failed'],
      [500, 'unconfirmed'],
      [503, 'unconfirmed'],
    ] as const) {
      const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: [`request-${String(status)}`] }) }));
      assert.equal(result.outcome, outcome, `${String(status)} is classified by its status alone`);
      assert.equal('providerRef' in result ? result.providerRef : undefined, `request-${String(status)}`, `${String(status)} keeps the provider's handle`);
      if (status === 500) assert.equal('reason' in result, false, 'a 5xx is never PROVIDER_UNAVAILABLE: the provider may have committed first');
      if (status === 400) assert.equal(result.outcome === 'failed' ? result.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED);
    }
  });

  it('P11 §145 — 202 Accepted with a job id is unconfirmed with that id, never completed', async () => {
    const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status: 202, providerRefValues: ['job-123'] }) }));
    assert.deepEqual({ ...result }, { outcome: 'unconfirmed', detail: result.outcome === 'unconfirmed' ? result.detail : undefined, providerRef: 'job-123' });
  });

  it('P11 §147 / §148 — no response means no reference: nothing sent, or nothing heard back', async () => {
    const notSent = await executeWith(fakeRuntime({ observe: () => ({ kind: 'not-sent' }) }));
    assert.equal(notSent.outcome === 'failed' ? notSent.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE);
    assert.equal('providerRef' in notSent, false);
    const reset = await executeWith(fakeRuntime({ observe: () => ({ kind: 'unconfirmed' }) }));
    assert.equal(reset.outcome, 'unconfirmed', 'a socket reset after send stays unconfirmed');
    assert.equal('providerRef' in reset, false);
    const thrown = await executeWith(fakeRuntime({ sendThrows: true }));
    assert.equal(thrown.outcome, 'unconfirmed');
    assert.equal('providerRef' in thrown, false);
  });

  it('P11 — a reference shaped like a credential, cookie, JWT or URL is never carried, on any status', async () => {
    for (const status of [200, 202, 400, 500]) {
      for (const value of ['Bearer abcdefgh', 'Basic dXNlcjpwYXNzd29yZA==', 'eyJhbGciOi.eyJzdWIiOi', 'session=1; cookie=abc', 'https://x.example/', 'authorization: y']) {
        const result = await executeWith(fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: [value] }) }));
        assert.equal('providerRef' in result, false, `${String(status)} ${value}`);
      }
    }
  });

  it('12. providerRefHeader may not be Location, Set-Cookie, Content-Location or Refresh', () => {
    for (const name of ['Location', 'set-cookie', 'Content-Location', 'Refresh']) refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ providerRefHeader: name }));
  });
});

describe('Generic HTTP — providerRef is untrusted: a reflected credential is never copied outward (SEC-INV-067)', () => {
  const BEARER = 'abc.def.ghi';
  const KEY = 'secret-123';
  const bearer = { credential: { kind: 'bearer', token: BEARER } };
  const apiKey = { credential: { kind: 'header', name: 'X-API-Key', value: KEY } };

  async function reflecting(overrides: Record<string, unknown>, providerRef: string, status = 200): Promise<{ result: ExecutionAdapterResult; runtime: FakeRuntime }> {
    const runtime = fakeRuntime({ observe: () => ({ kind: 'response', status, providerRefValues: [providerRef] }) });
    return { result: await executeWith(runtime, overrides), runtime };
  }

  function assertOmitted(result: ExecutionAdapterResult, runtime: FakeRuntime, secrets: readonly string[]): void {
    assert.equal(result.outcome, 'completed', 'omitting the reference never turns a completion into a failure or an unconfirmed outcome');
    assert.deepEqual({ ...result }, { outcome: 'completed' }, 'providerRef is absent, not redacted');
    assert.equal(runtime.sent.length, 1, 'the provider was invoked exactly once');
    const serialized = JSON.stringify(result);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  }

  it('1. an ordinary safe providerRef still returns', async () => {
    for (const overrides of [bearer, apiKey, { credential: undefined }]) {
      const { result } = await reflecting(overrides, 'req-7f3a-0001');
      assert.deepEqual({ ...result }, { outcome: 'completed', providerRef: 'req-7f3a-0001' });
    }
  });

  it('2–4. a bearer token reflected exactly, embedded, or as the full "Bearer <token>" value is omitted', async () => {
    for (const reflected of [BEARER, `ref-${BEARER}`, `${BEARER}-suffix`, `prefix-${BEARER}-suffix`, `Bearer ${BEARER}`, `echo: Bearer ${BEARER}!`]) {
      for (const status of [200, 201, 204]) {
        const { result, runtime } = await reflecting(bearer, reflected, status);
        assertOmitted(result, runtime, [BEARER]);
      }
    }
  });

  it('5–6. a header credential reflected exactly or embedded is omitted', async () => {
    for (const reflected of [KEY, `prefix-${KEY}`, `${KEY}-suffix`, `prefix-${KEY}-suffix`]) {
      const { result, runtime } = await reflecting(apiKey, reflected);
      assertOmitted(result, runtime, [KEY]);
    }
  });

  it('matching is exact and case-sensitive: a different-case or partial value is not the secret', async () => {
    const upper = (await reflecting(apiKey, 'SECRET-123')).result;
    assert.equal(upper.outcome === 'completed' ? upper.providerRef : undefined, 'SECRET-123');
    const partial = (await reflecting(apiKey, 'secret-12')).result;
    assert.equal(partial.outcome === 'completed' ? partial.providerRef : undefined, 'secret-12');
  });

  it('OWS: a header credential containing a space or tab anywhere is refused at composition — never trimmed', () => {
    for (const value of [' secret-123', 'secret-123 ', ' secret-123 ', '\tsecret-123', 'secret-123\t', 'secret 123', 'secret\t123']) {
      refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'header', name: 'X-API-Key', value } }));
      assert.throws(
        () => createGenericHttpExecutionAdapter(withOptions({ credential: { kind: 'header', name: 'X-API-Key', value } })),
        (error: unknown) => error instanceof GenericHttpConfigurationError && error.code === 'GENERIC_HTTP_CREDENTIAL_INVALID' && !error.message.includes('secret'),
        `${JSON.stringify(value)} must not reach an adapter`,
      );
    }
  });

  it('OWS: canonical opaque header credentials are still accepted, and injected exactly as configured', () => {
    for (const value of ['secret-123', 'abc.DEF_456', 'key+value/123=', 'p6.api_key:prod']) {
      const request = mapped({ credential: { kind: 'header', name: 'X-API-Key', value } });
      assert.equal(header(request, 'x-api-key'), value);
    }
  });

  it('OWS, why it is load-bearing: HTTP strips surrounding whitespace, so " secret-123 " would reach the provider as "secret-123" — a value the reflection filter would not have been guarding', async () => {
    // The effective value a recipient sees after RFC 9110 OWS stripping.
    const configured = ' secret-123 ';
    const effective = configured.trim();
    assert.notEqual(configured, effective);
    assert.equal(effective.includes(configured), false, 'a filter keyed on the configured spelling cannot see the effective one');
    // So the configured spelling is refused before any adapter exists …
    refusedWith('GENERIC_HTTP_CREDENTIAL_INVALID', () => plan({ credential: { kind: 'header', name: 'X-API-Key', value: configured } }));
    // … and the canonical spelling, which *is* the effective value, is filtered when reflected.
    const { result, runtime } = await reflecting({ credential: { kind: 'header', name: 'X-API-Key', value: effective } }, effective);
    assertOmitted(result, runtime, [effective]);
  });

  it('7. a providerRefHeader naming the credential header is refused at composition, in any case', () => {
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ ...apiKey, providerRefHeader: 'x-api-key' }));
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ ...apiKey, providerRefHeader: 'X-API-KEY' }));
  });

  it('8–11. Authorization, WWW-Authenticate, Proxy-Authenticate and Cookie are refused as providerRefHeader', () => {
    refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ ...bearer, providerRefHeader: 'Authorization' }));
    for (const name of ['Authorization', 'WWW-Authenticate', 'Proxy-Authenticate', 'Proxy-Authorization', 'Cookie', 'Set-Cookie']) {
      refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ providerRefHeader: name }));
      refusedWith('GENERIC_HTTP_HEADER_INVALID', () => plan({ credential: undefined, providerRefHeader: name }));
    }
  });

  it('the refusal message never echoes a credential', () => {
    assert.throws(
      () => plan({ credential: { kind: 'header', name: 'X-Secret-Header', value: KEY }, providerRefHeader: 'x-secret-header' }),
      (error: unknown) => error instanceof GenericHttpConfigurationError && !error.message.includes(KEY),
    );
  });

  it('the secret list is internal: it is not on the adapter object and not in the public option contract', () => {
    const adapter = createGenericHttpExecutionAdapterCore(plan(apiKey), fakeRuntime());
    assert.equal(JSON.stringify(adapter).includes(KEY), false);
    assert.equal(/credentialSecrets/.test(codeOf(`${MODULE_DIR}/contracts.ts`)), false);
    assert.equal(/credentialSecrets/.test(codeOf('src/enterprise/index.ts')), false);
    assert.equal(/credentialSecrets/.test(codeOf(`${MODULE_DIR}/index.ts`)), false);
  });

  it('every detail is one of the fixed phrases, and no result anywhere carries the credential', async () => {
    const phrases = new Set([
      'Generic HTTP request could not be constructed from the validated action.',
      'Generic HTTP destination could not be resolved.',
      'Generic HTTP destination is not publicly routable.',
      'Generic HTTP request could not connect before transmission.',
      'Generic HTTP outcome could not be confirmed.',
      'Generic HTTP provider returned a response that does not confirm the effect.',
      'Generic HTTP provider rejected the request.',
    ]);
    const observations: GenericHttpTransportObservation[] = [
      { kind: 'not-sent' },
      { kind: 'unconfirmed' },
      { kind: 'destination-mismatch' },
      ...[200, 302, 404, 408, 500].map((status) => ({ kind: 'response' as const, status, providerRefValues: ['ref'] })),
    ];
    const results: ExecutionAdapterResult[] = [];
    for (const credential of [{ kind: 'bearer', token: TOKEN }, { kind: 'header', name: 'X-API-Key', value: API_KEY }]) {
      for (const observation of observations) results.push(await executeWith(fakeRuntime({ observe: () => observation }), { credential }));
      results.push(await executeWith(fakeRuntime({ answers: [{ kind: 'failed' }] }), { credential }));
      results.push(await executeWith(fakeRuntime({ answers: [{ kind: 'resolved', answers: [{ address: '10.0.0.1', family: 4 }] }] }), { credential }));
      results.push(await executeWith(fakeRuntime(), { credential }, { ...ACTION, counterparty: undefined } as unknown as ValidatedExecutionAction));
      results.push(await executeWith(fakeRuntime({ sendThrows: true }), { credential }));
    }
    for (const result of results) {
      if ('detail' in result && result.detail !== undefined) assert.ok(phrases.has(result.detail), `unexpected detail: ${result.detail}`);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(serialized.includes(API_KEY), false);
      assert.equal(serialized.includes('api.erp.example'), false, 'no URL or host in an outward result');
    }
  });
});

// ---------------------------------------------------------------------------
// The Node transport
// ---------------------------------------------------------------------------

describe('Generic HTTP — Node transport request options (§11, §39 rows 30–34)', () => {
  const request = mapped();

  it('the lookup ignores the hostname and answers only the approved address, in both callback shapes', () => {
    const options = buildNodeRequestOptions(request, PUBLIC_V4);
    const lookup = options.lookup as unknown as (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void;
    const single: unknown[] = [];
    lookup('evil.example', {}, (...args) => single.push(...args));
    assert.deepEqual(single, [null, PUBLIC_V4.address, 4]);
    const all: unknown[] = [];
    lookup('api.erp.example', { all: true }, (...args) => all.push(...args));
    assert.deepEqual(all, [null, [{ address: PUBLIC_V4.address, family: 4 }]]);
  });

  it('SNI, certificate identity and Host come from the pinned hostname; no agent, no reuse, no family racing', () => {
    const options = buildNodeRequestOptions(request, PUBLIC_V6);
    assert.equal(options.hostname, 'api.erp.example');
    assert.equal(options.servername, 'api.erp.example');
    assert.equal(options.setHost, true);
    assert.equal(options.agent, false, 'a fresh single-use connection: nothing from an earlier DNS answer is reused');
    assert.equal(options.autoSelectFamily, false);
    assert.equal(options.family, 6);
    assert.equal(options.insecureHTTPParser, false);
    assert.equal(options.path, '/v1/payments');
    assert.equal(options.method, 'POST');
    assert.equal(options.rejectUnauthorized, true, 'certificate verification is hardcoded on, never left to a default the environment can relax');
    for (const key of ['ca', 'checkServerIdentity', 'secureContext', 'host', 'socketPath', 'createConnection', 'cert', 'key', 'pfx', 'minVersion', 'ciphers']) {
      assert.equal(key in options, false, `${key} must never be set`);
    }
    assert.equal(Object.getPrototypeOf(options.headers), null);
    assert.equal((options.headers as Record<string, string>)['host'], undefined, 'Host is set by Node from the pinned hostname, never copied from configuration');
  });
});

/** A scripted `ClientRequest` stand-in for the transport's phase logic. */
class FakeSocket extends EventEmitter {
  remoteAddress: string | undefined = PUBLIC_V4.address;
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  written: string | undefined;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  end(body?: string): this {
    this.written = body;
    return this;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(
    readonly statusCode: number,
    readonly rawHeaders: string[],
  ) {
    super();
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function scripted(script: (request: FakeRequest, socket: FakeSocket, respond: (response: FakeResponse) => void) => void): { primitive: GenericHttpRequestPrimitive; calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  const primitive = ((_options: unknown, onResponse: (response: FakeResponse) => void) => {
    const outbound = new FakeRequest();
    calls.push(outbound);
    const socket = new FakeSocket();
    setImmediate(() => script(outbound, socket, onResponse));
    return outbound;
  }) as unknown as GenericHttpRequestPrimitive;
  return { primitive, calls };
}

describe('Generic HTTP — transport phases: certainty ends at secureConnect (§21, §41)', () => {
  const request = mapped();

  it('an error before secureConnect (TCP refused, TLS failure) is not-sent', async () => {
    const { primitive, calls } = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      outbound.emit('error', new Error(`certificate ${TOKEN}`));
    });
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, 'x-request-id'), { kind: 'not-sent' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.destroyed, true);
  });

  it('a socket reset after secureConnect is unconfirmed', async () => {
    const { primitive } = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      outbound.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    });
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined), { kind: 'unconfirmed' });
  });

  it('a remote close after secureConnect with no response is unconfirmed', async () => {
    const { primitive } = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      outbound.emit('close');
    });
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined), { kind: 'unconfirmed' });
  });

  it('a timeout after secureConnect is unconfirmed; a timeout before it is not-sent', async () => {
    const secured = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
    });
    assert.deepEqual(await sendOnce(secured.primitive, request, PUBLIC_V4, 30, undefined), { kind: 'unconfirmed' });
    assert.equal(secured.calls[0]?.destroyed, true, 'the timed-out request is destroyed, not left running');
    const connecting = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
    });
    assert.deepEqual(await sendOnce(connecting.primitive, request, PUBLIC_V4, 30, undefined), { kind: 'not-sent' });
  });

  it('a request stream failure after secureConnect is unconfirmed', async () => {
    const { primitive } = scripted((outbound, socket) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      outbound.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined), { kind: 'unconfirmed' });
  });

  it('a TCP connection to an address other than the approved one is refused before TLS', async () => {
    const { primitive, calls } = scripted((outbound, socket) => {
      socket.remoteAddress = '10.0.0.9';
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      outbound.emit('close');
    });
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined), { kind: 'destination-mismatch' });
    assert.equal(calls[0]?.destroyed, true);
  });

  it('a final status is authoritative; the body is never read and the exchange is torn down at once', async () => {
    let response: FakeResponse | undefined;
    const { primitive, calls } = scripted((outbound, socket, respond) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      response = new FakeResponse(503, ['X-Request-Id', 'prov-9', 'x-request-id', 'prov-10', 'Content-Type', 'text/html']);
      respond(response);
      outbound.emit('error', new Error('late'));
    });
    const observation = await sendOnce(primitive, request, PUBLIC_V4, 1000, 'x-request-id');
    assert.deepEqual(observation, { kind: 'response', status: 503, providerRefValues: ['prov-9', 'prov-10'] });
    assert.equal(response?.destroyed, true, 'the response body is discarded, not buffered');
    assert.equal(response?.listenerCount('data'), 0, 'nothing ever subscribes to the body');
    assert.equal(calls[0]?.destroyed, true);
  });

  it('the request body written is exactly the mapped body', async () => {
    const { primitive, calls } = scripted((outbound, socket, respond) => {
      outbound.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
      respond(new FakeResponse(204, []));
    });
    await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined);
    assert.equal(calls[0]?.written, request.body);
  });

  it('a primitive that throws synchronously is not-sent', async () => {
    const primitive = (() => {
      throw new Error('ERR_INVALID_CHAR');
    }) as unknown as GenericHttpRequestPrimitive;
    assert.deepEqual(await sendOnce(primitive, request, PUBLIC_V4, 1000, undefined), { kind: 'not-sent' });
  });
});

// ---------------------------------------------------------------------------
// Real local sockets
// ---------------------------------------------------------------------------

const HOSTNAME = 'provider.frontera-test.invalid';
const LOOPBACK: GenericHttpResolvedAddress = { address: '127.0.0.1', family: 4 };
const workDir = mkdtempSync(join(tmpdir(), 'aoc-generic-http-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/**
 * A throwaway self-signed certificate for the test hostname, made at test time.
 * Absent openssl, the TLS-completing tests are skipped, never faked.
 *
 * Its validity is pinned to 2000–2099 through `openssl ca -selfsign` rather
 * than starting "now": a certificate whose notBefore is the second it was
 * minted is rejected as not-yet-valid if the host clock steps backwards
 * between minting and the handshake, which a virtualized clock can do.
 */
const certificate: { readonly key: Buffer; readonly cert: Buffer } | undefined = (() => {
  try {
    const at = (name: string) => join(workDir, name);
    writeFileSync(at('index.txt'), '');
    writeFileSync(at('serial'), '01\n');
    writeFileSync(
      at('ca.cnf'),
      [
        '[ca]',
        'default_ca = test',
        '[test]',
        `database = ${at('index.txt')}`,
        `new_certs_dir = ${workDir}`,
        `serial = ${at('serial')}`,
        'default_md = sha256',
        'policy = anything',
        'unique_subject = no',
        '[anything]',
        'commonName = supplied',
        '[ext]',
        `subjectAltName = DNS:${HOSTNAME}`,
        'basicConstraints = critical,CA:TRUE',
        'keyUsage = critical,digitalSignature,keyCertSign',
        '',
      ].join('\n'),
    );
    execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', at('key.pem'), '-out', at('csr.pem'), '-subj', `/CN=${HOSTNAME}`], { stdio: 'ignore' });
    execFileSync(
      'openssl',
      ['ca', '-batch', '-selfsign', '-config', at('ca.cnf'), '-keyfile', at('key.pem'), '-in', at('csr.pem'), '-out', at('cert.pem'), '-startdate', '20000101000000Z', '-enddate', '20991231235959Z', '-extensions', 'ext', '-notext'],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(at('key.pem')), cert: readFileSync(at('cert.pem')) };
  } catch {
    return undefined;
  }
})();

/** Why a handshake with the trusted test certificate failed — so a failure names its cause instead of reading as "not-sent". */
async function handshakeDiagnosis(port: number): Promise<string> {
  return new Promise((resolve) => {
    const probe = httpsRequest({ hostname: HOSTNAME, port, servername: HOSTNAME, lookup: ((_h: string, _o: unknown, cb: (...args: unknown[]) => void) => cb(null, '127.0.0.1', 4)) as never, agent: false, ca: certificate?.cert, method: 'HEAD' }, (response) => {
      response.destroy();
      resolve(`the handshake succeeded on a second attempt (status ${String(response.statusCode)})`);
    });
    probe.on('error', (error: NodeJS.ErrnoException) => resolve(`${error.code ?? 'no code'}: ${error.message} (clock ${new Date().toISOString()})`));
    probe.end();
  });
}

function wire(port: number): GenericHttpWireRequest {
  const base = mapped({ headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } } });
  return { ...base, hostname: HOSTNAME, port };
}

async function listen(server: HttpsServer | ReturnType<typeof createNetServer> | ReturnType<typeof createTlsServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

describe('Generic HTTP — the transport over real local sockets', () => {
  it('TCP connection refused is not-sent', async () => {
    const probe = createNetServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    assert.deepEqual(await sendOnce(httpsRequest as unknown as GenericHttpRequestPrimitive, wire(port), LOOPBACK, 2000, undefined), { kind: 'not-sent' });
  });

  it('the pinned lookup dials the approved IP for a hostname that cannot resolve, and SNI is the pinned hostname; a TLS failure is not-sent', async () => {
    let sni: string | undefined;
    let connections = 0;
    const server = createTlsServer({
      SNICallback: (name, callback) => {
        sni = name;
        callback(new Error('refuse handshake'), undefined);
      },
    });
    server.on('connection', () => (connections += 1));
    server.on('tlsClientError', () => {});
    const port = await listen(server);
    try {
      const observation = await sendOnce(httpsRequest as unknown as GenericHttpRequestPrimitive, wire(port), LOOPBACK, 2000, undefined);
      assert.deepEqual(observation, { kind: 'not-sent' });
      assert.equal(sni, HOSTNAME, 'TLS SNI is the configured hostname, not the IP');
      assert.equal(connections, 1, 'one connection, to the approved address — the unresolvable hostname was never looked up');
    } finally {
      server.close();
    }
  });

  it('a server that closes during the handshake is not-sent', async () => {
    const server = createNetServer((socket: Socket) => socket.destroy());
    const port = await listen(server);
    try {
      assert.deepEqual(await sendOnce(httpsRequest as unknown as GenericHttpRequestPrimitive, wire(port), LOOPBACK, 2000, undefined), { kind: 'not-sent' });
    } finally {
      server.close();
    }
  });

  it('28. an ambient NODE_TLS_REJECT_UNAUTHORIZED=0 cannot make the transport accept an untrusted certificate (isolated child process)', { skip: certificate === undefined }, () => {
    // A child process, so the ambient override cannot leak into this suite.
    const transportModule = join(__dirname, '..', 'execution-adapters', 'generic-http', 'node-https-transport.js');
    const script = `
      const { createServer, request } = require('node:https');
      const { readFileSync } = require('node:fs');
      const { sendOnce } = require(${JSON.stringify(transportModule)});
      (async () => {
        const server = createServer({ key: readFileSync(${JSON.stringify(join(workDir, 'key.pem'))}), cert: readFileSync(${JSON.stringify(join(workDir, 'cert.pem'))}) }, (req, res) => { hits.push(req.url); res.end(); });
        const hits = [];
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        // Control: in this process the ambient override really does disable Node's default verification.
        const control = await new Promise((resolve) => {
          const probe = request({ hostname: '127.0.0.1', port, servername: ${JSON.stringify(HOSTNAME)}, path: '/control', method: 'POST', agent: false }, (res) => { res.resume(); resolve(res.statusCode); });
          probe.on('error', (error) => resolve('error:' + error.code));
          probe.end();
        });
        const observation = await sendOnce(request, { method: 'POST', hostname: ${JSON.stringify(HOSTNAME)}, port, path: '/v1/payments', headers: [['content-type', 'application/json'], ['content-length', '2']], body: '{}' }, { address: '127.0.0.1', family: 4 }, 3000, undefined);
        server.closeAllConnections();
        server.close();
        process.stdout.write(JSON.stringify({ env: process.env.NODE_TLS_REJECT_UNAUTHORIZED, control, observation, hits }));
      })();
    `;
    const output = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const result = JSON.parse(output) as { env: string; control: unknown; observation: unknown; hits: string[] };
    assert.equal(result.env, '0');
    assert.equal(result.control, 200, 'non-vacuity: with the override, a request relying on the default accepts the untrusted certificate');
    assert.deepEqual(result.observation, { kind: 'not-sent' }, 'the Generic HTTP transport refuses the certificate anyway');
    assert.deepEqual(result.hits, ['/control'], 'the governed request was never delivered to the provider');
  });

  it('TLS certificate verification stays on: the production primitive refuses a self-signed provider as not-sent', { skip: certificate === undefined }, async () => {
    assert.ok(certificate !== undefined);
    let hits = 0;
    const server = createHttpsServer({ key: certificate.key, cert: certificate.cert }, (_request, response) => {
      hits += 1;
      response.end();
    });
    const port = await listen(server);
    try {
      assert.deepEqual(await sendOnce(httpsRequest as unknown as GenericHttpRequestPrimitive, wire(port), LOOPBACK, 2000, undefined), { kind: 'not-sent' });
      assert.equal(hits, 0, 'an unverifiable provider never receives the request');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  describe('with the test certificate trusted by a test-only primitive wrapper', { skip: certificate === undefined }, () => {
    const trusting = ((options: object, onResponse: never) => httpsRequest({ ...options, ca: certificate?.cert }, onResponse)) as unknown as GenericHttpRequestPrimitive;

    async function exchange(
      handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string) => void,
      timeoutMs = 2000,
    ): Promise<{ observation: GenericHttpTransportObservation; hits: { host?: string; path?: string; method?: string; idem?: string; body: string; authorization?: string }[] }> {
      assert.ok(certificate !== undefined);
      const hits: { host?: string; path?: string; method?: string; idem?: string; body: string; authorization?: string }[] = [];
      const server = createHttpsServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => (body += chunk));
        request.on('end', () => {
          const idem = request.headers['idempotency-key'];
          hits.push({
            ...(request.headers.host !== undefined ? { host: request.headers.host } : {}),
            ...(request.url !== undefined ? { path: request.url } : {}),
            ...(request.method !== undefined ? { method: request.method } : {}),
            ...(typeof idem === 'string' ? { idem } : {}),
            ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}),
            body,
          });
          handler(request, response, body);
        });
      });
      const port = await listen(server);
      try {
        const observation = await sendOnce(trusting, wire(port), LOOPBACK, timeoutMs, 'x-request-id');
        if (observation.kind === 'not-sent') assert.fail(`the TLS session with the trusted test provider was never established — ${await handshakeDiagnosis(port)}`);
        return { observation, hits };
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }

    it('the provider receives exactly the mapped request once: pinned Host, path, method, idempotency, credential and body', async () => {
      const { observation, hits } = await exchange((_request, response) => {
        response.writeHead(201, { 'X-Request-Id': 'prov-201' });
        response.end(`provider body with ${TOKEN}`);
      });
      assert.equal(observation.kind, 'response');
      assert.deepEqual(observation, { kind: 'response', status: 201, providerRefValues: ['prov-201'] });
      assert.equal(hits.length, 1);
      assert.match(hits[0]?.host ?? '', new RegExp(`^${HOSTNAME.replaceAll('.', '\\.')}:\\d+$`));
      assert.equal(hits[0]?.path, '/v1/payments');
      assert.equal(hits[0]?.method, 'POST');
      assert.equal(hits[0]?.idem, 'exec-1');
      assert.equal(hits[0]?.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(hits[0]?.body ?? ''), { invoiceId: 'INV-1001', vendorId: 'V123', amount: 7500, currency: 'USD', organization: 'org-datasys' });
      assert.equal(JSON.stringify(observation).includes(TOKEN), false, 'the response body never enters the observation');
    });

    it('a 302 is observed, and its Location is never requested', async () => {
      const { observation, hits } = await exchange((_request, response) => {
        response.writeHead(302, { Location: '/v1/elsewhere' });
        response.end();
      });
      assert.deepEqual(observation, { kind: 'response', status: 302, providerRefValues: [] });
      assert.equal(hits.length, 1, 'no second request, to the same host or any other');
    });

    it('17–18. a 303 See Other is observed once: exactly one request, and its Location is never requested', async () => {
      const { observation, hits } = await exchange((_request, response) => {
        response.writeHead(303, { Location: '/v1/payments/receipt-1' });
        response.end();
      });
      assert.deepEqual(observation, { kind: 'response', status: 303, providerRefValues: [] });
      assert.equal(hits.length, 1, 'no second request to the Location, on the same host or any other');
      assert.equal(hits[0]?.path, '/v1/payments');
    });

    it('a 500 is observed once and not retried', async () => {
      const { observation, hits } = await exchange((_request, response) => {
        response.writeHead(500);
        response.end();
      });
      assert.deepEqual(observation, { kind: 'response', status: 500, providerRefValues: [] });
      assert.equal(hits.length, 1);
    });

    it('a reset after the provider received the request is unconfirmed, and not retried', async () => {
      const { observation, hits } = await exchange((request) => request.socket.destroy());
      assert.deepEqual(observation, { kind: 'unconfirmed' });
      assert.equal(hits.length, 1);
    });

    it('a provider that receives the request and never answers is unconfirmed at the timeout', async () => {
      const { observation, hits } = await exchange(() => {}, 300);
      assert.deepEqual(observation, { kind: 'unconfirmed' });
      assert.equal(hits.length, 1);
    });

    it('a duplicated provider-reference header is reported as two values, never joined', async () => {
      const { observation } = await exchange((_request, response) => {
        response.setHeader('x-request-id', ['a', 'b']);
        response.writeHead(200);
        response.end();
      });
      assert.deepEqual(observation, { kind: 'response', status: 200, providerRefValues: ['a', 'b'] });
    });

    it('17. proxy environment variables change nothing: the provider is reached directly', async () => {
      const saved = { HTTPS_PROXY: process.env['HTTPS_PROXY'], HTTP_PROXY: process.env['HTTP_PROXY'], https_proxy: process.env['https_proxy'], NO_PROXY: process.env['NO_PROXY'] };
      process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9';
      process.env['HTTP_PROXY'] = 'http://127.0.0.1:9';
      process.env['https_proxy'] = 'http://127.0.0.1:9';
      delete process.env['NO_PROXY'];
      try {
        const { observation, hits } = await exchange((_request, response) => {
          response.writeHead(204);
          response.end();
        });
        assert.deepEqual(observation, { kind: 'response', status: 204, providerRefValues: [] });
        assert.equal(hits.length, 1);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('Generic HTTP — structural boundaries (§5, §29, §52)', () => {
  const FILES = ['contracts.ts', 'configuration.ts', 'request-mapper.ts', 'public-address-policy.ts', 'node-https-transport.ts', 'generic-http-execution-adapter.ts', 'index.ts'].map((name) => `${MODULE_DIR}/${name}`);

  it('imports no Kernel, policy, Governance Store, grant store, customer identity, obligation, approval or emergency-control module', () => {
    for (const file of FILES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        const allowed =
          specifier.startsWith('./') ||
          specifier === '../../../features/execution-runtime/index.js' ||
          // P9: the pure monetary primitive, to prove amount.value is canonical text before it is spelled as a JSON number.
          specifier === '../../../features/monetary-runtime/index.js' ||
          ['node:net', 'node:dns', 'node:https', 'node:http'].includes(specifier);
        assert.ok(allowed, `${file} imports '${specifier}'; the adapter receives a ValidatedExecutionAction and nothing else from governance`);
      }
      const code = codeOf(file);
      for (const forbidden of [/AocKernel/, /KernelEvaluation/, /GovernanceStore/, /BoundedGrantStore/, /BoundedGrantReader/, /CustomerIdentity/, /Obligation/, /Approval/, /EmergencyControl/, /evaluatePolicy/, /assertedContext\s*[:.]/, /boundedGrantId\s*[:(]/]) {
        assert.equal(forbidden.test(code), false, `${file} must not reference ${String(forbidden)}`);
      }
    }
  });

  it('only the transport imports node:https, node:http or node:dns', () => {
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('node-https-transport.ts')) {
        assert.ok(/from 'node:https'/.test(text) && /from 'node:dns'/.test(text), 'the transport is where the network lives');
      } else {
        assert.equal(/from 'node:(https|http|dns|tls)'/.test(text), false, `${file} must not import a network client module`);
      }
    }
  });

  it('the mapper, the configuration snapshot and the address policy perform no I/O and read no environment', () => {
    for (const name of ['request-mapper.ts', 'configuration.ts', 'public-address-policy.ts', 'contracts.ts']) {
      const code = codeOf(`${MODULE_DIR}/${name}`);
      for (const forbidden of [/node:(fs|http|https|dns|child_process|tls)/, /\bfetch\s*\(/, /process\.env/, /\brequire\s*\(/, /\bimport\s*\(/, /setTimeout|setInterval/, /Date\.now|new Date\(/, /Math\.random|randomUUID/, /\beval\s*\(|new\s+Function\s*\(/]) {
        assert.equal(forbidden.test(code), false, `${name} must stay pure (${String(forbidden)})`);
      }
    }
  });

  it('30. rejectUnauthorized appears on no public surface: not the option types, not the routing options, not the barrel — and is refused as an option', () => {
    for (const file of [`${MODULE_DIR}/contracts.ts`, `${MODULE_DIR}/index.ts`, 'src/enterprise/index.ts', 'src/enterprise/composition/composition-root.ts']) {
      assert.equal(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/.test(codeOf(file)), false, `${file} must not expose a TLS verification switch`);
    }
    for (const value of [true, false]) refusedWith('GENERIC_HTTP_OPTIONS_INVALID', () => plan({ rejectUnauthorized: value }));
    refusedWith('GENERIC_HTTP_OPTIONS_INVALID', () => plan({ tls: { rejectUnauthorized: false } }));
    const transport = codeOf(`${MODULE_DIR}/node-https-transport.ts`);
    assert.equal([...transport.matchAll(/rejectUnauthorized/g)].length, 1, 'set in exactly one place');
    assert.match(transport, /rejectUnauthorized:\s*true,/, 'and hardcoded to true, never computed');
  });

  it('§29. the public option types declare no network escape hatch', () => {
    const contracts = codeOf(`${MODULE_DIR}/contracts.ts`);
    const identifiers = new Set([...contracts.matchAll(/readonly\s+([A-Za-z_$][\w$]*)\??\s*:/g)].map((match) => (match[1] ?? '').toLowerCase()));
    assert.ok(identifiers.has('origin') && identifiers.has('credential'), 'the scan must see the real option fields');
    for (const forbidden of ['fetch', 'transport', 'request', 'socket', 'agent', 'dispatcher', 'proxy', 'lookup', 'resolver', 'dns', 'redirect', 'retry', 'rejectunauthorized', 'allowprivate', 'allowloopback', 'allowinsecure', 'tlsoptions', 'tls', 'runtime', 'insecure']) {
      for (const identifier of identifiers) {
        assert.equal(identifier.includes(forbidden), false, `a public Generic HTTP option names '${identifier}'`);
      }
    }
    assert.equal(identifiers.has('ca'), false);
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    const routing = /export interface EnterpriseExecutionAdapterRoutingOptions \{([\s\S]*?)\n\}/.exec(root)?.[1];
    assert.ok(routing !== undefined);
    for (const forbidden of ['transport', 'runtime', 'lookup', 'agent', 'proxy', 'fetch', 'dispatcher', 'resolver']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`, 'i').test(routing), false, `EnterpriseExecutionAdapterRoutingOptions must not carry '${forbidden}'`);
    }
  });

  it('§29–30. the internal seam is not reachable through the Enterprise barrel or the module barrel', () => {
    const barrel = codeOf('src/enterprise/index.ts');
    for (const symbol of ['createGenericHttpExecutionAdapterCore', 'createGenericHttpExecutionAdapter', 'NODE_GENERIC_HTTP_RUNTIME', 'GenericHttpNetworkRuntime', 'sendOnce', 'buildNodeRequestOptions', 'mapGenericHttpRequest', 'selectApprovedAddress', 'snapshotGenericHttpOptions']) {
      assert.equal(barrel.includes(symbol), false, `the Enterprise barrel must not expose ${symbol}`);
    }
    const genericExports = [...barrel.matchAll(/export (type )?\{[^}]*\} from '\.\/execution-adapters\/generic-http\/index\.js'/g)];
    assert.equal(genericExports.length, 1);
    assert.equal(genericExports[0]?.[1], 'type ', 'the Enterprise barrel exports Generic HTTP configuration types only');
    const moduleBarrel = codeOf(`${MODULE_DIR}/index.ts`);
    for (const symbol of ['createGenericHttpExecutionAdapterCore', 'NODE_GENERIC_HTTP_RUNTIME', 'GenericHttpNetworkRuntime', 'sendOnce', 'node-https-transport', 'request-mapper', 'public-address-policy', 'configuration.js']) {
      assert.equal(moduleBarrel.includes(symbol), false, `the module barrel must not expose ${symbol}`);
    }
  });

  it('the production factory binds the Node runtime and accepts no runtime argument', () => {
    const core = codeOf(`${MODULE_DIR}/generic-http-execution-adapter.ts`);
    assert.match(core, /export function createGenericHttpExecutionAdapter\(options: EnterpriseGenericHttpExecutionAdapterOptions\): ExecutionAdapter \{\s*return createGenericHttpExecutionAdapterCore\(snapshotGenericHttpOptions\(options\), NODE_GENERIC_HTTP_RUNTIME\);/);
    assert.equal(createGenericHttpExecutionAdapter.length, 1);
  });

  it('the execution runtime itself stays provider-neutral: no node:http, https, dns or net anywhere under it', () => {
    const walk = (dir: string): string[] =>
      readdirSyncSafe(dir).flatMap((name) => {
        const full = join(dir, name);
        return statIsDirectory(full) ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });
    const files = [...walk('src/features/execution-runtime/domain'), ...walk('src/features/execution-runtime/services')];
    assert.ok(files.length >= 8);
    for (const file of files) assert.equal(/from ['"]node:(http|https|dns|net|tls)['"]/.test(readFileSync(file, 'utf8')), false, `${file} must not import a network module`);
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statIsDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}
