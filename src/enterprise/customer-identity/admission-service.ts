import type { EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import { extractBearerToken } from '../orchestration/credential-matching.js';
import {
  CUSTOMER_IDENTITY_REFUSAL_REASONS,
  CUSTOMER_IDENTITY_UNAVAILABLE_REASONS,
  type BoundCustomerIdentity,
  type CustomerIdentityAdmissionRequest,
  type CustomerIdentityAdmissionResult,
  type CustomerIdentityAdmissionService,
  type CustomerPrincipal,
  type DynamicCustomerCredentialVerifier,
} from './contracts.js';
import { authenticateCustomerCredential } from './customer-authenticator.js';
import { CustomerIdentityConfigurationError } from './errors.js';
import { isCanonicalCustomerExternalSubject, isCanonicalCustomerIdentifier } from './identifiers.js';
import type { CustomerSubjectBinding, CustomerSubjectBindingReader } from './subject-binding-reader.js';

export interface CustomerIdentityAdmissionOptions {
  /** The configured credentials. Only those carrying an `organizationId` and a `customerIdentity` block can ever admit anyone. */
  readonly apiKeys: readonly EnterpriseApiKey[];
  /** The read-only binding port. In production, `createKernelAuthoritySubjectBindingReader` over the Kernel Authority store. */
  readonly subjectBindings: CustomerSubjectBindingReader;
  /** The one authority organization this instance's Kernel Authority world belongs to (`kernelAuthority.organizationId`). */
  readonly organizationId: string;
  /**
   * CTRL-02 — operator-issued agent credentials, consulted only for a bearer
   * credential that matches no configured key. When present, a deployment may
   * configure no static customer credential at all: its agents are onboarded
   * by identified operators instead of by editing configuration.
   */
  readonly agentCredentials?: DynamicCustomerCredentialVerifier;
  /** CTRL-02 — principal ids operator-issued credentials use (`agent:`). A configured key may not claim one, so one principal id names one identity. */
  readonly reservedPrincipalPrefix?: string;
}

/**
 * Checks, before anything is admitted, that the configured credentials can
 * only ever produce unambiguous customer principals for the organization this
 * instance serves. Throws `CustomerIdentityConfigurationError`; never repairs.
 *
 * * at least one customer-plane credential exists;
 * * every credential that carries customer identity is organization-scoped,
 *   well-formed, and scoped to the served organization;
 * * a `principalId` names one identity: several keys may share it (rotation),
 *   but only with the same organization and external subject.
 *
 * Legacy keys without a `customerIdentity` block are left exactly as they are
 * — valid for the legacy routes, never eligible here.
 */
export function assertCustomerCredentialConfiguration(
  apiKeys: readonly EnterpriseApiKey[],
  organizationId: string,
  options: { readonly dynamicCredentials?: boolean; readonly reservedPrincipalPrefix?: string } = {},
): void {
  if (!isCanonicalCustomerIdentifier(organizationId)) {
    throw new CustomerIdentityConfigurationError('CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED', 'The served authority organization id is not a canonical identifier.');
  }
  const principals = new Map<string, string>();
  let customerCredentials = 0;
  apiKeys.forEach((apiKey, index) => {
    const identity = apiKey.customerIdentity;
    if (identity === undefined) return;
    customerCredentials += 1;
    if (apiKey.organizationId === undefined || apiKey.organizationId.length === 0) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_CREDENTIAL_UNSCOPED',
        `Credential #${index} carries customer identity but no organizationId; a customer principal must belong to exactly one organization.`,
      );
    }
    if (
      !isCanonicalCustomerIdentifier(apiKey.organizationId) ||
      !isCanonicalCustomerIdentifier(identity.principalId) ||
      !isCanonicalCustomerExternalSubject(identity.externalSubject)
    ) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_CREDENTIAL_INVALID',
        `Credential #${index} carries malformed customer identity metadata (organizationId, principalId, externalSubject.system and externalSubject.subjectId must be non-empty, trim-stable, control-character-free and at most 256 characters).`,
      );
    }
    if (apiKey.organizationId !== organizationId) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED',
        `Credential #${index} is scoped to organization '${apiKey.organizationId}', but this instance serves the authority world of '${organizationId}' only.`,
      );
    }
    if (options.reservedPrincipalPrefix !== undefined && identity.principalId.startsWith(options.reservedPrincipalPrefix)) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS',
        `Credential #${index} uses principalId '${identity.principalId}', whose prefix is reserved for operator-issued agent principals.`,
      );
    }
    const fingerprint = JSON.stringify([apiKey.organizationId, identity.externalSubject.system, identity.externalSubject.subjectId]);
    const existing = principals.get(identity.principalId);
    if (existing !== undefined && existing !== fingerprint) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS',
        `Credential #${index} reuses principalId '${identity.principalId}' with a different organization or external subject; one principal names one identity.`,
      );
    }
    principals.set(identity.principalId, fingerprint);
  });
  if (customerCredentials === 0 && options.dynamicCredentials !== true) {
    throw new CustomerIdentityConfigurationError(
      'CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL',
      'Customer identity admission was requested, but no configured credential carries an organizationId and customerIdentity metadata.',
    );
  }
}

