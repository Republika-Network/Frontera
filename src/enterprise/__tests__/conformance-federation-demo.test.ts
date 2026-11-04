import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, describe, it } from 'node:test';

import { DEPLOYMENT_ATTESTATION_OPERATION, type ObservationPayload, type TransitionRecord } from '../conformance/contracts.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { FEDERATION_TIMING } from '../conformance/federation-contracts.js';
import { federationMetrics } from '../conformance/federation-scheduler.js';
import { signConformancePayload } from '../conformance/signing.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ORG_A } from './conformance-support.js';
import { REFERENCE_FIXTURE_REF, REFERENCE_OPERATIONS } from './conformance-reference-pep.js';
import { REFERENCE_CHALLENGES, assertionOf, cleanupReferenceCircuits, referenceApprovals, referenceStatus } from './conformance-reference-support.js';
import {
  FED_AUTHORIZATION,
  FED_OPERATORS,
  activeFederatedCredential,
  addValidator,
  adoptGeneration,
  beat,
  buildFederation,
  drain,
  enrollGeneration,
  requalify,
  runtimeFor,
  scheduleOne,
} from './conformance-federation-support.js';

/**
 * RN-CONFORM-05 / §25 — the reproducible synthetic federation demonstration, as `rn.conformance.federation-demo-report/1`.
 * Written only when `FRONTERA_RN_CONFORM_05_REPORT_OUT` names a path (the CI job uploads it). Every section says whether
 * it was MEASURED (computed by the real stores, engine, lifecycle and status machinery) or is FIXTURE behaviour.
 * SYNTHETIC — two Republika-controlled synthetic operator identities; NOT independent validators; nothing on a network.
 */

after(() => cleanupReferenceCircuits());

