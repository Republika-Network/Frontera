import type { CustomerIdentityRefusalReason, CustomerIdentityUnavailableReason } from '../customer-identity/index.js';
import { GOVERNED_ACTION_REASON_CODES, type GovernedActionResult } from '../governed-action/index.js';
import { EnterpriseHttpError } from './enterprise-http-errors.js';

/**
 * The HTTP contract of `POST /api/governed-actions`.
 *
 * **Request body:** the existing `GovernedActionIntent` wire shape, validated
 * closed by `validateGovernedActionIntent` inside the orchestrator. There is no
 * second schema here: this file neither reads nor widens the intent.
 *
 * **Response body — two shapes, never mixed:**
 *
 * - a caller that was admitted gets the `GovernedActionResult` the
 *   orchestrator produced, verbatim, whatever its status — a withheld or
 *   denied action is a *domain result* (`{ status, reasonCodes, ... }`),
 *   never an `{ error: ... }` envelope;
 * - anything that stops the request before the orchestrator — admission
 *   refusal, malformed JSON, oversized body, readiness, an unmounted route or
 *   an unexpected host fault — is the Enterprise Host error envelope
 *   (`{ error: { code, message } }`), exactly as on every other route.
 *
 * `GovernedActionResult` already carries no grant, grant scope, grant digest,
 * credential, adapter id, store handle or system context, and nothing here
 * adds one.
 */

/** What `AocEnterprise.governAction()` hands the HTTP adapter: a status to write and a body to serialize. */
export interface EnterpriseGovernedActionResponse {
  readonly httpStatus: number;
  readonly body: GovernedActionResult;
}

/**
 * The one transport mapping for a governed-action result. It reads `status`
 * (and, for `rejected`, which orchestration code rejected it) and nothing
 * else: it never reinterprets a result, and it never changes the body.
 *
 * - `executed` 200 — the effect happened, or is on record as having happened.
 * - `denied` 422 — the Kernel's governance denial, as on `/api/governance/evaluate`.
 * - `indeterminate` 503 — the Kernel could not decide (a provider fault).
 * - `withheld` 409 — allowed or pending, but a gate (approval, obligations,
 *   grant terms, authority binding, grant, exercise, emergency control) holds it.
 * - `execution_failed` 502 — the provider behind the adapter failed.
 * - `execution_unconfirmed` 409 — already attempted, outcome not on record; not retried.
 * - `rejected` 409 for an idempotency conflict, 403 for an identity the
 *   orchestrator refused (unreachable from an admitted request; fails closed if
 *   it ever happens), 400 for anything else.
 * - `system_error` 500.
 */
export function mapGovernedActionResultToHttpStatus(result: GovernedActionResult): number {
  switch (result.status) {
    case 'executed':
      return 200;
    case 'denied':
      return 422;
    case 'indeterminate':
      return 503;
    case 'withheld':
      return 409;
    case 'execution_failed':
      return 502;
    case 'execution_unconfirmed':
      return 409;
    case 'rejected':
      if (result.reasonCodes.includes(GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT)) return 409;
      if (result.reasonCodes.includes(GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_IDENTITY_INVALID)) return 403;
      return 400;
    case 'system_error':
      return 500;
  }
}

/**
 * Customer admission failures, on the wire. The `CUSTOMER_*` reason is **not**
 * put in the envelope: it tells a caller holding a credential which of the
 * binding checks it failed, and the envelope's code already says everything a
 * caller is entitled to know. It is logged server-side instead. No message
 * here carries the credential or the header.
 */
export function mapCustomerAdmissionFailureToHttp(reason: CustomerIdentityRefusalReason | CustomerIdentityUnavailableReason): EnterpriseHttpError {
  switch (reason) {
    case 'CUSTOMER_AUTH_REQUIRED':
    case 'CUSTOMER_AUTH_MALFORMED':
    case 'CUSTOMER_AUTH_INVALID':
      return new EnterpriseHttpError(401, 'AUTHENTICATION_FAILED', 'A valid customer credential is required.');
    case 'CUSTOMER_AUTH_UNSCOPED':
    case 'CUSTOMER_IDENTITY_NOT_CONFIGURED':
    case 'CUSTOMER_IDENTITY_INVALID':
    case 'CUSTOMER_ORGANIZATION_NOT_SERVED':
    case 'CUSTOMER_SUBJECT_UNBOUND':
    case 'CUSTOMER_SUBJECT_ACTOR_REVOKED':
      return new EnterpriseHttpError(403, 'AUTHORIZATION_FAILED', 'The credential does not identify a customer principal bound to an active actor.');
    case 'CUSTOMER_SUBJECT_LOOKUP_FAILED':
    case 'CUSTOMER_SUBJECT_BINDING_INCONSISTENT':
      return new EnterpriseHttpError(503, 'INFRASTRUCTURE_FAILURE', 'Customer identity could not be resolved; nothing was evaluated.');
  }
}
