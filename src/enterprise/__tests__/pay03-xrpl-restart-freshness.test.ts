import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createAuthorityStateFreshnessBoundary, createHttpAuthorityStateWitnessTransport, type AuthorityStateFreshnessBoundary } from '../authority-state-freshness/index.js';
import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { XRPL_RAIL_DETAILS as D, createXrplRlusdRail, type XrplRlusdRail, type XrplSubmissionInterlock } from '../../features/payment-runtime/rails/xrpl/index.js';
import { GOVERNED_ACCOUNT, OTHER_SOURCE, RLUSD_ASSET, TREASURY, VENDOR, createTestSoftwareXrplSigner, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createSqliteXrplSubmissionInterlock, XRPL_RESERVATIONS_STATE_KIND, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { SIMULATED_RESTART_QUARANTINE, createLedgerSimulator, scratch, type LedgerSimulator } from './pay03-xrpl-fixture.js';

/**
 * PAY-03 — restart freshness of the XRPL submission interlock, anchored at the
 * CORE-07 external witness (review fix: the combined slow-clock + lagging-server
 * failure).
 *
 * The restart quarantine (`xrpl-rlusd-rail.ts`) proves an earlier transaction's
 * window closed from two witnesses — this host's clock, and the first validated
 * index the configured server reported. Their errors can cancel: a clock an hour
 * slow **and** a server 1,000 ledgers behind at boot let both checks pass while a
 * transaction a previous process signed is still live. If a stale restore also
 * lost that transaction's interlock record, nothing local remembers it.
 *
 * The fix is an independent, monotonic reference outside the interlock's restore
 * domain: every reservation is a CORE-07 transition at the external witness, so a
 * restored older reservation history is refused at open — before anything is
 * signed — whatever the clock or the server says. These tests use the reference
 * witness over real loopback HTTP, with its own database in its own directory.
 */

const tmp = scratch('frontera-pay03-freshness-');
after(async () => {
  await closeAllWitnesses();
  tmp.cleanup();
});

const ORG = 'org-pay03-freshness';
const SOURCES = [
  { accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress },
  { accountId: 'reserve-ops', address: OTHER_SOURCE.classicAddress },
];
const withOffset = (lastLedgerOffset: number) => testConfiguration({ sourceAccounts: SOURCES.map((mapping) => ({ ...mapping })), lastLedgerOffset, finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
const CONFIGURATION = withOffset(4);
const SCOPE = { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId };
const HOUR_MS = 3_600_000;
const LAG = 1_000;

let counter = 0;
function request(): PaymentExecutionRequest {
  counter += 1;
  return {
    executionId: `aoc.exec:pay03-fresh-${counter}`,
    requestId: `req-${counter}`,
    decisionId: `dec-${counter}`,
    grantId: `grant-${counter}`,
    notAfter: '2030-01-01T00:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: { kind: 'xrpl-account', reference: VENDOR.classicAddress },
    amount: { value: '25.5', unit: RLUSD_ASSET },
    purpose: 'vendor-payment',
    rail: 'xrpl-rlusd',
  };
}

const detailOf = (outcome: unknown): string | undefined => (outcome as { detail?: string }).detail;
const hashOf = (outcome: unknown): string => (outcome as { externalReference: string }).externalReference;
const freshnessCode = (code: string) => (error: { code?: string }) => error.code === code;

function anchored(path: string, boundary: AuthorityStateFreshnessBoundary): Promise<DurableXrplSubmissionInterlock> {
  return createSqliteXrplSubmissionInterlock(path, { scope: SCOPE, now: () => new Date().toISOString(), freshness: { boundary } });
}

/** A client whose clock — the one the restart quarantine compares close times against — runs `slowByMs` behind the network. */
function clientWithClock(ledger: LedgerSimulator, slowByMs: number): LedgerSimulator {
  return slowByMs === 0 ? ledger : Object.assign(Object.create(ledger) as LedgerSimulator, { now: () => ledger.now() - slowByMs });
}

interface Restarted {
  readonly rail: XrplRlusdRail;
  readonly signers: ReturnType<typeof createTestSoftwareXrplSigner>[];
}

function railOver(ledger: LedgerSimulator, interlock: XrplSubmissionInterlock, options: { readonly offset?: number; readonly slowByMs?: number } = {}): Restarted {
  const signers = [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)];
  const rail = createXrplRlusdRail({ configuration: withOffset(options.offset ?? 4), client: clientWithClock(ledger, options.slowByMs ?? 0), signers, interlock, ...testClock() });
  return { rail, signers };
}

/**
 * A prior process, on a correct clock and a current server, signs a payment
 * under `lastLedgerOffset` 200 whose outcome stays unknown — its window runs
 * 200 ledgers past the prepared index. Returns that transaction.
 */
async function priorUnresolved(ledger: LedgerSimulator, path: string, boundary: AuthorityStateFreshnessBoundary) {
  const store = await anchored(path, boundary);
  const { rail } = railOver(ledger, store, { offset: 200 });
  await rail.readiness();
  ledger.index += SIMULATED_RESTART_QUARANTINE;
  ledger.nextOutcome = 'pending';
  const lost = await rail.execute(request());
  assert.equal(lost.status, 'unconfirmed');
  const lostTx = ledger.transactions.get(hashOf(lost))!;
  assert.equal(lostTx.lastLedgerSequence, ledger.index + 200, 'signed with the historical maximum window');
  await store.close();
  ledger.nextOutcome = 'success';
  return lostTx;
}

function restoreFile(from: string, to: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(`${to}${suffix}`, { force: true });
  copyFileSync(from, to);
}

/** A boundary for `witness` whose transport the test can script. */
async function scriptedBoundary(witness: StartedWitness): Promise<{ readonly boundary: AuthorityStateFreshnessBoundary; readonly transport: ScriptedWitnessTransport }> {
  const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
  const { anchor, monitor } = await connect(witness, { transport });
  return { boundary: createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }), transport };
}

