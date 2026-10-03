import { EnterpriseHttpErrors } from './enterprise-http-errors.js';
import type { BuildEvidenceBundleInput } from '../evidence/evidence-service.js';
import type { EvidenceBundle, EvidenceBundleRecord, EvidenceBundleState, EvidenceVerificationResult } from '../evidence/contracts.js';

/** Wire shape for `POST /api/evidence/build`: `evaluationId` builds a v1 bundle of one Governance Record; `requestId` (ASSURE-01) a v2 bundle carrying that governed request's trace. Exactly one. */
export interface EvidenceBuildRequestBody {
  readonly evaluationId?: string;
  readonly requestId?: string;
  readonly level?: string;
  readonly createdBy?: string;
}

/** Wire shape returned from `POST /api/evidence/build` and `GET /api/evidence/{bundleId}`. */
export interface EvidenceBundleResponseBody {
  readonly bundle: EvidenceBundle;
  readonly state: EvidenceBundleState;
  readonly storedAt: string;
  readonly supersededBy?: string;
}

/** Wire shape for `POST /api/evidence/verify`. */
export interface EvidenceVerifyRequestBody {
  readonly bundleId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** HTTP/JSON shape validation only, mirroring `validateGovernanceEvaluateRequestBody` -- the Evidence Service still validates the resolved input itself. */
export function validateEvidenceBuildRequestBody(body: unknown): BuildEvidenceBundleInput {
  if (!isPlainObject(body)) {
    throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  }
  const violations: string[] = [];
  // A v2 (trace) build body is closed. A v1 body keeps its frozen v1 behaviour:
  // fields it does not use are ignored, exactly as before ASSURE-01.
  if (body.requestId !== undefined) {
    const unknown = Object.keys(body).filter((key) => !['evaluationId', 'requestId', 'level', 'createdBy'].includes(key));
    if (unknown.length > 0) violations.push(`Unknown fields: ${unknown.join(', ')}.`);
  }
  if ((body.evaluationId === undefined) === (body.requestId === undefined)) violations.push('Exactly one of evaluationId (v1 bundle) or requestId (v2 trace bundle) is required.');
  if (body.evaluationId !== undefined && !isNonEmptyString(body.evaluationId)) violations.push('evaluationId, when present, must be a non-empty string.');
  if (body.requestId !== undefined && !isNonEmptyString(body.requestId)) violations.push('requestId, when present, must be a non-empty string.');
  if (!isNonEmptyString(body.level)) violations.push('level is a required non-empty string.');
  if (body.createdBy !== undefined && !isNonEmptyString(body.createdBy)) violations.push('createdBy, when present, must be a non-empty string.');
  if (violations.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest('The Evidence Bundle build request failed validation.', violations);
  }
  return {
    ...(body.evaluationId !== undefined ? { evaluationId: body.evaluationId as string } : {}),
    ...(body.requestId !== undefined ? { requestId: body.requestId as string } : {}),
    level: body.level as string,
    ...(body.createdBy !== undefined ? { createdBy: body.createdBy as string } : {}),
  };
}

export function validateEvidenceVerifyRequestBody(body: unknown): { readonly bundleId: string } {
  if (!isPlainObject(body) || !isNonEmptyString(body.bundleId)) {
    throw EnterpriseHttpErrors.invalidRequest('The Evidence Bundle verify request failed validation.', ['bundleId is a required non-empty string.']);
  }
  return { bundleId: body.bundleId };
}

export function toEvidenceBundleResponseBody(record: EvidenceBundleRecord): EvidenceBundleResponseBody {
  return {
    bundle: record.bundle,
    state: record.state,
    storedAt: record.storedAt,
    ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
  };
}

export function toEvidenceVerifyResponseBody(result: EvidenceVerificationResult): EvidenceVerificationResult {
  return result;
}

/** ASSURE-01: the closed query of `GET /api/evidence/traces/{requestId}` — exactly one `level`, nothing else. */
export function validateEvidenceTraceQuery(searchParams: URLSearchParams): { readonly level: string } {
  const keys = [...searchParams.keys()];
  const levels = searchParams.getAll('level');
  if (keys.some((key) => key !== 'level') || levels.length !== 1 || !isNonEmptyString(levels[0])) {
    throw EnterpriseHttpErrors.invalidRequest('The trace query failed validation.', ['Exactly one query parameter is accepted: level (FULL, AUDITOR, PARTNER, CUSTOMER or PUBLIC).']);
  }
  return { level: levels[0] as string };
}

/** ASSURE-01: `GET /api/evidence/traces/{requestId}/verify` takes no query at all. */
export function validateEvidenceTraceVerifyQuery(searchParams: URLSearchParams): void {
  if ([...searchParams.keys()].length > 0) {
    throw EnterpriseHttpErrors.invalidRequest('The trace verification query failed validation.', ['No query parameter is accepted.']);
  }
}
