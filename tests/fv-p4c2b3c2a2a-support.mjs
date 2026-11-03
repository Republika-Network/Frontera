// FV-P4C-2B3C-2A2A — test support for the first-administrator enrolment: a registered synthetic FV world (the
// real 2A1 registration ceremony against a real reference witness), the test-only issuer's first-administrator
// capabilities, software passkeys, and a child-process runner for SIGKILL and lost-answer cases. Not a test
// file; nothing here is reachable from the Host.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { humanIdentityGenesisDigest } from '../dist/src/enterprise/human-identity/chain.js';
import { createHttpAuthorityStateWitnessTransport } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { WITNESS_TOKEN } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { AUTHORITY_KEY_A } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { issueFirstAdministratorCapability, newEnrollmentId, trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { registerFvIdentity } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, bindingFor, registerRequest, registrarOptions, registrationWorld } from './fv-p4c2b3c2a-support.mjs';
import { ORIGIN, RP } from './fv-p4c2b3b-support.mjs';

export { ORIGIN, RP };
export const ADMIN = 'fv-admin-a';
export const ADMIN_NAME = 'Synthetic FV Administrator';
export const CHILD = new URL('./fv-p4c2b3c2a2a-admin-child.mjs', import.meta.url).pathname;

/** A world whose FV bootstrap identity store is registered (2A1), at `witness`. */
export async function registeredWorld(witness, options) {
  const world = registrationWorld(options);
  const binding = bindingFor(world, witness);
  const { request } = registerRequest(binding);
  const outcome = await registerFvIdentity(registrarOptions(world, witness), request);
  if (outcome.outcome !== 'registered') throw new Error(`the synthetic registration did not complete: ${JSON.stringify(outcome)}`);
  return { world, registration: binding };
}

/** The ceremony's trusted configuration: the registrar's, plus the FV executor's relying party. */
export function adminOptions(world, witness, overrides = {}) {
  return { ...registrarOptions(world, witness), relyingParty: RP, ...overrides };
}

/** The binding fields a first-administrator capability for `registration` commits to (what an issuer signs). */
export function adminBinding(registration, { enrollmentId = newEnrollmentId(), operatorId = ADMIN, displayName = ADMIN_NAME, credentialDigest = null, ...overrides } = {}) {
  return {
    enrollmentId,
    registrationId: registration.registrationId,
    organizationId: registration.organizationId,
    stateKind: FV_DOMAIN,
    deploymentId: registration.deploymentId,
    witnessId: registration.witnessId,
    witnessKeyDigest: registration.witnessKeyDigest,
    storeId: registration.storeId,
    storePath: registration.storePath,
    authenticityKeyId: registration.authenticityKeyId,
    storeHeadSequence: 0,
    storeHeadDigest: humanIdentityGenesisDigest(registration.storeId, registration.organizationId),
    operatorId,
    displayName,
    role: 'fv-administrator',
    rpId: RP.rpId,
    credentialDigest,
    ...overrides,
  };
}

/** An enrol request for `binding`, answered by `device` (a software passkey) unless `authenticator` is given. */
export function enrollRequest(binding, { device = new SoftwareAuthenticator({ origin: ORIGIN }), authenticator, issue = {}, request = {} } = {}) {
  const { presentation, capability } = issueFirstAdministratorCapability({ operation: 'enroll', binding, audience: AUDIENCE, trustDomain: TRUST_DOMAIN, ...issue });
  return {
    request: { presentation, enrollmentId: binding.enrollmentId, registrationId: binding.registrationId, storeId: binding.storeId, operatorId: binding.operatorId, displayName: binding.displayName, authenticator: authenticator ?? ((options) => device.register(options)), ...request },
    capability,
    device,
  };
}

/** A resume capability for the enrolment `binding` describes, naming the recorded credential. */
export function adminResumeRequest(binding, credentialDigest, issue = {}) {
  const { presentation, capability } = issueFirstAdministratorCapability({ operation: 'resume', binding: { ...binding, credentialDigest }, audience: AUDIENCE, trustDomain: TRUST_DOMAIN, ...issue });
  return { request: { presentation }, capability };
}

/**
 * A witness transport that fails the `nth` call of `operation`: by default the witness applied it and only the
 * answer was lost; with `undelivered`, that call and every later one of `operation` never reach the witness.
 */
export function losingTransport(witness, { operation, nth = 1, undelivered = false }) {
  const http = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
  let seen = 0;
  return {
    async call(request, options) {
      const hit = request.operation === operation && (seen += 1) >= nth && (undelivered || seen === nth);
      if (hit && undelivered) throw new Error(`synthetic: the ${operation} request never reached the witness`);
      const answer = await http.call(request, options);
      if (hit) throw new Error(`synthetic: the ${operation} answer was lost`);
      return answer;
    },
  };
}

/**
 * Runs one ceremony call (a request this process issued) in a **separate process**, answered by the child's
 * own software passkey, and returns its outcome, or
 * `{ killed: true }` when it SIGKILLed itself at `killAt` (a ceremony step). `pauseAt` holds it, with every lock
 * it holds, until `${signal}.release` exists.
 */
export function runAdminChild(world, witness, { operation = 'enroll', request, killAt, pauseAt, signal } = {}) {
  const config = join(world.dir, `child-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  // The request without its authenticator (the child answers with its own passkey).
  const { authenticator: _local, ...plain } = request;
  writeFileSync(config, JSON.stringify({ trustedIssuers: trustedRegistrationIssuers(), authorityKey: AUTHORITY_KEY_A, org: world.org, paths: world.paths, witness: { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, operation, request: plain, killAt, pauseAt, signal }), { mode: 0o600 });
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CHILD, config], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', fail);
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (sig === 'SIGKILL') return done({ killed: true, stderr: err });
      try {
        done({ ...JSON.parse(out.trim().split('\n').pop()), code });
      } catch {
        fail(new Error(`child ended ${String(code)} ${String(sig)} without an outcome: ${err}`));
      }
    });
  });
}

/** A ceremony in its own process, paused at `pauseAt` (holding its locks) until `release()`. */
export async function pausedAdminChild(world, witness, { operation = 'enroll', request, pauseAt }) {
  const signal = join(world.dir, `pause-${Math.random().toString(16).slice(2)}`);
  const done = runAdminChild(world, witness, { operation, request, pauseAt, signal });
  const deadline = Date.now() + 20_000;
  while (!existsSync(`${signal}.paused`)) {
    if (Date.now() > deadline) throw new Error(`the ceremony never reached ${pauseAt}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return { done, release: () => writeFileSync(`${signal}.release`, '') };
}
