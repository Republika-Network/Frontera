import { AOC_KERNEL_AUTHORITY_RUNTIME_VERSION, isDurableKernelAuthorityStoreProvider } from '../kernel-authority/contracts.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';

export const KERNEL_AUTHORITY_MODULE_ID = 'aoc.enterprise.kernel-authority';

/**
 * The Kernel Authority Runtime module: the durable, operator-provisioned
 * recognition/authority world the Kernel decides against.
 *
 * `criticality` defaults to `required` for this module, unlike its Passport
 * and Assurance siblings, and the asymmetry is deliberate. Those two degrade
 * gracefully because a deployment can still evaluate governance without them.
 * This one cannot: if the authority source is unreadable, every evaluation
 * would be answered out of a world that no longer reflects what operators
 * provisioned. Reporting `ready` in that state would be reporting a healthy
 * service that has quietly lost its authority -- so a deployment that
 * configured durable authority is not ready without it.
 *
 * It declares no dependency on the Governance Store. Evaluation history and
 * authority source-of-truth are separate concerns living in separate stores,
 * and neither needs the other to come online.
 */
export function createKernelAuthorityModule(store: KernelAuthorityStore, now: () => string, required: boolean): EnterpriseModule {
  return {
    descriptor: {
      id: KERNEL_AUTHORITY_MODULE_ID,
      version: AOC_KERNEL_AUTHORITY_RUNTIME_VERSION,
      displayName: 'Kernel Authority Runtime',
      description: 'Durable, operator-provisioned recognition and authority state restored into the world AocKernel evaluates against.',
      criticality: required ? 'required' : 'optional',
      capabilities: [
        'kernel-authority.provision',
        'kernel-authority.revoke',
        'kernel-authority.hydrate',
        'kernel-authority.external-subject-binding',
        'kernel-authority.audit-trail',
      ],
    },
    async initialize() {
      const health = await store.health();
      if (!health.writable) {
        throw new Error(`KernelAuthorityStore (${store.providerKind}) is not writable (migrationState: ${health.migrationState}).`);
      }
    },
    async health(): Promise<EnterpriseModuleHealth> {
      const health = await store.health();
      return {
        status: health.status,
        checkedAt: now(),
        ...(health.status !== 'healthy' ? { message: `KernelAuthorityStore is ${health.status}.` } : {}),
        details: {
          // Deliberately shape and counts only: never an actor id, a capability,
          // a resource scope, or any other authority content.
          provider: store.providerKind,
          durable: isDurableKernelAuthorityStoreProvider(store.providerKind),
          writable: health.writable,
          readable: health.readable,
          schemaVersion: health.schemaVersion,
          migrationState: health.migrationState,
          recordCount: health.recordCount,
        },
      };
    },
    async shutdown() {
      await store.close();
    },
  };
}

/**
 * The module a deployment gets when it configured durable authority, declared
 * it optional, and the store could not be opened or its world could not be
 * restored.
 *
 * It exists so the failure is visible in health rather than inferred from a
 * missing module. It reports unhealthy and never becomes ready; the Host stays
 * live because the operator asked for that, and the world it evaluates against
 * is the empty fail-closed one, so every request denies.
 */
export function createUnavailableKernelAuthorityModule(failure: Error, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: KERNEL_AUTHORITY_MODULE_ID,
      version: AOC_KERNEL_AUTHORITY_RUNTIME_VERSION,
      displayName: 'Kernel Authority Runtime (unavailable)',
      description: 'Configured durable authority source that could not be opened. Declared optional, so the Host runs against an empty fail-closed world.',
      criticality: 'optional',
      capabilities: [],
    },
    async initialize() {
      // Deliberately does not throw: an optional module that failed to come up
      // must degrade the Host, not prevent it from starting.
    },
    async health(): Promise<EnterpriseModuleHealth> {
      return {
        status: 'unhealthy',
        checkedAt: now(),
        message: 'The configured Kernel Authority Store is unavailable; the Kernel is evaluating against an empty, fail-closed world.',
        // The reason, never the authority content -- and never a path, which
        // would disclose deployment layout through a health endpoint.
        details: { provider: 'unavailable', durable: false, writable: false, readable: false, reason: failure.name },
      };
    },
    async shutdown() {
      // Nothing was opened.
    },
  };
}
