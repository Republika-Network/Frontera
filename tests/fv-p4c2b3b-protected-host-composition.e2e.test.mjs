// FV-P4C-2B3B — the protected FV Host composition, adversarially: real AUTH-03 (software passkeys), real
// SQLite histories, the real protected store, the real receiver package and the real coordinator, with
// real second processes for contention and real SIGKILL crashes at exact points. Synthetic principals,
// statuses, sources and databases, all under the OS temporary directory. The status source is a
// synthetic test provider: no trusted issuer-currentness source exists in the Host (B6).
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import * as fvIndex from '../dist/src/enterprise/sovereign-status-history/index.js';
import { checkProtectedFile, confirmExclusivelyHeld } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { storeCommittedRequestOf } from '../dist/src/enterprise/sovereign-status-history/sqlite-status-high-water-mark-store.js';
import { openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { trustedBootstrap } from './fv-status-bootstrap-support.mjs';
import { GRACE, NS_A, NS_B, S, T, addSeconds, compose, decisionsFor, makeClock, openIdentity, prepareWorld, requestFor } from './fv-p4c2b3b-support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = fileURLToPath(new URL('./fv-p4c2b3b-child.mjs', import.meta.url));
const LATER = addSeconds(T, 10);

const cleanup = [];
after(() => {
  for (const step of cleanup.splice(0).reverse()) {
    try {
      step();
    } catch {
      // already closed
    }
  }
});

async function world(options) {
  const w = await prepareWorld(options);
  cleanup.push(() => rmSync(w.dir, { recursive: true, force: true }));
  return w;
}

/** One Host start over `w`'s durable state: the identity store and the protected composition. */
async function start(w, at = LATER, overrides = {}) {
  const clock = makeClock(at);
  const identity = await openIdentity(w.dir, clock);
  cleanup.push(() => identity.close());
  try {
    const host = await compose(w, identity, clock, overrides);
    cleanup.push(() => host.close());
    return { host, identity, clock, stop: () => (host.close(), identity.close()) };
  } catch (error) {
    identity.close();
    throw error;
  }
}

function spawnChild(job) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(job)], { stdio: ['pipe', 'pipe', 'inherit'] });
  cleanup.push(() => child.kill('SIGKILL'));
  const lines = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  return {
    child,
    lines,
    exited,
    async next(predicate) {
      for (;;) {
        const found = lines.find(predicate);
        if (found !== undefined) return found;
        const ended = await Promise.race([new Promise((wake) => waiters.push(wake)).then(() => undefined), exited]);
        if (ended !== undefined) {
          const late = lines.find(predicate);
          if (late !== undefined) return late;
          throw new Error(`the child exited (${JSON.stringify(ended)}) without it: ${JSON.stringify(lines)}`);
        }
      }
    },
  };
}

const summary = (entries) => entries.map((e) => [e.result, 'reason' in e ? e.reason : e.settlement.outcome]);
const classes = (status) => Object.fromEntries(status.inventory.histories.map((h) => [h.namespace, h.class]));

/** A Host with both decisions signed for one request, then stopped: what a crash test hands to a child. */
async function signedJob(w, request = requestFor(NS_A)) {
  const s = await start(w, T);
  const decisions = decisionsFor(s.host, w.devices, request);
  s.stop();
  return { request, signedStatusText: S.active1.text, ...decisions };
}

/** The bootstrap run in a child that is SIGKILLed at `killAt`; then a restart over what it left on disk. */
async function crashAt(killAt) {
  const w = await world();
  const bootstrap = await signedJob(w);
  const child = spawnChild({ mode: 'crash', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), killAt, bootstrap });
  const exit = await child.exited;
  assert.equal(exit.signal, 'SIGKILL', `${killAt}: the child was killed`);
  const s = await start(w, LATER);
  s.clock.advance(GRACE + 1);
  const entries = await s.host.reconcile();
  const status = s.host.status();
  return { w, s, killAt, finished: child.lines.some((l) => l.finished === true), cls: classes(status)[NS_A], other: classes(status)[NS_B], pending: status.pendingIntents[NS_A], outcomes: summary(entries), requestId: bootstrap.request.requestId };
}

// ── Persistence and crash consistency ───────────────────────────────────────

