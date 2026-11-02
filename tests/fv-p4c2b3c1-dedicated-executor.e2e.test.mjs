// FV-P4C-2B3C-1 — the dedicated FV executor and its supervisor, with real OS processes: a supervisor
// (in this test process, or in its own process) starts the test-harness executor
// (fv-p4c2b3c1-executor-entry.mjs) over a synthetic world (B3B support: synthetic identities, temporary
// databases, no status source). Every child is a test-owned process; nothing kills this process or a Host.
import { fork, spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { FV_EXECUTOR_IPC_PROTOCOL, FV_EXECUTOR_TRANSITIONS, parseFvExecutorCommand } from '../dist/src/enterprise/sovereign-status-history/dedicated-executor-protocol.js';
import { FV_EXECUTOR_DEFAULT_RESTART_POLICY, createFvExecutorSupervisor, decideAfterExit } from '../dist/src/enterprise/sovereign-status-history/dedicated-executor-supervisor.js';
import { FV_EXECUTOR_PERSISTENCE_CONTRACT, fvExecutorOwnedFiles } from '../dist/src/enterprise/sovereign-status-history/executor-persistence-contract.js';
import { GRACE, NS_A, NS_B, T, addSeconds, compose, decisionsFor, makeClock, openIdentity, prepareWorld, requestFor, S } from './fv-p4c2b3b-support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = fileURLToPath(new URL('./fv-p4c2b3c1-executor-entry.mjs', import.meta.url));
const SUPERVISOR_CHILD = fileURLToPath(new URL('./fv-p4c2b3c1-supervisor-child.mjs', import.meta.url));
const B3B_CHILD = fileURLToPath(new URL('./fv-p4c2b3b-child.mjs', import.meta.url));
const PRODUCTION_ENTRY = join(ROOT, 'dist', 'src', 'enterprise', 'sovereign-status-history', 'dedicated-executor-main.js');
const FAST = Object.freeze({ maxRestarts: 2, windowMs: 60_000, baseDelayMs: 50, maxDelayMs: 200 });
const RUNNING = ['READY_INACTIVE', 'DEGRADED', 'QUARANTINED'];
const STATUS_KEYS = ['admittedNamespaces', 'bootstrapExecution', 'configuredNamespaces', 'epoch', 'instanceId', 'lastReason', 'lastReconciliation', 'pendingIntents', 'pid', 'protectedStoreLock', 'protectedStoreSchema', 'quarantinedNamespaces', 'readiness', 'startedAt', 'state'];

const cleanup = [];
const pids = new Set();
after(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    try {
      await step();
    } catch {
      // already stopped
    }
  }
  // Only test-owned processes, by the pids this file saw; never a wildcard.
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(predicate, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function world(options = {}) {
  const w = await prepareWorld({ dir: mkdtempSync(join(tmpdir(), 'fv-p4c2b3c1-')), ...options });
  cleanup.push(() => rmSync(w.dir, { recursive: true, force: true }));
  return w;
}

/** A supervisor in this process over the test-harness executor (or the production entry). */
function supervise(w, extra = {}, { policy = FAST, entry = ENTRY } = {}) {
  const events = [];
  const job = { dir: w.dir, namespaces: w.namespaces, at: T, ...extra };
  const sup = createFvExecutorSupervisor({
    entry,
    args: entry === ENTRY ? [JSON.stringify(job)] : [w.paths.protectedStore],
    policy,
    stopTimeoutMs: 10_000,
    statusTimeoutMs: 5_000,
    onEvent: (event) => {
      events.push(event);
      if (event.snapshot.pid !== null) pids.add(event.snapshot.pid);
    },
  });
  cleanup.push(() => sup.stop());
  const seen = (state, reason) => events.some((e) => e.snapshot.executorState === state && (reason === undefined || e.snapshot.executorReason === reason));
  const runningNow = () => RUNNING.includes(sup.snapshot().executorState) && sup.snapshot().phase === 'running';
  return { sup, events, seen, runningNow };
}

/** Whether another process could open the store now (no executor holds it). Opens no store of ours. */
function openable(path) {
  let db;
  try {
    db = new Database(path, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Every file of `dir` that this test process has open. */
const openHere = (dir) =>
  readdirSync('/proc/self/fd')
    .map((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        return '';
      }
    })
    .filter((target) => target.startsWith(dir));

/** The protected store read after every executor stopped (an exclusive open in this process, closed while held). */
async function readProtected(w, read) {
  const store = await openProtectedContinuityStore(w.paths.protectedStore, { now: () => new Date().toISOString() });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

/** Both humans' decisions for one request, signed through a B3B composition in this process, then closed. */
async function signedJob(w, request = requestFor(NS_A)) {
  const clock = makeClock(T);
  const host = await compose(w, clock);
  const decisions = decisionsFor(host, w.devices, request);
  host.close();
  return { request, signedStatusText: S.active1.text, ...decisions };
}

/** A B3B Host process killed at `killAt` during a real bootstrap: what a crashed executor leaves on disk. */
async function crashLeaving(w, killAt) {
  const bootstrap = await signedJob(w);
  const child = spawn(process.execPath, [B3B_CHILD, JSON.stringify({ mode: 'crash', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), killAt, bootstrap })], { stdio: ['pipe', 'ignore', 'ignore'] });
  pids.add(child.pid);
  const exit = await new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  assert.equal(exit.signal, 'SIGKILL');
  return bootstrap.request.requestId;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('FV-P4C-2B3C-1 dedicated executor — lifecycle under a supervisor, real processes', () => {
  it('8/11/41/42/6/28. normal start: READY_INACTIVE with bootstrap disabled, counts-only status over IPC, no FV file opened here; a requested stop is clean and releases the locks', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w);
    sup.start();
    await waitFor(() => seen('READY_INACTIVE'), 'READY_INACTIVE');
    assert.ok(seen('PREFLIGHT') && seen('ACQUIRING_EXCLUSIVITY') && seen('RECOVERING'), 'the startup states, in order of the relation');
    const status = await sup.status();
    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    assert.equal(status.state, 'READY_INACTIVE');
    assert.equal(status.readiness, 'ready');
    assert.equal(status.bootstrapExecution, 'disabled', 'READY_INACTIVE is never a permission to bootstrap');
    assert.deepEqual([status.configuredNamespaces, status.admittedNamespaces, status.quarantinedNamespaces, status.pendingIntents], [2, 2, 0, 0]);
    assert.equal(status.protectedStoreLock, 'held');
    assert.equal(status.lastReconciliation.outcome, 'completed');
    assert.equal(status.protectedStoreSchema, 'frontera.fv-protected-continuity-store/1');
    assert.ok(status.epoch >= 1);
    assert.equal(status.pid, sup.snapshot().pid);
    assert.doesNotMatch(JSON.stringify(status), /secret|private|token|capabilit|signer|credential|sqlite|\/tmp|-----BEGIN/i, 'no secret, capability, handle or path in a status');
    // The supervisor answered from the executor's memory: this process holds no FV file, and the executor still holds its lock.
    assert.deepEqual(openHere(w.dir), []);
    assert.equal(openable(w.paths.protectedStore), false, 'still held by the executor');
    await sup.stop();
    const snap = sup.snapshot();
    assert.equal(snap.phase, 'stopped');
    assert.deepEqual([snap.lastExit.code, snap.lastExit.signal, snap.lastExit.state, snap.lastExit.decision], [0, null, 'STOPPED', 'stopped']);
    assert.equal(snap.restarts, 0);
    assert.equal(openable(w.paths.protectedStore), true, 'a clean close released the lock');
  });

  it('9. a readiness failure is reported and parked: a protected store writable by others is PATH_REFUSED, never restarted, until the operator acknowledges', { timeout: 60_000 }, async () => {
    const w = await world();
    chmodSync(w.paths.protectedStore, 0o666);
    const { sup } = supervise(w);
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    const snap = sup.snapshot();
    assert.deepEqual([snap.executorState, snap.executorReason, snap.blockedReason, snap.restarts], ['FAILED', 'PATH_REFUSED', 'PATH_REFUSED', 0]);
    assert.ok(alive(snap.pid), 'parked: the executor stays, inactive, holding nothing, so no restart policy can repeat it');
    assert.equal(openable(w.paths.protectedStore), true, 'nothing was opened');
    await sleep(500);
    assert.equal(sup.snapshot().restarts, 0);
    await sup.stop();
    assert.equal(sup.snapshot().phase, 'blocked', 'a stop does not clear the block');
    assert.throws(() => sup.start(), { code: 'BLOCKED' });
    chmodSync(w.paths.protectedStore, 0o600);
    sup.acknowledgeBlock();
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'READY_INACTIVE', 'READY after the operator fixed and acknowledged it');
    await sup.stop();
  });

  it('42. the production entry is inactive by construction: DEPENDENCIES_UNAVAILABLE, nothing opened, blocked', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup } = supervise(w, {}, { entry: PRODUCTION_ENTRY });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.deepEqual([sup.snapshot().executorState, sup.snapshot().executorReason], ['FAILED', 'DEPENDENCIES_UNAVAILABLE']);
    assert.equal(openable(w.paths.protectedStore), true, 'it composes nothing and holds nothing');
    const status = await sup.status();
    assert.deepEqual([status.readiness, status.bootstrapExecution, status.protectedStoreLock], [null, null, 'not-acquired']);
    await sup.stop();
    assert.equal(sup.snapshot().lastExit.code, 0);
  });

  it('3/10/26. two executors over one protected store: exactly one holds it; the other is EXECUTOR_HELD, backs off, and is blocked at the restart limit', { timeout: 90_000 }, async () => {
    const w = await world();
    const first = supervise(w);
    first.sup.start();
    await waitFor(() => first.seen('READY_INACTIVE'), 'first READY');
    const second = supervise(w);
    second.sup.start();
    await waitFor(() => second.sup.snapshot().phase === 'blocked', 'second blocked');
    assert.equal(second.sup.snapshot().blockedReason, 'RESTART_LIMIT');
    assert.equal(second.sup.snapshot().restarts, FAST.maxRestarts);
    assert.ok(second.seen('FAILED', 'EXECUTOR_HELD'));
    assert.equal(second.seen('READY_INACTIVE'), false, 'never composed');
    assert.equal(second.sup.snapshot().lastExit.code, 75);
    assert.equal((await first.sup.status()).state, 'READY_INACTIVE', 'the holder was never disturbed');
    // One supervisor never runs two.
    assert.throws(() => first.sup.start(), { code: 'ALREADY_RUNNING' });
    await first.sup.stop();
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`${signal === 'SIGTERM' ? 12 : 13}. ${signal} from outside: a clean stop that releases the locks; not requested by the supervisor, so it is blocked for the operator, not restarted`, { timeout: 60_000 }, async () => {
      const w = await world();
      const { sup, seen } = supervise(w);
      sup.start();
      await waitFor(() => seen('READY_INACTIVE'), 'READY');
      process.kill(sup.snapshot().pid, signal);
      await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
      const snap = sup.snapshot();
      assert.deepEqual([snap.lastExit.code, snap.lastExit.signal, snap.lastExit.state, snap.lastExit.reason, snap.blockedReason], [0, null, 'STOPPED', `SIGNAL_${signal}`, 'UNEXPLAINED_CLEAN_EXIT']);
      assert.equal(openable(w.paths.protectedStore), true);
    });
  }

  it('14/16. SIGKILL: no cleanup runs; the supervisor restarts it with backoff, and the new executor holds a new epoch', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w);
    sup.start();
    await waitFor(() => seen('READY_INACTIVE'), 'READY');
    const before = await sup.status();
    process.kill(before.pid, 'SIGKILL');
    await waitFor(async () => sup.snapshot().restarts === 1 && (await sup.status())?.instanceId !== before.instanceId && sup.snapshot().executorState === 'READY_INACTIVE', 'restarted and READY');
    const after = await sup.status();
    assert.equal(sup.snapshot().lastExit.signal, 'SIGKILL');
    assert.ok(after.epoch > before.epoch, 'a new execution context, never the old one resumed');
    await sup.stop();
  });

  it('15/17. an unexpected exit with its locks held is restarted; a crash loop is stopped at the restart limit', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup } = supervise(w, { fault: 'exit-nonzero' });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.deepEqual([sup.snapshot().lastExit.code, sup.snapshot().blockedReason, sup.snapshot().restarts], [9, 'RESTART_LIMIT', FAST.maxRestarts]);
    assert.equal(openable(w.paths.protectedStore), true, 'nothing is left holding the store');
  });

  for (const [fault, reason] of [['uncaught', 'UNCAUGHT_EXCEPTION'], ['rejection', 'UNHANDLED_REJECTION']]) {
    it(`an ${reason === 'UNCAUGHT_EXCEPTION' ? 'uncaught exception' : 'unhandled rejection'}: FAILED with its code, a guarded close, exit 70, bounded restarts`, { timeout: 60_000 }, async () => {
      const w = await world();
      const { sup, seen } = supervise(w, { fault });
      sup.start();
      await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
      assert.ok(seen('FAILED', reason));
      assert.deepEqual([sup.snapshot().lastExit.code, sup.snapshot().lastExit.signal, sup.snapshot().blockedReason], [70, null, 'RESTART_LIMIT']);
      assert.equal(openable(w.paths.protectedStore), true);
    });
  }

  it('restart during recovery: killed while RECOVERING, the next executor recovers; and a requested stop during recovery waits for the running reconciliation', { timeout: 90_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w, { slowReconcileMs: 1500 });
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'RECOVERING', 'RECOVERING');
    process.kill(sup.snapshot().pid, 'SIGKILL');
    await waitFor(() => sup.snapshot().restarts === 1 && sup.snapshot().executorState === 'READY_INACTIVE', 'restarted and READY');
    assert.ok(seen('READY_INACTIVE'));
    await sup.stop();
    // Now a stop during recovery: it is not abandoned.
    const second = supervise(w, { slowReconcileMs: 1500 });
    second.sup.start();
    await waitFor(() => second.sup.snapshot().executorState === 'RECOVERING', 'RECOVERING');
    const started = Date.now();
    await second.sup.stop();
    assert.ok(Date.now() - started >= 900, 'the stop waited for the reconciliation in flight');
    assert.deepEqual([second.sup.snapshot().lastExit.code, second.sup.snapshot().lastExit.state], [0, 'STOPPED']);
  });
});

