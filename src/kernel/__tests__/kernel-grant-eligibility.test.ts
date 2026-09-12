import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createInMemoryObligationDischargeProvider,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import { GRANT_REASON_CODES } from '../../features/grant-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import { AOC_KERNEL_REASON_CODES } from '../reason-codes/reason-codes.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * `evaluate()` and grant eligibility.
 *
 * The invariant under test is the one the phase exists to protect:
 *
 * ```
 * ALLOW  does NOT automatically mean  GRANT EXISTS
 * ```
 *
 * and its mirror, which matters just as much:
 *
 * ```
 * a withheld grant does NOT mean DENY
 * ```
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3. Every assertion below
 * reads `status` and `grants.eligibility` side by side and checks that neither
 * has moved the other.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const LIFETIME = 600;

function buildKernel(options: { readonly discharges?: readonly ObligationDischargeObservation[]; readonly withObligations?: boolean } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    grants: { declaration: { maximumGrantLifetimeSeconds: LIFETIME } },
    ...(options.withObligations === true
      ? {
          obligations: {
            provider: createInMemoryObligationDischargeProvider(options.discharges ?? []),
            sources: [APPROVAL],
            declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
          },
        }
      : {}),
  });
}

function paymentRequest(requestId: string) {
  const base = toKernelRequest(buildDraftClosureEmailGuardInput());
  return { ...base, requestId, action: { ...base.action, amount: 7_500, currency: 'USD', counterpartyId: 'V123' } };
}

describe('evaluate() reports grant eligibility and never a grant', () => {
  it('an allowed authorization with no obligations declared is ELIGIBLE', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-eligibility-1'));

    assert.equal(result.status, 'allowed');
    assert.equal(result.grants?.eligibility, 'eligible');
    assert.equal(result.grants?.ineligibilityReasonCodes, undefined);
  });

  it('reports the source bounds a grant would be narrowed from, in canonical order', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-eligibility-2'));

    const bounds = result.grants?.sourceBounds ?? [];
    assert.deepEqual(bounds.map((bound) => bound.key), ['action', 'amount', 'counterparty', 'resources']);
    assert.deepEqual(
      bounds.find((bound) => bound.key === 'amount'),
      { key: 'amount', kind: 'ceiling', limit: 7_500, unit: 'USD' },
    );
    assert.deepEqual(
      bounds.find((bound) => bound.key === 'counterparty'),
      { key: 'counterparty', kind: 'identity', value: 'V123' },
    );
  });

  it('reports the upstream validity ceilings, and the deployment cap is one of them', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-eligibility-2b'));

    assert.deepEqual(result.grants?.validityCeilings, [{ source: 'deployment', notAfter: '2026-01-01T00:10:00.000Z' }]);
    assert.equal(
      result.grants?.sourceBounds.some((bound) => bound.key === 'validity'),
      false,
      'a validity window is not a scope axis — a scope says what a grant may act over, a window says when',
    );
  });

  it('reports no ceiling at all when the deployment declares no cap — no decision record carries a validity window', async () => {
    const fixture = buildDatasysEnforcementFixture();
    const kernel = new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      grants: { declaration: {} },
    });

    const result = await kernel.evaluate(paymentRequest('grant-eligibility-2c'));
    assert.deepEqual(result.grants?.validityCeilings, []);
    assert.equal(result.grants?.eligibility, 'eligible', 'an empty ceiling list is not a reason to withhold eligibility');
  });

  it('carries no grant, no grant id and no artifact — evaluate() issues nothing', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-eligibility-3'));

    const grants = result.grants as unknown as Record<string, unknown>;
    for (const forbidden of ['grant', 'grantId', 'token', 'digest', 'issuedAt', 'expiresAt']) {
      assert.equal(forbidden in grants, false, `evaluate() must not produce ${forbidden}: issuance is a separate, transactional operation`);
    }
  });

  it('two evaluations of the same world produce the same grant evaluation — evaluate() stays pure', async () => {
    const request = paymentRequest('grant-eligibility-4');
    const left = await buildKernel().evaluate(request);
    const right = await buildKernel().evaluate(request);
    assert.deepEqual(left.grants, right.grants);
  });
});

