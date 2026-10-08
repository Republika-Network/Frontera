import type { KernelEvaluationResult, KernelTrace, KernelTraceStep, KernelTraceStepStatus } from '../../kernel/index.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import type { EnterpriseEventRecord } from './governance-store.js';
import { GovernanceStoreError } from './errors.js';
import { computeDigest } from './digest.js';
import { redactSensitiveValues } from './redaction.js';
import { eventRecordDigestInput } from './projection.js';
import { isDefinitiveExecutionSummary } from '../governed-action/execution-summary.js';
import { isGovernedActionIdempotencyClaim } from '../governed-action/identifiers.js';
import { GOVERNANCE_REFERENCE_TYPES, GOVERNANCE_STORE_CONTRACT_IDS, isCanonicalGovernanceReferenceType, type GovernanceEventRecord, type GovernanceRecord, type GovernanceRecordSummary, type GovernanceGovernedPathFilter, type GovernanceIdempotencyRecord, type GovernanceStoreAccessContext, type GovernanceStoreQuery } from './contracts.js';

/**
 * Provider-independent Governance Store semantics: access-scope
 * enforcement, cursor encoding, query normalization, summaries, and
 * record→Kernel-shape rehydration. Both store implementations use exactly
 * these helpers so tenant isolation and pagination can never drift between
 * providers.
 */

export const GOVERNANCE_QUERY_DEFAULT_LIMIT = 50;
export const GOVERNANCE_QUERY_MAX_LIMIT = 200;

/** Non-system callers must present an organization scope for every read. */
export function requireReadScope(context: GovernanceStoreAccessContext): void {
  if (!context.system && (context.organizationId === undefined || context.organizationId.length === 0)) {
    throw new GovernanceStoreError('GOVERNANCE_TENANT_SCOPE_REQUIRED', 'A non-system caller must provide an organization scope for Governance Store reads.');
  }
}

/** Visibility rule: system sees everything; an organization-scoped caller sees only its own records. Records without an organization are system-level and invisible to tenant callers. */
export function canSeeRecord(context: GovernanceStoreAccessContext, recordOrganizationId: string | undefined): boolean {
  if (context.system) return true;
  return recordOrganizationId !== undefined && recordOrganizationId === context.organizationId;
}

/** Resolves the effective organization filter for a query, rejecting cross-tenant filter attempts instead of silently widening scope. */
export function resolveQueryOrganization(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): string | undefined {
  requireReadScope(context);
  if (context.system) return query.organizationId;
  if (query.organizationId !== undefined && query.organizationId !== context.organizationId) {
    throw new GovernanceStoreError('GOVERNANCE_ACCESS_SCOPE_VIOLATION', 'An organization-scoped caller may only query its own organization.');
  }
  return context.organizationId;
}

export function normalizeQueryLimit(limit: number | undefined): number {
  if (limit === undefined) return GOVERNANCE_QUERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > GOVERNANCE_QUERY_MAX_LIMIT) {
    throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', `Query limit must be an integer between 1 and ${GOVERNANCE_QUERY_MAX_LIMIT}.`);
  }
  return limit;
}

/** Opaque cursor: base64url of the chain position the previous page ended on. Ordering is `chainPosition DESC`, stable under concurrent appends. */
export function encodeQueryCursor(chainPosition: number): string {
  return Buffer.from(JSON.stringify({ p: chainPosition }), 'utf8').toString('base64url');
}

export function decodeQueryCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { p?: unknown };
    if (typeof parsed.p === 'number' && Number.isInteger(parsed.p) && parsed.p > 0) return parsed.p;
  } catch {
    // fall through to the structured error below
  }
  throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', 'The query cursor is not a cursor this store issued.');
}

/**
 * Write-path guard for the reference vocabulary. Both store implementations
 * call this before persisting, so an unknown string can never be stored and
 * later cast back as though it were a classification this build recognizes —
 * which matters most for `authorization_artifact`, the one value that reads
 * as "Soberanía authorized this".
 *
 * This is deliberately **write-only**. The read path stays permissive: a
 * value written by a newer runtime, or historical rows written before a
 * value was added, must remain readable rather than turning a stored
 * aggregate into a corruption error. See the Governance Store
 * documentation, "Reference vocabulary compatibility".
 */
export function assertCanonicalReferenceType(referenceType: string): void {
  if (!isCanonicalGovernanceReferenceType(referenceType)) {
    throw new GovernanceStoreError(
      'GOVERNANCE_STORE_VALIDATION_ERROR',
      `referenceType '${referenceType}' is not a canonical Governance Store reference type; expected one of ${GOVERNANCE_REFERENCE_TYPES.join(', ')}.`,
    );
  }
}

