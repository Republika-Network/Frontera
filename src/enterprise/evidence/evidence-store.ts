import type { GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { EvidenceError } from './errors.js';
import type { EvidenceBundle, EvidenceBundleRecord, EvidenceBundleState } from './contracts.js';

/**
 * The Bundle Store (mission section "Bundle Store"): storage for Evidence
 * Bundles, deliberately independent of the Governance Store -- "No guardar
 * Bundles dentro del Governance Store." Bundles themselves are immutable;
 * this store's only mutable state is lifecycle bookkeeping
 * (`EvidenceBundleState`), tracked per `bundleId`, never a rewrite of the
 * bundle's own content. There is no update method and none may be added.
 *
 * Query surface is deliberately bounded to a Bundle's own identifiers
 * (mission: "No exponer queries masivas") -- there is no arbitrary filter or
 * cross-tenant listing here, and every list returns at most
 * `EVIDENCE_STORE_LIST_LIMIT` entries (the newest).
 *
 * ASSURE-01: a durable SQLite provider (`sqlite-evidence-store.ts`) is the
 * production one; the in-memory provider remains for embedders and tests. The
 * lifecycle is forward-only — `GENERATED → VERIFIED → EXPORTED`, any of them →
 * `SUPERSEDED`, which is terminal — and a transition that would move backwards
 * is a no-op returning the current entry, never a rewrite.
 */
export interface EvidenceStore {
  readonly providerKind: 'memory' | 'sqlite';

  /**
   * Stores a newly built, immutable Bundle. Throws `EVIDENCE_BUNDLE_ALREADY_EXISTS`
   * if `bundleId` was already stored -- Bundles are never overwritten.
   * `supersedes` marks earlier bundles of the same organization and request
   * `SUPERSEDED` by this one in the same atomic step; it never changes their content.
   */
  store(bundle: EvidenceBundle, options?: StoreEvidenceBundleOptions): Promise<EvidenceBundleRecord>;

  getByBundleId(context: GovernanceStoreAccessContext, bundleId: string): Promise<EvidenceBundleRecord | null>;
  listByEvaluationId(context: GovernanceStoreAccessContext, evaluationId: string): Promise<readonly EvidenceBundleRecord[]>;
  listByDecisionId(context: GovernanceStoreAccessContext, decisionId: string): Promise<readonly EvidenceBundleRecord[]>;
  /** ASSURE-01: the bundles built for one governed request (bounded, oldest first). */
  listByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<readonly EvidenceBundleRecord[]>;

  /** Records that this Bundle has been successfully verified. Never mutates the Bundle itself -- only the store's lifecycle bookkeeping. */
  markVerified(bundleId: string): Promise<EvidenceBundleRecord>;
  /** Records that this Bundle has been exported to a consumer. */
  markExported(bundleId: string): Promise<EvidenceBundleRecord>;
  /**
   * Records that this Bundle has been superseded by a newly built
   * replacement -- the mission's "Supersession": a changed disclosure
   * policy never updates an existing Bundle, it always produces a new one,
   * and the old one is marked superseded rather than deleted.
   */
  supersede(bundleId: string, replacementBundleId: string): Promise<EvidenceBundleRecord>;

  health(): Promise<EvidenceStoreHealth>;
  close(): Promise<void>;
}

export interface StoreEvidenceBundleOptions {
  /**
   * The organization that owns the Bundle — the source record's organization,
   * independent of whether the Bundle's disclosure policy reveals it. Defaults
   * to `bundle.source.organizationId` (the pre-ASSURE-01 behaviour).
   */
  readonly organizationId?: string;
  /** Bundles this one replaces (ASSURE-01: an earlier bundle of the same request and policy). */
  readonly supersedes?: readonly string[];
}

export interface EvidenceStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}

/** Every list is bounded; the newest entries are kept when more exist. */
export const EVIDENCE_STORE_LIST_LIMIT = 100;

export const EVIDENCE_STORE_MEMORY_SCHEMA_VERSION = 'aoc.evidence-bundle-store.memory.v1';

export interface CreateEvidenceStoreOptions {
  readonly now?: () => string;
}

const STATE_RANK: Readonly<Record<EvidenceBundleState, number>> = { GENERATED: 0, VERIFIED: 1, EXPORTED: 2, SUPERSEDED: 3 };

/** The one lifecycle rule both providers apply: forward only, `SUPERSEDED` terminal. */
export function isForwardEvidenceTransition(from: EvidenceBundleState, to: EvidenceBundleState): boolean {
  return from !== 'SUPERSEDED' && STATE_RANK[to] > STATE_RANK[from];
}

export function canSeeEvidenceBundle(context: GovernanceStoreAccessContext, ownerOrganizationId: string | undefined): boolean {
  if (context.system) return true;
  return ownerOrganizationId !== undefined && ownerOrganizationId === context.organizationId;
}

