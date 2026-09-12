import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  GRANT_REVOCATION_REASONS,
  assessGrantExercise,
  boundedGrantDigest,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  isGrantRevocationReason,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantIssuanceService,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../index.js';
import { ENTERPRISE_GRANT_REVOCATION_REASONS } from '@aoc-enterprise/grant-revocation';

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';

const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const SOURCE_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};

const SOURCE: GrantSourceAuthorization = {
  correlation: CORRELATION,
  subject: 'actor-a',
  scope: SOURCE_SCOPE,
  authorizationPermitsExercise: true,
  allBlockingObligationsSatisfied: true,
  evaluatedAt: NOW,
  validityCeilings: [],
};

async function issued(): Promise<{ readonly service: GrantIssuanceService; readonly store: BoundedGrantStorePort; readonly grant: BoundedGrant }> {
  const store = createInMemoryBoundedGrantStore();
  const service = createGrantIssuanceService({ store });
  const outcome = await service.issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return { service, store, grant: outcome.grant };
}

describe('Expiry — a state derived from the clock at read time, never a sweeper', () => {
  it('is exercisable before its horizon', async () => {
    const { service, grant } = await issued();
    assert.equal((await service.assessExercise(grant.id, '2026-01-01T12:09:59.999Z')).eligibility, 'exercisable');
  });

  it('is unusable at its horizon, with nothing having swept', async () => {
    const { service, grant } = await issued();
    const assessment = await service.assessExercise(grant.id, HORIZON);
    assert.equal(assessment.eligibility, 'unusable');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_EXPIRED]);
  });

  it('is unusable after its horizon', async () => {
    const { service, grant } = await issued();
    assert.equal((await service.assessExercise(grant.id, '2026-01-02T00:00:00.000Z')).eligibility, 'unusable');
  });

  it('expiry never mutates the stored grant — the artifact an auditor reads is the one that was issued', async () => {
    const { service, store, grant } = await issued();
    await service.assessExercise(grant.id, '2026-01-02T00:00:00.000Z');
    const read = await store.read(grant.id);
    assert.deepEqual(read.grant, grant);
  });

  it('a malformed instant on either side makes the grant unusable, never usable forever', () => {
    const grant = { ...({} as BoundedGrant) };
    void grant;
    assert.equal(assessGrantExercise({ grant: brokenGrant('never'), at: NOW }).eligibility, 'unusable');
    assert.equal(assessGrantExercise({ grant: brokenGrant(HORIZON), at: 'not-a-time' }).eligibility, 'unusable');
  });
});

function brokenGrant(expiresAt: string): BoundedGrant {
  const withoutDigest = {
    id: 'aoc.grant:test',
    correlation: CORRELATION,
    subject: 'actor-a',
    scope: SOURCE_SCOPE,
    issuedAt: NOW,
    expiresAt,
    sourceDigest: 'sha256:0',
  };
  return { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };
}

describe('Revocation — deterministic, idempotent, and never a rewrite of history', () => {
  it('a revoked grant is unusable', async () => {
    const { service, grant } = await issued();
    const revoked = await service.revokeGrant({ grantId: grant.id, reason: 'administrator-revoked', revokedAt: '2026-01-01T12:05:00.000Z', issuerRef: 'ops' });
    assert.equal(revoked.outcome, 'revoked');
    const assessment = await service.assessExercise(grant.id, '2026-01-01T12:06:00.000Z');
    assert.equal(assessment.eligibility, 'unusable');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_REVOKED]);
  });

  it('revocation is idempotent, and the first revocation stands', async () => {
    const { service, grant } = await issued();
    const first = await service.revokeGrant({ grantId: grant.id, reason: 'administrator-revoked', revokedAt: '2026-01-01T12:05:00.000Z', issuerRef: 'ops' });
    const second = await service.revokeGrant({ grantId: grant.id, reason: 'security-incident', revokedAt: '2026-01-01T12:07:00.000Z', issuerRef: 'someone-else' });
    if (first.outcome === 'refused' || second.outcome === 'refused') throw new Error('expected both revocations to resolve');
    assert.equal(first.outcome, 'revoked');
    assert.equal(second.outcome, 'already-revoked');
    assert.deepEqual(second.revocation, first.revocation, 'a later call is not new information about when a grant stopped being exercisable');
  });

  it('revocation never touches the grant record itself', async () => {
    const { service, store, grant } = await issued();
    await service.revokeGrant({ grantId: grant.id, reason: 'policy-changed', revokedAt: '2026-01-01T12:05:00.000Z', issuerRef: 'ops' });
    const read = await store.read(grant.id);
    assert.deepEqual(read.grant, grant, 'the historical artifact is preserved; only exercisability changes');
    assert.equal(read.revocation?.reason, 'policy-changed');
  });

  it('a revoked grant that is also expired reports both reasons', async () => {
    const { service, grant } = await issued();
    await service.revokeGrant({ grantId: grant.id, reason: 'expired', revokedAt: '2026-01-01T12:05:00.000Z', issuerRef: 'ops' });
    const assessment = await service.assessExercise(grant.id, '2026-01-02T00:00:00.000Z');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_REVOKED, GRANT_REASON_CODES.GRANT_EXPIRED]);
  });

  it('revoking a grant that was never issued is refused, never silently recorded', async () => {
    const { service } = await issued();
    const outcome = await service.revokeGrant({ grantId: 'aoc.grant:absent', reason: 'manual-revocation', revokedAt: NOW, issuerRef: 'ops' });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_NOT_FOUND]);
  });

  it('reuses the existing revocation vocabulary exactly — no second, incompatible revocation subsystem', () => {
    assert.deepEqual([...GRANT_REVOCATION_REASONS].sort(), Object.values(ENTERPRISE_GRANT_REVOCATION_REASONS).sort());
    for (const reason of Object.values(ENTERPRISE_GRANT_REVOCATION_REASONS)) assert.equal(isGrantRevocationReason(reason), true);
    assert.equal(isGrantRevocationReason('provider-said-so'), false);
  });
});

describe('Tamper evidence', () => {
  it('a grant whose fields were edited after issuance no longer matches its digest and is unusable', async () => {
    const { grant } = await issued();
    const tampered: BoundedGrant = { ...grant, scope: { ...grant.scope, amount: { kind: 'ceiling', limit: 1_000_000, unit: 'USD' } } };
    const assessment = assessGrantExercise({ grant: tampered, at: NOW });
    assert.equal(assessment.eligibility, 'unusable');
    assert.equal(assessment.reasonCodes.includes(GRANT_REASON_CODES.GRANT_CORRELATION_INVALID), true);
  });

  it('an extended expiry on a copied grant is detected', async () => {
    const { grant } = await issued();
    const tampered: BoundedGrant = { ...grant, expiresAt: '2099-01-01T00:00:00.000Z' };
    assert.equal(assessGrantExercise({ grant: tampered, at: NOW }).eligibility, 'unusable');
  });

  it('a substituted subject on a copied grant is detected', async () => {
    const { grant } = await issued();
    assert.equal(assessGrantExercise({ grant: { ...grant, subject: 'attacker' }, at: NOW }).eligibility, 'unusable');
  });

  it('reading a grant identity the store does not hold reports not found rather than anything usable', async () => {
    const { service } = await issued();
    const assessment = await service.assessExercise('aoc.grant:forged', NOW);
    assert.equal(assessment.eligibility, 'unusable');
    assert.deepEqual(assessment.reasonCodes, [GRANT_REASON_CODES.GRANT_NOT_FOUND]);
  });
});
