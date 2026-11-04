import { createHash } from 'node:crypto';

import { CHALLENGE_CATALOGUE, DEPLOYMENT_ATTESTATION_OPERATION, requiredOperations, toMs, type ChallengeType, type SignedChallenge } from './contracts.js';
import { ChallengeCoordinatorError, type ChallengeCoordinator, type RandomSource } from './coordinator.js';
import { FEDERATION_TIMING, TERMINAL_JOB_STATES, type JobAssignment, type JobLease, type JobPurpose, type ScheduledJob } from './federation-contracts.js';
import type { FederationHealth } from './federation-health.js';
import type { FederationRegistry } from './federation-registry.js';
import { FederationStoreError, type FederationStore } from './federation-store.js';
import type { ConformanceProfileRegistry } from './profile.js';
import type { ConformanceStore } from './sqlite-conformance-store.js';

/**
 * RN-CONFORM-05 — the durable challenge scheduler, the dispatch worker and operational metrics.
 *
 * The scheduler decides WHAT to challenge and WHOM to assign; the RN-CONFORM-02 coordinator still issues (signs,
 * nonces, deadlines) every challenge, and evidence acceptance still decides what counts. Assignment is per OPERATOR:
 * one validator per distinct eligible operator, never more operators than exist, and a job that cannot reach its
 * operator quorum is not created (QUORUM_INSUFFICIENT) — capacity is never fabricated.
 *
 * Delivery is at-least-once with idempotency, not exactly-once: the job's id is the coordinator's idempotency key, so
 * every retry and every worker re-obtains the SAME signed challenge (same id, nonce and deadline); the evidence store's
 * (challenge, validator) uniqueness and the validator outbox make a redelivery harmless. Leases carry a fencing token
 * that the store advances on every acquisition; a worker that lost its lease cannot commit, renew or deliver.
 */

export interface ScheduleRequest {
  readonly purpose: JobPurpose;
  readonly authorizationId: string;
  readonly challengeType: ChallengeType;
  readonly operation: string;
  readonly fixtureRef: string;
  readonly requiredOperators: number;
  /** Operators whose observations already exist for this question (investigation / dispute targets OTHER operators). */
  readonly excludeOperators?: readonly string[];
  /** Deterministic identity of the logical assignment (same key → same job). */
  readonly jobKey: string;
}

export type ScheduleResult =
  | { readonly scheduled: true; readonly job: ScheduledJob; readonly created: boolean }
  | { readonly scheduled: false; readonly reason: 'QUORUM_INSUFFICIENT' | 'AUTHORIZATION_INVALID' | 'QUEUE_FULL' | 'CAPABILITY_MISSING'; readonly availableOperators: number };

export interface FederationScheduler {
  schedule(request: ScheduleRequest): ScheduleResult;
  /** Assigns a REQUALIFICATION job to a reinstating generation plus one reference validator of another ACTIVE operator. */
  scheduleRequalification(input: { readonly validatorId: string; readonly generation: number; readonly authorizationId: string; readonly challengeType: ChallengeType; readonly operation: string; readonly fixtureRef: string }): ScheduleResult;
  /** One ROUTINE job per (requirement, operation) without accepted evidence in the current routine window. */
  planRoutine(authorizationId: string, fixtureRef: string): readonly ScheduleResult[];
  /** Expedited follow-ups from recent evidence: a single-operator violation → INVESTIGATION; violation vs conformance → DISPUTE. */
  planFollowUps(authorizationId: string, fixtureRef: string): readonly ScheduleResult[];
  /** Eligible, assignable validators now, one entry per validator, with their operators (for capacity and metrics). */
  capacity(challengeType: ChallengeType, profileId: string, profileVersion: string, untilMs: number): readonly JobAssignment[];
}