describe('PAY-03 restart freshness: the combined slow-clock + lagging-server failure is closed by the CORE-07 witness (review fix)', () => {
  it('F5 (the exact remaining fail-open): a near-maximum window, a stale restore that lost its row, a Host clock an hour slow and a server 1,000 ledgers behind at boot — both quarantine checks pass, yet nothing is signed or submitted', async () => {
    const ledger = createLedgerSimulator({ index: 30_000 });
    const witness = await startWitness();
    const dir = tmp.dir();
    const path = join(dir, 'interlock.sqlite');
    const stale = join(dir, 'stale-backup.sqlite');
    // The backup is taken before the payment: anchored, empty.
    await (await anchored(path, await boundaryFor(witness, ORG))).close();
    copyFileSync(path, stale);

    // 1. A prior process signs an unresolved transaction near the historical maximum window.
    const lostTx = await priorUnresolved(ledger, path, await boundaryFor(witness, ORG));
    const network = ledger.index;
    const submitsBefore = ledger.calls.submit;

    // 2. A stale restore loses its interlock row.
    restoreFile(stale, path);

    // 3 + 4. The Host restarts with its clock an hour behind, against a server 1,000 ledgers behind the network.
    ledger.index = network - LAG;

    // 5. Premise — the d8e58ff quarantine alone would release here: a rail over an interlock that remembers nothing
    //    (what the stale file holds) passes both checks and reaches the sequence check, which is all that stands
    //    between it and signing. The stub reports "blocked" so this premise signs and submits nothing.
    let asked = 0;
    const forgetful: XrplSubmissionInterlock = { recorded: async () => undefined, blocking: async () => (asked += 1) > 0, reserve: async () => ({ outcome: 'blocked' }), markUnconfirmed: async () => {}, settle: async () => {} };
    const premise = railOver(ledger, forgetful, { slowByMs: HOUR_MS });
    await premise.rail.readiness();
    ledger.index = network + 50;
    assert.ok(ledger.index < lostTx.lastLedgerSequence, 'the lost transaction can still be included');
    assert.equal(detailOf(await premise.rail.execute(request())), D.SEQUENCE_IN_FLIGHT, 'the restart quarantine let it through: only the (forgotten) record could have stopped it');
    assert.equal(asked, 1, 'both d8e58ff checks passed');

    // 6. The real Host composition: the restored, older reservation history is refused at open — nothing to sign with.
    ledger.index = network - LAG;
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    ledger.index = network + 50;
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'), 'and it stays refused however the clock or the server moves');
    assert.equal(premise.signers[0]!.signCount, 0, 'signer never called');
    assert.equal(ledger.calls.submit, submitsBefore, 'XRPL submit never called');
  });

  it('F8 / F10: refused until the newest reservation history is back; then a payment proceeds only once the prior window is definitively closed, with the same sequence', async () => {
    const ledger = createLedgerSimulator({ index: 40_000 });
    const witness = await startWitness();
    const dir = tmp.dir();
    const path = join(dir, 'interlock.sqlite');
    const stale = join(dir, 'stale-backup.sqlite');
    const newest = join(dir, 'newest-copy.sqlite');
    await (await anchored(path, await boundaryFor(witness, ORG))).close();
    copyFileSync(path, stale);
    const lostTx = await priorUnresolved(ledger, path, await boundaryFor(witness, ORG));
    copyFileSync(path, newest);
    const network = ledger.index;

    // backup / restore cannot rewind the witness: it is not in the interlock's file or backup set, so the stale copy stays refused.
    restoreFile(stale, path);
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));

    // The operator restores the newest copy: fresh, and it still holds the unresolved record.
    restoreFile(newest, path);
    const store = await anchored(path, await boundaryFor(witness, ORG));
    ledger.index = network - LAG;
    const { rail, signers } = railOver(ledger, store, { slowByMs: HOUR_MS });
    await rail.readiness();
    for (const index of [network + 50, lostTx.lastLedgerSequence - 1]) {
      ledger.index = index;
      assert.equal(detailOf(await rail.execute(request())), D.SEQUENCE_IN_FLIGHT, `refused before signing at ${index}`);
    }
    assert.equal(signers[0]!.signCount, 0);
    // The ledger has validated the lost transaction's LastLedgerSequence: it can never be included. Now, and only now.
    ledger.index = lostTx.lastLedgerSequence;
    lostTx.outcome = 'dropped';
    const next = await rail.execute(request());
    assert.equal(next.status, 'completed');
    assert.equal(ledger.transactions.get(hashOf(next))!.sequence, lostTx.sequence, 'the sequence is reused only once it is provably free');
    await store.close();
  });

  describe('F1–F4: every clock / server combination, with the reservation history proven fresh', () => {
    const cases = [
      { name: 'F1 correct clock + current server', slowByMs: 0, lag: 0 },
      { name: 'F2 slow clock + current server', slowByMs: HOUR_MS, lag: 0 },
      { name: 'F3 correct clock + lagging server', slowByMs: 0, lag: LAG },
      { name: 'F4 slow clock + lagging server', slowByMs: HOUR_MS, lag: LAG },
    ];
    for (const { name, slowByMs, lag } of cases) {
      it(`${name}: refused before signing while the prior transaction's window is open; proceeds once it is validated closed`, async () => {
        const ledger = createLedgerSimulator({ index: 50_000 });
        const witness = await startWitness();
        const path = join(tmp.dir(), 'interlock.sqlite');
        const lostTx = await priorUnresolved(ledger, path, await boundaryFor(witness, ORG));
        const network = ledger.index;
        const store = await anchored(path, await boundaryFor(witness, ORG));
        ledger.index = network - lag;
        const { rail, signers } = railOver(ledger, store, { slowByMs });
        await rail.readiness();
        for (let index = network - lag + 7; index < lostTx.lastLedgerSequence; index += 37) {
          ledger.index = index;
          const refused = await rail.execute(request());
          assert.equal(refused.status, 'not-completed');
          assert.ok(detailOf(refused) === D.RESTART_QUARANTINE || detailOf(refused) === D.SEQUENCE_IN_FLIGHT, `refused at ${index}: ${String(detailOf(refused))}`);
        }
        assert.equal(signers[0]!.signCount, 0, 'nothing signed while the window was open');
        ledger.index = Math.max(lostTx.lastLedgerSequence, network + SIMULATED_RESTART_QUARANTINE);
        lostTx.outcome = 'dropped';
        assert.equal((await rail.execute(request())).status, 'completed', 'eventually released');
        await store.close();
      });
    }
  });

  it('F6: the witness unavailable — at open the store is refused; while running, a payment is refused before signing', async () => {
    const ledger = createLedgerSimulator();
    const witness = await startWitness();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const boundary = await boundaryFor(witness, ORG);
    const store = await anchored(path, boundary);
    const { rail, signers } = railOver(ledger, store);
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    assert.equal((await rail.execute(request())).status, 'completed', 'control: witness reachable');

    await witness.close();
    const refused = await rail.execute(request());
    assert.deepEqual([refused.status, detailOf(refused)], ['not-completed', D.INTERLOCK_UNAVAILABLE]);
    assert.equal(signers[0]!.signCount, 1, 'the refused payment was never signed');
    assert.equal(ledger.calls.submit, 1);
    await store.close();
    await assert.rejects(anchored(path, boundary), freshnessCode('AUTHORITY_FRESHNESS_UNAVAILABLE'), 'and a restart is refused while it lasts');
  });

  it('F7: the witness stale (rolled back alone, behind the history it anchored) — a running process refuses before signing, and a restart is refused', async () => {
    const ledger = createLedgerSimulator();
    let witness = await startWitness();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const witnessBefore = join(tmp.dir(), 'witness-before.sqlite');
    const { boundary, transport } = await scriptedBoundary(witness);
    // The store keeps talking to whichever witness instance is current (a restart moves its port).
    let target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    transport.answer = (request) => target.call(request, { timeoutMs: 2_000 });
    const store = await anchored(path, boundary);
    const { rail, signers } = railOver(ledger, store);
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    // The witness's own state, captured before any reservation.
    await witness.close();
    copyFileSync(witness.databasePath, witnessBefore);
    witness = await witness.restart();
    target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    assert.equal((await rail.execute(request())).status, 'completed', 'control: one witnessed reservation');
    // The witness alone is rolled back to before it.
    await witness.close();
    restoreFile(witnessBefore, witness.databasePath);
    witness = await witness.restart();
    target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });

    const refused = await rail.execute(request());
    assert.deepEqual([refused.status, detailOf(refused)], ['not-completed', D.INTERLOCK_UNAVAILABLE]);
    assert.equal(signers[0]!.signCount, 1, 'the refused payment was never signed');
    assert.equal(ledger.calls.submit, 1);
    await store.close();
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_FORK_DETECTED'), 'a history the witness has not seen is never accepted');
  });

  it('F9: restart preserves safety — a reservation prepared at the witness but never committed refuses the restart; one committed but never finalized is completed at restart and still blocks', async () => {
    const ledger = createLedgerSimulator();
    const witness = await startWitness();

    // Committed locally, finalize lost (crash right after the local commit).
    const pathB = join(tmp.dir(), 'interlock.sqlite');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await anchored(pathB, boundary);
    const { rail } = railOver(ledger, store);
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Error('simulated crash before finalize');
      return forward();
    };
    ledger.nextOutcome = 'pending';
    const unresolved = await rail.execute(request());
    assert.equal(unresolved.status, 'unconfirmed');
    await store.close();
    const restarted = await anchored(pathB, await boundaryFor(witness, ORG));
    const tx = ledger.transactions.get(hashOf(unresolved))!;
    assert.equal(await restarted.blocking({ account: TREASURY.classicAddress, sequence: tx.sequence, validatedLedgerIndex: ledger.index }), true, 'finalized at restart; the record blocks');
    await restarted.close();

    // Prepared at the witness, never committed (crash between prepare and the local commit): indistinguishable from a rollback.
    const { anchor } = await connect(witness);
    const witnessed = await anchor.read({ stateKind: XRPL_RESERVATIONS_STATE_KIND, organizationId: ORG });
    assert.equal(witnessed.status, 'bound');
    if (witnessed.status !== 'bound') return;
    const expected = { stateKind: XRPL_RESERVATIONS_STATE_KIND, organizationId: ORG, storeId: witnessed.storeId, ...witnessed.committed } as const;
    await anchor.prepare(expected, { ...expected, sequence: expected.sequence + 1, stateDigest: `sha256:${'ab'.repeat(32)}` });
    await assert.rejects(anchored(pathB, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
  });

  it('F10 (structure): the anchored history is never opened for the rail without its witness, and a history recorded without one is never anchored after the fact', async () => {
    const witness = await startWitness();
    const path = join(tmp.dir(), 'interlock.sqlite');
    await (await anchored(path, await boundaryFor(witness, ORG))).close();
    await assert.rejects(createSqliteXrplSubmissionInterlock(path, { scope: SCOPE, now: () => new Date().toISOString() }), /never opened for the rail without it/);
    // Verification tooling (restore) reads it without the witness and writes nothing.
    const verifying = await createSqliteXrplSubmissionInterlock(path, { now: () => new Date().toISOString() });
    assert.equal(verifying.anchored, false);
    await verifying.close();

    const ledger = createLedgerSimulator();
    const legacy = join(tmp.dir(), 'legacy.sqlite');
    const unanchored = await createSqliteXrplSubmissionInterlock(legacy, { scope: SCOPE, now: () => new Date().toISOString() });
    const { rail } = railOver(ledger, unanchored);
    await rail.readiness();
    ledger.index += SIMULATED_RESTART_QUARANTINE;
    assert.equal((await rail.execute(request())).status, 'completed');
    await unanchored.close();
    await assert.rejects(anchored(legacy, await boundaryFor(witness, `${ORG}-legacy`)), /never anchored after the fact/);
  });
});
