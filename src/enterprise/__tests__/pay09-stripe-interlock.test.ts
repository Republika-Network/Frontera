import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { createAuthorityStateFreshnessBoundary, createHttpAuthorityStateWitnessTransport, type AuthorityStateFreshnessBoundary } from '../authority-state-freshness/index.js';
import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createStripeRail, stripeDestinationOf, stripeIdempotencyKey, type StripePaymentReservationInput } from '../../features/payment-runtime/rails/stripe/index.js';
import {
  CONNECTED_ACCOUNT,
  GOVERNED_ACCOUNT,
  OTHER_PLATFORM_ACCOUNT,
  PLATFORM_ACCOUNT,
  TEST_CUSTOMER,
  TEST_PAYMENT_METHOD,
  USD_ASSET,
  createSimulatedStripe,
  testRailConfiguration,
  type SimulatedStripe,
} from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { testRailConfiguration as lightningConfiguration } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createSqliteLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { PAYMENT_INITIATION_STATE_KIND, STRIPE_INTERLOCK_SCHEMA_VERSION, createSqliteStripePaymentInterlock, type DurableStripePaymentInterlock } from '../stripe-payment-rail/sqlite-stripe-payment-interlock.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows } from './core07-freshness-fixture.js';

/**
 * PAY-09 — the durable Stripe payment interlock (SIL-1 … SIL-12): one
 * reservation and one PaymentIntent binding per execution, one execution per
 * PaymentIntent, both written before the one confirmation, surviving restarts,
 * shared across processes, and anchored at the CORE-07 witness so a stale
 * restore or rollback can never reopen confirmation eligibility.
 */

const made: string[] = [];
const dir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay09-interlock-'));
  made.push(directory);
  return directory;
};
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

const ORG = 'org-pay09';
const CONFIGURATION = testRailConfiguration();
const SCOPE = { railId: CONFIGURATION.railId, mode: CONFIGURATION.mode, platformAccountId: CONFIGURATION.platformAccountId } as const;
const freshnessCode = (code: string) => (error: { code?: string }) => error.code === code;

function open(path: string, boundary: AuthorityStateFreshnessBoundary): Promise<DurableStripePaymentInterlock> {
  return createSqliteStripePaymentInterlock(path, { scope: SCOPE, now: () => new Date().toISOString(), freshness: { boundary } });
}

function restoreFile(from: string, to: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(`${to}${suffix}`, { force: true });
  copyFileSync(from, to);
}

function reservation(executionId: string, overrides: Partial<StripePaymentReservationInput> = {}): StripePaymentReservationInput {
  return {
    executionId,
    railId: SCOPE.railId,
    mode: 'test',
    platformAccountId: PLATFORM_ACCOUNT,
    sourceAccountId: GOVERNED_ACCOUNT,
    customerId: TEST_CUSTOMER,
    paymentMethodId: TEST_PAYMENT_METHOD,
    destinationAccountId: CONNECTED_ACCOUNT,
    amountValue: '75',
    amountUnit: USD_ASSET,
    amountCents: 7500n,
    currency: 'usd',
    createIdempotencyKey: stripeIdempotencyKey(SCOPE.railId, executionId, 'create'),
    confirmIdempotencyKey: stripeIdempotencyKey(SCOPE.railId, executionId, 'confirm'),
    ...overrides,
  };
}

function request(executionId: string): PaymentExecutionRequest {
  return {
    executionId,
    requestId: `req-${executionId}`,
    decisionId: `dec-${executionId}`,
    grantId: `grant-${executionId}`,
    notAfter: '2026-10-13T13:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: stripeDestinationOf(CONNECTED_ACCOUNT),
    amount: { value: '75', unit: USD_ASSET },
    purpose: 'purchase',
  };
}

const railOver = (interlock: DurableStripePaymentInterlock, stripe: SimulatedStripe = createSimulatedStripe()) => ({ stripe, rail: createStripeRail({ configuration: CONFIGURATION, stripe, interlock }) });

