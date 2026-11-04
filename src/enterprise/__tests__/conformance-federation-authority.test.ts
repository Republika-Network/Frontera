import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { canonicalizeConformance } from '../conformance/canonical.js';
import { SYNTHETIC_OPERATOR_STATEMENT, type ObservationPayload, type SignedChallenge } from '../conformance/contracts.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { FEDERATION_TIMING } from '../conformance/federation-contracts.js';
import { FederationError, createFederationRegistry } from '../conformance/federation-registry.js';
import { createSyntheticHumanDirectory } from '../conformance/human-authority.js';
import { createConformanceProfileRegistry } from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, ConformanceRegistryError, createConformanceRegistry } from '../conformance/registry.js';
import { signConformancePayload } from '../conformance/signing.js';
import {
  CONFORMANCE_STORE_PREVIOUS_SCHEMA_VERSION,
  CONFORMANCE_STORE_SCHEMA_VERSION,
  ConformanceStoreError,
  createConformanceStoreV2Fixture,
  migrateConformanceStore,
  openConformanceStore,
  operatorEligibleAt,
  operatorEligibleForStoredRow,
} from '../conformance/sqlite-conformance-store.js';
import { ALL_ACTIONS, ORG_A, T0, decide, manualClock, syntheticHuman, syntheticValidator, enrollmentDecisions } from './conformance-support.js';
import { REFERENCE_FIXTURE_REF } from './conformance-reference-pep.js';
import { assertionOf, cleanupReferenceCircuits, referenceStatus } from './conformance-reference-support.js';
import {
  FED_OPERATORS,
  FED_REQUALIFICATION_AUTHORIZATION,
  activeFederatedCredential,
  adoptGeneration,
  beat,
  drain,
  enrollGeneration,
  fedDecisions,
  makeMalicious,
  requalify,
  scheduleOne,
  standardFederation,
  type Federation,
} from './conformance-federation-support.js';

/**
 * RN-CONFORM-05 security remediation — regressions for P1-1 (retired-generation quarantine), P1-2 (dispute
 * chronology), P2-5 (authoritative operator status in the RN-CONFORM-02 store, schema /3 and its migration), the two
 * Codex P2s (job recovery, requalification isolation) and F-0 (same-millisecond ordering). Real SQLite throughout.
 */

after(() => cleanupReferenceCircuits());

const refused = (code: string) => (e: unknown) =>
  (e instanceof ConformanceRegistryError && e.code === code) || (e instanceof FederationError && e.code === code) || (e instanceof ConformanceStoreError && e.code === code);

const issueTo = (f: Federation, cvids: readonly string[], key: string, operation = 'document.open'): SignedChallenge =>
  f.c.services().coordinator.issue({ idempotencyKey: key, organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation, fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: cvids, deadlineSeconds: 600 });

/** Submits a contradiction of the stored observation of `cvid` for `challengeId`, signed with `key`. */
function contradict(f: Federation, challengeId: string, cvid: string, key: Parameters<typeof signConformancePayload>[2], eventId: string) {
  const row = f.c.store.getObservationForChallengeValidator(challengeId, cvid)!;
  const contradiction = { ...(JSON.parse(row.submissionJson) as { observation: ObservationPayload }).observation, eventId, observedOutcome: 'allowed' as const, outcomeClass: 'violation' as const };
  return f.c.services().evidence.submitObservation(JSON.stringify({ observation: contradiction, validatorSignature: signConformancePayload('observation', contradiction, key) }));
}

async function activeAndAged(seed: string): Promise<{ f: Federation; id: string }> {
  const f = standardFederation(seed);
  const id = await activeFederatedCredential(f);
  f.c.clock.advance(2 * 3600);
  beat(f);
  return { f, id };
}