describe('RN-CONFORM-05 — reproducible synthetic federation demonstration', () => {
  it('produces the structured federation report', async () => {
    // Stage 1 — operator enrollment (two synthetic operators) and validators with distinct ephemeral Ed25519 keys.
    const f = buildFederation({ seed: 'rn-conform-05-demo', operators: [FED_OPERATORS.A, FED_OPERATORS.B] });
    addValidator(f, 'va1', FED_OPERATORS.A);
    addValidator(f, 'va2', FED_OPERATORS.A);
    addValidator(f, 'vb1', FED_OPERATORS.B);
    const { lifecycle } = f.c.services();
    const metrics = () => federationMetrics({ fed: f.fed, store: f.c.store, registry: f.registry, health: f.health, nowMs: f.c.clock.ms(), organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest });
    const s = referenceStatus(f.c);
    const online = (id: string) => {
      const nonce = randomBytes(32).toString('base64url');
      const v = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, nonce))), id, { kind: 'online', nonce });
      return { result: v.result, state: v.state, stateVersion: v.stateVersion };
    };

    // Stage 2 — healthy operation.
    const heartbeats = beat(f);
    const healthy = metrics();

    // Stages 3–4 — durable scheduling of the full matrix, one validator per operator, execution, two-person issuance.
    const id = await activeFederatedCredential(f);
    const initialStatus = online(id);
    const routineJobs = f.fed.listJobs().length;

    // Stage 5 — the bypass: the export path stops asking for authorization (fixture switch).
    f.c.clock.advance(2 * 3600);
    beat(f);
    f.c.deployment.defects.add('BYPASS-01');
    f.c.deployment.defectOperations.add('document.export');
    scheduleOne(f, 'G01', 'document.export', 1, { exclude: [FED_OPERATORS.B], key: 'demo-first-report' });
    await drain(f);
    const afterFirst = lifecycle.evaluate(ORG_A, id);

    // Stage 6 — corroboration by the second operator (an INVESTIGATION job the scheduler derives from the evidence).
    const followUps = f.scheduler.planFollowUps(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
    await drain(f);
    const confirmed = lifecycle.evaluate(ORG_A, id);

    // Stage 7 — signed status (RN-CONFORM-03, unchanged; no validator touches it).
    const suspendedStatus = online(id);

    // Stage 8 — validator failure: a job is leased by a worker that then crashes; vb1 disappears; its heartbeat expires.
    const pendingJob = scheduleOne(f, 'G02', 'document.open', 2, { key: 'demo-crash-job' });
    assert.ok(pendingJob.scheduled);
    f.worker('worker-crashed').acquire(pendingJob.job.jobId);
    f.down.add('vb1');
    f.c.clock.advance(FEDERATION_TIMING.heartbeatUnreachableAfterSeconds + 1);
    beat(f);
    const missed = f.health.sweep();
    const duringOutage = { vb1: f.health.health('vb1'), capacity: metrics().distinctEligibleOperators, observationsForCrashedJob: f.fed.getJob(pendingJob.job.jobId)?.challengeId === null ? 0 : -1 };
    const noQuorum = scheduleOne(f, 'G05', 'document.open', 2, { key: 'demo-no-quorum' });

    // Stage 9 — recovery: vb1 restarts over its durable outbox; another worker recovers the expired lease.
    const vb1 = f.validators.get('vb1')!;
    vb1.outbox.close();
    Object.assign(vb1, runtimeFor(f, vb1, { create: false }));
    f.down.delete('vb1');
    beat(f);
    const recovered = await f.worker('worker-recovery').runOnce();
    const recoveredJob = f.fed.getJob(pendingJob.job.jobId)!;
    const recoveredObservations = f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).filter((o) => o.challengeId === recoveredJob.challengeId).length;

    // Stage 10 — quarantine: va2 signs two contradictory observations for one challenge.
    const q = f.c.services().coordinator.issue({ idempotencyKey: 'demo-va2-challenge', organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, assignedValidatorIds: ['va2.k1'], deadlineSeconds: 300 });
    const va2 = f.validators.get('va2')!;
    await va2.runtime.receive(q);
    const firstObs = f.c.store.getObservationForChallengeValidator(q.challenge.challengeId, 'va2.k1')!;
    const contradiction = { ...(JSON.parse(firstObs.submissionJson) as { observation: ObservationPayload }).observation, eventId: 'demo-contradiction', observedOutcome: 'allowed' as const, outcomeClass: 'violation' as const };
    const conflict = f.c.services().evidence.submitObservation(JSON.stringify({ observation: contradiction, validatorSignature: signConformancePayload('observation', contradiction, va2.key) }));
    const synced = f.registry.syncFromConformance();
    const afterQuarantine = scheduleOne(f, 'G02', 'document.export', 2, { key: 'demo-after-quarantine' });

    // Stage 11 — authorized key rotation of vb1 (proof of possession + two humans); history stays attributable.
    const before = f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).filter((o) => o.validatorId === 'vb1.k1');
    const rotation = enrollGeneration(f, 'vb1', 'ROTATE');
    adoptGeneration(f, 'vb1', rotation.generation, rotation.key);
    beat(f);
    const historicalDefects = before.map((row) => authenticateStoredObservation(f.c.store, f.c.profiles, row, f.c.coordinatorPublicKeyPem)).filter((d) => d !== null).length;
    const postRotation = scheduleOne(f, 'G06', 'document.open', 2, { key: 'demo-post-rotation' });
    await drain(f);

    // Stage 12a — quarantine release: new generation, two humans (enroll) + two humans (reinstate), requalification.
    const reinstated = enrollGeneration(f, 'va2', 'REINSTATE');
    adoptGeneration(f, 'va2', reinstated.generation, reinstated.key);
    const requalJobId = await requalify(f, 'va2', reinstated.generation.generation);
    const rq = f.fed.getJob(requalJobId)!;
    const cand = f.c.store.getObservationForChallengeValidator(rq.challengeId as string, reinstated.generation.conformanceValidatorId);
    const refA = rq.assignments.find((a) => a.validatorId !== 'va2')!;
    const refObs = f.c.store.getObservationForChallengeValidator(rq.challengeId as string, refA.conformanceValidatorId);
    const requalified = cand !== undefined && refObs !== undefined && cand.outcomeClass === refObs.outcomeClass;
    // The registry derives the result itself from the stored job and evidence (it is not told).
    f.registry.completeReinstatement('va2', reinstated.generation.generation, requalJobId);
    beat(f);

    // Stage 12b — SEPARATELY: the platform is fixed and the credential goes through full critical revalidation + two humans.
    f.c.clock.advance(3600);
    beat(f);
    f.c.deployment.defects.clear();
    f.c.deployment.defectOperations.clear();
    let revalidationJobs = 0;
    for (const type of REFERENCE_CHALLENGES) {
      for (const operation of type === 'G08' ? [DEPLOYMENT_ATTESTATION_OPERATION] : REFERENCE_OPERATIONS) {
        const r = scheduleOne(f, type, operation, 2, { key: `demo-revalidate|${type}|${operation}` });
        assert.ok(r.scheduled, `${type} ${operation}`);
        revalidationJobs += 1;
      }
    }
    await drain(f);
    f.c.clock.advance(1);
    const remediation = { statement: 'document.export routes through the reference PEP again; every critical challenge re-run by two operators.', declaredBy: 'platform-synthetic-alpha', declaredAt: f.c.clock.now() };
    const prep = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation });
    const approvals = referenceApprovals(f.c, prep, f.c.humans.carol, f.c.humans.bob);
    const credentialReinstated = lifecycle.commit(prep, approvals);
    const finalStatus = online(id);
    const history = verifyCredentialHistory(f.c.store, ORG_A, id, { registryPublicKeyPem: f.c.registryPublicKeyPem, humans: f.c.humansDirectory });
    const final = metrics();

    // Stage 13 — the report.
    const events = f.fed.listEvents();
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    const report = {
      schema: 'rn.conformance.federation-demo-report/1',
      designation: 'SYNTHETIC FEDERATION DEMONSTRATION — two Republika-controlled synthetic operator identities; NOT independent validators; NOT a certification.',
      boundaries: { networkUsed: false, fileverseContacted: false, realCustomerData: false, ledgerUsed: false, independentOperators: false, tokenOrRewardMechanism: false, publicValidatorService: false },
      '1_operators': { measured: true, operators: f.fed.listOperators().map((o) => ({ operatorId: o.operatorId, class: o.operatorClass, state: f.registry.operatorState(o.operatorId), designation: o.designation, independenceVerification: o.independenceVerification })) },
      '2_validators': { measured: true, validators: f.fed.listValidators().map((v) => ({ validatorId: v.validatorId, operatorId: v.operatorId, state: f.registry.validatorState(v.validatorId), health: f.health.health(v.validatorId) })) },
      '3_keys': { measured: true, generations: f.fed.listValidators().flatMap((v) => f.fed.listGenerations(v.validatorId).map((g) => ({ identity: g.conformanceValidatorId, keyId: g.keyId, kind: g.enrollmentKind, state: f.fed.generationState(g.validatorId, g.generation)?.state }))), custody: 'ephemeral in-process signer port; no private key in any store, log or report' },
      '4_heartbeats': { measured: true, initial: heartbeats.map((h) => h.accepted), accepted: count('HEARTBEAT_ACCEPTED'), refused: count('HEARTBEAT_REFUSED'), missed: count('HEARTBEAT_MISSED') },
      '5_capacity': { measured: true, healthy: { eligibleValidators: healthy.eligibleValidators, distinctEligibleOperators: healthy.distinctEligibleOperators, corroborationAvailable: healthy.corroborationAvailable } },
      '6_scheduling': { measured: true, routineJobs, revalidationJobs, jobStates: Object.fromEntries(['COMPLETED', 'EXPIRED', 'FAILED_FINAL', 'CANCELLED', 'PENDING', 'RETRY_PENDING', 'DISPATCHED', 'LEASED'].map((st) => [st, f.fed.listJobs([st as never]).length])) },
      '7_observations': { measured: true, accepted: final.observationsAccepted, rejected: final.observationsRejected },
      '8_bypassAndInvestigation': {
        measured: true,
        fixtureSwitch: { measured: false, variant: 'BYPASS-01', operation: 'document.export' },
        afterFirstOperator: { category: afterFirst.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, transition: afterFirst.protectiveTransition === null ? null : 'unexpected' },
        investigationScheduled: followUps.filter((r) => r.scheduled).length,
        afterSecondOperator: { violationOperators: confirmed.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.violationOperators, criticalFailureConfirmed: confirmed.evaluation.criticalFailureConfirmed },
      },
      '9_credentialTransitions': { measured: true, suspension: confirmed.protectiveTransition === null ? null : { code: confirmed.protectiveTransition.record.transitionCode, reasonCode: confirmed.protectiveTransition.record.reasonCode, humans: confirmed.protectiveTransition.record.humanDecisions.length }, reinstated: { state: credentialReinstated.state, stateVersion: credentialReinstated.stateVersion, approvers: approvals.map((d) => d.decision.principalId) } },
      '10_signedStatus': { measured: true, initial: initialStatus, suspended: suspendedStatus, final: finalStatus, issuedBy: 'RN-CONFORM-03 status signer (no validator involvement)' },
      '11_failureAndRecovery': { measured: true, missedHeartbeats: missed, duringOutage, quorumWithoutB: noQuorum.scheduled ? 'unexpected' : noQuorum.reason, recovered: recovered.map((o) => o.outcome), recoveredJobState: recoveredJob.state, recoveredObservations, leaseExpiredEvents: count('LEASE_EXPIRED') },
      '12_quarantine': { measured: true, requalificationTarget: rq.organizationId, conflict: conflict.accepted ? 'unexpected' : conflict.reason, synced, va2State: f.registry.validatorState('va2'), assignedAfterQuarantine: afterQuarantine.scheduled ? afterQuarantine.job.assignments.map((a) => a.validatorId) : [], releasedAfterRequalification: requalified },
      '13_keyRotation': { measured: true, newGeneration: rotation.generation.conformanceValidatorId, historicalObservationsReverified: before.length, historicalDefects, postRotationAssignedTo: postRotation.scheduled ? postRotation.job.assignments.map((a) => a.conformanceValidatorId) : [] },
      '14_verifiedHistory': { measured: true, valid: history.valid, transitions: history.valid ? history.transitions.map((r: TransitionRecord) => `${r.stateVersion}:${r.transitionCode}:${r.from ?? '∅'}→${r.to}:${r.reasonCode}`) : [] },
      '15_limitations': {
        measured: false,
        items: [
          'Operators are synthetic labels under Republika control; CC-D-02 (operator agreements, eligibility, independence verification, liability) is not approved.',
          'Corroboration by two synthetic operators demonstrates the mechanism, not organizational independence; collusion of k genuinely separate operators is not prevented by thresholds.',
          'Transport is in-process; no validator network service, authentication or deployment exists.',
          'Timing values are provisional engineering defaults, not SLOs.',
        ],
      },
    };

    // The report's load-bearing claims are asserted, not just printed.
    assert.deepEqual(heartbeats.map((h) => h.accepted), [true, true, true]);
    assert.equal(healthy.distinctEligibleOperators, 2);
    assert.equal(initialStatus.result, 'CONFORMANT');
    assert.equal(afterFirst.protectiveTransition, null);
    assert.equal(confirmed.protectiveTransition?.record.transitionCode, 'T4');
    assert.equal(confirmed.protectiveTransition?.record.humanDecisions.length, 0);
    assert.deepEqual([suspendedStatus.result, suspendedStatus.state], ['NOT_CONFORMANT', 'SUSPENDED']);
    assert.ok(missed.includes('vb1'));
    assert.equal(duringOutage.capacity, 1);
    assert.ok(!noQuorum.scheduled && noQuorum.reason === 'QUORUM_INSUFFICIENT');
    assert.equal(recoveredJob.state, 'COMPLETED');
    assert.equal(recoveredObservations, 2);
    assert.ok(!conflict.accepted && conflict.reason === 'VALIDATOR_CONFLICT');
    assert.deepEqual(synced, ['va2.k1']);
    assert.ok(afterQuarantine.scheduled && !afterQuarantine.job.assignments.some((a) => a.validatorId === 'va2'));
    assert.equal(historicalDefects, 0);
    assert.ok(postRotation.scheduled && postRotation.job.assignments.some((a) => a.conformanceValidatorId === 'vb1.k2'));
    assert.ok(requalified);
    assert.equal(f.registry.validatorState('va2'), 'ACTIVE');
    assert.equal(credentialReinstated.state, 'ACTIVE');
    assert.deepEqual([finalStatus.result, finalStatus.state], ['CONFORMANT', 'ACTIVE']);
    assert.ok(history.valid);
    const text = JSON.stringify(report);
    for (const needle of ['RN-CONFORM-04-SENTINEL', 'PRIVATE KEY', 'BEGIN PUBLIC KEY']) assert.ok(!text.includes(needle), needle);

    const out = process.env['FRONTERA_RN_CONFORM_05_REPORT_OUT'];
    if (out !== undefined && out.length > 0) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      const summary = [
        '# RN-CONFORM-05 synthetic federation demonstration',
        '',
        report.designation,
        '',
        `- Operators: ${report['1_operators'].operators.map((o) => `${o.operatorId} (${o.state}, ${o.independenceVerification})`).join(', ')}`,
        `- Validators: ${report['2_validators'].validators.map((v) => `${v.validatorId}@${v.operatorId} ${v.state}`).join(', ')}`,
        `- Healthy capacity: ${healthy.distinctEligibleOperators} distinct eligible operators`,
        `- Matrix: ${routineJobs} routine jobs, one validator per operator; credential ACTIVE, status ${initialStatus.result}`,
        `- Bypass (fixture) → first operator: ${report['8_bypassAndInvestigation'].afterFirstOperator.category} (no transition) → second operator: automatic ${report['9_credentialTransitions'].suspension?.code} ${report['9_credentialTransitions'].suspension?.reasonCode}`,
        `- Signed status: ${suspendedStatus.result} / ${suspendedStatus.state}`,
        `- Outage: vb1 ${duringOutage.vb1}, capacity ${duringOutage.capacity} operator → ${report['11_failureAndRecovery'].quorumWithoutB}; recovery → job ${recoveredJob.state} with ${recoveredObservations} observations (no duplicate vote)`,
        `- Quarantine: va2 ${report['12_quarantine'].conflict} → quarantined, not assigned; released after two-person reinstatement + requalification`,
        `- Rotation: vb1 → ${rotation.generation.conformanceValidatorId}; ${before.length} historical observations re-verified, ${historicalDefects} defects`,
        `- Credential: revalidated (${revalidationJobs} jobs), reinstated by ${approvals.map((d) => d.decision.principalId).join(' + ')} → ${finalStatus.state}; history ${history.valid ? 'verified' : 'INVALID'}`,
        '',
      ].join('\n');
      writeFileSync(`${out.replace(/\.json$/, '')}.summary.md`, summary);
    }
    s.close();
  });
});
