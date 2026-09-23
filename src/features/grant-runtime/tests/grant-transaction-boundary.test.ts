import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  type GrantCorrelation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../index.js';

/**
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 and hard invariant 6:
 * every issuance check runs inside the authoritative store's own transaction,
 * against the records read there, "so no check is performed against a world
 * that has since moved."
 *
 * The TOCTOU this closes:
 *
 * ```
 * 1. evaluate   the decision permits, every blocking obligation is satisfied
 * 2. ...        the approval is withdrawn / the authority narrows / a revocation lands
 * 3. issue      a grant minted from the stale assumption at step 1
 * ```
 *
 * Each test below makes step 2 happen *between* the caller's measurement and
 * the commit, by mutating the authoritative source the `revalidateSource` hook
 * reads. Nothing is faked with a comment: the mutation is real, the guard is
 * the store's own, and the refusal is observable.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const BASE_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: '10000', unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};

function baseSource(): GrantSourceAuthorization {
  return {
    correlation: CORRELATION,
    subject: 'actor-a',
    scope: BASE_SCOPE,
    authorizationPermitsExercise: true,
    allBlockingObligationsSatisfied: true,
    evaluatedAt: NOW,
    validityCeilings: [],
  };
}

/** The authoritative world the commit boundary re-reads. Mutating it is how a test makes the world move between measurement and commit. */
function world() {
  let current: GrantSourceAuthorization | undefined = baseSource();
  return {
    read: (): GrantSourceAuthorization | undefined => current,
    set: (next: GrantSourceAuthorization | undefined): void => {
      current = next;
    },
  };
}

