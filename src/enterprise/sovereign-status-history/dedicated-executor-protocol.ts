import type { PROTECTED_CONTINUITY_STORE_SCHEMA } from './protected-continuity-store.js';
import type { FvProtectedHostStatus } from './protected-host-composition.js';

/**
 * FV-P4C-2B3C-1 — the dedicated FV executor's IPC protocol, lifecycle states and reasons: data only, no
 * runtime import. Shared by the executor (`dedicated-executor.ts`) and its supervisor
 * (`dedicated-executor-supervisor.ts`), so the supervisor loads nothing that touches a file.
 */

export const FV_EXECUTOR_IPC_PROTOCOL = 'frontera.fv-executor-ipc/1' as const;
/** The largest command the executor accepts, serialized. Commands are tiny; anything larger is refused. */
export const FV_EXECUTOR_IPC_MAX_COMMAND_BYTES = 512;

/** Exit codes the supervisor reads when no lifecycle message reached it. */
export const FV_EXECUTOR_EXIT = Object.freeze({
  /** Stopped after a clean shutdown. */
  STOPPED: 0,
  /** An unexpected internal failure; cleanup was safe. */
  INTERNAL: 70,
  /** Another executor holds the protected store: retryable, with backoff. */
  HELD: 75,
  /** Refused before running (platform, not a supervised child, options): needs the operator. */
  CONFIG: 78,
} as const);

export const FV_EXECUTOR_STATES = Object.freeze([
  'CREATED',
  'PREFLIGHT',
  'ACQUIRING_EXCLUSIVITY',
  'RECOVERING',
  'READY_INACTIVE',
  'DEGRADED',
  'QUARANTINED',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'EXECUTOR_AUTHORITY_LOST',
] as const);
export type FvExecutorState = (typeof FV_EXECUTOR_STATES)[number];

/**
 * The closed transition relation. Nothing else is a transition. In particular:
 * - `READY_INACTIVE` permits no bootstrap: the executor has no bootstrap command at all;
 * - health only worsens in place (`READY_INACTIVE → DEGRADED → QUARANTINED`); no timer or poll improves it,
 *   only a new process, with a new epoch, after the operator has acted;
 * - `EXECUTOR_AUTHORITY_LOST`, `STOPPED` and `FAILED` are terminal for the process.
 */
export const FV_EXECUTOR_TRANSITIONS: Readonly<Record<FvExecutorState, readonly FvExecutorState[]>> = Object.freeze({
  CREATED: Object.freeze(['PREFLIGHT', 'FAILED'] as const),
  PREFLIGHT: Object.freeze(['ACQUIRING_EXCLUSIVITY', 'FAILED', 'STOPPING'] as const),
  ACQUIRING_EXCLUSIVITY: Object.freeze(['RECOVERING', 'FAILED', 'STOPPING'] as const),
  RECOVERING: Object.freeze(['READY_INACTIVE', 'DEGRADED', 'QUARANTINED', 'EXECUTOR_AUTHORITY_LOST', 'FAILED', 'STOPPING'] as const),
  READY_INACTIVE: Object.freeze(['DEGRADED', 'QUARANTINED', 'EXECUTOR_AUTHORITY_LOST', 'FAILED', 'STOPPING'] as const),
  DEGRADED: Object.freeze(['QUARANTINED', 'EXECUTOR_AUTHORITY_LOST', 'FAILED', 'STOPPING'] as const),
  QUARANTINED: Object.freeze(['EXECUTOR_AUTHORITY_LOST', 'FAILED', 'STOPPING'] as const),
  STOPPING: Object.freeze(['STOPPED', 'EXECUTOR_AUTHORITY_LOST', 'FAILED'] as const),
  STOPPED: Object.freeze([] as const),
  FAILED: Object.freeze([] as const),
  EXECUTOR_AUTHORITY_LOST: Object.freeze([] as const),
});

/**
 * Why the executor failed or stopped, as a code only (never a message that could carry data).
 * `NON_RETRYABLE` reasons need the operator: a supervisor must not restart the executor for them.
 */
