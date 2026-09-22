import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  assessGrantExercise,
  createInMemoryBoundedGrantStore,
  type BoundedGrant,
  type BoundedGrantStorePort,
} from '../../grant-runtime/index.js';
import {
  EXECUTION_FAILURE_REASONS,
  GRANT_EXERCISE_REASON_CODES,
  assessBoundedGrantExercise,
  createGrantExecutionService,
  type ExecutionOutcome,
  type GrantExerciseRequest,
} from '../index.js';
import {
  TEST_CORRELATION,
  TEST_EXPIRES_AT,
  buildExerciseRequest,
  buildTestGrant,
  createRecordingExecutionAdapter,
  type ExerciseRequestOverrides,
} from './execution-fixture.js';

/**
 * The gate, measured from the attacker's side of every row.
 *
 * The property under test is never "the assessment said no" on its own — it is
 * **the adapter was not called**. A refusal that still reached a provider would
 * have failed at the only thing this phase exists to guarantee, so every
 * blocked case asserts `callCount === 0` and the one valid case asserts
 * `callCount === 1`.
 */

const AT_T_PLUS_5 = '2026-01-01T12:05:00.000Z';

async function seed(grant: BoundedGrant): Promise<BoundedGrantStorePort> {
  const store = createInMemoryBoundedGrantStore();
  const issued = await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
  assert.equal(issued.outcome, 'issued');
  return store;
}

interface World {
  readonly store: BoundedGrantStorePort;
  readonly adapter: ReturnType<typeof createRecordingExecutionAdapter>;
  readonly exercise: (overrides?: ExerciseRequestOverrides) => Promise<ExecutionOutcome>;
  readonly grant: BoundedGrant;
}

async function world(options: { readonly at?: string; readonly grant?: BoundedGrant } = {}): Promise<World> {
  const grant = options.grant ?? buildTestGrant();
  const store = await seed(grant);
  const adapter = createRecordingExecutionAdapter();
  const service = createGrantExecutionService({ store, adapter, now: () => options.at ?? AT_T_PLUS_5 });
  return {
    store,
    adapter,
    grant,
    exercise: (overrides?: ExerciseRequestOverrides) => service.exercise(buildExerciseRequest(grant, overrides)),
  };
}

function withheldCodes(outcome: ExecutionOutcome): readonly string[] {
  return [...outcome.assessment.reasonCodes];
}

describe('Exercise — a valid grant, a valid action', () => {
  it('executes exactly once and reports the provider result', async () => {
    const { exercise, adapter } = await world();
    const outcome = await exercise();

    assert.equal(outcome.status, 'executed');
    assert.equal(adapter.callCount, 1, 'the adapter runs once for a usable exercise');
    assert.equal(outcome.status === 'executed' ? outcome.providerRef : undefined, 'provider-ref-1');
    assert.equal(outcome.assessment.usable, true);
    assert.deepEqual(outcome.assessment.reasonCodes, []);
  });

  it('a narrower amount succeeds — the ceiling is a ceiling, not an obligation to spend it', async () => {
    const { exercise, adapter } = await world();
    const outcome = await exercise({ amount: { value: 1_000, unit: 'USD' } });

    assert.equal(outcome.status, 'executed');
    assert.equal(adapter.callCount, 1);
  });

  it('the exact ceiling succeeds — attenuation permits equal, and Model A makes 7500 the evaluated amount', async () => {
    const { exercise } = await world();
    assert.equal((await exercise({ amount: { value: 7_500, unit: 'USD' } })).status, 'executed');
  });

  it('repeated exercise of the same valid grant is permitted, and nothing is consumed', async () => {
    // No accepted ADR defines single-use, a use counter, remaining uses, a
    // nonce ledger or destruction after exercise, and `ADR-ACCESS-LIFECYCLE.md`
    // states the opposite for the record *about* use: usage events are "many
    // per `grantRef` — repeatable by design". So repetition is preserved rather
    // than quietly forbidden, and no consumption model is invented here.
    const { exercise, adapter, store, grant } = await world();

    const first = await exercise({ executionId: 'exec-1' });
    const second = await exercise({ executionId: 'exec-2' });

    assert.equal(first.status, 'executed');
    assert.equal(second.status, 'executed');
    assert.equal(adapter.callCount, 2);

    const read = await store.read(grant.id);
    assert.deepEqual(read.grant, grant, 'the grant is byte-identical after two exercises: execution mutates no grant state');
    assert.equal(read.revocation, undefined);
  });
});

