import type { EvidenceStore } from '../evidence/evidence-store.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';

export const EVIDENCE_STORE_MODULE_ID = 'aoc.enterprise.evidence-bundles';

/**
 * ASSURE-01 — reports the health of the Evidence Bundle Store: whether bundles
 * can currently be read and written.
 *
 * `optional`: evidence is never a prerequisite of a decision or an effect, so
 * an unavailable bundle store degrades the Host (bundles cannot be built or
 * verified) and changes no authority outcome. It owns nothing: the
 * composition root closes a store it opened.
 */
export function createEvidenceStoreModule(store: EvidenceStore, now: () => string): EnterpriseModule {
  return {
    descriptor: {
      id: EVIDENCE_STORE_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Evidence Bundles',
      description: 'Immutable, integrity-verified Evidence Bundles — v1 decision projections and v2 Unified Authority-to-Outcome Trace bundles — with forward-only lifecycle bookkeeping.',
      criticality: 'optional',
      dependencies: [],
      capabilities: ['evidence.bundle-store'],
    },
    async initialize() {},
    async health(): Promise<EnterpriseModuleHealth> {
      try {
        const report = await store.health();
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The Evidence Bundle Store is unavailable; bundles cannot be built, read or verified. No authority outcome depends on it.' }),
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
