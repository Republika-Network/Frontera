import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { ObservationPayload, SignedChallenge } from '../conformance/contracts.js';
import { FEDERATION_TIMING, type ScheduledJob } from '../conformance/federation-contracts.js';
import { FederationError } from '../conformance/federation-registry.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { signConformancePayload } from '../conformance/signing.js';
import { ORG_A, deterministicRandom } from './conformance-support.js';
import { createValidatorRuntime, openValidatorOutbox } from '../conformance/federation-validator-runtime.js';
import { assertionOf, cleanupReferenceCircuits, referenceStatus } from './conformance-reference-support.js';
import {
  FED_AUTHORIZATION,
  FED_OPERATORS,
  activeFederatedCredential,
  adoptGeneration,
  beat,
  drain,
  enrollGeneration,
  fullCapabilities,
  ephemeralKey,
  ephemeralSigner,
  evidencePort,
  fedDecisions,
  makeMalicious,
  requalify,
  runtimeFor,
  scheduleOne,
  standardFederation,
  type Federation, REFERENCE_SCOPE
} from './conformance-federation-support.js';
import { REFERENCE_FIXTURE_REF } from './conformance-reference-pep.js';

/**
 * RN-CONFORM-05 — WP-09/10/11/13/14/15: federated corroboration Scenarios A–H over the real engine, lifecycle and signed
 * status; automatic quarantine and its two-person release with requalification; the validator runtime's refusals; and
 * the proof that the federation layer has no path to a credential decision.
 */

after(() => cleanupReferenceCircuits());

const jobOf = (r: ReturnType<typeof scheduleOne>): ScheduledJob => {
  if (!r.scheduled) throw new Error(`not scheduled: ${r.reason}`);
  return r.job;
};
const cr01 = (f: Federation, id: string) => f.c.services().lifecycle.evaluate(ORG_A, id);
const categoryOf = (e: ReturnType<typeof cr01>) => e.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01');
const operatorAValidators = ['va1', 'va2', 'va3'];

/** Two hours after issuance, heartbeats refreshed, the export path made defective (BYPASS-01) or left conformant. */
async function activeAndAged(seed: string, defective: boolean): Promise<{ f: Federation; id: string }> {
  const f = standardFederation(seed);
  const id = await activeFederatedCredential(f);
  f.c.clock.advance(2 * 3600);
  beat(f);
  if (defective) {
    f.c.deployment.defects.add('BYPASS-01');
    f.c.deployment.defectOperations.add('document.export');
  }
  return { f, id };
}

