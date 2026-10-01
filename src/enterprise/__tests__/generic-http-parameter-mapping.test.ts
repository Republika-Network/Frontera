import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { GovernedParameter } from '../../features/governed-parameter-runtime/index.js';
import { GenericHttpConfigurationError, type EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/contracts.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';

/**
 * CORE-08 §9 – §13 — the Generic HTTP adapter's closed `parameter` source.
 *
 * Pure tests over the production snapshot and mapper: a governed parameter is
 * read by exact dimension id from the validated action, placed only where the
 * trusted configuration puts it, spelled once per position (text in a path
 * segment, query value or header value; its own JSON primitive in a body), and
 * can never move the request — scheme, host, port, credential and routing are
 * configuration and nothing else. Authority properties (only exercise-contained
 * parameters reach an adapter) are proven at the exercise gate and on the Host,
 * not here.
 */

const TOKEN = 'Core08MappingBearerSentinel0123456789';

function action(parameters?: readonly GovernedParameter[]): ValidatedExecutionAction {
  return Object.freeze({
    boundedGrantId: 'grant-internal',
    subject: 'actor-agent',
    action: 'reference-action',
    resource: 'reference-resource',
    organization: 'org-core08',
    notAfter: '2026-01-01T00:10:00.000Z',
    correlation: Object.freeze({ requestId: 'req-1', decisionId: 'dec-1', executionId: 'exec-1' }),
    ...(parameters !== undefined ? { parameters: Object.freeze(parameters.map((entry) => Object.freeze({ ...entry }))) } : {}),
  });
}

const TYPED: readonly GovernedParameter[] = [
  { dimension: 'dryRun', type: 'boolean', value: false },
  { dimension: 'quantity', type: 'integer', value: 3 },
  { dimension: 'strategy', type: 'token', value: 'Blue-Green' },
];

function options(overrides: Partial<Record<keyof EnterpriseGenericHttpExecutionAdapterOptions, unknown>> = {}): EnterpriseGenericHttpExecutionAdapterOptions {
  return {
    adapterId: 'reference.http',
    origin: 'https://provider.example',
    method: 'POST',
    path: [
      { kind: 'literal', value: 'v1' },
      { kind: 'parameter', dimension: 'strategy' },
      { kind: 'parameter', dimension: 'quantity' },
      { kind: 'parameter', dimension: 'dryRun' },
    ],
    query: {
      q: { kind: 'parameter', dimension: 'quantity' },
      s: { kind: 'parameter', dimension: 'strategy' },
      d: { kind: 'parameter', dimension: 'dryRun' },
    },
    headers: {
      'X-Quantity': { kind: 'parameter', dimension: 'quantity' },
      'X-Strategy': { kind: 'parameter', dimension: 'strategy' },
      'X-Dry-Run': { kind: 'parameter', dimension: 'dryRun' },
    },
    body: {
      kind: 'json-object',
      fields: {
        quantity: { kind: 'parameter', dimension: 'quantity' },
        strategy: { kind: 'parameter', dimension: 'strategy' },
        dryRun: { kind: 'parameter', dimension: 'dryRun' },
      },
    },
    credential: { kind: 'bearer', token: TOKEN },
    ...overrides,
  } as EnterpriseGenericHttpExecutionAdapterOptions;
}

function build(overrides: Partial<Record<keyof EnterpriseGenericHttpExecutionAdapterOptions, unknown>> = {}, validated: ValidatedExecutionAction = action(TYPED)) {
  return mapGenericHttpRequest(snapshotGenericHttpOptions(options(overrides)), validated);
}

function built(overrides: Partial<Record<keyof EnterpriseGenericHttpExecutionAdapterOptions, unknown>> = {}, validated: ValidatedExecutionAction = action(TYPED)): GenericHttpWireRequest {
  const result = build(overrides, validated);
  assert.ok(result.ok, 'expected a buildable request');
  return result.request;
}

const header = (request: GenericHttpWireRequest, name: string) => request.headers.find(([key]) => key === name)?.[1];

function refused(overrides: Partial<Record<keyof EnterpriseGenericHttpExecutionAdapterOptions, unknown>>): void {
  assert.throws(() => snapshotGenericHttpOptions(options(overrides)), (error: unknown) => {
    assert.ok(error instanceof GenericHttpConfigurationError, String(error));
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
}

describe('CORE-08 §10 — one canonical translation per position, type preserved', () => {
  it('path segments, query values and header values carry the one text spelling: 3, Blue-Green, false', () => {
    const request = built();
    assert.equal(request.path, '/v1/Blue-Green/3/false?q=3&s=Blue-Green&d=false');
    assert.equal(header(request, 'x-quantity'), '3');
    assert.equal(header(request, 'x-strategy'), 'Blue-Green', 'a token is never lower-cased');
    assert.equal(header(request, 'x-dry-run'), 'false');
  });

  it('a JSON body keeps each JSON primitive: integer → number, token → string, boolean → boolean (false included)', () => {
    const request = built();
    assert.equal(request.body, '{"quantity":3,"strategy":"Blue-Green","dryRun":false}');
    assert.deepEqual(JSON.parse(request.body ?? ''), { quantity: 3, strategy: 'Blue-Green', dryRun: false });
    assert.equal(typeof (JSON.parse(request.body ?? '') as { dryRun: unknown }).dryRun, 'boolean', 'true/false is never "true"/"false" in JSON');
  });

  it('the largest safe integer is exact in text and in JSON', () => {
    const big = action([
      { dimension: 'dryRun', type: 'boolean', value: true },
      { dimension: 'quantity', type: 'integer', value: Number.MAX_SAFE_INTEGER },
      { dimension: 'strategy', type: 'token', value: 'x' },
    ]);
    const request = built({}, big);
    assert.ok(request.path.includes('/9007199254740991/true?'));
    assert.equal(request.body, '{"quantity":9007199254740991,"strategy":"x","dryRun":true}');
  });

  it('a negative integer is spelled once, as plain decimal', () => {
    const negative = action([
      { dimension: 'dryRun', type: 'boolean', value: true },
      { dimension: 'quantity', type: 'integer', value: -7 },
      { dimension: 'strategy', type: 'token', value: 'x' },
    ]);
    assert.equal(header(built({}, negative), 'x-quantity'), '-7');
  });
});

describe('CORE-08 §11 — absent parameters: required is unbuildable, optional is omitted', () => {
  it('a required (default) parameter the action does not carry makes the request unbuildable — and nothing is sent', async () => {
    assert.equal(build({}, action([TYPED[0] as GovernedParameter, TYPED[1] as GovernedParameter])).ok, false, 'strategy is missing');
    assert.equal(build({}, action()).ok, false, 'no parameters at all');
    let sends = 0;
    const runtime: GenericHttpNetworkRuntime = {
      async resolve() {
        return { kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] };
      },
      async send() {
        sends += 1;
        return { kind: 'response', status: 200, providerRefValues: [] };
      },
    };
    const adapter = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(options()), runtime);
    const result = await adapter.execute(action([TYPED[1] as GovernedParameter]));
    assert.equal(result.outcome, 'failed');
    assert.ok(result.outcome === 'failed' && result.reason === 'ADAPTER_ERROR');
    assert.equal(sends, 0, 'an unbuildable request is never sent');
    assert.equal((await adapter.execute(action(TYPED))).outcome, 'completed');
    assert.equal(sends, 1);
  });

  it('an optional parameter binding omits its destination field; it never defaults a value', () => {
    const request = built(
      {
        path: [{ kind: 'literal', value: 'v1' }],
        query: { s: { kind: 'parameter', dimension: 'strategy', required: false } },
        headers: { 'X-Strategy': { kind: 'parameter', dimension: 'strategy', required: false } },
        body: { kind: 'json-object', fields: { strategy: { kind: 'parameter', dimension: 'strategy', required: false }, quantity: { kind: 'parameter', dimension: 'quantity' } } },
      },
      action([TYPED[1] as GovernedParameter]),
    );
    assert.equal(request.path, '/v1');
    assert.equal(header(request, 'x-strategy'), undefined);
    assert.equal(request.body, '{"quantity":3}');
  });

  it('a path segment cannot be made optional', () => {
    refused({ path: [{ kind: 'parameter', dimension: 'strategy', required: false }] });
  });
});

describe('CORE-08 §9 — the binding is closed: one declared dimension id, never a path, template or expression', () => {
  it('a dotted id is an opaque name matched exactly — never traversed as a path into the action', () => {
    // `.` is a legal separator in the canonical governed-dimension grammar, so these
    // compose — and read nothing: no dimension is literally named this.
    for (const dimension of ['parameters.quantity', 'quantity.value', 'correlation.requestId']) {
      assert.equal(build({ query: {}, headers: {}, path: [{ kind: 'literal', value: 'v1' }], body: { kind: 'json-object', fields: { q: { kind: 'parameter', dimension } } } }).ok, false, `${dimension}: required and absent`);
      const optional = built({ query: {}, headers: {}, path: [{ kind: 'literal', value: 'v1' }], body: { kind: 'json-object', fields: { q: { kind: 'parameter', dimension, required: false } } } });
      assert.equal(optional.body, '{}', `${dimension} resolved to nothing`);
    }
  });

  it('refuses a template, an index, an expression, a JSONPath, a capitalized id and a non-string', () => {
    for (const dimension of ['${quantity}', 'quantity[0]', '$.quantity', 'quantity || 1', 'parameters/quantity', '.quantity', 'quantity.', 'Quantity', '', 7, null]) {
      refused({ body: { kind: 'json-object', fields: { quantity: { kind: 'parameter', dimension } } } });
      refused({ path: [{ kind: 'parameter', dimension }] });
      refused({ headers: { 'X-Q': { kind: 'parameter', dimension } } });
      refused({ query: { q: { kind: 'parameter', dimension } } });
    }
  });

  it('refuses an undeclared key on a parameter binding, and a non-boolean required flag', () => {
    refused({ query: { q: { kind: 'parameter', dimension: 'quantity', source: 'resource' } } });
    refused({ query: { q: { kind: 'parameter', dimension: 'quantity', transform: 'upper' } } });
    refused({ query: { q: { kind: 'parameter', dimension: 'quantity', required: 'yes' } } });
    refused({ path: [{ kind: 'parameter', dimension: 'quantity', default: 'x' }] });
  });

  it('a dimension named like an object member is only ever compared, never looked up', () => {
    const request = built(
      { path: [{ kind: 'literal', value: 'v1' }], query: {}, headers: {}, body: { kind: 'json-object', fields: { c: { kind: 'parameter', dimension: 'constructor', required: false } } } },
      action(TYPED),
    );
    assert.equal(request.body, '{}', 'no prototype member was read as a parameter');
  });
});

describe('CORE-08 §12 / §13 — a parameter can never control destination, credential or routing', () => {
  it('scheme, host and port come from the pinned origin whatever the parameter values are', () => {
    const hostile = action([
      { dimension: 'dryRun', type: 'boolean', value: true },
      { dimension: 'quantity', type: 'integer', value: 443 },
      { dimension: 'strategy', type: 'token', value: 'user@evil.example:8443' },
    ]);
    const request = built({}, hostile);
    assert.equal(request.hostname, 'provider.example');
    assert.equal(request.port, 443);
    assert.equal(request.path, '/v1/user%40evil.example%3A8443/443/true?q=443&s=user%40evil.example%3A8443&d=true');
    assert.ok(request.path.startsWith('/'));
    assert.equal(request.path.includes('//'), false);
  });

  it('a parameter cannot set Authorization, a credential header, a reserved header or a header name', () => {
    refused({ headers: { Authorization: { kind: 'parameter', dimension: 'strategy' } } });
    // Without any credential configured too — the reserved-name rule stands on its own, not only via the credential collision check.
    refused({ credential: undefined, headers: { Authorization: { kind: 'parameter', dimension: 'strategy' } } });
    refused({ credential: undefined, headers: { 'Proxy-Authorization': { kind: 'parameter', dimension: 'strategy' } } });
    refused({ headers: { Host: { kind: 'parameter', dimension: 'strategy' } } });
    refused({ headers: { 'Proxy-Authorization': { kind: 'parameter', dimension: 'strategy' } } });
    refused({ credential: { kind: 'header', name: 'X-Strategy', value: 'secret-value' } });
    const request = built();
    assert.equal(header(request, 'authorization'), `Bearer ${TOKEN}`, 'the credential is exactly the configured one');
    assert.equal(request.headers.filter(([name]) => name === 'authorization').length, 1);
  });

  it('the only configuration keys are the closed ones: no parameter-selected origin, adapter or route exists', () => {
    refused({ originParameter: 'strategy' } as never);
    refused({ adapterIdFrom: { kind: 'parameter', dimension: 'strategy' } } as never);
    refused({ origin: { kind: 'parameter', dimension: 'strategy' } });
  });
});

describe('CORE-08 §16 — defence in depth: only well-formed, typed, unique parameters are ever spelled', () => {
  const malformed: readonly [string, unknown][] = [
    ['a string integer', [TYPED[0], { dimension: 'quantity', type: 'integer', value: '3' }, TYPED[2]]],
    ['a numeric boolean', [{ dimension: 'dryRun', type: 'boolean', value: 0 }, TYPED[1], TYPED[2]]],
    ['a float', [TYPED[0], { dimension: 'quantity', type: 'integer', value: 3.5 }, TYPED[2]]],
    ['-0', [TYPED[0], { dimension: 'quantity', type: 'integer', value: -0 }, TYPED[2]]],
    ['a token with a slash', [TYPED[0], TYPED[1], { dimension: 'strategy', type: 'token', value: 'a/b' }]],
    ['a duplicated dimension', [TYPED[0], TYPED[1], TYPED[1], TYPED[2]]],
    ['an unknown type', [TYPED[0], { dimension: 'quantity', type: 'decimal', value: 3 }, TYPED[2]]],
    ['a non-array', { quantity: 3 }],
  ];
  for (const [name, parameters] of malformed) {
    it(`${name} on the validated action is unbuildable, never coerced`, () => {
      const validated = { ...action(), parameters } as unknown as ValidatedExecutionAction;
      assert.equal(build({}, validated).ok, false, name);
    });
  }

  it('fields beyond the declared sources are never read: extra action properties do not reach the request', () => {
    const smuggling = { ...action(TYPED), rawBody: '{"quantity":100}', metadata: { quantity: 100 }, assertedContext: { strategy: 'x' } } as unknown as ValidatedExecutionAction;
    assert.deepEqual(built({}, smuggling), built());
  });
});
