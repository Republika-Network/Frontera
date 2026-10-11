import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import {
  RIPPLE_EPOCH_UNIX_SECONDS,
  XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET,
  XRPL_RAIL_DETAILS as D,
  XRPL_RAIL_LIMITS,
  XRPL_RESTART_ANCHOR_SLACK_SECONDS,
  XRPL_RESTART_QUARANTINE_LEDGERS,
  XRPL_RESTART_QUARANTINE_MARGIN,
  createXrplRlusdRail,
  type XrplRlusdRail,
  type XrplSubmissionInterlock,
  type XrplTransactionSigner,
} from '../../features/payment-runtime/rails/xrpl/index.js';
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
const QUARANTINE = XRPL_RESTART_QUARANTINE_LEDGERS;
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

  it('I5 / I6 / C6: after a restart the unconfirmed record is still there and durably blocks its window, and the quarantine outlasts even the widest window', async () => {
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
    // The durable record — not memory — blocks the competing sequence for as long as its 200-ledger window is open.
    const record = rows(path)[0]!;
    assert.equal(await p.store.blocking({ account: TREASURY.classicAddress, sequence: record['sequence'] as number, validatedLedgerIndex: ledger.index }), true);
    assert.equal(await p.store.blocking({ account: TREASURY.classicAddress, sequence: record['sequence'] as number, validatedLedgerIndex: (record['last_ledger_sequence'] as number) - 1 }), true);
    // The quarantine, independent of the narrower current offset, ends only after that window has been validated.
    ledger.index += QUARANTINE;
    assert.ok(ledger.index >= (record['last_ledger_sequence'] as number), 'the quarantine outlasts the widest historical window');
    assert.equal(await p.store.blocking({ account: TREASURY.classicAddress, sequence: record['sequence'] as number, validatedLedgerIndex: ledger.index }), false, 'released by the ledger fact, not by a write');
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

describe('PAY-03 interlock review hardening (I10 across OS processes, I12 unknown schema, I16 stale restore)', () => {
  /** One OS process: opens its own connection, waits at the barrier, reserves once, reports the outcome. */
  const RESERVING_PROCESS = `
const { existsSync } = require('node:fs');
(async () => {
  const p = JSON.parse(process.argv[1]);
  const { createSqliteXrplSubmissionInterlock } = require(p.module);
  const store = await createSqliteXrplSubmissionInterlock(p.db, { scope: p.scope, now: () => new Date().toISOString(), busyTimeoutMs: 30000 });
  process.stdout.write('ready\\n');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(p.go)) Atomics.wait(pause, 0, 0, 1);
  let outcome;
  try {
    outcome = (await store.reserve(p.record, p.validated)).outcome;
  } catch (error) {
    outcome = 'error:' + String(error && error.code);
  }
  await store.close();
  process.stdout.write(JSON.stringify({ outcome }) + '\\n');
})();
`;

  it('I10: independent OS processes racing reserve on one file — exactly one wins per account; another account is independent', async () => {
    const dir = tmp.dir();
    const path = join(dir, 'race.sqlite');
    await (await openStore(path)).close();
    const go = join(dir, 'go');
    const module = join(process.cwd(), 'dist/src/enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.js');
    const amount = { currency: CONFIGURATION.asset.currency, issuer: CONFIGURATION.asset.issuer, value: '1' };
    const contenders = [...Array.from({ length: 7 }, () => TREASURY.classicAddress), OTHER_SOURCE.classicAddress];
    const children = contenders.map((account, index) => {
      const record = { executionId: `aoc.exec:os-race-${index}`, account, sequence: 9, lastLedgerSequence: 5020, minLedger: 5001, transactionHash: (index + 1).toString(16).toUpperCase().padStart(64, '0'), amount };
      const child = spawn(process.execPath, ['-e', RESERVING_PROCESS, JSON.stringify({ module, db: path, go, scope: SCOPE, record, validated: 5000 })], { stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      const ready = new Promise<void>((resolve, reject) => {
        const check = (): void => (output.includes('ready\n') ? resolve() : undefined);
        child.stdout.on('data', check);
        child.once('exit', () => reject(new Error(`contender ${index} exited before the barrier`)));
      });
      const done = new Promise<string>((resolve) => child.once('exit', () => resolve((JSON.parse(output.split('\n').filter((line) => line.startsWith('{')).pop() ?? '{}') as { outcome?: string }).outcome ?? 'no-answer')));
      return { account, ready, done };
    });
    await Promise.all(children.map((child) => child.ready));
    writeFileSync(go, '');
    const outcomes = await Promise.all(children.map(async (child) => ({ account: child.account, outcome: await child.done })));
    const of = (account: string): string[] => outcomes.filter((entry) => entry.account === account).map((entry) => entry.outcome).sort();
    assert.deepEqual(of(TREASURY.classicAddress), ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'reserved'], 'exactly one of seven processes reserves the contested sequence; no error, no second winner');
    assert.deepEqual(of(OTHER_SOURCE.classicAddress), ['reserved'], 'a different source account is independent');
    const store = await openStore(path);
    assert.deepEqual(await store.verifyAll(), { records: 2, open: 2 });
    await store.close();
  });

  it('I12: a file recorded under an unknown schema version is refused, unmutated — nothing is migrated, repaired or signed against', async () => {
    const path = join(tmp.dir(), 'interlock.sqlite');
    await (await openStore(path)).close();
    const db = new Database(path);
    db.prepare(`INSERT INTO xrpl_interlock_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.xrpl-submission-interlock.schema.v2', 'current', ?)`).run(iso());
    db.close();
    const versions = (): unknown[] => {
      const reader = new Database(path, { readonly: true });
      try {
        return reader.prepare('SELECT schema_version FROM xrpl_interlock_store_versions ORDER BY id').all();
      } finally {
        reader.close();
      }
    };
    const before = versions();
    await assert.rejects(openStore(path), (error: { code?: string; message?: string }) => error.code === 'XRPL_INTERLOCK_UNAVAILABLE' && /schema version/.test(error.message ?? ''));
    assert.deepEqual(versions(), before, 'refused unmutated');
  });

  it('I16 / C12: a stale restore that loses an unresolved record cannot reopen its sequence while its window is open — the restart quarantine outlasts it', async () => {
    const ledger = createLedgerSimulator();
    const dir = tmp.dir();
    const path = join(dir, 'interlock.sqlite');
    const stale = join(dir, 'stale-backup.sqlite');
    // The backup is taken before the payment: bound, empty.
    await (await openStore(path)).close();
    copyFileSync(path, stale);

    // A later run submits a payment whose outcome is unknown; its record exists only in the live file.
    ledger.nextOutcome = 'pending';
    const first = await startProcess(path, ledger, { warm: true });
    const lost = await first.rail.execute(request());
    assert.equal(lost.status, 'unconfirmed');
    const lostTx = ledger.transactions.get((lost as { externalReference: string }).externalReference)!;
    await exitProcess(first);

    // Restore the stale backup over it: the unresolved record is gone.
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    copyFileSync(stale, path);
    assert.deepEqual(rows(path), [], 'the stale restore lost the unresolved record');

    // The restored process refuses everything, unsigned, for as long as the lost transaction could still be included.
    ledger.nextOutcome = 'success';
    const restored = await startProcess(path, ledger);
    while (ledger.index < lostTx.lastLedgerSequence) {
      const refused = await restored.rail.execute(request());
      assert.deepEqual([refused.status, (refused as { detail?: string }).detail], ['not-completed', D.RESTART_QUARANTINE], `refused at ledger ${ledger.index} (lost window ends at ${lostTx.lastLedgerSequence})`);
      ledger.index += 1;
    }
    assert.equal(restored.signers[0]!.signCount, 0, 'nothing signed while the lost window was open');
    assert.equal(ledger.calls.submit, 1);

    // Once the quarantine has passed, the ledger has closed the lost window: the same sequence is free and nothing competes.
    ledger.index += 4 + QUARANTINE;
    lostTx.outcome = 'dropped';
    const next = await restored.rail.execute(request());
    assert.equal(next.status, 'completed');
    const reused = ledger.transactions.get((next as { externalReference: string }).externalReference)!;
    assert.equal(reused.sequence, lostTx.sequence, 'the sequence is reused only after the lost transaction can never be included');
    await exitProcess(restored);
  });
});
describe('PAY-03 restart quarantine: independent of the current lastLedgerOffset and of a lagging server (review fix)', () => {
  const withOffset = (lastLedgerOffset: number) => testConfiguration({ sourceAccounts: CONFIGURATION.sourceAccounts.map((mapping) => ({ ...mapping })), lastLedgerOffset, finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
  const freshSigners = () => [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(OTHER_SOURCE)];
  const detailOf = (outcome: unknown): string | undefined => (outcome as { detail?: string }).detail;

  it('the quarantine is the historical maximum window plus margin, and the historical bound never falls below what configuration accepts', () => {
    assert.ok(XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET >= XRPL_RAIL_LIMITS.lastLedgerOffset.maximum, 'raise XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET with the limit; never lower it');
    assert.equal(XRPL_RESTART_QUARANTINE_LEDGERS, XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET + XRPL_RESTART_QUARANTINE_MARGIN);
    const ledger = createLedgerSimulator();
    const { validatedLedgerHeader: _omitted, ...headerless } = ledger;
    assert.throws(
      () => createXrplRlusdRail({ configuration: CONFIGURATION, client: headerless as never, signers: freshSigners(), interlock: { recorded: async () => undefined, blocking: async () => false, reserve: async () => ({ outcome: 'reserved' }), markUnconfirmed: async () => {}, settle: async () => {} } }),
      /validatedLedgerHeader/,
      'a durable interlock without a close-time-capable client is refused at composition',
    );
  });

  it('T1–T7: a transaction signed under lastLedgerOffset 200 and lost by a stale restore keeps a restart configured with offset 4 refusing until the 200-ledger window is closed', async () => {
    const ledger = createLedgerSimulator();
    const dir = tmp.dir();
    const path = join(dir, 'interlock.sqlite');
    const stale = join(dir, 'stale-backup.sqlite');
    await (await openStore(path)).close();
    copyFileSync(path, stale);

    // T1 / T2: a prior process with lastLedgerOffset 200 submits a payment whose outcome is unknown.
    const firstStore = await openStore(path);
    const firstRail = createXrplRlusdRail({ configuration: withOffset(200), client: ledger, signers: freshSigners(), interlock: firstStore, ...testClock() });
    await firstRail.readiness();
    ledger.index += QUARANTINE;
    ledger.nextOutcome = 'pending';
    const lost = await firstRail.execute(request());
    assert.equal(lost.status, 'unconfirmed');
    const lostTx = ledger.transactions.get((lost as { externalReference: string }).externalReference)!;
    assert.equal(lostTx.lastLedgerSequence, ledger.index + 200, 'signed with the wide window');
    await firstStore.close();

    // T3: a stale restore loses that unresolved row.
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    copyFileSync(stale, path);
    assert.deepEqual(rows(path), [], 'the unresolved row is gone');

    // T4: restart with lastLedgerOffset 4.
    const narrow = withOffset(4);
    const store = await openStore(path);
    const signers = freshSigners();
    const rail = createXrplRlusdRail({ configuration: narrow, client: ledger, signers, interlock: store, ...testClock() });
    const restartIndex = ledger.index;
    await rail.readiness();
    ledger.nextOutcome = 'success';

    // T5: the validated ledger passes everything the new configuration's offset would imply (4 + margin).
    ledger.index = restartIndex + narrow.lastLedgerOffset + XRPL_RESTART_QUARANTINE_MARGIN + 1;
    // T6: still refused before signing — and through the whole of the lost transaction's window.
    for (; ledger.index <= lostTx.lastLedgerSequence; ledger.index += 7) {
      const refused = await rail.execute(request());
      assert.deepEqual([refused.status, detailOf(refused)], ['not-completed', D.RESTART_QUARANTINE], `refused at ledger ${ledger.index}; the lost window ends at ${lostTx.lastLedgerSequence}`);
    }
    assert.equal(signers[0]!.signCount, 0, 'nothing signed');
    assert.equal(ledger.calls.submit, 1, 'nothing submitted');

    // T7: beyond the maximum possible historical window, the lost transaction can never be included: a new execution proceeds.
    ledger.index = restartIndex + QUARANTINE;
    assert.ok(ledger.index >= lostTx.lastLedgerSequence + XRPL_RESTART_QUARANTINE_MARGIN);
    lostTx.outcome = 'dropped';
    const next = await rail.execute(request());
    assert.equal(next.status, 'completed');
    assert.equal(ledger.transactions.get((next as { externalReference: string }).externalReference)!.sequence, lostTx.sequence, 'the sequence is reused only once it is provably free');
    await store.close();
  });

  it('a server that is lagging when the Host starts cannot anchor the quarantine early: only a ledger that closed after the start anchors it', async () => {
    const ledger = createLedgerSimulator({ index: 10_000 });
    // A prior process, on a current server, signs under offset 200; its record is then lost (the restarted process gets an empty store).
    const priorStore = await openStore(join(tmp.dir(), 'prior.sqlite'));
    const prior = createXrplRlusdRail({ configuration: withOffset(200), client: ledger, signers: freshSigners(), interlock: priorStore, ...testClock() });
    await prior.readiness();
    ledger.index += QUARANTINE;
    ledger.nextOutcome = 'pending';
    const lost = await prior.execute(request());
    const lostTx = ledger.transactions.get((lost as { externalReference: string }).externalReference)!;
    await priorStore.close();

    // The restart reaches a server 1,000 ledgers behind the network, whose newest validated ledger closed an hour ago.
    const started = Date.now();
    const rippleNow = Math.floor(started / 1000) - RIPPLE_EPOCH_UNIX_SECONDS;
    const network = ledger.index;
    ledger.index = network - 1_000;
    ledger.closeTime = rippleNow - 3_600;
    const store = await openStore(join(tmp.dir(), 'restarted.sqlite'));
    const signers = freshSigners();
    const rail = createXrplRlusdRail({ configuration: withOffset(4), client: ledger, signers, interlock: store, ...testClock(started) });
    await rail.readiness();
    ledger.nextOutcome = 'success';

    // The server catches up — far past "first observed index + window" — but every ledger it reports closed before the start: no anchor, refused.
    for (const index of [network - 1_000 + QUARANTINE, network, lostTx.lastLedgerSequence - 1]) {
      ledger.index = index;
      assert.equal(detailOf(await rail.execute(request())), D.RESTART_QUARANTINE, `no anchor yet at ${index}`);
    }
    // A ledger that closed before start + slack still does not anchor.
    ledger.closeTime = rippleNow + XRPL_RESTART_ANCHOR_SLACK_SECONDS - 1;
    assert.equal(detailOf(await rail.execute(request())), D.RESTART_QUARANTINE);
    // Current now: the first ledger closed after start + slack anchors, and the full window runs from it.
    ledger.closeTime = rippleNow + XRPL_RESTART_ANCHOR_SLACK_SECONDS;
    const anchor = ledger.index;
    assert.equal(detailOf(await rail.execute(request())), D.RESTART_QUARANTINE);
    ledger.index = anchor + QUARANTINE - 1;
    assert.equal(detailOf(await rail.execute(request())), D.RESTART_QUARANTINE);
    assert.equal(signers[0]!.signCount, 0, 'nothing signed while the anchor was unproven or the window open');
    ledger.index = anchor + QUARANTINE;
    assert.ok(ledger.index > lostTx.lastLedgerSequence);
    lostTx.outcome = 'dropped';
    assert.equal((await rail.execute(request())).status, 'completed');
    assert.equal(ledger.calls.submit, 2);
    await store.close();
  });

  it('an unreadable or malformed ledger header never anchors: refused, nothing signed', async () => {
    const ledger = createLedgerSimulator();
    const store = await openStore(join(tmp.dir(), 'interlock.sqlite'));
    const signers = freshSigners();
    const malformed = { ...ledger, validatedLedgerHeader: async () => ({ ledger_index: ledger.index, close_time: 'soon' }) };
    const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: malformed, signers, interlock: store, ...testClock() });
    await rail.readiness();
    ledger.index += QUARANTINE * 3;
    assert.equal(detailOf(await rail.execute(request())), D.RESTART_QUARANTINE);
    assert.equal(signers[0]!.signCount, 0);
    assert.equal(ledger.calls.submit, 0);
    await store.close();
  });
});
