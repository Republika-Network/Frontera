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

// -- CTRL-04: the approval workflow ---------------------------------------------------
//
// What the Host serializes from the CORE-05 view (`operator-control/approval-workflow.ts`).
// Every state field is **derived by CORE-05** on the Host's read; the console
// displays it and never computes, increments or completes anything itself.

/** The inbox's closed views, rendered as links. The Host validates the value again. */
export const APPROVAL_VIEWS = ['pending', 'escalated', 'approved', 'rejected', 'revoked', 'expired', 'superseded', 'all'] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

/** The verdict verbs the Host routes, one path each. */
export const APPROVAL_VERBS = ['approve', 'reject', 'request-changes', 'escalate', 'revoke'] as const;
export type ApprovalVerb = (typeof APPROVAL_VERBS)[number];

export function isApprovalVerb(value: string): value is ApprovalVerb {
  return (APPROVAL_VERBS as readonly string[]).includes(value);
}

export function isApprovalView(value: string): value is ApprovalView {
  return (APPROVAL_VIEWS as readonly string[]).includes(value);
}

export interface ApprovalQuorum {
  readonly minimumApprovals: number;
  readonly countedApprovers: readonly string[];
  readonly satisfied: boolean;
}

export interface ApprovalInboxEntry {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly requestedAt: string;
  readonly status: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly governanceProfile: string;
  readonly quorum: ApprovalQuorum;
  readonly requestExpiresAt: string;
  readonly escalations: readonly { readonly actorId: string; readonly recordedAt: string; readonly reason: string | null }[];
  readonly changesRequested: number;
}

export interface ApprovalInbox {
  readonly view: string;
  readonly approvals: readonly ApprovalInboxEntry[];
}

export interface ApprovalVerdictRecord {
  readonly kind: string;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly counted: boolean;
  readonly reasonCode: string;
  readonly reason: string | null;
  readonly evidence: readonly { readonly type: string; readonly hash: string; readonly uri: string | null }[];
  readonly rowDigest: string;
}

export interface ApprovalDetail extends ApprovalInboxEntry {
  readonly subjectDigest: string;
  readonly canonicalSubject: string;
  readonly subject: {
    readonly evaluationId: string;
    readonly actorId: string;
    readonly principalActorId: string | null;
    readonly action: string;
    readonly resourceScope: string;
    readonly counterpartyId: string | null;
    readonly amount: { readonly value: string; readonly unit: string } | null;
    readonly governanceProfile: string;
    readonly actionClass: string;
    readonly resourceClass: string;
    readonly parameters: readonly { readonly dimension: string; readonly type: string; readonly value: string | number }[];
    readonly contextDigest: string | null;
    readonly contextValidUntil: string | null;
    readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string };
    readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string };
  };
  readonly requirement: {
    readonly approverAction: string;
    readonly minimumApprovals: number;
    readonly requestTtlSeconds: number;
    readonly approvalValiditySeconds: number;
    readonly requiredEvidence: readonly string[];
    readonly digest: string;
  };
  readonly superseded: boolean;
  readonly approvedAt: string | null;
  readonly notAfter: string | null;
  readonly approvalDigest: string | null;
  readonly closedBy: string | null;
  readonly verdicts: readonly ApprovalVerdictRecord[];
}

export interface ApprovalCommandBody {
  readonly subjectDigest: string;
  readonly evidence?: readonly { readonly type: string; readonly hash: string; readonly uri?: string }[];
  readonly reason?: string;
}

export interface ApprovalCommandResponse {
  readonly outcome: string;
  readonly verdict: string;
  /** CORE-05's canonical re-read after the append. */
  readonly approval: ApprovalDetail;
}

// -- PROD-03-01 operational visibility (the Host's `/api/admin/operations/...` reads) --------------

