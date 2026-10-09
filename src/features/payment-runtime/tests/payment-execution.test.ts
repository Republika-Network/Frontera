import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_FAILURE_REASONS, readExecutionAdapterResult, type ValidatedExecutionAction } from '../../execution-runtime/index.js';
import {
  PAYMENT_EXECUTION_REFUSALS as R,
  PAYMENT_RAIL_DETAILS,
  PaymentConfigurationError,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  executionResultOfPaymentRail,
  preparePaymentExecution,
  type PaymentRailResult,
} from '../index.js';
import { REFERENCE_RAIL_ID, createRecordingPaymentRail } from './payment-rail-fixture.js';

/**
 * PAY-01 qualification, contract level: the prepared payment execution (P9),
 * the payment rail contract and its mapping onto the existing execution
 * outcome vocabulary (P10–P12), and the rail's isolation from anything that
 * is not exactly a granted payment.
 */

const BINDING = createPaymentGovernanceBinding({ action: 'payment.send' });

type ActionOverrides = { readonly [K in keyof ValidatedExecutionAction]?: ValidatedExecutionAction[K] | undefined };

function validatedAction(overrides: ActionOverrides = {}): ValidatedExecutionAction {
  const action: Record<string, unknown> = {
    boundedGrantId: 'grant-1',
    subject: 'actor-1',
    action: 'payment.send',
    resource: 'acct-operating-001',
    counterparty: 'account:vendor-4471',
    organization: 'org-1',
    amount: { value: '1250.5', unit: 'USD' },
    parameters: [
      { dimension: 'paymentPurpose', type: 'token', value: 'vendor-payment' },
      { dimension: 'paymentReference', type: 'token', value: 'INV-2026-0042' },
    ],
    notAfter: '2026-01-01T00:10:00.000Z',
    correlation: { requestId: 'aoc.gar:00000000000000000000000000000001', decisionId: 'decision-1', executionId: 'exec-1' },
    ...overrides,
  };
  for (const key of Object.keys(action)) if (action[key] === undefined) delete action[key];
  return action as unknown as ValidatedExecutionAction;
}