describe('P1-1 — a quarantine on a retired key generation cannot be bypassed by its successor', () => {
  it('rotate → the retired k1 contradicts itself on an outstanding challenge → k2 is refused work at once, after restart too', async () => {
    const f = standardFederation('p11-retired');
    const vb1 = f.validators.get('vb1')!;
    const outstanding = issueTo(f, ['vb1.k1'], 'p11-outstanding');
    assert.equal((await vb1.runtime.receive(outstanding)).status, 'ACCEPTED');
    const k1Key = vb1.key;
    const { generation, key } = enrollGeneration(f, 'vb1', 'ROTATE');
    adoptGeneration(f, 'vb1', generation, key);
    beat(f);
    // A job is assigned to k2 while everything is still clean.
    const pending = scheduleOne(f, 'G02', 'document.open', 2, { exclude: [FED_OPERATORS.A], key: 'p11-k2-job' });
    assert.ok(pending.scheduled && pending.job.assignments.some((a) => a.conformanceValidatorId === 'vb1.k2'));
    // The retired k1 signs a contradiction for its outstanding challenge: evidence acceptance quarantines k1.
    assert.deepEqual(contradict(f, outstanding.challenge.challengeId, 'vb1.k1', k1Key, 'p11-contradiction'), { accepted: false, reason: 'VALIDATOR_CONFLICT' });
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE', 'the federation has not synced');
    // Before any sync: not eligible, not schedulable, and the worker refuses to dispatch the pre-assigned job.
    assert.deepEqual(f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms()), { eligible: false, reason: 'QUARANTINED' });
    assert.deepEqual(scheduleOne(f, 'G05', 'document.open', 3, { key: 'p11-after' }), { scheduled: false, reason: 'QUORUM_INSUFFICIENT', availableOperators: 2 });
    const out = await f.worker('w-p11').runOnce();
    assert.deepEqual(out.map((o) => o.outcome), ['CANCELLED']);
    assert.equal(f.deliveries.filter((d) => d.validatorId === 'vb1' && d.challengeId !== outstanding.challenge.challengeId).length, 0);
    // Restart (federation store reopened, conformance store re-read through a fresh handle): still refused.
    f.restart();
    assert.deepEqual(f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms()), { eligible: false, reason: 'QUARANTINED' });
    const store2 = openConformanceStore(join(f.c.dir, 'conformance.sqlite'));
    try {
      const fresh = createFederationRegistry({ fed: f.fed, store: store2, conformance: createConformanceRegistry({ store: store2, profiles: f.c.profiles, clock: f.c.clock, humans: f.c.humansDirectory }), profiles: f.c.profiles, humans: f.c.humansDirectory, clock: f.c.clock, random: f.c.random });
      assert.equal(fresh.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms()).eligible, false);
    } finally {
      store2.close();
    }
    // Rotation cannot launder it; release is only REINSTATE + requalification (a pass is never asserted).
    assert.throws(() => enrollGeneration(f, 'vb1', 'ROTATE'), refused('VALIDATOR_NOT_ELIGIBLE'));
    const reinstated = enrollGeneration(f, 'vb1', 'REINSTATE');
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
    assert.throws(() => f.registry.completeReinstatement('vb1', reinstated.generation.generation, 'job_none'), refused('REQUALIFICATION_FAILED'));
  });
});