const jobIdOf = (key: string) => `job_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;

const DEADLINE_OF: Readonly<Record<JobPurpose, number>> = Object.freeze({
  ROUTINE: FEDERATION_TIMING.routineDeadlineSeconds,
  INVESTIGATION: FEDERATION_TIMING.investigationDeadlineSeconds,
  DISPUTE: FEDERATION_TIMING.investigationDeadlineSeconds,
  REQUALIFICATION: FEDERATION_TIMING.requalificationDeadlineSeconds,
});

/** A uniformly distributed tie-break rank from the injected random source (CSPRNG by default, deterministic in tests). */
const rank = (random: RandomSource): number => random.bytes(4).readUInt32BE(0);

export function createFederationScheduler(deps: {
  readonly fed: FederationStore;
  readonly store: ConformanceStore;
  readonly registry: FederationRegistry;
  readonly health: FederationHealth;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: { now(): string };
  readonly random: RandomSource;
}): FederationScheduler {
  const { fed, store, registry, health, profiles, clock, random } = deps;
  const nowMs = () => {
    const ms = toMs(clock.now());
    fed.observeClock(ms);
    return ms;
  };

  const openWorkload = (): Map<string, number> => {
    const load = new Map<string, number>();
    for (const job of fed.listJobs(['PENDING', 'LEASED', 'DISPATCHED', 'RETRY_PENDING'])) for (const a of job.assignments) load.set(a.validatorId, (load.get(a.validatorId) ?? 0) + 1);
    return load;
  };

  const capacity = (challengeType: ChallengeType, profileId: string, profileVersion: string, untilMs: number): readonly JobAssignment[] => {
    const at = nowMs();
    const out: JobAssignment[] = [];
    for (const v of fed.listValidators()) {
      if (!v.capabilities.challengeTypes.includes(challengeType)) continue;
      if (!v.capabilities.profiles.some((p) => p.profileId === profileId && p.profileVersion === profileVersion)) continue;
      const h = health.health(v.validatorId);
      if (h !== 'HEALTHY' && h !== 'DEGRADED') continue;
      const e = registry.eligibility(v.validatorId, at, untilMs);
      if (!e.eligible) continue;
      out.push(Object.freeze({ validatorId: v.validatorId, generation: e.generation.generation, conformanceValidatorId: e.generation.conformanceValidatorId, operatorId: e.operatorId }));
    }
    return Object.freeze(out);
  };

  const authorizationFor = (authorizationId: string, fixtureRef: string, deadlineSeconds: number, at: number) => {
    const auth = fed.getAuthorization(authorizationId);
    if (auth === undefined) return undefined;
    const r = auth.record;
    // No scheduling outside the signed testing window: the whole challenge must fit inside it.
    if (at < toMs(r.notBefore) || at + deadlineSeconds * 1000 > toMs(r.notAfter) || !r.fixtureRefs.includes(fixtureRef)) return undefined;
    const integration = store.getIntegrationByDigest(r.organizationId, r.integrationDigest);
    return integration === undefined ? undefined : { auth: r, integration: integration.record };
  };

  const insert = (request: ScheduleRequest, assignments: readonly JobAssignment[], org: string, digest: string, at: number): ScheduleResult => {
    const jobId = jobIdOf(request.jobKey);
    try {
      const outcome = fed.insertJob(
        {
          jobId,
          purpose: request.purpose,
          organizationId: org,
          integrationDigest: digest,
          challengeType: request.challengeType,
          operation: request.operation,
          fixtureRef: request.fixtureRef,
          authorizationId: request.authorizationId,
          assignments,
          requiredOperators: request.requiredOperators,
          deadlineSeconds: DEADLINE_OF[request.purpose],
          nextAttemptMs: at,
        },
        at,
      );
      const job = fed.getJob(jobId) as ScheduledJob;
      if (outcome === 'inserted') {
        fed.appendEvent('JOB_SCHEDULED', at, 'job', jobId, { purpose: request.purpose, challengeType: request.challengeType, operation: request.operation, operators: new Set(assignments.map((a) => a.operatorId)).size });
        if (request.purpose === 'INVESTIGATION') fed.appendEvent('INVESTIGATION_SCHEDULED', at, 'job', jobId, { challengeType: request.challengeType, operation: request.operation });
        if (request.purpose === 'DISPUTE') fed.appendEvent('DISPUTE_ESCALATED', at, 'job', jobId, { challengeType: request.challengeType, operation: request.operation });
        if (request.purpose === 'REQUALIFICATION') fed.appendEvent('REQUALIFICATION_SCHEDULED', at, 'job', jobId, { challengeType: request.challengeType });
      }
      return { scheduled: true, job, created: outcome === 'inserted' };
    } catch (error) {
      if (error instanceof FederationStoreError && error.code === 'QUEUE_FULL') {
        fed.appendEvent('QUEUE_FULL', at, 'federation', 'scheduler', { jobKeyDigest: jobId });
        return { scheduled: false, reason: 'QUEUE_FULL', availableOperators: 0 };
      }
      throw error;
    }
  };

  const scheduler: FederationScheduler = {
    capacity,
    schedule(request) {
      const at = nowMs();
      const deadlineSeconds = DEADLINE_OF[request.purpose];
      const target = authorizationFor(request.authorizationId, request.fixtureRef, deadlineSeconds, at);
      if (target === undefined) return { scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 };
      const existing = fed.getJob(jobIdOf(request.jobKey));
      if (existing !== undefined) return { scheduled: true, job: existing, created: false };
      if (!Number.isSafeInteger(request.requiredOperators) || request.requiredOperators < 1) throw new TypeError('requiredOperators must be a positive integer.');
      const exclude = new Set(request.excludeOperators ?? []);
      const candidates = capacity(request.challengeType, target.integration.profile.id, target.integration.profile.version, at + deadlineSeconds * 1000).filter((a) => !exclude.has(a.operatorId));
      // One validator per operator: a second validator of the same operator adds no vote, so it is never assigned for quorum.
      const load = openWorkload();
      const byOperator = new Map<string, { a: JobAssignment; load: number; rank: number }>();
      for (const a of candidates) {
        const entry = { a, load: load.get(a.validatorId) ?? 0, rank: rank(random) };
        const current = byOperator.get(a.operatorId);
        if (current === undefined || entry.load < current.load || (entry.load === current.load && entry.rank < current.rank)) byOperator.set(a.operatorId, entry);
      }
      const operators = [...byOperator.values()].sort((x, y) => x.load - y.load || x.rank - y.rank);
      if (operators.length < request.requiredOperators) {
        fed.appendEvent('QUORUM_INSUFFICIENT', at, 'federation', 'scheduler', { purpose: request.purpose, challengeType: request.challengeType, operation: request.operation, required: request.requiredOperators, available: operators.length });
        return { scheduled: false, reason: 'QUORUM_INSUFFICIENT', availableOperators: operators.length };
      }
      const chosen = operators.slice(0, request.requiredOperators).map((o) => o.a);
      return insert(request, chosen, target.auth.organizationId, target.auth.integrationDigest, at);
    },

    scheduleRequalification(input) {
      const at = nowMs();
      const target = authorizationFor(input.authorizationId, input.fixtureRef, DEADLINE_OF.REQUALIFICATION, at);
      if (target === undefined) return { scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 };
      const record = fed.getValidator(input.validatorId);
      const row = fed.listGenerations(input.validatorId).find((g) => g.generation === input.generation);
      const pending = row !== undefined && row.enrollmentKind === 'REINSTATE' && fed.generationState(input.validatorId, input.generation)?.state === 'PENDING';
      const stored = row === undefined ? undefined : store.getValidator(row.conformanceValidatorId);
      if (record === undefined || row === undefined || !pending || stored === undefined || stored.quarantinedAtMs !== null || stored.keyRevokedAtMs !== null) {
        return { scheduled: false, reason: 'CAPABILITY_MISSING', availableOperators: 0 };
      }
      const reference = capacity(input.challengeType, target.integration.profile.id, target.integration.profile.version, at + DEADLINE_OF.REQUALIFICATION * 1000).filter((a) => a.operatorId !== record.operatorId);
      if (reference.length === 0) {
        fed.appendEvent('QUORUM_INSUFFICIENT', at, 'federation', 'scheduler', { purpose: 'REQUALIFICATION', required: 1, available: 0 });
        return { scheduled: false, reason: 'QUORUM_INSUFFICIENT', availableOperators: 0 };
      }
      const candidate: JobAssignment = Object.freeze({ validatorId: input.validatorId, generation: input.generation, conformanceValidatorId: row.conformanceValidatorId, operatorId: record.operatorId });
      return insert(
        {
          purpose: 'REQUALIFICATION',
          authorizationId: input.authorizationId,
          challengeType: input.challengeType,
          operation: input.operation,
          fixtureRef: input.fixtureRef,
          requiredOperators: 2,
          jobKey: `requalify|${row.conformanceValidatorId}|${input.challengeType}|${input.operation}`,
        },
        [candidate, reference[0] as JobAssignment],
        target.auth.organizationId,
        target.auth.integrationDigest,
        at,
      );
    },

    planRoutine(authorizationId, fixtureRef) {
      const at = nowMs();
      const auth = fed.getAuthorization(authorizationId);
      if (auth === undefined) return [{ scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 }];
      const integration = store.getIntegrationByDigest(auth.record.organizationId, auth.record.integrationDigest);
      if (integration === undefined) return [{ scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 }];
      const resolved = profiles.resolve(integration.record.profile.id, integration.record.profile.version, integration.record.profile.digest);
      if (!resolved.ok) return [{ scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 }];
      const windowMs = FEDERATION_TIMING.routineWindowSeconds * 1000;
      const windowIndex = Math.floor(at / windowMs);
      const recent = store.listRecentObservations(auth.record.organizationId, auth.record.integrationDigest, at - windowMs, 4096);
      const results: ScheduleResult[] = [];
      for (const requirement of resolved.definition.requirements) {
        if (requirement.evaluation !== 'validator-corroborated' || requirement.challengeType === null) continue;
        const type = requirement.challengeType as ChallengeType;
        for (const operation of requiredOperations(type, integration.record.coveredOperations)) {
          const fresh = new Set(recent.filter((o) => o.controlId === requirement.requirementId && o.operation === operation).map((o) => o.operatorId));
          if (fresh.size >= 2) continue;
          results.push(
            scheduler.schedule({
              purpose: 'ROUTINE',
              authorizationId,
              challengeType: type,
              operation,
              fixtureRef,
              requiredOperators: 2,
              jobKey: `routine|${auth.record.organizationId}|${auth.record.integrationDigest}|${type}|${operation}|${windowIndex}`,
            }),
          );
        }
      }
      return Object.freeze(results);
    },

    planFollowUps(authorizationId, fixtureRef) {
      const at = nowMs();
      const auth = fed.getAuthorization(authorizationId);
      if (auth === undefined) return [{ scheduled: false, reason: 'AUTHORIZATION_INVALID', availableOperators: 0 }];
      const windowMs = 30 * 60 * 1000;
      const recent = store.listRecentObservations(auth.record.organizationId, auth.record.integrationDigest, at - windowMs, 4096);
      const groups = new Map<string, { controlId: string; operation: string; violation: Map<string, string>; conformant: Set<string> }>();
      // Newest first: the latest observation per operator decides that operator's position.
      const seen = new Set<string>();
      for (const o of recent) {
        const key = `${o.controlId}|${o.operation}`;
        const opKey = `${key}|${o.operatorId}`;
        if (seen.has(opKey)) continue;
        seen.add(opKey);
        const g = groups.get(key) ?? { controlId: o.controlId, operation: o.operation, violation: new Map<string, string>(), conformant: new Set<string>() };
        if (o.outcomeClass === 'violation') g.violation.set(o.operatorId, o.eventId);
        else if (o.outcomeClass === 'conformant') g.conformant.add(o.operatorId);
        groups.set(key, g);
      }
      const results: ScheduleResult[] = [];
      for (const g of groups.values()) {
        if (g.violation.size === 0) continue;
        const type = (Object.keys(CHALLENGE_CATALOGUE) as ChallengeType[]).find((t) => CHALLENGE_CATALOGUE[t].controlId === g.controlId);
        if (type === undefined) continue;
        const operation = type === 'G08' ? DEPLOYMENT_ATTESTATION_OPERATION : g.operation;
        const trigger = [...g.violation.values()].sort()[0] as string;
        if (g.conformant.size === 0 && g.violation.size < 2) {
          results.push(
            scheduler.schedule({ purpose: 'INVESTIGATION', authorizationId, challengeType: type, operation, fixtureRef, requiredOperators: 2 - g.violation.size, excludeOperators: [...g.violation.keys()], jobKey: `investigate|${trigger}` }),
          );
        } else if (g.conformant.size > 0) {
          const involved = [...g.violation.keys(), ...g.conformant];
          const needed = Math.max(0, 3 - new Set(involved).size);
          if (needed > 0) {
            results.push(scheduler.schedule({ purpose: 'DISPUTE', authorizationId, challengeType: type, operation, fixtureRef, requiredOperators: needed, excludeOperators: involved, jobKey: `dispute|${trigger}|${[...g.conformant].sort().join(',')}` }));
          }
        }
      }
      return Object.freeze(results);
    },
  };
  return Object.freeze(scheduler);
}

// ---------------------------------------------------------------------------
// The dispatch worker.
// ---------------------------------------------------------------------------

/** How a challenge reaches a validator runtime. In this mission: in-process ports only (no network transport exists). */
export interface ChallengeTransport {
  deliver(assignment: JobAssignment, signed: SignedChallenge): Promise<'DELIVERED' | 'UNREACHABLE'>;
}

export type DispatchOutcome =
  | { readonly jobId: string; readonly outcome: 'NOT_DUE' }
  | { readonly jobId: string; readonly outcome: 'FENCED'; readonly detail: string }
  | { readonly jobId: string; readonly outcome: 'COMPLETED' | 'DISPATCHED' | 'RETRY_PENDING' | 'EXPIRED' | 'FAILED_FINAL' | 'CANCELLED'; readonly detail: string };

export interface DispatchWorker {
  readonly workerId: string;
  /** Releases expired leases, expires overdue jobs, then processes every due job once. Bounded: at most `limit` jobs. */
  runOnce(limit?: number): Promise<readonly DispatchOutcome[]>;
  /** Processes one job if due. */
  process(jobId: string): Promise<DispatchOutcome>;
  /** TEST-ONLY: acquire a lease without processing (to stage stale-worker races). */
  acquire(jobId: string): JobLease | null;
  /** Processes a job under a lease this worker already holds (a stale lease is fenced at the first durable step). */
  processWithLease(lease: JobLease): Promise<DispatchOutcome>;
}

export function backoffMs(attempts: number, random: RandomSource): number {
  const T = FEDERATION_TIMING;
  const base = Math.min(T.backoffMaxSeconds, T.backoffBaseSeconds * 2 ** Math.max(0, attempts - 1));
  const jitter = random.bytes(2).readUInt16BE(0) % (T.jitterMaxSeconds * 1000 + 1);
  return base * 1000 + jitter;
}

/** Coordinator-side expiry: jobs whose challenge deadline passed, or that can no longer fit inside their authorization. */
export function expireOverdueJobs(fed: FederationStore, store: ConformanceStore, nowMs: number): readonly string[] {
  const expired: string[] = [];
  for (const job of fed.listJobs(['PENDING', 'LEASED', 'DISPATCHED', 'RETRY_PENDING'])) {
    const auth = fed.getAuthorization(job.authorizationId);
    const overdue = job.challengeDeadlineMs !== null ? nowMs > job.challengeDeadlineMs : auth === undefined || nowMs + job.deadlineSeconds * 1000 > toMs(auth.record.notAfter);
    if (!overdue) continue;
    const committed = job.challengeId === null ? 0 : new Set(job.assignments.filter((a) => store.getObservationForChallengeValidator(job.challengeId as string, a.conformanceValidatorId) !== undefined).map((a) => a.operatorId)).size;
    fed.closeWithoutLease(job.jobId, nowMs, 'EXPIRED', job.challengeDeadlineMs !== null ? 'CHALLENGE_DEADLINE_PASSED' : 'AUTHORIZATION_WINDOW_EXHAUSTED');
    fed.appendEvent('JOB_EXPIRED', nowMs, 'job', job.jobId, { committedOperators: committed, requiredOperators: job.requiredOperators });
    // Missing evidence stays missing: the engine sees too few operators (investigation / staleness), never a success.
    if (committed < job.requiredOperators) fed.appendEvent('QUORUM_INSUFFICIENT', nowMs, 'job', job.jobId, { committed, required: job.requiredOperators });
    expired.push(job.jobId);
  }
  return Object.freeze(expired);
}

export function createDispatchWorker(deps: {
  readonly workerId: string;
  readonly fed: FederationStore;
  readonly store: ConformanceStore;
  readonly registry: FederationRegistry;
  readonly coordinator: ChallengeCoordinator;
  readonly transport: ChallengeTransport;
  readonly clock: { now(): string };
  readonly random: RandomSource;
}): DispatchWorker {
  const { workerId, fed, store, registry, coordinator, transport, clock, random } = deps;
  const T = FEDERATION_TIMING;
  const nowMs = () => {
    const ms = toMs(clock.now());
    fed.observeClock(ms);
    return ms;
  };
  const fenced = (jobId: string, error: unknown): DispatchOutcome => {
    if (error instanceof FederationStoreError && error.code === 'FENCED') {
      fed.appendEvent('LEASE_FENCED', toMs(clock.now()), 'job', jobId, { workerId });
      return { jobId, outcome: 'FENCED', detail: error.detail };
    }
    throw error;
  };
  const committedFor = (job: ScheduledJob) => job.assignments.filter((a) => job.challengeId !== null && store.getObservationForChallengeValidator(job.challengeId, a.conformanceValidatorId) !== undefined);
  const assignmentEligible = (job: ScheduledJob, a: JobAssignment, at: number, untilMs: number): boolean => {
    if (job.purpose === 'REQUALIFICATION' && fed.validatorState(a.validatorId)?.state === 'QUARANTINED') {
      const row = fed.listGenerations(a.validatorId).find((g) => g.generation === a.generation);
      const stored = store.getValidator(a.conformanceValidatorId);
      return row !== undefined && fed.generationState(a.validatorId, a.generation)?.state === 'PENDING' && stored !== undefined && stored.quarantinedAtMs === null && stored.keyRevokedAtMs === null && toMs(stored.record.keyValidUntil) >= untilMs;
    }
    const e = registry.eligibility(a.validatorId, at, untilMs);
    return e.eligible && e.generation.conformanceValidatorId === a.conformanceValidatorId && e.operatorId === a.operatorId;
  };

  const processWithLease = async (initial: JobLease): Promise<DispatchOutcome> => {
    let lease = initial;
    const jobId = lease.jobId;
    try {
      let job = fed.getJob(jobId) as ScheduledJob;
      let at = nowMs();
      fed.appendEvent('LEASE_ACQUIRED', at, 'job', jobId, { workerId, fencingToken: lease.fencingToken });

      // 1. The challenge: obtained once, then bound write-once to the job; every retry re-reads the same one.
      let signed: SignedChallenge | undefined;
      if (job.challengeId === null) {
        const auth = fed.getAuthorization(job.authorizationId);
        if (auth === undefined || at < toMs(auth.record.notBefore) || at + job.deadlineSeconds * 1000 > toMs(auth.record.notAfter)) {
          fed.commitWithLease(lease, at, { state: 'EXPIRED', lastError: 'AUTHORIZATION_WINDOW_EXHAUSTED' });
          fed.appendEvent('JOB_EXPIRED', at, 'job', jobId, { reason: 'AUTHORIZATION_WINDOW_EXHAUSTED' });
          return { jobId, outcome: 'EXPIRED', detail: 'AUTHORIZATION_WINDOW_EXHAUSTED' };
        }
        const until = at + job.deadlineSeconds * 1000;
        const lost = job.assignments.filter((a) => !assignmentEligible(job, a, at, until));
        if (lost.length > 0) {
          fed.commitWithLease(lease, at, { state: 'CANCELLED', lastError: `ASSIGNMENT_NOT_ELIGIBLE:${lost.map((a) => a.conformanceValidatorId).join(',')}` });
          fed.appendEvent('JOB_CANCELLED', at, 'job', jobId, { reason: 'ASSIGNMENT_NOT_ELIGIBLE', lost: lost.length });
          return { jobId, outcome: 'CANCELLED', detail: 'ASSIGNMENT_NOT_ELIGIBLE' };
        }
        try {
          signed = coordinator.issue({
            idempotencyKey: job.jobId,
            organizationId: job.organizationId,
            integrationDigest: job.integrationDigest,
            challengeType: job.challengeType,
            operation: job.operation,
            fixtureRef: job.fixtureRef,
            assignedValidatorIds: job.assignments.map((a) => a.conformanceValidatorId),
            deadlineSeconds: job.deadlineSeconds,
          });
        } catch (error) {
          if (error instanceof ChallengeCoordinatorError) {
            fed.commitWithLease(lease, at, { state: 'CANCELLED', lastError: `COORDINATOR_${error.code}` });
            fed.appendEvent('JOB_CANCELLED', at, 'job', jobId, { reason: error.code });
            return { jobId, outcome: 'CANCELLED', detail: error.code };
          }
          throw error;
        }
        job = fed.bindChallengeWithLease(lease, at, { challengeId: signed.challenge.challengeId, deadlineMs: toMs(signed.challenge.deadline) });
      } else {
        signed = store.getChallenge(job.challengeId);
        if (signed === undefined) throw new FederationStoreError('INVARIANT_REFUSED', 'job challenge missing from the conformance store');
      }
      const deadlineMs = toMs(signed.challenge.deadline);
      if (at > deadlineMs) {
        fed.commitWithLease(lease, at, { state: 'EXPIRED', lastError: 'CHALLENGE_DEADLINE_PASSED' });
        fed.appendEvent('JOB_EXPIRED', at, 'job', jobId, { reason: 'CHALLENGE_DEADLINE_PASSED' });
        return { jobId, outcome: 'EXPIRED', detail: 'CHALLENGE_DEADLINE_PASSED' };
      }

      // 2. Reconcile against committed evidence BEFORE delivering anything (lost acknowledgements, crashed workers).
      const missing = job.assignments.filter((a) => !committedFor(job).includes(a));
      let unreachable = 0;
      let delivered = 0;
      let ineligible = 0;
      for (const a of missing) {
        at = nowMs();
        // Fencing before every outbound action: a worker that lost its lease stops here.
        lease = fed.renewLease(lease, at, T.leaseSeconds * 1000);
        if (!assignmentEligible(job, a, at, deadlineMs)) {
          ineligible += 1;
          fed.appendDelivery(jobId, a.conformanceValidatorId, lease.fencingToken, at, 'NOT_ELIGIBLE');
          continue;
        }
        const result = await transport.deliver(a, signed);
        at = nowMs();
        fed.appendDelivery(jobId, a.conformanceValidatorId, lease.fencingToken, at, result);
        if (result === 'DELIVERED') {
          delivered += 1;
          fed.appendEvent('CHALLENGE_DISPATCHED', at, 'job', jobId, { validatorId: a.validatorId, generation: a.generation, fencingToken: lease.fencingToken });
        } else unreachable += 1;
      }

      // 3. Settle from the conformance store — the only source of truth for acceptance.
      at = nowMs();
      job = fed.getJob(jobId) as ScheduledJob;
      const committed = committedFor(job);
      const stillOpen = job.assignments.filter((a) => !committed.includes(a) && assignmentEligible(job, a, at, deadlineMs));
      if (stillOpen.length === 0) {
        const operators = new Set(committed.map((a) => a.operatorId)).size;
        fed.commitWithLease(lease, at, { state: 'COMPLETED', lastError: ineligible > 0 ? 'ASSIGNMENT_LOST' : null });
        fed.appendEvent('JOB_COMPLETED', at, 'job', jobId, { committedOperators: operators, requiredOperators: job.requiredOperators });
        if (operators < job.requiredOperators) fed.appendEvent('QUORUM_INSUFFICIENT', at, 'job', jobId, { committed: operators, required: job.requiredOperators });
        return { jobId, outcome: 'COMPLETED', detail: `${committed.length}/${job.assignments.length} observations committed` };
      }
      if (unreachable > 0 && delivered === 0) {
        const attempts = job.attempts + 1;
        if (attempts >= T.maxAttempts) {
          fed.commitWithLease(lease, at, { state: 'FAILED_FINAL', attempts, lastError: 'RETRY_EXHAUSTED' });
          fed.appendEvent('JOB_FAILED', at, 'job', jobId, { attempts });
          return { jobId, outcome: 'FAILED_FINAL', detail: 'RETRY_EXHAUSTED' };
        }
        const next = at + backoffMs(attempts, random);
        fed.commitWithLease(lease, at, { state: 'RETRY_PENDING', attempts, nextAttemptMs: next, lastError: 'UNREACHABLE' });
        fed.appendEvent('DISPATCH_RETRY', at, 'job', jobId, { attempts, nextAttemptInMs: next - at });
        return { jobId, outcome: 'RETRY_PENDING', detail: 'UNREACHABLE' };
      }
      // Delivered but not (yet) committed: wait, then re-check (and redeliver the same challenge) after a backoff.
      fed.commitWithLease(lease, at, { state: 'DISPATCHED', nextAttemptMs: at + T.backoffBaseSeconds * 1000 });
      return { jobId, outcome: 'DISPATCHED', detail: `${stillOpen.length} observation(s) outstanding` };
    } catch (error) {
      return fenced(jobId, error);
    }
  };

  const acquire = (jobId: string): JobLease | null => fed.acquireLease(jobId, workerId, nowMs(), T.leaseSeconds * 1000);

  const worker: DispatchWorker = {
    workerId,
    acquire,
    processWithLease,
    async process(jobId) {
      const job = fed.getJob(jobId);
      if (job === undefined || TERMINAL_JOB_STATES.includes(job.state)) return { jobId, outcome: 'NOT_DUE' };
      const lease = acquire(jobId);
      if (lease === null) return { jobId, outcome: 'NOT_DUE' };
      return processWithLease(lease);
    },
    async runOnce(limit = 64) {
      const at = nowMs();
      for (const id of fed.releaseExpiredLeases(at)) fed.appendEvent('LEASE_EXPIRED', at, 'job', id, { releasedBy: workerId });
      expireOverdueJobs(fed, store, at);
      const due = fed.listJobs(['PENDING', 'RETRY_PENDING', 'DISPATCHED']).filter((j) => j.nextAttemptMs <= at).slice(0, Math.max(0, Math.min(limit, 512)));
      const outcomes: DispatchOutcome[] = [];
      for (const job of due) outcomes.push(await worker.process(job.jobId));
      return Object.freeze(outcomes);
    },
  };
  return Object.freeze(worker);
}

// ---------------------------------------------------------------------------
// Operational metrics (internal; not SLA guarantees).
// ---------------------------------------------------------------------------

export interface FederationMetrics {
  readonly eligibleValidators: number;
  readonly distinctEligibleOperators: number;
  readonly pendingJobs: number;
  readonly leasedJobs: number;
  readonly dispatchedJobs: number;
  readonly expiredJobs: number;
  readonly retryQueueDepth: number;
  readonly failedJobs: number;
  readonly observationsAccepted: number;
  readonly observationsRejected: number;
  readonly observationAcceptanceRate: number | null;
  readonly signatureRejections: number;
  readonly signatureRejectionRate: number | null;
  readonly quarantinedValidators: number;
  readonly corroborationAvailable: boolean;
  readonly oldestUnresolvedInvestigationAgeSeconds: number | null;
  readonly evidenceFreshnessLagSeconds: number | null;
}

export function federationMetrics(deps: { readonly fed: FederationStore; readonly store: ConformanceStore; readonly registry: FederationRegistry; readonly health: FederationHealth; readonly nowMs: number; readonly organizationId: string; readonly integrationDigest: string }): FederationMetrics {
  const { fed, store, registry, health, nowMs } = deps;
  const eligible = fed.listValidators().filter((v) => {
    const h = health.health(v.validatorId);
    return (h === 'HEALTHY' || h === 'DEGRADED') && registry.eligibility(v.validatorId, nowMs, nowMs).eligible;
  });
  const operators = new Set(eligible.map((v) => v.operatorId));
  const jobs = fed.listJobs();
  const count = (state: string) => jobs.filter((j) => j.state === state).length;
  const observations = store.listObservations(deps.organizationId, deps.integrationDigest);
  const rejections = store.listRejections();
  const total = observations.length + rejections.length;
  const signature = rejections.filter((r) => r.reason === 'SIGNATURE_MISMATCH').length;
  const investigations = jobs.filter((j) => (j.purpose === 'INVESTIGATION' || j.purpose === 'DISPUTE') && !TERMINAL_JOB_STATES.includes(j.state));
  const newest = observations.reduce((m, o) => Math.max(m, o.observedAtMs), 0);
  return Object.freeze({
    eligibleValidators: eligible.length,
    distinctEligibleOperators: operators.size,
    pendingJobs: count('PENDING'),
    leasedJobs: count('LEASED'),
    dispatchedJobs: count('DISPATCHED'),
    expiredJobs: count('EXPIRED'),
    retryQueueDepth: count('RETRY_PENDING'),
    failedJobs: count('FAILED_FINAL'),
    observationsAccepted: observations.length,
    observationsRejected: rejections.length,
    observationAcceptanceRate: total === 0 ? null : observations.length / total,
    signatureRejections: signature,
    signatureRejectionRate: total === 0 ? null : signature / total,
    quarantinedValidators: fed.listValidators().filter((v) => fed.validatorState(v.validatorId)?.state === 'QUARANTINED').length,
    corroborationAvailable: operators.size >= 2,
    oldestUnresolvedInvestigationAgeSeconds: investigations.length === 0 ? null : Math.floor((nowMs - Math.min(...investigations.map((j) => j.createdMs))) / 1000),
    evidenceFreshnessLagSeconds: newest === 0 ? null : Math.floor((nowMs - newest) / 1000),
  });
}
