import type { KernelEvaluationRequest, KernelEvaluationResult, KernelTrace } from '../../kernel/index.js';
import type {
  AppendGovernanceEvaluationInput,
  AppendGovernanceEvaluationResult,
  GovernanceEvaluationRecord,
  GovernanceIdempotencyProbe,
  GovernanceIdempotencyResolution,
  GovernanceRecord,
  GovernanceRecordLoadResult,
  GovernanceRecordVerificationResult,
  GovernanceReferenceInput,
  GovernanceRequestRecord,
  GovernanceStoreAccessContext,
  GovernanceStoreCountQuery,
  GovernanceStoreHealth,
  GovernanceStoreQuery,
  GovernanceStoreQueryResult,
} from './contracts.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';

/**
 * Legacy (PR-002) event row shape, preserved for the compatibility surface.
 * New code should use `GovernanceEventRecord`; this shape remains what
 * `appendEnterpriseEvent`/`listEnterpriseEvents` speak.
 *
 * @deprecated Use `GovernanceEventRecord` and the aggregate append flow.
 */
export interface EnterpriseEventRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly requestId: string;
  readonly decisionId?: string;
  readonly correlationId?: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One row per Host boot ("what was running when this decision was made"), unchanged from PR-002. */
export interface EnterpriseVersionRecord {
  readonly bootId: string;
  readonly enterpriseVersion: string;
  readonly kernelVersion: string;
  readonly recordedAt: string;
}

/**
 * Legacy (PR-002) whole-trace read shape: the complete `KernelTrace` for one
 * decision, reassembled from the normalized `governance_trace_steps` rows.
 *
 * @deprecated Use `GovernanceRecord.trace` (normalized step records).
 */
export interface GovernanceDecisionTraceRecord {
  readonly decisionId: string;
  readonly trace: KernelTrace;
}

export type PersistEvaluationOutcome = 'stored' | 'idempotent_replay' | 'conflict';

/** @deprecated Use `AppendGovernanceEvaluationInput`. */
export interface PersistEvaluationInput {
  readonly request: KernelEvaluationRequest;
  readonly result: KernelEvaluationResult;
  readonly receivedAt: string;
}

/** @deprecated Use `AppendGovernanceEvaluationResult`. */
export interface PersistEvaluationResult {
  readonly outcome: PersistEvaluationOutcome;
  readonly evaluation: GovernanceEvaluationRecord;
}

/**
 * The Soberanía Enterprise Governance Store v1 (`aoc.governance-store.v1`): the
 * canonical, append-oriented, integrity-verifiable durable record of every
 * governance evaluation the Enterprise Host performs.
 *
 * Design invariants:
 * - **Records, never decides.** No method here interprets governance
 *   semantics; the Kernel result is preserved verbatim (sanitized), not
 *   reinterpreted.
 * - **Append-oriented.** There is deliberately no public update or delete
 *   method, and none may be added; corrections are future *appended*
 *   records (`GovernanceCorrectionRecord`, reserved). SQLite itself cannot
 *   make rows immutable — logical immutability is enforced by this API
 *   shape, by constraints, and by tests, and its limits are documented.
 * - **One evaluation = one atomic aggregate.** `appendEvaluation` commits
 *   request + evaluation + trace + reason codes + events + metadata +
 *   integrity in one transaction, or nothing at all.
 * - **Tenant-scoped reads.** Every read/query takes a
 *   `GovernanceStoreAccessContext`; non-system callers are bounded to
 *   their organization by the Store, not by caller discipline.
 *
 * The legacy PR-002 methods remain as a documented compatibility surface
 * implemented *on top of* the v1 model — there is exactly one storage
 * implementation per provider, never two.
 */
export interface GovernanceStore {
  readonly providerKind: 'memory' | 'sqlite';

  // -- v1 write model -------------------------------------------------------

  /** Appends one complete evaluation aggregate atomically. Idempotency (requestId and optional caller key, tenant-scoped) is enforced inside the same transaction via uniqueness constraints. */
  appendEvaluation(input: AppendGovernanceEvaluationInput): Promise<AppendGovernanceEvaluationResult>;

