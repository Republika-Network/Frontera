import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GovernedParameter } from '../../governed-parameter-runtime/index.js';
import { GRANT_SEMANTICS_FORMAT_V1, type BoundedGrant, type BoundedGrantReaderPort, type GrantScope } from '../../grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES as E, createGrantExecutionService, type GrantExerciseRequest, type ValidatedExecutionAction } from '../index.js';
import { buildTestGrant, createRecordingExecutionAdapter } from './execution-fixture.js';

/**
 * CORE-08 — typed governed parameters cross the execution boundary, and only
 * the ones the exercise gate proved.
 *
 * `GrantExecutionService` is the production gate. The adapter is a recorder,
 * so what is asserted is the exact `ValidatedExecutionAction` a provider
 * translation would receive: every dimension, type and value; frozen, fresh
 * data with no reference into the caller's objects; and the value that was
 * assessed — not a value a caller substituted while the exercise awaited.
 *
 * The dimension names are test data. Nothing in the execution runtime knows
 * what any of them means.
 */

const PROFILE = `reference-profile@1#sha256:${'a'.repeat(64)}`;
const CORRELATION = { requestId: 'req-core08', decisionId: 'dec-core08', action: 'reference-action', resourceScope: 'reference-resource' };
const SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'reference-action' },
  actionClass: { kind: 'identity', value: 'reference_action_class' },
  resourceClass: { kind: 'identity', value: 'reference_resource_class' },
  governanceProfile: { kind: 'identity', value: PROFILE },
  organization: { kind: 'identity', value: 'org-core08' },
  parameters: [
    { dimension: 'dryRun', kind: 'exact', type: 'boolean', value: false },
    { dimension: 'mode', kind: 'exact', type: 'token', value: 'Rolling' },
    { dimension: 'quantity', kind: 'maximum', type: 'integer', limit: 4 },
  ],
  resources: { kind: 'set', values: ['reference-resource'] },
};
const GRANT = buildTestGrant({ correlation: CORRELATION, scope: SCOPE, subject: 'agent-core08', semanticsFormat: GRANT_SEMANTICS_FORMAT_V1 });
const NOW = '2026-01-01T12:05:00.000Z';

const EXACT: readonly GovernedParameter[] = [
  { dimension: 'dryRun', type: 'boolean', value: false },
  { dimension: 'mode', type: 'token', value: 'Rolling' },
  { dimension: 'quantity', type: 'integer', value: 4 },
];

/** `'none'` states no parameter list at all (an explicit `undefined` would select the default). */
function request(stated: readonly GovernedParameter[] | 'none' = EXACT.map((entry) => ({ ...entry }) as GovernedParameter), grant: BoundedGrant = GRANT): GrantExerciseRequest {
  const parameters = stated === 'none' ? undefined : stated;
  return {
    boundedGrantId: grant.id,
    subject: 'agent-core08',
    action: 'reference-action',
    resource: 'reference-resource',
    organization: 'org-core08',
    governanceProfile: PROFILE,
    actionClass: 'reference_action_class',
    resourceClass: 'reference_resource_class',
    ...(parameters !== undefined ? { parameters } : {}),
    correlation: CORRELATION,
    executionId: 'exec-core08',
  };
}

function storeOf(grant: BoundedGrant, onRead?: () => void): BoundedGrantReaderPort {
  return {
    async read(grantId) {
      onRead?.();
      return grantId === grant.id ? { grant } : {};
    },
  } as BoundedGrantReaderPort;
}

function serviceFor(grant: BoundedGrant = GRANT, onRead?: () => void) {
  const adapter = createRecordingExecutionAdapter();
  const service = createGrantExecutionService({ store: storeOf(grant, onRead), adapter, now: () => NOW });
  return { adapter, service };
}

function only(calls: readonly ValidatedExecutionAction[]): ValidatedExecutionAction {
  assert.equal(calls.length, 1, 'exactly one adapter invocation');
  return calls[0] as ValidatedExecutionAction;
}

