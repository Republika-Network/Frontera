import { randomUUID } from 'node:crypto';

import { confirmExclusivelyHeld, exclusiveConnectionCount, exclusiveConnectionsSafe, exclusivitySupported } from './executor-exclusivity.js';
import { PROTECTED_CONTINUITY_STORE_SCHEMA } from './protected-continuity-store.js';
import type { FvProtectedHost, FvProtectedHostStatus } from './protected-host-composition.js';
import { FV_EXECUTOR_EXIT, FV_EXECUTOR_IPC_PROTOCOL, FV_EXECUTOR_TRANSITIONS, parseFvExecutorCommand } from './dedicated-executor-protocol.js';
import type { FvExecutorEvent, FvExecutorReason, FvExecutorState, FvExecutorStatus } from './dedicated-executor-protocol.js';

/**
 * FV-P4C-2B3C-1 — the dedicated FV executor process: its lifecycle, its narrow IPC channel, and its
 * process-wide termination contract (not composed into the running Host; see
 * `FV_DEDICATED_EXECUTOR_LIFECYCLE.md`).
 *
 * **Why a dedicated process.** The protected composition's authority is a POSIX lock, which belongs to
 * the whole process. Other code in the process that opens and closes one of its files drops it,
 * and a process whose lock was lost must stop by `SIGKILL` before a normal exit can checkpoint into
 * files another executor now owns (B3B). Neither is acceptable next to unrelated workloads. So the
 * composition runs alone in a child process that does nothing else, and only its supervisor talks to it,
 * over the IPC channel the supervisor created.
 *
 * **What this process owns:** its histories, its protected store, their locks, its AUTH-03 boundary and
 * its lifecycle. Its supervisor opens none of them; a status request is answered from memory here.
 *
 * **Termination contract (stronger than B3B's exit listener).** In this process:
 * - every exit path it controls checks `exclusiveConnectionsSafe()` first and stops by `SIGKILL` when it fails;
 * - `process.exit` is wrapped so that *any* caller's exit runs that check before the exit begins, which is
 *   before any `exit` listener (including one that would call `process.exit()` again);
 * - a fail-stop `exit` listener is prepended, so it runs first even for a natural exit;
 * - authority loss is watched, and ends the process by `SIGKILL` (it cannot be regained in place).
 * `SIGKILL` itself cannot be intercepted; it runs no user-space code, so nothing can checkpoint.
 *
 * **Never here:** a bootstrap command, a reconcile command, a status source, an HTTP route, a plugin or
 * module loader, a SQL interface, any secret, key, capability or handle in a message.
 */

export class FvDedicatedExecutorError extends Error {
  constructor(
    readonly code: 'PLATFORM_UNSUPPORTED' | 'NOT_A_DEDICATED_PROCESS' | 'ALREADY_RUNNING_IN_PROCESS' | 'OPTIONS_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'FvDedicatedExecutorError';
  }
}

export interface DedicatedFvExecutorDefinition {
  /** The protected store this executor's composition acquires: the authority the lock watch confirms. */
  readonly protectedStorePath: string;
  /**
   * Builds the protected composition in this process. A function from the entry module itself, never a
   * module path or anything loaded at run time. `undefined`: the dependencies are not available (the
   * production entry until B3C-3 and B6), and the executor stays FAILED, inactive, holding nothing.
   */
  readonly compose: (() => Promise<FvProtectedHost>) | undefined;
  /** How often authority and health are re-confirmed while running (default 1000 ms, 50–60000). */
  readonly watchIntervalMs?: number;
  /** One reconciliation from the histories' own evidence after composing (default true). */
  readonly reconcileOnStart?: boolean;
}

let running = false;

const FOREIGN_RESOURCES = new Set(['TCPServerWrap', 'TCPSocketWrap', 'TCPWrap', 'UDPWrap', 'PipeServerWrap', 'TLSWrap', 'HTTPParser', 'HTTP2Session']);
function looksDedicated(): boolean {
  const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  if (resources.some((name) => FOREIGN_RESOURCES.has(name))) return false;
  for (const event of ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT', 'message', 'disconnect'] as const) {
    if (process.listenerCount(event) !== 0) return false;
  }
  return true;
}

/**
 * Runs this process as the dedicated FV executor. Refuses (throws, opening nothing) unless this is
 * Linux, the main thread, and a child process with the IPC channel its supervisor created: it never
 * runs inside its caller's process. Only one per process.
 */