  /**
   * Pre-evaluation idempotency resolution, so the Host can skip re-running
   * the Kernel for an already-processed request. Advisory: the authoritative
   * enforcement is `appendEvaluation`'s own transactional uniqueness — a
   * concurrent racer that misses here still cannot double-commit.
   */
  resolveIdempotency(context: GovernanceStoreAccessContext, probe: GovernanceIdempotencyProbe): Promise<GovernanceIdempotencyResolution>;

  /**
   * Appends a reference from a committed evaluation to a
   * Passport/Evidence/Assurance/execution/authorization artifact.
   *
   * The append is transactional and tamper-evident: the Store assigns the
   * reference's position in this evaluation's chain, seals it, and advances
   * the stored chain head in one transaction, so no committed reference can
   * exist without its integrity metadata. Callers supply only the semantic
   * fields — chain position and digests are never caller-controlled.
   */
  appendReference(context: GovernanceStoreAccessContext, reference: GovernanceReferenceInput): Promise<void>;

  /** Appends one lifecycle/module event outside any evaluation aggregate (linked by correlation, not foreign key). Best-effort operational history. */
  appendLifecycleEvent(event: EnterpriseEvent): Promise<void>;

  // -- v1 read model --------------------------------------------------------

  getByEvaluationId(context: GovernanceStoreAccessContext, evaluationId: string): Promise<GovernanceRecord | null>;
  getByDecisionId(context: GovernanceStoreAccessContext, decisionId: string): Promise<GovernanceRecord | null>;
  getByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<GovernanceRecord | null>;

  /** Bounded, tenant-scoped query with opaque cursor pagination (order: chain position descending — newest committed first). */
  query(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult>;

  /**
   * PROD-03-01 — how many records the same tenant-scoped filters match, without
   * reading or returning one. Optional, so an embedder's own store stays a
   * valid `GovernanceStore`; both shipped providers implement it.
   */
  count?(context: GovernanceStoreAccessContext, query: GovernanceStoreCountQuery): Promise<number>;

  /** Structured reconstruction: loads every linked record, reports `complete`/`incomplete`/`corrupted` explicitly instead of silently returning partial data. */
  reconstruct(context: GovernanceStoreAccessContext, evaluationId: string): Promise<GovernanceRecordLoadResult>;

  /** Recomputes every digest from the stored canonical payloads and validates chain linkage. Stored digest values are never trusted without recomputation. */
  verify(context: GovernanceStoreAccessContext, evaluationId: string): Promise<GovernanceRecordVerificationResult>;

  health(): Promise<GovernanceStoreHealth>;

  // -- legacy PR-002 compatibility surface ----------------------------------

  /** @deprecated Use `appendEvaluation`. Appends with a minimal Enterprise context; outcomes map 1:1 onto the old contract. */
  persistEvaluation(input: PersistEvaluationInput): Promise<PersistEvaluationResult>;

  /** @deprecated Use `getByRequestId` with an access context. System-scoped. */
  getRequestById(requestId: string): Promise<GovernanceRequestRecord | undefined>;
  /** @deprecated Use `getByRequestId` with an access context. System-scoped. */
  getEvaluationByRequestId(requestId: string): Promise<GovernanceEvaluationRecord | undefined>;
  /** @deprecated Use `getByDecisionId` with an access context. System-scoped. */
  getEvaluationByDecisionId(decisionId: string): Promise<GovernanceEvaluationRecord | undefined>;
  /** @deprecated Use `getByDecisionId` — trace steps are normalized records on the aggregate. System-scoped. */
  getTraceByDecisionId(decisionId: string): Promise<GovernanceDecisionTraceRecord | undefined>;

  /** @deprecated Evaluation events are embedded in the aggregate by `appendEvaluation`; lifecycle events flow through `appendLifecycleEvent`. */
  appendEnterpriseEvent(record: EnterpriseEventRecord): Promise<void>;
  /** @deprecated Use `query`/`getBy*` with an access context. System-scoped. */
  listEnterpriseEvents(filter?: { readonly requestId?: string; readonly correlationId?: string }): Promise<readonly EnterpriseEventRecord[]>;

  recordEnterpriseVersion(record: EnterpriseVersionRecord): Promise<void>;
  getLatestEnterpriseVersion(): Promise<EnterpriseVersionRecord | undefined>;

  checkConnectivity(): Promise<boolean>;
  close(): Promise<void>;
}
