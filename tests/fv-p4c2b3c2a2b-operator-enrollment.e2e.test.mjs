// FV-P4C-2B3C-2A2B — FV operator enrolment under the FV administrator's authority, end to end: a registered FV
// store whose first administrator the real 2A2A ceremony enrolled, a real CORE-07 reference witness, real AUTH-03
// stores, real AUTH-02 WebAuthn verification (software passkeys), real child processes paused or SIGKILLed.
// Synthetic organizations, test-only keys and temporary directories only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { createHumanIdentityService, identityAdministratorFor, openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { fvRolesOf } from '../dist/src/enterprise/human-identity/fv-domain.js';
import { FV_OPERATOR_AUTHORIZATION_FORMAT, FV_OPERATOR_ENROLL_ACTION, appendFvOperator, fvOperatorCandidateChallenge, verifyFvOperatorRoles, fvOperatorAdministratorOptions, fvOperatorCandidateOptions, verifyFvOperatorCandidate, verifyFvOperatorEvidence } from '../dist/src/enterprise/human-identity/fv-operator.js';
import { firstAdministratorCredentialDigest } from '../dist/src/enterprise/human-identity/first-administrator.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { captureHistoryContinuity, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { composeFvProtectedHost } from '../dist/src/enterprise/sovereign-status-history/protected-host-composition.js';
import { enrollFvOperator, resumeFvOperatorEnrollment } from '../dist/src/enterprise/sovereign-status-history/identity-registration-operator.js';
import { witnessKeyDigestOf } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, own, removeOwnedDirectories } from './fv-p4c2b3c2a-support.mjs';
import { losingTransport, registeredWorld } from './fv-p4c2b3c2a2a-support.mjs';
import { ADMIN, ORIGIN, RP, administeredWorld, newRequestId, operatorOptions, operatorRequest, pausedOperatorChild, runOperatorChild } from './fv-p4c2b3c2a2b-support.mjs';
import { GRACE, SUBJECT, standing } from './fv-p4c2b3b-support.mjs';
import { resolver } from './fv-status-bootstrap-support.mjs';

after(async () => {
  await closeAllWitnesses();
  removeOwnedDirectories();
});
const started = async () => {
  const witness = await startWitness();
  own(witness.directory);
  return witness;
};
const world = async (options) => {
  const witness = await started();
  return { witness, w: await administeredWorld(witness, options) };
};

const enroll = (w, witness, request, overrides) => enrollFvOperator(operatorOptions(w.world, witness, overrides), request);
const resume = (w, witness, requestId, overrides) => resumeFvOperatorEnrollment(operatorOptions(w.world, witness, overrides), { requestId });
const fvSlot = async (witness, org) => (await witnessRows(witness.databasePath)).filter((row) => row.state_kind === FV_DOMAIN && row.organization_id === org).map((r) => [r.committed_sequence, r.pending_sequence]);
const AUTHENTICITY = () => ({ signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) });

/** Opens the registered FV store as its exclusive owner (no ceremony running), runs `use`, closes it. */
async function withStore(w, witness, use, { exclusive = true } = {}) {
  const store = await openSqliteHumanIdentityStore(w.world.paths.store, {
    organizationId: w.world.org,
    now: () => new Date().toISOString(),
    authenticity: AUTHENTICITY(),
    ...(exclusive ? { freshness: { boundary: await boundaryFor(witness, w.world.org), stateKind: FV_DOMAIN }, exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close(), storeId: w.registration.storeId } } : {}),
  });
  try {
    return await use(store);
  } finally {
    store.close();
  }
}
const kinds = (w, witness) => withStore(w, witness, (store) => store.history().map((row) => row.kind));
const FIRST_ADMIN_ROWS = ['principal_created', 'enrolment_authorized', 'credential_registered'];
const OPERATOR_ROWS = ['credential_used', 'principal_created', 'enrolment_authorized', 'credential_registered'];
/** After a child signed with the administrator's passkey, the parent's copy is behind: continue from the child's state. */
const adopt = (w, state) => {
  w.admin = new SoftwareAuthenticator({ origin: ORIGIN, restore: state });
};
const bump = (w, by = 100) => adopt(w, { ...w.admin.exportState(), counter: w.admin.exportState().counter + by });

/** Builds an operator enrolment's evidence by hand against the store's current head (for AUTH-03-level tests). */
async function evidenceFor(w, witness, store, { operatorId = 'fv-operator-x', candidate = new SoftwareAuthenticator({ origin: ORIGIN }), admin = w.admin, lifetimeMs = 60_000, now = Date.now(), patch = (a) => a, adminOverrides = {}, reuse } = {}) {
  const head = store.head();
  const requestId = reuse?.requestId ?? newRequestId();
  const fresh = fvOperatorCandidateOptions({ relyingParty: RP, requestId, operatorId, displayName: 'X', timeoutSeconds: 60, excludeCredentialIds: [] });
  // `reuse`: an earlier request's id and nonce (its candidate challenge), answered by another credential.
  const issued = reuse === undefined ? fresh : { ...fresh, nonce: reuse.nonce, options: { ...fresh.options, challenge: fvOperatorCandidateChallenge(requestId, reuse.nonce) } };
  const attestation = JSON.parse(JSON.stringify(candidate.register(issued.options)));
  const credential = await verifyFvOperatorCandidate({ relyingParty: RP, requestId, nonce: issued.nonce, response: attestation });
  const authorization = patch({
    format: FV_OPERATOR_AUTHORIZATION_FORMAT,
    action: FV_OPERATOR_ENROLL_ACTION,
    requestId,
    organizationId: w.world.org,
    deploymentId: w.registration.deploymentId,
    stateKind: FV_DOMAIN,
    storeId: w.registration.storeId,
    witnessId: witness.witnessId,
    witnessKeyDigest: witnessKeyDigestOf(witness.publicKeyPem),
    priorHead: { sequence: head.sequence, chainDigest: head.chainDigest },
    administrator: { operatorId: ADMIN, credentialId: w.adminCredentialId },
    candidate: { operatorId, displayName: 'X', userHandle: issued.userHandle, credentialDigest: firstAdministratorCredentialDigest(credential), attestationChallengeDigest: credential.challengeDigest },
    role: 'fv-operator',
    enrolment: { enrolmentId: `enr-${randomBytes(16).toString('hex')}`, tokenVerifier: createHash('sha256').update(randomBytes(32)).digest('hex') },
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + lifetimeMs).toISOString(),
  });
  const assertion = JSON.parse(JSON.stringify(admin.assert(fvOperatorAdministratorOptions({ relyingParty: RP, authorization, timeoutSeconds: 60 }), adminOverrides)));
  return { authorization, candidateNonce: issued.nonce, candidateAttestation: attestation, administratorAssertion: assertion };
}
const contextOf = (w, witness, overrides = {}) => ({ relyingParty: RP, expected: { deploymentId: w.registration.deploymentId, stateKind: FV_DOMAIN, witnessId: witness.witnessId, witnessKeyDigest: witnessKeyDigestOf(witness.publicKeyPem), ...overrides }, get now() {
  return new Date();
} });

