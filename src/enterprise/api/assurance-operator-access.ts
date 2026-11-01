import { AssuranceError } from '../assurance/errors.js';
import { RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import { COMMERCIAL_REPORT_RELEASE_ROLE } from '../assurance/commercial-report.js';
import type { AssuranceAccessContext, AssuranceReviewerPrincipal } from '../assurance/contracts.js';
import { extractBearerToken } from '../orchestration/credential-matching.js';
import { EnterpriseHttpErrors } from './enterprise-http-errors.js';

/**
 * ASSURE-REL-01D: who an Assurance HTTP caller is.
 *
 * The operator identity of the Assurance interface is the SEC-01B Assurance
 * reviewer credential -- no new identity system. A principal comes only from
 * `authenticateReviewer` (the service's own authenticator); nothing here builds
 * one, and no request field names the actor.
 *
 *  - Operator routes (evidence, termination, drafts, releases, custody,
 *    verification) accept ONLY a reviewer credential. An organization API key,
 *    an unscoped key, an operator/administrator/auditor secret or the
 *    unauthenticated system context is not a reviewer and is refused (401)
 *    before any body is read.
 *  - The v1 routes (create, view, evaluate, verify, findings, finding events,
 *    signals, reassess) also accept a reviewer credential, tried first; anything
 *    else takes the unchanged v1 path. With `reviewerOnly`, a v1 WRITE accepts a
 *    reviewer credential only.
 *
 * Roles are checked here before the body is read; the service checks them again
 * for every operation that already enforced its own role (reviews, ends,
 * releases).
 */

export const ASSURANCE_OPERATOR_REVIEWER_ROLE = RN_SV_REVIEWER_ROLE;
export const ASSURANCE_OPERATOR_RELEASE_ROLE = COMMERCIAL_REPORT_RELEASE_ROLE;

/** What the reviewer service exposes to this module: authentication only. */
export interface AssuranceReviewerAuthentication {
  authenticateReviewer(bearerToken: string): AssuranceReviewerPrincipal | undefined;
}

export interface AuthenticatedAssuranceReviewer {
  readonly reviewer: AssuranceReviewerPrincipal;
  /** The tenant-scoped context every call runs in: organization, actor and roles from the credential only. */
  readonly context: AssuranceAccessContext;
}

export type AssuranceCaller = ({ readonly kind: 'reviewer' } & AuthenticatedAssuranceReviewer) | { readonly kind: 'v1'; readonly context: AssuranceAccessContext };

function reviewerContextOf(reviewer: AssuranceReviewerPrincipal): AssuranceAccessContext {
  return { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
}

function requireAnyRole(reviewer: AssuranceReviewerPrincipal, anyOf: readonly string[]): void {
  if (anyOf.length > 0 && !anyOf.some((role) => reviewer.roles.includes(role))) {
    throw new AssuranceError('ASSURANCE_REVIEWER_UNAUTHORIZED', `This operation requires an Assurance reviewer holding one of: ${anyOf.join(', ')}.`, { requiredRoles: [...anyOf] });
  }
}

/** The reviewer a bearer credential authenticates, or `undefined` (no bearer, or not a reviewer credential). */
function reviewerFrom(authorizationHeader: string | undefined, authentication: AssuranceReviewerAuthentication): AssuranceReviewerPrincipal | undefined {
  const token = extractBearerToken(authorizationHeader);
  return token === undefined ? undefined : authentication.authenticateReviewer(token);
}

/**
 * An operator route: an authenticated Assurance reviewer holding one of
 * `anyOfRoles`, or nothing. Every non-reviewer credential gets the same 401, so
 * the answer does not reveal whether a token is some other valid credential.
 */
export function requireAssuranceReviewer(
  authorizationHeader: string | undefined,
  authentication: AssuranceReviewerAuthentication,
  anyOfRoles: readonly string[],
): AuthenticatedAssuranceReviewer {
  const reviewer = reviewerFrom(authorizationHeader, authentication);
  if (reviewer === undefined) throw EnterpriseHttpErrors.authenticationFailed('An Assurance reviewer credential (Bearer) is required for this operation.');
  requireAnyRole(reviewer, anyOfRoles);
  return { reviewer, context: reviewerContextOf(reviewer) };
}

/**
 * A v1 Assurance route. A reviewer credential is tried first (a write needs
 * `assure.reviewer`); otherwise `resolveV1` -- the unchanged organization-key /
 * system resolution -- runs, unless this is a write on a reviewer-only Host.
 */
export function resolveAssuranceCaller(
  authorizationHeader: string | undefined,
  authentication: AssuranceReviewerAuthentication,
  access: 'read' | 'write',
  reviewerOnly: boolean,
  resolveV1: () => AssuranceAccessContext,
): AssuranceCaller {
  const reviewer = reviewerFrom(authorizationHeader, authentication);
  if (reviewer !== undefined) {
    if (access === 'write') requireAnyRole(reviewer, [ASSURANCE_OPERATOR_REVIEWER_ROLE]);
    return { kind: 'reviewer', reviewer, context: reviewerContextOf(reviewer) };
  }
  if (access === 'write' && reviewerOnly) {
    throw EnterpriseHttpErrors.authenticationFailed('This Host accepts Assurance writes only from an Assurance reviewer credential (Bearer).');
  }
  return { kind: 'v1', context: resolveV1() };
}

/**
 * The actor of a reviewer-authenticated write: always the reviewer. A declared
 * value (`requestedBy`, `actorId`, `approvedBy`) may restate it; any other value
 * is refused, never silently replaced (the SEC-01B rule for `reviewerId`).
 */
export function bindDeclaredActor(declared: unknown, reviewer: AssuranceReviewerPrincipal, field: string): string {
  if (declared !== undefined && declared !== reviewer.reviewerId) {
    throw new AssuranceError('ASSURANCE_REVIEWER_UNAUTHORIZED', `The declared ${field} is not the authenticated reviewer; an action cannot be attributed to someone else.`, { field });
  }
  return reviewer.reviewerId;
}