/** One governed request as the Host classified it through its ASSURE-01 trace. */
export interface OperationalExecution {
  readonly requestId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly executionId: string | null;
  readonly actorId: string;
  readonly actionType: string;
  readonly classification: string;
  readonly attentionRequired: boolean;
  readonly attentionReasons: readonly string[];
  readonly unresolved: boolean;
  readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string; readonly persistedAt: string };
  readonly approval: { readonly presence: string; readonly verdicts: readonly string[] } | null;
  readonly issuance: { readonly status: string; readonly withheldBy: string | null; readonly reasonCodes: readonly string[]; readonly recordedAt: string | null };
  readonly execution: { readonly claim: string; readonly claimedAt: string | null };
  readonly outcome: { readonly status: string; readonly source: string | null; readonly failure: string | null; readonly withheldBy: string | null; readonly reasonCodes: readonly string[]; readonly recordedAt: string | null };
  readonly trace: { readonly available: boolean; readonly finalState: string | null; readonly failure: string | null };
}

export interface ExecutionsPage {
  readonly executions: readonly OperationalExecution[];
  readonly nextCursor: string | null;
  readonly coverage: string;
}

export interface AttentionPage {
  readonly attention: readonly OperationalExecution[];
  readonly nextCursor: string | null;
  readonly resolvedOnRead: number;
  readonly coverage: string;
}

export interface OperationalScan {
  readonly candidates: number;
  readonly examined: number;
  readonly complete: boolean;
  readonly limit: number;
}

export interface OperationalMetrics {
  readonly decisions: { readonly total: number; readonly allowed: number; readonly denied: number; readonly approvalRequired: number; readonly indeterminate: number };
  readonly issuanceWithheld: number;
  readonly executionClaims: number;
  readonly confirmedOutcomes: number | null;
  readonly unresolvedExecutions: number;
  readonly attentionRequired: number;
  readonly scan: OperationalScan;
  readonly computedAt: string;
  readonly coverage: string;
}

export interface OperationsHealth {
  /** The Host's own health report, exactly as `/health` states it. Rendered field by field; nothing is inferred from it. */
  readonly health: {
    readonly status: string;
    readonly enterpriseVersion: string;
    readonly kernelVersion: string;
    readonly checkedAt: string;
    readonly lifecycleState?: string;
    readonly ready?: boolean;
    readonly posture?: Readonly<Record<string, string | number>>;
    readonly persistence: { readonly provider: string; readonly status: string };
  };
  readonly operations: { readonly unresolvedExecutions: number; readonly attentionRequired: number; readonly scan: OperationalScan; readonly checkedAt: string };
}

export interface TraceCheck {
  readonly check: string;
  readonly category: string;
  readonly status: string;
  readonly detail?: string;
}

export interface OperationalTrace {
  readonly requestId: string;
  readonly disclosure: { readonly level: string; readonly policyId: string; readonly hiddenFields: readonly string[] };
  readonly trace: {
    readonly requestId: string;
    readonly evaluationId: string;
    readonly decisionId: string;
    readonly executionId?: string;
    readonly summary?: { readonly path: string; readonly finalState: string; readonly presence: Readonly<Record<string, string>> } | string;
    readonly stages: Readonly<Record<string, unknown>>;
  };
  readonly traceDigest: string;
  readonly verification: { readonly verified: boolean; readonly categories: Readonly<Record<string, string>>; readonly checks: readonly TraceCheck[]; readonly finalState: string; readonly verifiedAt: string; readonly boundary: string };
  readonly operational: OperationalExecution;
  readonly generatedAt: string;
}

/** Trace levels an operator may ask the Host for. FULL is internal to the Host and never offered. */
export const TRACE_LEVELS = ['AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC'] as const;

