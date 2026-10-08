// PROD-03-03 — pilot deployment qualification (cases D1–D15).
//
// Qualifies the supported deployment surface itself — the Dockerfile, the
// Compose kit in deploy/pilot/, the documented commands, the HTTP surface —
// never an internal class. It:
//
//   1. exports the repository to a scratch directory (tracked + untracked,
//      non-ignored files, or a `git archive` with --from-commit) and plants
//      canary files the image must never contain;
//   2. follows docs/deployment/PILOT_DEPLOYMENT.md in that export: build,
//      generate secrets, config-check, start, readiness, version;
//   3. creates durable governed state over HTTP (operators, an agent, allowed
//      and denied governed actions, an emergency stop), stops, restarts and
//      re-creates the stack, and requires every record to survive;
//   4. injects faults (missing configuration, no volume, read-only volume,
//      incompatible schema, witness down at boot, witness down at runtime);
//   5. scans every output for every secret, and the image for every canary.
//
// Needs Docker with Compose v2 and Node >= 22; nothing else on the host.
//
//   node scripts/deploy/qualify-pilot-deployment.mjs [--commit <40-hex>] [--from-commit <ref>] [--host-build] [--keep]
//
// Exit 0 only when every case passes. Each run uses its own Compose project,
// image tag, volumes and port, and removes them afterwards (unless --keep).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const RUN = randomBytes(4).toString('hex');
const PROJECT = `frontera-qual-${RUN}`;
const IMAGE = `frontera-host:qual-${RUN}`;
const CANARY = `FRONTERAQUALCANARY${randomBytes(12).toString('hex')}`;
const ORG = 'org-qualification';
const RESOURCE_A = 'ledger-a';
const RESOURCE_B = 'ledger-b';
const ACTION = 'record.update';

const results = [];
const captured = [];
let failed = false;

function log(line) {
  process.stdout.write(`${line}\n`);
}

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  if (!ok) failed = true;
  log(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(4)} ${title}${detail ? ` — ${detail}` : ''}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, commandArgs, { cwd = REPO, env = process.env, input, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (!allowFailure && out.status !== 0) {
    throw new Error(`${command} ${commandArgs.slice(0, 6).join(' ')} exited ${out.status}: ${(out.stderr || out.stdout).slice(-1500)}`);
  }
  return out;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---- 1. export --------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'frontera-qualification-'));
const exportDir = join(work, 'frontera');
const pilotDir = join(exportDir, 'deploy', 'pilot');
mkdirSync(exportDir);

