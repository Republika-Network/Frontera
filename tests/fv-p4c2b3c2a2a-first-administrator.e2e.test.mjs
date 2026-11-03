// FV-P4C-2B3C-2A2A — the first FV administrator's enrolment, end to end: a registered FV store (the real 2A1
// ceremony), the real G-02A verifier and ledger, a real CORE-07 reference witness, real AUTH-03 stores, the real
// AUTH-02 WebAuthn verification (software passkeys), real child processes paused or SIGKILLed at durable steps.
// Synthetic organizations, test-only issuer keys and temporary directories only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { createHumanIdentityService, identityAdministratorFor, openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { appendFirstAdministrator, newFirstAdministratorPlan, verifyFirstAdministratorAttestation, firstAdministratorRegistrationOptions } from '../dist/src/enterprise/human-identity/first-administrator.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { captureHistoryContinuity, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { composeFvProtectedHost } from '../dist/src/enterprise/sovereign-status-history/protected-host-composition.js';
import { enrollFvFirstAdministrator, readFvFirstAdministratorEnrollment, resumeFvFirstAdministratorEnrollment } from '../dist/src/enterprise/sovereign-status-history/identity-registration-first-administrator.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { OTHER_ISSUER, OTHER_ISSUER_KEY, TEST_REGISTRATION_ISSUER, TEST_REGISTRATION_ISSUER_KEY, UNTRUSTED_REGISTRATION_KEY, issueRegistrationCapability, newEnrollmentId, trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, bindingFor, holdExclusively, own, registerRequest, registrationWorld, removeOwnedDirectories, runChild } from './fv-p4c2b3c2a-support.mjs';
import { ADMIN, ADMIN_NAME, ORIGIN, RP, adminBinding, adminOptions, adminResumeRequest, enrollRequest, losingTransport, pausedAdminChild, registeredWorld, runAdminChild } from './fv-p4c2b3c2a2a-support.mjs';
import { GRACE, OPERATORS, SUBJECT, standing } from './fv-p4c2b3b-support.mjs';
import { resolver } from './fv-status-bootstrap-support.mjs';

after(async () => {
  await closeAllWitnesses();
  removeOwnedDirectories();
});
const started = async (options) => {
  const witness = await startWitness(options);
  own(witness.directory);
  return witness;
};

const enroll = (world, witness, request, overrides) => enrollFvFirstAdministrator(adminOptions(world, witness, overrides), request);
const resume = (world, witness, request, overrides) => resumeFvFirstAdministratorEnrollment(adminOptions(world, witness, overrides), request);
const view = (world, witness) => readFvFirstAdministratorEnrollment(adminOptions(world, witness));
const fvSlot = async (witness, org) => (await witnessRows(witness.databasePath)).filter((row) => row.state_kind === FV_DOMAIN && row.organization_id === org).map((r) => [r.committed_sequence, r.pending_sequence]);

async function ledgerState(world, capabilityId) {
  const ledger = await openExecutionCapabilityConsumptionLedger(world.paths.ledger, { audience: AUDIENCE, clock: () => Date.now() });
  try {
    return ledger.read(capabilityId).state;
  } finally {
    ledger.close();
  }
}

/** Opens the registered FV store as its exclusive owner (the ceremony is not running), runs `use`, closes it. */
async function withStore(world, witness, registration, use) {
  const store = await openSqliteHumanIdentityStore(world.paths.store, {
    organizationId: world.org,
    now: () => new Date().toISOString(),
    authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) },
    freshness: { boundary: await boundaryFor(witness, world.org), stateKind: FV_DOMAIN },
    exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close(), storeId: registration.storeId },
  });
  try {
    return await use(store);
  } finally {
    store.close();
  }
}
/** The FV store through a plain (non-owner) handle, without freshness: what a same-user writer holding the signing key could open. */
async function withPlainStore(w, use) {
  const store = await openSqliteHumanIdentityStore(w.paths.store, { organizationId: w.org, now: () => new Date().toISOString(), authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) } });
  try {
    return await use(store);
  } finally {
    store.close();
  }
}
const kinds = (world, witness, registration) => withStore(world, witness, registration, (store) => store.history().map((row) => row.kind));

async function world() {
  const witness = await started();
  const { world: w, registration } = await registeredWorld(witness);
  return { witness, world: w, registration };
}