export const FV_EXECUTOR_REASONS = Object.freeze([
  'PLATFORM_UNSUPPORTED',
  'NOT_A_DEDICATED_PROCESS',
  'ALREADY_RUNNING_IN_PROCESS',
  'DEPENDENCIES_UNAVAILABLE',
  'OPTIONS_INVALID',
  'PATH_REFUSED',
  'EXECUTOR_HELD',
  'PROTECTED_STORE_REFUSED',
  'CUSTODY_REFUSED',
  'COMPOSITION_FAILED',
  'AUTHORITY_LOST',
  'AUTHORITY_LOST_DURING_SHUTDOWN',
  'UNCAUGHT_EXCEPTION',
  'UNHANDLED_REJECTION',
  'STOP_REQUESTED',
  'SIGNAL_SIGTERM',
  'SIGNAL_SIGINT',
  'SUPERVISOR_DISCONNECTED',
] as const);
export type FvExecutorReason = (typeof FV_EXECUTOR_REASONS)[number];
export const FV_EXECUTOR_NON_RETRYABLE_REASONS: ReadonlySet<FvExecutorReason> = new Set<FvExecutorReason>([
  'PLATFORM_UNSUPPORTED',
  'NOT_A_DEDICATED_PROCESS',
  'ALREADY_RUNNING_IN_PROCESS',
  'DEPENDENCIES_UNAVAILABLE',
  'OPTIONS_INVALID',
  'PATH_REFUSED',
  'PROTECTED_STORE_REFUSED',
  'CUSTODY_REFUSED',
  'COMPOSITION_FAILED',
]);

/** The executor's status, as its supervisor sees it: counts and codes only. */
export interface FvExecutorStatus {
  readonly instanceId: string;
  readonly pid: number;
  readonly state: FvExecutorState;
  readonly startedAt: string;
  /** The composition's readiness, or `null` before it is composed. Never a permission to bootstrap. */
  readonly readiness: FvProtectedHostStatus['readiness'] | null;
  readonly bootstrapExecution: 'disabled' | 'enabled' | null;
  readonly epoch: number | null;
  readonly configuredNamespaces: number | null;
  readonly admittedNamespaces: number | null;
  readonly quarantinedNamespaces: number | null;
  /** Pending intents across namespaces; `null` when unknown (not composed, or a namespace unreadable). */
  readonly pendingIntents: number | null;
  readonly protectedStoreLock: 'not-acquired' | 'held' | 'lost' | 'released';
  readonly lastReconciliation: { readonly at: string; readonly outcome: 'completed' | 'failed'; readonly entries: number; readonly unresolved: number } | null;
  readonly lastReason: FvExecutorReason | null;
  readonly protectedStoreSchema: typeof PROTECTED_CONTINUITY_STORE_SCHEMA;
}

/** Supervisor → executor. Exactly these, nothing else. */
export type FvExecutorCommand = { readonly protocol: typeof FV_EXECUTOR_IPC_PROTOCOL; readonly type: 'status' | 'stop'; readonly id: string };

/** Executor → supervisor. */
export type FvExecutorEvent =
  | { readonly protocol: typeof FV_EXECUTOR_IPC_PROTOCOL; readonly type: 'lifecycle'; readonly instanceId: string; readonly state: FvExecutorState; readonly reason: FvExecutorReason | null; readonly at: string }
  | { readonly protocol: typeof FV_EXECUTOR_IPC_PROTOCOL; readonly type: 'status'; readonly id: string; readonly status: FvExecutorStatus }
  | { readonly protocol: typeof FV_EXECUTOR_IPC_PROTOCOL; readonly type: 'rejected'; readonly id: string | null; readonly reason: 'MALFORMED' | 'OVERSIZED' | 'COMMAND_UNKNOWN' | 'STOPPING' };

const COMMAND_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMAND_KEYS = ['id', 'protocol', 'type'];

/**
 * Parses one IPC message as a command: a plain object with exactly `protocol`, `type` and `id`, small
 * enough, of a known type. Anything else is a refusal reason, never a partial command.
 */
export function parseFvExecutorCommand(message: unknown): { readonly ok: true; readonly command: FvExecutorCommand } | { readonly ok: false; readonly id: string | null; readonly reason: 'MALFORMED' | 'OVERSIZED' | 'COMMAND_UNKNOWN' } {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
  } catch {
    return { ok: false, id: null, reason: 'MALFORMED' };
  }
  if (size > FV_EXECUTOR_IPC_MAX_COMMAND_BYTES) return { ok: false, id: null, reason: 'OVERSIZED' };
  if (typeof message !== 'object' || message === null || Array.isArray(message) || Object.getPrototypeOf(message) !== Object.prototype) return { ok: false, id: null, reason: 'MALFORMED' };
  const record = message as Record<string, unknown>;
  const id = typeof record.id === 'string' && COMMAND_ID.test(record.id) ? record.id : null;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(COMMAND_KEYS) || record.protocol !== FV_EXECUTOR_IPC_PROTOCOL || id === null || typeof record.type !== 'string') return { ok: false, id, reason: 'MALFORMED' };
  if (record.type !== 'status' && record.type !== 'stop') return { ok: false, id, reason: 'COMMAND_UNKNOWN' };
  return { ok: true, command: Object.freeze({ protocol: FV_EXECUTOR_IPC_PROTOCOL, type: record.type, id }) };
}
