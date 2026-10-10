import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { XRPL_RAIL_DETAILS as D, createXrplRlusdRail, type XrplRlusdRail, type XrplSubmissionInterlock, type XrplTransactionSigner } from '../../features/payment-runtime/rails/xrpl/index.js';
import { GOVERNED_ACCOUNT, OTHER_SOURCE, RLUSD_ASSET, TREASURY, VENDOR, createTestSoftwareXrplSigner, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { createXrplResolutionAuthority, readOnlyXrplLedger } from '../xrpl-payment-rail/xrpl-resolution-authority.js';
import { createLedgerSimulator, scratch, type LedgerSimulator } from './pay03-xrpl-fixture.js';

/**
 * PAY-03 — the durable submission interlock, the write order and the restart
 * quarantine, qualified on the real rail and the real SQLite interlock with a
 * deterministic ledger (no network).
 *
 * "Process exit" is modelled exactly as it happens: the rail instance and its
 * in-memory state are dropped, the store's connection is closed, and a new
 * rail is composed over a freshly opened store — nothing survives but the file.
 */

const tmp = scratch('frontera-pay03-interlock-');
after(() => tmp.cleanup());

const SECOND_ACCOUNT = 'reserve-ops';
const CONFIGURATION = testConfiguration({
  sourceAccounts: [
    { accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress },
    { accountId: SECOND_ACCOUNT, address: OTHER_SOURCE.classicAddress },
  ],
  finalityTimeoutMs: 5_000,
  pollIntervalMs: 1_000,
});
const QUARANTINE = CONFIGURATION.lastLedgerOffset + 4;
const SCOPE = { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId };
const iso = (): string => new Date().toISOString();

let counter = 0;
function request(overrides: Partial<PaymentExecutionRequest> = {}): PaymentExecutionRequest {
  counter += 1;
  return {
    executionId: `aoc.exec:pay03-${counter}`,
    requestId: `req-${counter}`,
    decisionId: `dec-${counter}`,
    grantId: `grant-${counter}`,
    notAfter: '2030-01-01T00:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: { kind: 'xrpl-account', reference: VENDOR.classicAddress },
    amount: { value: '25.5', unit: RLUSD_ASSET },
    purpose: 'vendor-payment',
    rail: 'xrpl-rlusd',
    ...overrides,
  };
}

function openStore(path: string): Promise<DurableXrplSubmissionInterlock> {
  return createSqliteXrplSubmissionInterlock(path, { scope: SCOPE, now: iso });
}

interface Process {
  readonly rail: XrplRlusdRail;
  readonly store: DurableXrplSubmissionInterlock;
  readonly signers: readonly ReturnType<typeof createTestSoftwareXrplSigner>[];
}

/** One "process": a store connection and a rail over it. With `warm`, the restart quarantine is already behind it. */
async function startProcess(path: string, ledger: LedgerSimulator, options: { readonly warm?: boolean; readonly interlock?: XrplSubmissionInterlock; readonly signers?: readonly XrplTransactionSigner[] } = {}): Promise<Process> {
  const store = await openStore(path);
  const signers = [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)];
  const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: options.signers ?? signers, interlock: options.interlock ?? store, ...testClock() });
  assert.deepEqual(await rail.readiness(), { status: 'ready' });
  if (options.warm === true) ledger.index += QUARANTINE;
  return { rail, store, signers };
}

async function exitProcess(process: Process): Promise<void> {
  await process.store.close();
}

function rows(path: string): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT execution_id, account, sequence, last_ledger_sequence, state, settlement FROM xrpl_submissions ORDER BY row_id').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** An interlock wrapper that "crashes" at a chosen point: the process dies there and nothing after it runs. */
class Crash extends Error {}
function crashing(inner: XrplSubmissionInterlock, at: 'before-reserve' | 'after-reserve' | 'before-outcome'): XrplSubmissionInterlock {
  return {
    recorded: (executionId) => inner.recorded(executionId),
    blocking: (query) => inner.blocking(query),
    async reserve(record, index) {
      if (at === 'before-reserve') throw new Crash();
      const reserved = await inner.reserve(record, index);
      if (at === 'after-reserve') throw new Crash();
      return reserved;
    },
    async markUnconfirmed(executionId, hash) {
      if (at === 'before-outcome') throw new Crash();
      return inner.markUnconfirmed(executionId, hash);
    },
    async settle(executionId, hash, settlement) {
      if (at === 'before-outcome') throw new Crash();
      return inner.settle(executionId, hash, settlement);
    },
  };
}

