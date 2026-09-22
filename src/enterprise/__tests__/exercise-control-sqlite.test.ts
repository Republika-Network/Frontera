import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { EXERCISE_CONTROL_REASON_CODES as X, createExerciseControlGate } from '../../features/exercise-control-runtime/index.js';
import {
  BINDING,
  at,
  amount,
  count,
  describeExerciseControlLedgerContract,
  reservation,
} from '../../features/exercise-control-runtime/tests/exercise-control-ledger-contract.js';
import {
  EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION,
  createSqliteExerciseControlLedger,
  isExerciseControlLedgerError,
  storedTerminalEventDigest,
} from '../exercise-control-ledger/index.js';

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

describeExerciseControlLedgerContract('SQLite exercise-control ledger', async () => {
  const ledger = await createSqliteExerciseControlLedger(freshPath());
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
    assert.match(plan(`SELECT DISTINCT reservation_id FROM exercise_control_reservation_limits WHERE limit_id = ? AND scope_key = ? AND reserved_at_ms > ?`, 'a', 'b', 0), /exercise_control_limits_by_bucket/);
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

    const beforeCrash = await createSqliteExerciseControlLedger(path);
    const abandonedLifetime = reservation({ executionId: 'crash-lifetime', limits: lifetime, reservedAt: at(0) });
    const abandonedRolling = reservation({ executionId: 'crash-rolling', limits: rolling, reservedAt: at(0) });
    await beforeCrash.reserve(abandonedLifetime);
    await beforeCrash.reserve(abandonedRolling);
    // The process ends here: no settle, no release, not even close().

    const afterCrash = await createSqliteExerciseControlLedger(path);
    assert.equal((await afterCrash.read(abandonedLifetime.reservationId))?.state, 'reserved');
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-1', limits: lifetime, reservedAt: at(3600 * 24 * 365) }))).outcome, 'refused', 'a lifetime bucket stays consumed indefinitely');
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-2', limits: rolling, reservedAt: at(30) }))).outcome, 'refused', 'inside the rolling window it still consumes');
    assert.equal((await afterCrash.reserve(reservation({ executionId: 'after-3', limits: rolling, reservedAt: at(61) }))).outcome, 'reserved', 'it ages out of the rolling window naturally');
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
    const gate = createExerciseControlGate({ policy: () => limits, authorityBinding: () => BINDING, reservationLedger: ledger, now: () => at(5) });
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
