/**
 * CTRL-02 — organizations, human operators and the agent inventory: the
 * operator plane over the existing authoritative services. See
 * `docs/architecture/ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md`.
 */
export { LEGACY_ADMINISTRATOR_ROLE, OPERATOR_PERMISSIONS, OPERATOR_ROLES, isOperatorRole, operatorMay, permissionsOf } from './roles.js';
export type { OperatorPermission, OperatorRole, OperatorRoleOrLegacy } from './roles.js';
export { createOperatorAuthenticator } from './operator-authenticator.js';
export type { EnterpriseOperatorPrincipal, OperatorAuthenticator, OperatorAuthenticatorOptions } from './operator-authenticator.js';
export { createOperatorControlService } from './service.js';
export type { OperatorBodyReader, OperatorControlDependencies, OperatorControlService, OperatorProfileLifecycle, OperatorQuery } from './service.js';
export type {
  AgentCredentialIssueResponse,
  AgentCredentialView,
  AgentInventoryView,
  AuthorityReferenceView,
  OperatorIdentityView,
  OrganizationView,
  ProfileVersionView,
} from './contracts.js';
export { APPROVAL_COMMANDS, APPROVAL_VIEWS, OPERATOR_APPROVAL_CHANNEL, approvalCommandContextFor, createOperatorApprovalService, isApprovalCommandVerb } from './approval-workflow.js';
export type {
  ApprovalCommandResult,
  ApprovalCommandVerb,
  ApprovalDetailView,
  ApprovalInboxItem,
  ApprovalInboxView,
  OperatorApprovalDependencies,
  OperatorApprovalService,
} from './approval-workflow.js';
export type { AgentCredentialRecord, AgentPrincipalRecord, ProfileLifecycleEvent } from './control-plane-store.js';