describe('FV-P4C-2B3B protected storage — durable intents and records across real crashes', () => {
  it('end to end: a bootstrap through the real coordinator commits, re-captures, completes its intent and settles committed', async () => {
    const w = await world();
    const s = await start(w);
    assert.equal(s.host.status().readiness, 'ready');
    const request = requestFor(NS_A);
    const ran = await s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) });
    assert.equal(ran.outcome, 'ran');
    assert.equal(ran.result.outcome, 'established', JSON.stringify(ran));
    assert.deepEqual(s.host.status().pendingIntents, { [NS_A]: [], [NS_B]: [] });
    s.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await s.host.reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    s.stop();
    // The intent journal persisted the whole lifecycle.
    const records = await openProtectedContinuityStore(w.paths.protectedStore, { now: () => LATER });
    const log = records.intentLog(NS_A);
    records.close();
    assert.deepEqual(log.map((i) => [i.requestId, i.state]), [[request.requestId, 'completed']]);
  });

  it('crash matrix (SIGKILL at each durable transition): settled by evidence or quarantined; never a confident negative', { timeout: 240_000 }, async () => {
    const quarantined = (r, consumed) => {
      assert.equal(r.finished, false, `${r.killAt}: the kill point was reached`);
      assert.equal(r.cls, 'INTENT_UNRESOLVED', r.killAt);
      assert.equal(r.other, 'CONTINUOUS', `${r.killAt}: the other namespace is served`);
      assert.deepEqual(r.pending, [r.requestId], `${r.killAt}: the intent stays pending (never cleared)`);
      assert.deepEqual(r.outcomes, Array(consumed).fill(['unresolved', 'HISTORY_NOT_IN_INVENTORY']), r.killAt);
    };
    // 2. The intent is durable, the response lost: nothing consumed.
    quarantined(await crashAt('beforeConsume:1'), 0);
    // 3–4. One or both decisions consumed, before the commit.
    quarantined(await crashAt('consumed:1'), 1);
    quarantined(await crashAt('consumed:2'), 2);
    quarantined(await crashAt('before:commit'), 2);
    // 7. Immediately after the commit; 8–9. after the checkpoint, before the intent is completed.
    for (const killAt of ['after:commit', 'before:save', 'before:completeIntent']) {
      const r = await crashAt(killAt);
      assert.equal(r.finished, false, `${killAt}: the kill point was reached`);
      assert.ok(['ADVANCED', 'CONTINUOUS'].includes(r.cls), `${killAt}: ${r.cls}`);
      assert.deepEqual(r.pending, [], `${killAt}: resolved by its evidence`);
      assert.deepEqual(r.outcomes, [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']], killAt);
    }
  });

  it('5–6. a source refusal or a refused transition after consumption completes the intent: settled not committed, which is true', async () => {
    const w = await world();
    const s = await start(w, LATER, { statusSource: { verifier: { attestStatusSource: async () => { throw new Error('source down'); } }, policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 } } });
    const request = requestFor(NS_A);
    const ran = await s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) });
    assert.equal(ran.result.reason, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(s.host.status().pendingIntents[NS_A], []);
    s.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await s.host.reconcile()), [['settled', 'bootstrap-not-committed'], ['settled', 'bootstrap-not-committed']]);
  });

  it('1. an intent that cannot be recorded refuses the consumption: a reused request id under another binding is a CONFLICT, nothing consumed', async () => {
    const w = await world();
    const s = await start(w, LATER, { statusSource: { verifier: { attestStatusSource: async () => { throw new Error('source down'); } }, policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 } } });
    const first = requestFor(NS_A);
    assert.equal((await s.host.bootstrap({ request: first, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, first) })).result.reason, 'SOURCE_UNAVAILABLE');
    const reused = { ...requestFor(NS_A), requestId: first.requestId, sourceRef: 'source:other-channel' };
    const ran = await s.host.bootstrap({ request: reused, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, reused) });
    assert.equal(ran.outcome, 'ran');
    assert.notEqual(ran.result.outcome, 'established');
    s.clock.advance(GRACE + 1);
    // Only the first attempt's two decisions were ever consumed.
    assert.equal((await s.host.reconcile()).length, 2);
  });

  it('10–13. a corrupt record, a corrupt intent, a tampered schema, a missing or held store: quarantined or refused, never reset', async () => {
    const w = await world();
    // A pending intent, written by the store itself.
    const records = await openProtectedContinuityStore(w.paths.protectedStore, { now: () => T });
    records.beginIntent(NS_B, { requestId: 'req:corrupt-me', bindingDigest: 'a'.repeat(64) });
    records.close();
    const raw = new Database(w.paths.protectedStore);
    raw.prepare("UPDATE fv_continuity_records SET record = '{not json' WHERE namespace = ?").run(NS_A);
    const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'fv_bootstrap_intents_identity_fixed'").get().sql;
    raw.exec('DROP TRIGGER fv_bootstrap_intents_identity_fixed');
    raw.prepare("UPDATE fv_bootstrap_intents SET binding_digest = 'zz' WHERE request_id = 'req:corrupt-me'").run();
    raw.exec(trigger);
    raw.close();
    const s = await start(w);
    assert.deepEqual(classes(s.host.status()), { [NS_A]: 'RECORD_INVALID', [NS_B]: 'UNAVAILABLE' });
    assert.equal(s.host.status().readiness, 'unavailable');
    assert.equal(s.host.status().pendingIntents[NS_B], null, 'an invalid intent row is never read as no intent');
    s.stop();
    // A dropped integrity trigger refuses the whole store.
    const tamper = new Database(w.paths.protectedStore);
    tamper.exec('DROP TRIGGER fv_bootstrap_intents_no_delete');
    tamper.close();
    await assert.rejects(start(w), (e) => e.code === 'PROTECTED_STORE_REFUSED');
    // A missing store is never recreated implicitly (refused by the path policy, before any open).
    rmSync(w.paths.protectedStore);
    await assert.rejects(start(w), (e) => e.code === 'PATH_REFUSED');
    assert.equal(existsSync(w.paths.protectedStore), false);
  });

  it('review M2: a database failure inside the evidence transaction counts as maybe written; that handle never reads it as absent', async () => {
    const w = await world();
    const history = await openSqliteStatusHighWaterMarkStore(w.paths.history(NS_A), { namespace: NS_A });
    const key = { sovereignAssetId: 'sa:m2', issuer: 'did:example:m2' };
    const mark = { ...key, sequence: 1, statusDigest: 'b'.repeat(64), issuedAt: '2026-10-28T11:59:00Z', currentTermsDigest: null, timeFloor: '2026-10-28T11:59:00Z', withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: T };
    // A failure raised inside the transaction, after the store's own checks (deterministic stand-in for an I/O error at the sync).
    const draft = { schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA, requestId: 'req:m2-uncertain', get operatorRef() { throw new Error('I/O error'); } };
    await assert.rejects(history.compareAndSetWithEvidence(key, null, mark, draft), (e) => e.code === 'DATABASE');
    assert.equal(await history.hasBootstrapRequest('req:m2-uncertain'), false, 'nothing visible to this handle');
    assert.equal(storeCommittedRequestOf(history, 'req:m2-uncertain'), true, 'but it may have been written: never completed as absent');
    assert.equal(storeCommittedRequestOf(history, 'req:never-tried'), false);
    history.close();
  });

  it('the store itself: durable epoch per acquisition, no delete, no re-open of a completed intent, conflicts refused, fenced writes write nothing', async () => {
    const w = await world();
    const now = () => T;
    const first = await openProtectedContinuityStore(w.paths.protectedStore, { now });
    const epoch = first.epoch;
    first.beginIntent(NS_A, { requestId: 'req:one', bindingDigest: 'b'.repeat(64) });
    first.beginIntent(NS_A, { requestId: 'req:one', bindingDigest: 'b'.repeat(64) }); // the same fact again
    assert.throws(() => first.beginIntent(NS_A, { requestId: 'req:one', bindingDigest: 'c'.repeat(64) }), (e) => e.code === 'CONFLICT');
    first.completeIntent(NS_A, 'req:one');
    assert.throws(() => first.completeIntent(NS_A, 'req:one'), (e) => e.code === 'CONFLICT');
    assert.throws(() => first.beginIntent(NS_A, { requestId: 'req:one', bindingDigest: 'b'.repeat(64) }), (e) => e.code === 'CONFLICT');
    assert.throws(() => first.save({ namespace: NS_A }), (e) => e.code === 'INVALID_WRITE');
    first.close();
    const fenced = await openProtectedContinuityStore(w.paths.protectedStore, { now, beforeWrite: () => undefined });
    assert.equal(fenced.epoch, epoch + 1);
    fenced.close();
    let allow = true;
    const second = await openProtectedContinuityStore(w.paths.protectedStore, { now, beforeWrite: () => { if (!allow) throw new Error('lost'); } });
    allow = false;
    assert.throws(() => second.beginIntent(NS_A, { requestId: 'req:two', bindingDigest: 'b'.repeat(64) }), (e) => e.code === 'FENCED');
    assert.deepEqual(second.pendingIntents(NS_A), []);
    second.close();
    await assert.rejects(openProtectedContinuityStore(w.paths.protectedStore, { now, create: true }), (e) => e.code === 'OPEN_REFUSED');
    const raw = new Database(w.paths.protectedStore);
    assert.throws(() => raw.prepare('DELETE FROM fv_bootstrap_intents').run(), /never deleted/);
    assert.throws(() => raw.prepare('DELETE FROM fv_continuity_records').run(), /never deleted/);
    assert.throws(() => raw.prepare("UPDATE fv_bootstrap_intents SET state = 'pending', completed_at = NULL").run(), /completed once/);
    assert.throws(() => raw.prepare('UPDATE fv_protected_meta SET epoch = 0').run(), /only increases/);
    raw.close();
  });
});

