// PROD-03 clean-room pilot drill — the harness.
//
// What the harness MAY do (PROD-03 §114): create temporary directories, write
// the deployment's configuration (the reference pilot template, with one
// documented route substitution) and its secrets (from the supported
// generator), start and stop processes, send HTTP, read process output, run
// the documented CLIs (preflight, readiness, backup, restore, the secret
// generator), and run runbook command blocks as written.
//
// What it must NOT do, and a structural test enforces it on this directory
// (tests/pilot/prod03-pilot-structure.test.mjs): open a SQLite database, import
// a store, a service or the composed Enterprise, write a signed artifact or
// the witness database, edit configuration after start, or edit source.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('.', import.meta.url));
export const REFERENCE_TEMPLATE = join(REPO, 'deploy/pilot/governed-actions.reference-pilot.json');
export const REFERENCE_TARGET_ADAPTER_ID = 'pilot.reference-target';
export const ORGANIZATION_ID = 'org-pilot';

/** The onboarding runbook's `drill:` blocks; the clean-room drill's handoff phase executes exactly these, as written. */
export const DRILL_RUNBOOK = 'docs/pilot/ONBOARDING_RUNBOOK.md';
export const DRILL_EXECUTED_BLOCKS = Object.freeze([
  'org-actor', 'org-trust-domain', 'org-root-issuer',
  'profile-list', 'profile-activate',
  'agent-owner', 'agent-actor', 'agent-credential', 'agent-credential-deliver', 'agent-inspect',
  'authority-owner-grant', 'authority-passport', 'authority-capability', 'authority-delegation',
  'approver-actor', 'approver-standing',
  'approval-inbox', 'approval-detail', 'approval-approve', 'approval-reject',
  'agent-request',
  'evidence-activity', 'evidence-trace',
  'revoke-delegation', 'credential-rotate', 'credential-revoke', 'agent-offboard',
]);

/** `<!-- drill: id -->` blocks of a runbook: id → script (list-item indentation removed). */
export function drillBlocks(markdown) {
  const blocks = new Map();
  for (const match of markdown.replace(/\r\n/g, '\n').matchAll(/^([ \t]*)<!-- drill: ([a-z0-9-]+) -->\n\1```bash\n([\s\S]*?)\n\1```$/gm)) {
    const [, indent, id, body] = match;
    if (blocks.has(id)) throw new Error(`duplicate drill block ${id}`);
    blocks.set(id, body.split('\n').map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n'));
  }
  return blocks;
}

/** Every operator the reference pilot names, by role (deploy/pilot/governed-actions.reference-pilot.json). */
export const OPERATOR_ENVS = Object.freeze({
  admin: 'FRONTERA_OPERATOR_KEY_ADMIN',
  provisioner: 'FRONTERA_OPERATOR_KEY_PROVISIONER',
  steward: 'FRONTERA_OPERATOR_KEY_STEWARD',
  approver: 'FRONTERA_OPERATOR_KEY_APPROVER',
  responder: 'FRONTERA_OPERATOR_KEY_RESPONDER',
  observer: 'FRONTERA_OPERATOR_KEY_OBSERVER',
});

// -- processes --------------------------------------------------------------------------

export async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const live = new Set();

/** A child process whose output is kept line by line (never printed: it may be searched for secrets). */
export function startProcess(name, script, env, { cwd = REPO } = {}) {
  const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = { name, child, lines: [], exitCode: undefined, exited: undefined };
  proc.exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit((proc.exitCode = code ?? signal))));
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      proc.lines.push(...parts);
    });
    stream.on('end', () => {
      if (buffer !== '') proc.lines.push(buffer);
    });
  }
  live.add(proc);
  child.once('exit', () => live.delete(proc));
  return proc;
}

