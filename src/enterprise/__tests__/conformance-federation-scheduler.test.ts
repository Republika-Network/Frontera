import assert from 'node:assert/strict';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { FEDERATION_TIMING, type JobAssignment, type ScheduledJob } from '../conformance/federation-contracts.js';
import { backoffMs } from '../conformance/federation-scheduler.js';
import { FederationStoreError } from '../conformance/federation-store.js';
import { signConformancePayload } from '../conformance/signing.js';
import { ORG_A, deterministicRandom } from './conformance-support.js';
import { REFERENCE_FIXTURE_REF } from './conformance-reference-pep.js';
import { cleanupReferenceCircuits } from './conformance-reference-support.js';
import { FED_AUTHORIZATION, FED_OPERATORS, beat, drain, evidencePort, fedDecisions, runtimeFor, scheduleOne, standardFederation, type FederatedValidator, type Federation } from './conformance-federation-support.js';

/**
 * RN-CONFORM-05 — WP-05/06/07/08/17: heartbeats and health, the durable scheduler, leases and fencing, operator-aware
 * assignment, and the failure / recovery cases F-01…F-11 against the real SQLite stores.
 */

after(() => cleanupReferenceCircuits());

const jobOf = (r: ReturnType<typeof scheduleOne>): ScheduledJob => {
  if (!r.scheduled) throw new Error(`not scheduled: ${r.reason}`);
  return r.job;
};
const operatorsOf = (job: ScheduledJob) => job.assignments.map((a: JobAssignment) => a.operatorId).sort();
const observationsFor = (f: Federation, challengeId: string) => f.c.store.listObservations(ORG_A, f.c.integration.integrationDigest).filter((o) => o.challengeId === challengeId);

function signedHeartbeat(f: Federation, v: FederatedValidator, overrides: Record<string, unknown> = {}, key = v.key) {
  const base = v.runtime.heartbeat(v.sessionId as string).heartbeat;
  const heartbeat = { ...base, ...overrides };
  return { heartbeat, signature: signConformancePayload('validatorHeartbeat', heartbeat, key) };
}