describe('FV-P4C-2B3C-2A2A — the first FV administrator is enrolled once, by the registration issuer’s capability', () => {
  it('enrols from a verified capability and a verified passkey: three signed, witnessed rows; the administrator is recognized by AUTH-02 over the FV store', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    const { request, capability, device } = enrollRequest(binding);
    const outcome = await enroll(w, witness, request);
    assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
    const { evidence } = outcome;
    assert.deepEqual([evidence.operatorId, evidence.role, evidence.storeId, evidence.registrationId, evidence.enrollmentId, evidence.capabilityId, evidence.storeSequence], [ADMIN, 'fv-administrator', registration.storeId, registration.registrationId, binding.enrollmentId, capability.capabilityId, 3]);
    assert.equal(/BEGIN|PRIVATE|signature|publicKey|attestation/i.test(JSON.stringify(evidence)), false, 'no key, signature, capability or attestation in the evidence');
    assert.deepEqual(await fvSlot(witness, w.org), [[3, null]], 'the witness holds the three rows, nothing pending');
    assert.equal((await witnessRows(witness.databasePath)).length, 1, 'the Host identity domain is untouched');
    assert.equal(await ledgerState(w, capability.capabilityId), 'completed');
    assert.deepEqual(await view(w, witness), { state: 'enrolled', enrollmentId: binding.enrollmentId, operatorId: ADMIN, credentialId: evidence.credentialId, credentialDigest: evidence.credentialDigest, capabilityId: capability.capabilityId });
    await withStore(w, witness, registration, async (store) => {
      const history = store.history();
      assert.deepEqual(history.map((row) => row.kind), ['principal_created', 'enrolment_authorized', 'credential_registered']);
      const principal = JSON.parse(history[0].payload);
      assert.deepEqual([principal.role, principal.authorizationCapabilityId, principal.displayName, history[0].recordedBy], ['fv-administrator', capability.capabilityId, ADMIN_NAME, 'fv-first-administrator-ceremony']);
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN] });
      // The enrolment row was born consumed by its credential: never an invitation anyone can present.
      assert.deepEqual(identity.enrolmentsOf(ADMIN).map((e) => e.state), ['consumed']);
      assert.deepEqual(identity.credentialsOf(ADMIN).map((c) => [c.credentialId, c.state, c.rpId]), [[evidence.credentialId, 'active', RP.rpId]]);
      const recognized = await identity.finishAuthentication(device.assert(identity.beginAuthentication()));
      assert.equal(recognized.operatorId ?? recognized.principal?.operatorId, ADMIN);
    });
  });

  it('never a second administrator by this path: another capability, a replay, a resume, or the rows appended directly to a populated store', async () => {
    const { witness, world: w, registration } = await world();
    const first = enrollRequest(adminBinding(registration));
    assert.equal((await enroll(w, witness, first.request)).outcome, 'enrolled');
    const second = enrollRequest(adminBinding(registration, { operatorId: 'fv-admin-b' }));
    assert.deepEqual(await enroll(w, witness, second.request), { outcome: 'refused', reason: 'ALREADY_ENROLLED' });
    assert.equal(await ledgerState(w, second.capability.capabilityId), 'absent', 'refused before consumption');
    assert.deepEqual(await enroll(w, witness, first.request), { outcome: 'refused', reason: 'ALREADY_ENROLLED' });
    // A resume of the completed enrolment reports it and consumes nothing.
    const done = await view(w, witness);
    const resumed = adminResumeRequest(adminBinding(registration, { enrollmentId: done.enrollmentId }), done.credentialDigest);
    assert.equal((await resume(w, witness, resumed.request)).outcome, 'enrolled');
    assert.equal(await ledgerState(w, resumed.capability.capabilityId), 'absent');
    // Below the record: the store's own rule refuses any plan but its own on a store that holds anything.
    await withStore(w, witness, registration, async (store) => {
      const device = new SoftwareAuthenticator({ origin: ORIGIN });
      const issued = firstAdministratorRegistrationOptions({ relyingParty: RP, operatorId: 'fv-admin-b', displayName: 'B', capabilityId: 'c'.repeat(64), timeoutSeconds: 60 });
      const credential = await verifyFirstAdministratorAttestation({ relyingParty: RP, capabilityId: 'c'.repeat(64), nonce: issued.nonce, response: device.register(issued.options) });
      const plan = newFirstAdministratorPlan({ operatorId: 'fv-admin-b', displayName: 'B', userHandle: issued.userHandle, recordedAt: new Date().toISOString(), authorization: { capabilityId: 'c'.repeat(64), issuer: 'issuer:x' }, credential });
      await assert.rejects(appendFirstAdministrator(store, plan), { code: 'HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT' });
      assert.equal(store.history().length, 3);
    });
    assert.deepEqual(await fvSlot(witness, w.org), [[3, null]]);
  });

  it('a store already holding anything (the Host’s humans, written by a Host administrator) is refused before consumption: never a first administrator beside them', async () => {
    const { witness, world: w, registration } = await world();
    // FV-P4C-2B3C-2A2B: the FV owner's handle refuses Host administration, so the Host human is written through a plain
    // handle (a same-user writer with the signing key, before any first administrator exists) — outside the witness.
    await withPlainStore(w, async (store) => {
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: OPERATORS });
      const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: w.org, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
      await identity.createPrincipal(admin, { operatorId: OPERATORS[0], displayName: 'Host human' });
    });
    // The witness never saw that row: the FV store is refused (a fork) before anything is consumed.
    const { request, capability } = enrollRequest(adminBinding(registration));
    assert.deepEqual(await enroll(w, witness, request), { outcome: 'refused', reason: 'STORE_REFUSED', detail: 'AUTHORITY_FRESHNESS_FORK_DETECTED' });
    assert.equal(await ledgerState(w, capability.capabilityId), 'absent');
    assert.deepEqual(await withPlainStore(w, (store) => store.history().map((row) => row.kind)), ['principal_created']);
    assert.deepEqual(await fvSlot(witness, w.org), [[0, null]]);
  });
});

