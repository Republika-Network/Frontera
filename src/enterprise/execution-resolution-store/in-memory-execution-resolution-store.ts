import {
  EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
  type BindExecutionResolutionAuthorityInput,
  type BindExecutionResolutionAuthorityResult,
  type ExecutionResolutionAccessContext,
  type ExecutionResolutionBinding,
  type ExecutionResolutionRecord,
  type ExecutionResolutionState,
  type ExecutionResolutionStoreHealth,
  type RecordExecutionResolutionInput,
  type RecordExecutionResolutionResult,
} from './contracts.js';
import { ExecutionResolutionStoreError } from './errors.js';
import { buildExecutionResolutionBinding, buildExecutionResolutionRecord } from './integrity.js';
import {
  planExecutionResolution,
  planExecutionResolutionBinding,
  requireResolutionAccessContext,
  requireResolutionExecutionId,
  requireValidBinding,
  requireValidResolution,
  verifyLoadedResolutionState,
  type ExecutionResolutionStore,
} from './resolution-store.js';
import { isCanonicalResolutionInstant } from './validation.js';

export interface InMemoryExecutionResolutionStoreOptions {
  /** The injected clock, sampled inside each write's synchronous section as `recordedAt`. Required. */
  readonly now: () => string;
}

/**
 * The reference implementation of `ExecutionResolutionStore`, held to the same
 * shared contract suite as the SQLite store. Every write is one synchronous
 * section. **Not durable**: selected only when `persistence.provider` is
 * `memory`.
 */
export function createInMemoryExecutionResolutionStore(options: InMemoryExecutionResolutionStoreOptions): ExecutionResolutionStore {
  if (typeof options?.now !== 'function') throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_STORE_UNAVAILABLE', 'The execution resolution store requires an injected clock.');
  const now = options.now;
  const bindings = new Map<string, ExecutionResolutionBinding>();
  const resolutions = new Map<string, ExecutionResolutionRecord>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_STORE_UNAVAILABLE', 'The execution resolution store has been closed.');
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalResolutionInstant(instant)) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_STORE_UNAVAILABLE', 'The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function load(executionId: string, organizationId: string): ExecutionResolutionState | undefined {
    return verifyLoadedResolutionState(executionId, organizationId, bindings.get(executionId), resolutions.get(executionId));
  }

  return {
    providerKind: 'memory',

    async bind(context: ExecutionResolutionAccessContext, input: BindExecutionResolutionAuthorityInput): Promise<BindExecutionResolutionAuthorityResult> {
      assertOpen();
      requireValidBinding(context, input);
      const plan = planExecutionResolutionBinding(input, load(input.executionId, input.organizationId));
      if (plan.kind === 'existing') return { outcome: 'existing', binding: plan.binding };
      const binding = buildExecutionResolutionBinding(input, recordedAt());
      bindings.set(binding.executionId, binding);
      return { outcome: 'bound', binding };
    },

    async recordResolution(context: ExecutionResolutionAccessContext, input: RecordExecutionResolutionInput): Promise<RecordExecutionResolutionResult> {
      assertOpen();
      requireValidResolution(context, input);
      const plan = planExecutionResolution(input, load(input.executionId, input.organizationId));
      if (plan.kind === 'existing') return { outcome: 'existing', resolution: plan.resolution };
      const resolution = buildExecutionResolutionRecord(input, recordedAt());
      resolutions.set(resolution.executionId, resolution);
      return { outcome: 'recorded', resolution };
    },

    async read(context: ExecutionResolutionAccessContext, executionId: string): Promise<ExecutionResolutionState | undefined> {
      assertOpen();
      const organizationId = requireResolutionAccessContext(context);
      requireResolutionExecutionId(executionId);
      return load(executionId, organizationId);
    },

    async health(): Promise<ExecutionResolutionStoreHealth> {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
