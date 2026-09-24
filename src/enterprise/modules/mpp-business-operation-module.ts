import type { MppBusinessOperationStore } from '../mpp-business-operation-store/operation-store.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';
import { GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID } from './governed-action-orchestrator-module.js';

export const MPP_BUSINESS_OPERATION_MODULE_ID = 'aoc.enterprise.mpp-business-operations';

/**
 * Reports the health of the P13 MPP business-operation store: whether business
 * operations and their challenge history can currently be read and written.
 *
 * Registered only when `mppChallengePayments` is enabled.
 *
 * ## Store health is not method or merchant health
 *
 * `methodsComposed` counts the trusted method normalizers composed at startup.
 * It says nothing about any merchant, rail or provider: this module never
 * parses a challenge, and makes no network call. (Richer operability is P16.)
 *
 * ## Why `optional`, and why that is still fail-closed
 *
 * The frozen evaluate and governed-action surfaces never pass through this
 * store. MPP challenge payments fail closed on their own: an operation that
 * cannot be recorded never reaches governance. It owns nothing: the
 * composition root closes a store it opened, and a host closes one it supplied.
 */
export function createMppBusinessOperationModule(store: MppBusinessOperationStore, methodsComposed: number, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: MPP_BUSINESS_OPERATION_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'MPP Business Operations',
      description: 'Immutable, integrity-verified record of each MPP business operation, its accepted challenges, and the governed request it maps to. No route.',
      criticality: 'optional',
      dependencies: [{ moduleId: GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID }],
      capabilities: ['mpp.challenge-ingestion', 'mpp.business-idempotency'],
    },
    async initialize() {},
    async health(): Promise<EnterpriseModuleHealth> {
      try {
        const report = await store.health();
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The MPP business-operation store is unavailable; MPP challenge payments are refused before governance.' }),
          details: { provider: store.providerKind, readable: report.readable, writable: report.writable, schemaVersion: report.schemaVersion, methodsComposed },
        };
      } catch {
        return { status: 'unhealthy', checkedAt: now(), details: { provider: store.providerKind, readable: false, writable: false, methodsComposed } };
      }
    },
    async shutdown() {
      // Owns nothing; see above.
    },
  };
}
