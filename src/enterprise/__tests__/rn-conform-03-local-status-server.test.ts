import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { LOCAL_STATUS_SERVER_ENABLEMENT, LocalStatusServerError, startLocalStatusServer } from '../conformance-status-local/server.js';
import { createFixedWindowRateLimiter, createStatusHttpHandler, type StatusHttpRequest } from '../conformance/status-http.js';
import { activeCredential, cleanupAll } from './conformance-support.js';
import { buildStatusCircuit, freshNonce, type StatusCircuit } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 / WP-08, WP-09 — the read-only status binding (pure handler)
 * and its loopback-only, disabled-by-default local listener.
 *
 * This file intentionally uses loopback HTTP and is therefore not named
 * `conformance-*` (the RN-CONFORM-02 structure suite forbids network code in
 * those). Every connection is to 127.0.0.1 on an ephemeral port.
 */

after(cleanupAll);

const handlerFor = (s: StatusCircuit, limit = 1000) => createStatusHttpHandler({ registry: s.registry, clock: s.c.clock, rateLimiter: createFixedWindowRateLimiter({ limit, windowMs: 60_000 }) });
const req = (over: Partial<StatusHttpRequest>): StatusHttpRequest => ({ method: 'GET', url: '/conformance/v1/keys', contentType: null, body: null, clientKey: '127.0.0.1', ...over });
const post = (body: string, contentType = 'application/json') => req({ method: 'POST', url: '/conformance/v1/status', contentType, body });

