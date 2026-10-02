import { classifyHostFailure, contractFailure, unreachableFailure, type HostFailure } from './failures.js';
import {
  shapes,
  type AgentView,
  type CredentialIssueResult,
  type CredentialRevokeResult,
  type DecisionEvidence,
  type DecisionPage,
  type EmergencyControls,
  type EmergencyTarget,
  type EmergencyTransitionResult,
  type EntityKind,
  type EntityRevokeResult,
  type EntityView,
  type ExecutionGrantView,
  type GrantRevokeResult,
  type GrantView,
  type OrganizationContext,
  type ProfileCatalog,
  type ProfileTransitionResult,
  type ProvisionResult,
} from './wire.js';

/**
 * CTRL-03 — the web control plane's one HTTP client boundary to the Frontera
 * Host.
 *
 * Every read and every write the console performs is one call here, over the
 * Host's shipped operator plane (`/api/admin/...`). This module holds no state:
 * it is handed the operator's bearer credential per call (from the server-side
 * session, never from the browser), sends it in the `Authorization` header and
 * nowhere else, follows no redirect, and reports either the Host's well-formed
 * 2xx body or a classified failure. It never logs, never retries, and never
 * turns a non-2xx answer into data.
 */

export type HostResult<T> = { readonly ok: true; readonly status: number; readonly body: T } | { readonly ok: false; readonly failure: HostFailure };

export interface HostClientOptions {
  /** The Host's base URL (scheme, host, port). */
  readonly baseUrl: string;
  /** Per-request deadline. */
  readonly timeoutMs?: number;
}

