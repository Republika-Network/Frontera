import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { FV_EXECUTOR_EXIT, FV_EXECUTOR_IPC_PROTOCOL, FV_EXECUTOR_NON_RETRYABLE_REASONS, FV_EXECUTOR_REASONS, FV_EXECUTOR_STATES } from './dedicated-executor-protocol.js';
import type { FvExecutorEvent, FvExecutorReason, FvExecutorState, FvExecutorStatus } from './dedicated-executor-protocol.js';

/**
 * FV-P4C-2B3C-1 — supervision of the dedicated FV executor (not composed into the running Host).
 *
 * Two layers:
 * - **The contract** (`decideAfterExit`): a pure function from what was observed about an exit to what
 *   happens next. A platform adapter (this module's child-process supervisor, or a container or systemd
 *   policy configured to match; see `FV_DEDICATED_EXECUTOR_LIFECYCLE.md`) applies it.
 * - **The child-process adapter** (`createFvExecutorSupervisor`): starts one executor child with a fixed
 *   entry module, no inherited environment and no inherited Node flags; observes it over the IPC channel
 *   it created; restarts it only as the contract says.
 *
 * The supervisor owns no FV resource. It never opens, probes or stats an executor file: it imports no
 * filesystem or SQLite module at all. Health is the executor's own report, over IPC, from memory. A
 * process that started is not a bootstrap; a restart clears no intent (the executor's own startup
 * recovers by evidence); a blocked executor is resumed only by an explicit operator call, never a timer.
 */

export interface FvExecutorRestartPolicy {
  /** Restarts allowed within `windowMs` before the supervisor blocks (default 3). */
  readonly maxRestarts: number;
  readonly windowMs: number;
  /** Backoff: `baseDelayMs * 2^(attempt-1)`, at most `maxDelayMs`. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const FV_EXECUTOR_DEFAULT_RESTART_POLICY: FvExecutorRestartPolicy = Object.freeze({ maxRestarts: 3, windowMs: 10 * 60_000, baseDelayMs: 1_000, maxDelayMs: 60_000 });

/** What the supervisor saw about one exit. */
export interface FvExecutorExitObservation {
  readonly code: number | null;
  readonly signal: string | null;
  /** The last lifecycle state and reason the executor reported, if any reached the supervisor. */
  readonly lastState: FvExecutorState | null;
  readonly lastReason: FvExecutorReason | null;
  /** Whether this supervisor asked it to stop. */
  readonly stopRequested: boolean;
}

export type FvExecutorExitDecision =
  | { readonly action: 'stopped'; readonly clean: true }
  | { readonly action: 'restart'; readonly delayMs: number; readonly attempt: number }
  | { readonly action: 'blocked'; readonly reason: FvExecutorReason | 'RESTART_LIMIT' | 'UNEXPLAINED_CLEAN_EXIT' | 'REFUSED_TO_RUN' | 'UNCLEAN_STOP' };

/**
 * The supervision contract. `recentRestarts` are the instants (ms) of this supervisor's earlier restarts.
 * - A requested stop is never followed by a restart.
 * - A reported non-retryable reason (configuration, path, store, custody, platform) blocks: only the
 *   operator can fix it, and restarting would only repeat it.
 * - A clean stop the supervisor did not request (an outside SIGTERM, say) is not a crash: it blocks, so
 *   the operator sees it, rather than fighting whoever stopped it.
 * - Anything else (a crash, a signal, authority lost, another executor holding the store) restarts with
 *   exponential backoff, until `maxRestarts` within `windowMs`, then blocks.
 */
export function decideAfterExit(observation: FvExecutorExitObservation, recentRestarts: readonly number[], now: number, policy: FvExecutorRestartPolicy = FV_EXECUTOR_DEFAULT_RESTART_POLICY): FvExecutorExitDecision {
  const clean = observation.code === FV_EXECUTOR_EXIT.STOPPED && observation.signal === null;
  if (observation.stopRequested) {
    // A requested stop is never restarted; but one that did not end cleanly (authority lost while stopping,
    // or escalated to a signal) needs the operator before the next start (review L3).
    if (clean && (observation.lastState === 'STOPPED' || observation.lastState === 'FAILED')) return Object.freeze({ action: 'stopped' as const, clean: true });
    return Object.freeze({ action: 'blocked' as const, reason: 'UNCLEAN_STOP' as const });
  }
  if (observation.lastReason !== null && FV_EXECUTOR_NON_RETRYABLE_REASONS.has(observation.lastReason)) return Object.freeze({ action: 'blocked' as const, reason: observation.lastReason });
  if (observation.code === FV_EXECUTOR_EXIT.CONFIG && observation.signal === null) return Object.freeze({ action: 'blocked' as const, reason: 'REFUSED_TO_RUN' as const });
  if (clean) return Object.freeze({ action: 'blocked' as const, reason: 'UNEXPLAINED_CLEAN_EXIT' as const });
  const within = recentRestarts.filter((at) => now - at < policy.windowMs).length;
  if (within >= policy.maxRestarts) return Object.freeze({ action: 'blocked' as const, reason: 'RESTART_LIMIT' as const });
  const attempt = within + 1;
  return Object.freeze({ action: 'restart' as const, delayMs: Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)), attempt });
}

