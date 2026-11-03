// FV-P4C-2B3C-2A1 — one registration ceremony call in its own process (test support, not a test file).
// SIGKILLs itself at the requested durable step, or right after the witness applied the genesis and before
// its answer reaches the registrar (`enroll-sent`): a real process death, not an exception.
import { readFileSync } from 'node:fs';

import { createHttpAuthorityStateWitnessTransport } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { WITNESS_TOKEN } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { registerFvIdentity, resumeFvIdentityRegistration } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const die = () => process.kill(process.pid, 'SIGKILL');
const http = createHttpAuthorityStateWitnessTransport({ endpoint: config.witness.endpoint, credential: WITNESS_TOKEN });
const transport = {
  async call(request, options) {
    const answer = await http.call(request, options);
    if (config.killAt === 'enroll-sent' && request.operation === 'enroll') die();
    return answer;
  },
};
const options = {
  organizationId: config.org,
  deploymentId: 'deployment:test-fv-b3c2a',
  audience: 'fv-identity-registrar:test-fv-b3c2a',
  trustDomain: 'trust-domain:test-fv-b3c2a',
  // The same trusted issuer as the test process: the key pair is regenerated per process, so the child pins the public half it was given.
  trustedIssuers: config.trustedIssuers,
  recordPath: config.paths.record,
  ledgerPath: config.paths.ledger,
  storePath: config.paths.store,
  authenticity: { signer: testSigner(config.authorityKey), verifier: testVerifier([config.authorityKey]) },
  witness: { transport, pinned: { witnessId: config.witness.witnessId, publicKeyPem: config.witness.publicKeyPem }, timeoutMs: 2_000, maxAttempts: 1 },
  clock: () => Date.now(),
  observer: (step) => {
    if (step === config.killAt) die();
  },
};
const outcome = config.operation === 'resume' ? await resumeFvIdentityRegistration(options, config.request) : await registerFvIdentity(options, config.request);
if (config.hold) await new Promise((done) => setTimeout(done, config.hold));
process.stdout.write(`${JSON.stringify(outcome)}\n`);
