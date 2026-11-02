// FV-P4C-2B3B — a second Host process for the multi-process and crash tests. Not a test file itself.
//
// argv[2] is a JSON job: { mode, dir, ... }. Modes:
// - `hold`: compose and hold the executor until stdin closes or the process is killed. With `dropLocks`,
//   first drop this process's POSIX locks by a raw open/close of its files (the hazard the fence exists
//   for), then on the line `bootstrap` from stdin attempt the job's bootstrap and report.
// - `contend`: try to compose, report the outcome, close.
// - `crash`: compose and run the job's bootstrap, killing this process (SIGKILL) at an exact point:
//   `before:<write>` or `after:<write>` for a fenced durable write (`beginIntent`, `commit`, `save`,
//   `completeIntent`), `beforeConsume:<n>` just before the n-th AUTH-03 decision consumption, or
//   `consumed:<n>` just after it.
// - `crash` with `holdUntilTold`: when the bootstrap finishes, report and wait for the line `die`.
// - `midrun-loss`: run the job's bootstrap with a status source that, once both decisions are consumed,
//   drops this process's lock on the protected store (raw open/close), then lets the run continue.
// - `replace-history`: replace history A at its path while held, bootstrap A (refused) and B (signed in
//   `job.second`), then drop the protected store's lock and try again.
// - `drop-at`: drop the protected store's lock inside the fence of `job.dropAt` (`save` or
//   `completeIntent`), after the post-settle lock check passed: the strictest timing for I2.
// - `reconcile-loss`: a bootstrap whose source refuses (decisions consumed, nothing committed), the grace
//   bound passed, then `reconcile()`, with the lock dropped right after its authority check (I3).
// These last modes end with a normal `process.exit(0)`: the exit guard must stop the process (SIGKILL)
// before a lost connection can checkpoint into files it no longer owns.
// Every report is one JSON line on stdout.
import { closeSync, copyFileSync, openSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

import { confirmExclusivelyHeld } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';
import { compose, makeClock, openIdentity, pathsOf } from './fv-p4c2b3b-support.mjs';

const job = JSON.parse(process.argv[2]);
const paths = pathsOf(job.dir);
const dropProtectedLock = () => closeSync(openSync(paths.protectedStore, 'r'));
/** Which fenced durable write a fence read belongs to, from its call stack. */
const writeOf = (stack) => (/\bbeginIntent\b/.test(stack) ? 'beginIntent' : /\bcompareAndSetWithEvidence\b/.test(stack) ? 'commit' : /\bcompleteIntent\b/.test(stack) ? 'completeIntent' : /\.save\b|\bsave \(/.test(stack) ? 'save' : undefined);
let armedReconcile = false;
if (job.mode === 'drop-at' || job.mode === 'reconcile-loss') {
  const fs = createRequire(import.meta.url)('node:fs');
  const read = fs.readFileSync;
  let dropped = false;
  fs.readFileSync = function (...args) {
    if (args[0] === '/proc/locks' && !dropped) {
      if (job.mode === 'drop-at' && writeOf(new Error().stack ?? '') === job.dropAt) {
        dropped = true;
        dropProtectedLock();
      } else if (job.mode === 'reconcile-loss' && armedReconcile) {
        // The authority check at reconcile() start reads first, and passes; the lock is lost right after.
        const out = read.apply(this, args);
        dropped = true;
        dropProtectedLock();
        return out;
      }
    }
    return read.apply(this, args);
  };
}
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const die = () => {
  process.kill(process.pid, 'SIGKILL');
  for (;;) {
    // never returns
  }
};

const clock = makeClock(job.at);
let identityStore = await openIdentity(job.dir, clock);

if (job.mode === 'crash') {
  const [when, what] = job.killAt.split(':');
  // Fenced writes: the fence reads /proc/locks synchronously immediately before each write transaction.
  const fs = createRequire(import.meta.url)('node:fs');
  const read = fs.readFileSync;
  let armedAfter = false;
  fs.readFileSync = function (...args) {
    if (args[0] === '/proc/locks') {
      const stack = new Error().stack ?? '';
      const write = /\bbeginIntent\b/.test(stack) ? 'beginIntent' : /\bcompareAndSetWithEvidence\b/.test(stack) ? 'commit' : /\bcompleteIntent\b/.test(stack) ? 'completeIntent' : /\.save\b|\bsave \(/.test(stack) ? 'save' : undefined;
      if (armedAfter) die();
      if (write !== undefined && write === what) {
        if (when === 'before') die();
        if (when === 'after') armedAfter = true;
      }
    }
    return read.apply(this, args);
  };
  if (when === 'consumed' || when === 'beforeConsume') {
    // AUTH-03 consumption: the identity-store append of a `decision_authorized` row.
    let consumed = 0;
    const store = identityStore;
    identityStore = new Proxy(store, {
      get(target, property) {
        if (property === 'append') {
          return async (...args) => {
            const consuming = args[0]?.kind === 'decision_authorized';
            if (consuming) consumed += 1;
            if (consuming && when === 'beforeConsume' && consumed === Number(what)) die();
            const row = await target.append(...args);
            if (consuming && when === 'consumed' && consumed === Number(what)) die();
            return row;
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

let overrides = {};
if (job.refuseSource) {
  overrides = { statusSource: { verifier: { attestStatusSource: async () => { throw new Error('source down'); } }, policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 } } };
}
if (job.mode === 'midrun-loss') {
  overrides = {
    statusSource: {
      // Runs after both decisions are consumed (coordinator step 4): the executor's lock is silently dropped here.
      verifier: { attestStatusSource: async (query) => (dropProtectedLock(), { sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: clock.iso(), status: { ...query.status } }) },
      policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 },
    },
  };
}
let host;
try {
  host = await compose({ paths, namespaces: job.namespaces }, identityStore, clock, overrides);
} catch (error) {
  report({ composed: false, code: error.code ?? String(error) });
  identityStore.close();
  process.exit(0);
}
report({ composed: true, epoch: host.status().epoch, pid: process.pid });

if (job.mode === 'contend') {
  host.close();
  identityStore.close();
  process.exit(0);
}

if (job.mode === 'crash') {
  const outcome = await host.bootstrap(job.bootstrap);
  // Reached only when the kill point was never hit: the bootstrap completed. Exit without closing (a crash too).
  report({ finished: true, outcome: outcome.outcome, reason: outcome.reason ?? outcome.result?.reason });
  if (job.holdUntilTold) {
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => line === 'die' && die());
  } else die();
}

if (job.mode === 'midrun-loss') {
  const outcome = await host.bootstrap(job.bootstrap);
  const status = host.status();
  report({ reason: outcome.reason ?? outcome.result?.reason, readiness: status.readiness, pending: status.pendingIntents[job.namespaces[0]] });
  host.close();
  identityStore.close();
  process.exit(0);
}

if (job.mode === 'drop-at') {
  const outcome = await host.bootstrap(job.bootstrap);
  const status = host.status();
  report({ reason: outcome.reason ?? outcome.result?.reason, readiness: status.readiness, pending: status.pendingIntents[job.namespaces[0]] });
  host.close();
  identityStore.close();
  process.exit(0);
}

if (job.mode === 'reconcile-loss') {
  const outcome = await host.bootstrap(job.bootstrap);
  clock.advance(job.grace + 1);
  const before = identityStore.history().filter((row) => row.kind === 'decision_outcome').length;
  armedReconcile = true;
  let entries;
  try {
    entries = (await host.reconcile()).map((e) => [e.result, 'reason' in e ? e.reason : e.settlement.outcome]);
  } catch (error) {
    entries = String(error.message);
  }
  const after = identityStore.history().filter((row) => row.kind === 'decision_outcome').length;
  report({ bootstrap: outcome.result?.reason, entries, settlementsWritten: after - before, readiness: host.status().readiness });
  host.close();
  identityStore.close();
  process.exit(0);
}

if (job.mode === 'replace-history') {
  const [a, b] = job.namespaces;
  const out = { heldAtStart: confirmExclusivelyHeld([paths.protectedStore, paths.history(a), paths.history(b)]), absent: confirmExclusivelyHeld([join(job.dir, 'absent.sqlite')]) };
  // A raw writer replaces history A at its path while it is held.
  copyFileSync(paths.history(a), join(job.dir, 'copy.sqlite'));
  renameSync(join(job.dir, 'copy.sqlite'), paths.history(a));
  out.replacedHeld = confirmExclusivelyHeld([paths.history(a)]);
  out.first = (await host.bootstrap(job.bootstrap)).reason;
  out.lostAfterReplacement = host.status().readiness === 'executor-lost';
  out.second = (await host.bootstrap(job.second)).result?.outcome;
  dropProtectedLock();
  out.protectedHeld = confirmExclusivelyHeld([paths.protectedStore]);
  out.third = (await host.bootstrap({ ...job.second, requesterResponse: {}, approverResponse: {} })).reason;
  out.readiness = host.status().readiness;
  out.fourth = (await host.bootstrap({ ...job.second, requesterResponse: {}, approverResponse: {} })).reason;
  try {
    await host.reconcile();
    out.reconciled = 'ran';
  } catch (error) {
    out.reconciled = String(error.message);
  }
  report(out);
  host.close();
  identityStore.close();
  process.exit(0);
}

if (job.mode === 'hold') {
  if (job.dropLocks) {
    // The hazard: a raw descriptor of each held file opened and closed in this process drops its POSIX locks.
    for (const path of [pathsOf(job.dir).protectedStore, ...job.namespaces.map((n) => pathsOf(job.dir).history(n))]) closeSync(openSync(path, 'r'));
    report({ dropped: true });
  }
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (line === 'bootstrap') {
      const outcome = await host.bootstrap(job.bootstrap);
      let reconciled;
      try {
        await host.reconcile();
        reconciled = 'ran';
      } catch (error) {
        reconciled = String(error.message);
      }
      report({ bootstrap: outcome.outcome, reason: outcome.reason ?? outcome.result?.reason, readiness: host.status().readiness, reconciled });
    }
  });
  lines.on('close', () => {
    host.close();
    identityStore.close();
    process.exit(0);
  });
}
