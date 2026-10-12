import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { createAuthorityStateFreshnessBoundary, createHttpAuthorityStateWitnessTransport, type AuthorityStateFreshnessBoundary } from '../authority-state-freshness/index.js';
import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createLightningInvoiceBook, createLightningRail, lightningDestinationOf, type LightningPaymentReservationInput } from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, GOVERNED_ACCOUNT, TEST_NOW_MS, btc, createSimulatedLightningNode, testPreimage, testNodeKey, testRailConfiguration, type SimulatedLightningNode } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { PAYMENT_INITIATION_STATE_KIND, createSqliteLightningPaymentInterlock, type DurableLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * PAY-06 — the durable Lightning payment interlock (IL-1 … IL-12): one
 * reservation per execution and per payment hash, written before the one
 * send, surviving restarts, shared across processes, and anchored at the
 * CORE-07 witness so a stale restore or rollback can never reopen send
 * eligibility.
 */

const made: string[] = [];
const dir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay06-interlock-'));
  made.push(directory);
  return directory;
};
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

const ORG = 'org-pay06';
const CONFIGURATION = testRailConfiguration();
const SCOPE = { railId: CONFIGURATION.railId, network: CONFIGURATION.network } as const;
const freshnessCode = (code: string) => (error: { code?: string }) => error.code === code;

function open(path: string, boundary: AuthorityStateFreshnessBoundary): Promise<DurableLightningPaymentInterlock> {
  return createSqliteLightningPaymentInterlock(path, { scope: SCOPE, now: () => new Date().toISOString(), freshness: { boundary } });
}

function restoreFile(from: string, to: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(`${to}${suffix}`, { force: true });
  copyFileSync(from, to);
}

async function reservation(label: string, executionId: string): Promise<LightningPaymentReservationInput> {
  return {
    executionId,
    paymentHash: testPreimage(label).paymentHash,
    payee: await testNodeKey('payee-node'),
    network: 'regtest',
    invoiceDigest: testPreimage(`digest-${label}`).paymentHash,
    amountMsat: 2_500_000n,
    feeLimitMsat: 25_000n,
    expiresAt: Math.floor(TEST_NOW_MS / 1000) + 3600,
  };
}

interface Composed {
  readonly node: SimulatedLightningNode;
  execute(executionId: string, label: string): Promise<{ readonly status: string; readonly detail?: string }>;
}

async function railOver(interlock: DurableLightningPaymentInterlock, node?: SimulatedLightningNode): Promise<Composed> {
  const simulated = node ?? (await createSimulatedLightningNode());
  const book = createLightningInvoiceBook();
  const rail = createLightningRail({ configuration: CONFIGURATION, node: simulated, invoices: book, interlock, now: () => TEST_NOW_MS });
  return {
    node: simulated,
    async execute(executionId, label) {
      const invoice = simulated.payment(testPreimage(label).paymentHash) !== undefined ? undefined : await simulated.registerInvoice({ label, amountMsat: 2_500_000n }).catch(() => undefined);
      const { paymentHash } = testPreimage(label);
      const payee = await testNodeKey('payee-node');
      if (invoice !== undefined) book.register(paymentHash, invoice.invoice);
      const request: PaymentExecutionRequest = {
        executionId,
        requestId: `req-${executionId}`,
        decisionId: `dec-${executionId}`,
        grantId: `grant-${executionId}`,
        notAfter: '2026-10-12T01:00:00.000Z',
        source: { accountId: GOVERNED_ACCOUNT },
        destination: lightningDestinationOf(payee, paymentHash),
        amount: { value: btc(2_500_000n), unit: BTC_ASSET },
        purpose: 'vendor-payment',
      };
      return (await rail.execute(request)) as { readonly status: string; readonly detail?: string };
    },
  };
}

