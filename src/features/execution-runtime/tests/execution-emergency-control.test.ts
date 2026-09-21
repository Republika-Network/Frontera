import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMERGENCY_CONTROL_REASON_CODES, createInMemoryEmergencyControlStore } from '../../emergency-control-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrant, type BoundedGrantStorePort } from '../../grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, createGrantExecutionService, type ExecutionOutcome } from '../index.js';
import { buildExerciseRequest, buildTestGrant, createRecordingExecutionAdapter } from './execution-fixture.js';

/**
 * The effect-time interlock, measured the way the rest of this module is
 * measured: **was the adapter called?**
 *
 * The distinguishing property of this gate is that it fires on a world where
 * everything else is fine. The grant exists, is unexpired, unrevoked, and
 * covers the action exactly; the assessment is `usable`; and the provider is
 * still not contacted.
 */

const AT_T_PLUS_5 = '2026-01-01T12:05:00.000Z';
const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';

async function seed(grant: BoundedGrant): Promise<BoundedGrantStorePort> {
  const store = createInMemoryBoundedGrantStore();
  const issued = await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
  assert.equal(issued.outcome, 'issued');
  return store;
}

async function world(options: { readonly at?: string } = {}) {
  const grant = buildTestGrant();
  const store = await seed(grant);
  const adapter = createRecordingExecutionAdapter();
  const controls = createInMemoryEmergencyControlStore();
  const service = createGrantExecutionService({ store, adapter, emergencyControl: controls, now: () => options.at ?? AT_T_PLUS_5 });
  return {
    grant,
    store,
    adapter,
    controls,
    exercise: (): Promise<ExecutionOutcome> => service.exercise(buildExerciseRequest(grant)),
    assess: () => service.assess(buildExerciseRequest(grant)),
  };
}

describe('Exercise-time emergency control — a valid grant does not reach a provider while a stop is active', () => {
  it('a global stop withholds, calls no adapter, and leaves the assessment usable', async () => {
    const { adapter, controls, exercise } = await world();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });

    const outcome = await exercise();
    assert.equal(outcome.status, 'withheld');
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.equal(adapter.callCount, 0);
    assert.equal(outcome.status === 'withheld' ? outcome.assessment.usable : undefined, true);
    assert.deepEqual(outcome.status === 'withheld' ? outcome.assessment.reasonCodes : ['x'], []);
  });

  it('the emergency reasons are carried separately, never inside the grant-exercise vocabulary', async () => {
    const { controls, exercise } = await world();
    controls.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });

    const outcome = await exercise();
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control');
    assert.deepEqual(outcome.emergencyControl.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    // The assessment's own vocabulary is untouched, which is what keeps the two
    // reason-code namespaces disjoint in the record as well as in the type.
    for (const code of outcome.assessment.reasonCodes) {
      assert.equal(String(code).startsWith('GRANT_EXERCISE_'), true);
    }
    assert.deepEqual(outcome.emergencyControl.matchedScopes, [{ scope: 'organization', value: 'org-acme' }]);
  });

  it('an unreadable control withholds and calls no adapter — an outage is never permission', async () => {
    const { adapter, controls, exercise } = await world();
    controls.simulateUnavailable(true);

    const outcome = await exercise();
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control');
    assert.deepEqual(outcome.emergencyControl.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(adapter.callCount, 0);
  });

  it('a reader that throws withholds and calls no adapter', async () => {
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({
      store,
      adapter,
      emergencyControl: {
        read() {
          throw new Error('control plane unreachable');
        },
      },
      now: () => AT_T_PLUS_5,
    });
    const outcome = await service.exercise(buildExerciseRequest(grant));
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control');
    assert.equal(adapter.callCount, 0);
  });

  it('a clear control calls the adapter exactly once', async () => {
    const { adapter, exercise } = await world();
    const outcome = await exercise();
    assert.equal(outcome.status, 'executed');
    assert.equal(adapter.callCount, 1);
  });

  it('a stop that turns on between issuance and exercise is honoured, because the check is at exercise time', async () => {
    const { adapter, controls, exercise } = await world();
    // First attempt runs: the world is clear.
    assert.equal((await exercise()).status, 'executed');
    assert.equal(adapter.callCount, 1);
    // The stop turns on. The grant has not changed at all — it is still valid,
    // still unrevoked, still covering the action.
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    const second = await exercise();
    assert.ok(second.status === 'withheld' && second.withheldBy === 'emergency-control');
    assert.equal(adapter.callCount, 1, 'the second attempt must not reach the provider');
  });

  it('clearing the stop lets execution resume: an interlock is not a revocation', async () => {
    const { adapter, controls, exercise, store, grant } = await world();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal((await exercise()).status, 'withheld');
    controls.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT });

    const outcome = await exercise();
    assert.equal(outcome.status, 'executed');
    assert.equal(adapter.callCount, 1);
    // And the grant itself was never touched: no revocation was recorded.
    const read = await store.read(grant.id);
    assert.equal(read.revocation, undefined);
    assert.deepEqual(read.grant, grant);
  });
});

describe('Exercise-time emergency control — ordering against the grant gate', () => {
  it('an unusable grant is withheld by grant-exercise, not by the interlock, even while a stop is active', async () => {
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const controls = createInMemoryEmergencyControlStore();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    // T+15m: the grant expired at T+10m.
    const service = createGrantExecutionService({ store, adapter, emergencyControl: controls, now: () => '2026-01-01T12:15:00.000Z' });

    const outcome = await service.exercise(buildExerciseRequest(grant));
    assert.ok(outcome.status === 'withheld');
    assert.equal(outcome.withheldBy, 'grant-exercise', 'the grant gate answers first, so an expired grant is reported as expired');
    assert.ok(outcome.assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(adapter.callCount, 0);
  });

  it('assess() stays a pure read of the grant and is not gated by the interlock', async () => {
    const { controls, assess } = await world();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    const assessment = await assess();
    // The question `assess` answers is "does the grant cover this action", and
    // an operational stop is not an answer to it. The gate that matters is
    // `exercise`, which is the only path to a provider.
    assert.equal(assessment.usable, true);
  });

  it('the interlock is queried with trusted values only — the holder read from the store, not the request', async () => {
    const seen: unknown[] = [];
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({
      store,
      adapter,
      emergencyControl: {
        read(query) {
          seen.push(query);
          return { state: 'clear', reasonCodes: [] };
        },
      },
      now: () => AT_T_PLUS_5,
    });
    await service.exercise(buildExerciseRequest(grant));
    assert.deepEqual(seen, [{ organizationId: 'org-acme', actorId: grant.subject, resource: 'vendor/V123' }]);
    // No adapter scope at this checkpoint: the adapter may be a composite, and
    // the child is not known until routing has run.
    assert.equal('adapterId' in (seen[0] as Record<string, unknown>), false);
    assert.equal('workflowId' in (seen[0] as Record<string, unknown>), false);
  });

  it('omitting the reader leaves this service behaving exactly as it did', async () => {
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });
    const outcome = await service.exercise(buildExerciseRequest(grant));
    assert.equal(outcome.status, 'executed');
    assert.equal(adapter.callCount, 1);
  });
});
