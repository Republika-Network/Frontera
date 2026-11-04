// FV-P4C-2B3C-2A2B — test support for FV operator enrolment: a registered synthetic FV world with its first
// administrator enrolled by the real 2A2A ceremony, software passkeys for the administrator and the candidates, and a
// child-process runner for SIGKILL cases. Synthetic organizations, test-only keys and temporary directories only.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHORITY_KEY_A } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { enrollFvFirstAdministrator } from '../dist/src/enterprise/sovereign-status-history/identity-registration-first-administrator.js';
import { ADMIN, ORIGIN, RP, adminBinding, adminOptions, enrollRequest, registeredWorld } from './fv-p4c2b3c2a2a-support.mjs';

export { ADMIN, ORIGIN, RP };
export const CHILD = new URL('./fv-p4c2b3c2a2b-operator-child.mjs', import.meta.url).pathname;
export const newRequestId = () => `fvop-${randomBytes(16).toString('hex')}`;

/** A registered world whose first FV administrator (`ADMIN`) is enrolled, with that administrator's passkey. */
export async function administeredWorld(witness, options) {
  const { world, registration } = await registeredWorld(witness, options);
  const admin = new SoftwareAuthenticator({ origin: ORIGIN });
  const outcome = await enrollFvFirstAdministrator(adminOptions(world, witness), enrollRequest(adminBinding(registration), { device: admin }).request);
  if (outcome.outcome !== 'enrolled') throw new Error(`the synthetic first administrator was not enrolled: ${JSON.stringify(outcome)}`);
  return { world, registration, admin, adminCredentialId: outcome.evidence.credentialId };
}

/** The operator ceremony's trusted configuration (the registrar's, plus the relying party). */
export const operatorOptions = (world, witness, overrides = {}) => adminOptions(world, witness, overrides);

/** An enrolment request: `candidate` proves possession, `admin` (the FV administrator's passkey) authorizes. */
export function operatorRequest(w, { operatorId = 'fv-operator-a', displayName = 'Synthetic FV Operator', candidate = new SoftwareAuthenticator({ origin: ORIGIN }), admin = w.admin, adminCredentialId = w.adminCredentialId, administratorOperatorId = ADMIN, requestId = newRequestId(), candidateAnswer, adminAnswer, ...rest } = {}) {
  return {
    request: {
      requestId,
      operatorId,
      displayName,
      administratorOperatorId,
      administratorCredentialId: adminCredentialId,
      candidate: candidateAnswer ?? ((options) => candidate.register(options)),
      administrator: adminAnswer ?? ((options) => admin.assert(options)),
      ...rest,
    },
    candidate,
  };
}

/**
 * One enrolment in a **separate process**, with the administrator's and the candidate's synthetic passkeys handed
 * over (test-only state in the world's owner-only directory). SIGKILLs itself at `killAt`, or pauses at `pauseAt`
 * until `${signal}.release` exists. Returns the outcome and the administrator's passkey state afterwards.
 */
export function runOperatorChild(w, witness, { operation = 'enroll', requestId = newRequestId(), operatorId = 'fv-operator-a', killAt, pauseAt, signal } = {}) {
  const config = join(w.world.dir, `child-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const candidate = new SoftwareAuthenticator({ origin: ORIGIN });
  writeFileSync(config, JSON.stringify({ trustedIssuers: trustedRegistrationIssuers(), authorityKey: AUTHORITY_KEY_A, org: w.world.org, paths: w.world.paths, witness: { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, operation, requestId, operatorId, administratorCredentialId: w.adminCredentialId, admin: w.admin.exportState(), candidate: candidate.exportState(), killAt, pauseAt, signal }), { mode: 0o600 });
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
      if (sig === 'SIGKILL') return done({ killed: true, requestId, stderr: err });
      try {
        done({ ...JSON.parse(out.trim().split('\n').pop()), requestId, code });
      } catch {
        fail(new Error(`child ended ${String(code)} ${String(sig)} without an outcome: ${err}`));
      }
    });
  });
}

/** A ceremony in its own process, paused at `pauseAt` (holding its locks) until `release()`. */
export async function pausedOperatorChild(w, witness, options) {
  const signal = join(w.world.dir, `pause-${Math.random().toString(16).slice(2)}`);
  const done = runOperatorChild(w, witness, { ...options, signal });
  const deadline = Date.now() + 20_000;
  while (!existsSync(`${signal}.paused`)) {
    if (Date.now() > deadline) throw new Error(`the ceremony never reached ${options.pauseAt}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return { done, release: () => writeFileSync(`${signal}.release`, '') };
}