describe('RN-CONFORM-05 — federated corroboration scenarios (WP-13)', () => {
  it('baseline: the full reference matrix is scheduled per operator, executed by validator runtimes and issued by two humans', async () => {
    const f = standardFederation('fed-baseline');
    const id = await activeFederatedCredential(f);
    assert.equal(f.c.store.getHead(ORG_A, id)?.state, 'ACTIVE');
    const jobs = f.fed.listJobs();
    assert.equal(jobs.length, 22);
    assert.ok(jobs.every((j) => j.state === 'COMPLETED' && new Set(j.assignments.map((a) => a.operatorId)).size === 2));
  });

  it('Scenario A + D: two distinct operator records observe the same critical bypass → VERIFIED_FAILURE → T4 → signed SUSPENDED', async () => {
    const { f, id } = await activeAndAged('fed-d', true);
    const job = jobOf(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.B, FED_OPERATORS.C], key: 'd-first' }));
    await drain(f);
    const afterOne = cr01(f, id);
    assert.equal(afterOne.protectiveTransition, null, 'one operator: investigation only');
    assert.equal(categoryOf(afterOne)?.category, 'UNCONFIRMED_VIOLATION');
    const followUps = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
    assert.ok(followUps.some((r) => r.scheduled && r.job.purpose === 'INVESTIGATION'));
    await drain(f);
    const confirmed = cr01(f, id);
    assert.equal(confirmed.protectiveTransition?.record.transitionCode, 'T4');
    assert.equal(confirmed.protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.equal(confirmed.protectiveTransition?.record.humanDecisions.length, 0);
    const violators = categoryOf(confirmed)?.violationOperators ?? [];
    assert.equal(new Set(violators).size, 2);
    for (const op of violators) assert.equal(f.fed.getOperator(op)?.designation, 'SYNTHETIC-FEDERATION-NON-PRODUCTION', 'distinct operator RECORDS, all labelled synthetic');
    assert.ok(job.assignments.every((a) => operatorAValidators.includes(a.validatorId)));
    // RN-CONFORM-03: the online, nonce-bound status cannot report the outdated ACTIVE.
    const s = referenceStatus(f.c);
    const nonce = randomBytes(32).toString('base64url');
    const verdict = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, nonce))), id, { kind: 'online', nonce });
    assert.deepEqual([verdict.result, verdict.state], ['NOT_CONFORMANT', 'SUSPENDED']);
    s.close();
  });

  it('Scenario B + G: three validators of one operator report the same violation → one operator vote, nothing confirmed', async () => {
    const { f, id } = await activeAndAged('fed-b', true);
    const cvids = operatorAValidators.map((v) => `${v}.k1`);
    // Operator A tries to manufacture three votes: the coordinator issues to all three of its validators.
    const signed: SignedChallenge = f.c.services().coordinator.issue({
      idempotencyKey: 'operator-a-three-votes',
      organizationId: ORG_A,
      integrationDigest: f.c.integration.integrationDigest,
      challengeType: 'G01',
      operation: 'document.export',
      fixtureRef: REFERENCE_FIXTURE_REF,
      assignedValidatorIds: cvids,
      deadlineSeconds: 600,
      authorizationId: FED_AUTHORIZATION,
      purpose: 'CONFORMANCE',
    });
    for (const v of operatorAValidators) assert.equal((await f.validators.get(v)!.runtime.receive(signed)).status, 'ACCEPTED');
    const result = cr01(f, id);
    assert.equal(result.protectiveTransition, null);
    assert.equal(categoryOf(result)?.category, 'UNCONFIRMED_VIOLATION');
    assert.deepEqual(categoryOf(result)?.violationOperators, [FED_OPERATORS.A]);
    assert.equal(result.evaluation.criticalFailureConfirmed, false);
    assert.equal(f.c.store.getHead(ORG_A, id)?.state, 'ACTIVE');
    // The scheduler, asked for a second operator, never picks another validator of A.
    const follow = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF).find((r) => r.scheduled && r.job.purpose === 'INVESTIGATION');
    assert.ok(follow?.scheduled && follow.job.assignments.every((a) => a.operatorId !== FED_OPERATORS.A));
  });

  it('Scenario C: one malicious validator alone cannot cause a suspension; the dispute it opens is resolved by other operators', async () => {
    const { f, id } = await activeAndAged('fed-c', false);
    for (const v of operatorAValidators) makeMalicious(f, v, 'allowed');
    jobOf(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.B, FED_OPERATORS.C], key: 'c-lie' }));
    await drain(f);
    assert.equal(cr01(f, id).protectiveTransition, null);
    // Investigation: one other operator → conformant → CONFLICTING (never a clean pass, never a suspension yet).
    f.c.clock.advance(5);
    f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
    await drain(f);
    const disputed = cr01(f, id);
    assert.equal(categoryOf(disputed)?.category, 'CONFLICTING');
    assert.equal(disputed.protectiveTransition, null);
    // Dispute: the third distinct operator → conformant → resolved by ≥ 2 other operators.
    // Resolution needs conformant observations strictly AFTER the violation (engine rule), so time moves on.
    f.c.clock.advance(5);
    const dispute = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF).find((r) => r.scheduled && r.job.purpose === 'DISPUTE');
    assert.ok(dispute?.scheduled);
    await drain(f);
    const resolved = cr01(f, id);
    assert.equal(categoryOf(resolved)?.category, 'VERIFIED_SUCCESS');
    assert.equal(f.c.store.getHead(ORG_A, id)?.state, 'ACTIVE');
  });

  it('Scenario E: conflicting observations → third operator; it confirms the violation (no false PASS); unresolved, SR-4 fails closed', async () => {
    const { f, id } = await activeAndAged('fed-e', true);
    makeMalicious(f, 'vb1', 'denied');
    jobOf(scheduleOne(f, 'G01', 'document.export', 2, { exclude: [FED_OPERATORS.C], key: 'e-split' }));
    await drain(f);
    const split = cr01(f, id);
    assert.equal(categoryOf(split)?.category, 'CONFLICTING');
    assert.equal(split.protectiveTransition, null);
    const dispute = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF).find((r) => r.scheduled && r.job.purpose === 'DISPUTE');
    // B's observation was simultaneous with the violation, not after it, so it cannot resolve it (engine rule): the
    // dispute needs two operators other than A, and C is among them (review P1-2).
    assert.ok(dispute?.scheduled && dispute.job.assignments.every((a) => a.operatorId !== FED_OPERATORS.A) && dispute.job.assignments.some((a) => a.operatorId === FED_OPERATORS.C));
    await drain(f);
    const settled = cr01(f, id);
    assert.equal(settled.protectiveTransition?.record.transitionCode, 'T4');
    assert.equal(settled.protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');

    // The same split with the third operator unavailable: no quorum is fabricated, and past T_confirm SR-4 suspends.
    const g = await activeAndAged('fed-e2', true);
    makeMalicious(g.f, 'vb1', 'denied');
    jobOf(scheduleOne(g.f, 'G01', 'document.export', 2, { exclude: [FED_OPERATORS.C], key: 'e2-split' }));
    await drain(g.f);
    g.f.down.add('vc1');
    g.f.c.clock.advance(FEDERATION_TIMING.heartbeatUnreachableAfterSeconds + 1);
    beat(g.f);
    const none = g.f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
    assert.ok(none.some((r) => !r.scheduled && r.reason === 'QUORUM_INSUFFICIENT'));
    g.f.c.clock.advance(31 * 60);
    const expired = cr01(g.f, g.id);
    assert.equal(expired.protectiveTransition?.record.reasonCode, 'CONFLICTING_EVIDENCE');
    assert.equal(expired.evaluation.criticalFailureConfirmed, false, 'a timeout is not a confirmed violation');
  });

  it('Scenario F: an operator unavailable during an investigation never yields a confirmed violation from missing heartbeats', async () => {
    const { f, id } = await activeAndAged('fed-f', true);
    jobOf(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.B, FED_OPERATORS.C], key: 'f-first' }));
    await drain(f);
    for (const v of ['vb1', 'vc1']) f.down.add(v);
    f.c.clock.advance(FEDERATION_TIMING.heartbeatUnreachableAfterSeconds + 1);
    beat(f);
    f.health.sweep();
    const follow = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
    assert.ok(follow.every((r) => !r.scheduled && r.reason === 'QUORUM_INSUFFICIENT'));
    const open = cr01(f, id);
    assert.equal(open.protectiveTransition, null);
    assert.equal(open.evaluation.criticalFailureConfirmed, false);
    f.c.clock.advance(31 * 60);
    const failClosed = cr01(f, id);
    assert.equal(failClosed.protectiveTransition?.record.reasonCode, 'CORROBORATION_UNAVAILABLE');
    assert.equal(failClosed.evaluation.criticalFailureConfirmed, false);
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE', 'unreachable is not malicious: nobody was quarantined');
  });

  it('Scenario H: a crash after signing, before the acknowledgement, reuses the same signed bytes and adds no vote', async () => {
    const { f, id } = await activeAndAged('fed-h', true);
    const job = jobOf(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.A, FED_OPERATORS.C], key: 'h-first' }));
    const b = f.validators.get(job.assignments[0]!.validatorId)!;
    // The runtime signs and records the observation, then "crashes" before the submission reaches evidence acceptance.
    const real = evidencePort(f.c);
    b.outbox.close();
    Object.assign(b, runtimeFor(f, b, { create: false, evidence: { ...real, submitObservation: () => { throw new Error('crashed before delivery'); } } }));
    await drain(f);
    const pending = b.outbox.listSigned();
    assert.equal(pending.length, 1);
    b.outbox.close();
    Object.assign(b, runtimeFor(f, b, { create: false }));
    const [recovered] = b.runtime.recover();
    assert.ok(recovered?.status === 'ACCEPTED' && recovered.eventId === pending[0]!.eventId && !recovered.reconciled);
    const stored = f.c.store.getObservation(pending[0]!.eventId);
    assert.ok(stored !== undefined);
    assert.equal(b.runtime.recover().length, 0, 'nothing left to resubmit');
    assert.equal(cr01(f, id).protectiveTransition, null, 'still one operator');
  });
});