function httpCall(port: number, options: { method?: string; path: string; body?: string; host?: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, unknown>; body: string } | { error: string }> {
  return new Promise((settle) => {
    const r = request(
      { host: '127.0.0.1', port, agent: false, method: options.method ?? 'GET', path: options.path, headers: { host: options.host ?? `127.0.0.1:${port}`, connection: 'close', ...(options.headers ?? {}) }, timeout: options.timeoutMs ?? 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => settle({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('timeout', () => {
      r.destroy();
      settle({ error: 'timeout' });
    });
    r.on('error', (e) => settle({ error: e.message }));
    if (options.body !== undefined) r.write(options.body);
    r.end();
  });
}

describe('RN-CONFORM-03 status HTTP binding (pure handler)', () => {
  it('serves the four read-only routes with strict schemas, size limits, cache rules and no unsigned state', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const handle = handlerFor(s);
    const nonce = freshNonce();
    const online = handle(post(JSON.stringify(s.onlineRequest(credentialId, nonce))));
    assert.equal(online.status, 200);
    assert.equal(online.headers['cache-control'], 'no-store');
    assert.equal(online.headers['x-conformance-designation'], 'SYNTHETIC-NON-PRODUCTION');
    assert.equal(s.verify(online.body, credentialId, { kind: 'online', nonce }).result, 'CONFORMANT');

    const stapled = handle(req({ url: `/conformance/v1/credentials/${credentialId}/status` }));
    assert.equal(stapled.status, 200);
    const maxAge = Number(/^public, max-age=(\d+)$/.exec(stapled.headers['cache-control'] ?? '')?.[1]);
    const validUntil = Date.parse(String((JSON.parse(stapled.body) as { validUntil: string }).validUntil));
    assert.ok(maxAge > 0 && maxAge * 1000 <= validUntil - s.c.clock.ms(), 'cacheable no longer than the remaining signed validity');

    const transitions = handle(req({ url: `/conformance/v1/credentials/${credentialId}/transitions?after=0&limit=10` }));
    assert.equal(transitions.status, 200);
    assert.deepEqual((JSON.parse(transitions.body) as { transitions: { stateVersion: number }[] }).transitions.map((t) => t.stateVersion), [1, 2]);
    const keys = handle(req({}));
    assert.equal(keys.status, 200);
    assert.ok(!keys.body.includes('PRIVATE') && keys.body.includes('BEGIN PUBLIC KEY'));

    // Privacy-minimal (CC-D-13): no evidence, validator, operator, human or decision data in any public response.
    for (const body of [online.body, stapled.body, transitions.body]) {
      for (const leak of ['evidenceDigest', 'validator-', 'op-synthetic', 'human-', 'decisionId', 'submissionJson', 'observation', 'PRIVATE KEY']) assert.ok(!body.includes(leak), `leaks ${leak}`);
    }

    // Refusals and errors.
    const statusOf = (r: StatusHttpRequest) => handle(r).status;
    assert.equal(statusOf(req({ method: 'POST', url: '/conformance/v1/keys', body: '' })), 405);
    assert.equal(statusOf(req({ method: 'DELETE', url: `/conformance/v1/credentials/${credentialId}/status` })), 405);
    assert.equal(statusOf(req({ method: 'PUT', url: '/conformance/v1/status', body: '{}' })), 405);
    assert.equal(statusOf(req({ url: '/conformance/v1/credentials' })), 404);
    assert.equal(statusOf(req({ url: '/api/v1/anything' })), 404);
    assert.equal(statusOf(post(JSON.stringify(s.onlineRequest(credentialId)), 'text/plain')), 415);
    assert.equal(statusOf(post('x'.repeat(5000))), 413);
    assert.equal(statusOf(post('{not json')), 400);
    assert.equal(statusOf(post(JSON.stringify({ ...s.onlineRequest(credentialId), state: 'ACTIVE' }))), 400);
    assert.equal(statusOf(post(JSON.stringify({ ...s.onlineRequest(credentialId), nonce: 'short' }))), 400);
    assert.equal(statusOf(req({ url: `/conformance/v1/credentials/${credentialId}/transitions?limit=51` })), 400);
    assert.equal(statusOf(req({ url: `/conformance/v1/credentials/${credentialId}/transitions?offset=1` })), 400);
    assert.equal(statusOf(req({ url: `/conformance/v1/credentials/${credentialId}/status?fresh=1` })), 400);
    assert.equal(statusOf(req({ url: '/conformance/v1/credentials/crd_unknown/status' })), 404);
    assert.equal(statusOf(req({ url: `/conformance/v1/credentials/${'x'.repeat(600)}/status` })), 414);
    const mismatch = handle(post(JSON.stringify(s.onlineRequest(credentialId, freshNonce(), { platformId: 'platform-synthetic-beta' }))));
    assert.deepEqual([mismatch.status, (JSON.parse(mismatch.body) as { result: string }).result, mismatch.headers['cache-control']], [200, 'SUBJECT_MISMATCH', 'no-store'], 'a signed refusal');

    // Signer outage: an explicit unsigned UNAVAILABLE that cannot be mistaken for a status.
    s.signer.setAvailable(false);
    const down = handle(post(JSON.stringify(s.onlineRequest(credentialId))));
    assert.deepEqual([down.status, JSON.parse(down.body), down.headers['cache-control']], [503, { error: 'UNAVAILABLE', signed: false }, 'no-store']);
    assert.equal(s.verify(down.body, credentialId, { kind: 'stapled' }).conformant, false);
    s.cleanup();
  });

  it('rate-limits per client key', () => {
    const s = buildStatusCircuit();
    const handle = handlerFor(s, 3);
    const codes = [1, 2, 3, 4].map(() => handle(req({})).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.equal(handle(req({ clientKey: '::1' })).status, 200, 'another client is unaffected');
    s.cleanup();
  });
});

describe('RN-CONFORM-03 local listener: disabled by default, loopback only (WP-08, INV-12)', () => {
  it('refuses to start without the explicit enablement or on a non-loopback address', async () => {
    const s = buildStatusCircuit();
    const handle = handlerFor(s);
    const refused = async (options: Parameters<typeof startLocalStatusServer>[0], code: string) =>
      assert.rejects(() => startLocalStatusServer(options), (e: unknown) => e instanceof LocalStatusServerError && e.code === code);
    await refused({ handle }, 'NOT_ENABLED');
    await refused({ handle, enable: 'true' }, 'NOT_ENABLED');
    for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10', 'example.com']) await refused({ handle, enable: LOCAL_STATUS_SERVER_ENABLEMENT, host }, 'NOT_LOOPBACK');
    s.cleanup();
  });

  it('answers over loopback HTTP, refuses a foreign Host header and oversized bodies; network failures never yield a status', async () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const server = await startLocalStatusServer({ handle: handlerFor(s), enable: LOCAL_STATUS_SERVER_ENABLEMENT });
    try {
      assert.equal(server.host, '127.0.0.1');
      const nonce = freshNonce();
      const ok = await httpCall(server.port, { method: 'POST', path: '/conformance/v1/status', body: JSON.stringify(s.onlineRequest(credentialId, nonce)), headers: { 'content-type': 'application/json' } });
      assert.ok('status' in ok && ok.status === 200);
      assert.equal('body' in ok && s.verify(ok.body, credentialId, { kind: 'online', nonce }).result, 'CONFORMANT');
      const rebinding = await httpCall(server.port, { path: '/conformance/v1/keys', host: 'attacker.example:80' });
      assert.ok('status' in rebinding && rebinding.status === 421);
      const big = await httpCall(server.port, { method: 'POST', path: '/conformance/v1/status', body: 'x'.repeat(8 * 1024), headers: { 'content-type': 'application/json' } });
      assert.ok(('status' in big && big.status === 413) || 'error' in big, 'refused or reset');
    } finally {
      await server.close();
    }
    // After close: connection refused — no artifact, never conformant.
    const gone = await httpCall(server.port, { path: '/conformance/v1/keys' });
    assert.ok('error' in gone);
    assert.equal(s.verify(undefined, credentialId, { kind: 'stapled' }).conformant, false);
    // A peer that accepts and never answers: the client times out; nothing to verify.
    const held: Socket[] = [];
    const silent = createTcpServer((socket) => held.push(socket));
    await new Promise<void>((settle) => silent.listen(0, '127.0.0.1', () => settle()));
    const timedOut = await httpCall((silent.address() as AddressInfo).port, { path: '/conformance/v1/keys', timeoutMs: 200 });
    assert.deepEqual(timedOut, { error: 'timeout' });
    for (const socket of held) socket.destroy();
    await new Promise<void>((settle) => silent.close(() => settle()));
    s.cleanup();
  });
});

describe('RN-CONFORM-03 scope and exposure (INV-12, §17 Scope)', () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : walk(path);
      return /\.(ts|mts|mjs|js|json|ya?ml)$/.test(name) ? [path] : [];
    });

  it('the listener and its enablement literal are referenced by nothing but this test; no Host, configuration, script or deployment starts it', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, '.github')), ...readdirSync(ROOT).filter((f) => /\.(json|ya?ml|js|mjs)$/.test(f)).map((f) => join(ROOT, f))];
    const self = join(ROOT, 'src', 'enterprise', '__tests__', 'rn-conform-03-local-status-server.test.ts');
    const server = join(ROOT, 'src', 'enterprise', 'conformance-status-local', 'server.ts');
    const offenders = files.filter((f) => f !== self && f !== server).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return text.includes('conformance-status-local') || text.includes(LOCAL_STATUS_SERVER_ENABLEMENT);
    });
    // Two files may name the directory: the PAY-07 CORE manifest (classification) and the RN-CONFORM-02 structure suite (its allowlist).
    assert.deepEqual(offenders.map((f) => relative(ROOT, f)).filter((f) => !f.endsWith('pay07-core-source-manifest.ts') && !f.endsWith('conformance-structure.test.ts')), []);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.ok(!JSON.stringify(pkg.exports ?? {}).includes('conformance'), 'no package export');
    assert.ok(!Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).some((d) => /xrpl|ripple|fileverse/i.test(d)), 'no ledger or Fileverse client dependency');
    const freeze = readFileSync(join(ROOT, 'release', 'api-surface.v1.json'), 'utf8');
    assert.ok(!freeze.includes('/conformance/'), 'not part of the frozen v1 Host API');
    assert.ok(!readFileSync(join(ROOT, 'src', 'enterprise', 'adapters', 'node-http-adapter.ts'), 'utf8').includes('/conformance/'), 'not routed by the Enterprise Host adapter');
    for (const f of readdirSync(ROOT)) assert.ok(!/^vercel\.json$|^\.vercel$/.test(f) || !readFileSync(join(ROOT, f), 'utf8').includes('conformance'), 'no deployment configuration');
  });
});
