// FV-P4C-2B3C-2A3A — test support for FV operator credential revocation: a registered synthetic FV world with its
// first administrator (2A2A) and one FV operator (2A2B) enrolled by the real ceremonies, and a child-process runner for
// SIGKILL cases. Synthetic organizations, test-only keys and temporary directories only.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHORITY_KEY_A } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { enrollFvOperator } from '../dist/src/enterprise/sovereign-status-history/identity-registration-operator.js';
import { ADMIN, ORIGIN, RP, administeredWorld, operatorOptions, operatorRequest } from './fv-p4c2b3c2a2b-support.mjs';

export { ADMIN, ORIGIN, RP };
export const CHILD = new URL('./fv-p4c2b3c2a3a-revocation-child.mjs', import.meta.url).pathname;
export const newRevocationId = () => `fvrev-${randomBytes(16).toString('hex')}`;

/** Enrols `operatorId` in `w` through the real 2A2B ceremony; returns its passkey and credential id. */
export async function enrolOperator(w, witness, operatorId) {
  const candidate = new SoftwareAuthenticator({ origin: ORIGIN });
  const outcome = await enrollFvOperator(operatorOptions(w.world, witness), operatorRequest(w, { operatorId, candidate }).request);
  if (outcome.outcome !== 'enrolled') throw new Error(`the synthetic operator was not enrolled: ${JSON.stringify(outcome)}`);
  return { device: candidate, credentialId: outcome.evidence.credentialId };
}

/** A registered world with its FV administrator and one FV operator (`fv-operator-a`). */
export async function operatedWorld(witness, options) {
  const w = await administeredWorld(witness, options);
  w.operators = { 'fv-operator-a': await enrolOperator(w, witness, 'fv-operator-a') };
  return w;
}

/** A revocation request: the FV administrator's passkey (`admin`) authorizes revoking `operatorId`'s `credentialId`. */
export function revocationRequest(w, { operatorId = 'fv-operator-a', credentialId = w.operators?.[operatorId]?.credentialId, reason = 'compromised', admin = w.admin, adminCredentialId = w.adminCredentialId, administratorOperatorId = ADMIN, requestId = newRevocationId(), adminAnswer, ...rest } = {}) {
  return {
    request: { requestId, operatorId, credentialId, reason, administratorOperatorId, administratorCredentialId: adminCredentialId, administrator: adminAnswer ?? ((options) => admin.assert(options)), ...rest },
  };
}

/** One revocation in a separate process (the administrator's synthetic passkey handed over); SIGKILL at `killAt`, or pause at `pauseAt`. */
export function runRevocationChild(w, witness, { operation = 'revoke', requestId = newRevocationId(), operatorId = 'fv-operator-a', credentialId = w.operators?.[operatorId]?.credentialId, killAt, pauseAt, signal } = {}) {
  const config = join(w.world.dir, `child-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(config, JSON.stringify({ trustedIssuers: trustedRegistrationIssuers(), authorityKey: AUTHORITY_KEY_A, org: w.world.org, paths: w.world.paths, witness: { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, operation, requestId, operatorId, credentialId, administratorCredentialId: w.adminCredentialId, admin: w.admin.exportState(), killAt, pauseAt, signal }), { mode: 0o600 });
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

export async function pausedRevocationChild(w, witness, options) {
  const signal = join(w.world.dir, `pause-${Math.random().toString(16).slice(2)}`);
  const done = runRevocationChild(w, witness, { ...options, signal });
  const deadline = Date.now() + 20_000;
  while (!existsSync(`${signal}.paused`)) {
    if (Date.now() > deadline) throw new Error(`the ceremony never reached ${options.pauseAt}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return { done, release: () => writeFileSync(`${signal}.release`, '') };
}
