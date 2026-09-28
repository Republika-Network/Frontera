/**
 * CTRL-01 — authority administration: the supported operator surface for
 * inspecting and revoking existing authority and for emergency control. See
 * `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`.
 */
export { createAuthorityAdministrationService } from './service.js';
export type { AdministrationBodyReader, AuthorityAdministrationDependencies, AuthorityAdministrationService } from './service.js';
export {
  ADMIN_EMERGENCY_CONTROL_SCOPES,
  ADMIN_MAX_BODY_BYTES,
  ADMIN_MAX_REASON_LENGTH,
  isCanonicalGrantId,
  validateAuthorityEntityRevocationRequest,
  validateEmergencyControlTarget,
  validateGrantRevocationRequest,
} from './contracts.js';
export type {
  AdministeredAuthorityEntityView,
  AdministeredExecutionGrantView,
  AdministeredGrantBound,
  AdministeredGrantRevocation,
  AdministeredGrantView,
  AdministrativeRevocationOutcome,
  AuthorityEntityRevocationRequest,
  AuthorityEntityRevocationResponse,
  EmergencyControlTarget,
  EmergencyControlTransitionResponse,
  EmergencyControlsView,
  GrantRevocationRequest,
  GrantRevocationResponse,
} from './contracts.js';
