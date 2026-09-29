import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { EXTERNAL_AUTHORITY_SIGNER_PATHS } from '../external-authority-signer/index.js';
import { startFaultProxy, type FaultProxy } from './core02-external-signer-fixture.js';

/**
 * CORE-02R — the fault-injecting signer proxy used by the review-hardening
 * suites is itself a network forwarder, so it must not be one an inbound
 * request can steer (CodeQL js/request-forgery). It forwards exactly the six
 * protocol routes, each with its protocol method, to a fixture-owned target,
 * and refuses everything else locally with zero upstream requests.
 *
 * Requests are written on a raw socket so the request-target reaches the proxy
 * exactly as an attacker would send it (absolute-form, scheme-relative, query,
 * fragment, dot-segments) — an HTTP client library would normalize some of
 * these away and prove nothing.
 */

interface Sentinel {
  readonly endpoint: string;
  readonly seen: { method: string; url: string }[];
  close(): Promise<void>;
}

async function sentinel(): Promise<Sentinel> {
  const seen: { method: string; url: string }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One raw HTTP/1.1 request; resolves the status code (0 if the connection closed without one). */
function raw(endpoint: string, method: string, target: string, body = ''): Promise<number> {
  const { port } = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    let answer = '';
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
    });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0)));
    socket.on('error', reject);
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
}

const SIGNING_PATHS = Object.entries(EXTERNAL_AUTHORITY_SIGNER_PATHS)
  .filter(([operation]) => operation !== 'identity')
  .map(([, path]) => path);

describe('CORE-02R — the signer fault proxy forwards only the closed protocol routes, and no inbound request can choose its upstream', () => {
  let upstream: Sentinel;
  let redirected: Sentinel;
  let attacker: Sentinel;
  let proxy: FaultProxy;
  const upstreamCalls = () => upstream.seen.length + redirected.seen.length + attacker.seen.length;

  before(async () => {
    upstream = await sentinel();
    redirected = await sentinel();
    attacker = await sentinel();
    proxy = await startFaultProxy(upstream.endpoint);
  });
  after(async () => {
    await proxy.close();
    await upstream.close();
    await redirected.close();
    await attacker.close();
  });

  it('exactly GET /v1/identity forwards, to the fixture-owned target, at the canonical path', async () => {
    assert.equal(await raw(proxy.endpoint, 'GET', '/v1/identity'), 200);
    assert.deepEqual(upstream.seen.at(-1), { method: 'GET', url: '/v1/identity' });
    assert.equal(proxy.identityCalls, 1);
  });

  it('each of the five signing paths forwards with POST', async () => {
    assert.equal(SIGNING_PATHS.length, 5);
    for (const path of SIGNING_PATHS) {
      assert.equal(await raw(proxy.endpoint, 'POST', path, '{}'), 200, path);
      assert.deepEqual(upstream.seen.at(-1), { method: 'POST', url: path });
    }
    assert.equal(proxy.signCalls, 5);
  });

  it('SSRF: absolute-form, scheme-relative, query, fragment, dot-segment, prefix-only and unknown request-targets are refused locally — zero upstream requests, and the attacker sentinel is never reached', async () => {
    const attackerHost = new URL(attacker.endpoint).host;
    const malicious = [
      `${attacker.endpoint}/v1/identity`,
      `${attacker.endpoint}/`,
      'http://attacker.example/',
      'http://attacker.example/v1/identity',
      `//${attackerHost}/v1/identity`,
      '//attacker.example/',
      '/v1/identity?x=1',
      '/v1/identity?',
      '/v1/identity#x',
      '/../v1/identity',
      '/v1/../v1/identity',
      '/v1/identity/',
      '/V1/IDENTITY',
      '/v1/sign/',
      '/v1/sign/grant/../../identity',
      '/v1/sign/grant?redirect=http://attacker.example/',
      '/v1/sign/other',
      '/v1/diagnostics/operations',
      '/',
      '*',
    ];
    const before = upstreamCalls();
    const refusedBefore = proxy.refused;
    for (const target of malicious) {
      const method = target.includes('/sign/') ? 'POST' : 'GET';
      const status = await raw(proxy.endpoint, method, target, method === 'POST' ? '{}' : '');
      // 404 from the proxy's route table, or 400 when Node's own parser rejects the target first; never forwarded either way.
      assert.ok(status === 404 || status === 400, `${target} → ${status}`);
    }
    assert.equal(upstreamCalls(), before, 'no malicious target produced an upstream request');
    assert.deepEqual(attacker.seen, [], 'the attacker sentinel was never contacted');
    assert.ok(proxy.refused - refusedBefore >= malicious.length - 2, 'refused by the proxy itself (Node may reject a couple first)');
    assert.equal(proxy.identityCalls, 1, 'refusals are not counted as protocol calls');
  });

  it('wrong method on a valid path → 405, zero upstream requests', async () => {
    const before = upstreamCalls();
    const cases: readonly [string, string][] = [
      ['POST', '/v1/identity'],
      ['PUT', '/v1/identity'],
      ['DELETE', '/v1/identity'],
      ...SIGNING_PATHS.flatMap((path): [string, string][] => [
        ['GET', path],
        ['PUT', path],
      ]),
    ];
    for (const [method, path] of cases) assert.equal(await raw(proxy.endpoint, method, path, method === 'GET' ? '' : '{}'), 405, `${method} ${path}`);
    assert.equal(upstreamCalls(), before);
  });

  it('the redirect fault redirects a VALID signing route only: identity still goes to the fixture target, and a malicious target reaches neither', async () => {
    proxy.redirectTarget = redirected.endpoint;
    proxy.fault = 'redirect';
    try {
      const upstreamBefore = upstream.seen.length;
      assert.equal(await raw(proxy.endpoint, 'POST', EXTERNAL_AUTHORITY_SIGNER_PATHS.signGrant, '{}'), 200);
      assert.deepEqual(redirected.seen, [{ method: 'POST', url: EXTERNAL_AUTHORITY_SIGNER_PATHS.signGrant }]);
      assert.equal(upstream.seen.length, upstreamBefore, 'the signing call went to the redirect target, not the primary');
      assert.equal(await raw(proxy.endpoint, 'GET', EXTERNAL_AUTHORITY_SIGNER_PATHS.identity), 200);
      assert.equal(upstream.seen.length, upstreamBefore + 1, 'identity is never redirected');
      assert.equal(redirected.seen.length, 1);
      for (const target of [`${attacker.endpoint}${EXTERNAL_AUTHORITY_SIGNER_PATHS.signGrant}`, '/v1/sign/grant?x=1', '/v1/sign/grants']) {
        assert.equal(await raw(proxy.endpoint, 'POST', target, '{}'), 404, target);
      }
      assert.equal(redirected.seen.length, 1);
      assert.deepEqual(attacker.seen, []);
    } finally {
      proxy.fault = 'pass';
      proxy.redirectTarget = undefined;
    }
  });
});
