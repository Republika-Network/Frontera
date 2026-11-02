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
// - `identity-loss` (B3C-3): only the bootstrap identity store's lock dropped; then a challenge and a bootstrap.
// - `settle-race` (B3C-3): the same, but the lock is dropped right after the FV settlement guard has passed,
//   before the AUTH-03 identity-store write: only the store's own in-transaction fence can refuse it now.
// These last modes end with a normal `process.exit(0)`: the exit guard must stop the process (SIGKILL)
// before a lost connection can checkpoint into files it no longer owns.
// Every report is one JSON line on stdout.
import { closeSync, copyFileSync, openSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

import { confirmExclusivelyHeld } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';
import { bootstrapAuthorityDecisionInput } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { bindingOf, compose, makeClock, pathsOf } from './fv-p4c2b3b-support.mjs';

const job = JSON.parse(process.argv[2]);
// FV-EXEC-LOCK-01: every observation is attributed to its durable write by its call stack (`writeOf`), so the stack
// must be deep enough to reach the write's frame from every observation a fence makes (V8's default is 10 frames).
Error.stackTraceLimit = 64;
const paths = pathsOf(job.dir);
const dropProtectedLock = () => closeSync(openSync(paths.protectedStore, 'r'));
/** Which fenced durable write a fence read belongs to, from its call stack. */
const writeOf = (stack) => (/\bbeginIntent\b/.test(stack) ? 'beginIntent' : /\bcompareAndSetWithEvidence\b/.test(stack) ? 'commit' : /\bcompleteIntent\b/.test(stack) ? 'completeIntent' : /\.save\b|\bsave \(/.test(stack) ? 'save' : undefined);
let armedReconcile = false;
// FV-EXEC-LOCK-01: the fault points are the fence's kernel observation itself — one `confirmExclusivelyHeld` call,
// which no longer reads /proc/locks (it reads /proc/self/fdinfo). The composition calls it through the module's
// exports, so the test wraps that export: a "before" fault acts before the observation, an "after" one right after
// it returned (the check has passed), exactly where the /proc/locks read used to be.
const exclusivity = createRequire(import.meta.url)('../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js');
const observe = exclusivity.confirmExclusivelyHeld;
/** `around(stack)` runs before each observation; a function it returns runs right after it. */
const aroundObservation = (around) => {
  exclusivity.confirmExclusivelyHeld = function (...args) {
    const afterwards = around(new Error().stack ?? '');
    const out = observe.apply(this, args);
    if (typeof afterwards === 'function') afterwards();
    return out;
  };
};
if (job.mode === 'drop-at' || job.mode === 'reconcile-loss' || job.mode === 'settle-race') {
  let dropped = false;
  aroundObservation((stack) => {
    if (dropped) return undefined;
    if (job.mode === 'drop-at' && writeOf(stack) === job.dropAt) {
      dropped = true;
      dropProtectedLock();
    } else if (job.mode === 'settle-race' && armedReconcile && /\bsettlementGuard\b/.test(stack)) {
      // B3C-3: the FV settlement guard observes, and passes; the lock is lost right after, before the AUTH-03 write.
      dropped = true;
      return dropProtectedLock;
    } else if (job.mode === 'reconcile-loss' && armedReconcile) {
      // The authority check at reconcile() start observes first, and passes; the lock is lost right after.
      dropped = true;
      return dropProtectedLock;
    }
    return undefined;
  });
}
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const die = () => {
  process.kill(process.pid, 'SIGKILL');
  for (;;) {
    // never returns
  }
};

const clock = makeClock(job.at);
// FV-P4C-2B3C-3: the composition opens its own bootstrap identity store. This test harness observes the
// store it opened (and, for the consumption crash points, wraps it) at the store module's export.
const storeModule = createRequire(import.meta.url)('../dist/src/enterprise/human-identity/sqlite-human-identity-store.js');
const realOpen = storeModule.openSqliteHumanIdentityStore;
let identityStore;
let wrapStore = (store) => store;
storeModule.openSqliteHumanIdentityStore = async (...args) => {
  identityStore = await realOpen(...args);
  return wrapStore(identityStore);
};

if (job.mode === 'crash') {
  const [when, what] = job.killAt.split(':');
  // Fenced writes: the fence observes the kernel's locks synchronously immediately before each write transaction.
  let armedAfter = false;
  aroundObservation((stack) => {
    {
      const write = /\bbeginIntent\b/.test(stack) ? 'beginIntent' : /\bcompareAndSetWithEvidence\b/.test(stack) ? 'commit' : /\bcompleteIntent\b/.test(stack) ? 'completeIntent' : /\.save\b|\bsave \(/.test(stack) ? 'save' : undefined;
      // "after:X" — the first observation of anything else once X's fence has passed: X's write has committed.
      if (armedAfter && write !== what) die();
      if (write !== undefined && write === what) {
        if (when === 'before') die();
        if (when === 'after') armedAfter = true;
      }
    }
    return undefined;
  });
  if (when === 'consumed' || when === 'beforeConsume') {
    // AUTH-03 consumption: the identity-store append of a `decision_authorized` row.
    let consumed = 0;
    wrapStore = (store) => new Proxy(store, {
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
  host = await compose({ paths, namespaces: job.namespaces }, clock, overrides);
} catch (error) {
  report({ composed: false, code: error.code ?? String(error) });
  process.exit(0);
}
report({ composed: true, epoch: host.status().epoch, pid: process.pid });

if (job.mode === 'contend') {
  host.close();
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
  process.exit(0);
}

if (job.mode === 'drop-at') {
  const outcome = await host.bootstrap(job.bootstrap);
  const status = host.status();
  report({ reason: outcome.reason ?? outcome.result?.reason, readiness: status.readiness, pending: status.pendingIntents[job.namespaces[0]] });
  host.close();
  process.exit(0);
}

if (job.mode === 'reconcile-loss' || job.mode === 'settle-race') {
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
  process.exit(0);
}

if (job.mode === 'identity-loss') {
  // B3C-3: only the bootstrap identity store's lock is dropped (a raw open/close in this process).
  closeSync(openSync(paths.identity, 'r'));
  const out = { identityHeld: confirmExclusivelyHeld([paths.identity]), protectedHeld: confirmExclusivelyHeld([paths.protectedStore]) };
  try {
    host.beginBootstrapDecision({ operatorId: 'requester-a', ...bootstrapAuthorityDecisionInput(bindingOf(job.bootstrap.request).binding, 'requester') });
    out.begin = 'issued';
  } catch (error) {
    out.begin = error.code ?? 'refused';
  }
  const outcome = await host.bootstrap(job.bootstrap);
  out.bootstrap = outcome.outcome === 'ran' ? outcome.result.reason ?? outcome.result.outcome : outcome.reason;
  out.readiness = host.status().readiness;
  report(out);
  host.close();
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
  process.exit(0);
}

if (job.mode === 'hold') {
  if (job.dropLocks) {
    // The hazard: a raw descriptor of each held file opened and closed in this process drops its POSIX locks.
    // B3C-3: the bootstrap identity store is one of its files too; `except-identity` keeps that one lock.
    const files = [pathsOf(job.dir).protectedStore, ...job.namespaces.map((n) => pathsOf(job.dir).history(n)), ...(job.dropLocks === 'except-identity' ? [] : [pathsOf(job.dir).identity])];
    for (const path of files) closeSync(openSync(path, 'r'));
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
    process.exit(0);
  });
}