export async function waitForLine(proc, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = proc.lines.find((entry) => pattern.test(entry));
    if (line !== undefined) return line;
    if (proc.exitCode !== undefined) throw new Error(`${proc.name} exited (${proc.exitCode}) before printing ${pattern}:\n${proc.lines.slice(-30).join('\n')}`);
    if (Date.now() > deadline) throw new Error(`${proc.name} did not print ${pattern} within ${timeoutMs} ms:\n${proc.lines.slice(-30).join('\n')}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/** SIGTERM — the supported stop — and the exit code. Never SIGKILL in the normal path. */
export async function stopProcess(proc, timeoutMs = 45_000) {
  if (proc.exitCode !== undefined) return proc.exitCode;
  proc.child.kill('SIGTERM');
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return code;
}

/** Last resort for teardown after a failed test. */
export async function killAll() {
  for (const proc of [...live]) {
    proc.child.kill('SIGKILL');
    await proc.exited;
  }
}

/** Runs a documented CLI to completion. Output kept, never printed unless asked. */
export function runCli(script, args, env, { cwd = REPO, input } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}), maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

// -- the release under test ---------------------------------------------------------------------------

/** The commit this drill qualifies: CI's, the repository's, or — outside a checkout — a synthetic identity, labelled as such. */
export function drillCommit() {
  const fromEnv = (process.env.FRONTERA_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? '').trim();
  if (/^[0-9a-f]{40}$/.test(fromEnv)) return { commit: fromEnv, source: 'environment' };
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return { commit: head, source: 'git' };
  } catch {
    // not a checkout
  }
  return { commit: 'd7111d7111d7111d7111d7111d7111d7111d7111'.slice(0, 40), source: 'synthetic (outside a repository)' };
}

/**
 * A RELEASE root, as the pilot image stages one (Dockerfile, build stage):
 * package metadata, the operator scripts, the release manifest inputs and the
 * compiled output without tests or source maps, plus the recorded release
 * identity (`write-release-identity.mjs`). Dependencies are the repository's.
 */
export function stageRelease(root, commit) {
  const stage = join(root, 'release');
  mkdirSync(stage, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE.md']) cpSync(join(REPO, file), join(stage, file));
  for (const dir of ['scripts', 'release']) cpSync(join(REPO, dir), join(stage, dir), { recursive: true });
  cpSync(join(REPO, 'dist'), join(stage, 'dist'), {
    recursive: true,
    filter: (source) => !/[\\/]__tests__([\\/]|$)/.test(source) && !/\.test\.(js|d\.ts)$/.test(source) && !/\.map$/.test(source) && !/release-identity\.json$/.test(source),
  });
  symlinkSync(join(REPO, 'node_modules'), join(stage, 'node_modules'), 'dir');
  const written = runCli(join(stage, 'scripts/release/write-release-identity.mjs'), [], { ...process.env, FRONTERA_BUILD_COMMIT: commit }, { cwd: stage });
  assert.equal(written.status, 0, `write-release-identity: ${written.stderr}${written.stdout}`);
  return stage;
}

// -- secrets, from the supported generator --------------------------------------------------------------

/** Parses the generator's `.env` lines the way Compose's env_file does for these shapes: `"…\n…"` (escapes), `'…'` (literal), bare. */
export function parseEnvBlock(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf('=');
    const name = line.slice(0, index);
    let value = line.slice(index + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\n/g, '\n');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

export function generateSecrets(stage, witnessKeyFile, names, { secretsOnly = false } = {}) {
  const args = [...(secretsOnly ? ['--secrets-only'] : []), ...names.flatMap((name) => ['--secret', name])];
  const result = runCli(join(stage, 'scripts/deploy/generate-pilot-secrets.mjs'), args, { PATH: process.env.PATH, FRONTERA_REFERENCE_WITNESS_KEY_FILE: witnessKeyFile }, { cwd: stage });
  assert.equal(result.status, 0, `generate-pilot-secrets: ${result.stderr}`);
  return parseEnvBlock(result.stdout);
}

// -- the deployment ---------------------------------------------------------------------------------------

/** The reference pilot's governed-action file, with the ONE drill substitution: the deploy route reaches the reference target instead of the public Generic HTTP target. */
export function referencePilotFile(overrides = {}) {
  const template = JSON.parse(readFileSync(REFERENCE_TEMPLATE, 'utf8'));
  const routes = template.routes.map((route) => (route.adapterId === 'deploy-target' ? { ...route, adapterId: REFERENCE_TARGET_ADAPTER_ID } : route));
  return { ...template, routes, ...overrides };
}

/** The Host environment: what deploy/pilot/compose.yaml fixes, the site's .env values, and every store under one state directory. */
export function hostEnvironment({ stateDir, governedActionsFile, witnessUrl, secrets, extra = {} }) {
  const store = (name) => join(stateDir, name);
  return {
    PATH: process.env.PATH,
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS: '30000',
    AOC_ENTERPRISE_LOG_LEVEL: 'info',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORGANIZATION_ID,
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: governedActionsFile,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: witnessUrl,
    AOC_ENTERPRISE_SQLITE_PATH: store('enterprise-host.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: store('agent-passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: store('assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: store('kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: store('bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: store('emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: store('exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: store('authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: store('execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: store('execution-resolutions.sqlite'),
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: store('obligation-discharges.sqlite'),
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: store('approvals.sqlite'),
    AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH: store('control-plane.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: store('evidence-bundles.sqlite'),
    ...secrets,
    ...extra,
  };
}

export function workspace(prefix = 'frontera-prod03-drill-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    dir(name) {
      const path = join(root, name);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// -- HTTP ----------------------------------------------------------------------------------------------------

export const transcript = [];

export async function http(base, method, path, { bearer, body, headers = {} } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  transcript.push(text);
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return { status: response.status, text, body: parsed };
}

export function expectStatus(reply, status, where) {
  assert.equal(reply.status, status, `${where}: ${reply.text.slice(0, 800)}`);
  return reply;
}

export async function targetEffects(targetUrl) {
  return (await (await fetch(new URL('/effects', targetUrl))).json()).effects;
}

export async function setTargetMode(targetUrl, mode) {
  const response = await fetch(new URL('/mode', targetUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  assert.equal(response.status, 200);
}

/** Runs one runbook command block as written, in bash, with the operator's environment. */
export function runBlock(source, env, { cwd } = {}) {
  try {
    const stdout = execFileSync('bash', ['-c', source], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

export function writeJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function exists(path) {
  return existsSync(resolve(path));
}
