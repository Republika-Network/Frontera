/**
 * Authority-Controlled Execution — the composition that connects the
 * authority-control pipeline to a provider-neutral execution boundary.
 *
 * See `docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md` for the design.
 * The two things to know from here: composing this changes nothing about any
 * flow that does not compose it, and nothing composed here can authorize.
 */
export {
  GRANT_AUTHORITY_BINDING_FORMAT,
  GRANT_BOUNDED_AUTHORITY_KINDS,
  GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS,
  grantAuthorityBindingDigest,
  grantValidityCeilingsFor,
  isWellFormedGrantAuthorityBinding,
  serializeGrantAuthorityBinding,
} from './authority-binding.js';
export type { GrantAuthorityBinding, GrantBoundedAuthorityKind, GrantUnboundedAuthoritySourceKind } from './authority-binding.js';

export { AUTHORITY_BINDING_REASON_CODES, AUTHORITY_BINDING_REASON_CODE_VALUES } from './contracts.js';
export type {
  AuthorityBindingReasonCode,
  AuthorityControlledAuthorizationInput,
  AuthorityControlledAuthorizationOutcome,
  ExecutionKernelPort,
  GrantAuthorityBindingQuery,
  GrantAuthorityBindingResolver,
} from './contracts.js';

export { assertValidExerciseControlCallbacks, assertValidExerciseControlStore, exerciseAuthorityBindingDigestResolver } from './exercise-controls.js';
export type { AuthorityControlledExerciseControls, ExerciseAuthorityBindingResolver } from './exercise-controls.js';

export { ExecutionGovernanceError, isExecutionGovernanceError } from './errors.js';
export type { ExecutionGovernanceErrorCode } from './errors.js';

export { createAuthorityControlledExecution } from './service.js';
export type {
  AuthorityControlledExecutionOptions,
  AuthorityControlledExecutionService,
  RevokeBoundedGrantRequest,
  RevokeBoundedGrantResult,
} from './service.js';