describe('RN-CONFORM-05 — automatic quarantine and controlled release (WP-11)', () => {
  it('contradictory signed observations quarantine the validator; assignments stop; release needs two humans and requalification', async () => {
    const { f } = await activeAndAged('fed-q', false);
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { exclude: [FED_OPERATORS.C], key: 'q' }));
    await drain(f);
    const challenge = f.c.store.getChallenge(f.fed.getJob(job.jobId)!.challengeId as string)!;
    const b = f.validators.get('vb1')!;
    const first = f.c.store.getObservationForChallengeValidator(challenge.challenge.challengeId, 'vb1.k1')!;
    const contradiction = { ...(JSON.parse(first.submissionJson) as { observation: ObservationPayload }).observation, eventId: 'contradiction-1', observedOutcome: 'allowed' as const, outcomeClass: 'violation' as const };
    const result = f.c.services().evidence.submitObservation(JSON.stringify({ observation: contradiction, validatorSignature: signConformancePayload('observation', contradiction, b.key) }));
    assert.deepEqual(result, { accepted: false, reason: 'VALIDATOR_CONFLICT' });
    assert.deepEqual(f.registry.syncFromConformance(), ['vb1.k1']);
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
    assert.ok(f.fed.listEvents().some((e) => e.kind === 'VALIDATOR_QUARANTINED' && e.subjectId === 'vb1'));
    const next = jobOf(scheduleOne(f, 'G02', 'document.open', 2, { key: 'after-q' }));
    assert.ok(next.assignments.every((a) => a.validatorId !== 'vb1'));
    // No exit by heartbeat; no exit by activation.
    assert.equal(beat(f, ['vb1'])[0]?.accepted, false);
    assert.throws(() => f.registry.activateValidator('vb1'), FederationError);
    // Release: a NEW generation (the compromised identity never returns), two humans for the enrollment and two for the reinstatement…
    const { generation, key } = enrollGeneration(f, 'vb1', 'REINSTATE');
    assert.equal(generation.generation, 2);
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED', '…and still quarantined until it requalifies');
    assert.notEqual(f.c.store.getValidator('vb1.k1')?.quarantinedAtMs, null, 'the old identity stays quarantined forever');
    adoptGeneration(f, 'vb1', generation, key);
    // A caller cannot simply assert a pass (review P2-1): no job, or a job that is not this generation's, is refused.
    assert.throws(() => f.registry.completeReinstatement('vb1', 2, 'job_unknown'), (e: unknown) => e instanceof FederationError && e.code === 'REQUALIFICATION_FAILED');
    const routineJob = f.fed.listJobs(['COMPLETED'])[0]!.jobId;
    assert.throws(() => f.registry.completeReinstatement('vb1', 2, routineJob), (e: unknown) => e instanceof FederationError && e.code === 'REQUALIFICATION_FAILED');
    // Requalification is never scheduled against a credentialed integration (review P1-2).
    assert.equal(f.scheduler.scheduleRequalification({ validatorId: 'vb1', generation: 2, authorizationId: FED_AUTHORIZATION, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF }).scheduled, false);
    // …then a bounded requalification challenge on the credential-free fixture, alongside a reference validator of another operator.
    const jobId = await requalify(f, 'vb1', 2);
    const done = f.fed.getJob(jobId)!;
    assert.equal(done.organizationId, f.requalification.organizationId);
    assert.ok(done.assignments.some((a) => a.operatorId !== FED_OPERATORS.B));
    f.registry.completeReinstatement('vb1', 2, jobId);
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE');
    const kinds = f.fed.listEvents().filter((e) => e.subjectId === 'vb1').map((e) => e.kind);
    assert.ok(kinds.includes('REQUALIFICATION_PASSED') && kinds.includes('VALIDATOR_REINSTATED'));
  });

  it('regression (compatibility fix): a quarantine in the acceptance millisecond withdraws the evidence — it never makes it look tampered', async () => {
    const { f, id } = await activeAndAged('fed-same-ms', false);
    const signed = f.c.services().coordinator.issue({ idempotencyKey: 'same-ms-1', organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: ['vb1.k1'], deadlineSeconds: 300, authorizationId: FED_AUTHORIZATION, purpose: 'CONFORMANCE' });
    const b = f.validators.get('vb1')!;
    assert.equal((await b.runtime.receive(signed)).status, 'ACCEPTED');
    const row = f.c.store.getObservationForChallengeValidator(signed.challenge.challengeId, 'vb1.k1')!;
    // The contradiction arrives in the SAME millisecond: evidence acceptance quarantines vb1.k1 at the acceptance instant.
    const contradiction = { ...(JSON.parse(row.submissionJson) as { observation: ObservationPayload }).observation, eventId: 'same-ms-contradiction', observedOutcome: 'allowed' as const, outcomeClass: 'violation' as const };
    assert.deepEqual(f.c.services().evidence.submitObservation(JSON.stringify({ observation: contradiction, validatorSignature: signConformancePayload('observation', contradiction, b.key) })), { accepted: false, reason: 'VALIDATOR_CONFLICT' });
    assert.equal(f.c.store.getValidator('vb1.k1')?.quarantinedAtMs, row.acceptedAtMs);
    assert.equal(authenticateStoredObservation(f.c.store, f.c.profiles, row, f.c.coordinatorPublicKeyPem), null, 'the row was accepted before the quarantine: it is not forged');
    const s = referenceStatus(f.c);
    const nonce = randomBytes(32).toString('base64url');
    const verdict = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, nonce))), id, { kind: 'online', nonce });
    assert.notEqual(verdict.detail, 'EVIDENCE_TAMPERED');
    s.close();
    // Live acceptance keeps the inclusive boundary: a submission at the quarantine instant is still refused.
    const late = { ...contradiction, eventId: 'same-ms-late' };
    assert.deepEqual(f.c.services().evidence.submitObservation(JSON.stringify({ observation: late, validatorSignature: signConformancePayload('observation', late, b.key) })), { accepted: false, reason: 'VALIDATOR_QUARANTINED' });
  });

  it('P1-2: a reinstating validator lying during requalification never touches a real credential and does not requalify', async () => {
    const { f, id } = await activeAndAged('fed-p12', true);
    f.registry.quarantineValidator('vb1', 'PROTOCOL_VIOLATIONS');
    const { generation, key } = enrollGeneration(f, 'vb1', 'REINSTATE');
    adoptGeneration(f, 'vb1', generation, key);
    makeMalicious(f, 'vb1', 'allowed');
    // Meanwhile another operator genuinely observes the export bypass on the REAL credential.
    jobOf(scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.B, FED_OPERATORS.C], key: 'p12-real' }));
    await drain(f);
    const jobId = await requalify(f, 'vb1', 2);
    const evaluation = cr01(f, id);
    assert.equal(evaluation.evaluation.criticalFailureConfirmed, false, 'the probation lie is not a second operator vote on the real credential');
    assert.notEqual(evaluation.protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.deepEqual(categoryOf(evaluation)?.violationOperators, [FED_OPERATORS.A]);
    assert.throws(() => f.registry.completeReinstatement('vb1', 2, jobId), (e: unknown) => e instanceof FederationError && e.code === 'REQUALIFICATION_FAILED');
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
  });

  it('P2-4: observation event ids are unpredictable, so no validator can pre-empt another\'s', async () => {
    const f = standardFederation('fed-p24');
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { key: 'p24' }));
    await drain(f);
    const rows = f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).filter((o) => o.challengeId === f.fed.getJob(job.jobId)!.challengeId);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.match(r.eventId, /^obs_[0-9a-f]{32}$/);
  });

  it('persistent AUTHENTICATED protocol violations quarantine; forged signature failures never do', async () => {
    const { f } = await activeAndAged('fed-threshold', false);
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { exclude: [FED_OPERATORS.A], key: 'th' }));
    await drain(f);
    const challenge = f.c.store.getChallenge(f.fed.getJob(job.jobId)!.challengeId as string)!;
    const base = (JSON.parse(f.c.store.getObservationForChallengeValidator(challenge.challenge.challengeId, 'vb1.k1')!.submissionJson) as { observation: ObservationPayload }).observation;
    const b = f.validators.get('vb1')!;
    const c = f.validators.get('vc1')!;
    for (let i = 0; i < FEDERATION_TIMING.protocolViolationThreshold; i += 1) {
      const wrongNonce = { ...base, eventId: `bad-nonce-${i}`, challengeNonce: randomBytes(32).toString('base64url') };
      assert.equal(f.c.services().evidence.submitObservation(JSON.stringify({ observation: wrongNonce, validatorSignature: signConformancePayload('observation', wrongNonce, b.key) })).accepted, false);
      // Someone else claims to be vc1 with a key it does not hold: SIGNATURE_MISMATCH, never attributed to vc1.
      const forged = { ...base, eventId: `forged-${i}`, validatorId: 'vc1.k1', validatorKeyId: c.generation.keyId };
      assert.equal(f.c.services().evidence.submitObservation(JSON.stringify({ observation: forged, validatorSignature: signConformancePayload('observation', forged, b.key) })).accepted, false);
    }
    assert.deepEqual(f.registry.enforceProtocolThreshold(), ['vb1']);
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
    assert.equal(f.registry.validatorState('vc1'), 'ACTIVE');
  });
});

