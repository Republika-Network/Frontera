/** Governance configuration that cannot be believed. Thrown at composition only — a Host with malformed profiles does not start. */
export class GovernanceProfileConfigurationError extends Error {
  readonly code = 'GOVERNANCE_PROFILE_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GovernanceProfileConfigurationError';
  }
}
