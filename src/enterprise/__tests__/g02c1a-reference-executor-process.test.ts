import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { genericHttpRequestBinding } from '../execution-adapters/generic-http/request-binding.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import type { ReferenceExecutorAssessment } from '../reference-executor/index.js';
import {
  BEARER,
  BEARER_ENV,
  CONFIG_VARIABLE,
  DIGEST_HEADER,
  ENCODED_RESOURCE,
  HEADER_CREDENTIAL,
  HEADER_CREDENTIAL_ENV,
  HEADER_CREDENTIAL_NAME,
  HOSTNAME,
  NONDEFAULT_PORT,
  OTHER_ISSUER,
  RESOURCE,
  addHeaderLines,
  capabilityFor,
  captureHostBytes,
  digestOfRecord,
  editHeaders,
  exchange,
  executorConfiguration,
  hostVector,
  parseRaw,
  pin,
  presentationFor,
  rawExchange,
  refusedStart,
  sendThroughHostTransport,
  serializeRaw,
  spawnExecutor,
  validatedAction,
  withBody,
  withFreshPresentation,
  withPresentation,
  ISSUED_PRESENTATIONS,
  ISSUER_KEY,
  type HostVector,
  type RawRequest,
  type SpawnedExecutor,
} from './g02c1a-reference-executor-fixture.js';

/**
 * G-02C1A — the reference executor as a **separate OS process**, reading real
 * HTTP/1.1 bytes with its own Node parser.
 *
 * Host side: the real G-02C0 mapper and binding, and the real Host transport
 * (`sendOnce`) writing the bytes. Executor side: `scripts/run-reference-executor.mjs`
 * with a configuration file of public keys and one credential variable.
 *
 * Not qualified here: TLS, public DNS, certificates and real reverse proxies —
 * the transport speaks plain HTTP to loopback (`loopbackPrimitive`).
 */

const BODY = {
  kind: 'json-object',
  fields: {
    subject: { kind: 'source', source: 'subject' },
    amount: { kind: 'source', source: 'amount.value' },
    currency: { kind: 'source', source: 'amount.unit' },
    replicas: { kind: 'parameter', dimension: 'replicaCount' },
  },
};
const PARAMETER = (dimension: string) => ({ kind: 'parameter', dimension });

interface Vector {
  readonly vector: HostVector;
  readonly executor: 'default' | 'port' | 'header';
  readonly capability?: Parameters<typeof capabilityFor>[1];
}

const VECTORS: readonly Vector[] = [
  { executor: 'default', vector: hostVector('POST without body') },
  { executor: 'default', vector: hostVector('POST with body', { body: BODY }) },
  { executor: 'default', vector: hostVector('PUT without body', { method: 'PUT', query: { strategy: PARAMETER('strategy') } }) },
  { executor: 'default', vector: hostVector('PATCH without body', { method: 'PATCH', headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } } }) },
  { executor: 'default', vector: hostVector('DELETE without body', { method: 'DELETE' }) },
  { executor: 'default', vector: hostVector('PUT with body', { method: 'PUT', body: BODY }) },
  {
    executor: 'default',
    vector: hostVector('typed parameters in path, query, header and body', {
      path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'replicas' }, PARAMETER('replicaCount')],
      query: { strategy: PARAMETER('strategy') },
      headers: { 'X-Replicas': PARAMETER('replicaCount'), 'X-Strategy': PARAMETER('strategy') },
      body: { kind: 'json-object', fields: { replicas: PARAMETER('replicaCount'), strategy: PARAMETER('strategy'), canary: { kind: 'literal', value: true } } },
    }),
  },
  {
    executor: 'default',
    vector: hostVector('percent-encoded path and query', { query: { note: { kind: 'literal', value: 'a b&c=d/é' }, who: { kind: 'source', source: 'counterparty' } } }, validatedAction({ resource: ENCODED_RESOURCE })),
    capability: { resource: ENCODED_RESOURCE },
  },
  {
    executor: 'default',
    vector: hostVector('multiple permitted headers', {
      query: { strategy: PARAMETER('strategy') },
      headers: {
        'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' },
        'X-Counterparty': { kind: 'source', source: 'counterparty' },
        'X-Release-Channel': { kind: 'literal', value: 'stable' },
        'X-Tenant': { kind: 'source', source: 'organization' },
        Accept: { kind: 'literal', value: 'application/json' },
      },
      body: BODY,
    }),
  },
  { executor: 'port', vector: hostVector('a non-default port', { origin: `https://${HOSTNAME}:${String(NONDEFAULT_PORT)}`, method: 'PATCH', body: BODY }) },
  { executor: 'header', vector: hostVector('a header credential', { credential: { kind: 'header', name: 'X-Gateway-Key', value: HEADER_CREDENTIAL } }) },
];