describe('P1-2 — dispute planning follows the engine chronology', () => {
  it('A and B conformant BEFORE C\'s violation do not resolve it: a fresh dispute goes to A and B, and the credential stays ACTIVE', async () => {
    const { f, id } = await activeAndAged('p12-chronology');
    const { lifecycle } = f.c.services();
    assert.ok(scheduleOne(f, 'G01', 'document.export', 2, { exclude: [FED_OPERATORS.C], key: 'p12-pre' }).scheduled);
    await drain(f);
    f.c.clock.advance(60);
    makeMalicious(f, 'vc1', 'allowed');
    assert.ok(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.A, FED_OPERATORS.B], key: 'p12-c' }).scheduled);
    await drain(f);
    const cr01 = () => lifecycle.evaluate(ORG_A, id).evaluation.requirementResults.find((r) => r.requirementId === 'CR-01');
    assert.equal(cr01()?.category, 'CONFLICTING', 'the earlier conformance cannot resolve a later violation');
    f.c.clock.advance(5);
    const plan = f.scheduler.planFollowUps('auth-reference-pep-synthetic-1', REFERENCE_FIXTURE_REF);
    const dispute = plan.find((r) => r.scheduled && r.job.purpose === 'DISPUTE');
    assert.ok(dispute?.scheduled, 'the scheduler sees the unresolved dispute (the old code saw "three operators involved" and did nothing)');
    assert.deepEqual([...new Set(dispute.job.assignments.map((a) => a.operatorId))].sort(), [FED_OPERATORS.A, FED_OPERATORS.B], 'operators whose evidence predates the violation are reassigned');
    // Duplicate planning while the dispute is in flight schedules nothing more.
    const before = f.fed.listJobs().length;
    assert.equal(f.scheduler.planFollowUps('auth-reference-pep-synthetic-1', REFERENCE_FIXTURE_REF).filter((r) => r.scheduled && r.created).length, 0);
    assert.equal(f.fed.listJobs().length, before);
    // A coordinator restart during the investigation loses nothing.
    f.restart();
    await drain(f);
    assert.equal(cr01()?.category, 'VERIFIED_SUCCESS', 'resolved by two other operators strictly after the violation');
    f.c.clock.advance(31 * 60);
    const later = lifecycle.evaluate(ORG_A, id);
    assert.equal(later.protectiveTransition, null, 'no SR-4 suspension: the scheduler did not skip the necessary challenges');
    assert.equal(f.c.store.getHead(ORG_A, id)?.state, 'ACTIVE');
  });

  it('two operators confirming a violation need no follow-up; a confirmed violation still suspends', async () => {
    const { f, id } = await activeAndAged('p12-confirmed');
    f.c.deployment.defects.add('BYPASS-01');
    f.c.deployment.defectOperations.add('document.export');
    assert.ok(scheduleOne(f, 'G01', 'document.export', 2, { exclude: [FED_OPERATORS.C], key: 'p12-two' }).scheduled);
    await drain(f);
    assert.equal(f.c.services().lifecycle.evaluate(ORG_A, id).protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.equal(f.scheduler.planFollowUps('auth-reference-pep-synthetic-1', REFERENCE_FIXTURE_REF).length, 0);
  });
});