export function runDedicatedFvExecutor(definition: DedicatedFvExecutorDefinition): void {
  if (!exclusivitySupported()) throw new FvDedicatedExecutorError('PLATFORM_UNSUPPORTED', 'The dedicated FV executor runs on Linux, on the main thread, only.');
  if (typeof process.send !== 'function' || process.connected !== true) throw new FvDedicatedExecutorError('NOT_A_DEDICATED_PROCESS', 'The dedicated FV executor runs only as a supervised child process with an IPC channel; it never runs in its caller’s process.');
  if (running || exclusiveConnectionCount() !== 0) throw new FvDedicatedExecutorError('ALREADY_RUNNING_IN_PROCESS', 'This process already holds, or has held, FV executor state.');
  // Review L1: an IPC channel alone does not make a process dedicated (a Host can itself be a forked child).
  // A process already serving (a listening or connected socket) or already handling process-wide failures or
  // signals is someone else's: refused. A heuristic, not a proof; the deployment contract is what isolates.
  if (!looksDedicated()) throw new FvDedicatedExecutorError('NOT_A_DEDICATED_PROCESS', 'This process already runs other work (sockets or process-wide handlers); the FV executor runs alone.');
  if (typeof definition !== 'object' || definition === null || typeof definition.protectedStorePath !== 'string' || definition.protectedStorePath === '' || (definition.compose !== undefined && typeof definition.compose !== 'function')) {
    throw new FvDedicatedExecutorError('OPTIONS_INVALID', 'The executor needs its protected store path and its composition function.');
  }
  const watchIntervalMs = definition.watchIntervalMs ?? 1000;
  if (!Number.isInteger(watchIntervalMs) || watchIntervalMs < 50 || watchIntervalMs > 60_000) throw new FvDedicatedExecutorError('OPTIONS_INVALID', 'watchIntervalMs is an integer from 50 to 60000.');
  running = true;
  startExecutor(definition.protectedStorePath, definition.compose, watchIntervalMs, definition.reconcileOnStart !== false);
}

