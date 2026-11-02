// FV-P4C-2B3C-1 — a TEST-ONLY dedicated executor entry: the real executor runtime
// (runDedicatedFvExecutorOrRefuse) over the B3B synthetic world (synthetic identity, temporary
// databases), with NO status source (bootstrap execution disabled, as in production). It is the
// deliberately separate harness the production entry (dedicated-executor-main.js) is not: nothing
// outside tests starts it. Not a test file itself.
//
// argv[2] is a JSON job: { dir, namespaces, at, histories?, watchIntervalMs?, slowReconcileMs?, fault?, faultAfterMs?, platform? }.
// Faults, injected by this harness only (the executor has no command for any of them):
// - `uncaught`: throw from a timer;  `rejection`: an unhandled rejection;  `exit-nonzero`: process.exit(9);
// - `drop-lock`: a raw open/close of the protected store (this process's POSIX locks are dropped);
// - `drop-lock-on-stop`: the same, at the moment a stop command arrives;
// - `reexit`: an `exit` listener registered BEFORE the executor that calls process.exit(3) again, then
//   the lock dropped, then a process.exit(0) cached before the executor wrapped it (the B3B exit-listener edge).
import { closeSync, openSync } from 'node:fs';

const job = JSON.parse(process.argv[2]);
if (job.platform !== undefined) Object.defineProperty(process, 'platform', { value: job.platform });
// A dependency that cached process.exit before the executor started bypasses its wrapper: the prepended
// fail-stop `exit` listener must still run first, ahead of this earlier listener that exits again.
const cachedExit = process.exit.bind(process);
// It exits again through the cached (unwrapped) exit, so only the prepended listener can stop it first.
if (job.fault === 'reexit') process.on('exit', () => cachedExit(3));

// Review L1: a process already doing other work (a listening socket, its own failure handler) is refused.
if (job.foreign === 'server') {
  const { createServer } = await import('node:net');
  await new Promise((done) => createServer().listen(0, '127.0.0.1', done));
}
if (job.foreign === 'handler') process.on('uncaughtException', () => undefined);

// What the supervisor handed this process: its environment keys and Node flags, written into the world.
if (job.reportLaunch) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${job.dir}/launch-${process.pid}.json`, JSON.stringify({ env: Object.keys(process.env), execArgv: process.execArgv }));
}

const { runDedicatedFvExecutorOrRefuse } = await import('../dist/src/enterprise/sovereign-status-history/dedicated-executor.js');
const { compose, makeClock, openIdentity, pathsOf } = await import('./fv-p4c2b3b-support.mjs');

const paths = pathsOf(job.dir);
const dropLock = () => closeSync(openSync(paths.protectedStore, 'r'));
const clock = makeClock(job.at);

const composeHere = async () => {
  const identity = await openIdentity(job.dir, clock);
  const world = { paths, namespaces: job.namespaces };
  const overrides = { statusSource: undefined };
  if (Array.isArray(job.histories)) overrides.configuration = () => ({ generation: 1, histories: job.histories });
  let host;
  try {
    host = await compose(world, identity, clock, overrides);
  } catch (error) {
    identity.close();
    throw error;
  }
  if (job.slowReconcileMs === undefined) return host;
  // Only the timing of reconciliation changes: the runtime sees the same three methods it uses.
  return {
    status: () => host.status(),
    close: () => host.close(),
    reconcile: async () => {
      await new Promise((done) => setTimeout(done, job.slowReconcileMs));
      return host.reconcile();
    },
  };
};


// Faults fire `faultAfterMs` after the executor first reports a running state (observed on its own IPC sends).
const RUNNING = new Set(['READY_INACTIVE', 'DEGRADED', 'QUARANTINED']);
let armed = job.fault !== undefined && !['drop-lock-on-stop', 'leaky-status', 'leaky-lifecycle'].includes(job.fault);
if (typeof process.send === 'function') {
  const send = process.send.bind(process);
  process.send = (message, ...rest) => {
    // `leaky-status`: a compromised executor adds a path to its status; the supervisor must not pass it on.
    if (job.fault === 'leaky-lifecycle' && message?.type === 'lifecycle') message = { ...message, instanceId: `${message.instanceId} ${paths.protectedStore}` };
    if (job.fault === 'leaky-status' && message?.type === 'status') message = { ...message, status: { ...message.status, protectedStorePath: paths.protectedStore } };
    if (armed && message?.type === 'lifecycle' && RUNNING.has(message.state)) {
      armed = false;
      setTimeout(fire, job.faultAfterMs ?? 100);
    }
    return send(message, ...rest);
  };
}
function fire() {
  if (job.fault === 'uncaught') throw new Error('synthetic uncaught failure');
  if (job.fault === 'rejection') void Promise.reject(new Error('synthetic rejection'));
  if (job.fault === 'exit-nonzero') process.exit(9);
  if (job.fault === 'drop-lock') dropLock();
  // A history's lock only (publication review M): the protected store stays held.
  if (job.fault === 'drop-history-lock') closeSync(openSync(paths.history(job.namespaces[0]), 'r'));
  if (job.fault === 'reexit') {
    dropLock();
    cachedExit(0);
  }
}

runDedicatedFvExecutorOrRefuse({ protectedStorePath: paths.protectedStore, compose: composeHere, ...(job.watchIntervalMs !== undefined ? { watchIntervalMs: job.watchIntervalMs } : {}) });
// After the executor is running (it refuses a process that already has message listeners).
if (job.fault === 'drop-lock-on-stop') {
  process.prependListener('message', (message) => {
    if (message?.type === 'stop') dropLock();
  });
}
