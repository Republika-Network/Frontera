import { EnterpriseHostApiError, EnterpriseHostNetworkError, EnterpriseHostTimeoutError } from './errors.js';
import type {
  AgentPassport,
  AssuranceAssessment,
  AssuranceSignalRequest,
  AssuranceVerificationResult,
  CreateAssessmentRequest,
  EnterpriseHostClientOptions,
  EvidenceBuildRequest,
  EvidenceBundleResponse,
  EvidenceVerificationResult,
  FetchLike,
  GovernanceEvaluateRequest,
  GovernanceEvaluateResponse,
  GovernanceRecord,
  GovernanceVerificationResult,
  GovernedActionIntent,
  GovernedActionResult,
  HealthReport,
  IssuePassportRequest,
  LivenessResponse,
  ManualReviewRequest,
  PassportVerificationResult,
  PassportVerifyMode,
  ReadinessResponse,
  ReassessRequest,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface AbortSignalTimeoutFactory {
  timeout(ms: number): unknown;
}

/** The Enterprise Host HTTP client. One method per public endpoint; no business logic, no local decisions. */
export interface EnterpriseHostClient {
  // health
  live(): Promise<LivenessResponse>;
  ready(): Promise<ReadinessResponse>;
  health(): Promise<HealthReport>;

  // governance
  evaluate(request: GovernanceEvaluateRequest, options?: { readonly idempotencyKey?: string }): Promise<GovernanceEvaluateResponse>;
  getEvaluation(evaluationId: string): Promise<GovernanceRecord>;
  verifyEvaluation(evaluationId: string): Promise<GovernanceVerificationResult>;
  getDecision(decisionId: string): Promise<GovernanceRecord>;
  getRequest(requestId: string): Promise<GovernanceRecord>;

  // governed actions
  /**
   * `POST /api/governed-actions` under the client's `apiKey`.
   *
   * `GovernedActionResult` domain responses are returned — `executed` (200),
   * `denied` (422), `withheld` (409), `execution_failed` (502) and the rest —
   * once the body is a well-formed result under the HTTP status the Host pairs
   * with it. Enterprise error envelopes (authentication, authorization,
   * malformed request, unmounted route) and invalid, unrecognized or
   * mismatched-status protocol responses throw `EnterpriseHostApiError`.
   */
  governAction(intent: GovernedActionIntent): Promise<GovernedActionResult>;

  // evidence
  buildEvidence(request: EvidenceBuildRequest): Promise<EvidenceBundleResponse>;
  verifyEvidence(bundleId: string): Promise<EvidenceVerificationResult>;
  getEvidence(bundleId: string): Promise<EvidenceBundleResponse>;

  // passports
  issuePassport(request: IssuePassportRequest): Promise<unknown>;
  getPassport(passportId: string): Promise<unknown>;
  getPassportEvents(passportId: string): Promise<unknown>;
  getPassportHistory(passportId: string): Promise<unknown>;
  activatePassport(passportId: string, actorId: string): Promise<AgentPassport>;
  suspendPassport(passportId: string, body: Readonly<Record<string, unknown>>): Promise<AgentPassport>;
  reactivatePassport(passportId: string, actorId: string): Promise<AgentPassport>;
  revokePassport(passportId: string, body: Readonly<Record<string, unknown>>): Promise<AgentPassport>;
  retirePassport(passportId: string, body: Readonly<Record<string, unknown>>): Promise<AgentPassport>;
  verifyPassport(passportId: string, mode?: PassportVerifyMode): Promise<PassportVerificationResult>;
  linkPassportEvidence(passportId: string, body: Readonly<Record<string, unknown>>): Promise<AgentPassport>;
  linkPassportGovernance(passportId: string, body: Readonly<Record<string, unknown>>): Promise<AgentPassport>;
  buildPassportView(passportId: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;

  // assurance
  createAssessment(request: CreateAssessmentRequest): Promise<AssuranceAssessment>;
  evaluateAssessment(assessmentId: string, options?: { readonly complete?: boolean }): Promise<AssuranceAssessment>;
  verifyAssessment(assessmentId: string): Promise<AssuranceVerificationResult>;
  getAssessment(assessmentId: string): Promise<AssuranceAssessment>;
  listFindings(assessmentId: string): Promise<unknown>;
  appendFindingEvent(findingId: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;
  recordManualReview(request: ManualReviewRequest): Promise<unknown>;
  processSignal(request: AssuranceSignalRequest): Promise<unknown>;
  getContinuousState(subjectId: string, options?: { readonly frameworkId?: string; readonly frameworkVersion?: string }): Promise<unknown>;
  requestReassessment(subjectId: string, request: ReassessRequest): Promise<AssuranceAssessment>;
}

function resolveFetch(options: EnterpriseHostClientOptions): FetchLike {
  if (options.fetch !== undefined) return options.fetch;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (globalFetch === undefined) {
    throw new TypeError('No fetch implementation available: pass options.fetch or run on Node.js >= 18.');
  }
  return globalFetch;
}

function timeoutSignal(ms: number): unknown {
  const abortSignal = (globalThis as { AbortSignal?: AbortSignalTimeoutFactory }).AbortSignal;
  return abortSignal?.timeout !== undefined ? abortSignal.timeout(ms) : undefined;
}

function isTimeoutAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}

function extractEnvelope(body: unknown): { code: string; message: string; details?: readonly string[] } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const errorField = (body as { error?: unknown }).error;
  if (typeof errorField !== 'object' || errorField === null) return undefined;
  const { code, message, details } = errorField as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return {
    code,
    message,
    ...(Array.isArray(details) && details.every((entry) => typeof entry === 'string') ? { details: details as readonly string[] } : {}),
  };
}

/** Builds the `EnterpriseHostApiError` for a response the caller must not receive as data. */
function apiErrorFor(status: number, parsed: unknown, fallbackMessage: string): EnterpriseHostApiError {
  const envelope = extractEnvelope(parsed);
  return new EnterpriseHostApiError(status, envelope?.code ?? 'UNKNOWN', envelope?.message ?? fallbackMessage, parsed, envelope?.details);
}

// -- governed-action wire decoding ---------------------------------------------
//
// Transport decoding of the Host's `GovernedActionResult` contract: the known
// vocabularies, the field types each status requires, and the HTTP status the
// Host pairs with each result. It proves the *shape* the server promised; it
// never judges an outcome. Unknown additive fields are tolerated.

const GOVERNED_ACTION_RESULT_STATUSES: readonly string[] = ['executed', 'denied', 'indeterminate', 'withheld', 'execution_failed', 'execution_unconfirmed', 'rejected', 'system_error'];
const DECISION_STATUSES: readonly string[] = ['allowed', 'denied', 'approval_required', 'indeterminate'];
const WITHHELD_BY: readonly string[] = ['approval', 'obligations', 'grant', 'authority-binding', 'grant-terms', 'exercise', 'emergency-control'];
const EXECUTION_FAILURES: readonly string[] = ['PROVIDER_REJECTED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_RESPONSE_INVALID', 'ADAPTER_ERROR'];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isDecisionRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['decisionId'] === 'string' &&
    typeof value['evaluationId'] === 'string' &&
    isOneOf(value['status'], DECISION_STATUSES) &&
    isStringArray(value['reasonCodes'])
  );
}

