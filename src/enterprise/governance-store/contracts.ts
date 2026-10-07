import type { KernelDecisionStatus, KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import type { EnterpriseModuleSnapshot } from '../modules/enterprise-module.js';

/**
 * Canonical record model of the Soberanía Enterprise Governance Store v1
 * (PR-004). These contracts describe the durable, reconstructable,
 * integrity-verifiable form of one governance evaluation. The Store
 * *records* these facts; it never decides them — decision semantics belong
 * exclusively to `AocKernel` (`src/kernel/`).
 */

export const AOC_GOVERNANCE_STORE_VERSION = '1.0.0';

export const GOVERNANCE_STORE_SCHEMA_VERSION = 'aoc.governance-store.schema.v1';

export const GOVERNANCE_STORE_CONTRACT_IDS = {
  store: 'aoc.governance-store.v1',
  requestRecord: 'aoc.governance-request-record.v1',
  evaluationRecord: 'aoc.governance-evaluation-record.v1',
  traceRecord: 'aoc.governance-trace-record.v1',
  eventRecord: 'aoc.governance-event-record.v1',
  integrityRecord: 'aoc.governance-integrity-record.v1',
  referenceRecord: 'aoc.governance-reference-record.v1',
} as const;

/**
 * The reference-integrity format this build writes and can verify. Stamped
 * on every protected reference row rather than derived from the store schema
 * version, so a future `…v2` can coexist row-by-row instead of retroactively
 * redefining what `v1` rows meant. A row claiming a version this build does
 * not know is reported as unverifiable, never silently accepted and never
 * downgraded to a legacy row.
 */
export const GOVERNANCE_REFERENCE_INTEGRITY_VERSION = 'aoc.governance-reference-integrity.v1';

/** Marker value stamped on `GovernanceRecordMetadata.migrationSource` for aggregates migrated from the PR-002 schema rather than appended live. */
export const GOVERNANCE_MIGRATION_SOURCE_PR_002 = 'pr-002-governance-store';

// ---------------------------------------------------------------------------
// Record model
// ---------------------------------------------------------------------------

/**
 * Durable representation of one incoming governance request. `requestPayload`
 * is the *sanitized persistence projection* of the normalized
 * `KernelEvaluationRequest` (sensitive keys redacted per
 * `redaction.ts`), never raw transport input; `payloadDigest` attests to
 * exactly that persisted projection.
 */
export interface GovernanceRequestRecord {
  readonly recordId: string;
  readonly requestId: string;
  readonly correlationId?: string;

  readonly actorId: string;
  readonly actorType?: string;

  readonly organizationId?: string;

  readonly actionType: string;
  readonly actionDomain?: string;
  readonly resourceScope: string;

  readonly targetType?: string;
  readonly targetId?: string;

  readonly requestedAt: string;
  readonly receivedAt: string;

  readonly requestContract: string;
  readonly requestPayload: Readonly<Record<string, unknown>>;

  readonly payloadDigest: string;
}

/**
 * Durable representation of one Kernel evaluation. `resultPayload` is the
 * complete, sanitized `KernelEvaluationResult` (minus the trace, which is
 * normalized into `GovernanceTraceRecord`s), so an idempotent replay can
 * return the exact original result without re-running the Kernel.
 */
export interface GovernanceEvaluationRecord {
  readonly recordId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly correlationId?: string;

  readonly status: KernelDecisionStatus;
  readonly summary: string;
  readonly reasonCodes: readonly string[];

  readonly evaluatedAt: string;
  readonly persistedAt: string;

  readonly kernelVersion: string;
  readonly enterpriseVersion: string;

  readonly evaluationContract: string;

  readonly resultPayload: Readonly<Record<string, unknown>>;
  readonly resultDigest: string;
}

/** One Kernel trace step, normalized as an append-oriented child record with a unique `(evaluationId, sequence)`. */
export interface GovernanceTraceRecord {
  readonly traceRecordId: string;
  readonly evaluationId: string;
  readonly sequence: number;

  readonly operator: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];

  readonly startedAt?: string;
  readonly completedAt?: string;

  readonly metadata?: Readonly<Record<string, unknown>>;

  readonly traceContract: string;
  readonly traceDigest: string;
}