// ── Authority loss and fail-stop ────────────────────────────────────────────

describe('FV-P4C-2B3C-1 dedicated executor — authority loss and fail-stop', () => {
  it('21/1. lock lost while running: EXECUTOR_AUTHORITY_LOST, ended by SIGKILL; the supervising process is untouched and no intent changes', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w, { fault: 'drop-lock', watchIntervalMs: 100 });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.ok(seen('EXECUTOR_AUTHORITY_LOST', 'AUTHORITY_LOST'));
    assert.equal(sup.snapshot().lastExit.signal, 'SIGKILL');
    assert.equal(sup.snapshot().blockedReason, 'RESTART_LIMIT');
    assert.equal(process.exitCode ?? 0, 0, 'this process (the supervisor) runs on');
    const intents = await readProtected(w, (store) => [...store.intentLog(NS_A), ...store.intentLog(NS_B)]);
    assert.deepEqual(intents, []);
  });

  it('publication review M: a history lock lost while running is authority lost too: no false readiness, SIGKILL', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w, { fault: 'drop-history-lock', watchIntervalMs: 100 }, { policy: { ...FAST, maxRestarts: 0 } });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.ok(seen('EXECUTOR_AUTHORITY_LOST', 'AUTHORITY_LOST'));
    assert.deepEqual([sup.snapshot().lastExit.signal, sup.snapshot().blockedReason], ['SIGKILL', 'RESTART_LIMIT']);
  });

  it('the B3B exit-listener edge, closed in the dedicated process: an earlier exit listener that exits again, and an exit cached before the wrapper, still end by SIGKILL', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup } = supervise(w, { fault: 'reexit' }, { policy: { ...FAST, maxRestarts: 0 } });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.deepEqual([sup.snapshot().lastExit.code, sup.snapshot().lastExit.signal], [null, 'SIGKILL'], 'neither exit code 0 nor the listener’s 3: the prepended guard stopped it first');
  });

  it('22/23/24/25. a stale executor: another commits while it is stale; its shutdown is a fail-stop without any close; the new holder’s state survives', { timeout: 90_000 }, async () => {
    const w = await world();
    // A notices nothing on its own (a long watch): its locks are silently dropped once it is ready (B3C-3: all of
    // them, its bootstrap identity store's included; with that one kept, no takeover is possible at all, below).
    const stale = supervise(w, { fault: 'drop-all-locks', watchIntervalMs: 60_000 }, { policy: { ...FAST, maxRestarts: 0 } });
    stale.sup.start();
    await waitFor(() => stale.seen('READY_INACTIVE'), 'stale READY');
    await waitFor(() => openable(w.paths.protectedStore), 'the stale lock dropped');
    const holder = supervise(w);
    holder.sup.start();
    await waitFor(() => holder.runningNow(), 'new holder running');
    const held = await holder.sup.status();
    assert.deepEqual([held.state, held.protectedStoreLock, held.admittedNamespaces, held.quarantinedNamespaces], ['READY_INACTIVE', 'held', 2, 0]);
    // The stale executor is asked to stop: it must not close (a closing checkpoint would write the holder's files).
    await stale.sup.stop();
    assert.equal(stale.sup.snapshot().lastExit.signal, 'SIGKILL');
    assert.deepEqual([stale.sup.snapshot().phase, stale.sup.snapshot().blockedReason], ['blocked', 'UNCLEAN_STOP'], 'an unclean stop needs the operator before the next start');
    assert.ok(stale.seen('EXECUTOR_AUTHORITY_LOST', 'AUTHORITY_LOST_DURING_SHUTDOWN'));
    const still = await holder.sup.status();
    assert.deepEqual([still.state, still.protectedStoreLock, still.epoch], ['READY_INACTIVE', 'held', held.epoch], 'no state of the new holder changed');
    await holder.sup.stop();
    // The holder's epoch is durable and the store is intact (the open runs quick_check and the trigger set).
    const epoch = await readProtected(w, (store) => store.epoch);
    assert.equal(epoch, held.epoch + 1);
  });

  it('B3C-3. a stale executor that lost its protected-store lock but still holds its bootstrap identity store blocks every takeover (one identity owner)', { timeout: 90_000 }, async () => {
    const w = await world();
    const stale = supervise(w, { fault: 'drop-lock', watchIntervalMs: 60_000 }, { policy: { ...FAST, maxRestarts: 0 } });
    stale.sup.start();
    await waitFor(() => stale.seen('READY_INACTIVE'), 'stale READY');
    await waitFor(() => openable(w.paths.protectedStore), 'the stale protected-store lock dropped');
    const second = supervise(w);
    second.sup.start();
    await waitFor(() => second.sup.snapshot().phase === 'blocked', 'second blocked');
    assert.ok(second.seen('FAILED', 'EXECUTOR_HELD'), 'refused at the identity store, which has one owner');
    assert.equal(second.seen('READY_INACTIVE'), false);
    assert.equal(openable(w.paths.identity), false, 'the identity store is still held by its one owner');
    await stale.sup.stop();
    assert.equal(stale.sup.snapshot().lastExit.signal, 'SIGKILL', 'the stale owner ends by fail-stop, never a close');
  });

  it('22. lock lost during shutdown itself: no close, fail-stop', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w, { fault: 'drop-lock-on-stop' });
    sup.start();
    await waitFor(() => seen('READY_INACTIVE'), 'READY');
    await sup.stop();
    assert.equal(sup.snapshot().lastExit.signal, 'SIGKILL');
    assert.ok(seen('EXECUTOR_AUTHORITY_LOST', 'AUTHORITY_LOST_DURING_SHUTDOWN'));
    assert.equal(sup.snapshot().blockedReason, 'UNCLEAN_STOP');
    assert.throws(() => sup.start(), { code: 'BLOCKED' });
    assert.equal(await readProtected(w, (store) => store.intentLog(NS_A).length), 0);
  });

  it('2. the supervisor dies: its executor stops cleanly on its own, bootstraps nothing, and releases the lock', { timeout: 60_000 }, async () => {
    const w = await world();
    const parent = spawn(process.execPath, [SUPERVISOR_CHILD, JSON.stringify({ dir: w.dir, namespaces: w.namespaces, at: T })], { stdio: ['ignore', 'pipe', 'ignore'] });
    pids.add(parent.pid);
    cleanup.push(() => parent.kill('SIGKILL'));
    let buffer = '';
    let executorPid;
    parent.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const event = JSON.parse(line);
        if (event.state === 'READY_INACTIVE') executorPid = event.pid;
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    await waitFor(() => executorPid !== undefined, 'executor READY under the supervisor process');
    pids.add(executorPid);
    assert.equal(openable(w.paths.protectedStore), false);
    parent.kill('SIGKILL');
    await waitFor(() => !alive(executorPid), 'the orphaned executor stopped');
    assert.equal(openable(w.paths.protectedStore), true, 'a clean stop released the lock');
    assert.deepEqual(await readProtected(w, (store) => store.intentLog(NS_A)), [], 'nothing was bootstrapped');
  });
});

