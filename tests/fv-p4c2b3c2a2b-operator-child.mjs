// FV-P4C-2B3C-2A2B — one operator-enrolment ceremony call in its own process (test support, not a test file).
// SIGKILLs itself at the requested durable step (a real process death), or pauses there holding every lock it holds.
// The synthetic administrator's and candidate's passkeys are continued from the state the parent handed over.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { createHttpAuthorityStateWitnessTransport } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { WITNESS_TOKEN } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { INTENDED_PRODUCTION_RP_ID, createRelyingPartyConfiguration } from '../dist/src/enterprise/human-identity/index.js';
import { enrollFvOperator, resumeFvOperatorEnrollment } from '../dist/src/enterprise/sovereign-status-history/identity-registration-operator.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const die = () => process.kill(process.pid, 'SIGKILL');
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const options = {
  organizationId: config.org,
  deploymentId: 'deployment:test-fv-b3c2a',
  audience: 'fv-identity-registrar:test-fv-b3c2a',
  trustDomain: 'trust-domain:test-fv-b3c2a',
  trustedIssuers: config.trustedIssuers,
  recordPath: config.paths.record,
  ledgerPath: config.paths.ledger,
  storePath: config.paths.store,
  authenticity: { signer: testSigner(config.authorityKey), verifier: testVerifier([config.authorityKey]) },
  witness: { transport: createHttpAuthorityStateWitnessTransport({ endpoint: config.witness.endpoint, credential: WITNESS_TOKEN }), pinned: { witnessId: config.witness.witnessId, publicKeyPem: config.witness.publicKeyPem }, timeoutMs: 2_000, maxAttempts: 1 },
  clock: () => Date.now(),
  relyingParty: createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] }),
  observer: (step) => {
    if (step === config.killAt) die();
    if (step === config.pauseAt) {
      writeFileSync(`${config.signal}.paused`, step);
      const cell = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 30_000;
      while (!existsSync(`${config.signal}.release`) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 10);
    }
  },
};
const admin = new SoftwareAuthenticator({ origin: ORIGIN, restore: config.admin });
const candidate = new SoftwareAuthenticator({ origin: ORIGIN, restore: config.candidate });
const outcome =
  config.operation === 'resume'
    ? await resumeFvOperatorEnrollment(options, { requestId: config.requestId })
    : await enrollFvOperator(options, { requestId: config.requestId, operatorId: config.operatorId, displayName: 'Synthetic FV Operator', administratorOperatorId: 'fv-admin-a', administratorCredentialId: config.administratorCredentialId, candidate: (o) => candidate.register(o), administrator: (o) => admin.assert(o) });
process.stdout.write(`${JSON.stringify({ ...outcome, adminState: admin.exportState() })}\n`);
