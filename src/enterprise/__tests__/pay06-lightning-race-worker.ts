import { parentPort, workerData } from 'node:worker_threads';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createLightningInvoiceBook, createLightningRail, lightningDestinationOf } from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, GOVERNED_ACCOUNT, TEST_NOW_MS, btc, createSimulatedLightningNode, testRailConfiguration } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createSqliteLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { boundaryFor } from './core07-freshness-fixture.js';

/**
 * One independent Host in a Lightning payment race (PAY-06 IL-5 / IL-6): its
 * own thread, its own `better-sqlite3` connection to the shared interlock
 * file, its own CORE-07 witness client and its own rail over its own node
 * connection. It composes everything, reports ready, blocks on a shared
 * barrier until every participant is ready, then executes. It reports how many
 * times **its** node was asked to send. Test scaffolding only.
 */
interface RaceInput {
  readonly path: string;
  readonly barrier: SharedArrayBuffer;
  readonly organizationId: string;
  readonly executionId: string;
  readonly invoiceLabel: string;
  readonly witness: { readonly endpoint: string; readonly witnessId: string; readonly publicKeyPem: string };
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  const configuration = testRailConfiguration();
  const interlock = await createSqliteLightningPaymentInterlock(input.path, {
    scope: { railId: configuration.railId, network: configuration.network },
    now: () => new Date().toISOString(),
    freshness: { boundary: await boundaryFor(input.witness, input.organizationId) },
    busyTimeoutMs: 30_000,
  });
  const node = await createSimulatedLightningNode();
  node.behaviour = 'hold';
  const invoice = await node.registerInvoice({ label: input.invoiceLabel, amountMsat: 2_500_000n });
  const book = createLightningInvoiceBook();
  book.register(invoice.paymentHash, invoice.invoice);
  const rail = createLightningRail({ configuration, node, invoices: book, interlock, now: () => TEST_NOW_MS });
  const request: PaymentExecutionRequest = {
    executionId: input.executionId,
    requestId: `req-${input.executionId}`,
    decisionId: `dec-${input.executionId}`,
    grantId: `grant-${input.executionId}`,
    notAfter: '2026-10-12T01:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: lightningDestinationOf(invoice.payee, invoice.paymentHash),
    amount: { value: btc(invoice.amountMsat), unit: BTC_ASSET },
    purpose: 'vendor-payment',
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
  parentPort?.postMessage({ kind: 'done', outcome, sends: node.calls.sendPayment });
}

void main();