describe('FV-P4C-2B3C-2A2B — the FV administrator enrols FV operators', () => {
  it('enrols an operator: candidate proof, administrator assertion over the exact request, four signed rows, witness-confirmed; AUTH-02 recognizes the operator; roles come from signed rows', async () => {
    const { witness, w } = await world();
    const { request, candidate } = operatorRequest(w);
    const outcome = await enroll(w, witness, request);
    assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
    assert.deepEqual([outcome.evidence.operatorId, outcome.evidence.role, outcome.evidence.administratorOperatorId, outcome.evidence.authorizedAtSequence, outcome.evidence.storeSequence], ['fv-operator-a', 'fv-operator', ADMIN, 3, 7]);
    assert.deepEqual(await fvSlot(witness, w.world.org), [[7, null]]);
    await withStore(w, witness, async (store) => {
      const history = store.history();
      assert.deepEqual(history.map((r) => r.kind), [...FIRST_ADMIN_ROWS, ...OPERATOR_ROWS]);
      assert.deepEqual([...fvRolesOf(history)], [[ADMIN, 'fv-administrator'], ['fv-operator-a', 'fv-operator']]);
      const used = JSON.parse(history[3].payload);
      assert.equal(history[3].objectId, w.adminCredentialId, 'the administrator’s credential use consumes its authorization');
      assert.match(used.planDigest, /^sha256:/);
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a'] });
      assert.deepEqual(identity.enrolmentsOf('fv-operator-a').map((e) => [e.state, e.expiresAt]), [['consumed', '1970-01-01T00:00:00.000Z']]);
      const recognized = await identity.finishAuthentication(candidate.assert(identity.beginAuthentication()));
      assert.equal(recognized.operatorId, 'fv-operator-a');
    });
  });

  it('enrols several operators, each authorization bound to its own head; the same operator or the same credential twice is refused', async () => {
    const { witness, w } = await world();
    const shared = new SoftwareAuthenticator({ origin: ORIGIN });
    assert.equal((await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-a', candidate: shared }).request)).outcome, 'enrolled');
    const b = await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-b' }).request);
    assert.deepEqual([b.outcome, b.evidence.authorizedAtSequence, b.evidence.storeSequence], ['enrolled', 7, 11]);
    assert.deepEqual(await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-a' }).request), { outcome: 'refused', reason: 'CANDIDATE_EXISTS' });
    assert.deepEqual(await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-c', candidate: shared }).request), { outcome: 'refused', reason: 'CREDENTIAL_DUPLICATE' });
    assert.equal((await kinds(w, witness)).length, 11);
  });
});

describe('FV-P4C-2B3C-2A2B — Host administrator authority never implies FV administrator authority', () => {
  const hostAdmin = (org) => identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: org, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });

  it('every general administrative act, token registration and owner revocation is refused on an FV store, through its owner’s handle or a plain one; nothing is written', async () => {
    const { witness, w } = await world();
    for (const exclusive of [true, false]) {
      await withStore(
        w,
        witness,
        async (store) => {
          const before = store.history().length;
          const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'intruder'] });
          const admin = hostAdmin(w.world.org);
          const refused = { code: 'HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED' };
          await assert.rejects(identity.createPrincipal(admin, { operatorId: 'intruder', displayName: 'Intruder' }), refused);
          await assert.rejects(identity.authorizeEnrolment(admin, ADMIN), refused);
          await assert.rejects(identity.revokePrincipal(admin, ADMIN, 'no'), refused);
          await assert.rejects(identity.revokeCredential(admin, w.adminCredentialId, 'no'), refused);
          await assert.rejects(identity.revokeEnrolment(admin, `enr-${'0'.repeat(32)}`, 'no'), refused);
          assert.throws(() => identity.beginRegistration(`fre1.enr-${'0'.repeat(32)}.${'A'.repeat(43)}`), refused);
          await assert.rejects(identity.finishRegistration(`fre1.enr-${'0'.repeat(32)}.${'A'.repeat(43)}`, {}), refused);
          assert.throws(() => identity.beginOwnerRevocation(w.adminCredentialId), refused);
          await assert.rejects(identity.finishOwnerRevocation(w.adminCredentialId, {}, 'no'), refused);
          assert.equal(store.history().length, before, exclusive ? 'owner handle' : 'plain handle');
        },
        { exclusive },
      );
    }
    assert.deepEqual(await fvSlot(witness, w.world.org), [[3, null]]);
  });

  it('an FV store opened by its owner is refused even before its first administrator exists', async () => {
    const witness = await started();
    const { world: registered, registration } = await registeredWorld(witness);
    const w = { world: registered, registration };
    await withStore(w, witness, async (store) => {
      assert.equal(store.history().length, 0);
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: ['intruder'] });
      await assert.rejects(identity.createPrincipal(hostAdmin(registered.org), { operatorId: 'intruder', displayName: 'Intruder' }), { code: 'HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED' });
      assert.equal(store.history().length, 0);
    });
  });

  it('a Host store keeps its ordinary Host administration', async () => {
    const dir = own(mkdtempSync(join(tmpdir(), 'fv-b3c2a2b-host-')));
    const store = await openSqliteHumanIdentityStore(join(dir, 'host.sqlite'), { organizationId: 'org-host', now: () => new Date().toISOString(), authenticity: AUTHENTICITY(), create: true });
    try {
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: ['host-op'] });
      const principal = await identity.createPrincipal(hostAdmin('org-host'), { operatorId: 'host-op', displayName: 'Host operator' });
      assert.equal(principal.state, 'active');
      assert.equal((await identity.authorizeEnrolment(hostAdmin('org-host'), 'host-op')).state, 'open');
    } finally {
      store.close();
    }
  });

  it('an FV operator cannot administer: naming it as the administrator, or the administrator with the operator’s credential, is refused', async () => {
    const { witness, w } = await world();
    const operator = new SoftwareAuthenticator({ origin: ORIGIN });
    const enrolled = await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-a', candidate: operator }).request);
    assert.equal(enrolled.outcome, 'enrolled');
    const asAdmin = operatorRequest(w, { operatorId: 'fv-operator-b', administratorOperatorId: 'fv-operator-a', admin: operator, adminCredentialId: enrolled.evidence.credentialId });
    assert.deepEqual(await enroll(w, witness, asAdmin.request), { outcome: 'refused', reason: 'NOT_ADMINISTRATOR' });
    const borrowed = operatorRequest(w, { operatorId: 'fv-operator-b', admin: operator, adminCredentialId: enrolled.evidence.credentialId });
    assert.deepEqual(await enroll(w, witness, borrowed.request), { outcome: 'refused', reason: 'ADMINISTRATOR_CREDENTIAL_UNUSABLE' });
    assert.equal((await kinds(w, witness)).length, 7);
  });

  it('another organization’s FV administrator is no administrator here, and evidence made for one store never applies to another', async () => {
    const witness = await started();
    const a = await administeredWorld(witness, { org: 'org-fv-b3c2a2b-a' });
    const b = await administeredWorld(witness, { org: 'org-fv-b3c2a2b-b' });
    // A's administrator, naming its own credential, against B's store.
    assert.deepEqual(await enroll(b, witness, operatorRequest(b, { admin: a.admin, adminCredentialId: a.adminCredentialId }).request), { outcome: 'refused', reason: 'ADMINISTRATOR_CREDENTIAL_UNUSABLE' });
    // A's administrator's passkey answering for B's administrator credential: the signature is not B's administrator's.
    const forged = await enroll(b, witness, operatorRequest(b, { admin: a.admin }).request);
    assert.deepEqual([forged.outcome, forged.reason], ['refused', 'ADMINISTRATOR_PROOF_INVALID']);
    // Evidence A's administrator made for A's store, presented to B's store.
    await withStore(a, witness, async (storeA) => {
      const evidence = await evidenceFor(a, witness, storeA);
      await withStore(b, witness, async (storeB) => {
        const verification = await verifyFvOperatorEvidence(storeB.history(), storeB, evidence, contextOf(b, witness));
        assert.deepEqual(verification, { verified: false, reason: 'SCOPE_MISMATCH' });
      });
    });
    assert.deepEqual([await fvSlot(witness, a.world.org), await fvSlot(witness, b.world.org)], [[[3, null]], [[3, null]]]);
  });
});

