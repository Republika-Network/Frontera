// FV-P4C-2B3C-2A3A — FV operator credential revocation under the FV administrator's authority, end to end: a
// registered FV store with its administrator (2A2A) and operators (2A2B) enrolled by the real ceremonies, a real CORE-07
// reference witness, real AUTH-03 stores, real AUTH-02 WebAuthn verification (software passkeys), real child processes
// paused or SIGKILLed. Synthetic organizations, test-only keys and temporary directories only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { createHumanIdentityService, identityAdministratorFor, openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { firstAdministratorCredentialDigest } from '../dist/src/enterprise/human-identity/first-administrator.js';
import { chainDigestAt, verifyFvOperatorRoles } from '../dist/src/enterprise/human-identity/fv-operator.js';
import { FV_REVOCATION_ACTION, FV_REVOCATION_AUTHORIZATION_FORMAT, appendFvRevocation, fvRevocationAdministratorOptions, fvRevocationAuthorizationCommitment, verifyFvCurrentOperators, verifyFvRevocationEvidence, verifyFvRevocations } from '../dist/src/enterprise/human-identity/fv-revocation.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { captureHistoryContinuity, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { composeFvProtectedHost } from '../dist/src/enterprise/sovereign-status-history/protected-host-composition.js';
import { enrollFvOperator } from '../dist/src/enterprise/sovereign-status-history/identity-registration-operator.js';
import { resumeFvOperatorRevocation, revokeFvOperatorCredential } from '../dist/src/enterprise/sovereign-status-history/identity-registration-revocation.js';
import { witnessKeyDigestOf } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, own, removeOwnedDirectories } from './fv-p4c2b3c2a-support.mjs';
import { losingTransport } from './fv-p4c2b3c2a2a-support.mjs';
import { administeredWorld, operatorOptions, operatorRequest, runOperatorChild } from './fv-p4c2b3c2a2b-support.mjs';
import { ADMIN, ORIGIN, RP, enrolOperator, newRevocationId, operatedWorld, pausedRevocationChild, revocationRequest, runRevocationChild } from './fv-p4c2b3c2a3a-support.mjs';
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
  return { witness, w: await operatedWorld(witness, options) };
};
const revoke = (w, witness, request, overrides) => revokeFvOperatorCredential(operatorOptions(w.world, witness, overrides), request);
const resume = (w, witness, requestId, overrides) => resumeFvOperatorRevocation(operatorOptions(w.world, witness, overrides), { requestId });
const fvSlot = async (witness, org) => (await witnessRows(witness.databasePath)).filter((row) => row.state_kind === FV_DOMAIN && row.organization_id === org).map((r) => [r.committed_sequence, r.pending_sequence]);
const AUTHENTICITY = () => ({ signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) });
async function withStore(w, witness, use) {
  const store = await openSqliteHumanIdentityStore(w.world.paths.store, { organizationId: w.world.org, now: () => new Date().toISOString(), authenticity: AUTHENTICITY(), freshness: { boundary: await boundaryFor(witness, w.world.org), stateKind: FV_DOMAIN }, exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close(), storeId: w.registration.storeId } });
  try {
    return await use(store);
  } finally {
    store.close();
  }
}
const length = (w, witness) => withStore(w, witness, (store) => store.history().length);
const adopt = (w, state) => {
  w.admin = new SoftwareAuthenticator({ origin: ORIGIN, restore: state });
};
const bump = (w, by = 100) => adopt(w, { ...w.admin.exportState(), counter: w.admin.exportState().counter + by });
const contextOf = (w, witness, overrides = {}) => ({ relyingParty: RP, expected: { storeId: w.registration.storeId, deploymentId: w.registration.deploymentId, stateKind: FV_DOMAIN, witnessId: witness.witnessId, witnessKeyDigest: witnessKeyDigestOf(witness.publicKeyPem), ...overrides }, get now() {
  return new Date();
} });
const canonicalOf = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonicalOf).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalOf(v[k])}`).join(',')}}`);
/**
 * AUDIT-HF01 — the exact row AUTH-03 would write for `evidence`, built WITHOUT AUTH-03's checks: what a holder of the
 * store's signing key could append raw. (The positive controls below prove it is byte-for-byte AUTH-03's row.)
 */
