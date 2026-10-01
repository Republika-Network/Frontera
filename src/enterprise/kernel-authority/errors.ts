/**
 * The Kernel Authority Runtime's error taxonomy, parallel in shape to
 * `AgentPassportErrorCode` / `GovernanceStoreErrorCode`. Every failure this
 * module surfaces is one of these codes; raw driver/internal errors never
 * escape it.
 *
 * Note what is deliberately absent: there is no code here that means "denied".
 * These are *operational* failures of the authority source — a store that
 * cannot be opened, a payload that is not well-formed, an operator who is not
 * authorized to provision. A governance denial is `AocKernel`'s to produce and
 * arrives as a Kernel reason code, never as one of these. Conflating the two
 * would let an infrastructure outage masquerade as a policy outcome (mission
 * section 38).
 */
export type KernelAuthorityErrorCode =
  | 'KERNEL_AUTHORITY_ENTITY_NOT_FOUND'
  | 'KERNEL_AUTHORITY_ENTITY_CONFLICT'
  | 'KERNEL_AUTHORITY_ENTITY_REVOKED'
  | 'KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT'
  | 'KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT'
  | 'KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED'
  | 'KERNEL_AUTHORITY_TENANT_SCOPE_REQUIRED'
  | 'KERNEL_AUTHORITY_ACCESS_SCOPE_VIOLATION'
  | 'KERNEL_AUTHORITY_REFERENCE_INVALID'
  | 'KERNEL_AUTHORITY_INTEGRITY_FAILED'
  | 'KERNEL_AUTHORITY_STORE_UNAVAILABLE'
  | 'KERNEL_AUTHORITY_VERSION_UNSUPPORTED'
  | 'KERNEL_AUTHORITY_VALIDATION_ERROR'
  /**
   * CTRL-02: the write **was durably committed**, and refreshing the live
   * projection afterwards failed. The projection fails closed until a refresh
   * succeeds; retrying the same request (same id and terms, same idempotency
   * key) replays the committed record and refreshes. Never "nothing written".
   */
  | 'KERNEL_AUTHORITY_REFRESH_FAILED';

export class KernelAuthorityError extends Error {
  constructor(
    readonly code: KernelAuthorityErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'KernelAuthorityError';
  }
}

export function isKernelAuthorityError(error: unknown): error is KernelAuthorityError {
  return error instanceof KernelAuthorityError;
}