describe('ALLOW does not mean a grant exists', () => {
  it('allowed with a blocking obligation outstanding: status ALLOW, eligibility INELIGIBLE, no grant', async () => {
    const result = await buildKernel({ withObligations: true }).evaluate(paymentRequest('grant-eligibility-5'));

    assert.equal(result.status, 'allowed', 'a pending condition never un-authorizes an action');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, false);
    assert.equal(result.grants?.eligibility, 'ineligible');
    assert.deepEqual(result.grants?.ineligibilityReasonCodes, [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
  });

  it('the GRANT_ vocabulary never leaks into the authorization reason codes', async () => {
    const result = await buildKernel({ withObligations: true }).evaluate(paymentRequest('grant-eligibility-6'));

    for (const code of result.reasonCodes) assert.equal(code.startsWith('GRANT_'), false);
    assert.equal(result.reasonCodes.includes(AOC_KERNEL_REASON_CODES.KERNEL_INDETERMINATE), false);
  });

  it('discharging the obligation makes it eligible, and the decision is unchanged either way', async () => {
    const base = paymentRequest('grant-eligibility-7');
    const correlation = { requestId: base.requestId, action: base.action.capability ?? base.action.type, resourceScope: base.action.resourceScope };
    const pending = await buildKernel({ withObligations: true }).evaluate(base);
    const discharged = await buildKernel({
      withObligations: true,
      discharges: [{ obligationType: 'finance.approval', correlation, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW, subjectId: 'finance-officer', reference: 'apr-1' }],
    }).evaluate(base);

    assert.equal(pending.status, discharged.status, 'the authorization is identical; only grant eligibility moved');
    assert.deepEqual(pending.reasonCodes, discharged.reasonCodes);
    assert.equal(pending.grants?.eligibility, 'ineligible');
    assert.equal(discharged.grants?.eligibility, 'eligible');
  });
});

describe('DENY does not become eligible, whatever the obligations say', () => {
  it('a denied authorization is INELIGIBLE and stays denied', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildUnknownAgentReadGuardInput()));

    assert.equal(result.status, 'denied');
    assert.equal(result.grants?.eligibility, 'ineligible');
    assert.deepEqual(result.grants?.ineligibilityReasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });

  it('a denied authorization with every obligation satisfied is still INELIGIBLE', async () => {
    const request = toKernelRequest(buildUnknownAgentReadGuardInput());
    const correlation = { requestId: request.requestId, action: request.action.capability ?? request.action.type, resourceScope: request.action.resourceScope };
    const result = await buildKernel({
      withObligations: true,
      discharges: [{ obligationType: 'finance.approval', correlation, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW, reference: 'apr-1' }],
    }).evaluate(request);

    assert.equal(result.status, 'denied');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, true, 'the obligation really is satisfied');
    assert.equal(result.grants?.eligibility, 'ineligible');
    assert.deepEqual(result.grants?.ineligibilityReasonCodes, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });
});

describe('The correlation a grant would carry is derived, never supplied', () => {
  it('names the request, the Kernel decision, the action and the resource scope', async () => {
    const request = paymentRequest('grant-eligibility-8');
    const result = await buildKernel().evaluate(request);

    assert.deepEqual(result.grants?.correlation, {
      requestId: 'grant-eligibility-8',
      decisionId: result.decisionId,
      action: request.action.capability ?? request.action.type,
      resourceScope: request.action.resourceScope,
    });
  });

  it('the subject is the actor the authorization was evaluated for', async () => {
    const request = paymentRequest('grant-eligibility-9');
    const result = await buildKernel().evaluate(request);
    assert.equal(result.grants?.subject, request.actor.id);
  });
});