/** One reason code, normalized for querying while the authoritative ordered list stays on the evaluation record. Duplicates are allowed (the Kernel's order is preserved verbatim); `(evaluationId, sequence)` is unique. */
export interface GovernanceReasonRecord {
  readonly reasonRecordId: string;
  readonly evaluationId: string;
  readonly sequence: number;
  readonly reasonCode: string;
}

export type GovernanceEventAggregateType = 'governance_request' | 'governance_evaluation' | 'enterprise_lifecycle' | 'enterprise_module';

/** One appended Enterprise event. Evaluation events are embedded in the evaluation aggregate (same transaction); lifecycle/module events are appended standalone and link by correlation, never by foreign key. */
export interface GovernanceEventRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: GovernanceEventAggregateType;
  readonly aggregateId: string;

  /** Denormalized reference columns preserved for the legacy `listEnterpriseEvents` surface and direct querying. */
  readonly requestId?: string;
  readonly decisionId?: string;

  readonly correlationId?: string;
  readonly causationId?: string;

  readonly sequence?: number;

  readonly occurredAt: string;
  readonly persistedAt: string;

  readonly enterpriseVersion: string;
  readonly kernelVersion?: string;

  readonly eventContract: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;

  readonly eventDigest: string;
}

/** Bounded snapshot of one Enterprise module at evaluation time. */
export interface GovernanceModuleSnapshot {
  readonly moduleId: string;
  readonly version: string;
  readonly state: string;
  readonly required: boolean;
}

/** Bounded snapshot of one provider at evaluation time — type/identifier/version/readiness only, never configuration or credentials. */
export interface GovernanceProviderSnapshot {
  readonly providerType: string;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly ready: boolean;
}

/** Reconstruction metadata for one evaluation aggregate: what was running, in what state, when the decision was recorded. */
export interface GovernanceRecordMetadata {
  readonly metadataId: string;
  readonly evaluationId: string;

  readonly enterpriseVersion: string;
  readonly kernelVersion: string;

  readonly lifecycleState: string;

  readonly moduleSnapshot: readonly GovernanceModuleSnapshot[];
  readonly providerSnapshot?: readonly GovernanceProviderSnapshot[];

  readonly environment?: string;
  readonly buildVersion?: string;

  readonly createdAt: string;

  readonly schemaVersion: string;

  /** Present only on aggregates migrated from an earlier schema (`GOVERNANCE_MIGRATION_SOURCE_PR_002`). Absent on live appends. */
  readonly migrationSource?: string;
}

/**
 * Integrity metadata for one evaluation aggregate. SHA-256 over
 * `aoc.canonical-json.v1` serialization. This detects post-commit
 * modification of stored records; it is NOT a digital signature, NOT
 * non-repudiation, and NOT protection against a privileged writer who can
 * rewrite records and digests together — see the Governance Store
 * documentation's "Integrity model and its limits".
 */
export interface GovernanceIntegrityMetadata {
  readonly integrityId: string;
  readonly evaluationId: string;

  readonly algorithm: 'sha256';
  readonly canonicalizationVersion: string;

  readonly requestDigest: string;
  readonly evaluationDigest: string;
  readonly traceDigest: string;
  readonly eventsDigest: string;
  readonly metadataDigest: string;

  readonly aggregateDigest: string;

  /** Store-scoped append chain: the `aggregateDigest` of the previously committed aggregate in this store. Absent on the first aggregate. */
  readonly previousAggregateDigest?: string;

  /** Monotonic position of this aggregate in the store-scoped chain (1-based). Provides the stable pagination/chain order. */
  readonly chainPosition: number;

  readonly createdAt: string;
}

