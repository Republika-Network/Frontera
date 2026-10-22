import type { AocKernel, KernelClock, KernelIdGenerator, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelValidationError } from '../../kernel/index.js';
import {
  mapDecisionStatusToHttpStatus,
  toGovernanceEvaluateResponseBody,
  toKernelEvaluationOptions,
  toKernelEvaluationRequest,
  validateGovernanceEvaluateRequestBody,
  type GovernanceEvaluateResponseBody,
} from '../api/governance-evaluate-contract.js';
import { EnterpriseHttpError, EnterpriseHttpErrors, mapGovernanceStoreErrorToHttp } from '../api/enterprise-http-errors.js';
import type { EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import type { CustomerIdentityAdmissionService } from '../customer-identity/contracts.js';
import type { EnterpriseEvent, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent } from '../events/enterprise-events.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import type { GovernanceEnterpriseContext, GovernanceEvaluationAttribution, GovernanceIdempotencyContext, GovernanceRecord } from '../governance-store/contracts.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import type { EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { authenticateAdvisoryCaller, establishAdvisoryIdentity, mayReplayTo } from './advisory-identity.js';
import { buildGovernanceEvaluationOutcomeEvent } from './governance-evaluation-events.js';

/** Transport-level input to one evaluation call -- the not-yet-validated wire body plus the caller's auth header and optional `Idempotency-Key` header value. */
export interface EvaluateGovernanceRequestInput {
  readonly rawBody: unknown;
  readonly authorizationHeader?: string;
  /** Caller-supplied `Idempotency-Key` header (PR-004 section 44). Scoped to the authenticated organization context by the orchestrator; never trusted as globally unique on its own. */
  readonly idempotencyKey?: string;
}

export interface EvaluateGovernanceRequestDependencies {
  readonly kernel: AocKernel;
  readonly clock: KernelClock;
  /** Used only to fill in a caller-omitted `requestId` on the `KernelEvaluationRequest` itself -- this is the same id generator the Kernel was constructed with. */
  readonly idGenerator: KernelIdGenerator;
  /** A separate id source for the Enterprise Host's own bookkeeping (`EnterpriseEvent.eventId`) -- deliberately independent of the Kernel's own id sequence. */
  readonly eventIdGenerator: KernelIdGenerator;
  readonly store: GovernanceStore;
  readonly eventPublisher: EnterpriseEventPublisher;
  readonly telemetry: EnterpriseTelemetry;
  readonly logger: EnterpriseLogger;
  readonly configuration: EnterpriseConfiguration;
  /** Live Enterprise context (lifecycle state, module snapshot, providers) captured into every appended aggregate. Supplied by the composition root. */
  readonly enterpriseContext: () => GovernanceEnterpriseContext;
  /** G-01A: the composed customer identity admission. Absent, a customer-plane credential cannot evaluate. */
  readonly customerIdentityAdmission?: CustomerIdentityAdmissionService;
  /** G-01A: the trusted Host trust domain. Absent, no customer or service principal can evaluate. */
  readonly trustDomainId?: string;
}

/** The Enterprise Host's evaluation response -- an HTTP status derived from `KernelDecisionStatus`, plus the wire response body. */
export interface EnterpriseEvaluationResponse {
  readonly httpStatus: number;
  readonly body: GovernanceEvaluateResponseBody;
}

/** Idempotency scope: always tenant-qualified so one organization's key can never collide with another's (PR-004 section 15). Requests naming no organization share the explicit global scope. */
function idempotencyScopeFor(organizationId: string | undefined): string {
  return organizationId !== undefined ? `org:${organizationId}` : 'global';
}

/**
 * The PR-004 evaluation flow: Authentication -> Validation -> Idempotency
 * Resolution (before the Kernel is re-run) -> `kernel.evaluate()` -> one
 * atomic Governance Store aggregate append -> post-commit event publication
 * -> HTTP response.
 *
 * Persistence invariant (PR-004 section 64): no successful governance
 * response is ever returned when the required Governance Store commit
 * failed. The Kernel result may exist transiently, but Soberanía Enterprise does
 * not claim governed completion it cannot durably prove.
 */
export async function evaluateGovernanceRequest(
  input: EvaluateGovernanceRequestInput,
  deps: EvaluateGovernanceRequestDependencies,
): Promise<EnterpriseEvaluationResponse> {
  const receivedAt = deps.clock.now();
  const startedAtMs = Date.now();

  // Enterprise-owned authentication -- entirely separate from, and prior to,
  // anything the Kernel evaluates. Neither a 401 nor a 403 is a governance
  // decision. G-01A: the credential establishes who is calling; the body's
  // actor and organization are claims checked against it after validation.
  // G-01B1: one snapshot of the body, read once. Everything below — authentication's organization hint, validation, and
  // the Kernel request — reads this copy, so an in-process body (an accessor, a mutation between reads) cannot validate one
  // request id and evaluate another.
  const rawBody = snapshotRequestBody(input.rawBody);
  const candidateOrganizationId = isPlainObjectWithOrganization(rawBody) ? rawBody.organization?.id : undefined;
  const caller = authenticateAdvisoryCaller(input.authorizationHeader, candidateOrganizationId, deps.configuration);

  const body = validateGovernanceEvaluateRequestBody(rawBody);
  const request = toKernelEvaluationRequest(body, deps.clock, deps.idGenerator);
  const options = toKernelEvaluationOptions(body, deps.configuration.features.traceLevel);

  const { accessContext, attribution } = await establishAdvisoryIdentity(caller, input.authorizationHeader, request, {
    configuration: deps.configuration,
    ...(deps.customerIdentityAdmission !== undefined ? { customerIdentityAdmission: deps.customerIdentityAdmission } : {}),
    ...(deps.trustDomainId !== undefined ? { trustDomainId: deps.trustDomainId } : {}),
  });
  const organizationId = request.organization?.id;
  const idempotency: GovernanceIdempotencyContext | undefined =
    input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey, scope: idempotencyScopeFor(organizationId) } : undefined;

  deps.logger.info('governance.evaluate.requested', {
    requestId: request.requestId,
    ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    route: 'POST /api/governance/evaluate',
  });

  // -- Idempotency resolution BEFORE re-running the Kernel (PR-004 section 44).
  // Advisory only: the authoritative enforcement is the append transaction's
  // own uniqueness constraints; a racer that misses here still cannot
  // double-commit.
  const payloadDigest = computeGovernanceRequestPayloadDigest(request);
  const resolution = await deps.store.resolveIdempotency(accessContext, {
    requestId: request.requestId,
    payloadDigest,
    ...(idempotency !== undefined ? { idempotency } : {}),
  });
  if (resolution.kind === 'conflict') {
    deps.telemetry.recordStoreIdempotencyConflict();
    throw idempotencyConflictError(resolution.conflictKind, request.requestId);
  }
  if (resolution.kind === 'replay') {
    return replayResponse(replayableRecord(resolution.record, attribution, idempotency, request.requestId, deps), deps, Date.now() - startedAtMs);
  }

  // -- Operational pre-evaluation event: published in-process only; its
  // durable copy is embedded in the aggregate below and committed atomically
  // with the evaluation (PR-004 section 63/65, Option A).
  let requestedEvent: GovernanceEvaluationRequestedEvent | undefined;
  if (deps.configuration.eventPublishing.enabled) {
    requestedEvent = {
      eventId: deps.eventIdGenerator.nextId('enterprise-event'),
      type: 'GovernanceEvaluationRequested',
      occurredAt: receivedAt,
      requestId: request.requestId,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    };
    await deps.eventPublisher.publish(requestedEvent);
  }

  let result: KernelEvaluationResult;
  try {
    result = await deps.kernel.evaluate(request, options);
  } catch (error) {
    if (error instanceof KernelValidationError) {
      throw EnterpriseHttpErrors.invalidRequest(error.message);
    }
    deps.telemetry.recordEnterpriseFailure();
    deps.logger.error('governance.evaluate.kernel_failure', { requestId: request.requestId, route: 'POST /api/governance/evaluate' });
    throw EnterpriseHttpErrors.infrastructureFailure('The Kernel could not complete evaluation.');
  }

  const durationMs = Date.now() - startedAtMs;
  deps.telemetry.recordEvaluation(result.status, durationMs);

  const completionEvent = deps.configuration.eventPublishing.enabled
    ? buildGovernanceEvaluationOutcomeEvent(result, deps.eventIdGenerator.nextId('enterprise-event'))
    : undefined;
  const aggregateEvents: EnterpriseEvent[] = [];
  if (requestedEvent !== undefined) aggregateEvents.push(requestedEvent);
  if (completionEvent !== undefined) aggregateEvents.push(completionEvent);

  // -- One atomic Governance Store aggregate append.
  const appendStartedAtMs = Date.now();
  let appended;
  try {
    appended = await deps.store.appendEvaluation({
      request,
      result,
      receivedAt,
      enterpriseContext: deps.enterpriseContext(),
      events: aggregateEvents,
      ...(idempotency !== undefined ? { idempotency } : {}),
      accessContext,
      ...(attribution !== undefined ? { attribution } : {}),
    });
  } catch (error) {
    deps.telemetry.recordPersistenceFailure();
    deps.telemetry.recordStoreAppendFailure();
    deps.logger.error('governance.store.append_failed', {
      requestId: request.requestId,
      decisionId: result.decisionId,
      ...(isGovernanceStoreError(error) ? { errorCode: error.code } : {}),
      route: 'POST /api/governance/evaluate',
    });
    if (deps.configuration.eventPublishing.enabled) {
      // Best-effort failure signal; publication failure here must not mask the original error.
      try {
        await deps.eventPublisher.publish({
          eventId: deps.eventIdGenerator.nextId('enterprise-event'),
          type: 'GovernanceRecordCommitFailed',
          occurredAt: deps.clock.now(),
          requestId: request.requestId,
          errorCode: isGovernanceStoreError(error) ? error.code : 'GOVERNANCE_STORE_TRANSACTION_FAILED',
          ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
        });
      } catch {
        // swallowed by design
      }
    }
    if (isGovernanceStoreError(error)) {
      if (error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT') {
        deps.telemetry.recordStoreIdempotencyConflict();
        throw idempotencyConflictError(error.details?.conflictKind === 'idempotency-key' ? 'idempotency-key' : 'request-id', request.requestId);
      }
      throw mapGovernanceStoreErrorToHttp(error);
    }
    throw EnterpriseHttpErrors.infrastructureFailure('The evaluation could not be persisted.');
  }
  // A concurrent racer committed the equivalent aggregate first — answer
  // with the stored original, exactly like the pre-Kernel replay path. G-01A:
  // a replay signal is answered only from the record it names, after the
  // requester check; one that names no record is never treated as this
  // caller's fresh commit.
  if (appended.idempotentReplay) {
    const existing = replayableRecord(appended.existingRecord, attribution, idempotency, request.requestId, deps);
    deps.telemetry.recordStoreAppend(Date.now() - appendStartedAtMs, true);
    return replayResponse(existing, deps, Date.now() - startedAtMs);
  }
  deps.telemetry.recordStoreAppend(Date.now() - appendStartedAtMs, false);

  deps.logger.info('governance.audit.decision', {
    requestId: result.requestId,
    decisionId: result.decisionId,
    evaluationId: appended.evaluationId,
    status: result.status,
    durationMs,
    created: appended.created,
    kernelVersion: result.kernelVersion,
    enterpriseVersion: deps.configuration.enterpriseVersion,
    ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
  });

  // -- Post-commit events only (PR-004 section 62/63): nothing named
  // "committed" or "completed" is published before the transaction commits.
  if (deps.configuration.eventPublishing.enabled) {
    if (completionEvent !== undefined) await deps.eventPublisher.publish(completionEvent);
    await deps.eventPublisher.publish({
      eventId: deps.eventIdGenerator.nextId('enterprise-event'),
      type: 'GovernanceRecordCommitted',
      occurredAt: appended.persistedAt,
      requestId: result.requestId,
      decisionId: result.decisionId,
      evaluationId: appended.evaluationId,
      aggregateDigest: appended.aggregateDigest,
      ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
    });
  }

  return {
    httpStatus: mapDecisionStatusToHttpStatus(result.status),
    body: toGovernanceEvaluateResponseBody(result, { evaluationId: appended.evaluationId, aggregateDigest: appended.aggregateDigest }),
  };
}

/** Rebuilds the HTTP response for an idempotent replay from the stored aggregate — the Kernel is NOT re-run; the answer is the originally persisted decision (PR-004 section 44). */
function replayResponse(record: GovernanceRecord, deps: EvaluateGovernanceRequestDependencies, durationMs: number): EnterpriseEvaluationResponse {
  const storedResult = toKernelEvaluationResult(record);
  deps.telemetry.recordStoreAppend(0, true);
  deps.logger.info('governance.audit.decision', {
    requestId: storedResult.requestId,
    decisionId: storedResult.decisionId,
    evaluationId: record.evaluation.evaluationId,
    status: storedResult.status,
    durationMs,
    created: false,
    idempotentReplay: true,
    kernelVersion: storedResult.kernelVersion,
    enterpriseVersion: deps.configuration.enterpriseVersion,
    ...(storedResult.correlationId !== undefined ? { correlationId: storedResult.correlationId } : {}),
  });
  return {
    httpStatus: mapDecisionStatusToHttpStatus(storedResult.status),
    body: toGovernanceEvaluateResponseBody(storedResult, {
      evaluationId: record.evaluation.evaluationId,
      aggregateDigest: record.integrity.aggregateDigest,
    }),
  };
}

/**
 * G-01A: an equivalent stored decision answers only the requester that
 * committed it. Any other requester -- another principal, another basis, or an
 * authenticated principal meeting a record that carries no attribution -- gets
 * the existing 409 for the key or request id it reused, and nothing is written.
 * A Store that signals a replay without the record it replays (an injected
 * Store can) gives nothing to check the requester against: that is an
 * integrity failure, never a replay and never a fresh commit.
 */
function replayableRecord(
  record: GovernanceRecord | null | undefined,
  attribution: GovernanceEvaluationAttribution | undefined,
  idempotency: GovernanceIdempotencyContext | undefined,
  requestId: string,
  deps: EvaluateGovernanceRequestDependencies,
): GovernanceRecord {
  if (!isReplayableRecordShape(record)) {
    deps.telemetry.recordStoreCorruptedRecord();
    deps.logger.error('governance.evaluate.replay_without_record', { requestId, route: 'POST /api/governance/evaluate' });
    throw new EnterpriseHttpError(500, 'GOVERNANCE_RECORD_CORRUPTED', 'A stored governance record is corrupted; see server logs.');
  }
  if (mayReplayTo(record, attribution)) return record;
  deps.telemetry.recordStoreIdempotencyConflict();
  throw idempotencyConflictError(idempotency !== undefined ? 'idempotency-key' : 'request-id', requestId);
}

/**
 * `request-id` conflicts keep the PR-002 wire contract (409 CONCURRENCY_CONFLICT); caller-key conflicts are the PR-004 409
 * GOVERNANCE_IDEMPOTENCY_CONFLICT. G-01B1: one text per kind, whatever the cause — a different payload, another requester's
 * equivalent request, or a record the caller cannot see — so the text never says which.
 */
function idempotencyConflictError(conflictKind: 'idempotency-key' | 'request-id', requestId: string): EnterpriseHttpError {
  if (conflictKind === 'idempotency-key') {
    return new EnterpriseHttpError(409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used by another requester or with a different request payload.');
  }
  return EnterpriseHttpErrors.concurrencyConflict(
    `requestId '${requestId}' was already submitted by another requester or with a different payload; a request id must uniquely identify one governance request.`,
  );
}

/**
 * G-01B1: the body as the wire would carry it — one JSON round trip, which reads every field exactly once. A body that has
 * no JSON form is no request body: it becomes `null`, which validation refuses with the existing 400 after authentication,
 * exactly where a malformed body is refused today.
 */
function snapshotRequestBody(rawBody: unknown): unknown {
  if (rawBody === null || typeof rawBody !== 'object') return rawBody;
  try {
    return JSON.parse(JSON.stringify(rawBody)) as unknown;
  } catch {
    return null;
  }
}

/** The minimum a replayed record must carry for the requester check and the replay response: its request, evaluation, events and integrity. */
function isReplayableRecordShape(record: GovernanceRecord | null | undefined): record is GovernanceRecord {
  if (record === null || typeof record !== 'object') return false;
  const candidate = record as unknown as Record<string, unknown>;
  return ['request', 'evaluation', 'integrity'].every((key) => candidate[key] !== null && typeof candidate[key] === 'object') && Array.isArray(candidate['events']);
}

function isPlainObjectWithOrganization(value: unknown): value is { organization?: { id?: string } } {
  return typeof value === 'object' && value !== null;
}