export function toGovernanceRecordSummary(record: GovernanceRecord): GovernanceRecordSummary {
  return {
    evaluationId: record.evaluation.evaluationId,
    decisionId: record.evaluation.decisionId,
    requestId: record.evaluation.requestId,
    ...(record.evaluation.correlationId !== undefined ? { correlationId: record.evaluation.correlationId } : {}),
    ...(record.request.organizationId !== undefined ? { organizationId: record.request.organizationId } : {}),
    actorId: record.request.actorId,
    actionType: record.request.actionType,
    status: record.evaluation.status,
    reasonCodes: record.evaluation.reasonCodes,
    evaluatedAt: record.evaluation.evaluatedAt,
    persistedAt: record.evaluation.persistedAt,
    aggregateDigest: record.integrity.aggregateDigest,
  };
}

/** In-memory query predicate; the SQLite implementation mirrors these exact semantics in SQL (time bounds are inclusive against `evaluatedAt`). */
export function matchesQueryFilters(record: GovernanceRecord, query: GovernanceStoreQuery, organizationId: string | undefined, idempotencyClaim?: GovernanceIdempotencyRecord): boolean {
  if (organizationId !== undefined && record.request.organizationId !== organizationId) return false;
  if (query.requestId !== undefined && record.evaluation.requestId !== query.requestId) return false;
  if (query.evaluationId !== undefined && record.evaluation.evaluationId !== query.evaluationId) return false;
  if (query.decisionId !== undefined && record.evaluation.decisionId !== query.decisionId) return false;
  if (query.correlationId !== undefined && record.evaluation.correlationId !== query.correlationId) return false;
  if (query.actorId !== undefined && record.request.actorId !== query.actorId) return false;
  if (query.actionType !== undefined && record.request.actionType !== query.actionType) return false;
  if (query.status !== undefined && record.evaluation.status !== query.status) return false;
  if (query.reasonCode !== undefined && !record.evaluation.reasonCodes.includes(query.reasonCode)) return false;
  if (query.governedPath !== undefined && !matchesGovernedPath(record, query.governedPath, idempotencyClaim)) return false;
  if (query.from !== undefined && record.evaluation.evaluatedAt < query.from) return false;
  if (query.to !== undefined && record.evaluation.evaluatedAt > query.to) return false;
  return true;
}

/** Reassembles the original `KernelTrace` from the normalized step records (order restored by `sequence`). */
export function toKernelTrace(record: GovernanceRecord): KernelTrace {
  const steps: KernelTraceStep[] = [...record.trace]
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => ({
      sequence: step.sequence,
      operator: step.operator,
      status: step.status as KernelTraceStepStatus,
      reasonCodes: step.reasonCodes,
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
      ...(step.metadata !== undefined ? { metadata: step.metadata } : {}),
    }));
  return { steps, decisionId: record.evaluation.decisionId, kernelVersion: record.evaluation.kernelVersion };
}

/**
 * Rehydrates the sanitized `KernelEvaluationResult` from a stored aggregate
 * (result payload + normalized trace) so an idempotent replay can answer
 * with the originally persisted decision without re-running the Kernel.
 * This is historical reconstruction of the persisted projection — statuses,
 * reason codes, identifiers, and timestamps are the stored originals.
 */
export function toKernelEvaluationResult(record: GovernanceRecord): KernelEvaluationResult {
  const payload = record.evaluation.resultPayload as unknown as Omit<KernelEvaluationResult, 'trace'>;
  return { ...payload, trace: toKernelTrace(record) };
}

