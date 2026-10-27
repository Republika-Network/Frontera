// AUTH-04D2A — the synthetic Authority pilot's deployment configuration
// (deploy/authority-pilot/), structurally. Each fact is checked against the
// file that owns it: the ingress contract (AUTH-04D1), the web client's
// security headers (AUTH-04C), the gateway (AUTH-04B), the AUTH-04D1R shutdown
// constraints and the reference pilot policy (PROD-03). Behaviour — what Compose
// resolves and what nginx actually does — is qualified by the CI job
// authority-pilot-config (scripts/deploy/qualify-authority-pilot.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const KIT = 'deploy/authority-pilot';
const HOST = read(`${KIT}/compose.host.yaml`);
const CUTOVER = read(`${KIT}/compose.authority.yaml`);
const WITNESS = read(`${KIT}/compose.witness.yaml`);
const NGINX = read(`${KIT}/nginx/authority.conf`);
const PROXY = read(`${KIT}/nginx/authority-gateway-proxy.conf`);
const WITNESS_NGINX = read(`${KIT}/nginx/witness.conf`);
const CONTRACT = JSON.parse(read(`${KIT}/ingress-contract.json`));
const AUTHORITY = 'authority.frontera-systems.com';

const value = (text, name) => {
  const match = new RegExp(`^\\s+${name}: "?([^"\\n]*)"?$`, 'm').exec(text);
  assert.ok(match !== null, name);
  return match[1];
};

