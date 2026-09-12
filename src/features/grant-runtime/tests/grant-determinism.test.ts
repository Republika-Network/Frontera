import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  attenuateGrantScope,
  boundedGrantDigest,
  boundedGrantId,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  deploymentGrantValidityCeiling,
  serializeBoundedGrant,
  serializeGrantScope,
  type GrantCorrelation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../index.js';
import { canonicalSerialize } from '../../../enterprise/governance-store/canonical-json.js';
import { computeDigest } from '../../../enterprise/governance-store/digest.js';

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' },
  counterparty: { kind: 'identity', value: 'V123' },
  organization: { kind: 'identity', value: 'org-1' },
  resources: { kind: 'set', values: ['record:contract', 'record:invoice'] },
};

const SOURCE: GrantSourceAuthorization = {
  correlation: CORRELATION,
  subject: 'actor-a',
  scope: SCOPE,
  authorizationPermitsExercise: true,
  allBlockingObligationsSatisfied: true,
  evaluatedAt: NOW,
  validityCeilings: [{ source: 'deployment', notAfter: HORIZON }],
};

describe('Deterministic grant identity', () => {
  it('the same correlation, subject and bounds always produce the same id', () => {
    assert.equal(boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON }), boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON }));
  });

  it('set order and key insertion order do not change the id', () => {
    const reordered: GrantScope = {
      resources: { kind: 'set', values: ['record:invoice', 'record:contract'] },
      organization: { kind: 'identity', value: 'org-1' },
      counterparty: { kind: 'identity', value: 'V123' },
      amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' },
      action: { kind: 'identity', value: 'payment.send' },
    };
    assert.equal(boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: reordered, expiresAt: HORIZON }), boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON }));
  });

  it('a different subject, correlation or bound produces a different id', () => {
    const base = boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON });
    assert.notEqual(boundedGrantId({ correlation: CORRELATION, subject: 'actor-b', scope: SCOPE, expiresAt: HORIZON }), base);
    assert.notEqual(boundedGrantId({ correlation: { ...CORRELATION, decisionId: 'dec-2' }, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON }), base);
    assert.notEqual(boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: { ...SCOPE, amount: { kind: 'ceiling', limit: 9_999, unit: 'USD' } }, expiresAt: HORIZON }), base);
  });

  it('carries no UUID, no counter and no clock — two ids minted a day apart are identical', () => {
    const first = boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON });
    const second = boundedGrantId({ correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, expiresAt: HORIZON });
    assert.equal(first, second);
    assert.match(first, /^aoc\.grant:[0-9a-f]{32}$/);
  });

  it('repeated identical issuance inputs produce a byte-identical derived grant', async () => {
    const issueOnce = async () => {
      const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
      const outcome = await service.issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
      if (outcome.outcome === 'refused') throw new Error('expected an issued grant');
      return serializeBoundedGrant(outcome.grant);
    };
    assert.equal(await issueOnce(), await issueOnce());
  });

  it('attenuation is order-independent and repeatable', () => {
    const requested = { amount: { kind: 'ceiling' as const, limit: 5_000, unit: 'USD' }, resources: { kind: 'set' as const, values: ['record:invoice', 'record:contract'] } };
    const a = attenuateGrantScope(SCOPE, requested);
    const b = attenuateGrantScope(SCOPE, { resources: requested.resources, amount: requested.amount });
    assert.deepEqual(a, b);
  });
});

describe('Canonicalization — byte-compatible with aoc.canonical-json.v1', () => {
  it('a serialized scope matches what the Governance Store canonicalizer produces for the same value', () => {
    assert.equal(serializeGrantScope(SCOPE), canonicalSerialize(JSON.parse(serializeGrantScope(SCOPE)) as unknown));
  });

  it('a scope with an unstated axis omits it rather than writing null', () => {
    const partial: GrantScope = { action: { kind: 'identity', value: 'payment.send' }, resources: { kind: 'set', values: ['record:contract'] } };
    const serialized = serializeGrantScope(partial);
    assert.equal(serialized.includes('null'), false);
    assert.equal(serialized, canonicalSerialize(JSON.parse(serialized) as unknown));
  });

  it('a serialized grant matches the canonicalizer for the same value', async () => {
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    const outcome = await service.issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    if (outcome.outcome === 'refused') throw new Error('expected an issued grant');
    const serialized = serializeBoundedGrant(outcome.grant);
    assert.equal(serialized, canonicalSerialize(JSON.parse(serialized) as unknown));
  });

  it('the grant digest is the repository digest idiom over the same canonical bytes', async () => {
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    const outcome = await service.issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    if (outcome.outcome === 'refused') throw new Error('expected an issued grant');
    const { digest, ...withoutDigest } = outcome.grant;
    assert.equal(digest, boundedGrantDigest(withoutDigest));
    assert.equal(digest, computeDigest(JSON.parse(serializeBoundedGrant({ ...withoutDigest, digest: '' })) as unknown));
  });

  it('`-0` normalizes to `0`, so two scopes meaning the same limit never digest differently', () => {
    const negativeZero: GrantScope = { amount: { kind: 'ceiling', limit: -0, unit: 'USD' } };
    const positiveZero: GrantScope = { amount: { kind: 'ceiling', limit: 0, unit: 'USD' } };
    assert.equal(serializeGrantScope(negativeZero), serializeGrantScope(positiveZero));
  });
});

describe('No hidden clock and no hidden randomness', () => {
  it('the deployment ceiling is computed from the instant it is given, never from an ambient clock', () => {
    assert.deepEqual(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, NOW), { source: 'deployment', notAfter: HORIZON });
    assert.deepEqual(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, '2030-06-01T00:00:00.000Z'), {
      source: 'deployment',
      notAfter: '2030-06-01T00:10:00.000Z',
    });
  });

  it('an unparseable anchor yields no ceiling — which caps nothing and issues nothing unbounded, because the issuer still states the expiry', () => {
    assert.equal(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, 'not-a-time'), undefined);
  });
});