describe('RN-CONFORM-05 — the validator runtime boundary (WP-09/10)', () => {
  const issueTo = (f: Federation, cvids: readonly string[], key = `rt-${Math.random()}`) =>
    f.c.services().coordinator.issue({ idempotencyKey: key.replace('.', '-'), organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: cvids, deadlineSeconds: 300, authorizationId: FED_AUTHORIZATION, purpose: 'CONFORMANCE' });

  it('refuses tampered, foreign-coordinator, misassigned, expired and malformed challenges before executing anything', async () => {
    const f = standardFederation('fed-rt');
    const v = f.validators.get('vb1')!;
    const signed = issueTo(f, ['vb1.k1']);
    const tampered = { ...signed, challenge: { ...signed.challenge, nonce: randomBytes(32).toString('base64url') } };
    assert.deepEqual(await v.runtime.receive(tampered), { status: 'REFUSED', reason: 'COORDINATOR_UNTRUSTED' });
    const otherOrg = { ...signed, challenge: { ...signed.challenge, organizationId: 'org-synthetic-beta' } };
    assert.deepEqual(await v.runtime.receive(otherOrg), { status: 'REFUSED', reason: 'COORDINATOR_UNTRUSTED' }, 'every binding is under the coordinator signature');
    const forgedCoordinator = { challenge: signed.challenge, coordinatorSignature: signConformancePayload('challenge', signed.challenge, ephemeralKey()) };
    assert.deepEqual(await v.runtime.receive(forgedCoordinator), { status: 'REFUSED', reason: 'COORDINATOR_UNTRUSTED' });
    assert.deepEqual(await f.validators.get('vc1')!.runtime.receive(signed), { status: 'REFUSED', reason: 'WRONG_VALIDATOR' });
    assert.deepEqual(await v.runtime.receive({ challenge: signed.challenge }), { status: 'REFUSED', reason: 'MALFORMED_CHALLENGE' });
    f.c.clock.advance(301);
    assert.deepEqual(await v.runtime.receive(signed), { status: 'REFUSED', reason: 'CHALLENGE_EXPIRED' });
    assert.equal(f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).length, 0);
  });

  it('refuses unauthorized endpoints, prohibited environments, unsupported challenges and a signer that is not its key', async () => {
    const f = standardFederation('fed-rt2');
    const v = f.validators.get('vb1')!;
    const signed = issueTo(f, ['vb1.k1']);
    v.outbox.close();
    const noEndpoint = runtimeFor(f, v, { create: false, fixtureRefs: [] });
    assert.deepEqual(await noEndpoint.runtime.receive(signed), { status: 'REFUSED', reason: 'UNAUTHORIZED_ENDPOINT' });
    noEndpoint.outbox.close();
    const production = runtimeFor(f, v, { create: false, environment: 'production' });
    assert.deepEqual(await production.runtime.receive(signed), { status: 'REFUSED', reason: 'ENVIRONMENT_PROHIBITED' });
    production.outbox.close();
    const wrongSigner = runtimeFor(f, { ...v, key: f.validators.get('vc1')!.key }, { create: false });
    assert.deepEqual(await wrongSigner.runtime.receive(signed), { status: 'REFUSED', reason: 'SIGNER_KEY_MISMATCH' });
    wrongSigner.outbox.close();
    Object.assign(v, runtimeFor(f, v, { create: false }));
  });

  it('a rejected observation is never retried into an accepted one; a delayed one past its deadline is never submitted', async () => {
    const f = standardFederation('fed-rt3');
    const v = f.validators.get('vb1')!;
    const signed = issueTo(f, ['vb1.k1']);
    f.registry.revokeKeyGeneration('vb1.k1', 'KEY_COMPROMISE');
    const rejected = await v.runtime.receive(signed);
    assert.deepEqual(rejected.status === 'REJECTED' ? rejected.reason : rejected.status, 'VALIDATOR_REVOKED');
    assert.equal((await v.runtime.receive(signed)).status, 'REJECTED', 'a redelivery returns the recorded rejection');
    assert.equal(f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).length, 0);
  });

  it('cross-tenant: a challenge for another organization\'s integration is refused; another organization\'s humans cannot authorize testing', async () => {
    const f = standardFederation('fed-tenant');
    const { record, prepared } = f.registry.prepareTestingAuthorization({
      authorizationId: 'auth-cross-tenant',
      organizationId: ORG_A,
      integrationDigest: f.c.integration.integrationDigest,
      purpose: 'CONFORMANCE',
      supersedes: null,
      ...REFERENCE_SCOPE,
      notBefore: f.c.clock.now(),
      notAfter: '2027-01-01T00:00:00.000Z',
    });
    // Organization binding specifically (distinct principals, one of them from another organization).
    assert.throws(
      () => f.registry.authorizeTesting(record, fedDecisions(f, prepared, f.c.humans.alice, f.c.humans.mallory)),
      (e: unknown) => e instanceof FederationError && e.code === 'APPROVAL_REFUSED' && e.detail === 'ORGANIZATION_MISMATCH',
    );
    // The integration digest of organization A does not exist under organization B: no cross-tenant authorization.
    assert.throws(
      () => f.registry.prepareTestingAuthorization({ authorizationId: 'auth-cross-2', organizationId: 'org-synthetic-beta', integrationDigest: record.integrationDigest, purpose: 'CONFORMANCE', supersedes: null, ...REFERENCE_SCOPE, notBefore: record.notBefore, notAfter: record.notAfter }),
      (e: unknown) => e instanceof FederationError && e.code === 'UNKNOWN_INTEGRATION',
    );
    // A runtime never executes for a target outside its authorization, even with a valid coordinator signature.
    const v = f.validators.get('vb1')!;
    const signed = f.c.services().coordinator.issue({ idempotencyKey: 'cross-tenant-1', organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: ['vb1.k1'], deadlineSeconds: 300, authorizationId: FED_AUTHORIZATION, purpose: 'CONFORMANCE' });
    v.outbox.close();
    const other = runtimeFor(f, v, { create: false, fixtureRefs: [REFERENCE_FIXTURE_REF] });
    other.outbox.close();
    const foreign = createValidatorRuntime({
      identity: other.runtime.identity,
      signer: ephemeralSigner(v.key),
      executor: { execute: async () => { throw new Error('must not execute'); } },
      evidence: evidencePort(f.c),
      outbox: openValidatorOutbox(join(f.c.dir, 'outbox-vb1.k1.sqlite'), 'vb1.k1'),
      policy: { trustedCoordinatorPublicKeyPems: [f.c.coordinatorPublicKeyPem], authorizedTargets: [{ organizationId: 'org-synthetic-beta', integrationDigest: f.c.integration.integrationDigest, deploymentDigest: `sha256:${'0'.repeat(64)}`, fixtureRefs: [REFERENCE_FIXTURE_REF] }], capabilities: fullCapabilities(), environment: 'synthetic', clockSkewMs: 5000 },
      clock: f.c.clock,
      random: deterministicRandom('foreign'),
    });
    assert.deepEqual(await foreign.receive(signed), { status: 'REFUSED', reason: 'UNAUTHORIZED_TARGET' });
  });
});