// ── Exclusive execution ─────────────────────────────────────────────────────

describe('FV-P4C-2B3B exclusive executor — kernel file locks on the write path, fenced on every write', () => {
  it('14–15/17/20. a second Host is refused while the first lives, whatever its clock; a killed holder releases; epochs increase', { timeout: 60_000 }, async () => {
    const w = await world();
    const holder = spawnChild({ mode: 'hold', dir: w.dir, namespaces: w.namespaces, at: T });
    const held = await holder.next((l) => 'composed' in l);
    assert.equal(held.composed, true);
    for (const at of [T, '2036-10-28T12:00:00Z', '2016-10-28T12:00:00Z']) await assert.rejects(start(w, at), (e) => e.code === 'EXECUTOR_HELD', `refused at ${at}`);
    holder.child.kill('SIGKILL');
    await holder.exited;
    const s = await start(w);
    assert.ok(s.host.status().epoch > held.epoch);
    assert.equal(s.host.status().readiness, 'ready');
    s.stop();
  });

  it('14. two Hosts started together: exactly one composes', { timeout: 60_000 }, async () => {
    const w = await world();
    const a = spawnChild({ mode: 'hold', dir: w.dir, namespaces: w.namespaces, at: T });
    const b = spawnChild({ mode: 'hold', dir: w.dir, namespaces: w.namespaces, at: T });
    const outcomes = await Promise.all([a.next((l) => 'composed' in l), b.next((l) => 'composed' in l)]);
    assert.deepEqual(outcomes.map((o) => o.composed).sort(), [false, true]);
    assert.equal(outcomes.find((o) => !o.composed).code, 'EXECUTOR_HELD');
  });

  it('16. an old process whose locks were silently dropped, after another Host took over, writes nothing, and its graceful close and exit cannot undo the new holder', { timeout: 90_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const stale = spawnChild({ mode: 'hold', dropLocks: true, dir: w.dir, namespaces: w.namespaces, at: T, bootstrap: { ...bootstrap, requesterResponse: {}, approverResponse: {} } });
    const staleEpoch = (await stale.next((l) => 'composed' in l)).epoch;
    await stale.next((l) => l.dropped === true);
    // Ownership transfers: a new holder composes (the kernel shows no lock of the old process), commits and stays alive.
    const holder = spawnChild({ mode: 'crash', holdUntilTold: true, dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), killAt: 'never:x', bootstrap });
    const holderEpoch = (await holder.next((l) => 'composed' in l)).epoch;
    assert.ok(holderEpoch > staleEpoch);
    assert.equal((await holder.next((l) => l.finished)).reason, 'ESTABLISHED');
    // The stale process tries to work: refused before anything, and it stops.
    stale.child.stdin.write('bootstrap\n');
    const attempt = await stale.next((l) => 'bootstrap' in l);
    assert.deepEqual([attempt.bootstrap, attempt.reason, attempt.readiness], ['refused', 'EXECUTOR_NOT_HELD', 'executor-lost']);
    assert.match(attempt.reconciled, /no longer holds exclusive execution/);
    // Release review C1: it now shuts down gracefully (close, then a normal exit). Its lost connections are
    // never closed, and the exit guard stops it before any closing checkpoint.
    stale.child.stdin.end();
    assert.equal((await stale.exited).signal, 'SIGKILL', 'a Host that lost its authority stops, it does not checkpoint');
    holder.child.stdin.write('die\n');
    await holder.exited;
    // The new holder's commit, record and completed intent all survived.
    const r = await start(w);
    assert.ok(r.host.status().epoch > holderEpoch);
    assert.deepEqual(classes(r.host.status()), { [NS_A]: 'CONTINUOUS', [NS_B]: 'CONTINUOUS' });
    assert.deepEqual(r.host.status().pendingIntents, { [NS_A]: [], [NS_B]: [] });
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    const fresh = decisionsFor(r.host, w.devices, bootstrap.request);
    assert.equal((await r.host.bootstrap({ ...bootstrap, ...fresh })).result.reason, 'REQUEST_REPLAYED');
  });

  it('19. a history held by another process is UNAVAILABLE, the other namespace is served; 18. a replayed request from another instance is refused', { timeout: 60_000 }, async () => {
    const w = await world();
    const foreign = spawn(process.execPath, ['-e', `const D=require(${JSON.stringify(join(ROOT, 'node_modules', 'better-sqlite3'))});const d=new D(process.argv[1]);d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE');d.exec('COMMIT');process.stdout.write('held\\n');setInterval(()=>d.prepare('select 1').get(),1000);`, w.paths.history(NS_B)], { stdio: ['ignore', 'pipe', 'inherit'] });
    cleanup.push(() => foreign.kill('SIGKILL'));
    await new Promise((done) => foreign.stdout.once('data', done));
    const s = await start(w);
    assert.deepEqual(classes(s.host.status()), { [NS_A]: 'CONTINUOUS', [NS_B]: 'UNAVAILABLE' });
    assert.equal(s.host.status().readiness, 'degraded');
    const request = requestFor(NS_A);
    assert.equal((await s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) })).result.outcome, 'established');
    s.stop();
    foreign.kill('SIGKILL');
    const again = await start(w, addSeconds(T, 20));
    const replay = await again.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(again.host, w.devices, request) });
    assert.equal(replay.result.reason, 'REQUEST_REPLAYED');
    again.stop();
  });

  it('shutdown while executing: the run fails closed, its intent stays pending, the restart quarantines; nothing is settled negative', async () => {
    const w = await world();
    let release;
    let entered;
    const gate = new Promise((done) => (release = done));
    const reached = new Promise((done) => (entered = done));
    // The source check runs after both decisions are consumed (coordinator step 4): it signals, then waits.
    const slow = { verifier: { attestStatusSource: async (query) => (entered(), await gate, { sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: LATER, status: { ...query.status } }) }, policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 } };
    const s = await start(w, LATER, { statusSource: slow });
    const request = requestFor(NS_A);
    const running = s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) });
    await reached;
    s.host.close();
    release();
    const ran = await running;
    assert.notEqual(ran.result?.outcome, 'established');
    s.identity.close();
    const r = await start(w);
    assert.equal(classes(r.host.status())[NS_A], 'INTENT_UNRESOLVED');
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
  });

  it('lease loss mid-operation: the lock dropped after consumption, before the commit, fences the commit; the intent stays pending; the executor stops', { timeout: 90_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const child = spawnChild({ mode: 'midrun-loss', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap });
    const result = await child.next((l) => 'reason' in l);
    assert.deepEqual(result, { reason: 'HISTORY_STORE_UNAVAILABLE', readiness: 'executor-lost', pending: [bootstrap.request.requestId] }, 'the commit was fenced; the intent was never completed');
    assert.equal((await child.exited).signal, 'SIGKILL', 'the lost executor stopped at exit');
    const r = await start(w);
    assert.equal(classes(r.host.status())[NS_A], 'INTENT_UNRESOLVED');
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
  });

  it('final review I2: the lock lost inside the fence of save or completeIntent (after the post-settle check passed) completes nothing; the restart settles only by evidence', { timeout: 180_000 }, async () => {
    const run = async (dropAt, refuseSource) => {
      const w = await world();
      const bootstrap = await signedJob(w);
      const child = spawnChild({ mode: 'drop-at', dropAt, refuseSource, dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap });
      const out = await child.next((l) => 'readiness' in l);
      assert.equal((await child.exited).signal, 'SIGKILL', `${dropAt}: the lost executor stopped at exit`);
      const r = await start(w);
      r.clock.advance(GRACE + 1);
      const entries = summary(await r.host.reconcile());
      const after = { cls: classes(r.host.status())[NS_A], pending: r.host.status().pendingIntents[NS_A] };
      r.stop();
      return { out, after, entries, requestId: bootstrap.request.requestId };
    };
    // Committed, then the lock is lost before the record is re-captured, or before the intent is completed.
    for (const dropAt of ['save', 'completeIntent']) {
      const { out, after, entries, requestId } = await run(dropAt, false);
      assert.deepEqual(out, { reason: 'ESTABLISHED', readiness: 'executor-lost', pending: [requestId] }, `${dropAt}: never completed without the lock`);
      assert.deepEqual(after.pending, [], `${dropAt}: resolved at restart by its evidence`);
      assert.deepEqual(entries, [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']], dropAt);
    }
    // Nothing committed (the source refused), then the lock is lost before the "absent" completion: still pending.
    const { out, after, entries, requestId } = await run('completeIntent', true);
    assert.deepEqual(out, { reason: 'SOURCE_UNAVAILABLE', readiness: 'executor-lost', pending: [requestId] });
    assert.deepEqual(after, { cls: 'INTENT_UNRESOLVED', pending: [requestId] }, 'quarantined; never cleared without the lock');
    assert.deepEqual(entries, [['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY']], 'never a negative');
  });

  it('final review I3: the lock lost after reconcile()’s authority check, before any settlement, settles nothing; a later executor settles the truth', { timeout: 90_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const child = spawnChild({ mode: 'reconcile-loss', refuseSource: true, grace: GRACE, dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap });
    const out = await child.next((l) => 'entries' in l);
    assert.equal(out.bootstrap, 'SOURCE_UNAVAILABLE');
    assert.equal(out.settlementsWritten, 0, 'no settlement written by an executor without its lock');
    assert.ok(Array.isArray(out.entries) && out.entries.every(([result]) => result === 'unresolved'), JSON.stringify(out.entries));
    assert.equal(out.readiness, 'executor-lost');
    assert.equal((await child.exited).signal, 'SIGKILL');
    const r = await start(w);
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['settled', 'bootstrap-not-committed'], ['settled', 'bootstrap-not-committed']], 'true: nothing was committed');
  });

  it('the kernel check names this process’s lock on the inode the path names now: a history replaced while held is excluded; a dropped executor lock stops everything', { timeout: 90_000 }, async () => {
    const w = await world();
    const first = await signedJob(w, requestFor(NS_A));
    const second = await signedJob(w, requestFor(NS_B));
    const child = spawnChild({ mode: 'replace-history', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap: first, second });
    const out = await child.next((l) => 'heldAtStart' in l);
    assert.deepEqual(out, {
      heldAtStart: true,
      absent: false,
      // 31. A history replaced at its path while held: that namespace only.
      replacedHeld: false,
      first: 'HISTORY_NOT_ADMITTED',
      lostAfterReplacement: false,
      second: 'established',
      // The hazard in-process: a raw open/close of the protected store drops this process's POSIX lock.
      protectedHeld: false,
      third: 'EXECUTOR_NOT_HELD',
      readiness: 'executor-lost',
      fourth: 'EXECUTOR_LOST',
      reconciled: 'The protected FV Host no longer holds exclusive execution; nothing is reconciled.',
    });
    assert.equal((await child.exited).signal, 'SIGKILL', 'the lost executor stopped at exit');
  });
});