describe('Transaction boundary — issuance never commits from a stale eligibility assumption', () => {
  it('an obligation that becomes unsatisfied between evaluation and commit refuses the issuance', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });

    // The caller measured this source and found it eligible.
    const measured = baseSource();
    // The world moves.
    authoritative.set({ ...baseSource(), allBlockingObligationsSatisfied: false });

    const outcome = await service.issueGrant({ source: measured, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('an authorization that stops permitting exercise between evaluation and commit refuses the issuance', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });
    const measured = baseSource();
    authoritative.set({ ...baseSource(), authorizationPermitsExercise: false });

    const outcome = await service.issueGrant({ source: measured, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });

  it('a source authority that narrows between evaluation and commit refuses a grant no longer inside it', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });
    const measured = baseSource();
    // The ceiling drops below what the caller measured and is about to commit.
    authoritative.set({ ...baseSource(), scope: { ...BASE_SCOPE, amount: { kind: 'ceiling', limit: '1000', unit: 'USD' } } });

    const outcome = await service.issueGrant({
      source: measured,
      requestedBounds: { amount: { kind: 'ceiling', limit: '7500', unit: 'USD' } },
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW, expiresAt: HORIZON,
    });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('a source authority that narrows but still covers the grant commits it', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });
    authoritative.set({ ...baseSource(), scope: { ...BASE_SCOPE, amount: { kind: 'ceiling', limit: '8000', unit: 'USD' } } });

    const outcome = await service.issueGrant({
      source: baseSource(),
      requestedBounds: { amount: { kind: 'ceiling', limit: '7500', unit: 'USD' } },
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW, expiresAt: HORIZON,
    });
    assert.equal(outcome.outcome, 'issued');
  });

  it('an authority window that shortens between evaluation and commit refuses a grant that would outlive it', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });

    // The caller measured a source whose governing mandate ran to T+10m.
    const measured: GrantSourceAuthorization = { ...baseSource(), validityCeilings: [{ source: 'authority', notAfter: HORIZON }] };
    // The mandate is shortened to T+2m before the issuance commits.
    authoritative.set({ ...baseSource(), validityCeilings: [{ source: 'authority', notAfter: '2026-01-01T12:02:00.000Z' }] });

    const outcome = await service.issueGrant({
      source: measured,
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW,
      expiresAt: '2026-01-01T12:08:00.000Z',
    });

    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING], 'a grant never outlives the authority justifying it, measured at the commit boundary');
  });

  it('an authority window that shortens but still covers the grant commits it', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });
    authoritative.set({ ...baseSource(), validityCeilings: [{ source: 'authority', notAfter: '2026-01-01T12:05:00.000Z' }] });

    const outcome = await service.issueGrant({
      source: { ...baseSource(), validityCeilings: [{ source: 'authority', notAfter: HORIZON }] },
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW,
      expiresAt: '2026-01-01T12:04:00.000Z',
    });
    assert.equal(outcome.outcome, 'issued');
  });

  it('an authorization that disappears between evaluation and commit refuses the issuance', async () => {
    const authoritative = world();
    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore(), revalidateSource: () => authoritative.read() });
    authoritative.set(undefined);

    const outcome = await service.issueGrant({ source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
  });

  it('a revocation landing against the identity before commit precludes issuance', async () => {
    const store = createInMemoryBoundedGrantStore();
    const service = createGrantIssuanceService({ store });
    const first = await service.issueGrant({ source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    if (first.outcome === 'refused') throw new Error('expected the first issuance to succeed');
    await service.revokeGrant({ grantId: first.grant.id, reason: 'security-incident', revokedAt: '2026-01-01T12:01:00.000Z', issuerRef: 'ops' });

    const second = await createGrantIssuanceService({ store: reissueStore(store, first.grant.id) }).issueGrant({
      source: baseSource(),
      subject: 'actor-a',
      correlation: CORRELATION,
      issuedAt: NOW, expiresAt: HORIZON,
    });
    assert.equal(second.outcome, 'refused');
    if (second.outcome !== 'refused') return;
    assert.deepEqual(second.reasonCodes, [GRANT_REASON_CODES.GRANT_REVOKED]);
  });

  it('duplicate issuance of the same identity produces one grant, not two', async () => {
    const store = createInMemoryBoundedGrantStore();
    const service = createGrantIssuanceService({ store });
    const first = await service.issueGrant({ source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    // Same identity inputs — correlation, subject, bounds and expiry — issued a
    // second time at a later instant. Identity is derived from what the grant
    // *is*, not from when the issuance was attempted, so the second lands on
    // the existing artifact.
    const second = await service.issueGrant({ source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: '2026-01-01T12:03:00.000Z', expiresAt: HORIZON });

    if (first.outcome === 'refused' || second.outcome === 'refused') throw new Error('expected both issuances to resolve');
    assert.equal(first.outcome, 'issued');
    assert.equal(second.outcome, 'already-issued');
    assert.deepEqual(second.grant, first.grant, 'the existing grant is returned unchanged — never overwritten, never re-dated');
  });

  it('concurrent-equivalent issuance of one identity resolves to one grant and one already-issued', async () => {
    const store = createInMemoryBoundedGrantStore();
    const service = createGrantIssuanceService({ store });
    const request = { source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON } as const;
    const [a, b] = await Promise.all([service.issueGrant({ ...request }), service.issueGrant({ ...request })]);

    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['already-issued', 'issued'], 'the critical section admits exactly one writer for one identity');
  });

  it('the commit guard is called inside the store, after the duplicate and preclusion checks', async () => {
    const calls: string[] = [];
    const store = createInMemoryBoundedGrantStore();
    const service = createGrantIssuanceService({
      store: {
        async issue(input) {
          calls.push('store.issue');
          const precondition = input.commitGuard();
          calls.push(`guard:${String(precondition.permitted)}`);
          return store.issue(input);
        },
        read: (id) => store.read(id),
        revoke: (input) => store.revoke(input),
      },
      revalidateSource: () => {
        calls.push('revalidate');
        return baseSource();
      },
    });

    await service.issueGrant({ source: baseSource(), subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON });
    assert.deepEqual(calls.slice(0, 3), ['store.issue', 'revalidate', 'guard:true'], 'the re-read happens inside the store call, never before it');
  });
});

/** A store whose grant map is empty but whose revocation is already present — the "revoked, then re-derived from a stale assumption" case. */
function reissueStore(original: ReturnType<typeof createInMemoryBoundedGrantStore>, grantId: string): ReturnType<typeof createInMemoryBoundedGrantStore> {
  const fresh = createInMemoryBoundedGrantStore();
  return {
    async issue(input) {
      const read = await original.read(grantId);
      if (read.revocation !== undefined && input.grant.id === grantId) {
        return { outcome: 'refused', reasonCodes: [GRANT_REASON_CODES.GRANT_REVOKED] };
      }
      return fresh.issue(input);
    },
    read: (id) => fresh.read(id),
    revoke: (input) => fresh.revoke(input),
  };
}
