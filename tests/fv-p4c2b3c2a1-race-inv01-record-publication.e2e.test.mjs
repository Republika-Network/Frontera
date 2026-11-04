// FV-P4C-2B3C-2A1-RACE-INV-01 — the FV registration record is published complete, and its exclusive lock has one
// winner. Two defects made concurrent registrations fail (CI on main `cded5c80`: REGISTRAR_BUSY + RECORD_CORRUPT):
//  - D1: the record was created (O_EXCL) at its path before it was initialized. A ceremony that lost or tied the lock,
//    or died, left an uninitialized file there, which every later registration refused as corrupt, forever.
//  - D2: the lock was taken in exclusive locking mode with no wait. Two openers both took SHARED; neither could escalate
//    (exclusive mode releases nothing, even after a failed attempt), so both were refused.
// Real code; other processes hold real SQLite locks (POSIX locks are per process, as in production). Synthetic data only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, linkSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { openFvRegistrationRecord } from '../dist/src/enterprise/sovereign-status-history/identity-registration-record.js';
import { registerFvIdentity } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { FV_DOMAIN, bindingFor, own, registerRequest, registrarOptions, registrationWorld, removeOwnedDirectories } from './fv-p4c2b3c2a-support.mjs';

after(async () => {
  await closeAllWitnesses();
  removeOwnedDirectories();
});
/**
 * A real record opener in its own process (the file policy and exclusivity are per process). It loads everything, reports
 * `ready`, and calls the opener on a `go` line (so contenders start together); it reports `opening` immediately before the
 * call, then its outcome with the time it acquired; an opened record is held until stdin ends.
 */
function openerProcess(file, org) {
  const code = `
    const Database = require(${JSON.stringify(SQLITE)});
    void Database;
    import(${JSON.stringify(RECORD_MODULE)}).then(async ({ openFvRegistrationRecord }) => {
      process.stdout.write('ready\\n');
      let input = '';
      await new Promise((go) => { const onData = (chunk) => { input += chunk; if (input.includes('go\\n')) { process.stdin.off('data', onData); go(); } }; process.stdin.on('data', onData); process.stdin.resume(); });
      process.stdout.write('opening\\n');
      const startedAt = Date.now();
      try {
        const record = await openFvRegistrationRecord(${JSON.stringify(file)}, { organizationId: ${JSON.stringify(org)}, now: () => new Date().toISOString(), create: false });
        process.stdout.write(JSON.stringify({ outcome: 'opened', waitedMs: Date.now() - startedAt, at: Date.now() }) + '\\n');
        process.stdin.on('end', () => { record.close(); process.exit(0); });
        process.stdin.resume();
      } catch (error) {
        process.stdout.write(JSON.stringify({ outcome: error.code ?? String(error), message: String(error.message), waitedMs: Date.now() - startedAt }) + '\\n');
        process.exit(0);
      }
    });`;
  return lineProcess(code);
}
function lineProcess(code) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  const waiters = [];
  const exited = new Promise((done) => child.on('exit', done));
  child.stdout.on('data', (chunk) => {
    out += chunk;
    waiters.splice(0).forEach((wake) => wake());
  });
  const line = async (accept) => {
    for (;;) {
      const found = out.split('\n').find((l) => l !== '' && accept(l));
      if (found !== undefined) return found;
      await new Promise((wake) => waiters.push(wake));
    }
  };
  return { line, send: (text) => child.stdin.write(text), release: () => child.stdin.end(), exited };
}
const RECORD_MODULE = new URL('../dist/src/enterprise/sovereign-status-history/identity-registration-record.js', import.meta.url).href;
const SQLITE = createRequire(import.meta.url).resolve('better-sqlite3');
const now = () => new Date().toISOString();
const started = async () => {
  const witness = await startWitness();
  own(witness.directory);
  return witness;
};
const register = (world, witness) => registerFvIdentity(registrarOptions(world, witness), registerRequest(bindingFor(world, witness)).request);
const privateNames = (world) => readdirSync(world.dir).filter((name) => name.includes('.init-'));
async function initializedRecord(world) {
  (await openFvRegistrationRecord(world.paths.record, { organizationId: world.org, now, create: true })).close();
}

/**
 * Another process holding a raw SQLite lock on `file` (`shared`: a read transaction; `exclusive`), released when its stdin
 * ends or after `releaseAfterMs`. Separate processes: POSIX locks belong to a whole process, as in production.
 */