/**
 * Credential → principal → organization → external subject → actor.
 *
 * Admission reads the `Authorization` header and nothing else from the
 * request; the organization comes from the matched credential's
 * configuration, the actor from the Kernel Authority binding in that
 * organization. It calls no Kernel, writes nothing, and issues no authority —
 * `bound` means only "this credential represents this actor", and the
 * decision about what the actor may do is still the Kernel's to make.
 */
export function createCustomerIdentityAdmission(options: CustomerIdentityAdmissionOptions): CustomerIdentityAdmissionService {
  assertCustomerCredentialConfiguration(options.apiKeys, options.organizationId, {
    dynamicCredentials: options.agentCredentials !== undefined,
    ...(options.reservedPrincipalPrefix !== undefined ? { reservedPrincipalPrefix: options.reservedPrincipalPrefix } : {}),
  });
  // An immutable snapshot of what was validated above, so a host that later
  // mutates its own configuration objects cannot change what admission reads.
  const apiKeys: readonly EnterpriseApiKey[] = Object.freeze(
    options.apiKeys.map((apiKey) =>
      Object.freeze({
        key: apiKey.key,
        ...(apiKey.organizationId !== undefined ? { organizationId: apiKey.organizationId } : {}),
        ...(apiKey.customerIdentity !== undefined
          ? {
              customerIdentity: Object.freeze({
                principalId: apiKey.customerIdentity.principalId,
                externalSubject: Object.freeze({ system: apiKey.customerIdentity.externalSubject.system, subjectId: apiKey.customerIdentity.externalSubject.subjectId }),
              }),
            }
          : {}),
      }),
    ),
  );
  const { subjectBindings, organizationId, agentCredentials } = options;

  return Object.freeze({
    organizationId,
    async admit(request: CustomerIdentityAdmissionRequest): Promise<CustomerIdentityAdmissionResult> {
      const authorizationHeader = typeof request?.authorizationHeader === 'string' ? request.authorizationHeader : undefined;
      const authenticated = authenticateCustomerCredential(authorizationHeader, apiKeys);
      let principal: CustomerPrincipal;
      // CTRL-02: the actor an operator-issued credential was bound to at issue.
      let issuedForActorId: string | undefined;
      if (authenticated.status === 'refused') {
        // Only a well-formed bearer credential that matched no configured key
        // is ever offered to the operator-issued credential port — never a
        // configured key that was refused for another reason.
        const token = authenticated.reason === CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_INVALID && agentCredentials !== undefined && authorizationHeader !== undefined ? extractBearerToken(authorizationHeader) : undefined;
        if (token === undefined || agentCredentials === undefined) return { status: 'refused', reason: authenticated.reason };
        const dynamic = await agentCredentials.authenticate(token);
        if (dynamic.status === 'unavailable') return { status: 'unavailable', reason: CUSTOMER_IDENTITY_UNAVAILABLE_REASONS.CUSTOMER_SUBJECT_LOOKUP_FAILED };
        if (dynamic.status !== 'authenticated') return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_AUTH_INVALID };
        principal = dynamic.principal;
        issuedForActorId = dynamic.actorId;
      } else {
        principal = authenticated.principal;
      }

      // Composition already refuses a credential for another organization; this
      // is the same rule restated at the one place a binding is read, so a key
      // list that changed after composition still cannot resolve a foreign world.
      if (principal.organizationId !== organizationId) {
        return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_ORGANIZATION_NOT_SERVED };
      }

      let binding: CustomerSubjectBinding;
      try {
        binding = await subjectBindings.findActorByExternalSubject(principal.organizationId, principal.externalSubject);
      } catch {
        return { status: 'unavailable', reason: CUSTOMER_IDENTITY_UNAVAILABLE_REASONS.CUSTOMER_SUBJECT_LOOKUP_FAILED };
      }

      switch (binding?.status) {
        case 'bound': {
          if (!isCanonicalCustomerIdentifier(binding.actorId)) {
            return { status: 'unavailable', reason: CUSTOMER_IDENTITY_UNAVAILABLE_REASONS.CUSTOMER_SUBJECT_BINDING_INCONSISTENT };
          }
          // CTRL-02: the Kernel Authority binding is canonical; a credential
          // issued for another actor admits no one.
          if (issuedForActorId !== undefined && issuedForActorId !== binding.actorId) {
            return { status: 'unavailable', reason: CUSTOMER_IDENTITY_UNAVAILABLE_REASONS.CUSTOMER_SUBJECT_BINDING_INCONSISTENT };
          }
          const identity: BoundCustomerIdentity = Object.freeze({ principal, actor: Object.freeze({ actorId: binding.actorId }) });
          return Object.freeze({ status: 'bound', identity });
        }
        case 'unbound':
          return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_SUBJECT_UNBOUND };
        case 'revoked':
          return { status: 'refused', reason: CUSTOMER_IDENTITY_REFUSAL_REASONS.CUSTOMER_SUBJECT_ACTOR_REVOKED };
        default:
          return { status: 'unavailable', reason: CUSTOMER_IDENTITY_UNAVAILABLE_REASONS.CUSTOMER_SUBJECT_BINDING_INCONSISTENT };
      }
    },
  });
}
