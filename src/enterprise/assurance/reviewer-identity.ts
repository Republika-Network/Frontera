import { matchApiKey } from '../orchestration/credential-matching.js';
import type { AssuranceReviewerPrincipal } from './contracts.js';

/**
 * Authenticated reviewer identity (ASSURE-SEC-01B).
 *
 * A manual review is attributed to an Assurance reviewer credential -- a
 * dedicated secret configured for one reviewer, in one organization, with an
 * explicit role list -- and to nothing a request states. Like auditors and
 * CTRL-02 operators, the credential is never an `EnterpriseApiKey`: an
 * organization key, an operator, an administrator, an auditor or the system
 * context authenticates no reviewer and holds no reviewer role.
 *
 * Trust boundary. A principal is trusted only if THIS authenticator issued it
 * (a private `WeakSet`), and the authenticator issues one only for a bearer
 * token equal to a configured secret. An object of the same shape built by
 * any caller -- `{ reviewerId, roles: ['assure.reviewer'] }` from a request
 * body, or a context claiming `system: true` -- is not recognised. What the
 * types cannot guarantee: in-process code that holds a configured secret can
 * authenticate as that reviewer; the secret is the credential.
 */

export interface AssuranceReviewerCredential {
  readonly reviewerId: string;
  readonly organizationId: string;
  /** Explicit roles, e.g. `assure.reviewer`. Never inferred, never widened by a request. */
  readonly roles: readonly string[];
  readonly key: string;
}

export interface AssuranceReviewerAuthenticator {
  /** The principal for a configured reviewer secret, or `undefined`. Constant-time comparison against every configured secret. */
  authenticate(bearerToken: string): AssuranceReviewerPrincipal | undefined;
  /** Whether `principal` was issued by this authenticator. Structural look-alikes are not. */
  isAuthenticated(principal: unknown): principal is AssuranceReviewerPrincipal;
}

export function createAssuranceReviewerAuthenticator(credentials: readonly AssuranceReviewerCredential[]): AssuranceReviewerAuthenticator {
  const configured = credentials.map((credential) => Object.freeze({ ...credential, roles: Object.freeze([...credential.roles]) }));
  const issued = new WeakSet<object>();
  return {
    authenticate(bearerToken) {
      const matched = matchApiKey(bearerToken, configured);
      if (matched === undefined) return undefined;
      const principal: AssuranceReviewerPrincipal = Object.freeze({
        credentialClass: 'assurance-reviewer',
        reviewerId: matched.reviewerId,
        organizationId: matched.organizationId,
        roles: matched.roles,
      });
      issued.add(principal);
      return principal;
    },
    isAuthenticated(principal): principal is AssuranceReviewerPrincipal {
      return typeof principal === 'object' && principal !== null && issued.has(principal);
    },
  };
}