function holderProcess(file, { lock, releaseAfterMs }) {
  const code = `
    const Database = require(${JSON.stringify(SQLITE)});
    const db = new Database(${JSON.stringify(file)}, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    if (${JSON.stringify(lock)} === 'shared') { db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM sqlite_master').get(); } else { db.exec('BEGIN EXCLUSIVE'); }
    process.stdout.write('held\\n');
    const release = () => { db.exec('COMMIT'); db.close(); process.stdout.write('released\\n'); process.exit(0); };
    if (${JSON.stringify(releaseAfterMs ?? null)} !== null) setTimeout(release, ${JSON.stringify(releaseAfterMs ?? 0)});
    process.stdin.on('end', release);
    process.stdin.resume();`;
  return lineProcess(code);
}
/**
 * Another process that holds the record's RESERVED lock (a pending write), reports `held`, and on a `commit` line tries to
 * COMMIT within `commitWaitMs` — which needs every SHARED lock gone. It reports the outcome and how long it took.
 */
function writerProcess(file, { commitWaitMs }) {
  const code = `
    const Database = require(${JSON.stringify(SQLITE)});
    const db = new Database(${JSON.stringify(file)}, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO fv_registration_events (at, kind, detail) VALUES ('2026-01-01T00:00:00.000Z', 'race-inv01-probe', '{}')").run();
    process.stdout.write('held\\n');
    let input = '';
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('commit\\n')) return;
      db.pragma('busy_timeout = ' + ${JSON.stringify(commitWaitMs)});
      const startedAt = Date.now();
      let outcome = 'committed';
      try { db.exec('COMMIT'); } catch (error) { outcome = error.code ?? String(error); try { db.exec('ROLLBACK'); } catch {} }
      process.stdout.write(JSON.stringify({ outcome, tookMs: Date.now() - startedAt }) + '\\n');
      db.close();
      process.exit(0);
    });
    process.stdin.resume();`;
  return lineProcess(code);
}
const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

