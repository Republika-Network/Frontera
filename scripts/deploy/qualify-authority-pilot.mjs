#!/usr/bin/env node
// AUTH-04D2A — qualification of the synthetic Authority pilot's deployment
// configuration (deploy/authority-pilot/), with no cloud resource, DNS name or
// real certificate. Run by CI (job authority-pilot-config); each subcommand
// checks one thing and exits non-zero with a reason on the first failure.
//
//   compose <host|cutover|executor|witness> <merged.json>
//       the output of `docker compose ... config --format json`: what the
//       overlays actually resolve to, not what the files say
//   ingress --ca <pem>
//       the Host machine's nginx (installed as the runbook installs it, with a
//       throwaway certificate) in front of a stub gateway on 127.0.0.1:8788
//   executor --ca <pem>
//       AUTH-04D2S: the synthetic executor's TLS front on port 8443 of the Host
//       machine, beside the Authority ingress, before a stub executor on 127.0.0.1:8445
//   witness --ca <pem>
//       the witness machine's nginx in front of a stub witness on 127.0.0.1:8444
//   logs <access-log>
//       the ingress logged requests, and no cookie, query string, CSRF token
//       or Authorization value
//
// Synthetic only: every name is reserved or the pilot's own; nothing leaves
// this machine.

import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AUTHORITY = 'authority.frontera-systems.com';
const WITNESS = 'frontera-witness.invalid';
const EXECUTOR = 'synthetic-executor.frontera-systems.com';
const EXECUTOR_VOLUME = 'frontera-synthetic-executor';
const MARKERS = { cookie: 'COOKIE-MARK-7c1f', csrf: 'CSRF-MARK-91ab', query: 'QUERY-MARK-55d2', bearer: 'BEARER-MARK-0e3c', capability: 'CAPABILITY-MARK-4a8e' };

function fail(message) {
  console.error(`qualify-authority-pilot: FAIL — ${message}`);
  process.exit(1);
}
function check(condition, message) {
  if (!condition) fail(message);
  console.log(`  ok  ${message}`);
}

// ── compose ─────────────────────────────────────────────────────────────────────────

/** `docker compose config --format json` renders environment as an object and durations as Go strings ("1m15s"). */
function seconds(duration) {
  const match = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(duration ?? ''));
  if (match === null) return Number.NaN;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

const WITNESS_STATE = '/var/lib/frontera-witness';

/** What a service runs: entrypoint and command, as one string. */
function launches(service) {
  return [...(service.entrypoint ?? []), ...(service.command ?? [])].join(' ');
}

/**
 * The Host machine never generates, holds or reaches the witness receipt
 * private key: checked on every resolved service, tools included, and on the
 * project's volumes, so a service hidden behind a profile still counts.
 */
function hostHoldsNoWitnessMaterial(merged) {
  const services = merged.services ?? {};
  for (const name of ['witness-init', 'authority-witness']) check(services[name] === undefined, `Host: no ${name} service (it cannot be run here, under any profile)`);
  check(!Object.keys(merged.volumes ?? {}).some((volume) => volume.includes('witness')), 'Host: no witness volume is declared');
  for (const [name, service] of Object.entries(services)) {
    check(!(service.volumes ?? []).some((volume) => volume.target === WITNESS_STATE || String(volume.source ?? '').includes('witness')), `Host ${name}: no witness volume is mounted`);
    check(!Object.keys(service.environment ?? {}).some((variable) => /^FRONTERA_REFERENCE_WITNESS_/.test(variable)), `Host ${name}: no witness key, database or listener variable`);
    const runs = launches(service);
    check(!runs.includes('run-reference-authority-state-witness'), `Host ${name}: does not run a witness`);
    check(!runs.includes('generate-pilot-secrets.mjs') || runs.includes('generate-pilot-secrets.mjs --authority-only'), `Host ${name}: generates no witness key (only --authority-only)`);
  }
}

