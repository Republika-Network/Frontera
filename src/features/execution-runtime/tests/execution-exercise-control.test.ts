import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMERGENCY_CONTROL_REASON_CODES, createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../emergency-control-runtime/index.js';
import {
  EXERCISE_CONTROL_REASON_CODES as X,
  createExerciseControlGate,
  createInMemoryExerciseControlLedger,
  exerciseReservationId,
  type ExerciseControlLedgerPort,
  type ExerciseControlLimit,
  type ExerciseControlPolicy,
  type ExerciseControlQuery,
} from '../../exercise-control-runtime/index.js';
import { BINDING, OTHER_BINDING, amount, count } from '../../exercise-control-runtime/tests/exercise-control-ledger-contract.js';
import { createInMemoryBoundedGrantStore, type BoundedGrant } from '../../grant-runtime/index.js';
import {
  GRANT_EXERCISE_REASON_CODES,
  createExecutionAdapterRegistry,
  createGrantExecutionService,
  type ExecutionAdapter,
  type ExecutionAdapterResult,
  type ExecutionOutcome,
  type GrantExerciseRequest,
  type ValidatedExecutionAction,
} from '../index.js';
import { buildExerciseRequest, buildTestGrant, createRecordingExecutionAdapter, type RecordingExecutionAdapter } from './execution-fixture.js';

/**
 * P7 inside the canonical gate, measured the way this module measures
 * everything: **was the adapter called, and what happened to the reservation?**
 *
 * ```
 * grant read -> containment -> emergency -> binding #1 -> policy -> RESERVE
 *   -> binding #2 -> emergency #2 -> adapter -> settle | release
 * ```
 */

const AT = '2026-01-01T12:05:00.000Z';
const ISSUER = 'operator:on-call';

interface LedgerCounts {
  reserve: number;
  settle: number;
  release: number;
}

interface Faults {
  reserveThrows?: boolean;
  reserveReturns?: unknown;
  settleThrows?: boolean;
  releaseThrows?: boolean;
  duringReserve?: () => void;
}

function instrumented(inner: ExerciseControlLedgerPort, counts: LedgerCounts, faults: Faults): ExerciseControlLedgerPort {
  return {
    async reserve(request) {
      counts.reserve += 1;
      if (faults.reserveThrows === true) throw new Error('ledger unreachable');
      if (faults.reserveReturns !== undefined) return faults.reserveReturns as never;
      const outcome = await inner.reserve(request);
      faults.duringReserve?.();
      return outcome;
    },
    async settle(input) {
      counts.settle += 1;
      if (faults.settleThrows === true) throw new Error('ledger unreachable');
      return inner.settle(input);
    },
    async release(input) {
      counts.release += 1;
      if (faults.releaseThrows === true) throw new Error('ledger unreachable');
      return inner.release(input);
    },
    read: (reservationId) => inner.read(reservationId),
  };
}

interface WorldOptions {
  readonly limits?: readonly ExerciseControlLimit[];
  readonly policy?: ExerciseControlPolicy;
  readonly binding?: (query: ExerciseControlQuery, call: number) => string | undefined;
  readonly grant?: BoundedGrant;
  readonly behaviour?: (action: ValidatedExecutionAction) => ExecutionAdapterResult | Promise<ExecutionAdapterResult>;
  readonly faults?: Faults;
  readonly adapter?: (controls: ReturnType<typeof createInMemoryEmergencyControlStore>) => ExecutionAdapter;
  readonly composeExerciseControl?: boolean;
}