describe('PAY-09 interlock — uniqueness (SIL-1 … SIL-4)', () => {
  it('SIL-1 a reservation, then its binding: durable, verified, exact on read-back', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    assert.deepEqual(await interlock.reserve(reservation('exec-sil-1')), { outcome: 'reserved' });
    const reserved = await interlock.read('exec-sil-1');
    assert.equal(reserved?.amountCents, 7500n);
    assert.equal(reserved?.paymentIntentId, undefined, 'reserved, not yet bound');
    assert.deepEqual(await interlock.bind('exec-sil-1', 'pi_sil1'), { outcome: 'bound' });
    const bound = await interlock.read('exec-sil-1');
    assert.equal(bound?.paymentIntentId, 'pi_sil1');
    assert.equal(bound?.platformAccountId, PLATFORM_ACCOUNT);
    assert.equal(await interlock.executionOfPaymentIntent('pi_sil1'), 'exec-sil-1');
    assert.deepEqual(await interlock.verifyAll(), { entries: 2 });
    await interlock.close();
  });

  it('SIL-2 one reservation per execution: a replay or a changed payment → execution-recorded with the ORIGINAL terms; nothing written', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    await interlock.reserve(reservation('exec-sil-2'));
    const again = await interlock.reserve(reservation('exec-sil-2', { amountValue: '80', amountCents: 8000n }));
    assert.equal(again.outcome, 'execution-recorded');
    assert.equal(again.outcome === 'execution-recorded' ? again.record.amountCents : undefined, 7500n, 'no mutation, no latest-wins');
    assert.deepEqual(await interlock.verifyAll(), { entries: 1 });
    await interlock.close();
  });

  it('SIL-3 one PaymentIntent per execution and one execution per PaymentIntent; no binding without a reservation', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    await interlock.reserve(reservation('exec-sil-3a'));
    await interlock.reserve(reservation('exec-sil-3b'));
    assert.deepEqual(await interlock.bind('exec-sil-3a', 'pi_sil3'), { outcome: 'bound' });
    assert.deepEqual(await interlock.bind('exec-sil-3a', 'pi_sil3other'), { outcome: 'execution-bound', paymentIntentId: 'pi_sil3' }, 'never re-bound');
    assert.deepEqual(await interlock.bind('exec-sil-3b', 'pi_sil3'), { outcome: 'payment-intent-bound-elsewhere' });
    assert.deepEqual(await interlock.bind('exec-sil-3-none', 'pi_sil3none'), { outcome: 'not-reserved' });
    assert.deepEqual(await interlock.verifyAll(), { entries: 3 });
    await interlock.close();
  });

  it('SIL-4 refuses malformed or out-of-scope input; triggers refuse UPDATE and DELETE; a rewritten row is refused at open', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const interlock = await open(path, await boundaryFor(witness, ORG));
    for (const overrides of [
      { amountValue: '75.01' },
      { amountCents: 7500.5 as unknown as bigint },
      { currency: 'eur' as never },
      { mode: 'live' as never },
      { platformAccountId: OTHER_PLATFORM_ACCOUNT },
      { railId: 'another-rail' },
      { destinationAccountId: PLATFORM_ACCOUNT },
      { customerId: 'pm_card_visa' },
      { confirmIdempotencyKey: stripeIdempotencyKey(SCOPE.railId, 'exec-sil-4', 'create') },
      { createIdempotencyKey: 'random-key' },
    ] as const) {
      await assert.rejects(interlock.reserve(reservation('exec-sil-4', overrides as Partial<StripePaymentReservationInput>)), /STRIPE_INTERLOCK_INVALID|refused a malformed/, JSON.stringify(overrides));
    }
    await assert.rejects(interlock.bind('exec-sil-4', 'pi_x_secret_y'), /malformed/);
    await interlock.reserve(reservation('exec-sil-4'));
    await interlock.bind('exec-sil-4', 'pi_sil4');
    await interlock.close();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    assert.throws(() => db.prepare(`UPDATE stripe_payment_entries SET payment_intent_id = 'pi_other' WHERE kind = 'binding'`).run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM stripe_payment_entries').run(), /append-only/);
    // Rewrite the amount with the trigger dropped and every digest string kept: integrity refuses it at open.
    db.exec('DROP TRIGGER stripe_entries_append_only_update');
    const row = db.prepare(`SELECT sequence, entry_json FROM stripe_payment_entries WHERE kind = 'reservation'`).get() as { sequence: number; entry_json: string };
    const content = JSON.parse(row.entry_json) as Record<string, unknown>;
    db.prepare('UPDATE stripe_payment_entries SET entry_json = ? WHERE sequence = ?').run(canonicalSerialize({ ...content, amountValue: '7.5', amountCents: '750' }), row.sequence);
    db.close();
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), /integrity check/);
  });
});