/** The mutation base: body, query and two mapped headers. */
const BASE = VECTORS[8]?.vector as HostVector;
const NO_BODY = VECTORS[0]?.vector as HostVector;
const DELETE = VECTORS[4]?.vector as HostVector;
const ENCODED = VECTORS[7]?.vector as HostVector;

let executors: Record<Vector['executor'], SpawnedExecutor>;
/** Every response this suite received, for the log-safety checks at the end. */
const answered: string[] = [];

before(async () => {
  const [defaults, port, header] = await Promise.all([
    spawnExecutor(),
    spawnExecutor(executorConfiguration({ expectedOrigin: `https://${HOSTNAME}:${String(NONDEFAULT_PORT)}` })),
    spawnExecutor(executorConfiguration({ clientCredential: { kind: 'header', name: HEADER_CREDENTIAL_NAME, valueEnv: HEADER_CREDENTIAL_ENV } })),
  ]);
  executors = { default: defaults, port, header };
});

after(async () => {
  await Promise.all(Object.values(executors).map((executor) => executor.kill()));
});

function present(digest: string, overrides: Parameters<typeof capabilityFor>[1] = {}): string {
  return presentationFor(capabilityFor(digest, overrides));
}

async function send(executor: SpawnedExecutor, raw: RawRequest): Promise<{ readonly status: number | undefined; readonly assessment: ReferenceExecutorAssessment }> {
  const { response, assessment } = await exchange(executor, serializeRaw(raw));
  answered.push(response.head, response.body);
  return { status: response.status, assessment };
}

describe('G-02C1A process — golden vectors: the Host’s binding, rebuilt by an independent process from real bytes', () => {
  for (const entry of VECTORS) {
    it(`${entry.vector.name}: identical digest, assessed eligible, answered 409`, async (t) => {
      const executor = executors[entry.executor];
      const before = executor.assessments.length;
      const observation = await sendThroughHostTransport(executor.port, withPresentation(entry.vector.request, present(entry.vector.digest, entry.capability)));
      assert.equal(observation.kind, 'response');
      if (observation.kind !== 'response') return;
      assert.equal(observation.status, 409, 'verification only: never a 2xx');
      assert.deepEqual(observation.providerRefValues, [entry.vector.digest], 'the executor rebuilt exactly the Host’s digest');
      await executor.waitForAssessments(before + 1);
      assert.deepEqual(executor.assessments[before], { mode: 'verification-only', outcome: 'assessed-eligible', stage: 'eligibility', code: 'VERIFICATION_ONLY', bindingDigest: entry.vector.digest });
      t.diagnostic(`golden ${entry.vector.name}: ${entry.vector.request.method} ${entry.vector.request.path} -> ${entry.vector.digest}`);
    });
  }

  it('the Host binding and the executor agree with records written out by hand from the specification', async () => {
    const records = [
      { vector: NO_BODY, record: { method: 'POST', origin: { scheme: 'https', hostname: HOSTNAME, port: 443 }, target: `/v1/deployments/${RESOURCE}`, headers: [], credentialHeader: 'authorization', body: null } },
      { vector: DELETE, record: { method: 'DELETE', origin: { scheme: 'https', hostname: HOSTNAME, port: 443 }, target: `/v1/deployments/${RESOURCE}`, headers: [], credentialHeader: 'authorization', body: null } },
      {
        vector: hostVector('one body field', { body: { kind: 'json-object', fields: { replicas: PARAMETER('replicaCount') } } }),
        record: { method: 'POST', origin: { scheme: 'https', hostname: HOSTNAME, port: 443 }, target: `/v1/deployments/${RESOURCE}`, headers: [['content-length', '14'], ['content-type', 'application/json']], credentialHeader: 'authorization', body: '{"replicas":4}' },
      },
    ];
    for (const { vector, record } of records) {
      assert.equal(vector.digest, digestOfRecord(record), `${vector.name}: the Host binding is the specified record`);
      const observation = await sendThroughHostTransport(executors.default.port, withPresentation(vector.request, present(vector.digest)));
      assert.ok(observation.kind === 'response' && observation.providerRefValues[0] === digestOfRecord(record), `${vector.name}: so is the executor's`);
    }
  });

  it('the Host classifies every gateway answer as definitively not completed: the full Generic HTTP adapter over the real transport', async () => {
    const vector = VECTORS[1]?.vector as HostVector;
    const presentation = present(vector.digest);
    const adapter = createGenericHttpExecutionAdapterCore(vector.plan, {
      resolve: async () => ({ kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] }),
      send: (request, _address, _timeoutMs, providerRefHeader) => sendThroughHostTransport(executors.default.port, withPresentation(request, presentation), providerRefHeader),
    });
    const result = await adapter.execute(validatedAction());
    assert.equal(result.outcome, 'failed');
    assert.equal(result.outcome === 'failed' ? result.reason : undefined, 'PROVIDER_REJECTED', 'an eligible assessment (409) is a provider rejection to the Host, never completed or unconfirmed');
  });
});