describe('PAY-03 interlock qualification (I1–I15)', () => {
  it('I1: a completed payment is recorded before its submission and settled after it; the next payment proceeds', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const first = await p.rail.execute(request());
    assert.equal(first.status, 'completed');
    assert.deepEqual(rows(path).map((row) => [row['state'], row['settlement']]), [['settled', 'validated-success']]);
    assert.equal((await p.rail.execute(request())).status, 'completed');
    assert.equal(ledger.calls.submit, 2);
    await exitProcess(p);
  });

  it('I2: a validated tec failure settles (validated-failure) and releases', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'tec';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const outcome = await p.rail.execute(request());
    assert.equal(outcome.status, 'not-completed');
    assert.equal(rows(path)[0]?.['settlement'], 'validated-failure');
    ledger.nextOutcome = 'success';
    assert.equal((await p.rail.execute(request())).status, 'completed');
    await exitProcess(p);
  });

  it('I3: proven expiry (window closed, complete search) settles (expired) and releases', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'dropped';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    // The ledger closes the window while the rail waits for finality.
    const lookup = ledger.lookupTransaction.bind(ledger);
    ledger.lookupTransaction = async (query, timeoutMs) => {
      ledger.index = query.maxLedger;
      return lookup(query, timeoutMs);
    };
    const outcome = await p.rail.execute(request());
    assert.deepEqual([outcome.status, (outcome as { detail?: string }).detail], ['not-completed', D.TRANSACTION_EXPIRED]);
    assert.equal(rows(path)[0]?.['settlement'], 'expired');
    await exitProcess(p);
  });

  it('I4 / I8: an unconfirmed payment stays open and blocks a payment that would compete for its sequence', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const first = await p.rail.execute(request());
    assert.equal(first.status, 'unconfirmed');
    assert.equal(rows(path)[0]?.['state'], 'unconfirmed');
    const second = await p.rail.execute(request());
    assert.deepEqual([second.status, (second as { detail?: string }).detail], ['not-completed', D.SEQUENCE_IN_FLIGHT]);
    assert.equal(ledger.calls.submit, 1, 'the competing payment was never submitted');
    assert.equal(p.signers[0]!.signCount, 1, 'nor even signed: the pre-check refused it first');
    await exitProcess(p);
  });

  it('I5 / I6 / C6: after a restart the unconfirmed record is still there, the quarantine refuses everything first, and the record keeps blocking a wider window', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    // A first run with a wide window (offset 200), unconfirmed, then the process exits.
    const wide = testConfiguration({ sourceAccounts: CONFIGURATION.sourceAccounts.map((m) => ({ ...m })), lastLedgerOffset: 200, finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const firstStore = await openStore(path);
    const firstRail = createXrplRlusdRail({ configuration: wide, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)], interlock: firstStore, ...testClock() });
    await firstRail.readiness();
    ledger.index += 204;
    assert.equal((await firstRail.execute(request())).status, 'unconfirmed');
    await firstStore.close();

    // Restart (offset back to 20). During the quarantine nothing is even prepared.
    const p = await startProcess(path, ledger);
    assert.equal(rows(path)[0]?.['state'], 'unconfirmed', 'restart cleared nothing');
    const during = await p.rail.execute(request());
    assert.deepEqual([during.status, (during as { detail?: string }).detail], ['not-completed', D.RESTART_QUARANTINE]);
    // After the quarantine, the durable record — not memory — still blocks the competing sequence.
    ledger.index += QUARANTINE;
    const after = await p.rail.execute(request());
    assert.deepEqual([after.status, (after as { detail?: string }).detail], ['not-completed', D.SEQUENCE_IN_FLIGHT]);
    assert.equal(ledger.calls.submit, 1);
    await exitProcess(p);
  });

  it('I9: a different source account is independent of another account’s open record', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    assert.equal((await p.rail.execute(request())).status, 'unconfirmed');
    ledger.nextOutcome = 'success';
    assert.equal((await p.rail.execute(request({ source: { accountId: SECOND_ACCOUNT } }))).status, 'completed');
    await exitProcess(p);
  });

  it('I10 / C10: a second process on the same file cannot bypass the interlock — check-and-reserve is one transaction', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const a = await startProcess(path, ledger, { warm: true });
    const b = await startProcess(path, ledger, { warm: true });
    assert.equal((await a.rail.execute(request())).status, 'unconfirmed');
    const fromB = await b.rail.execute(request());
    assert.deepEqual([fromB.status, (fromB as { detail?: string }).detail], ['not-completed', D.SEQUENCE_IN_FLIGHT]);
    assert.equal(ledger.calls.submit, 1);

    // A true race: both prepared the same sequence and both reach reserve — exactly one wins.
    const raceLedger = createLedgerSimulator({ index: 5000 });
    const racePath = join(tmp.dir(), 'race.sqlite');
    const [x, y] = [await openStore(racePath), await openStore(racePath)];
    const record = (executionId: string, hash: string) => ({ executionId, account: TREASURY.classicAddress, sequence: 9, lastLedgerSequence: 5020, minLedger: 5001, transactionHash: hash, amount: { currency: CONFIGURATION.asset.currency, issuer: CONFIGURATION.asset.issuer, value: '1' } });
    const results = await Promise.all([x.reserve(record('aoc.exec:race-a', 'A'.repeat(64)), raceLedger.index), y.reserve(record('aoc.exec:race-b', 'B'.repeat(64)), raceLedger.index)]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['blocked', 'reserved']);
    await Promise.all([x.close(), y.close(), exitProcess(a), exitProcess(b)]);
  });

  it('I11: a malformed or foreign store fails closed — the rail refuses before signing, with nothing submitted', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    assert.equal((await p.rail.execute(request())).status, 'completed');
    // Corrupt the one row's state digest out of band (triggers do not guard the digest column).
    const db = new Database(path);
    db.prepare(`UPDATE xrpl_submissions SET state_digest = 'sha256:' || substr('0000000000000000000000000000000000000000000000000000000000000000', 1, 64)`).run();
    db.close();
    const submits = ledger.calls.submit;
    const refused = await p.rail.execute(request());
    assert.deepEqual([refused.status, (refused as { detail?: string }).detail], ['not-completed', D.INTERLOCK_UNAVAILABLE]);
    assert.equal(ledger.calls.submit, submits);
    assert.equal(p.signers[0]!.signCount, 1, 'never signed against a store that could not be believed');
    await exitProcess(p);
    await assert.rejects(openStore(path), (error: { code?: string }) => error.code === 'XRPL_INTERLOCK_CORRUPT', 'and it refuses to open again');
    // A store bound to another network is refused unmutated.
    const foreign = join(tmp.dir(), 'foreign.sqlite');
    await (await createSqliteXrplSubmissionInterlock(foreign, { scope: { railId: SCOPE.railId, networkId: 0 }, now: iso })).close();
    await assert.rejects(openStore(foreign), (error: { code?: string }) => error.code === 'XRPL_INTERLOCK_UNAVAILABLE');
  });

  it('I12: an unresolved record cannot silently disappear — deletes are refused, and a row removed behind the triggers is detected', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    assert.equal((await p.rail.execute(request())).status, 'unconfirmed');
    await exitProcess(p);
    const db = new Database(path);
    assert.throws(() => db.prepare('DELETE FROM xrpl_submissions').run(), /never deleted/);
    assert.throws(() => db.prepare(`UPDATE xrpl_submissions SET state = 'submitting'`).run(), /forward only/);
    assert.throws(() => db.prepare('UPDATE xrpl_submissions SET sequence = sequence + 1').run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM xrpl_submission_transitions').run(), /append-only/);
    db.exec('DROP TRIGGER xrpl_submissions_no_delete');
    db.prepare('DELETE FROM xrpl_submissions').run();
    db.close();
    await assert.rejects(openStore(path), (error: { code?: string; check?: string }) => error.code === 'XRPL_INTERLOCK_CORRUPT' && error.check === 'record-missing');
  });

  it('I13 / I14 / I15: a P12 resolution from the ledger settles the record; an unresolved answer changes nothing', async () => {
    for (const [eventual, certainty] of [
      ['success', 'confirmed-completed'],
      ['tec', 'confirmed-not-completed'],
    ] as const) {
      const ledger = createLedgerSimulator();
      ledger.nextOutcome = 'pending';
      const path = join(tmp.dir(), 'interlock.sqlite');
      const p = await startProcess(path, ledger, { warm: true });
      const req = request();
      const outcome = await p.rail.execute(req);
      assert.equal(outcome.status, 'unconfirmed');
      const authority = createXrplResolutionAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplLedger(ledger), interlock: p.store });
      const query = { organizationId: 'org', executionId: req.executionId, evaluationId: 'e', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', action: 'pay', amount: { value: '25.5', unit: RLUSD_ASSET }, providerRef: (outcome as { externalReference: string }).externalReference, basis: 'initial-observation-unconfirmed' } as const;
      // I15: still pending on the ledger → unresolved, record untouched, still blocking.
      assert.deepEqual(await authority.resolve(query), { outcome: 'unresolved' });
      assert.equal(rows(path)[0]?.['state'], 'unconfirmed');
      // The ledger decides; the resolver reads it, answers, and settles the record.
      ledger.validate((outcome as { externalReference: string }).externalReference, eventual);
      const answer = await authority.resolve(query);
      assert.equal(answer.outcome, 'resolved');
      assert.equal((answer as { certainty: string }).certainty, certainty);
      assert.equal(rows(path)[0]?.['state'], 'settled');
      // And the account is free again (its sequence moved past the settled transaction).
      ledger.nextOutcome = 'success';
      assert.equal((await p.rail.execute(request())).status, 'completed');
      assert.equal(ledger.calls.submit, 2, 'resolution submitted nothing');
      await exitProcess(p);
    }
  });
});