describe('PAY-09 interlock — secret hygiene of the durable record', () => {
  it('the file holds opaque ids and exact amounts only: no key, no client secret, no card data, no personal data', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const interlock = await open(path, await boundaryFor(witness, ORG));
    const { rail } = railOver(interlock);
    assert.equal((await rail.execute(request('exec-hygiene'))).status, 'completed');
    await interlock.close();
    const bytes = ['', '-wal'].map((suffix) => {
      try {
        return readFileSync(`${path}${suffix}`).toString('latin1');
      } catch {
        return '';
      }
    }).join('');
    assert.ok(bytes.includes('exec-hygiene'), 'the scan reads the real file');
    for (const forbidden of ['sk_test_', 'rk_test_', 'whsec_', 'client_secret', '_secret_', 'card_number', 'cvc']) assert.equal(bytes.includes(forbidden), false, forbidden);
    // Bounded by non-hex characters: a SHA-256 digest is lowercase hex, and one holds a 13-digit decimal run
    // by chance about once in twenty-four; a PAN is stored, if ever, between quotes or punctuation.
    assert.equal(/(?<![0-9a-f])[0-9]{13,19}(?![0-9a-f])/.test(bytes), false, 'no card-number-shaped digit run');
    assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/.test(bytes), false, 'no email address');
  });
});

describe('PAY-09 interlock — concurrency across processes (SIL-5)', () => {
  it('SIL-5 four Hosts race ONE execution over one file and one witness — exactly one creation and one confirmation in total', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    await (await open(path, await boundaryFor(witness, ORG))).close();
    const barrier = new SharedArrayBuffer(4);
    const pinned = { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem };
    const workers = [1, 2, 3, 4].map(() => new Worker(join(__dirname, 'pay09-stripe-race-worker.js'), { workerData: { path, barrier, organizationId: ORG, witness: pinned, executionId: 'exec-sil-5' } }));
    let ready = 0;
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ readonly outcome: string; readonly creates: number; readonly confirms: number }>((resolveDone, reject) => {
            worker.on('error', reject);
            worker.on('message', (message: { kind: string; outcome?: string; creates?: number; confirms?: number }) => {
              if (message.kind === 'ready') {
                ready += 1;
                if (ready === workers.length) {
                  const gate = new Int32Array(barrier);
                  Atomics.store(gate, 0, 1);
                  Atomics.notify(gate, 0);
                }
              } else if (message.kind === 'done') resolveDone({ outcome: message.outcome ?? '', creates: message.creates ?? 0, confirms: message.confirms ?? 0 });
            });
          }),
      ),
    );
    await Promise.all(workers.map((worker) => worker.terminate()));
    const outcomes = results.map((result) => result.outcome);
    assert.equal(results.reduce((sum, result) => sum + result.creates, 0), 1, outcomes.join(' | '));
    assert.equal(results.reduce((sum, result) => sum + result.confirms, 0), 1, outcomes.join(' | '));
    assert.equal(outcomes.filter((outcome) => outcome === 'completed:').length, 1, outcomes.join(' | '));
    for (const outcome of outcomes) assert.ok(outcome === 'completed:' || outcome === 'unconfirmed:stripe-execution-previously-initiated' || outcome === 'not-completed:stripe-interlock-unavailable', outcome);
  });
});

