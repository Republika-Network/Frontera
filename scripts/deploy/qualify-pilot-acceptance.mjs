// PROD-03-04 — pilot acceptance qualification (cases O1–O15).
//
// Qualifies the pilot OPERATIONS documentation itself: it builds the kit from a
// clean export of the commit, as PROD-03-03's qualification does, and then
// executes the command blocks of docs/pilot/OPERATIONS_RUNBOOK.md and
// docs/pilot/INCIDENT_TRIAGE.md exactly as written. Every block marked
// `<!-- exec: <id> -->` is run with bash in deploy/pilot/; only three things
// are substituted, so the run is isolated from any real deployment on the
// machine:
//
//   127.0.0.1:8787          -> 127.0.0.1:<free port>
//   frontera-pilot_         -> <run project>_          (volume names)
//   frontera-host:previous  -> <run image>-previous    (the rollback tag)
//
// The variables a block expects from the operator (ADMIN, OBSERVER,
// BACKUP_DIR, BACKUP_FILE, REQUEST_ID, EXECUTION_ID, STOP_SCOPE, STOP_VALUE)
// are set from the run's own state. A documented command that fails, or whose
// result differs from what the runbook says, fails its case.
//
// It never records a human acknowledgement: the acceptance criteria that are
// people's decisions (A14–A17) are written to the evidence pack as `not-run`.
//
//   node scripts/deploy/qualify-pilot-acceptance.mjs (--commit <40-hex> | --from-commit <ref>) [--host-build] [--evidence <file>] [--keep]
//
// The qualified source is always `git archive` of that one commit, never the
// working tree, so the identity it records is the code it ran. Blocks run as
// an operator's interactive shell runs them: no `set -e`, no `pipefail`; a
// block's own `&&` chains and failure messages are what is qualified.
//
// Needs Docker with Compose v2, bash, curl, sha256sum and Node >= 22. Exit 0
// only when every case passes. Each run uses its own Compose project, image
// tags, volumes, port and scratch directory, and removes them (unless --keep).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The documents whose `exec` blocks this qualification runs. */
export const EXECUTED_DOCUMENTS = ['docs/pilot/OPERATIONS_RUNBOOK.md', 'docs/pilot/INCIDENT_TRIAGE.md'];

/** Markers the documented blocks print when they stop short; any of them fails the block. */
const BLOCK_FAILURE_MARKERS = /BACKUP FAILED|WITNESS BACKUP FAILED|RESTORE NOT COMPLETED/;

/** Every block id this qualification executes; the structure test requires the documents to carry exactly these. */
export const EXECUTED_BLOCKS = [
  'startup-identity', 'startup-config-check', 'startup-volumes', 'startup-start', 'startup-inspect',
  'shutdown', 'restart',
  'backup-take', 'backup-verify', 'witness-backup',
  'restore-compatibility', 'restore-run', 'restore-start',
  'upgrade-prepare', 'upgrade-apply', 'rollback-image',
  'health-inspect',
  'resolution-list', 'resolution-inspect', 'resolution-submit',
  'emergency-activate', 'emergency-release',
  'approvals-list',
  'evidence-capture',
];

