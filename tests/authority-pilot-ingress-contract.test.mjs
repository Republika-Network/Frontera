// AUTH-04D1 — the Authority pilot ingress contract (deploy/authority-pilot/ingress-contract.json)
// agrees with what the gateway and the web client actually require. A specification
// only: nothing here deploys, resolves a name or opens a port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const CONTRACT_PATH = 'deploy/authority-pilot/ingress-contract.json';
const contract = JSON.parse(read(CONTRACT_PATH));
const gatewaySource = read('src/enterprise/authority-gateway/gateway.ts');
const route = (id) => contract.routes.find((entry) => entry.id === id);

test('one origin: the relying party the Host is configured for, over TLS, with two routes and nothing else', async () => {
  const { INTENDED_PRODUCTION_RP_ID } = await import(join(ROOT, 'dist/src/enterprise/human-identity/index.js'));
  assert.equal(contract.contract, 'frontera.authority-pilot.ingress-contract.v1');
  assert.equal(contract.origin, `https://${INTENDED_PRODUCTION_RP_ID}`);
  assert.deepEqual(contract.routes.map((entry) => [entry.id, entry.pathPrefix, entry.upstream]), [
    ['authority-api', '/authority/v1/', 'authority-gateway'],
    ['authority-web', '/', 'static'],
  ]);
  assert.deepEqual(Object.keys(contract.upstreams).sort(), ['authority-gateway', 'static']);
});

test('the API route matches the gateway: its prefix, body bound, Host and Origin checks, headers and cookies', async () => {
  const gateway = await import(join(ROOT, 'dist/src/enterprise/authority-gateway/index.js'));
  const web = await import(join(ROOT, 'dist/src/authority-web/api.js'));
  const api = route('authority-api');
  assert.equal(api.pathPrefix, `${web.API_PREFIX}/`, 'the prefix the web client calls');
  assert.match(gatewaySource, /const MAX_BODY_BYTES = 64 \* 1024;/);
  assert.equal(api.maxRequestBodyBytes, 64 * 1024, 'the ingress never accepts more than the gateway reads');
  assert.equal(api.preserveHostHeader, true);
  assert.match(gatewaySource, /req\.headers\.host !== publicOrigin\.host\) throw new GatewayError\(421/, 'the gateway checks Host itself');
  assert.match(gatewaySource, /req\.headers\.origin !== publicOrigin\.origin\) throw new GatewayError\(403/, 'and Origin');
  for (const header of ['host', 'origin', 'cookie', 'content-type', gateway.AUTHORITY_CSRF_HEADER]) assert.ok(api.forwardRequestHeaders.includes(header), header);
  assert.equal(gateway.AUTHORITY_CSRF_HEADER, web.CSRF_HEADER);
  for (const cookie of [gateway.AUTHORITY_SESSION_COOKIE, gateway.AUTHORITY_LOGIN_COOKIE, gateway.AUTHORITY_ENROLMENT_COOKIE]) assert.ok(cookie.startsWith('__Host-'), `${cookie}: host-only, so the ingress must not set a Domain or rewrite it`);
  assert.match(api.forwardResponseHeaders, /set-cookie/);
  assert.deepEqual(api.responseHeadersAdded, []);
  assert.equal(gateway.AUTHORITY_SECURITY_HEADERS['cache-control'], 'no-store');
  assert.match(api.cache, /^never/);
  assert.deepEqual(api.methods, ['GET', 'POST']);
});

test('the static route serves exactly the reproducible build with the client\'s security headers', () => {
  const web = route('authority-web');
  assert.equal(web.staticRoot, 'apps/authority-web/dist');
  assert.equal(web.responseHeadersFile, 'apps/authority-web/security-headers.json');
  const headers = JSON.parse(read(web.responseHeadersFile));
  assert.match(headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
  assert.equal(headers['strict-transport-security'], contract.tls.strictTransportSecurity);
  assert.deepEqual(web.methods, ['GET', 'HEAD']);
  assert.ok(web.notServed.includes('security-headers.json'));
  assert.ok(existsSync(join(ROOT, 'scripts/authority-web/build.mjs')), 'the build that writes asset-manifest.json');
});

test('no CORS, no cross-origin path to the operator plane, the witness or custody, and rate limits on every ceremony', () => {
  const text = read(CONTRACT_PATH);
  assert.equal(/"access-control-[a-z-]+"\s*:/i.test(text), false, 'no Access-Control-* header is configured');
  assert.match(contract.cors, /^none/);
  const never = contract.neverRoutedFromThisOrigin.map((entry) => entry.what).join(' ');
  for (const surface of ['/api/admin/', '/api/governed-actions', 'witness', 'signer', 'backup storage']) assert.ok(never.includes(surface), surface);
  for (const prefix of ['/authority/v1/session/login', '/authority/v1/enrolment', '/authority/v1/']) {
    assert.ok(contract.rateLimits.rules.some((rule) => rule.pathPrefix === prefix && /429/.test(rule.onExceed)), prefix);
  }
  assert.match(contract.rateLimits.clientIdentity, /never trusted/);
  // The rate-limited paths are exactly the ceremonies the gateway's own admission hook names.
  assert.match(gatewaySource, /segments\.join\('\/'\) === 'session\/login'\) && method === 'POST'\) admitted\('login'\)/);
  assert.match(gatewaySource, /segments\.join\('\/'\) === 'enrolment'\) && method === 'POST'\) \{\s*admitted\('enrolment'\)/);
});

test('the contract carries no secret and configures no infrastructure', () => {
  const text = read(CONTRACT_PATH);
  // Prose may name a bearer; a credential value may not appear.
  assert.equal(/Bearer [A-Za-z0-9._~+/-]{16}|BEGIN [A-Z ]*KEY|fre1\.|[0-9a-f]{64}|AOC_ENTERPRISE_API_KEYS|_TOKEN"/.test(text), false);
  assert.equal(/password/i.test(text), false);
  assert.equal(/\b(\d{1,3}\.){3}\d{1,3}\b/.test(text.replace(/127\.0\.0\.1/g, '')), false, 'no address other than loopback');
  // AUTH-04D2A added the pilot's configuration beside the contract; nothing here deploys (tests/authority-pilot-deployment-kit.structure.test.mjs).
  assert.deepEqual(readdirSync(join(ROOT, 'deploy/authority-pilot')).sort(), ['compose.authority.yaml', 'compose.executor.yaml', 'compose.host.yaml', 'compose.witness.yaml', 'governed-actions.synthetic-pilot.json', 'host.env.example', 'ingress-contract.json', 'nginx', 'synthetic-execution.additions.json', 'witness.env.example']);
  assert.match(contract['//'], /not a deployment/);
});