export function requireEvidenceReadScope(context: GovernanceStoreAccessContext): void {
  if (!context.system && (context.organizationId === undefined || context.organizationId.length === 0)) {
    throw new EvidenceError('EVIDENCE_TENANT_SCOPE_REQUIRED', 'A non-system caller must provide an organization scope for Evidence Bundle reads.');
  }
}

/** In-memory Bundle Store. Atomicity comes from the synchronous commit sections (single-threaded JS) -- no `await` sits between a lookup and its corresponding index update. */
export function createInMemoryEvidenceStore(options: CreateEvidenceStoreOptions = {}): EvidenceStore {
  const now = options.now ?? (() => new Date().toISOString());
  const bundlesById = new Map<string, EvidenceBundleRecord>();
  const order: string[] = [];
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new EvidenceError('EVIDENCE_STORE_UNAVAILABLE', 'The Evidence Bundle Store has been closed.');
  }

  function requireStored(bundleId: string): EvidenceBundleRecord {
    const existing = bundlesById.get(bundleId);
    if (existing === undefined) {
      throw new EvidenceError('EVIDENCE_BUNDLE_NOT_FOUND', `No Evidence Bundle for bundleId '${bundleId}'.`);
    }
    return existing;
  }

  function transition(bundleId: string, state: EvidenceBundleState, supersededBy?: string): EvidenceBundleRecord {
    assertOpen();
    const existing = requireStored(bundleId);
    if (!isForwardEvidenceTransition(existing.state, state)) return existing;
    const updated: EvidenceBundleRecord = { ...existing, state, ...(supersededBy !== undefined ? { supersededBy } : {}) };
    bundlesById.set(bundleId, updated);
    return updated;
  }

  function list(context: GovernanceStoreAccessContext, matches: (bundle: EvidenceBundle) => boolean): readonly EvidenceBundleRecord[] {
    assertOpen();
    requireEvidenceReadScope(context);
    const found = order
      .map((id) => bundlesById.get(id))
      .filter((record): record is EvidenceBundleRecord => record !== undefined && matches(record.bundle) && canSeeEvidenceBundle(context, record.organizationId));
    return found.slice(-EVIDENCE_STORE_LIST_LIMIT);
  }

  return {
    providerKind: 'memory',

    async store(bundle, storeOptions = {}) {
      assertOpen();
      if (bundlesById.has(bundle.bundleId)) {
        throw new EvidenceError('EVIDENCE_BUNDLE_ALREADY_EXISTS', `bundleId '${bundle.bundleId}' was already stored; Bundles are immutable and never overwritten.`);
      }
      const organizationId = storeOptions.organizationId ?? bundle.source.organizationId;
      const supersedes = storeOptions.supersedes ?? [];
      for (const id of supersedes) {
        const previous = requireStored(id);
        if (previous.organizationId !== organizationId || previous.bundle.source.requestId !== bundle.source.requestId) {
          throw new EvidenceError('EVIDENCE_ACCESS_SCOPE_VIOLATION', 'A Bundle may only supersede an earlier Bundle of the same organization and request.');
        }
      }
      const record: EvidenceBundleRecord = { bundle, state: 'GENERATED', storedAt: now(), ...(organizationId !== undefined ? { organizationId } : {}) };

      // Synchronous commit section -- the bundle, its index and any supersession commit together.
      bundlesById.set(bundle.bundleId, record);
      order.push(bundle.bundleId);
      for (const id of supersedes) transition(id, 'SUPERSEDED', bundle.bundleId);
      return record;
    },

    async getByBundleId(context, bundleId) {
      assertOpen();
      requireEvidenceReadScope(context);
      const record = bundlesById.get(bundleId);
      if (record === undefined) return null;
      return canSeeEvidenceBundle(context, record.organizationId) ? record : null;
    },

    async listByEvaluationId(context, evaluationId) {
      return list(context, (bundle) => bundle.source.evaluationId === evaluationId);
    },

    async listByDecisionId(context, decisionId) {
      return list(context, (bundle) => bundle.source.decisionId === decisionId);
    },

    async listByRequestId(context, requestId) {
      return list(context, (bundle) => bundle.source.requestId === requestId);
    },

    async markVerified(bundleId) {
      return transition(bundleId, 'VERIFIED');
    },
    async markExported(bundleId) {
      return transition(bundleId, 'EXPORTED');
    },
    async supersede(bundleId, replacementBundleId) {
      assertOpen();
      requireStored(replacementBundleId);
      return transition(bundleId, 'SUPERSEDED', replacementBundleId);
    },

    async health() {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: EVIDENCE_STORE_MEMORY_SCHEMA_VERSION, checkedAt: now() };
    },

    async close() {
      closed = true;
    },
  };
}
