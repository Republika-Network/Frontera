import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { PAYMENT_BUSINESS_OPERATION_STATE_KIND, createSqlitePaymentBusinessOperationStore } from '../payment-protocol-ingress/sqlite-payment-business-operation-store.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { STORE_ORG, storeEntry, type StoreChallenge, type StoreTerms } from './pay04-protocol-support.js';

/**
 * PAY-04 layer E — the property the JavaScript event loop cannot prove:
 *
 * ```
 * genuinely parallel writers on one file can never fork a business operation
 * ```
 *
 * Worker threads, each with its own SQLite connection, released together from
 * a shared barrier and repeated. No Map, Promise cache or JS mutex is
 * involved: the primary key, the unique challenge-identity index and
 * `BEGIN IMMEDIATE` decide.
 */

const directories: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-pay04-race-'));
  directories.push(directory);
  return join(directory, 'payment-business-operations.sqlite');
}

interface Participant {
  readonly terms: StoreTerms;
  readonly challenge: StoreChallenge;
}

async function race(path: string, participants: readonly Participant[], witness?: StartedWitness): Promise<readonly string[]> {
  // Create the schema (and, anchored, the witnessed genesis) first, so every participant races on the write, not the DDL.
  const freshness = witness === undefined ? {} : { freshness: { boundary: await boundaryFor(witness, STORE_ORG) } };
  await (await createSqlitePaymentBusinessOperationStore(path, { now: () => '2026-09-24T12:00:00.000Z', ...freshness })).close();
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const pinned = witness === undefined ? {} : { witness: { endpoint: witness.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem } };
  const workers = participants.map((participant) => new Worker(join(__dirname, 'pay04-business-operation-concurrency-worker.js'), { workerData: { path, barrier, ...participant, ...pinned } }));
  const results = workers.map(
    (worker) =>
      new Promise<string>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (message: { kind: string; outcome?: string }) => {
          if (message.kind === 'ready') {
            ready += 1;
            if (ready === workers.length) {
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
            }
          } else if (message.kind === 'done') {
            resolve(message.outcome ?? '');
          }
        });
      }),
  );
  const outcomes = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  return outcomes;
}

function rows(path: string): { readonly operations: number; readonly challenges: number; readonly amounts: readonly string[] } {
  const db = new Database(path, { readonly: true });
  try {
    const operations = (db.prepare(`SELECT COUNT(*) AS n FROM payment_business_operations`).get() as { n: number }).n;
    const challenges = (db.prepare(`SELECT COUNT(*) AS n FROM payment_protocol_challenges`).get() as { n: number }).n;
    const amounts = (db.prepare(`SELECT amount_value AS value FROM payment_business_operations`).all() as { value: string }[]).map((row) => row.value);
    return { operations, challenges, amounts };
  } finally {
    db.close();
  }
}

const ROUNDS = 3;

describe('PAY-04 E — I8 / M29: the same operation, the same terms, raced across threads', () => {
  it('one operation, one challenge row, one governed request id; every writer told created|existing', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = freshPath();
      const outcomes = await race(path, Array.from({ length: 6 }, () => ({ terms: {}, challenge: { id: 'ch-a' } })));
      assert.equal(outcomes.filter((outcome) => outcome.startsWith('created:appended:1:')).length, 1, outcomes.join('\n'));
      assert.equal(outcomes.filter((outcome) => outcome.startsWith('existing:existing:1:')).length, 5, outcomes.join('\n'));
      assert.equal(new Set(outcomes.map((outcome) => outcome.split(':').slice(3).join(':'))).size, 1, 'one governed request id');
      assert.deepEqual(rows(path), { operations: 1, challenges: 1, amounts: ['10'] });
    }
  });
});

describe('PAY-04 E — I9: the same operation, 10 USD against 11 USD, raced', () => {
  it('exactly one semantic identity wins; every other writer conflicts; never two operations, never last-write-wins', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = freshPath();
      const participants = Array.from({ length: 6 }, (_, index) => ({ terms: { value: index % 2 === 0 ? '10' : '11' }, challenge: { id: `ch-${index}` } }));
      const outcomes = await race(path, participants);
      assert.equal(outcomes.filter((outcome) => outcome.startsWith('created:')).length, 1, outcomes.join('\n'));
      const { operations, amounts } = rows(path);
      assert.equal(operations, 1);
      for (const [index, outcome] of outcomes.entries()) {
        if (participants[index]?.terms.value === amounts[0]) assert.match(outcome, /^(created|existing):appended:/, outcome);
        else assert.equal(outcome, 'PAYMENT_BUSINESS_OPERATION_CONFLICT');
      }
    }
  });
});

