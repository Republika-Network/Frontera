// CORE-02 — external key custody through the SHIPPED launch path
// (`npm run start:enterprise` → scripts/run-enterprise-host.mjs → bootEnterpriseHost),
// with the reference external signer (scripts/run-reference-authority-signer.mjs)
// as a second, separate process that alone owns the authority private key.
//
// Proven here by inspection, not by assertion of a boolean:
//   - the Host process's own environment (/proc/<pid>/environ) carries no
//     private key, while the signer process's key file exists and is its own;
//   - the launcher configures external custody from the environment it is
//     given, and reports `authoritySigner=external`;
//   - the Host's signed genesis crossed the process boundary (the signer's
//     own operation counter);
//   - the same launch with a private key added is refused, not ignored.
// Run after `npm run build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../scripts/run-enterprise-host.mjs', import.meta.url));
const SIGNER = fileURLToPath(new URL('../scripts/run-reference-authority-signer.mjs', import.meta.url));
// CORE-07: a secure Host also needs its external authority-state witness — a third process.
const WITNESS = fileURLToPath(new URL('../scripts/run-reference-authority-state-witness.mjs', import.meta.url));
const WITNESS_TOKEN = 'FRONTERA_CORE07_LAUNCHER_WITNESS_TOKEN_SENTINEL_3a9e5c1b7d20f846';
const TOKEN = 'FRONTERA_CORE02_LAUNCHER_TOKEN_SENTINEL_6d1c9a04e2f7b38a';
const KEY_ID = 'frontera-core02-launcher-key';
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

function waitFor(child, pattern, deadlineMs = 60_000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${pattern}: ${out} ${err}`));
    }, deadlineMs);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = pattern.exec(out);
      if (match !== null) {
        clearTimeout(deadline);
        resolve({ match, out: () => out, err: () => err });
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      reject(Object.assign(new Error(`exited ${code}`), { stdout: out, stderr: err, code }));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function counts(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/diagnostics/operations', headers: { authorization: `Bearer ${TOKEN}` }, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}

function hostEnv(dir, signerPort, publicKeyPem, witness = { port: 1, publicKeyPem }) {
  const file = join(dir, 'governed-actions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      trustDomainId: 'trust-domain-core02',
      grantLifetimeSeconds: 300,
      customerPrincipals: [{ principalId: 'principal-agent', externalSubject: { system: 'core02-app', subjectId: 'agent-1' }, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
      administrators: [{ operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' }],
      genericHttpAdapters: [
        {
          adapterId: 'erp.generic',
          origin: 'https://erp.example.com',
          method: 'POST',
          path: [{ kind: 'literal', value: 'actions' }],
          body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' }, executionId: { kind: 'source', source: 'correlation.executionId' } } },
        },
      ],
      routes: [{ action: 'erp.sync', adapterId: 'erp.generic' }],
    }),
  );
  return {
    PATH: process.env.PATH,
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: 'FRONTERA_CORE02_LEGACY_KEY_SENTINEL_1b2c:org-core02',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-core02',
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: file,
    FRONTERA_TEST_AGENT_KEY: 'FRONTERA_CORE02_AGENT_KEY_SENTINEL_77e1',
    FRONTERA_TEST_ADMIN_KEY: 'FRONTERA_CORE02_ADMIN_KEY_SENTINEL_5f0b3d7c9e2a4816',
    // External custody: endpoint, credential, the pinned key id, the trusted PUBLIC key. No private key.
    AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: `http://127.0.0.1:${signerPort}`,
    AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: TOKEN,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: KEY_ID,
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([{ keyId: KEY_ID, algorithm: 'ed25519-v1', publicKeyPem }]),
    // CORE-07: the external authority-state witness — its own endpoint, credential and pinned receipt key.
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: `http://127.0.0.1:${witness.port}`,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: WITNESS_TOKEN,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: 'witness-core07-launcher',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: witness.publicKeyPem,
  };
}

