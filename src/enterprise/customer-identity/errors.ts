export type CustomerIdentityConfigurationErrorCode =
  | 'CUSTOMER_IDENTITY_AUTHORITY_UNAVAILABLE'
  | 'CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL'
  | 'CUSTOMER_IDENTITY_CREDENTIAL_UNSCOPED'
  | 'CUSTOMER_IDENTITY_CREDENTIAL_INVALID'
  | 'CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED'
  | 'CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS';

/**
 * Raised while **composing** customer admission, never while admitting a
 * caller. A deployment that asked for the customer plane and cannot have a
 * secure one gets no customer plane at all — there is no weaker mode to fall
 * back to. Messages name configuration positions, never key material.
 */
export class CustomerIdentityConfigurationError extends Error {
  readonly code: CustomerIdentityConfigurationErrorCode;

  constructor(code: CustomerIdentityConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'CustomerIdentityConfigurationError';
    this.code = code;
  }
}
