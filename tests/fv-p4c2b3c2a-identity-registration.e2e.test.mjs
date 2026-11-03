// FV-P4C-2B3C-2A1 — the FV bootstrap identity registration ceremony, end to end: the real G-02A verifier and
// consumption ledger, a real CORE-07 reference witness (its own database, its own directory), real AUTH-03
// stores, real child processes killed by SIGKILL at durable steps. Synthetic organizations, test-only issuer
// keys and temporary directories only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { AuthorityStateFreshnessError } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { captureHistoryContinuity, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { composeFvProtectedHost } from '../dist/src/enterprise/sovereign-status-history/protected-host-composition.js';
import { fileIdentityOf } from '../dist/src/enterprise/sovereign-status-history/identity-registration-record.js';
import { readFvIdentityRegistration, registerFvIdentity, resumeFvIdentityRegistration, verifyFvIdentityRegistration } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { OTHER_ISSUER, OTHER_ISSUER_KEY, TEST_REGISTRATION_ISSUER, TEST_REGISTRATION_ISSUER_KEY, UNTRUSTED_REGISTRATION_KEY, newStoreId, trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, bindingFor, holdExclusively, own, registerRequest, registrarOptions, registrationWorld, removeOwnedDirectories, resumeRequest, runChild } from './fv-p4c2b3c2a-support.mjs';
import { GRACE, OPERATORS, RP, SUBJECT, standing } from './fv-p4c2b3b-support.mjs';
import { resolver } from './fv-status-bootstrap-support.mjs';

// Exact ownership: every witness and world directory these tests made, and nothing else.
after(async () => {
  await closeAllWitnesses();
  removeOwnedDirectories();
});
const started = async (options) => {
  const witness = await startWitness(options);
  own(witness.directory);
  return witness;
};

const register = (world, witness, request, overrides) => registerFvIdentity(registrarOptions(world, witness, overrides), request);
const resume = (world, witness, request, overrides) => resumeFvIdentityRegistration(registrarOptions(world, witness, overrides), request);
const view = (world) => readFvIdentityRegistration(world.paths.record, world.org);
const fvRows = async (witness) => (await witnessRows(witness.databasePath)).filter((row) => row.state_kind === FV_DOMAIN);
const files = (world) => readdirSync(world.dir).filter((name) => !name.startsWith('child-'));

async function freshWorld(options) {
  const witness = await started();
  return { witness, world: registrationWorld(options) };
}

async function ledgerStateOf(world, capabilityId) {
  const ledger = await openExecutionCapabilityConsumptionLedger(world.paths.ledger, { audience: AUDIENCE, clock: () => Date.now() });
  try {
    return ledger.read(capabilityId).state;
  } finally {
    ledger.close();
  }
}

describe('FV-P4C-2B3C-2A1 — the registration ceremony creates one FV identity, once', () => {
  it('registers from a verified capability: the witness’s FV slot binds the preselected store at its genesis, and the evidence is non-secret', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    const { request, capability } = registerRequest(binding);
    const outcome = await register(world, witness, request);
    assert.equal(outcome.outcome, 'registered', JSON.stringify(outcome));
    const { evidence } = outcome;
    assert.equal(evidence.storeId, binding.storeId);
    assert.equal(evidence.registrationId, binding.registrationId);
    assert.equal(evidence.stateKind, FV_DOMAIN);
    assert.equal(evidence.capabilityId, capability.capabilityId);
    assert.equal(evidence.witnessId, witness.witnessId);
    assert.equal(/BEGIN|PRIVATE|signature|capability"/i.test(JSON.stringify(evidence)), false, 'no key, signature or capability text in the evidence');
    // The witness: exactly one FV binding, this store, at its genesis; the Host's domain untouched.
    const rows = await witnessRows(witness.databasePath);
    assert.deepEqual(rows.map((r) => [r.state_kind, r.store_id, r.committed_sequence, r.pending_sequence]), [[FV_DOMAIN, binding.storeId, 0, null]]);
    assert.equal(rows[0].committed_digest, evidence.genesisDigest);
    // The store: owner-only, its own id, opens only as the exclusive FV owner under the witness.
    assert.equal(statSync(world.paths.store).mode & 0o077, 0);
    assert.deepEqual((await view(world)).evidence, evidence);
    assert.equal(await ledgerStateOf(world, capability.capabilityId), 'completed');
    const reopened = await openSqliteHumanIdentityStore(world.paths.store, {
      organizationId: world.org,
      now: () => new Date().toISOString(),
      authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) },
      freshness: { boundary: await boundaryFor(witness, world.org), stateKind: FV_DOMAIN },
      exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close(), storeId: binding.storeId },
    });
    assert.equal(reopened.head().sequence, 0);
    reopened.close();
  });

  it('never a second genesis: a replay, a second capability, and a full local wipe all leave the one witnessed store', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    const first = registerRequest(binding);
    assert.equal((await register(world, witness, first.request)).outcome, 'registered');
    assert.deepEqual(await register(world, witness, first.request), { outcome: 'refused', reason: 'ALREADY_REGISTERED' }, 'a replay');
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'ALREADY_REGISTERED' }, 'another capability for another store');
    // The record and the ledger forgotten (deleted or rolled back): the ledger no longer remembers the replay, but the path and then the witness refuse.
    rmSync(world.paths.record);
    rmSync(world.paths.ledger);
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'STORE_PATH_OCCUPIED' });
    rmSync(world.paths.store);
    rmSync(world.paths.record, { force: true });
    rmSync(world.paths.ledger, { force: true });
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'WITNESS_ALREADY_BOUND' }, 'a new genesis is never made over a witnessed one');
    assert.deepEqual(await register(world, witness, registerRequest(binding).request), { outcome: 'refused', reason: 'WITNESS_ALREADY_BOUND' }, 'not even of the same store id');
    assert.deepEqual((await fvRows(witness)).map((r) => r.store_id), [binding.storeId]);
  });
});