async function world(options: WorldOptions = {}) {
  const grant = options.grant ?? buildTestGrant({ authorityBindingDigest: BINDING });
  const store = createInMemoryBoundedGrantStore();
  assert.equal((await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) })).outcome, 'issued');
  const recording = createRecordingExecutionAdapter(options.behaviour);
  const controls = createInMemoryEmergencyControlStore();
  const counts: LedgerCounts = { reserve: 0, settle: 0, release: 0 };
  const faults: Faults = { ...options.faults };
  const inner = createInMemoryExerciseControlLedger();
  const ledger = instrumented(inner, counts, faults);
  const policyQueries: ExerciseControlQuery[] = [];
  const bindingQueries: ExerciseControlQuery[] = [];
  let bindingCalls = 0;
  const gate = createExerciseControlGate({
    policy:
      options.policy ??
      ((query) => {
        policyQueries.push(query);
        return options.limits ?? [count('grant-uses', `grant:${query.boundedGrantId}`, 1)];
      }),
    authorityBinding: (query) => {
      bindingQueries.push(query);
      bindingCalls += 1;
      return options.binding === undefined ? BINDING : options.binding(query, bindingCalls);
    },
    reservationLedger: ledger,
    now: () => AT,
  });
  const adapter = options.adapter?.(controls) ?? recording;
  const service = createGrantExecutionService({
    store,
    adapter,
    emergencyControl: createEmergencyControlReader(controls),
    ...(options.composeExerciseControl === false ? {} : { exerciseControl: gate }),
    now: () => AT,
  });
  const reservationIdFor = (executionId: string) => exerciseReservationId({ boundedGrantId: grant.id, executionId });
  return {
    grant,
    store,
    adapter: recording,
    controls,
    counts,
    faults,
    ledger: inner,
    policyQueries,
    bindingQueries,
    exercise: (request: GrantExerciseRequest = buildExerciseRequest(grant)): Promise<ExecutionOutcome> => service.exercise(request),
    stateOf: async (executionId = 'exec-1') => (await inner.read(reservationIdFor(executionId)))?.state,
    reasonOf: async (executionId = 'exec-1') => (await inner.read(reservationIdFor(executionId)))?.terminal?.reason,
  };
}

function exerciseControlCodes(outcome: ExecutionOutcome): readonly string[] {
  assert.equal(outcome.status, 'withheld', JSON.stringify(outcome));
  assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'exercise-control', JSON.stringify(outcome));
  return outcome.exerciseControl.reasonCodes;
}

