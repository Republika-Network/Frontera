/**
 * CTRL-03 — the web control plane's own statement of the Host's operator-plane
 * wire contract.
 *
 * Deliberately **not** imported from `src/enterprise`: the web application
 * reaches the Host over HTTP only, so it describes the JSON it receives rather
 * than sharing server types (and with them, a path into server modules). Every
 * shape here is what the Host serializes today (`operator-control/contracts.ts`,
 * `authority-administration/contracts.ts`); the canonical web qualification
 * proves the two agree against the real Host.
 *
 * Nothing here decides anything. Closed lists (entity kinds, revocation
 * reasons, emergency scopes) exist only to render closed form controls; the
 * Host validates every value again and its refusal is what the operator sees.
 */

export type EntityKind = 'actor' | 'trust-domain' | 'root-issuer' | 'passport' | 'capability-token' | 'authority-grant' | 'delegation-grant';

export const ENTITY_KINDS: readonly EntityKind[] = ['actor', 'trust-domain', 'root-issuer', 'passport', 'capability-token', 'authority-grant', 'delegation-grant'];

export const ENTITY_KIND_LABELS: Readonly<Record<EntityKind, string>> = {
  actor: 'Actor',
  'trust-domain': 'Trust domain',
  'root-issuer': 'Root issuer',
  passport: 'Passport',
  'capability-token': 'Capability token',
  'authority-grant': 'Authority grant',
  'delegation-grant': 'Delegation grant',
};

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}

/** The Host's closed bounded-grant revocation vocabulary (CTRL-01). */
export const GRANT_REVOCATION_REASONS = ['administrator-revoked', 'expired', 'manual-revocation', 'policy-changed', 'principal-disabled', 'resource-removed', 'security-incident'] as const;

/** Emergency-control scopes the Host accepts over HTTP (CTRL-01: every scope but `workflow`). */
export const EMERGENCY_SCOPES = ['global', 'organization', 'actor', 'adapter', 'resource'] as const;

export interface OperatorIdentity {
  readonly operatorId: string;
  readonly role: string;
  readonly credentialClass: string;
  /** Reported by the Host. The console uses it to decide what to *show*; the Host decides what is *allowed*. */
  readonly permissions: readonly string[];
}

export interface OrganizationContext {
  readonly organization: {
    readonly organizationId: string;
    readonly trustDomainId: string | null;
    readonly agentCredentials: string;
    readonly profileLifecycle: string;
  };
  readonly operator: OperatorIdentity;
}

export interface CredentialView {
  readonly credentialId: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly replacesCredentialId: string | null;
}

export interface AuthorityReference {
  readonly entityKind: string;
  readonly entityId: string;
  readonly status: string;
}

export interface AgentView {
  readonly actorId: string;
  readonly displayName: string;
  readonly status: string;
  readonly externalSubject: { readonly system: string; readonly subjectId: string } | null;
  readonly trustDomainId: string | null;
  readonly provisionedBy: string;
  readonly provisionedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly principalId: string | null;
  readonly credentials: readonly CredentialView[];
  readonly authority: {
    readonly passports: readonly AuthorityReference[];
    readonly capabilityTokens: readonly AuthorityReference[];
    readonly authorityGrants: readonly AuthorityReference[];
    readonly delegationGrants: readonly AuthorityReference[];
  };
  readonly onboarding: { readonly actor: string; readonly credential: string; readonly standingAuthority: string };
}

export interface CredentialIssueResult {
  readonly outcome: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly credential: CredentialView;
  /** The one reveal. `null` on an idempotent replay. */
  readonly bearerCredential: string | null;
  readonly replaced?: CredentialView;
}

export interface CredentialRevokeResult {
  readonly outcome: string;
  readonly actorId: string;
  readonly credential: CredentialView;
}

export interface EntityView {
  readonly entityKind: string;
  readonly entityId: string;
  readonly organizationId: string;
  readonly trustDomainId: string | null;
  readonly status: string;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly provisionedBy: string;
  readonly provisionedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly sequence: number;
}

export interface ProvisionResult {
  readonly outcome: string;
  readonly entity: EntityView;
}