describe('CORE-08 §5 / §7 — the adapter receives exactly the exercised canonical parameters', () => {
  it('every dimension, type and value arrives exactly — integer, case-sensitive token and boolean false included', async () => {
    const { adapter, service } = serviceFor();
    const outcome = await service.exercise(request());
    assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
    const action = only(adapter.calls);
    assert.deepEqual(action.parameters, EXACT);
    const [dryRun, mode, quantity] = action.parameters ?? [];
    assert.equal(dryRun?.value, false, 'boolean false is carried as false, never absent, 0 or "false"');
    assert.equal(typeof dryRun?.value, 'boolean');
    assert.equal(mode?.value, 'Rolling', 'a token is byte-exact: never lower-cased');
    assert.equal(quantity?.value, 4);
    assert.equal(typeof quantity?.value, 'number');
  });

  it('the list is in canonical dimension order, with each dimension once', async () => {
    const { adapter, service } = serviceFor();
    await service.exercise(request());
    const dimensions = (only(adapter.calls).parameters ?? []).map((entry) => entry.dimension);
    assert.deepEqual(dimensions, [...dimensions].sort());
    assert.equal(new Set(dimensions).size, dimensions.length);
  });

  it('a value below a maximum bound is delivered as attempted, not as the bound', async () => {
    const { adapter, service } = serviceFor();
    const attempted = [EXACT[0], EXACT[1], { dimension: 'quantity', type: 'integer', value: 2 }] as GovernedParameter[];
    assert.equal((await service.exercise(request(attempted))).status, 'executed');
    assert.deepEqual(only(adapter.calls).parameters?.[2], { dimension: 'quantity', type: 'integer', value: 2 });
  });

  it('a grant that bounds no parameter delivers an action with no parameters key at all', async () => {
    const { parameters: _none, ...rest } = SCOPE;
    const plain = buildTestGrant({ correlation: CORRELATION, scope: rest, subject: 'agent-core08', semanticsFormat: GRANT_SEMANTICS_FORMAT_V1 });
    const { adapter, service } = serviceFor(plain);
    assert.equal((await service.exercise(request('none', plain))).status, 'executed');
    assert.equal(Object.prototype.hasOwnProperty.call(only(adapter.calls), 'parameters'), false);
  });
});