/** Proves `body` is a well-formed `GovernedActionResult`. Unknown additive fields are tolerated; nothing is coerced. */
function isGovernedActionResult(body: unknown): body is GovernedActionResult {
  if (!isRecord(body) || body['error'] !== undefined) return false;
  const status = body['status'];
  if (!isOneOf(status, GOVERNED_ACTION_RESULT_STATUSES) || !isStringArray(body['reasonCodes'])) return false;
  if (!isOptionalString(body['requestId']) || !isOptionalString(body['correlationId']) || !isOptionalString(body['executionId'])) return false;
  if (body['decision'] !== undefined && !isDecisionRef(body['decision'])) return false;
  switch (status) {
    case 'executed':
      return typeof body['replayed'] === 'boolean' && typeof body['outcomeRecorded'] === 'boolean' && isOptionalString(body['providerRef']);
    case 'withheld':
      return isOneOf(body['withheldBy'], WITHHELD_BY);
    case 'execution_failed':
      return isOneOf(body['failure'], EXECUTION_FAILURES) && typeof body['replayed'] === 'boolean' && typeof body['outcomeRecorded'] === 'boolean';
    default:
      return true;
  }
}

/** The HTTP status the Host pairs with each result (docs/enterprise/API_STABILITY_V1.md §2.6). */
function expectedGovernedActionHttpStatus(result: GovernedActionResult): number {
  switch (result.status) {
    case 'executed':
      return 200;
    case 'denied':
      return 422;
    case 'indeterminate':
      return 503;
    case 'withheld':
    case 'execution_unconfirmed':
      return 409;
    case 'execution_failed':
      return 502;
    case 'rejected':
      if (result.reasonCodes.includes('GOVERNED_ACTION_IDEMPOTENCY_CONFLICT')) return 409;
      if (result.reasonCodes.includes('GOVERNED_ACTION_IDENTITY_INVALID')) return 403;
      return 400;
    case 'system_error':
      return 500;
  }
}

