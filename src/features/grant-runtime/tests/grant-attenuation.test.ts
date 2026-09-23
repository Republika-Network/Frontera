import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_BOUND_KEYS,
  GRANT_REASON_CODES,
  attenuateGrantScope,
  compareGrantBound,
  grantScopeIsWithin,
  type GrantBound,
  type GrantBoundComparison,
  type GrantBoundKey,
  type GrantScope,
} from '../index.js';

/**
 * The settling invariant of layer E, tested as a property rather than as a
 * handful of examples.
 *
 * > GRANT ⊆ AUTHORIZED AUTHORITY
 *
 * Every table below enumerates, for one bound shape, a source bound and the
 * four positions a requested bound can occupy relative to it — LESS THAN, EQUAL,
 * GREATER THAN, INCOMPARABLE — and asserts the two permitted and the two
 * refused. Deterministic tables and enumerated generators, never probabilistic
 * fuzzing: a suite whose failures depend on a seed is a suite that is green on
 * the run that mattered.
 */

interface BoundCase {
  readonly name: string;
  readonly requested: GrantBound;
  readonly expected: GrantBoundComparison;
}

interface BoundTable {
  readonly shape: string;
  readonly source: GrantBound;
  readonly cases: readonly BoundCase[];
  /**
   * The scope axis this shape is expressed on, when it is one.
   *
   * `window` has no axis: a validity window is not a scope bound — a scope says
   * what a grant may act over, a window says when — so it is exercised through
   * `compareGrantBound` here and end to end in `grant-validity.test.ts`, where
   * the issuer proposes and the ceilings contain.
   */
  readonly key?: GrantBoundKey;
}

const TABLES: readonly BoundTable[] = [
  {
    key: 'action',
    shape: 'identity',
    source: { kind: 'identity', value: 'payment' },
    cases: [
      { name: 'the same action', requested: { kind: 'identity', value: 'payment' }, expected: 'equal' },
      { name: 'a wildcard', requested: { kind: 'identity', value: '*' }, expected: 'incomparable' },
      { name: 'a different action', requested: { kind: 'identity', value: 'refund' }, expected: 'incomparable' },
      { name: 'an empty action', requested: { kind: 'identity', value: '' }, expected: 'incomparable' },
      { name: 'a set where an identity belongs', requested: { kind: 'set', values: ['payment'] }, expected: 'incomparable' },
    ],
  },
  {
    key: 'resources',
    shape: 'set',
    source: { kind: 'set', values: ['A', 'B', 'C'] },
    cases: [
      { name: 'the same set', requested: { kind: 'set', values: ['A', 'B', 'C'] }, expected: 'equal' },
      { name: 'the same set in another order', requested: { kind: 'set', values: ['C', 'A', 'B'] }, expected: 'equal' },
      { name: 'a proper subset', requested: { kind: 'set', values: ['A', 'B'] }, expected: 'narrower' },
      { name: 'a single member', requested: { kind: 'set', values: ['B'] }, expected: 'narrower' },
      { name: 'a set with one member outside', requested: { kind: 'set', values: ['A', 'B', 'D'] }, expected: 'broader' },
      { name: 'a disjoint set', requested: { kind: 'set', values: ['D'] }, expected: 'broader' },
      { name: 'a superset', requested: { kind: 'set', values: ['A', 'B', 'C', 'D'] }, expected: 'broader' },
      { name: 'an empty set', requested: { kind: 'set', values: [] }, expected: 'incomparable' },
    ],
  },
  {
    key: 'amount',
    shape: 'ceiling',
    source: { kind: 'ceiling', limit: '10000', unit: 'USD' },
    cases: [
      { name: 'an equal ceiling', requested: { kind: 'ceiling', limit: '10000', unit: 'USD' }, expected: 'equal' },
      { name: 'a lower ceiling', requested: { kind: 'ceiling', limit: '5000', unit: 'USD' }, expected: 'narrower' },
      { name: 'a ceiling one unit below', requested: { kind: 'ceiling', limit: '9999', unit: 'USD' }, expected: 'narrower' },
      { name: 'a ceiling of zero', requested: { kind: 'ceiling', limit: '0', unit: 'USD' }, expected: 'narrower' },
      { name: 'a higher ceiling', requested: { kind: 'ceiling', limit: '15000', unit: 'USD' }, expected: 'broader' },
      { name: 'a ceiling one unit above', requested: { kind: 'ceiling', limit: '10001', unit: 'USD' }, expected: 'broader' },
      { name: 'a lower ceiling in another currency', requested: { kind: 'ceiling', limit: '1', unit: 'EUR' }, expected: 'incomparable' },
      { name: 'a negative ceiling', requested: { kind: 'ceiling', limit: '-1', unit: 'USD' }, expected: 'incomparable' },
      { name: 'a non-finite ceiling', requested: { kind: 'ceiling', limit: 'Infinity', unit: 'USD' }, expected: 'incomparable' },
      { name: 'a NaN ceiling', requested: { kind: 'ceiling', limit: 'NaN', unit: 'USD' }, expected: 'incomparable' },
    ],
  },
  {
    shape: 'window',
    source: { kind: 'window', notAfter: '2026-01-01T15:00:00.000Z' },
    cases: [
      { name: 'the same instant', requested: { kind: 'window', notAfter: '2026-01-01T15:00:00.000Z' }, expected: 'equal' },
      { name: 'an earlier instant', requested: { kind: 'window', notAfter: '2026-01-01T14:45:00.000Z' }, expected: 'narrower' },
      { name: 'one millisecond earlier', requested: { kind: 'window', notAfter: '2026-01-01T14:59:59.999Z' }, expected: 'narrower' },
      { name: 'a later instant', requested: { kind: 'window', notAfter: '2026-01-01T16:00:00.000Z' }, expected: 'broader' },
      { name: 'one millisecond later', requested: { kind: 'window', notAfter: '2026-01-01T15:00:00.001Z' }, expected: 'broader' },
      { name: 'an unparseable instant', requested: { kind: 'window', notAfter: 'not-a-timestamp' }, expected: 'incomparable' },
      { name: 'an empty instant', requested: { kind: 'window', notAfter: '' }, expected: 'incomparable' },
    ],
  },
];