describe('AUTH-04D2A — synthetic Authority pilot deployment configuration', () => {
  it('shutdown timings satisfy AUTH-04D1R: nine witness calls fit the drain bound, and the supervisor grace exceeds both drains', () => {
    const timeout = Number(value(HOST, 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS'));
    const attempts = Number(value(HOST, 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS'));
    const shutdown = Number(value(HOST, 'AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS'));
    const grace = Number(/^ {4}stop_grace_period: (\d+)s$/m.exec(HOST)?.[1]) * 1000;
    assert.ok(9 * timeout * attempts < shutdown, `${9 * timeout * attempts} < ${shutdown}`);
    assert.ok(grace >= 2 * shutdown + 10_000, `${grace} >= 2 × ${shutdown} + 10 s`);
    assert.ok(attempts >= 1 && attempts <= 3 && timeout >= 1 && timeout <= 60_000, 'within the Host’s accepted ranges');
  });

  it('stage 1 leaves the human-decision authority disabled; only the cutover overlay enables it, for exactly one relying party and origin', () => {
    assert.equal(/HUMAN_AUTHORITY|AUTHORITY_GATEWAY/.test(HOST.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')), false);
    assert.equal(value(CUTOVER, 'AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE'), 'enabled');
    assert.equal(value(CUTOVER, 'AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID'), AUTHORITY);
    assert.equal(value(CUTOVER, 'AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS'), CONTRACT.origin);
    assert.equal(value(CUTOVER, 'AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN'), CONTRACT.origin);
    assert.equal(value(CUTOVER, 'AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE'), '${FRONTERA_AUTHORITY_INITIALIZE_IDENTITY:-false}', 'initialization is off unless .env says otherwise, once');
    // Every .env line reaches the Host, which refuses a human-authority variable before cutover (AUTH-04A).
    assert.equal(/^AOC_ENTERPRISE_(HUMAN_|AUTHORITY_GATEWAY_)/m.test(read(`${KIT}/host.env.example`)), false);
    assert.match(CUTOVER, /^ {6}- "127\.0\.0\.1:8788:8788"$/m, 'the gateway is published on loopback only');
    assert.equal(/^\s+- "(?!127\.0\.0\.1:)/m.test(CUTOVER + HOST), false, 'no other port is published');
  });

  it('the witness is remote: never the bundled one on the Host machine, always https, on its own machine with no Host secret', () => {
    assert.match(HOST, /AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: \$\{AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT:\?/);
    const hostTemplate = read(`${KIT}/host.env.example`);
    assert.equal(/^COMPOSE_PROFILES=/m.test(hostTemplate), false, 'the reference-witness profile is never enabled on the Host machine');
    assert.match(hostTemplate, /^AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT='<required: https:\/\//m);
    assert.match(WITNESS, /network_mode: host/);
    assert.match(WITNESS, /FRONTERA_REFERENCE_WITNESS_HOST: 127\.0\.0\.1/);
    assert.equal(/SIGNING_KEY|OPERATOR_KEY|API_KEYS|ORGANIZATION_ID/.test(WITNESS + read(`${KIT}/witness.env.example`)), false);
    assert.match(WITNESS, /--witness-only/);
    assert.match(HOST, /--authority-only/);
  });

  it('templates hold placeholders only, never a value that could be a credential', () => {
    for (const file of ['host.env.example', 'witness.env.example']) {
      for (const line of read(`${KIT}/${file}`).split('\n').filter((entry) => /^[A-Z_][A-Z0-9_]*=/.test(entry))) {
        const [name, ...rest] = line.split('=');
        const assigned = rest.join('=');
        if (name === 'FRONTERA_AUTHORITY_INITIALIZE_IDENTITY') assert.equal(assigned, 'false');
        else assert.match(assigned, /^'<required[^>']*>'$/, `${file}: ${name}`);
      }
    }
  });

  it('the synthetic policy is the reference pilot policy, evidence-free, whose only executor can never resolve and holds no credential', async () => {
    const synthetic = JSON.parse(read(`${KIT}/governed-actions.synthetic-pilot.json`));
    const reference = JSON.parse(read('deploy/pilot/governed-actions.reference-pilot.json'));
    const { genericHttpAdapters, routes, ...governance } = synthetic;
    const { genericHttpAdapters: _a, routes: _r, ...referenceGovernance } = reference;
    assert.deepEqual(governance, referenceGovernance, 'operators, profiles and approval policy are unchanged (AUTH-04D1E Option C)');
    assert.equal(governance.governance.profiles.some((profile) => profile.approval?.requiredEvidence !== undefined), false, 'evidence-free');
    assert.ok(genericHttpAdapters.length > 0);
    for (const adapter of genericHttpAdapters) {
      assert.match(adapter.origin, /^https:\/\/[a-z0-9-]+\.invalid$/, 'RFC 6761 .invalid never resolves: nothing can be sent');
      assert.equal(adapter.credential, undefined);
    }
    for (const route of routes) assert.ok(genericHttpAdapters.some((adapter) => adapter.adapterId === route.adapterId));
    // The Host's own parser accepts it.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'frontera-synthetic-'));
    try {
      const file = join(dir, 'governed-actions.json');
      writeFileSync(file, JSON.stringify(synthetic));
      const operatorEnv = Object.fromEntries(synthetic.operators.map((operator) => [operator.apiKeyEnv, `synthetic-${operator.operatorId}-0000000000000000000000000000`]));
      const { loadEnterpriseHostConfiguration } = await import(join(ROOT, 'dist/src/enterprise/index.js'));
      const host = loadEnterpriseHostConfiguration({ AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: file, AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_REQUIRE_AUTH: 'true', ...operatorEnv });
      assert.equal(host.governedActions.routes.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the Host ingress implements the contract: one name, two routes, the gateway on loopback, the contract’s bounds and rate limits, no CORS', () => {
    const api = CONTRACT.routes.find((route) => route.id === 'authority-api');
    assert.deepEqual([...NGINX.matchAll(/server_name ([^;]+);/g)].map((match) => match[1]).sort(), ['_', '_', AUTHORITY, AUTHORITY]);
    assert.match(NGINX, new RegExp(`client_max_body_size ${api.maxRequestBodyBytes / 1024}k;`));
    assert.deepEqual([...(NGINX + PROXY).matchAll(/proxy_pass ([^;]+);/g)].map((match) => match[1]), ['http://127.0.0.1:8788']);
    const directives = (NGINX + PROXY).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.equal(/8787|8444|access-control|X-Forwarded|proxy_set_header Origin|proxy_set_header Cookie/i.test(directives), false);
    assert.match(PROXY, /proxy_set_header Host \$host;/);
    const rate = (zone) => Number(new RegExp(`zone=${zone}:10m rate=(\\d+)r/m;`).exec(NGINX)?.[1]);
    const rule = (prefix) => Number(/^(\d+) requests per minute/.exec(CONTRACT.rateLimits.rules.find((entry) => entry.pathPrefix === prefix).perClient)?.[1]);
    assert.equal(rate('frontera_authority_login'), rule('/authority/v1/session/login'));
    assert.equal(rate('frontera_authority_enrolment'), rule('/authority/v1/enrolment'));
    assert.equal(rate('frontera_authority_api'), rule('/authority/v1/'));
    assert.match(NGINX, /limit_req_zone \$binary_remote_addr/);
    assert.match(NGINX, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
    assert.match(NGINX, /ssl_reject_handshake on;/);
    assert.match(NGINX, /location = \/security-headers\.json \{\s*return 404;/);
    assert.match(NGINX, /log_format frontera_authority '\$time_iso8601 \$remote_addr "\$request_method \$uri" \$status \$body_bytes_sent \$request_time';/, 'never a cookie, query string or header value');
  });

  it('the static client gets exactly its own security headers, generated from the file that owns them', () => {
    const owned = Object.entries(JSON.parse(read('apps/authority-web/security-headers.json'))).filter(([name]) => name !== '//');
    const configured = [...read(`${KIT}/nginx/authority-web-headers.conf`).matchAll(/^add_header ([a-z-]+) "([^"]*)" always;$/gm)].map((match) => [match[1], match[2]]);
    assert.deepEqual(configured, owned);
  });

  it('the witness ingress: TLS, the witness protocol only, an allow-list that denies everyone but loopback until the Host is added', () => {
    assert.deepEqual([...WITNESS_NGINX.matchAll(/proxy_pass ([^;]+);/g)].map((match) => match[1]), ['http://127.0.0.1:8444']);
    assert.match(WITNESS_NGINX, /location \^~ \/v2\/ \{/);
    assert.match(WITNESS_NGINX, /include \/etc\/nginx\/frontera\/witness-allowlist\.conf;/);
    assert.equal(read(`${KIT}/nginx/witness-allowlist.conf`).split('\n').filter((line) => !line.startsWith('#') && line.trim() !== '').join('\n'), 'allow 127.0.0.1;\ndeny all;');
  });

  it('nothing in the kit names a cloud provider, a personal path or a payment rail, or holds a secret', () => {
    const files = ['compose.host.yaml', 'compose.authority.yaml', 'compose.witness.yaml', 'governed-actions.synthetic-pilot.json', 'host.env.example', 'witness.env.example', 'nginx/authority.conf', 'nginx/authority-gateway-proxy.conf', 'nginx/authority-web-headers.conf', 'nginx/witness.conf', 'nginx/witness-allowlist.conf'].map((file) => `${KIT}/${file}`);
    files.push('scripts/deploy/qualify-authority-pilot.mjs');
    for (const file of files) {
      const text = read(file);
      assert.equal(/C:\\Users|\/mnt\/c\/|vicvalch|\bWSL\b|digitalocean|hetzner|lightsail|amazonaws|\bAWS\b|\bAzure\b|\bGCP\b|vercel/i.test(text), false, `${file}: provider or personal path`);
      assert.equal(/xrpl|rlusd|lightning|wallet/i.test(text), false, `${file}: rail`);
      // A key or token: a PEM, or a long run mixing lower case, upper case and digits (variable names are upper case only).
      assert.equal(/BEGIN [A-Z ]*PRIVATE KEY|(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}/.test(text), false, `${file}: something that looks like a key or token`);
    }
  });

  it('CI qualifies the kit: Compose resolution, both ingresses with throwaway certificates, and the log hygiene', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('  authority-pilot-config:'), ci.indexOf('  authority-web-preview:'));
    for (const step of ['compose host', 'compose cutover', 'compose witness', 'ingress --ca', 'logs ', 'witness --ca', 'sudo nginx -t']) assert.ok(job.includes(step), step);
    assert.equal(/docker compose[^\n]*\b(up|start|build|pull|push)\b/.test(job), false, 'nothing is started, built or pushed');
    assert.equal(/certbot|acme\.sh|letsencrypt\.org|vercel|kubectl|terraform|gcloud|aws /i.test(job), false, 'no real certificate, no cloud');
  });
});
