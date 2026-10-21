import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import type { EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { GOVERNANCE_ATTRIBUTION_EVENT_TYPE, type GovernanceRecord, type GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { AGENT_PRINCIPAL_PREFIX } from '../operator-control/agent-credentials.js';
import { SERVICE_PRINCIPAL_MIN_SECRET_LENGTH } from './advisory-identity.js';
import { extractBearerToken, matchApiKey } from './credential-matching.js';

/**
 * G-01A — authorization-aware disclosure on the Governance Record read routes
 * (`GET /api/governance/evaluations/{id}`, `/decisions/{id}`, `/requests/{id}`).
 *
 * The Store keeps every record complete and unchanged; nothing here writes.
 * What a reader is *shown* depends on who it is:
 *
 * * **canonical** — the complete stored aggregate, exactly as before G-01A:
 *   system scope (an unscoped key under explicit `compat`, or authentication
 *   disabled), and an **auditor** credential for records of its one
 *   organization;
 * * **projected** — for an ordinary organization-scoped key: the same record
 *   with the payload of each `GovernanceEvaluationAttributed` event that names
 *   a requesting principal withheld, and an explicit `projection` marker saying
 *   so. A record with nothing to withhold — every pre-G-01A record, and a
 *   legacy key's asserted attribution, which names no principal — is returned
 *   unchanged and unmarked.
 *
 * Organization scope alone is never auditor authority: an auditor is a
 * separate, explicitly configured credential.
 */

export const GOVERNANCE_RECORD_PROJECTION_VERSION = 'aoc.governance-record-projection.v1';

export type GovernanceRecordDisclosure = 'canonical' | 'projected';

/** One withheld value in a projection: which event, which field, and why. */
export interface GovernanceRecordWithheldField {
  readonly eventId: string;
  readonly eventType: string;
  readonly field: 'eventPayload';
  readonly reason: 'auditor-authorization-required';
}

/** The marker a projected read carries. Its presence is the statement "this is not the canonical record". */
export interface GovernanceRecordProjectionMarker {
  readonly version: typeof GOVERNANCE_RECORD_PROJECTION_VERSION;
  readonly canonical: false;
  readonly withheld: readonly GovernanceRecordWithheldField[];
  /** The digests in a projection describe the stored canonical record, not this view; only server-side verification checks them. */
  readonly verification: string;
}

/** What a Governance Record read returns: the canonical record, or a marked projection of it. */
export type GovernanceRecordView = GovernanceRecord & { readonly projection?: GovernanceRecordProjectionMarker };

/** The value standing in for a withheld attribution payload. */
export const WITHHELD_ATTRIBUTION_PAYLOAD = Object.freeze({ withheld: 'attribution' as const });

const VERIFICATION_NOTE =
  'This is a projection, not the canonical record: withheld payloads are not shown, so its digests cannot be recomputed from it. GET /api/governance/evaluations/{evaluationId}/verify verifies the complete stored record server-side.';

/**
 * The view one reader is entitled to. Never mutates `record`: a projection is
 * a fresh object, and the canonical record is returned as is.
 */
export function projectGovernanceRecord(record: GovernanceRecord, disclosure: GovernanceRecordDisclosure): GovernanceRecordView {
  if (disclosure === 'canonical') return record;
  const withheld: GovernanceRecordWithheldField[] = [];
  const events = record.events.map((event) => {
    if (event.eventType !== GOVERNANCE_ATTRIBUTION_EVENT_TYPE || namesNoPrincipal(event.eventPayload)) return event;
    withheld.push({ eventId: event.eventId, eventType: event.eventType, field: 'eventPayload', reason: 'auditor-authorization-required' });
    return { ...event, eventPayload: WITHHELD_ATTRIBUTION_PAYLOAD };
  });
  if (withheld.length === 0) return record;
  return { ...record, events, projection: { version: GOVERNANCE_RECORD_PROJECTION_VERSION, canonical: false, withheld, verification: VERIFICATION_NOTE } };
}

/**
 * Whether an attribution payload is a legacy key's asserted attribution, which
 * names no requesting principal and so has nothing to withhold. Anything else
 * — a customer or service principal, or a payload this build cannot read — is
 * withheld: unreadable fails closed.
 */
function namesNoPrincipal(payload: Readonly<Record<string, unknown>>): boolean {
  const attribution = payload['attribution'];
  if (attribution === null || typeof attribution !== 'object' || Array.isArray(attribution)) return false;
  const fields = attribution as Record<string, unknown>;
  return fields['basis'] === 'legacy-asserted' && !('requestingPrincipalId' in fields);
}

/** Who is reading, the tenant scope the Store enforces for them, and the view they receive. */
export interface GovernanceReadAccess {
  readonly context: GovernanceStoreAccessContext;
  readonly disclosure: GovernanceRecordDisclosure;
}

/**
 * The Governance Record read routes' authentication. Identical to
 * `resolveGovernanceAccessContext` for every API key, which an organization-
 * scoped key now reads through a projection; additionally recognizes the
 * configured auditors, here and nowhere else. Every API key and every auditor
 * secret is compared on every call.
 */
export function resolveGovernanceReadAccess(authorizationHeader: string | undefined, configuration: EnterpriseConfiguration): GovernanceReadAccess {
  if (!configuration.features.requireAuthentication) return { context: { system: true }, disclosure: 'canonical' };

  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) throw EnterpriseHttpErrors.authenticationFailed('A Bearer token is required.');
  const matchedKey = matchApiKey(token, configuration.authentication.apiKeys);
  const matchedAuditor = matchApiKey(token, configuration.authentication.auditors ?? []);
  if (matchedKey !== undefined && matchedAuditor !== undefined) throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');

  if (matchedAuditor !== undefined) return { context: { system: false, organizationId: matchedAuditor.organizationId }, disclosure: 'canonical' };
  if (matchedKey === undefined) throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');
  return matchedKey.organizationId !== undefined ? { context: { system: false, organizationId: matchedKey.organizationId }, disclosure: 'projected' } : { context: { system: true }, disclosure: 'canonical' };
}

/** Thrown when a configured auditor could never be a safe, unambiguous, single-organization reader. Names fields and positions, never a secret. */
export class AuditorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditorConfigurationError';
  }
}