describe('FV-P4C-2B3C-2A2A — only an exactly scoped capability from a pinned issuer authorizes the first administrator', () => {
  it('refuses every mis-scoped, tampered, expired, misused or untrusted capability before anything is consumed or written', async () => {
    const { witness, world: w, registration } = await world();
    const base = adminBinding(registration);
    const cases = [
      ['another operator than the issuer named', enrollRequest(base, { request: { operatorId: 'fv-admin-b' } })],
      ['another display name', enrollRequest(base, { request: { displayName: 'Someone Else' } })],
      ['another relying party', enrollRequest({ ...base, rpId: 'evil.example' })],
      ['a non-genesis store head', enrollRequest({ ...base, storeHeadSequence: 3 })],
      ['another store id', enrollRequest({ ...base, storeId: 'human-identity-store:00000000-0000-4000-8000-000000000000' }, { request: { storeId: registration.storeId } })],
      ['another witness key', enrollRequest({ ...base, witnessKeyDigest: `sha256:${'0'.repeat(64)}` })],
      ['a resume binding presented to enrol', enrollRequest({ ...base, credentialDigest: `sha256:${'1'.repeat(64)}` })],
      ['another organization', enrollRequest(base, { issue: { organizationId: 'org-other' } })],
      ['an untrusted key', enrollRequest(base, { issue: { key: UNTRUSTED_REGISTRATION_KEY } })],
      ['expired', enrollRequest(base, { issue: { issuedAtMs: Date.now() - 120_000 } })],
      ['another execution id', enrollRequest(base, { issue: { executionId: newEnrollmentId() } })],
      ['the resume action', enrollRequest(base, { issue: { operation: 'resume' } })],
    ];
    for (const [name, { request, capability }] of cases) {
      const outcome = await enroll(w, witness, request);
      assert.equal(outcome.outcome, 'refused', name);
      assert.equal(outcome.reason, 'CAPABILITY_REJECTED', `${name}: ${JSON.stringify(outcome)}`);
      assert.equal(await ledgerState(w, capability.capabilityId), 'absent', name);
    }
    // A registration capability is not a first-administrator capability.
    const registrationCapability = issueRegistrationCapability({ operation: 'register', binding: bindingFor(w, witness, { registrationId: registration.registrationId, storeId: registration.storeId }), audience: AUDIENCE, trustDomain: TRUST_DOMAIN });
    const misused = enrollRequest(base, { request: { presentation: registrationCapability.presentation } });
    assert.equal((await enroll(w, witness, misused.request)).reason, 'CAPABILITY_REJECTED');
    // Another registration's ids beside a valid capability.
    assert.deepEqual(await enroll(w, witness, enrollRequest(base, { request: { registrationId: `fvreg-${'a'.repeat(32)}` } }).request), { outcome: 'refused', reason: 'CONFIGURATION_MISMATCH' });
    assert.deepEqual(await fvSlot(witness, w.org), [[0, null]]);
    assert.deepEqual(await kinds(w, witness, registration), []);
    // The store was never touched: the exactly scoped capability enrols.
    assert.equal((await enroll(w, witness, enrollRequest(base).request)).outcome, 'enrolled');
  });

  it('only a registered registration of exactly this configuration, on its reserved file: otherwise refused, nothing consumed', async () => {
    const witness = await started();
    // No registration at all.
    const empty = registrationWorld({ org: 'org-fv-b3c2a2a-none' });
    const none = enrollRequest(adminBinding(bindingFor(empty, witness)));
    assert.deepEqual(await enroll(empty, witness, none.request), { outcome: 'refused', reason: 'NO_REGISTRATION' });
    // A registration still in progress (its ceremony killed after the witness anchored it).
    const pendingWorld = registrationWorld({ org: 'org-fv-b3c2a2a-pending' });
    const pendingBinding = bindingFor(pendingWorld, witness);
    assert.equal((await runChild(pendingWorld, witness, { operation: 'register', request: registerRequest(pendingBinding).request, killAt: 'witness-anchored' })).killed, true);
    const early = enrollRequest(adminBinding(pendingBinding));
    assert.deepEqual(await enroll(pendingWorld, witness, early.request), { outcome: 'refused', reason: 'REGISTRATION_PENDING' });
    assert.equal(await ledgerState(pendingWorld, early.capability.capabilityId), 'absent');
    // Registered, but asked under another witness; then with the store file replaced by a copy.
    const { world: w, registration } = await registeredWorld(witness, { org: 'org-fv-b3c2a2a-moved' });
    const otherWitness = await started();
    const elsewhere = enrollRequest(adminBinding(registration));
    assert.deepEqual(await enroll(w, witness, elsewhere.request, { witness: adminOptions(w, otherWitness).witness }), { outcome: 'refused', reason: 'CONFIGURATION_MISMATCH' });
    copyFileSync(w.paths.store, `${w.paths.store}.copy`);
    renameSync(`${w.paths.store}.copy`, w.paths.store);
    assert.deepEqual(await enroll(w, witness, elsewhere.request), { outcome: 'refused', reason: 'STORE_FILE_MISMATCH' });
    assert.equal(await ledgerState(w, elsewhere.capability.capabilityId), 'absent');
  });
});