// ── Recovery ────────────────────────────────────────────────────────────────

describe('FV-P4C-2B3C-1 dedicated executor — recovery and quarantine across restarts', () => {
  it('18/29/31/32. a pending intent without evidence survives restarts: its namespace quarantined, its decisions unresolved, never cleared, never improving in place', { timeout: 90_000 }, async () => {
    const w = await world();
    const requestId = await crashLeaving(w, 'before:commit');
    const { sup } = supervise(w, { at: addSeconds(T, GRACE + 60), watchIntervalMs: 100 });
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'DEGRADED', 'DEGRADED');
    const first = await sup.status();
    assert.deepEqual([first.pendingIntents, first.admittedNamespaces, first.quarantinedNamespaces], [1, 1, 1]);
    assert.ok(first.lastReconciliation.unresolved >= 1, 'past the grace bound, an uncertain run is still never settled not-committed');
    await sleep(600);
    assert.equal((await sup.status()).state, 'DEGRADED', 'no timer or poll improves it');
    process.kill(first.pid, 'SIGKILL');
    await waitFor(async () => sup.snapshot().restarts === 1 && sup.snapshot().executorState === 'DEGRADED' && (await sup.status())?.instanceId !== first.instanceId, 'restarted');
    assert.equal((await sup.status()).pendingIntents, 1, 'a restart clears no intent');
    await sup.stop();
    const log = await readProtected(w, (store) => store.intentLog(NS_A));
    assert.deepEqual(log.map((i) => [i.requestId, i.state]), [[requestId, 'pending']]);
  });

  it('30. committed evidence is recovered after a crash: the intent completes by evidence and both decisions settle', { timeout: 90_000 }, async () => {
    const w = await world();
    const requestId = await crashLeaving(w, 'after:commit');
    const { sup } = supervise(w, { at: addSeconds(T, GRACE + 60) });
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'READY_INACTIVE', 'READY');
    const status = await sup.status();
    assert.equal(status.pendingIntents, 0);
    assert.deepEqual([status.lastReconciliation.entries, status.lastReconciliation.unresolved], [2, 0]);
    await sup.stop();
    const log = await readProtected(w, (store) => store.intentLog(NS_A));
    assert.deepEqual(log.map((i) => [i.requestId, i.state]), [[requestId, 'completed']]);
  });

  it('19/33. a corrupt history is quarantined; the healthy namespace stays admitted', { timeout: 60_000 }, async () => {
    const w = await world();
    const fd = openSync(w.paths.history(NS_B), 'r+');
    writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
    closeSync(fd);
    const { sup } = supervise(w);
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'DEGRADED', 'DEGRADED');
    const status = await sup.status();
    assert.deepEqual([status.admittedNamespaces, status.quarantinedNamespaces, status.readiness], [1, 1, 'degraded']);
    await sup.stop();
  });

  it('20. a history of another namespace configured under this one is quarantined', { timeout: 60_000 }, async () => {
    const w = await world();
    const other = join(w.dir, 'other.sqlite');
    (await openSqliteStatusHighWaterMarkStore(other, { namespace: 'receiver:other', create: true })).close();
    const { sup } = supervise(w, { histories: [{ namespace: NS_A, databasePath: w.paths.history(NS_A) }, { namespace: NS_B, databasePath: other }] });
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'DEGRADED', 'DEGRADED');
    assert.equal((await sup.status()).quarantinedNamespaces, 1);
    await sup.stop();
  });

  it('34/35. a missing history is never recreated, and its record is never re-anchored', { timeout: 60_000 }, async () => {
    const w = await world();
    const recordBefore = await readProtected(w, (store) => store.load(NS_B));
    unlinkSync(w.paths.history(NS_B));
    const { sup } = supervise(w);
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'DEGRADED', 'DEGRADED');
    await sup.stop();
    assert.equal(existsSync(w.paths.history(NS_B)), false);
    assert.deepEqual(await readProtected(w, (store) => store.load(NS_B)), recordBefore);
  });

  it('27. trust limitation, documented: a same-user writer is not stopped by the lock; the damage is detected and quarantined at the next start', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup } = supervise(w);
    sup.start();
    await waitFor(() => sup.snapshot().executorState === 'READY_INACTIVE', 'READY');
    // Another process of the same user writes the held file directly: POSIX advisory locks do not prevent it.
    const writer = spawnSync(process.execPath, ['-e', `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(w.paths.history(NS_B))},'r+');fs.writeSync(fd,Buffer.alloc(100,0x42),0,100,0);fs.closeSync(fd);`], { timeout: 10_000 });
    assert.equal(writer.status, 0, 'the write succeeded: outside current protection');
    await sup.stop();
    const again = supervise(w);
    again.sup.start();
    await waitFor(() => again.sup.snapshot().executorState === 'DEGRADED', 'DEGRADED at the next start');
    assert.equal((await again.sup.status()).quarantinedNamespaces, 1);
    await again.sup.stop();
  });
});