/** `<!-- exec: id -->` blocks of one Markdown document: id → script (list-item indentation removed). */
export function executableBlocks(markdown) {
  const blocks = new Map();
  for (const match of markdown.replace(/\r\n/g, '\n').matchAll(/^([ \t]*)<!-- exec: ([a-z0-9-]+) -->\n\1```bash\n([\s\S]*?)\n\1```$/gm)) {
    const [, indent, id, body] = match;
    if (blocks.has(id)) throw new Error(`duplicate exec block ${id}`);
    blocks.set(id, body.split('\n').map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n'));
  }
  return blocks;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await qualify();

async function qualify() {
  const RUN = randomBytes(4).toString('hex');
  const PROJECT = `frontera-accept-${RUN}`;
  const IMAGE = `frontera-host:accept-${RUN}`;
  const CANARY = `FRONTERAACCEPTCANARY${randomBytes(12).toString('hex')}`;
  const ORG = 'org-acceptance';
  const RESOURCE_A = 'ledger-a';
  const RESOURCE_B = 'ledger-b';
  const ACTION = 'record.update';

  const results = [];
  const captured = [];
  let failed = false;

  const log = (line) => process.stdout.write(`${line}\n`);
  function record(id, title, ok, detail) {
    results.push({ id, title, ok, detail: detail ?? null });
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
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

  // ---- export -------------------------------------------------------------------------------
  const work = mkdtempSync(join(tmpdir(), 'frontera-acceptance-'));
  const exportDir = join(work, 'frontera');
  const pilotDir = join(exportDir, 'deploy', 'pilot');
  const backupDir = join(work, 'backups');
  mkdirSync(exportDir);
  mkdirSync(backupDir);

  const requested = option('--from-commit') ?? option('--commit');
  const resolved = requested === undefined ? null : spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${requested}^{commit}`], { encoding: 'utf8' });
  const commit = resolved?.status === 0 ? resolved.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit) || (option('--commit') !== undefined && option('--commit') !== commit)) {
    rmSync(work, { recursive: true, force: true });
    log('Pilot acceptance qualifies one identified commit: pass --commit <40-hex> (a full hash present in this repository) or --from-commit <ref>.');
    process.exit(2);
  }
  // No shell: the commit and the paths are arguments, never interpolated into a command line.
  const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', commit], { maxBuffer: 1024 * 1024 * 1024 });
  check(archive.status === 0, `git archive ${commit} failed: ${archive.stderr}`);
  const extracted = spawnSync('tar', ['-x', '-C', exportDir], { input: archive.stdout, encoding: 'utf8' });
  check(extracted.status === 0, `extracting ${commit} failed: ${extracted.stderr}`);

  const port = await freePort();
  const composeEnv = { ...process.env, FRONTERA_IMAGE: IMAGE, FRONTERA_BUILD_COMMIT: commit, FRONTERA_PUBLISH_PORT: String(port), COMPOSE_PROJECT_NAME: PROJECT };
  const compose = (composeArgs, options = {}) => run('docker', ['compose', ...composeArgs], { cwd: pilotDir, env: composeEnv, ...options });
  const base = `http://127.0.0.1:${port}`;

  // ---- the documented commands ----------------------------------------------------------------
  const blocks = new Map();
  for (const document of EXECUTED_DOCUMENTS) {
    for (const [id, script] of executableBlocks(readFileSync(join(exportDir, document), 'utf8'))) blocks.set(id, script);
  }
  const executed = new Set();
  const substitute = (script) => script.replaceAll('127.0.0.1:8787', `127.0.0.1:${port}`).replaceAll('frontera-pilot_', `${PROJECT}_`).replaceAll('frontera-host:previous', `${IMAGE}-previous`);
  const operatorVariables = {};

  /** Runs one documented block, as written, the way an interactive shell runs it; `exports` names variables the block sets that the caller needs back. */
  function doc(id, variables = {}, { exports = [], allowFailure = false } = {}) {
    const script = blocks.get(id);
    check(script !== undefined, `the documentation has no exec block '${id}'`);
    executed.add(id);
    const epilogue = exports.map((name) => `\nprintf '\\n@@%s=%s\\n' '${name}' "$${name}"`).join('');
    const out = run('bash', ['-c', `${substitute(script)}${epilogue}`], {
      cwd: pilotDir,
      env: { ...composeEnv, ...operatorVariables, ...variables },
      allowFailure: true,
    });
    captured.push(out.stdout, out.stderr);
    if (!allowFailure && (out.status !== 0 || BLOCK_FAILURE_MARKERS.test(out.stderr))) throw new Error(`documented block '${id}' exited ${out.status}: ${(out.stderr || out.stdout).slice(-1500)}`);
    const values = {};
    for (const [, name, value] of out.stdout.matchAll(/^@@([A-Z_]+)=(.*)$/gm)) values[name] = value;
    return { ...out, values };
  }

  async function http(method, path, { authorization, body, capture = true } = {}, attempt = 1) {
    const headers = { ...(authorization !== undefined ? { authorization } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    try {
      const response = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
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
      // A documented block may have restarted the Host behind fetch's keep-alive
      // pool: a read is attempted again on a fresh connection. A POST never is.
      if (method === 'GET' && attempt < 3) {
        await sleep(500);
        return http(method, path, { authorization, body, capture }, attempt + 1);
      }
      return { status: 0, body: {}, text: '' };
    }
  }
  async function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(1000);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async function neverReady(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await http('GET', '/ready')).status === 200) return false;
      await sleep(1000);
    }
    return true;
  }
  const json = (text) => JSON.parse(text.trim().split('\n').filter((line) => line.startsWith('{')).pop() ?? '{}');
  /** The `/version` document among a block's output lines. */
  const versionOf = (text) => JSON.parse(text.split('\n').find((line) => line.includes('"schema":"frontera.release-identity.v1"')) ?? '{}');

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

  const state = {};
  const operator = {};
  const evidence = { release: null, health: null, backup: null, restore: null, restart: null, operatorResolution: null, evidenceBundle: null };

  async function snapshot() {
    const metrics = await http('GET', '/api/admin/operations/metrics', { authorization: operator.observer });
    check(metrics.status === 200, `operations/metrics answered ${metrics.status}`);
    const executions = await http('GET', '/api/admin/operations/executions?limit=50', { authorization: operator.observer });
    check(executions.status === 200, `operations/executions answered ${executions.status}`);
    const attention = await http('GET', '/api/admin/operations/attention?limit=50', { authorization: operator.observer });
    check(attention.status === 200, `operations/attention answered ${attention.status}`);
    const stops = await http('GET', '/api/admin/emergency-controls', { authorization: operator.observer });
    check(stops.status === 200, `emergency-controls answered ${stops.status}`);
    const agents = await http('GET', '/api/admin/agents', { authorization: operator.observer });
    check(agents.status === 200, `agents answered ${agents.status}`);
    return {
      decisions: metrics.body.decisions,
      executions: (executions.body.executions ?? []).map((view) => `${view.requestId}:${view.classification}`).sort(),
      attention: (attention.body.attention ?? []).map((view) => view.requestId).sort(),
      stops: JSON.stringify(stops.body.active ?? []),
      agents: (agents.body.agents ?? []).map((agent) => agent.actorId ?? agent.agentId).sort(),
    };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const govern = (resource, idempotencyKey) => http('POST', '/api/governed-actions', { authorization: `Bearer ${state.agentCredential}`, body: { action: ACTION, resource, idempotencyKey } });
  async function provision(kind, body) {
    const reply = await http('POST', `/api/admin/authority/entities/${kind}`, { authorization: operator.admin, body });
    check(reply.status === 200 && reply.body.outcome === 'provisioned', `provision ${kind}: ${reply.status} ${reply.text.slice(0, 300)}`);
  }
  async function waitHealthy(timeoutMs = 90_000) {
    await waitFor(async () => (await http('GET', '/health')).body.status === 'healthy', timeoutMs, '/health healthy');
  }

  async function main() {
    // ---- build and configure (PROD-03-03 quickstart; qualified there) ------------------------
    try {
      if (flag('--host-build')) {
        run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: exportDir });
        run('npm', ['run', 'build'], { cwd: exportDir });
      }
      compose(['build']);
      copyFileSync(join(pilotDir, '.env.example'), join(pilotDir, '.env'));
      const governed = JSON.parse(readFileSync(join(pilotDir, 'governed-actions.example.json'), 'utf8'));
      // No egress: `.invalid` never resolves, so an authorized action reaches the adapter and fails before a byte is sent.
      governed.genericHttpAdapters[0].origin = 'https://provider.frontera-acceptance.invalid';
      state.trustDomainId = governed.trustDomainId;
      writeFileSync(join(pilotDir, 'governed-actions.json'), `${JSON.stringify(governed, null, 2)}\n`, { mode: 0o644 });
      appendFileSync(join(pilotDir, '.env'), compose(['run', '--rm', '-T', 'witness-init', '--secret', 'FRONTERA_OPERATOR_KEY_ADMIN', '--secret', 'FRONTERA_OPERATOR_KEY_OBSERVER']).stdout);
      setEnvValue(join(pilotDir, '.env'), 'AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID', `'${ORG}'`);
      setEnvValue(join(pilotDir, '.env'), 'FRONTERA_PROVIDER_TOKEN', `'${CANARY}PROVIDER'`);
      state.env = parseEnvFile(join(pilotDir, '.env'));
      operator.admin = `Bearer ${state.env.FRONTERA_OPERATOR_KEY_ADMIN}`;
      operator.observer = `Bearer ${state.env.FRONTERA_OPERATOR_KEY_OBSERVER}`;
      // What the runbook's operator session exports: whole header lines for curl -H.
      operatorVariables.ADMIN = `Authorization: ${operator.admin}`;
      operatorVariables.OBSERVER = `Authorization: ${operator.observer}`;
      operatorVariables.BACKUP_DIR = backupDir;
      log(`     built ${IMAGE} from ${commit.slice(0, 12)}; project ${PROJECT}; port ${port}`);
    } catch (error) {
      record('O1', 'build and configuration', false, error.message);
      return;
    }

    // ---- O1 documented startup + O6 version ------------------------------------------------------
    try {
      const identity = doc('startup-identity');
      check(identity.stdout.trim() === commit, `the image label is '${identity.stdout.trim()}', not the approved commit`);
      const checked = doc('startup-config-check');
      check(/RESULT: PASS/.test(checked.stdout), 'the configuration check did not pass');
      const volumes = doc('startup-volumes');
      check(volumes.stdout.includes(`${PROJECT}_frontera-state`) && volumes.stdout.includes(`${PROJECT}_frontera-witness`), 'a volume is missing');
      doc('startup-start');
      state.startupOutput = doc('startup-inspect').stdout;
      check((await http('GET', '/ready')).status === 200, '/ready is not 200');
      record('O1', 'documented startup: identity, config-check, volumes, start, /live, /ready, health, version — ready', true);
    } catch (error) {
      record('O1', 'documented startup', false, error.message);
      return;
    }
    try {
      const version = versionOf(state.startupOutput);
      check(version.commit === commit && version.build === 'release', `/version commit ${version.commit} build ${version.build}`);
      const manifest = JSON.parse(readFileSync(join(exportDir, 'release', 'RELEASE_MANIFEST.json'), 'utf8'));
      check(version.version === manifest.version && version.api?.endpointCount === manifest.api.endpointCount, '/version disagrees with the release manifest');
      evidence.release = { version: version.version, release: version.release, commit: version.commit, build: version.build, api: version.api, runtimeVersions: version.runtimeVersions };
      record('O6', '/version matches the approved commit, the image label and the release manifest', true, version.release);
    } catch (error) {
      record('O6', 'release identity', false, error.message);
    }

    // ---- O7 live / ready / health ------------------------------------------------------------------
    try {
      const live = await http('GET', '/live');
      const ready = await http('GET', '/ready');
      const health = await http('GET', '/health');
      check(live.status === 200 && ready.status === 200 && ready.body.ready === true, '/live or /ready is not 200');
      check(['healthy', 'degraded', 'unhealthy'].includes(health.body.status) && typeof health.body.modules === 'object', '/health lacks status or modules');
      const modules = Object.entries(health.body.modules);
      check(modules.some(([, module]) => module.required === true) && modules.some(([, module]) => module.required === false), 'modules do not state criticality');
      check(health.body.modules['aoc.enterprise.execution-resolutions']?.required === true, 'P12 is not a required module');
      const operations = await http('GET', '/api/admin/operations/health', { authorization: operator.observer });
      check(operations.status === 200 && operations.body.health?.status === health.body.status && typeof operations.body.operations?.unresolvedExecutions === 'number', 'the operator health view is not /health plus operations');
      const inspected = doc('health-inspect');
      check(inspected.stdout.includes('/ready HTTP 200'), 'health-inspect does not show /ready 200');
      evidence.health = { status: health.body.status, degradedModules: modules.filter(([, module]) => module.health?.status !== 'healthy').map(([id]) => id) };
      record('O7', 'live, ready and health are distinct as documented; the operator view adds operations', true, `${modules.length} modules, ${modules.filter(([, module]) => module.required).length} required`);
    } catch (error) {
      record('O7', 'live / ready / health', false, error.message);
    }

    // ---- governed state over HTTP (A5/A6), and O12 emergency control -----------------------------
    try {
      await provision('actor', { actorId: 'actor-accept-org', type: 'organization', displayName: 'Acceptance Org' });
      await provision('trust-domain', { trustDomainId: state.trustDomainId, name: 'Acceptance', issuerActorId: 'actor-accept-org', acceptedIssuerIds: ['actor-accept-org'], acceptedActorTypes: ['human', 'organization', 'agent'] });
      await provision('root-issuer', { trustDomainId: state.trustDomainId, actorId: 'actor-accept-org' });
      await provision('actor', { actorId: 'actor-accept-owner', type: 'human', displayName: 'Owner', issuerId: 'actor-accept-org', trustDomainId: state.trustDomainId });
      await provision('actor', { actorId: 'actor-accept-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-accept-org', trustDomainId: state.trustDomainId, externalSubject: { system: 'acceptance', subjectId: 'agent-1' } });
      // The one response whose purpose is to hand a secret over (the one-time agent credential): not part of O13's haystack.
      const issued = await http('POST', '/api/admin/agents/actor-accept-agent/credentials', { authorization: operator.admin, body: { idempotencyKey: 'accept-issue-1' }, capture: false });
      check(issued.status === 200, `credential issue ${issued.status}`);
      state.agentCredential = issued.body.bearerCredential;
      const scope = { actions: [ACTION], resourceScopes: [RESOURCE_A, RESOURCE_B] };
      await provision('authority-grant', { authorityGrantId: 'authority-accept-agent', issuerActorId: 'actor-accept-org', subjectActorId: 'actor-accept-owner', trustDomainId: state.trustDomainId, capability: 'accept.manage', ...scope, canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1 });
      await provision('passport', { passportId: 'passport-accept-agent', type: 'agent_passport', subjectActorId: 'actor-accept-agent', issuerActorId: 'actor-accept-org', trustDomainId: state.trustDomainId });
      await provision('capability-token', { capabilityTokenId: 'capability-accept-agent', subjectActorId: 'actor-accept-agent', principalActorId: 'actor-accept-owner', issuerActorId: 'actor-accept-owner', trustDomainId: state.trustDomainId, capability: 'accept.execute', ...scope, riskLevel: 'medium' });
      await provision('delegation-grant', { delegationGrantId: 'delegation-accept-agent', delegatorActorId: 'actor-accept-owner', delegateActorId: 'actor-accept-agent', delegateActorType: 'agent', trustDomainId: state.trustDomainId, sourceAuthorityGrantId: 'authority-accept-agent', capability: 'accept.execute', ...scope, canRedelegate: false });

      const allowed = await govern(RESOURCE_A, 'accept-allowed-1');
      check(typeof allowed.body.requestId === 'string' && !['denied', 'withheld'].includes(allowed.body.status), `the authorized action was ${allowed.body.status}`);
      state.allowedRequestId = allowed.body.requestId;
      const denied = await govern('ledger-unauthorized', 'accept-denied-1');
      check(denied.body.status === 'denied', `the unauthorized action was ${denied.body.status}`);

      const stop = { STOP_SCOPE: 'resource', STOP_VALUE: RESOURCE_B };
      const activated = doc('emergency-activate', stop);
      check(/"outcome":"activated"/.test(activated.stdout) && activated.stdout.includes(`"value":"${RESOURCE_B}"`), 'activation not shown as documented');
      const withheld = await govern(RESOURCE_B, 'accept-withheld-1');
      check(withheld.body.status === 'withheld' && withheld.body.withheldBy === 'emergency-control', `the stopped resource was ${withheld.body.status}/${withheld.body.withheldBy}`);
      state.withheldRequestId = withheld.body.requestId;
      const released = doc('emergency-release', stop);
      check(/"outcome":"released"/.test(released.stdout) && /"active":\[\]/.test(released.stdout), 'release not shown as documented');
      const afterRelease = await govern(RESOURCE_B, 'accept-after-release-1');
      check(afterRelease.body.withheldBy !== 'emergency-control', 'still withheld after release');
      // A stop that stays active, so the restart and restore cases carry one.
      doc('emergency-activate', stop);
      record('O12', 'documented emergency control: activate → withheld → release → not withheld; an unauthorized action is denied', true, `authorized action '${allowed.body.status}'`);
    } catch (error) {
      record('O12', 'emergency control', false, error.message);
      return;
    }

    // ---- O10 operator resolution commands, O11 capacity / Attention surfacing ---------------------
    try {
      const before = await snapshot();
      const listed = doc('resolution-list');
      const attention = json(listed.stdout);
      check(Array.isArray(attention.attention) && attention.coverage === 'execution-claims-without-definitive-outcome', 'Attention not as documented');
      const inspected = doc('resolution-inspect', { REQUEST_ID: state.allowedRequestId });
      const [viewLine, traceLine] = inspected.stdout.trim().split('\n');
      const view = JSON.parse(viewLine).executions?.[0];
      check(view?.requestId === state.allowedRequestId, 'the execution view was not returned');
      check(JSON.parse(traceLine).requestId === state.allowedRequestId || traceLine.includes(state.allowedRequestId), 'the trace was not returned');
      const refusals = [];
      if (view.executionId) {
        const definitive = doc('resolution-submit', { EXECUTION_ID: view.executionId });
        const code = json(definitive.stdout).error?.code;
        check(['EXECUTION_OUTCOME_ALREADY_DEFINITIVE', 'EXECUTION_NOT_RESOLVABLE'].includes(code), `resolving the executed action answered ${code}`);
        refusals.push(`executed: ${code}`);
      }
      // The execution withheld by the emergency stop: never resolvable.
      const withheldView = JSON.parse(doc('resolution-inspect', { REQUEST_ID: state.withheldRequestId }).stdout.trim().split('\n')[0]).executions?.[0];
      check(withheldView?.requestId === state.withheldRequestId, 'the withheld execution view was not returned');
      check(withheldView.resolvable === false && withheldView.unresolved === false && !attention.attention.some((entry) => entry.requestId === state.withheldRequestId), 'the withheld execution is presented as resolvable');
      if (withheldView.executionId) {
        // As PROD-03-02's R8: withheld at exercise is not resolvable (409); withheld before preparation has no execution record (404).
        const code = json(doc('resolution-submit', { EXECUTION_ID: withheldView.executionId }).stdout).error?.code;
        check(code === 'EXECUTION_NOT_RESOLVABLE' || code === 'EXECUTION_NOT_FOUND', `resolving the withheld action answered ${code}`);
        refusals.push(`withheld: ${code}`);
      } else {
        refusals.push(`withheld: ${withheldView.classification}, no execution id, resolvable false`);
      }
      const unknown = doc('resolution-submit', { EXECUTION_ID: `aoc.exec:${'0'.repeat(32)}` });
      check(json(unknown.stdout).error?.code === 'EXECUTION_NOT_FOUND', 'an unknown execution was not 404');
      refusals.push('unknown: EXECUTION_NOT_FOUND');
      const observer = doc('resolution-submit', { EXECUTION_ID: view.executionId ?? `aoc.exec:${'0'.repeat(32)}`, ADMIN: operatorVariables.OBSERVER });
      check(json(observer.stdout).error?.code === 'OPERATOR_PERMISSION_DENIED', 'an observer was not refused');
      refusals.push('observer: OPERATOR_PERMISSION_DENIED');
      check(same(await snapshot(), before), 'a refused resolution changed operational state');
      if (flag('--host-build')) {
        const suite = run(process.execPath, ['--test', 'dist/src/enterprise/__tests__/prod0302-operator-resolution-host.test.js', 'dist/src/enterprise/__tests__/prod0302-review-hardening.test.js'], { cwd: exportDir, allowFailure: true });
        check(suite.status === 0, `PROD-03-02 in-process suite failed: ${suite.stdout.slice(-1500)}`);
        refusals.push('R1–R8 and capacity in-process: pass');
      }
      evidence.operatorResolution = { result: 'not-applicable', refusals };
      record('O10', 'documented resolution commands answer as documented; refusals record nothing', true, refusals.join('; '));

      const operations = await http('GET', '/api/admin/operations/health', { authorization: operator.observer });
      const ops = operations.body.operations;
      check(ops && typeof ops.unresolvedExecutions === 'number' && typeof ops.attentionRequired === 'number' && ops.scan?.complete === true, 'operations health does not surface unresolved executions and the scan');
      record('O11', 'Attention and capacity follow-up are surfaced as documented', true, `${flag('--host-build') ? 'pending → adjusted in-process; ' : ''}unresolved=${ops.unresolvedExecutions}`);
    } catch (error) {
      record('O10', 'operator resolution', false, error.message);
    }

    // ---- approvals (documented answer on a deployment without approvals) ---------------------------
    try {
      const approvals = doc('approvals-list');
      check(json(approvals.stdout).error?.code === 'NOT_FOUND', 'approvals-list did not answer the documented 404');
    } catch (error) {
      record('O7', 'approvals command', false, error.message);
    }

    // ---- O3 restart ------------------------------------------------------------------------------
    try {
      state.before = await snapshot();
      const restarted = doc('restart');
      check(versionOf(restarted.stdout).commit === commit, 'the version changed across the restart');
      check(same(await snapshot(), state.before), 'state changed across the documented restart');
      evidence.restart = { statePreserved: true };
      record('O3', 'documented restart: release and operational state unchanged', true, `${state.before.executions.length} executions, stop active`);
    } catch (error) {
      record('O3', 'restart', false, error.message);
    }

    // ---- O2 shutdown, then O3 full start ---------------------------------------------------------
    try {
      const stopped = doc('shutdown');
      const lines = stopped.stdout.trim().split('\n');
      check(Number(lines.find((line) => /^\d+$/.test(line))) >= 1, 'no shutdown_complete in the logs');
      check(lines.includes('0'), 'the Host exit code was not 0');
      check(stopped.stdout.includes(`${PROJECT}_frontera-state`) && stopped.stdout.includes(`${PROJECT}_frontera-witness`), 'a volume is gone');
      for (const service of ['frontera', 'authority-witness']) {
        const id = compose(['ps', '-a', '-q', service]).stdout.trim();
        check(run('docker', ['inspect', '-f', '{{.State.ExitCode}}', id]).stdout.trim() === '0', `${service} did not exit 0`);
      }
      record('O2', 'documented shutdown: every service exits 0, shutdown_complete logged, both volumes kept', true);
      doc('startup-start');
      check(same(await snapshot(), state.before), 'state changed across the full stop and start');
      record('O3', 'full stop and start: operational state identical', true);
    } catch (error) {
      record('O2', 'shutdown', false, error.message);
      return;
    }

    // ---- O8 optional degradation: the witness away after startup ---------------------------------
    try {
      compose(['stop', 'authority-witness']);
      await waitFor(async () => (await http('GET', '/health')).body.status === 'degraded', 60_000, '/health degraded');
      const inspected = doc('health-inspect');
      check(inspected.stdout.includes('/ready HTTP 200') && inspected.stdout.includes('"status":"degraded"'), 'degraded is not still ready as documented');
      check((await http('GET', '/live')).status === 200, '/live failed while degraded');
      compose(['start', 'authority-witness']);
      await waitHealthy();
      record('O8', 'witness lost after startup: degraded, still live and ready, as documented; recovers', true);
    } catch (error) {
      record('O8', 'degraded optional', false, error.message);
    }

    // ---- O4 backup -------------------------------------------------------------------------------
    try {
      state.beforeBackup = await snapshot();
      const taken = doc('backup-take', {}, { exports: ['BACKUP_FILE'] });
      state.backupFile = taken.values.BACKUP_FILE;
      check(state.backupFile && existsSync(state.backupFile), 'no backup file');
      const report = JSON.parse(taken.stderr.slice(taken.stderr.indexOf('{\n'), taken.stderr.lastIndexOf('}') + 1));
      check(report.coverageComplete === true && report.consistency === 'cold-attested' && report.sourceCommit === commit, `backup report: complete=${report.coverageComplete} consistency=${report.consistency} commit=${report.sourceCommit}`);
      const verified = doc('backup-verify', { BACKUP_FILE: state.backupFile });
      for (const needle of ['"complete": true', '"operatorAttestedStopped": true', `"commit": "${commit}"`, `"backupId": "${report.backupId}"`]) check(verified.stdout.includes(needle), `the verification does not show ${needle}`);
      check(existsSync(`${state.backupFile}.sha256`), 'no .sha256 beside the backup');
      check(!readFileSync(`${state.backupFile}.sha256`, 'utf8').includes('/'), 'the archive checksum names a path, not the archive beside it');
      check((statSync(state.backupFile).mode & 0o777) === 0o600, 'the backup archive is not mode 600');
      check(same(await snapshot(), state.beforeBackup), 'the backup changed operational state');
      const witness = doc('witness-backup');
      const witnessFile = readdirSync(backupDir).find((name) => name.startsWith('frontera-witness-'));
      const listing = run('tar', ['-tf', join(backupDir, witnessFile)]).stdout;
      check(['./witness.sqlite', './receipt-key.pem', './receipt-key.pem.pub'].every((name) => listing.split('\n').includes(name)), 'the witness archive is incomplete');
      check((statSync(join(backupDir, witnessFile)).mode & 0o777) === 0o600, 'the witness archive (key material) is not mode 600');
      captured.push(witness.stdout);
      await waitHealthy();
      evidence.backup = { backupId: report.backupId, verified: true, stores: report.stores.length };
      record('O4', 'documented backup: cold, streamed out, checksums verified, complete, source commit = the release; witness set separate', true, `${report.backupId}, ${report.stores.length} stores`);
    } catch (error) {
      record('O4', 'backup', false, error.message);
      return;
    }

    // ---- O5 restore, after state moved on, into a replaced state volume --------------------------
    try {
      const later = await govern('ledger-unauthorized', 'accept-after-backup-1');
      check(later.body.status === 'denied', 'the post-backup action was not recorded');
      check(!same(await snapshot(), state.beforeBackup), 'state did not move after the backup');
      // The restore block refuses while the Host runs, and changes nothing.
      const guarded = doc('restore-run', { BACKUP_FILE: state.backupFile }, { allowFailure: true });
      check(guarded.stderr.includes('RESTORE NOT COMPLETED') && !/"status": "restored"/.test(guarded.stdout), 'the restore block ran against a running Host');
      check(!same(await snapshot(), state.beforeBackup), 'a refused restore changed the state');
      doc('backup-take'); // §6 step 3: preserve the current state first.
      const compatibility = doc('restore-compatibility', { BACKUP_FILE: state.backupFile });
      check(compatibility.stdout.split(commit).length - 1 >= 2, 'the backup and the image are not the same release');
      // The disaster: the state volume is lost (qualification only — never a runbook step).
      compose(['rm', '-f', '-s', 'frontera']);
      run('docker', ['volume', 'rm', `${PROJECT}_frontera-state`]);
      const restored = doc('restore-run', { BACKUP_FILE: state.backupFile });
      check(/"status": "restored"/.test(restored.stdout), 'restore did not report restored');
      const started = doc('restore-start');
      check(versionOf(started.stdout).commit === commit, '/version after restore');
      check(same(await snapshot(), state.beforeBackup), 'the restored state is not the backed-up state');
      evidence.restore = { result: 'restored', backupId: evidence.backup.backupId, readyAfterRestore: true };
      record('O5', 'documented restore into a replaced state volume: ready, the backed-up records present, later ones gone', true);
    } catch (error) {
      record('O5', 'restore', false, error.message);
      return;
    }

    // ---- O9 required failure ---------------------------------------------------------------------
    try {
      compose(['stop', 'frontera', 'authority-witness']);
      compose(['up', '-d', '--no-deps', 'frontera']);
      check(await neverReady(25_000), '/ready answered 200 without the required witness');
      check(/refused to start \[[A-Z_]+\]/.test(compose(['logs', '--no-color', 'frontera']).stdout), 'no refusal in the logs');
      compose(['stop', 'frontera']);
      doc('startup-start');
      record('O9', 'required dependency down at boot: refused, never ready, as documented', true);
    } catch (error) {
      record('O9', 'required failure', false, error.message);
    }

    // ---- upgrade and rollback commands (same release on both sides) ------------------------------
    try {
      doc('upgrade-prepare');
      check(existsSync(join(backupDir, 'pre-upgrade-version.json')), 'no pre-upgrade version record');
      const upgraded = doc('upgrade-apply');
      check(versionOf(upgraded.stdout).commit === commit, 'version after upgrade-apply');
      const rolledBack = doc('rollback-image');
      check(versionOf(rolledBack.stdout).commit === commit && /RESULT: PASS/.test(rolledBack.stdout), 'rollback-image');
      check(same(await snapshot(), state.beforeBackup), 'state changed across upgrade and rollback');
      record('O14', 'upgrade and rollback commands run as documented (same release both sides); state intact', true);
    } catch (error) {
      record('O14', 'upgrade / rollback commands', false, error.message);
    }

    // ---- O13 evidence and secrets ----------------------------------------------------------------
    try {
      const bundle = doc('evidence-capture', {}, { exports: ['EVIDENCE_DIR'] });
      const dir = join(pilotDir, bundle.values.EVIDENCE_DIR);
      const files = readdirSync(dir);
      for (const name of ['version.json', 'live.json', 'ready.json', 'health.json', 'operations-health.json', 'attention.json', 'compose-ps.txt', 'compose-logs.txt', 'config-check.txt']) check(files.includes(name), `the bundle lacks ${name}`);
      check(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).commit === commit, 'the bundle does not identify the release');
      const bundleText = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
      captured.push(bundleText, compose(['logs', '--no-color'], { allowFailure: true }).stdout);
      const secrets = [
        ...Object.entries(state.env)
          .filter(([name]) => /KEY_PEM|TOKEN|OPERATOR_KEY/.test(name))
          .flatMap(([name, value]) => [[name, value], ...value.split('\n').filter((line) => line.length >= 20 && !line.startsWith('-----')).map((line, index) => [`${name} line ${index + 1}`, line])]),
        ['agent credential', state.agentCredential],
        ['provider token canary', `${CANARY}PROVIDER`],
      ].filter(([, value]) => typeof value === 'string' && value.length >= 16);
      const haystack = captured.join('\n');
      const leaked = secrets.filter(([, secret]) => haystack.includes(secret)).map(([label]) => label);
      check(leaked.length === 0, `secret value(s) found: ${leaked.join(', ')}`);
      evidence.evidenceBundle = files.sort();
      record('O13', 'the evidence bundle identifies the release; no secret in it or in any documented command output', true, `${secrets.length} values against ${captured.length} outputs`);
    } catch (error) {
      record('O13', 'evidence', false, error.message);
    }

    // ---- O14 / O15 documentation boundaries -------------------------------------------------------
    try {
      const runbook = readFileSync(join(exportDir, 'docs/pilot/OPERATIONS_RUNBOOK.md'), 'utf8');
      check(/There is \*\*no store schema downgrade\*\*/.test(runbook), 'the rollback section does not state the schema-downgrade boundary');
      for (const [id, script] of blocks) {
        check(!/down\s+-v\b|\bsqlite3\b|\bUPDATE\s|\bDELETE\s+FROM\b/i.test(script), `block ${id} carries a forbidden command`);
      }
      record('O14', 'no schema downgrade promised; no documented command deletes volumes or edits a store', true);
    } catch (error) {
      record('O14', 'documentation boundaries', false, error.message);
    }
    try {
      const configured = [...Object.keys(state.env), ...compose(['config']).stdout.split('\n').filter((line) => /^\s+[A-Z_]+:/.test(line))].join('\n');
      const commands = [...blocks.values()].join('\n');
      const hits = `${configured}\n${commands}`.match(/xrpl|rlusd|lightning|wallet|PAY_/gi) ?? [];
      check(hits.length === 0, `rail configuration present: ${hits.join(', ')}`);
      record('O15', 'no payment rail in the deployment or any documented command', true);
    } catch (error) {
      record('O15', 'rail neutrality', false, error.message);
    }

    // ---- every exec block ran ------------------------------------------------------------------
    const unexecuted = [...blocks.keys()].filter((id) => !executed.has(id));
    const undocumented = EXECUTED_BLOCKS.filter((id) => !blocks.has(id));
    if (unexecuted.length > 0 || undocumented.length > 0) record('DOC', 'every documented exec block was executed', false, `not run: ${unexecuted.join(', ') || '-'}; missing: ${undocumented.join(', ') || '-'}`);
    else log(`     ${executed.size} documented command blocks executed`);

    // ---- O2 final clean stop ---------------------------------------------------------------------
    try {
      doc('shutdown');
      log('     final documented shutdown: clean');
    } catch (error) {
      record('O2', 'final shutdown', false, error.message);
    }
  }

  try {
    await main();
  } catch (error) {
    record('ERR', 'qualification aborted', false, error.message);
  } finally {
    const evidenceFile = option('--evidence');
    if (evidenceFile !== undefined) {
      // A case recorded more than once passes only if every record of it passed.
      const automated = new Map();
      for (const result of results) automated.set(result.id, (automated.get(result.id) ?? true) && result.ok);
      const caseResult = (...ids) => (ids.every((id) => automated.get(id) === true) ? 'pass' : ids.some((id) => automated.get(id) === false) ? 'fail' : 'not-run');
      // Proven on the reference deployment only; the pilot proves these with its own provider (PILOT_ACCEPTANCE.md §1).
      const REFERENCE_ONLY = {
        A5: 'qualification output: the decision path only (the reference provider is unreachable by design)',
        A9: 'qualification output: resolution refusals in the container and the PROD-03-02 in-process suite (no real unresolved execution)',
      };
      const criteria = {
        A1: caseResult('O1', 'O6'), A2: caseResult('O1'), A3: caseResult('O1', 'O7'), A4: caseResult('O6'), A5: caseResult('O12'), A6: caseResult('O12'),
        A7: caseResult('O12'), A8: caseResult('O7', 'O10'), A9: caseResult('O10', 'O11'), A10: caseResult('O3'), A11: caseResult('O4'), A12: caseResult('O5'),
        A13: caseResult('O2'), A14: 'not-run', A15: 'not-run', A16: 'not-run', A17: 'not-run',
      };
      writeFileSync(
        evidenceFile,
        `${JSON.stringify(
          {
            schema: 'frontera.pilot-acceptance-evidence.v1',
            producedBy: 'scripts/deploy/qualify-pilot-acceptance.mjs (qualification reference deployment)',
            pilotOrganization: null,
            organizationId: ORG,
            environment: `qualification:${PROJECT}`,
            date: new Date().toISOString(),
            release: evidence.release,
            configCheck: automated.get('O1') === true ? 'PASS' : 'not-run',
            readiness: automated.get('O7') === true ? { live: 200, ready: 200 } : null,
            health: evidence.health,
            cases: Object.entries(criteria).map(([id, result]) => ({ id, result, evidence: result === 'not-run' ? 'human acknowledgement: never recorded by the qualification' : (REFERENCE_ONLY[id] ?? 'qualification output'), by: result === 'not-run' ? null : 'qualification' })),
            qualification: results,
            backup: evidence.backup,
            restore: evidence.restore,
            restart: evidence.restart,
            operatorResolution: evidence.operatorResolution,
            evidenceBundle: evidence.evidenceBundle,
            deviations: [],
            approvals: { pilotOwner: null, fronteraContact: null },
            status: null,
            statusNote: 'Acceptance is a human decision (docs/pilot/PILOT_ACCEPTANCE.md §2); this record holds only the automatable evidence.',
          },
          null,
          2,
        )}\n`,
      );
      log(`     evidence written: ${evidenceFile}`);
    }
    if (flag('--keep')) {
      log(`kept: project ${PROJECT}, image ${IMAGE}, export ${exportDir}`);
    } else {
      compose(['down', '-v', '--remove-orphans'], { allowFailure: true });
      run('docker', ['image', 'rm', '-f', IMAGE, `${IMAGE}-previous`], { allowFailure: true });
      rmSync(work, { recursive: true, force: true });
    }
  }

  log('');
  log(`Pilot acceptance qualification: ${results.filter((result) => result.ok).length}/${results.length} passed${failed ? ' — FAILED' : ''}`);
  process.exit(failed ? 1 : 0);
}
