import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import type { EnterpriseConfiguration, EnterpriseServicePrincipal } from '../configuration/enterprise-configuration.js';
import { CUSTOMER_IDENTITY_REFUSAL_REASONS, type CustomerIdentityAdmissionService } from '../customer-identity/contracts.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { readRecordedAttribution, sameRequester } from '../governance-store/attribution.js';
import {
  GOVERNANCE_ATTRIBUTION_VERSION,
  type GovernanceEvaluationAttribution,
  type GovernanceRecord,
  type GovernanceStoreAccessContext,
} from '../governance-store/contracts.js';
import { extractBearerToken, matchApiKey } from './credential-matching.js';

/**
 * G-01A — trusted identity and attribution for the advisory evaluate route
 * (`POST /api/governance/evaluate`).
 *
 * The body of an evaluation names an actor and an organization. Before G-01A
 * those names were trusted because the request was authenticated; here they
 * are only claims, checked against what the credential establishes:
 *
 * * a **customer principal** (a key carrying `customerIdentity`) is resolved
 *   through the existing customer identity admission — credential → principal
 *   → organization → Kernel Authority binding → actor — and the body must name
 *   exactly that organization, that actor and the Host's trust domain;
 * * a **service principal** may name only an actor on its explicit allow-list,
 *   in its one organization, in the Host's trust domain, and is recorded as
 *   the requester, apart from the actor it evaluated;
 * * a **legacy key** keeps its v1 meaning, except that a scoped key must state
 *   its own organization, and an unscoped key exists only in `compat` mode. The
 *   actor it names is recorded as asserted, never as authenticated.
 *
 * Nothing here is a second identity subsystem: customer identity is admission's
 * answer, credentials are matched by the canonical constant-time matcher, and
 * no Kernel, grant or governed-action code is reached.
 */

/** Who presented the credential — resolved from the credential and configuration alone. */
export type AdvisoryCaller =
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'legacy'; readonly organizationId?: string }
  | { readonly kind: 'customer'; readonly organizationId: string }
  | { readonly kind: 'service'; readonly principal: EnterpriseServicePrincipal };

/** The scope a caller's evaluation is stored under, and the attribution sealed with it. */
export interface AdvisoryIdentity {
  readonly accessContext: GovernanceStoreAccessContext;
  /** Absent only for an unauthenticated caller (authentication disabled): such a record carries no identity. */
  readonly attribution?: GovernanceEvaluationAttribution;
}

export interface AdvisoryIdentityDependencies {
  readonly configuration: EnterpriseConfiguration;
  /** The composed customer identity admission. Absent, a customer-plane credential cannot evaluate: it is refused, never downgraded to a legacy key. */
  readonly customerIdentityAdmission?: CustomerIdentityAdmissionService;
  /** The trusted Host trust domain (the governed-action configuration's). Absent, no customer or service principal can evaluate. */
  readonly trustDomainId?: string;
}

function scopedOrganizationOf(caller: AdvisoryCaller): string | undefined {
  switch (caller.kind) {
    case 'legacy':
      return caller.organizationId;
    case 'customer':
      return caller.organizationId;
    case 'service':
      return caller.principal.organizationId;
    case 'unauthenticated':
      return undefined;
  }
}

/**
 * Authentication — before the body is validated, exactly where v1 put it. A
 * missing or unknown credential is a 401; a scoped credential naming another
 * organization is the v1 403. Every configured secret, legacy and service
 * alike, is compared on every call.
 */