// ── Interface, custody and refusal ──────────────────────────────────────────

describe('FV-P4C-2B3C-1 dedicated executor — the IPC channel, custody and refusals', () => {
  it('36/37/38/39/40. arbitrary, malformed and oversized commands are refused; events and status carry codes and counts only', { timeout: 60_000 }, async () => {
    const w = await world();
    const child = fork(ENTRY, [JSON.stringify({ dir: w.dir, namespaces: w.namespaces, at: T })], { execArgv: ['--disable-sigusr1'], env: {}, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    pids.add(child.pid);
    cleanup.push(() => child.kill('SIGKILL'));
    const messages = [];
    child.on('message', (m) => messages.push(m));
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    await waitFor(() => messages.some((m) => m.type === 'lifecycle' && m.state === 'READY_INACTIVE'), 'READY');
    const reply = async (command, id) => {
      const count = messages.length;
      child.send(command);
      return waitFor(() => messages.slice(count).find((m) => m.type !== 'lifecycle' && (id === undefined || m.id === id)), 'a reply');
    };
    const P = FV_EXECUTOR_IPC_PROTOCOL;
    for (const type of ['bootstrap', 'reconcile', 'beginBootstrapDecision', 'exec', 'sql', 'snapshot']) {
      assert.deepEqual(await reply({ protocol: P, type, id: `c-${type.length}` }, `c-${type.length}`), { protocol: P, type: 'rejected', id: `c-${type.length}`, reason: 'COMMAND_UNKNOWN' }, type);
    }
    for (const bad of [[1, 2], 'status', { type: 'status', id: 'm1' }, { protocol: P, type: 'status', id: 'm2', extra: true }, { protocol: 'other/1', type: 'status', id: 'm3' }, { protocol: P, type: 'status', id: 'bad id!' }, { protocol: P, type: 'status' }]) {
      assert.equal((await reply(bad)).reason, 'MALFORMED', JSON.stringify(bad));
    }
    assert.equal((await reply({ protocol: P, type: 'status', id: 'o1', pad: 'x'.repeat(4096) })).reason, 'OVERSIZED');
    const status = (await reply({ protocol: P, type: 'status', id: 's1' }, 's1')).status;
    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    for (const [key, value] of Object.entries(status)) assert.ok(value === null || ['string', 'number'].includes(typeof value) || key === 'lastReconciliation', key);
    for (const event of messages.filter((m) => m.type === 'lifecycle')) assert.deepEqual(Object.keys(event).sort(), ['at', 'instanceId', 'protocol', 'reason', 'state', 'type']);
    assert.equal(status.state, 'READY_INACTIVE', 'nothing above changed the executor');
    child.send({ protocol: P, type: 'stop', id: 'x1' });
    assert.deepEqual(await exited, { code: 0, signal: null });
  });

  it('4. a worker thread is refused before anything is opened', { timeout: 30_000 }, async () => {
    const url = new URL('../dist/src/enterprise/sovereign-status-history/dedicated-executor.js', import.meta.url).href;
    const worker = new Worker(`import(${JSON.stringify(url)}).then(({ runDedicatedFvExecutor }) => { try { runDedicatedFvExecutor({ protectedStorePath: '/nonexistent', compose: undefined }); require('node:worker_threads').parentPort.postMessage('RAN'); } catch (e) { require('node:worker_threads').parentPort.postMessage(e.code); } });`, { eval: true });
    const code = await new Promise((done) => worker.once('message', done));
    await worker.terminate();
    assert.equal(code, 'PLATFORM_UNSUPPORTED');
  });

  it('5. an unsupported platform is refused, parked and blocked; nothing is opened', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup } = supervise(w, { platform: 'darwin' });
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    assert.deepEqual([sup.snapshot().executorState, sup.snapshot().executorReason], ['FAILED', 'PLATFORM_UNSUPPORTED']);
    assert.equal(openable(w.paths.protectedStore), true);
    await sup.stop();
  });

  it('it never runs in its caller’s process: without a supervisor’s IPC channel it refuses and exits 78, opening nothing', { timeout: 60_000 }, async () => {
    const w = await world();
    const run = spawnSync(process.execPath, [ENTRY, JSON.stringify({ dir: w.dir, namespaces: w.namespaces, at: T })], { timeout: 30_000, encoding: 'utf8' });
    assert.equal(run.status, 78);
    assert.match(run.stderr, /NOT_A_DEDICATED_PROCESS/);
    assert.equal(openable(w.paths.protectedStore), true);
    const production = spawnSync(process.execPath, [PRODUCTION_ENTRY, w.paths.protectedStore], { timeout: 30_000, encoding: 'utf8' });
    assert.equal(production.status, 78);
  });

  it('review M1: SIGUSR1 from another process of the same user opens no inspector in the executor', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w);
    sup.start();
    await waitFor(() => seen('READY_INACTIVE'), 'READY');
    const { pid } = sup.snapshot();
    process.kill(pid, 'SIGUSR1');
    await sleep(500);
    assert.ok(alive(pid));
    await assert.rejects(fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(2000) }), 'no inspector listens');
    assert.equal((await sup.status()).state, 'READY_INACTIVE');
    await sup.stop();
    assert.equal(sup.snapshot().lastExit.code, 0);
  });

  for (const foreign of ['server', 'handler']) {
    it(`review L1: a process already doing other work (${foreign === 'server' ? 'a listening socket' : 'its own failure handler'}) is not a dedicated executor: refused, parked, blocked`, { timeout: 60_000 }, async () => {
      const w = await world();
      const { sup } = supervise(w, { foreign });
      sup.start();
      await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
      assert.deepEqual([sup.snapshot().executorState, sup.snapshot().executorReason], ['FAILED', 'NOT_A_DEDICATED_PROCESS']);
      assert.equal(openable(w.paths.protectedStore), true);
      await sup.stop();
    });
  }

  it('the executor is launched with no inherited environment and only --disable-sigusr1, whatever the supervising process has', { timeout: 60_000 }, async () => {
    const w = await world();
    process.env.FV_P4C2B3C1_CANARY = 'must-not-reach-the-executor';
    try {
      const { sup, seen } = supervise(w, { reportLaunch: true });
      sup.start();
      await waitFor(() => seen('READY_INACTIVE'), 'READY');
      const { pid } = sup.snapshot();
      const launch = JSON.parse((await import('node:fs')).readFileSync(join(w.dir, `launch-${pid}.json`), 'utf8'));
      assert.deepEqual(launch, { env: [], execArgv: ['--disable-sigusr1'] });
      await sup.stop();
    } finally {
      delete process.env.FV_P4C2B3C1_CANARY;
    }
  });

  it('review L4: a status carrying anything beyond its exact fields (here a path) is not passed on by the supervisor', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, seen } = supervise(w, { fault: 'leaky-status' });
    sup.start();
    await waitFor(() => seen('READY_INACTIVE'), 'READY');
    assert.equal(await sup.status(), undefined);
    await sup.stop();
  });

  it('publication review: the executor itself refuses an inspector exposure, whoever launched it (no --disable-sigusr1, an inspect flag, NODE_OPTIONS)', { timeout: 60_000 }, async () => {
    const w = await world();
    const job = JSON.stringify({ dir: w.dir, namespaces: w.namespaces, at: T });
    for (const [execArgv, env] of [[[], {}], [['--disable-sigusr1', '--inspect-port=0'], {}], [['--disable-sigusr1'], { NODE_OPTIONS: '--no-warnings' }]]) {
      const child = fork(ENTRY, [job], { execArgv, env, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      pids.add(child.pid);
      const event = await new Promise((done) => child.on('message', (m) => m.type === 'lifecycle' && done(m)));
      assert.deepEqual([event.state, event.reason], ['FAILED', 'DEBUG_EXPOSED'], JSON.stringify(execArgv));
      child.send({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'stop', id: 'x' });
      await new Promise((done) => child.on('exit', done));
    }
    assert.equal(openable(w.paths.protectedStore), true);
  });

  it('publication review: lifecycle events that are not exactly an event (here an instance id carrying a path) never reach the snapshot or the log', { timeout: 60_000 }, async () => {
    const w = await world();
    const { sup, events } = supervise(w, { fault: 'leaky-lifecycle' });
    sup.start();
    await waitFor(async () => (await sup.status())?.state === 'READY_INACTIVE', 'READY by status');
    assert.equal(sup.snapshot().executorState, null);
    assert.equal(sup.snapshot().instanceId, null);
    assert.doesNotMatch(JSON.stringify(events), /sqlite|\/tmp/);
    await sup.stop();
    assert.equal(sup.snapshot().lastExit.code, 0);
  });

  it('publication review: a blocked supervisor cannot be started from inside the exit of its stop', { timeout: 60_000 }, async () => {
    const w = await world();
    let attempt;
    const sup = createFvExecutorSupervisor({
      entry: PRODUCTION_ENTRY,
      args: [w.paths.protectedStore],
      policy: FAST,
      onEvent: (event) => {
        if (event.snapshot.pid !== null) pids.add(event.snapshot.pid);
        if (event.kind === 'exit') {
          try {
            sup.start();
            attempt = 'ACCEPTED';
          } catch (error) {
            attempt = error.code;
          }
        }
      },
    });
    cleanup.push(() => sup.stop());
    sup.start();
    await waitFor(() => sup.snapshot().phase === 'blocked', 'blocked');
    await sup.stop();
    assert.equal(attempt, 'BLOCKED');
    assert.deepEqual([sup.snapshot().phase, sup.snapshot().pid], ['blocked', null]);
  });

  it('the supervisor validates its entry and arguments, and starts the child with no inherited flags or environment', () => {
    for (const entry of ['relative/entry.js', '/abs/entry.sh', '', '/abs/\0.js']) assert.throws(() => createFvExecutorSupervisor({ entry }), { code: 'OPTIONS_INVALID' }, entry);
    assert.throws(() => createFvExecutorSupervisor({ entry: ENTRY, args: Array(9).fill('a') }), { code: 'OPTIONS_INVALID' });
    // Review L2: no policy that storms or overflows a timer.
    for (const policy of [{ ...FAST, maxRestarts: -1 }, { ...FAST, windowMs: 0 }, { ...FAST, baseDelayMs: 0 }, { ...FAST, maxDelayMs: 2 ** 31 }, { ...FAST, baseDelayMs: 500, maxDelayMs: 100 }, { ...FAST, maxRestarts: 1e6 }]) {
      assert.throws(() => createFvExecutorSupervisor({ entry: ENTRY, policy }), { code: 'OPTIONS_INVALID' }, JSON.stringify(policy));
    }
    assert.throws(() => createFvExecutorSupervisor({ entry: ENTRY, stopTimeoutMs: 2 ** 31 }), { code: 'OPTIONS_INVALID' });
  });
});