describe('PAY-04 E — refreshed challenges and one challenge for two operations, raced', () => {
  it('two equivalent refreshed challenges are recorded under one operation at positions 1 and 2', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = freshPath();
      const outcomes = await race(path, [
        { terms: {}, challenge: { id: 'refresh-a', expires: '2026-09-24T12:05:00Z' } },
        { terms: {}, challenge: { id: 'refresh-b', expires: '2026-09-24T12:06:00Z' } },
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.split(':').slice(0, 3).join(':')).sort(), ['created:appended:1', 'existing:appended:2']);
      assert.deepEqual({ operations: rows(path).operations, challenges: rows(path).challenges }, { operations: 1, challenges: 2 });
    }
  });

  it('M30 raced: one challenge presented for two operations at once binds to exactly one', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = freshPath();
      const outcomes = await race(path, [
        { terms: { businessOperationId: 'bop-x' }, challenge: { id: 'shared' } },
        { terms: { businessOperationId: 'bop-y' }, challenge: { id: 'shared' } },
        { terms: { businessOperationId: 'bop-z', principalId: 'principal-b' }, challenge: { id: 'shared' } },
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.startsWith('created:appended:1:')).length, 1, outcomes.join('\n'));
      assert.equal(outcomes.filter((outcome) => outcome === 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT').length, 2, outcomes.join('\n'));
      assert.deepEqual({ operations: rows(path).operations, challenges: rows(path).challenges }, { operations: 1, challenges: 1 });
    }
  });

  it('a store reopened after a restart still converges on one operation under a race', async () => {
    const path = freshPath();
    const early = await createSqlitePaymentBusinessOperationStore(path, { now: () => '2026-09-24T12:00:00.000Z' });
    await early.record({ organizationId: STORE_ORG }, storeEntry({}, { id: 'before-restart' }));
    await early.close();
    const outcomes = await race(path, Array.from({ length: 4 }, (_, index) => ({ terms: {}, challenge: { id: `after-restart-${index}` } })));
    assert.equal(outcomes.every((outcome) => outcome.startsWith('existing:appended:')), true, outcomes.join('\n'));
    assert.deepEqual(outcomes.map((outcome) => outcome.split(':')[2]).sort(), ['2', '3', '4', '5']);
    assert.equal(rows(path).operations, 1);
  });
});

describe('PAY-04 hardening — anchored at the CORE-07 witness, raced across threads (F9 across processes)', () => {
  /** What the witness holds for the store's slot: its committed sequence, and whether a transition is still prepared. */
  async function witnessed(witness: StartedWitness): Promise<{ readonly sequence: number; readonly pending: boolean }> {
    const row = (await witnessRows(witness.databasePath)).find((entry) => entry['state_kind'] === PAYMENT_BUSINESS_OPERATION_STATE_KIND);
    return { sequence: Number(row?.['committed_sequence'] ?? -1), pending: row?.['pending_sequence'] !== null && row?.['pending_sequence'] !== undefined };
  }

  /** A participant that did not win either lost cleanly (a conflict decided by the store) or was refused by the witness before writing — never anything else. */
  const CLEAN_LOSS = /^(PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT|AUTHORITY_FRESHNESS_CONFLICT|AUTHORITY_FRESHNESS_PENDING_RECOVERY)$/;

  it('M30 raced, anchored: one challenge presented for three operations by three connections binds to at most one owner — exactly one ownership transition at the witness', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const witness = await startWitness();
      const path = freshPath();
      const outcomes = await race(
        path,
        [
          { terms: { businessOperationId: 'bop-x' }, challenge: { id: 'shared' } },
          { terms: { businessOperationId: 'bop-y' }, challenge: { id: 'shared' } },
          { terms: { businessOperationId: 'bop-z', principalId: 'principal-b' }, challenge: { id: 'shared' } },
        ],
        witness,
      );
      const winners = outcomes.filter((outcome) => outcome.startsWith('created:appended:1:'));
      assert.equal(winners.length, 1, outcomes.join('\n'));
      for (const outcome of outcomes) if (!winners.includes(outcome)) assert.match(outcome, CLEAN_LOSS);
      assert.deepEqual({ operations: rows(path).operations, challenges: rows(path).challenges }, { operations: 1, challenges: 1 });
      assert.deepEqual(await witnessed(witness), { sequence: 1, pending: false }, 'the witness saw exactly the one ownership the file holds');
      // And the file still opens: every connection's transition was a clean compare-and-advance, never a fork.
      await (await createSqlitePaymentBusinessOperationStore(path, { now: () => '2026-09-24T12:00:01.000Z', freshness: { boundary: await boundaryFor(witness, STORE_ORG) } })).close();
    }
  });

  it('refreshes raced, anchored: every accepted challenge is one witnessed transition; the file and the witness agree exactly', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const witness = await startWitness();
      const path = freshPath();
      const outcomes = await race(path, Array.from({ length: 4 }, (_, index) => ({ terms: {}, challenge: { id: `refresh-${index}` } })), witness);
      const accepted = outcomes.filter((outcome) => /^(created|existing):appended:/.test(outcome));
      for (const outcome of outcomes) if (!accepted.includes(outcome)) assert.match(outcome, CLEAN_LOSS);
      assert.ok(accepted.length >= 1, outcomes.join('\n'));
      assert.equal(outcomes.filter((outcome) => outcome.startsWith('created:')).length, 1, outcomes.join('\n'));
      assert.deepEqual({ operations: rows(path).operations, challenges: rows(path).challenges }, { operations: 1, challenges: accepted.length });
      assert.deepEqual(await witnessed(witness), { sequence: accepted.length, pending: false });
      await (await createSqlitePaymentBusinessOperationStore(path, { now: () => '2026-09-24T12:00:01.000Z', freshness: { boundary: await boundaryFor(witness, STORE_ORG) } })).close();
    }
  });
});
