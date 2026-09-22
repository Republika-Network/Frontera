import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMERGENCY_CONTROL_REASON_CODES, createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import {
  EXERCISE_CONTROL_REASON_CODES as X,
  createInMemoryExerciseControlLedger,
  exerciseReservationId,
  type ExerciseControlLedgerPort,
  type ExerciseControlPolicy,
} from '../../features/exercise-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES as G, createExecutionAdapterRegistry, type ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import {
  createAuthorityEventProjector,
  createInMemoryAuthorityEventStreamStore,
  deriveAuthorityEventStreamId,
  type AuthorityEvent,
  type AuthorityEventProjector,
  type AuthorityEventRecorder,
  type AuthorityEventStreamStore,
  type AuthorityEventStreamWriter,
} from '../authority-event-stream/index.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { deriveGovernedActionRequestId, type GovernedActionResult } from '../governed-action/index.js';
import {
  ALLOWED_INTENT,
  DENIED_ACTOR,
  DENIED_INTENT,
  GRANT_LIFETIME_MS,
  IDENTITY,
  NO_TEMPORAL_BOUND,
  ORG,
  buildGovernedWorld,
  identityFor,
  type GovernedWorld,
  type WorldOptions,
} from './governed-action-support.js';
import { drained, steppingClock, tick } from './authority-event-stream-support.js';

/**
 * §30 / §31 / §34 — P8 on the real governed-action path: the real Kernel, the
 * real Governance Store, the real bounded-grant store, real ACE and (where named)
 * the real P7 gate and ledger. Every assertion reads the **actual** stream back
 * through the store; nothing inspects a mock callback.
 */

const intent = (key: string) => ({ ...ALLOWED_INTENT, idempotencyKey: key });
const CHANGED_BINDING = { kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: 'changed after the reservation' } as const;
const ONE_PER_ACTOR: ExerciseControlPolicy = (query) => [{ limitId: 'actor-uses', scopeKey: `actor:${query.subject}`, metric: 'count', maximum: 1, window: { kind: 'lifetime' } }];

interface StreamWorld {
  readonly governed: GovernedWorld;
  readonly stream: AuthorityEventStreamStore;
  readonly projector: AuthorityEventProjector;
  readonly grants: BoundedGrantStorePort;
}

/** A governed world with the canonical stream composed exactly as the composition root composes it: one projector, handed to ACE and the orchestrator. */
function streamWorld(options: WorldOptions & { readonly writer?: AuthorityEventStreamWriter; readonly recorder?: AuthorityEventRecorder } = {}): StreamWorld {
  const stream = createInMemoryAuthorityEventStreamStore({ now: steppingClock('2026-06-01T00:00:00.000Z').now });
  const grants = options.grantStore ?? createInMemoryBoundedGrantStore();
  const projector = createAuthorityEventProjector({ organizationId: ORG, store: options.writer ?? stream, grants });
  const governed = buildGovernedWorld({ ...options, grantStore: grants, evidence: options.recorder ?? projector });
  return { governed, stream, projector, grants };
}

function p7(options: { readonly policy?: ExerciseControlPolicy; readonly binding?: () => typeof NO_TEMPORAL_BOUND | typeof CHANGED_BINDING; readonly ledger?: ExerciseControlLedgerPort } = {}) {
  return {
    policy: options.policy ?? ONE_PER_ACTOR,
    revalidateAuthorityBinding: options.binding ?? (() => NO_TEMPORAL_BOUND),
    reservationLedger: options.ledger ?? createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' }),
  };
}

async function streamOf(world: StreamWorld, result: GovernedActionResult): Promise<readonly AuthorityEvent[]> {
  assert.ok(result.requestId !== undefined);
  // Projection is never awaited by the path that produced these facts, so the
  // test waits for the queue here — the one place where waiting is correct.
  assert.equal(await drained(() => world.projector.health()), true, 'the projection queue drained');
  const streamId = deriveAuthorityEventStreamId({ organizationId: ORG, requestId: result.requestId });
  const verification = await world.stream.verifyStream({ organizationId: ORG }, streamId);
  assert.equal(verification.valid, true, verification.failures.join('; '));
  return world.stream.readStream({ organizationId: ORG }, streamId);
}

const types = (events: readonly AuthorityEvent[]) => events.map((event) => event.eventType);
/** An event's payload as plain data, for field assertions across the union. */
const P = (event: AuthorityEvent | undefined): Readonly<Record<string, unknown>> => (event?.payload ?? {}) as Readonly<Record<string, unknown>>;

function only(events: readonly AuthorityEvent[], type: AuthorityEvent['eventType']): AuthorityEvent {
  const matching = events.filter((event) => event.eventType === type);
  assert.equal(matching.length, 1, `exactly one ${type}`);
  return matching[0] as AuthorityEvent;
}