describe('P7 in the gate — composition is opt-in', () => {
  it('A. without exercise controls, nothing changes: the adapter runs and no reservation exists', async () => {
    const w = await world({ composeExerciseControl: false });
    assert.equal((await w.exercise()).status, 'executed');
    assert.equal((await w.exercise()).status, 'executed', 'the same execution id executes again exactly as before P7');
    assert.equal(w.adapter.callCount, 2);
    assert.deepEqual(w.counts, { reserve: 0, settle: 0, release: 0 });
  });

  it('a legacy grant without binding provenance still executes when P7 is not composed', async () => {
    const w = await world({ composeExerciseControl: false, grant: buildTestGrant() });
    assert.equal(w.grant.authorityBindingDigest, undefined);
    assert.equal((await w.exercise()).status, 'executed');
  });

  it('with exercise controls, a usable exercise reserves exactly once, invokes the adapter once, and settles', async () => {
    const w = await world();
    const outcome = await w.exercise();
    assert.equal(outcome.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
    assert.deepEqual(w.counts, { reserve: 1, settle: 1, release: 0 });
    assert.equal(await w.stateOf(), 'settled');
    assert.equal(await w.reasonOf(), 'executed');
  });

  it('the adapter receives exactly the validated action it always did — no reservation, limit or ledger crosses the boundary', async () => {
    const plain = await world({ composeExerciseControl: false });
    const gated = await world();
    await plain.exercise();
    await gated.exercise();
    assert.deepEqual(gated.adapter.calls[0], plain.adapter.calls[0]);
    for (const key of Object.keys(gated.adapter.calls[0] ?? {})) assert.equal(/reservation|limit|ledger|quota|budget|binding/i.test(key), false, key);
  });
});

describe('P7 in the gate — §45 settlement and release follow the observed outcome', () => {
  const rows: readonly (readonly [string, WorldOptions['behaviour'], ExecutionOutcome['status'], 'settled' | 'released', string])[] = [
    ['1. executed → settled', () => ({ outcome: 'completed', providerRef: 'p-1' }), 'executed', 'settled', 'executed'],
    ['2. unconfirmed → settled', () => ({ outcome: 'unconfirmed' }), 'execution-unconfirmed', 'settled', 'execution-unconfirmed'],
    ['3. PROVIDER_REJECTED → released', () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }), 'execution-failed', 'released', 'execution-failed'],
    ['4. PROVIDER_UNAVAILABLE → released', () => ({ outcome: 'failed', reason: 'PROVIDER_UNAVAILABLE' }), 'execution-failed', 'released', 'execution-failed'],
    ['5. ADAPTER_ERROR → released', () => ({ outcome: 'failed', reason: 'ADAPTER_ERROR' }), 'execution-failed', 'released', 'execution-failed'],
    [
      '6. adapter throw → released',
      () => {
        throw new Error('socket reset');
      },
      'execution-failed',
      'released',
      'execution-failed',
    ],
    ['7. malformed adapter result → released', () => ({ outcome: 'teleported' }) as unknown as ExecutionAdapterResult, 'execution-failed', 'released', 'execution-failed'],
  ];
  for (const [label, behaviour, status, state, reason] of rows) {
    it(label, async () => {
      const w = await world({ ...(behaviour !== undefined ? { behaviour } : {}) });
      const outcome = await w.exercise();
      assert.equal(outcome.status, status);
      assert.equal(w.adapter.callCount, 1);
      assert.equal(await w.stateOf(), state);
      assert.equal(await w.reasonOf(), reason);
    });
  }

  it('16 (§42). an unconfirmed effect does not return amount capacity; a definite failure does', async () => {
    const limits = [amount('spend', 'grant:spend', '7500', 'USD')];
    const unconfirmed = await world({ limits, behaviour: () => ({ outcome: 'unconfirmed' }) });
    assert.equal((await unconfirmed.exercise()).status, 'execution-unconfirmed');
    assert.deepEqual(exerciseControlCodes(await unconfirmed.exercise(buildExerciseRequest(unconfirmed.grant, { executionId: 'exec-2' }))), [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);

    const failed = await world({ limits, behaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    assert.equal((await failed.exercise()).status, 'execution-failed');
    assert.equal((await failed.exercise(buildExerciseRequest(failed.grant, { executionId: 'exec-2' }))).status, 'execution-failed', 'the released capacity was available again');
    assert.equal(failed.adapter.callCount, 2);
  });

  it('15. a settlement the ledger cannot record never rewrites the executed outcome, and the reservation keeps consuming', async () => {
    const w = await world({ faults: { settleThrows: true } });
    const outcome = await w.exercise();
    assert.equal(outcome.status, 'executed', 'the provider outcome stands');
    assert.equal(await w.stateOf(), 'reserved');
    assert.deepEqual(exerciseControlCodes(await w.exercise(buildExerciseRequest(w.grant, { executionId: 'exec-2' }))), [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(w.adapter.callCount, 1);
  });

  it('16. a release the ledger cannot record is not pretended: the reservation keeps consuming', async () => {
    const w = await world({ faults: { releaseThrows: true }, behaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    assert.equal((await w.exercise()).status, 'execution-failed');
    assert.equal(await w.stateOf(), 'reserved');
    assert.deepEqual(exerciseControlCodes(await w.exercise(buildExerciseRequest(w.grant, { executionId: 'exec-2' }))), [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(w.adapter.callCount, 1);
  });
});

describe('P7 in the gate — aggregate refusals reach no adapter', () => {
  it('limit exceeded: withheld by exercise-control, assessment still usable, codes outside the grant vocabulary', async () => {
    const w = await world();
    await w.exercise();
    const second = await w.exercise(buildExerciseRequest(w.grant, { executionId: 'exec-2' }));
    assert.deepEqual(exerciseControlCodes(second), [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.ok(second.status === 'withheld');
    assert.equal(second.assessment.usable, true);
    assert.deepEqual(second.assessment.reasonCodes, [], 'no EXERCISE_CONTROL_* code enters the grant-exercise assessment');
    assert.equal(w.adapter.callCount, 1);
  });

  it('H / §38. the same execution identity cannot invoke the adapter twice — even after it settled', async () => {
    const w = await world({ limits: [count('roomy', 'grant:roomy', 100)] });
    assert.equal((await w.exercise()).status, 'executed');
    assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_EXECUTION_ALREADY_RESERVED]);
    assert.equal(w.adapter.callCount, 1);
    assert.equal(w.counts.settle, 1, 'the duplicate finalizes nothing');
  });

  it('the same execution id with an altered attempt is a reservation conflict and reaches no adapter', async () => {
    const w = await world({ limits: [count('roomy', 'grant:roomy', 100)] });
    await w.exercise();
    const altered = await w.exercise(buildExerciseRequest(w.grant, { amount: { value: 1, unit: 'USD' } }));
    assert.deepEqual(exerciseControlCodes(altered), [X.EXERCISE_CONTROL_RESERVATION_CONFLICT]);
    assert.equal(w.adapter.callCount, 1);
  });

  it('a ledger that throws or answers outside its contract withholds — unavailable is never empty', async () => {
    for (const faults of [{ reserveThrows: true }, { reserveReturns: { outcome: 'maybe' } }, { reserveReturns: null }, { reserveReturns: { outcome: 'refused', reasonCodes: ['EMERGENCY_CONTROL_ACTIVE'] } }] as const) {
      const w = await world({ faults });
      assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_LEDGER_UNAVAILABLE], JSON.stringify(faults));
      assert.equal(w.adapter.callCount, 0);
    }
  });

  it('an invalid policy answer withholds before any reservation', async () => {
    const hostile = new Proxy([count('a', 'b', 1)], {
      get() {
        throw new Error('trap');
      },
    });
    for (const policy of [
      () => {
        throw new Error('policy crashed');
      },
      () => Promise.resolve([]) as unknown as readonly ExerciseControlLimit[],
      () => hostile,
      () => [count('dup', 's', 1), count('dup', 's', 2)],
      () => [{ ...count('x', 's', 1), adapterId: 'stripe' }] as unknown as readonly ExerciseControlLimit[],
    ] as const) {
      const w = await world({ policy });
      assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_POLICY_INVALID]);
      assert.equal(w.counts.reserve, 0);
      assert.equal(w.adapter.callCount, 0);
    }
  });

  it('§42.7–8. an amount limit with no amount, or in another unit, withholds before any reservation', async () => {
    const noAmount = await world({ limits: [amount('spend', 's', '100', 'USD')], grant: buildTestGrant({ authorityBindingDigest: BINDING, scope: { action: { kind: 'identity', value: 'payment' }, counterparty: { kind: 'identity', value: 'V123' }, organization: { kind: 'identity', value: 'org-acme' }, resources: { kind: 'set', values: ['vendor/V123'] } } }) });
    assert.deepEqual(exerciseControlCodes(await noAmount.exercise(buildExerciseRequest(noAmount.grant, { omitAmount: true }))), [X.EXERCISE_CONTROL_AMOUNT_REQUIRED]);
    assert.equal(noAmount.counts.reserve, 0);

    const eur = await world({ limits: [amount('spend', 's', '100000', 'EUR')] });
    assert.deepEqual(exerciseControlCodes(await eur.exercise()), [X.EXERCISE_CONTROL_UNIT_MISMATCH], 'a USD attempt is never converted into an EUR limit');
    assert.equal(eur.counts.reserve, 0);
    assert.equal(noAmount.adapter.callCount + eur.adapter.callCount, 0);
  });

  it('0.1 + 0.2 under a maximum of 0.3 executes twice, then refuses', async () => {
    const limits = [amount('spend', 'grant:cents', '0.3', 'USD')];
    const w = await world({ limits });
    assert.equal((await w.exercise(buildExerciseRequest(w.grant, { executionId: 'e-1', amount: { value: 0.1, unit: 'USD' } }))).status, 'executed');
    assert.equal((await w.exercise(buildExerciseRequest(w.grant, { executionId: 'e-2', amount: { value: 0.2, unit: 'USD' } }))).status, 'executed');
    assert.deepEqual(exerciseControlCodes(await w.exercise(buildExerciseRequest(w.grant, { executionId: 'e-3', amount: { value: 0.0000001, unit: 'USD' } }))), [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(w.adapter.callCount, 2);
  });

  it('an unusable grant is refused by the grant layer first, and P7 is never consulted', async () => {
    const w = await world();
    const outcome = await w.exercise(buildExerciseRequest(w.grant, { amount: { value: 1_000_000, unit: 'USD' } }));
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'grant-exercise');
    assert.deepEqual(outcome.assessment.reasonCodes, [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED]);
    assert.equal(w.bindingQueries.length + w.policyQueries.length + w.counts.reserve, 0, 'aggregate controls can only narrow a covered attempt, never evaluate an uncovered one');
  });
});

describe('P7 in the gate — §47 exercise-time authority-binding revalidation', () => {
  it('15. a legacy grant without binding provenance is withheld as unverifiable when P7 is composed', async () => {
    const w = await world({ grant: buildTestGrant() });
    assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE]);
    assert.deepEqual(w.counts, { reserve: 0, settle: 0, release: 0 });
    assert.equal(w.adapter.callCount, 0);
  });

  it('12–14. an undefined, throwing or malformed resolver answer is unverifiable', async () => {
    for (const binding of [
      () => undefined,
      () => {
        throw new Error('authority store down');
      },
      () => 'not-a-digest',
    ] as const) {
      const w = await world({ binding });
      assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE]);
      assert.equal(w.counts.reserve, 0);
      assert.equal(w.adapter.callCount, 0);
    }
  });

  it('9–11. a changed binding is withheld as changed, before any reservation', async () => {
    const w = await world({ binding: () => OTHER_BINDING });
    assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    assert.equal(w.counts.reserve, 0);
    assert.equal(w.adapter.callCount, 0);
  });

  it('17. a binding that changes between check #1 and #2 releases the reservation and reaches no adapter', async () => {
    const w = await world({ binding: (_query, call) => (call === 1 ? BINDING : OTHER_BINDING) });
    assert.deepEqual(exerciseControlCodes(await w.exercise()), [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    assert.deepEqual(w.counts, { reserve: 1, settle: 0, release: 1 });
    assert.equal(await w.stateOf(), 'released');
    assert.equal(await w.reasonOf(), 'exercise-control');
    assert.equal(w.adapter.callCount, 0);
  });

  it('18. the resolver and the policy receive only trusted, contained material — never the caller request object', async () => {
    const w = await world();
    const request = { ...buildExerciseRequest(w.grant), assertedContext: { budget: 1e9 }, limitId: 'caller-limit', scopeKey: 'caller-scope', reservationId: 'caller-reservation' } as GrantExerciseRequest;
    assert.equal((await w.exercise(request)).status, 'executed');
    for (const query of [...w.policyQueries, ...w.bindingQueries]) {
      assert.ok(Object.isFrozen(query) && Object.isFrozen(query.correlation));
      assert.deepEqual(Object.keys(query).sort(), ['action', 'amount', 'at', 'boundedGrantId', 'correlation', 'counterparty', 'grantExpiresAt', 'grantIssuedAt', 'organization', 'resource', 'subject']);
      assert.equal(query.subject, w.grant.subject, 'the holder comes from the authoritative grant');
      assert.equal(query.grantExpiresAt, w.grant.expiresAt);
      assert.equal(query.grantIssuedAt, w.grant.issuedAt);
      assert.equal(JSON.stringify(query).includes('caller-'), false);
      assert.equal(JSON.stringify(query).includes('1000000000'), false);
    }
    assert.equal(w.bindingQueries.length, 2, 'revalidated twice: before and after the reservation');
  });

  it('19. the resolver cannot widen the grant: a matching binding on an expired grant is never even asked', async () => {
    const w = await world({ grant: buildTestGrant({ authorityBindingDigest: BINDING, expiresAt: '2026-01-01T12:01:00.000Z' }) });
    const outcome = await w.exercise();
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'grant-exercise');
    assert.equal(w.bindingQueries.length, 0);
  });
});

describe('P7 in the gate — §48 emergency interaction', () => {
  it('1–2. an active or unreadable stop before the reservation: zero reservations, zero adapter calls', async () => {
    const active = await world();
    active.controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    const stopped = await active.exercise();
    assert.ok(stopped.status === 'withheld' && stopped.withheldBy === 'emergency-control');
    assert.equal(active.counts.reserve, 0);

    const unreadable = await world();
    unreadable.controls.simulateUnavailable(true);
    const unknown = await unreadable.exercise();
    assert.ok(unknown.status === 'withheld' && unknown.withheldBy === 'emergency-control');
    assert.deepEqual(unknown.emergencyControl.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(unreadable.counts.reserve, 0);
    assert.equal(active.adapter.callCount + unreadable.adapter.callCount, 0);
  });

  it('3. a stop activated during the reservation is seen by the re-check: released, zero adapter calls', async () => {
    let world_: Awaited<ReturnType<typeof world>> | undefined;
    const w = await world({
      faults: {
        duringReserve: () => {
          world_?.controls.activate({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: AT });
        },
      },
    });
    world_ = w;
    const outcome = await w.exercise();
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control', JSON.stringify(outcome));
    assert.deepEqual(outcome.emergencyControl.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(await w.stateOf(), 'released');
    assert.equal(await w.reasonOf(), 'emergency-control');
    assert.equal(w.adapter.callCount, 0);
  });

  it('4. an adapter-scoped stop inside the registry releases the reservation and reaches no child', async () => {
    let child: RecordingExecutionAdapter | undefined;
    const w = await world({
      adapter: (controls) => {
        child = createRecordingExecutionAdapter();
        return createExecutionAdapterRegistry({ adapters: [child], selectAdapter: () => 'test.fake-provider', emergencyControl: createEmergencyControlReader(controls) });
      },
    });
    w.controls.activate({ scope: 'adapter', value: 'test.fake-provider', issuerRef: ISSUER, declaredAt: AT });
    const outcome = await w.exercise();
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control', JSON.stringify(outcome));
    assert.equal(child?.callCount, 0);
    assert.equal(await w.stateOf(), 'released');
    assert.equal(await w.reasonOf(), 'emergency-control');
  });
});
