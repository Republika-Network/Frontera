import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryBoundedGrantStore, type BoundedGrant } from '../../grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, assessBoundedGrantExercise, createGrantExecutionService, type GrantExerciseRequest } from '../index.js';
import { TEST_EXPIRES_AT, buildExerciseRequest, buildTestGrant, createRecordingExecutionAdapter } from './execution-fixture.js';

/**
 * Determinism, and the self-assertion boundary.
 *
 * The two are one suite because they are the same property measured twice: an
 * assessment is a pure function of the trusted grant, the attempted action and
 * the injected instant, so *nothing a caller adds* can move it — which is both
 * "repeated reads agree" and "a forged field changes nothing".
 */

const AT = '2026-01-01T12:05:00.000Z';

async function seeded(grant: BoundedGrant) {
  const store = createInMemoryBoundedGrantStore();
  await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
  return store;
}

describe('Exercise determinism', () => {
  it('repeated assessments at the same instant are identical, field for field', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const service = createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now: () => AT });
    const request = buildExerciseRequest(grant);

    const first = await service.assess(request);
    const second = await service.assess(request);
    const third = await service.assess(request);

    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  });

  it('repeated refusals report the same codes in the same order', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const service = createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now: () => TEST_EXPIRES_AT });
    const request = buildExerciseRequest(grant, { subject: 'agent-B', amount: { value: '9000', unit: 'USD' } });

    const first = await service.assess(request);
    const second = await service.assess(request);

    assert.deepEqual(second.reasonCodes, first.reasonCodes);
    assert.ok(first.reasonCodes.length >= 3);
  });

  it('the assessment moves only when the injected instant moves', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const request = buildExerciseRequest(grant);

    const before = await createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now: () => '2026-01-01T12:09:59.999Z' }).assess(request);
    const after = await createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now: () => TEST_EXPIRES_AT }).assess(request);

    assert.equal(before.usable, true);
    assert.equal(after.usable, false);
    assert.deepEqual(after.reasonCodes, [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED]);
  });

  it('a malformed expiresAt makes a grant unusable, never usable-forever', () => {
    const grant: BoundedGrant = { ...buildTestGrant(), expiresAt: 'not-an-instant' };
    const assessment = assessBoundedGrantExercise({ grant, request: buildExerciseRequest(grant), at: AT });

    assert.equal(assessment.usable, false);
    assert.ok(assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
  });

  it('a malformed assessment instant is refused too — an unreadable clock is not a permissive clock', () => {
    const grant = buildTestGrant();
    const assessment = assessBoundedGrantExercise({ grant, request: buildExerciseRequest(grant), at: 'whenever' });

    assert.equal(assessment.usable, false);
    assert.ok(assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
  });
});

describe('Exercise — caller self-assertion changes nothing', () => {
  /**
   * The payloads the brief names, each submitted as an extra field on the
   * exercise request object.
   *
   * They cannot be typed onto `GrantExerciseRequest` at all — the type carries
   * a grant *reference* and no grant, so there is no `maxAmount`, no `status`,
   * no `expiresAt`, no `revoked` and no grant `subject` to set. Casting past
   * the type system is the strongest form of the attack available, and the
   * assertion is that even then the assessment is byte-identical.
   */
  const FORGERIES: readonly Readonly<Record<string, unknown>>[] = [
    { maxAmount: 1_000_000 },
    { 'aoc.grant': { status: 'active' } },
    { grant: { expiresAt: '2099-01-01T00:00:00.000Z' } },
    { grant: { subject: 'attacker' } },
    { grant: { resource: '*' } },
    { grant: { revoked: false } },
    { grant: { maxAmount: 1_000_000, action: '*', subject: 'attacker' } },
    { grantEligible: true },
    { scope: { amount: { kind: 'ceiling', limit: '1000000', unit: 'USD' } } },
    { digest: 'sha256:forged', usable: true },
    { revocation: undefined, expiresAt: '2099-01-01T00:00:00.000Z' },
  ];

  it('every forged field leaves a valid assessment byte-identical', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const service = createGrantExecutionService({ store, adapter: createRecordingExecutionAdapter(), now: () => AT });

    const clean = await service.assess(buildExerciseRequest(grant));
    for (const forgery of FORGERIES) {
      const forged = { ...buildExerciseRequest(grant), ...forgery } as unknown as GrantExerciseRequest;
      assert.deepEqual(await service.assess(forged), clean, `the forgery ${JSON.stringify(forgery)} moved the assessment`);
    }
  });

  it('a forged ceiling does not raise the real one, and the adapter is still not called', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT });

    const forged = {
      ...buildExerciseRequest(grant, { amount: { value: '1000000', unit: 'USD' } }),
      maxAmount: 1_000_000,
      grant: { maxAmount: 1_000_000, expiresAt: '2099-01-01T00:00:00.000Z' },
    } as unknown as GrantExerciseRequest;

    const outcome = await service.exercise(forged);
    assert.equal(outcome.status, 'withheld');
    assert.ok(outcome.assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED));
    assert.equal(adapter.callCount, 0, 'the trusted 7500 ceiling stood; 1000000 never became authority');
  });

  it('a caller cannot clear a revocation by claiming it is absent', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    await store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: AT, issuerRef: 'ops' });

    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT });

    const forged = { ...buildExerciseRequest(grant), revoked: false, revocation: null, status: 'active' } as unknown as GrantExerciseRequest;
    const outcome = await service.exercise(forged);

    assert.equal(outcome.status, 'withheld');
    assert.ok(outcome.assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED));
    assert.equal(adapter.callCount, 0);
  });

  it('a caller cannot extend expiresAt past the trusted horizon', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => TEST_EXPIRES_AT });

    const forged = { ...buildExerciseRequest(grant), expiresAt: '2099-01-01T00:00:00.000Z' } as unknown as GrantExerciseRequest;
    const outcome = await service.exercise(forged);

    assert.equal(outcome.status, 'withheld');
    assert.ok(outcome.assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(adapter.callCount, 0);
  });

  it('naming another holder’s grant id does not make the attacker its holder', async () => {
    const grant = buildTestGrant();
    const store = await seeded(grant);
    const adapter = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter, now: () => AT });

    const outcome = await service.exercise(buildExerciseRequest(grant, { subject: 'attacker' }));
    assert.equal(outcome.status, 'withheld');
    assert.deepEqual([...outcome.assessment.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_SUBJECT_MISMATCH]);
    assert.equal(adapter.callCount, 0);
  });
});
