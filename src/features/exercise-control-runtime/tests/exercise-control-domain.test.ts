import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXERCISE_CONTROL_MAXIMUM_LIMITS,
  EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS,
  EXERCISE_CONTROL_REASON_CODES as R,
  addExerciseDecimals,
  compareExerciseDecimals,
  exerciseControlPolicyDigest,
  exerciseControlRuleVerdict,
  exerciseReservationId,
  exerciseReservationRequestDigest,
  isCanonicalExerciseDecimal,
  snapshotExerciseControlLimits,
  verifyExerciseAuthorityBinding,
  type ExerciseControlLimit,
  type ExerciseControlQuery,
} from '../index.js';
import { BINDING, OTHER_BINDING, amount, count } from './exercise-control-ledger-contract.js';
import { legacyExerciseDecimalFromNumber as exerciseDecimalFromNumber } from './legacy-usage-conversion.js';

describe('Exercise control — §10 / §42 exact decimal arithmetic', () => {
  it('accepts exactly the canonical grammar', () => {
    for (const valid of ['0', '0.1', '10', '10.25', '1000000.000001', '7500']) assert.equal(isCanonicalExerciseDecimal(valid), true, valid);
    for (const invalid of ['+10', '01', '10.', '10.0', '1e3', 'NaN', 'Infinity', '-1', '', ' 1', '1 ', '.5', '0.', '00', '1,000', '0x10', '١٠']) {
      assert.equal(isCanonicalExerciseDecimal(invalid), false, invalid);
    }
    assert.equal(isCanonicalExerciseDecimal(10), false, 'a number is not canonical text');
  });

  it('bounds the number of digits a policy maximum may state', () => {
    assert.equal(isCanonicalExerciseDecimal('9'.repeat(128)), true);
    assert.equal(isCanonicalExerciseDecimal('9'.repeat(129)), false);
    assert.equal(isCanonicalExerciseDecimal(`0.${'0'.repeat(126)}1`), true);
    assert.equal(isCanonicalExerciseDecimal(`0.${'0'.repeat(127)}1`), false);
  });

  it('3. 0.1 + 0.2 is exactly 0.3 — the JavaScript float sum is not', () => {
    assert.notEqual(0.1 + 0.2, 0.3, 'the hazard is real');
    const sum = addExerciseDecimals(exerciseDecimalFromNumber(0.1) ?? '', exerciseDecimalFromNumber(0.2) ?? '');
    assert.equal(sum, '0.3');
    assert.equal(compareExerciseDecimals(sum, '0.3'), 0);
  });

  it('5. (pre-P9 ledger usage) the retired number conversion expanded exponent notation exactly', () => {
    assert.equal(exerciseDecimalFromNumber(0.1), '0.1');
    assert.equal(exerciseDecimalFromNumber(1e-7), '0.0000001');
    assert.equal(exerciseDecimalFromNumber(1e6), '1000000');
    assert.equal(exerciseDecimalFromNumber(1e21), '1000000000000000000000');
    assert.equal(exerciseDecimalFromNumber(1.5e-10), '0.00000000015');
    assert.equal(exerciseDecimalFromNumber(7500), '7500');
    assert.equal(exerciseDecimalFromNumber(10.25), '10.25');
    assert.equal(exerciseDecimalFromNumber(0), '0');
    assert.equal(exerciseDecimalFromNumber(-0), '0');
  });

  it('6. (pre-P9 ledger usage) every value the retired conversion could write fits the usage digit bound', () => {
    const tiny = exerciseDecimalFromNumber(Number.MIN_VALUE);
    assert.ok(tiny !== undefined && tiny.startsWith('0.') && tiny.endsWith('5'));
    const huge = exerciseDecimalFromNumber(Number.MAX_VALUE);
    assert.ok(huge !== undefined && huge.length === 309 && !huge.includes('.'));
    assert.equal(exerciseDecimalFromNumber(Number.MAX_SAFE_INTEGER), '9007199254740991');
  });

  it('13. NaN, Infinity and negatives cannot enter', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.0001]) assert.equal(exerciseDecimalFromNumber(value), undefined, String(value));
  });

  it('compares and adds exactly across scales', () => {
    assert.equal(addExerciseDecimals('99.99', '0.01'), '100');
    assert.equal(addExerciseDecimals('0', '0'), '0');
    assert.equal(compareExerciseDecimals('100', '100.000001'), -1);
    assert.equal(compareExerciseDecimals('100.1', '100.09'), 1);
    assert.throws(() => addExerciseDecimals('1.0', '1'), 'a non-canonical operand is refused, never normalized');
  });
});

