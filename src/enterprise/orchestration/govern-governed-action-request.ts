import { mapCustomerAdmissionFailureToHttp, mapGovernedActionResultToHttpStatus, type EnterpriseGovernedActionResponse } from '../api/governed-action-contract.js';
import type { CustomerIdentityAdmissionService } from '../customer-identity/index.js';
import type { GovernedActionOrchestrator } from '../governed-action/index.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';

export interface GovernGovernedActionRequestInput {
  /** The not-yet-validated request body. Handed to the orchestrator untouched; it validates the intent closed. */
  readonly rawIntent: unknown;
  /** The caller's `Authorization` header — the only thing admission reads. */
  readonly authorizationHeader?: string;
}

export interface GovernGovernedActionRequestDependencies {
  readonly admission: CustomerIdentityAdmissionService;
  readonly orchestrator: GovernedActionOrchestrator;
  readonly logger: EnterpriseLogger;
}

/**
 * The customer plane's one application sequence:
 *
 * ```
 * Authorization header -> customer identity admission -> BoundCustomerIdentity
 *                      -> GovernedActionOrchestrator.govern(identity, rawIntent)
 * ```
 *
 * Authentication lives here, outside the orchestrator, so the orchestrator
 * keeps importing no credential matcher and parsing no header. Nothing here
 * decides, selects an adapter, issues or exercises a grant, or reads the
 * intent: the only identity the orchestrator ever sees is the one admission
 * produced, and anything short of `bound` stops before the Kernel with the
 * Enterprise error envelope.
 *
 * Admission never consults `AOC_ENTERPRISE_REQUIRE_AUTH`: that flag belongs to
 * the legacy routes, and this path has no unauthenticated mode.
 */
export async function governGovernedActionRequest(
  input: GovernGovernedActionRequestInput,
  deps: GovernGovernedActionRequestDependencies,
): Promise<EnterpriseGovernedActionResponse> {
  const admitted = await deps.admission.admit(input.authorizationHeader !== undefined ? { authorizationHeader: input.authorizationHeader } : {});
  if (admitted.status !== 'bound') {
    // The stable reason code only — never the header, the credential or the principal.
    deps.logger.warn('governed_action.admission_refused', { route: 'POST /api/governed-actions', errorCode: admitted.reason });
    throw mapCustomerAdmissionFailureToHttp(admitted.reason);
  }

  const result = await deps.orchestrator.govern(admitted.identity, input.rawIntent);
  return { httpStatus: mapGovernedActionResultToHttpStatus(result), body: result };
}