// ── Coordinator ownership and AUTH-03 custody ───────────────────────────────

describe('FV-P4C-2B3B coordinator and custody — data in, never code; the capability never leaves the composition', () => {
  it('21/25. the surface is five methods; nothing reachable is a history, the protected store, the identity store or the capability', async () => {
    const w = await world();
    const s = await start(w);
    assert.deepEqual(Object.keys(s.host).sort(), ['beginBootstrapDecision', 'bootstrap', 'close', 'reconcile', 'status']);
    const seen = new Set();
    const walk = (value) => {
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      for (const forbidden of ['compareAndSetWithEvidence', 'beginIntent', 'append', 'recordBootstrapAuthoritySettlement', 'authorizeBootstrapAuthorityDecision', 'runBootstrap', 'historyFor']) {
        assert.equal(forbidden in value, false, `reachable: ${forbidden}`);
      }
      for (const key of Object.getOwnPropertyNames(value)) walk(value[key]);
    };
    walk(s.host);
    walk(s.host.status());
    // A function, or a request object carrying code, is never run: the input is read once as data.
    let reads = 0;
    const switching = { get request() { reads += 1; return reads === 1 ? requestFor(NS_A) : () => 'code'; }, signedStatusText: S.active1.text, requesterResponse: {}, approverResponse: {} };
    assert.equal((await s.host.bootstrap({ request: () => 'code', signedStatusText: '', requesterResponse: {}, approverResponse: {} })).reason, 'REQUEST_INVALID');
    await s.host.bootstrap(switching);
    assert.equal(reads, 1, 'the caller’s object is read exactly once');
  });

  it('12. bootstrap execution is disabled without a status source: refused before any intent or consumption', async () => {
    const w = await world();
    const s = await start(w, LATER, { statusSource: undefined });
    assert.equal(s.host.status().bootstrapExecution, 'disabled');
    const request = requestFor(NS_A);
    assert.equal((await s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) })).reason, 'BOOTSTRAP_DISABLED');
    assert.deepEqual(s.host.status().pendingIntents[NS_A], []);
    s.clock.advance(GRACE + 1);
    assert.deepEqual(await s.host.reconcile(), []);
  });

  it('26–29. wrong binding, wrong namespace, the same human twice, an unpermitted approver, swapped roles: never established', async () => {
    const w = await world();
    const s = await start(w);
    const request = requestFor(NS_A);
    const other = requestFor(NS_A);
    const attempt = async (input) => s.host.bootstrap({ request, signedStatusText: S.active1.text, ...input });
    const wrongBinding = await attempt(decisionsFor(s.host, w.devices, other));
    assert.notEqual(wrongBinding.result.outcome, 'established');
    assert.equal((await s.host.bootstrap({ request: requestFor('receiver:not-configured'), signedStatusText: S.active1.text, requesterResponse: {}, approverResponse: {} })).reason, 'HISTORY_NOT_ADMITTED');
    for (const [label, approver] of [['same human', 'requester-a'], ['unpermitted', 'approver-c']]) {
      const fresh = requestFor(NS_A);
      const ran = await s.host.bootstrap({ request: fresh, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, fresh, { approver }) });
      assert.notEqual(ran.result.outcome, 'established', label);
    }
    const swapped = requestFor(NS_A);
    const d = decisionsFor(s.host, w.devices, swapped);
    assert.notEqual((await s.host.bootstrap({ request: swapped, signedStatusText: S.active1.text, requesterResponse: d.approverResponse, approverResponse: d.requesterResponse })).result.outcome, 'established');
    // Nothing committed anywhere, so nothing pending either.
    assert.deepEqual(s.host.status().pendingIntents[NS_A], []);
    s.clock.advance(GRACE + 1);
    for (const entry of summary(await s.host.reconcile())) assert.deepEqual(entry, ['settled', 'bootstrap-not-committed']);
  });

  it('22–24. the capability is issued inside and revoked at close; a foreign organization’s identity store is refused', async () => {
    const w = await world();
    const s = await start(w);
    s.host.close();
    await assert.rejects(s.host.reconcile(), /closed/);
    assert.equal((await s.host.bootstrap({ request: requestFor(NS_A), signedStatusText: '', requesterResponse: {}, approverResponse: {} })).reason, 'CLOSED');
    s.identity.close();
    const otherDir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3b-foreign-'));
    cleanup.push(() => rmSync(otherDir, { recursive: true, force: true }));
    const clock = makeClock(LATER);
    const foreign = await openSqliteHumanIdentityStore(join(otherDir, 'identity.sqlite'), { organizationId: 'org-someone-else', now: () => clock.iso(), authenticity: { signer: testSigner(), verifier: testVerifier() }, create: true });
    cleanup.push(() => foreign.close());
    await assert.rejects(compose(w, foreign, clock), (e) => e.code === 'CUSTODY_REFUSED');
    // The refused start released everything it took: a normal start works.
    (await start(w)).stop();
  });
});

