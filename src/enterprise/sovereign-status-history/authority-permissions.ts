import { canonicalInstant, isDigest, isIdentifier } from './bootstrap-contract.js';

/**
 * FV-P4C-2B2B (B4) — the two narrow permissions of a sovereign status history
 * bootstrap, answered from the Host's durable Kernel-Authority world.
 *
 * | Permission | Allows |
 * |---|---|
 * | `status-history.bootstrap.request` | signing the requester attestation for one exact bootstrap binding |
 * | `status-history.bootstrap.approve` | signing the independent approval of that same binding, as another human |
 *
 * **Where a grant lives.** A permission is a Kernel-Authority authority grant
 * (or a delegation of one) whose `actions` name it, over the resource scope
 * `statusHistoryResourceScope(namespace)` (or its parent
 * `frontera.sovereign-status-history`, by Kernel-Authority's own scope
 * containment). It is provisioned explicitly, per human, through the
 * existing operator provisioning surface; it is revocable, may expire, is
 * organization- and trust-domain-scoped, and is lineage-checked on every
 * read. Actions match exactly: no wildcard, no implication between the two.
 *
 * **Why not CTRL-02.** CTRL-02's `OPERATOR_PERMISSIONS` is role-based, with
 * no per-human grant, no resource dimension, and `organization-administrator`
 * defined as *every* permission. Adding these names there would grant both to
 * every organization administrator implicitly — the inheritance this
 * permission must not have. CTRL-02 is therefore unchanged, and holding any
 * CTRL-02 role (administrator included) confers neither permission.
 *
 * **What neither permission allows.** Each authorizes one signed decision
 * over one binding, inside a coordinator that offers no reset, conflict
 * clearing, withdrawal reopening, retired-terms revival, sequence or time
 * floor downgrade, database replacement or source-verification bypass. No
 * such operation exists to be reached, so no permission can reach it.
 *
 * Answers are `true` only for a recognized actor with a valid, live grant at
 * the Host's trusted instant. Every other answer, a throw included, is
 * `false` (the authorizer treats a throw as `PERMISSION_SERVICE_FAILED`).
 */

export const STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION = 'status-history.bootstrap.request' as const;
export const STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION = 'status-history.bootstrap.approve' as const;
export const STATUS_HISTORY_BOOTSTRAP_PERMISSIONS = Object.freeze([STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION, STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION] as const);
export type StatusHistoryBootstrapPermission = (typeof STATUS_HISTORY_BOOTSTRAP_PERMISSIONS)[number];

/** The Kernel-Authority resource scope root of every status history. */
export const STATUS_HISTORY_RESOURCE_SCOPE = 'frontera.sovereign-status-history' as const;

/**
 * The resource scope of one receiver namespace's history:
 * `frontera.sovereign-status-history:<encodeURIComponent(namespace)>`.
 *
 * Review fix: Kernel-Authority scope containment is `:`-hierarchical
 * (`requested === scope || requested.startsWith(scope + ':')`), and namespaces
 * may contain `:` (`receiver:acme`). Unencoded, a grant for namespace
 * `receiver` would also cover `receiver:acme`. Encoded, `:` becomes `%3A`, so a
 * namespace scope covers exactly that namespace; only the root scope covers
 * every namespace, explicitly.
 */
export function statusHistoryResourceScope(namespace: string): string {
  if (!isIdentifier(namespace, 256)) throw new TypeError('A receiver namespace is a non-empty identifier.');
  return `${STATUS_HISTORY_RESOURCE_SCOPE}:${encodeURIComponent(namespace)}`;
}

/**
 * What a permission is asked for: the organization, the receiver namespace and the binding. A grant is
 * namespace-wide: the binding digest is format-checked and passed for audit context, but no
 * Kernel-Authority grant is per binding.
 */
export interface BootstrapPermissionScope {
  readonly organizationId: string;
  readonly namespace: string;
  readonly bindingDigest: string;
}

/**
 * Structurally, the Host's approver-standing port (CORE-05's
 * `ApprovalAuthorityPort`, answered from the durable Kernel-Authority world,
 * with lineage revalidation). Read through this shape so this module imports
 * nothing of the Host.
 */
export interface BootstrapStandingPort {
  recognition(actorId: string): { readonly recognized: boolean };
  authority(query: { readonly actorId: string; readonly capability: string; readonly resourceScope: string; readonly at: string }): { readonly valid: boolean };
}

/** Who may request and who may approve, by the Host's own records. */
export interface BootstrapHumanPermissions {
  mayRequest(operatorId: string, scope: BootstrapPermissionScope): boolean;
  mayApprove(operatorId: string, scope: BootstrapPermissionScope): boolean;
}

export interface KernelAuthorityBootstrapPermissionsOptions {
  readonly standing: BootstrapStandingPort;
  /** The one organization this Host serves. A scope naming another is refused. */
  readonly organizationId: string;
  /** The Host's trusted clock, as a canonical UTC instant. Never a caller's. */
  readonly now: () => string;
}

const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function createKernelAuthorityBootstrapPermissions(options: KernelAuthorityBootstrapPermissionsOptions): BootstrapHumanPermissions {
  const { standing, organizationId, now } = options;
  const recognition = standing.recognition.bind(standing);
  const authority = standing.authority.bind(standing);
  if (!isIdentifier(organizationId, 256)) throw new TypeError('The organization id is a non-empty identifier.');

  const holds = (permission: StatusHistoryBootstrapPermission, operatorId: unknown, scope: unknown): boolean => {
    if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId)) return false;
    if (typeof scope !== 'object' || scope === null) return false;
    const { organizationId: scopeOrganization, namespace, bindingDigest } = scope as Partial<BootstrapPermissionScope>;
    if (scopeOrganization !== organizationId || typeof namespace !== 'string' || !isIdentifier(namespace, 256) || !isDigest(bindingDigest)) return false;
    const at = now();
    if (canonicalInstant(at) === undefined) return false;
    const actorId = `operator:${operatorId}`;
    // Both answers are read as exactly `true`: anything else, a truthy string included, refuses.
    if (recognition(actorId)?.recognized !== true) return false;
    return authority({ actorId, capability: permission, resourceScope: statusHistoryResourceScope(namespace), at })?.valid === true;
  };

  return Object.freeze({
    mayRequest: (operatorId: string, scope: BootstrapPermissionScope) => holds(STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION, operatorId, scope),
    mayApprove: (operatorId: string, scope: BootstrapPermissionScope) => holds(STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, operatorId, scope),
  });
}
