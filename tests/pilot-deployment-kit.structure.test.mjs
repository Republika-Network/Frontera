// PROD-03-03 — the pilot deployment kit and release coherence, structurally.
//
// The kit (Dockerfile, .dockerignore, deploy/pilot/, the guide) states facts
// that other files own: the store set (PROD-02 registry), the Node major
// (package.json engines, CI), the endpoint count (API freeze), the package
// version (release manifest). Each is checked against its owner here, so a
// drift fails `npm test` rather than a pilot. The behaviour of the kit is
// qualified by scripts/deploy/qualify-pilot-deployment.mjs (needs Docker).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STORE_DEFINITIONS, storeEnvironmentFor } from '../scripts/portability/store-registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const json = (path) => JSON.parse(read(path));

const COMPOSE = read('deploy/pilot/compose.yaml');
const DOCKERFILE = read('Dockerfile');
const DOCKERIGNORE = read('.dockerignore');
const GUIDE = read('docs/deployment/PILOT_DEPLOYMENT.md');
const PKG = json('package.json');

/** `KEY: value` lines of one service's `environment:` block. */
function serviceEnvironment(service) {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.ok(start >= 0, `service ${service}`);
  const out = {};
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^ {4}\S/.test(line)) inEnvironment = false;
    const match = inEnvironment ? /^ {6}([A-Z_][A-Z0-9_]*): (.*)$/.exec(line) : null;
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** Every file of the deployment kit (code, configuration, docs). */
function kitFiles() {
  const files = ['Dockerfile', '.dockerignore', 'docs/deployment/PILOT_DEPLOYMENT.md'];
  for (const dir of ['deploy/pilot', 'scripts/deploy']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (statSync(join(ROOT, dir, name)).isFile()) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

describe('PROD-03-03 pilot deployment kit', () => {
  it('the Compose kit mounts every store the Host can compose, under one state root, at the PROD-02 registry filenames', () => {
    const environment = serviceEnvironment('frontera');
    const expected = storeEnvironmentFor('/var/lib/frontera');
    const configured = Object.fromEntries(Object.entries(environment).filter(([name]) => name.endsWith('_SQLITE_PATH')));
    assert.deepEqual(configured, expected);
    assert.equal(Object.keys(expected).length, STORE_DEFINITIONS.length);
    assert.match(COMPOSE, /^ {6}- frontera-state:\/var\/lib\/frontera$/m, 'the state root is a named volume');
    assert.match(COMPOSE, /^ {6}- frontera-witness:\/var\/lib\/frontera-witness$/m, "the witness's state is a different volume");
    assert.equal(serviceEnvironment('authority-witness').FRONTERA_REFERENCE_WITNESS_DB.startsWith('/var/lib/frontera-witness/'), true, 'the witness database is never in the Host state root');
  });

  it('the kit fixes the secure profile; .env cannot weaken it', () => {
    const environment = serviceEnvironment('frontera');
    for (const [name, value] of Object.entries({
      AOC_ENTERPRISE_ENV: 'production',
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
      AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'external',
      AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: '/etc/frontera/governed-actions.json',
    })) {
      assert.equal(environment[name], value, name);
    }
    const example = read('deploy/pilot/.env.example');
    for (const name of Object.keys(environment)) {
      assert.equal(new RegExp(`^${name}=`, 'm').test(example), false, `.env.example must not set the fixed ${name}`);
    }
    assert.match(COMPOSE, /"\$\{FRONTERA_PUBLISH_ADDRESS:-127\.0\.0\.1\}:/, 'the port is published on loopback unless the operator decides otherwise');
    assert.match(COMPOSE, /FRONTERA_REFERENCE_WITNESS_HOST: 127\.0\.0\.1/, 'the witness binds loopback only');
  });

  it('.env.example and the example governed-action file hold placeholders, never a credential', () => {
    const example = read('deploy/pilot/.env.example');
    // The one non-placeholder setting: which Compose profile runs the bundled witness.
    assert.match(example, /^COMPOSE_PROFILES=reference-witness$/m);
    const assignments = example.split('\n').filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line) && !line.startsWith('COMPOSE_PROFILES='));
    assert.ok(assignments.length > 0);
    for (const line of assignments) {
      const value = line.slice(line.indexOf('=') + 1);
      assert.match(value, /^<required[^>]*>$/, `${line.split('=')[0]} is a placeholder`);
    }
    assert.equal(/BEGIN [A-Z ]*PRIVATE KEY/.test(example), false, 'no key material');
    const governed = read('deploy/pilot/governed-actions.example.json');
    const parsed = JSON.parse(governed);
    for (const operator of parsed.operators) assert.match(operator.apiKeyEnv, /^[A-Z_][A-Z0-9_]*$/);
    for (const adapter of parsed.genericHttpAdapters) {
      for (const field of Object.keys(adapter.credential ?? {})) assert.ok(['kind', 'name', 'tokenEnv', 'valueEnv'].includes(field), `credential field ${field}: secrets are named by variable, never inline`);
    }
  });

  it('the example governed-action file is accepted by the Host’s own parser', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'frontera-kit-'));
    try {
      const file = join(dir, 'governed-actions.json');
      writeFileSync(file, read('deploy/pilot/governed-actions.example.json'));
      const { loadEnterpriseHostConfiguration } = await import(join(ROOT, 'dist/src/enterprise/index.js'));
      const host = loadEnterpriseHostConfiguration({
        AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: file,
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
        FRONTERA_OPERATOR_KEY_ADMIN: 'kit-admin-secret-0000000000000000000000000000',
        FRONTERA_OPERATOR_KEY_OBSERVER: 'kit-observer-secret-00000000000000000000000000',
        FRONTERA_PROVIDER_TOKEN: 'kit-provider-token',
      });
      assert.equal(host.governedActions.routes.size, 1);
      assert.equal(host.configuration.administration.operators.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the Dockerfile pins one Node major that package.json and CI agree on, and runs the launcher as a non-root user', () => {
    const image = /^ARG NODE_IMAGE=node:(\d+)\.(\d+)\.(\d+)-[a-z0-9-]+@sha256:[0-9a-f]{64}$/m.exec(DOCKERFILE);
    assert.ok(image, 'NODE_IMAGE is pinned by exact version and digest');
    const major = Number(image[1]);
    assert.equal(PKG.engines.node, `>=${major}`, 'engines.node');
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/publishability.yml']) {
      for (const match of read(workflow).matchAll(/node-version: '(\d+)'/g)) assert.equal(Number(match[1]), major, workflow);
    }
    assert.equal(json('release/RELEASE_MANIFEST.json').compatibilityMatrix.node, `>=${major}`);
    assert.match(DOCKERFILE, /^USER node$/m);
    assert.match(DOCKERFILE, /^CMD \["node", "scripts\/run-enterprise-host\.mjs"\]$/m);
    assert.match(DOCKERFILE, /npm ci --no-audit --no-fund/);
    assert.match(DOCKERFILE, /npm ci --omit=dev/);
    assert.match(DOCKERFILE, /write-release-identity\.mjs/);
    assert.equal(/curl[^\n]*\|\s*(ba)?sh|wget[^\n]*\|\s*(ba)?sh/.test(DOCKERFILE), false, 'no pipe-to-shell installer');
    assert.equal(/^(COPY|ADD)[^\n]*\.env/m.test(DOCKERFILE), false);
  });

  it('.dockerignore is an allow-list that keeps developer state out of the build context', () => {
    const lines = DOCKERIGNORE.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    assert.equal(lines[0], '*', 'everything is excluded first');
    for (const pattern of ['**/node_modules', '**/dist', '**/.env', '**/.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/*.pem', '**/.data', '**/backups']) {
      assert.ok(lines.includes(pattern), pattern);
    }
    for (const allowed of lines.filter((line) => line.startsWith('!'))) {
      assert.equal(/\.env|\.git\b|deploy|docs|tests|\.data/.test(allowed), false, `${allowed} must not be admitted`);
    }
    // What the build needs is admitted: the lockfile and the workspace manifests.
    for (const needed of ['!package.json', '!package-lock.json', '!src/', '!packages/', '!apps/*/package.json', '!vendor/*.tgz', '!scripts/', '!release/api-surface.v1.json']) {
      assert.ok(lines.includes(needed), needed);
    }
  });

  it('the kit names no personal path, WSL or Windows path, cloud provider or payment rail', () => {
    const personalOrPlatform = /C:\\Users|\/mnt\/c\/|vicvalch|onchainfest|\bWSL\b|digitalocean|amazonaws|\bAWS\b|\bAzure\b|\bGCP\b|vercel|\bandrew\b|\blumx\b/i;
    const rail = /xrpl|rlusd|lightning|wallet/i;
    // The guide states the kit's rail neutrality, and the qualification's D14
    // detector names the rails it looks for: the only two files that may.
    const declaresNeutrality = new Set(['docs/deployment/PILOT_DEPLOYMENT.md', 'scripts/deploy/qualify-pilot-deployment.mjs']);
    for (const file of kitFiles()) {
      const text = read(file);
      const hit = personalOrPlatform.exec(text) ?? (declaresNeutrality.has(file) ? null : rail.exec(text));
      assert.equal(hit, null, `${file}: ${hit?.[0]}`);
    }
  });

  it('every command the guide documents exists: scripts, npm scripts and Compose services', () => {
    const blocks = [...GUIDE.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
    assert.ok(blocks.length > 0);
    for (const [, script] of blocks.matchAll(/node (scripts\/[A-Za-z0-9/_.-]+\.mjs)/g)) assert.ok(existsSync(join(ROOT, script)), script);
    for (const [, name] of blocks.matchAll(/npm run ([a-z0-9:-]+)/g)) assert.ok(PKG.scripts[name] !== undefined, `npm run ${name}`);
    for (const [, service] of blocks.matchAll(/docker compose (?:run --rm(?: -T)?|logs|stop|start|restart)(?: [a-z-]+)* (frontera|authority-witness|network)\b/g)) {
      assert.match(COMPOSE, new RegExp(`^  ${service}:$`, 'm'), service);
    }
    for (const [, path] of blocks.matchAll(/http:\/\/127\.0\.0\.1:8787(\/[a-z]+)/g)) {
      assert.ok(['/live', '/ready', '/health', '/version'].includes(path), path);
    }
  });
});