export type FvSupervisorPhase = 'idle' | 'starting' | 'running' | 'backoff' | 'stopping' | 'stopped' | 'blocked';

export interface FvSupervisorSnapshot {
  readonly phase: FvSupervisorPhase;
  readonly pid: number | null;
  readonly instanceId: string | null;
  /** The running executor's last reported lifecycle state (`null` when none runs): what it said, never a bootstrap outcome. */
  readonly executorState: FvExecutorState | null;
  readonly executorReason: FvExecutorReason | null;
  readonly restarts: number;
  readonly blockedReason: string | null;
  /** Diagnostics of the last exit: codes only, never output or payloads. */
  readonly lastExit: { readonly code: number | null; readonly signal: string | null; readonly state: FvExecutorState | null; readonly reason: FvExecutorReason | null; readonly decision: FvExecutorExitDecision['action'] } | null;
}

export interface FvExecutorSupervisorOptions {
  /**
   * The executor entry module: an absolute path chosen by the trusted composition (as a unit file's
   * `ExecStart` is), never by a request. It is started with `process.execPath`, no Node flags.
   */
  readonly entry: string;
  /** Arguments for the entry: short strings only (at most 8, 4 KiB each). */
  readonly args?: readonly string[];
  readonly policy?: FvExecutorRestartPolicy;
  /** How long a requested stop may take before SIGTERM, then as long again before SIGKILL (default 30 s). */
  readonly stopTimeoutMs?: number;
  /** How long a status request may take (default 2 s). */
  readonly statusTimeoutMs?: number;
  /** Lifecycle observations, for the operator's log: codes only. */
  readonly onEvent?: (event: { readonly kind: 'lifecycle' | 'exit' | 'restart' | 'blocked'; readonly snapshot: FvSupervisorSnapshot }) => void;
}

export interface FvExecutorSupervisor {
  /** Starts the executor. Refuses while one runs, or while blocked. */
  start(): void;
  /** The executor's status, asked over IPC; `undefined` if there is no running executor or it did not answer in time. */
  status(): Promise<FvExecutorStatus | undefined>;
  /** Stops the executor and supervision; resolves once the child has exited. */
  stop(): Promise<void>;
  /** The operator's explicit acknowledgement of a block: allows `start()` again. Never called by a timer. */
  acknowledgeBlock(): void;
  snapshot(): FvSupervisorSnapshot;
}

export class FvExecutorSupervisorError extends Error {
  constructor(
    readonly code: 'OPTIONS_INVALID' | 'ALREADY_RUNNING' | 'BLOCKED' | 'STOPPED',
    message: string,
  ) {
    super(message);
    this.name = 'FvExecutorSupervisorError';
  }
}

const STATES = new Set<string>(FV_EXECUTOR_STATES);
const REASONS = new Set<string>(FV_EXECUTOR_REASONS);

const STATUS_KEYS = JSON.stringify(['admittedNamespaces', 'bootstrapExecution', 'configuredNamespaces', 'epoch', 'instanceId', 'lastReason', 'lastReconciliation', 'pendingIntents', 'pid', 'protectedStoreLock', 'protectedStoreSchema', 'quarantinedNamespaces', 'readiness', 'startedAt', 'state']);
const RECONCILIATION_KEYS = JSON.stringify(['at', 'entries', 'outcome', 'unresolved']);
const countOrNull = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
/** Review L4: a status is exactly its keys, each a code, a count or a short string; nothing else is passed on. */
function isStatus(value: unknown): value is FvExecutorStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(s).sort()) !== STATUS_KEYS) return false;
  if (typeof s.instanceId !== 'string' || !/^fv-executor:[0-9a-f-]{36}$/.test(s.instanceId) || !Number.isInteger(s.pid)) return false;
  if (typeof s.state !== 'string' || !STATES.has(s.state) || (s.lastReason !== null && (typeof s.lastReason !== 'string' || !REASONS.has(s.lastReason)))) return false;
  if (typeof s.startedAt !== 'string' || s.startedAt.length > 40 || s.protectedStoreSchema !== 'frontera.fv-protected-continuity-store/1') return false;
  if (![null, 'ready', 'degraded', 'unavailable', 'executor-lost', 'closed'].includes(s.readiness as string | null) || ![null, 'disabled', 'enabled'].includes(s.bootstrapExecution as string | null)) return false;
  if (!['not-acquired', 'held', 'lost', 'released'].includes(s.protectedStoreLock as string)) return false;
  if (![s.epoch, s.configuredNamespaces, s.admittedNamespaces, s.quarantinedNamespaces, s.pendingIntents].every(countOrNull)) return false;
  const r = s.lastReconciliation;
  if (r === null) return true;
  if (typeof r !== 'object' || Array.isArray(r) || JSON.stringify(Object.keys(r as object).sort()) !== RECONCILIATION_KEYS) return false;
  const rec = r as Record<string, unknown>;
  return typeof rec.at === 'string' && rec.at.length <= 40 && (rec.outcome === 'completed' || rec.outcome === 'failed') && countOrNull(rec.entries) && countOrNull(rec.unresolved);
}

