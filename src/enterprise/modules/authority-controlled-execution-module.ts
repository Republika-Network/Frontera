import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { AuthorityControlledExecutionService } from '../execution-governance/index.js';
import type { EnterpriseModule } from './enterprise-module.js';
import { KERNEL_MODULE_ID } from './kernel-module.js';

export const AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID = 'aoc.enterprise.authority-controlled-execution';

/**
 * Reports that this deployment composed grant-aware execution, and nothing
 * more.
 *
 * Registered **only** when a host supplied `authorityControlledExecution`, so
 * its absence from `modules()` is the honest answer for every deployment that
 * did not adopt layer E — the same way the Kernel Authority module is absent
 * when no durable authority source is configured.
 *
 * `criticality: 'optional'` because a Host that cannot run grant-aware
 * execution is still a Host: the frozen v1 evaluation surface does not pass
 * through this composition and never has. Marking it `required` would let an
 * opt-in execution boundary take an otherwise healthy deployment out of
 * `ready`.
 *
 * It performs no health probe against the provider. Reaching an external
 * system to answer `/ready` would make the availability of a payment rail into
 * the availability of authorization, which is exactly risk R1 in
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §9 — and an adapter that is down
 * withholds nothing anyway, because an execution that cannot run reports
 * `execution-failed` rather than a grant or a decision.
 */
export function createAuthorityControlledExecutionModule(service: AuthorityControlledExecutionService, adapterId: string, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Authority-Controlled Execution',
      description: 'Bounded-grant issuance and grant-gated, provider-neutral execution composed onto the Kernel.',
      criticality: 'optional',
      dependencies: [{ moduleId: KERNEL_MODULE_ID }],
      capabilities: ['grant.issue', 'grant.exercise', 'grant.revoke', 'execution.adapter'],
    },
    async initialize() {
      if (service === undefined) {
        throw new Error('AuthorityControlledExecutionService instance is missing.');
      }
    },
    async health() {
      return { status: 'healthy', checkedAt: now(), details: { executionAdapterId: adapterId } };
    },
    async shutdown() {
      // The composition owns no external resources of its own: the grant store
      // and the execution adapter are supplied by the host, and the host closes
      // what it opened.
    },
  };
}
