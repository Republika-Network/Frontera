import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  attenuateGrantScope,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  grantScopeIsWithin,
  isWellFormedGrantScope,
  serializeGrantScope,
  type GrantCorrelation,
  type GrantParameterBound,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../index.js';

/**
 * CORE-03 — attenuation over **non-money** typed parameter dimensions, through
 * the one production attenuation engine and the one production issuance
 * service. No test-only comparison exists: every answer below is
 * `attenuateGrantScope`'s, `grantScopeIsWithin`'s or `issueGrant`'s.
 *
 * > child authority ⊆ parent authority — for `recordCount`, exactly as for money.
 */

const PROFILE = `customer-data-read@1#sha256:${'c'.repeat(64)}`;
const max = (dimension: string, limit: number): GrantParameterBound => ({ dimension, kind: 'maximum', type: 'integer', limit });
const exact = (dimension: string, value: string): GrantParameterBound => ({ dimension, kind: 'exact', type: 'token', value });

function scopeWith(parameters: readonly GrantParameterBound[]): GrantScope {
  return {
    action: { kind: 'identity', value: 'read-customer-records' },
    governanceProfile: { kind: 'identity', value: PROFILE },
    parameters,
    resources: { kind: 'set', values: ['customer-data-example'] },
  };
}

describe('CORE-03 §55 — attenuation of a non-money dimension (recordCount)', () => {
  it('parent recordCount <= 1000, child recordCount <= 100: a valid attenuation', () => {
    const outcome = attenuateGrantScope(scopeWith([max('recordCount', 1000)]), { parameters: [max('recordCount', 100)] });
    assert.equal(outcome.outcome, 'attenuated', JSON.stringify(outcome));
    if (outcome.outcome !== 'attenuated') return;
    assert.deepEqual(outcome.scope.parameters, [max('recordCount', 100)]);
    assert.deepEqual(outcome.bounds.find((bound) => bound.key === 'parameters.recordCount'), { key: 'parameters.recordCount', comparison: 'narrower', narrowingRequested: true, permitted: true });
    assert.equal(grantScopeIsWithin(scopeWith([max('recordCount', 1000)]), outcome.scope), true);
  });

  it('parent recordCount <= 100, child recordCount <= 1000: refused as a broadening', () => {
    const outcome = attenuateGrantScope(scopeWith([max('recordCount', 100)]), { parameters: [max('recordCount', 1000)] });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations, [{ key: 'parameters.recordCount', comparison: 'broader', reasonCode: GRANT_REASON_CODES.GRANT_SCOPE_BROADENING }]);
    assert.equal(grantScopeIsWithin(scopeWith([max('recordCount', 100)]), scopeWith([max('recordCount', 1000)])), false);
  });

  it('no requested narrowing inherits the parent bound exactly — never "unbounded"', () => {
    const outcome = attenuateGrantScope(scopeWith([exact('dataScope', 'contact-fields'), max('recordCount', 1000)]));
    assert.equal(outcome.outcome, 'attenuated');
    if (outcome.outcome !== 'attenuated') return;
    assert.deepEqual(outcome.scope.parameters, [exact('dataScope', 'contact-fields'), max('recordCount', 1000)], 'canonical order, inherited unchanged');
  });

  it('a source list out of canonical order is not a parent anything can be proven against', () => {
    assert.equal(attenuateGrantScope(scopeWith([max('recordCount', 1000), exact('dataScope', 'contact-fields')])).outcome, 'refused');
  });

  it('a bound on a dimension the parent never bounded is refused — no parent, no proof of ⊆', () => {
    const outcome = attenuateGrantScope(scopeWith([max('recordCount', 1000)]), { parameters: [exact('destination', 'archive')] });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.violations.map((violation) => [violation.key, violation.reasonCode]), [['parameters.destination', GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]]);
  });

  it('a parameter bound requested on a scope with no parameters at all is refused', () => {
    const outcome = attenuateGrantScope({ action: { kind: 'identity', value: 'a' }, resources: { kind: 'set', values: ['r'] } }, { parameters: [max('recordCount', 1)] });
    assert.equal(outcome.outcome, 'refused');
  });

  it('a different exact value, a different kind or a different type is incomparable, never ranked', () => {
    for (const [parent, child] of [
      [exact('environment', 'production'), exact('environment', 'staging')],
      [max('recordCount', 1000), { dimension: 'recordCount', kind: 'exact', type: 'integer', value: 10 } as GrantParameterBound],
      [exact('recordCount', '10'), max('recordCount', 10)],
    ] as const) {
      const outcome = attenuateGrantScope(scopeWith([parent]), { parameters: [child] });
      assert.equal(outcome.outcome, 'refused', `${JSON.stringify(parent)} ← ${JSON.stringify(child)}`);
    }
  });

  it('an unusable requested list — duplicated, unsorted or malformed — refuses the whole grant', () => {
    for (const parameters of [
      [max('recordCount', 10), max('recordCount', 20)],
      [max('recordCount', 10), exact('dataScope', 'x')],
      [max('recordCount', Number.NaN)],
      [max('RecordCount!', 10)],
      [],
    ]) {
      const outcome = attenuateGrantScope(scopeWith([exact('dataScope', 'x'), max('recordCount', 1000)]), { parameters });
      assert.equal(outcome.outcome, 'refused', JSON.stringify(parameters));
    }
  });
});