async function rawRevocationRow(evidence, recordedBy = 'fv-operator-revocation-ceremony') {
  const { challengeDigestOf } = await import('../dist/src/enterprise/human-identity/decision-challenge.js');
  const { webAuthnChallengeOf } = await import('../dist/src/enterprise/human-identity/index.js');
  const { signatureCounterOf } = await import('../dist/src/enterprise/human-identity/webauthn.js');
  const { authorization, administratorAssertion: a } = evidence;
  const commitment = fvRevocationAuthorizationCommitment(authorization);
  return {
    kind: 'credential_revoked',
    operatorId: authorization.target.operatorId,
    objectId: authorization.target.credentialId,
    payload: canonicalOf({ reason: authorization.reason, revokedBy: 'fv-administrator', assertedWith: authorization.administrator.credentialId, counter: signatureCounterOf(a.response.authenticatorData), backedUp: false, challengeDigest: challengeDigestOf(webAuthnChallengeOf(commitment)), authorizationCommitment: commitment, authorization, assertion: { clientDataJSON: a.response.clientDataJSON, authenticatorData: a.response.authenticatorData, signature: a.response.signature } }),
    recordedBy,
    recordedAt: authorization.notBefore,
  };
}
/** The audit's verdict on one credential: 'authorized', 'unauthorized' or 'absent'. */
async function auditOf(w, witness, history, credentialId, expected = contextOf(w, witness).expected) {
  const { authorized, unauthorized } = await verifyFvRevocations(history, w.world.org, RP, expected);
  return authorized.has(credentialId) ? 'authorized' : unauthorized.has(credentialId) ? 'unauthorized' : 'absent';
}
/** Authenticates `device` through AUTH-02 over the FV store: the recognized operator id, or the refusal code. */
async function authenticate(w, witness, device) {
  return withStore(w, witness, async (store) => {
    const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a', 'fv-operator-b', 'fv-operator-c'] });
    try {
      return (await identity.finishAuthentication(device.assert(identity.beginAuthentication(), { counter: 50_000 + Math.floor(Math.random() * 1000) }))).operatorId;
    } catch (error) {
      return error.code;
    }
  });
}
/** Builds a revocation's evidence by hand against the store's current head (AUTH-03-level tests). */
function evidenceFor(w, witness, store, { operatorId = 'fv-operator-a', credentialId = w.operators[operatorId]?.credentialId, admin = w.admin, adminCredentialId = w.adminCredentialId, administratorOperatorId = ADMIN, lifetimeMs = 60_000, now = Date.now(), patch = (a) => a, adminOverrides = {} } = {}) {
  const head = store.head();
  const target = store.history().find((r) => r.kind === 'credential_registered' && r.objectId === credentialId);
  const publicKey = target === undefined ? 'AAAA' : JSON.parse(target.payload).publicKey;
  const authorization = patch({
    format: FV_REVOCATION_AUTHORIZATION_FORMAT,
    action: FV_REVOCATION_ACTION,
    requestId: newRevocationId(),
    organizationId: w.world.org,
    deploymentId: w.registration.deploymentId,
    stateKind: FV_DOMAIN,
    storeId: w.registration.storeId,
    witnessId: witness.witnessId,
    witnessKeyDigest: witnessKeyDigestOf(witness.publicKeyPem),
    priorHead: { sequence: head.sequence, chainDigest: head.chainDigest },
    administrator: { operatorId: administratorOperatorId, credentialId: adminCredentialId },
    target: { operatorId, credentialId: credentialId ?? 'AAAA', credentialDigest: firstAdministratorCredentialDigest({ credentialId: credentialId ?? 'AAAA', publicKey }) },
    reason: 'compromised',
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + lifetimeMs).toISOString(),
  });
  return { authorization, administratorAssertion: JSON.parse(JSON.stringify(admin.assert(fvRevocationAdministratorOptions({ relyingParty: RP, authorization, timeoutSeconds: 60 }), adminOverrides))) };
}

describe('FV-P4C-2B3C-2A3A — the FV administrator revokes an FV operator credential', () => {
  it('revokes: one signed, witness-confirmed row; the credential no longer authenticates; current authority is gone, historical membership remains', async () => {
    const { witness, w } = await world();
    const before = await length(w, witness);
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'fv-operator-a');
    const sequence = await length(w, witness);
    const outcome = await revoke(w, witness, revocationRequest(w).request);
    assert.equal(outcome.outcome, 'revoked', JSON.stringify(outcome));
    assert.deepEqual([outcome.evidence.operatorId, outcome.evidence.credentialId, outcome.evidence.reason, outcome.evidence.authorizedAtSequence, outcome.evidence.storeSequence], ['fv-operator-a', w.operators['fv-operator-a'].credentialId, 'compromised', sequence, sequence + 1]);
    assert.equal(before, 7);
    assert.deepEqual(await fvSlot(witness, w.world.org), [[sequence + 1, null]]);
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
    await withStore(w, witness, async (store) => {
      const history = store.history();
      const row = history[sequence];
      assert.deepEqual([row.kind, row.objectId, row.recordedBy], ['credential_revoked', w.operators['fv-operator-a'].credentialId, 'fv-operator-revocation-ceremony']);
      assert.deepEqual([...(await verifyFvOperatorRoles(history, w.world.org, RP))], ['fv-operator-a'], 'historical membership still verifies');
      assert.deepEqual([...(await verifyFvCurrentOperators(history, w.world.org, RP))], [], 'no current authority');
      const revocations = await verifyFvRevocations(history, w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized]], [[w.operators['fv-operator-a'].credentialId], []]);
    });
  });

  it('deterministic and idempotent: the same request is re-reported, never re-applied; a new request for a revoked credential is refused; later rows change neither', async () => {
    const { witness, w } = await world();
    const { request } = revocationRequest(w);
    assert.equal((await revoke(w, witness, request)).outcome, 'revoked');
    const after1 = await length(w, witness);
    assert.equal((await resume(w, witness, request.requestId)).outcome, 'revoked');
    assert.deepEqual(await revoke(w, witness, request), { outcome: 'refused', reason: 'REQUEST_PENDING' });
    assert.deepEqual(await revoke(w, witness, revocationRequest(w).request), { outcome: 'refused', reason: 'ALREADY_REVOKED' });
    // Another enrolment after it: the completed revocation is still re-reported, and still in force.
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    assert.equal((await resume(w, witness, request.requestId)).outcome, 'revoked');
    assert.equal(await length(w, witness), after1 + 4);
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-b'].device), 'fv-operator-b');
  });
});