describe('PAY-06 interlock — uniqueness (IL-1 … IL-4)', () => {
  it('IL-1 the first execution reserves its logical payment: durable, verified, exact on read-back', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    const input = await reservation('il-1', 'exec-il-1');
    assert.deepEqual(await interlock.reserve(input), { outcome: 'reserved' });
    const record = await interlock.read('exec-il-1');
    assert.ok(record !== undefined);
    for (const key of Object.keys(input) as (keyof LightningPaymentReservationInput)[]) assert.equal(record[key], input[key], key);
    assert.equal(typeof record.amountMsat, 'bigint');
    assert.deepEqual(await interlock.recorded('exec-il-1'), record);
    assert.equal(await interlock.recorded('exec-il-unknown'), undefined);
    assert.deepEqual(await interlock.verifyAll(), { reservations: 1 });
    await interlock.close();
  });

  it('IL-2 exact replay of the same execution → execution-recorded, the same record, nothing written', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    const input = await reservation('il-2', 'exec-il-2');
    await interlock.reserve(input);
    const again = await interlock.reserve(input);
    assert.equal(again.outcome, 'execution-recorded');
    assert.equal(again.outcome === 'execution-recorded' && again.record.paymentHash, input.paymentHash);
    assert.deepEqual(await interlock.verifyAll(), { reservations: 1 });
    await interlock.close();
  });

  it('IL-3 the same execution with a different invoice → execution-recorded with the ORIGINAL binding; no mutation, no latest-wins', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    await interlock.reserve(await reservation('il-3-first', 'exec-il-3'));
    const rebound = await interlock.reserve(await reservation('il-3-second', 'exec-il-3'));
    assert.equal(rebound.outcome === 'execution-recorded' && rebound.record.paymentHash, testPreimage('il-3-first').paymentHash);
    assert.equal((await interlock.read('exec-il-3'))?.paymentHash, testPreimage('il-3-first').paymentHash);
    assert.deepEqual(await interlock.verifyAll(), { reservations: 1 });
    await interlock.close();
  });

  it('IL-4 the same invoice for a different execution → payment-hash-reserved, nothing written — even for the same amount', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    await interlock.reserve(await reservation('il-4', 'exec-il-4-a'));
    assert.deepEqual(await interlock.reserve(await reservation('il-4', 'exec-il-4-b')), { outcome: 'payment-hash-reserved' });
    assert.equal(await interlock.read('exec-il-4-b'), undefined);
    await interlock.close();
  });

  it('the interlock refuses malformed input and tampered rows; triggers refuse UPDATE and DELETE', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const interlock = await open(path, await boundaryFor(witness, ORG));
    const good = await reservation('il-tamper', 'exec-il-tamper');
    for (const bad of [{ ...good, paymentHash: 'zz' }, { ...good, amountMsat: 0n }, { ...good, amountMsat: 25 as never }, { ...good, network: 'mainnet' as const }, { ...good, executionId: 'bad id' }]) {
      await assert.rejects(interlock.reserve(bad), /LIGHTNING_INTERLOCK_INVALID|refused a malformed/);
    }
    await interlock.reserve(good);
    await interlock.close();
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path);
    assert.throws(() => raw.prepare('DELETE FROM lightning_payment_reservations').run(), /append-only/);
    assert.throws(() => raw.prepare("UPDATE lightning_payment_reservations SET payment_hash = 'x'").run(), /append-only/);
    // A row rewritten consistently with its digests dropped from the triggers' protection: refused at open, never repaired.
    raw.exec('DROP TRIGGER lightning_reservations_append_only_update');
    raw.prepare(`UPDATE lightning_payment_reservations SET entry_json = replace(entry_json, '"amountMsat":"2500000"', '"amountMsat":"2500001"')`).run();
    raw.close();
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), /integrity check/);
  });
});

describe('PAY-06 interlock — concurrency across processes (IL-5, IL-6)', () => {
  async function race(witness: StartedWitness, participants: readonly { readonly executionId: string; readonly invoiceLabel: string }[]): Promise<{ readonly outcomes: string[]; readonly sends: number }> {
    const path = join(dir(), 'interlock.sqlite');
    // Genesis first, so every participant opens an anchored file.
    await (await open(path, await boundaryFor(witness, ORG))).close();
    const barrier = new SharedArrayBuffer(4);
    const pinned = { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem };
    const workers = participants.map((participant) => new Worker(join(__dirname, 'pay06-lightning-race-worker.js'), { workerData: { path, barrier, organizationId: ORG, witness: pinned, ...participant } }));
    let ready = 0;
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ readonly outcome: string; readonly sends: number }>((resolveDone, reject) => {
            worker.on('error', reject);
            worker.on('message', (message: { kind: string; outcome?: string; sends?: number }) => {
              if (message.kind === 'ready') {
                ready += 1;
                if (ready === workers.length) {
                  const gate = new Int32Array(barrier);
                  Atomics.store(gate, 0, 1);
                  Atomics.notify(gate, 0);
                }
              } else if (message.kind === 'done') resolveDone({ outcome: message.outcome ?? '', sends: message.sends ?? 0 });
            });
          }),
      ),
    );
    await Promise.all(workers.map((worker) => worker.terminate()));
    return { outcomes: results.map((result) => result.outcome), sends: results.reduce((sum, result) => sum + result.sends, 0) };
  }

  it('IL-5 four Hosts race ONE execution over one file and one witness — exactly one reaches the node', async () => {
    const witness = await startWitness();
    const { outcomes, sends } = await race(witness, [1, 2, 3, 4].map(() => ({ executionId: 'exec-il-5', invoiceLabel: 'il-5' })));
    assert.equal(sends, 1, outcomes.join(' | '));
    assert.equal(outcomes.filter((outcome) => outcome === 'unconfirmed:lightning-payment-in-flight').length, 1, outcomes.join(' | '));
    for (const outcome of outcomes) assert.ok(outcome === 'unconfirmed:lightning-payment-in-flight' || outcome === 'unconfirmed:lightning-execution-previously-initiated' || outcome === 'not-completed:lightning-interlock-unavailable', outcome);
  });

  it('IL-6 four Hosts race four executions for ONE payment hash — exactly one reaches the node; the rest fail closed', async () => {
    const witness = await startWitness();
    const { outcomes, sends } = await race(witness, [1, 2, 3, 4].map((index) => ({ executionId: `exec-il-6-${index}`, invoiceLabel: 'il-6' })));
    assert.equal(sends, 1, outcomes.join(' | '));
    assert.equal(outcomes.filter((outcome) => outcome.startsWith('not-completed:')).length, 3, outcomes.join(' | '));
  });
});