// ── The contracts, as pure functions ────────────────────────────────────────

describe('FV-P4C-2B3C-1 contracts — the transition relation, the restart policy, the command parser, persistence ownership', () => {
  it('the transition relation: health never improves in place, and the terminal states lead nowhere', () => {
    assert.equal(FV_EXECUTOR_TRANSITIONS.DEGRADED.includes('READY_INACTIVE'), false);
    for (const better of ['READY_INACTIVE', 'DEGRADED', 'RECOVERING']) assert.equal(FV_EXECUTOR_TRANSITIONS.QUARANTINED.includes(better), false);
    for (const terminal of ['STOPPED', 'FAILED', 'EXECUTOR_AUTHORITY_LOST']) assert.deepEqual(FV_EXECUTOR_TRANSITIONS[terminal], []);
    for (const [from, to] of Object.entries(FV_EXECUTOR_TRANSITIONS)) assert.equal(to.includes(from), false, `${from} is no self-transition`);
    assert.ok(Object.isFrozen(FV_EXECUTOR_TRANSITIONS) && Object.values(FV_EXECUTOR_TRANSITIONS).every(Object.isFrozen));
  });

  it('decideAfterExit: requested stops never restart; non-retryable reasons and unexplained clean exits block; crashes back off to a limit', () => {
    const base = { code: null, signal: 'SIGKILL', lastState: 'READY_INACTIVE', lastReason: null, stopRequested: false };
    assert.deepEqual(decideAfterExit({ ...base, code: 0, signal: null, lastState: 'STOPPED', stopRequested: true }, [], 0), { action: 'stopped', clean: true });
    assert.deepEqual(decideAfterExit({ ...base, stopRequested: true }, [], 0), { action: 'blocked', reason: 'UNCLEAN_STOP' });
    assert.deepEqual(decideAfterExit({ ...base, signal: 'SIGKILL', lastState: 'EXECUTOR_AUTHORITY_LOST', lastReason: 'AUTHORITY_LOST_DURING_SHUTDOWN', stopRequested: true }, [], 0), { action: 'blocked', reason: 'UNCLEAN_STOP' });
    for (const reason of ['PATH_REFUSED', 'PROTECTED_STORE_REFUSED', 'CUSTODY_REFUSED', 'OPTIONS_INVALID', 'PLATFORM_UNSUPPORTED', 'DEPENDENCIES_UNAVAILABLE', 'COMPOSITION_FAILED']) {
      assert.deepEqual(decideAfterExit({ ...base, code: 0, signal: null, lastState: 'FAILED', lastReason: reason }, [], 0), { action: 'blocked', reason });
    }
    assert.deepEqual(decideAfterExit({ ...base, code: 78, signal: null, lastState: null }, [], 0), { action: 'blocked', reason: 'REFUSED_TO_RUN' });
    assert.deepEqual(decideAfterExit({ ...base, code: 0, signal: null, lastState: 'STOPPED', lastReason: 'SIGNAL_SIGTERM' }, [], 0), { action: 'blocked', reason: 'UNEXPLAINED_CLEAN_EXIT' });
    const policy = FV_EXECUTOR_DEFAULT_RESTART_POLICY;
    assert.deepEqual(decideAfterExit(base, [], 1e9, policy), { action: 'restart', delayMs: policy.baseDelayMs, attempt: 1 });
    assert.deepEqual(decideAfterExit({ ...base, code: 75, signal: null, lastState: 'FAILED', lastReason: 'EXECUTOR_HELD' }, [1e9 - 10], 1e9, policy), { action: 'restart', delayMs: policy.baseDelayMs * 2, attempt: 2 });
    assert.deepEqual(decideAfterExit({ ...base, lastState: 'EXECUTOR_AUTHORITY_LOST', lastReason: 'AUTHORITY_LOST' }, [1e9 - 30, 1e9 - 20, 1e9 - 10], 1e9, policy), { action: 'blocked', reason: 'RESTART_LIMIT' });
    assert.equal(decideAfterExit(base, [1e9 - policy.windowMs - 1, 1e9 - policy.windowMs - 2, 1e9 - policy.windowMs - 3], 1e9, policy).action, 'restart', 'old restarts leave the window');
    assert.equal(decideAfterExit(base, [], 0, { ...policy, baseDelayMs: 50_000, maxDelayMs: 60_000 }).delayMs, 50_000);
    assert.equal(decideAfterExit(base, [0, 1], 2, { ...policy, baseDelayMs: 50_000, maxDelayMs: 60_000 }).delayMs, 60_000);
  });

  it('parseFvExecutorCommand accepts exactly status and stop', () => {
    const P = FV_EXECUTOR_IPC_PROTOCOL;
    assert.deepEqual(parseFvExecutorCommand({ protocol: P, type: 'status', id: 'a' }), { ok: true, command: { protocol: P, type: 'status', id: 'a' } });
    assert.equal(parseFvExecutorCommand({ protocol: P, type: 'stop', id: 'b' }).ok, true);
    assert.equal(parseFvExecutorCommand(Object.assign(Object.create({ polluted: true }), { protocol: P, type: 'status', id: 'c' })).reason, 'MALFORMED');
    assert.equal(parseFvExecutorCommand(undefined).reason, 'MALFORMED');
    const cyclic = { protocol: P, type: 'status', id: 'd' };
    cyclic.self = cyclic;
    assert.equal(parseFvExecutorCommand(cyclic).reason, 'MALFORMED');
    assert.equal(parseFvExecutorCommand({ protocol: P, type: 'status', id: 'x'.repeat(65) }).reason, 'MALFORMED');
  });

  it('the persistence ownership contract (PROD-02 preparation): the executor owns its stores; backup is executor-mediated or cold, both deferred', () => {
    const c = FV_EXECUTOR_PERSISTENCE_CONTRACT;
    assert.equal(c.owner, 'frontera.fv-dedicated-executor');
    assert.deepEqual(c.stores.map((s) => [s.kind, s.schemaIdentity, s.cardinality]), [
      ['protected-continuity-store', 'frontera.fv-protected-continuity-store/1', 'one'],
      ['status-history', 'frontera.sovereign-status-history.v2', 'per-namespace'],
      ['bootstrap-identity-store', 'frontera.human-identity-store (AUTH-03 schema 2), bootstrap-authority domain', 'one'],
    ]);
    assert.deepEqual(c.snapshotModes.map((m) => [m.mode, m.status]), [['executor-mediated', 'deferred-to-B3C-2'], ['cold', 'deferred-to-B3C-2']]);
    assert.ok(c.forbiddenWhileExecutorActive.some((rule) => /inside the executor process/.test(rule)));
    // Review M2, closed by B3C-3: the executor owns its own bootstrap identity store; AUTH-04A's is never opened by it.
    assert.deepEqual(c.notOwned.map((n) => [n.kind, n.owner, n.activationBlocker]), [['auth04a-host-identity-store', 'AUTH-04A (the Enterprise Host)', false]]);
    assert.deepEqual(fvExecutorOwnedFiles('/p/s', ['/p/a']), ['/p/s', '/p/s-wal', '/p/s-shm', '/p/s-journal', '/p/a', '/p/a-wal', '/p/a-shm', '/p/a-journal']);
  });
});