describe('FV-P4C-2B3C-2A1-RACE-INV-01 — the registration record is published complete; its lock has one winner', () => {
  it('D1: a new record is initialized under a private name and published complete — nothing stands at the record path meanwhile, and no private name remains', async () => {
    const world = registrationWorld();
    const opening = openFvRegistrationRecord(world.paths.record, { organizationId: world.org, now, create: true });
    // Synchronously after the call: before the fix, the empty O_EXCL file already stood at the record path here.
    const visibleWhileCreating = existsSync(world.paths.record);
    const record = await opening;
    const stat = lstatSync(world.paths.record);
    record.close();
    assert.deepEqual([visibleWhileCreating, stat.nlink, stat.mode & 0o777, privateNames(world)], [false, 1, 0o600, []]);
  });

  it('D2: two openers contending while another connection holds the record: exactly one acquires it promptly once released, the other is refused BUSY — never both', async () => {
    const world = registrationWorld();
    await initializedRecord(world);
    const reader = holderProcess(world.paths.record, { lock: 'shared' });
    await reader.line((l) => l === 'held');
    const openers = [openerProcess(world.paths.record, world.org), openerProcess(world.paths.record, world.org)];
    await Promise.all(openers.map((o) => o.line((l) => l === 'ready')));
    // Started together (review F1/F2: no start skew), both contend inside SQLite for the lock the reader's SHARED lock
    // blocks; then the reader releases.
    openers.forEach((o) => o.send('go\n'));
    await Promise.all(openers.map((o) => o.line((l) => l === 'opening')));
    await sleep(50);
    reader.release();
    await reader.line((l) => l === 'released');
    const releasedAt = Date.now();
    const outcomes = await Promise.all(openers.map(async (o) => JSON.parse(await o.line((l) => l.startsWith('{')))));
    openers.forEach((o) => o.release());
    await Promise.all([reader, ...openers].map((o) => o.exited));
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ['BUSY', 'opened'], JSON.stringify(outcomes));
    // Promptly: the losing contender released what it took at once (normal locking mode while acquiring), so the winner
    // acquired soon after the reader let go — not only after the other contender's whole wait ran out, which is how
    // two openers starting together both ran out of time and were both refused.
    assert.ok(outcomes.find((o) => o.outcome === 'opened').at - releasedAt < 300, JSON.stringify({ releasedAt, outcomes }));
  });

  it('D2 (deterministic): an opener waiting for the lock holds nothing while it waits — a writer holding RESERVED still commits (exclusive mode is set only once the lock is held)', async () => {
    const world = registrationWorld();
    await initializedRecord(world);
    const writer = writerProcess(world.paths.record, { commitWaitMs: 250 });
    await writer.line((l) => l === 'held');
    const opener = openerProcess(world.paths.record, world.org);
    await opener.line((l) => l === 'ready');
    opener.send('go\n');
    await opener.line((l) => l === 'opening');
    // The opener is now inside its bounded wait (500 ms), blocked by the writer's RESERVED lock. In normal locking mode
    // each failed attempt releases its SHARED lock, so the writer's COMMIT (which needs every SHARED lock gone) succeeds.
    // Had exclusive mode been set first, the waiting opener would keep SHARED for its whole wait and the COMMIT would fail.
    await sleep(100);
    writer.send('commit\n');
    const committed = JSON.parse(await writer.line((l) => l.startsWith('{')));
    const opened = JSON.parse(await opener.line((l) => l.startsWith('{')));
    opener.release();
    await Promise.all([writer.exited, opener.exited]);
    assert.equal(committed.outcome, 'committed', JSON.stringify({ committed, opened }));
    // Once the writer committed, the waiting opener acquired within its bound.
    assert.equal(opened.outcome, 'opened', JSON.stringify({ committed, opened }));
  });

  it('D2: the wait is bounded — a record released within it is acquired; one held past it is refused BUSY', async () => {
    const world = registrationWorld();
    await initializedRecord(world);
    const holder = holderProcess(world.paths.record, { lock: 'exclusive', releaseAfterMs: 150 });
    await holder.line((l) => l === 'held');
    // Held by another process for 150 ms: this opener waits, then acquires.
    const record = await openFvRegistrationRecord(world.paths.record, { organizationId: world.org, now, create: false });
    await holder.exited;
    // Now this process holds it, for good: another process's opener waits its bound, then is refused.
    const other = openerProcess(world.paths.record, world.org);
    await other.line((l) => l === 'ready');
    other.send('go\n');
    await other.line((l) => l === 'opening');
    const startedAt = Date.now();
    const outcome = JSON.parse(await other.line((l) => l.startsWith('{')));
    const waited = Date.now() - startedAt;
    other.release();
    await other.exited;
    record.close();
    assert.equal(outcome.outcome, 'BUSY', JSON.stringify(outcome));
    assert.ok(waited >= 400 && waited < 5_000, `waited ${waited} ms`);
  });

  it('an interrupted publication never leaves a path that refuses forever: a private file alone, or a second (private) name of the record, is released and a registration succeeds', async () => {
    const witness = await started();
    // Killed before publishing: an unused private file beside an absent record path.
    const first = registrationWorld();
    closeSync(openSync(join(first.dir, 'fv-registration.sqlite.init-' + 'a'.repeat(32)), 'wx', 0o600));
    assert.equal((await register(first, witness)).outcome, 'registered');
    // Killed between link and the removal of the private name: the record has two names.
    const second = registrationWorld({ org: `${first.org}-b` });
    await initializedRecord(second);
    const privateName = `${second.paths.record}.init-${'b'.repeat(32)}`;
    linkSync(second.paths.record, privateName);
    assert.equal(lstatSync(second.paths.record).nlink, 2);
    const outcome = await register(second, witness);
    assert.deepEqual([outcome.outcome, existsSync(privateName), lstatSync(second.paths.record).nlink], ['registered', false, 1], JSON.stringify(outcome));
    assert.equal((await witnessRows(witness.databasePath)).filter((r) => r.state_kind === FV_DOMAIN).length, 2);
  });

  it('anything else at the record path stays refused, never adopted: an empty file (RECORD_CORRUPT), a second name that is not a publication’s (PATH_REFUSED); nothing consumed, nothing anchored', async () => {
    const witness = await started();
    const empty = registrationWorld();
    closeSync(openSync(empty.paths.record, 'wx', 0o600));
    const refusedEmpty = await register(empty, witness);
    const other = registrationWorld({ org: `${empty.org}-c` });
    await initializedRecord(other);
    linkSync(other.paths.record, join(other.dir, 'fv-registration.sqlite.backup'));
    const refusedLinked = await register(other, witness);
    assert.deepEqual(
      [refusedEmpty.outcome, refusedEmpty.reason, refusedLinked.outcome, refusedLinked.reason],
      ['refused', 'RECORD_CORRUPT', 'refused', 'PATH_REFUSED'],
      JSON.stringify([refusedEmpty, refusedLinked]),
    );
    assert.deepEqual([existsSync(empty.paths.ledger), existsSync(empty.paths.store), existsSync(other.paths.ledger), existsSync(other.paths.store)], [false, false, false, false]);
    assert.deepEqual(await witnessRows(witness.databasePath), []);
  });
});