/**
 * The canonical reference vocabulary, as runtime values. The union on
 * `GovernanceReferenceRecord.referenceType` is derived from this list so the
 * type and the value that reaches storage can never drift apart.
 *
 * `authorization_artifact` names *what Soberanía authorized*;
 * `execution_record` and `external_artifact` name *what someone else then
 * did about it*. Keeping those apart is the point of the vocabulary — see
 * `docs/enterprise/AOC_GOVERNANCE_RECORD_MODEL.md`, "Reference vocabulary".
 *
 * - `passport_event` — an Agent Passport lifecycle event.
 * - `evidence_bundle` — an Evidence Bundle built over this evaluation.
 * - `assurance_record` — an Assurance assessment/finding artifact.
 * - `execution_record` — a report of an external system acting on an
 *   authorization Soberanía issued (token issuance, collateral filing, release).
 * - `external_artifact` — an artifact originating *outside* the Soberanía
 *   authorization machinery, referenced as evidence or context.
 * - `authorization_artifact` — a durable artifact produced by Soberanía Enterprise
 *   that records or embodies authorization resulting from a governed
 *   enforcement decision (`TokenizationMandate`, `CollateralizationMandate`,
 *   `LicenseMandate`, `TransferMandate`).
 * - `reconsideration_link` — LAND-01: this evaluation is an explicit,
 *   linked reconsideration of an earlier withheld governed action (the
 *   `externalId`), evaluated afresh after governance state changed. Also used
 *   for the at-most-once marker that one original was realized. Evidence of
 *   lineage only: it carries no authority and nothing inherits a decision
 *   through it.
 * - `issuance_record` — LAND-02: authority issuance was evaluated for
 *   this committed decision and **withheld** (layer, reason codes, the
 *   requested amount and, for the financial layer, the ceiling compared
 *   against). Evidence of a result the issuance core already reached; it is
 *   never read to decide anything.
 *
 * **A reference type is evidence classification, never authority.** Nothing
 * in the runtime reads `referenceType` to decide anything; appending one
 * grants no rights. See "Authorization artifact trust boundary" in the
 * Governance Store documentation.
 */
export const GOVERNANCE_REFERENCE_TYPES = [
  'passport_event',
  'evidence_bundle',
  'assurance_record',
  'execution_record',
  'external_artifact',
  'authorization_artifact',
  'reconsideration_link',
  'issuance_record',
] as const;

export type GovernanceReferenceType = (typeof GOVERNANCE_REFERENCE_TYPES)[number];

/**
 * True when `value` is a reference type this build knows. Used to reject
 * unknown values on *write*; reads stay deliberately permissive so records
 * written by a newer runtime, and history written by an older one, both stay
 * readable. See "Reference vocabulary compatibility" in the Governance Store
 * documentation.
 */
export function isCanonicalGovernanceReferenceType(value: string): value is GovernanceReferenceType {
  return (GOVERNANCE_REFERENCE_TYPES as readonly string[]).includes(value);
}

/**
 * A reference from a governance evaluation to a
 * Passport/Evidence/Assurance/execution/authorization artifact. The Store
 * only preserves references; it never interprets them as authority.
 *
 * The four integrity fields are **computed and owned by the Store**, exactly
 * as aggregate digests are: callers pass a `GovernanceReferenceInput` and the
 * Store seals it on append. They are optional because reference rows written
 * before reference integrity existed genuinely do not have them — see
 * `GovernanceReferenceIntegrityStatus`.
 *
 * `digest` and `referenceDigest` are different things and must not be
 * confused: `digest` is the *referenced artifact's own* content digest,
 * supplied by the caller and never verified by the Store; `referenceDigest`
 * is the Store's tamper-evidence digest over this reference row.
 */
export interface GovernanceReferenceRecord {
  readonly referenceId: string;
  readonly evaluationId: string;

  readonly referenceType: GovernanceReferenceType;

  readonly externalId: string;
  readonly externalVersion?: string;

  readonly digest?: string;
  readonly uri?: string;

  readonly createdAt: string;

  /** Position in this evaluation's protected reference chain (1-based). Absent on legacy-unprotected rows. */
  readonly sequence?: number;
  /** The reference-integrity format this row was sealed under (`GOVERNANCE_REFERENCE_INTEGRITY_VERSION` for rows this build wrote). Absent on legacy-unprotected rows. */
  readonly integrityVersion?: string;
  /** The `referenceDigest` of the preceding protected reference on the same evaluation. Absent on the first protected reference and on legacy-unprotected rows. */
  readonly previousReferenceDigest?: string;
  /** Tamper-evidence digest over this reference row. Absent on legacy-unprotected rows. */
  readonly referenceDigest?: string;
}

/**
 * What a caller supplies to `appendReference`. The integrity fields are
 * deliberately absent: the Store computes `sequence`, `integrityVersion`,
 * `previousReferenceDigest`, and `referenceDigest` inside the append
 * transaction, so a caller can neither choose its own chain position nor
 * present a digest the Store did not compute.
 */
