import {
  requireDestinationApprovalTarget,
  type ApproveDestinationResult,
  type DestinationApprovalHistoryEntry,
  type DestinationApprovalState,
  type DestinationApprovalStorePort,
  type DestinationGovernanceAuthority,
  type RevokeDestinationResult,
} from '../../features/destination-runtime/approval/index.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import type { OperatorPermission } from '../operator-control/roles.js';

/**
 * The destination approval administrative service (ANDREW-P0-03).
 *
 * ```
 * Authorization header
 *   └─ CTRL-02 OperatorAuthenticator.authorize(header, permission)   401 / 403 / 503, body never read
 *       └─ EnterpriseOperatorPrincipal (server configuration only)
 *           └─ DestinationGovernanceAuthority { organizationId, actorRef, authorityBasis }
 *               └─ DestinationApprovalStorePort.approve / revoke / read / history
 * ```
 *
 * The one place a `DestinationGovernanceAuthority` is built. Its organization
 * is the principal's — the one organization the Host serves — and its actor
 * and basis are the principal's identity, role and the permission it was
 * authorized under. A command states a destination, optional terms and an
 * idempotency key, and nothing else: it cannot name an organization, an
 * approver, a basis or a state, because the store refuses any such field.
 *
 * | operation | permission | held by |
 * | --- | --- | --- |
 * | `approveDestination` | `destination.approve` (widens) | organization-administrator |
 * | `revokeDestination` | `destination.revoke` (narrows) | organization-administrator, responder |
 * | `readDestinationApproval`, `destinationApprovalHistory` | `inventory.read` | every CTRL-02 role |
 *
 * Permissions are decided by `roles.ts` through the authenticator, never here.
 * No HTTP route reaches this yet, and it is not composed into the Host: see
 * `docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md` §15.
 */
export interface DestinationApprovalAdministration {
  approveDestination(authorizationHeader: string | undefined, command: unknown): ApproveDestinationResult;
  revokeDestination(authorizationHeader: string | undefined, command: unknown): RevokeDestinationResult;
  /** `{ destination }` — the organization is the caller's, never stated. */
  readDestinationApproval(authorizationHeader: string | undefined, request: unknown): DestinationApprovalState;
  destinationApprovalHistory(authorizationHeader: string | undefined, request: unknown): readonly DestinationApprovalHistoryEntry[];
}

export interface CreateDestinationApprovalAdministrationOptions {
  readonly authenticator: Pick<OperatorAuthenticator, 'authorize'>;
  readonly store: DestinationApprovalStorePort;
}

/**
 * Why this actor could make this decision, from trusted fields only:
 * `operator-permission:<permission>;role:<role>;credential:<class>`.
 */
function authorityBasisOf(principal: EnterpriseOperatorPrincipal, permission: OperatorPermission): string {
  return `operator-permission:${permission};role:${principal.role};credential:${principal.credentialClass}`;
}

export function createDestinationApprovalAdministration(options: CreateDestinationApprovalAdministrationOptions): DestinationApprovalAdministration {
  const { authenticator, store } = options;
  if (typeof authenticator?.authorize !== 'function') throw new TypeError('createDestinationApprovalAdministration: an operator authenticator is required.');
  if (typeof store?.approve !== 'function') throw new TypeError('createDestinationApprovalAdministration: a destination approval store is required.');

  function authorityFor(authorizationHeader: string | undefined, permission: OperatorPermission): DestinationGovernanceAuthority {
    const principal = authenticator.authorize(authorizationHeader, permission);
    return Object.freeze({ authenticated: true, organizationId: principal.organizationId, actorRef: principal.actorRef, authorityBasis: authorityBasisOf(principal, permission) });
  }

  return Object.freeze({
    approveDestination(authorizationHeader: string | undefined, command: unknown): ApproveDestinationResult {
      // Authorized before the command is looked at.
      const authority = authorityFor(authorizationHeader, 'destination.approve');
      return store.approve(authority, command as never);
    },

    revokeDestination(authorizationHeader: string | undefined, command: unknown): RevokeDestinationResult {
      const authority = authorityFor(authorizationHeader, 'destination.revoke');
      return store.revoke(authority, command as never);
    },

    readDestinationApproval(authorizationHeader: string | undefined, request: unknown): DestinationApprovalState {
      const principal = authenticator.authorize(authorizationHeader, 'inventory.read');
      const { destination } = requireDestinationApprovalTarget(request);
      return store.read({ organizationId: principal.organizationId, destination });
    },

    destinationApprovalHistory(authorizationHeader: string | undefined, request: unknown): readonly DestinationApprovalHistoryEntry[] {
      const principal = authenticator.authorize(authorizationHeader, 'inventory.read');
      const { destination } = requireDestinationApprovalTarget(request);
      return store.history({ organizationId: principal.organizationId, destination });
    },
  });
}