describe('RN-CONFORM-05 — signed heartbeats and health (WP-05)', () => {
  it('accepts a session-bound, monotonic, signed heartbeat; an identical redelivery is idempotent', () => {
    const f = standardFederation();
    const v = f.validators.get('vb1')!;
    assert.equal(f.health.health('vb1'), 'HEALTHY');
    const hb = v.runtime.heartbeat(v.sessionId as string);
    assert.deepEqual(f.health.acceptHeartbeat(hb), { accepted: true, duplicate: false });
    assert.deepEqual(f.health.acceptHeartbeat(hb), { accepted: true, duplicate: true });
  });

  it('refuses replayed, older, equivocating, future-dated, stale and clock-rolled-back heartbeats', () => {
    const f = standardFederation();
    const v = f.validators.get('vb1')!;
    const first = v.runtime.heartbeat(v.sessionId as string);
    assert.equal(f.health.acceptHeartbeat(first).accepted, true);
    // Same sequence, different content: equivocation, recorded as an attributable violation.
    const equivocal = { heartbeat: { ...first.heartbeat, operationalState: 'DRAINING' as const }, signature: signConformancePayload('validatorHeartbeat', { ...first.heartbeat, operationalState: 'DRAINING' }, v.key) };
    assert.deepEqual(f.health.acceptHeartbeat(equivocal), { accepted: false, reason: 'EQUIVOCATION' });
    assert.equal(f.fed.countViolations('vb1.k1', 0), 1);
    const second = v.runtime.heartbeat(v.sessionId as string);
    assert.equal(f.health.acceptHeartbeat(second).accepted, true);
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { sequence: first.heartbeat.sequence })), { accepted: false, reason: 'SEQUENCE_REPLAYED' });
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { sequence: 1 })).accepted, false);
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { emittedAt: new Date(f.c.clock.ms() + 60_000).toISOString() })), { accepted: false, reason: 'FUTURE_DATED' });
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { emittedAt: new Date(f.c.clock.ms() - 10 * 60_000).toISOString() })), { accepted: false, reason: 'STALE_HEARTBEAT' });
    f.c.clock.advance(30);
    const third = v.runtime.heartbeat(v.sessionId as string);
    assert.equal(f.health.acceptHeartbeat(third).accepted, true);
    // A higher sequence whose emission time goes backwards (the validator's clock was rolled back).
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { sequence: third.heartbeat.sequence + 5, emittedAt: new Date(f.c.clock.ms() - 20_000).toISOString() })), { accepted: false, reason: 'CLOCK_ROLLBACK' });
  });

  it('refuses forged signatures, foreign sessions, forged operators, forged capabilities, revoked keys and quarantined validators', () => {
    const f = standardFederation();
    const v = f.validators.get('vb1')!;
    const other = f.validators.get('vc1')!;
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, {}, other.key)), { accepted: false, reason: 'SIGNATURE_INVALID' });
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { sessionId: other.sessionId })), { accepted: false, reason: 'SESSION_MISMATCH' });
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { operatorId: FED_OPERATORS.C })), { accepted: false, reason: 'OPERATOR_MISMATCH' });
    assert.deepEqual(f.health.acceptHeartbeat(signedHeartbeat(f, v, { capabilities: { challengeTypes: ['G01'], profiles: v.runtime.heartbeat(v.sessionId as string).heartbeat.capabilities.profiles } })), {
      accepted: false,
      reason: 'CAPABILITY_MISMATCH',
    });
    assert.deepEqual(f.health.acceptHeartbeat({ heartbeat: { nonsense: true }, signature: null }), { accepted: false, reason: 'MALFORMED_HEARTBEAT' });
    f.registry.revokeKeyGeneration('vc1.k1', 'KEY_COMPROMISE');
    assert.deepEqual(beat(f, ['vc1']), [{ accepted: false, reason: 'KEY_NOT_ELIGIBLE' }]);
    f.registry.quarantineValidator('vb1', 'PROTOCOL_VIOLATIONS');
    assert.deepEqual(beat(f, ['vb1']), [{ accepted: false, reason: 'VALIDATOR_QUARANTINED' }]);
    assert.equal(f.health.health('vb1'), 'QUARANTINED', 'a quarantined validator never reports HEALTHY');
  });

  it('missing heartbeats degrade, then make a validator UNREACHABLE (once-per-gap event) — never quarantine or revoke it', () => {
    const f = standardFederation();
    f.c.clock.advance(FEDERATION_TIMING.heartbeatDegradedAfterSeconds + 1);
    assert.equal(f.health.health('vb1'), 'DEGRADED');
    f.c.clock.advance(FEDERATION_TIMING.heartbeatUnreachableAfterSeconds);
    assert.equal(f.health.health('vb1'), 'UNREACHABLE');
    const missed = f.health.sweep();
    assert.ok(missed.includes('vb1'));
    assert.deepEqual(f.health.sweep(), [], 'one HEARTBEAT_MISSED per gap');
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE');
    beat(f, ['vb1']);
    assert.equal(f.health.health('vb1'), 'HEALTHY');
  });
});