/**
 * `governAction`'s decoder, applied on **every** HTTP status: a well-formed
 * result under the HTTP status the Host pairs with it is returned; an
 * Enterprise error envelope throws as on every other route; anything else —
 * malformed, unrecognized, or a valid result under the wrong status — is
 * protocol drift and throws rather than reaching the caller as a typed result.
 */
function decodeGovernedActionResponse(status: number, parsed: unknown, route: string): GovernedActionResult {
  if (extractEnvelope(parsed) !== undefined) {
    throw apiErrorFor(status, parsed, `Request to '${route}' failed with status ${status}.`);
  }
  if (!isGovernedActionResult(parsed)) {
    throw apiErrorFor(status, parsed, `Request to '${route}' returned an unrecognized governed-action response (HTTP ${status}).`);
  }
  const expected = expectedGovernedActionHttpStatus(parsed);
  if (expected !== status) {
    throw apiErrorFor(status, parsed, `Request to '${route}' returned a '${parsed.status}' result under HTTP ${status}; the Host pairs it with ${expected}.`);
  }
  return parsed;
}

/**
 * Creates a typed HTTP client for the Soberanía Enterprise Host v1 API.
 *
 * The client performs no retries: retry policy belongs to the caller (see
 * README "Retries" for which operations are safe to retry and how to use
 * the evaluate `idempotencyKey`).
 */