/**
 * The one auditor validator, run by the Host's loader on the configuration it
 * built and again at composition for any embedder:
 *
 * * scoped to the one organization this instance serves;
 * * a canonical auditor id outside the `agent:` namespace, naming no customer
 *   or service principal, operator, administrator or other auditor;
 * * a secret of at least 32 characters without surrounding whitespace, shared
 *   with no API key, service principal, operator, administrator or other auditor.
 */
export function assertAuditorConfiguration(configuration: EnterpriseConfiguration, servedOrganizationId: string): void {
  const auditors = configuration.authentication.auditors ?? [];
  if (auditors.length === 0) return;
  const servicePrincipals = configuration.authentication.servicePrincipals ?? [];
  const administrators = configuration.administration?.administrators ?? [];
  const operators = configuration.administration?.operators ?? [];
  const takenIds = new Set([
    ...configuration.authentication.apiKeys.flatMap((apiKey) => (apiKey.customerIdentity !== undefined ? [apiKey.customerIdentity.principalId] : [])),
    ...servicePrincipals.map((servicePrincipal) => servicePrincipal.principalId),
    ...administrators.map((administrator) => administrator.operatorId),
    ...operators.map((operator) => operator.operatorId),
  ]);
  const secrets = new Set([
    ...configuration.authentication.apiKeys.map((apiKey) => apiKey.key),
    ...servicePrincipals.map((servicePrincipal) => servicePrincipal.key),
    ...administrators.map((administrator) => administrator.key),
    ...operators.map((operator) => operator.key),
  ]);
  const auditorIds = new Set<string>();
  auditors.forEach((auditor, index) => {
    const where = `auditors[${index}]`;
    if (!isCanonicalCustomerIdentifier(auditor.auditorId)) throw new AuditorConfigurationError(`${where}.auditorId must be a non-empty, trim-stable identifier of at most 256 characters with no control characters.`);
    if (auditor.auditorId.startsWith(AGENT_PRINCIPAL_PREFIX)) throw new AuditorConfigurationError(`${where}.auditorId uses the '${AGENT_PRINCIPAL_PREFIX}' prefix, which is reserved for operator-issued agent principals.`);
    if (auditorIds.has(auditor.auditorId) || takenIds.has(auditor.auditorId)) {
      throw new AuditorConfigurationError(`${where}.auditorId already names another auditor, principal, operator or administrator; one id names one identity.`);
    }
    auditorIds.add(auditor.auditorId);
    if (auditor.organizationId !== servedOrganizationId) throw new AuditorConfigurationError(`${where} is not scoped to the organization this instance serves.`);
    const key = auditor.key;
    if (typeof key !== 'string' || key.length < SERVICE_PRINCIPAL_MIN_SECRET_LENGTH || key.trim() !== key) {
      throw new AuditorConfigurationError(`${where} has a secret shorter than ${SERVICE_PRINCIPAL_MIN_SECRET_LENGTH} characters or with surrounding whitespace. An auditor credential must be a long random secret.`);
    }
    if (secrets.has(key)) throw new AuditorConfigurationError(`${where} shares its secret with another credential; one secret authenticates one caller.`);
    secrets.add(key);
  });
}