export interface EntityRevokeResult {
  readonly outcome: string;
  readonly entity: EntityView;
}

export type GrantBoundView =
  | { readonly kind: 'identity'; readonly value: string }
  | { readonly kind: 'set'; readonly values: readonly string[] }
  | { readonly kind: 'ceiling'; readonly limit: string; readonly unit: string }
  | { readonly kind: 'window'; readonly notAfter: string };

export interface ParameterBoundView {
  readonly dimension: string;
  readonly kind: string;
  readonly type: string;
  readonly value?: number | string | boolean;
  readonly limit?: number;
}

export interface GrantView {
  readonly grantId: string;
  readonly subject: string;
  readonly provenance: { readonly requestId: string; readonly decisionId: string; readonly action: string; readonly resourceScope: string };
  readonly bounds: Readonly<Record<string, GrantBoundView | readonly ParameterBoundView[]>>;
  readonly semanticsFormat?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: { readonly eligibility: string; readonly reasonCodes: readonly string[]; readonly assessedAt: string };
  readonly revocation: { readonly revokedAt: string; readonly reason: string; readonly revokedBy: string } | null;
}

export interface GrantRevokeResult {
  readonly outcome: string;
  readonly grantId: string;
  readonly revocation: { readonly revokedAt: string; readonly reason: string; readonly revokedBy: string };
}

export interface ExecutionGrantView {
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly grantId: string;
  readonly action: string;
  readonly preparedAt: string;
}

export interface EmergencyTarget {
  readonly scope: string;
  readonly value?: string;
}

export interface EmergencyControls {
  readonly active: readonly EmergencyTarget[];
}

export interface EmergencyTransitionResult extends EmergencyControls {
  readonly outcome: string;
  readonly control: EmergencyTarget;
}

export interface ProfileParameterView {
  readonly dimension: string;
  readonly required?: boolean;
}

export interface ProfileVersion {
  readonly profileId: string;
  readonly version: number;
  readonly digest: string;
  readonly state: string;
  readonly actionClass: string;
  readonly resourceClass: string;
  readonly owner: string;
  readonly provenance: { readonly authoredBy: string; readonly approvedBy: string };
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly retiredBy: string | null;
  readonly retiredAt: string | null;
  readonly retirementReason: string | null;
  readonly definition: { readonly parameters?: readonly ProfileParameterView[] } & Readonly<Record<string, unknown>>;
}

export interface ProfileCatalog {
  readonly lifecycle: string;
  readonly profiles: readonly ProfileVersion[];
}

export interface ProfileTransitionResult {
  readonly outcome: string;
  readonly profile: ProfileVersion;
  readonly superseded: ProfileVersion | null;
}

export interface DecisionSummary {
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly actorId: string;
  readonly actionType: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly persistedAt: string;
}

export interface DecisionPage {
  readonly decisions: readonly DecisionSummary[];
  readonly nextCursor: string | null;
  readonly coverage: string;
}

export interface DecisionReference {
  readonly referenceId: string;
  readonly referenceType: string;
  readonly externalId: string;
  readonly externalVersion: string | null;
  readonly digest: string | null;
  readonly createdAt: string;
  readonly sequence: number | null;
}

export interface DecisionEvidence {
  readonly decision: {
    readonly evaluationId: string;
    readonly decisionId: string;
    readonly requestId: string;
    readonly correlationId: string | null;
    readonly actorId: string;
    readonly actorType: string | null;
    readonly actionType: string;
    readonly resourceScope: string;
    readonly requestedAt: string;
    readonly status: string;
    readonly summary: string;
    readonly reasonCodes: readonly string[];
    readonly evaluatedAt: string;
    readonly persistedAt: string;
    readonly kernelVersion: string;
  };
  readonly integrity: { readonly algorithm: string; readonly chainPosition: number; readonly aggregateDigest: string; readonly previousAggregateDigest: string | null };
  readonly references: readonly DecisionReference[];
  readonly verification: {
    readonly valid: boolean;
    readonly verifiedAt: string;
    readonly checks: Readonly<Record<string, boolean>>;
    readonly failures: readonly { readonly check: string; readonly message: string }[];
    readonly referenceIntegrity: { readonly legacyUnprotected: number; readonly protectedValid: number; readonly protectedCorrupted: number; readonly protectedUnsupportedVersion: number };
  };
  readonly coverage: string;
}