const fromCommit = option('--from-commit');
if (fromCommit !== undefined) {
  const tar = spawnSync('sh', ['-c', `git -C "${REPO}" archive --format=tar "${fromCommit}" | tar -x -C "${exportDir}"`], { encoding: 'utf8' });
  check(tar.status === 0, `git archive ${fromCommit} failed: ${tar.stderr}`);
} else {
  const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO }).stdout.split('\0').filter(Boolean);
  for (const file of files) {
    const source = join(REPO, file);
    const target = join(exportDir, file);
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(source, target);
    } catch (error) {
      // A tracked file deleted in the working tree is simply not exported.
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

const commit = option('--commit') ?? (fromCommit !== undefined ? run('git', ['rev-parse', `${fromCommit}^{commit}`]).stdout.trim() : '');
check(commit === '' || /^[0-9a-f]{40}$/.test(commit), '--commit must be a full 40-hex commit');

// Canaries the image must never contain: developer state a careless build context would carry.
const canaryFiles = ['.env', '.env.local', '.data/dev.sqlite', 'local.sqlite', 'secrets/authority.pem', '.git/config', 'node_modules/canary/index.js', 'coverage/lcov.info', 'src/.env.production', 'packages/identity/.data/x.sqlite', 'notes.log'];
for (const file of canaryFiles) {
  mkdirSync(dirname(join(exportDir, file)), { recursive: true });
  writeFileSync(join(exportDir, file), `${CANARY}\n`);
}

const port = await freePort();
const composeEnv = { ...process.env, FRONTERA_IMAGE: IMAGE, FRONTERA_BUILD_COMMIT: commit, FRONTERA_PUBLISH_PORT: String(port) };
const compose = (composeArgs, options = {}) => run('docker', ['compose', '-p', PROJECT, ...(options.files ?? []).flatMap((file) => ['-f', file]), ...composeArgs], { cwd: pilotDir, env: composeEnv, ...options });
const base = `http://127.0.0.1:${port}`;

async function http(method, path, { authorization, body, capture = true } = {}) {
  const headers = { ...(authorization !== undefined ? { authorization } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  try {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (capture) captured.push(text);
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    return { status: response.status, body: json, text };
  } catch {
    return { status: 0, body: {}, text: '' };
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitReady = (timeoutMs = 180_000) => waitFor(async () => (await http('GET', '/ready')).status === 200, timeoutMs, '/ready 200');

/** True if /ready never answers 200 for `ms`. */
async function neverReady(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await http('GET', '/ready')).status === 200) return false;
    await sleep(1000);
  }
  return true;
}

function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replaceAll('\\n', '\n');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function setEnvValue(path, name, value) {
  const text = readFileSync(path, 'utf8');
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  check(pattern.test(text), `${name} is not in ${path}`);
  writeFileSync(path, text.replace(pattern, `${name}=${value}`));
}

const configCheck = (files) => compose(['run', '--rm', '-T', 'config-check'], { allowFailure: true, files });
const logs = () => compose(['logs', '--no-color'], { allowFailure: true }).stdout;
function exitCodeOf(service) {
  const id = compose(['ps', '-a', '-q', service], { allowFailure: true }).stdout.trim().split('\n')[0];
  if (!id) return undefined;
  return Number(run('docker', ['inspect', '-f', '{{.State.ExitCode}}', id]).stdout.trim());
}

const operator = {};
const state = {};

async function snapshot() {
  const executions = await http('GET', '/api/admin/operations/executions?limit=50', { authorization: operator.observer });
  check(executions.status === 200, `operations/executions answered ${executions.status}`);
  const views = (executions.body.executions ?? []).map((view) => `${view.requestId}:${view.classification}`).sort();
  const trace = await http('GET', `/api/admin/operations/traces/${encodeURIComponent(state.allowedRequestId)}`, { authorization: operator.observer });
  check(trace.status === 200, `operations/traces answered ${trace.status}`);
  const agents = await http('GET', '/api/admin/agents', { authorization: operator.observer });
  check(agents.status === 200, `agents answered ${agents.status}`);
  const stops = await http('GET', '/api/admin/emergency-controls', { authorization: operator.admin });
  check(stops.status === 200, `emergency-controls answered ${stops.status}`);
  const agentIds = (agents.body.agents ?? []).map((agent) => agent.actorId ?? agent.agentId).sort();
  const activeStops = JSON.stringify(stops.body).includes(RESOURCE_B);
  return { views, traceRequestId: trace.body.requestId ?? trace.body.trace?.requestId ?? null, agentIds, activeStops };
}

async function govern(resource, idempotencyKey, action = ACTION) {
  return http('POST', '/api/governed-actions', { authorization: `Bearer ${state.agentCredential}`, body: { action, resource, idempotencyKey } });
}

async function provision(kind, body) {
  const reply = await http('POST', `/api/admin/authority/entities/${kind}`, { authorization: operator.admin, body });
  check(reply.status === 200 && reply.body.outcome === 'provisioned', `provision ${kind}: ${reply.status} ${reply.text.slice(0, 300)}`);
}

async function main() {
  // ---- D1 clean build ----------------------------------------------------------------------
  try {
    if (flag('--host-build')) {
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: exportDir });
      run('npm', ['run', 'build'], { cwd: exportDir });
    }
    compose(['build']);
    const identity = JSON.parse(run('docker', ['run', '--rm', IMAGE, 'cat', 'dist/release-identity.json']).stdout);
    check(identity.build === (commit === '' ? 'development' : 'release'), `image identity build is ${identity.build}`);
    record('D1', 'clean export builds the runtime image', true, `${flag('--host-build') ? 'npm ci + build on host, ' : ''}image ${identity.release}`);
  } catch (error) {
    record('D1', 'clean export builds the runtime image', false, error.message);
    return;
  }

  // ---- D13 artifact hygiene -----------------------------------------------------------------
  try {
    const scan = run('docker', [
      'run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      `grep -rl "${CANARY}" /app /home /etc/frontera /var/lib/frontera 2>/dev/null; ` +
        // Developer state, anywhere the image could carry it (dependencies included).
        `find /app /home/node /etc/frontera /var/lib/frontera /var/lib/frontera-witness \\( -name '.env*' -o -name '*.sqlite*' -o -name '.git' -o -name '*.pem' -o -name '*.key' -o -name coverage -o -name '*.log' -o -name '.data' \\) 2>/dev/null; ` +
        // Test and build leftovers of our own code (third-party packages ship what they publish).
        `find /app/dist /app/packages /app/scripts \\( -name '__tests__' -o -name 'dist-test' -o -name '*.test.js' -o -name '*.tsbuildinfo' -o -name '*.map' \\) 2>/dev/null; ` +
        `for d in src tests apps docs vendor examples deploy .github; do [ -e "/app/$d" ] && echo "/app/$d"; done; ` +
        `[ "$(id -u)" = 0 ] && echo 'runs as root'; true`,
    ]).stdout.trim();
    check(scan === '', `the image contains: ${scan.split('\n').slice(0, 12).join(', ')}`);
    record('D13', 'image excludes .env, .git, databases, keys, tests, caches and every canary; runs non-root', true, `${canaryFiles.length} canary files planted in the build context`);
  } catch (error) {
    record('D13', 'artifact hygiene', false, error.message);
  }

  // ---- configuration, as documented --------------------------------------------------------
  copyFileSync(join(pilotDir, '.env.example'), join(pilotDir, '.env'));
  const governed = JSON.parse(readFileSync(join(pilotDir, 'governed-actions.example.json'), 'utf8'));
  // No egress from a qualification run: `.invalid` never resolves, so an
  // authorized action reaches the adapter and fails before a byte is sent.
  governed.genericHttpAdapters[0].origin = 'https://provider.frontera-qualification.invalid';
  writeFileSync(join(pilotDir, 'governed-actions.json'), `${JSON.stringify(governed, null, 2)}\n`);
  const generated = compose(['run', '--rm', '-T', 'witness-init', '--secret', 'FRONTERA_OPERATOR_KEY_ADMIN', '--secret', 'FRONTERA_OPERATOR_KEY_OBSERVER']);
  appendFileSync(join(pilotDir, '.env'), generated.stdout);
  const again = compose(['run', '--rm', '-T', 'witness-init'], { allowFailure: true });
  check(again.status !== 0 && again.stdout === '', 'the secret generator must refuse a second run and print nothing');
  // An operator added later: a credential only, no key touched.
  const extra = compose(['run', '--rm', '-T', 'witness-init', '--secrets-only', '--secret', 'FRONTERA_OPERATOR_KEY_LATER']);
  const extraNames = extra.stdout.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split('=')[0]);
  check(JSON.stringify(extraNames) === '["FRONTERA_OPERATOR_KEY_LATER"]', `--secrets-only printed ${extraNames.join(', ')}`);

  // ---- D2 missing required configuration ----------------------------------------------------
  try {
    const missing = configCheck();
    captured.push(missing.stdout, missing.stderr);
    check(missing.status === 1, `config-check exited ${missing.status}`);
    check(/\[CONFIG_PLACEHOLDER_VALUE\]/.test(missing.stdout), 'no placeholder refusal');
    check(missing.stdout.includes('AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID') && missing.stdout.includes('FRONTERA_PROVIDER_TOKEN'), 'the refusal does not name both variables');
    check(compose(['ps', '-q']).stdout.trim() === '', 'the configuration check or the generator left services running');
    compose(['up', '-d']);
    check(await neverReady(20_000), '/ready answered 200 on a refused configuration');
    check(/refused to start \[CONFIG_PLACEHOLDER_VALUE\]/.test(logs()), 'the launcher did not refuse with the placeholder code');
    compose(['stop', 'frontera']);
    record('D2', 'missing required configuration: config-check exits 1, the Host refuses and never becomes ready', true, 'CONFIG_PLACEHOLDER_VALUE, variables named, no value printed');
  } catch (error) {
    record('D2', 'missing required configuration', false, error.message);
  }

  // ---- D3 valid configuration --------------------------------------------------------------
  const envPath = join(pilotDir, '.env');
  setEnvValue(envPath, 'AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID', ORG);
  setEnvValue(envPath, 'FRONTERA_PROVIDER_TOKEN', `${CANARY}PROVIDER`);
  const env = parseEnvFile(envPath);
  operator.admin = `Bearer ${env.FRONTERA_OPERATOR_KEY_ADMIN}`;
  operator.observer = `Bearer ${env.FRONTERA_OPERATOR_KEY_OBSERVER}`;
  try {
    const valid = configCheck();
    captured.push(valid.stdout, valid.stderr);
    check(valid.status === 0, `config-check exited ${valid.status}: ${valid.stdout}`);
    compose(['up', '-d']);
    await waitReady();
    check((await http('GET', '/live')).status === 200, '/live is not 200');
    record('D3', 'valid configuration: config-check exits 0, the Host starts and becomes ready', true);
  } catch (error) {
    record('D3', 'valid configuration', false, error.message);
    return;
  }

  // ---- D5 release identity -----------------------------------------------------------------
  try {
    const version = await http('GET', '/version');
    check(version.status === 200, `/version answered ${version.status}`);
    const recorded = JSON.parse(run('docker', ['run', '--rm', IMAGE, 'cat', 'dist/release-identity.json']).stdout);
    const label = run('docker', ['image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', IMAGE]).stdout.trim();
    check(version.body.commit === (commit === '' ? 'unknown' : commit), `/version commit ${version.body.commit}`);
    check(version.body.release === recorded.release && version.body.version === recorded.version && version.body.commit === recorded.commit, '/version disagrees with the image');
    check(label === commit, `image revision label '${label}'`);
    const manifest = JSON.parse(readFileSync(join(exportDir, 'release', 'RELEASE_MANIFEST.json'), 'utf8'));
    check(version.body.version === manifest.version && version.body.api.endpointCount === manifest.api.endpointCount, '/version disagrees with release/RELEASE_MANIFEST.json');
    record('D5', '/version matches the built artifact, its label and the release manifest', true, `${version.body.release} build=${version.body.build}`);
  } catch (error) {
    record('D5', 'release identity', false, error.message);
  }

  // ---- durable governed state, over HTTP -----------------------------------------------------
  try {
    await provision('actor', { actorId: 'actor-qual-org', type: 'organization', displayName: 'Qualification Org' });
    await provision('trust-domain', { trustDomainId: governed.trustDomainId, name: 'Qualification', issuerActorId: 'actor-qual-org', acceptedIssuerIds: ['actor-qual-org'], acceptedActorTypes: ['human', 'organization', 'agent'] });
    await provision('root-issuer', { trustDomainId: governed.trustDomainId, actorId: 'actor-qual-org' });
    await provision('actor', { actorId: 'actor-qual-owner', type: 'human', displayName: 'Owner', issuerId: 'actor-qual-org', trustDomainId: governed.trustDomainId });
    await provision('actor', { actorId: 'actor-qual-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-qual-org', trustDomainId: governed.trustDomainId, externalSubject: { system: 'qualification', subjectId: 'agent-1' } });
    // The one response whose purpose is to hand a secret over: the one-time
    // agent credential, to the operator who issued it. Not part of D12's haystack.
    const issued = await http('POST', '/api/admin/agents/actor-qual-agent/credentials', { authorization: operator.admin, body: { idempotencyKey: 'qual-issue-1' }, capture: false });
    check(issued.status === 200, `credential issue ${issued.status}`);
    state.agentCredential = issued.body.bearerCredential;
    const scope = { actions: [ACTION], resourceScopes: [RESOURCE_A, RESOURCE_B] };
    await provision('authority-grant', { authorityGrantId: 'authority-qual-agent', issuerActorId: 'actor-qual-org', subjectActorId: 'actor-qual-owner', trustDomainId: governed.trustDomainId, capability: 'qual.manage', ...scope, canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1 });
    await provision('passport', { passportId: 'passport-qual-agent', type: 'agent_passport', subjectActorId: 'actor-qual-agent', issuerActorId: 'actor-qual-org', trustDomainId: governed.trustDomainId });
    await provision('capability-token', { capabilityTokenId: 'capability-qual-agent', subjectActorId: 'actor-qual-agent', principalActorId: 'actor-qual-owner', issuerActorId: 'actor-qual-owner', trustDomainId: governed.trustDomainId, capability: 'qual.execute', ...scope, riskLevel: 'medium' });
    await provision('delegation-grant', { delegationGrantId: 'delegation-qual-agent', delegatorActorId: 'actor-qual-owner', delegateActorId: 'actor-qual-agent', delegateActorType: 'agent', trustDomainId: governed.trustDomainId, sourceAuthorityGrantId: 'authority-qual-agent', capability: 'qual.execute', ...scope, canRedelegate: false });

    const allowed = await govern(RESOURCE_A, 'qual-allowed-1');
    check(typeof allowed.body.requestId === 'string' && allowed.body.status !== 'denied' && allowed.body.status !== 'withheld', `the authorized action was ${allowed.body.status}: ${allowed.text.slice(0, 300)}`);
    state.allowedRequestId = allowed.body.requestId;
    state.allowedStatus = allowed.body.status;
    const denied = await govern('ledger-unauthorized', 'qual-denied-1');
    check(denied.body.status === 'denied', `the unauthorized action was ${denied.body.status}`);
    const stop = await http('POST', '/api/admin/emergency-controls/activate', { authorization: operator.admin, body: { scope: 'resource', value: RESOURCE_B } });
    check(stop.status === 200, `emergency stop ${stop.status}`);
    const withheld = await govern(RESOURCE_B, 'qual-withheld-1');
    check(withheld.body.status === 'withheld' && withheld.body.withheldBy === 'emergency-control', `the stopped resource was ${withheld.body.status}/${withheld.body.withheldBy}`);
    state.before = await snapshot();
    check(state.before.views.length >= 3, `only ${state.before.views.length} execution records`);
    const health = await http('GET', '/health');
    const p12 = Object.entries(health.body.modules ?? {}).find(([id]) => /reconciliation|resolution/i.test(id));
    state.p12Module = p12?.[0];
    check(p12 !== undefined && p12[1].required === true && p12[1].health.status === 'healthy', 'P12 is not a required, healthy module');
    log(`     state: ${state.before.views.length} execution records, authorized action '${state.allowedStatus}', P12 module '${state.p12Module}' required`);
  } catch (error) {
    record('D4', 'durable governed state could not be created', false, error.message);
    return;
  }

  // ---- D11 clean shutdown + D15 restart persistence -----------------------------------------
  try {
    compose(['stop', 'frontera']);
    check(exitCodeOf('frontera') === 0, `frontera exited ${exitCodeOf('frontera')} on SIGTERM`);
    check(/enterprise\.host\.shutdown_complete/.test(logs()), 'no shutdown_complete event');
    compose(['up', '-d']);
    await waitReady();
    const after = await snapshot();
    check(JSON.stringify(after) === JSON.stringify(state.before), `state changed across the restart: ${JSON.stringify(after)} vs ${JSON.stringify(state.before)}`);
    const stillWithheld = await govern(RESOURCE_B, 'qual-withheld-2');
    check(stillWithheld.body.withheldBy === 'emergency-control', 'the emergency stop did not survive the restart');
    const replay = await govern(RESOURCE_A, 'qual-allowed-1');
    check(replay.body.requestId === state.allowedRequestId, 'the idempotent replay did not return the original request');
    state.before = await snapshot();
    record('D11', 'SIGTERM (docker compose stop) exits 0 after shutdown_complete; the same stores reopen', true);
    record('D15', 'executions, trace, agents and the emergency stop survive a Host restart; replay is idempotent', true, `${after.views.length} records`);
  } catch (error) {
    record('D11/D15', 'clean shutdown and restart persistence', false, error.message);
  }

  // ---- D4 persistent storage: the whole stack recreated ------------------------------------
  try {
    compose(['down']);
    compose(['up', '-d']);
    await waitReady();
    const after = await snapshot();
    check(JSON.stringify(after) === JSON.stringify(state.before), 'state changed across down/up');
    record('D4', 'containers removed and recreated (volumes kept): every record is still there', true);
  } catch (error) {
    record('D4', 'persistent storage', false, error.message);
  }

  // ---- D7 degradation: the witness goes away after startup ---------------------------------
  try {
    compose(['stop', 'authority-witness']);
    await waitFor(async () => (await http('GET', '/health')).body.status === 'degraded', 60_000, 'health degraded');
    check((await http('GET', '/live')).status === 200, '/live failed while degraded');
    check((await http('GET', '/ready')).status === 200, '/ready failed while degraded (existing authority is still served)');
    compose(['start', 'authority-witness']);
    await waitFor(async () => (await http('GET', '/health')).body.status === 'healthy', 90_000, 'health healthy again');
    record('D7', 'witness outage after startup: degraded, still live and ready; recovers when it returns', true);
  } catch (error) {
    record('D7', 'degradation follows existing criticality', false, error.message);
  }

  // ---- D6 required dependency failure at boot ------------------------------------------------
  try {
    compose(['stop', 'frontera', 'authority-witness']);
    compose(['up', '-d', '--no-deps', 'frontera']);
    check(await neverReady(25_000), '/ready answered 200 without the required witness');
    check(/refused to start \[[A-Z_]+\]/.test(logs()), 'no refusal code in the logs');
    compose(['stop', 'frontera']);
    compose(['up', '-d']);
    await waitReady();
    record('D6', 'required dependency down at boot: the Host refuses and is never ready; P12 is a required module', true, `P12 module '${state.p12Module}'`);
  } catch (error) {
    record('D6', 'required module failure', false, error.message);
  }

  // ---- D8 / D9 storage faults (override files: the kit's volume removed or read-only) -------
  const fault = (name, volumes, extra = '') => {
    const file = join(pilotDir, `qualification-${name}.yaml`);
    const list = volumes.map((volume) => `      - ${volume}\n`).join('');
    writeFileSync(file, `services:\n  frontera:\n    volumes: !override\n${list}${extra}  config-check:\n    volumes: !override\n${list}${extra}`);
    return ['compose.yaml', file];
  };
  compose(['stop', 'frontera']);
  for (const [id, name, volumes, code, extra] of [
    ['D8', 'no state volume (container layer)', ['./governed-actions.json:/etc/frontera/governed-actions.json:ro,z'], 'STORAGE_NOT_PERSISTENT'],
    ['D8', 'state on a tmpfs mount', ['./governed-actions.json:/etc/frontera/governed-actions.json:ro,z'], 'STORAGE_NOT_PERSISTENT', '    tmpfs:\n      - /var/lib/frontera:uid=1000,gid=1000,mode=0700\n'],
    ['D9', 'read-only state volume', ['frontera-state:/var/lib/frontera:ro', './governed-actions.json:/etc/frontera/governed-actions.json:ro,z'], 'STORAGE_NOT_WRITABLE'],
  ]) {
    try {
      const files = fault(`${id.toLowerCase()}-${name.replace(/[^a-z]+/gi, '-')}`, volumes, extra);
      const checked = configCheck(files);
      captured.push(checked.stdout, checked.stderr);
      check(checked.status === 1 && checked.stdout.includes(`[${code}]`), `config-check: ${checked.status} ${checked.stdout.slice(-400)}`);
      const launched = compose(['run', '--rm', '-T', 'frontera'], { files, allowFailure: true });
      captured.push(launched.stdout, launched.stderr);
      check(launched.status === 1 && launched.stderr.includes(`refused to start [${code}]`) && !launched.stdout.includes('listening'), `launcher: ${launched.status}`);
      record(id, `${name}: config-check and the launcher refuse with ${code}; nothing listens`, true);
    } catch (error) {
      record(id, name, false, error.message);
    }
  }

  // ---- D10 incompatible schema --------------------------------------------------------------
  const inState = (script) => compose(['run', '--rm', '-T', '--no-deps', 'frontera', 'node', '-e', script], { allowFailure: true });
  try {
    const db = '/var/lib/frontera/enterprise-host.sqlite';
    const prepared = inState(
      `const fs=require('fs');for(const s of ['','-wal','-shm'])if(fs.existsSync('${db}'+s))fs.copyFileSync('${db}'+s,'${db}'+s+'.d10');` +
        `const D=require('better-sqlite3');const d=new D('${db}');d.prepare("INSERT INTO governance_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.governance-store.schema.v999','current',?)").run(new Date().toISOString());d.close();`,
    );
    check(prepared.status === 0, `could not prepare the fault: ${prepared.stderr.slice(-400)}`);
    const checked = configCheck();
    captured.push(checked.stdout);
    check(checked.status === 1 && checked.stdout.includes('[SCHEMA_INCOMPATIBLE]'), `config-check: ${checked.stdout.slice(-400)}`);
    // The Host's own gate, without the preflight in front of it.
    const direct = inState(`require('/app/dist/src/enterprise/index.js').bootEnterpriseHost().then(async h=>{await h.close();console.log('BOOTED');process.exit(2)},e=>{console.log('REFUSED '+(e.code??e.name));process.exit(1)})`);
    captured.push(direct.stdout, direct.stderr);
    check(direct.status === 1 && direct.stdout.includes('REFUSED'), `bootEnterpriseHost: ${direct.status} ${direct.stdout.slice(-300)}`);
    const restored = inState(`const fs=require('fs');for(const s of ['','-wal','-shm']){const f='${db}'+s;if(fs.existsSync(f+'.d10'))fs.renameSync(f+'.d10',f);else if(s&&fs.existsSync(f))fs.rmSync(f)}`);
    check(restored.status === 0, 'could not restore the store');
    record('D10', 'a store at an unknown schema version: config-check and the Host itself refuse (fail closed)', true, direct.stdout.trim().split('\n').pop());
  } catch (error) {
    record('D10', 'schema incompatible', false, error.message);
  }

  // The fault cases must have changed nothing.
  try {
    compose(['up', '-d']);
    await waitReady();
    const after = await snapshot();
    check(JSON.stringify(after) === JSON.stringify(state.before), 'state changed after the fault cases');
    log('     state intact after the fault cases');
  } catch (error) {
    record('D4', 'state after the fault cases', false, error.message);
  }

  // ---- D12 secret leakage --------------------------------------------------------------------
  try {
    for (const path of ['/health', '/ready', '/live', '/version', '/api/admin/agents', '/api/definitely-not-a-route']) captured.push((await http('GET', path)).text);
    captured.push((await http('GET', '/api/admin/agents', { authorization: 'Bearer wrong-credential-for-qualification' })).text);
    captured.push((await http('POST', '/api/governed-actions', { authorization: `Bearer ${state.agentCredential}`, body: '{not json' })).text);
    captured.push(logs());
    // [label, value]: a leak is reported by label, never by value.
    const secrets = [
      ...Object.entries(env)
        .filter(([name]) => /KEY_PEM|TOKEN|OPERATOR_KEY/.test(name))
        .flatMap(([name, value]) => [[name, value], ...value.split('\n').filter((line) => line.length >= 20 && !line.startsWith('-----')).map((line, index) => [`${name} line ${index + 1}`, line])]),
      ['agent credential', state.agentCredential],
      ['provider token canary', `${CANARY}PROVIDER`],
    ].filter(([, value]) => typeof value === 'string' && value.length >= 16);
    const haystack = captured.join('\n');
    const leaked = secrets.filter(([, secret]) => haystack.includes(secret)).map(([label]) => label);
    check(leaked.length === 0, `secret value(s) found in output: ${leaked.join(', ')}`);
    record('D12', 'no secret or canary in config-check output, logs, health, readiness, version or error responses', true, `${secrets.length} values against ${captured.length} captured outputs`);
  } catch (error) {
    record('D12', 'secret leakage', false, error.message);
  }

  // ---- D14 rail neutrality -------------------------------------------------------------------
  try {
    const configured = [...Object.keys(env), ...compose(['config']).stdout.split('\n').filter((line) => /^\s+[A-Z_]+:/.test(line))].join('\n');
    const hits = configured.match(/xrpl|rlusd|lightning|wallet|PAY_/gi) ?? [];
    check(hits.length === 0, `rail configuration present: ${hits.join(', ')}`);
    record('D14', 'the deployment carries no XRPL, RLUSD, Lightning, wallet or PAY configuration', true);
  } catch (error) {
    record('D14', 'rail neutrality', false, error.message);
  }

  // ---- final clean stop ----------------------------------------------------------------------
  try {
    compose(['stop']);
    check(exitCodeOf('frontera') === 0 && exitCodeOf('authority-witness') === 0, `exit codes frontera=${exitCodeOf('frontera')} witness=${exitCodeOf('authority-witness')}`);
    log('     final stop: every service exited 0');
  } catch (error) {
    record('D11', 'final clean stop', false, error.message);
  }
}

try {
  await main();
} catch (error) {
  record('ERR', 'qualification aborted', false, error.message);
} finally {
  if (flag('--keep')) {
    log(`kept: project ${PROJECT}, image ${IMAGE}, export ${exportDir}`);
  } else {
    compose(['down', '-v', '--remove-orphans'], { allowFailure: true });
    run('docker', ['image', 'rm', '-f', IMAGE], { allowFailure: true });
    rmSync(work, { recursive: true, force: true });
  }
}

log('');
log(`Pilot deployment qualification: ${results.filter((result) => result.ok).length}/${results.length} passed${failed ? ' — FAILED' : ''}`);
process.exit(failed ? 1 : 0);
