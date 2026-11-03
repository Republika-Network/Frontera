// FV-P4C-2B3C-2A1 — test support for the FV identity registration ceremony: synthetic organizations, a real
// CORE-07 reference witness, real AUTH-03 stores, the real G-02A verifier and ledger, test-only issuance.
// Not a test file itself; nothing here is reachable from the Host.
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpAuthorityStateWitnessTransport } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { WITNESS_TOKEN } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { issueRegistrationCapability, newRegistrationId, newStoreId, trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { FV_IDENTITY_STORE_POLICY, witnessKeyDigestOf } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { heldByAnotherProcess } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';

export const ORG = 'org-fv-p4c2b3c2a';
export const DEPLOYMENT = 'deployment:test-fv-b3c2a';
export const AUDIENCE = 'fv-identity-registrar:test-fv-b3c2a';
export const TRUST_DOMAIN = 'trust-domain:test-fv-b3c2a';
export const FV_DOMAIN = 'fv-bootstrap-identity-state';
export const CHILD = new URL('./fv-p4c2b3c2a-registrar-child.mjs', import.meta.url).pathname;

/** Every temporary directory these tests created (and only those): removed by `removeOwnedDirectories`. */
const owned = new Set();
export function own(dir) {
  owned.add(dir);
  return dir;
}
export function removeOwnedDirectories() {
  for (const dir of owned) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
  owned.clear();
}

/** A fresh, owner-only directory per world: the record, the ledger and the store live in it; the witness elsewhere. */
export function registrationWorld({ org = ORG, dir = own(mkdtempSync(join(tmpdir(), 'fv-b3c2a-'))) } = {}) {
  return { org, dir, paths: { record: join(dir, 'fv-registration.sqlite'), ledger: join(dir, 'fv-registration-ledger.sqlite'), store: join(dir, 'fv-identity.sqlite') } };
}

/** The registrar's trusted configuration for `world` at `witness`. */
export function registrarOptions(world, witness, overrides = {}) {
  return {
    organizationId: world.org,
    deploymentId: DEPLOYMENT,
    audience: AUDIENCE,
    trustDomain: TRUST_DOMAIN,
    trustedIssuers: trustedRegistrationIssuers(),
    recordPath: world.paths.record,
    ledgerPath: world.paths.ledger,
    storePath: world.paths.store,
    authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) },
    witness: { transport: createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }), pinned: { witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, timeoutMs: 2_000, maxAttempts: 1 },
    clock: () => Date.now(),
    ...overrides,
  };
}

/** The binding fields a registration of `world` at `witness` commits to (what an issuer signs). */
export function bindingFor(world, witness, { registrationId = newRegistrationId(), storeId = newStoreId(), ...overrides } = {}) {
  return {
    registrationId,
    organizationId: world.org,
    stateKind: FV_DOMAIN,
    deploymentId: DEPLOYMENT,
    witnessId: witness.witnessId,
    witnessKeyDigest: witnessKeyDigestOf(witness.publicKeyPem),
    storeId,
    storePath: world.paths.store,
    storePolicy: FV_IDENTITY_STORE_POLICY,
    authenticityKeyId: AUTHORITY_KEY_A.keyId,
    ...overrides,
  };
}

/** A register request: the test-only issuer's capability for `binding`, and the two values the operator passes beside it. */
export function registerRequest(binding, issue = {}) {
  const { presentation, capability } = issueRegistrationCapability({ operation: 'register', binding, audience: AUDIENCE, trustDomain: TRUST_DOMAIN, ...issue });
  return { request: { presentation, registrationId: binding.registrationId, storeId: binding.storeId }, capability };
}

/** A resume capability for the registration `binding` describes. */
export function resumeRequest(binding, issue = {}) {
  const { presentation, capability } = issueRegistrationCapability({ operation: 'resume', binding, audience: AUDIENCE, trustDomain: TRUST_DOMAIN, ...issue });
  return { request: { presentation }, capability };
}

/**
 * Runs one ceremony call in a **separate process** and returns its outcome, or `{ killed: true }` when it
 * SIGKILLed itself at `killAt` (a registrar step, or `enroll-sent`: the witness applied the genesis and the
 * answer never reached the registrar).
 */
export function runChild(world, witness, { operation, request, killAt, hold } = {}) {
  const config = join(world.dir, `child-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(config, JSON.stringify({ trustedIssuers: trustedRegistrationIssuers(), authorityKey: AUTHORITY_KEY_A, org: world.org, paths: world.paths, witness: { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, operation, request, killAt, hold }), { mode: 0o600 });
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CHILD, config], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return done({ killed: true, stdout: out, stderr: err });
      try {
        done({ ...JSON.parse(out.trim().split('\n').pop()), code });
      } catch {
        fail(new Error(`child ended ${String(code)} ${String(signal)} without an outcome: ${err}`));
      }
    });
  });
}

/**
 * A child that opens `path` as an exclusive SQLite owner and holds it until killed (an executor still alive).
 * The connection is strongly referenced and used (a collected connection is closed, releasing its lock), and the
 * lock is confirmed in /proc/locks before this resolves: a holder that does not hold fails the test, not the ceremony.
 */
export async function holdExclusively(path) {
  const child = await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { default: Database } = await import(${JSON.stringify(new URL('../node_modules/better-sqlite3/lib/index.js', import.meta.url).pathname)});
      const db = new Database(${JSON.stringify(path)}, { fileMustExist: true });
      db.pragma('locking_mode = EXCLUSIVE'); db.exec('BEGIN EXCLUSIVE'); db.exec('COMMIT');
      globalThis.held = db;
      process.stdout.write('held\\n'); setInterval(() => db.prepare('SELECT 1').get(), 200);
    `], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    child.stdout.once('data', () => done(child));
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`holder exited ${String(code)}`)));
  });
  if (!heldByAnotherProcess(path)) {
    child.kill('SIGKILL');
    throw new Error(`the holder does not hold ${path}`);
  }
  return child;
}
