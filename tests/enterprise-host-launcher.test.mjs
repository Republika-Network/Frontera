// PROD-01 — the launcher operators run (`npm run start:enterprise`) is the
// canonical bootstrap, and nothing else. Run after `npm run build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../scripts/run-enterprise-host.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('npm run start:enterprise and start:kernel-host both run the one launcher', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['start:enterprise'], 'node scripts/run-enterprise-host.mjs');
  assert.equal(pkg.scripts['start:kernel-host'], 'node scripts/run-enterprise-host.mjs');
});

test('the launcher delegates to bootEnterpriseHost and composes nothing itself', () => {
  const code = stripComments(readFileSync(LAUNCHER, 'utf8'));
  assert.match(code, /import \{[^}]*\bbootEnterpriseHost\b[^}]*\} from '\.\.\/dist\/src\/enterprise\/index\.js'/);
  assert.match(code, /await bootEnterpriseHost\(\)/, 'boots from the process environment through the canonical bootstrap');
  for (const forbidden of [/createEnterpriseServer/, /createEnterprise\b/, /loadEnterpriseConfiguration/, /process\.env\.[A-Z]/]) {
    assert.equal(forbidden.test(code), false, `the launcher must not compose or read configuration itself (${forbidden})`);
  }
});

/**
 * Spawns the launcher. A launcher that should refuse but instead boots would
 * run forever, and the test runner does not kill spawned children on timeout,
 * so every run has its own deadline: past it the child is killed and the run
 * reports `timedOut` — a failure, never a hang.
 */
function run(env, { stopWhenListening = false, deadlineMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stopWhenListening && stdout.includes('posture:')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

test('a production launch without secure configuration exits 1 with a code, and prints no secret', { timeout: 120_000 }, async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const apiKey = 'LAUNCHER_TEST_API_KEY_SENTINEL_4411';
  const result = await run({
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: apiKey,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: 'k1',
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: pem,
  });
  assert.equal(result.timedOut, false, `the launcher must refuse, not keep running: ${result.stdout}`);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /refused to start \[HOST_GOVERNED_ACTIONS_REQUIRED\]/);
  assert.equal(result.stdout.includes('listening'), false, 'nothing was bound');
  const output = result.stdout + result.stderr;
  assert.equal(output.includes(pem.split('\n')[1]), false, 'the signing key never reaches the output');
  assert.equal(output.includes(apiKey), false, 'an API key never reaches the output');
  assert.equal(/\n\s+at /.test(result.stderr), false, 'no stack trace');
});

test('a development launch states its posture, and SIGTERM shuts it down cleanly', { timeout: 120_000 }, async () => {
  const result = await run({ AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_LOG_LEVEL: 'error' }, { stopWhenListening: true });
  assert.equal(result.timedOut, false, 'SIGTERM must stop the Host');
  assert.match(result.stdout, /listening on http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /posture: environment=development persistence=ephemeral authentication=disabled governedActions=not-composed/);
  assert.match(result.stdout, /WARNING: ephemeral in-memory state/);
  assert.equal(result.code, 0, `graceful shutdown exits 0: ${result.stderr}`);
});
