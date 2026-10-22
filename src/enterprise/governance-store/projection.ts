import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import { computeDigest } from './digest.js';
import { canonicalSerialize } from './canonical-json.js';
import { redactSensitiveValues } from './redaction.js';
import { GovernanceStoreError } from './errors.js';
import { assertAttributionMatchesRequest, attributionEventPayload } from './attribution.js';
import {
  GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
  GOVERNANCE_STORE_CONTRACT_IDS,
  GOVERNANCE_STORE_SCHEMA_VERSION,
  type AppendGovernanceEvaluationInput,
  type GovernanceEventRecord,
  type GovernanceEvaluationRecord,
  type GovernanceIntegrityMetadata,
  type GovernanceReasonRecord,
  type GovernanceRecord,
  type GovernanceRecordMetadata,
  type GovernanceRequestRecord,
  type GovernanceTraceRecord,
} from './contracts.js';

/**
 * The Governance Store's persistence projection (mission sections 36-38):
 * the one place that turns a live Kernel request/result plus Enterprise
 * context into the sanitized, size-bounded, digest-carrying records that
 * are actually persisted. Both store implementations call this — the
 * projection, redaction, limits, and integrity computation can never drift
 * between providers.
 */

/** Enforced persistence limits. Every field here is validated at store construction and actually enforced on append — no decorative configuration. */
export interface GovernanceStoreLimits {
  readonly maxRequestPayloadBytes: number;
  readonly maxResultPayloadBytes: number;
  readonly maxEventPayloadBytes: number;
  readonly maxTraceSteps: number;
}

export const DEFAULT_GOVERNANCE_STORE_LIMITS: GovernanceStoreLimits = {
  maxRequestPayloadBytes: 262_144, // 256 KiB
  maxResultPayloadBytes: 524_288, // 512 KiB
  maxEventPayloadBytes: 65_536, // 64 KiB
  maxTraceSteps: 500,
};

export function validateGovernanceStoreLimits(limits: GovernanceStoreLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', `Governance Store limit '${key}' must be a positive integer; received ${String(value)}.`);
    }
  }
}

/** Deterministic clock/id dependencies, injected so tests control every Store-generated timestamp and identifier. */
export interface GovernanceProjectionDependencies {
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  readonly limits: GovernanceStoreLimits;
}

/** All records of one evaluation aggregate, ready for a single-transaction commit. */
export interface GovernanceAggregate {
  readonly record: GovernanceRecord;
  readonly payloadDigest: string;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalSerialize(value), 'utf8');
}

/**
 * Sanitized persistence projection of the normalized Kernel request. Applied
 * before digesting — the digest attests to what is persisted, never to
 * undisclosed raw secrets.
 */
export function projectRequestPayload(request: KernelEvaluationRequest): Readonly<Record<string, unknown>> {
  return redactSensitiveValues({ ...request }) as Readonly<Record<string, unknown>>;
}

/**
 * The digest used for idempotency comparison ("same normalized request?").
 * Computed over the sanitized projection so it is identical whether computed
 * pre-evaluation (idempotency probe) or at append time.
 */
export function computeGovernanceRequestPayloadDigest(request: KernelEvaluationRequest): string {
  return computeDigest(projectRequestPayload(request));
}