export interface DecisionQuery {
  readonly actorId?: string;
  readonly decisionId?: string;
  readonly requestId?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface HostClient {
  organization(bearer: string): Promise<HostResult<OrganizationContext>>;
  listAgents(bearer: string): Promise<HostResult<{ readonly agents: readonly AgentView[] }>>;
  agent(bearer: string, actorId: string): Promise<HostResult<AgentView>>;
  issueCredential(bearer: string, actorId: string, idempotencyKey: string): Promise<HostResult<CredentialIssueResult>>;
  rotateCredential(bearer: string, actorId: string, credentialId: string, idempotencyKey: string): Promise<HostResult<CredentialIssueResult>>;
  revokeCredential(bearer: string, actorId: string, credentialId: string, reason: string): Promise<HostResult<CredentialRevokeResult>>;
  listEntities(bearer: string, filter?: { readonly kind?: string; readonly status?: string }): Promise<HostResult<{ readonly entities: readonly EntityView[] }>>;
  entity(bearer: string, kind: EntityKind, entityId: string): Promise<HostResult<EntityView>>;
  provision(bearer: string, kind: EntityKind, body: Readonly<Record<string, unknown>>): Promise<HostResult<ProvisionResult>>;
  revokeEntity(bearer: string, kind: EntityKind, entityId: string, reason: string): Promise<HostResult<EntityRevokeResult>>;
  grant(bearer: string, grantId: string): Promise<HostResult<GrantView>>;
  revokeGrant(bearer: string, grantId: string, reason: string): Promise<HostResult<GrantRevokeResult>>;
  execution(bearer: string, executionId: string): Promise<HostResult<ExecutionGrantView>>;
  emergencyControls(bearer: string): Promise<HostResult<EmergencyControls>>;
  activateEmergencyControl(bearer: string, target: EmergencyTarget): Promise<HostResult<EmergencyTransitionResult>>;
  releaseEmergencyControl(bearer: string, target: EmergencyTarget): Promise<HostResult<EmergencyTransitionResult>>;
  profiles(bearer: string): Promise<HostResult<ProfileCatalog>>;
  transitionProfile(bearer: string, profileId: string, version: number, transition: 'activate' | 'retire', digest: string, reason?: string): Promise<HostResult<ProfileTransitionResult>>;
  decisions(bearer: string, query: DecisionQuery): Promise<HostResult<DecisionPage>>;
  decisionEvidence(bearer: string, evaluationId: string): Promise<HostResult<DecisionEvidence>>;
}

/**
 * One path segment. `.` and `..` are refused rather than encoded: a URL parser
 * resolves them (and their percent-encoded forms) as dot segments, which would
 * send the request to a different Host route than the one the operator
 * confirmed.
 */
class DotSegmentRefused extends Error {}
const segment = (value: string): string => {
  if (value === '.' || value === '..') throw new DotSegmentRefused();
  return encodeURIComponent(value);
};

function invalidTarget(): HostFailure {
  return { kind: 'validation', status: null, code: null, message: 'The target identifier is not a valid path segment. Nothing was sent to the Host.', failure: null, recorded: null };
}

export function createHostClient(options: HostClientOptions): HostClient {
  const base = new URL(options.baseUrl);
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') throw new Error('createHostClient: the Host base URL must carry no credentials, query or fragment.');
  const origin = base.origin;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function send<T>(method: 'GET' | 'POST', path: string, bearer: string, guard: (body: unknown) => body is T, body?: Readonly<Record<string, unknown>>): Promise<HostResult<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { ok: false, failure: unreachableFailure() };
    }
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status > 299) return { ok: false, failure: classifyHostFailure(response.status, parsed) };
    if (!guard(parsed)) return { ok: false, failure: contractFailure(response.status) };
    return { ok: true, status: response.status, body: parsed };
  }

  const query = (entries: Readonly<Record<string, string | number | undefined>>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== '') search.set(key, String(value));
    const text = search.toString();
    return text.length === 0 ? '' : `?${text}`;
  };

  const client: HostClient = {
    organization: (bearer) => send('GET', '/api/admin/organization', bearer, shapes.organization),
    listAgents: (bearer) => send('GET', '/api/admin/agents', bearer, shapes.agents),
    agent: (bearer, actorId) => send('GET', `/api/admin/agents/${segment(actorId)}`, bearer, shapes.agent),
    issueCredential: (bearer, actorId, idempotencyKey) => send('POST', `/api/admin/agents/${segment(actorId)}/credentials`, bearer, shapes.credentialIssue, { idempotencyKey }),
    rotateCredential: (bearer, actorId, credentialId, idempotencyKey) =>
      send('POST', `/api/admin/agents/${segment(actorId)}/credentials/${segment(credentialId)}/rotate`, bearer, shapes.credentialIssue, { idempotencyKey }),
    revokeCredential: (bearer, actorId, credentialId, reason) => send('POST', `/api/admin/agents/${segment(actorId)}/credentials/${segment(credentialId)}/revoke`, bearer, shapes.credentialRevoke, { reason }),
    listEntities: (bearer, filter = {}) => send('GET', `/api/admin/authority/entities${query({ kind: filter.kind, status: filter.status })}`, bearer, shapes.entities),
    entity: (bearer, kind, entityId) => send('GET', `/api/admin/authority/entities/${segment(kind)}/${segment(entityId)}`, bearer, shapes.entity),
    provision: (bearer, kind, body) => send('POST', `/api/admin/authority/entities/${segment(kind)}`, bearer, shapes.provision, body),
    revokeEntity: (bearer, kind, entityId, reason) => send('POST', `/api/admin/authority/entities/${segment(kind)}/${segment(entityId)}/revoke`, bearer, shapes.entityRevoke, { reason }),
    grant: (bearer, grantId) => send('GET', `/api/admin/authority/grants/${segment(grantId)}`, bearer, shapes.grant),
    revokeGrant: (bearer, grantId, reason) => send('POST', `/api/admin/authority/grants/${segment(grantId)}/revoke`, bearer, shapes.grantRevoke, { reason }),
    execution: (bearer, executionId) => send('GET', `/api/admin/authority/executions/${segment(executionId)}`, bearer, shapes.execution),
    emergencyControls: (bearer) => send('GET', '/api/admin/emergency-controls', bearer, shapes.emergency),
    activateEmergencyControl: (bearer, target) =>
      send('POST', '/api/admin/emergency-controls/activate', bearer, shapes.emergencyTransition, target.value === undefined ? { scope: target.scope } : { scope: target.scope, value: target.value }),
    releaseEmergencyControl: (bearer, target) =>
      send('POST', '/api/admin/emergency-controls/release', bearer, shapes.emergencyTransition, target.value === undefined ? { scope: target.scope } : { scope: target.scope, value: target.value }),
    profiles: (bearer) => send('GET', '/api/admin/governance-profiles', bearer, shapes.profiles),
    transitionProfile: (bearer, profileId, version, transition, digest, reason) =>
      send('POST', `/api/admin/governance-profiles/${segment(profileId)}/versions/${segment(String(version))}/${transition}`, bearer, shapes.profileTransition, reason === undefined ? { digest } : { digest, reason }),
    decisions: (bearer, decisionQuery) =>
      send('GET', `/api/admin/activity/decisions${query({ actorId: decisionQuery.actorId, decisionId: decisionQuery.decisionId, requestId: decisionQuery.requestId, status: decisionQuery.status, limit: decisionQuery.limit, cursor: decisionQuery.cursor })}`, bearer, shapes.decisions),
    decisionEvidence: (bearer, evaluationId) => send('GET', `/api/admin/evidence/decisions/${segment(evaluationId)}`, bearer, shapes.evidence),
  };
  // Every method builds its path before sending; a refused segment becomes a validation failure, never a request.
  const guarded = Object.fromEntries(
    Object.entries(client).map(([name, method]) => [
      name,
      (...args: unknown[]): Promise<HostResult<unknown>> => {
        try {
          return (method as (...a: unknown[]) => Promise<HostResult<unknown>>)(...args);
        } catch (error) {
          if (error instanceof DotSegmentRefused) return Promise.resolve({ ok: false, failure: invalidTarget() });
          throw error;
        }
      },
    ]),
  ) as unknown as HostClient;
  return Object.freeze(guarded);
}