export function isTraceLevel(value: string): value is (typeof TRACE_LEVELS)[number] {
  return (TRACE_LEVELS as readonly string[]).includes(value);
}

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
  approvalEntry: (entry: unknown): entry is ApprovalInboxEntry =>
    isObject(entry) &&
    isString(entry['approvalRequestId']) &&
    isString(entry['requestId']) &&
    isString(entry['status']) &&
    isString(entry['actorId']) &&
    isObject(entry['quorum']) &&
    typeof entry['quorum']['minimumApprovals'] === 'number' &&
    isArrayOf(entry['quorum']['countedApprovers'], isString) &&
    typeof entry['quorum']['satisfied'] === 'boolean' &&
    Array.isArray(entry['escalations']),
  approvals: (body: unknown): body is ApprovalInbox => isObject(body) && isString(body['view']) && isArrayOf(body['approvals'], (entry) => shapes.approvalEntry(entry)),
  approval: (body: unknown): body is ApprovalDetail =>
    isObject(body) &&
    shapes.approvalEntry(body) &&
    isString(body['subjectDigest']) &&
    isString(body['canonicalSubject']) &&
    isObject(body['subject']) &&
    isObject(body['requirement']) &&
    isArrayOf(body['verdicts'], (verdict) => isObject(verdict) && isString(verdict['kind']) && typeof verdict['counted'] === 'boolean' && Array.isArray(verdict['evidence'])),
  operationalExecution: (entry: unknown): entry is OperationalExecution =>
    isObject(entry) &&
    isString(entry['requestId']) &&
    isString(entry['evaluationId']) &&
    isString(entry['classification']) &&
    typeof entry['attentionRequired'] === 'boolean' &&
    isArrayOf(entry['attentionReasons'], isString) &&
    typeof entry['unresolved'] === 'boolean' &&
    isObject(entry['decision']) &&
    isString(entry['decision']['status']) &&
    isObject(entry['issuance']) &&
    isObject(entry['execution']) &&
    isObject(entry['outcome']) &&
    isObject(entry['trace']),
  executions: (body: unknown): body is ExecutionsPage =>
    isObject(body) && isArrayOf(body['executions'], (entry) => shapes.operationalExecution(entry)) && (body['nextCursor'] === null || isString(body['nextCursor'])),
  attention: (body: unknown): body is AttentionPage =>
    isObject(body) && isArrayOf(body['attention'], (entry) => shapes.operationalExecution(entry)) && (body['nextCursor'] === null || isString(body['nextCursor'])) && typeof body['resolvedOnRead'] === 'number',
  operationalScan: (scan: unknown): scan is OperationalScan =>
    isObject(scan) && typeof scan['candidates'] === 'number' && typeof scan['examined'] === 'number' && typeof scan['complete'] === 'boolean' && typeof scan['limit'] === 'number',
  metrics: (body: unknown): body is OperationalMetrics =>
    isObject(body) &&
    isObject(body['decisions']) &&
    typeof body['decisions']['total'] === 'number' &&
    typeof body['issuanceWithheld'] === 'number' &&
    typeof body['executionClaims'] === 'number' &&
    (body['confirmedOutcomes'] === null || typeof body['confirmedOutcomes'] === 'number') &&
    typeof body['unresolvedExecutions'] === 'number' &&
    typeof body['attentionRequired'] === 'number' &&
    shapes.operationalScan(body['scan']),
  operationsHealth: (body: unknown): body is OperationsHealth =>
    isObject(body) &&
    isObject(body['health']) &&
    isString(body['health']['status']) &&
    isObject(body['health']['persistence']) &&
    isObject(body['operations']) &&
    typeof body['operations']['unresolvedExecutions'] === 'number' &&
    typeof body['operations']['attentionRequired'] === 'number' &&
    shapes.operationalScan(body['operations']['scan']),
  trace: (body: unknown): body is OperationalTrace =>
    isObject(body) &&
    isString(body['requestId']) &&
    isObject(body['disclosure']) &&
    isString(body['disclosure']['level']) &&
    isObject(body['trace']) &&
    isObject(body['trace']['stages']) &&
    isString(body['traceDigest']) &&
    isObject(body['verification']) &&
    typeof body['verification']['verified'] === 'boolean' &&
    isArrayOf(body['verification']['checks'], (entry) => isObject(entry) && isString(entry['check']) && isString(entry['status'])) &&
    shapes.operationalExecution(body['operational']),
  approvalCommand: (body: unknown): body is ApprovalCommandResponse => isObject(body) && body['outcome'] === 'recorded' && isString(body['verdict']) && shapes.approval(body['approval']),
} as const;