describe('PAY-06 interlock — restart, crash, rollback (IL-7 … IL-12)', () => {
  it('IL-7 / IL-8 / IL-12 restart after a reservation and after a send: the same execution is never sent again', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    let interlock = await open(path, await boundaryFor(witness, ORG));
    let host = await railOver(interlock);
    host.node.behaviour = 'disconnect-after-accept';
    assert.equal((await host.execute('exec-il-8', 'il-8')).status, 'unconfirmed');
    const node = host.node;
    await interlock.close();
    // Restart: a new process, the same node and the same file.
    interlock = await open(path, await boundaryFor(witness, ORG));
    host = await railOver(interlock, node);
    node.behaviour = 'succeed';
    assert.deepEqual(await host.execute('exec-il-8', 'il-8'), { status: 'unconfirmed', externalReference: testPreimage('il-8').paymentHash, detail: 'lightning-execution-previously-initiated' });
    assert.equal(node.calls.sendPayment, 1, 'one send across the restart');
    await interlock.close();
  });

  it('IL-9 a stale restore of the interlock (losing a reservation of a payment already initiated) is refused at open — nothing can be sent', async () => {
    const witness = await startWitness();
    const directory = dir();
    const path = join(directory, 'interlock.sqlite');
    const backup = join(directory, 'backup.sqlite');
    let interlock = await open(path, await boundaryFor(witness, ORG));
    await interlock.close();
    copyFileSync(path, backup);
    interlock = await open(path, await boundaryFor(witness, ORG));
    const host = await railOver(interlock);
    assert.equal((await host.execute('exec-il-9', 'il-9')).status, 'completed');
    await interlock.close();
    restoreFile(backup, path);
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    // A lost file (an empty one) is refused too: the witness holds the slot beyond genesis.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), (error: { code?: string }) => typeof error.code === 'string' && error.code.startsWith('AUTHORITY_FRESHNESS_'));
    assert.equal(host.node.calls.sendPayment, 1);
  });

  it('IL-10 the witness unavailable: refused at open; while running, a payment is refused before the send', async () => {
    let witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const { anchor, monitor } = await connect(witness, { transport: new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN })) });
    const interlock = await open(path, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }));
    const host = await railOver(interlock);
    await witness.close();
    assert.deepEqual(await host.execute('exec-il-10', 'il-10'), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: 'lightning-interlock-unavailable' });
    assert.equal(host.node.calls.sendPayment, 0, 'no witnessed reservation, no send');
    await interlock.close();
    await assert.rejects(boundaryFor(witness, ORG).then((boundary) => open(path, boundary)));
    witness = await witness.restart();
    await (await open(path, await boundaryFor(witness, ORG))).close();
  });

  it('IL-11 the witness rolled back alone (a fork): a running process refuses before the send, and a restart is refused as a fork', async () => {
    let witness = await startWitness();
    const directory = dir();
    const path = join(directory, 'interlock.sqlite');
    const witnessBefore = join(directory, 'witness-before.sqlite');
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    let target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    transport.answer = (request) => target.call(request, { timeoutMs: 2_000 });
    const { anchor, monitor } = await connect(witness, { transport });
    const interlock = await open(path, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }));
    const host = await railOver(interlock);
    await witness.close();
    copyFileSync(witness.databasePath, witnessBefore);
    witness = await witness.restart();
    target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    assert.equal((await host.execute('exec-il-11-a', 'il-11-a')).status, 'completed', 'control: one witnessed reservation');
    await witness.close();
    restoreFile(witnessBefore, witness.databasePath);
    witness = await witness.restart();
    target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    assert.deepEqual(await host.execute('exec-il-11-b', 'il-11-b'), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: 'lightning-interlock-unavailable' });
    assert.equal(host.node.calls.sendPayment, 1);
    await interlock.close();
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });

  it('a reservation prepared at the witness but never committed (crash between prepare and commit) refuses the restart — never silently dropped', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    await (await open(path, await boundaryFor(witness, ORG))).close();
    const { anchor } = await connect(witness);
    const witnessed = await anchor.read({ stateKind: PAYMENT_INITIATION_STATE_KIND, organizationId: ORG });
    assert.equal(witnessed.status, 'bound');
    if (witnessed.status !== 'bound') return;
    const expected = { stateKind: PAYMENT_INITIATION_STATE_KIND, organizationId: ORG, storeId: witnessed.storeId, ...witnessed.committed } as const;
    await anchor.prepare(expected, { ...expected, sequence: expected.sequence + 1, stateDigest: `sha256:${'cd'.repeat(32)}` });
    await assert.rejects(open(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
  });

  it('a reservation committed locally whose witness finalize was lost: the send proceeds once, the reservation is finalized at restart and still binds the execution', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor, monitor } = await connect(witness, { transport });
    const interlock = await open(path, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }));
    transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Error('simulated crash before finalize');
      return forward();
    };
    const host = await railOver(interlock);
    // CORE-07: a lost finalize after the durable local commit is recoverable — the reservation is durable and prepared at
    // the witness, so the one send proceeds (as PAY-03's F9).
    const first = await host.execute('exec-il-finalize', 'il-finalize');
    assert.equal(first.status, 'completed');
    assert.equal(host.node.calls.sendPayment, 1);
    await interlock.close();
    const restarted = await open(path, await boundaryFor(witness, ORG));
    assert.equal((await restarted.read('exec-il-finalize'))?.paymentHash, testPreimage('il-finalize').paymentHash, 'finalized at restart: the binding stands');
    const again = await railOver(restarted, host.node);
    assert.deepEqual(await again.execute('exec-il-finalize', 'il-finalize'), { status: 'unconfirmed', externalReference: testPreimage('il-finalize').paymentHash, detail: 'lightning-execution-previously-initiated' });
    assert.equal(host.node.calls.sendPayment, 1, 'never sent again');
    await restarted.close();
  });

  it('a file bound to another rail, network or organization is refused unmutated; the interlock is never opened without its witness', async () => {
    const witness = await startWitness();
    const path = join(dir(), 'interlock.sqlite');
    await (await open(path, await boundaryFor(witness, ORG))).close();
    await assert.rejects(createSqliteLightningPaymentInterlock(path, { scope: { railId: 'other-rail', network: 'regtest' }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }), /another rail or Lightning network/);
    await assert.rejects(createSqliteLightningPaymentInterlock(path, { scope: { railId: SCOPE.railId, network: 'testnet' }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }), /another rail or Lightning network/);
    await assert.rejects(createSqliteLightningPaymentInterlock(path, { scope: SCOPE, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, 'org-other') } }), /another organization/);
    await assert.rejects(createSqliteLightningPaymentInterlock(path, { scope: SCOPE, now: () => new Date().toISOString(), freshness: undefined as never }), /never opened without its freshness boundary/);
  });

  it('health is bounded: readiness facts only — no payment hash, invoice, payee or amount', async () => {
    const witness = await startWitness();
    const interlock = await open(join(dir(), 'interlock.sqlite'), await boundaryFor(witness, ORG));
    const input = await reservation('il-health', 'exec-il-health');
    await interlock.reserve(input);
    const health = await interlock.health();
    assert.deepEqual(Object.keys(health).sort(), ['freshness', 'readable', 'reservations', 'schemaVersion', 'status', 'writable']);
    assert.equal(health.status, 'healthy');
    for (const value of [input.paymentHash, input.payee, input.invoiceDigest, '2500000']) assert.equal(JSON.stringify(health).includes(value), false);
    await interlock.close();
    assert.equal((await interlock.health()).status, 'unhealthy');
  });
});