describe('G-02C1A process — Content-Length: 0, from the real Host transport', () => {
  it('Node writes exactly one Content-Length: 0 for a body-less POST, PUT and PATCH, none for DELETE, and never Transfer-Encoding', async (t) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const vector = method === 'POST' ? NO_BODY : hostVector(`${method} without body`, { method });
      const raw = parseRaw(await captureHostBytes(withPresentation(vector.request, present(vector.digest))));
      const lengths = raw.headerLines.filter((line) => /^content-length:/i.test(line));
      assert.deepEqual(lengths, method === 'DELETE' ? [] : ['Content-Length: 0'], method);
      assert.equal(raw.body.length, 0);
      assert.equal(raw.headerLines.some((line) => /^transfer-encoding:/i.test(line)), false);
      assert.ok(raw.headerLines.includes(`Host: ${HOSTNAME}`) && raw.headerLines.includes('Connection: close'), 'Host and Connection as the HTTPS transport writes them');
      t.diagnostic(`${method} without body: ${raw.requestLine} | ${raw.headerLines.filter((line) => !line.startsWith(EXECUTION_CAPABILITY_PRESENTATION_HEADER) && !/^authorization:/i.test(line)).join(' | ')}`);
    }
    const body = parseRaw(await captureHostBytes(withPresentation(BASE.request, present(BASE.digest))));
    assert.deepEqual(body.headerLines.filter((line) => /^content-length:/i.test(line)), [`content-length: ${String(body.body.length)}`], 'with a body: the mapper’s own header, once');
  });

  it('the exception applies only where the transport makes it, and only to exactly zero', async () => {
    const post = parseRaw(await captureHostBytes(withPresentation(NO_BODY.request, present(NO_BODY.digest))));
    assert.equal((await send(executors.default, withFreshPresentation(post, NO_BODY.digest))).assessment.outcome, 'assessed-eligible');
    const missing = await send(executors.default, withFreshPresentation(editHeaders(post, 'content-length', () => null), NO_BODY.digest));
    assert.deepEqual([missing.assessment.stage, missing.assessment.code], ['binding', 'FRAMING_UNEXPECTED']);
    const zeros = await send(executors.default, withFreshPresentation(editHeaders(post, 'content-length', () => 'Content-Length: 00'), NO_BODY.digest));
    assert.equal(zeros.assessment.outcome, 'refused');
    assert.ok(['FRAMING_UNEXPECTED', 'HTTP_MALFORMED'].includes(zeros.assessment.code), zeros.assessment.code);
    const del = parseRaw(await captureHostBytes(withPresentation(DELETE.request, present(DELETE.digest))));
    assert.equal((await send(executors.default, withFreshPresentation(del, DELETE.digest))).assessment.outcome, 'assessed-eligible');
    const delWithLength = await send(executors.default, withFreshPresentation(addHeaderLines(del, 'Content-Length: 0'), DELETE.digest));
    assert.deepEqual([delWithLength.assessment.stage, delWithLength.assessment.code], ['verification', 'ACTION_BINDING_MISMATCH']);
  });
});