/** Every event in a lifecycle names the same request, decision, grant and execution — the references line up with the authoritative artifacts. */
function assertLinked(events: readonly AuthorityEvent[], result: GovernedActionResult): void {
  const decision = only(events, 'governance.decision.committed');
  assert.equal(decision.references.requestId, result.requestId);
  assert.equal(decision.references.evaluationId, result.decision?.evaluationId);
  assert.equal(decision.references.decisionId, result.decision?.decisionId);
  const grantIds = new Set(events.filter((event) => event.references.boundedGrantId !== undefined).map((event) => event.references.boundedGrantId));
  assert.ok(grantIds.size <= 1, 'one grant per lifecycle');
  for (const event of events) {
    assert.equal(event.references.requestId, result.requestId);
    if (event.references.decisionId !== undefined) assert.equal(event.references.decisionId, result.decision?.decisionId);
    if (event.references.executionId !== undefined) assert.equal(event.references.executionId, result.executionId);
    if (event.references.evaluationId !== undefined) assert.equal(event.references.evaluationId, result.decision?.evaluationId);
    assert.equal(event.organizationId, ORG);
  }
}

describe('P8 governed action — §30 decisions', () => {
  it('Kernel denied → one committed-decision event carrying the committed status and codes, and nothing else', async () => {
    const world = streamWorld();
    const result = await world.governed.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    assert.equal(result.status, 'denied');
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed']);
    const decision = only(events, 'governance.decision.committed');
    assert.equal(P(decision).status, 'denied');
    assert.deepEqual([...(decision.payload as { reasonCodes: readonly string[] }).reasonCodes], [...result.reasonCodes]);
    const record = await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
    assert.equal(decision.occurredAt, record?.evaluation.persistedAt, 'occurredAt is the commit instant of the record');
    assert.equal((decision.payload as { aggregateDigest: string }).aggregateDigest, record?.integrity.aggregateDigest);
    assertLinked(events, result);
  });

  it('Kernel indeterminate → the committed indeterminate decision, and no grant', async () => {
    const world = streamWorld({ kernelOverride: (result) => ({ ...result, status: 'indeterminate', reasonCodes: ['KERNEL_TEST_INDETERMINATE'] }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('indeterminate'));
    assert.equal(result.status, 'indeterminate');
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed']);
    assert.equal(P(events[0]).status, 'indeterminate');
  });

  it('a decision that is never committed produces no event: a Kernel that throws, or a commit that fails', async () => {
    for (const options of [{ kernelThrows: new Error('kernel down') }, { storeFault: { appendEvaluation: true } } as WorldOptions]) {
      const world = streamWorld(options);
      const result = await world.governed.orchestrator.govern(IDENTITY, intent('uncommitted'));
      assert.equal(result.status, 'system_error');
      assert.equal(world.projector.health().appended, 0, 'no stream exists for an uncommitted decision');
    }
  });
});

describe('P8 governed action — §30 grant → execution outcomes', () => {
  it('allowed → grant issued → claimed → executed, in lifecycle order, with adapter attribution and providerRef as evidence', async () => {
    const world = streamWorld();
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('executed'));
    assert.equal(result.status, 'executed');
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed']);
    assertLinked(events, result);
    const grant = (await world.grants.read(only(events, 'grant.issued').references.boundedGrantId ?? '')).grant;
    assert.ok(grant !== undefined, 'the event references a grant the authoritative store holds');
    assert.equal(only(events, 'grant.issued').occurredAt, grant.issuedAt);
    assert.equal(P(only(events, 'grant.issued')).grantDigest, grant.digest);
    const outcome = only(events, 'execution.outcome.observed');
    assert.deepEqual(outcome.payload, { status: 'executed', reasonCodes: [], adapterId: 'test.fake-provider', providerRef: 'provider-ref-1', outcomeRecorded: true });
    const record = await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
    const claimRow = record?.references.find((reference) => reference.externalVersion === 'attempt');
    assert.equal(only(events, 'execution.attempt.claimed').occurredAt, claimRow?.createdAt, "the claim event's instant is the claim row's own");
    events.forEach((event, index) => assert.equal(event.sequence, index + 1));
  });

  it('allowed → grant issued → provider definite failure: execution-failed with its reason — never "executed", never a boolean', async () => {
    const world = streamWorld({ adapterBehaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('failed'));
    assert.equal(result.status, 'execution_failed');
    const outcome = only(await streamOf(world, result), 'execution.outcome.observed');
    assert.deepEqual(outcome.payload, { status: 'execution-failed', failure: 'PROVIDER_REJECTED', reasonCodes: ['PROVIDER_REJECTED'], adapterId: 'test.fake-provider', outcomeRecorded: true });
  });

  it('allowed → grant issued → execution unconfirmed: recorded as unconfirmed — never failed, never confirmed', async () => {
    const world = streamWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed', detail: 'connection reset after send' }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('unconfirmed'));
    assert.equal(result.status, 'execution_unconfirmed');
    const outcome = only(await streamOf(world, result), 'execution.outcome.observed');
    assert.deepEqual(outcome.payload, { status: 'execution-unconfirmed', reasonCodes: [], adapterId: 'test.fake-provider', outcomeRecorded: true });
    assert.equal(JSON.stringify(outcome).includes('connection reset'), false, 'adapter detail is never copied');
  });

  it('an exercise that throws leaves the claim without an outcome event — unknown stays unknown', async () => {
    const world = streamWorld({
      beforeExercise: async () => {
        throw new Error('the exercise port is unreachable');
      },
    });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('thrown'));
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual(types(await streamOf(world, result)), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed']);
  });

  it('grant exercise withheld (revoked after the claim): revocation, then a grant-exercise withholding with its own codes', async () => {
    const world = streamWorld({
      beforeExercise: async ({ ace }, grantId) => {
        await ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
      },
    });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('revoked'));
    assert.equal(result.status, 'withheld');
    const events = await streamOf(world, result);
    // A revocation's lifecycle is resolved from the authoritative grant on its
    // own queue, so it lands after the facts already enqueued for this stream;
    // its occurredAt is still the revocation instant.
    assert.deepEqual([...types(events)].sort(), ['execution.attempt.claimed', 'execution.outcome.observed', 'governance.decision.committed', 'grant.issued', 'grant.revoked']);
    assert.ok(types(events).indexOf('grant.revoked') > types(events).indexOf('grant.issued'), 'a revocation is never recorded before the issuance it revokes');
    assert.deepEqual(only(events, 'grant.revoked').payload, { reason: 'security-incident' });
    assert.deepEqual(only(events, 'execution.outcome.observed').payload, { status: 'withheld', withheldBy: 'grant-exercise', reasonCodes: [G.GRANT_EXERCISE_REVOKED], outcomeRecorded: true });
    assert.equal(world.governed.adapter.callCount, 0);
    assertLinked(events, result);
  });

  it('a revocation recorded later lands in the right lifecycle, after its facts; repeating it adds nothing', async () => {
    const world = streamWorld();
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('revoke-later'));
    const grantId = only(await streamOf(world, result), 'grant.issued').references.boundedGrantId ?? '';
    world.governed.clock.advance(60_000);
    assert.equal((await world.governed.ace.revokeGrant({ grantId, reason: 'policy-changed', issuerRef: 'operator:1' })).outcome, 'revoked');
    assert.equal((await world.governed.ace.revokeGrant({ grantId, reason: 'policy-changed', issuerRef: 'operator:1' })).outcome, 'already-revoked');
    const events = await streamOf(world, result);
    assert.equal(types(events).indexOf('grant.revoked'), events.length - 1, 'the later revocation is the newest event');
    assert.equal(events.filter((event) => event.eventType === 'grant.revoked').length, 1);
    const read = await world.grants.read(grantId);
    assert.equal(only(events, 'grant.revoked').occurredAt, read.revocation?.revokedAt, 'occurredAt is the revocation the store holds');
  });

  it('expiry observed at the pre-assessment: an observation at the grant\'s own expiry instant — no claim, no outcome, no invented transition', async () => {
    const world = streamWorld({
      beforeAssess: async ({ clock }) => {
        clock.advance(GRANT_LIFETIME_MS + 1);
      },
    });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('expired-pre'));
    assert.equal(result.status, 'withheld');
    assert.deepEqual([...result.reasonCodes], [G.GRANT_EXERCISE_EXPIRED]);
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'grant.expiry.observed']);
    const expiry = only(events, 'grant.expiry.observed');
    assert.equal(expiry.occurredAt, P(only(events, 'grant.issued')).expiresAt);
    assert.equal(events.some((event) => event.eventType === 'grant.revoked'), false, 'expiry is never recorded as a revocation');
  });

  it('expiry observed at exercise time: the recorded withholding, then the expiry observation; re-observing it adds nothing', async () => {
    const world = streamWorld({
      beforeExercise: async ({ clock }) => {
        clock.advance(GRANT_LIFETIME_MS + 1);
      },
    });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('expired-exercise'));
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed', 'grant.expiry.observed']);
    assert.deepEqual(only(events, 'execution.outcome.observed').payload, { status: 'withheld', withheldBy: 'grant-exercise', reasonCodes: [G.GRANT_EXERCISE_EXPIRED], outcomeRecorded: true });
    // The same fact observed again resolves to the same event.
    const grant = (await world.grants.read(only(events, 'grant.issued').references.boundedGrantId ?? '')).grant;
    assert.ok(grant !== undefined);
    world.projector.grantExpiryObserved(grant);
    assert.equal((await streamOf(world, result)).length, events.length);
  });

  it('emergency-control withholding at the adapter-scoped checkpoint: withheld by emergency-control, no child invoked', async () => {
    const controls = createInMemoryEmergencyControlStore();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: 'operator:on-call', declaredAt: '2026-01-01T00:00:00.000Z' });
    const reader = createEmergencyControlReader(controls);
    const a = createRecordingExecutionAdapter();
    const registry: ExecutionAdapter = createExecutionAdapterRegistry({ adapters: [{ ...a, adapterId: 'adapter-a', execute: (action) => a.execute(action) }], selectAdapter: () => 'adapter-a', emergencyControl: reader });
    const world = streamWorld({ emergencyControl: reader, executionAdapter: registry });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('emergency'));
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'emergency-control');
    const events = await streamOf(world, result);
    assert.deepEqual(only(events, 'execution.outcome.observed').payload, { status: 'withheld', withheldBy: 'emergency-control', reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE], outcomeRecorded: true });
    assert.equal(a.callCount, 0);
  });

  it('an admission-time emergency stop withholds before any grant exists: the stream holds only the committed decision', async () => {
    const controls = createInMemoryEmergencyControlStore();
    controls.activate({ scope: 'global', issuerRef: 'operator:on-call', declaredAt: '2026-01-01T00:00:00.000Z' });
    const world = streamWorld({ emergencyControl: createEmergencyControlReader(controls) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('admission-stop'));
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'emergency-control');
    assert.deepEqual(types(await streamOf(world, result)), ['governance.decision.committed']);
  });
});