describe('CORE-08 §6 / P-8 … P-12 — nothing the gate did not contain reaches the adapter', () => {
  const cases: readonly [string, readonly GovernedParameter[] | 'none', string][] = [
    ['P-2 above the maximum', [EXACT[0], EXACT[1], { dimension: 'quantity', type: 'integer', value: 5 }] as GovernedParameter[], E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
    ['P-3 an integer spelled as a string', [EXACT[0], EXACT[1], { dimension: 'quantity', type: 'integer', value: '4' as unknown as number }] as GovernedParameter[], E.GRANT_EXERCISE_REQUEST_MALFORMED],
    ['P-5 a different token under an exact bound', [EXACT[0], { dimension: 'mode', type: 'token', value: 'rolling' }, EXACT[2]] as GovernedParameter[], E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
    ['P-7 a number standing in for a boolean', [{ dimension: 'dryRun', type: 'boolean', value: 0 as unknown as boolean }, EXACT[1], EXACT[2]] as GovernedParameter[], E.GRANT_EXERCISE_REQUEST_MALFORMED],
    ['P-7 a string standing in for a boolean', [{ dimension: 'dryRun', type: 'boolean', value: 'false' as unknown as boolean }, EXACT[1], EXACT[2]] as GovernedParameter[], E.GRANT_EXERCISE_REQUEST_MALFORMED],
    ['P-11 a dimension the grant never bounded', [...EXACT, { dimension: 'zone', type: 'token', value: 'eu' }] as GovernedParameter[], E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
    ['P-12 a bounded dimension omitted', [EXACT[1], EXACT[2]] as GovernedParameter[], E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
    ['P-12 every parameter omitted', 'none', E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
    ['P-9 a duplicated dimension', [EXACT[0], EXACT[1], EXACT[2], EXACT[2]] as GovernedParameter[], E.GRANT_EXERCISE_REQUEST_MALFORMED],
    ['P-14 a non-canonical order', [EXACT[2], EXACT[1], EXACT[0]] as GovernedParameter[], E.GRANT_EXERCISE_REQUEST_MALFORMED],
  ];
  for (const [name, parameters, code] of cases) {
    it(`${name} is withheld before the adapter`, async () => {
      const { adapter, service } = serviceFor();
      const outcome = await service.exercise(request(parameters));
      assert.equal(outcome.status, 'withheld', name);
      assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(code as never), `${name}: ${JSON.stringify(outcome)}`);
      assert.equal(adapter.callCount, 0, name);
    });
  }
});

describe('CORE-08 §8 / P-13 — fresh, frozen data; the caller cannot substitute a value after it was assessed', () => {
  it('the action, its amount-free parameter list and every entry are frozen; nothing is shared with the caller', async () => {
    const { adapter, service } = serviceFor();
    const caller = request();
    await service.exercise(caller);
    const action = only(adapter.calls);
    assert.ok(Object.isFrozen(action));
    assert.ok(Object.isFrozen(action.correlation));
    assert.ok(Object.isFrozen(action.parameters));
    for (const entry of action.parameters ?? []) assert.ok(Object.isFrozen(entry));
    assert.notEqual(action.parameters, caller.parameters, 'not the caller array');
    for (const [index, entry] of (action.parameters ?? []).entries()) assert.notEqual(entry, caller.parameters?.[index], 'not the caller entry');
    assert.throws(() => (action.parameters as GovernedParameter[]).push({ dimension: 'zone', type: 'token', value: 'x' }), TypeError);
    assert.throws(() => {
      (action.parameters?.[2] as { value: number }).value = 400;
    }, TypeError);
  });

  it('mutating the caller objects after the exercise returns changes nothing an adapter saw', async () => {
    const { adapter, service } = serviceFor();
    const caller = request();
    await service.exercise(caller);
    (caller.parameters as GovernedParameter[])[2] = { dimension: 'quantity', type: 'integer', value: 999 };
    ((caller.parameters as GovernedParameter[])[1] as { value: string }).value = 'Recreate';
    assert.deepEqual(only(adapter.calls).parameters, EXACT);
  });

  it('a caller mutating its request while the exercise awaits the authoritative read cannot swap in another (even in-bound) value', async () => {
    const caller = request();
    const { adapter, service } = serviceFor(GRANT, () => {
      // Inside the await: a different value that is *also* inside the bound.
      (caller.parameters as GovernedParameter[])[2] = { dimension: 'quantity', type: 'integer', value: 1 };
      ((caller.parameters as GovernedParameter[])[1] as { value: string }).value = 'Recreate';
    });
    const outcome = await service.exercise(caller);
    assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
    assert.deepEqual(only(adapter.calls).parameters, EXACT, 'the value delivered is the value read when the exercise began');
  });

  it('a getter-bearing entry is read once: the value assessed is the value delivered, and no getter survives', async () => {
    let reads = 0;
    const shifty = {
      dimension: 'quantity',
      type: 'integer',
      get value(): number {
        reads += 1;
        return reads === 1 ? 4 : 40_000;
      },
    } as unknown as GovernedParameter;
    const { adapter, service } = serviceFor();
    assert.equal((await service.exercise(request([EXACT[0], EXACT[1], shifty] as GovernedParameter[]))).status, 'executed');
    assert.equal(reads, 1);
    const delivered = only(adapter.calls).parameters?.[2];
    assert.deepEqual(delivered, { dimension: 'quantity', type: 'integer', value: 4 });
    assert.equal(Object.getOwnPropertyDescriptor(delivered, 'value')?.get, undefined, 'plain data, not an accessor');
  });

  it('extra properties on a caller entry never travel: an entry is { dimension, type, value } and nothing else', async () => {
    const { adapter, service } = serviceFor();
    const smuggling = [EXACT[0], EXACT[1], { ...EXACT[2], path: '/admin', origin: 'https://attacker.example' }] as GovernedParameter[];
    assert.equal((await service.exercise(request(smuggling))).status, 'executed');
    assert.deepEqual(Object.keys(only(adapter.calls).parameters?.[2] ?? {}).sort(), ['dimension', 'type', 'value']);
  });

  it('a Proxy parameter list that throws while being read is refused as malformed, never partially delivered', async () => {
    const { adapter, service } = serviceFor();
    const hostile = new Proxy([...EXACT], {
      get(target, key, receiver) {
        if (key === '2') throw new Error('trap');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const outcome = await service.exercise(request(hostile));
    assert.equal(outcome.status, 'withheld');
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_REQUEST_MALFORMED), JSON.stringify(outcome));
    assert.equal(adapter.callCount, 0);
  });

  it('the amount crosses as a fresh frozen copy too', async () => {
    const grant = buildTestGrant();
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store: storeOf(grant), adapter, now: () => '2026-01-01T12:05:00.000Z' });
    const amount = { value: '7500', unit: 'USD' };
    const outcome = await service.exercise({
      boundedGrantId: grant.id,
      subject: 'agent-A',
      action: 'payment',
      resource: 'vendor/V123',
      counterparty: 'V123',
      organization: 'org-acme',
      amount,
      correlation: grant.correlation,
      executionId: 'exec-amount',
    });
    assert.equal(outcome.status, 'executed');
    const delivered = only(adapter.calls).amount;
    assert.deepEqual(delivered, { value: '7500', unit: 'USD' });
    assert.notEqual(delivered, amount);
    assert.ok(Object.isFrozen(delivered));
    amount.value = '1';
    assert.equal(only(adapter.calls).amount?.value, '7500');
  });
});