/** Sanitized result projection. The trace is normalized into `GovernanceTraceRecord`s, so the stored result payload deliberately excludes it — reconstruction reassembles the full result from both. */
export function projectResultPayload(result: KernelEvaluationResult): Readonly<Record<string, unknown>> {
  const { trace: _trace, ...withoutTrace } = result;
  return redactSensitiveValues({ ...withoutTrace }) as Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Digest input definitions — the exact, documented recomputation contract.
// Verification recomputes from these same functions; nothing else defines
// what a digest covers.
// ---------------------------------------------------------------------------

/** `integrity.requestDigest` covers the complete request record, including its `payloadDigest` column. */
export function requestRecordDigestInput(record: GovernanceRequestRecord): Readonly<Record<string, unknown>> {
  return { ...record };
}

/** `integrity.evaluationDigest` covers the complete evaluation record, including its `resultDigest` column. */
export function evaluationRecordDigestInput(record: GovernanceEvaluationRecord): Readonly<Record<string, unknown>> {
  return { ...record };
}

/** Each step's own `traceDigest` covers the step record *minus* that digest field. */
export function traceStepDigestInput(record: Omit<GovernanceTraceRecord, 'traceDigest'>): Readonly<Record<string, unknown>> {
  const { ...rest } = record;
  return rest;
}

/** `integrity.traceDigest` covers the ordered array of complete step records (including each `traceDigest`). */
export function traceRecordsDigestInput(records: readonly GovernanceTraceRecord[]): readonly Readonly<Record<string, unknown>>[] {
  return [...records].sort((a, b) => a.sequence - b.sequence).map((record) => ({ ...record }));
}

/** Each event's own `eventDigest` covers the event record *minus* that digest field. */
export function eventRecordDigestInput(record: Omit<GovernanceEventRecord, 'eventDigest'>): Readonly<Record<string, unknown>> {
  const { ...rest } = record;
  return rest;
}

/** `integrity.eventsDigest` covers the ordered array of complete event records (including each `eventDigest`). */
export function eventRecordsDigestInput(records: readonly GovernanceEventRecord[]): readonly Readonly<Record<string, unknown>>[] {
  return [...records].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((record) => ({ ...record }));
}

/** `integrity.metadataDigest` covers the complete metadata record. */
export function metadataDigestInput(record: GovernanceRecordMetadata): Readonly<Record<string, unknown>> {
  return { ...record };
}

/** `integrity.aggregateDigest` covers the canonical object of the five component digests plus the previous chain digest (omitted entirely for the first aggregate). Mission section 54 — never ambiguous string concatenation. */
export function computeAggregateDigest(parts: {
  readonly requestDigest: string;
  readonly evaluationDigest: string;
  readonly traceDigest: string;
  readonly eventsDigest: string;
  readonly metadataDigest: string;
  readonly previousAggregateDigest?: string;
}): string {
  return computeDigest({
    requestDigest: parts.requestDigest,
    evaluationDigest: parts.evaluationDigest,
    traceDigest: parts.traceDigest,
    eventsDigest: parts.eventsDigest,
    metadataDigest: parts.metadataDigest,
    ...(parts.previousAggregateDigest !== undefined ? { previousAggregateDigest: parts.previousAggregateDigest } : {}),
  });
}

// ---------------------------------------------------------------------------
// Aggregate builder
// ---------------------------------------------------------------------------

function isReservedAttributionEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { readonly type?: unknown }).type === GOVERNANCE_ATTRIBUTION_EVENT_TYPE;
}

function validateAppendInput(input: AppendGovernanceEvaluationInput): void {
  const problems: string[] = [];
  if (typeof input.request?.requestId !== 'string' || input.request.requestId.length === 0) problems.push('request.requestId must be a non-empty string');
  if (typeof input.result?.decisionId !== 'string' || input.result.decisionId.length === 0) problems.push('result.decisionId must be a non-empty string');
  if (input.result?.requestId !== input.request?.requestId) problems.push('result.requestId must match request.requestId');
  if (typeof input.receivedAt !== 'string' || input.receivedAt.length === 0) problems.push('receivedAt must be a non-empty ISO timestamp');
  if (typeof input.enterpriseContext?.enterpriseVersion !== 'string') problems.push('enterpriseContext.enterpriseVersion is required');
  if (typeof input.enterpriseContext?.lifecycleState !== 'string') problems.push('enterpriseContext.lifecycleState is required');
  // G-01C: an attribution event is sealed only from the validated `attribution` field, never from a caller's event.
  if (Array.isArray(input.events) && input.events.some(isReservedAttributionEvent)) problems.push(`events must not carry a '${GOVERNANCE_ATTRIBUTION_EVENT_TYPE}' event`);
  if (problems.length > 0) {
    throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', `Invalid append input: ${problems.join('; ')}.`);
  }
  if (!input.accessContext.system && input.accessContext.organizationId !== input.request.organization?.id) {
    throw new GovernanceStoreError(
      'GOVERNANCE_ACCESS_SCOPE_VIOLATION',
      'A non-system caller may only append evaluations for its own organization scope.',
      { requestOrganizationId: input.request.organization?.id ?? null },
    );
  }
  if (input.attribution !== undefined) assertAttributionMatchesRequest(input.attribution, input.request);
}