export function authenticateAdvisoryCaller(authorizationHeader: string | undefined, candidateOrganizationId: string | undefined, configuration: EnterpriseConfiguration): AdvisoryCaller {
  if (!configuration.features.requireAuthentication) return { kind: 'unauthenticated' };

  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) throw EnterpriseHttpErrors.authenticationFailed('A Bearer token is required.');

  const matchedKey = matchApiKey(token, configuration.authentication.apiKeys);
  const matchedService = matchApiKey(token, configuration.authentication.servicePrincipals ?? []);
  // One secret authenticates one caller; composition refuses a shared secret,
  // and a configuration that still holds one admits neither.
  if (matchedKey !== undefined && matchedService !== undefined) throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');

  let caller: AdvisoryCaller;
  if (matchedService !== undefined) {
    caller = { kind: 'service', principal: matchedService };
  } else if (matchedKey === undefined) {
    throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');
  } else if (matchedKey.customerIdentity !== undefined && matchedKey.organizationId !== undefined && matchedKey.organizationId.length > 0) {
    caller = { kind: 'customer', organizationId: matchedKey.organizationId };
  } else if (matchedKey.customerIdentity !== undefined) {
    // A customer identity without an organization is malformed configuration; it is never a legacy key.
    throw EnterpriseHttpErrors.authorizationFailed('This credential is not authorized to evaluate.');
  } else {
    const organizationId = matchedKey.organizationId !== undefined && matchedKey.organizationId.length > 0 ? matchedKey.organizationId : undefined;
    if (organizationId === undefined && configuration.authentication.legacyKeyMode === 'restricted') {
      throw EnterpriseHttpErrors.authorizationFailed('An unscoped credential is not accepted while legacy keys are restricted.');
    }
    caller = { kind: 'legacy', ...(organizationId !== undefined ? { organizationId } : {}) };
  }

  const scoped = scopedOrganizationOf(caller);
  if (scoped !== undefined && candidateOrganizationId !== undefined && scoped !== candidateOrganizationId) {
    throw EnterpriseHttpErrors.authorizationFailed(`This credential is not authorized for organization '${candidateOrganizationId}'.`);
  }
  return caller;
}

function requireStatedOrganization(request: KernelEvaluationRequest, organizationId: string): void {
  // Omission is not an implicit match: an organization-bound credential evaluates only in the organization it states.
  if (request.organization?.id !== organizationId) {
    throw EnterpriseHttpErrors.authorizationFailed('This credential is scoped to an organization; the request must name that organization.');
  }
}

function requireTrustedTrustDomain(request: KernelEvaluationRequest, trustDomainId: string | undefined): void {
  if (trustDomainId === undefined || request.actor.trustDomainId !== trustDomainId) {
    throw EnterpriseHttpErrors.authorizationFailed('The request must name this Host’s trust domain.');
  }
}

/**
 * Authorization of the body's claims against the authenticated caller, after
 * validation. Returns the scope the Store is called under and the attribution
 * the record is sealed with; throws a v1 401/403/503 otherwise. Nothing is
 * written on any refusal.
 */
export async function establishAdvisoryIdentity(caller: AdvisoryCaller, authorizationHeader: string | undefined, request: KernelEvaluationRequest, deps: AdvisoryIdentityDependencies): Promise<AdvisoryIdentity> {
  const organizationId = request.organization?.id;
  const actorId = request.actor.id;
  switch (caller.kind) {
    case 'unauthenticated':
      return { accessContext: { system: true, ...(organizationId !== undefined ? { organizationId } : {}), actorId } };

    case 'legacy': {
      if (caller.organizationId !== undefined) {
        requireStatedOrganization(request, caller.organizationId);
        return {
          accessContext: { system: false, organizationId: caller.organizationId, actorId },
          attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'organization', organizationId: caller.organizationId, evaluatedActorId: actorId },
        };
      }
      return {
        accessContext: { system: true, ...(organizationId !== undefined ? { organizationId } : {}), actorId },
        attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'unscoped', ...(organizationId !== undefined ? { organizationId } : {}), evaluatedActorId: actorId },
      };
    }

    case 'customer': {
      const admission = deps.customerIdentityAdmission;
      if (admission === undefined) throw EnterpriseHttpErrors.authorizationFailed('Customer-plane credentials evaluate only where customer identity admission is composed.');
      const admitted = await admission.admit({ ...(authorizationHeader !== undefined ? { authorizationHeader } : {}) });
      if (admitted.status === 'unavailable') throw EnterpriseHttpErrors.providerUnavailable('The caller’s identity could not be resolved.');
      if (admitted.status === 'refused') {
        const unauthenticated =
          admitted.reason === CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_REQUIRED ||
          admitted.reason === CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_MALFORMED ||
          admitted.reason === CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_INVALID;
        throw unauthenticated ? EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.') : EnterpriseHttpErrors.authorizationFailed('The caller has no bound identity to evaluate as.');
      }
      const { principal, actor } = admitted.identity;
      if (principal.plane !== 'customer' || principal.organizationId !== caller.organizationId) {
        throw EnterpriseHttpErrors.authorizationFailed('The caller has no bound identity to evaluate as.');
      }
      requireStatedOrganization(request, principal.organizationId);
      if (actorId !== actor.actorId) throw EnterpriseHttpErrors.authorizationFailed('A customer principal may evaluate only as the actor it is bound to.');
      requireTrustedTrustDomain(request, deps.trustDomainId);
      return {
        accessContext: { system: false, organizationId: principal.organizationId, actorId },
        attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: principal.organizationId, requestingPrincipalId: principal.principalId, evaluatedActorId: actorId },
      };
    }

    case 'service': {
      const { principal } = caller;
      requireStatedOrganization(request, principal.organizationId);
      if (!principal.onBehalfOfActors.includes(actorId)) throw EnterpriseHttpErrors.authorizationFailed('This service principal may not evaluate on behalf of that actor.');
      requireTrustedTrustDomain(request, deps.trustDomainId);
      return {
        accessContext: { system: false, organizationId: principal.organizationId, actorId },
        attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'service-principal', organizationId: principal.organizationId, requestingPrincipalId: principal.principalId, evaluatedActorId: actorId },
      };
    }
  }
}