function compose(mode, file) {
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  const services = merged.services ?? {};
  console.log(`compose: ${mode}`);
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) check(port.host_ip === '127.0.0.1', `${name}: port ${String(port.published)} is published on loopback only`);
  }
  if (mode === 'witness') {
    const witness = services['authority-witness'];
    check(witness !== undefined, 'the witness service exists');
    check(witness.network_mode === 'host', 'the witness shares the machine loopback (it binds loopback only)');
    check(witness.environment.FRONTERA_REFERENCE_WITNESS_HOST === '127.0.0.1', 'the witness binds 127.0.0.1');
    check((witness.ports ?? []).length === 0, 'the witness publishes no port');
    check(!Object.keys(witness.environment).some((name) => /SIGNING_KEY|OPERATOR_KEY|API_KEYS/.test(name)), 'the witness holds no Host secret');
    const init = services['witness-init'];
    check(init !== undefined && init.network_mode === 'none', 'witness-init exists on the witness machine, with no network');
    check(launches(init).includes('generate-pilot-secrets.mjs --witness-only'), 'witness-init generates the witness half only (--witness-only)');
    check((init.volumes ?? []).some((volume) => volume.target === WITNESS_STATE), 'witness-init persists the receipt key on the witness volume');
    return;
  }
  hostHoldsNoWitnessMaterial(merged);
  const host = services.frontera;
  check(host !== undefined, 'the Host service exists');
  const env = host.environment;
  const timeout = Number(env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS);
  const attempts = Number(env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS);
  const shutdown = Number(env.AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS);
  const grace = seconds(host.stop_grace_period) * 1000;
  check(9 * timeout * attempts < shutdown, `AUTH-04D1R: 9 witness calls × ${timeout} ms × ${attempts} < shutdown ${shutdown} ms`);
  check(grace >= 2 * shutdown + 10_000, `AUTH-04D1R: stop grace ${grace} ms >= 2 × shutdown + 10 s`);
  check(/^https:\/\//.test(env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT), 'the witness endpoint is https (a remote witness)');
  check(env.AOC_ENTERPRISE_ENV === 'production' && env.AOC_ENTERPRISE_REQUIRE_AUTH === 'true', 'the secure production profile is kept');
  const policy = (host.volumes ?? []).find((volume) => volume.target === '/etc/frontera/governed-actions.json');
  const policySource = mode === 'executor' ? '/governed-actions.json' : 'deploy/authority-pilot/governed-actions.synthetic-pilot.json';
  check(policy !== undefined && policy.source.endsWith(policySource) && policy.read_only === true, mode === 'executor' ? 'the rendered synthetic-execution policy is mounted read-only' : 'the synthetic policy is mounted read-only');
  const human = Object.keys(env).filter((name) => /^AOC_ENTERPRISE_(HUMAN_|AUTHORITY_GATEWAY_)/.test(name));
  if (mode === 'host') {
    check(human.length === 0, 'stage 1: the human-decision authority and its gateway are disabled (no variable at all)');
    check(!(services.network.ports ?? []).some((port) => String(port.target) === '8788'), 'stage 1: no gateway port');
    return;
  }
  check(env.AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE === 'enabled' && env.AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE === 'enabled', 'cutover: authority and gateway enabled');
  check(env.AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID === AUTHORITY, 'cutover: the RP ID is the Authority host');
  check(env.AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS === `https://${AUTHORITY}` && env.AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN === `https://${AUTHORITY}`, 'cutover: one exact origin');
  check(env.AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH === '/var/lib/frontera/human-identity.sqlite', 'cutover: the identity store is on the state volume');
  check(env.AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE === 'false', 'cutover: initialization is off by default');
  check((services.network.ports ?? []).some((port) => String(port.target) === '8788' && port.host_ip === '127.0.0.1'), 'cutover: the gateway is published on loopback only');
  for (const tool of ['config-check', 'pilot-readiness']) {
    check(services[tool] === undefined || services[tool].environment.AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE === 'enabled', `cutover: ${tool} checks the same configuration`);
  }
  if (mode === 'executor') executorIsolation(merged);
}

const mounts = (service, source) => (service?.volumes ?? []).some((volume) => volume.source === source);

/**
 * AUTH-04D2S: the synthetic executor on the Host machine holds its own state and no Host secret, and no Host service
 * holds or reaches its receipt key. Checked on the resolved project, tools included.
 */
