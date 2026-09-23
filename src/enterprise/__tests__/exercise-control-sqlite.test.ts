import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { EXERCISE_CONTROL_REASON_CODES as X, createExerciseControlGate } from '../../features/exercise-control-runtime/index.js';
import {
  BINDING,
  at,
  amount,
  count,
  describeExerciseControlLedgerContract,
  manualClock,
  reservation,
} from '../../features/exercise-control-runtime/tests/exercise-control-ledger-contract.js';
import {
  EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
  createSqliteExerciseControlLedger,
  isExerciseControlLedgerError,
  storedTerminalEventDigest,
} from '../exercise-control-ledger/index.js';
import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';

/**
 * The production exercise-control ledger: the shared port contract, then the
 * properties only a durable store has — survival across close/reopen, crash
 * conservatism, integrity validation that fails closed, schema refusal before
 * mutation, and honest health.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-exercise-ledger-'));
  directories.push(directory);
  return join(directory, 'exercise-ledger.sqlite');
}

describeExerciseControlLedgerContract('SQLite exercise-control ledger', async (now) => {
  const ledger = await createSqliteExerciseControlLedger(freshPath(), { now });
  return { ledger, close: () => ledger.close() };
});

/** A raw writer on the same file, standing in for someone with filesystem access. The append-only triggers are dropped first, exactly as such a writer could. */
function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

async function corruptCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return isExerciseControlLedgerError(error) ? error.code : 'NOT_A_LEDGER_ERROR';
  }
}

describe('SQLite exercise-control ledger — §51 persistence', () => {
  it('1–4. reservations, settlements and releases survive close/reopen, and aggregates stay enforced after restart', async () => {
    const path = freshPath();
    const limits = [count('uses', 'grant:p', 2)];
    const settled = reservation({ executionId: 'p-settled', limits });
    const released = reservation({ executionId: 'p-released', limits });
    const pending = reservation({ executionId: 'p-pending', limits });

    const first = await createSqliteExerciseControlLedger(path);
    await first.reserve(settled);
    await first.settle({ reservationId: settled.reservationId, reason: 'executed', recordedAt: at(1) });
    await first.reserve(released);
    await first.release({ reservationId: released.reservationId, reason: 'execution-failed', recordedAt: at(2) });
    await first.reserve(pending);
    await first.close();

    const reopened = await createSqliteExerciseControlLedger(path);
    assert.equal((await reopened.read(settled.reservationId))?.state, 'settled');
    assert.equal((await reopened.read(released.reservationId))?.state, 'released');
    assert.equal((await reopened.read(pending.reservationId))?.state, 'reserved');
    const blocked = await reopened.reserve(reservation({ executionId: 'p-after-restart', limits }));
    assert.equal(blocked.outcome, 'refused', 'settled + pending = 2 of 2 — still enforced after restart');
    await reopened.close();
  });

  it('the durability pragmas are the ones the design depends on', async () => {
    const path = freshPath();
    const ledger = await createSqliteExerciseControlLedger(path);
    await ledger.close();
    const db = new Database(path);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.close();
    const source = readFileSync('src/enterprise/exercise-control-ledger/sqlite-exercise-control-ledger.ts', 'utf8');
    for (const pragma of ["db.pragma('foreign_keys = ON')", "db.pragma('journal_mode = WAL')", "db.pragma('synchronous = FULL')", 'busy_timeout']) assert.ok(source.includes(pragma), pragma);
  });

  it('the load-bearing lookups are indexed', async () => {
    const path = freshPath();
    await (await createSqliteExerciseControlLedger(path)).close();
    const db = new Database(path);
    const indexes = (db.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'`).all() as { name: string; tbl_name: string; sql: string | null }[]).map((row) => `${row.tbl_name}:${row.sql ?? row.name}`);
    const plan = (sql: string, ...params: unknown[]) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
    assert.ok(indexes.some((entry) => entry.includes('exercise_control_limits_by_bucket') && entry.includes('limit_id, scope_key, reserved_at_ms')));
    assert.ok(indexes.some((entry) => entry.includes('exercise_control_reservations_by_execution')));
    assert.match(plan(`SELECT DISTINCT reservation_id FROM exercise_control_reservation_limits WHERE limit_id = ? AND scope_key = ?`, 'a', 'b'), /exercise_control_limits_by_bucket/);
    assert.match(plan(`SELECT reservation_id FROM exercise_control_reservations WHERE execution_id = ?`, 'x'), /exercise_control_reservations_by_execution/);
    assert.match(plan(`SELECT * FROM exercise_control_terminal_events WHERE reservation_id = ?`, 'x'), /PRIMARY KEY|sqlite_autoindex/);
    db.close();
  });

  it('terminal events and reservations are append-only in the database itself', async () => {
    const path = freshPath();
    const ledger = await createSqliteExerciseControlLedger(path);
    const request = reservation({ executionId: 'append-only', limits: [count('a', 'b', 5)] });
    await ledger.reserve(request);
    await ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(1) });
    await ledger.close();
    const db = new Database(path);
    assert.throws(() => db.exec(`DELETE FROM exercise_control_terminal_events`), /append-only/);
    assert.throws(() => db.exec(`UPDATE exercise_control_terminal_events SET terminal_kind = 'settled'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM exercise_control_reservations`), /append-only/);
    assert.throws(() => db.exec(`UPDATE exercise_control_reservation_limits SET usage = '0'`), /append-only/);
    db.close();
  });
});