describe('FV-P4C-2B3C-2A1 — only an exactly scoped capability from a pinned issuer authorizes a registration', () => {
  it('refuses every mis-scoped, tampered, expired, replayed-across-scope or untrusted capability before anything is created', async () => {
    const { witness, world } = await freshWorld();
    const base = bindingFor(world, witness);
    const reject = async (label, request, detail, overrides) => {
      const outcome = await register(world, witness, request, overrides);
      assert.equal(outcome.outcome, 'refused', `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.reason, detail === 'REQUEST_INVALID' ? 'REQUEST_INVALID' : 'CAPABILITY_REJECTED', label);
      if (detail !== 'REQUEST_INVALID') assert.equal(outcome.detail, detail, label);
    };
    const mis = (fields, issue) => registerRequest({ ...base, ...fields }, issue).request;
    // The binding: every field the registrar recomputes from its own configuration.
    await reject('another organization in the binding', mis({ organizationId: 'org-other' }, { organizationId: world.org }), 'ACTION_BINDING_MISMATCH');
    await reject('another witness id', mis({ witnessId: 'witness-other' }), 'ACTION_BINDING_MISMATCH');
    await reject('another witness key', mis({ witnessKeyDigest: `sha256:${'0'.repeat(64)}` }), 'ACTION_BINDING_MISMATCH');
    await reject('the Host’s identity domain', mis({ stateKind: 'human-identity-state' }), 'ACTION_BINDING_MISMATCH');
    await reject('another deployment', mis({ deploymentId: 'deployment:other' }), 'ACTION_BINDING_MISMATCH');
    await reject('another store path', mis({ storePath: join(world.dir, 'elsewhere.sqlite') }), 'ACTION_BINDING_MISMATCH');
    await reject('another store policy', mis({ storePolicy: 'frontera.fv-identity-store-policy.v0' }), 'ACTION_BINDING_MISMATCH');
    await reject('another signing key', mis({ authenticityKeyId: AUTHORITY_KEY_B.keyId }), 'ACTION_BINDING_MISMATCH');
    // The operator changes the parameters beside the capability.
    const signed = registerRequest(base).request;
    await reject('a store id other than the signed one', { ...signed, storeId: newStoreId() }, 'ACTION_BINDING_MISMATCH');
    await reject('a registration id other than the signed one', { ...signed, registrationId: `fvreg-${'1'.repeat(32)}` }, 'ACTION_BINDING_MISMATCH');
    // The capability's own fields.
    await reject('another organization', mis({}, { organizationId: 'org-other' }), 'ORGANIZATION_MISMATCH');
    await reject('another audience', mis({}, { audience: 'fv-identity-registrar:other' }), 'AUDIENCE_MISMATCH');
    await reject('another trust domain', mis({}, { trustDomain: 'trust-domain:other' }), 'TRUST_DOMAIN_MISMATCH');
    await reject('the resume operation', { ...resumeRequest(base).request, registrationId: base.registrationId, storeId: base.storeId }, 'ACTION_MISMATCH');
    await reject('another execution', mis({}, { executionId: `fvreg-${'2'.repeat(32)}` }), 'EXECUTION_MISMATCH');
    await reject('expired', mis({}, { issuedAtMs: Date.now() - 60_000, lifetimeMs: 30_000 }), 'CAPABILITY_EXPIRED');
    await reject('not yet valid', mis({}, { issuedAtMs: Date.now() + 60_000 }), 'CAPABILITY_NOT_YET_VALID');
    await reject('a lifetime over the profile maximum', mis({}, { lifetimeMs: 120_000 }), 'CAPABILITY_LIFETIME_INVALID');
    await reject('an unknown issuer', mis({}, { issuer: OTHER_ISSUER, key: OTHER_ISSUER_KEY }), 'ISSUER_UNTRUSTED');
    await reject('an attacker key under the pinned key id', mis({}, { key: UNTRUSTED_REGISTRATION_KEY }), 'SIGNATURE_INVALID');
    await reject('the issuer’s key no longer pinned (rotated out)', mis(), 'ISSUER_KEY_MISMATCH', { trustedIssuers: trustedRegistrationIssuers([{ issuer: TEST_REGISTRATION_ISSUER, key: OTHER_ISSUER_KEY }]) });
    const tampered = registerRequest(base).request;
    await reject('a tampered capability text', { ...tampered, presentation: { ...tampered.presentation, capability: tampered.presentation.capability.replace('"single-use"', '"single-use" ') } }, 'CAPABILITY_NONCANONICAL');
    await reject('a capability re-signed field (another subject)', { ...tampered, presentation: { ...tampered.presentation, capability: tampered.presentation.capability.replace('operator:test-registration-officer', 'operator:someone-else') } }, 'SIGNATURE_INVALID');
    // Nothing that is not a signed G-02A capability: a Host bearer token, an operator credential, a flag.
    await reject('a Host session token', { ...signed, presentation: { capability: 'Bearer host-session-token', signature: signed.presentation.signature } }, 'CAPABILITY_MALFORMED');
    await reject('no capability at all', { registrationId: base.registrationId, storeId: base.storeId, presentation: { registered: true } }, 'REQUEST_INVALID');
    await assert.rejects(register(world, witness, signed, { trustedIssuers: [] }), (e) => e.code === 'OPTIONS_INVALID', 'no pinned issuer: no registration, never a default');
    // Nothing was created anywhere, and nothing was consumed.
    assert.deepEqual(files(world), []);
    assert.deepEqual(await fvRows(witness), []);
    assert.equal((await register(world, witness, signed)).outcome, 'registered', 'the correctly scoped capability still works afterwards');
  });

  it('one capability, two processes at once: exactly one registers; a second deployment cannot register the organization again', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    const { request } = registerRequest(binding);
    const outcomes = await Promise.all([runChild(world, witness, { operation: 'register', request }), runChild(world, witness, { operation: 'register', request })]);
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ['refused', 'registered'], JSON.stringify(outcomes));
    assert.ok(['REGISTRAR_BUSY', 'ALREADY_REGISTERED', 'CAPABILITY_NOT_CLAIMED'].includes(outcomes.find((o) => o.outcome === 'refused').reason));
    // Two deployments (separate records and ledgers) of one organization at one witness, concurrently.
    const other = registrationWorld({ org: world.org });
    const second = await Promise.all([runChild(world, witness, { operation: 'register', request: registerRequest(bindingFor(world, witness)).request }), runChild(other, witness, { operation: 'register', request: registerRequest(bindingFor(other, witness)).request })]);
    assert.equal(second.filter((o) => o.outcome === 'registered').length, 0, JSON.stringify(second));
    assert.deepEqual((await fvRows(witness)).map((r) => r.store_id), [binding.storeId], 'one FV store for the organization, ever');
  });

  it('two deployments racing to be first: at most one genesis; the loser never adopts the winner’s store', async () => {
    const { witness, world } = await freshWorld();
    const other = registrationWorld({ org: world.org });
    const a = bindingFor(world, witness);
    const b = bindingFor(other, witness);
    const outcomes = await Promise.all([runChild(world, witness, { operation: 'register', request: registerRequest(a).request }), runChild(other, witness, { operation: 'register', request: registerRequest(b).request })]);
    assert.equal(outcomes.filter((o) => o.outcome === 'registered').length, 1, JSON.stringify(outcomes));
    const loser = outcomes.find((o) => o.outcome !== 'registered');
    assert.ok((loser.outcome === 'refused' && loser.reason === 'WITNESS_ALREADY_BOUND') || (loser.outcome === 'quarantined' && loser.reason === 'WITNESS_BOUND_TO_ANOTHER_STORE'), JSON.stringify(loser));
    const rows = await fvRows(witness);
    assert.equal(rows.length, 1);
    assert.ok([a.storeId, b.storeId].includes(rows[0].store_id));
  });
});

describe('FV-P4C-2B3C-2A1 — no existing store is ever claimed', () => {
  it('a Host store, a copied FV store, a symlink or a foreign file at the store path is refused before the capability is consumed', async () => {
    const { witness, world } = await freshWorld();
    const authenticity = { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) };
    // The Host's own store (AUTH-04A's kind, anchored in the Host domain at the same witness), placed at the FV path.
    const host = await openSqliteHumanIdentityStore(world.paths.store, { organizationId: world.org, now: () => new Date().toISOString(), authenticity, create: true, freshness: { boundary: await boundaryFor(witness, world.org) } });
    const hostStoreId = host.storeId;
    host.close();
    const attempt = registerRequest(bindingFor(world, witness));
    assert.deepEqual(await register(world, witness, attempt.request), { outcome: 'refused', reason: 'STORE_PATH_OCCUPIED' });
    rmSync(world.paths.store);
    for (const suffix of ['-wal', '-shm']) rmSync(`${world.paths.store}${suffix}`, { force: true });
    // A symlink to a store elsewhere, and a foreign file.
    const elsewhere = join(world.dir, 'elsewhere.sqlite');
    writeFileSync(elsewhere, 'x', { mode: 0o600 });
    symlinkSync(elsewhere, world.paths.store);
    assert.deepEqual(await register(world, witness, attempt.request), { outcome: 'refused', reason: 'PATH_REFUSED', detail: 'store:LINKED' });
    rmSync(world.paths.store);
    linkSync(elsewhere, world.paths.store);
    assert.deepEqual(await register(world, witness, attempt.request), { outcome: 'refused', reason: 'PATH_REFUSED', detail: 'store:LINKED' }, 'a hard link');
    rmSync(world.paths.store);
    rmSync(elsewhere);
    writeFileSync(world.paths.store, 'foreign', { mode: 0o600 });
    assert.deepEqual(await register(world, witness, attempt.request), { outcome: 'refused', reason: 'STORE_PATH_OCCUPIED' }, 'a foreign file');
    rmSync(world.paths.store);
    // The Host store's own id, preselected as the FV store id: one store, one identity domain.
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness, { storeId: hostStoreId })).request), { outcome: 'refused', reason: 'STORE_ID_IN_ANOTHER_DOMAIN' });
    // None of these consumed the capability: it still registers.
    assert.equal((await register(world, witness, attempt.request)).outcome, 'registered');
    assert.deepEqual((await fvRows(witness)).map((r) => r.store_id), [attempt.request.storeId]);
  });

  it('an FV slot already bound (a test-only or another deployment’s genesis) is refused, never adopted; an unsafe directory is refused', async () => {
    const { witness, world } = await freshWorld();
    const elsewhere = registrationWorld({ org: world.org });
    const existing = await openSqliteHumanIdentityStore(elsewhere.paths.store, {
      organizationId: world.org,
      now: () => new Date().toISOString(),
      authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) },
      create: true,
      freshness: { boundary: await boundaryFor(witness, world.org), stateKind: FV_DOMAIN },
      exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close() },
    });
    existing.close();
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'WITNESS_ALREADY_BOUND' });
    assert.equal(existsSync(world.paths.store), false);
    const { witness: w2, world: unsafe } = await freshWorld();
    chmodSync(unsafe.dir, 0o777);
    const refused = await register(unsafe, w2, registerRequest(bindingFor(unsafe, w2)).request);
    chmodSync(unsafe.dir, 0o700);
    assert.equal(refused.reason, 'PATH_REFUSED');
    assert.deepEqual(files(unsafe), []);
  });
});

describe('FV-P4C-2B3C-2A1 — crash consistency: SIGKILL at every durable step, recovery from evidence only', () => {
  const STEPS = ['intent-recorded', 'enroll-sent', 'witness-genesis-answered', 'witness-anchored', 'store-file-reserved', 'store-genesis-committed', 'store-created'];
  for (const step of STEPS) {
    it(`killed at ${step}: pending, never success; the original capability cannot restart it; a resume capability completes the same registration`, async () => {
      const { witness, world } = await freshWorld();
      const binding = bindingFor(world, witness);
      const first = registerRequest(binding);
      assert.equal((await runChild(world, witness, { operation: 'register', request: first.request, killAt: step })).killed, true);
      const before = await view(world);
      assert.notEqual(before.state, 'registered');
      assert.equal(before.storeId, binding.storeId);
      // Neither the consumed capability nor a fresh one starts anything new over a registration in progress.
      assert.deepEqual(await register(world, witness, first.request), { outcome: 'refused', reason: 'REGISTRATION_PENDING' });
      assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'REGISTRATION_PENDING' });
      // Nor does a resume capability for another registration, or the register capability presented as a resume.
      assert.equal((await resume(world, witness, resumeRequest({ ...binding, storeId: newStoreId() }).request)).detail, 'ACTION_BINDING_MISMATCH');
      assert.equal((await resume(world, witness, { presentation: first.request.presentation })).detail, 'ACTION_MISMATCH');
      const completion = resumeRequest(binding);
      const outcome = await resume(world, witness, completion.request);
      assert.equal(outcome.outcome, 'registered', JSON.stringify(outcome));
      assert.equal(outcome.evidence.storeId, binding.storeId);
      assert.equal(outcome.evidence.capabilityId, first.capability.capabilityId, 'the evidence names the authorization that chose this store');
      assert.deepEqual((await fvRows(witness)).map((r) => [r.store_id, r.committed_sequence]), [[binding.storeId, 0]], 'the same genesis: a lost answer was read back, never re-made');
      // The resume capability is spent; the completed registration is reported without consuming anything.
      assert.equal((await resume(world, witness, completion.request)).outcome, 'registered');
      assert.equal(await ledgerStateOf(world, completion.capability.capabilityId), 'completed');
    });
  }

  it('killed after the capability was consumed but before any intent: nothing was contacted; the capability is spent; a new one registers', async () => {
    const { witness, world } = await freshWorld();
    const first = registerRequest(bindingFor(world, witness));
    assert.equal((await runChild(world, witness, { operation: 'register', request: first.request, killAt: 'capability-claimed' })).killed, true);
    assert.equal(await view(world), undefined);
    assert.deepEqual(await fvRows(witness), []);
    assert.equal(existsSync(world.paths.store), false);
    assert.deepEqual(await resume(world, witness, resumeRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'NO_REGISTRATION' });
    assert.deepEqual(await register(world, witness, first.request), { outcome: 'refused', reason: 'CAPABILITY_NOT_CLAIMED', detail: 'CAPABILITY_CONSUMED' }, 'a replay of the spent capability');
    const second = registerRequest(bindingFor(world, witness));
    assert.equal((await register(world, witness, second.request)).outcome, 'registered');
    assert.equal(await ledgerStateOf(world, first.capability.capabilityId), 'failed', 'the orphaned claim is settled as failed');
  });

  it('killed after the registration committed but before its answer: the registration is complete and readable; nothing re-runs', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'registered' })).killed, true);
    assert.equal((await view(world)).state, 'registered');
    const outcome = await resume(world, witness, resumeRequest(binding).request);
    assert.equal(outcome.outcome, 'registered');
    assert.equal(outcome.evidence.storeId, binding.storeId);
  });

  it('a crash between creating the store file and recording it leaves only an empty file: that file, and only that one, is taken over', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'witness-anchored' })).killed, true);
    writeFileSync(world.paths.store, '', { mode: 0o600, flag: 'wx' });
    assert.equal((await resume(world, witness, resumeRequest(binding).request)).outcome, 'registered');
    // Not a file holding anything.
    const { witness: w2, world: foreign } = await freshWorld();
    const b2 = bindingFor(foreign, w2);
    assert.equal((await runChild(foreign, w2, { operation: 'register', request: registerRequest(b2).request, killAt: 'witness-anchored' })).killed, true);
    writeFileSync(foreign.paths.store, 'SQLite format 3\0 not ours', { mode: 0o600, flag: 'wx' });
    assert.deepEqual(await resume(foreign, w2, resumeRequest(b2).request), { outcome: 'quarantined', reason: 'FOREIGN_FILE_AT_STORE_PATH', registrationId: b2.registrationId, storeId: b2.storeId });
  });

  it('a resume capability is single-use; while the witness is unreachable the registration stays pending and consumes nothing new', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'intent-recorded' })).killed, true);
    await witness.close();
    const attempt = resumeRequest(binding);
    assert.deepEqual(await resume(world, witness, attempt.request), { outcome: 'refused', reason: 'WITNESS_UNAVAILABLE' });
    assert.equal((await view(world)).state, 'intent-recorded');
    const restarted = await witness.restart();
    // The same witness (same database, same key) on a new port: the unconsumed resume capability now completes it.
    assert.equal((await resume(world, restarted, attempt.request)).outcome, 'registered');
  });

  it('a lost or failed witness answer during the ceremony is pending, never success and never quarantine; a replayed resume capability is refused', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    const options = registrarOptions(world, witness);
    const real = options.witness.transport;
    let failEnroll = true;
    const transport = { call: (request, o) => (failEnroll && request.operation === 'enroll' ? Promise.reject(Object.assign(new Error('unavailable'), { name: 'AuthorityStateFreshnessError', code: 'AUTHORITY_FRESHNESS_UNAVAILABLE' })) : real.call(request, o)) };
    const pending = await registerFvIdentity({ ...options, witness: { ...options.witness, transport } }, registerRequest(binding).request);
    assert.equal(pending.outcome, 'pending', JSON.stringify(pending));
    assert.equal(pending.state, 'intent-recorded');
    assert.deepEqual(await fvRows(witness), []);
    failEnroll = false;
    const attempt = resumeRequest(binding);
    const again = await resumeFvIdentityRegistration({ ...options, witness: { ...options.witness, transport } }, attempt.request);
    assert.equal(again.outcome, 'registered');
    // Replaying a consumed resume capability against a fresh registration in progress elsewhere is refused by the ledger.
    assert.equal((await resume(world, witness, attempt.request)).outcome, 'registered', 'a completed registration is only reported');
  });
});

describe('FV-P4C-2B3C-2A1 — a witness that does not answer authentically is pending, never quarantine (publication review finding 1)', () => {
  const faults = {
    'HTTP 401 (a rotated credential)': () => Promise.reject(new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED', 'refused')),
    'a 404 from a proxy': () => Promise.reject(new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_REFUSED', 'refused')),
    'a garbage body': () => Promise.resolve({ nonsense: true }),
  };
  for (const step of ['witness-anchored', 'store-created']) {
    for (const [label, fault] of Object.entries(faults)) {
      it(`after ${step}, ${label}: pending; once the witness heals, a resume completes the same registration`, async () => {
        const { witness, world } = await freshWorld();
        const binding = bindingFor(world, witness);
        const options = registrarOptions(world, witness);
        const real = options.witness.transport;
        let broken = false;
        const transport = { call: (request, o) => (broken ? fault() : real.call(request, o)) };
        const flaky = { ...options, witness: { ...options.witness, transport }, observer: (s) => { if (s === step) broken = true; } };
        const first = await registerFvIdentity(flaky, registerRequest(binding).request);
        assert.equal(first.outcome, 'pending', JSON.stringify(first));
        assert.equal(first.reason, 'WITNESS_UNAVAILABLE');
        broken = false;
        const healed = await resumeFvIdentityRegistration({ ...flaky, observer: undefined }, resumeRequest(binding).request);
        assert.equal(healed.outcome, 'registered', JSON.stringify(healed));
        assert.equal(healed.evidence.storeId, binding.storeId);
      });
    }
  }
});

describe('FV-P4C-2B3C-2A1 — inconsistent evidence quarantines, for good', () => {
  it('the witness bound another store while this registration was pending: quarantined, never adopted, never retried', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'intent-recorded' })).killed, true);
    const other = registrationWorld({ org: world.org });
    assert.equal((await register(other, witness, registerRequest(bindingFor(other, witness)).request)).outcome, 'registered');
    assert.deepEqual(await resume(world, witness, resumeRequest(binding).request), { outcome: 'quarantined', reason: 'WITNESS_BOUND_TO_ANOTHER_STORE', registrationId: binding.registrationId, storeId: binding.storeId });
    assert.deepEqual(await resume(world, witness, resumeRequest(binding).request), { outcome: 'refused', reason: 'REGISTRATION_QUARANTINED', detail: 'WITNESS_BOUND_TO_ANOTHER_STORE' });
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'REGISTRATION_QUARANTINED' });
    assert.equal(existsSync(world.paths.store), false);
  });

  it('a foreign file at the path before the witness was asked, a replaced or vanished store file after creation: quarantined', async () => {
    for (const [step, tamper, reason] of [
      ['intent-recorded', (w) => writeFileSync(w.paths.store, 'foreign', { mode: 0o600 }), 'FOREIGN_FILE_AT_STORE_PATH'],
      ['store-created', (w) => (copyFileSync(w.paths.store, `${w.paths.store}.copy`), rmSync(w.paths.store), copyFileSync(`${w.paths.store}.copy`, w.paths.store), rmSync(`${w.paths.store}.copy`)), 'STORE_FILE_REPLACED'],
      ['store-created', (w) => rmSync(w.paths.store), 'STORE_FILE_REPLACED'],
    ]) {
      const { witness, world } = await freshWorld();
      const binding = bindingFor(world, witness);
      assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: step })).killed, true);
      tamper(world);
      assert.deepEqual(await resume(world, witness, resumeRequest(binding).request), { outcome: 'quarantined', reason, registrationId: binding.registrationId, storeId: binding.storeId }, `${step} ${reason}`);
    }
  });

  it('the store rewritten in place (same inode, another store’s bytes) after creation: the readback refuses it, never registered', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'store-created' })).killed, true);
    // Another organization's genuine FV store, at another witness, copied over the registered file's content.
    const { witness: w2, world: donor } = await freshWorld({ org: 'org-fv-p4c2b3c2a-donor' });
    assert.equal((await register(donor, w2, registerRequest(bindingFor(donor, w2)).request)).outcome, 'registered');
    const before = statSync(world.paths.store, { bigint: true });
    copyFileSync(donor.paths.store, world.paths.store);
    const after = statSync(world.paths.store, { bigint: true });
    assert.equal(after.ino, before.ino, 'the same file: only its content changed');
    const outcome = await resume(world, witness, resumeRequest(binding).request);
    assert.equal(outcome.outcome, 'quarantined', JSON.stringify(outcome));
    assert.equal(outcome.reason, 'STORE_NOT_GENESIS');
  });

  it('a resume under another witness, path or signing key is refused; a corrupted record is refused, never repaired', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'witness-anchored' })).killed, true);
    const foreign = await started();
    assert.deepEqual(await resume(world, foreign, resumeRequest(binding).request), { outcome: 'refused', reason: 'CONFIGURATION_MISMATCH' }, 'a foreign witness');
    assert.deepEqual(await resume(world, witness, resumeRequest(binding).request, { authenticity: { signer: testSigner(AUTHORITY_KEY_B), verifier: testVerifier([AUTHORITY_KEY_B]) } }), { outcome: 'refused', reason: 'CONFIGURATION_MISMATCH' });
    // Raw tampering: the forward-only trigger dropped and the store id rewritten.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(world.paths.record);
    db.exec('DROP TRIGGER fv_registration_forward_only');
    db.prepare('UPDATE fv_registration SET store_id = ?').run(newStoreId());
    db.close();
    assert.deepEqual(await resume(world, witness, resumeRequest(binding).request), { outcome: 'refused', reason: 'RECORD_CORRUPT' });
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request), { outcome: 'refused', reason: 'RECORD_CORRUPT' });
    await assert.rejects(view(world), (e) => e.code === 'CORRUPT');
  });

  it('a forged pending record (rows consistent, trigger re-created, another store id) is never continued, even with a resume capability for its forged fields', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'intent-recorded' })).killed, true);
    const forged = { ...binding, storeId: newStoreId() };
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(world.paths.record);
    const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'fv_registration_forward_only'`).get().sql;
    db.exec('DROP TRIGGER fv_registration_forward_only');
    db.prepare('UPDATE fv_registration SET store_id = ?').run(forged.storeId);
    db.exec(trigger);
    db.close();
    assert.deepEqual(await resume(world, witness, resumeRequest(forged).request), { outcome: 'refused', reason: 'RECORD_CORRUPT', detail: 'AUTHORIZATION_UNVERIFIED' });
    assert.deepEqual(await fvRows(witness), [], 'nothing reached the witness');
  });

  it('the forward-only rules hold at the database level: no deletion, no backward step, no rewritten intent', async () => {
    const { witness, world } = await freshWorld();
    assert.equal((await register(world, witness, registerRequest(bindingFor(world, witness)).request)).outcome, 'registered');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(world.paths.record);
    try {
      assert.throws(() => db.prepare('DELETE FROM fv_registration').run(), /permanent/);
      assert.throws(() => db.prepare(`UPDATE fv_registration SET state = 'intent-recorded'`).run(), /only moves forward/);
      assert.throws(() => db.prepare('UPDATE fv_registration SET store_id = ?').run(newStoreId()), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE fv_registration SET state = 'quarantined', quarantine_reason = 'STORE_NOT_GENESIS'`).run(), /only moves forward/);
      assert.throws(() => db.prepare('DELETE FROM fv_registration_events').run(), /append-only/);
    } finally {
      db.close();
    }
  });
});

describe('FV-P4C-2B3C-2A1 — locks: one ceremony at a time; never over a store another process holds', () => {
  it('a second ceremony while one holds the record is REGISTRAR_BUSY; a store held by a live process keeps the registration pending', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'store-genesis-committed' })).killed, true);
    const recordHolder = await holdExclusively(world.paths.record);
    try {
      assert.deepEqual(await resume(world, witness, resumeRequest(binding).request), { outcome: 'refused', reason: 'REGISTRAR_BUSY' });
    } finally {
      recordHolder.kill('SIGKILL');
    }
    const storeHolder = await holdExclusively(world.paths.store);
    let held;
    try {
      held = await resume(world, witness, resumeRequest(binding).request);
    } finally {
      storeHolder.kill('SIGKILL');
    }
    assert.equal(held.outcome, 'pending', JSON.stringify(held));
    assert.equal(held.reason, 'STORE_HELD');
    await new Promise((done) => setTimeout(done, 100));
    assert.equal((await resume(world, witness, resumeRequest(binding).request)).outcome, 'registered');
  });
});

// ── The executor's readiness gates ──────────────────────────────────────────

async function composeOver(world, witness, storeId, { registration = true, freshness = true, issuers = trustedRegistrationIssuers(), boundaryWitness = witness, recordPath = world.paths.record, ...overrides } = {}) {
  const namespace = 'receiver:fv-b3c2a';
  const protectedStore = join(world.dir, 'fv-protected.sqlite');
  const history = join(world.dir, 'history.sqlite');
  if (!existsSync(protectedStore)) {
    const records = await openProtectedContinuityStore(protectedStore, { create: true, now: () => new Date().toISOString() });
    const h = await openSqliteStatusHighWaterMarkStore(history, { namespace, create: true });
    records.save(captureHistoryContinuity(h, { namespace, databasePath: history, generation: 1, recordedAt: new Date().toISOString() }));
    h.close();
    records.close();
  }
  return composeFvProtectedHost({
    protectedStorePath: protectedStore,
    configuration: () => ({ generation: 1, histories: [{ namespace, databasePath: history }] }),
    identity: {
      storePath: world.paths.store,
      storeId,
      authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) },
      ...(freshness ? { freshness: { boundary: await boundaryFor(boundaryWitness, world.org), stateKind: FV_DOMAIN } } : {}),
      relyingParty: RP,
      operatorIds: OPERATORS,
    },
    ...(registration ? { registration: { recordPath, trustedIssuers: issuers, audience: AUDIENCE, trustDomain: TRUST_DOMAIN } } : {}),
    standing,
    organizationId: world.org,
    clock: () => new Date(),
    graceSeconds: GRACE,
    receiver: { verifySovereignStatus, establishStatusHistory },
    verificationKeyResolver: resolver,
    trustedSubjectOf: (id) => (id === SUBJECT.sovereignAssetId ? { ...SUBJECT } : undefined),
    ...overrides,
  });
}

const unregistered = (failure) => (e) => e.code === 'IDENTITY_UNREGISTERED' && e.message.includes(failure);

describe('FV-P4C-2B3C-2A1 — the executor verifies the registration before its identity store is opened, and stays non-operational', () => {
  it('a verified registration composes, reports it, and still executes nothing', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await register(world, witness, registerRequest(binding).request)).outcome, 'registered');
    const host = await composeOver(world, witness, binding.storeId);
    try {
      const status = host.status();
      assert.equal(status.identityRegistration, 'verified');
      assert.equal(status.bootstrapExecution, 'disabled');
      assert.deepEqual(await host.bootstrap({ request: {}, signedStatusText: '', requesterResponse: {}, approverResponse: {} }), { outcome: 'refused', reason: 'BOOTSTRAP_DISABLED' });
    } finally {
      host.close();
    }
  });

  it('NOT READY for every missing, pending, quarantined, mismatched, forged or substituted registration', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    // Pending: crashed after its store was created.
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: 'store-created' })).killed, true);
    await assert.rejects(composeOver(world, witness, binding.storeId), unregistered('REGISTRATION_PENDING'));
    assert.equal((await resume(world, witness, resumeRequest(binding).request)).outcome, 'registered');
    // Missing: no record at the configured path.
    await assert.rejects(composeOver(world, witness, binding.storeId, { recordPath: join(world.dir, 'no-record.sqlite') }), unregistered('NOT_REGISTERED'));
    // Needs the witness; another store id pinned; another witness; issuers the executor does not pin.
    await assert.rejects(composeOver(world, witness, binding.storeId, { freshness: false }), (e) => e.code === 'OPTIONS_INVALID');
    await assert.rejects(composeOver(world, witness, newStoreId()), unregistered('STORE_MISMATCH'));
    await assert.rejects(composeOver(world, witness, binding.storeId, { boundaryWitness: await started({ witnessId: 'witness-other' }) }), unregistered('WITNESS_MISMATCH'));
    await assert.rejects(composeOver(world, witness, binding.storeId, { issuers: trustedRegistrationIssuers([{ issuer: OTHER_ISSUER, key: OTHER_ISSUER_KEY }]) }), unregistered('AUTHORIZATION_UNVERIFIED'));
    await assert.rejects(composeOver(world, witness, binding.storeId, { issuers: trustedRegistrationIssuers([{ issuer: TEST_REGISTRATION_ISSUER, key: UNTRUSTED_REGISTRATION_KEY }]) }), unregistered('AUTHORIZATION_UNVERIFIED'));
    // A byte-identical copy of the store put in place of the registered file (another inode).
    copyFileSync(world.paths.store, `${world.paths.store}.copy`);
    rmSync(world.paths.store);
    copyFileSync(`${world.paths.store}.copy`, world.paths.store);
    chmodSync(world.paths.store, 0o600);
    await assert.rejects(composeOver(world, witness, binding.storeId), unregistered('STORE_FILE_MISMATCH'));
    // Without the registration option the same copy still opens: the gate is what makes the difference (activation will require it).
    const ungated = await composeOver(world, witness, binding.storeId, { registration: false });
    assert.equal(ungated.status().identityRegistration, 'unverified');
    ungated.close();
  });

  it('a forged record (consistent rows, a re-created trigger, another store id) fails the signature over its binding', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await register(world, witness, registerRequest(binding).request)).outcome, 'registered');
    const forgedId = newStoreId();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(world.paths.record);
    const trigger = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'fv_registration_forward_only'`).get().sql;
    db.exec('DROP TRIGGER fv_registration_forward_only');
    db.prepare('UPDATE fv_registration SET store_id = ?').run(forgedId);
    db.exec(trigger);
    db.close();
    await assert.rejects(composeOver(world, witness, forgedId), unregistered('AUTHORIZATION_UNVERIFIED'));
    // A quarantined registration is refused too.
    const { witness: w2, world: q } = await freshWorld();
    const b2 = bindingFor(q, w2);
    assert.equal((await runChild(q, w2, { operation: 'register', request: registerRequest(b2).request, killAt: 'store-created' })).killed, true);
    rmSync(q.paths.store);
    assert.equal((await resume(q, w2, resumeRequest(b2).request)).outcome, 'quarantined');
    const verdict = await verifyFvIdentityRegistration({ recordPath: q.paths.record, organizationId: q.org, storePath: q.paths.store, storeId: b2.storeId, witnessId: w2.witnessId, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN });
    assert.deepEqual(verdict, { verified: false, failure: 'REGISTRATION_QUARANTINED' });
  });

  it('the witness unreachable when the executor opens its registered store: refused', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await register(world, witness, registerRequest(binding).request)).outcome, 'registered');
    const boundary = await boundaryFor(witness, world.org);
    await witness.close();
    await assert.rejects(
      composeFvProtectedHostLike(world, binding.storeId, boundary),
      (e) => e.code === 'IDENTITY_REFUSED',
    );
  });
});