describe('Exercise — every refusal withholds the adapter', () => {
  const cases: readonly {
    readonly name: string;
    readonly overrides: ExerciseRequestOverrides;
    readonly code: string;
  }[] = [
    { name: 'wrong subject', overrides: { subject: 'agent-B' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_SUBJECT_MISMATCH },
    { name: 'wrong action', overrides: { action: 'transfer' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE },
    { name: 'wildcard action', overrides: { action: '*' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE },
    { name: 'wrong resource', overrides: { resource: 'vendor/V999' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE },
    { name: 'wildcard resource', overrides: { resource: '*' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE },
    { name: 'wrong counterparty', overrides: { counterparty: 'V999' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE },
    { name: 'wrong organization', overrides: { organization: 'org-attacker' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE },
    { name: 'amount above the ceiling', overrides: { amount: { value: 9_000, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'amount at the policy threshold rather than the evaluated amount', overrides: { amount: { value: 10_000, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'amount in a different unit', overrides: { amount: { value: 10, unit: 'EUR' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'no amount where the grant states a ceiling', overrides: { omitAmount: true }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED },
    { name: 'no counterparty where the grant bounds one', overrides: { omitCounterparty: true }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE },
    { name: 'wrong request correlation', overrides: { correlation: { ...TEST_CORRELATION, requestId: 'req-other' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_CORRELATION_INVALID },
    { name: 'wrong decision correlation', overrides: { correlation: { ...TEST_CORRELATION, decisionId: 'decision-other' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_CORRELATION_INVALID },
    { name: 'unknown grant id', overrides: { boundedGrantId: 'aoc.grant:does-not-exist' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND },
    { name: 'blank grant id', overrides: { boundedGrantId: '' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND },
    { name: 'blank subject', overrides: { subject: '' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REQUEST_MALFORMED },
    { name: 'blank execution id', overrides: { executionId: '' }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REQUEST_MALFORMED },
    { name: 'negative amount', overrides: { amount: { value: -1, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REQUEST_MALFORMED },
    { name: 'non-finite amount', overrides: { amount: { value: Number.POSITIVE_INFINITY, unit: 'USD' } }, code: GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REQUEST_MALFORMED },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} blocks, and the adapter is not called`, async () => {
      const { exercise, adapter } = await world();
      const outcome = await exercise(testCase.overrides);

      assert.equal(outcome.status, 'withheld');
      assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'grant-exercise');
      assert.ok(withheldCodes(outcome).includes(testCase.code), `expected ${testCase.code}, got ${withheldCodes(outcome).join(', ')}`);
      assert.equal(adapter.callCount, 0, 'no provider is reached for a refused exercise');
    });
  }

  it('an expired grant blocks at exactly its expiresAt — the boundary is closed, not open', async () => {
    const { exercise, adapter } = await world({ at: TEST_EXPIRES_AT });
    const outcome = await exercise();

    assert.equal(outcome.status, 'withheld');
    assert.ok(withheldCodes(outcome).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(adapter.callCount, 0);
  });

  it('one millisecond before expiry it is still usable — the boundary is exact', async () => {
    const { exercise } = await world({ at: '2026-01-01T12:09:59.999Z' });
    assert.equal((await exercise()).status, 'executed');
  });

  it('a revoked grant blocks immediately, with no sweeper having run', async () => {
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    assert.equal((await service.exercise(buildExerciseRequest(grant))).status, 'executed');

    const revoked = await store.revoke({ grantId: grant.id, reason: 'policy-changed', revokedAt: AT_T_PLUS_5, issuerRef: 'ops@example.test' });
    assert.equal(revoked.outcome, 'revoked');

    const after = await service.exercise(buildExerciseRequest(grant, { executionId: 'exec-2' }));
    assert.equal(after.status, 'withheld');
    assert.ok(withheldCodes(after).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED));
    assert.equal(adapter.callCount, 1, 'only the pre-revocation exercise reached the provider');
  });

  it('a tampered stored grant blocks — a widened ceiling in the store is refused, never honoured', async () => {
    const trusted = buildTestGrant();
    // The privileged-writer case the digest is honest about: a grant whose
    // fields were edited after issuance no longer matches its own digest.
    const tampered: BoundedGrant = { ...trusted, scope: { ...trusted.scope, amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' } } };
    const store = createInMemoryBoundedGrantStore();
    await store.issue({ grant: tampered, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });

    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const outcome = await service.exercise(buildExerciseRequest(tampered, { amount: { value: 10_000, unit: 'USD' } }));
    assert.equal(outcome.status, 'withheld');
    assert.ok(withheldCodes(outcome).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_INTEGRITY_INVALID));
    assert.equal(adapter.callCount, 0, 'a widened ceiling never becomes authority — the grant is refused entirely');
  });

  it('a store that throws reads as no grant, never as permission', async () => {
    const store: BoundedGrantStorePort = {
      async issue() {
        throw new Error('unavailable');
      },
      async read() {
        throw new Error('unavailable');
      },
      async revoke() {
        throw new Error('unavailable');
      },
    };
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const outcome = await service.exercise(buildExerciseRequest(buildTestGrant()));
    assert.equal(outcome.status, 'withheld');
    assert.deepEqual(withheldCodes(outcome), [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND]);
    assert.equal(adapter.callCount, 0);
  });

  it('reports every failing reason, not only the first', async () => {
    const { exercise } = await world({ at: TEST_EXPIRES_AT });
    const outcome = await exercise({ subject: 'agent-B', resource: 'vendor/V999' });

    const codes = withheldCodes(outcome);
    assert.ok(codes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.ok(codes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_SUBJECT_MISMATCH));
    assert.ok(codes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE));
  });
});

describe('Exercise — the adapter receives a validated action and nothing more', () => {
  it('the subject and the horizon come from the trusted store, never from the request', async () => {
    const { exercise, adapter, grant } = await world();
    await exercise();

    const call = adapter.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.subject, grant.subject);
    assert.equal(call.notAfter, grant.expiresAt);
    assert.equal(call.boundedGrantId, grant.id);
  });

  it('carries no grant, no scope, no digest, no decision and no policy', async () => {
    const { exercise, adapter } = await world();
    await exercise();

    const call = adapter.calls[0] as unknown as Readonly<Record<string, unknown>>;
    assert.ok(call !== undefined);
    for (const forbidden of ['grant', 'scope', 'digest', 'sourceDigest', 'status', 'decision', 'reasonCodes', 'policies', 'obligations', 'context', 'authorizationPermitsExercise', 'validityCeilings']) {
      assert.equal(forbidden in call, false, `the adapter must not receive '${forbidden}' — it has nothing to decide with`);
    }
  });

  it('receives the attempted amount, never the grant’s broader ceiling', async () => {
    const { exercise, adapter } = await world();
    await exercise({ amount: { value: 1_000, unit: 'USD' } });

    const call = adapter.calls[0];
    assert.ok(call !== undefined);
    assert.deepEqual(call.amount, { value: 1_000, unit: 'USD' }, 'the adapter acts on what was attempted and proven, not on the widest thing it could have been');
  });

  it('carries the correlation a later Evidence phase needs', async () => {
    const { exercise, adapter } = await world();
    await exercise({ executionId: 'exec-77' });

    const call = adapter.calls[0];
    assert.ok(call !== undefined);
    assert.deepEqual(call.correlation, { requestId: TEST_CORRELATION.requestId, decisionId: TEST_CORRELATION.decisionId, executionId: 'exec-77' });
  });
});

describe('Exercise — a provider failure is a provider failure', () => {
  it('an adapter reporting failure is not an authorization outcome', async () => {
    const store = await seed(buildTestGrant());
    const adapter = createRecordingExecutionAdapter(() => ({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: 'timeout' }));
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const outcome = await service.exercise(buildExerciseRequest(buildTestGrant()));
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE);
    assert.equal(outcome.assessment.usable, true, 'authority was sufficient; the provider is what failed');
  });

  it('an adapter that throws becomes ADAPTER_ERROR rather than escaping', async () => {
    const store = await seed(buildTestGrant());
    const adapter = createRecordingExecutionAdapter(() => {
      throw new Error('provider exploded');
    });
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const outcome = await service.exercise(buildExerciseRequest(buildTestGrant()));
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
  });
});

describe('Exercise — the clock is sampled after the authoritative read', () => {
  /**
   * A store whose read takes real time, as a durable one does.
   *
   * The clock advances while the read is in flight, so an instant sampled
   * *before* the lookup is not the instant the grant is being judged at. The
   * window here is the one the review named: a read that begins one millisecond
   * before `expiresAt` and completes at `expiresAt`.
   */
  function slowStore(grant: BoundedGrant, startsAt: string, completesAt: string): { readonly store: BoundedGrantStorePort; readonly now: () => string } {
    // The clock advances *because the read took time*, not because of how many
    // times it was called. That is what makes this a real reproduction: a
    // service that samples before the lookup sees `startsAt` however it is
    // written, and one that samples after sees `completesAt`.
    let instant = startsAt;
    return {
      store: {
        async issue() {
          throw new Error('not used');
        },
        async read() {
          await Promise.resolve();
          instant = completesAt;
          return { grant };
        },
        async revoke() {
          throw new Error('not used');
        },
      },
      now: () => instant,
    };
  }

  it('a read that spans the expiry boundary withholds the adapter', async () => {
    const grant = buildTestGrant();
    const { store, now } = slowStore(grant, '2026-01-01T12:09:59.999Z', TEST_EXPIRES_AT);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now });

    const outcome = await service.exercise(buildExerciseRequest(grant));

    assert.equal(outcome.status, 'withheld', 'the grant expired while the store was answering; it is judged at the instant the record arrived');
    assert.ok(withheldCodes(outcome).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(adapter.callCount, 0);
  });

  it('the reported exercisedAt is the post-read instant, so the outcome and the assessment agree', async () => {
    const grant = buildTestGrant();
    const { store, now } = slowStore(grant, '2026-01-01T12:09:59.999Z', TEST_EXPIRES_AT);
    const service = createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now });

    const outcome = await service.exercise(buildExerciseRequest(grant));
    assert.equal(outcome.exercisedAt, TEST_EXPIRES_AT, 'an outcome timestamped before the read would misdate the evidence chain too');
  });

  it('assess() samples it after the read as well', async () => {
    const grant = buildTestGrant();
    const { store, now } = slowStore(grant, '2026-01-01T12:09:59.999Z', TEST_EXPIRES_AT);
    const service = createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now });

    const assessment = await service.assess(buildExerciseRequest(grant));
    assert.equal(assessment.usable, false);
    assert.ok(assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
  });

  it('a read that completes before expiry is still usable — the fix does not over-refuse', async () => {
    const grant = buildTestGrant();
    const { store, now } = slowStore(grant, '2026-01-01T12:04:00.000Z', '2026-01-01T12:05:00.000Z');
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now });

    assert.equal((await service.exercise(buildExerciseRequest(grant))).status, 'executed');
    assert.equal(adapter.callCount, 1);
  });
});

describe('Exercise — assess() runs nothing', () => {
  it('a usable assessment still contacts no provider', async () => {
    const store = await seed(buildTestGrant());
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const assessment = await service.assess(buildExerciseRequest(buildTestGrant()));
    assert.equal(assessment.usable, true);
    assert.equal(adapter.callCount, 0, 'preflight is preflight: it answers, it does not act');
  });
});

describe('Exercise — the two assessors agree on the facts they share', () => {
  for (const scenario of [
    { name: 'valid', at: AT_T_PLUS_5, revoke: false },
    { name: 'expired', at: TEST_EXPIRES_AT, revoke: false },
    { name: 'revoked', at: AT_T_PLUS_5, revoke: true },
  ]) {
    it(`${scenario.name}: the grant runtime and the execution runtime reach the same verdict`, async () => {
      const grant = buildTestGrant();
      const store = await seed(grant);
      if (scenario.revoke) await store.revoke({ grantId: grant.id, reason: 'policy-changed', revokedAt: AT_T_PLUS_5, issuerRef: 'ops' });
      const read = await store.read(grant.id);
      assert.ok(read.grant !== undefined);

      const layerE = assessGrantExercise({ grant: read.grant, ...(read.revocation !== undefined ? { revocation: read.revocation } : {}), at: scenario.at });
      const composed = assessBoundedGrantExercise({
        grant: read.grant,
        ...(read.revocation !== undefined ? { revocation: read.revocation } : {}),
        request: buildExerciseRequest(grant),
        at: scenario.at,
      });

      assert.equal(composed.usable, layerE.eligibility === 'exercisable', 'a rule restated by hand is a rule that can drift; this asserts it has not');
      assert.equal(
        composed.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED),
        layerE.reasonCodes.includes(GRANT_REASON_CODES.GRANT_EXPIRED),
      );
      assert.equal(
        composed.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED),
        layerE.reasonCodes.includes(GRANT_REASON_CODES.GRANT_REVOKED),
      );
    });
  }
});

describe('Exercise — a grant that bounds no optional axis', () => {
  it('accepts an attempt that states none either', async () => {
    const grant = buildTestGrant({
      scope: { action: { kind: 'identity', value: 'payment' }, resources: { kind: 'set', values: ['vendor/V123'] } },
    });
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const request: GrantExerciseRequest = buildExerciseRequest(grant, { omitAmount: true, omitCounterparty: true, omitOrganization: true });
    assert.equal((await service.exercise(request)).status, 'executed');
  });

  it('refuses an attempt that asserts an axis the authorization never bounded', async () => {
    const grant = buildTestGrant({
      scope: { action: { kind: 'identity', value: 'payment' }, resources: { kind: 'set', values: ['vendor/V123'] } },
    });
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });

    const outcome = await service.exercise(buildExerciseRequest(grant, { omitCounterparty: true, omitOrganization: true, amount: { value: 1, unit: 'USD' } }));
    assert.equal(outcome.status, 'withheld');
    assert.ok(withheldCodes(outcome).includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED));
    assert.equal(adapter.callCount, 0);
  });
});

describe('P6 — a provider contacted with its answer lost is execution-unconfirmed, not a failure', () => {
  async function exerciseWith(result: Parameters<typeof createRecordingExecutionAdapter>[0]): Promise<{ outcome: ExecutionOutcome; calls: number }> {
    const grant = buildTestGrant();
    const store = await seed(grant);
    const adapter = createRecordingExecutionAdapter(result);
    const service = createGrantExecutionService({ store, adapter, now: () => AT_T_PLUS_5 });
    const outcome = await service.exercise(buildExerciseRequest(grant));
    return { outcome, calls: adapter.callCount };
  }

  it('an unconfirmed adapter result becomes status execution-unconfirmed, with the usable assessment and the adapter named', async () => {
    const { outcome, calls } = await exerciseWith(() => ({ outcome: 'unconfirmed', detail: 'lost after send' }));
    assert.equal(calls, 1, 'the adapter ran exactly once');
    assert.equal(outcome.status, 'execution-unconfirmed');
    assert.ok(outcome.status === 'execution-unconfirmed');
    assert.equal(outcome.assessment.usable, true);
    assert.equal(outcome.adapterId, 'test.fake-provider');
    assert.equal(outcome.detail, 'lost after send');
    assert.equal(outcome.exercisedAt, AT_T_PLUS_5);
    assert.equal(outcome.correlation.executionId, buildExerciseRequest(buildTestGrant()).executionId);
  });

  it('a definitive provider failure is still execution-failed — the two are never merged', async () => {
    const { outcome } = await exerciseWith(() => ({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE }));
    assert.equal(outcome.status, 'execution-failed');
  });
});