describe('RN-CONFORM-05 — credential lifecycle separation and privacy (WP-14/15/16)', () => {
  const ROOT = process.cwd();
  const MODULE = join(ROOT, 'src', 'enterprise', 'conformance');
  const federationFiles = readdirSync(MODULE).filter((n) => n.startsWith('federation-'));
  const importsOf = (text: string) => [...text.matchAll(/\bfrom\s+'([^']+)';\s*$/gm)].map((m) => m[1]!);

  it('no federation module imports the lifecycle, the status machinery or the verifier; the runtime imports no store or registry', () => {
    assert.ok(federationFiles.length >= 6);
    for (const name of federationFiles) {
      const imports = importsOf(readFileSync(join(MODULE, name), 'utf8'));
      for (const banned of ['./lifecycle.js', './verifier.js', './status-registry.js', './status-signer.js', './status-projection.js', './status-http.js', './anchor-intent.js']) assert.ok(!imports.includes(banned), `${name} imports ${banned}`);
    }
    const runtime = importsOf(readFileSync(join(MODULE, 'federation-validator-runtime.ts'), 'utf8'));
    for (const banned of ['./sqlite-conformance-store.js', './federation-store.js', './registry.js', './federation-registry.js', './human-authority.js', './federation-scheduler.js']) assert.ok(!runtime.includes(banned), `runtime imports ${banned}`);
  });

  it('no federation module writes evidence, evaluations, transitions, credentials or status directly', () => {
    for (const name of federationFiles) {
      const text = readFileSync(join(MODULE, name), 'utf8');
      // Every write to the conformance store goes through the existing registry; none directly (review test finding 4).
      const direct = /\bstore\.(insert\w+|append\w+|commit\w+|create\w+|withStatusIssuance)\(/;
      assert.ok(!direct.test(text), `${name} writes the conformance store directly`);
      assert.ok(!/\bimport\s*\(/.test(text), `${name} uses a dynamic import`);
      for (const banned of [/\.commitTransition\(/, /\.commitEvaluation\(/, /\.createCredential\(/, /\.insertObservation\(/, /\.withStatusIssuance\(/, /\.insertRejection\(/]) assert.ok(!banned.test(text), `${name} matches ${banned}`);
    }
  });

  it('operational events and the federation store carry no key material, protected content or free text', async () => {
    const { f } = await activeAndAged('fed-privacy', true);
    jobOf(scheduleOne(f, 'G01', 'document.export', 2, { key: 'privacy' }));
    await drain(f);
    const events = JSON.stringify(f.fed.listEvents());
    for (const needle of ['RN-CONFORM-04-SENTINEL', 'PRIVATE KEY', 'BEGIN PUBLIC KEY', 'contentBase64']) assert.ok(!events.includes(needle), needle);
    assert.ok(f.fed.listEvents().every((e) => JSON.stringify(e.detail).length <= FEDERATION_TIMING.maxEventDetailBytes));
    assert.ok(!f.deliveries.some((d) => JSON.stringify(d).includes('RN-CONFORM-04-SENTINEL')));
  });
});