/** Maps an `EnterpriseLifecycleEvent`-or-governance `EnterpriseEvent` published outside an evaluation aggregate onto the durable event record shape. */
export function toStandaloneEventRecord(
  event: EnterpriseEvent,
  deps: { readonly now: () => string; readonly enterpriseVersion: string; readonly sequence: number },
): GovernanceEventRecord {
  const persistedAt = deps.now();
  if ('lifecycleCorrelationId' in event) {
    const { eventId, type, occurredAt, enterpriseVersion, lifecycleCorrelationId, moduleId, ...payloadFields } = event;
    const withoutDigest: Omit<GovernanceEventRecord, 'eventDigest'> = {
      eventId,
      eventType: type,
      aggregateType: moduleId !== undefined ? 'enterprise_module' : 'enterprise_lifecycle',
      aggregateId: moduleId ?? lifecycleCorrelationId,
      correlationId: lifecycleCorrelationId,
      sequence: deps.sequence,
      occurredAt,
      persistedAt,
      enterpriseVersion,
      eventContract: GOVERNANCE_STORE_CONTRACT_IDS.eventRecord,
      eventPayload: redactSensitiveValues({ ...payloadFields, ...(moduleId !== undefined ? { moduleId } : {}) }) as Readonly<Record<string, unknown>>,
    };
    return { ...withoutDigest, eventDigest: computeDigest(eventRecordDigestInput(withoutDigest)) };
  }

  const { eventId, type, occurredAt, requestId, correlationId, ...payloadFields } = event;
  const decisionId = 'decisionId' in payloadFields ? (payloadFields as { decisionId?: string }).decisionId : undefined;
  const withoutDigest: Omit<GovernanceEventRecord, 'eventDigest'> = {
    eventId,
    eventType: type,
    aggregateType: 'governance_request',
    aggregateId: requestId,
    requestId,
    ...(decisionId !== undefined ? { decisionId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    sequence: deps.sequence,
    occurredAt,
    persistedAt,
    enterpriseVersion: deps.enterpriseVersion,
    eventContract: GOVERNANCE_STORE_CONTRACT_IDS.eventRecord,
    eventPayload: redactSensitiveValues({ ...payloadFields }) as Readonly<Record<string, unknown>>,
  };
  return { ...withoutDigest, eventDigest: computeDigest(eventRecordDigestInput(withoutDigest)) };
}

/** Maps a legacy PR-002 `EnterpriseEventRecord` onto the durable v1 event record shape. */
export function legacyEventToRecord(
  legacy: EnterpriseEventRecord,
  deps: { readonly now: () => string; readonly enterpriseVersion: string; readonly sequence: number },
): GovernanceEventRecord {
  const withoutDigest: Omit<GovernanceEventRecord, 'eventDigest'> = {
    eventId: legacy.eventId,
    eventType: legacy.eventType,
    aggregateType: 'governance_request',
    aggregateId: legacy.requestId,
    requestId: legacy.requestId,
    ...(legacy.decisionId !== undefined ? { decisionId: legacy.decisionId } : {}),
    ...(legacy.correlationId !== undefined ? { correlationId: legacy.correlationId } : {}),
    sequence: deps.sequence,
    occurredAt: legacy.occurredAt,
    persistedAt: deps.now(),
    enterpriseVersion: deps.enterpriseVersion,
    eventContract: GOVERNANCE_STORE_CONTRACT_IDS.eventRecord,
    eventPayload: redactSensitiveValues({ ...legacy.payload }) as Readonly<Record<string, unknown>>,
  };
  return { ...withoutDigest, eventDigest: computeDigest(eventRecordDigestInput(withoutDigest)) };
}

/** Maps a durable event record back onto the legacy read shape (only events carrying a requestId are visible through the legacy surface). */
export function recordToLegacyEvent(record: GovernanceEventRecord): EnterpriseEventRecord | undefined {
  if (record.requestId === undefined) return undefined;
  return {
    eventId: record.eventId,
    eventType: record.eventType,
    requestId: record.requestId,
    ...(record.decisionId !== undefined ? { decisionId: record.decisionId } : {}),
    ...(record.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
    occurredAt: record.occurredAt,
    payload: record.eventPayload,
  };
}

/** Deep-freezes a value graph so in-memory "persisted" records are logically immutable after commit. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * PROD-03-01 — whether an `execution_record` row's recorded form states a
 * definitive answer for its execution, decoded by the execution ledger's own
 * grammar (`governed-action/execution-summary.ts`): an effect that completed,
 * did not complete, was withheld at exercise, or was resolved by P12 — each
 * only in a form the ledger writes. The write-ahead claim (`attempt`), the
 * adapter's own unconfirmed answer and every malformed row (`withheld:` with
 * no decodable reason, `resolved:` with no known certainty, …) are not, so a
 * corrupt row keeps its claim open for the trace to classify. Selection only —
 * the SQLite provider calls this same function from SQL — and never a reading
 * of what happened: that is the trace's.
 */
export function isDefinitiveExecutionEvidence(externalVersion: string | undefined): boolean {
  return isDefinitiveExecutionSummary(externalVersion);
}

/**
 * PROD-03-01 — whether a record came through the governed-action path: it
 * holds that path's own idempotency claim for its request id
 * (`isGovernedActionIdempotencyClaim`). The SQLite provider calls this same
 * function from SQL.
 */
export function isGovernedActionClaimFor(organizationId: string | undefined, requestId: string, scope: string, idempotencyKey: string): boolean {
  return isGovernedActionIdempotencyClaim({ organizationId, requestId, scope, idempotencyKey });
}

/** The in-memory form of `GovernanceStoreQuery.governedPath`; the SQLite provider mirrors it in SQL. `idempotencyClaim`: the record's own idempotency claim, if it holds one. */
export function matchesGovernedPath(record: GovernanceRecord, filter: GovernanceGovernedPathFilter, idempotencyClaim?: GovernanceIdempotencyRecord): boolean {
  if (filter === 'governed-action') return idempotencyClaim !== undefined && isGovernedActionClaimFor(record.request.organizationId, record.evaluation.requestId, idempotencyClaim.scope, idempotencyClaim.idempotencyKey);
  if (filter === 'issuance-withheld') return record.references.some((entry) => entry.referenceType === 'issuance_record');
  const executionRows = record.references.filter((entry) => entry.referenceType === 'execution_record');
  const claims = executionRows.filter((entry) => entry.externalVersion === 'attempt');
  if (filter === 'execution-claimed') return claims.length > 0;
  return claims.some((claim) => !executionRows.some((entry) => entry.externalId === claim.externalId && isDefinitiveExecutionEvidence(entry.externalVersion)));
}
