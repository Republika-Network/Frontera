import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GovernedParameter } from '../../governed-parameter-runtime/index.js';
import { GRANT_SEMANTICS_FORMAT_V1, type GrantScope } from '../../grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES as E, assessBoundedGrantExercise, type GrantExerciseRequest } from '../index.js';
import { TEST_ISSUED_AT, buildTestGrant } from './execution-fixture.js';

/**
 * CORE-03 — the exercise gate over typed parameters and the Governance Profile
 * axis: within bound, over bound, missing, extra, wrong type, and a swapped
 * profile. The gate is the production `assessBoundedGrantExercise`.
 */

const PROFILE = `customer-data-read@1#sha256:${'e'.repeat(64)}`;
const CORRELATION = { requestId: 'req-p', decisionId: 'dec-p', action: 'read-customer-records', resourceScope: 'customer-data-example' };
const SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'read-customer-records' },
  actionClass: { kind: 'identity', value: 'read' },
  resourceClass: { kind: 'identity', value: 'customer_dataset' },
  governanceProfile: { kind: 'identity', value: PROFILE },
  organization: { kind: 'identity', value: 'org-a' },
  parameters: [
    { dimension: 'dataScope', kind: 'exact', type: 'token', value: 'contact-fields' },
    { dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 1000 },
  ],
  resources: { kind: 'set', values: ['customer-data-example'] },
};
const GRANT = buildTestGrant({ correlation: CORRELATION, scope: SCOPE, subject: 'agent-a', semanticsFormat: GRANT_SEMANTICS_FORMAT_V1 });
const AT = '2026-01-01T12:05:00.000Z';

function attempt(parameters: readonly GovernedParameter[] | undefined, overrides: Partial<GrantExerciseRequest> = {}): GrantExerciseRequest {
  return {
    boundedGrantId: GRANT.id,
    subject: 'agent-a',
    action: 'read-customer-records',
    resource: 'customer-data-example',
    organization: 'org-a',
    governanceProfile: PROFILE,
    actionClass: 'read',
    resourceClass: 'customer_dataset',
    ...(parameters !== undefined ? { parameters } : {}),
    correlation: CORRELATION,
    executionId: 'exec-p',
    ...overrides,
  };
}
const within: readonly GovernedParameter[] = [
  { dimension: 'dataScope', type: 'token', value: 'contact-fields' },
  { dimension: 'recordCount', type: 'integer', value: 1000 },
];

function assess(request: GrantExerciseRequest) {
  return assessBoundedGrantExercise({ grant: GRANT, request, at: AT });
}