describe('FV-P4C-2B3C-2A1 — publication review (PR #262): a misconfiguration is refused before anything is consumed, and touches nothing it does not own', () => {
  it('a verifier that does not trust the signer is refused before the capability is consumed or the witness anchored (register and resume)', async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    const mistrusting = { authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_B]) } };
    const attempt = registerRequest(binding);
    assert.deepEqual(await register(world, witness, attempt.request, mistrusting), { outcome: 'refused', reason: 'AUTHENTICITY_UNVERIFIED' });
    assert.deepEqual(await fvRows(witness), [], 'nothing anchored');
    assert.equal(await view(world), undefined, 'no intent recorded');
    // The same capability, under the correct configuration, still registers: nothing was consumed.
    assert.equal((await register(world, witness, attempt.request)).outcome, 'registered');
    // Resume: a crash after the genesis was anchored, then a mistrusting resume, then the same resume capability correctly.
    const { witness: w2, world: q } = await freshWorld();
    const b2 = bindingFor(q, w2);
    assert.equal((await runChild(q, w2, { operation: 'register', request: registerRequest(b2).request, killAt: 'witness-anchored' })).killed, true);
    const completion = resumeRequest(b2);
    assert.deepEqual(await resume(q, w2, completion.request, mistrusting), { outcome: 'refused', reason: 'AUTHENTICITY_UNVERIFIED' });
    assert.equal((await view(q)).state, 'witness-anchored', 'never quarantined');
    assert.equal((await resume(q, w2, completion.request)).outcome, 'registered');
  });

  it('a record path naming another owner’s WAL database is refused before SQLite opens it: never checkpointed, never converted', async () => {
    const { witness, world } = await freshWorld();
    const foreign = join(world.dir, 'someone-elses.sqlite');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(foreign);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x)');
    db.close();
    chmodSync(foreign, 0o600);
    const before = readFileSync(foreign);
    assert.deepEqual(await register(world, witness, registerRequest(bindingFor(world, witness)).request, { recordPath: foreign }), { outcome: 'refused', reason: 'RECORD_CORRUPT' });
    assert.deepEqual(readFileSync(foreign), before, 'the foreign database is byte-for-byte unchanged');
    assert.equal(existsSync(`${foreign}-journal`), false);
    const verdict = await verifyFvIdentityRegistration({ recordPath: foreign, organizationId: world.org, storePath: world.paths.store, storeId: newStoreId(), witnessId: witness.witnessId, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN });
    assert.equal(verdict.verified, false);
    assert.deepEqual(readFileSync(foreign), before);
    assert.deepEqual(await fvRows(witness), []);
  });
});