describe('RN-CONFORM-05 — operator-aware assignment (WP-08)', () => {
  it('assigns one validator per distinct operator and never fabricates quorum', () => {
    const f = standardFederation();
    const two = jobOf(scheduleOne(f, 'G01', 'document.export', 2));
    assert.equal(new Set(operatorsOf(two)).size, 2);
    const three = jobOf(scheduleOne(f, 'G01', 'document.open', 3));
    assert.deepEqual(operatorsOf(three), [FED_OPERATORS.A, FED_OPERATORS.B, FED_OPERATORS.C]);
    // Operator A has three validators; that never makes four operators.
    const four = scheduleOne(f, 'G05', 'document.open', 4);
    assert.deepEqual(four, { scheduled: false, reason: 'QUORUM_INSUFFICIENT', availableOperators: 3 });
    assert.ok(f.fed.listEvents().some((e) => e.kind === 'QUORUM_INSUFFICIENT'));
    // A dispute that needs an operator other than A and B, with C unavailable, cannot be served by A2 or A3.
    f.down.add('vc1');
    f.c.clock.advance(FEDERATION_TIMING.heartbeatUnreachableAfterSeconds + 1);
    beat(f);
    assert.equal(f.health.health('vc1'), 'UNREACHABLE');
    assert.deepEqual(scheduleOne(f, 'G01', 'document.export', 1, { purpose: 'DISPUTE', exclude: [FED_OPERATORS.A, FED_OPERATORS.B] }), { scheduled: false, reason: 'QUORUM_INSUFFICIENT', availableOperators: 0 });
  });

  it('skips quarantined, revoked, unhealthy and incapable validators; prefers the least-loaded one of an operator', () => {
    const f = standardFederation();
    f.registry.quarantineValidator('va1', 'PROTOCOL_VIOLATIONS');
    for (let i = 0; i < 4; i += 1) {
      const job = jobOf(scheduleOne(f, 'G02', 'document.open', 3, { key: `load-${i}` }));
      assert.ok(!job.assignments.some((a) => a.validatorId === 'va1'), 'quarantined never assigned');
    }
    const loads = new Map<string, number>();
    for (const job of f.fed.listJobs()) for (const a of job.assignments) loads.set(a.validatorId, (loads.get(a.validatorId) ?? 0) + 1);
    assert.deepEqual([loads.get('va2'), loads.get('va3')], [2, 2], 'operator A work spread across its eligible validators');
  });

  it('selection is reproducible from the injected random source', () => {
    const pick = (seed: string) => {
      const f = standardFederation(seed);
      return jobOf(scheduleOne(f, 'G01', 'document.open', 3, { key: 'fixed' })).assignments.map((a) => a.validatorId).sort();
    };
    assert.deepEqual(pick('seed-x'), pick('seed-x'));
  });

  it('nothing is scheduled outside the signed testing authorization (unknown, wrong fixture, expired window)', () => {
    const f = standardFederation();
    assert.equal(
      f.scheduler.schedule({ purpose: 'ROUTINE', authorizationId: 'auth-unknown', challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF, requiredOperators: 2, jobKey: 'x1' }).scheduled,
      false,
    );
    assert.equal(
      f.scheduler.schedule({ purpose: 'ROUTINE', authorizationId: FED_AUTHORIZATION, challengeType: 'G01', operation: 'document.open', fixtureRef: 'fixture-production-endpoint', requiredOperators: 2, jobKey: 'x2' }).scheduled,
      false,
    );
    // Authorizing a fixture the integration never registered is refused at the source.
    assert.throws(() =>
      f.registry.prepareTestingAuthorization({ authorizationId: 'auth-bad', organizationId: 'org-synthetic-alpha', integrationDigest: f.c.integration.integrationDigest, fixtureRefs: ['https-customer-tenant'], notBefore: f.c.clock.now(), notAfter: '2027-01-01T00:00:00.000Z' }),
    );
    f.c.clock.advance(31 * 86_400);
    beat(f);
    assert.deepEqual(scheduleOne(f, 'G01', 'document.open', 2, { key: 'late' }), { scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 });
  });

  it('the same logical assignment key yields the same job (idempotent scheduling)', () => {
    const f = standardFederation();
    const a = scheduleOne(f, 'G01', 'document.open', 2, { key: 'same' });
    const b = scheduleOne(f, 'G01', 'document.open', 2, { key: 'same' });
    assert.ok(a.scheduled && b.scheduled && !b.created && a.job.jobId === b.job.jobId);
    assert.equal(f.fed.listJobs().length, 1);
  });
});