// -- minimal shape guards ---------------------------------------------------------
//
// A 2xx body that does not have the shape the console renders is a contract
// failure, reported as such — never rendered partially as if it were state.

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isArrayOf = (value: unknown, item: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(item);

export const shapes = {
  organization: (body: unknown): body is OrganizationContext =>
    isObject(body) &&
    isObject(body['organization']) &&
    isString(body['organization']['organizationId']) &&
    isObject(body['operator']) &&
    isString(body['operator']['operatorId']) &&
    isString(body['operator']['role']) &&
    isArrayOf(body['operator']['permissions'], isString),
  agent: (body: unknown): body is AgentView =>
    isObject(body) && isString(body['actorId']) && isString(body['status']) && Array.isArray(body['credentials']) && isObject(body['authority']) && isObject(body['onboarding']),
  agents: (body: unknown): body is { readonly agents: readonly AgentView[] } => isObject(body) && isArrayOf(body['agents'], (entry) => shapes.agent(entry)),
  entity: (body: unknown): body is EntityView => isObject(body) && isString(body['entityKind']) && isString(body['entityId']) && isString(body['status']) && isObject(body['terms']),
  entities: (body: unknown): body is { readonly entities: readonly EntityView[] } => isObject(body) && isArrayOf(body['entities'], (entry) => shapes.entity(entry)),
  provision: (body: unknown): body is ProvisionResult => isObject(body) && isString(body['outcome']) && shapes.entity(body['entity']),
  entityRevoke: (body: unknown): body is EntityRevokeResult => isObject(body) && isString(body['outcome']) && shapes.entity(body['entity']),
  credentialIssue: (body: unknown): body is CredentialIssueResult =>
    isObject(body) && isString(body['outcome']) && isObject(body['credential']) && (body['bearerCredential'] === null || isString(body['bearerCredential'])),
  credentialRevoke: (body: unknown): body is CredentialRevokeResult => isObject(body) && isString(body['outcome']) && isObject(body['credential']),
  grant: (body: unknown): body is GrantView => isObject(body) && isString(body['grantId']) && isObject(body['status']) && isObject(body['bounds']),
  grantRevoke: (body: unknown): body is GrantRevokeResult => isObject(body) && isString(body['outcome']) && isObject(body['revocation']),
  execution: (body: unknown): body is ExecutionGrantView => isObject(body) && isString(body['executionId']) && isString(body['grantId']),
  emergency: (body: unknown): body is EmergencyControls => isObject(body) && Array.isArray(body['active']),
  emergencyTransition: (body: unknown): body is EmergencyTransitionResult =>
    isObject(body) && isString(body['outcome']) && Array.isArray(body['active']) && isObject(body['control']) && isString(body['control']['scope']),
  profiles: (body: unknown): body is ProfileCatalog => isObject(body) && isString(body['lifecycle']) && isArrayOf(body['profiles'], (entry) => isObject(entry) && isString(entry['profileId']) && isString(entry['digest'])),
  profileTransition: (body: unknown): body is ProfileTransitionResult => isObject(body) && isString(body['outcome']) && isObject(body['profile']),
  decisions: (body: unknown): body is DecisionPage =>
    isObject(body) && isArrayOf(body['decisions'], (entry) => isObject(entry) && isString(entry['evaluationId']) && isString(entry['status'])) && (body['nextCursor'] === null || isString(body['nextCursor'])),
  evidence: (body: unknown): body is DecisionEvidence =>
    isObject(body) &&
    isObject(body['decision']) &&
    isString(body['decision']['evaluationId']) &&
    Array.isArray(body['references']) &&
    isObject(body['verification']) &&
    typeof body['verification']['valid'] === 'boolean' &&
    isObject(body['verification']['checks']) &&
    Object.values(body['verification']['checks']).every((value) => typeof value === 'boolean') &&
    Array.isArray(body['verification']['failures']) &&
    isObject(body['verification']['referenceIntegrity']) &&
    typeof body['verification']['referenceIntegrity']['legacyUnprotected'] === 'number',
} as const;