describe('Attenuation matrix — LESS THAN and EQUAL permit, GREATER THAN and INCOMPARABLE refuse', () => {
  for (const table of TABLES) {
    for (const boundCase of table.cases) {
      it(`${table.shape} bound: ${boundCase.name} compares ${boundCase.expected}`, () => {
        assert.equal(compareGrantBound(table.source, boundCase.requested), boundCase.expected);
      });

      if (table.key === undefined) continue;
      const key = table.key;
      it(`${table.shape} bound on '${key}': ${boundCase.name} is ${boundCase.expected === 'equal' || boundCase.expected === 'narrower' ? 'issued' : 'refused'}`, () => {
        const outcome = attenuateGrantScope({ [key]: table.source } as GrantScope, { [key]: boundCase.requested });
        if (boundCase.expected === 'equal' || boundCase.expected === 'narrower') {
          assert.equal(outcome.outcome, 'attenuated');
          if (outcome.outcome !== 'attenuated') return;
          assert.equal(grantScopeIsWithin({ [key]: table.source } as GrantScope, outcome.scope), true, 'an issued scope is always inside its source');
        } else {
          assert.equal(outcome.outcome, 'refused');
          if (outcome.outcome !== 'refused') return;
          const expectedCode = boundCase.expected === 'broader' ? GRANT_REASON_CODES.GRANT_SCOPE_BROADENING : GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE;
          assert.deepEqual(
            outcome.violations.map((violation) => violation.reasonCode),
            [expectedCode],
          );
        }
      });
    }
  }

  it('every bound shape in the algebra is covered by a table', () => {
    assert.deepEqual([...new Set(TABLES.map((table) => table.shape))].sort(), ['ceiling', 'identity', 'set', 'window']);
  });

  it('every scope axis is covered by a table, and only `window` sits outside the scope', () => {
    const covered = TABLES.flatMap((table) => (table.key === undefined ? [] : [table.key])).sort();
    assert.deepEqual(covered, [...GRANT_BOUND_KEYS].filter((key) => covered.includes(key)).sort());
    assert.deepEqual(
      TABLES.filter((table) => table.key === undefined).map((table) => table.shape),
      ['window'],
    );
  });
});

const SOURCE: GrantScope = {
  action: { kind: 'identity', value: 'payment' },
  amount: { kind: 'ceiling', limit: '10000', unit: 'USD' },
  counterparty: { kind: 'identity', value: 'V123' },
  organization: { kind: 'identity', value: 'org-1' },
  resources: { kind: 'set', values: ['record:contract'] },
};

