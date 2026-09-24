import {
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION,
  type ExecutionAttemptRecord,
  type ExecutionOutcomeAccessContext,
  type ExecutionOutcomeRecord,
  type ExecutionOutcomeStoreHealth,
  type ExecutionTerminalRecord,
  type PrepareExecutionAttemptInput,
  type PrepareExecutionAttemptResult,
  type RecordExecutionTerminalInput,
  type RecordExecutionTerminalResult,
} from './contracts.js';
import { ExecutionOutcomeStoreError } from './errors.js';
import { buildExecutionAttemptRecord, buildExecutionTerminalRecord } from './integrity.js';
import {
  planExecutionAttempt,
  planExecutionTerminal,
  requireExecutionId,
  requireOutcomeAccessContext,
  requireValidAttempt,
  requireValidTerminal,
  verifyLoadedOutcome,
  type ExecutionOutcomeStore,
} from './outcome-store.js';
import { isCanonicalOutcomeInstant } from './validation.js';

export interface InMemoryExecutionOutcomeStoreOptions {
  /** The injected clock, sampled inside each write's synchronous section as `recordedAt`. Required: there is no ambient default. */
  readonly now: () => string;
}

/**
 * The reference implementation of `ExecutionOutcomeStore`, held to the same
 * shared contract suite as the SQLite store: identity, immutability, conflict,
 * validation and tenant isolation are identical.
 *
 * Every write is **one synchronous section** — no `await` between reading the
 * existing records and writing the new one. **Not durable**: a restart loses
 * every attempt and every observation, which is exactly the situation P11
 * exists to prevent in production. The composition root selects it only when
 * `persistence.provider` is `memory`.
 */
export function createInMemoryExecutionOutcomeStore(options: InMemoryExecutionOutcomeStoreOptions): ExecutionOutcomeStore {
  if (typeof options?.now !== 'function') throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_STORE_UNAVAILABLE', 'The execution outcome store requires an injected clock.');
  const now = options.now;
  const attempts = new Map<string, ExecutionAttemptRecord>();
  const terminals = new Map<string, ExecutionTerminalRecord>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_STORE_UNAVAILABLE', 'The execution outcome store has been closed.');
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalOutcomeInstant(instant)) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_STORE_UNAVAILABLE', 'The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function load(executionId: string, organizationId: string): ExecutionOutcomeRecord | undefined {
    return verifyLoadedOutcome(executionId, organizationId, attempts.get(executionId), terminals.get(executionId));
  }

  return {
    providerKind: 'memory',

    async prepareAttempt(context: ExecutionOutcomeAccessContext, input: PrepareExecutionAttemptInput): Promise<PrepareExecutionAttemptResult> {
      assertOpen();
      requireValidAttempt(context, input);
      // One synchronous critical section from here to the return.
      const plan = planExecutionAttempt(input, load(input.executionId, input.organizationId));
      if (plan.kind === 'existing') return { outcome: 'existing', attempt: plan.attempt };
      const attempt = buildExecutionAttemptRecord(input, recordedAt());
      attempts.set(attempt.executionId, attempt);
      return { outcome: 'prepared', attempt };
    },

    async recordTerminal(context: ExecutionOutcomeAccessContext, input: RecordExecutionTerminalInput): Promise<RecordExecutionTerminalResult> {
      assertOpen();
      requireValidTerminal(context, input);
      const plan = planExecutionTerminal(input, load(input.executionId, input.organizationId));
      if (plan.kind === 'existing') return { outcome: 'existing', terminal: plan.terminal };
      const terminal = buildExecutionTerminalRecord(input, plan.attempt, recordedAt());
      terminals.set(terminal.executionId, terminal);
      return { outcome: 'recorded', terminal };
    },

    async read(context: ExecutionOutcomeAccessContext, executionId: string): Promise<ExecutionOutcomeRecord | undefined> {
      assertOpen();
      const organizationId = requireOutcomeAccessContext(context);
      requireExecutionId(executionId);
      return load(executionId, organizationId);
    },

    async health(): Promise<ExecutionOutcomeStoreHealth> {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: EXECUTION_OUTCOME_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