export function createEnterpriseHostClient(options: EnterpriseHostClientOptions): EnterpriseHostClient {
  const fetchImpl = resolveFetch(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  /**
   * `decode` lets one route own its whole response contract, on every HTTP
   * status. Only `governAction` passes it; every other method keeps the
   * original rule that any status >= 400 throws and anything else is returned.
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
    decode?: (status: number, parsed: unknown, route: string) => T,
  ): Promise<T> {
    const route = `${method} ${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
      ...extraHeaders,
    };

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (isTimeoutAbort(error)) throw new EnterpriseHostTimeoutError(timeoutMs, route);
      throw new EnterpriseHostNetworkError(route, error);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new EnterpriseHostNetworkError(route, error);
    }

    if (decode !== undefined) return decode(response.status, parsed, route);

    if (response.status >= 400) {
      throw apiErrorFor(response.status, parsed, `Request to '${route}' failed with status ${response.status}.`);
    }
    return parsed as T;
  }

  const encode = encodeURIComponent;

  return {
    live: () => request('GET', '/live'),
    ready: () => request('GET', '/ready'),
    health: () => request('GET', '/health'),

    evaluate: (body, callOptions) =>
      request('POST', '/api/governance/evaluate', body, callOptions?.idempotencyKey !== undefined ? { 'idempotency-key': callOptions.idempotencyKey } : undefined),
    getEvaluation: (evaluationId) => request('GET', `/api/governance/evaluations/${encode(evaluationId)}`),
    verifyEvaluation: (evaluationId) => request('GET', `/api/governance/evaluations/${encode(evaluationId)}/verify`),
    getDecision: (decisionId) => request('GET', `/api/governance/decisions/${encode(decisionId)}`),
    getRequest: (requestId) => request('GET', `/api/governance/requests/${encode(requestId)}`),

    governAction: (intent) => request('POST', '/api/governed-actions', intent, undefined, decodeGovernedActionResponse),

    buildEvidence: (body) => request('POST', '/api/evidence/build', body),
    verifyEvidence: (bundleId) => request('POST', '/api/evidence/verify', { bundleId }),
    getEvidence: (bundleId) => request('GET', `/api/evidence/${encode(bundleId)}`),

    issuePassport: (body) => request('POST', '/api/passports', body),
    getPassport: (passportId) => request('GET', `/api/passports/${encode(passportId)}`),
    getPassportEvents: (passportId) => request('GET', `/api/passports/${encode(passportId)}/events`),
    getPassportHistory: (passportId) => request('GET', `/api/passports/${encode(passportId)}/history`),
    activatePassport: (passportId, actorId) => request('POST', `/api/passports/${encode(passportId)}/activate`, { actorId }),
    suspendPassport: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/suspend`, body),
    // The reactivate route validates the body field as `reactivatedBy`, not `actorId`.
    reactivatePassport: (passportId, actorId) => request('POST', `/api/passports/${encode(passportId)}/reactivate`, { reactivatedBy: actorId }),
    revokePassport: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/revoke`, body),
    retirePassport: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/retire`, body),
    verifyPassport: (passportId, mode) => request('POST', `/api/passports/${encode(passportId)}/verify`, mode !== undefined ? { mode } : {}),
    linkPassportEvidence: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/evidence`, body),
    linkPassportGovernance: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/governance`, body),
    buildPassportView: (passportId, body) => request('POST', `/api/passports/${encode(passportId)}/views`, body),

    createAssessment: (body) => request('POST', '/api/assurance/assessments', body),
    evaluateAssessment: (assessmentId, callOptions) =>
      request('POST', `/api/assurance/assessments/${encode(assessmentId)}/evaluate`, callOptions?.complete !== undefined ? { complete: callOptions.complete } : {}),
    verifyAssessment: (assessmentId) => request('POST', `/api/assurance/assessments/${encode(assessmentId)}/verify`),
    getAssessment: (assessmentId) => request('GET', `/api/assurance/assessments/${encode(assessmentId)}`),
    listFindings: (assessmentId) => request('GET', `/api/assurance/assessments/${encode(assessmentId)}/findings`),
    appendFindingEvent: (findingId, body) => request('POST', `/api/assurance/findings/${encode(findingId)}/events`, body),
    recordManualReview: (body) => request('POST', '/api/assurance/manual-reviews', body),
    processSignal: (body) => request('POST', '/api/assurance/signals', body),
    getContinuousState: (subjectId, callOptions) => {
      const params = [
        ...(callOptions?.frameworkId !== undefined ? [`frameworkId=${encode(callOptions.frameworkId)}`] : []),
        ...(callOptions?.frameworkVersion !== undefined ? [`frameworkVersion=${encode(callOptions.frameworkVersion)}`] : []),
      ];
      const query = params.length > 0 ? `?${params.join('&')}` : '';
      return request('GET', `/api/assurance/subjects/${encode(subjectId)}/state${query}`);
    },
    requestReassessment: (subjectId, body) => request('POST', `/api/assurance/subjects/${encode(subjectId)}/reassess`, body),
  };
}