describe('RN-CONFORM-05 — durable jobs, leases and fencing (WP-06/07)', () => {
  it('two workers claiming the same job: exactly one lease; the fencing token advances', () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    const w1 = f.worker('w1');
    const w2 = f.worker('w2');
    const l1 = w1.acquire(job.jobId);
    const l2 = w2.acquire(job.jobId);
    assert.ok(l1 !== null && l2 === null);
    assert.equal(l1.fencingToken, 1);
  });

  it('lease expiry during execution: the takeover worker gets a newer token; the stale worker is fenced everywhere', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    const stale = f.worker('w-stale').acquire(job.jobId)!;
    f.c.clock.advance(FEDERATION_TIMING.leaseSeconds + 1);
    const fresh = f.worker('w-fresh').acquire(job.jobId)!;
    assert.equal(fresh.fencingToken, stale.fencingToken + 1);
    assert.throws(() => f.fed.commitWithLease(stale, f.c.clock.ms(), { state: 'COMPLETED' }), (e: unknown) => e instanceof FederationStoreError && e.code === 'FENCED');
    assert.throws(() => f.fed.renewLease(stale, f.c.clock.ms(), 1000), (e: unknown) => e instanceof FederationStoreError && e.code === 'FENCED');
    const staleOutcome = await f.worker('w-stale').processWithLease(stale);
    assert.equal(staleOutcome.outcome, 'FENCED');
    assert.equal(f.deliveries.length, 0, 'the stale worker delivered nothing');
    const freshOutcome = await f.worker('w-fresh').processWithLease(fresh);
    assert.equal(freshOutcome.outcome, 'COMPLETED');
    const done = f.fed.getJob(job.jobId)!;
    assert.equal(done.state, 'COMPLETED');
    assert.equal(observationsFor(f, done.challengeId as string).length, 2);
    // Terminal: nobody can move it again, with any token.
    assert.throws(() => f.fed.closeWithoutLease(job.jobId, f.c.clock.ms(), 'CANCELLED', 'late'), FederationStoreError);
  });

  it('worker crash before dispatch: the lease expires and the job is recovered by another worker, same challenge identity', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    f.worker('w-crashed').acquire(job.jobId);
    f.c.clock.advance(FEDERATION_TIMING.leaseSeconds + 1);
    const outcomes = await f.worker('w-recover').runOnce();
    assert.ok(f.fed.listEvents().some((e) => e.kind === 'LEASE_EXPIRED' && e.subjectId === job.jobId));
    assert.deepEqual(outcomes.map((o) => o.outcome), ['COMPLETED']);
    assert.equal(f.fed.getJob(job.jobId)?.attempts, 1, 'the abandoned lease counts as an attempt');
  });

  it('worker crash after dispatch + lost acknowledgement + coordinator restart: same challenge, same signed bytes, one vote', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { exclude: [FED_OPERATORS.C] }));
    // The B validator's submission commits but its acknowledgement is lost (the port throws after the commit).
    const b = f.validators.get(job.assignments.find((a) => a.operatorId === FED_OPERATORS.B)!.validatorId)!;
    const real = evidencePort(f.c);
    b.outbox.close();
    const lossy = runtimeFor(f, b, { create: false, evidence: { ...real, submitObservation: (raw) => { real.submitObservation(raw); throw new Error('acknowledgement lost'); } } });
    Object.assign(b, lossy);
    const first = await f.worker('w1').runOnce();
    assert.deepEqual(first.map((o) => o.outcome), ['COMPLETED'], 'the store, not the acknowledgement, decides: both observations are committed');
    const challengeId = f.fed.getJob(job.jobId)!.challengeId as string;
    assert.equal(observationsFor(f, challengeId).length, 2);
    // The runtime still thinks it is unacknowledged; on restart it reconciles instead of submitting a second vote.
    b.outbox.close();
    Object.assign(b, runtimeFor(f, b, { create: false }));
    const recovered = b.runtime.recover();
    assert.deepEqual(recovered.map((r) => r.status), ['ACCEPTED']);
    assert.ok(recovered[0]?.status === 'ACCEPTED' && recovered[0].reconciled);
    assert.equal(observationsFor(f, challengeId).length, 2);
    assert.equal(f.c.store.listRejections().filter((r) => r.challengeId === challengeId).length, 0, 'no duplicate submission was even attempted');
    f.restart();
    assert.equal(f.fed.getJob(job.jobId)?.state, 'COMPLETED', 'F-01: the job survives the coordinator restart');
  });

  it('delivery retries keep the challenge identity and deadline; observations after the lease expired still count once', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { exclude: [FED_OPERATORS.C] }));
    const bId = job.assignments.find((a) => a.operatorId === FED_OPERATORS.B)!.validatorId;
    f.down.add(bId);
    const first = await f.worker('w1').runOnce();
    assert.deepEqual(first.map((o) => o.outcome), ['DISPATCHED']);
    const issued = f.fed.getJob(job.jobId)!;
    f.down.delete(bId);
    f.c.clock.advance(FEDERATION_TIMING.backoffBaseSeconds + 1);
    // Partition heals; the next pass redelivers the SAME challenge to B only.
    const second = await f.worker('w2').runOnce();
    assert.deepEqual(second.map((o) => o.outcome), ['COMPLETED']);
    const done = f.fed.getJob(job.jobId)!;
    assert.equal(done.challengeId, issued.challengeId);
    assert.equal(done.challengeDeadlineMs, issued.challengeDeadlineMs, 'a retry never extends the deadline');
    const ids = new Set(f.deliveries.map((d) => d.challengeId));
    assert.equal(ids.size, 1);
    assert.equal(observationsFor(f, done.challengeId as string).length, 2);
    // Redelivering the same challenge directly is harmless: the runtime answers from its outbox.
    const again = await f.validators.get(bId)!.runtime.receive(f.c.store.getChallenge(done.challengeId as string));
    assert.equal(again.status, 'ACCEPTED');
    assert.equal(observationsFor(f, done.challengeId as string).length, 2);
  });

  it('a validator revoked while its job is active loses the assignment; the job closes without fabricating its vote', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2, { exclude: [FED_OPERATORS.C] }));
    const b = job.assignments.find((a) => a.operatorId === FED_OPERATORS.B)!;
    f.down.add(b.validatorId);
    await f.worker('w1').runOnce();
    f.registry.revokeValidator(b.validatorId, fedDecisions(f, f.registry.prepareValidatorAction(b.validatorId, 'revoke')));
    f.down.delete(b.validatorId);
    f.c.clock.advance(FEDERATION_TIMING.backoffBaseSeconds + 1);
    const out = await f.worker('w2').runOnce();
    assert.deepEqual(out.map((o) => o.outcome), ['COMPLETED']);
    const done = f.fed.getJob(job.jobId)!;
    assert.equal(done.lastError, 'ASSIGNMENT_LOST');
    assert.equal(observationsFor(f, done.challengeId as string).length, 1, 'one operator only — no vote was manufactured for the revoked one');
    assert.ok(f.fed.listEvents().some((e) => e.kind === 'QUORUM_INSUFFICIENT' && e.subjectId === job.jobId));
    // Its runtime cannot slip an observation in afterwards: evidence acceptance refuses the revoked key.
    const late = await f.validators.get(b.validatorId)!.runtime.receive(f.c.store.getChallenge(done.challengeId as string));
    assert.deepEqual(late.status === 'REJECTED' ? late.reason : late.status, 'VALIDATOR_REVOKED');
  });

  it('a job whose validator became ineligible before issuance is cancelled, never issued to it', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    f.registry.quarantineValidator(job.assignments[0]!.validatorId, 'PROTOCOL_VIOLATIONS');
    const out = await f.worker('w1').runOnce();
    assert.deepEqual(out.map((o) => o.outcome), ['CANCELLED']);
    assert.equal(f.fed.getJob(job.jobId)?.challengeId, null);
  });

  it('F-08/F-10: a partition ends in bounded retries and FAILED_FINAL or EXPIRED, never in evidence', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    for (const id of f.validators.keys()) f.down.add(id);
    for (let i = 0; i < 12; i += 1) {
      await f.worker('w1').runOnce();
      f.c.clock.advance(FEDERATION_TIMING.backoffMaxSeconds);
    }
    const final = f.fed.getJob(job.jobId)!;
    assert.ok(final.state === 'FAILED_FINAL' || final.state === 'EXPIRED', final.state);
    assert.ok(final.attempts <= FEDERATION_TIMING.maxAttempts);
    assert.equal(observationsFor(f, final.challengeId as string).length, 0);
    for (let n = 1; n < 40; n += 1) assert.ok(backoffMs(n, deterministicRandom('b')) <= (FEDERATION_TIMING.backoffMaxSeconds + FEDERATION_TIMING.jitterMaxSeconds) * 1000);
  });

  it('F-10: the queue is bounded', () => {
    const f = standardFederation();
    const base = jobOf(scheduleOne(f, 'G01', 'document.open', 2));
    for (let i = f.fed.countOpenJobs(); i < FEDERATION_TIMING.maxOpenJobs; i += 1) {
      f.fed.insertJob({ ...base, jobId: `job-fill-${i}`, assignments: base.assignments, nextAttemptMs: f.c.clock.ms() }, f.c.clock.ms());
    }
    assert.throws(() => f.fed.insertJob({ ...base, jobId: 'job-overflow', assignments: base.assignments, nextAttemptMs: f.c.clock.ms() }, f.c.clock.ms()), (e: unknown) => e instanceof FederationStoreError && e.code === 'QUEUE_FULL');
    assert.deepEqual(scheduleOne(f, 'G05', 'document.open', 2, { key: 'overflow' }), { scheduled: false, reason: 'QUEUE_FULL', availableOperators: 0 });
  });

  it('F-11: a clock presented behind the durable high-water mark is refused everywhere', async () => {
    const f = standardFederation();
    scheduleOne(f, 'G01', 'document.open', 2);
    f.c.clock.advance(-10 * 60);
    assert.throws(() => scheduleOne(f, 'G01', 'document.export', 2), (e: unknown) => e instanceof FederationStoreError && e.code === 'CLOCK_REGRESSION');
    assert.deepEqual(beat(f, ['vb1']), [{ accepted: false, reason: 'CLOCK_ROLLBACK' }]);
    await assert.rejects(() => f.worker('w1').runOnce(), (e: unknown) => e instanceof FederationStoreError && e.code === 'CLOCK_REGRESSION');
  });
});