export type GovernanceReferenceInput = Omit<GovernanceReferenceRecord, 'sequence' | 'integrityVersion' | 'previousReferenceDigest' | 'referenceDigest'>;

/**
 * How one persisted reference row stands against the reference-integrity
 * mechanism. The classification is deliberately four-valued, because
 * collapsing any pair of these would mean claiming something untrue:
 *
 * - `legacy_unprotected` — the row carries *no* integrity metadata at all.
 *   It predates the mechanism (or was written by a runtime without it). It
 *   is readable and historically truthful, and it is **not** evidence that
 *   the row is unchanged. Never reported as a failure.
 * - `protected_valid` — sealed under a version this build knows, and its
 *   digest and chain linkage recompute correctly.
 * - `protected_corrupted` — claims protection under a known version but does
 *   not verify: mismatched digest, broken linkage, malformed digest, or
 *   partial integrity metadata. Always a failure; never downgraded to
 *   `legacy_unprotected`.
 * - `protected_unsupported_version` — claims protection under a version this
 *   build cannot verify. Not corruption (the row may be perfectly intact)
 *   and not legacy (it claims protection), so it fails closed as
 *   unverifiable rather than being guessed at either way.
 */
export type GovernanceReferenceIntegrityStatus = 'legacy_unprotected' | 'protected_valid' | 'protected_corrupted' | 'protected_unsupported_version';

/** Per-status counts of an aggregate's reference rows. Present on every verification result; all zeros when the aggregate has no references. */
export interface GovernanceReferenceIntegritySummary {
  readonly legacyUnprotected: number;
  readonly protectedValid: number;
  readonly protectedCorrupted: number;
  readonly protectedUnsupportedVersion: number;
}

/**
 * The stored head of one evaluation's protected reference chain. Mirrors the
 * Agent Passport Store's `latest_sequence`/`latest_event_digest` projection.
 * Its purpose is tail-deletion detection: without a stored head, removing the
 * newest protected references leaves a shorter but internally consistent
 * chain.
 */
export interface GovernanceReferenceChainState {
  readonly evaluationId: string;
  readonly integrityVersion: string;
  readonly latestSequence: number;
  readonly latestReferenceDigest: string;
  readonly updatedAt: string;
}

/**
 * Reserved append-only correction/supersession contract (mission section
 * 72). No correction API exists in v1 — the type is reserved so future
 * corrections are modeled as appended records, never as updates.
 */
export interface GovernanceCorrectionRecord {
  readonly correctionId: string;
  readonly evaluationId: string;
  readonly correctionType: 'metadata_correction' | 'classification_correction' | 'redaction' | 'supersession';

  readonly reason: string;
  readonly correctedBy: string;
  readonly createdAt: string;

  readonly replacementEvaluationId?: string;
}

/** The full reconstruction aggregate for one governance evaluation. A read model — not stored as one row. */
export interface GovernanceRecord {
  readonly recordId: string;
  readonly request: GovernanceRequestRecord;
  readonly evaluation: GovernanceEvaluationRecord;
  readonly trace: readonly GovernanceTraceRecord[];
  readonly reasons: readonly GovernanceReasonRecord[];
  readonly events: readonly GovernanceEventRecord[];
  readonly metadata: GovernanceRecordMetadata;
  readonly integrity: GovernanceIntegrityMetadata;
  readonly references: readonly GovernanceReferenceRecord[];
}

/** Metadata a future deterministic re-evaluation would need. Derived from the stored aggregate — see `toGovernanceReplayMetadata`. Re-evaluation itself is NOT implemented and is not claimed to be deterministic until every dependency is versioned and recoverable. */
export interface GovernanceReplayMetadata {
  readonly requestContract: string;
  readonly evaluationContract: string;
  readonly kernelVersion: string;
  readonly enterpriseVersion: string;
  readonly providerVersions: readonly string[];
}

// ---------------------------------------------------------------------------
// Access, idempotency, append, query, verification
// ---------------------------------------------------------------------------

/**
 * The authorization scope the Enterprise Host resolved for a Store call.
 * The Store does not authenticate anyone; it *enforces* the scope it is
 * handed: `system: true` reads across organizations, otherwise
 * `organizationId` is required and bounds every read.
 */