describe('CORE-03 — containment is proven of the artifact, strictly', () => {
  it('a child that drops a parent parameter bound is broader, not narrower', () => {
    const parent = scopeWith([max('recordCount', 100)]);
    const { parameters: _dropped, ...child } = parent;
    assert.equal(grantScopeIsWithin(parent, child), false, 'no recordCount bound admits any recordCount');
  });

  it('a child that adds a dimension the parent never bounded is not within it', () => {
    assert.equal(grantScopeIsWithin(scopeWith([max('recordCount', 100)]), scopeWith([exact('dataScope', 'x'), max('recordCount', 100)])), false);
  });

  it('a child that swaps the profile reference is not within the parent', () => {
    const parent = scopeWith([max('recordCount', 100)]);
    assert.equal(grantScopeIsWithin(parent, { ...parent, governanceProfile: { kind: 'identity', value: `customer-data-export@1#sha256:${'d'.repeat(64)}` } }), false);
  });
});

describe('CORE-03 — scope well-formedness and serialization', () => {
  it('an empty or unsorted parameter list is not a well-formed scope', () => {
    assert.equal(isWellFormedGrantScope(scopeWith([])), false);
    assert.equal(isWellFormedGrantScope(scopeWith([max('recordCount', 1), exact('dataScope', 'x')])), false);
    assert.equal(isWellFormedGrantScope(scopeWith([exact('dataScope', 'x'), max('recordCount', 1)])), true);
  });

  it('a scope without CORE-03 axes serializes to the exact pre-CORE-03 bytes', () => {
    const legacy: GrantScope = {
      action: { kind: 'identity', value: 'payment.send' },
      amount: { kind: 'ceiling', limit: '100', unit: 'USD' },
      counterparty: { kind: 'identity', value: 'vendor-v123' },
      organization: { kind: 'identity', value: 'org-a' },
      resources: { kind: 'set', values: ['resource-treasury-1'] },
    };
    // Recorded from the unmodified build of 2ee659b (src/enterprise/__tests__/fixtures/pre-core-03).
    assert.equal(
      serializeGrantScope(legacy),
      '{"action":{"kind":"identity","value":"payment.send"},"amount":{"kind":"ceiling","limit":"100","unit":"USD"},"counterparty":{"kind":"identity","value":"vendor-v123"},"organization":{"kind":"identity","value":"org-a"},"resources":{"kind":"set","values":["resource-treasury-1"]}}',
    );
  });

  it('a CORE-03 scope serializes profile and parameters in canonical position, independent of input order', () => {
    const a = serializeGrantScope(scopeWith([exact('dataScope', 'x'), max('recordCount', 50)]));
    const b = serializeGrantScope({ ...scopeWith([max('recordCount', 50), exact('dataScope', 'x')]) });
    assert.equal(a, b);
    assert.equal(
      a,
      `{"action":{"kind":"identity","value":"read-customer-records"},"governanceProfile":{"kind":"identity","value":"${PROFILE}"},"parameters":[{"dimension":"dataScope","kind":"exact","type":"token","value":"x"},{"dimension":"recordCount","kind":"maximum","limit":50,"type":"integer"}],"resources":{"kind":"set","values":["customer-data-example"]}}`,
    );
  });
});

describe('CORE-03 — the production issuance service over a non-money bound', () => {
  const NOW = '2026-01-01T12:00:00.000Z';
  const correlation: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'read-customer-records', resourceScope: 'customer-data-example' };
  const source = (parameters: readonly GrantParameterBound[]): GrantSourceAuthorization => ({
    correlation,
    subject: 'agent-a',
    scope: scopeWith(parameters),
    authorizationPermitsExercise: true,
    allBlockingObligationsSatisfied: true,
    evaluatedAt: NOW,
    validityCeilings: [],
  });
  const issue = (parameters: readonly GrantParameterBound[], requested?: readonly GrantParameterBound[]) =>
    createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() }).issueGrant({
      source: source(parameters),
      subject: 'agent-a',
      correlation,
      issuedAt: NOW,
      expiresAt: '2026-01-01T12:10:00.000Z',
      ...(requested !== undefined ? { requestedBounds: { parameters: requested } } : {}),
    });

  it('issues a narrowed grant, whose identity and digest cover the parameter bound', async () => {
    const narrowed = await issue([max('recordCount', 1000)], [max('recordCount', 100)]);
    const inherited = await issue([max('recordCount', 1000)]);
    assert.equal(narrowed.outcome, 'issued');
    assert.equal(inherited.outcome, 'issued');
    if (narrowed.outcome !== 'issued' || inherited.outcome !== 'issued') return;
    assert.deepEqual(narrowed.grant.scope.parameters, [max('recordCount', 100)]);
    assert.notEqual(narrowed.grant.id, inherited.grant.id, 'two different parameter bounds never share a grant identity');
    assert.notEqual(narrowed.grant.digest, inherited.grant.digest);
  });

  it('refuses a widening request with GRANT_SCOPE_BROADENING and issues nothing', async () => {
    const outcome = await issue([max('recordCount', 100)], [max('recordCount', 1000)]);
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual([...outcome.reasonCodes], [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('refuses a source whose parameter list cannot be proven against (malformed) as not derivable', async () => {
    const outcome = await issue([max('recordCount', 1), max('recordCount', 2)]);
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.ok(outcome.reasonCodes.includes(GRANT_REASON_CODES.GRANT_SOURCE_BOUNDS_INCOMPLETE));
  });
});