describe('SQLite exercise-control ledger — §46 crash conservatism', () => {
  it('a reservation left without a terminal event keeps consuming after restart; no startup cleanup releases it', async () => {
    const path = freshPath();
    const lifetime = [count('lifetime', 'grant:crash', 1)];
    const rolling = [count('rolling', 'grant:crash', 1, { kind: 'rolling', seconds: 60 })];

    const clock = manualClock(at(0));
    const beforeCrash = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const abandonedLifetime = reservation({ executionId: 'crash-lifetime', limits: lifetime });
    const abandonedRolling = reservation({ executionId: 'crash-rolling', limits: rolling });
    await beforeCrash.reserve(abandonedLifetime);
    await beforeCrash.reserve(abandonedRolling);
    // The process ends here: no settle, no release, not even close().

    const afterCrash = await createSqliteExerciseControlLedger(path, { now: clock.now });
    assert.equal((await afterCrash.read(abandonedLifetime.reservationId))?.state, 'reserved');
    clock.set(at(3600 * 24 * 365));
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-1', limits: lifetime }))).outcome, 'refused', 'a lifetime bucket stays consumed indefinitely');
    clock.set(at(30));
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-2', limits: rolling }))).outcome, 'refused', 'inside the rolling window it still consumes');
    clock.set(at(61));
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-3', limits: rolling }))).outcome, 'reserved', 'it ages out of the rolling window naturally');
    assert.equal((await afterCrash.read(abandonedRolling.reservationId))?.state, 'reserved', 'aging out is not a release: the row is untouched');
    await afterCrash.close();
    await beforeCrash.close();
  });
});