describe('PAY-01 P9 — the rail receives exactly the normalized, granted payment', () => {
  it('prepares a request from the validated action only, with least authority', () => {
    const preparation = preparePaymentExecution(validatedAction(), BINDING);
    assert.equal(preparation.prepared, true);
    if (!preparation.prepared) return;
    assert.deepEqual(preparation.request, {
      executionId: 'exec-1',
      requestId: 'aoc.gar:00000000000000000000000000000001',
      decisionId: 'decision-1',
      grantId: 'grant-1',
      notAfter: '2026-01-01T00:10:00.000Z',
      source: { accountId: 'acct-operating-001' },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '1250.5', unit: 'USD' },
      purpose: 'vendor-payment',
      reference: 'INV-2026-0042',
    });
    for (const absent of ['subject', 'organization', 'actorId', 'decision', 'status', 'grant', 'scope', 'policy', 'obligations', 'approval', 'digest', 'parameters']) {
      assert.equal(absent in preparation.request, false, absent);
    }
    assert.ok(Object.isFrozen(preparation.request) && Object.isFrozen(preparation.request.amount) && Object.isFrozen(preparation.request.destination));
  });

  it('carries payment parameters only, never another dimension a host profile declares', () => {
    const preparation = preparePaymentExecution(
      validatedAction({ parameters: [{ dimension: 'costCenter', type: 'token', value: 'cc-9' }, { dimension: 'paymentPurpose', type: 'token', value: 'payroll' }] }),
      BINDING,
    );
    assert.equal(preparation.prepared && JSON.stringify(preparation.request).includes('cc-9'), false);
  });

  const refusals: readonly [string, ActionOverrides, string][] = [
    ['another action', { action: 'export-records' }, R.PAYMENT_EXECUTION_ACTION_UNBOUND],
    ['no amount', { amount: undefined }, R.PAYMENT_EXECUTION_AMOUNT_INVALID],
    ['a zero amount', { amount: { value: '0', unit: 'USD' } }, R.PAYMENT_EXECUTION_AMOUNT_INVALID],
    ['a numeric amount', { amount: { value: 10 as unknown as string, unit: 'USD' } }, R.PAYMENT_EXECUTION_AMOUNT_INVALID],
    ['a source that is not an account reference', { resource: 'a/b' }, R.PAYMENT_EXECUTION_SOURCE_INVALID],
    ['no counterparty', { counterparty: undefined }, R.PAYMENT_EXECUTION_DESTINATION_INVALID],
    ['an undecodable counterparty', { counterparty: 'vendor-4471' }, R.PAYMENT_EXECUTION_DESTINATION_INVALID],
    ['no purpose', { parameters: [] }, R.PAYMENT_EXECUTION_PARAMETERS_INVALID],
    ['a purpose outside the vocabulary', { parameters: [{ dimension: 'paymentPurpose', type: 'token', value: 'gift' }] }, R.PAYMENT_EXECUTION_PARAMETERS_INVALID],
    ['a purpose of the wrong type', { parameters: [{ dimension: 'paymentPurpose', type: 'boolean', value: true }] }, R.PAYMENT_EXECUTION_PARAMETERS_INVALID],
    ['a rail of the wrong type', { parameters: [{ dimension: 'paymentPurpose', type: 'token', value: 'payroll' }, { dimension: 'paymentRail', type: 'integer', value: 1 }] }, R.PAYMENT_EXECUTION_PARAMETERS_INVALID],
  ];
  for (const [label, overrides, refusal] of refusals) {
    it(`refuses to prepare ${label} — and the rail is never invoked`, async () => {
      assert.deepEqual(preparePaymentExecution(validatedAction(overrides), BINDING), { prepared: false, refusal });
      const rail = createRecordingPaymentRail();
      const result = await createPaymentRailExecutionAdapter({ rail, binding: BINDING }).execute(validatedAction(overrides));
      assert.deepEqual(result, { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: PAYMENT_RAIL_DETAILS.PAYMENT_EXECUTION_NOT_PREPARED });
      assert.equal(rail.callCount, 0);
    });
  }

  it('refuses a payment granted for a different rail before contacting this one', async () => {
    const rail = createRecordingPaymentRail();
    const action = validatedAction({ parameters: [{ dimension: 'paymentPurpose', type: 'token', value: 'payroll' }, { dimension: 'paymentRail', type: 'token', value: 'other-rail' }] });
    const result = await createPaymentRailExecutionAdapter({ rail, binding: BINDING }).execute(action);
    assert.deepEqual(result, { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_NOT_PREFERRED });
    assert.equal(rail.callCount, 0);
  });

  it('executes a payment granted for this rail', async () => {
    const rail = createRecordingPaymentRail();
    const action = validatedAction({ parameters: [{ dimension: 'paymentPurpose', type: 'token', value: 'payroll' }, { dimension: 'paymentRail', type: 'token', value: REFERENCE_RAIL_ID }] });
    assert.equal((await createPaymentRailExecutionAdapter({ rail, binding: BINDING }).execute(action)).outcome, 'completed');
    assert.equal(rail.callCount, 1);
    assert.equal(rail.requests[0]?.rail, REFERENCE_RAIL_ID);
  });
});

