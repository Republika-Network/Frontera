import { parentPort, workerData } from 'node:worker_threads';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createStripeRail, stripeDestinationOf } from '../../features/payment-runtime/rails/stripe/index.js';
import { CONNECTED_ACCOUNT, GOVERNED_ACCOUNT, USD_ASSET, createSimulatedStripe, testRailConfiguration } from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { createSqliteStripePaymentInterlock } from '../stripe-payment-rail/sqlite-stripe-payment-interlock.js';
import { boundaryFor } from './core07-freshness-fixture.js';

/**
 * One independent Host in a Stripe payment race (PAY-09 SIL-5): its own
 * thread, its own `better-sqlite3` connection to the shared interlock file,
 * its own CORE-07 witness client and its own rail over its own Stripe
 * connection. It composes everything, reports ready, blocks on a shared
 * barrier until every participant is ready, then executes. It reports how
 * many PaymentIntents it created and how many confirmations reached **its**
 * Stripe. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly organizationId: string;
  readonly executionId: string;
  readonly witness: { readonly endpoint: string; readonly witnessId: string; readonly publicKeyPem: string };
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  const configuration = testRailConfiguration();
  const interlock = await createSqliteStripePaymentInterlock(input.path, {
    scope: { railId: configuration.railId, mode: configuration.mode, platformAccountId: configuration.platformAccountId },
    now: () => new Date().toISOString(),
    freshness: { boundary: await boundaryFor(input.witness, input.organizationId) },
    busyTimeoutMs: 30_000,
  });
  const stripe = createSimulatedStripe();
  const rail = createStripeRail({ configuration, stripe, interlock });
  const request: PaymentExecutionRequest = {
    executionId: input.executionId,
    requestId: `req-${input.executionId}`,
    decisionId: `dec-${input.executionId}`,
    grantId: `grant-${input.executionId}`,
    notAfter: '2026-10-13T13:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: stripeDestinationOf(CONNECTED_ACCOUNT),
    amount: { value: '75', unit: USD_ASSET },
    purpose: 'purchase',
  };
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  let outcome: string;
  try {
    const result = await rail.execute(request);
    outcome = `${result.status}:${(result as { detail?: string }).detail ?? ''}`;
  } catch (error) {
    outcome = `error:${error instanceof Error ? error.message : String(error)}`;
  }
  await interlock.close();
  parentPort?.postMessage({ kind: 'done', outcome, creates: stripe.calls.create, confirms: stripe.calls.confirmReceived });
}

void main();