describe('SQLite exercise-control ledger — §51 corruption fails closed, never repaired', () => {
  async function seeded(): Promise<{ readonly path: string; readonly id: string; readonly limits: ReturnType<typeof count>[] }> {
    const path = freshPath();
    const limits = [count('uses', 'grant:c', 5)];
    const ledger = await createSqliteExerciseControlLedger(path);
    const request = reservation({ executionId: 'seeded', limits });
    await ledger.reserve(request);
    await ledger.close();
    return { path, id: request.reservationId, limits };
  }

  const cases: readonly (readonly [string, (id: string) => readonly string[]])[] = [
    ['5. a modified reservation digest', (id) => [`UPDATE exercise_control_reservations SET record_digest = 'sha256:${'0'.repeat(64)}' WHERE reservation_id = '${id}'`]],
    ['5b. a modified reservation field under an intact digest', (id) => [`UPDATE exercise_control_reservations SET authority_binding_digest = 'sha256:${'9'.repeat(64)}' WHERE reservation_id = '${id}'`]],
    ['6. a modified rule row (usage lowered)', (id) => [`UPDATE exercise_control_reservation_limits SET usage = '0' WHERE reservation_id = '${id}'`]],
    ['6b. a modified rule row (maximum raised)', (id) => [`UPDATE exercise_control_reservation_limits SET maximum = '5000' WHERE reservation_id = '${id}'`]],
    ['6c. a rule row moved to another bucket', (id) => [`UPDATE exercise_control_reservation_limits SET scope_key = 'grant:elsewhere' WHERE reservation_id = '${id}'`]],
    ['7. a missing rule row', (id) => [`DELETE FROM exercise_control_reservation_limits WHERE reservation_id = '${id}'`]],
    ['7b. a whole reservation deleted with its rule rows', (id) => [`DELETE FROM exercise_control_reservation_limits WHERE reservation_id = '${id}'`, `DELETE FROM exercise_control_reservations WHERE reservation_id = '${id}'`]],
    ['7c. a bucket head edited without re-sealing', () => [`UPDATE exercise_control_bucket_heads SET rule_row_count = 0`]],
    ['8. a forged terminal event with no valid digest', (id) => [`INSERT INTO exercise_control_terminal_events VALUES ('${id}', 'released', 'execution-failed', '${at(1)}', 'sha256:${'1'.repeat(64)}', '${at(1)}', '${EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION}')`]],
    ['8b. a terminal event whose reason is outside its kind', (id) => [`INSERT INTO exercise_control_terminal_events VALUES ('${id}', 'released', 'executed', '${at(1)}', '${storedTerminalEventDigest({ reservationId: id, kind: 'released', reason: 'executed' as never, recordedAt: at(1) })}', '${at(1)}', '${EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION}')`]],
    ['unrecognized record schema version', (id) => [`UPDATE exercise_control_reservations SET schema_version = 'aoc.exercise-control-ledger.schema.v0' WHERE reservation_id = '${id}'`]],
    ['a reservation instant that disagrees with its indexed column', (id) => [`UPDATE exercise_control_reservations SET reserved_at_ms = reserved_at_ms - 1 WHERE reservation_id = '${id}'`]],
  ];

  for (const [label, statements] of cases) {
    it(`${label} → the next admission against that bucket fails closed; nothing is repaired`, async () => {
      const { path, id, limits } = await seeded();
      tamper(path, statements(id));
      const ledger = await createSqliteExerciseControlLedger(path);
      // Reading the damaged reservation refuses — where the reservation itself
      // was damaged. (A wholly deleted reservation is simply absent, and an
      // edited bucket head damages the bucket, not the reservation.)
      if (!label.startsWith('7b.') && !label.startsWith('7c.')) assert.equal(await corruptCode(() => ledger.read(id)), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT');
      // Admission against the bucket refuses too. A deleted or re-bucketed
      // rule row is caught by the bucket's sealed head; every other edit by the
      // row's own validation the moment the bucket reads it.
      assert.equal(await corruptCode(() => ledger.reserve(reservation({ executionId: `after-${label}`, limits }))), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT', label);
      if (label.startsWith('6c.')) {
        assert.equal(await corruptCode(() => ledger.reserve(reservation({ executionId: 'probe', limits: [count('uses', 'grant:elsewhere', 5)] }))), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT', 'the destination bucket fails closed too');
      }
      await ledger.close();
    });
  }

  it('9. a conflicting terminal state (settled rewritten to released) fails closed', async () => {
    const { path, id, limits } = await seeded();
    const ledger = await createSqliteExerciseControlLedger(path);
    await ledger.settle({ reservationId: id, reason: 'executed', recordedAt: at(1) });
    await ledger.close();
    tamper(path, [`UPDATE exercise_control_terminal_events SET terminal_kind = 'released', reason = 'execution-failed' WHERE reservation_id = '${id}'`]);
    const reopened = await createSqliteExerciseControlLedger(path);
    assert.equal(await corruptCode(() => reopened.reserve(reservation({ executionId: 'after-flip', limits }))), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT', 'a forged release does not free capacity');
    await reopened.close();
  });

  it('13. no silent repair: the damaged row is exactly as the tamper left it after a refused admission', async () => {
    const { path, id, limits } = await seeded();
    tamper(path, [`UPDATE exercise_control_reservation_limits SET usage = '0' WHERE reservation_id = '${id}'`]);
    const ledger = await createSqliteExerciseControlLedger(path);
    await corruptCode(() => ledger.reserve(reservation({ executionId: 'repair?', limits })));
    await ledger.close();
    const db = new Database(path);
    assert.equal((db.prepare(`SELECT usage FROM exercise_control_reservation_limits WHERE reservation_id = ?`).get(id) as { usage: string }).usage, '0');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM exercise_control_reservations`).get() as { n: number }).n, 1, 'nothing was written');
    db.close();
  });

  it('through the gate, a corrupt ledger withholds as unavailable', async () => {
    const { path, id, limits } = await seeded();
    tamper(path, [`UPDATE exercise_control_reservation_limits SET usage = '0' WHERE reservation_id = '${id}'`]);
    const ledger = await createSqliteExerciseControlLedger(path);
    const gate = createExerciseControlGate({ actionClassifier: createFinancialActionClassifier({ financialActions: [] }), policy: () => limits, authorityBinding: () => BINDING, reservationLedger: ledger, now: () => at(5) });
    const admission = await gate.admit({
      grant: { id: 'aoc.grant:contract', subject: 'agent-A', issuedAt: at(-60), expiresAt: at(600), correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment', resourceScope: 'vendor/V123' }, authorityBindingDigest: BINDING },
      attempt: { action: 'payment', resource: 'vendor/V123' },
      executionId: 'through-gate',
      at: at(5),
    });
    assert.deepEqual(admission, { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_LEDGER_UNAVAILABLE] });
    await ledger.close();
  });
});

describe('SQLite exercise-control ledger — §51 schema, closure and health', () => {
  it('10. an unknown schema version is refused at open, before anything is mutated', async () => {
    const path = freshPath();
    await (await createSqliteExerciseControlLedger(path)).close();
    const db = new Database(path);
    db.prepare(`INSERT INTO exercise_control_ledger_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.exercise-control-ledger.schema.v9', 'current', ?)`).run(at(0));
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get() as { n: number }).n;
    db.close();
    await assert.rejects(createSqliteExerciseControlLedger(path), (error: unknown) => isExerciseControlLedgerError(error) && error.code === 'EXERCISE_CONTROL_LEDGER_UNAVAILABLE');
    const after = new Database(path);
    assert.equal((after.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get() as { n: number }).n, before, 'no table, index or trigger was created');
    assert.equal((after.prepare(`SELECT schema_version FROM exercise_control_ledger_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string }).schema_version, 'aoc.exercise-control-ledger.schema.v9');
    after.close();
  });

  it('11–12. a closed ledger refuses reads and writes, and health reports it', async () => {
    const ledger = await createSqliteExerciseControlLedger(freshPath());
    const healthy = await ledger.health();
    assert.deepEqual({ status: healthy.status, readable: healthy.readable, writable: healthy.writable, schemaVersion: healthy.schemaVersion }, { status: 'healthy', readable: true, writable: true, schemaVersion: EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION });
    await ledger.close();
    const request = reservation({ executionId: 'closed', limits: [count('a', 'b', 1)] });
    for (const run of [() => ledger.reserve(request), () => ledger.read(request.reservationId), () => ledger.settle({ reservationId: request.reservationId, reason: 'executed', recordedAt: at(1) }), () => ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(1) })]) {
      assert.equal(await corruptCode(run), 'EXERCISE_CONTROL_LEDGER_UNAVAILABLE');
    }
    const unhealthy = await ledger.health();
    assert.deepEqual({ status: unhealthy.status, readable: unhealthy.readable, writable: unhealthy.writable }, { status: 'unhealthy', readable: false, writable: false });
  });

  it('refuses an empty path and an out-of-bounds busy timeout at open', async () => {
    await assert.rejects(createSqliteExerciseControlLedger(''));
    await assert.rejects(createSqliteExerciseControlLedger(freshPath(), { busyTimeoutMs: 0 }));
    await assert.rejects(createSqliteExerciseControlLedger(freshPath(), { busyTimeoutMs: 600_000 }));
  });

  it('§14. amounts are stored as exact decimal text, and no SQL SUM is load-bearing', async () => {
    const path = freshPath();
    const ledger = await createSqliteExerciseControlLedger(path);
    await ledger.reserve(reservation({ executionId: 'text', limits: [amount('spend', 'grant:t', '0.3', 'USD')], amount: { value: '0.1', unit: 'USD' } }));
    await ledger.close();
    const db = new Database(path);
    const row = db.prepare(`SELECT usage, typeof(usage) AS kind, maximum, typeof(maximum) AS maxKind FROM exercise_control_reservation_limits`).get() as { usage: string; kind: string; maximum: string; maxKind: string };
    assert.deepEqual(row, { usage: '0.1', kind: 'text', maximum: '0.3', maxKind: 'text' });
    db.close();
    const source = readFileSync('src/enterprise/exercise-control-ledger/sqlite-exercise-control-ledger.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/\b(SUM|TOTAL|AVG)\s*\(/i.test(source.replace(/\/\/.*$/gm, '')), false);
    assert.equal(/\bREAL\b/.test(source), false, 'no floating column');
  });
});

describe('SQLite exercise-control ledger — the reservation instant is sampled inside BEGIN IMMEDIATE', () => {
  it('reserved_at, reserved_at_ms and every rule row reserved_at_ms are the ledger clock instant, not any caller instant', async () => {
    const path = freshPath();
    const clock = manualClock(at(5));
    const ledger = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const request = reservation({ executionId: 'persisted-instant', limits: [count('a', 'grant:pi', 5, { kind: 'rolling', seconds: 60 }), count('b', 'grant:pi', 5)] });
    const outcome = await ledger.reserve(request);
    assert.equal(outcome.outcome === 'reserved' ? outcome.reservation.reservedAt : undefined, at(5));
    await ledger.close();
    const db = new Database(path);
    const row = db.prepare(`SELECT reserved_at, reserved_at_ms FROM exercise_control_reservations WHERE reservation_id = ?`).get(request.reservationId) as { reserved_at: string; reserved_at_ms: number };
    assert.deepEqual(row, { reserved_at: at(5), reserved_at_ms: Date.parse(at(5)) });
    const rules = db.prepare(`SELECT reserved_at_ms FROM exercise_control_reservation_limits WHERE reservation_id = ?`).all(request.reservationId) as { reserved_at_ms: number }[];
    assert.deepEqual(rules, [{ reserved_at_ms: Date.parse(at(5)) }, { reserved_at_ms: Date.parse(at(5)) }]);
    db.close();
  });

  it('a clock that does not answer an instant fails admission closed and writes nothing', async () => {
    const path = freshPath();
    let answer = at(0);
    const ledger = await createSqliteExerciseControlLedger(path, { now: () => answer });
    answer = 'not-an-instant';
    const request = reservation({ executionId: 'bad-clock', limits: [count('a', 'grant:bc', 5)] });
    assert.equal(await corruptCode(() => ledger.reserve(request)), 'EXERCISE_CONTROL_LEDGER_UNAVAILABLE');
    answer = at(1);
    assert.equal(await ledger.read(request.reservationId), undefined);
    await ledger.close();
  });

  it('a real write-lock wait: the reservation instant is taken after the lock is acquired, so the rolling window starts then', async () => {
    const path = freshPath();
    // The wall clock, read by both the "assessment" here and the ledger.
    const now = (): string => new Date().toISOString();
    const ledger = await createSqliteExerciseControlLedger(path, { now, busyTimeoutMs: 10_000 });
    const holdMs = 600;
    // Another connection, on another thread, holds the write lock.
    const holder = new Worker(join(__dirname, 'exercise-control-lock-holder-worker.js'), { workerData: { path, holdMs } });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('message', () => resolve());
    });
    const assessedAt = now();
    const request = reservation({ executionId: 'lock-wait', limits: [count('lw', 'grant:lw', 1, { kind: 'rolling', seconds: 1 })] });
    const outcome = await ledger.reserve(request);
    await exited;
    assert.equal(outcome.outcome, 'reserved');
    const reservedAt = outcome.outcome === 'reserved' ? outcome.reservation.reservedAt : assessedAt;
    const waited = Date.parse(reservedAt) - Date.parse(assessedAt);
    assert.ok(waited >= holdMs - 150, `the reservation instant is after the lock wait (waited ${String(waited)} ms of ${String(holdMs)})`);
    assert.equal((await ledger.read(request.reservationId))?.reservation.reservedAt, reservedAt, 'and it is the instant persisted');
    await ledger.close();
  });
});

describe('SQLite exercise-control ledger — rolling admission verifies before it filters', () => {
  const rolling = [count('velocity', 'grant:rv', 1, { kind: 'rolling', seconds: 60 })];

  it('a rule row whose reserved_at_ms alone is moved backwards out of the window, without re-sealing, fails admission closed', async () => {
    const path = freshPath();
    const clock = manualClock(at(0));
    const seeded = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const live = reservation({ executionId: 'live', limits: rolling });
    assert.equal((await seeded.reserve(live)).outcome, 'reserved');
    await seeded.close();

    const before = new Database(path, { readonly: true });
    const original = before.prepare(`SELECT reserved_at_ms, rule_digest FROM exercise_control_reservation_limits WHERE reservation_id = ?`).get(live.reservationId) as { reserved_at_ms: number; rule_digest: string };
    const heads = before.prepare(`SELECT * FROM exercise_control_bucket_heads`).all();
    before.close();

    // ONLY the rule row's indexed instant, a day backwards; no digest touched.
    const moved = original.reserved_at_ms - 86_400_000;
    tamper(path, [`UPDATE exercise_control_reservation_limits SET reserved_at_ms = ${String(moved)} WHERE reservation_id = '${live.reservationId}'`]);

    clock.set(at(10));
    const ledger = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const attempt = reservation({ executionId: 'after-backdate', limits: rolling });
    assert.equal(await corruptCode(() => ledger.reserve(attempt)), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT', 'the backdated row is verified, not skipped');
    await ledger.close();

    const after = new Database(path, { readonly: true });
    assert.equal((after.prepare(`SELECT COUNT(*) AS n FROM exercise_control_reservations`).get() as { n: number }).n, 1, 'no new reservation');
    assert.equal(after.prepare(`SELECT 1 FROM exercise_control_reservations WHERE reservation_id = ?`).get(attempt.reservationId), undefined);
    const row = after.prepare(`SELECT reserved_at_ms, rule_digest FROM exercise_control_reservation_limits WHERE reservation_id = ?`).get(live.reservationId) as { reserved_at_ms: number; rule_digest: string };
    assert.deepEqual(row, { reserved_at_ms: moved, rule_digest: original.rule_digest }, 'the corrupted row is not repaired');
    assert.deepEqual(after.prepare(`SELECT * FROM exercise_control_bucket_heads`).all(), heads, 'the bucket head is unchanged');
    after.close();
  });

  it('through the gate, the backdated row withholds as unavailable: no reservation, so no adapter', async () => {
    const path = freshPath();
    const clock = manualClock(at(0));
    const seeded = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const live = reservation({ executionId: 'gate-live', limits: rolling });
    await seeded.reserve(live);
    await seeded.close();
    tamper(path, [`UPDATE exercise_control_reservation_limits SET reserved_at_ms = reserved_at_ms - 86400000 WHERE reservation_id = '${live.reservationId}'`]);
    clock.set(at(10));
    const ledger = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const gate = createExerciseControlGate({ actionClassifier: createFinancialActionClassifier({ financialActions: [] }), policy: () => rolling, authorityBinding: () => BINDING, reservationLedger: ledger, now: clock.now });
    const admission = await gate.admit({
      grant: { id: 'aoc.grant:contract', subject: 'agent-A', issuedAt: at(-60), expiresAt: at(600), correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment', resourceScope: 'vendor/V123' }, authorityBindingDigest: BINDING },
      attempt: { action: 'payment', resource: 'vendor/V123' },
      executionId: 'gate-after-backdate',
      at: at(10),
    });
    assert.deepEqual(admission, { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_LEDGER_UNAVAILABLE] });
    await ledger.close();
  });

  it('a legitimate old VERIFIED reservation is verified and then simply filtered out by the rolling window', async () => {
    const path = freshPath();
    const clock = manualClock(at(0));
    const ledger = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const old = reservation({ executionId: 'old', limits: rolling });
    assert.equal((await ledger.reserve(old)).outcome, 'reserved');
    await ledger.settle({ reservationId: old.reservationId, reason: 'executed', recordedAt: at(1) });
    clock.set(at(3600));
    assert.equal((await ledger.reserve(reservation({ executionId: 'new', limits: rolling }))).outcome, 'reserved', 'the verified old reservation is outside the window');
    clock.set(at(3601));
    assert.equal((await ledger.reserve(reservation({ executionId: 'newer', limits: rolling }))).outcome, 'refused', 'the new one is inside it');
    assert.equal((await ledger.read(old.reservationId))?.state, 'settled', 'aging out is not a release');
    await ledger.close();
  });

  it('an old reservation outside the window is still verified: an unsealed edit to it fails the rolling bucket closed', async () => {
    const path = freshPath();
    const clock = manualClock(at(0));
    const seeded = await createSqliteExerciseControlLedger(path, { now: clock.now });
    const old = reservation({ executionId: 'old-edited', limits: rolling });
    await seeded.reserve(old);
    await seeded.close();
    tamper(path, [`UPDATE exercise_control_reservation_limits SET maximum = '5000' WHERE reservation_id = '${old.reservationId}'`]);
    clock.set(at(3600));
    const ledger = await createSqliteExerciseControlLedger(path, { now: clock.now });
    assert.equal(await corruptCode(() => ledger.reserve(reservation({ executionId: 'probe-old', limits: rolling }))), 'EXERCISE_CONTROL_LEDGER_STATE_CORRUPT');
    await ledger.close();
  });

  it('the bucket scan is not range-filtered on the unverified timestamp column', () => {
    const source = readFileSync('src/enterprise/exercise-control-ledger/sqlite-exercise-control-ledger.ts', 'utf8');
    assert.equal(/reserved_at_ms\s*>/.test(source), false, 'no SQL predicate on reserved_at_ms may choose which rows are verified');
    assert.equal(source.includes('selectBucketSince'), false);
  });
});