describe('RN-CONFORM-05 — restart, rollback and corruption (WP-17)', () => {
  it('F-01: pending and investigation jobs survive a coordinator restart and are processed afterwards', async () => {
    const f = standardFederation();
    const job = jobOf(scheduleOne(f, 'G01', 'document.export', 2, { purpose: 'INVESTIGATION' }));
    f.restart();
    assert.equal(f.fed.getJob(job.jobId)?.state, 'PENDING');
    const out = await drain(f);
    assert.deepEqual(out.map((o) => o.outcome), ['COMPLETED']);
  });

  it('F-06: a restored older federation store is refused when the sequence is pinned; unpinned, the conformance store still refuses the revoked key', () => {
    const f = standardFederation();
    const path = f.fedPath;
    f.fed.close();
    const snapshot = `${path}.snapshot`;
    copyFileSync(path, snapshot);
    f.restart();
    f.registry.revokeKeyGeneration('vb1.k1', 'KEY_COMPROMISE');
    const pinned = f.fed.stateSeq();
    f.fed.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    copyFileSync(snapshot, path);
    assert.throws(() => f.restart({ expectedMinimumStateSeq: pinned }), (e: unknown) => e instanceof FederationStoreError && e.code === 'ROLLBACK_DETECTED');
    f.restart();
    assert.equal(f.fed.generationState('vb1', 1)?.state, 'ACTIVE', 'the rolled-back view still says ACTIVE…');
    assert.deepEqual(f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms()), { eligible: false, reason: 'KEY_REVOKED' }, '…but eligibility re-reads the conformance store');
    f.registry.syncFromConformance();
    assert.equal(f.fed.generationState('vb1', 1)?.state, 'REVOKED');
  });

  it('F-07: a tampered row or trigger is refused, never repaired into an authorized state', () => {
    const f = standardFederation();
    const path = f.fedPath;
    f.fed.close();
    const raw = new Database(path);
    const trigger = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'fed_operators_no_update'").get() as { sql: string }).sql;
    raw.exec('DROP TRIGGER fed_operators_no_update');
    const row = raw.prepare('SELECT record_json FROM fed_operators WHERE operator_id = ?').get(FED_OPERATORS.B) as { record_json: string };
    raw.prepare('UPDATE fed_operators SET record_json = ? WHERE operator_id = ?').run(row.record_json.replace('NOT_VERIFIED', 'VERIFIED_INDEPENDENT'), FED_OPERATORS.B);
    raw.exec(trigger);
    raw.close();
    f.restart();
    assert.throws(() => f.fed.getOperator(FED_OPERATORS.B), (e: unknown) => e instanceof FederationStoreError && e.code === 'CORRUPT');
    f.fed.close();
    const raw2 = new Database(path);
    raw2.exec('DROP TRIGGER fed_jobs_fencing');
    raw2.close();
    assert.throws(() => f.restart(), (e: unknown) => e instanceof FederationStoreError && e.code === 'CORRUPT');
  });
});