describe('FV-P4C-2B3C-2A3A — only the current FV administrator revokes, and only an FV operator’s own credential', () => {
  const hostAdmin = (org) => identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: org, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });

  it('refuses a Host administrator, an FV operator as administrator, the administrator as a target, another organization’s administrator, and wrong or substituted targets; nothing is written', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    const before = await length(w, witness);
    await withStore(w, witness, async (store) => {
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a'] });
      await assert.rejects(identity.revokeCredential(hostAdmin(w.world.org), w.operators['fv-operator-a'].credentialId, 'host'), { code: 'HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED' });
    });
    const b = w.operators['fv-operator-b'];
    const other = await (async () => {
      const o = await administeredWorld(witness, { org: 'org-fv-b3c2a3a-other' });
      return o;
    })();
    const cases = [
      ['an FV operator as the administrator', revocationRequest(w, { administratorOperatorId: 'fv-operator-b', admin: b.device, adminCredentialId: b.credentialId }), 'NOT_ADMINISTRATOR'],
      ['the administrator with an operator’s credential', revocationRequest(w, { admin: b.device, adminCredentialId: b.credentialId }), 'ADMINISTRATOR_CREDENTIAL_UNUSABLE'],
      ['the administrator as the target', revocationRequest(w, { operatorId: ADMIN, credentialId: w.adminCredentialId }), 'NOT_OPERATOR'],
      ['another organization’s administrator', revocationRequest(w, { admin: other.admin, adminCredentialId: other.adminCredentialId }), 'ADMINISTRATOR_CREDENTIAL_UNUSABLE'],
      ['a credential that does not exist', revocationRequest(w, { credentialId: 'A'.repeat(43) }), 'TARGET_CREDENTIAL_UNKNOWN'],
      ['another operator’s credential under this operator (substitution)', revocationRequest(w, { operatorId: 'fv-operator-a', credentialId: b.credentialId }), 'TARGET_CREDENTIAL_UNKNOWN'],
      ['a principal that is no FV operator', revocationRequest(w, { operatorId: 'nobody', credentialId: b.credentialId }), 'NOT_OPERATOR'],
    ];
    for (const [name, { request }, reason] of cases) {
      const outcome = await revoke(w, witness, request);
      assert.deepEqual([outcome.outcome, outcome.reason], ['refused', reason], `${name}: ${JSON.stringify(outcome)}`);
    }
    // Another organization's administrator, against the other store's identity: its passkey, the other credential id.
    const forged = await revoke(w, witness, revocationRequest(w, { admin: other.admin }).request);
    assert.deepEqual([forged.outcome, forged.reason], ['refused', 'ADMINISTRATOR_PROOF_INVALID']);
    assert.equal(await length(w, witness), before);
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'fv-operator-a');
  });

  it('an administrator whose credential is no longer current authorizes nothing: neither a revocation nor an enrolment (a forged revocation of it, reported unauthorized)', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, async (store) => {
      // A holder of the store's signing key revokes the administrator's credential with a raw row.
      await store.append({ kind: 'credential_revoked', operatorId: ADMIN, objectId: w.adminCredentialId, payload: JSON.stringify({ reason: 'forged', revokedBy: 'fv-administrator' }), recordedBy: 'fv-operator-revocation-ceremony', recordedAt: new Date().toISOString() }, () => undefined);
      const revocations = await verifyFvRevocations(store.history(), w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized]], [[], [w.adminCredentialId]]);
    });
    assert.deepEqual(await revoke(w, witness, revocationRequest(w).request), { outcome: 'refused', reason: 'ADMINISTRATOR_CREDENTIAL_UNUSABLE' });
    assert.deepEqual(await enrollFvOperator(operatorOptions(w.world, witness), operatorRequest(w, { operatorId: 'fv-operator-z' }).request), { outcome: 'refused', reason: 'ADMINISTRATOR_CREDENTIAL_UNUSABLE' });
  });

  it('the revocation verifier re-checks the signature and the position: a consistent forgery with a bad signature, and a refused stale approval appended later, are unauthorized', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    w.operators['fv-operator-c'] = await enrolOperator(w, witness, 'fv-operator-c');
    await withStore(w, witness, async (store) => {
      const ctx = contextOf(w, witness);
      // A genuine approval for B, made at this head, then refused as stale once the head moves.
      const stale = evidenceFor(w, witness, store, { operatorId: 'fv-operator-b' });
      const staleRow = (await verifyFvRevocationEvidence(store.history(), store, stale, ctx)).row;
      // The head moves by another operator's authentication (the administrator's counter is untouched, so only the
      // position and chain checks can tell the stale approval apart).
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-c'] });
      await identity.finishAuthentication(w.operators['fv-operator-c'].device.assert(identity.beginAuthentication(), { counter: 20_000 }));
      await assert.rejects(appendFvRevocation(store, stale, ctx), { reason: 'STALE_HEAD' });
      // A signing-key holder appends it anyway, and a consistent row for C whose signature is altered.
      await store.append(staleRow, () => undefined);
      const forged = evidenceFor(w, witness, store, { operatorId: 'fv-operator-c', adminOverrides: { counter: 30_000 } });
      const forgedRow = (await verifyFvRevocationEvidence(store.history(), store, forged, ctx)).row;
      const payload = JSON.parse(forgedRow.payload);
      const sig = payload.assertion.signature;
      payload.assertion.signature = `${sig.slice(0, -4)}${sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
      const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
      await store.append({ ...forgedRow, payload: canonical(payload) }, () => undefined);
      const revocations = await verifyFvRevocations(store.history(), w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized].sort()], [[], [w.operators['fv-operator-b'].credentialId, w.operators['fv-operator-c'].credentialId].sort()]);
    });
  });

  it('the audit judges provenance, not just the signature: an administrator-signed revocation a key holder appended outside the ceremony, or of a principal that is no verified operator, is unauthorized', async () => {
    const { witness, w } = await world();
    const { challengeDigestOf } = await import('../dist/src/enterprise/human-identity/decision-challenge.js');
    const { webAuthnChallengeOf } = await import('../dist/src/enterprise/human-identity/index.js');
    const { signatureCounterOf } = await import('../dist/src/enterprise/human-identity/webauthn.js');
    const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
    /** The exact row AUTH-03 would write for `evidence` (without AUTH-03's checks), under `recordedBy`. */
    const rowFor = (evidence, recordedBy) => {
      const { authorization, administratorAssertion: a } = evidence;
      const commitment = fvRevocationAuthorizationCommitment(authorization);
      return {
        kind: 'credential_revoked',
        operatorId: authorization.target.operatorId,
        objectId: authorization.target.credentialId,
        payload: canonical({ reason: authorization.reason, revokedBy: 'fv-administrator', assertedWith: authorization.administrator.credentialId, counter: signatureCounterOf(a.response.authenticatorData), backedUp: false, challengeDigest: challengeDigestOf(webAuthnChallengeOf(commitment)), authorizationCommitment: commitment, authorization, assertion: { clientDataJSON: a.response.clientDataJSON, authenticatorData: a.response.authenticatorData, signature: a.response.signature } }),
        recordedBy,
        recordedAt: authorization.notBefore,
      };
    };
    await withStore(w, witness, async (store) => {
      // A genuinely signed revocation of operator A, appended at its exact position, but not by the ceremony.
      await store.append(rowFor(evidenceFor(w, witness, store), 'operator-plane:ops-admin'), () => undefined);
      // A principal and credential that are no verified FV operator (no authorizing row), then a genuinely signed revocation of it, with the ceremony's recorder.
      const sample = store.history().find((r) => r.kind === 'credential_registered' && r.operatorId === 'fv-operator-a');
      const now = new Date().toISOString();
      const enrolmentId = `enr-${randomBytes(16).toString('hex')}`;
      const credentialId = randomBytes(32).toString('base64url');
      await store.append({ kind: 'principal_created', operatorId: 'not-an-operator', objectId: null, payload: canonical({ displayName: 'X', userHandle: 'AAAA' }), recordedBy: 'test:forger', recordedAt: now }, () => undefined);
      await store.append({ kind: 'enrolment_authorized', operatorId: 'not-an-operator', objectId: enrolmentId, payload: canonical({ expiresAt: '1970-01-01T00:00:00.000Z', tokenVerifier: 'f'.repeat(64) }), recordedBy: 'test:forger', recordedAt: now }, () => undefined);
      await store.append({ kind: 'credential_registered', operatorId: 'not-an-operator', objectId: credentialId, payload: canonical({ ...JSON.parse(sample.payload), enrolmentId, challengeDigest: `sha256:${randomBytes(32).toString('hex')}` }), recordedBy: 'test:forger', recordedAt: now }, () => undefined);
      w.operators['not-an-operator'] = { credentialId };
      await store.append(rowFor(evidenceFor(w, witness, store, { operatorId: 'not-an-operator', adminOverrides: { counter: 40_000 } }), 'fv-operator-revocation-ceremony'), () => undefined);
      const revocations = await verifyFvRevocations(store.history(), w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized].sort()], [[], [w.operators['fv-operator-a'].credentialId, credentialId].sort()]);
    });
  });

  it('publication review F1: a genuine authorization appended with a swapped projected field (assertedWith) is unauthorized', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    await withStore(w, witness, async (store) => {
      const evidence = evidenceFor(w, witness, store);
      const row = (await verifyFvRevocationEvidence(store.history(), store, evidence, contextOf(w, witness))).row;
      const payload = JSON.parse(row.payload);
      const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);
      // A signing-key holder appends it at its exact position, crediting the use (and its counter) to operator B's credential.
      await store.append({ ...row, payload: canonical({ ...payload, assertedWith: w.operators['fv-operator-b'].credentialId }) }, () => undefined);
      const revocations = await verifyFvRevocations(store.history(), w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized]], [[], [w.operators['fv-operator-a'].credentialId]]);
    });
  });

  it('AUDIT-HF01: an administrator-signed but off-contract revocation (over-long window, another store, deployment, state kind, witness or witness key) is refused by AUTH-03 and reported unauthorized; under its own scope the same row is authorized (the scope check is what refuses it)', async () => {
    const otherKey = `sha256:${randomBytes(32).toString('hex')}`;
    const cases = [
      { name: 'lifetime 30 days', options: { lifetimeMs: 30 * 24 * 3600_000 }, refusal: 'MALFORMED' },
      { name: 'notAfter before notBefore', options: { lifetimeMs: -60_000 }, refusal: 'MALFORMED' },
      // The prior chain digest recomputed under the claimed store id's genesis: only the explicit store-id comparison refuses it.
      { name: 'storeId', options: (store, w) => ({ patch: (a) => ({ ...a, storeId: 'other-store-id', priorHead: { ...a.priorHead, chainDigest: chainDigestAt(store.history(), 'other-store-id', w.world.org, a.priorHead.sequence) } }) }), refusal: 'SCOPE_MISMATCH', own: { storeId: 'other-store-id' } },
      { name: 'deploymentId', options: { patch: (a) => ({ ...a, deploymentId: 'other-deployment' }) }, refusal: 'SCOPE_MISMATCH', own: { deploymentId: 'other-deployment' } },
      { name: 'stateKind', options: { patch: (a) => ({ ...a, stateKind: 'frontera.other-state' }) }, refusal: 'SCOPE_MISMATCH', own: { stateKind: 'frontera.other-state' } },
      { name: 'witnessId', options: { patch: (a) => ({ ...a, witnessId: 'other-witness' }) }, refusal: 'SCOPE_MISMATCH', own: { witnessId: 'other-witness' } },
      { name: 'witnessKeyDigest', options: { patch: (a) => ({ ...a, witnessKeyDigest: otherKey }) }, refusal: 'SCOPE_MISMATCH', own: { witnessKeyDigest: otherKey } },
      { name: 'target key digest', options: { patch: (a) => ({ ...a, target: { ...a.target, credentialDigest: otherKey } }) }, refusal: 'TARGET_MISMATCH' },
      // AUTH-02's projection revokes whatever credential a row names, whoever owns it: only the audit's ownership check refuses this.
      { name: 'target credential owned by another principal', options: { credentialId: 'ADMIN_CREDENTIAL' }, refusal: 'TARGET_CREDENTIAL_UNKNOWN', target: 'admin' },
    ];
    const verdicts = [];
    for (const { name, options, refusal, own, target } of cases) {
      const { witness, w } = await world();
      await withStore(w, witness, async (store) => {
        const credentialId = target === 'admin' ? w.adminCredentialId : w.operators['fv-operator-a'].credentialId;
        const evidence = evidenceFor(w, witness, store, { ...(typeof options === 'function' ? options(store, w) : options), ...(target === 'admin' ? { credentialId } : {}) });
        const refused = (await verifyFvRevocationEvidence(store.history(), store, evidence, contextOf(w, witness))).reason;
        await store.append(await rawRevocationRow(evidence), () => undefined);
        const history = store.history();
        verdicts.push([name, refused, await auditOf(w, witness, history, credentialId), own === undefined ? '-' : await auditOf(w, witness, history, credentialId, contextOf(w, witness, own).expected)]);
      });
    }
    assert.deepEqual(verdicts, cases.map(({ name, refusal, own }) => [name, refusal, 'unauthorized', own === undefined ? '-' : 'authorized']));
  });

  it('AUDIT-HF01 controls: the raw row equals AUTH-03’s (an in-scope one, and one at exactly the 300 s cap, are authorized); without a complete authenticated scope nothing is authorized', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    await withStore(w, witness, async (store) => {
      const evidence = evidenceFor(w, witness, store);
      const raw = await rawRevocationRow(evidence);
      const auth03 = (await verifyFvRevocationEvidence(store.history(), store, evidence, contextOf(w, witness))).row;
      assert.deepEqual(raw, { ...auth03 });
      await store.append(raw, () => undefined);
      const capped = evidenceFor(w, witness, store, { operatorId: 'fv-operator-b', lifetimeMs: 300_000, adminOverrides: { counter: 40_000 } });
      assert.equal((await verifyFvRevocationEvidence(store.history(), store, capped, contextOf(w, witness))).verified, true);
      await store.append(await rawRevocationRow(capped), () => undefined);
      const history = store.history();
      const [a, b] = [w.operators['fv-operator-a'].credentialId, w.operators['fv-operator-b'].credentialId];
      assert.deepEqual([await auditOf(w, witness, history, a), await auditOf(w, witness, history, b)], ['authorized', 'authorized']);
      const { deploymentId: _omitted, ...incomplete } = contextOf(w, witness).expected;
      for (const expected of [undefined, null, incomplete, { ...contextOf(w, witness).expected, witnessId: '' }]) {
        const { authorized, unauthorized } = await verifyFvRevocations(history, w.world.org, RP, expected);
        assert.deepEqual([[...authorized], [...unauthorized].sort()], [[], [a, b].sort()]);
      }
    });
  });

  it('AUDIT-HF01 retained limit (F2): a genuine in-scope authorization the ceremony refused as expired, appended later at its unchanged head by a key holder, is still labelled authorized — the audit cannot prove append time', async () => {
    const { witness, w } = await world();
    await withStore(w, witness, async (store) => {
      const evidence = evidenceFor(w, witness, store, { now: Date.now() - 20 * 60_000, lifetimeMs: 60_000 });
      assert.equal((await verifyFvRevocationEvidence(store.history(), store, evidence, contextOf(w, witness))).reason, 'WINDOW_CLOSED');
      await store.append(await rawRevocationRow(evidence), () => undefined);
      assert.equal(await auditOf(w, witness, store.history(), w.operators['fv-operator-a'].credentialId), 'authorized');
    });
    // It only removes authority: the credential no longer authenticates.
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
  });

  it('AUDIT-HF01 (F-D): the append guard refuses a revocation whose verified head was advanced by a write of the same owner before the append (CONFLICT); nothing revoked, history and witness consistent', async () => {
    const { witness, w } = await world();
    const credentialId = w.operators['fv-operator-a'].credentialId;
    await withStore(w, witness, async (store) => {
      const evidence = evidenceFor(w, witness, store);
      const before = store.history().length;
      // The same exclusive owner (one process, one store instance) authenticates operator A through AUTH-02 while the
      // revocation's verification has already run: the write lands between AUTH-03's check and its guarded append.
      const identity = createHumanIdentityService({ store, relyingParty: RP, operatorIds: [ADMIN, 'fv-operator-a'] });
      const raced = new Proxy(store, {
        get(target, property) {
          if (property === 'append') {
            return async (row, guard) => {
              await identity.finishAuthentication(w.operators['fv-operator-a'].device.assert(identity.beginAuthentication(), { counter: 60_000 }));
              return target.append(row, guard);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await assert.rejects(appendFvRevocation(raced, evidence, contextOf(w, witness)), (error) => error.reason === 'CONFLICT');
      const history = store.history();
      assert.deepEqual([history.length, history.at(-1).kind, history.some((row) => row.kind === 'credential_revoked')], [before + 1, 'credential_used', false]);
    });
    // Reopened (signed chain and CORE-07 freshness re-verified): the witness holds exactly the store's head, nothing pending; A is still a current operator.
    const head = await withStore(w, witness, async (store) => ({ sequence: store.head().sequence, current: await verifyFvCurrentOperators(store.history(), w.world.org, RP) }));
    assert.deepEqual(await fvSlot(witness, w.world.org), [[head.sequence, null]]);
    assert.equal(head.current.has('fv-operator-a'), true);
    assert.equal(await auditOf(w, witness, (await withStore(w, witness, (store) => store.history())), credentialId), 'absent');
  });

  it('a revocation row a store-signing-key holder forged only removes authority, and is reported unauthorized', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    const genuine = await revoke(w, witness, revocationRequest(w, { operatorId: 'fv-operator-b' }).request);
    assert.equal(genuine.outcome, 'revoked');
    await withStore(w, witness, async (store) => {
      // A copy of the genuine row's shape (its contract and assertion) aimed at another credential, and a bare row.
      const genuineRow = store.history().at(-1);
      const payload = JSON.parse(genuineRow.payload);
      await store.append({ kind: 'credential_revoked', operatorId: 'fv-operator-a', objectId: w.operators['fv-operator-a'].credentialId, payload: JSON.stringify({ ...payload, challengeDigest: `sha256:${randomBytes(32).toString('hex')}`, counter: payload.counter + 5 }), recordedBy: 'fv-operator-revocation-ceremony', recordedAt: new Date().toISOString() }, () => undefined);
      const history = store.history();
      const revocations = await verifyFvRevocations(history, w.world.org, RP, contextOf(w, witness).expected);
      assert.deepEqual([[...revocations.authorized], [...revocations.unauthorized]], [[w.operators['fv-operator-b'].credentialId], [w.operators['fv-operator-a'].credentialId]]);
      assert.deepEqual([...(await verifyFvCurrentOperators(history, w.world.org, RP))], [], 'fail closed: a revoked credential never counts');
    });
    // Review L2: a forged revocation under another recorder (AUTH-02's administrator shape) is reported too, never silently.
    w.operators['fv-operator-c'] = await (async () => {
      bump(w);
      return enrolOperator(w, witness, 'fv-operator-c');
    })();
    await withStore(w, witness, async (store) => {
      await store.append({ kind: 'credential_revoked', operatorId: 'fv-operator-c', objectId: w.operators['fv-operator-c'].credentialId, payload: JSON.stringify({ reason: 'forged', revokedBy: 'administrator' }), recordedBy: 'operator-plane:ops-admin', recordedAt: new Date().toISOString() }, () => undefined);
      const revocations = await verifyFvRevocations(store.history(), w.world.org, RP, contextOf(w, witness).expected);
      assert.ok(revocations.unauthorized.has(w.operators['fv-operator-c'].credentialId));
      assert.ok(!revocations.authorized.has(w.operators['fv-operator-c'].credentialId));
    });
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
  });
});

describe('FV-P4C-2B3C-2A3A — the authorization is exactly bound: AUTH-03 decides from the signed history', () => {
  it('refuses every altered, misdirected, stale, unverified, regressed, expired or over-long authorization; the genuine one appends once', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    await withStore(w, witness, async (store) => {
      const ctx = contextOf(w, witness);
      const check = async (name, evidence, reason, context = ctx) => assert.deepEqual(await verifyFvRevocationEvidence(store.history(), store, evidence, context), { verified: false, reason }, name);
      const genuine = evidenceFor(w, witness, store);
      await check('another deployment', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { deploymentId: 'deployment:other' }));
      await check('another witness', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { witnessId: 'witness:other' }));
      await check('another state kind (the Host’s domain)', genuine, 'SCOPE_MISMATCH', contextOf(w, witness, { stateKind: 'human-identity-state' }));
      await check('signed for another organization', evidenceFor(w, witness, store, { patch: (a) => ({ ...a, organizationId: 'org-other' }) }), 'SCOPE_MISMATCH');
      for (const [name, change] of [
        ['the target after signing', (a) => ({ ...a, target: { ...a.target, operatorId: 'fv-operator-b', credentialId: w.operators['fv-operator-b'].credentialId } })],
        ['the reason after signing', (a) => ({ ...a, reason: 'other' })],
        ['the window after signing', (a) => ({ ...a, notAfter: new Date(Date.parse(a.notAfter) + 1_000).toISOString() })],
      ]) {
        // Retargeted: the named credential's key is not the signed digest (refused before the signature is even checked).
        await check(name, { ...genuine, authorization: change(genuine.authorization) }, name.startsWith('the target') ? 'TARGET_MISMATCH' : 'ASSERTION_INVALID');
      }
      await check('a substituted target key (digest)', evidenceFor(w, witness, store, { patch: (a) => ({ ...a, target: { ...a.target, credentialDigest: `sha256:${'4'.repeat(64)}` } }) }), 'TARGET_MISMATCH');
      await check('another prior head', { ...genuine, authorization: { ...genuine.authorization, priorHead: { sequence: 2, chainDigest: genuine.authorization.priorHead.chainDigest } } }, 'STALE_HEAD');
      await check('an assertion without user verification', evidenceFor(w, witness, store, { adminOverrides: { userVerified: false } }), 'ASSERTION_INVALID');
      await check('another key claiming the administrator’s credential', evidenceFor(w, witness, store, { admin: new SoftwareAuthenticator({ origin: ORIGIN, credentialId: Buffer.from(w.adminCredentialId, 'base64url') }) }), 'ASSERTION_INVALID');
      await check('an expired authorization', evidenceFor(w, witness, store, { now: Date.now() - 120_000, lifetimeMs: 60_000 }), 'WINDOW_CLOSED');
      await check('a window over 300 s', evidenceFor(w, witness, store, { lifetimeMs: 301_000 }), 'MALFORMED');
      // AUTH-03 itself (not only the ceremony's early checks): an FV operator as the administrator, and one operator's credential under another's name.
      const b = w.operators['fv-operator-b'];
      await check('an FV operator as the administrator (AUTH-03)', evidenceFor(w, witness, store, { administratorOperatorId: 'fv-operator-b', admin: b.device, adminCredentialId: b.credentialId }), 'NOT_ADMINISTRATOR');
      await check('operator B’s credential under operator A (AUTH-03)', evidenceFor(w, witness, store, { operatorId: 'fv-operator-a', credentialId: b.credentialId }), 'TARGET_CREDENTIAL_UNKNOWN');
      // The genuine one appends exactly once; then the same evidence is re-reported, adding nothing.
      await appendFvRevocation(store, genuine, ctx);
      const after1 = store.history().length;
      await appendFvRevocation(store, genuine, ctx);
      assert.equal(store.history().length, after1);
      // After it: a counter at or below the stored one, a revoked target, a stale authorization, a replayed assertion.
      await check('a counter that did not advance', evidenceFor(w, witness, store, { operatorId: 'fv-operator-b', adminOverrides: { counter: 1 } }), 'COUNTER_REGRESSION');
      await check('the revoked credential again', evidenceFor(w, witness, store), 'ALREADY_REVOKED');
      const stale = { ...evidenceFor(w, witness, store, { operatorId: 'fv-operator-b' }), authorization: undefined };
      void stale;
      const fresh = evidenceFor(w, witness, store, { operatorId: 'fv-operator-b' });
      await check('one revocation’s assertion for another target', { ...fresh, administratorAssertion: genuine.administratorAssertion }, 'ASSERTION_INVALID');
    });
  });

  it('an authorization prepared at one head is refused once anything advanced it (re-authorize)', async () => {
    const { witness, w } = await world();
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    await withStore(w, witness, async (store) => {
      const ctx = contextOf(w, witness);
      const first = evidenceFor(w, witness, store);
      const second = evidenceFor(w, witness, store, { operatorId: 'fv-operator-b' });
      await appendFvRevocation(store, first, ctx);
      await assert.rejects(appendFvRevocation(store, second, ctx), { reason: 'STALE_HEAD' });
    });
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-b'].device), 'fv-operator-b');
  });
});

describe('FV-P4C-2B3C-2A3A — interaction with operator enrolment', () => {
  for (const killAt of ['credential_used', 'principal_created', 'enrolment_authorized']) {
    it(`an enrolment killed at ${killAt}: revocation is refused until it is resumed; its own target is no operator yet; afterwards revocation proceeds`, async () => {
      const { witness, w } = await world();
      const killed = await runOperatorChild(w, witness, { killAt, operatorId: 'fv-operator-b' });
      assert.equal(killed.killed, true);
      bump(w);
      const before = await length(w, witness);
      assert.deepEqual(await revoke(w, witness, revocationRequest(w).request), { outcome: 'refused', reason: 'ENROLLMENT_PENDING' });
      await withStore(w, witness, async (store) => assert.deepEqual(await verifyFvRevocationEvidence(store.history(), store, evidenceFor(w, witness, store), contextOf(w, witness)), { verified: false, reason: 'PLAN_INCOMPLETE' }));
      assert.equal(await length(w, witness), before);
      bump(w);
      const { resumeFvOperatorEnrollment } = await import('../dist/src/enterprise/sovereign-status-history/identity-registration-operator.js');
      assert.equal((await resumeFvOperatorEnrollment(operatorOptions(w.world, witness), { requestId: killed.requestId })).outcome, 'enrolled');
      assert.equal((await revoke(w, witness, revocationRequest(w).request)).outcome, 'revoked');
    });
  }

  it('an enrolment after a revocation proceeds at the new head; the revoked operator id cannot be re-enrolled (one credential per operator, by design)', async () => {
    const { witness, w } = await world();
    assert.equal((await revoke(w, witness, revocationRequest(w).request)).outcome, 'revoked');
    assert.equal((await enrollFvOperator(operatorOptions(w.world, witness), operatorRequest(w, { operatorId: 'fv-operator-b' }).request)).outcome, 'enrolled');
    assert.deepEqual(await enrollFvOperator(operatorOptions(w.world, witness), operatorRequest(w, { operatorId: 'fv-operator-a' }).request), { outcome: 'refused', reason: 'CANDIDATE_EXISTS' });
  });
});

describe('FV-P4C-2B3C-2A3A — crash consistency: SIGKILL at every durable step, completion from verified evidence only', () => {
  it('killed after the administrator’s proof, before the intent: nothing recorded or written; a new request revokes', async () => {
    const { witness, w } = await world();
    const before = await length(w, witness);
    const killed = await runRevocationChild(w, witness, { killAt: 'administrator-verified' });
    assert.equal(killed.killed, true);
    assert.deepEqual(await resume(w, witness, killed.requestId), { outcome: 'refused', reason: 'NO_REQUEST' });
    assert.equal(await length(w, witness), before);
    bump(w);
    assert.equal((await revoke(w, witness, revocationRequest(w).request)).outcome, 'revoked');
  });

  for (const killAt of ['intent-recorded', 'credential_revoked']) {
    it(`killed at ${killAt}: a resume re-verifies the recorded evidence and completes (or confirms) exactly once`, async () => {
      const { witness, w } = await world();
      const before = await length(w, witness);
      const killed = await runRevocationChild(w, witness, { killAt });
      assert.equal(killed.killed, true);
      assert.equal(await length(w, witness), before + (killAt === 'credential_revoked' ? 1 : 0));
      const outcome = await resume(w, witness, killed.requestId);
      assert.equal(outcome.outcome, 'revoked', JSON.stringify(outcome));
      assert.equal(await length(w, witness), before + 1);
      assert.equal((await resume(w, witness, killed.requestId)).outcome, 'revoked');
      assert.deepEqual(await fvSlot(witness, w.world.org), [[before + 1, null]]);
      assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE');
    });
  }

  it('the window closed after a crash before the row: refused (authorize again); a stale head after another write: refused', async () => {
    const { witness, w } = await world();
    const killed = await runRevocationChild(w, witness, { killAt: 'intent-recorded' });
    assert.deepEqual(await resume(w, witness, killed.requestId, { clock: () => Date.now() + 10 * 60_000 }), { outcome: 'refused', reason: 'WINDOW_CLOSED' });
    bump(w);
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    assert.deepEqual(await resume(w, witness, killed.requestId), { outcome: 'refused', reason: 'STALE_HEAD' });
    assert.equal(await authenticate(w, witness, w.operators['fv-operator-a'].device), 'fv-operator-a', 'never revoked by the stale request');
  });

  it('a finalize that never reached the witness: pending, never revoked; a resume confirms. A lost prepare answer: pending, then refused (CORE-07 pending recovery)', async () => {
    const { witness, w } = await world();
    const options = operatorOptions(w.world, witness);
    const first = revocationRequest(w);
    const pending = await revokeFvOperatorCredential({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'finalize', nth: 1, undelivered: true }) } }, first.request);
    assert.deepEqual([pending.outcome, pending.reason], ['pending', 'WITNESS_UNAVAILABLE']);
    assert.equal((await resume(w, witness, first.request.requestId)).outcome, 'revoked');
    w.operators['fv-operator-b'] = await enrolOperator(w, witness, 'fv-operator-b');
    const second = revocationRequest(w, { operatorId: 'fv-operator-b' });
    const lost = await revokeFvOperatorCredential({ ...options, witness: { ...options.witness, transport: losingTransport(witness, { operation: 'prepare', nth: 1 }) } }, second.request);
    assert.equal(lost.outcome, 'pending');
    assert.deepEqual(await resume(w, witness, second.request.requestId), { outcome: 'refused', reason: 'STORE_REFUSED', detail: 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' });
  });

  it('a rolled-back store never revives a revoked credential: the witness refuses it', async () => {
    const { witness, w } = await world();
    const before = readFileSync(w.world.paths.store);
    const { request } = revocationRequest(w);
    assert.equal((await revoke(w, witness, request)).outcome, 'revoked');
    writeFileSync(w.world.paths.store, before);
    const refused = await resume(w, witness, request.requestId);
    assert.deepEqual([refused.outcome, refused.reason, refused.detail], ['refused', 'STORE_REFUSED', 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED']);
    await assert.rejects(authenticate(w, witness, w.operators['fv-operator-a'].device), { code: 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' });
  });
});

describe('FV-P4C-2B3C-2A3A — a forged record never revokes, never restores', () => {
  it('a rewritten, deleted or forged-complete record: refused or ignored; the genuine evidence completes', async () => {
    const { witness, w } = await world();
    const { default: Database } = await import('better-sqlite3');
    const killed = await runRevocationChild(w, witness, { killAt: 'intent-recorded' });
    bump(w);
    const read = new Database(w.world.paths.record, { readonly: true });
    const original = read.prepare(`SELECT sequence, detail FROM fv_registration_events WHERE kind = 'operator-revocation-intent'`).get();
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
    const before = await length(w, witness);
    // Retargeted after signing, a reason rewritten: the administrator never signed those.
    for (const change of [{ target: { ...genuine.evidence.authorization.target, operatorId: 'fv-operator-z' } }, { reason: 'other' }]) {
      withTrigger('fv_registration_events_append_only_update', (db) => db.prepare('UPDATE fv_registration_events SET detail = ? WHERE sequence = ?').run(JSON.stringify({ ...genuine, evidence: { ...genuine.evidence, authorization: { ...genuine.evidence.authorization, ...change } } }), original.sequence));
      assert.equal((await resume(w, witness, killed.requestId)).outcome, 'refused');
    }
    // Deleted, then a forged completion and garbage: nothing to resume.
    withTrigger('fv_registration_events_append_only_delete', (db) => db.prepare('DELETE FROM fv_registration_events WHERE sequence = ?').run(original.sequence));
    const db = new Database(w.world.paths.record);
    db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'operator-credential-revoked', JSON.stringify({ requestId: killed.requestId }));
    db.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'operator-revocation-intent', '{not json');
    db.close();
    assert.deepEqual(await resume(w, witness, killed.requestId), { outcome: 'refused', reason: 'NO_REQUEST' });
    assert.equal(await length(w, witness), before);
    // Read-only (an authentication would itself advance the head and make the recorded authorization stale).
    assert.deepEqual([...(await withStore(w, witness, (store) => verifyFvCurrentOperators(store.history(), w.world.org, RP)))], ['fv-operator-a'], 'a forged completion revokes nothing');
    // Review L1: the genuine evidence filed under another request id completes nothing under that id.
    const otherId = newRevocationId();
    const copy = new Database(w.world.paths.record);
    copy.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'operator-revocation-intent', JSON.stringify({ ...genuine, requestId: otherId }));
    copy.close();
    assert.deepEqual(await resume(w, witness, otherId), { outcome: 'refused', reason: 'NO_REQUEST' });
    // Reconstructed: the genuine evidence completes.
    const again = new Database(w.world.paths.record);
    again.prepare('INSERT INTO fv_registration_events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'operator-revocation-intent', original.detail);
    again.close();
    const completed = await resume(w, witness, killed.requestId);
    assert.equal(completed.outcome, 'revoked', JSON.stringify(completed));
  });
});

describe('FV-P4C-2B3C-2A3A — real processes: one ceremony at a time', () => {
  it('a second revocation while one holds the record is REGISTRAR_BUSY; the first completes; the second, retried, finds the credential revoked', async () => {
    const { witness, w } = await world();
    const paused = await pausedRevocationChild(w, witness, { pauseAt: 'administrator-verified' });
    assert.deepEqual(await revoke(w, witness, revocationRequest(w).request), { outcome: 'refused', reason: 'REGISTRAR_BUSY' });
    paused.release();
    const done = await paused.done;
    assert.equal(done.outcome, 'revoked');
    adopt(w, done.adminState);
    bump(w);
    assert.deepEqual(await revoke(w, witness, revocationRequest(w).request), { outcome: 'refused', reason: 'ALREADY_REVOKED' });
  });
});

describe('FV-P4C-2B3C-2A3A — the ceremony writes only the store it holds', () => {
  it('the store file replaced under a paused ceremony: no revocation reaches the replacement or is reported; a resume refuses the substituted file', async () => {
    const { witness, w } = await world();
    const before = (await fvSlot(witness, w.world.org))[0];
    const paused = await pausedRevocationChild(w, witness, { pauseAt: 'intent-recorded' });
    const replacement = `${w.world.paths.store}.replacement`;
    copyFileSync(w.world.paths.store, replacement);
    renameSync(replacement, w.world.paths.store);
    paused.release();
    const outcome = await paused.done;
    assert.notEqual(outcome.outcome, 'revoked', JSON.stringify(outcome));
    assert.deepEqual((await fvSlot(witness, w.world.org))[0], before, 'nothing reached the witness');
    assert.equal((await resume(w, witness, outcome.requestId)).reason, 'STORE_FILE_MISMATCH');
  });
});

describe('FV-P4C-2B3C-2A3A — isolation: no ledger claim, no readiness', () => {
  it('a revocation touches no G-02A ledger claim, and the executor still executes nothing', async () => {
    const { witness, w } = await world();
    const ledgerRows = async () => {
      const ledger = await openExecutionCapabilityConsumptionLedger(w.world.paths.ledger, { audience: AUDIENCE, clock: () => Date.now() });
      try {
        return JSON.stringify(ledger.listUnresolved());
      } finally {
        ledger.close();
      }
    };
    const before = await ledgerRows();
    assert.equal((await revoke(w, witness, revocationRequest(w).request)).outcome, 'revoked');
    assert.equal(await ledgerRows(), before);
    const namespace = 'receiver:fv-b3c2a3a';
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
    void createHash;
  });
});