/** The reference authority-state witness as its own process, over its own key and database. */
async function spawnWitness(dir) {
  const child = spawn(process.execPath, [WITNESS], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      FRONTERA_REFERENCE_WITNESS_DB: join(dir, 'witness.sqlite'),
      FRONTERA_REFERENCE_WITNESS_KEY_FILE: join(dir, 'witness-key.pem'),
      FRONTERA_REFERENCE_WITNESS_ID: 'witness-core07-launcher',
      FRONTERA_REFERENCE_WITNESS_TOKEN: WITNESS_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = await waitFor(child, /listening on http:\/\/127\.0\.0\.1:(\d+) witnessId=/);
  return { child, port: Number.parseInt(started.match[1], 10), publicKeyPem: readFileSync(join(dir, 'witness-key.pem.pub'), 'utf8') };
}

test('the shipped launcher runs a production Host under external custody; the Host process never holds the authority private key', { timeout: 180_000 }, async (t) => {
  const keys = mkdtempSync(join(tmpdir(), 'frontera-core02-launcher-keys-'));
  const data = mkdtempSync(join(tmpdir(), 'frontera-core02-launcher-data-'));
  const keyFile = join(keys, 'authority-key.pem');
  const signer = spawn(process.execPath, [SIGNER], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, FRONTERA_REFERENCE_SIGNER_KEY_FILE: keyFile, FRONTERA_REFERENCE_SIGNER_KEY_ID: KEY_ID, FRONTERA_REFERENCE_SIGNER_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const witnessDir = mkdtempSync(join(tmpdir(), 'frontera-core07-launcher-witness-'));
  let host;
  let witness;
  t.after(async () => {
    if (host !== undefined) await stop(host);
    await stop(signer);
    if (witness !== undefined) await stop(witness.child);
    rmSync(keys, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(witnessDir, { recursive: true, force: true });
  });
  const signerStarted = await waitFor(signer, /listening on http:\/\/127\.0\.0\.1:(\d+) keyId=/);
  assert.match(signerStarted.out(), /NOT an HSM/, 'the reference signer is labelled for what it is');
  const signerPort = Number.parseInt(signerStarted.match[1], 10);
  assert.ok(existsSync(keyFile), 'the private key lives in the signer’s own file');
  // Only the public half is read by this (operator) process.
  const publicKeyPem = readFileSync(`${keyFile}.pub`, 'utf8');
  assert.equal(PRIVATE_KEY.test(publicKeyPem), false);

  witness = await spawnWitness(witnessDir);
  const env = hostEnv(data, signerPort, publicKeyPem, witness);
  for (const [name, value] of Object.entries(env)) assert.equal(PRIVATE_KEY.test(value ?? ''), false, `${name} carries no private key`);
  host = spawn(process.execPath, [LAUNCHER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = await waitFor(host, /posture: .*\n/);
  const line = started.out();
  assert.match(line, /listening on http:\/\/127\.0\.0\.1:\d+/);
  assert.match(line, /authorityStore=authenticated-durable/);
  assert.match(line, /authoritySigner=external/);
  assert.match(line, /authorityFreshness=external/);

  // The running Host process's own environment, read from the kernel.
  if (existsSync(`/proc/${host.pid}/environ`)) {
    const environ = readFileSync(`/proc/${host.pid}/environ`, 'utf8').split('\0');
    assert.ok(environ.some((entry) => entry.startsWith('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external')), 'measured the right process');
    assert.equal(environ.some((entry) => entry.startsWith('AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM=')), false, 'no signing-key variable');
    assert.equal(environ.some((entry) => PRIVATE_KEY.test(entry)), false, 'no private key anywhere in the Host process environment');
    const signerEnviron = readFileSync(`/proc/${signer.pid}/environ`, 'utf8').split('\0');
    assert.equal(signerEnviron.some((entry) => entry.startsWith('AOC_ENTERPRISE_')), false, 'the signer shares none of the Host’s configuration');
  } else {
    t.diagnostic('/proc is not available on this platform; the environment passed to the Host was inspected instead');
  }

  const signed = await counts(signerPort);
  assert.deepEqual(signed, { signGrant: 0, signRevocation: 0, signRevocationState: 1, signObligationDischargeState: 0, signApprovalState: 0 }, 'the grant store’s signed genesis crossed the process boundary');
  const output = started.out() + started.err();
  assert.equal(output.includes(TOKEN) || PRIVATE_KEY.test(output), false, 'no credential or key in the launcher output');
});

test('the same launch with an authority private key added is refused before listen — never ignored', { timeout: 120_000 }, async (t) => {
  const keys = mkdtempSync(join(tmpdir(), 'frontera-core02-launcher-keys-'));
  const data = mkdtempSync(join(tmpdir(), 'frontera-core02-launcher-data-'));
  t.after(() => {
    rmSync(keys, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const env = { ...hostEnv(data, 1, publicKey.export({ type: 'spki', format: 'pem' }).toString()), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: pem };
  const child = spawn(process.execPath, [LAUNCHER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await waitFor(child, /never-matches/).catch((error) => error);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /refused to start \[HOST_ENVIRONMENT_INVALID\].*AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM must not be set/);
  assert.equal(result.stdout.includes('listening'), false);
  assert.equal((result.stdout + result.stderr).includes(pem.split('\n')[1]), false, 'the key is never echoed');
});