describe('FV-P4C-2B3C-2A2A — proof of possession is verified before the capability is consumed', () => {
  it('an absent, failed, misdirected, wrong-origin, wrong-RP or unverified-user passkey consumes nothing; the same capability then enrols', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    const { request, capability } = enrollRequest(binding, { issue: { lifetimeMs: 60_000 } });
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    const failures = [
      ['the authenticator fails', () => {
        throw new Error('cancelled');
      }],
      ['another challenge', (options) => device.register({ ...options, challenge: 'A'.repeat(43) })],
      ['another origin', (options) => new SoftwareAuthenticator({ origin: 'https://evil.example' }).register(options)],
      ['another relying party', (options) => device.register(options, { rpId: 'evil.example' })],
      ['no user verification', (options) => device.register(options, { userVerified: false })],
      ['not a registration response', () => ({ id: 'x' })],
      // Re-review 1: a credential the plan cannot hold (a 1,000-byte id) is refused before consumption, never thrown after it.
      ['a credential id the plan cannot hold', (options) => new SoftwareAuthenticator({ origin: ORIGIN, credentialId: new Uint8Array(1_000).fill(7) }).register(options)],
    ];
    for (const [name, authenticator] of failures) {
      const outcome = await enroll(w, witness, { ...request, authenticator });
      assert.deepEqual([outcome.outcome, outcome.reason], ['refused', 'ATTESTATION_INVALID'], `${name}: ${JSON.stringify(outcome)}`);
      assert.equal(await ledgerState(w, capability.capabilityId), 'absent', name);
    }
    assert.deepEqual(await kinds(w, witness, registration), []);
    assert.equal((await enroll(w, witness, { ...request, authenticator: (options) => device.register(options) })).outcome, 'enrolled');
  });
});

describe('FV-P4C-2B3C-2A2A — the capability’s window is checked again after the human answers', () => {
  it('a passkey that answers after the capability expired is refused: nothing consumed, nothing written', async () => {
    const { witness, world: w, registration } = await world();
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    const { request, capability } = enrollRequest(adminBinding(registration), { issue: { lifetimeMs: 1_500 } });
    const late = async (options) => {
      await new Promise((settle) => setTimeout(settle, 2_000));
      return device.register(options);
    };
    const outcome = await enroll(w, witness, { ...request, authenticator: late });
    assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
    assert.equal(outcome.reason, 'CAPABILITY_REJECTED');
    assert.equal(await ledgerState(w, capability.capabilityId), 'absent');
    assert.deepEqual(await kinds(w, witness, registration), []);
  });
});

describe('FV-P4C-2B3C-2A2A — crash consistency: SIGKILL at every durable step, completion from evidence only', () => {
  it('killed after consuming, before the plan was recorded: nothing written; a new capability enrols; the orphan is settled failed', async () => {
    const { witness, world: w, registration } = await world();
    const lost = enrollRequest(adminBinding(registration));
    assert.equal((await runAdminChild(w, witness, { request: lost.request, killAt: 'capability-claimed' })).killed, true);
    assert.deepEqual(await view(w, witness), { state: 'none' });
    assert.deepEqual(await kinds(w, witness, registration), []);
    assert.equal(await ledgerState(w, lost.capability.capabilityId), 'claimed');
    const next = enrollRequest(adminBinding(registration));
    assert.equal((await enroll(w, witness, next.request)).outcome, 'enrolled');
    assert.equal(await ledgerState(w, lost.capability.capabilityId), 'failed');
  });

  it('killed after the plan was recorded but before the store was written: nothing to resume; a new capability enrols; the old claim is left spent', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    const first = enrollRequest(binding);
    assert.equal((await runAdminChild(w, witness, { request: first.request, killAt: 'intent-recorded' })).killed, true);
    const recorded = await view(w, witness);
    assert.equal(recorded.state, 'pending');
    assert.deepEqual(await kinds(w, witness, registration), []);
    const resumed = adminResumeRequest(binding, recorded.credentialDigest);
    assert.deepEqual(await resume(w, witness, resumed.request), { outcome: 'refused', reason: 'NO_ENROLLMENT', detail: 'STORE_EMPTY' });
    assert.equal(await ledgerState(w, resumed.capability.capabilityId), 'absent');
    const next = enrollRequest(adminBinding(registration));
    const outcome = await enroll(w, witness, next.request);
    assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
    assert.equal(outcome.evidence.enrollmentId, next.request.enrollmentId);
    // The superseded claim is left as the ledger holds it (spent, deciding nothing): never settled because a record names it.
    assert.deepEqual([await ledgerState(w, first.capability.capabilityId), await ledgerState(w, next.capability.capabilityId)], ['claimed', 'completed']);
    assert.equal((await view(w, witness)).enrollmentId, next.request.enrollmentId);
  });

  for (const [killAt, rows] of [['principal_created', 1], ['enrolment_authorized', 2]]) {
    it(`killed at ${killAt}: pending; a new enrolment is refused; only a resume capability naming the recorded credential completes it`, async () => {
      const { witness, world: w, registration } = await world();
      const binding = adminBinding(registration);
      const first = enrollRequest(binding);
      assert.equal((await runAdminChild(w, witness, { request: first.request, killAt })).killed, true);
      const recorded = await view(w, witness);
      assert.equal(recorded.state, 'pending');
      assert.equal(recorded.enrollmentId, binding.enrollmentId);
      assert.equal((await kinds(w, witness, registration)).length, rows);
      if (rows === 2) {
        // A principal and its enrolment, no credential: the enrolment was born expired, never presentable.
        await withStore(w, witness, registration, (store) => assert.deepEqual(createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN] }).enrolmentsOf(ADMIN).map((e) => e.state), ['expired']));
      }
      assert.deepEqual(await enroll(w, witness, enrollRequest(adminBinding(registration)).request), { outcome: 'refused', reason: 'ENROLLMENT_PENDING' });
      // A resume naming another credential is refused; nothing consumed.
      const wrong = adminResumeRequest(binding, `sha256:${'2'.repeat(64)}`);
      assert.equal((await resume(w, witness, wrong.request)).reason, 'CAPABILITY_REJECTED');
      assert.equal(await ledgerState(w, wrong.capability.capabilityId), 'absent');
      const right = adminResumeRequest(binding, recorded.credentialDigest);
      const outcome = await resume(w, witness, right.request);
      assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
      assert.equal(outcome.evidence.credentialId, recorded.credentialId);
      assert.deepEqual(await kinds(w, witness, registration), ['principal_created', 'enrolment_authorized', 'credential_registered']);
      // Both claims are this record's own, and both are settled by the completed enrolment.
      assert.deepEqual([await ledgerState(w, first.capability.capabilityId), await ledgerState(w, right.capability.capabilityId)], ['completed', 'completed']);
      // The same resume again: the store already holds the administrator, so it is reported; nothing is consumed twice.
      assert.equal((await resume(w, witness, right.request)).outcome, 'enrolled');
      assert.deepEqual(await fvSlot(witness, w.org), [[3, null]]);
    });
  }

  it('killed after the last row, before completion was recorded: the store holds the administrator; a resume reports it, consuming nothing', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    assert.equal((await runAdminChild(w, witness, { request: enrollRequest(binding).request, killAt: 'credential_registered' })).killed, true);
    const recorded = await view(w, witness);
    assert.equal(recorded.state, 'pending', 'the record is not the authority; the store is');
    const resumed = adminResumeRequest(binding, recorded.credentialDigest);
    assert.equal((await resume(w, witness, resumed.request)).outcome, 'enrolled');
    assert.equal(await ledgerState(w, resumed.capability.capabilityId), 'absent');
    assert.equal((await view(w, witness)).state, 'enrolled');
  });
});

