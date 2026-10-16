import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import {
  TRADE_INTERLOCK_STORE_SCHEMA_VERSION,
  TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1,
  TRADE_RESERVATIONS_STATE_KIND,
  createSqliteTradeSequenceInterlock,
  type DurableTradeSequenceInterlock,
  type TradeReservationInput,
} from '../xrpl-trade-execution/sqlite-trade-sequence-interlock.js';
import { ScriptedWitnessTransport, boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ORG, scratch } from './trade04c-execution-fixture.js';
import { intendAndSign, intentFor, reserveWithIntent } from './trade04d-intent-fixture.js';
import { testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04C (G4) — the durable trade sequence interlock: SQLite, anchored at
 * the CORE-07 witness in slot `trade-sequence-reservations`, reservations and
 * submission claims both in the anchored history. Real reference witness over
 * loopback HTTP; real SQLite files; nothing simulated but the time.
 */

const tmp = scratch();
after(async () => {
  await closeAllWitnesses();
  tmp.cleanup();
});

const OWNER = testAccount();
const OTHER_OWNER = testAccount();
const DELEGATE = testAccount();
const SCOPE = { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 };
const now = (): string => new Date().toISOString();
let counter = 0;
const HASH = (n: number): string => n.toString(16).toUpperCase().padStart(64, 'A');
let file = 0;
const pathFor = (): string => join(tmp.dir, `interlock-${(file += 1)}.sqlite`);

function reservation(overrides: Partial<TradeReservationInput> = {}, validated = 500): TradeReservationInput {
  counter += 1;
  return {
    executionId: `aoc.exec:trade-interlock-${counter}`,
    account: OWNER,
    sequence: 40,
    lastLedgerSequence: validated + 20,
    minLedger: validated + 1,
    transactionHash: HASH(counter),
    evidence: {
      organizationId: ORG,
      subject: 'actor-engine',
      requestId: `req-${counter}`,
      decisionId: `dec-${counter}`,
      boundedGrantId: `grant-${counter}`,
      proposalDigest: `sha256:${'a'.repeat(64)}`,
      delegateAccount: DELEGATE,
      signerId: 'signer-1',
      signerRequestId: 'f'.repeat(64),
      signingPublicKey: `ED${'1'.repeat(64)}`,
      keyAuthority: 'master-key',
      preparedDigest: `sha256:${'b'.repeat(64)}`,
      delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`,
      delegationFactsDigest: `sha256:${'d'.repeat(64)}`,
      referenceLedgerIndex: validated,
      referenceLedgerHash: 'E'.repeat(64),
      delegationLedgerIndex: validated,
      delegateRootLedgerIndex: validated,
      ownerRootLedgerIndex: validated,
      fee: '12',
      ledgerProvenance: 'injected-ledger-client',
    },
    ...overrides,
  };
}

async function open(path: string, witness: StartedWitness, options: { readonly accounts?: readonly string[]; readonly scope?: typeof SCOPE } = {}): Promise<DurableTradeSequenceInterlock> {
  return createSqliteTradeSequenceInterlock(path, { scope: options.scope ?? SCOPE, sequenceAccounts: options.accounts ?? [OWNER, OTHER_OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
}

/** Restores a closed SQLite file from a copy (no WAL or shared-memory file of the newer state left beside it). */
function restore(backup: string, path: string): void {
  for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
  copyFileSync(backup, path);
}

const intentForTest = (record: TradeReservationInput) => intentFor(record);
const claimOf = (record: TradeReservationInput, overrides: Record<string, unknown> = {}) => ({ executionId: record.executionId, networkId: 1, transactionHash: record.transactionHash, transactionType: 'OfferCreate', account: record.account, sequence: record.sequence, lastLedgerSequence: record.lastLedgerSequence, ...overrides });
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

describe('TRADE-04C interlock — reservation and blocking', () => {
  it('first reservation succeeds and blocks the same or a lower Sequence on the owner, not another owner, until the window closes', async () => {
    const witness = await startWitness();
    const store = await open(pathFor(), witness);
    try {
      const first = reservation();
      assert.deepEqual(await reserveWithIntent(store, first, 500), { outcome: 'reserved' });
      assert.equal(await store.recorded(first.executionId), first.transactionHash);
      assert.equal(await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 500 }), true);
      assert.equal(await store.blocking({ account: OWNER, sequence: 39, validatedLedgerIndex: 500 }), true);
      assert.equal(await store.blocking({ account: OWNER, sequence: 41, validatedLedgerIndex: 500 }), false);
      assert.equal(await store.blocking({ account: OTHER_OWNER, sequence: 40, validatedLedgerIndex: 500 }), false);
      assert.deepEqual(await reserveWithIntent(store, reservation({ sequence: 40 }), 500), { outcome: 'blocked' }, 'two executions competing for one Sequence');
      assert.deepEqual(await reserveWithIntent(store, reservation({ account: OTHER_OWNER, sequence: 40 }), 500), { outcome: 'reserved' }, 'different owners are isolated');
      assert.equal(await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 520 }), false, 'the ledger reached LastLedgerSequence');
      assert.deepEqual(await store.reserve({ ...first, transactionHash: HASH(9_999) }, 500), { outcome: 'execution-recorded', transactionHash: first.transactionHash }, 'one record per execution, ever');
    } finally {
      await store.close();
    }
  });

  it('concurrent duplicate reservations for one Sequence: exactly one wins', async () => {
    const witness = await startWitness();
    const store = await open(pathFor(), witness);
    try {
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => reserveWithIntent(store, reservation({ sequence: 77, account: OTHER_OWNER }), 500)));
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'reserved').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'blocked').length, 7);
    } finally {
      await store.close();
    }
  });

  it('two processes on one file and one witness (two connections): never both reserve a competing Sequence', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const a = await open(path, witness);
    const b = await open(path, witness);
    try {
      const results = await Promise.allSettled([reserveWithIntent(a, reservation({ sequence: 90 }), 500), reserveWithIntent(b, reservation({ sequence: 90 }), 500)]);
      const reserved = results.filter((result) => result.status === 'fulfilled' && result.value.outcome === 'reserved');
      assert.equal(reserved.length, 1, JSON.stringify(results.map((result) => (result.status === 'fulfilled' ? result.value : (result.reason as { code?: string }).code))));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('refuses an owner outside the configured sequence accounts, malformed input, and a reference index that does not match minLedger', async () => {
    const witness = await startWitness();
    const store = await open(pathFor(), witness, { accounts: [OWNER] });
    try {
      await assert.rejects(store.reserve(reservation({ account: OTHER_OWNER }), 500), code('TRADE_INTERLOCK_INVALID'));
      await assert.rejects(store.reserve(reservation({ sequence: 0 }), 500), code('TRADE_INTERLOCK_INVALID'));
      await assert.rejects(store.reserve(reservation({ transactionHash: 'abc' }), 500), code('TRADE_INTERLOCK_INVALID'));
      await assert.rejects(store.reserve(reservation(), 499), code('TRADE_INTERLOCK_INVALID'));
      const bad = reservation();
      await assert.rejects(store.reserve({ ...bad, evidence: { ...bad.evidence, extra: 'x' } as never }, 500), code('TRADE_INTERLOCK_INVALID'));
      await assert.rejects(store.reserve({ ...bad, evidence: { ...bad.evidence, signerId: 'has spaces and a token=secret' } }, 500), code('TRADE_INTERLOCK_INVALID'));
      await assert.rejects(store.reserve({ ...bad, evidence: { ...bad.evidence, delegateAccount: OWNER } }, 500), code('TRADE_INTERLOCK_INVALID'), 'owner and delegate are distinct');
    } finally {
      await store.close();
    }
  });
});

describe('TRADE-04C interlock — the submission claim (G2): exactly the reserved blob, once, ever', () => {
  it('requires a reservation, every field equal, the reserved state; a second claim — here, in another connection or after restart — is refused', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    const record = reservation();
    try {
      await assert.rejects(store.claimSubmission(claimOf(record)), code('TRADE_INTERLOCK_CLAIM_REFUSED'), 'no reservation');
      await reserveWithIntent(store, record, 500);
      for (const [field, value] of [
        ['executionId', 'aoc.exec:someone-else'],
        ['networkId', 2],
        ['transactionHash', HASH(123_456)],
        ['transactionType', 'Payment'],
        ['account', OTHER_OWNER],
        ['sequence', 41],
        ['lastLedgerSequence', 521],
      ] as const) {
        await assert.rejects(store.claimSubmission(claimOf(record, { [field]: value })), code('TRADE_INTERLOCK_CLAIM_REFUSED'), field);
      }
      assert.equal((await store.read(record.executionId))?.state, 'reserved');
      await store.claimSubmission(claimOf(record));
      const claimed = await store.read(record.executionId);
      assert.equal(claimed?.state, 'submitting');
      assert.equal(claimed?.submissionAttempts, 1);
      await assert.rejects(store.claimSubmission(claimOf(record)), code('TRADE_INTERLOCK_CLAIM_REFUSED'), 'already claimed');
      const other = await open(path, witness);
      await assert.rejects(other.claimSubmission(claimOf(record)), code('TRADE_INTERLOCK_CLAIM_REFUSED'), 'another connection');
      await other.close();
    } finally {
      await store.close();
    }
    const restarted = await open(path, witness);
    try {
      await assert.rejects(restarted.claimSubmission(claimOf(record)), code('TRADE_INTERLOCK_CLAIM_REFUSED'), 'after restart');
      assert.equal((await restarted.read(record.executionId))?.submissionAttempts, 1);
    } finally {
      await restarted.close();
    }
  });

  it('the lifecycle moves forward only; unconfirmed only after a claim; settle closes and never reopens', async () => {
    const witness = await startWitness();
    const store = await open(pathFor(), witness);
    try {
      const record = reservation();
      await reserveWithIntent(store, record, 500);
      await store.markUnconfirmed(record.executionId, record.transactionHash, 'trade-submission-outcome-unknown');
      assert.equal((await store.read(record.executionId))?.state, 'reserved', 'an unclaimed reservation is never marked submitted');
      await store.claimSubmission(claimOf(record));
      await store.markUnconfirmed(record.executionId, record.transactionHash, 'trade-submission-outcome-unknown');
      assert.equal((await store.read(record.executionId))?.state, 'unconfirmed');
      await store.settle(record.executionId, record.transactionHash, 'validated-success', 'tesSUCCESS');
      await store.markUnconfirmed(record.executionId, record.transactionHash);
      const settled = await store.read(record.executionId);
      assert.equal(settled?.state, 'settled');
      assert.deepEqual(settled?.transitions.map((transition) => [transition.to, transition.detail ?? null]), [['reserved', null], ['submitting', null], ['unconfirmed', 'trade-submission-outcome-unknown'], ['settled', 'tesSUCCESS']]);
      await assert.rejects(store.settle(record.executionId, HASH(1), 'expired'), code('TRADE_INTERLOCK_CORRUPT'), 'settling another hash');
      await assert.rejects(store.settle(record.executionId, record.transactionHash, 'not-submitted' as never), code('TRADE_INTERLOCK_INVALID'), 'there is no not-submitted release');
    } finally {
      await store.close();
    }
  });
});

describe('TRADE-04C interlock — CORE-07 freshness and startup', () => {
  it('initial enrollment: a new store is enrolled at the witness before its genesis commits; reopening establishes the same history', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    assert.equal(store.anchored, true);
    await reserveWithIntent(store, reservation(), 500);
    assert.equal((await store.health()).freshness, 'ready');
    await store.close();
    const reopened = await open(path, witness);
    assert.equal((await reopened.verifyAll()).records, 1);
    await reopened.close();
  });

  it('a stale restore (an older copy of the file) is refused at open: ROLLBACK_DETECTED', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    await reserveWithIntent(store, reservation(), 500);
    await store.close();
    const backup = `${path}.backup`;
    copyFileSync(path, backup);
    const again = await open(path, witness);
    const later = reservation({ account: OTHER_OWNER });
    await reserveWithIntent(again, later, 500);
    await again.claimSubmission(claimOf(later));
    await again.close();
    restore(backup, path);
    await assert.rejects(open(path, witness), (error: { code?: string; message?: string }) => error.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || /ROLLBACK/.test(String(error.message)));
  });

  it('a lost submission claim (restore taken between reserve and claim) is detected: claims are anchored too', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    const record = reservation();
    await reserveWithIntent(store, record, 500);
    await store.close();
    const backup = `${path}.backup`;
    copyFileSync(path, backup);
    const again = await open(path, witness);
    await again.claimSubmission(claimOf(record));
    await again.close();
    restore(backup, path);
    await assert.rejects(open(path, witness), (error: { code?: string; message?: string }) => error.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || /ROLLBACK/.test(String(error.message)));
  });

  it('witness unavailable: the open is refused; with the store open, blocking (before every signature) refuses', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    await reserveWithIntent(store, reservation(), 500);
    await witness.close();
    await assert.rejects(store.blocking({ account: OWNER, sequence: 41, validatedLedgerIndex: 500 }));
    await assert.rejects(store.recordIntent(intentForTest(reservation({ sequence: 60, account: OTHER_OWNER })), 500), 'no intent is recorded without the witness');
    await assert.rejects(store.reserve(reservation({ sequence: 60, account: OTHER_OWNER }), 500));
    await store.close();
    await assert.rejects(open(path, witness));
  });

  it('crash after the local commit but before witness finalize: the next open reconciles and keeps the reservation; a local file behind the witness (crash/restore losing a committed transition) is refused', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const { createHttpAuthorityStateWitnessTransport } = await import('../authority-state-freshness/index.js');
    const { WITNESS_TOKEN } = await import('./core07-freshness-fixture.js');
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const boundary = await boundaryFor(witness, ORG, { transport: scripted });
    const store = await createSqliteTradeSequenceInterlock(path, { scope: SCOPE, sequenceAccounts: [OWNER, OTHER_OWNER], now, freshness: { boundary } });
    const committed = reservation();
    await reserveWithIntent(store, committed, 500);
    // Finalize lost after the local commit ("crash after store commit, before witness finalize").
    scripted.answer = (request, forward) => (request.operation === 'finalize' ? Promise.reject(new Error('lost')) : forward());
    const second = reservation({ account: OTHER_OWNER, sequence: 70 });
    scripted.answer = (_request, forward) => forward();
    await intendAndSign(store, second, 500);
    scripted.answer = (request, forward) => (request.operation === 'finalize' ? Promise.reject(new Error('lost')) : forward());
    await store.reserve(second, 500).catch(() => undefined);
    scripted.answer = (_request, forward) => forward();
    await store.close();
    const reopened = await open(path, witness);
    assert.equal(await reopened.recorded(second.executionId), second.transactionHash, 'committed locally: kept, and the witness finalized on reconciliation');
    assert.equal(await reopened.recorded(committed.executionId), committed.transactionHash);
    await reopened.close();

    // A file left behind the witness's history (a later transition the file no longer holds).
    const path2 = pathFor();
    const witness2 = await startWitness();
    const scripted2 = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness2.endpoint, credential: WITNESS_TOKEN }));
    const store2 = await createSqliteTradeSequenceInterlock(path2, { scope: SCOPE, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness2, ORG, { transport: scripted2 }) } });
    await reserveWithIntent(store2, reservation(), 500);
    const backup = `${path2}.before`;
    await store2.close();
    copyFileSync(path2, backup);
    const store3 = await open(path2, witness2, { accounts: [OWNER] });
    await reserveWithIntent(store3, reservation({ sequence: 80 }), 500);
    await store3.close();
    restore(backup, path2);
    await assert.rejects(open(path2, witness2, { accounts: [OWNER] }), (error: { code?: string; message?: string }) => /ROLLBACK|PENDING/.test(`${error.code} ${error.message}`), 'a history the witness saw advance past this file is refused');
  });

  it('crash before the local commit (witness prepared, file never committed): nothing reserved, and the next open is refused PENDING_RECOVERY — never guessed either way', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const { createHttpAuthorityStateWitnessTransport } = await import('../authority-state-freshness/index.js');
    const { WITNESS_TOKEN } = await import('./core07-freshness-fixture.js');
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const store = await createSqliteTradeSequenceInterlock(path, { scope: SCOPE, sequenceAccounts: [OWNER], now, busyTimeoutMs: 0, freshness: { boundary: await boundaryFor(witness, ORG, { transport: scripted }) } });
    let blocker: InstanceType<typeof Database> | undefined;
    scripted.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'prepare') {
        // Another writer holds the file: the store's local commit cannot run.
        blocker = new Database(path);
        blocker.exec('BEGIN EXCLUSIVE');
      }
      return answer;
    };
    const lost = reservation();
    const forward = scripted.answer;
    scripted.answer = (_request, next) => next();
    await intendAndSign(store, lost, 500);
    scripted.answer = forward;
    await assert.rejects(store.reserve(lost, 500));
    blocker?.exec('ROLLBACK');
    blocker?.close();
    scripted.answer = (_request, forward) => forward();
    await store.close();
    await assert.rejects(open(path, witness, { accounts: [OWNER] }), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY');
    const verifier = await createSqliteTradeSequenceInterlock(path, { now });
    assert.equal((await verifier.verifyAll()).records, 0, 'the file holds no record of it');
    assert.equal((await verifier.readIntent(lost.executionId))?.state, 'signing', 'its intent, committed before, still holds the window');
    await verifier.close();
  });

  it('an existing store with records but no anchor is never auto-enrolled; an unsupported schema version and another scope are refused unmutated', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    await reserveWithIntent(store, reservation(), 500);
    await store.close();
    const forged = pathFor();
    copyFileSync(path, forged);
    const db = new Database(forged);
    db.exec('DROP TRIGGER trade_interlock_anchor_no_delete; DELETE FROM trade_interlock_anchor;');
    db.close();
    await assert.rejects(open(forged, await startWitness()), /never anchored after the fact/);
    const versioned = pathFor();
    copyFileSync(path, versioned);
    const db2 = new Database(versioned);
    db2.prepare(`INSERT INTO trade_interlock_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.trade-sequence-interlock.schema.v3', 'current', ?)`).run(now());
    db2.close();
    await assert.rejects(open(versioned, witness), /schema version this runtime does not implement/);
    await assert.rejects(open(path, witness, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 2 } }), /another domain or XRPL network/);
    assert.equal(TRADE_INTERLOCK_STORE_SCHEMA_VERSION, 'aoc.trade-sequence-interlock.schema.v2', 'TRADE-04D D-1');
    assert.equal(TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1, 'aoc.trade-sequence-interlock.schema.v1');
    assert.equal(TRADE_RESERVATIONS_STATE_KIND, 'trade-sequence-reservations');
  });

  it('tampered records are refused, never repaired: identity, state, evidence, a deleted row, a forged settlement', async () => {
    const witness = await startWitness();
    const path = pathFor();
    const store = await open(path, witness);
    const record = reservation();
    await reserveWithIntent(store, record, 500);
    await store.close();
    const tampers = [
      'DROP TRIGGER trade_reservations_identity_immutable; UPDATE trade_reservations SET sequence = 41;',
      'DROP TRIGGER trade_reservations_forward_only; UPDATE trade_reservations SET state = \'settled\', settlement = \'expired\';',
      "DROP TRIGGER trade_reservations_identity_immutable; UPDATE trade_reservations SET evidence = replace(evidence, 'master-key', 'regular-key');",
      'DROP TRIGGER trade_reservations_no_delete; DELETE FROM trade_reservations;',
      // Under v2 the history's events are in the v2 table (the v1 table is frozen, empty for a new file).
      'DROP TRIGGER trade_anchored_events_v2_append_only_delete; DELETE FROM trade_anchored_events_v2;',
      // D-1: the intent behind the reservation.
      "DROP TRIGGER trade_anchored_events_v2_append_only_delete; DELETE FROM trade_anchored_events_v2 WHERE kind = 'intent';",
      "DROP TRIGGER trade_anchored_events_v2_append_only_delete; DELETE FROM trade_anchored_events_v2 WHERE kind = 'sign';",
      'DROP TRIGGER trade_intents_no_delete; DELETE FROM trade_intents;',
      'DROP TRIGGER trade_intents_identity_immutable; UPDATE trade_intents SET sequence = 41;',
      "DROP TRIGGER trade_intents_forward_only; UPDATE trade_intents SET state = 'expired';",
      "DROP TRIGGER trade_intents_identity_immutable; UPDATE trade_intents SET signing_preimage_digest = 'sha256:' || substr('0000000000000000000000000000000000000000000000000000000000000000', 1, 64);",
      'DROP TRIGGER trade_intent_transitions_append_only_delete; DELETE FROM trade_intent_transitions;',
      'DROP TRIGGER trade_intents_capability_once; UPDATE trade_intents SET capability_id = NULL;',
    ];
    for (const sql of tampers) {
      const copy = pathFor();
      copyFileSync(path, copy);
      const db = new Database(copy);
      db.exec(sql);
      db.close();
      // Verification tooling (no scope, no witness) reads the copy: refused.
      await assert.rejects(createSqliteTradeSequenceInterlock(copy, { now }), (error: { code?: string }) => error.code === 'TRADE_INTERLOCK_CORRUPT', sql);
    }
    // The untampered file verifies without a witness and writes nothing.
    const verifier = await createSqliteTradeSequenceInterlock(path, { now });
    assert.deepEqual(await verifier.verifyAll(), { records: 1, open: 1, intents: 1, openIntents: 0 });
    await assert.rejects(verifier.reserve(reservation(), 500), code('TRADE_INTERLOCK_INVALID'));
    await verifier.close();
  });

  it('never opened for execution without the witness, never created by verification', async () => {
    await assert.rejects(createSqliteTradeSequenceInterlock(pathFor(), { scope: SCOPE, sequenceAccounts: [OWNER], now }), /only under the CORE-07 freshness witness/);
    await assert.rejects(createSqliteTradeSequenceInterlock(pathFor(), { now }), /verification never creates one/);
    await assert.rejects(createSqliteTradeSequenceInterlock(pathFor(), { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 0 }, sequenceAccounts: [OWNER], now }), /non-mainnet/);
  });
});