describe('FV-P4C-2B3C-2A2B — the authorization is exactly bound: AUTH-03 decides from the signed history', () => {
  it('refuses every altered, misdirected, stale, unverified, regressed, expired or over-long authorization; the genuine one appends once', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, async (store) => {
      const ctx = contextOf(w, witness);
      const check = async (name, evidence, reason, context = ctx) => assert.deepEqual(await verifyFvOperatorEvidence(store.history(), store, evidence, context), { verified: false, reason }, name);
      const genuine = await evidenceFor(w, witness, store);
      await check('another deployment', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { deploymentId: 'deployment:other' }));
      await check('another witness', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { witnessId: 'witness:other' }));
      await check('another state kind', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { stateKind: 'human-identity-state' }));
      await check('signed for another organization', await evidenceFor(w, witness, store, { patch: (a) => ({ ...a, organizationId: 'org-other' }) }), 'SCOPE_MISMATCH');
      await check('signed for another store', await evidenceFor(w, witness, store, { patch: (a) => ({ ...a, storeId: 'human-identity-store:00000000-0000-4000-8000-000000000000' }) }), 'SCOPE_MISMATCH');
      for (const [name, change] of [
        ['the candidate’s operator id after signing', (a) => ({ ...a, candidate: { ...a.candidate, operatorId: 'fv-operator-z' } })],
        ['the candidate’s credential digest after signing', (a) => ({ ...a, candidate: { ...a.candidate, credentialDigest: `sha256:${'3'.repeat(64)}` } })],
        ['the window after signing', (a) => ({ ...a, notAfter: new Date(Date.parse(a.notAfter) + 1_000).toISOString() })],
      ]) {
        await check(name, { ...genuine, authorization: change(genuine.authorization) }, 'ASSERTION_INVALID');
      }
      await check('the administrator role requested', { ...genuine, authorization: { ...genuine.authorization, role: 'fv-administrator' } }, 'MALFORMED');
      await check('another prior head', { ...genuine, authorization: { ...genuine.authorization, priorHead: { sequence: 2, chainDigest: genuine.authorization.priorHead.chainDigest } } }, 'STALE_HEAD');
      await check('another request’s attestation', { ...genuine, candidateAttestation: (await evidenceFor(w, witness, store)).candidateAttestation }, 'ATTESTATION_INVALID');
      const substitute = new SoftwareAuthenticator({ origin: ORIGIN }).register({ ...fvOperatorCandidateOptions({ relyingParty: RP, requestId: genuine.authorization.requestId, operatorId: 'fv-operator-x', displayName: 'X', timeoutSeconds: 60, excludeCredentialIds: [] }).options, challenge: fvOperatorCandidateChallenge(genuine.authorization.requestId, genuine.candidateNonce) });
      await check('another passkey answering this request’s challenge (substitution after approval)', { ...genuine, candidateAttestation: JSON.parse(JSON.stringify(substitute)) }, 'CANDIDATE_MISMATCH');
      await check('an assertion without user verification', await evidenceFor(w, witness, store, { adminOverrides: { userVerified: false } }), 'ASSERTION_INVALID');
      await check('another key claiming the administrator’s credential', await evidenceFor(w, witness, store, { admin: new SoftwareAuthenticator({ origin: ORIGIN, credentialId: Buffer.from(w.adminCredentialId, 'base64url') }) }), 'ASSERTION_INVALID');
      await check('an expired authorization', await evidenceFor(w, witness, store, { now: Date.now() - 120_000, lifetimeMs: 60_000 }), 'WINDOW_CLOSED');
      await check('a window over 300 s', await evidenceFor(w, witness, store, { lifetimeMs: 301_000 }), 'MALFORMED');
      // The genuine evidence appends exactly once; the same evidence again adds nothing.
      await appendFvOperator(store, genuine, ctx);
      assert.equal(store.history().length, 7);
      await appendFvOperator(store, genuine, ctx);
      assert.equal(store.history().length, 7);
      // AUTH-03 itself refuses an FV operator acting as the administrator, with its own credential (not only the ceremony's early check).
      const operatorDevice = new SoftwareAuthenticator({ origin: ORIGIN });
      const byOperator = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-o', candidate: operatorDevice });
      await appendFvOperator(store, byOperator, ctx);
      const asAdmin = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-p', admin: operatorDevice, patch: (a) => ({ ...a, administrator: { operatorId: 'fv-operator-o', credentialId: operatorDevice.id } }) });
      await check('an FV operator as the administrator (AUTH-03)', asAdmin, 'NOT_ADMINISTRATOR');
      // AUTH-03 itself refuses a principal that already exists (not only the ceremony's early check).
      await check('an operator that already exists', await evidenceFor(w, witness, store, { operatorId: 'fv-operator-x' }), 'CANDIDATE_EXISTS');
      // A new candidate credential answering an earlier, consumed candidate challenge (its request id and nonce), under a
      // genuine administrator signature at the new head: refused, never a second consumption (which AUTH-02 would read as corruption).
      await check('a consumed candidate challenge answered again', await evidenceFor(w, witness, store, { operatorId: 'fv-operator-r', reuse: { requestId: genuine.authorization.requestId, nonce: genuine.candidateNonce } }), 'CHALLENGE_CONSUMED');
      // The genuine use advanced the administrator's stored counter: a counter at or below it is refused.
      await check('a counter that did not advance', await evidenceFor(w, witness, store, { operatorId: 'fv-operator-q', adminOverrides: { counter: 1 } }), 'COUNTER_REGRESSION');
      // The administrator's assertion for one candidate never serves another.
      const fresh = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-y' });
      const other = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-w' });
      await check('one candidate’s assertion for another', { ...other, administratorAssertion: fresh.administratorAssertion }, 'ASSERTION_INVALID');
    });
  });

  it('an authorization prepared at one head is refused once another enrolment advanced it (re-authorize)', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, async (store) => {
      const ctx = contextOf(w, witness);
      const first = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-1' });
      const second = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-2' });
      await appendFvOperator(store, first, ctx);
      await assert.rejects(appendFvOperator(store, second, ctx), { reason: 'STALE_HEAD' });
      assert.equal(store.history().length, 7);
    });
  });
});