interface EventEnvelopeFields {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly requestId?: string;
  readonly decisionId?: string;
  readonly correlationId?: string;
}

function toEvaluationEventRecord(
  event: EnterpriseEvent,
  index: number,
  causationId: string | undefined,
  evaluationId: string,
  enterpriseVersion: string,
  kernelVersion: string,
  persistedAt: string,
  limits: GovernanceStoreLimits,
): GovernanceEventRecord {
  const { eventId, type, occurredAt, requestId, decisionId, correlationId, ...payloadFields } = event as EventEnvelopeFields & Record<string, unknown>;
  const eventPayload = redactSensitiveValues(payloadFields) as Readonly<Record<string, unknown>>;

  if (byteLength(eventPayload) > limits.maxEventPayloadBytes) {
    throw new GovernanceStoreError('GOVERNANCE_EVENT_PAYLOAD_TOO_LARGE', `Event '${type}' payload exceeds the configured limit of ${limits.maxEventPayloadBytes} bytes.`, { eventType: type });
  }

  const withoutDigest: Omit<GovernanceEventRecord, 'eventDigest'> = {
    eventId,
    eventType: type,
    aggregateType: 'governance_evaluation',
    aggregateId: evaluationId,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(decisionId !== undefined ? { decisionId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(causationId !== undefined ? { causationId } : {}),
    sequence: index + 1,
    occurredAt,
    persistedAt,
    enterpriseVersion,
    kernelVersion,
    eventContract: GOVERNANCE_STORE_CONTRACT_IDS.eventRecord,
    eventPayload,
  };
  return { ...withoutDigest, eventDigest: computeDigest(eventRecordDigestInput(withoutDigest)) };
}

/**
 * Builds the complete, integrity-sealed aggregate for one evaluation.
 * Pure over its inputs: identical inputs (including the injected clock/id
 * values and chain state) produce identical records and digests. Callers —
 * the store implementations — commit the result atomically.
 */
export function buildGovernanceAggregate(
  input: AppendGovernanceEvaluationInput,
  deps: GovernanceProjectionDependencies,
  chain: { readonly previousAggregateDigest?: string; readonly chainPosition: number },
): GovernanceAggregate {
  validateAppendInput(input);
  const { request, result, enterpriseContext } = input;
  const persistedAt = deps.now();

  // -- request record --
  const requestPayload = projectRequestPayload(request);
  if (byteLength(requestPayload) > deps.limits.maxRequestPayloadBytes) {
    throw new GovernanceStoreError('GOVERNANCE_RECORD_TOO_LARGE', `Request payload exceeds the configured limit of ${deps.limits.maxRequestPayloadBytes} bytes.`, { requestId: request.requestId });
  }
  const payloadDigest = computeDigest(requestPayload);
  const requestRecord: GovernanceRequestRecord = {
    recordId: deps.nextId('gov-request-record'),
    requestId: request.requestId,
    ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    actorId: request.actor.id,
    ...(request.actor.type !== undefined ? { actorType: request.actor.type } : {}),
    ...(request.organization?.id !== undefined ? { organizationId: request.organization.id } : {}),
    actionType: request.action.type,
    ...(request.action.domain !== undefined ? { actionDomain: request.action.domain } : {}),
    resourceScope: request.action.resourceScope,
    ...(request.target?.type !== undefined ? { targetType: request.target.type } : {}),
    ...(request.target?.id !== undefined ? { targetId: request.target.id } : {}),
    requestedAt: request.requestedAt,
    receivedAt: input.receivedAt,
    requestContract: GOVERNANCE_STORE_CONTRACT_IDS.requestRecord,
    requestPayload,
    payloadDigest,
  };

  // -- evaluation record --
  const resultPayload = projectResultPayload(result);
  if (byteLength(resultPayload) > deps.limits.maxResultPayloadBytes) {
    throw new GovernanceStoreError('GOVERNANCE_RECORD_TOO_LARGE', `Result payload exceeds the configured limit of ${deps.limits.maxResultPayloadBytes} bytes.`, { requestId: request.requestId });
  }
  const evaluationId = deps.nextId('gov-evaluation');
  const evaluationRecord: GovernanceEvaluationRecord = {
    recordId: deps.nextId('gov-evaluation-record'),
    evaluationId,
    decisionId: result.decisionId,
    requestId: result.requestId,
    ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
    status: result.status,
    summary: result.summary,
    reasonCodes: [...result.reasonCodes],
    evaluatedAt: result.evaluatedAt,
    persistedAt,
    kernelVersion: result.kernelVersion,
    enterpriseVersion: enterpriseContext.enterpriseVersion,
    evaluationContract: GOVERNANCE_STORE_CONTRACT_IDS.evaluationRecord,
    resultPayload,
    resultDigest: computeDigest(resultPayload),
  };

  // -- trace records --
  if (result.trace.steps.length > deps.limits.maxTraceSteps) {
    throw new GovernanceStoreError('GOVERNANCE_TRACE_LIMIT_EXCEEDED', `Trace has ${result.trace.steps.length} steps; the configured limit is ${deps.limits.maxTraceSteps}.`, { requestId: request.requestId });
  }
  const seenSequences = new Set<number>();
  const traceRecords: GovernanceTraceRecord[] = result.trace.steps.map((step) => {
    if (seenSequences.has(step.sequence)) {
      throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', `Duplicate trace sequence ${step.sequence}; sequences must be unique within one evaluation.`, { requestId: request.requestId });
    }
    seenSequences.add(step.sequence);
    const sanitizedMetadata = step.metadata !== undefined ? (redactSensitiveValues({ ...step.metadata }) as Readonly<Record<string, unknown>>) : undefined;
    const withoutDigest: Omit<GovernanceTraceRecord, 'traceDigest'> = {
      traceRecordId: deps.nextId('gov-trace-record'),
      evaluationId,
      sequence: step.sequence,
      operator: step.operator,
      status: step.status,
      reasonCodes: [...step.reasonCodes],
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
      ...(sanitizedMetadata !== undefined ? { metadata: sanitizedMetadata } : {}),
      traceContract: GOVERNANCE_STORE_CONTRACT_IDS.traceRecord,
    };
    return { ...withoutDigest, traceDigest: computeDigest(traceStepDigestInput(withoutDigest)) };
  });

  // -- reason records (duplicates allowed: the Kernel's exact order is the truth being preserved) --
  const reasonRecords: GovernanceReasonRecord[] = result.reasonCodes.map((reasonCode, index) => ({
    reasonRecordId: deps.nextId('gov-reason-record'),
    evaluationId,
    sequence: index + 1,
    reasonCode,
  }));

  // -- event records (embedded in the aggregate; the Requested event, when present first, is the causation source for the rest) --
  const firstEvent = input.events[0];
  const causationSourceId = firstEvent !== undefined && firstEvent.type === 'GovernanceEvaluationRequested' ? firstEvent.eventId : undefined;
  const eventRecords: GovernanceEventRecord[] = input.events.map((event, index) =>
    toEvaluationEventRecord(
      event,
      index,
      index > 0 ? causationSourceId : undefined,
      evaluationId,
      enterpriseContext.enterpriseVersion,
      result.kernelVersion,
      persistedAt,
      deps.limits,
    ),
  );
  // G-01A: the attribution, sealed after the operational events. Store-only:
  // it carries no `requestId`, so the legacy `listEnterpriseEvents` surface
  // never lists it, and it is never handed to an event publisher.
  if (input.attribution !== undefined) {
    const withoutDigest: Omit<GovernanceEventRecord, 'eventDigest'> = {
      eventId: deps.nextId('gov-attribution-event'),
      eventType: GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
      aggregateType: 'governance_evaluation',
      aggregateId: evaluationId,
      ...(causationSourceId !== undefined ? { causationId: causationSourceId } : {}),
      sequence: eventRecords.length + 1,
      occurredAt: input.receivedAt,
      persistedAt,
      enterpriseVersion: enterpriseContext.enterpriseVersion,
      kernelVersion: result.kernelVersion,
      eventContract: GOVERNANCE_STORE_CONTRACT_IDS.eventRecord,
      eventPayload: attributionEventPayload(input.attribution),
    };
    eventRecords.push({ ...withoutDigest, eventDigest: computeDigest(eventRecordDigestInput(withoutDigest)) });
  }

  // -- metadata record --
  const metadataRecord: GovernanceRecordMetadata = {
    metadataId: deps.nextId('gov-metadata'),
    evaluationId,
    enterpriseVersion: enterpriseContext.enterpriseVersion,
    kernelVersion: result.kernelVersion,
    lifecycleState: enterpriseContext.lifecycleState,
    moduleSnapshot: enterpriseContext.modules.map((module) => ({
      moduleId: module.id,
      version: module.version,
      state: module.state,
      required: module.required,
    })),
    ...(enterpriseContext.providers !== undefined ? { providerSnapshot: enterpriseContext.providers.map((provider) => ({ ...provider })) } : {}),
    ...(enterpriseContext.environment !== undefined ? { environment: enterpriseContext.environment } : {}),
    ...(enterpriseContext.buildVersion !== undefined ? { buildVersion: enterpriseContext.buildVersion } : {}),
    createdAt: persistedAt,
    schemaVersion: GOVERNANCE_STORE_SCHEMA_VERSION,
  };

  // -- integrity --
  const requestDigest = computeDigest(requestRecordDigestInput(requestRecord));
  const evaluationDigest = computeDigest(evaluationRecordDigestInput(evaluationRecord));
  const traceDigest = computeDigest(traceRecordsDigestInput(traceRecords));
  const eventsDigest = computeDigest(eventRecordsDigestInput(eventRecords));
  const metadataDigestValue = computeDigest(metadataDigestInput(metadataRecord));
  const aggregateDigest = computeAggregateDigest({
    requestDigest,
    evaluationDigest,
    traceDigest,
    eventsDigest,
    metadataDigest: metadataDigestValue,
    ...(chain.previousAggregateDigest !== undefined ? { previousAggregateDigest: chain.previousAggregateDigest } : {}),
  });

  const integrity: GovernanceIntegrityMetadata = {
    integrityId: deps.nextId('gov-integrity'),
    evaluationId,
    algorithm: 'sha256',
    canonicalizationVersion: 'aoc.canonical-json.v1',
    requestDigest,
    evaluationDigest,
    traceDigest,
    eventsDigest,
    metadataDigest: metadataDigestValue,
    aggregateDigest,
    ...(chain.previousAggregateDigest !== undefined ? { previousAggregateDigest: chain.previousAggregateDigest } : {}),
    chainPosition: chain.chainPosition,
    createdAt: persistedAt,
  };

  return {
    record: {
      // The evaluation record is the aggregate root; its recordId names the aggregate.
      recordId: evaluationRecord.recordId,
      request: requestRecord,
      evaluation: evaluationRecord,
      trace: traceRecords,
      reasons: reasonRecords,
      events: eventRecords,
      metadata: metadataRecord,
      integrity,
      references: [],
    },
    payloadDigest,
  };
}