describe('PAY-01 P10–P12 — rail results map onto the existing execution outcome vocabulary', () => {
  const run = async (behaviour: () => PaymentRailResult | Promise<PaymentRailResult>) => {
    const rail = createRecordingPaymentRail(behaviour);
    const result = await createPaymentRailExecutionAdapter({ rail, binding: BINDING }).execute(validatedAction());
    assert.equal(rail.callCount, 1, 'invoked exactly once');
    assert.deepEqual(readExecutionAdapterResult(result), result, 'the result is one the execution runtime reads unchanged');
    return result;
  };

  it('P10: completed → completed, carrying the provider handle', async () => {
    assert.deepEqual(await run(() => ({ status: 'completed', externalReference: 'prov-123' })), { outcome: 'completed', providerRef: 'prov-123' });
  });

  it('P11: not-completed → failed, with the existing reason vocabulary and a bounded detail', async () => {
    assert.deepEqual(await run(() => ({ status: 'not-completed', reason: 'PROVIDER_REJECTED', detail: 'insufficient-funds', externalReference: 'prov-9' })), {
      outcome: 'failed',
      reason: 'PROVIDER_REJECTED',
      providerRef: 'prov-9',
      detail: 'insufficient-funds',
    });
  });

  it('P12: unconfirmed → unconfirmed', async () => {
    assert.deepEqual(await run(() => ({ status: 'unconfirmed', externalReference: 'job-7', detail: 'connection-reset' })), { outcome: 'unconfirmed', providerRef: 'job-7', detail: 'connection-reset' });
  });

  it('P12: a rail that throws, or answers with anything unreadable, is unconfirmed — never a failure that would release capacity or invite a retry', async () => {
    const unreadable = { outcome: 'unconfirmed', detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_RESULT_UNREADABLE };
    assert.deepEqual(
      await run(() => {
        throw new Error('socket hang up');
      }),
      unreadable,
    );
    assert.deepEqual(await run(() => Promise.reject(new Error('timeout'))), unreadable);
    for (const answer of [undefined, null, 'ok', { status: 'settled' }, { status: 'not-completed', reason: 'INSUFFICIENT_FUNDS' }, { outcome: 'completed' }]) {
      assert.deepEqual(await run(() => answer as unknown as PaymentRailResult), unreadable, JSON.stringify(answer));
    }
  });

  it('reads a rail-controlled result once, and a throwing getter is unconfirmed', async () => {
    let reads = 0;
    const tricky = {
      get status() {
        reads += 1;
        return reads === 1 ? 'not-completed' : 'completed';
      },
      reason: 'PROVIDER_REJECTED',
    };
    assert.equal(executionResultOfPaymentRail(tricky).outcome, 'failed');
    assert.equal(reads, 1);
    const throwing = {
      get status(): string {
        throw new Error('getter');
      },
    };
    assert.deepEqual(await run(() => throwing as unknown as PaymentRailResult), { outcome: 'unconfirmed', detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_RESULT_UNREADABLE });
  });

  it('drops a provider handle or detail that is not safe to record, and never changes the outcome for it', async () => {
    assert.deepEqual(await run(() => ({ status: 'completed', externalReference: 'Bearer abc.def.ghi' })), { outcome: 'completed' });
    assert.deepEqual(await run(() => ({ status: 'completed', externalReference: 'https://provider.example/p/1' })), { outcome: 'completed' });
    assert.deepEqual(await run(() => ({ status: 'not-completed', reason: 'PROVIDER_REJECTED', detail: 'the provider said: account 123 is closed' })), { outcome: 'failed', reason: 'PROVIDER_REJECTED' });
    assert.deepEqual(await run(() => ({ status: 'unconfirmed', externalReference: 7 as unknown as string })), { outcome: 'unconfirmed' });
  });
});

describe('PAY-01 rail composition', () => {
  it('records the rail as the adapter that performed the effect', () => {
    assert.equal(createPaymentRailExecutionAdapter({ rail: createRecordingPaymentRail(), binding: BINDING }).adapterId, REFERENCE_RAIL_ID);
  });

  it('refuses a rail with no execute function, a malformed id, or no binding', () => {
    assert.throws(() => createPaymentRailExecutionAdapter({ rail: { railId: 'r' } as never, binding: BINDING }), PaymentConfigurationError);
    for (const railId of ['', 'Rail One', 'a/b', 'r'.repeat(65)]) {
      assert.throws(() => createPaymentRailExecutionAdapter({ rail: createRecordingPaymentRail(undefined, railId), binding: BINDING }), PaymentConfigurationError, railId);
    }
    assert.throws(() => createPaymentRailExecutionAdapter({ rail: createRecordingPaymentRail(), binding: undefined as never }), PaymentConfigurationError);
  });

  it('snapshots the rail at composition: a later mutation cannot change which code runs', async () => {
    const rail = createRecordingPaymentRail();
    const adapter = createPaymentRailExecutionAdapter({ rail, binding: BINDING });
    (rail as { execute: unknown }).execute = async () => ({ status: 'completed', externalReference: 'swapped' });
    const result = await adapter.execute(validatedAction());
    assert.equal(rail.callCount, 1);
    assert.notEqual(result.outcome === 'completed' ? result.providerRef : undefined, 'swapped');
  });
});