describe('P2-5 — operator authority is enforced by the authoritative RN-CONFORM-02 store', () => {
  it('Phase E: quarantine and revocation of an operator bind direct enrollment, direct challenges, acceptance and evaluation — across restarts', async () => {
    const f = standardFederation('p25-phase-e');
    const conformance = f.c.services().registry;
    const coordinator = f.c.services().coordinator;
    const va1 = f.validators.get('va1')!;
    // A challenge issued while operator A is eligible …
    const preIssued = issueTo(f, ['va1.k1'], 'p25-pre-issued');
    // … then operator A is quarantined in the authoritative store only (the federation has not been told).
    conformance.quarantineOperator(FED_OPERATORS.A, 'OPERATOR_COMPROMISE');
    // Direct RN-CONFORM-02 enrollment of a new A validator: refused.
    const a2 = syntheticValidator('va-direct', FED_OPERATORS.A);
    const prep = conformance.prepareValidatorEnrollment({ validatorId: a2.validatorId, operatorId: a2.operatorId, publicKeyPem: a2.publicKeyPem, keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
    assert.throws(() => conformance.enrollValidator(prep.record, enrollmentDecisions(f.c, a2.validatorId, prep.bindingDigest, f.c.clock.now())), refused('OPERATOR_NOT_ELIGIBLE'));
    // Direct challenge assignment: refused.
    assert.throws(() => issueTo(f, ['va1.k1'], 'p25-direct'), (e: unknown) => e instanceof Error && /VALIDATOR_NOT_ELIGIBLE/.test(e.message));
    // An observation for the pre-issued challenge: refused at acceptance — it can never contribute to quorum.
    const late = await va1.runtime.receive(preIssued);
    assert.deepEqual(late.status === 'REJECTED' ? late.reason : late.status, 'OPERATOR_NOT_ELIGIBLE');
    // The federation's eligibility reads the authoritative status even before it syncs; sync mirrors it.
    assert.equal(f.registry.eligibility('va2', f.c.clock.ms(), f.c.clock.ms()).eligible, false);
    f.registry.syncFromConformance();
    assert.equal(f.registry.operatorState(FED_OPERATORS.A), 'QUARANTINED');
    // Revocation (two humans in the federation, terminal in the conformance store).
    f.registry.revokeOperator(FED_OPERATORS.A, fedDecisions(f, f.registry.prepareOperatorAction(FED_OPERATORS.A, 'revoke')));
    assert.equal(f.c.store.listOperatorEvents(FED_OPERATORS.A).at(-1)?.kind, 'REVOKED');
    assert.throws(() => f.registry.registerOperator({ operatorId: FED_OPERATORS.A, operatorClass: 'REPUBLIKA', administrativeOwnerRef: 'owner-ref-reuse' }), refused('DUPLICATE_OPERATOR'));
    const reapprove = conformance.prepareOperatorAction(FED_OPERATORS.A, 'approve');
    assert.throws(() => conformance.approveOperator(FED_OPERATORS.A, fedDecisions(f, reapprove)), refused('TRANSITION_NOT_ALLOWED'));
    assert.throws(() => enrollGeneration(f, 'va2', 'ROTATE'), refused('VALIDATOR_NOT_ELIGIBLE'));
    // Restart both stores: the restrictions are durable.
    f.restart();
    const store2 = openConformanceStore(join(f.c.dir, 'conformance.sqlite'));
    try {
      const registry2 = createConformanceRegistry({ store: store2, profiles: f.c.profiles, clock: f.c.clock, humans: f.c.humansDirectory });
      assert.equal(registry2.operatorEligible(FED_OPERATORS.A), false);
      const again = registry2.prepareValidatorEnrollment({ validatorId: 'va-direct-2', operatorId: FED_OPERATORS.A, publicKeyPem: syntheticValidator('va-direct-2', FED_OPERATORS.A).publicKeyPem, keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
      assert.throws(() => registry2.enrollValidator(again.record, enrollmentDecisions(f.c, 'va-direct-2', again.bindingDigest, f.c.clock.now())), refused('OPERATOR_NOT_ELIGIBLE'));
    } finally {
      store2.close();
    }
    assert.throws(() => coordinator.issue({ idempotencyKey: 'p25-after-restart', organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: ['va2.k1'], deadlineSeconds: 300 }));
  });

  it('two self-registered (unapproved) operator ids cannot enroll validators, so they can never fabricate a VERIFIED_SUCCESS', () => {
    const f = standardFederation('p25-fabricated');
    const conformance = f.c.services().registry;
    for (const op of ['op-fabricated-1', 'op-fabricated-2']) {
      conformance.registerSyntheticOperator(op); // the legacy path: no approval
      assert.equal(conformance.operatorEligible(op), false);
      const v = syntheticValidator(`v-${op}`, op);
      const prep = conformance.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: op, publicKeyPem: v.publicKeyPem, keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
      assert.throws(() => conformance.enrollValidator(prep.record, enrollmentDecisions(f.c, v.validatorId, prep.bindingDigest, f.c.clock.now())), refused('OPERATOR_NOT_ELIGIBLE'));
    }
    // An id nobody registered: UNKNOWN_OPERATOR.
    const ghost = syntheticValidator('v-ghost', 'op-never-registered');
    const prep = conformance.prepareValidatorEnrollment({ validatorId: ghost.validatorId, operatorId: 'op-never-registered', publicKeyPem: ghost.publicKeyPem, keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
    assert.throws(() => conformance.enrollValidator(prep.record, []), refused('UNKNOWN_OPERATOR'));
    // A federation-registered but unapproved operator is not eligible either.
    f.registry.registerOperator({ operatorId: 'op-registered-only', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-registered' });
    assert.equal(conformance.operatorEligible('op-registered-only'), false);
    // Approval by another organization's humans is refused (cross-tenant).
    const p = f.registry.prepareOperatorAction('op-registered-only', 'approve');
    assert.throws(() => f.registry.approveOperator('op-registered-only', fedDecisions(f, p, f.c.humans.alice, f.c.humans.bob)), refused('APPROVAL_REFUSED'));
    assert.equal(f.c.store.getOperator('op-registered-only'), undefined, 'a refused approval writes nothing');
  });

  it('the store itself refuses an approval without two humans and any return from REVOKED (direct writes)', () => {
    const f = standardFederation('p25-raw');
    f.c.services().registry.registerSyntheticOperator('op-raw');
    const raw = new Database(join(f.c.dir, 'conformance.sqlite'));
    try {
      assert.throws(() => raw.prepare("INSERT INTO cc_operator_events (operator_id, seq, kind, at_ms, reason, binding_digest) VALUES ('op-raw', 1, 'APPROVED', 1, 'forged', NULL)").run(), /two humans/);
      raw.prepare("INSERT INTO cc_operator_events (operator_id, seq, kind, at_ms, reason, binding_digest) VALUES ('op-raw', 1, 'REVOKED', 1, 'protective', NULL)").run();
      assert.throws(() => raw.prepare("INSERT INTO cc_operator_events (operator_id, seq, kind, at_ms, reason, binding_digest) VALUES ('op-raw', 2, 'REINSTATED', 2, 'forged', NULL)").run(), /transition not allowed|two humans/);
      assert.throws(() => raw.prepare("UPDATE cc_operator_events SET kind = 'APPROVED' WHERE operator_id = 'op-raw'").run(), /immutable/);
      assert.throws(() => raw.prepare("DELETE FROM cc_operator_events WHERE operator_id = 'op-raw'").run(), /immutable/);
    } finally {
      raw.close();
    }
  });

  it('F-0 still holds for operator status: a same-millisecond operator quarantine withdraws, never "tampers", accepted evidence', async () => {
    const { f, id } = await activeAndAged('p25-same-ms');
    const vb1 = f.validators.get('vb1')!;
    const signed = issueTo(f, ['vb1.k1'], 'p25-same-ms');
    assert.equal((await vb1.runtime.receive(signed)).status, 'ACCEPTED');
    const row = f.c.store.getObservationForChallengeValidator(signed.challenge.challengeId, 'vb1.k1')!;
    f.c.services().registry.quarantineOperator(FED_OPERATORS.B, 'SAME_MILLISECOND');
    assert.equal(f.c.store.listOperatorEvents(FED_OPERATORS.B).at(-1)?.atMs, row.acceptedAtMs);
    assert.equal(authenticateStoredObservation(f.c.store, f.c.profiles, row, f.c.coordinatorPublicKeyPem), null);
    const s = referenceStatus(f.c);
    const nonce = randomBytes(32).toString('base64url');
    const verdict = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, nonce))), id, { kind: 'online', nonce });
    assert.notEqual(verdict.detail, 'EVIDENCE_TAMPERED');
    s.close();
  });

  it('the stored-row and live eligibility rules (unit): live is inclusive; stored accepts either same-millisecond order and the LEGACY era', () => {
    const approvedThenQuarantined = [{ seq: 1, kind: 'APPROVED' as const, atMs: 1_000 }, { seq: 2, kind: 'QUARANTINED' as const, atMs: 2_000 }];
    assert.equal(operatorEligibleAt(approvedThenQuarantined, 1_999), true);
    assert.equal(operatorEligibleAt(approvedThenQuarantined, 2_000), false, 'live: the quarantine applies at its own instant');
    assert.equal(operatorEligibleForStoredRow(approvedThenQuarantined, 2_000), true, 'stored: committed before the same-millisecond quarantine');
    assert.equal(operatorEligibleForStoredRow(approvedThenQuarantined, 2_001), false);
    assert.equal(operatorEligibleForStoredRow([{ seq: 1, kind: 'APPROVED', atMs: 1_000 }], 999), false);
    const legacy = [{ seq: 1, kind: 'LEGACY' as const, atMs: 5_000 }];
    assert.equal(operatorEligibleForStoredRow(legacy, 4_000), true, 'accepted before the migration');
    assert.equal(operatorEligibleForStoredRow(legacy, 5_001), false);
    assert.equal(operatorEligibleAt(legacy, 6_000), false, 'LEGACY is never eligible for new evidence');
    assert.equal(operatorEligibleAt([], 6_000), false, 'unknown fails closed');
  });
});

describe('P2-5 — schema /3 and the explicit /2 → /3 migration', () => {
  const NET = CONFORMANCE_NETWORK_ORGANIZATION;
  const humans = { netAlice: syntheticHuman('net-alice', NET), netBob: syntheticHuman('net-bob', NET) };
  const directory = createSyntheticHumanDirectory(Object.values(humans).map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: ALL_ACTIONS })));
  const legacyOperator = (db: Database.Database, operatorId: string) =>
    db.prepare('INSERT INTO cc_operators (operator_id, record_json, synthetic) VALUES (?, ?, 1)').run(operatorId, canonicalizeConformance({ schema: 'rn.conformance.validator-operator/1', operatorId, synthetic: true, attestation: { statement: SYNTHETIC_OPERATOR_STATEMENT, attestedAt: T0 }, registeredAt: T0 }));

  it('a /2 file is refused with SCHEMA_MIGRATION_REQUIRED, migrated explicitly (operators LEGACY, not eligible), and re-approval restores eligibility', () => {
    const f = standardFederation('p25-migrate');
    const path = join(f.c.dir, 'legacy-v2.sqlite');
    createConformanceStoreV2Fixture(path);
    const raw = new Database(path);
    legacyOperator(raw, 'op-legacy');
    raw.close();
    assert.throws(() => openConformanceStore(path), refused('SCHEMA_MIGRATION_REQUIRED'));
    const result = migrateConformanceStore(path, { now: () => Date.parse(T0) });
    assert.deepEqual(result, { from: CONFORMANCE_STORE_PREVIOUS_SCHEMA_VERSION, to: CONFORMANCE_STORE_SCHEMA_VERSION, legacyOperators: 1 });
    assert.throws(() => migrateConformanceStore(path), refused('ALREADY_CURRENT'));
    const store = openConformanceStore(path);
    try {
      assert.deepEqual(store.listOperatorEvents('op-legacy').map((e) => e.kind), ['LEGACY']);
      const clock = manualClock(T0);
      clock.advance(60);
      const registry = createConformanceRegistry({ store, profiles: createConformanceProfileRegistry(), clock, humans: directory });
      assert.equal(registry.operatorEligible('op-legacy'), false, 'a migrated operator is NOT treated as approved');
      const v = syntheticValidator('v-legacy', 'op-legacy');
      const prep = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: 'op-legacy', publicKeyPem: v.publicKeyPem, keyValidFrom: clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
      assert.throws(() => registry.enrollValidator(prep.record, enrollmentDecisions({ humans: { ...humans } as never }, v.validatorId, prep.bindingDigest, clock.now())), refused('OPERATOR_NOT_ELIGIBLE'));
      const approve = registry.prepareOperatorAction('op-legacy', 'approve');
      registry.approveOperator('op-legacy', [decide(humans.netAlice, 'attest', approve.action, approve.subjectRef, approve.actionBindingDigest, clock.now()), decide(humans.netBob, 'approve', approve.action, approve.subjectRef, approve.actionBindingDigest, clock.now())]);
      assert.equal(registry.operatorEligible('op-legacy'), true);
    } finally {
      store.close();
    }
  });

  it('a tampered /2 file is refused by the migration; an interrupted migration leaves the file exactly /2', () => {
    const f = standardFederation('p25-migrate-negative');
    const tampered = join(f.c.dir, 'tampered-v2.sqlite');
    createConformanceStoreV2Fixture(tampered);
    const raw = new Database(tampered);
    raw.exec('DROP TRIGGER cc_observations_attributed');
    raw.close();
    assert.throws(() => migrateConformanceStore(tampered), refused('CORRUPT'));
    const interrupted = join(f.c.dir, 'interrupted-v2.sqlite');
    createConformanceStoreV2Fixture(interrupted);
    assert.throws(() => migrateConformanceStore(interrupted, { faultAfterSchema: () => { throw new Error('synthetic crash mid-migration'); } }), /synthetic crash/);
    assert.throws(() => openConformanceStore(interrupted), refused('SCHEMA_MIGRATION_REQUIRED'));
    assert.equal(migrateConformanceStore(interrupted).to, CONFORMANCE_STORE_SCHEMA_VERSION, 'a later explicit run succeeds');
    assert.ok(existsSync(interrupted));
    // A /3 file whose operator trigger was removed is CORRUPT on open (never silently repaired).
    const raw3 = new Database(interrupted);
    raw3.exec('DROP TRIGGER cc_operator_events_valid');
    raw3.close();
    assert.throws(() => openConformanceStore(interrupted), refused('CORRUPT'));
  });
});

describe('Codex P2 — durable job recovery and requalification isolation', () => {
  async function pendingRequalification(seed: string) {
    const f = standardFederation(seed);
    f.registry.quarantineValidator('vb1', 'PROTOCOL_VIOLATIONS');
    const { generation, key } = enrollGeneration(f, 'vb1', 'REINSTATE');
    adoptGeneration(f, 'vb1', generation, key);
    const r = f.scheduler.scheduleRequalification({ validatorId: 'vb1', generation: 2, authorizationId: FED_REQUALIFICATION_AUTHORIZATION, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF });
    if (!r.scheduled) throw new Error(r.reason);
    return { f, jobId: r.job.jobId };
  }

  it('a worker crash after every observation committed, restarted after the deadline: COMPLETED (not EXPIRED) and the reinstatement succeeds', async () => {
    const { f, jobId } = await pendingRequalification('p2-recovery');
    let delivered = 0;
    const crashing = { deliver: async (a: Parameters<Federation['transport']['deliver']>[0], s: SignedChallenge) => {
      const result = await f.transport.deliver(a, s);
      delivered += 1;
      if (delivered === f.fed.getJob(jobId)!.assignments.length) throw new Error('worker crashed after the last commit');
      return result;
    } };
    await assert.rejects(() => f.workerWith('w-crash', crashing).process(jobId), /worker crashed/);
    const stuck = f.fed.getJob(jobId)!;
    assert.equal(stuck.state, 'LEASED');
    assert.equal(stuck.assignments.filter((a) => f.c.store.getObservationForChallengeValidator(stuck.challengeId as string, a.conformanceValidatorId) !== undefined).length, 2);
    f.c.clock.advance(FEDERATION_TIMING.requalificationDeadlineSeconds + 1);
    f.restart();
    await f.worker('w-recover').runOnce();
    assert.equal(f.fed.getJob(jobId)?.state, 'COMPLETED');
    assert.equal(f.fed.getJob(jobId)?.lastError, 'RECONCILED_AFTER_DEADLINE');
    f.registry.completeReinstatement('vb1', 2, jobId);
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE');
  });

  it('a credential created on the probation fixture before dispatch cancels the job; created before completion, it voids the requalification', async () => {
    const a = await pendingRequalification('p2-requal-dispatch');
    a.f.c.services().lifecycle.registerCandidate({ organizationId: a.f.requalification.organizationId, integrationDigest: a.f.requalification.integrationDigest });
    const out = await a.f.worker('w-requal').process(a.jobId);
    assert.deepEqual([out.outcome, 'detail' in out ? out.detail : null], ['CANCELLED', 'REQUALIFICATION_TARGET_CREDENTIALED']);
    assert.equal(a.f.c.store.listObservations(a.f.requalification.organizationId, a.f.requalification.integrationDigest).length, 0, 'no probation evidence lands on a credentialed integration');
    assert.equal(a.f.scheduler.scheduleRequalification({ validatorId: 'vb1', generation: 2, authorizationId: FED_REQUALIFICATION_AUTHORIZATION, challengeType: 'G01', operation: 'document.export', fixtureRef: REFERENCE_FIXTURE_REF }).scheduled, false);

    const b = await pendingRequalification('p2-requal-complete');
    await drain(b.f);
    b.f.c.services().lifecycle.registerCandidate({ organizationId: b.f.requalification.organizationId, integrationDigest: b.f.requalification.integrationDigest });
    assert.throws(() => b.f.registry.completeReinstatement('vb1', 2, b.jobId), refused('REQUALIFICATION_FAILED'));
    assert.equal(b.f.registry.validatorState('vb1'), 'QUARANTINED');
  });

  it('a normal requalification still works end to end (fixture without credential)', async () => {
    const f = standardFederation('p2-requal-ok');
    f.registry.quarantineValidator('vb1', 'PROTOCOL_VIOLATIONS');
    const { generation, key } = enrollGeneration(f, 'vb1', 'REINSTATE');
    adoptGeneration(f, 'vb1', generation, key);
    const jobId = await requalify(f, 'vb1', 2);
    f.registry.completeReinstatement('vb1', 2, jobId);
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE');
  });
});