export interface GovernanceStoreAccessContext {
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly system: boolean;
}

/** Caller-supplied idempotency key plus the tenant scope it is unique within. Scope always includes organization context (or the explicit global scope for unscoped requests) so one tenant's key can never collide with another's. */
export interface GovernanceIdempotencyContext {
  readonly idempotencyKey: string;
  readonly scope: string;
}

/** Durable idempotency claim: `(scope, idempotencyKey)` is unique; `requestDigest` distinguishes an idempotent replay from a conflicting reuse. */
export interface GovernanceIdempotencyRecord {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly evaluationId: string;
  readonly createdAt: string;
}

/** Input for pre-evaluation idempotency resolution — lets the Host skip re-running the Kernel for a known-idempotent request. */
export interface GovernanceIdempotencyProbe {
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly idempotency?: GovernanceIdempotencyContext;
}

export type GovernanceIdempotencyResolution =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly record: GovernanceRecord }
  | { readonly kind: 'conflict'; readonly conflictKind: 'idempotency-key' | 'request-id' };

/** The Enterprise context captured alongside one appended evaluation. */
export interface GovernanceEnterpriseContext {
  readonly enterpriseVersion: string;
  readonly lifecycleState: string;
  readonly modules: readonly EnterpriseModuleSnapshot[];
  readonly providers?: readonly GovernanceProviderSnapshot[];
  readonly buildVersion?: string;
  readonly environment?: string;
}

/**
 * Everything the Store needs to append one complete evaluation aggregate.
 * Callers never provide digests, record ids, or chain positions — the Store
 * computes all integrity metadata internally.
 */
export interface AppendGovernanceEvaluationInput {
  readonly request: KernelEvaluationRequest;
  readonly result: KernelEvaluationResult;

  readonly receivedAt: string;

  readonly enterpriseContext: GovernanceEnterpriseContext;

  readonly events: readonly EnterpriseEvent[];

  readonly idempotency?: GovernanceIdempotencyContext;

  readonly accessContext: GovernanceStoreAccessContext;
}

export interface AppendGovernanceEvaluationResult {
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;

  /** True when this call durably committed a new aggregate. */
  readonly created: boolean;
  /** True when an equivalent aggregate already existed and was returned instead of re-persisting. */
  readonly idempotentReplay: boolean;

  readonly aggregateDigest: string;
  readonly persistedAt: string;

  /** Present when `idempotentReplay` — the previously stored aggregate, so callers can rebuild the original response without re-evaluating. */
  readonly existingRecord?: GovernanceRecord;
}

/** Bounded query surface. Filters are ANDed; time bounds are inclusive against `evaluatedAt`. Never arbitrary SQL. */
export interface GovernanceStoreQuery {
  readonly requestId?: string;
  readonly evaluationId?: string;
  readonly decisionId?: string;
  readonly correlationId?: string;
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly actionType?: string;
  readonly status?: KernelDecisionStatus;
  readonly reasonCode?: string;
  /** PROD-03-01 — narrows to records carrying one shape of governed-path evidence. See `GOVERNANCE_GOVERNED_PATH_FILTERS`. */
  readonly governedPath?: GovernanceGovernedPathFilter;

