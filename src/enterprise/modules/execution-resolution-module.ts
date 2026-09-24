import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';
import { GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID } from './governed-action-orchestrator-module.js';

export const EXECUTION_RESOLUTION_MODULE_ID = 'aoc.enterprise.execution-resolutions';

/**
 * Reports the health of the P12 execution resolution store: whether
 * resolution-authority bindings and definitive resolutions can currently be read
 * and written.
 *
 * Registered only when `executionReconciliation` is enabled.
 *
 * ## Store health is not authority health
 *
 * `authoritiesComposed` counts the resolution authorities composed at
 * startup. It says nothing about whether any of them can reach its provider:
 * this module never calls an authority, and a healthy SQLite file is never
 * reported as provider connectivity. (Richer operability is P16.)
 *
 * ## Why `optional`, and why that is still fail-closed
 *
 * The frozen evaluate surface never passes through this store. Governed
 * execution fails closed on its own: a binding that cannot be written stops an
 * execution before its claim, and a resolution that cannot be read is never
 * replayed optimistically. It owns nothing: the composition root closes a
 * store it opened, and a host closes one it supplied.
 */
export function createExecutionResolutionModule(store: ExecutionResolutionStore, authoritiesComposed: number, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: EXECUTION_RESOLUTION_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Execution Resolutions',
      description: 'Immutable, integrity-verified record of which trusted resolution authority may resolve each governed execution, and of what it later established. No route.',
      criticality: 'optional',
      dependencies: [{ moduleId: GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID }],
      capabilities: ['execution.resolution-authority-binding', 'execution.definitive-resolution'],
    },
    async initialize() {},
    async health(): Promise<EnterpriseModuleHealth> {
      try {
        const report = await store.health();
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The execution resolution store is unavailable; new governed executions are refused before their claim, and no resolution can be recorded.' }),
          details: { provider: store.providerKind, readable: report.readable, writable: report.writable, schemaVersion: report.schemaVersion, authoritiesComposed },
        };
      } catch {
        return { status: 'unhealthy', checkedAt: now(), details: { provider: store.providerKind, readable: false, writable: false, authoritiesComposed } };
      }
    },
    async shutdown() {
      // Owns nothing; see above.
    },
  };
}
