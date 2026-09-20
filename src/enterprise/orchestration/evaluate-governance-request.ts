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
import type { EnterpriseEvent, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent } from '../events/enterprise-events.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import type { GovernanceEnterpriseContext, GovernanceIdempotencyContext, GovernanceRecord, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import type { EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { extractBearerToken, matchApiKey } from './credential-matching.js';
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
}

/** The Enterprise Host's evaluation response -- an HTTP status derived from `KernelDecisionStatus`, plus the wire response body. */
export interface EnterpriseEvaluationResponse {
  readonly httpStatus: number;
  readonly body: GovernanceEvaluateResponseBody;
}

/**
 * Enterprise-owned authentication/authorization -- entirely separate from,
 * and prior to, anything the Kernel evaluates. A missing/unknown key is a
 * 401; a recognized key scoped to a different organization than the
 * request names is a 403. Neither check is a governance decision.
 */
function authenticateAndAuthorize(
  authorizationHeader: string | undefined,
  organizationId: string | undefined,
  configuration: EnterpriseConfiguration,
): void {
  if (!configuration.features.requireAuthentication) return;

  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) throw EnterpriseHttpErrors.authenticationFailed('A Bearer token is required.');

  const matchedKey = matchApiKey(token, configuration.authentication.apiKeys);
  if (matchedKey === undefined) throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');

  if (matchedKey.organizationId !== undefined && organizationId !== undefined && matchedKey.organizationId !== organizationId) {
    throw EnterpriseHttpErrors.authorizationFailed(`This credential is not authorized for organization '${organizationId}'.`);
  }
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

  const candidateOrganizationId = isPlainObjectWithOrganization(input.rawBody) ? input.rawBody.organization?.id : undefined;
  authenticateAndAuthorize(input.authorizationHeader, candidateOrganizationId, deps.configuration);

  const body = validateGovernanceEvaluateRequestBody(input.rawBody);
  const request = toKernelEvaluationRequest(body, deps.clock, deps.idGenerator);
  const options = toKernelEvaluationOptions(body, deps.configuration.features.traceLevel);

  const organizationId = request.organization?.id;
  const accessContext: GovernanceStoreAccessContext = {
    system: true,
    ...(organizationId !== undefined ? { organizationId } : {}),
    actorId: request.actor.id,
  };
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
    return replayResponse(resolution.record, deps, Date.now() - startedAtMs);
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
  deps.telemetry.recordStoreAppend(Date.now() - appendStartedAtMs, appended.idempotentReplay);

  // A concurrent racer committed the equivalent aggregate first — answer
  // with the stored original, exactly like the pre-Kernel replay path.
  if (appended.idempotentReplay && appended.existingRecord !== undefined) {
    return replayResponse(appended.existingRecord, deps, Date.now() - startedAtMs);
  }

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

/** `request-id` conflicts keep the PR-002 wire contract (409 CONCURRENCY_CONFLICT); caller-key conflicts are the PR-004 409 GOVERNANCE_IDEMPOTENCY_CONFLICT. */
function idempotencyConflictError(conflictKind: 'idempotency-key' | 'request-id', requestId: string): EnterpriseHttpError {
  if (conflictKind === 'idempotency-key') {
    return new EnterpriseHttpError(409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request payload.');
  }
  return EnterpriseHttpErrors.concurrencyConflict(
    `requestId '${requestId}' was already submitted with a different payload; a request id must uniquely identify one governance request.`,
  );
}

function isPlainObjectWithOrganization(value: unknown): value is { organization?: { id?: string } } {
  return typeof value === 'object' && value !== null;
}
