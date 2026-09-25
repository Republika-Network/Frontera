import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule } from './enterprise-module.js';
import { AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID } from './authority-controlled-execution-module.js';
import { GOVERNANCE_STORE_MODULE_ID } from './governance-store-module.js';
import { KERNEL_MODULE_ID } from './kernel-module.js';

export const GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID = 'aoc.enterprise.governed-action-orchestrator';

/**
 * Reports that this deployment composed the Governed Action Orchestrator, and
 * nothing more.
 *
 * Registered **only** when a host asked for governed actions, so its absence
 * from `modules()` is the honest answer for every deployment that did not.
 * `optional` for the reason the Authority-Controlled Execution module is: the
 * frozen v1 evaluation surface never passes through this path, so it must not
 * be able to take an otherwise healthy Host out of `ready`. It adds no route.
 *
 * A Host whose purpose **is** governed execution (the Enterprise Host bootstrap,
 * `host/enterprise-host.ts`) composes it as `required` instead: there, an
 * unhealthy orchestrator means the Host cannot do the one thing it runs for, and
 * `/health` and `/ready` must say so.
 */
export function createGovernedActionOrchestratorModule(now: () => string, criticality: 'required' | 'optional' = 'optional'): EnterpriseModule {
  return {
    descriptor: {
      id: GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Governed Action Orchestrator',
      description: 'Internal governed-action orchestration: bound identity -> Kernel -> committed decision -> bounded grant -> exercise. Customer route: POST /api/governed-actions, through customer identity admission only.',
      criticality,
      dependencies: [{ moduleId: KERNEL_MODULE_ID }, { moduleId: GOVERNANCE_STORE_MODULE_ID }, { moduleId: AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID }],
      capabilities: ['governed-action.orchestrate'],
    },
    async initialize() {},
    async health() {
      return { status: 'healthy', checkedAt: now() };
    },
    async shutdown() {
      // Owns nothing: the Governance Store, grant store and adapter belong to the Host.
    },
  };
}