describe('FV-P4C-2B3C-2A2B — real processes: one ceremony at a time', () => {
  it('a second enrolment while one holds the record is REGISTRAR_BUSY; the first completes; a retry at the new head enrols', async () => {
    const { witness, w } = await world();
    const paused = await pausedOperatorChild(w, witness, { operatorId: 'fv-operator-a', pauseAt: 'administrator-verified' });
    assert.deepEqual(await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-b' }).request), { outcome: 'refused', reason: 'REGISTRAR_BUSY' });
    paused.release();
    const done = await paused.done;
    assert.equal(done.outcome, 'enrolled');
    adopt(w, done.adminState);
    assert.equal((await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-b' }).request)).outcome, 'enrolled');
    assert.deepEqual(await fvSlot(witness, w.world.org), [[11, null]]);
  });
});

describe('FV-P4C-2B3C-2A2B — the ceremony writes only the store it holds', () => {
  it('the store file replaced under a paused ceremony: no row reaches the replacement or is reported enrolled; a resume refuses the substituted file', async () => {
    const { witness, w } = await world();
    const paused = await pausedOperatorChild(w, witness, { operatorId: 'fv-operator-a', pauseAt: 'intent-recorded' });
    const replacement = `${w.world.paths.store}.replacement`;
    copyFileSync(w.world.paths.store, replacement);
    renameSync(replacement, w.world.paths.store);
    paused.release();
    const outcome = await paused.done;
    assert.notEqual(outcome.outcome, 'enrolled', JSON.stringify(outcome));
    assert.deepEqual(await fvSlot(witness, w.world.org), [[3, null]], 'nothing reached the witness');
    assert.deepEqual((await resume(w, witness, paused.requestId ?? outcome.requestId)).reason, 'STORE_FILE_MISMATCH');
  });
});

describe('FV-P4C-2B3C-2A2B — crash consistency: SIGKILL at every durable step, completion from verified evidence only', () => {
  for (const killAt of ['candidate-verified', 'administrator-verified']) {
    it(`killed at ${killAt}, before anything was recorded: nothing written, no request to resume; a new request enrols`, async () => {
      const { witness, w } = await world();
      const killed = await runOperatorChild(w, witness, { killAt });
      assert.equal(killed.killed, true);
      assert.deepEqual(await resume(w, witness, killed.requestId), { outcome: 'refused', reason: 'NO_REQUEST' });
      assert.equal((await kinds(w, witness)).length, 3);
      bump(w);
      assert.equal((await enroll(w, witness, operatorRequest(w).request)).outcome, 'enrolled');
    });
  }

  for (const [killAt, rows] of [['intent-recorded', 0], ['credential_used', 1], ['principal_created', 2], ['enrolment_authorized', 3], ['credential_registered', 4]]) {
    it(`killed at ${killAt} (${rows} rows written): a resume re-verifies the recorded evidence and completes exactly once`, async () => {
      const { witness, w } = await world();
      const killed = await runOperatorChild(w, witness, { killAt });
      assert.equal(killed.killed, true);
      assert.equal((await kinds(w, witness)).length, 3 + rows);
      bump(w);
      assert.deepEqual(await enroll(w, witness, operatorRequest(w, { requestId: killed.requestId }).request), { outcome: 'refused', reason: 'REQUEST_PENDING' });
      const outcome = await resume(w, witness, killed.requestId);
      assert.equal(outcome.outcome, 'enrolled', JSON.stringify(outcome));
      assert.deepEqual(await kinds(w, witness), [...FIRST_ADMIN_ROWS, ...OPERATOR_ROWS]);
      assert.equal((await resume(w, witness, killed.requestId)).outcome, 'enrolled', 'a second resume reports, adds nothing');
      assert.deepEqual(await fvSlot(witness, w.world.org), [[7, null]]);
    });
  }

  for (const killAt of ['credential_used', 'principal_created', 'enrolment_authorized']) {
    it(`Codex P2: killed at ${killAt}, a new enrolment is refused until the unfinished plan is resumed; it is never stranded`, async () => {
      const { witness, w } = await world();
      const killed = await runOperatorChild(w, witness, { killAt, operatorId: 'fv-operator-a' });
      assert.equal(killed.killed, true);
      bump(w);
      // The ceremony, before any human is asked.
      assert.deepEqual(await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-b' }).request), { outcome: 'refused', reason: 'ENROLLMENT_PENDING' });
      // AUTH-03 itself, for evidence made at the partial head.
      await withStore(w, witness, async (store) => {
        const evidence = await evidenceFor(w, witness, store, { operatorId: 'fv-operator-b' });
        assert.deepEqual(await verifyFvOperatorEvidence(store.history(), store, evidence, contextOf(w, witness)), { verified: false, reason: 'PLAN_INCOMPLETE' });
        // Fix-commit review F1: nothing else is written either (an AUTH-02 authentication would strand the plan for good).
        const before = store.history().length;
        const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN] });
        await assert.rejects(identity.finishAuthentication(w.admin.assert(identity.beginAuthentication(), { counter: 9_000 })), { code: 'HUMAN_IDENTITY_FV_ENROLLMENT_PENDING' });
        assert.equal(store.history().length, before);
      });
      bump(w);
      // The unfinished plan resumes (its rows are still the history's suffix), then the next enrolment proceeds.
      assert.equal((await resume(w, witness, killed.requestId)).outcome, 'enrolled');
      assert.equal((await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-b' }).request)).outcome, 'enrolled');
      assert.deepEqual([...(await withStore(w, witness, (store) => verifyFvOperatorRoles(store.history(), w.world.org, RP)))].sort(), ['fv-operator-a', 'fv-operator-b']);
    });
  }

  it('the window closed after a crash: with no row written, refused (authorize again); with the first row written, completed', async () => {
    const { witness, w } = await world();
    const late = { clock: () => Date.now() + 10 * 60_000 };
    const none = await runOperatorChild(w, witness, { killAt: 'intent-recorded', operatorId: 'fv-operator-a' });
    assert.deepEqual(await resume(w, witness, none.requestId, late), { outcome: 'refused', reason: 'WINDOW_CLOSED' });
    assert.equal((await kinds(w, witness)).length, 3);
    const some = await runOperatorChild(w, witness, { killAt: 'credential_used', operatorId: 'fv-operator-b' });
    assert.equal((await resume(w, witness, some.requestId, late)).outcome, 'enrolled');
    // The first request's authorization was for the old head: now stale as well as expired.
    assert.equal((await resume(w, witness, none.requestId)).reason, 'STALE_HEAD');
  });

  it('a finalize that never reached the witness: pending, never enrolled; a resume completes. A lost prepare answer: pending, then refused (CORE-07 pending recovery)', async () => {
    const { witness, w } = await world();
    const options = operatorOptions(w.world, witness);
    const first = operatorRequest(w, { operatorId: 'fv-operator-a' });
    const pending = await enrollFvOperator({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'finalize', nth: 4, undelivered: true }) } }, first.request);
    assert.deepEqual([pending.outcome, pending.reason], ['pending', 'WITNESS_UNAVAILABLE']);
    assert.deepEqual(await fvSlot(witness, w.world.org), [[6, 7]]);
    assert.equal((await resume(w, witness, first.request.requestId)).outcome, 'enrolled');
    const second = operatorRequest(w, { operatorId: 'fv-operator-b' });
    const lost = await enrollFvOperator({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'prepare', nth: 2 }) } }, second.request);
    assert.equal(lost.outcome, 'pending');
    assert.deepEqual(await resume(w, witness, second.request.requestId), { outcome: 'refused', reason: 'STORE_REFUSED', detail: 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' });
  });
});