describe('CORE-03 §54 — a typed non-money bound at exercise', () => {
  it('within bound (recordCount = 1000 <= 1000) is exercisable', () => {
    assert.equal(TEST_ISSUED_AT < AT, true);
    assert.deepEqual(assess(attempt(within)).reasonCodes, []);
  });

  it('over bound (recordCount = 1001) is withheld with GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE', () => {
    const result = assess(attempt([within[0] as GovernedParameter, { dimension: 'recordCount', type: 'integer', value: 1001 }]));
    assert.equal(result.usable, false);
    assert.deepEqual([...result.reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
  });

  it('a missing bound-required parameter is withheld — absence never satisfies a bound', () => {
    assert.deepEqual([...assess(attempt([within[0] as GovernedParameter])).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
    assert.deepEqual([...assess(attempt(undefined)).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
  });

  it('the wrong type is refused — a token "1000" is never the integer 1000', () => {
    assert.deepEqual([...assess(attempt([within[0] as GovernedParameter, { dimension: 'recordCount', type: 'token', value: '1000' }])).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
  });

  it('a different exact value is refused', () => {
    assert.deepEqual([...assess(attempt([{ dimension: 'dataScope', type: 'token', value: 'all-fields' }, within[1] as GovernedParameter])).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
  });

  it('a parameter for a dimension the grant never bounded is refused, not ignored', () => {
    const extra: readonly GovernedParameter[] = [within[0] as GovernedParameter, { dimension: 'destination', type: 'token', value: 'anywhere' }, within[1] as GovernedParameter];
    assert.deepEqual([...assess(attempt(extra)).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
  });

  it('an unsorted or duplicated parameter list is malformed before anything is compared', () => {
    assert.deepEqual([...assess(attempt([within[1] as GovernedParameter, within[0] as GovernedParameter])).reasonCodes], [E.GRANT_EXERCISE_REQUEST_MALFORMED]);
    assert.deepEqual(
      [...assess(attempt([within[0] as GovernedParameter, { dimension: 'recordCount', type: 'integer', value: 1 }, { dimension: 'recordCount', type: 'integer', value: 1000000 }])).reasonCodes],
      [E.GRANT_EXERCISE_REQUEST_MALFORMED],
      'two recordCount values: no shadow parameter is ever "the" value',
    );
  });
});

describe('CORE-03 §73 — action, resource and profile substitution at exercise', () => {
  it('the same grant exercised as a different action (read → export) is refused', () => {
    assert.ok(assess(attempt(within, { action: 'export-customer-records' })).reasonCodes.includes(E.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE));
  });

  it('the same grant exercised over a different resource is refused', () => {
    assert.ok(assess(attempt(within, { resource: 'all-customer-records' })).reasonCodes.includes(E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE));
  });

  it('an attempt under another profile — or none — is refused with GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH', () => {
    assert.deepEqual([...assess(attempt(within, { governanceProfile: `customer-data-export@1#sha256:${'e'.repeat(64)}` })).reasonCodes], [E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH]);
    const { governanceProfile: _omitted, ...noProfile } = attempt(within);
    assert.deepEqual([...assess(noProfile).reasonCodes], [E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH]);
  });

  it('an attempt under another action class or resource class — or none — is refused with GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH', () => {
    assert.deepEqual([...assess(attempt(within, { actionClass: 'export' })).reasonCodes], [E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH]);
    assert.deepEqual([...assess(attempt(within, { resourceClass: 'public_dataset' })).reasonCodes], [E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH]);
    const { actionClass: _omitted, ...noClass } = attempt(within);
    assert.deepEqual([...assess(noClass).reasonCodes], [E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH]);
  });

  it('a grant whose semantic marker and axes disagree is an integrity failure, whatever is attempted', () => {
    const noMarker = buildTestGrant({ correlation: CORRELATION, scope: SCOPE, subject: 'agent-a' });
    assert.ok(assessBoundedGrantExercise({ grant: noMarker, request: attempt(within, { boundedGrantId: noMarker.id }), at: AT }).reasonCodes.includes(E.GRANT_EXERCISE_INTEGRITY_INVALID), 'new axes without semanticsFormat');
    const { actionClass: _a, ...partial } = SCOPE;
    const markerWithoutAxes = buildTestGrant({ correlation: CORRELATION, scope: partial, subject: 'agent-a', semanticsFormat: GRANT_SEMANTICS_FORMAT_V1 });
    assert.ok(assessBoundedGrantExercise({ grant: markerWithoutAxes, request: attempt(within, { boundedGrantId: markerWithoutAxes.id }), at: AT }).reasonCodes.includes(E.GRANT_EXERCISE_INTEGRITY_INVALID), 'semanticsFormat without its required axes');
    const unknownMarker = buildTestGrant({ correlation: CORRELATION, scope: SCOPE, subject: 'agent-a', semanticsFormat: 'frontera.grant-semantics.v2' });
    assert.ok(assessBoundedGrantExercise({ grant: unknownMarker, request: attempt(within, { boundedGrantId: unknownMarker.id }), at: AT }).reasonCodes.includes(E.GRANT_EXERCISE_INTEGRITY_INVALID), 'an unknown marker');
  });

  it('a legacy grant (no profile, no parameters) refuses an attempt that states either', () => {
    const legacy = buildTestGrant();
    const legacyAttempt: GrantExerciseRequest = {
      boundedGrantId: legacy.id,
      subject: 'agent-A',
      action: 'payment',
      resource: 'vendor/V123',
      counterparty: 'V123',
      organization: 'org-acme',
      amount: { value: '7500', unit: 'USD' },
      correlation: legacy.correlation,
      executionId: 'exec-legacy',
    };
    assert.deepEqual([...assessBoundedGrantExercise({ grant: legacy, request: legacyAttempt, at: AT }).reasonCodes], []);
    assert.deepEqual([...assessBoundedGrantExercise({ grant: legacy, request: { ...legacyAttempt, parameters: [{ dimension: 'recordCount', type: 'integer', value: 1 }] }, at: AT }).reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
    assert.deepEqual([...assessBoundedGrantExercise({ grant: legacy, request: { ...legacyAttempt, governanceProfile: PROFILE }, at: AT }).reasonCodes], [E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH]);
  });
});
