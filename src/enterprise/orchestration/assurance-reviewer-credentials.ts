import type { EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { AGENT_PRINCIPAL_PREFIX } from '../operator-control/agent-credentials.js';
import { SERVICE_PRINCIPAL_MIN_SECRET_LENGTH } from './advisory-identity.js';

/** Thrown when a configured Assurance reviewer could never be a safe, unambiguous, single-organization reviewer. Names fields and positions, never a secret. */
export class AssuranceReviewerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssuranceReviewerConfigurationError';
  }
}

/**
 * The one Assurance reviewer validator (ASSURE-SEC-01B), run by the Host's
 * loader on the configuration it built and again at composition for any
 * embedder:
 *
 * * scoped to the one organization this instance serves;
 * * a canonical reviewer id outside the `agent:` namespace, naming no customer
 *   or service principal, auditor, operator, administrator or other reviewer;
 * * at least one role, each a canonical identifier, listed once -- no wildcard
 *   or implied role exists;
 * * a secret of at least 32 characters without surrounding whitespace, shared
 *   with no other credential of any class.
 */
export function assertAssuranceReviewerConfiguration(configuration: EnterpriseConfiguration, servedOrganizationId: string): void {
  const reviewers = configuration.authentication.assuranceReviewers ?? [];
  if (reviewers.length === 0) return;
  const servicePrincipals = configuration.authentication.servicePrincipals ?? [];
  const auditors = configuration.authentication.auditors ?? [];
  const administrators = configuration.administration?.administrators ?? [];
  const operators = configuration.administration?.operators ?? [];
  const takenIds = new Set([
    ...configuration.authentication.apiKeys.flatMap((apiKey) => (apiKey.customerIdentity !== undefined ? [apiKey.customerIdentity.principalId] : [])),
    ...servicePrincipals.map((servicePrincipal) => servicePrincipal.principalId),
    ...auditors.map((auditor) => auditor.auditorId),
    ...administrators.map((administrator) => administrator.operatorId),
    ...operators.map((operator) => operator.operatorId),
  ]);
  const secrets = new Set([
    ...configuration.authentication.apiKeys.map((apiKey) => apiKey.key),
    ...servicePrincipals.map((servicePrincipal) => servicePrincipal.key),
    ...auditors.map((auditor) => auditor.key),
    ...administrators.map((administrator) => administrator.key),
    ...operators.map((operator) => operator.key),
  ]);
  const reviewerIds = new Set<string>();
  reviewers.forEach((reviewer, index) => {
    const where = `assuranceReviewers[${index}]`;
    if (!isCanonicalCustomerIdentifier(reviewer.reviewerId)) {
      throw new AssuranceReviewerConfigurationError(`${where}.reviewerId must be a non-empty, trim-stable identifier of at most 256 characters with no control characters.`);
    }
    if (reviewer.reviewerId.startsWith(AGENT_PRINCIPAL_PREFIX)) {
      throw new AssuranceReviewerConfigurationError(`${where}.reviewerId uses the '${AGENT_PRINCIPAL_PREFIX}' prefix, which is reserved for operator-issued agent principals.`);
    }
    if (reviewerIds.has(reviewer.reviewerId) || takenIds.has(reviewer.reviewerId)) {
      throw new AssuranceReviewerConfigurationError(`${where}.reviewerId already names another reviewer, principal, auditor, operator or administrator; one id names one identity.`);
    }
    reviewerIds.add(reviewer.reviewerId);
    if (reviewer.organizationId !== servedOrganizationId) throw new AssuranceReviewerConfigurationError(`${where} is not scoped to the organization this instance serves.`);
    if (!Array.isArray(reviewer.roles) || reviewer.roles.length === 0) throw new AssuranceReviewerConfigurationError(`${where}.roles must list at least one role; no role is implied.`);
    const roles = new Set<string>();
    reviewer.roles.forEach((role, roleIndex) => {
      if (typeof role !== 'string' || !isCanonicalCustomerIdentifier(role) || role.includes('*')) {
        throw new AssuranceReviewerConfigurationError(`${where}.roles[${roleIndex}] must be an exact, canonical role identifier; patterns are not roles.`);
      }
      if (roles.has(role)) throw new AssuranceReviewerConfigurationError(`${where}.roles[${roleIndex}] repeats '${role}'.`);
      roles.add(role);
    });
    const key = reviewer.key;
    if (typeof key !== 'string' || key.length < SERVICE_PRINCIPAL_MIN_SECRET_LENGTH || key.trim() !== key) {
      throw new AssuranceReviewerConfigurationError(
        `${where} has a secret shorter than ${SERVICE_PRINCIPAL_MIN_SECRET_LENGTH} characters or with surrounding whitespace. A reviewer credential must be a long random secret.`,
      );
    }
    if (secrets.has(key)) throw new AssuranceReviewerConfigurationError(`${where} shares its secret with another credential; one secret authenticates one caller.`);
    secrets.add(key);
  });
}
