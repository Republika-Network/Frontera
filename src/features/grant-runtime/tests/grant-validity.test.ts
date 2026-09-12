import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_REASON_CODES,
  GRANT_VALIDITY_CEILING_SOURCES,
  assertValidGrantDeclaration,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  deploymentGrantValidityCeiling,
  effectiveGrantValidityCeiling,
  resolveGrantValidity,
  withGrantValidityCeiling,
  type GrantCorrelation,
  type GrantIssuanceOutcome,
  type GrantScope,
  type GrantSourceAuthorization,
  type GrantValidityCeiling,
} from '../index.js';

/**
 * Where a grant's validity comes from.
 *
 * Normative source: `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4, "Where
 * a grant's validity comes from", and hard invariants 9 and 10.
 *
 * ```
 * 1  every bounded grant is finite
 * 2  expiresAt is proposed by the trusted issuer
 * 3  the proposal is contained by every applicable upstream ceiling that exists
 * 4  no upstream bound is invented where none exists
 * ```
 *
 * An earlier revision had this backwards — the horizon was derived as
 * `evaluatedAt + maximumGrantLifetimeSeconds`, and a deployment configuring no
 * maximum could issue no grants at all. The first test below is the one that
 * would have failed then, and it is the point of this suite.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: 7_500, unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};

function source(ceilings: readonly GrantValidityCeiling[] = []): GrantSourceAuthorization {
  return {
    correlation: CORRELATION,
    subject: 'actor-a',
    scope: SCOPE,
    authorizationPermitsExercise: true,
    allBlockingObligationsSatisfied: true,
    evaluatedAt: NOW,
    validityCeilings: ceilings,
  };
}

async function issue(input: {
  readonly expiresAt?: string;
  readonly ceilings?: readonly GrantValidityCeiling[];
  readonly additional?: readonly GrantValidityCeiling[];
  readonly issuedAt?: string;
}): Promise<GrantIssuanceOutcome> {
  const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
  return service.issueGrant({
    source: source(input.ceilings ?? []),
    subject: 'actor-a',
    correlation: CORRELATION,
    issuedAt: input.issuedAt ?? NOW,
    // Deliberately cast rather than omitted: the point of several cases below is
    // what happens when an issuer supplies nothing, and the type forbids it.
    expiresAt: input.expiresAt as string,
    ...(input.additional !== undefined ? { additionalValidityCeilings: input.additional } : {}),
  });
}

function codes(outcome: GrantIssuanceOutcome): readonly string[] {
  return outcome.outcome === 'refused' ? [...outcome.reasonCodes] : [];
}

describe('Rule 2 — the issuer proposes the expiry, and nothing proposes one for it', () => {
  it('an issuer-supplied finite expiry issues a grant with NO deployment ceiling configured at all', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:05:00.000Z' });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:05:00.000Z');
    assert.equal(outcome.effectiveValidityCeiling, undefined, 'nothing was capping it, and that is an ordinary answer');
  });

  it('the accepted expiry is exactly what the issuer proposed — never rewritten', async () => {
    for (const proposed of ['2026-01-01T12:00:00.001Z', '2026-01-01T12:30:00.000Z', '2027-06-01T00:00:00.000Z']) {
      const outcome = await issue({ expiresAt: proposed });
      if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');
      assert.equal(outcome.grant.expiresAt, proposed);
    }
  });

  it('a missing issuer expiry refuses issuance', async () => {
    assert.deepEqual(codes(await issue({})), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
    assert.deepEqual(codes(await issue({ expiresAt: '' })), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
  });

  it('a malformed issuer expiry refuses issuance', async () => {
    for (const malformed of ['whenever', 'tomorrow', '2026-13-45T99:99:99Z', 'null']) {
      assert.deepEqual(codes(await issue({ expiresAt: malformed })), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID], malformed);
    }
  });

  it('an expiry at or before issuedAt refuses issuance', async () => {
    assert.deepEqual(codes(await issue({ expiresAt: NOW })), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
    assert.deepEqual(codes(await issue({ expiresAt: '2026-01-01T11:59:59.999Z' })), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
  });

  it('one millisecond after issuedAt is accepted — the rule is strictly after, not comfortably after', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:00:00.001Z' });
    assert.equal(outcome.outcome, 'issued');
  });
});

describe('Rule 3 — every applicable ceiling contains the proposal', () => {
  const DEPLOYMENT: GrantValidityCeiling = { source: 'deployment', notAfter: '2026-01-01T12:10:00.000Z' };
  const AUTHORITY: GrantValidityCeiling = { source: 'authority', notAfter: '2026-01-01T12:04:00.000Z' };
  const DECISION: GrantValidityCeiling = { source: 'decision', notAfter: '2026-01-01T12:07:00.000Z' };

  it('an expiry inside the deployment ceiling is accepted, and the ceiling is reported', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:05:00.000Z', ceilings: [DEPLOYMENT] });
    if (outcome.outcome !== 'issued') throw new Error('expected an issued grant');
    assert.equal(outcome.grant.expiresAt, '2026-01-01T12:05:00.000Z');
    assert.deepEqual(outcome.effectiveValidityCeiling, DEPLOYMENT);
  });

  it('an expiry exactly at the ceiling is accepted — equal is attenuation', async () => {
    const outcome = await issue({ expiresAt: DEPLOYMENT.notAfter, ceilings: [DEPLOYMENT] });
    assert.equal(outcome.outcome, 'issued');
  });

  it('an expiry beyond the deployment ceiling is REFUSED, never silently clamped', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T13:00:00.000Z', ceilings: [DEPLOYMENT] });

    assert.equal(outcome.outcome, 'refused');
    assert.deepEqual(codes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.effectiveValidityCeiling, DEPLOYMENT, 'the refusal names what capped it');
  });

  it('an authority ceiling caps the grant', async () => {
    const within = await issue({ expiresAt: '2026-01-01T12:03:00.000Z', ceilings: [AUTHORITY] });
    assert.equal(within.outcome, 'issued');

    const beyond = await issue({ expiresAt: '2026-01-01T12:09:00.000Z', ceilings: [AUTHORITY] });
    assert.deepEqual(codes(beyond), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('a grant cannot outlive the authority justifying it, even when the deployment cap is generous', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:09:00.000Z', ceilings: [DEPLOYMENT, AUTHORITY] });

    assert.deepEqual(codes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.effectiveValidityCeiling, AUTHORITY, 'the strictest bound is the one that governs');
  });

  it('the strictest of several ceilings is the effective one, whichever kind it is', () => {
    assert.deepEqual(effectiveGrantValidityCeiling([DEPLOYMENT, DECISION, AUTHORITY]), AUTHORITY);
    assert.deepEqual(effectiveGrantValidityCeiling([DEPLOYMENT, DECISION]), DECISION);
    assert.deepEqual(effectiveGrantValidityCeiling([DEPLOYMENT]), DEPLOYMENT);
    assert.equal(effectiveGrantValidityCeiling([]), undefined);
  });

  it('a ceiling supplied by the host at issuance time is honoured alongside the source’s own', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:09:00.000Z', ceilings: [DEPLOYMENT], additional: [AUTHORITY] });
    assert.deepEqual(codes(outcome), [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('`withGrantValidityCeiling` adds a ceiling without mutating the source', () => {
    const original = source([DEPLOYMENT]);
    const extended = withGrantValidityCeiling(original, AUTHORITY);

    assert.deepEqual(original.validityCeilings, [DEPLOYMENT], 'the source handed in is never mutated');
    assert.deepEqual(extended.validityCeilings, [DEPLOYMENT, AUTHORITY]);
  });

  it('a malformed ceiling fails closed rather than quietly stopping capping', async () => {
    const outcome = await issue({ expiresAt: '2026-01-01T12:01:00.000Z', ceilings: [{ source: 'authority', notAfter: 'never' }] });
    assert.deepEqual(codes(outcome), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
    assert.equal(effectiveGrantValidityCeiling([{ source: 'authority', notAfter: 'never' }]), undefined);
  });

  it('the ceiling vocabulary is closed and names what imposed the bound', () => {
    assert.deepEqual([...GRANT_VALIDITY_CEILING_SOURCES], ['authority', 'decision', 'deployment']);
  });
});

describe('Rule 4 — no upstream bound is invented where none exists', () => {
  it('an absent upstream ceiling does NOT make a finite issuer expiry invalid', () => {
    const resolution = resolveGrantValidity({ issuedAt: NOW, requestedExpiresAt: '2029-01-01T00:00:00.000Z', ceilings: [] });

    assert.equal(resolution.outcome, 'accepted');
    assert.equal(resolution.expiresAt, '2029-01-01T00:00:00.000Z');
    assert.equal(resolution.effectiveCeiling, undefined);
    assert.deepEqual(resolution.reasonCodes, []);
  });

  it('an empty ceiling list never means unbounded — the issuer must still state a finite expiry', () => {
    assert.equal(resolveGrantValidity({ issuedAt: NOW, requestedExpiresAt: undefined, ceilings: [] }).outcome, 'refused');
  });
});

describe('The deployment ceiling is optional', () => {
  it('an empty declaration is valid at wiring time', () => {
    assert.doesNotThrow(() => assertValidGrantDeclaration({}));
    assert.doesNotThrow(() => assertValidGrantDeclaration({ maximumGrantLifetimeSeconds: 600 }));
  });

  it('a *present* invalid lifetime is still a wiring-time failure', () => {
    for (const maximumGrantLifetimeSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => assertValidGrantDeclaration({ maximumGrantLifetimeSeconds }), /maximumGrantLifetimeSeconds/);
    }
  });

  it('no declared lifetime imposes no ceiling', () => {
    assert.equal(deploymentGrantValidityCeiling({}, NOW), undefined);
  });

  it('a declared lifetime imposes a ceiling measured from the instant it is given, with no ambient clock', () => {
    assert.deepEqual(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, NOW), { source: 'deployment', notAfter: '2026-01-01T12:10:00.000Z' });
    assert.deepEqual(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, '2030-06-01T00:00:00.000Z'), {
      source: 'deployment',
      notAfter: '2030-06-01T00:10:00.000Z',
    });
  });

  it('an unparseable anchor imposes no ceiling, and that alone never issues an unbounded grant', async () => {
    assert.equal(deploymentGrantValidityCeiling({ maximumGrantLifetimeSeconds: 600 }, 'not-a-time'), undefined);
    assert.deepEqual(codes(await issue({})), [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID]);
  });
});