/** Reads one executor event; anything not exactly an event is ignored. */
function eventOf(message: unknown): FvExecutorEvent | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.protocol !== FV_EXECUTOR_IPC_PROTOCOL) return undefined;
  if (m.type === 'lifecycle' && typeof m.instanceId === 'string' && typeof m.state === 'string' && STATES.has(m.state) && (m.reason === null || (typeof m.reason === 'string' && REASONS.has(m.reason)))) return m as FvExecutorEvent;
  if (m.type === 'status' && typeof m.id === 'string' && isStatus(m.status)) return m as FvExecutorEvent;
  if (m.type === 'rejected') return m as FvExecutorEvent;
  return undefined;
}

export function createFvExecutorSupervisor(options: FvExecutorSupervisorOptions): FvExecutorSupervisor {
  const invalid = (message: string): never => {
    throw new FvExecutorSupervisorError('OPTIONS_INVALID', message);
  };
  if (typeof options !== 'object' || options === null) invalid('The supervisor needs its options.');
  const { entry } = options;
  if (typeof entry !== 'string' || !isAbsolute(entry) || entry.includes('\0') || !/\.(c|m)?js$/.test(entry)) invalid('entry is the absolute path of the executor entry module.');
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.length > 8 || args.some((a) => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) invalid('args are at most 8 short strings.');
  const policy = options.policy ?? FV_EXECUTOR_DEFAULT_RESTART_POLICY;
  // Review L2: no policy that could storm (an empty window, no delay) or overflow a timer.
  const MAX_TIMER = 2_147_483_647;
  if (typeof policy !== 'object' || policy === null) invalid('The restart policy is an object.');
  if (!Number.isInteger(policy.maxRestarts) || policy.maxRestarts < 0 || policy.maxRestarts > 100) invalid('maxRestarts is an integer from 0 to 100.');
  for (const key of ['windowMs', 'baseDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1 || policy[key] > MAX_TIMER) invalid(`${key} is an integer from 1 to ${MAX_TIMER}.`);
  }
  if (policy.baseDelayMs > policy.maxDelayMs) invalid('baseDelayMs is at most maxDelayMs.');
  const stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 2_000;
  if (!Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 1_073_741_823 || !Number.isInteger(statusTimeoutMs) || statusTimeoutMs < 1 || statusTimeoutMs > 2_147_483_647) invalid('Timeouts are positive integers within a timer’s range.');

  let phase: FvSupervisorPhase = 'idle';
  let child: ChildProcess | undefined;
  let instanceId: string | null = null;
  let executorState: FvExecutorState | null = null;
  let executorReason: FvExecutorReason | null = null;
  let stopRequested = false;
  let blockedReason: string | null = null;
  let lastExit: FvSupervisorSnapshot['lastExit'] = null;
  const restartTimes: number[] = [];
  let backoff: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<void> = Promise.resolve();
  let nextId = 0;
  const waiting = new Map<string, (status: FvExecutorStatus | undefined) => void>();

  const snapshot = (): FvSupervisorSnapshot =>
    Object.freeze({ phase, pid: child?.pid ?? null, instanceId, executorState, executorReason, restarts: restartTimes.length, blockedReason, lastExit });
  const emit = (kind: 'lifecycle' | 'exit' | 'restart' | 'blocked'): void => {
    try {
      options.onEvent?.({ kind, snapshot: snapshot() });
    } catch {
      // An observer cannot affect supervision.
    }
  };

  const spawnOne = (): void => {
    phase = 'starting';
    instanceId = null;
    executorState = null;
    executorReason = null;
    stopRequested = false;
    const started = fork(entry, [...args], {
      execPath: process.execPath,
      // No inherited flags (no --require, --inspect, --import): only the entry module runs. And no inspector
      // on SIGUSR1 (review M1): otherwise any same-user process could attach and run code in the executor.
      execArgv: ['--disable-sigusr1'],
      // No inherited environment: nothing reaches the executor but its arguments.
      env: {},
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child = started;
    let resolveExit!: () => void;
    exited = new Promise((done) => (resolveExit = done));
    started.on('message', (message: unknown) => {
      const event = eventOf(message);
      if (event === undefined) return;
      if (event.type === 'lifecycle') {
        instanceId = event.instanceId;
        executorState = event.state;
        executorReason = event.reason;
        if (phase === 'starting') phase = 'running';
        // A non-retryable failure is parked by the executor itself (it stays alive, holding nothing): block now.
        if (event.state === 'FAILED' && event.reason !== null && FV_EXECUTOR_NON_RETRYABLE_REASONS.has(event.reason) && phase !== 'stopping') {
          blockedReason = event.reason;
          phase = 'blocked';
          emit('blocked');
          return;
        }
        emit('lifecycle');
      } else if (event.type === 'status') {
        waiting.get(event.id)?.(event.status);
        waiting.delete(event.id);
      } else if (event.type === 'rejected' && typeof event.id === 'string') {
        waiting.get(event.id)?.(undefined);
        waiting.delete(event.id);
      }
    });
    started.on('error', () => {
      // A spawn failure is followed by `exit` (or never started): the exit path decides.
    });
    started.on('exit', (code, signal) => {
      for (const done of waiting.values()) done(undefined);
      waiting.clear();
      child = undefined;
      const observation: FvExecutorExitObservation = { code, signal, lastState: executorState, lastReason: executorReason, stopRequested };
      const now = Date.now();
      const decision = phase === 'blocked' && !stopRequested ? ({ action: 'blocked', reason: (blockedReason ?? 'UNEXPLAINED_CLEAN_EXIT') as FvExecutorReason } as const) : decideAfterExit(observation, restartTimes, now, policy);
      lastExit = Object.freeze({ code, signal, state: executorState, reason: executorReason, decision: decision.action });
      // The exited executor's last report is history now (in lastExit): no live state is claimed for it.
      instanceId = null;
      executorState = null;
      executorReason = null;
      phase = decision.action === 'restart' ? 'backoff' : decision.action === 'blocked' || phase === 'blocked' ? 'blocked' : 'stopped';
      emit('exit');
      if (decision.action === 'stopped') {
        phase = phase === 'blocked' ? 'blocked' : 'stopped';
      } else if (decision.action === 'blocked') {
        phase = 'blocked';
        blockedReason = decision.reason;
        emit('blocked');
      } else {
        phase = 'backoff';
        restartTimes.push(now);
        emit('restart');
        backoff = setTimeout(() => {
          backoff = undefined;
          if (phase === 'backoff') spawnOne();
        }, decision.delayMs);
      }
      resolveExit();
    });
  };

  return Object.freeze({
    start(): void {
      if (phase === 'blocked') throw new FvExecutorSupervisorError('BLOCKED', `The executor is blocked (${blockedReason}); the operator must acknowledge it first.`);
      if (child !== undefined || phase === 'starting' || phase === 'running' || phase === 'backoff' || phase === 'stopping') throw new FvExecutorSupervisorError('ALREADY_RUNNING', 'An executor is already supervised; a second one is never started.');
      spawnOne();
    },
    status(): Promise<FvExecutorStatus | undefined> {
      const current = child;
      if (current === undefined || current.connected !== true) return Promise.resolve(undefined);
      nextId += 1;
      const id = `s${nextId}`;
      return new Promise((resolveStatus) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolveStatus(undefined);
        }, statusTimeoutMs);
        waiting.set(id, (status) => {
          clearTimeout(timer);
          resolveStatus(status);
        });
        try {
          current.send({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'status', id });
        } catch {
          clearTimeout(timer);
          waiting.delete(id);
          resolveStatus(undefined);
        }
      });
    },
    async stop(): Promise<void> {
      if (backoff !== undefined) {
        clearTimeout(backoff);
        backoff = undefined;
      }
      const current = child;
      if (current === undefined) {
        if (phase !== 'blocked') phase = 'stopped';
        return;
      }
      const wasBlocked = phase === 'blocked';
      stopRequested = true;
      phase = 'stopping';
      nextId += 1;
      try {
        current.send({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: 'stop', id: `x${nextId}` });
      } catch {
        // No channel: the signals below.
      }
      const escalate = (signal: NodeJS.Signals, after: number) =>
        setTimeout(() => {
          if (child === current) current.kill(signal);
        }, after);
      const term = escalate('SIGTERM', stopTimeoutMs);
      const kill = escalate('SIGKILL', 2 * stopTimeoutMs);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
      if (wasBlocked) phase = 'blocked';
    },
    acknowledgeBlock(): void {
      if (phase !== 'blocked' || child !== undefined) return;
      blockedReason = null;
      restartTimes.length = 0;
      phase = 'idle';
    },
    snapshot,
  });
}