describe('FV-P4C-2B3C-2A2A — a resume is its own execution', () => {
  it('a resume capability reusing the enrolment’s execution id is refused, from the same issuer and from another pinned one, and never consumed', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    assert.equal((await runAdminChild(w, witness, { request: enrollRequest(binding).request, killAt: 'principal_created' })).killed, true);
    const { credentialDigest } = await view(w, witness);
    const issuers = trustedRegistrationIssuers([{ issuer: TEST_REGISTRATION_ISSUER, key: TEST_REGISTRATION_ISSUER_KEY }, { issuer: OTHER_ISSUER, key: OTHER_ISSUER_KEY }]);
    for (const issue of [{}, { issuer: OTHER_ISSUER, key: OTHER_ISSUER_KEY }]) {
      const reused = adminResumeRequest(binding, credentialDigest, { ...issue, executionId: binding.enrollmentId });
      assert.deepEqual(await resume(w, witness, reused.request, { trustedIssuers: issuers }), { outcome: 'refused', reason: 'CAPABILITY_REJECTED', detail: 'EXECUTION_MISMATCH' }, issue.issuer ?? 'same issuer');
      assert.equal(await ledgerState(w, reused.capability.capabilityId), 'absent');
    }
    assert.deepEqual(await kinds(w, witness, registration), ['principal_created']);
    // Its own execution, from the other pinned issuer: completes.
    assert.equal((await resume(w, witness, adminResumeRequest(binding, credentialDigest, { issuer: OTHER_ISSUER, key: OTHER_ISSUER_KEY }).request, { trustedIssuers: issuers })).outcome, 'enrolled');
  });
});

describe('FV-P4C-2B3C-2A2A — a lost witness answer is never success', () => {
  it('a lost finalize answer before the last row: the store completes it before its next row; enrolled only once the witness confirms the head', async () => {
    const { witness, world: w, registration } = await world();
    const options = adminOptions(w, witness);
    const outcome = await enrollFvFirstAdministrator({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'finalize', nth: 2 }) } }, enrollRequest(adminBinding(registration)).request);
    assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
    assert.deepEqual(await fvSlot(witness, w.org), [[3, null]]);
  });

  it('the last row’s finalize never reaches the witness: committed locally, only prepared at the witness, never reported enrolled; a resume completes it, consuming nothing', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    const options = adminOptions(w, witness);
    const first = enrollRequest(binding);
    const outcome = await enrollFvFirstAdministrator({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'finalize', nth: 3, undelivered: true }) } }, first.request);
    assert.equal(outcome.outcome, 'pending', JSON.stringify(outcome));
    assert.equal(outcome.reason, 'WITNESS_UNAVAILABLE');
    assert.deepEqual(await fvSlot(witness, w.org), [[2, 3]], 'the witness still holds the last row as prepared');
    assert.equal(await ledgerState(w, first.capability.capabilityId), 'outcome-unknown');
    const resumed = adminResumeRequest(binding, outcome.credentialDigest);
    const done = await resume(w, witness, resumed.request);
    assert.equal(done.outcome, 'enrolled', JSON.stringify(done));
    assert.equal(await ledgerState(w, resumed.capability.capabilityId), 'absent', 'the store already held all three rows: nothing to authorize');
    assert.equal(await ledgerState(w, first.capability.capabilityId), 'completed');
    assert.deepEqual(await kinds(w, witness, registration), ['principal_created', 'enrolment_authorized', 'credential_registered']);
    assert.deepEqual(await fvSlot(witness, w.org), [[3, null]]);
  });

  it('a prepare the witness applied but whose answer was lost: pending, then refused at resume (CORE-07 pending recovery), never enrolled, nothing more consumed', async () => {
    const { witness, world: w, registration } = await world();
    const binding = adminBinding(registration);
    const options = adminOptions(w, witness);
    const outcome = await enrollFvFirstAdministrator({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'prepare', nth: 2 }) } }, enrollRequest(binding).request);
    assert.equal(outcome.outcome, 'pending', JSON.stringify(outcome));
    const resumed = adminResumeRequest(binding, outcome.credentialDigest);
    const refusal = await resume(w, witness, resumed.request);
    assert.deepEqual(refusal, { outcome: 'refused', reason: 'STORE_REFUSED', detail: 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' });
    assert.equal(await ledgerState(w, resumed.capability.capabilityId), 'absent');
    assert.equal((await view(w, witness)).state, 'pending');
    assert.deepEqual(await fvSlot(witness, w.org), [[1, 2]], 'the witness holds the prepared row the store never committed');
  });
});