describe('Exercise control — §8 the closed limit contract', () => {
  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ limitId: 'grant-uses', scopeKey: 'grant:g', metric: 'count', maximum: 3, window: { kind: 'lifetime' }, ...overrides });

  it('snapshots a valid policy answer into a fresh, frozen, sorted copy', () => {
    const raw = [valid({ limitId: 'z-last' }), amount('a-first', 'org:1', '100', 'USD')];
    const snapshot = snapshotExerciseControlLimits(raw);
    assert.ok(snapshot !== undefined);
    assert.deepEqual(snapshot.map((limit) => limit.limitId), ['a-first', 'z-last']);
    assert.ok(Object.isFrozen(snapshot) && snapshot.every((limit) => Object.isFrozen(limit) && Object.isFrozen(limit.window)));
    assert.notEqual(snapshot[1], raw[0], 'a copy, never the host object');
  });

  it('an empty answer is valid: no aggregate limit applies', () => {
    assert.deepEqual(snapshotExerciseControlLimits([]), []);
  });

  for (const [label, raw] of [
    ['§40.11 maximum zero', [valid({ maximum: 0 })]],
    ['§40.12 fractional maximum', [valid({ maximum: 1.5 })]],
    ['§40.13 unsafe integer maximum', [valid({ maximum: Number.MAX_SAFE_INTEGER + 1 })]],
    ['negative count maximum', [valid({ maximum: -1 })]],
    ['string count maximum', [valid({ maximum: '3' })]],
    ['§41.10 rolling seconds zero', [valid({ window: { kind: 'rolling', seconds: 0 } })]],
    ['§41.11 rolling above one year', [valid({ window: { kind: 'rolling', seconds: EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS + 1 } })]],
    ['fractional rolling seconds', [valid({ window: { kind: 'rolling', seconds: 1.5 } })]],
    ['unknown window kind', [valid({ window: { kind: 'calendar-month' } })]],
    ['window with an extra key', [valid({ window: { kind: 'lifetime', seconds: 5 } })]],
    ['§42.10 negative amount maximum', [amount('spend', 's', '-1', 'USD')]],
    ['§42.11 exponent-form amount maximum', [amount('spend', 's', '1e3', 'USD')]],
    ['§42.12 non-canonical "10.0"', [amount('spend', 's', '10.0', 'USD')]],
    ['numeric amount maximum', [{ ...amount('spend', 's', '10', 'USD'), maximum: 10 }]],
    ['amount without unit', [{ limitId: 'spend', scopeKey: 's', metric: 'amount', maximum: '10', window: { kind: 'lifetime' } }]],
    ['count with a unit', [valid({ unit: 'USD' })]],
    ['unknown metric', [valid({ metric: 'velocity' })]],
    ['an extra key (a provider hint)', [valid({ adapterId: 'stripe' })]],
    ['non-canonical limitId', [valid({ limitId: ' grant-uses' })]],
    ['limitId with a space', [valid({ limitId: 'grant uses' })]],
    ['over-long limitId', [valid({ limitId: `a${'b'.repeat(128)}` })]],
    ['empty scopeKey', [valid({ scopeKey: '' })]],
    ['scopeKey with surrounding whitespace', [valid({ scopeKey: ' grant:g' })]],
    ['scopeKey with a control character', [valid({ scopeKey: 'grant:\u0000g' })]],
    ['scopeKey over 512 UTF-8 bytes', [valid({ scopeKey: 'é'.repeat(257) })]],
    ['§40.10 duplicate (limitId, scopeKey)', [valid(), valid({ maximum: 5 })]],
    ['more than 32 limits', Array.from({ length: EXERCISE_CONTROL_MAXIMUM_LIMITS + 1 }, (_, index) => valid({ limitId: `limit-${index}` }))],
    ['not an array', valid()],
    ['a promise', Promise.resolve([valid()])],
    ['null', null],
    ['an array holding a non-object', [7]],
    ['a class instance', [Object.assign(Object.create({ inherited: true }) as object, valid())]],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.equal(snapshotExerciseControlLimits(raw), undefined);
    });
  }

  it('accepts exactly 32 limits and a scopeKey of exactly 512 bytes', () => {
    assert.equal(snapshotExerciseControlLimits(Array.from({ length: EXERCISE_CONTROL_MAXIMUM_LIMITS }, (_, index) => valid({ limitId: `limit-${index}` })))?.length, 32);
    assert.ok(snapshotExerciseControlLimits([valid({ scopeKey: 'x'.repeat(512) })]) !== undefined);
    assert.ok(snapshotExerciseControlLimits([valid({ window: { kind: 'rolling', seconds: EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS } })]) !== undefined);
  });

  it('a getter is refused rather than run, and a throwing Proxy throws — which the gate reads as invalid', () => {
    let reads = 0;
    const getter = valid();
    Object.defineProperty(getter, 'maximum', {
      enumerable: true,
      get() {
        reads += 1;
        return 3;
      },
    });
    assert.throws(() => snapshotExerciseControlLimits([getter]));
    assert.equal(reads, 0, 'the accessor was never invoked');
    const hostile = new Proxy([valid()], {
      get() {
        throw new Error('trap');
      },
    });
    assert.throws(() => snapshotExerciseControlLimits(hostile));
  });
});