describe('P8 governed action — §19 / §30 P7 reservation facts', () => {
  it('successful reservation → settlement: reserved, settled(executed), then the outcome — each from what the ledger recorded', async () => {
    const ledger = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    const world = streamWorld({ exerciseControls: p7({ ledger }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('p7-settle'));
    assert.equal(result.status, 'executed');
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'exercise.reservation.reserved', 'exercise.reservation.settled', 'execution.outcome.observed']);
    assertLinked(events, result);
    const reserved = only(events, 'exercise.reservation.reserved');
    const grantId = only(events, 'grant.issued').references.boundedGrantId ?? '';
    assert.equal(reserved.references.reservationId, exerciseReservationId({ boundedGrantId: grantId, executionId: result.executionId ?? '' }));
    const view = await ledger.read(reserved.references.reservationId ?? '');
    assert.equal(view?.state, 'settled');
    assert.equal(reserved.occurredAt, view?.reservation.reservedAt, "the ledger's own admission instant");
    assert.equal(P(reserved).policyDigest, view?.reservation.policyDigest);
    assert.deepEqual(only(events, 'exercise.reservation.settled').payload, { reason: 'executed' });
  });

  it('exercise-control limit withheld: an exercise-control withholding and no reservation event, because nothing was reserved', async () => {
    const world = streamWorld({ exerciseControls: p7() });
    await world.governed.orchestrator.govern(IDENTITY, intent('p7-fill'));
    const second = await world.governed.orchestrator.govern(IDENTITY, intent('p7-over'));
    assert.deepEqual([...second.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    const events = await streamOf(world, second);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed']);
    assert.deepEqual(only(events, 'execution.outcome.observed').payload, { status: 'withheld', withheldBy: 'exercise-control', reasonCodes: [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], outcomeRecorded: true });
  });

  it('authority binding changed after the reservation: reserved, released(exercise-control), then the withholding', async () => {
    let calls = 0;
    const world = streamWorld({ exerciseControls: p7({ binding: () => ((calls += 1), calls === 1 ? NO_TEMPORAL_BOUND : CHANGED_BINDING) }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('p7-binding'));
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    const events = await streamOf(world, result);
    assert.deepEqual(types(events), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'exercise.reservation.reserved', 'exercise.reservation.released', 'execution.outcome.observed']);
    assert.deepEqual(only(events, 'exercise.reservation.released').payload, { reason: 'exercise-control' });
    assert.equal(world.governed.adapter.callCount, 0);
  });

  it('post-reservation grant withholding → release: the grant revoked while the reservation waited is released as grant-exercise', async () => {
    let world: StreamWorld | undefined;
    const inner = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    const ledger: ExerciseControlLedgerPort = {
      async reserve(request) {
        const outcome = await inner.reserve(request);
        await world?.governed.ace.revokeGrant({ grantId: request.boundedGrantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
        return outcome;
      },
      settle: (input) => inner.settle(input),
      release: (input) => inner.release(input),
      read: (id) => inner.read(id),
    };
    world = streamWorld({ exerciseControls: p7({ ledger }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('p7-revoked-wait'));
    const events = await streamOf(world, result);
    assert.deepEqual([...types(events)].sort(), [
      'governance.decision.committed',
      'grant.issued',
      'grant.revoked',
      'execution.attempt.claimed',
      'exercise.reservation.reserved',
      'exercise.reservation.released',
      'execution.outcome.observed',
    ].sort());
    assert.ok(types(events).indexOf('exercise.reservation.released') > types(events).indexOf('exercise.reservation.reserved'), 'the reservation is released after it is reserved');
    assert.deepEqual(only(events, 'exercise.reservation.released').payload, { reason: 'grant-exercise' });
    assert.equal(P(only(events, 'execution.outcome.observed')).withheldBy, 'grant-exercise');
  });

  it('a finalization the ledger could not record is not observed: no settled event, while the outcome still is', async () => {
    const inner = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    const ledger: ExerciseControlLedgerPort = { reserve: (r) => inner.reserve(r), settle: async () => Promise.reject(new Error('disk')), release: (i) => inner.release(i), read: (id) => inner.read(id) };
    const world = streamWorld({ exerciseControls: p7({ ledger }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('p7-retained'));
    assert.equal(result.status, 'executed');
    assert.deepEqual(types(await streamOf(world, result)), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'exercise.reservation.reserved', 'execution.outcome.observed']);
  });
});

describe('P8 governed action — §34 replay manufactures no duplicate facts', () => {
  it('replaying an executed lifecycle adds no grant, claim, outcome or reservation event, and invokes nothing', async () => {
    const world = streamWorld({ exerciseControls: p7() });
    const first = await world.governed.orchestrator.govern(IDENTITY, intent('replay'));
    const before = await streamOf(world, first);
    const appended = world.projector.health().appended;
    for (let round = 0; round < 3; round += 1) {
      const replay = await world.governed.orchestrator.govern(IDENTITY, intent('replay'));
      assert.equal(replay.status === 'executed' ? replay.replayed : undefined, true);
    }
    assert.deepEqual([...(await streamOf(world, first))], [...before], 'byte-identical stream');
    assert.equal(world.projector.health().appended, appended, 'nothing new appended');
    assert.equal(world.projector.health().failed, 0, 'the replayed decision resolved to the existing event, not a conflict');
    assert.equal(world.governed.adapter.callCount, 1);
  });

  it('replaying a withheld lifecycle and a denied one adds nothing either', async () => {
    const world = streamWorld({
      beforeExercise: async ({ ace }, grantId) => {
        await ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
      },
    });
    const withheld = await world.governed.orchestrator.govern(IDENTITY, intent('replay-withheld'));
    const denied = await world.governed.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    const lengths = [(await streamOf(world, withheld)).length, (await streamOf(world, denied)).length];
    await world.governed.orchestrator.govern(IDENTITY, intent('replay-withheld'));
    await world.governed.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    assert.deepEqual([(await streamOf(world, withheld)).length, (await streamOf(world, denied)).length], lengths);
  });
});

/**
 * §9 of the P8 hardening — the regressions the reviewer asked for: a projection
 * that **never settles**.
 *
 * A rejected projection was always caught. A pending one is the dangerous case:
 * if any authority path awaited durable projection, a stuck writer would hold a
 * decision before its grant, sit between the durable execution claim and the
 * adapter, keep a P7 reservation consuming while `admit()` never returned, or
 * withhold a revocation's confirmation. Reporting is an enqueue, so none of that
 * can happen — and these tests fail (by timing out) the moment it can.
 */
describe('P8 governed action — a never-settling projection holds nothing', () => {
  /** A store whose appends never settle. Not a rejection: a promise that is simply never resolved. */
  function stuckWriter(options: { readonly only?: AuthorityEvent['eventType'] } = {}): { readonly writer: AuthorityEventStreamWriter; readonly invoked: string[]; readonly store: AuthorityEventStreamStore } {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock('2026-07-01T00:00:00.000Z').now });
    const invoked: string[] = [];
    return {
      store,
      invoked,
      writer: {
        append(context, input) {
          invoked.push(input.eventType);
          if (options.only === undefined || options.only === input.eventType) return new Promise(() => {});
          return store.append(context, input);
        },
      },
    };
  }

  it('TEST A — the committed-decision projection never settles: the governed action still reaches the same outcome', { timeout: 30_000 }, async () => {
    const stuck = stuckWriter({ only: 'governance.decision.committed' });
    const world = streamWorld({ writer: stuck.writer });
    const control = streamWorld();
    const [pendingRun, controlRun] = [await world.governed.orchestrator.govern(IDENTITY, intent('stuck-decision')), await control.governed.orchestrator.govern(IDENTITY, intent('stuck-decision'))];
    assert.equal(pendingRun.status, 'executed');
    assert.deepEqual(pendingRun.reasonCodes, controlRun.reasonCodes);
    assert.equal(world.governed.adapter.callCount, 1);
    await tick();
    assert.deepEqual(stuck.invoked, ['governance.decision.committed'], 'the stream is stuck at its first event — and the lifecycle finished anyway');
    assert.ok(world.projector.health().pending >= 1);
  });

  it('TEST B — the claim projection never settles: the adapter is still invoked exactly once, the outcome is still recorded, and a replay is not falsely unconfirmed', { timeout: 30_000 }, async () => {
    const stuck = stuckWriter({ only: 'execution.attempt.claimed' });
    const world = streamWorld({ writer: stuck.writer });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-claim'));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(world.governed.adapter.callCount, 1, 'no pending evidence sat between the claim and the adapter');
    assert.equal(result.status === 'executed' ? result.outcomeRecorded : undefined, true);
    const record = await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
    assert.deepEqual(
      record?.references.filter((reference) => reference.referenceType === 'execution_record').map((reference) => reference.externalVersion),
      ['attempt', 'executed@test.fake-provider'],
    );
    const replay = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-claim'));
    assert.equal(replay.status, 'executed', 'the replay reads the recorded outcome, not "unconfirmed"');
    assert.equal(replay.status === 'executed' ? replay.replayed : undefined, true);
    assert.equal(world.governed.adapter.callCount, 1);
  });

  it('TEST C — the reservation projection never settles: the second grant read, the provider and settlement all still happen', { timeout: 30_000 }, async () => {
    const ledger = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    const stuck = stuckWriter({ only: 'exercise.reservation.reserved' });
    const world = streamWorld({ writer: stuck.writer, exerciseControls: p7({ ledger }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-reservation'));
    assert.equal(result.status, 'executed');
    assert.equal(world.governed.adapter.callCount, 1);
    const grantId = (await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? ''))?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId ?? '';
    const view = await ledger.read(exerciseReservationId({ boundedGrantId: grantId, executionId: result.executionId ?? '' }));
    assert.equal(view?.state, 'settled', 'capacity was finalized, not left consuming behind a stuck evidence write');
    assert.equal(view?.terminal?.reason, 'executed');
  });

  it('TEST C (release) — a post-reservation withholding still releases while its projection is stuck', { timeout: 30_000 }, async () => {
    const ledger = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    let calls = 0;
    const stuck = stuckWriter({ only: 'exercise.reservation.reserved' });
    const world = streamWorld({ writer: stuck.writer, exerciseControls: p7({ ledger, binding: () => ((calls += 1), calls === 1 ? NO_TEMPORAL_BOUND : CHANGED_BINDING) }) });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-reservation-release'));
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    const grantId = (await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? ''))?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId ?? '';
    const view = await ledger.read(exerciseReservationId({ boundedGrantId: grantId, executionId: result.executionId ?? '' }));
    assert.equal(view?.state, 'released');
    assert.equal(world.governed.adapter.callCount, 0);
  });

  it('TEST D — the revocation projection never settles: revokeGrant still resolves, and the next exercise is withheld by the authoritative revocation', { timeout: 30_000 }, async () => {
    const stuck = stuckWriter();
    const world = streamWorld({ writer: stuck.writer });
    const first = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-revocation'));
    const grantId = (await world.governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, first.requestId ?? ''))?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId ?? '';
    const revoked = await world.governed.ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
    assert.equal(revoked.outcome, 'revoked', 'the authoritative result came back with projection still pending');
    assert.equal((await world.governed.ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' })).outcome, 'already-revoked');
    const assessment = await world.governed.ace.assessExercise({
      boundedGrantId: grantId,
      subject: IDENTITY.actor.actorId,
      action: ALLOWED_INTENT.action,
      resource: ALLOWED_INTENT.resource,
      organization: ORG,
      correlation: { requestId: first.requestId ?? '', decisionId: first.decision?.decisionId ?? '', action: ALLOWED_INTENT.action, resourceScope: ALLOWED_INTENT.resource },
      executionId: first.executionId ?? '',
    });
    assert.equal(assessment.usable, false);
    assert.deepEqual([...assessment.reasonCodes], [G.GRANT_EXERCISE_REVOKED], 'revocation is read from the grant store, never from the stream');
  });

  it('TEST E — the outcome projection never settles: the result is still returned, for every certainty', { timeout: 30_000 }, async () => {
    for (const [behaviour, status] of [
      [() => ({ outcome: 'completed' as const, providerRef: 'ref-1' }), 'executed'],
      [() => ({ outcome: 'failed' as const, reason: 'PROVIDER_REJECTED' as const }), 'execution_failed'],
      [() => ({ outcome: 'unconfirmed' as const }), 'execution_unconfirmed'],
    ] as const) {
      const stuck = stuckWriter({ only: 'execution.outcome.observed' });
      const world = streamWorld({ writer: stuck.writer, adapterBehaviour: behaviour });
      const result = await world.governed.orchestrator.govern(IDENTITY, intent(`stuck-outcome-${status}`));
      assert.equal(result.status, status);
      assert.equal(world.governed.adapter.callCount, 1);
      await tick();
      assert.ok(world.projector.health().pending >= 1, 'the outcome projection is still queued');
    }
  });

  it('a stuck lifecycle does not stop the next one from being recorded', { timeout: 30_000 }, async () => {
    const stuck = stuckWriter({ only: 'governance.decision.committed' });
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock('2026-08-01T00:00:00.000Z').now });
    let stickyRequest: string | undefined;
    const writer: AuthorityEventStreamWriter = {
      append(context, input) {
        if (stickyRequest !== undefined && input.references.requestId === stickyRequest) return new Promise(() => {});
        return store.append(context, input);
      },
    };
    const world = streamWorld({ writer });
    stickyRequest = deriveGovernedActionRequestId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, idempotencyKey: 'stuck-lifecycle' });
    const stuckResult = await world.governed.orchestrator.govern(IDENTITY, intent('stuck-lifecycle'));
    const healthy = await world.governed.orchestrator.govern(IDENTITY, intent('healthy-lifecycle'));
    assert.equal(stuckResult.status, 'executed');
    assert.equal(healthy.status, 'executed');
    await tick(10);
    assert.deepEqual(
      (await store.readStream({ organizationId: ORG }, deriveAuthorityEventStreamId({ organizationId: ORG, requestId: healthy.requestId ?? '' }))).map((event) => event.eventType),
      ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed'],
    );
    assert.deepEqual([...(await store.readStream({ organizationId: ORG }, deriveAuthorityEventStreamId({ organizationId: ORG, requestId: stuckResult.requestId ?? '' })))], [], 'the stuck stream wrote nothing');
    assert.equal(stuck.invoked.length, 0);
  });
});

describe('P8 governed action — §31 a projection failure never becomes authority', () => {
  const failingWriter: AuthorityEventStreamWriter = {
    async append() {
      throw new Error('evidence disk full');
    },
  };
  /** A recorder that fails at the call site itself — past the projector's own catch — on every method. */
  const throwingRecorder = new Proxy({} as AuthorityEventRecorder, {
    get: () => () => {
      throw new Error('recorder exploded');
    },
  });

  /** One scenario run three ways: no stream, a stream whose store throws, a recorder that throws. Everything authoritative must be identical. */
  async function threeWays(scenario: (options: WorldOptions & { readonly writer?: AuthorityEventStreamWriter; readonly recorder?: AuthorityEventRecorder }) => Promise<{ readonly world: GovernedWorld; readonly results: readonly GovernedActionResult[]; readonly authority: () => Promise<unknown> }>) {
    const control = await scenario({});
    const failingStore = await scenario({ writer: failingWriter });
    const failingRecorder = await scenario({ recorder: throwingRecorder });
    for (const [label, run] of [['failing store', failingStore], ['throwing recorder', failingRecorder]] as const) {
      assert.deepEqual(run.results, control.results, `${label}: results identical`);
      assert.equal(run.world.adapter.callCount, control.world.adapter.callCount, `${label}: adapter invocations identical`);
      assert.deepEqual(run.world.issueOutcomes.map((outcome) => outcome.outcome), control.world.issueOutcomes.map((outcome) => outcome.outcome), `${label}: no grant minted or withheld differently`);
      assert.deepEqual(await run.authority(), await control.authority(), `${label}: authoritative state identical`);
    }
  }

  /**
   * The same world with or without a stream. The Governance Store gets a
   * deterministic id source, so evaluation ids — and therefore whole results —
   * are comparable across the three runs.
   */
  const clean = (options: WorldOptions & { readonly writer?: AuthorityEventStreamWriter; readonly recorder?: AuthorityEventRecorder }, extra: WorldOptions = {}) => {
    let id = 0;
    const store = createInMemoryGovernanceStore({ nextId: (prefix) => `${prefix}-${(id += 1)}`, now: () => '2026-01-01T00:00:00.000Z' });
    return options.writer === undefined && options.recorder === undefined ? { governed: buildGovernedWorld({ ...extra, store }) } : streamWorld({ ...extra, store, ...options });
  };

  it('denied stays denied; allowed stays allowed', async () => {
    await threeWays(async (options) => {
      const { governed } = clean(options);
      const results = [await governed.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT), await governed.orchestrator.govern(IDENTITY, intent('x-allowed'))];
      assert.deepEqual(results.map((result) => result.status), ['denied', 'executed']);
      return { world: governed, results, authority: async () => governed.adapter.calls.length };
    });
  });

  it('executed stays executed, failed stays failed, unconfirmed stays unconfirmed — and no second adapter invocation', async () => {
    for (const [behaviour, status] of [
      [() => ({ outcome: 'completed' as const, providerRef: 'ref-9' }), 'executed'],
      [() => ({ outcome: 'failed' as const, reason: 'PROVIDER_UNAVAILABLE' as const }), 'execution_failed'],
      [() => ({ outcome: 'unconfirmed' as const }), 'execution_unconfirmed'],
    ] as const) {
      await threeWays(async (options) => {
        const { governed } = clean(options, { adapterBehaviour: behaviour });
        const results = [await governed.orchestrator.govern(IDENTITY, intent(`x-${status}`)), await governed.orchestrator.govern(IDENTITY, intent(`x-${status}`))];
        assert.equal(results[0]?.status, status);
        assert.equal(governed.adapter.callCount, 1, 'the replay never invokes again');
        return { world: governed, results, authority: async () => (await governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, results[0]?.requestId ?? ''))?.references.map((reference) => reference.externalVersion) };
      });
    }
  });

  it('routing is unchanged: the same child performs the effect', async () => {
    const children: RecordingExecutionAdapter[] = [];
    await threeWays(async (options) => {
      const a = createRecordingExecutionAdapter();
      const b = createRecordingExecutionAdapter();
      const registry = createExecutionAdapterRegistry({
        adapters: [
          { adapterId: 'adapter-a', execute: (action) => a.execute(action) },
          { adapterId: 'adapter-b', execute: (action) => b.execute(action) },
        ],
        selectAdapter: () => 'adapter-b',
      });
      children.push(a, b);
      const { governed } = clean(options, { executionAdapter: registry });
      const results = [await governed.orchestrator.govern(IDENTITY, intent('x-routing'))];
      return { world: governed, results, authority: async () => [a.callCount, b.callCount] };
    });
    assert.deepEqual(children.map((child) => child.callCount), [0, 1, 0, 1, 0, 1]);
  });

  for (const [label, changedAfterReservation] of [
    ['settled', false],
    ['released', true],
  ] as const) {
    it(`a reservation is neither released nor settled by a projection failure (${label}): the ledger state is identical`, async () => {
      await threeWays(async (options) => {
        const ledger = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
        let calls = 0;
        const binding = () => ((calls += 1), changedAfterReservation && calls > 1 ? CHANGED_BINDING : NO_TEMPORAL_BOUND);
        const { governed } = clean(options, { exerciseControls: p7({ ledger, binding }) });
        const results = [await governed.orchestrator.govern(IDENTITY, intent('x-p7'))];
        return {
          world: governed,
          results,
          authority: async () => {
            const record = await governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, results[0]?.requestId ?? '');
            const grantId = record?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId ?? '';
            const view = await ledger.read(exerciseReservationId({ boundedGrantId: grantId, executionId: results[0]?.executionId ?? '' }));
            assert.equal(view?.state, label);
            return { state: view?.state, terminal: view?.terminal?.reason };
          },
        };
      });
    });
  }

  it('a revocation stays revoked, and no grant is revoked or minted by a failing projection', async () => {
    await threeWays(async (options) => {
      const { governed } = clean(options);
      const result = await governed.orchestrator.govern(IDENTITY, intent('x-revoke'));
      const record = await governed.rawStore.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
      const grantId = record?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId ?? '';
      const before = await governed.grantStore.read(grantId);
      assert.equal(before.revocation, undefined, 'projection failure revoked nothing');
      const revoked = await governed.ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator:1', revokedAt: '2026-01-01T00:05:00.000Z' });
      assert.equal(revoked.outcome, 'revoked');
      return { world: governed, results: [result], authority: async () => governed.grantStore.read(grantId) };
    });
  });

  it('the failure is visible where operators look, and nowhere a caller does', async () => {
    const world = streamWorld({ writer: failingWriter });
    const result = await world.governed.orchestrator.govern(IDENTITY, intent('x-visible'));
    assert.equal(result.status, 'executed');
    assert.equal(await drained(() => world.projector.health()), true);
    const health = world.projector.health();
    assert.equal(health.status, 'degraded');
    assert.ok(health.failed >= 4);
    assert.equal(health.lastFailureCode, 'AUTHORITY_EVENT_PROJECTION_FAILED');
    assert.equal(JSON.stringify(result).includes('evidence'), false, 'no projection field on the result');
  });
});