describe('PAY-09 interlock — restart, crash, rollback (SIL-6 … SIL-12)', () => {
  it('SIL-6 restart after the confirmation was sent and its answer lost: the same execution is never confirmed again', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    let interlock = await open(path, await boundaryFor(witness, ORG));
    let host = railOver(interlock);
    host.stripe.confirmBehaviour = 'succeed-response-lost';
    assert.equal((await host.rail.execute(request('exec-sil-6'))).status, 'unconfirmed');
    const stripe = host.stripe;
    await interlock.close();
    interlock = await open(path, await boundaryFor(witness, ORG));
    host = railOver(interlock, stripe);
    stripe.confirmBehaviour = 'succeed';
    const again = await host.rail.execute(request('exec-sil-6'));
    assert.deepEqual(again, { status: 'unconfirmed', externalReference: stripe.intents()[0]!.id, detail: 'stripe-execution-previously-initiated' });
    assert.deepEqual({ creates: stripe.calls.create, confirms: stripe.calls.confirmReceived, charges: stripe.charges() }, { creates: 1, confirms: 1, charges: 1 }, 'one of each across the restart');
    await interlock.close();
  });

  it('SIL-7 crash after the reservation, before the creation: a restart never creates or confirms for that execution', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    let interlock = await open(path, await boundaryFor(witness, ORG));
    // The process reserved, then died before the PaymentIntent was created.
    await interlock.reserve(reservation('exec-sil-7'));
    await interlock.close();
    interlock = await open(path, await boundaryFor(witness, ORG));
    const host = railOver(interlock);
    const result = await host.rail.execute(request('exec-sil-7'));
    assert.deepEqual(result, { status: 'unconfirmed', detail: 'stripe-execution-previously-initiated' });
    assert.equal(host.stripe.calls.create + host.stripe.calls.confirmAttempted, 0);
    await interlock.close();
  });

  it('SIL-8 a stale restore of the interlock (losing the binding of a payment already confirmed) is refused at open — nothing can be confirmed', async () => {
    const witness = await startWitness();
    const directory = dir();
    const path = join(directory, 'interlock.sqlite');
    const backup = join(directory, 'backup.sqlite');
    let interlock = await open(path, await boundaryFor(witness, ORG));
    await interlock.close();
    copyFileSync(path, backup);
    interlock = await open(path, await boundaryFor(witness, ORG));
    const host = railOver(interlock);
    assert.equal((await host.rail.execute(request('exec-sil-8'))).status, 'completed');
    await interlock.close();
    restoreFile(backup, path);
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), (error: { code?: string }) => typeof error.code === 'string' && error.code.startsWith('AUTHORITY_FRESHNESS_'), 'a lost file never silently starts over');
    assert.equal(host.stripe.charges(), 1);
  });

  it('SIL-9 the witness unavailable while running: a payment is refused before anything exists at Stripe', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const { anchor, monitor } = await connect(witness, { transport: new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN })) });
    const interlock = await open(path, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }));
    const host = railOver(interlock);
    await witness.close();
    assert.deepEqual(await host.rail.execute(request('exec-sil-9')), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: 'stripe-interlock-unavailable' });
    assert.equal(host.stripe.calls.create + host.stripe.calls.confirmAttempted, 0, 'no witnessed reservation, nothing created');
    await interlock.close();
  });

  it('SIL-10 the witness fails between the reservation and the binding: the PaymentIntent is created (it cannot charge) and is never confirmed', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor, monitor } = await connect(witness, { transport });
    const interlock = await open(path, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }));
    const host = railOver(interlock);
    let prepares = 0;
    transport.answer = (call, forward) => {
      if (call.operation === 'prepare' && (prepares += 1) === 2) throw new Error('witness lost before the binding');
      return forward();
    };
    const result = await host.rail.execute(request('exec-sil-10'));
    assert.equal(result.status, 'not-completed');
    assert.equal((result as { detail?: string }).detail, 'stripe-binding-unavailable');
    assert.equal(host.stripe.calls.create, 1);
    assert.equal(host.stripe.calls.confirmAttempted, 0, 'an unbound PaymentIntent is never confirmed');
    assert.equal(host.stripe.intents()[0]?.status, 'requires_confirmation');
    await interlock.close();
  });

  it('SIL-11 a file bound to another rail, platform account or organization is refused unmutated; never opened without its witness', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    await (await open(path, await boundaryFor(witness, ORG))).close();
    const now = (): string => new Date().toISOString();
    await assert.rejects(createSqliteStripePaymentInterlock(path, { scope: { ...SCOPE, railId: 'other-rail' }, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), /another rail, mode or platform account/);
    await assert.rejects(createSqliteStripePaymentInterlock(path, { scope: { ...SCOPE, platformAccountId: OTHER_PLATFORM_ACCOUNT }, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), /another rail, mode or platform account/);
    await assert.rejects(createSqliteStripePaymentInterlock(path, { scope: { ...SCOPE, mode: 'live' as never }, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), /scope/);
    await assert.rejects(createSqliteStripePaymentInterlock(path, { scope: SCOPE, now, freshness: { boundary: await boundaryFor(witness, 'org-other') } }), /another organization/);
    await assert.rejects(createSqliteStripePaymentInterlock(path, { scope: SCOPE, now, freshness: undefined as never }), /never opened without its freshness boundary/);
  });

  it('SIL-12 the CORE-07 slot is the rail-neutral payment-initiation-reservations, namespaced by the configured rail id: Stripe beside a Lightning interlock of the SAME organization opens in its own slot; a second Stripe store under the same rail id is still refused', async () => {
    assert.equal(PAYMENT_INITIATION_STATE_KIND, 'payment-initiation-reservations');
    const witness = await startWitness();
    const lightning = lightningConfiguration();
    const ln = await createSqliteLightningPaymentInterlock(join(dir(), 'lightning.sqlite'), { scope: { railId: lightning.railId, network: lightning.network }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const stripe = await open(join(dir(), 'stripe.sqlite'), await boundaryFor(witness, ORG));
    assert.equal((await stripe.health()).status, 'healthy', 'the second rail of one organization is not refused (the pre-hardening SIL-12 residual is closed)');
    assert.equal((await ln.health()).status, 'healthy');
    const slots = (await witnessRows(witness.databasePath)).map((row) => `${String(row['state_kind'])}|${String(row['organization_id'])}|${String(row['namespace'])}`);
    assert.deepEqual(slots, [`payment-initiation-reservations|${ORG}|${lightning.railId}`, `payment-initiation-reservations|${ORG}|${SCOPE.railId}`]);
    // The slot now holds history (an empty file at genesis would adopt the deterministic genesis — CORE-07's crash recovery).
    assert.deepEqual(await stripe.reserve(reservation('exec-sil-12')), { outcome: 'reserved' });
    await stripe.close();
    await ln.close();
    // One slot per rail: another Stripe store under the SAME rail id is a substitution, never a second store.
    await assert.rejects(open(join(dir(), 'stripe-second.sqlite'), await boundaryFor(witness, ORG)), (error: { code?: string }) => typeof error.code === 'string' && error.code.startsWith('AUTHORITY_FRESHNESS_'), 'never a second store under one slot');
    // Another organization's slot is its own.
    await (await open(join(dir(), 'stripe-other-org.sqlite'), await boundaryFor(witness, 'org-pay09-other'))).close();
  });

  it('health is bounded: readiness facts only — no PaymentIntent, account, Customer or amount', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    await interlock.reserve(reservation('exec-health'));
    const health = await interlock.health();
    assert.deepEqual(Object.keys(health).sort(), ['entries', 'freshness', 'readable', 'schemaVersion', 'status', 'writable']);
    assert.equal(health.status, 'healthy');
    assert.equal(health.schemaVersion, STRIPE_INTERLOCK_SCHEMA_VERSION);
    for (const value of [PLATFORM_ACCOUNT, CONNECTED_ACCOUNT, TEST_CUSTOMER, TEST_PAYMENT_METHOD, '7500']) assert.equal(JSON.stringify(health).includes(value), false);
    await interlock.close();
    assert.equal((await interlock.health()).status, 'unhealthy');
  });
});