describe('FV-P4C-2B3C-2A2A — locks: one ceremony at a time; never over a store another process holds', () => {
  it('a second ceremony while one holds the record is REGISTRAR_BUSY; the first completes; the second then finds it enrolled', async () => {
    const { witness, world: w, registration } = await world();
    const first = enrollRequest(adminBinding(registration));
    const paused = await pausedAdminChild(w, witness, { request: first.request, pauseAt: 'attestation-verified' });
    const second = enrollRequest(adminBinding(registration, { operatorId: 'fv-admin-b' }));
    assert.deepEqual(await enroll(w, witness, second.request), { outcome: 'refused', reason: 'REGISTRAR_BUSY' });
    paused.release();
    assert.equal((await paused.done).outcome, 'enrolled');
    assert.deepEqual(await enroll(w, witness, second.request), { outcome: 'refused', reason: 'ALREADY_ENROLLED' });
    assert.equal(await ledgerState(w, second.capability.capabilityId), 'absent');
  });

  it('a store held by a live process (an executor) is refused before consumption', async () => {
    const { witness, world: w, registration } = await world();
    const holder = await holdExclusively(w.paths.store);
    try {
      const { request, capability } = enrollRequest(adminBinding(registration));
      assert.deepEqual(await enroll(w, witness, request), { outcome: 'refused', reason: 'STORE_HELD' });
      assert.equal(await ledgerState(w, capability.capabilityId), 'absent');
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

describe('FV-P4C-2B3C-2A2A — a forged record never completes an administrator the issuer did not authorize (review F1–F3)', () => {
  it('once the store holds the first row, it pins the plan: every rewritten intent is refused at resume, even with a resume capability for the forged credential', async () => {
    const { witness, world: w, registration } = await world();
    const { default: Database } = await import('better-sqlite3');
    const binding = adminBinding(registration);
    assert.equal((await runAdminChild(w, witness, { request: enrollRequest(binding).request, killAt: 'principal_created' })).killed, true);
    const genuineView = await view(w, witness);
    const read = new Database(w.paths.record, { readonly: true });
    const original = read.prepare(`SELECT sequence, detail FROM fv_registration_events WHERE kind = 'first-administrator-intent'`).get();
    read.close();
    const intent = JSON.parse(original.detail);
    // Events are append-only; a same-user writer drops the trigger, rewrites the intent and re-creates the trigger.
    const rewrite = (detail) => {
      const db = new Database(w.paths.record);
      try {
        const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'fv_registration_events_append_only_update'`).get().sql;
        db.exec('DROP TRIGGER fv_registration_events_append_only_update');
        db.prepare('UPDATE fv_registration_events SET detail = ? WHERE sequence = ?').run(detail, original.sequence);
        db.exec(trigger);
      } finally {
        db.close();
      }
    };
    /** The forger's own passkey, answering a fresh nonce for `capabilityId`: a self-consistent intent. */
    const ownPasskey = async (capabilityId) => {
      const issued = firstAdministratorRegistrationOptions({ relyingParty: RP, operatorId: ADMIN, displayName: ADMIN_NAME, capabilityId, timeoutSeconds: 60 });
      const attestation = JSON.parse(JSON.stringify(new SoftwareAuthenticator({ origin: ORIGIN }).register(issued.options)));
      const credential = await verifyFirstAdministratorAttestation({ relyingParty: RP, capabilityId, nonce: issued.nonce, response: attestation });
      return { nonce: issued.nonce, attestation, userHandle: issued.userHandle, credential: { ...credential, transports: [...credential.transports] } };
    };
    const untrusted = enrollRequest(binding, { issue: { key: UNTRUSTED_REGISTRATION_KEY } });
    const own = await ownPasskey(intent.capabilityId);
    const ownUntrusted = await ownPasskey(untrusted.capability.capabilityId);
    const forgeries = [
      // F1: the genuine capability, the forger's passkey, every field consistent.
      ['the forger’s passkey under the genuine capability', { ...intent, nonce: own.nonce, attestation: own.attestation, plan: { ...intent.plan, userHandle: own.userHandle, credential: own.credential } }],
      // F2: the genuine credential, an invitation the forger can present.
      ['a known token verifier and a far-future time', { ...intent, plan: { ...intent.plan, tokenVerifier: createHash('sha256').update('A'.repeat(43)).digest('hex'), recordedAt: '2099-01-01T00:00:00.000Z' } }],
      ['another operator in the plan', { ...intent, plan: { ...intent.plan, operatorId: 'fv-admin-b' } }],
      // Only the first row's plan digest excludes these two: every field the first row shows is the genuine one.
      ['the forger’s passkey, the genuine user handle and time', { ...intent, nonce: own.nonce, attestation: own.attestation, plan: { ...intent.plan, credential: own.credential } }],
      ['only a known token verifier', { ...intent, plan: { ...intent.plan, tokenVerifier: createHash('sha256').update('A'.repeat(43)).digest('hex') } }],
      ['an enrol capability no pinned key signed, with the forger’s passkey', { ...intent, capability: untrusted.request.presentation.capability, signature: untrusted.request.presentation.signature, capabilityId: untrusted.capability.capabilityId, nonce: ownUntrusted.nonce, attestation: ownUntrusted.attestation, plan: { ...intent.plan, userHandle: ownUntrusted.userHandle, authorization: { ...intent.plan.authorization, capabilityId: untrusted.capability.capabilityId }, credential: ownUntrusted.credential } }],
    ];
    for (const [name, forged] of forgeries) {
      rewrite(JSON.stringify(forged));
      // A misled issuer signs a resume for exactly what the rewritten record shows.
      const shown = await view(w, witness);
      const misled = adminResumeRequest({ ...binding, operatorId: forged.plan.operatorId }, shown.credentialDigest);
      assert.deepEqual(await resume(w, witness, misled.request), { outcome: 'refused', reason: 'ENROLLMENT_CONFLICT' }, name);
      assert.equal(await ledgerState(w, misled.capability.capabilityId), 'absent', name);
    }
    // The genuine plan and capability text, its signature replaced: the store's pin matches, the stored signature does not.
    const sig = intent.signature.signature;
    rewrite(JSON.stringify({ ...intent, signature: { ...intent.signature, signature: `${sig.slice(0, -4)}${sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'}` } }));
    assert.deepEqual(await resume(w, witness, adminResumeRequest(binding, genuineView.credentialDigest).request), { outcome: 'refused', reason: 'RECORD_CORRUPT', detail: 'AUTHORIZATION_UNVERIFIED' }, 'a forged signature on the recorded capability');
    // The genuine plan with a nonce its attestation did not answer: the store's pin matches, the stored evidence does not.
    rewrite(JSON.stringify({ ...intent, nonce: 'B'.repeat(43) }));
    assert.deepEqual(await resume(w, witness, adminResumeRequest(binding, genuineView.credentialDigest).request), { outcome: 'refused', reason: 'RECORD_CORRUPT', detail: 'AUTHORIZATION_UNVERIFIED' });
    // The genuine intent deleted (the delete trigger dropped and re-created): nothing completes; reconstructed, it does.
    const removeIntent = () => {
      const db = new Database(w.paths.record);
      try {
        const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'fv_registration_events_append_only_delete'`).get().sql;
        db.exec('DROP TRIGGER fv_registration_events_append_only_delete');
        db.prepare('DELETE FROM fv_registration_events WHERE sequence = ?').run(original.sequence);
        db.exec(trigger);
      } finally {
        db.close();
      }
    };
    removeIntent();
    assert.deepEqual(await resume(w, witness, adminResumeRequest(binding, genuineView.credentialDigest).request), { outcome: 'refused', reason: 'NO_ENROLLMENT' });
    assert.deepEqual(await enroll(w, witness, enrollRequest(adminBinding(registration)).request), { outcome: 'refused', reason: 'STORE_NOT_EMPTY' }, 'a store holding a row nobody recorded is never enrolled over');
    // Re-review 3: a broken copy of the genuine plan recorded first cannot hide the genuine intent recorded after it.
    {
      const db = new Database(w.paths.record);
      db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'first-administrator-intent', JSON.stringify({ ...intent, nonce: 'B'.repeat(43) }));
      db.close();
    }
    {
      const db = new Database(w.paths.record);
      db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'first-administrator-intent', original.detail);
      db.close();
    }
    assert.deepEqual(await kinds(w, witness, registration), ['principal_created']);
    const done = await resume(w, witness, adminResumeRequest(binding, genuineView.credentialDigest).request);
    assert.equal(done.outcome, 'enrolled', JSON.stringify(done));
    assert.equal(done.evidence.credentialId, genuineView.credentialId);
    await withStore(w, witness, registration, (store) => {
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN] });
      assert.deepEqual(identity.enrolmentsOf(ADMIN).map((e) => [e.state, e.expiresAt]), [['consumed', '1970-01-01T00:00:00.000Z']]);
    });
  });

  it('F3: an intent inserted into a record whose store was never written (a signed but unconsumed capability, the forger’s passkey) completes nothing', async () => {
    const { witness, world: w, registration } = await world();
    const { default: Database } = await import('better-sqlite3');
    const binding = adminBinding(registration);
    // A validly signed enrol capability that was never consumed (its attempt failed at the passkey).
    const unused = enrollRequest(binding);
    assert.deepEqual(await enroll(w, witness, { ...unused.request, authenticator: () => { throw new Error('cancelled'); } }), { outcome: 'refused', reason: 'ATTESTATION_INVALID' });
    const issued = firstAdministratorRegistrationOptions({ relyingParty: RP, operatorId: ADMIN, displayName: ADMIN_NAME, capabilityId: unused.capability.capabilityId, timeoutSeconds: 60 });
    const attestation = JSON.parse(JSON.stringify(new SoftwareAuthenticator({ origin: ORIGIN }).register(issued.options)));
    const credential = await verifyFirstAdministratorAttestation({ relyingParty: RP, capabilityId: unused.capability.capabilityId, nonce: issued.nonce, response: attestation });
    const plan = newFirstAdministratorPlan({ operatorId: ADMIN, displayName: ADMIN_NAME, userHandle: issued.userHandle, recordedAt: new Date().toISOString(), authorization: { capabilityId: unused.capability.capabilityId, issuer: unused.capability.issuer }, credential });
    const forged = { enrollmentId: binding.enrollmentId, capabilityId: unused.capability.capabilityId, capabilityIssuer: unused.capability.issuer, capability: unused.request.presentation.capability, signature: unused.request.presentation.signature, nonce: issued.nonce, attestation, plan };
    const db = new Database(w.paths.record);
    db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'first-administrator-intent', JSON.stringify(forged));
    db.close();
    const misled = adminResumeRequest(binding, (await view(w, witness)).credentialDigest);
    assert.deepEqual(await resume(w, witness, misled.request), { outcome: 'refused', reason: 'NO_ENROLLMENT', detail: 'STORE_EMPTY' });
    assert.equal(await ledgerState(w, misled.capability.capabilityId), 'absent');
    assert.deepEqual(await kinds(w, witness, registration), []);
    // Publication review 1: a forged completion event and a malformed intent, inserted beside it, block nothing either.
    {
      const db2 = new Database(w.paths.record);
      db2.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'first-administrator-enrolled', JSON.stringify({ enrollmentId: binding.enrollmentId }));
      db2.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'first-administrator-intent', '{not json');
      db2.close();
    }
    // The inserted intent blocks nothing: a genuine enrolment supersedes it.
    assert.equal((await enroll(w, witness, enrollRequest(adminBinding(registration)).request)).outcome, 'enrolled');
  });
});

describe('FV-P4C-2B3C-2A2A — a rewritten registration record never admits an enrolment', () => {
  it('a registration whose stored capability signature was rewritten (trigger re-created) is refused before anything is consumed', async () => {
    const { witness, world: w, registration } = await world();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(w.paths.record);
    try {
      const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'fv_registration_forward_only'`).get().sql;
      const { capability_signature: signature } = db.prepare('SELECT capability_signature FROM fv_registration WHERE id = 1').get();
      const forged = JSON.parse(signature);
      forged.signature = `${forged.signature.slice(0, -2)}${forged.signature.endsWith('AA') ? 'BB' : 'AA'}`;
      db.exec('DROP TRIGGER fv_registration_forward_only');
      db.prepare('UPDATE fv_registration SET capability_signature = ? WHERE id = 1').run(JSON.stringify(forged));
      db.exec(trigger);
    } finally {
      db.close();
    }
    const { request, capability } = enrollRequest(adminBinding(registration));
    assert.deepEqual(await enroll(w, witness, request), { outcome: 'refused', reason: 'RECORD_CORRUPT', detail: 'AUTHORIZATION_UNVERIFIED' });
    assert.equal(await ledgerState(w, capability.capabilityId), 'absent');
    assert.deepEqual(await fvSlot(witness, w.org), [[0, null]]);
  });
});

describe('FV-P4C-2B3C-2A2A — the executor stays non-operational', () => {
  it('a registered store with its first administrator composes, verifies its registration, and still executes nothing', async () => {
    const { witness, world: w, registration } = await world();
    assert.equal((await enroll(w, witness, enrollRequest(adminBinding(registration)).request)).outcome, 'enrolled');
    const namespace = 'receiver:fv-b3c2a2a';
    const protectedStore = join(w.dir, 'fv-protected.sqlite');
    const history = join(w.dir, 'history.sqlite');
    const records = await openProtectedContinuityStore(protectedStore, { create: true, now: () => new Date().toISOString() });
    const h = await openSqliteStatusHighWaterMarkStore(history, { namespace, create: true });
    records.save(captureHistoryContinuity(h, { namespace, databasePath: history, generation: 1, recordedAt: new Date().toISOString() }));
    h.close();
    records.close();
    const host = await composeFvProtectedHost({
      protectedStorePath: protectedStore,
      configuration: () => ({ generation: 1, histories: [{ namespace, databasePath: history }] }),
      identity: { storePath: w.paths.store, storeId: registration.storeId, authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, freshness: { boundary: await boundaryFor(witness, w.org), stateKind: FV_DOMAIN }, relyingParty: RP, operatorIds: [ADMIN] },
      registration: { recordPath: w.paths.record, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN },
      standing,
      organizationId: w.org,
      clock: () => new Date(),
      graceSeconds: GRACE,
      receiver: { verifySovereignStatus, establishStatusHistory },
      verificationKeyResolver: resolver,
      trustedSubjectOf: (id) => (id === SUBJECT.sovereignAssetId ? { ...SUBJECT } : undefined),
    });
    try {
      assert.equal(host.status().identityRegistration, 'verified');
      assert.equal(host.status().bootstrapExecution, 'disabled');
      assert.deepEqual(await host.bootstrap({ request: {}, signedStatusText: '', requesterResponse: {}, approverResponse: {} }), { outcome: 'refused', reason: 'BOOTSTRAP_DISABLED' });
    } finally {
      host.close();
    }
  });
});