/**
 * Whether a stored decision may answer this caller as an idempotent replay.
 *
 * Only the requester that committed it: the same basis, principal (or legacy
 * scope), organization and actor. A record with no attribution — committed
 * before G-01A, or with authentication disabled — carries no authenticated
 * identity, so it never answers a customer or service principal: it is not
 * adopted by them, and it is not promoted by being returned. It still answers
 * a legacy or unauthenticated caller exactly as it did before G-01A.
 */
export function mayReplayTo(record: GovernanceRecord, attribution: GovernanceEvaluationAttribution | undefined): boolean {
  const recorded = readRecordedAttribution(record);
  if (recorded.status === 'unreadable') return false;
  if (recorded.status === 'unattributed') return attribution === undefined || attribution.basis === 'legacy-asserted';
  return attribution !== undefined && sameRequester(recorded.attribution, attribution);
}

/** Thrown when a configured service principal could never be a safe, unambiguous requester. */
export class ServicePrincipalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServicePrincipalConfigurationError';
  }
}

/**
 * Composition-time check of `authentication.servicePrincipals`, so an embedder
 * that bypasses the Host's file parser still cannot compose a weaker service
 * principal: the served organization only, an explicit non-empty allow-list of
 * exact actor ids, one identity per principal id, one secret per caller.
 */
export function assertServicePrincipalConfiguration(configuration: EnterpriseConfiguration, servedOrganizationId: string): void {
  const servicePrincipals = configuration.authentication.servicePrincipals ?? [];
  const customerPrincipalIds = new Set(configuration.authentication.apiKeys.flatMap((apiKey) => (apiKey.customerIdentity !== undefined ? [apiKey.customerIdentity.principalId] : [])));
  const secrets = new Set(configuration.authentication.apiKeys.map((apiKey) => apiKey.key));
  const principalIds = new Set<string>();
  servicePrincipals.forEach((servicePrincipal, index) => {
    const where = `Service principal #${index}`;
    if (!isCanonicalCustomerIdentifier(servicePrincipal.principalId)) throw new ServicePrincipalConfigurationError(`${where} has a malformed principalId.`);
    if (servicePrincipal.organizationId !== servedOrganizationId) throw new ServicePrincipalConfigurationError(`${where} is not scoped to the organization this instance serves.`);
    if (principalIds.has(servicePrincipal.principalId) || customerPrincipalIds.has(servicePrincipal.principalId)) {
      throw new ServicePrincipalConfigurationError(`${where} reuses a principal id; one principal id names one identity.`);
    }
    principalIds.add(servicePrincipal.principalId);
    if (typeof servicePrincipal.key !== 'string' || servicePrincipal.key.length === 0 || secrets.has(servicePrincipal.key)) {
      throw new ServicePrincipalConfigurationError(`${where} has an empty secret or one shared with another credential.`);
    }
    secrets.add(servicePrincipal.key);
    const actors = servicePrincipal.onBehalfOfActors;
    if (!Array.isArray(actors) || actors.length === 0 || actors.some((actor) => !isCanonicalCustomerIdentifier(actor) || actor.includes('*')) || new Set(actors).size !== actors.length) {
      throw new ServicePrincipalConfigurationError(`${where} must list at least one exact, distinct actor id; there is no implicit or wildcard delegation.`);
    }
  });
}