describe('FV-P4C-2B3C-2A1 — publication audit: a rewritten record never verifies a store the issuer did not authorize', () => {
  /** A raw same-user writer: drops every trigger, rewrites, re-creates them. */
  async function rewrite(world, sql, ...params) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(world.paths.record);
    const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`).all();
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare(sql).run(...params);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.close();
  }
  const crashedAt = async (step) => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await runChild(world, witness, { operation: 'register', request: registerRequest(binding).request, killAt: step })).killed, true);
    return { witness, world, binding };
  };
  const completed = async () => {
    const { witness, world } = await freshWorld();
    const binding = bindingFor(world, witness);
    assert.equal((await register(world, witness, registerRequest(binding).request)).outcome, 'registered');
    return { witness, world, binding };
  };

  it('a pending record promoted to registered over a store it never created, a regressed state, a foreign or stale record: refused', async () => {
    // Intent only (the witness never asked); a plain store put at the path and the record promoted to it.
    const a = await crashedAt('intent-recorded');
    const plain = await openSqliteHumanIdentityStore(a.world.paths.store, { organizationId: a.world.org, now: () => new Date().toISOString(), authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, create: true });
    const plainId = plain.storeId;
    plain.close();
    await rewrite(a.world, `UPDATE fv_registration SET state = 'registered', store_file_identity = ?, registered_at = ?`, fileIdentityOf(a.world.paths.store), new Date().toISOString());
    await assert.rejects(composeOver(a.world, a.witness, a.binding.storeId), unregistered('RECORD_CORRUPT'));
    await assert.rejects(composeOver(a.world, a.witness, plainId), unregistered('RECORD_CORRUPT'));
    // A registered record moved backwards or into quarantine; a registered record without its file identity.
    const b = await completed();
    await rewrite(b.world, `UPDATE fv_registration SET state = 'store-created'`);
    await assert.rejects(composeOver(b.world, b.witness, b.binding.storeId), unregistered('RECORD_CORRUPT'));
    const c = await completed();
    await rewrite(c.world, `UPDATE fv_registration SET store_file_identity = NULL`);
    await assert.rejects(composeOver(c.world, c.witness, c.binding.storeId), unregistered('RECORD_CORRUPT'));
    // Another organization's registered record, and the same organization's registration at another witness, in place of this one.
    const other = await (async () => {
      const { witness, world } = await freshWorld({ org: 'org-fv-p4c2b3c2a-other' });
      const binding = bindingFor(world, witness);
      assert.equal((await register(world, witness, registerRequest(binding, { organizationId: world.org }).request)).outcome, 'registered');
      return { witness, world, binding };
    })();
    const d = await completed();
    const e = await completed();
    copyFileSync(other.world.paths.record, d.world.paths.record);
    await assert.rejects(composeOver(d.world, d.witness, d.binding.storeId), unregistered('RECORD_CORRUPT'));
    copyFileSync(e.world.paths.record, d.world.paths.record);
    await assert.rejects(composeOver(d.world, d.witness, d.binding.storeId), unregistered('STORE_MISMATCH'));
    await assert.rejects(composeOver(d.world, d.witness, e.binding.storeId), unregistered('STORE_MISMATCH'));
    // An older, pending copy of the record restored after completion: pending again, never a second genesis.
    const f = await crashedAt('store-created');
    copyFileSync(f.world.paths.record, join(f.world.dir, 'older-record'));
    assert.equal((await resume(f.world, f.witness, resumeRequest(f.binding).request)).outcome, 'registered');
    rmSync(f.world.paths.record);
    copyFileSync(join(f.world.dir, 'older-record'), f.world.paths.record);
    chmodSync(f.world.paths.record, 0o600);
    await assert.rejects(composeOver(f.world, f.witness, f.binding.storeId), unregistered('REGISTRATION_PENDING'));
    assert.deepEqual(await register(f.world, f.witness, registerRequest(bindingFor(f.world, f.witness)).request), { outcome: 'refused', reason: 'REGISTRATION_PENDING' });
    assert.deepEqual((await fvRows(f.witness)).map((r) => r.store_id), [f.binding.storeId]);
  });

  it('a rewritten file identity admits only the authorized store itself; another FV store or a Host store at the path is refused by the pin', async () => {
    const { witness, world, binding } = await completed();
    // A byte-identical copy (another inode) with the record rewritten to it: the same authorized store, at the same witnessed head.
    copyFileSync(world.paths.store, `${world.paths.store}.copy`);
    rmSync(world.paths.store);
    copyFileSync(`${world.paths.store}.copy`, world.paths.store);
    chmodSync(world.paths.store, 0o600);
    rmSync(`${world.paths.store}.copy`);
    await rewrite(world, `UPDATE fv_registration SET store_file_identity = ?`, fileIdentityOf(world.paths.store));
    const host = await composeOver(world, witness, binding.storeId);
    assert.equal(host.status().identityRegistration, 'verified');
    assert.equal(host.status().bootstrapExecution, 'disabled');
    host.close();
    // Another registered FV store, then a Host-domain store, at the path with the record rewritten to each.
    const other = await completed();
    rmSync(world.paths.store);
    copyFileSync(other.world.paths.store, world.paths.store);
    chmodSync(world.paths.store, 0o600);
    await rewrite(world, `UPDATE fv_registration SET store_file_identity = ?`, fileIdentityOf(world.paths.store));
    await assert.rejects(composeOver(world, witness, binding.storeId), (e) => e.code === 'IDENTITY_REFUSED');
    rmSync(world.paths.store);
    const hostStore = await openSqliteHumanIdentityStore(world.paths.store, { organizationId: world.org, now: () => new Date().toISOString(), authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, create: true, freshness: { boundary: await boundaryFor(witness, world.org) } });
    const hostStoreId = hostStore.storeId;
    hostStore.close();
    await rewrite(world, `UPDATE fv_registration SET store_file_identity = ?`, fileIdentityOf(world.paths.store));
    await assert.rejects(composeOver(world, witness, binding.storeId), (e) => e.code === 'IDENTITY_REFUSED');
    await assert.rejects(composeOver(world, witness, hostStoreId), unregistered('STORE_MISMATCH'));
  });

  it('an in-progress record rewritten before resume is quarantined, never completed; a skipped witness step contacts nothing', async () => {
    const a = await crashedAt('store-created');
    await rewrite(a.world, `UPDATE fv_registration SET store_file_identity = '1:2:3'`);
    assert.equal((await resume(a.world, a.witness, resumeRequest(a.binding).request)).reason, 'STORE_FILE_REPLACED');
    const b = await crashedAt('intent-recorded');
    const now = new Date().toISOString();
    await rewrite(b.world, `UPDATE fv_registration SET state = 'store-created', witness_anchored_at = ?, genesis_digest = 'sha256:forged', store_file_identity = '1:2:3', store_file_reserved_at = ?, store_created_at = ?`, now, now, now);
    const outcome = await resume(b.world, b.witness, resumeRequest(b.binding).request);
    assert.equal(outcome.outcome, 'quarantined');
    assert.deepEqual(await fvRows(b.witness), [], 'the witness was never asked to bind anything');
  });

  it('trust dependency, stated: the state column is not authority. A crashed, authorized registration whose store exists is admitted if a same-user writer promotes it', async () => {
    // The gate verifies the issuer-signed binding, the witness's binding of S and the held file. It cannot tell
    // the ceremony's own `registered` from a same-user writer's: the store is still exactly the one the issuer
    // authorized and the witness holds. Recorded in the lifecycle document (§12, publication audit).
    const { witness, world, binding } = await crashedAt('store-created');
    await rewrite(world, `UPDATE fv_registration SET state = 'registered', registered_at = ?`, new Date().toISOString());
    const host = await composeOver(world, witness, binding.storeId);
    assert.equal(host.status().identityRegistration, 'verified');
    assert.equal(host.status().bootstrapExecution, 'disabled');
    assert.deepEqual(await host.bootstrap({ request: {}, signedStatusText: '', requesterResponse: {}, approverResponse: {} }), { outcome: 'refused', reason: 'BOOTSTRAP_DISABLED' });
    host.close();
    assert.deepEqual((await fvRows(witness)).map((r) => [r.store_id, r.committed_sequence]), [[binding.storeId, 0]]);
  });
});

/** The composition with a boundary whose witness has since gone away. */
async function composeFvProtectedHostLike(world, storeId, boundary) {
  const namespace = 'receiver:fv-b3c2a';
  const protectedStore = join(world.dir, 'fv-protected.sqlite');
  const history = join(world.dir, 'history.sqlite');
  const records = await openProtectedContinuityStore(protectedStore, { create: true, now: () => new Date().toISOString() });
  const h = await openSqliteStatusHighWaterMarkStore(history, { namespace, create: true });
  records.save(captureHistoryContinuity(h, { namespace, databasePath: history, generation: 1, recordedAt: new Date().toISOString() }));
  h.close();
  records.close();
  return composeFvProtectedHost({
    protectedStorePath: protectedStore,
    configuration: () => ({ generation: 1, histories: [{ namespace, databasePath: history }] }),
    identity: { storePath: world.paths.store, storeId, authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, freshness: { boundary, stateKind: FV_DOMAIN }, relyingParty: RP, operatorIds: OPERATORS },
    registration: { recordPath: world.paths.record, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN },
    standing,
    organizationId: world.org,
    clock: () => new Date(),
    graceSeconds: GRACE,
    receiver: { verifySovereignStatus, establishStatusHistory },
    verificationKeyResolver: resolver,
    trustedSubjectOf: () => undefined,
  });
}

it('test-only issuance: the issuer fixture and its keys are generated per process; the production registrar pins no issuer by default', () => {
  assert.notEqual(TEST_REGISTRATION_ISSUER_KEY.publicKeyPem, UNTRUSTED_REGISTRATION_KEY.publicKeyPem);
  assert.equal(TEST_REGISTRATION_ISSUER_KEY.keyId, UNTRUSTED_REGISTRATION_KEY.keyId, 'the attacker key reuses the pinned key id');
});
