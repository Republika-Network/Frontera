/**
 * A wiring-time failure, raised when a deployment composes the grant capability
 * in a way that could not be honoured.
 *
 * Thrown at construction rather than at issuance, for the reason
 * `ObligationConfigurationError` and `ContextConfigurationError` are: a
 * deployment that declares a grant horizon of zero seconds should find out when
 * it builds the host, not in the middle of a payment.
 */
export class GrantConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantConfigurationError';
  }
}
