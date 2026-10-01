import { EnterpriseHttpError, EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import type { EnterpriseAdministrator, EnterpriseApiKey, EnterpriseOperator } from '../configuration/enterprise-configuration.js';
import { extractBearerToken, matchApiKey } from '../orchestration/credential-matching.js';
import { isOperatorRole, LEGACY_ADMINISTRATOR_ROLE, operatorMay, type OperatorPermission, type OperatorRoleOrLegacy } from './roles.js';

/**
 * CTRL-02 — the canonical, immutable runtime identity of an operator-plane
 * caller.
 *
 * Built only from server configuration, after a constant-time credential
 * match. It deliberately carries **no** credential, no caller-stated flag, no
 * permission list and no authority: what the operator may do is asked of the
 * permission policy (`roles.ts`) each time, and what authority exists is the
 * Kernel Authority's to say. `organizationId` is the one organization the Host
 * serves — never a value any request named.
 */
export interface EnterpriseOperatorPrincipal {
  readonly plane: 'operator';
  readonly operatorId: string;
  readonly organizationId: string;
  readonly role: OperatorRoleOrLegacy;
  /** `operator`: a CTRL-02 operator with a configured role. `legacy-administrator`: a CTRL-01 administrator credential, held to exactly its CTRL-01 powers. */
  readonly credentialClass: 'operator' | 'legacy-administrator';
  /** What every store records as the actor of a write: the operator plane, then the operator. The same spelling CTRL-01 records. */
  readonly actorRef: string;
}

/**
 * The one operator-plane authentication and authorization step.
 *
 * ```
 * Authorization header
 *   └─ Bearer credential?                          no / malformed            → 401
 *       └─ operator or administrator credential?   no, but an ordinary key   → 403
 *           │                                      no                        → 401
 *           └─ Host ready?                                                   → 503
 *               └─ role holds the permission?      no                        → 403 OPERATOR_PERMISSION_DENIED
 * ```
 *
 * Called before a request body is read, so a refused caller's body is never
 * read, parsed or validated.
 */
export interface OperatorAuthenticator {
  readonly organizationId: string;
  authorize(authorizationHeader: string | undefined, permission: OperatorPermission): EnterpriseOperatorPrincipal;
}

export interface OperatorAuthenticatorOptions {
  /** CTRL-01 administrators: the `legacy-administrator` compatibility class. */
  readonly administrators: readonly EnterpriseAdministrator[];
  /** CTRL-02 operators, each with one role from the closed model. */
  readonly operators: readonly EnterpriseOperator[];
  /** Every ordinary credential the Host accepts elsewhere — used only to tell 403 (authenticated, wrong plane) from 401. */
  readonly ordinaryCredentials: readonly EnterpriseApiKey[];
  readonly organizationId: string;
  readonly isReady: () => boolean;
  readonly lifecycleState: () => string;
}

function permissionDenied(permission: OperatorPermission): EnterpriseHttpError {
  return new EnterpriseHttpError(403, 'OPERATOR_PERMISSION_DENIED', `This operator's role does not hold the '${permission}' permission. Nothing was read or changed.`);
}

export function createOperatorAuthenticator(options: OperatorAuthenticatorOptions): OperatorAuthenticator {
  const { organizationId } = options;
  // Identities are snapshotted and frozen here; secrets live only in the key
  // objects the constant-time matcher compares, and leave this module never.
  const identities = new Map<EnterpriseApiKey, Omit<EnterpriseOperatorPrincipal, 'plane' | 'organizationId' | 'actorRef'>>();
  const planeKeys: EnterpriseApiKey[] = [];
  const seenOperatorIds = new Set<string>();
  for (const administrator of options.administrators) {
    if (seenOperatorIds.has(administrator.operatorId)) throw new Error('createOperatorAuthenticator: an operator id is configured twice.');
    seenOperatorIds.add(administrator.operatorId);
    const key: EnterpriseApiKey = { key: administrator.key };
    planeKeys.push(key);
    identities.set(key, { operatorId: administrator.operatorId, role: LEGACY_ADMINISTRATOR_ROLE, credentialClass: 'legacy-administrator' });
  }
  for (const operator of options.operators) {
    if (!isOperatorRole(operator.role)) throw new Error('createOperatorAuthenticator: an operator names a role outside the closed operator role model.');
    if (seenOperatorIds.has(operator.operatorId)) throw new Error('createOperatorAuthenticator: an operator id is configured twice.');
    seenOperatorIds.add(operator.operatorId);
    const key: EnterpriseApiKey = { key: operator.key };
    planeKeys.push(key);
    identities.set(key, { operatorId: operator.operatorId, role: operator.role, credentialClass: 'operator' });
  }
  if (planeKeys.length === 0) throw new Error('createOperatorAuthenticator: at least one administrator or operator is required.');
  const ordinaryKeys = options.ordinaryCredentials.map((apiKey) => ({ key: apiKey.key }));

  return Object.freeze({
    organizationId,
    authorize(authorizationHeader: string | undefined, permission: OperatorPermission): EnterpriseOperatorPrincipal {
      const token = typeof authorizationHeader === 'string' ? extractBearerToken(authorizationHeader) : undefined;
      if (token === undefined) throw EnterpriseHttpErrors.authenticationFailed('An operator Bearer credential is required.');
      // Both lookups always run, so timing does not reveal which kind of secret was presented.
      const matched = matchApiKey(token, planeKeys);
      const ordinary = matchApiKey(token, ordinaryKeys);
      const identity = matched === undefined ? undefined : identities.get(matched);
      if (identity === undefined) {
        if (ordinary !== undefined) throw EnterpriseHttpErrors.authorizationFailed('This credential is not authorized on the operator plane.');
        throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');
      }
      if (!options.isReady()) throw EnterpriseHttpErrors.enterpriseNotReady(options.lifecycleState());
      if (!operatorMay(identity.role, permission)) throw permissionDenied(permission);
      return Object.freeze({
        plane: 'operator' as const,
        operatorId: identity.operatorId,
        organizationId,
        role: identity.role,
        credentialClass: identity.credentialClass,
        actorRef: `operator:${identity.operatorId}`,
      });
    },
  });
}
