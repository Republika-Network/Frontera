import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  assessGrantEligibility,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  grantScopeIsWithin,
  type GrantCorrelation,
  type GrantIssuanceOutcome,
  type GrantScope,
  type GrantSourceAuthorization,
  type RequestedGrantBounds,
} from '../index.js';

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';

const CORRELATION: GrantCorrelation = {
  requestId: 'req-1',
  decisionId: 'dec-1',
  action: 'payment.send',
  resourceScope: 'record:contract',
};

const SOURCE_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' },
  counterparty: { kind: 'identity', value: 'V123' },
  resources: { kind: 'set', values: ['record:contract'] },
  validity: { kind: 'window', notAfter: HORIZON },
};

function source(overrides: Partial<GrantSourceAuthorization> = {}): GrantSourceAuthorization {
  return {
    correlation: CORRELATION,
    subject: 'actor-a',
    scope: SOURCE_SCOPE,
    authorizationPermitsExercise: true,
    allBlockingObligationsSatisfied: true,
    evaluatedAt: NOW,
    ...overrides,
  };
}

async function issue(input: {
  readonly source?: GrantSourceAuthorization;
  readonly requestedBounds?: RequestedGrantBounds;
  readonly subject?: string;
  readonly correlation?: GrantCorrelation;
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
}): Promise<GrantIssuanceOutcome> {
  const service = createGrantIssuanceService({
    store: createInMemoryBoundedGrantStore(),
    ...(input.revalidateSource !== undefined ? { revalidateSource: input.revalidateSource } : {}),
  });
  const src = input.source ?? source();
  return service.issueGrant({
    source: src,
    ...(input.requestedBounds !== undefined ? { requestedBounds: input.requestedBounds } : {}),
    subject: input.subject ?? src.subject,
    correlation: input.correlation ?? src.correlation,
    issuedAt: NOW,
  });
}

function refusalCodes(outcome: GrantIssuanceOutcome): readonly string[] {
  return outcome.outcome === 'refused' ? outcome.reasonCodes : [];
}

describe('Grant eligibility — ALLOW does not mean a grant exists', () => {
  it('an authorization that permits exercise with every obligation satisfied is eligible', () => {
    assert.equal(assessGrantEligibility(source()).eligibility, 'eligible');
  });

  it('permitted but with a blocking obligation outstanding is INELIGIBLE, and the authorization is not rewritten', () => {
    const pending = source({ allBlockingObligationsSatisfied: false });
    const assessment = assessGrantEligibility(pending);
    assert.equal(assessment.eligibility, 'ineligible');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
    assert.equal(pending.authorizationPermitsExercise, true, 'the source authorization is untouched — a grant layer never rewrites a decision');
  });

  it('not permitted, with every obligation satisfied, is INELIGIBLE and stays not permitted', () => {
    const denied = source({ authorizationPermitsExercise: false });
    const assessment = assessGrantEligibility(denied);
    assert.equal(assessment.eligibility, 'ineligible');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
    assert.equal(denied.allBlockingObligationsSatisfied, true);
  });

  it('reports every failing condition rather than only the first', () => {
    const assessment = assessGrantEligibility(source({ authorizationPermitsExercise: false, allBlockingObligationsSatisfied: false }));
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED, GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('a source missing a mandatory bound is ineligible — an unbounded grant is never the fallback', () => {
    const noHorizon = source({ scope: { action: { kind: 'identity', value: 'payment.send' }, resources: { kind: 'set', values: ['record:contract'] } } });
    assert.deepEqual(assessGrantEligibility(noHorizon).reasonCodes, [GRANT_REASON_CODES.GRANT_SOURCE_BOUNDS_INCOMPLETE]);
  });
});

describe('Issuance — the eight checks ahead of a grant', () => {
  it('issues a grant for exact source bounds', async () => {
    const outcome = await issue({});
    assert.equal(outcome.outcome, 'issued');
    if (outcome.outcome !== 'issued') return;
    assert.deepEqual(outcome.grant.scope, SOURCE_SCOPE);
    assert.equal(outcome.grant.expiresAt, HORIZON);
    assert.equal(outcome.grant.subject, 'actor-a');
  });

  it('issues a grant for narrower bounds on several axes at once', async () => {
    const outcome = await issue({
      requestedBounds: {
        amount: { kind: 'ceiling', limit: 5_000, unit: 'USD' },
        validity: { kind: 'window', notAfter: '2026-01-01T12:02:00.000Z' },
      },
    });
    assert.equal(outcome.outcome, 'issued');
    if (outcome.outcome !== 'issued') return;
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: 5_000, unit: 'USD' });
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:02:00.000Z');
    assert.equal(grantScopeIsWithin(SOURCE_SCOPE, outcome.grant.scope), true);
  });

  it('refuses an amount expansion and issues nothing', async () => {
    const outcome = await issue({ requestedBounds: { amount: { kind: 'ceiling', limit: 15_000, unit: 'USD' } } });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('refuses a resource expansion', async () => {
    const outcome = await issue({ requestedBounds: { counterparty: { kind: 'identity', value: 'V999' } } });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('refuses a validity expansion', async () => {
    const outcome = await issue({ requestedBounds: { validity: { kind: 'window', notAfter: '2026-01-01T12:30:00.000Z' } } });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('refuses an action broadened to a wildcard', async () => {
    const outcome = await issue({ requestedBounds: { action: { kind: 'identity', value: '*' } } });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_BOUND_INCOMPARABLE]);
  });

  it('refuses a subject substitution — there is no delegation at this layer', async () => {
    const outcome = await issue({ subject: 'actor-b' });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_SUBJECT_INVALID]);
  });

  it('refuses an issuance whose correlation names a different request', async () => {
    const outcome = await issue({ correlation: { ...CORRELATION, requestId: 'req-2' } });
    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
  });

  it('refuses an issuance whose correlation names a different decision', async () => {
    const outcome = await issue({ correlation: { ...CORRELATION, decisionId: 'dec-2' } });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
  });

  it('refuses an issuance whose correlation names a different action or resource scope', async () => {
    assert.deepEqual(refusalCodes(await issue({ correlation: { ...CORRELATION, action: 'refund.send' } })), [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
    assert.deepEqual(refusalCodes(await issue({ correlation: { ...CORRELATION, resourceScope: 'record:other' } })), [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
  });

  it('refuses when the authorization did not permit exercise, whatever bounds are requested', async () => {
    const outcome = await issue({ source: source({ authorizationPermitsExercise: false }), requestedBounds: { amount: { kind: 'ceiling', limit: 1, unit: 'USD' } } });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });

  it('refuses when a blocking obligation stands, whatever bounds are requested', async () => {
    const outcome = await issue({ source: source({ allBlockingObligationsSatisfied: false }) });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('refuses a grant whose horizon is at or before the instant it would be issued', async () => {
    const outcome = await issue({ source: source({ scope: { ...SOURCE_SCOPE, validity: { kind: 'window', notAfter: NOW } } }) });
    assert.deepEqual(refusalCodes(outcome), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
  });

  it('never partially issues — a refusal writes nothing the store will return', async () => {
    const store = createInMemoryBoundedGrantStore();
    const service = createGrantIssuanceService({ store });
    const refused = await service.issueGrant({
      source: source(),
      requestedBounds: { amount: { kind: 'ceiling', limit: 15_000, unit: 'USD' } },
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW,
    });
    assert.equal(refused.outcome, 'refused');
    const issued = await service.issueGrant({ source: source(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW });
    assert.equal(issued.outcome, 'issued', 'the refused attempt left no artifact and no reservation behind');
  });
});