function startExecutor(protectedStorePath: string, compose: (() => Promise<FvProtectedHost>) | undefined, watchIntervalMs: number, reconcileOnStart: boolean): void {
  const send = process.send!.bind(process);
  const instanceId = `fv-executor:${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let state: FvExecutorState = 'CREATED';
  let reason: FvExecutorReason | null = null;
  let host: FvProtectedHost | undefined;
  let lock: FvExecutorStatus['protectedStoreLock'] = 'not-acquired';
  let lastReconciliation: FvExecutorStatus['lastReconciliation'] = null;
  let work: Promise<unknown> | undefined;
  let stopping = false;
  let watch: ReturnType<typeof setInterval> | undefined;

  // ---- The termination contract, installed before anything is opened. ----
  const killNow = (): never => {
    process.kill(process.pid, 'SIGKILL');
    for (;;) {
      // SIGKILL is delivered before this returns; never continue.
    }
  };
  const realExit = process.exit.bind(process);
  // Any caller's exit (ours, a dependency's, or one from inside an `exit` listener) is checked before it begins.
  process.exit = ((code?: number) => {
    if (!exclusiveConnectionsSafe()) killNow();
    return realExit(code);
  }) as typeof process.exit;
  // And a natural exit (empty event loop) is checked by the first `exit` listener.
  process.prependListener('exit', () => {
    if (!exclusiveConnectionsSafe()) killNow();
  });

  const post = (event: FvExecutorEvent): Promise<void> =>
    new Promise((done) => {
      if (process.connected !== true) return done();
      const timer = setTimeout(done, 250);
      try {
        send(event, undefined, {}, () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  let flushed: Promise<void> = Promise.resolve();
  const transition = (next: FvExecutorState, why: FvExecutorReason | null = null): boolean => {
    if (!FV_EXECUTOR_TRANSITIONS[state].includes(next)) return false;
    state = next;
    if (why !== null) reason = why;
    flushed = post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'lifecycle', instanceId, state, reason, at: new Date().toISOString() });
    return true;
  };

  /** Authority is gone: nothing more runs, nothing is closed, the process ends by SIGKILL. */
  const failStop = async (why: 'AUTHORITY_LOST' | 'AUTHORITY_LOST_DURING_SHUTDOWN'): Promise<never> => {
    if (watch !== undefined) clearInterval(watch);
    lock = 'lost';
    state = FV_EXECUTOR_TRANSITIONS[state].includes('EXECUTOR_AUTHORITY_LOST') ? 'EXECUTOR_AUTHORITY_LOST' : state;
    reason = why;
    await post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'lifecycle', instanceId, state: 'EXECUTOR_AUTHORITY_LOST', reason: why, at: new Date().toISOString() });
    return killNow();
  };
  /** The end of every non-fatal path: a normal exit only when every exclusive connection is closed or still held. */
  const finish = async (code: number): Promise<never> => {
    if (!exclusiveConnectionsSafe()) return failStop('AUTHORITY_LOST_DURING_SHUTDOWN');
    await flushed;
    await new Promise((done) => setImmediate(done));
    if (process.connected === true) process.disconnect();
    return realExitChecked(code);
  };
  const realExitChecked = (code: number): never => {
    if (!exclusiveConnectionsSafe()) killNow();
    return realExit(code);
  };

  const statusNow = (): FvExecutorStatus => {
    let composed: FvProtectedHostStatus | undefined;
    try {
      composed = host?.status();
    } catch {
      composed = undefined;
    }
    const pending = composed === undefined ? null : Object.values(composed.pendingIntents);
    const histories = composed?.inventory.histories;
    const configured = composed === undefined ? null : Object.keys(composed.pendingIntents).length;
    const admitted = histories === undefined ? null : histories.filter((h) => h.admitted).length;
    return Object.freeze({
      instanceId,
      pid: process.pid,
      state,
      startedAt,
      readiness: composed?.readiness ?? null,
      bootstrapExecution: composed?.bootstrapExecution ?? null,
      epoch: composed?.epoch ?? null,
      configuredNamespaces: configured,
      admittedNamespaces: admitted,
      quarantinedNamespaces: configured === null || admitted === null ? null : configured - admitted,
      pendingIntents: pending === null || pending.some((p) => p === null) ? null : pending.reduce((n, p) => n + p!.length, 0),
      protectedStoreLock: lock,
      lastReconciliation,
      lastReason: reason,
      protectedStoreSchema: PROTECTED_CONTINUITY_STORE_SCHEMA,
    });
  };

  /** The composition's readiness, applied monotonically: it never improves in place. */
  const observe = (): void => {
    if (host === undefined || stopping) return;
    if (!confirmExclusivelyHeld([protectedStorePath])) {
      void failStop('AUTHORITY_LOST');
      return;
    }
    let readiness: FvProtectedHostStatus['readiness'];
    try {
      readiness = host.status().readiness;
    } catch {
      readiness = 'unavailable';
    }
    if (readiness === 'executor-lost') {
      void failStop('AUTHORITY_LOST');
      return;
    }
    const target: FvExecutorState = readiness === 'ready' ? 'READY_INACTIVE' : readiness === 'degraded' ? 'DEGRADED' : 'QUARANTINED';
    const rank = (s: FvExecutorState): number => (s === 'READY_INACTIVE' ? 1 : s === 'DEGRADED' ? 2 : s === 'QUARANTINED' ? 3 : 0);
    if (state === 'RECOVERING' || rank(target) > rank(state)) transition(target);
  };

  const stop = async (why: 'STOP_REQUESTED' | 'SIGNAL_SIGTERM' | 'SIGNAL_SIGINT' | 'SUPERVISOR_DISCONNECTED'): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (watch !== undefined) clearInterval(watch);
    // A parked FAILED executor holds nothing: it simply ends (its FAILED state and reason stand).
    if (state === 'FAILED') return void (await finish(FV_EXECUTOR_EXIT.STOPPED));
    transition('STOPPING', why);
    // Running work is awaited, never abandoned: the composition is closed only once nothing is in flight.
    if (work !== undefined) await work.catch(() => undefined);
    if (host !== undefined) {
      // Lost while stopping: no close (it could checkpoint into another executor's files), fail-stop instead.
      if (!confirmExclusivelyHeld([protectedStorePath]) || !exclusiveConnectionsSafe()) return void (await failStop('AUTHORITY_LOST_DURING_SHUTDOWN'));
      host.close();
      // The guarded closer retains a connection whose lock it could not confirm: that is a lost lock too.
      if (exclusiveConnectionCount() !== 0) return void (await failStop('AUTHORITY_LOST_DURING_SHUTDOWN'));
      lock = 'released';
    }
    if (!transition('STOPPED')) return void (await finish(FV_EXECUTOR_EXIT.INTERNAL));
    await finish(FV_EXECUTOR_EXIT.STOPPED);
  };

  let failing = false;
  const fatal = async (why: 'UNCAUGHT_EXCEPTION' | 'UNHANDLED_REJECTION'): Promise<void> => {
    if (failing) return;
    failing = true;
    if (watch !== undefined) clearInterval(watch);
    stopping = true;
    if (host !== undefined && !exclusiveConnectionsSafe()) return void (await failStop('AUTHORITY_LOST'));
    state = 'FAILED';
    reason = why;
    try {
      host?.close();
    } catch {
      // The guarded closer never closes a connection it does not hold; the check below decides.
    }
    await post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'lifecycle', instanceId, state: 'FAILED', reason: why, at: new Date().toISOString() });
    await finish(FV_EXECUTOR_EXIT.INTERNAL);
  };

  process.on('uncaughtException', () => void fatal('UNCAUGHT_EXCEPTION'));
  process.on('unhandledRejection', () => void fatal('UNHANDLED_REJECTION'));
  process.on('SIGTERM', () => void stop('SIGNAL_SIGTERM'));
  process.on('SIGINT', () => void stop('SIGNAL_SIGINT'));
  // The supervisor is gone (it crashed or was killed): stop cleanly rather than hold the locks unsupervised.
  process.on('disconnect', () => void stop('SUPERVISOR_DISCONNECTED'));
  process.on('message', (message: unknown) => {
    const parsed = parseFvExecutorCommand(message);
    if (!parsed.ok) return void post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'rejected', id: parsed.id, reason: parsed.reason });
    const { command } = parsed;
    if (command.type === 'status') return void post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'status', id: command.id, status: statusNow() });
    if (stopping) return void post({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'rejected', id: command.id, reason: 'STOPPING' });
    void stop('STOP_REQUESTED');
  });

  void (async () => {
    transition('PREFLIGHT');
    if (compose === undefined) {
      // Inactive by construction: no composition, nothing opened, nothing held. It waits to be stopped.
      transition('FAILED', 'DEPENDENCIES_UNAVAILABLE');
      return;
    }
    if (stopping) return;
    transition('ACQUIRING_EXCLUSIVITY');
    // The host is assigned inside the in-flight work itself, so a stop that awaits this work always sees it.
    const composing = compose().then((composed) => {
      host = composed;
      return composed;
    });
    work = composing;
    try {
      await composing;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const why: FvExecutorReason =
        code === 'EXECUTOR_HELD' || code === 'OPTIONS_INVALID' || code === 'PATH_REFUSED' || code === 'PROTECTED_STORE_REFUSED' || code === 'CUSTODY_REFUSED' || code === 'PLATFORM_UNSUPPORTED' ? code : 'COMPOSITION_FAILED';
      work = undefined;
      // A refused composition closed what it had opened; anything still registered means a lost lock.
      if (exclusiveConnectionCount() !== 0) return void (await failStop('AUTHORITY_LOST'));
      if (stopping) return;
      transition('FAILED', why);
      // Retryable only when another executor holds the store: exit, and let the supervisor back off.
      // Every other refusal needs the operator: the process stays, FAILED and inactive, so no supervisor restarts it.
      if (why === 'EXECUTOR_HELD') await finish(FV_EXECUTOR_EXIT.HELD);
      return;
    } finally {
      if (work === composing) work = undefined;
    }
    lock = 'held';
    if (stopping) return;
    transition('RECOVERING');
    if (reconcileOnStart) {
      const reconciling = host!.reconcile();
      work = reconciling;
      try {
        const entries = await reconciling;
        lastReconciliation = Object.freeze({ at: new Date().toISOString(), outcome: 'completed' as const, entries: entries.length, unresolved: entries.filter((e) => e.result !== 'settled' && e.result !== 'unchanged').length });
      } catch {
        lastReconciliation = Object.freeze({ at: new Date().toISOString(), outcome: 'failed' as const, entries: 0, unresolved: 0 });
      } finally {
        work = undefined;
      }
    }
    if (stopping) return;
    observe();
    watch = setInterval(observe, watchIntervalMs);
  })().catch(() => void fatal('UNCAUGHT_EXCEPTION'));
}

/**
 * The entry modules' wrapper: runs the executor, or, when it refuses to run, reports the refusal and
 * holds nothing. Under a supervisor the refusal is sent as `FAILED` with its reason and the process
 * stays parked until stopped (so no restart policy can repeat it); otherwise it exits `CONFIG` (78).
 */
export function runDedicatedFvExecutorOrRefuse(definition: DedicatedFvExecutorDefinition): void {
  try {
    runDedicatedFvExecutor(definition);
  } catch (error) {
    const reason: FvExecutorReason = error instanceof FvDedicatedExecutorError ? error.code : 'OPTIONS_INVALID';
    if (typeof process.send === 'function' && process.connected === true) {
      process.send({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'lifecycle', instanceId: 'fv-executor:refused', state: 'FAILED', reason, at: new Date().toISOString() } satisfies FvExecutorEvent);
      process.on('message', (message: unknown) => {
        const parsed = parseFvExecutorCommand(message);
        if (parsed.ok && parsed.command.type === 'stop' && process.connected === true) process.disconnect();
      });
      return;
    }
    process.stderr.write(`FV executor refused to run: ${reason}\n`);
    process.exitCode = FV_EXECUTOR_EXIT.CONFIG;
  }
}