function executorIsolation(merged) {
  const services = merged.services ?? {};
  const executor = services['synthetic-executor'];
  check(executor !== undefined, 'executor: the synthetic executor service exists');
  check(executor.network_mode === 'host' && (executor.ports ?? []).length === 0, 'executor: on this machine\'s loopback (it binds loopback only), no published port');
  check(launches(executor).includes('scripts/run-reference-executor.mjs'), 'executor: runs the reference executor, nothing else');
  check(JSON.stringify(Object.keys(executor.environment ?? {}).sort()) === JSON.stringify(['FRONTERA_REFERENCE_EXECUTOR_CONFIG_FILE', 'FRONTERA_SYNTHETIC_EXECUTOR_TOKEN']), 'executor: its configuration file and its one client credential are its whole environment (no Host secret)');
  check(mounts(executor, EXECUTOR_VOLUME) && !mounts(executor, 'frontera-state'), 'executor: its own volume, never the Host state');
  const configuration = (executor.volumes ?? []).find((volume) => volume.target === '/etc/frontera-synthetic-executor/configuration.json');
  check(configuration !== undefined && configuration.read_only === true, 'executor: its rendered configuration is read-only');
  check(JSON.stringify(executor.healthcheck?.test ?? []).includes('8445'), 'executor: health is its loopback port 8445');
  for (const [name, service] of Object.entries(services)) {
    if (name === 'synthetic-executor' || name === 'synthetic-executor-init') continue;
    check(!mounts(service, EXECUTOR_VOLUME), `executor: ${name} never mounts the executor's volume (its receipt key)`);
  }
  const init = services['synthetic-executor-init'];
  check(init !== undefined && init.network_mode === 'none' && launches(init).includes('synthetic-execution-pilot.mjs executor-init'), 'executor-init: no network, the executor half only');
  check(Object.keys(init.environment ?? {}).length === 0 && !mounts(init, 'frontera-state'), 'executor-init: no Host secret, no Host state');
  const render = services['synthetic-execution-render'];
  check(render !== undefined && render.network_mode === 'none' && launches(render).includes('synthetic-execution-pilot.mjs render'), 'render: no network');
  check(JSON.stringify(Object.keys(render.environment ?? {}).sort()) === JSON.stringify(['AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS', 'AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID']), 'render: public keys and the organization only');
  check(!mounts(render, 'frontera-state'), 'render: no Host state');
  const hostInit = services['execution-init'];
  check(hostInit !== undefined && hostInit.network_mode === 'none' && launches(hostInit).includes('synthetic-execution-pilot.mjs host-init'), 'execution-init: no network');
  check(JSON.stringify(Object.keys(hostInit.environment ?? {})) === JSON.stringify(['AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID']), 'execution-init: no secret');
  check(Object.keys(merged.volumes ?? {}).includes(EXECUTOR_VOLUME), 'executor: its volume is declared');
  // AUTH-04D2V: the execution verifier reads; it holds the observer and auditor credentials only, and no port.
  const verifier = services['execution-verifier'];
  check(verifier !== undefined && verifier.network_mode === 'service:network' && (verifier.ports ?? []).length === 0, 'execution-verifier: the Host\'s private listener only, no published port');
  check(launches(verifier).includes('scripts/deploy/verify-synthetic-execution.mjs'), 'execution-verifier: runs the read-only verifier, nothing else');
  check(JSON.stringify(Object.keys(verifier.environment ?? {}).sort()) === JSON.stringify(['FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER', 'FRONTERA_OPERATOR_KEY_OBSERVER']), 'execution-verifier: the observer and the read-only auditor credentials are its whole environment');
  const pinnedDirectory = (verifier.volumes ?? []).find((volume) => volume.target === '/etc/frontera-synthetic-execution');
  check(pinnedDirectory !== undefined && pinnedDirectory.read_only === true, 'execution-verifier: the pinned public configuration is read-only');
}

// ── stubs and requests ──────────────────────────────────────────────────────────────