describe('FV-P4C-2B3C-2A2B — a forged record never completes an operator the administrator did not authorize', () => {
  it('a rewritten, inserted, deleted or reordered intent, and a forged completion, are refused or ignored; the genuine evidence completes', async () => {
    const { witness, w } = await world();
    const { default: Database } = await import('better-sqlite3');
    const killed = await runOperatorChild(w, witness, { killAt: 'intent-recorded' });
    bump(w);
    const read = new Database(w.world.paths.record, { readonly: true });
    const original = read.prepare(`SELECT sequence, detail FROM fv_registration_events WHERE kind = 'operator-enrollment-intent'`).get();
    read.close();
    const genuine = JSON.parse(original.detail);
    const withTrigger = (name, run) => {
      const db = new Database(w.world.paths.record);
      try {
        const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name).sql;
        db.exec(`DROP TRIGGER ${name}`);
        run(db);
        db.exec(trigger);
      } finally {
        db.close();
      }
    };
    const rewrite = (detail) => withTrigger('fv_registration_events_append_only_update', (db) => db.prepare('UPDATE fv_registration_events SET detail = ? WHERE sequence = ?').run(detail, original.sequence));
    const insert = (kind, detail) => {
      const db = new Database(w.world.paths.record);
      db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), kind, detail);
      db.close();
    };
    // The forger's passkey and its digest in place of the candidate's: the administrator never signed that.
    const forger = new SoftwareAuthenticator({ origin: ORIGIN });
    const swapped = (() => {
      const e = genuine.evidence;
      return { requestId: genuine.requestId, evidence: { ...e, candidateAttestation: forger.register(fvOperatorCandidateOptions({ relyingParty: RP, requestId: e.authorization.requestId, operatorId: 'fv-operator-a', displayName: 'x', timeoutSeconds: 60, excludeCredentialIds: [] }).options) } };
    })();
    rewrite(JSON.stringify(swapped));
    assert.equal((await resume(w, witness, killed.requestId)).outcome, 'refused');
    rewrite(JSON.stringify({ ...genuine, evidence: { ...genuine.evidence, authorization: { ...genuine.evidence.authorization, role: 'fv-administrator' } } }));
    assert.equal((await resume(w, witness, killed.requestId)).outcome, 'refused');
    assert.equal((await kinds(w, witness)).length, 3, 'nothing written by a forged intent');
    // Deleted: nothing to resume.
    withTrigger('fv_registration_events_append_only_delete', (db) => db.prepare('DELETE FROM fv_registration_events WHERE sequence = ?').run(original.sequence));
    assert.deepEqual(await resume(w, witness, killed.requestId), { outcome: 'refused', reason: 'NO_REQUEST' });
    // Reordered: a forged copy first, a forged completion and junk beside it, the genuine one reconstructed last.
    insert('operator-enrollment-intent', JSON.stringify(swapped));
    insert('operator-enrolled', JSON.stringify({ requestId: killed.requestId }));
    insert('operator-enrollment-intent', '{not json');
    insert('operator-enrollment-intent', original.detail);
    const done = await resume(w, witness, killed.requestId);
    assert.equal(done.outcome, 'enrolled', JSON.stringify(done));
    assert.notEqual(done.evidence.credentialId, forger.id, 'the genuine candidate, never the forger');
    assert.deepEqual(await kinds(w, witness), [...FIRST_ADMIN_ROWS, ...OPERATOR_ROWS]);
  });
});

