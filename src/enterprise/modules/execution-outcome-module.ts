import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';
import { GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID } from './governed-action-orchestrator-module.js';

export const EXECUTION_OUTCOME_MODULE_ID = 'aoc.enterprise.execution-outcomes';

/**
 * Reports the health of the durable execution outcome store (P11): whether the
 * exact attempt context and the initial provider observations of governed
 * executions can currently be read and written.
 *
 * Registered whenever the Governed Action Orchestrator is composed — the store
 * is composed with it automatically, never as a separate opt-in.
 *
 * ## Why `optional`, and why that is still fail-closed
 *
 * The frozen v1 evaluation surface never passes through this store, so an
 * outage here is not an outage of the Host. It is an outage of **governed
 * execution**, and that capability fails closed on its own: an attempt that
 * cannot be durably prepared is never claimed and never reaches an adapter
 * (`system_error` / `GOVERNED_ACTION_EXECUTION_CLAIM_FAILED`), and an
 * execution whose record cannot be read replays as "attempted, outcome not on
 * record" — never as a success, and never as a second invocation. This module
 * makes that state visible to an operator; it is never read by anything that
 * decides.
 *
 * It owns nothing: the composition root closes a store it opened, and a host
 * closes one it supplied.
 */
export function createExecutionOutcomeModule(store: ExecutionOutcomeStore, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: EXECUTION_OUTCOME_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Durable Execution Outcomes',
      description: 'Immutable, integrity-verified, tenant-confined record of each governed execution: its exact prepared context and its initial provider observation. No route.',
      criticality: 'optional',
      dependencies: [{ moduleId: GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID }],
      capabilities: ['execution.durable-outcomes', 'execution.provider-certainty'],
    },
    async initialize() {},
    async health(): Promise<EnterpriseModuleHealth> {
      try {
        const report = await store.health();
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The execution outcome store is unavailable; governed executions are refused before any provider is contacted.' }),
          details: { provider: store.providerKind, readable: report.readable, writable: report.writable, schemaVersion: report.schemaVersion },
        };
      } catch {
        return { status: 'unhealthy', checkedAt: now(), details: { provider: store.providerKind, readable: false, writable: false } };
      }
    },
    async shutdown() {
      // Owns nothing; see above.
    },
  };
}