describe('G-02C1A process — every relevant field, mutated in the real bytes, is detected', () => {
  let base: RawRequest;
  let encoded: RawRequest;
  before(async () => {
    base = parseRaw(await captureHostBytes(withPresentation(BASE.request, present(BASE.digest))));
    encoded = parseRaw(await captureHostBytes(withPresentation(ENCODED.request, present(ENCODED.digest, { resource: ENCODED_RESOURCE }))));
  });

  const bodyText = (raw: RawRequest): string => raw.body.toString('utf8');
  const replaceBody = (raw: RawRequest, from: string, to: string): RawRequest => {
    assert.ok(bodyText(raw).includes(from), from);
    return withBody(raw, Buffer.from(bodyText(raw).replace(from, to), 'utf8'));
  };
  const line = (raw: RawRequest, find: string | RegExp, to: string): RawRequest => {
    assert.ok(raw.requestLine.search(find) !== -1, String(find));
    return { ...raw, requestLine: raw.requestLine.replace(find, to) };
  };

  it('control: the captured bytes, freshly presented, are eligible', async () => {
    const control = await send(executors.default, withFreshPresentation(base, BASE.digest));
    assert.deepEqual([control.status, control.assessment.outcome, control.assessment.bindingDigest], [409, 'assessed-eligible', BASE.digest]);
    assert.equal((await send(executors.default, withFreshPresentation(encoded, ENCODED.digest, { resource: ENCODED_RESOURCE }))).assessment.outcome, 'assessed-eligible');
  });

  it('header-name case is not a mutation: names compare case-insensitively, as HTTP defines them', async () => {
    const recased = editHeaders(base, 'x-release-channel', (header) => header.replace('x-release-channel', 'X-RELEASE-CHANNEL'));
    assert.equal((await send(executors.default, withFreshPresentation(recased, BASE.digest))).assessment.outcome, 'assessed-eligible');
  });

  const otherHost = hostVector('the base request for another hostname', { origin: 'https://other.executor.example', query: { strategy: PARAMETER('strategy') }, headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' }, 'X-Counterparty': { kind: 'source', source: 'counterparty' }, 'X-Release-Channel': { kind: 'literal', value: 'stable' }, 'X-Tenant': { kind: 'source', source: 'organization' }, Accept: { kind: 'literal', value: 'application/json' } }, body: BODY });
  const otherPort = hostVector('the base request for another port', { origin: `https://${HOSTNAME}:${String(NONDEFAULT_PORT)}`, query: { strategy: PARAMETER('strategy') }, headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' }, 'X-Counterparty': { kind: 'source', source: 'counterparty' }, 'X-Release-Channel': { kind: 'literal', value: 'stable' }, 'X-Tenant': { kind: 'source', source: 'organization' }, Accept: { kind: 'literal', value: 'application/json' } }, body: BODY });
  const renamedCredential = digestOfRecord({ ...genericHttpRequestBinding(BASE.plan, BASE.request), credentialHeader: 'x-api-key' });

  const MUTATIONS: readonly (readonly [string, (raw: RawRequest) => RawRequest, ReferenceExecutorAssessment['stage'], ReferenceExecutorAssessment['code'], (string | undefined)?, Parameters<typeof capabilityFor>[1]?])[] = [
    ['method', (raw) => line(raw, /^POST /, 'PUT '), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['hostname (Host rewritten)', (raw) => editHeaders(raw, 'host', () => 'Host: other.executor.example'), 'admission', 'HOST_MISMATCH'],
    ['port (Host rewritten)', (raw) => editHeaders(raw, 'host', () => `Host: ${HOSTNAME}:${String(NONDEFAULT_PORT)}`), 'admission', 'HOST_MISMATCH'],
    ['hostname (signed for another origin, Host rewritten to this one)', (raw) => raw, 'verification', 'ACTION_BINDING_MISMATCH', otherHost.digest],
    ['port (signed for another port, Host rewritten to this one)', (raw) => raw, 'verification', 'ACTION_BINDING_MISMATCH', otherPort.digest],
    ['path', (raw) => line(raw, `/deployments/${RESOURCE}`, '/deployments/cluster-eu-2'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['path with a dot-segment (never normalized)', (raw) => line(raw, '/v1/deployments/', '/v1/x/../deployments/'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['query value', (raw) => line(raw, 'strategy=rolling', 'strategy=recreate'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['query parameter added', (raw) => line(raw, 'strategy=rolling', 'strategy=rolling&dryRun=false'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['header name', (raw) => editHeaders(raw, 'x-release-channel', (header) => header.replace('x-release-channel', 'x-release-chanel')), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['header value', (raw) => editHeaders(raw, 'x-release-channel', () => 'x-release-channel: canary'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['header removed', (raw) => editHeaders(raw, 'x-tenant', () => null), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['duplicate header', (raw) => addHeaderLines(raw, 'x-release-channel: stable'), 'admission', 'HEADER_DUPLICATED'],
    ['duplicate header in another case', (raw) => addHeaderLines(raw, 'X-Release-Channel: canary'), 'admission', 'HEADER_DUPLICATED'],
    ['unexpected extra header', (raw) => addHeaderLines(raw, 'x-extra: 1'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['a proxy’s X-Forwarded-For', (raw) => addHeaderLines(raw, 'X-Forwarded-For: 203.0.113.9'), 'admission', 'PROXY_REWRITE_REFUSED'],
    ['a proxy’s Via', (raw) => addHeaderLines(raw, 'Via: 1.1 edge-proxy'), 'admission', 'PROXY_REWRITE_REFUSED'],
    ['body, same length', (raw) => replaceBody(raw, '7500', '7501'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['body, re-serialized JSON (never reparsed)', (raw) => withBody(raw, Buffer.from(JSON.stringify(JSON.parse(bodyText(raw)) as unknown, null, 1), 'utf8')), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['body, an escape for a character', (raw) => replaceBody(raw, 'release-bot', 'r\\u0065lease-bot'), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['body, a byte-order mark', (raw) => withBody(raw, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw.body])), 'verification', 'ACTION_BINDING_MISMATCH'],
    ['body encoding, invalid UTF-8', (raw) => ({ ...raw, body: Buffer.concat([raw.body.subarray(0, 5), Buffer.from([0xff]), raw.body.subarray(6)]) }), 'admission', 'BODY_NOT_UTF8'],
    ['body encoding, a content coding', (raw) => addHeaderLines(raw, 'Content-Encoding: gzip'), 'admission', 'CONTENT_ENCODING_UNSUPPORTED'],
    ['content-length, chunked framing instead', (raw) => ({ ...addHeaderLines(editHeaders(raw, 'content-length', () => null), 'Transfer-Encoding: chunked'), body: Buffer.from(`${raw.body.length.toString(16)}\r\n${bodyText(raw)}\r\n0\r\n\r\n`, 'utf8') }), 'admission', 'FRAMING_UNSUPPORTED'],
    ['credential header name (bound in the signed record)', (raw) => raw, 'verification', 'ACTION_BINDING_MISMATCH', renamedCredential],
    ['credential value', (raw) => editHeaders(raw, 'authorization', () => `authorization: Bearer ${BEARER}x`), 'credential', 'CLIENT_UNAUTHENTICATED'],
    ['credential header renamed on the wire', (raw) => editHeaders(raw, 'authorization', (header) => header.replace(/^authorization/i, 'x-authorization')), 'admission', 'CLIENT_CREDENTIAL_MISSING'],
    ['presentation missing', (raw) => editHeaders(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, () => null), 'admission', 'PRESENTATION_MISSING'],
    ['presentation duplicated', (raw) => addHeaderLines(raw, raw.headerLines.find((header) => header.startsWith(EXECUTION_CAPABILITY_PRESENTATION_HEADER)) ?? ''), 'admission', 'HEADER_DUPLICATED'],
    ['presentation corrupted', (raw) => editHeaders(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, (header) => `${header}!`), 'presentation', 'PRESENTATION_ENCODING_INVALID'],
    ['presentation for another request', (raw) => raw, 'verification', 'ACTION_BINDING_MISMATCH', NO_BODY.digest],
    ['issuer, unknown', (raw) => raw, 'policy', 'ISSUER_NOT_PINNED', undefined, { issuer: 'frontera-deployment-unknown' }],
    ['issuer, another pinned issuer under this key', (raw) => raw, 'verification', 'ISSUER_KEY_MISMATCH', undefined, { issuer: OTHER_ISSUER }],
    ['audience', (raw) => raw, 'policy', 'AUDIENCE_NOT_THIS_EXECUTOR', undefined, { audience: 'executor-elsewhere' }],
    ['organization', (raw) => raw, 'policy', 'ORGANIZATION_NOT_PERMITTED', undefined, { organizationId: 'org-elsewhere' }],
    ['trust domain', (raw) => raw, 'policy', 'TRUST_DOMAIN_NOT_PERMITTED', undefined, { trustDomain: 'trust-domain-elsewhere' }],
    ['expired', (raw) => raw, 'verification', 'CAPABILITY_EXPIRED', undefined, { issuedAt: new Date(Date.now() - 40_000).toISOString(), expiresAt: new Date(Date.now() - 10_000).toISOString() }],
    ['GET (the Host has no GET)', (raw) => line(raw, /^POST /, 'GET '), 'admission', 'METHOD_NOT_PERMITTED'],
    ['HTTP/1.0', (raw) => line(raw, / HTTP\/1\.1$/, ' HTTP/1.0'), 'admission', 'HTTP_VERSION_UNSUPPORTED'],
    ['an absolute-form target', (raw) => line(raw, /^POST \//, `POST https://${HOSTNAME}/`), 'admission', 'REQUEST_TARGET_INVALID'],
  ];

  for (const [name, mutate, stage, code, digest, overrides] of MUTATIONS) {
    it(`${name} → ${stage} / ${code}`, async () => {
      // Presented fresh for the base digest (or the one named), then mutated: only the mutation separates it from the eligible control.
      const presentedRaw = withFreshPresentation(base, digest ?? BASE.digest, overrides ?? {});
      const mutated = name.startsWith('presentation') ? mutate(presentedRaw) : withFreshPresentation(mutate(base), digest ?? BASE.digest, overrides ?? {});
      const { status, assessment } = await send(executors.default, mutated);
      assert.deepEqual({ outcome: assessment.outcome, stage: assessment.stage, code: assessment.code }, { outcome: 'refused', stage, code });
      assert.ok(status !== undefined && status >= 400 && status < 500, `refused with a 4xx, not ${String(status)}`);
    });
  }

  it('percent-encoding case is a mutation: %C3%A9 and %c3%a9 are different targets to this executor', async () => {
    assert.ok(encoded.requestLine.includes('%C3%A9'));
    const lower = { ...encoded, requestLine: encoded.requestLine.replace('%C3%A9', '%c3%a9') };
    const { assessment } = await send(executors.default, withFreshPresentation(lower, ENCODED.digest, { resource: ENCODED_RESOURCE }));
    assert.deepEqual([assessment.stage, assessment.code], ['verification', 'ACTION_BINDING_MISMATCH']);
  });

  it('a status-required capability verifies and is still never eligible (403)', async () => {
    const { status, assessment } = await send(executors.default, withFreshPresentation(base, BASE.digest, { statusRequirement: 'online-status-required' }));
    assert.deepEqual([status, assessment.outcome, assessment.code], [403, 'assessed-ineligible', 'STATUS_REQUIRED_UNAVAILABLE']);
  });

  it('framing the strict parser refuses: Content-Length with Transfer-Encoding, and a leading-zero length', async () => {
    const both = await send(executors.default, withFreshPresentation(addHeaderLines(base, 'Transfer-Encoding: chunked'), BASE.digest));
    assert.equal(both.assessment.outcome, 'refused');
    assert.ok(['HTTP_MALFORMED', 'FRAMING_UNSUPPORTED'].includes(both.assessment.code), both.assessment.code);
    const zero = await send(executors.default, withFreshPresentation(editHeaders(base, 'content-length', () => `content-length: 0${String(base.body.length)}`), BASE.digest));
    assert.equal(zero.assessment.outcome, 'refused');
    assert.ok(['ACTION_BINDING_MISMATCH', 'HTTP_MALFORMED'].includes(zero.assessment.code), zero.assessment.code);
  });
});

describe('G-02C1A process — smuggling, upgrades and bounds', () => {
  let base: RawRequest;
  before(async () => {
    base = parseRaw(await captureHostBytes(withPresentation(BASE.request, present(BASE.digest))));
  });

  const head = (lines: readonly string[]): Buffer => Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  /** Everything the executor reported for one connection carrying `bytes` (at least `minimum` assessments, then a short settle). */
  const reported = async (executor: SpawnedExecutor, bytes: Buffer, minimum = 1): Promise<readonly ReferenceExecutorAssessment[]> => {
    const before = executor.assessments.length;
    const response = await rawExchange(executor.port, bytes);
    answered.push(response.head, response.body);
    if (minimum > 0) await executor.waitForAssessments(before + minimum);
    await new Promise((settle) => setTimeout(settle, 300));
    return executor.assessments.slice(before);
  };
  /** A second request on one connection: refused by the gateway, or by the strict parser (data after `Connection: close`). */
  const SECOND_REQUEST_REFUSALS: readonly string[] = ['REQUEST_PIPELINED', 'HTTP_MALFORMED'];

  it('a second request on the same connection is refused and never verified — Host-shaped (Connection: close) or keep-alive', async () => {
    const first = serializeRaw(withFreshPresentation(base, BASE.digest));
    const second = serializeRaw(withFreshPresentation(editHeaders(base, 'x-release-channel', () => 'x-release-channel: canary'), BASE.digest));
    const closing = await reported(executors.default, Buffer.concat([first, second]));
    assert.ok(closing.some((assessment) => SECOND_REQUEST_REFUSALS.includes(assessment.code)), JSON.stringify(closing));
    assert.equal(closing.some((assessment) => assessment.code === 'ACTION_BINDING_MISMATCH'), false, 'the second request reached no verification');
    // Keep-alive reaches the gateway's own one-request-per-connection rule.
    const keepAlive = (raw: RawRequest): RawRequest => editHeaders(raw, 'connection', () => 'Connection: keep-alive');
    const pipelined = await reported(executors.default, Buffer.concat([serializeRaw(keepAlive(withFreshPresentation(base, BASE.digest))), serializeRaw(keepAlive(withFreshPresentation(base, BASE.digest)))]));
    assert.ok(pipelined.some((assessment) => assessment.code === 'REQUEST_PIPELINED'), JSON.stringify(pipelined));
    assert.equal(pipelined.some((assessment) => assessment.outcome !== 'refused'), false);
  });

  it('a request hidden after a body-less request is a second request, and is refused', async () => {
    const post = parseRaw(await captureHostBytes(withPresentation(NO_BODY.request, present(NO_BODY.digest))));
    const smuggled = Buffer.concat([serializeRaw(withFreshPresentation(post, NO_BODY.digest)), head(['POST /v1/admin HTTP/1.1', `Host: ${HOSTNAME}`, 'Connection: close', `authorization: Bearer ${BEARER}`])]);
    const assessments = await reported(executors.default, smuggled);
    assert.ok(assessments.some((assessment) => SECOND_REQUEST_REFUSALS.includes(assessment.code)), JSON.stringify(assessments));
    assert.equal(assessments.filter((assessment) => assessment.outcome === 'assessed-eligible').length <= 1, true, 'at most the first, exact request');
  });

  it('HTTP/2 prior knowledge, an h2c or WebSocket upgrade, CONNECT and Expect are refused before a handler', async () => {
    const h2 = await reported(executors.default, Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1'), 0);
    assert.ok(h2.every((assessment) => assessment.outcome === 'refused'), JSON.stringify(h2));
    const websocket = await reported(executors.default, head(['GET /v1/deployments HTTP/1.1', `Host: ${HOSTNAME}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']));
    assert.equal(websocket[0]?.code, 'UPGRADE_REFUSED');
    const h2c = await reported(executors.default, head(['POST /v1/deployments HTTP/1.1', `Host: ${HOSTNAME}`, 'Connection: Upgrade, HTTP2-Settings', 'Upgrade: h2c', 'HTTP2-Settings: AAMAAABkAAQAAP__']));
    assert.equal(h2c[0]?.code, 'UPGRADE_REFUSED');
    const tunnel = await reported(executors.default, head([`CONNECT ${HOSTNAME}:443 HTTP/1.1`, `Host: ${HOSTNAME}:443`]));
    assert.equal(tunnel[0]?.code, 'METHOD_NOT_PERMITTED');
    const before = executors.default.assessments.length;
    const expect = await rawExchange(executors.default.port, serializeRaw(withFreshPresentation(addHeaderLines(base, 'Expect: 100-continue'), BASE.digest)));
    await executors.default.waitForAssessments(before + 1);
    assert.equal(expect.status, 417);
    assert.equal(executors.default.assessments[before]?.code, 'EXPECTATION_REFUSED');
  });

  it('a folded header line is refused, or bound as the parser joined it — never accepted as the original', async () => {
    const folded = { ...base, headerLines: base.headerLines.map((header) => (header.startsWith('x-release-channel') ? `${header}\r\n continued` : header)) };
    const assessments = await reported(executors.default, serializeRaw(withFreshPresentation(folded, BASE.digest)), 0);
    assert.ok(assessments.every((assessment) => assessment.outcome === 'refused'), JSON.stringify(assessments));
  });

  it('bounds: a body, a header block, a header count and a presentation over their limits', async () => {
    const big = Buffer.alloc(70 * 1024, 0x61);
    const body = await send(executors.default, withFreshPresentation(withBody(base, big), BASE.digest));
    assert.deepEqual([body.status, body.assessment.code], [413, 'BODY_TOO_LARGE']);
    const block = await send(executors.default, withFreshPresentation(addHeaderLines(base, `x-padding: ${'p'.repeat(40 * 1024)}`), BASE.digest));
    assert.deepEqual([block.status, block.assessment.code], [431, 'HEADERS_TOO_LARGE']);
    const count = await send(executors.default, withFreshPresentation(addHeaderLines(base, ...Array.from({ length: 48 }, (_, index) => `x-filler-${String(index)}: x`)), BASE.digest));
    assert.deepEqual([count.status, count.assessment.code], [431, 'HEADER_COUNT_EXCEEDED']);
    const presentation = await send(executors.default, editHeaders(base, EXECUTION_CAPABILITY_PRESENTATION_HEADER, () => `${EXECUTION_CAPABILITY_PRESENTATION_HEADER}: ${'A'.repeat(9_000)}`));
    assert.deepEqual([presentation.status, presentation.assessment.code], [403, 'PRESENTATION_TOO_LARGE']);
  });

  it('a request that never finishes is cut off by the processing bound, unanswered', async () => {
    const before = executors.default.assessments.length;
    const started = Date.now();
    const partial = serializeRaw(withFreshPresentation(base, BASE.digest)).subarray(0, -5);
    const response = await rawExchange(executors.default.port, partial, 9_000);
    await executors.default.waitForAssessments(before + 1, 9_000);
    assert.equal(executors.default.assessments[before]?.code, 'PROCESSING_TIMEOUT');
    assert.equal(response.status, undefined, 'no answer: the socket is closed');
    assert.ok(Date.now() - started < 9_000);
  });
});

describe('G-02C1A process — separation: the executor holds public trust only', () => {
  it('the executor is its own process, started with only PATH, its configuration file and its credential variables', () => {
    for (const executor of Object.values(executors)) {
      assert.notEqual(executor.pid, process.pid);
      assert.deepEqual(Object.keys(executor.environment).sort(), [BEARER_ENV, CONFIG_VARIABLE, HEADER_CREDENTIAL_ENV, 'PATH'].sort());
      for (const value of Object.values(executor.environment)) assert.equal(/PRIVATE KEY/.test(value), false);
      const config = readFileSync(executor.configPath, 'utf8');
      assert.ok(config.includes('-----BEGIN PUBLIC KEY-----'));
      assert.equal(/PRIVATE KEY/.test(config), false, 'the configuration holds no private key');
      assert.equal(config.includes(BEARER) || config.includes(HEADER_CREDENTIAL), false, 'the configuration names the credential variable, not its value');
    }
  });

  it('at runtime the executor loads only its own closure: no Host, Kernel, grant, store or signing module', () => {
    const launcher = resolve('dist/src/enterprise/reference-executor/launcher.js');
    const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(launcher)}); process.stdout.write(JSON.stringify(Object.keys(require.cache)))`], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const root = resolve('dist/src').replace(/\\/g, '/');
    const loaded = (JSON.parse(probe.stdout) as string[]).map((file) => file.replace(/\\/g, '/'));
    assert.ok(loaded.every((file) => file.startsWith(`${root}/`)), 'no package outside dist/src is loaded');
    assert.deepEqual(loaded.map((file) => file.slice(root.length + 1)).sort(), [
      'enterprise/authority-authenticity/errors.js',
      'enterprise/authority-authenticity/signature-envelope.js',
      'enterprise/authority-authenticity/signature-verification.js',
      'enterprise/execution-capability-presentation/index.js',
      'enterprise/execution-capability-presentation/presentation.js',
      'enterprise/execution-capability/capability.js',
      'enterprise/execution-capability/index.js',
      'enterprise/execution-capability/verifier.js',
      'enterprise/governance-store/canonical-json.js',
      'enterprise/governance-store/digest.js',
      'enterprise/reference-executor/admission.js',
      'enterprise/reference-executor/binding-reconstruction.js',
      'enterprise/reference-executor/configuration.js',
      'enterprise/reference-executor/gateway.js',
      'enterprise/reference-executor/launcher.js',
      'enterprise/reference-executor/verification-pipeline.js',
    ]);
  });

  it('a configuration the executor must refuse stops it at boot, with a code and no value', async () => {
    const privatePem = ISSUER_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const cases: readonly (readonly [string, Record<string, unknown>, string, Readonly<Record<string, string>>?])[] = [
      ['a wildcard audience', executorConfiguration({ audience: '*' }), 'IDENTITY_INVALID'],
      ['a public listener', executorConfiguration({ listen: { host: '0.0.0.0', port: 0 } }), 'RUNTIME_UNSAFE'],
      ['a production environment', executorConfiguration({ environment: 'production' }), 'ENVIRONMENT_UNSUPPORTED'],
      ['a private key pinned as trust', executorConfiguration({ trustedIssuers: [{ issuer: 'frontera-deployment-g02c1a', keys: [{ ...pin(ISSUER_KEY), publicKeyPem: privatePem }] }] }), 'PUBLIC_KEY_INVALID'],
      ['a status-required policy', executorConfiguration({ statusPolicy: 'online-required' }), 'STATUS_POLICY_UNSUPPORTED'],
      ['no credential value', executorConfiguration(), 'CREDENTIAL_INVALID', {}],
    ];
    for (const [name, config, code, environment] of cases) {
      const refused = await refusedStart(config, environment);
      assert.equal(refused.code, 1, name);
      assert.deepEqual([refused.refusal.event, refused.refusal.code], ['refused-to-start', code], name);
      assert.equal(refused.stdout, '', `${name}: no ready line`);
      for (const secret of [BEARER, 'PRIVATE KEY', 'BEGIN']) assert.equal(refused.stderr.includes(secret), false, `${name}: ${secret}`);
    }
  });
});

describe('G-02C1A process — diagnostics never carry a secret or a capability', () => {
  it('nothing the executor wrote, and nothing it answered, contains the credential, a presentation, a capability or a body', () => {
    const written = Object.values(executors)
      .map((executor) => `${executor.stdout()}\n${executor.stderr()}`)
      .join('\n');
    const responses = answered.join('\n');
    assert.ok(ISSUED_PRESENTATIONS.length > 40, 'the suite presented capabilities');
    for (const [where, text] of [
      ['stdout and stderr', written],
      ['responses', responses],
    ] as const) {
      for (const secret of [BEARER, HEADER_CREDENTIAL, 'PRIVATE KEY', 'capabilityId', 'grantReference', 'agent:release-bot', 'vendor-0042', '"amount"']) assert.equal(text.includes(secret), false, `${where}: ${secret}`);
      for (const value of ISSUED_PRESENTATIONS) assert.equal(text.includes(value.slice(0, 64)) || text.includes(value.slice(-64)), false, `${where}: a presentation`);
    }
    for (const line of written.split('\n').filter((entry) => entry.length > 0)) {
      const event = JSON.parse(line) as Record<string, unknown>;
      assert.ok(event['event'] === 'ready' || event['event'] === 'assessment', line);
      if (event['event'] === 'assessment') assert.deepEqual(Object.keys(event).sort(), ['bindingDigest', 'code', 'event', 'mode', 'outcome', 'stage']);
    }
  });
});