describe('FV-P4C-2B3C-2A2B — review findings: the role needs the administrator’s signature; every row field is signed', () => {
  it('M1: an fv-operator row a store-signing-key holder appended has no role; a forged authorizing pair has none that verifies; the genuine operator verifies', async () => {
    const { witness, w } = await world();
    assert.equal((await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-a' }).request)).outcome, 'enrolled');
    await withStore(w, witness, async (store) => {
      const now = new Date().toISOString();
      // A bare row with the right role and recorder.
      await store.append({ kind: 'principal_created', operatorId: 'forged-op', objectId: null, payload: JSON.stringify({ authorizationCommitment: `sha256:${'0'.repeat(64)}`, authorizedBy: ADMIN, displayName: 'Forged', role: 'fv-operator', userHandle: 'AAAA' }), recordedBy: 'fv-operator-enrollment-ceremony', recordedAt: now }, () => undefined);
      assert.equal(fvRolesOf(store.history()).get('forged-op'), undefined);
      // A structurally consistent pair: the genuine contract with another candidate, its commitment recomputed, the genuine assertion copied.
      const history = store.history();
      const genuineUsed = JSON.parse(history[3].payload);
      const contract = { ...genuineUsed.authorization, candidate: { ...genuineUsed.authorization.candidate, operatorId: 'forged-pair' } };
      const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
      const commitment = `sha256:${createHash('sha256').update(canonical(contract), 'utf8').digest('hex')}`;
      await store.append({ kind: 'credential_used', operatorId: ADMIN, objectId: w.adminCredentialId, payload: canonical({ ...genuineUsed, authorization: contract, authorizationCommitment: commitment, counter: genuineUsed.counter + 50 }), recordedBy: 'fv-operator-enrollment-ceremony', recordedAt: now }, () => undefined);
      await store.append({ kind: 'principal_created', operatorId: 'forged-pair', objectId: null, payload: canonical({ authorizationCommitment: commitment, authorizedBy: ADMIN, displayName: 'Forged', role: 'fv-operator', userHandle: 'BBBB' }), recordedBy: 'fv-operator-enrollment-ceremony', recordedAt: now }, () => undefined);
      assert.equal(fvRolesOf(store.history()).get('forged-pair'), 'fv-operator', 'structure alone cannot tell');
      assert.deepEqual([...(await verifyFvOperatorRoles(store.history(), w.world.org, RP))], ['fv-operator-a'], 'only the operator the administrator’s key authorized verifies');
    });
  });

  it('role forgery matrix: every malformed authorizing structure gets no role; a consistent one with a bad signature gets one that never verifies', async () => {
    const { witness, w } = await world();
    assert.equal((await enroll(w, witness, operatorRequest(w, { operatorId: 'fv-operator-a' }).request)).outcome, 'enrolled');
    await withStore(w, witness, async (store) => {
      const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
      const digest = (v) => `sha256:${createHash('sha256').update(canonical(v), 'utf8').digest('hex')}`;
      const genuine = JSON.parse(store.history()[3].payload);
      const now = new Date().toISOString();
      let counter = genuine.counter + 10;
      // (A forged row reusing a consumed challenge digest would make AUTH-02 refuse the whole history as corrupt: each gets its own.)
      const used = (contract, { objectId = w.adminCredentialId, operatorId = ADMIN, recordedBy = 'fv-operator-enrollment-ceremony', assertion = genuine.assertion } = {}) =>
        store.append({ kind: 'credential_used', operatorId, objectId, payload: canonical({ ...genuine, authorization: contract, authorizationCommitment: digest(contract), assertion, counter: (counter += 1), challengeDigest: `sha256:${randomBytes(32).toString('hex')}` }), recordedBy, recordedAt: now }, () => undefined);
      const principal = (operatorId, commitment, authorizedBy = ADMIN) => store.append({ kind: 'principal_created', operatorId, objectId: null, payload: canonical({ authorizationCommitment: commitment, authorizedBy, displayName: 'Forged', role: 'fv-operator', userHandle: 'AAAA' }), recordedBy: 'fv-operator-enrollment-ceremony', recordedAt: now }, () => undefined);
      const contractFor = (candidate, patch = {}) => ({ ...genuine.authorization, candidate: { ...genuine.authorization.candidate, operatorId: candidate }, ...patch });
      const structural = (id) => fvRolesOf(store.history()).get(id);
      // After an unrelated (AUTH-02) authentication by the administrator.
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a'] });
      await identity.finishAuthentication(w.admin.assert(identity.beginAuthentication()));
      await principal('after-auth', `sha256:${'1'.repeat(64)}`);
      // The contract names another administrator credential than the row's.
      const c1 = contractFor('wrong-cred', { administrator: { ...genuine.authorization.administrator, credentialId: 'AAAA' } });
      await used(c1);
      await principal('wrong-cred', digest(c1));
      // The contract names another candidate.
      const c2 = contractFor('someone-else');
      await used(c2);
      await principal('other-candidate', digest(c2));
      // Reordered: the principal before its authorizing row.
      const c3 = contractFor('reordered');
      await principal('reordered', digest(c3));
      await used(c3);
      // An intermediate row between them.
      const c4 = contractFor('gapped');
      await used(c4);
      // (A forged plan start leaves the store mid-plan: AUTH-02 now refuses to write, so the gap is a raw row.)
      await store.append({ kind: 'credential_used', operatorId: ADMIN, objectId: w.adminCredentialId, payload: canonical({ backedUp: false, challengeDigest: `sha256:${randomBytes(32).toString('hex')}`, counter: (counter += 1) }), recordedBy: 'webauthn-ceremony', recordedAt: now }, () => undefined);
      await principal('gapped', digest(c4));
      // The contract's role changed.
      const c5 = contractFor('admin-role', { role: 'fv-administrator' });
      await used(c5);
      await principal('admin-role', digest(c5));
      // Authorized by an operator's credential (not the administrator's).
      const operatorCredential = store.history()[6].objectId;
      const c6 = contractFor('by-operator', { administrator: { operatorId: 'fv-operator-a', credentialId: operatorCredential } });
      await used(c6, { objectId: operatorCredential, operatorId: 'fv-operator-a' });
      await principal('by-operator', digest(c6), 'fv-operator-a');
      for (const id of ['after-auth', 'wrong-cred', 'other-candidate', 'reordered', 'gapped', 'admin-role', 'by-operator']) assert.equal(structural(id), undefined, id);
      // Structurally consistent, the administrator's signature altered: a role structure alone would grant; the verifier never does.
      const c7 = contractFor('altered-signature');
      const sig = genuine.assertion.signature;
      await used(c7, { assertion: { ...genuine.assertion, signature: `${sig.slice(0, -4)}${sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'}` } });
      await principal('altered-signature', digest(c7));
      assert.equal(structural('altered-signature'), 'fv-operator');
      assert.deepEqual([...(await verifyFvOperatorRoles(store.history(), w.world.org, RP))], ['fv-operator-a']);
    });
  });

  it('publication review F1: an approval AUTH-03 refused as stale, appended later by a signing-key holder, never verifies as an operator', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, async (store) => {
      const evidence = await evidenceFor(w, witness, store, { operatorId: 'fv-op-stale' });
      const verified = await verifyFvOperatorEvidence(store.history(), store, evidence, contextOf(w, witness));
      assert.equal(verified.verified, true);
      // The head moves (an AUTH-02 authentication): AUTH-03 now refuses the approval.
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN] });
      await identity.finishAuthentication(w.admin.assert(identity.beginAuthentication(), { counter: 5_000 }));
      await assert.rejects(appendFvOperator(store, evidence, contextOf(w, witness)), { reason: 'STALE_HEAD' });
      // A signing-key holder appends the genuine, signed rows anyway, at the later position.
      for (const row of verified.rows) await store.append(row, () => undefined);
      assert.equal(fvRolesOf(store.history()).get('fv-op-stale'), 'fv-operator', 'structurally recognizable');
      assert.deepEqual([...(await verifyFvOperatorRoles(store.history(), w.world.org, RP))], [], 'never a verified operator');
    });
  });

  it('fix-commit review F2: a garbage operator-ceremony row is no plan start and blocks nothing', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, (store) => store.append({ kind: 'credential_used', operatorId: ADMIN, objectId: w.adminCredentialId, payload: JSON.stringify({ challengeDigest: `sha256:${randomBytes(32).toString('hex')}`, counter: 1 }), recordedBy: 'fv-operator-enrollment-ceremony', recordedAt: new Date().toISOString() }, () => undefined));
    bump(w);
    assert.equal((await enroll(w, witness, operatorRequest(w).request)).outcome, 'enrolled');
  });

  it('a request under another deployment’s configuration is refused; a rolled-back store never revives a consumed authorization', async () => {
    const { witness, w } = await world();
    assert.deepEqual(await enroll(w, witness, operatorRequest(w).request, { deploymentId: 'deployment:other' }), { outcome: 'refused', reason: 'CONFIGURATION_MISMATCH' });
    // The store as it was before the enrolment, restored in place (same file) after it.
    const before = readFileSync(w.world.paths.store);
    const { request } = operatorRequest(w, { operatorId: 'fv-operator-a' });
    assert.equal((await enroll(w, witness, request)).outcome, 'enrolled');
    writeFileSync(w.world.paths.store, before);
    const replay = await resume(w, witness, request.requestId);
    assert.deepEqual([replay.outcome, replay.reason, replay.detail], ['refused', 'STORE_REFUSED', 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED']);
    assert.deepEqual(await fvSlot(witness, w.world.org), [[7, null]], 'the witness still holds the enrolment');
  });

  it('L1: the enrolment id, token verifier and time are signed: rewriting them in a recorded intent is refused; rows carry the signed time', async () => {
    const { witness, w } = await world();
    const { default: Database } = await import('better-sqlite3');
    const killed = await runOperatorChild(w, witness, { killAt: 'intent-recorded' });
    const db = new Database(w.world.paths.record);
    const original = db.prepare(`SELECT sequence, detail FROM fv_registration_events WHERE kind = 'operator-enrollment-intent'`).get();
    const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'fv_registration_events_append_only_update'`).get().sql;
    const genuine = JSON.parse(original.detail);
    for (const change of [{ enrolment: { enrolmentId: `enr-${'a'.repeat(32)}`, tokenVerifier: 'f'.repeat(64) } }, { notBefore: '1999-01-01T00:00:00.000Z' }]) {
      db.exec('DROP TRIGGER fv_registration_events_append_only_update');
      db.prepare('UPDATE fv_registration_events SET detail = ? WHERE sequence = ?').run(JSON.stringify({ ...genuine, evidence: { ...genuine.evidence, authorization: { ...genuine.evidence.authorization, ...change } } }), original.sequence);
      db.exec(trigger);
      const outcome = await resume(w, witness, killed.requestId);
      assert.equal(outcome.outcome, 'refused', JSON.stringify(change));
      assert.equal((await kinds(w, witness)).length, 3);
    }
    db.exec('DROP TRIGGER fv_registration_events_append_only_update');
    db.prepare('UPDATE fv_registration_events SET detail = ? WHERE sequence = ?').run(original.detail, original.sequence);
    db.exec(trigger);
    db.close();
    assert.equal((await resume(w, witness, killed.requestId)).outcome, 'enrolled');
    await withStore(w, witness, (store) => {
      const rows = store.history().slice(3);
      assert.deepEqual([...new Set(rows.map((r) => r.recordedAt))], [genuine.evidence.authorization.notBefore]);
      assert.equal(rows[2].objectId, genuine.evidence.authorization.enrolment.enrolmentId);
    });
  });
});

describe('FV-P4C-2B3C-2A2B — isolation: no ledger claim, no readiness', () => {
  it('an operator enrolment touches no G-02A ledger claim, and the executor still executes nothing', async () => {
    const { witness, w } = await world();
    const ledgerRows = async () => {
      const ledger = await openExecutionCapabilityConsumptionLedger(w.world.paths.ledger, { audience: AUDIENCE, clock: () => Date.now() });
      try {
        return JSON.stringify(ledger.listUnresolved()) + JSON.stringify(ledger.read('x'.repeat(64)));
      } finally {
        ledger.close();
      }
    };
    const before = await ledgerRows();
    assert.equal((await enroll(w, witness, operatorRequest(w).request)).outcome, 'enrolled');
    assert.equal(await ledgerRows(), before);
    const namespace = 'receiver:fv-b3c2a2b';
    const protectedStore = join(w.world.dir, 'fv-protected.sqlite');
    const history = join(w.world.dir, 'history.sqlite');
    const records = await openProtectedContinuityStore(protectedStore, { create: true, now: () => new Date().toISOString() });
    const h = await openSqliteStatusHighWaterMarkStore(history, { namespace, create: true });
    records.save(captureHistoryContinuity(h, { namespace, databasePath: history, generation: 1, recordedAt: new Date().toISOString() }));
    h.close();
    records.close();
    const host = await composeFvProtectedHost({
      protectedStorePath: protectedStore,
      configuration: () => ({ generation: 1, histories: [{ namespace, databasePath: history }] }),
      identity: { storePath: w.world.paths.store, storeId: w.registration.storeId, authenticity: AUTHENTICITY(), freshness: { boundary: await boundaryFor(witness, w.world.org), stateKind: FV_DOMAIN }, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a'] },
      registration: { recordPath: w.world.paths.record, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN },
      standing,
      organizationId: w.world.org,
      clock: () => new Date(),
      graceSeconds: GRACE,
      receiver: { verifySovereignStatus, establishStatusHistory },
      verificationKeyResolver: resolver,
      trustedSubjectOf: (id) => (id === SUBJECT.sovereignAssetId ? { ...SUBJECT } : undefined),
    });
    try {
      assert.equal(host.status().bootstrapExecution, 'disabled');
      assert.deepEqual(await host.bootstrap({ request: {}, signedStatusText: '', requesterResponse: {}, approverResponse: {} }), { outcome: 'refused', reason: 'BOOTSTRAP_DISABLED' });
    } finally {
      host.close();
    }
  });
});