describe('PAY-03 crash matrix (C1–C10): may another payment safely proceed?', () => {
  it('C1: crash before signing — nothing signed, recorded or submitted; the next payment proceeds', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    ledger.unavailable = true; // the process "dies" during preparation: no signature, no record
    assert.equal((await p.rail.execute(request())).status, 'not-completed');
    assert.deepEqual(rows(path), []);
    ledger.unavailable = false;
    assert.equal((await p.rail.execute(request())).status, 'completed');
    await exitProcess(p);
  });

  it('C2: crash after signing, before the durable write — nothing was submitted; a later payment may take the same sequence safely', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    const store = await openStore(path);
    const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)], interlock: crashing(store, 'before-reserve'), ...testClock() });
    await rail.readiness();
    ledger.index += QUARANTINE;
    const crashed = await rail.execute(request());
    assert.deepEqual([crashed.status, (crashed as { detail?: string }).detail], ['not-completed', D.INTERLOCK_UNAVAILABLE]);
    assert.equal(ledger.calls.submit, 0, 'no record, no submission: the write order holds');
    assert.deepEqual(rows(path), []);
    await store.close();
    const p = await startProcess(path, ledger, { warm: true });
    assert.equal((await p.rail.execute(request())).status, 'completed', 'the same sequence is free: the signed blob never left the process');
    await exitProcess(p);
  });

  it('C3: crash after the durable reservation, before submit — the record blocks until the ledger proves the window closed (bounded false block)', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    // A second, long-running process on the same state (its quarantine long behind it).
    const live = await startProcess(path, ledger, { warm: true });
    const store = await openStore(path);
    const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)], interlock: crashing(store, 'after-reserve'), ...testClock() });
    await rail.readiness();
    ledger.index += QUARANTINE;
    await rail.execute(request()); // the "process" dies right after the reservation committed
    assert.equal(ledger.calls.submit, 0);
    assert.equal(rows(path)[0]?.['state'], 'submitting');
    await store.close();
    // The live process is blocked while the window is open — it cannot know the submit never happened...
    const record = rows(path)[0]!;
    assert.ok((record['last_ledger_sequence'] as number) > ledger.index);
    assert.equal(((await live.rail.execute(request())) as { detail?: string }).detail, D.SEQUENCE_IN_FLIGHT);
    // ...and free once the validated ledger reaches LastLedgerSequence: the false block is bounded by the window.
    ledger.index = record['last_ledger_sequence'] as number;
    assert.equal((await live.rail.execute(request())).status, 'completed');
    assert.equal(ledger.calls.submit, 1);
    await exitProcess(live);
  });

  it('C4: crash during submit (the blob may have left) — unconfirmed with the hash; the record blocks', async () => {
    const ledger = createLedgerSimulator();
    ledger.submitMode = 'lost-after-send';
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const outcome = await p.rail.execute(request());
    assert.deepEqual([outcome.status, (outcome as { detail?: string }).detail], ['unconfirmed', D.SUBMISSION_OUTCOME_UNKNOWN]);
    assert.match((outcome as { externalReference: string }).externalReference, /^[0-9A-F]{64}$/);
    assert.equal(rows(path)[0]?.['state'], 'unconfirmed');
    ledger.submitMode = 'accept';
    assert.equal(((await p.rail.execute(request())) as { detail?: string }).detail, D.SEQUENCE_IN_FLIGHT);
    await exitProcess(p);
  });

  it('C5: crash after submit, before the outcome is recorded — the record stays `submitting`, which blocks exactly like unconfirmed', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const live = await startProcess(path, ledger, { warm: true });
    const store = await openStore(path);
    const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)], interlock: crashing(store, 'before-outcome'), ...testClock() });
    await rail.readiness();
    ledger.index += QUARANTINE;
    assert.equal((await rail.execute(request())).status, 'unconfirmed');
    assert.equal(rows(path)[0]?.['state'], 'submitting');
    await store.close();
    // Another process on the same state, and a restarted one (after its quarantine, with a wider window still open), are both blocked.
    assert.equal(((await live.rail.execute(request())) as { detail?: string }).detail, D.SEQUENCE_IN_FLIGHT);
    const restarted = await startProcess(path, ledger);
    assert.equal(((await restarted.rail.execute(request())) as { detail?: string }).detail, D.RESTART_QUARANTINE);
    assert.equal(ledger.calls.submit, 1);
    await Promise.all([exitProcess(live), exitProcess(restarted)]);
  });

  it('C7 / C8: restart after a completed or a definitively failed payment — settled records never block', async () => {
    for (const eventual of ['success', 'tec'] as const) {
      const ledger = createLedgerSimulator();
      ledger.nextOutcome = eventual;
      const path = join(tmp.dir(), 'interlock.sqlite');
      const first = await startProcess(path, ledger, { warm: true });
      await first.rail.execute(request());
      await exitProcess(first);
      ledger.nextOutcome = 'success';
      const p = await startProcess(path, ledger, { warm: true });
      assert.equal((await p.rail.execute(request())).status, 'completed');
      await exitProcess(p);
    }
  });

  it('no resend: an execution that already has a record is never signed or submitted again, and is reported unconfirmed with its hash', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const req = request();
    const first = await p.rail.execute(req);
    // Even after the window closes (nothing blocks any more), the same execution is never sent again.
    ledger.index += 1000;
    ledger.sequence += 1;
    const again = await p.rail.execute(req);
    assert.deepEqual(again, { status: 'unconfirmed', externalReference: (first as { externalReference: string }).externalReference, detail: D.EXECUTION_PREVIOUSLY_SUBMITTED });
    assert.equal(ledger.calls.submit, 1);
    await exitProcess(p);
  });

  it('a submission the client proves was never attempted closes its reservation (not-submitted) and releases', async () => {
    const ledger = createLedgerSimulator();
    ledger.submitMode = 'not-attempted';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    const outcome = await p.rail.execute(request());
    assert.deepEqual([outcome.status, (outcome as { detail?: string }).detail], ['not-completed', D.SUBMISSION_NOT_ATTEMPTED]);
    assert.equal(rows(path)[0]?.['settlement'], 'not-submitted');
    ledger.submitMode = 'accept';
    const next = await p.rail.execute(request());
    assert.equal(next.status, 'completed', JSON.stringify(next));
    await exitProcess(p);
  });

  it('a signer that answers with a blob signed by a key other than the pinned one is refused before submission', async () => {
    const ledger = createLedgerSimulator();
    const path = join(tmp.dir(), 'interlock.sqlite');
    // Pinned to OTHER_SOURCE's key, but the signer actually signs with TREASURY's own key.
    const impostor: XrplTransactionSigner = { address: TREASURY.classicAddress, signingPublicKey: OTHER_SOURCE.publicKey, sign: createTestSoftwareXrplSigner(TREASURY).sign };
    const p = await startProcess(path, ledger, { warm: true, signers: [impostor, createTestSoftwareXrplSigner(OTHER_SOURCE)] });
    const outcome = await p.rail.execute(request());
    assert.deepEqual([outcome.status, (outcome as { detail?: string }).detail], ['not-completed', D.SIGNING_KEY_MISMATCH]);
    assert.equal(ledger.calls.submit, 0);
    assert.deepEqual(rows(path), [], 'nothing reserved for a blob that was never going to be submitted');
    await exitProcess(p);
  });

  it('shutdown clears nothing: an open record survives close and reopen byte for byte', async () => {
    const ledger = createLedgerSimulator();
    ledger.nextOutcome = 'pending';
    const path = join(tmp.dir(), 'interlock.sqlite');
    const p = await startProcess(path, ledger, { warm: true });
    await p.rail.execute(request());
    const before = rows(path);
    await p.rail.close();
    await exitProcess(p);
    const reopened = await openStore(path);
    assert.deepEqual(rows(path), before);
    assert.deepEqual(await reopened.verifyAll(), { records: 1, open: 1 });
    await reopened.close();
  });
});