/** A stub upstream on loopback that records what reached it. */
async function stub(port, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
      answer(req, res);
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.on('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return { seen, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

/** One request to the local ingress, as a browser would make it to `name`. Resolves with the response, or with { error } when the ingress closes or refuses. */
function send({ tls = true, ca, servername, host, method = 'GET', path, headers = {}, body, port, localAddress }) {
  return new Promise((resolveSend) => {
    const options = { host: '127.0.0.1', port: port ?? (tls ? 443 : 80), method, path, headers: { host, ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) }, ...(tls ? { ca, servername } : {}), ...(localAddress !== undefined ? { localAddress } : {}) };
    const req = (tls ? httpsRequest : httpRequest)(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveSend({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (error) => resolveSend({ error: error.code ?? error.message }));
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

// ── the Host machine's ingress ──────────────────────────────────────────────────────

async function ingress() {
  const ca = readFileSync(argValue('--ca') ?? fail('--ca is required'));
  const expectedHeaders = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(ROOT, 'apps/authority-web/security-headers.json'), 'utf8'))).filter(([name]) => name !== '//'));
  const gateway = await stub(8788, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': ['__Host-frontera_authority_session=stub; Path=/; Secure; HttpOnly; SameSite=Strict', '__Host-frontera_authority_login=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict'] });
    res.end('{"stub":true}');
  });
  const at = (options) => send({ ca, servername: AUTHORITY, host: AUTHORITY, ...options });
  try {
    console.log('ingress: the static client');
    const index = await at({ path: '/' });
    check(index.status === 200 && /text\/html/.test(index.headers['content-type'] ?? ''), 'GET / serves the client');
    for (const [name, value] of Object.entries(expectedHeaders)) check(index.headers[name] === value, `static header ${name} is exactly the client's`);
    check(!Object.keys(index.headers).some((name) => name.startsWith('access-control-')), 'no CORS header on the client');
    check(!/^nginx\//.test(index.headers.server ?? '') || index.headers.server === 'nginx', 'no server version is disclosed');
    check((await at({ path: '/security-headers.json' })).status === 404, 'the header source file is not served');
    for (const path of ['/api/admin/approvals', '/api/governed-actions', '/health', '/ready', '/v2/identity']) {
      const reply = await at({ path });
      check(reply.status === 404, `${path} is not routed anywhere (${String(reply.status)})`);
    }
    check(gateway.seen.length === 0, 'nothing but /authority/v1/ ever reached the gateway');
    check((await at({ method: 'POST', path: '/', body: '{}' })).status === 403, 'the static client accepts GET and HEAD only');

    console.log('ingress: the Authority API');
    const session = await at({ path: `/authority/v1/session?${MARKERS.query}=1`, headers: { cookie: `__Host-frontera_authority_session=${MARKERS.cookie}`, origin: `https://${AUTHORITY}` } });
    check(session.status === 200, 'GET /authority/v1/session reaches the gateway');
    const first = gateway.seen.at(-1);
    check(first.headers.host === AUTHORITY, 'the gateway sees the Authority Host exactly');
    check(first.headers.cookie === `__Host-frontera_authority_session=${MARKERS.cookie}`, 'the cookie passes unchanged');
    check(first.headers.origin === `https://${AUTHORITY}`, 'the Origin passes unchanged');
    check(!('x-forwarded-for' in first.headers) && !('forwarded' in first.headers), 'no forwarding header is invented');
    check(Array.isArray(session.headers['set-cookie']) && session.headers['set-cookie'].length === 2 && session.headers['set-cookie'][0].startsWith('__Host-frontera_authority_session=stub'), 'every Set-Cookie returns unchanged');
    check(session.headers['cache-control'] === 'no-store', "the gateway's no-store returns unchanged");
    check(session.headers['content-security-policy'] === undefined && !Object.keys(session.headers).some((name) => name.startsWith('access-control-')), 'the ingress adds no header to API answers, and no CORS');
    const post = await at({ method: 'POST', path: '/authority/v1/decisions', headers: { 'content-type': 'application/json', origin: `https://${AUTHORITY}`, 'x-frontera-csrf-token': MARKERS.csrf, authorization: `Bearer ${MARKERS.bearer}` }, body: '{"assertion":{}}' });
    check(post.status === 200, 'POST reaches the gateway');
    const forwarded = gateway.seen.at(-1);
    check(forwarded.headers['x-frontera-csrf-token'] === MARKERS.csrf, 'the CSRF header passes unchanged');
    check(forwarded.headers.authorization === `Bearer ${MARKERS.bearer}`, 'an Authorization header passes unchanged, so the gateway refuses it itself');
    check(forwarded.bytes === Buffer.byteLength('{"assertion":{}}'), 'the body passes unchanged');
    const before = gateway.seen.length;
    const large = await at({ method: 'POST', path: '/authority/v1/decisions', headers: { 'content-type': 'application/json' }, body: `{"x":"${'a'.repeat(70 * 1024)}"}` });
    check(large.status === 413 && gateway.seen.length === before, 'a body over 64 KiB is refused at the ingress and never forwarded');
    check((await at({ method: 'PUT', path: '/authority/v1/session', body: '{}' })).status === 403, 'only GET and POST reach the gateway');
    const preflight = await at({ method: 'OPTIONS', path: '/authority/v1/session', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    check(preflight.status === 403 && !Object.keys(preflight.headers ?? {}).some((name) => name.startsWith('access-control-')), 'a CORS preflight is refused without any CORS header');

    console.log('ingress: names and transport');
    check((await at({ host: 'evil.example', path: '/' })).error !== undefined, 'another Host on the Authority certificate is closed without an answer');
    check((await send({ ca, servername: 'evil.example', host: 'evil.example', path: '/' })).error !== undefined, 'another TLS name gets no certificate (handshake refused)');
    const plain = await send({ tls: false, host: AUTHORITY, path: `/x?${MARKERS.query}=2` });
    check(plain.status === 301 && plain.headers.location === `https://${AUTHORITY}/x?${MARKERS.query}=2`, 'plain HTTP only redirects to https');
    check(plain.headers['set-cookie'] === undefined, 'the redirect sets no cookie');
    check((await send({ tls: false, host: 'evil.example', path: '/' })).error !== undefined, 'plain HTTP for another name is closed without an answer');

    console.log('ingress: rate limits (per TCP peer)');
    const statuses = async (path, count) => {
      const out = [];
      for (let index = 0; index < count; index += 1) out.push((await at({ method: 'POST', path, headers: { 'content-type': 'application/json' }, body: '{}' })).status);
      return out;
    };
    const login = await statuses('/authority/v1/session/login/options', 10);
    check(login.slice(0, 6).every((status) => status === 200) && login.slice(6).every((status) => status === 429), `sign-in: 6 admitted then 429 (${login.join(',')})`);
    const enrolment = await statuses('/authority/v1/enrolment/options', 7);
    check(enrolment.slice(0, 4).every((status) => status === 200) && enrolment.slice(4).every((status) => status === 429), `enrolment: 4 admitted then 429 (${enrolment.join(',')})`);
    check((await at({ path: '/authority/v1/session' })).status === 200, 'the ceremonies are limited separately from the rest of the API');
  } finally {
    await gateway.close();
  }
}

// ── the witness machine's ingress ───────────────────────────────────────────────────

async function witness() {
  const ca = readFileSync(argValue('--ca') ?? fail('--ca is required'));
  const upstream = await stub(8444, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"stub":"witness"}');
  });
  const at = (options) => send({ ca, servername: WITNESS, host: WITNESS, ...options });
  try {
    console.log('witness ingress');
    check((await at({ path: '/v2/identity' })).status === 200, 'the witness protocol is reachable from an allowed address (loopback here)');
    check(upstream.seen.at(-1)?.headers.host === WITNESS, 'the witness sees its own host name');
    check((await at({ method: 'POST', path: '/v2/checkpoint/prepare', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 200, 'checkpoint operations pass');
    const before = upstream.seen.length;
    check((await at({ path: '/' })).status === 404 && (await at({ path: '/admin' })).status === 404 && upstream.seen.length === before, 'nothing but /v2/ is routed');
    check((await at({ method: 'DELETE', path: '/v2/checkpoint/read' })).status === 403, 'only GET and POST');
    check((await send({ ca, servername: 'evil.example', host: 'evil.example', path: '/v2/identity' })).error !== undefined, 'another TLS name gets no certificate');
    check((await send({ tls: false, host: WITNESS, path: '/v2/identity' })).error !== undefined, 'plain HTTP serves no witness traffic');
    const allowlist = readFileSync(join(ROOT, 'deploy/authority-pilot/nginx/witness-allowlist.conf'), 'utf8');
    check(/^deny all;$/m.test(allowlist) && allowlist.split('\n').filter((line) => /^allow /.test(line)).every((line) => line === 'allow 127.0.0.1;'), 'the shipped allow-list admits loopback only until the Host address is added');
  } finally {
    await upstream.close();
  }
}

// ── the synthetic executor's front, on the Host machine ─────────────────────────────

async function executorFront() {
  const ca = readFileSync(argValue('--ca') ?? fail('--ca is required'));
  const authority = `${EXECUTOR}:8443`;
  const upstream = await stub(8445, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'frontera-execution-receipt': `RECEIPT-${MARKERS.capability}` });
    res.end('{"stub":"executor"}');
  });
  const at = (options) => send({ ca, servername: EXECUTOR, host: authority, port: 8443, ...options });
  const body = '{"release":"release-1","requestId":"r","decisionId":"d","executionId":"e"}';
  const governed = { 'content-type': 'application/json', authorization: `Bearer ${MARKERS.bearer}`, 'frontera-execution-capability': MARKERS.capability, 'idempotency-key': 'execution-1' };
  try {
    console.log('executor front');
    const reply = await at({ method: 'POST', path: `/v1/deployments/synthetic-environment?${MARKERS.query}=1`, headers: governed, body });
    check(reply.status === 200, 'POST /v1/deployments/<resource> reaches the executor from an allowed address');
    const seen = upstream.seen.at(-1);
    check(seen.headers.host === authority, 'the executor sees the Host header exactly, port included (it is part of the bound request)');
    check(seen.headers.authorization === governed.authorization && seen.headers['frontera-execution-capability'] === MARKERS.capability && seen.headers['idempotency-key'] === 'execution-1', 'the credential, the capability presentation and the idempotency key pass unchanged');
    check(seen.bytes === Buffer.byteLength(body) && seen.url === `/v1/deployments/synthetic-environment?${MARKERS.query}=1`, 'the target and the body pass unchanged');
    check(!('x-forwarded-for' in seen.headers) && !('forwarded' in seen.headers) && !('x-real-ip' in seen.headers), 'no forwarding header is invented');
    check(reply.headers['frontera-execution-receipt'] === `RECEIPT-${MARKERS.capability}`, 'the executor\'s receipt header returns unchanged');
    const before = upstream.seen.length;
    check((await at({ path: '/v1/deployments/synthetic-environment' })).status === 403, 'only POST');
    check((await at({ method: 'PUT', path: '/v1/deployments/synthetic-environment', body: '{}' })).status === 403, 'no PUT');
    check((await at({ method: 'POST', path: '/admin', headers: governed, body })).status === 404 && (await at({ path: '/' })).status === 404, 'nothing but /v1/deployments/ is routed');
    check((await at({ method: 'POST', path: '/v1/deployments/x', headers: { 'content-type': 'application/json' }, body: `{"x":"${'a'.repeat(70 * 1024)}"}` })).status === 413, 'a body over 64 KiB is refused at the front');
    check((await at({ method: 'POST', path: '/v1/deployments/x', headers: governed, body, localAddress: '127.0.0.2' })).status === 403, 'an address outside the allow-list is refused');
    check(upstream.seen.length === before, 'none of those reached the executor');
    check((await send({ ca, servername: 'evil.example', host: 'evil.example', port: 8443, path: '/v1/deployments/x' })).error !== undefined, 'another TLS name on 8443 gets no certificate');
    check((await send({ tls: false, host: EXECUTOR, path: '/v1/deployments/x' })).error !== undefined, 'plain HTTP for the executor name serves nothing but the ACME challenge');
    check((await send({ ca, servername: EXECUTOR, host: EXECUTOR, path: '/v1/deployments/x' })).error !== undefined, 'the Authority ingress (443) does not answer the executor name');
    const viaAuthority = await send({ ca, servername: AUTHORITY, host: AUTHORITY, method: 'POST', path: '/v1/deployments/synthetic-environment', headers: governed, body });
    check(viaAuthority.status !== 200 && upstream.seen.length === before, 'the Authority ingress has no route to the executor');
    const allowlist = readFileSync(join(ROOT, 'deploy/authority-pilot/nginx/synthetic-executor-allowlist.conf'), 'utf8');
    check(JSON.stringify(allowlist.split('\n').filter((line) => /^(allow|deny) /.test(line))) === JSON.stringify(['allow 127.0.0.1;', 'allow 172.16.0.0/12;', 'allow 192.168.0.0/16;', 'deny all;']), 'the allow-list admits loopback and the Docker bridge pools only');
    for (let index = 0; index < 8; index += 1) await at({ method: 'POST', path: '/v1/deployments/synthetic-environment', headers: governed, body });
  } finally {
    await upstream.close();
  }
}

function logs(file) {
  const text = readFileSync(file, 'utf8');
  console.log('ingress logs');
  check(text.split('\n').filter((line) => line.trim() !== '').length > 10, 'requests were logged');
  for (const [what, marker] of Object.entries(MARKERS)) check(!text.includes(marker), `no ${what} value in the log`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'compose') compose(rest[0], rest[1]);
else if (command === 'ingress') await ingress();
else if (command === 'witness') await witness();
else if (command === 'executor') await executorFront();
else if (command === 'logs') logs(rest[0]);
else fail('usage: qualify-authority-pilot.mjs compose <host|cutover|executor|witness> <merged.json> | ingress --ca <pem> | executor --ca <pem> | witness --ca <pem> | logs <file>');
console.log(`qualify-authority-pilot: ${command} passed`);
