import type { EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import { extractBearerToken, matchApiKey } from '../orchestration/credential-matching.js';
import { CUSTOMER_IDENTITY_REFUSAL_REASONS, type CustomerIdentityRefusalReason, type CustomerPrincipal } from './contracts.js';
import { isCanonicalCustomerExternalSubject, isCanonicalCustomerIdentifier } from './identifiers.js';

export type CustomerAuthenticationResult =
  | { readonly status: 'authenticated'; readonly principal: CustomerPrincipal }
  | { readonly status: 'refused'; readonly reason: CustomerIdentityRefusalReason };

/**
 * Credential → customer principal, for the API-key authenticator.
 *
 * Bearer extraction and key lookup are the Host's canonical
 * `extractBearerToken` / `matchApiKey` — the same constant-time, compare-every-
 * key matcher the legacy routes use. There is no second comparison here.
 *
 * What makes a key customer-plane eligible is decided **after** the
 * constant-time lookup and only from its non-secret configuration: an
 * `organizationId` and a well-formed `customerIdentity` block. A valid legacy
 * key is not a valid customer principal.
 *
 * Nothing here has a fallback. Authentication being disabled for the legacy
 * routes (`AOC_ENTERPRISE_REQUIRE_AUTH=false`) is never consulted, an
 * unscoped key is refused rather than widened to `system`, and no principal
 * can be built without a key that matched.
 *
 * The raw credential never leaves this function: the principal is assembled
 * from configuration fields other than `key`, and no refusal carries text.
 */
export function authenticateCustomerCredential(authorizationHeader: string | undefined, apiKeys: readonly EnterpriseApiKey[]): CustomerAuthenticationResult {
  if (authorizationHeader === undefined || authorizationHeader.trim().length === 0) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_REQUIRED };
  }
  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_MALFORMED };
  }

  const matched = matchApiKey(token, apiKeys);
  if (matched === undefined) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_INVALID };
  }

  const { organizationId, customerIdentity } = matched;
  if (organizationId === undefined || organizationId.length === 0) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_UNSCOPED };
  }
  if (customerIdentity === undefined) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_IDENTITY_NOT_CONFIGURED };
  }
  if (
    !isCanonicalCustomerIdentifier(organizationId) ||
    !isCanonicalCustomerIdentifier(customerIdentity.principalId) ||
    !isCanonicalCustomerExternalSubject(customerIdentity.externalSubject)
  ) {
    return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_IDENTITY_INVALID };
  }

  // Built field by field from configuration, never spread from `matched`: a
  // spread would carry `key` along with it.
  const principal: CustomerPrincipal = Object.freeze({
    plane: 'customer',
    principalId: customerIdentity.principalId,
    organizationId,
    externalSubject: Object.freeze({
      system: customerIdentity.externalSubject.system,
      subjectId: customerIdentity.externalSubject.subjectId,
    }),
  });
  return { status: 'authenticated', principal };
}
