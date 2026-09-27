import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { AuthorityControlledExecutionService } from '../execution-governance/index.js';
import { isAuthenticatedDurableBoundedGrantStore } from '../bounded-grant-store/sqlite-bounded-grant-store.js';
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
 *
 * It does report, since CORE-01, **which kind of grant store** the Host holds —
 * `authenticated-durable` or `unauthenticated` — so a deployment running on
 * unsigned authority storage says so rather than looking identical to one that
 * is not. For the authenticated durable store it also probes the store's own
 * local health, which includes verifying the signed revocation-state
 * commitment: a store whose revocation state cannot be proven answers no
 * authority read, and is reported unhealthy. That probe is local SQLite, never
 * a provider.
 *
 * A Host whose purpose **is** governed execution (the Enterprise Host bootstrap,
 * `host/enterprise-host.ts`) composes it as `required` instead: there, an
 * unhealthy grant store means the Host cannot do the one thing it runs for, and
 * `/health` and `/ready` must say so.
 */
export function createAuthorityControlledExecutionModule(
  service: AuthorityControlledExecutionService,
  adapterId: string,
  now: () => string,
  grantStore?: unknown,
  criticality: 'required' | 'optional' = 'optional',
): EnterpriseModule {
  const durable = isAuthenticatedDurableBoundedGrantStore(grantStore) ? grantStore : undefined;
  return {
    descriptor: {
      id: AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Authority-Controlled Execution',
      description: 'Bounded-grant issuance and grant-gated, provider-neutral execution composed onto the Kernel.',
      criticality,
      dependencies: [{ moduleId: KERNEL_MODULE_ID }],
      capabilities: ['grant.issue', 'grant.exercise', 'grant.revoke', 'execution.adapter'],
    },
    async initialize() {
      if (service === undefined) {
        throw new Error('AuthorityControlledExecutionService instance is missing.');
      }
    },
    async health() {
      if (durable === undefined) {
        return { status: 'healthy', checkedAt: now(), details: { executionAdapterId: adapterId, grantStore: 'unauthenticated' } };
      }
      try {
        const report = await durable.health();
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          details: {
            executionAdapterId: adapterId,
            grantStore: 'authenticated-durable',
            revocationState: report.revocationState,
            ...(report.revocationStateFailure !== undefined ? { revocationStateFailure: report.revocationStateFailure } : {}),
            ...(report.revocationSequence !== undefined ? { revocationSequence: report.revocationSequence } : {}),
          },
        };
      } catch {
        return { status: 'unhealthy', checkedAt: now(), details: { executionAdapterId: adapterId, grantStore: 'authenticated-durable', revocationState: 'failed' } };
      }
    },
    async shutdown() {
      // The composition owns no external resources of its own: the grant store
      // and the execution adapter are supplied by the host, and the host closes
      // what it opened.
    },
  };
}