describe('PROD-03-03 release coherence', () => {
  const manifest = json('release/RELEASE_MANIFEST.json');
  const freeze = json('release/api-surface.v1.json');

  it('the release manifest agrees with package.json and the API freeze', () => {
    assert.equal(manifest.name, PKG.name);
    assert.equal(manifest.version, PKG.version);
    assert.equal(manifest.api.endpointCount, freeze.endpointCount);
    assert.equal(manifest.api.surface, freeze.surface);
    assert.equal(manifest.compatibilityMatrix.node, PKG.engines.node);
    assert.equal(manifest.compatibilityMatrix['better-sqlite3'], PKG.dependencies['better-sqlite3']);
  });

  it('the API stability document states the frozen endpoint count, and the freeze lists /version', () => {
    assert.match(read('docs/enterprise/API_STABILITY_V1.md'), new RegExp(`→ \\*\\*${freeze.endpointCount}\\*\\*`));
    assert.ok(freeze.routeLiterals.includes('/version'));
    assert.ok(freeze.probes.some((probe) => probe.method === 'GET' && probe.path === '/version'));
  });

  it('the release identity writer records every registry store and validates through the Host’s own reader', async () => {
    const { spawnSync } = await import('node:child_process');
    const { rmSync } = await import('node:fs');
    const out = join(ROOT, 'dist', 'release-identity.json');
    const commit = 'b'.repeat(40);
    try {
      const run = spawnSync(process.execPath, [join(ROOT, 'scripts/release/write-release-identity.mjs')], { cwd: ROOT, env: { PATH: process.env.PATH, FRONTERA_BUILD_COMMIT: commit }, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const identity = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(identity.release, `${PKG.version}+${commit.slice(0, 12)}`);
      assert.deepEqual(Object.keys(identity.storeSchemaVersions).sort(), STORE_DEFINITIONS.map((storeDef) => storeDef.name).sort());
      assert.equal(identity.api.endpointCount, freeze.endpointCount);
      const refused = spawnSync(process.execPath, [join(ROOT, 'scripts/release/write-release-identity.mjs')], { cwd: ROOT, env: { PATH: process.env.PATH, FRONTERA_BUILD_COMMIT: 'abc' }, encoding: 'utf8' });
      assert.equal(refused.status, 1, 'a malformed commit is refused');
    } finally {
      rmSync(out, { force: true });
    }
  });

  it('CI runs the release coherence checks and the pilot deployment qualification', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /npm run check:release-coherence/);
    assert.match(ci, /qualify-pilot-deployment\.mjs/);
  });
});
