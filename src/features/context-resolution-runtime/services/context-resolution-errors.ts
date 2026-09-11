/** Configuration is rejected at composition time, not at decision time: a deployment that mis-declares a source or a requirement finds out when it wires the Kernel, never in the middle of an evaluation. */
export class ContextConfigurationError extends Error {
  readonly violations: readonly string[];

  constructor(message: string, violations: readonly string[]) {
    super(violations.length > 0 ? `${message} ${violations.join(' ')}` : message);
    this.name = 'ContextConfigurationError';
    this.violations = violations;
  }
}