describe('Attenuation across a whole scope', () => {
  it('no requested narrowing inherits the source bounds exactly — ADR §4', () => {
    const outcome = attenuateGrantScope(SOURCE);
    assert.equal(outcome.outcome, 'attenuated');
    if (outcome.outcome !== 'attenuated') return;
    assert.deepEqual(outcome.scope, SOURCE);
    assert.equal(outcome.bounds.every((bound) => !bound.narrowingRequested && bound.permitted), true);
  });

  it('narrowing one axis leaves every other axis at the source bound', () => {
    const outcome = attenuateGrantScope(SOURCE, { amount: { kind: 'ceiling', limit: '5000', unit: 'USD' } });
    assert.equal(outcome.outcome, 'attenuated');
    if (outcome.outcome !== 'attenuated') return;
    assert.deepEqual(outcome.scope.amount, { kind: 'ceiling', limit: '5000', unit: 'USD' });
    assert.deepEqual(outcome.scope.action, SOURCE.action);
    assert.deepEqual(outcome.scope.resources, SOURCE.resources);
  });

  it('one broadened axis refuses the whole grant, even when every other axis narrows', () => {
    const outcome = attenuateGrantScope(SOURCE, {
      amount: { kind: 'ceiling', limit: '1', unit: 'USD' },
      resources: { kind: 'set', values: ['record:contract'] },
      counterparty: { kind: 'identity', value: 'V999' },
    });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations.map((violation) => violation.key), ['counterparty']);
  });

  it('every violated axis is reported, not only the first', () => {
    const outcome = attenuateGrantScope(SOURCE, {
      amount: { kind: 'ceiling', limit: '99999', unit: 'USD' },
      counterparty: { kind: 'identity', value: 'V999' },
      resources: { kind: 'set', values: ['record:contract', 'record:somebody-elses'] },
    });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations.map((violation) => violation.key), ['amount', 'counterparty', 'resources']);
  });

  it('a bound on an axis the source never stated is refused, never treated as unbounded', () => {
    const partial: GrantScope = { action: { kind: 'identity', value: 'payment' } };
    const outcome = attenuateGrantScope(partial, { amount: { kind: 'ceiling', limit: '1', unit: 'USD' } });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations.map((violation) => violation.reasonCode), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('a malformed source bound refuses rather than being compared into permission', () => {
    const broken: GrantScope = { amount: { kind: 'ceiling', limit: 'NaN', unit: 'USD' } };
    assert.equal(attenuateGrantScope(broken).outcome, 'refused');
    assert.equal(attenuateGrantScope(broken, { amount: { kind: 'ceiling', limit: '1', unit: 'USD' } }).outcome, 'refused');
  });

  it('a bound carrying the wrong shape for its axis is refused before comparison', () => {
    const outcome = attenuateGrantScope(SOURCE, { amount: { kind: 'set', values: ['5000'] } });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations.map((violation) => violation.reasonCode), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('attenuation visits every axis exactly once, in canonical order', () => {
    const outcome = attenuateGrantScope(SOURCE);
    assert.equal(outcome.outcome, 'attenuated');
    if (outcome.outcome !== 'attenuated') return;
    assert.deepEqual(outcome.bounds.map((bound) => bound.key), [...GRANT_BOUND_KEYS]);
  });
});

describe('grantScopeIsWithin — the invariant proven of the artifact, not the process', () => {
  it('holds for every scope attenuation produces, across the full enumerated table', () => {
    for (const table of TABLES) {
      const key = table.key;
      if (key === undefined) continue;
      for (const boundCase of table.cases) {
        const source = { [key]: table.source } as GrantScope;
        const outcome = attenuateGrantScope(source, { [key]: boundCase.requested });
        if (outcome.outcome === 'attenuated') {
          assert.equal(grantScopeIsWithin(source, outcome.scope), true, `${key}/${boundCase.name} produced a scope outside its source`);
        }
      }
    }
  });

  it('is false for a child stating a bound its parent does not', () => {
    assert.equal(grantScopeIsWithin({ action: { kind: 'identity', value: 'payment' } }, SOURCE), false);
  });

  it('is true for a child that states nothing — attenuation is reflexive over an empty narrowing', () => {
    assert.equal(grantScopeIsWithin(SOURCE, {}), true);
  });

  it('is true of a source against itself on every axis', () => {
    assert.equal(grantScopeIsWithin(SOURCE, SOURCE), true);
  });
});