describe('Exercise control — §30 policy fingerprint and §15 reservation identity', () => {
  const limits: readonly ExerciseControlLimit[] = [count('b', 'scope', 3), amount('a', 'scope', '100', 'USD', { kind: 'rolling', seconds: 60 })];

  it('return order does not change the policy digest', () => {
    assert.equal(exerciseControlPolicyDigest(limits), exerciseControlPolicyDigest([...limits].reverse()));
  });

  it('any actual change to a limit changes it', () => {
    const base = exerciseControlPolicyDigest(limits);
    for (const changed of [
      [count('b', 'scope', 4), limits[1] as ExerciseControlLimit],
      [count('b', 'scope-2', 3), limits[1] as ExerciseControlLimit],
      [count('c', 'scope', 3), limits[1] as ExerciseControlLimit],
      [limits[0] as ExerciseControlLimit, amount('a', 'scope', '100.5', 'USD', { kind: 'rolling', seconds: 60 })],
      [limits[0] as ExerciseControlLimit, amount('a', 'scope', '100', 'EUR', { kind: 'rolling', seconds: 60 })],
      [limits[0] as ExerciseControlLimit, amount('a', 'scope', '100', 'USD', { kind: 'rolling', seconds: 61 })],
      [limits[0] as ExerciseControlLimit, amount('a', 'scope', '100', 'USD')],
      [limits[0] as ExerciseControlLimit],
    ]) {
      assert.notEqual(exerciseControlPolicyDigest(changed), base);
    }
  });

  it('the reservation id is deterministic, derived from the grant and the execution identity, and never random', () => {
    const id = exerciseReservationId({ boundedGrantId: 'aoc.grant:1', executionId: 'exec-1' });
    assert.match(id, /^aoc\.exercise-reservation:[0-9a-f]{32}$/);
    assert.equal(id, exerciseReservationId({ boundedGrantId: 'aoc.grant:1', executionId: 'exec-1' }));
    assert.notEqual(id, exerciseReservationId({ boundedGrantId: 'aoc.grant:2', executionId: 'exec-1' }));
    assert.notEqual(id, exerciseReservationId({ boundedGrantId: 'aoc.grant:1', executionId: 'exec-2' }));
  });

  it('the request digest covers every validated field, optional axes included', () => {
    const subject = {
      boundedGrantId: 'aoc.grant:1',
      executionId: 'exec-1',
      subject: 'agent-A',
      action: 'payment',
      resource: 'vendor/V123',
      counterparty: 'V123',
      organization: 'org-acme',
      amount: { value: '7500', unit: 'USD' },
      correlation: { requestId: 'r', decisionId: 'd', action: 'payment', resourceScope: 'vendor/V123' },
    };
    const base = exerciseReservationRequestDigest(subject);
    const { counterparty: _counterparty, ...withoutCounterparty } = subject;
    for (const changed of [
      { ...subject, subject: 'agent-B' },
      { ...subject, action: 'refund' },
      { ...subject, resource: 'vendor/V999' },
      { ...subject, organization: 'org-other' },
      { ...subject, amount: { value: '7500.01', unit: 'USD' } },
      { ...subject, amount: { value: '7500', unit: 'EUR' } },
      { ...subject, correlation: { ...subject.correlation, decisionId: 'd2' } },
      withoutCounterparty,
    ]) {
      assert.notEqual(exerciseReservationRequestDigest(changed), base);
    }
  });
});

