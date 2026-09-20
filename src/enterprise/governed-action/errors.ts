export type GovernedActionConfigurationErrorCode =
  /** Governed actions consume a `BoundCustomerIdentity`; without customer identity admission there is no trusted actor to act for. */
  | 'GOVERNED_ACTION_CUSTOMER_IDENTITY_REQUIRED'
  /** Governed actions issue and exercise bounded grants; without Authority-Controlled Execution there is nothing to issue or exercise through. */
  | 'GOVERNED_ACTION_EXECUTION_REQUIRED'
  /** The execution Kernel was supplied by the host, so the composition root cannot prove it is grant-aware under the declared grant capability. */
  | 'GOVERNED_ACTION_KERNEL_NOT_PROVABLY_GRANT_AWARE'
  /** The Governance Store handed to this Host cannot append, re-read, verify and reference decisions. */
  | 'GOVERNED_ACTION_GOVERNANCE_STORE_UNAVAILABLE'
  /** The trust domain or grant policy the host supplied is missing or malformed. */
  | 'GOVERNED_ACTION_CONFIGURATION_INVALID';

/**
 * Raised while **composing** the Governed Action Orchestrator, never while
 * governing an action. A deployment that asked for governed actions and cannot
 * have the canonical ordering gets no orchestrator at all — there is no weaker
 * mode to fall back to.
 */
export class GovernedActionConfigurationError extends Error {
  readonly code: GovernedActionConfigurationErrorCode;

  constructor(code: GovernedActionConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'GovernedActionConfigurationError';
    this.code = code;
  }
}
