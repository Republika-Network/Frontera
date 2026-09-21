/**
 * The Governed Action Orchestrator — internal orchestration capability. Its one
 * customer route, `POST /api/governed-actions`, lives outside this layer
 * (`orchestration/govern-governed-action-request.ts` admits the caller, then
 * calls `govern()`); nothing here authenticates or parses HTTP.
 *
 * See `docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md`. The one thing to
 * know from here: a governed action's decision is durably committed to the
 * Governance Store before any bounded grant for it can exist, and actor and
 * organization come from a `BoundCustomerIdentity` and from nowhere else.
 */
export {
  GOVERNED_ACTION_REASON_CODES,
  GOVERNED_ACTION_REASON_CODE_VALUES,
  type GovernedActionAmount,
  type GovernedActionDecisionRef,
  type GovernedActionGrantPolicy,
  type GovernedActionGrantPolicyQuery,
  type GovernedActionGrantTerms,
  type GovernedActionIntent,
  type GovernedActionReasonCode,
  type GovernedActionResult,
  type GovernedActionResultStatus,
  type GovernedActionWithheldBy,
} from './contracts.js';
export { GOVERNED_ACTION_RESERVED_CONTEXT_KEYS, validateGovernedActionIntent, type GovernedActionIntentValidation } from './intent.js';
export { deriveGovernedActionExecutionId, deriveGovernedActionRequestId, governedActionIdempotencyScope } from './identifiers.js';
export { createGovernedActionOrchestrator, type GovernedActionOrchestrator, type GovernedActionOrchestratorOptions } from './orchestrator.js';
export { GovernedActionConfigurationError, type GovernedActionConfigurationErrorCode } from './errors.js';