describe('Exercise control — the shared admission rule', () => {
  const nowMs = Date.parse('2026-03-01T00:10:00.000Z');

  it('count: pending, settled and future-dated usage all count; the rule never sees released usage', () => {
    const rule = { limit: count('c', 's', 2, { kind: 'rolling', seconds: 60 }), usage: '1' };
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'count', usage: '1', reservedAtMs: nowMs - 30_000 }], nowMs), 'within');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'count', usage: '1', reservedAtMs: nowMs - 30_000 }, { metric: 'count', usage: '1', reservedAtMs: nowMs + 3_600_000 }], nowMs), 'exceeded');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'count', usage: '1', reservedAtMs: nowMs - 60_000 }, { metric: 'count', usage: '1', reservedAtMs: nowMs - 61_000 }], nowMs), 'within');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'count', usage: '1', reservedAtMs: Number.NaN }, { metric: 'count', usage: '1', reservedAtMs: Number.NaN }], nowMs), 'exceeded', 'an unreadable age is never old enough');
  });

  it('amount: exact sum, exact unit, and a foreign-metric row in the bucket cannot be converted', () => {
    const rule = { limit: amount('a', 's', '0.3', 'USD'), usage: '0.2' };
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'amount', unit: 'USD', usage: '0.1', reservedAtMs: nowMs }], nowMs), 'within');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'amount', unit: 'USD', usage: '0.1000001', reservedAtMs: nowMs }], nowMs), 'exceeded');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'amount', unit: 'EUR', usage: '0.1', reservedAtMs: nowMs }], nowMs), 'unit-mismatch');
    assert.equal(exerciseControlRuleVerdict(rule, [{ metric: 'count', usage: '1', reservedAtMs: nowMs }], nowMs), 'unit-mismatch');
  });
});

describe('Exercise control — §25 exercise-time binding verification', () => {
  const query = {} as ExerciseControlQuery;

  it('exact digest equality verifies, and nothing else does', () => {
    assert.deepEqual(verifyExerciseAuthorityBinding(BINDING, () => BINDING, query), { verified: true });
    assert.deepEqual(verifyExerciseAuthorityBinding(BINDING, () => OTHER_BINDING, query), { verified: false, reasonCode: R.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED });
  });

  it('a grant without provenance, an undefined answer, a throw, a promise and a malformed digest are all unverifiable', () => {
    const unverifiable = { verified: false, reasonCode: R.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE };
    assert.deepEqual(verifyExerciseAuthorityBinding(undefined, () => BINDING, query), unverifiable);
    assert.deepEqual(verifyExerciseAuthorityBinding(BINDING, () => undefined, query), unverifiable);
    assert.deepEqual(
      verifyExerciseAuthorityBinding(
        BINDING,
        () => {
          throw new Error('authority store unreachable');
        },
        query,
      ),
      unverifiable,
    );
    assert.deepEqual(verifyExerciseAuthorityBinding(BINDING, () => Promise.resolve(BINDING) as unknown as string, query), unverifiable);
    assert.deepEqual(verifyExerciseAuthorityBinding(BINDING, () => BINDING.toUpperCase(), query), unverifiable);
    assert.deepEqual(verifyExerciseAuthorityBinding('sha256:short', () => 'sha256:short', query), unverifiable, 'malformed provenance is never compared into a match');
  });
});