// ── History continuity and the filesystem ───────────────────────────────────

describe('FV-P4C-2B3B history continuity — substitution, rollback, WAL and links are quarantined, per namespace', () => {
  it('32/37. an older backup restored at the path is ROLLED_BACK: its decisions stay unresolved, the other namespace is served', async () => {
    const w = await world();
    const backup = join(w.dir, 'backup.sqlite');
    copyFileSync(w.paths.history(NS_A), backup);
    const s = await start(w);
    const request = requestFor(NS_A);
    assert.equal((await s.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(s.host, w.devices, request) })).result.outcome, 'established');
    s.stop();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${w.paths.history(NS_A)}${suffix}`, { force: true });
    copyFileSync(backup, w.paths.history(NS_A));
    chmodSync(w.paths.history(NS_A), 0o600);
    const r = await start(w);
    assert.deepEqual(classes(r.host.status()), { [NS_A]: 'ROLLED_BACK', [NS_B]: 'CONTINUOUS' });
  });

  it('33. the WAL of a crashed Host deleted after the commit: the history is ROLLED_BACK, never not-committed', { timeout: 60_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const child = spawnChild({ mode: 'crash', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), killAt: 'never:x', bootstrap });
    await child.exited;
    assert.equal(child.lines.find((l) => l.finished)?.reason, 'ESTABLISHED');
    assert.equal(existsSync(`${w.paths.history(NS_A)}-wal`), true, 'the commit is still in the WAL');
    unlinkSync(`${w.paths.history(NS_A)}-wal`);
    const r = await start(w);
    assert.equal(classes(r.host.status())[NS_A], 'ROLLED_BACK');
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
  });

  it('34–36. a symlinked file or directory, a file writable by others, a missing or corrupt history: refused or quarantined, the rest served', async () => {
    const w = await world();
    // 34. A symlink at the configured path.
    const real = join(w.dir, 'real-b.sqlite');
    renameSync(w.paths.history(NS_B), real);
    symlinkSync(real, w.paths.history(NS_B));
    let s = await start(w);
    assert.deepEqual(s.host.status().pathRefusals, { [NS_B]: 'LINKED' });
    assert.equal(s.host.status().readiness, 'degraded');
    s.stop();
    unlinkSync(w.paths.history(NS_B));
    renameSync(real, w.paths.history(NS_B));
    // Group-writable: anyone in the group could replace its content.
    chmodSync(w.paths.history(NS_B), 0o664);
    s = await start(w);
    assert.deepEqual(s.host.status().pathRefusals, { [NS_B]: 'WRITABLE_BY_OTHERS' });
    s.stop();
    chmodSync(w.paths.history(NS_B), 0o600);
    // A symlinked directory component.
    const linkedDir = join(w.dir, 'linked');
    symlinkSync(w.dir, linkedDir);
    assert.equal(checkProtectedFile(join(linkedDir, 'x.sqlite'), { allowMissing: true }), 'NOT_CANONICAL');
    // 35–36. Missing and corrupt.
    rmSync(w.paths.history(NS_A));
    s = await start(w);
    assert.deepEqual(s.host.status().pathRefusals, { [NS_A]: 'UNREADABLE' });
    assert.equal(classes(s.host.status())[NS_B], 'CONTINUOUS');
    s.stop();
    writeFileSync(w.paths.history(NS_A), 'not a database', { mode: 0o600 });
    s = await start(w);
    assert.deepEqual(classes(s.host.status()), { [NS_A]: 'CORRUPT', [NS_B]: 'CONTINUOUS' });
    s.stop();
  });

  it('38. evidence written by a raw writer outside the executor is UNEXPLAINED_EVIDENCE', async () => {
    const w = await world();
    const raw = await openSqliteStatusHighWaterMarkStore(w.paths.history(NS_A), { namespace: NS_A });
    assert.equal((await trustedBootstrap(raw, S.active1, T)).outcome, 'established');
    raw.close();
    const s = await start(w);
    assert.deepEqual(classes(s.host.status()), { [NS_A]: 'UNEXPLAINED_EVIDENCE', [NS_B]: 'CONTINUOUS' });
  });

  it('LIMITATION (FV-P4D): the history and the protected store restored together to before a commit are indistinguishable from no commit', { timeout: 60_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const snapshot = join(w.dir, 'snapshot');
    mkdirSync(snapshot, { mode: 0o700 });
    for (const file of [w.paths.history(NS_A), w.paths.protectedStore]) copyFileSync(file, join(snapshot, relative(w.dir, file)));
    const child = spawnChild({ mode: 'crash', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), killAt: 'after:commit', bootstrap });
    await child.exited;
    for (const file of [w.paths.history(NS_A), w.paths.protectedStore]) {
      for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
      copyFileSync(join(snapshot, relative(w.dir, file)), file);
      chmodSync(file, 0o600);
    }
    const r = await start(w);
    assert.equal(classes(r.host.status())[NS_A], 'CONTINUOUS');
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['settled', 'bootstrap-not-committed'], ['settled', 'bootstrap-not-committed']], 'undetectable here: an independent witness is FV-P4D');
  });
});

// ── Isolation ───────────────────────────────────────────────────────────────

describe('FV-P4C-2B3B isolation — internal only: no route, CLI, startup, status source, document use or Fileverse', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(m?js|ts)$/.test(name) ? [path] : [];
  });
  const MODULE = join(ROOT, 'src', 'enterprise', 'sovereign-status-history');
  const NAMES = /composeFvProtectedHost|openProtectedContinuityStore|confirmExclusivelyHeld|checkProtectedFile|protected-host-composition|protected-continuity-store|executor-exclusivity/;

  it('41–43. nothing in src/ outside the FV module, nor any script, reaches the composition; the FV index does not export it', () => {
    const callers = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))].filter((file) => !file.startsWith(MODULE) && NAMES.test(readFileSync(file, 'utf8')));
    assert.deepEqual(callers.map((f) => relative(ROOT, f)), []);
    for (const name of ['composeFvProtectedHost', 'openProtectedContinuityStore', 'confirmExclusivelyHeld', 'checkProtectedFile']) assert.equal(name in fvIndex, false, name);
    assert.equal(NAMES.test(readFileSync(join(MODULE, 'index.ts'), 'utf8')), false);
  });

  it('44–47. the new modules import only the FV module, AUTH-03’s index and node built-ins: no status source, document use, Fileverse, route or network', () => {
    const allowed = {
      'protected-host-composition.ts': ['../human-identity/index.js', 'node:fs', 'node:path'],
      'protected-continuity-store.ts': ['node:fs', 'node:path', 'better-sqlite3'],
      'executor-exclusivity.ts': ['node:fs', 'node:path', 'node:worker_threads'],
    };
    for (const [name, external] of Object.entries(allowed)) {
      const text = readFileSync(join(MODULE, name), 'utf8');
      const specifiers = [...text.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of specifiers) assert.ok(specifier.startsWith('./') || external.includes(specifier), `${name} imports ${specifier}`);
    }
    // The composition passes AUTH-03's own predicate and never accepts one.
    const composition = readFileSync(join(MODULE, 'protected-host-composition.ts'), 'utf8');
    assert.match(composition, /custody: isBootstrapSettlementCapabilityOf,/);
    assert.equal(/readonly (custody|settlement|capability)\b/.test(composition), false, 'no option carries custody or a capability');
  });

  it('review R2-H: no exclusive connection is ever opened in a worker thread (its teardown would checkpoint unguarded)', async () => {
    const w = await world();
    const { Worker } = await import('node:worker_threads');
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const out = {};
        const { openProtectedContinuityStore } = await import(workerData.store);
        const { openSqliteStatusHighWaterMarkStore } = await import(workerData.history);
        const { confirmExclusivelyHeld, exclusivitySupported } = await import(workerData.exclusivity);
        out.supported = exclusivitySupported();
        out.confirm = confirmExclusivelyHeld([workerData.protectedStore]);
        try { await openProtectedContinuityStore(workerData.protectedStore, { now: () => '2026-10-28T12:00:00Z' }); out.store = 'opened'; } catch (e) { out.store = e.code; }
        try { await openSqliteStatusHighWaterMarkStore(workerData.historyPath, { namespace: workerData.namespace, exclusive: true }); out.history = 'opened'; } catch (e) { out.history = e.code; }
        parentPort.postMessage(out);
      })();`;
    const dist = (name) => new URL(`../dist/src/enterprise/sovereign-status-history/${name}`, import.meta.url).href;
    const worker = new Worker(code, { eval: true, workerData: { store: dist('protected-continuity-store.js'), history: dist('index.js'), exclusivity: dist('executor-exclusivity.js'), protectedStore: w.paths.protectedStore, historyPath: w.paths.history(NS_A), namespace: NS_A } });
    const out = await new Promise((done, fail) => (worker.once('message', done), worker.once('error', fail)));
    await worker.terminate();
    assert.deepEqual(out, { supported: false, confirm: false, store: 'OPEN_REFUSED', history: 'OPEN_REFUSED' });
    // Nothing was taken: the main thread composes.
    (await start(w)).stop();
  });

  it('review L1/R2-L: a duplicated namespace, one file under two namespaces, or the protected store as a history is refused before anything is opened', async () => {
    const w = await world();
    const configs = [
      [{ namespace: NS_A, databasePath: w.paths.history(NS_A) }, { namespace: NS_A, databasePath: w.paths.history(NS_B) }],
      [{ namespace: NS_A, databasePath: w.paths.history(NS_A) }, { namespace: NS_B, databasePath: w.paths.history(NS_A) }],
      [{ namespace: NS_A, databasePath: w.paths.history(NS_A) }, { namespace: NS_B, databasePath: w.paths.protectedStore }],
      [{ namespace: NS_A, databasePath: w.paths.history(NS_A) }, { namespace: 7, databasePath: w.paths.history(NS_B) }],
    ];
    for (const histories of configs) await assert.rejects(start(w, LATER, { configuration: () => ({ generation: 1, histories }) }), (e) => e.code === 'OPTIONS_INVALID', JSON.stringify(histories));
    (await start(w)).stop();
  });

  it('a filesystem policy refusal of the protected store refuses startup before anything is opened', async () => {
    const w = await world();
    chmodSync(w.paths.protectedStore, 0o666);
    await assert.rejects(start(w), (e) => e.code === 'PATH_REFUSED');
    chmodSync(w.paths.protectedStore, 0o600);
    chmodSync(w.dir, 0o777);
    await assert.rejects(start(w), (e) => e.code === 'PATH_REFUSED');
    chmodSync(w.dir, 0o700);
    (await start(w)).stop();
  });
});