  readonly from?: string;
  readonly to?: string;

  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * PROD-03-01 — read-only filters over the governed-path evidence rows a record
 * already carries (`governed-action/execution-ledger.ts` writes them). They
 * select records for an operator to look at; nothing reads them to decide
 * anything, and the canonical answer for a selected record is still its
 * ASSURE-01 trace.
 *
 * - `execution-claimed` — the record holds a write-ahead execution claim
 *   (`execution_record`, `externalVersion: 'attempt'`).
 * - `execution-open` — it holds a claim with no **definitive** outcome row for
 *   the same execution id: no row that decodes, in the execution ledger's own grammar, as
 *   executed, failed, withheld at exercise or resolved
 *   (`isDefinitiveExecutionEvidence`); a malformed row is not definitive. A superset of the
 *   executions whose trace is unresolved: a definitive row is written only
 *   after the canonical record it summarizes committed.
 * - `issuance-withheld` — the record holds a LAND-02 `issuance_record` row.
 * - `governed-action` — the record came through the governed-action path: it
 *   holds that path's own idempotency claim, whose scope and key derive its
 *   request id (`isGovernedActionIdempotencyClaim`). A record of the evaluate
 *   route never does, whatever request id its caller chose.
 */
export const GOVERNANCE_GOVERNED_PATH_FILTERS = ['execution-claimed', 'execution-open', 'issuance-withheld', 'governed-action'] as const;

export type GovernanceGovernedPathFilter = (typeof GOVERNANCE_GOVERNED_PATH_FILTERS)[number];

/** A count over the same filters as a query. No page: a count reads no record. */
export type GovernanceStoreCountQuery = Omit<GovernanceStoreQuery, 'limit' | 'cursor'>;

/** One query hit — a summary, not the full aggregate; use `getByEvaluationId` for reconstruction. */
export interface GovernanceRecordSummary {
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly organizationId?: string;
  readonly actorId: string;
  readonly actionType: string;
  readonly status: KernelDecisionStatus;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly persistedAt: string;
  readonly aggregateDigest: string;
}

export interface GovernanceStoreQueryResult {
  readonly records: readonly GovernanceRecordSummary[];
  /** Opaque cursor for the next page; absent when this page is the last. Ordering is `chainPosition DESC` (newest committed first) and is stable under concurrent appends. */
  readonly nextCursor?: string;
}

export interface GovernanceIntegrityFailure {
  readonly check: string;
  readonly message: string;
}

/**
 * The result of verifying one stored aggregate across **both** integrity
 * domains. They are separate on purpose and must stay separate:
 *
 * - *aggregate integrity* (`requestDigest`…`previousDigest`) protects the
 *   canonical governance decision record, sealed at commit;
 * - *reference integrity* (`referenceIntegrity`) protects the append-only
 *   linkage from that record to authorization artifacts and external
 *   evidence, which are appended afterwards and therefore cannot be inside
 *   the aggregate digest.
 *
 * See `docs/architecture/ADR-GOVERNANCE-REFERENCE-INTEGRITY.md`.
 */
export interface GovernanceRecordVerificationResult {
  readonly evaluationId: string;
  readonly valid: boolean;

  readonly checks: {
    readonly requestDigest: boolean;
    readonly evaluationDigest: boolean;
    readonly traceDigest: boolean;
    readonly eventsDigest: boolean;
    readonly metadataDigest: boolean;
    readonly aggregateDigest: boolean;
    readonly previousDigest?: boolean;
    /** True when no reference row failed reference-integrity verification. Legacy-unprotected rows never make this false — they were never protected, and saying otherwise would report a historical fact as a fault. */
    readonly referenceIntegrity: boolean;
  };

  readonly verifiedAt: string;

  readonly failures: readonly GovernanceIntegrityFailure[];

  /** Per-status counts of this aggregate's reference rows, so a caller can tell "nothing protected" apart from "everything protected and valid" without inspecting each row. */
  readonly referenceIntegrity: GovernanceReferenceIntegritySummary;
}

/** Structured result of loading an aggregate: complete, or explicitly incomplete/corrupted with the missing pieces named. Partial data is never silently returned as complete. */
export interface GovernanceRecordLoadResult {
  readonly status: 'complete' | 'incomplete' | 'corrupted';
  readonly record?: GovernanceRecord;
  readonly missingComponents: readonly string[];
  readonly integrityFailures: readonly string[];
}

export interface GovernanceStoreHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly writable: boolean;
  readonly readable: boolean;
  readonly schemaVersion: string;
  readonly migrationState: string;
  readonly checkedAt: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Derives the replay-preparation metadata (mission section 30) from a stored aggregate. Values are only ever read from what was actually persisted. */
export function toGovernanceReplayMetadata(record: GovernanceRecord): GovernanceReplayMetadata {
  const providerVersions = (record.metadata.providerSnapshot ?? [])
    .filter((provider) => provider.providerVersion !== undefined)
    .map((provider) => `${provider.providerType}@${provider.providerVersion ?? ''}`);
  return {
    requestContract: record.request.requestContract,
    evaluationContract: record.evaluation.evaluationContract,
    kernelVersion: record.evaluation.kernelVersion,
    enterpriseVersion: record.evaluation.enterpriseVersion,
    providerVersions,
  };
}
