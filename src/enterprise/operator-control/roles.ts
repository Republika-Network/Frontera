/**
 * CTRL-02 — the closed operator role model and the one permission policy.
 *
 * ```
 * credential ─► authenticated operator principal ─► organization (server) ─► role ─► permission ─► operation
 * ```
 *
 * Roles are derived from the permissions the control plane actually needs, not
 * copied from any product's account model. Two invariants shape them:
 *
 * - **Restriction never implies expansion.** A role that may revoke, disable a
 *   credential or stop execution holds no permission that creates, widens or
 *   restores authority.
 * - **Inspection never implies mutation.** The read-only role holds reads only.
 *
 * The mapping is trusted code: no request, header, query or body can state a
 * role or a permission, and nothing outside this file decides what a role may
 * do. Handlers ask `operatorMay(role, permission)` and nothing else.
 */

/** Every permission the operator plane knows. Closed: a permission not named here does not exist. */
export const OPERATOR_PERMISSIONS = [
  /** Read the served organization and the caller's own identity. */
  'organization.read',
  /** CTRL-01 reads: one bounded grant, one execution's grant, one Kernel-Authority entity, emergency controls. */
  'authority.inspect',
  /** CTRL-02 reads: the agent inventory, authority listings, Governance Profile versions. */
  'inventory.read',
  /** Organization bootstrap: trust domains, root issuers and organization (issuer) actors. */
  'authority.bootstrap',
  /** Standing authority: human and agent actors, passports, capability tokens, authority grants, delegation grants. */
  'authority.provision',
  /** Terminal revocation of a bounded grant or a Kernel-Authority entity. Narrows only. */
  'authority.revoke',
  /** Issue or rotate an agent's customer-plane credential. */
  'agent-credential.manage',
  /** Revoke an agent's customer-plane credential. Narrows only. */
  'agent-credential.revoke',
  /** Activate a Governance Profile version (draft → active). */
  'profile.promote',
  /** Retire a Governance Profile version (→ retired, terminal). */
  'profile.retire',
  /** Declare an emergency stop. Narrows only. */
  'emergency.stop',
  /** Release an emergency stop — restores execution, so it is never a restrict-only permission. */
  'emergency.release',
  /**
   * CTRL-04 — read the approval inbox and one approval request: the canonical
   * subject (actor, action, resource, amount, counterparty, typed parameters),
   * its requirement snapshot and its derived state. Inspection only.
   */
  'approval.read',
  /**
   * CTRL-04 — *attempt* an approving verdict. **Permitting**: never part of a
   * restrict-only role. It confers no approval authority — CORE-05 still
   * requires the operator's own live Kernel-Authority standing for the
   * requirement's approver action over the request's resource.
   */
  'approval.approve',
  /**
   * CTRL-04 — *attempt* a verdict that only narrows or records: reject (final),
   * request changes, escalate (both inert), revoke an approval. Restrict-only:
   * it never implies `approval.approve`. CORE-05 still requires live
   * Kernel-Authority standing.
   */
  'approval.restrict',
] as const;

export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[number];

/**
 * The CTRL-02 operator roles. Closed.
 *
 * - `observer` — inspection only.
 * - `responder` — incident response that only narrows: revoke authority,
 *   revoke an agent credential, declare an emergency stop. It cannot release a
 *   stop, because releasing restores execution.
 * - `provisioner` — onboards agents and assigns standing authority, under every
 *   existing Kernel-Authority rule; may also narrow what it assigned. No
 *   organization bootstrap, no profile promotion, no emergency release.
 * - `profile-steward` — promotes and retires Governance Profile versions. No
 *   authority, no credentials.
 * - `approver` — CTRL-04: reads, the approval inbox, and attempting every
 *   approval verdict. No authority, credentials, profiles or emergency
 *   control. The role only lets an operator *reach* the approval commands;
 *   whether a verdict counts is CORE-05's, from the operator's own
 *   Kernel-Authority approver standing.
 * - `organization-administrator` — every permission, including organization
 *   bootstrap and emergency release.
 *
 * CTRL-04 approval permissions: `approval.read` is held by `observer`,
 * `responder`, `approver` and `organization-administrator` (not `provisioner`
 * or `profile-steward`: neither needs to see approval subjects);
 * `approval.restrict` by `responder`, `approver`, `organization-administrator`;
 * `approval.approve` by `approver` and `organization-administrator` only.
 */
export const OPERATOR_ROLES = ['observer', 'responder', 'provisioner', 'profile-steward', 'approver', 'organization-administrator'] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/**
 * The CTRL-01 compatibility class. Not an `OperatorRole` — it cannot be
 * configured on an operator — and it holds exactly the powers a CTRL-01
 * administrator had: inspect, revoke, emergency stop and release. Never
 * provisioning, credentials, profiles or the CTRL-02 inventory: a CTRL-01
 * shared administrator secret does not silently become a provisioning
 * credential because CTRL-02 exists. Migration is deliberate: declare the
 * operator under `operators` with a role.
 */
export const LEGACY_ADMINISTRATOR_ROLE = 'legacy-administrator' as const;

export type OperatorRoleOrLegacy = OperatorRole | typeof LEGACY_ADMINISTRATOR_ROLE;

const READ: readonly OperatorPermission[] = ['organization.read', 'authority.inspect', 'inventory.read'];

const POLICY: Readonly<Record<OperatorRoleOrLegacy, ReadonlySet<OperatorPermission>>> = Object.freeze({
  observer: new Set<OperatorPermission>([...READ, 'approval.read']),
  responder: new Set<OperatorPermission>([...READ, 'authority.revoke', 'agent-credential.revoke', 'emergency.stop', 'approval.read', 'approval.restrict']),
  provisioner: new Set<OperatorPermission>([...READ, 'authority.provision', 'authority.revoke', 'agent-credential.manage', 'agent-credential.revoke']),
  'profile-steward': new Set<OperatorPermission>([...READ, 'profile.promote', 'profile.retire']),
  approver: new Set<OperatorPermission>([...READ, 'approval.read', 'approval.approve', 'approval.restrict']),
  'organization-administrator': new Set<OperatorPermission>(OPERATOR_PERMISSIONS),
  [LEGACY_ADMINISTRATOR_ROLE]: new Set<OperatorPermission>(['authority.inspect', 'authority.revoke', 'emergency.stop', 'emergency.release']),
});

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === 'string' && (OPERATOR_ROLES as readonly string[]).includes(value);
}

/** The one authorization decision on the operator plane. Total: an unknown role or permission is `false`. */
export function operatorMay(role: OperatorRoleOrLegacy, permission: OperatorPermission): boolean {
  const granted = Object.prototype.hasOwnProperty.call(POLICY, role) ? POLICY[role] : undefined;
  return granted !== undefined && granted.has(permission);
}

/** Every permission a role holds, in the policy's declared order. For the caller's own `GET /api/admin/organization`. */
export function permissionsOf(role: OperatorRoleOrLegacy): readonly OperatorPermission[] {
  return OPERATOR_PERMISSIONS.filter((permission) => operatorMay(role, permission));
}
