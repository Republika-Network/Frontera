import { EnterpriseHttpError, EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { isCanonicalEntityId, isKernelAuthorityEntityKind } from '../authority-administration/contracts.js';
import { toAdministeredAuthorityEntityView, type AdministeredAuthorityEntityView } from '../authority-administration/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import type { GovernanceProfileRegistry, ResolvedGovernanceProfile } from '../governance-profile/index.js';
import type { KernelAuthorityAccessContext, KernelAuthorityEntityKind, KernelAuthorityRecord } from '../kernel-authority/contracts.js';
import { isKernelAuthorityError } from '../kernel-authority/errors.js';
import { hydrateKernelAuthorityWorld } from '../kernel-authority/hydration.js';
import { compareKernelAuthorityRecords, readExternalSubject, type KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { validateKernelAuthorityMonetaryConstraints } from '../kernel-authority/monetary-constraints.js';
import { readKernelAuthorityParameterBounds } from '../kernel-authority/parameter-bounds.js';
import { compareGovernedParameterBound, governedParameterBoundComparisonPermits } from '../../features/governed-parameter-runtime/index.js';
import type { KernelAuthorityProvisioningResult, KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { agentCredentialVerifier, agentPrincipalIdFor, formatAgentCredential, isAgentCredentialId, newAgentCredentialId, newAgentCredentialSecret } from './agent-credentials.js';
import {
  BOOTSTRAP_ACTOR_TYPES,
  closedQuery,
  isOperatorEntityId,
  profileVersionOf,
  provisionedEntityId,
  toAgentCredentialView,
  validateCredentialRequest,
  validateProfileTransitionRequest,
  validateProvisionRequest,
  validateReasonRequest,
  type AgentCredentialIssueResponse,
  type AgentInventoryView,
  type AuthorityReferenceView,
  type OperatorProvisionRequest,
  type OrganizationView,
  type ProfileVersionView,
} from './contracts.js';
import { isControlPlaneStoreError, type ControlPlaneStore, type ProfileLifecycleEvent } from './control-plane-store.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from './operator-authenticator.js';
import { permissionsOf, type OperatorPermission } from './roles.js';

/**
 * CTRL-02 — the operator control service: organizations, human operators and
 * the agent inventory, over the existing authoritative services.
 *
 * Every operation runs the same sequence, in this order:
 *
 * ```
 * Authorization header
 *   └─ OperatorAuthenticator.authorize(header, permission)    401 / 403 / 503, before any body is read
 *       └─ closed path + query + body                         400
 *           └─ server-derived context: { system: true, organizationId: <served>, actorId: operator:<id> }
 *               ├─ Kernel Authority:  KernelAuthorityProvisioningService (existing append rules), after a
 *               │                     dry-run replay of the would-be world through the real engines
 *               ├─ agent credentials: ControlPlaneStore (verifier only; reveal once)
 *               └─ profile lifecycle: ControlPlaneStore, then the registry's lifecycle view reloads
 * ```
 *
 * What it cannot do, by the objects it is handed: mint or issue a bounded
 * grant (it holds no grant store, issuance core or Kernel), un-revoke anything
 * (no port offers it), sign anything, reach a database driver, or write a
 * Kernel Authority event except through the provisioning service.
 */

export type OperatorBodyReader = () => Promise<unknown>;
export type OperatorQuery = Readonly<Record<string, string>>;

export interface OperatorControlService {
  describeOrganization(authorizationHeader: string | undefined, query: OperatorQuery): Promise<OrganizationView>;
  listAgents(authorizationHeader: string | undefined, query: OperatorQuery): Promise<{ readonly agents: readonly AgentInventoryView[] }>;
  inspectAgent(authorizationHeader: string | undefined, actorId: string, query: OperatorQuery): Promise<AgentInventoryView>;
  issueAgentCredential(authorizationHeader: string | undefined, actorId: string, readBody: OperatorBodyReader): Promise<AgentCredentialIssueResponse>;
  rotateAgentCredential(authorizationHeader: string | undefined, actorId: string, credentialId: string, readBody: OperatorBodyReader): Promise<AgentCredentialIssueResponse>;
  revokeAgentCredential(authorizationHeader: string | undefined, actorId: string, credentialId: string, readBody: OperatorBodyReader): Promise<{ readonly outcome: 'revoked' | 'already-revoked'; readonly actorId: string; readonly credential: AgentInventoryView['credentials'][number] }>;
  listAuthorityEntities(authorizationHeader: string | undefined, query: OperatorQuery): Promise<{ readonly entities: readonly AdministeredAuthorityEntityView[] }>;
  provisionAuthorityEntity(authorizationHeader: string | undefined, entityKind: string, readBody: OperatorBodyReader): Promise<{ readonly outcome: 'provisioned' | 'replayed'; readonly entity: AdministeredAuthorityEntityView }>;
  listGovernanceProfiles(authorizationHeader: string | undefined, query: OperatorQuery): Promise<{ readonly lifecycle: 'operator-promoted' | 'static'; readonly profiles: readonly ProfileVersionView[] }>;
  transitionGovernanceProfile(
    authorizationHeader: string | undefined,
    profileId: string,
    version: string,
    transition: 'activate' | 'retire',
    readBody: OperatorBodyReader,
  ): Promise<{ readonly outcome: 'activated' | 'retired' | 'already-active' | 'already-retired'; readonly profile: ProfileVersionView; readonly superseded: ProfileVersionView | null }>;
}

export interface OperatorProfileLifecycle {
  /** Reloads the registry's lifecycle view from the durable store. Called only after a committed transition. */
  reload(): Promise<void>;
}

export interface OperatorControlDependencies {
  readonly authenticator: OperatorAuthenticator;
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** The governed-action trust domain, when governed actions are composed. Reported, never used to scope a write. */
  readonly trustDomainId?: string;
  readonly now: () => string;
  readonly logger: EnterpriseLogger;
  readonly kernelAuthority: {
    readonly store: Pick<KernelAuthorityStore, 'getRecord' | 'listRecords'>;
    readonly provisioning: Pick<
      KernelAuthorityProvisioningService,
      'provisionActor' | 'provisionTrustDomain' | 'provisionRootIssuer' | 'provisionPassport' | 'provisionCapabilityToken' | 'provisionAuthorityGrant' | 'provisionDelegationGrant'
    >;
  };
  /** Agent credentials and the profile lifecycle. Absent: no credential or lifecycle route is composed (404). */
  readonly controlPlane?: Pick<
    ControlPlaneStore,
    'issueAgentCredential' | 'revokeAgentCredential' | 'getAgentPrincipalByActor' | 'listAgentCredentials' | 'listProfileLifecycleEvents' | 'transitionProfile'
  >;
  /** External subjects of statically configured customer principals: an operator never issues a second principal for one. */
  readonly staticCustomerSubjects: readonly { readonly system: string; readonly subjectId: string }[];
  readonly governance: GovernanceProfileRegistry;
  /** Present exactly when the registry is in `operator-promoted` lifecycle mode. */
  readonly profileLifecycle?: OperatorProfileLifecycle;
}

function notComposed(capability: string): EnterpriseHttpError {
  return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED', `${capability} is not composed on this Host.`);
}

function notFound(message: string): EnterpriseHttpError {
  return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND', message);
}

function refused(message: string, failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(409, 'OPERATOR_OPERATION_REFUSED', message, undefined, { failure, recorded: false });
}

function unavailable(): EnterpriseHttpError {
  return new EnterpriseHttpError(503, 'AUTHORITY_STATE_UNAVAILABLE', 'The authoritative store is unavailable. Nothing was read or changed.');
}

function integrityFailed(failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(
    500,
    'AUTHORITY_STATE_INTEGRITY_FAILED',
    'The authoritative state could not be verified, so it is not reported and nothing was changed. Treat this as a security incident; see the operator runbook.',
    undefined,
    { failure },
  );
}

function committedRefreshFailed(): EnterpriseHttpError {
  return new EnterpriseHttpError(
    503,
    'AUTHORITY_STATE_REFRESH_FAILED',
    'The authority write was durably recorded, but this Host could not refresh its in-memory authority projection, which now fails closed (decisions are denied) until a refresh succeeds. Retry the SAME request — same target, terms and idempotency key — to replay the committed record and refresh. Do not submit a different request.',
    undefined,
    { recorded: true, retry: 'same-request' },
  );
}

const KIND_PERMISSION: Readonly<Record<KernelAuthorityEntityKind, OperatorPermission>> = {
  'trust-domain': 'authority.bootstrap',
  'root-issuer': 'authority.bootstrap',
  actor: 'authority.provision',
  passport: 'authority.provision',
  'capability-token': 'authority.provision',
  'authority-grant': 'authority.provision',
  'delegation-grant': 'authority.provision',
};

export function createOperatorControlService(dependencies: OperatorControlDependencies): OperatorControlService {
  const { authenticator, organizationId, now, logger, governance } = dependencies;
  const { store, provisioning } = dependencies.kernelAuthority;
  if (authenticator.organizationId !== organizationId) throw new Error('createOperatorControlService: the authenticator serves another organization.');

  /** Reads are organization-scoped, never system: an operator reads this Host's organization and nothing else. */
  const readContext: KernelAuthorityAccessContext = Object.freeze({ system: false, organizationId });
  const staticSubjects = new Set(dependencies.staticCustomerSubjects.map((subject) => JSON.stringify([subject.system, subject.subjectId])));

  /**
   * Provisioning writes are serialized in this process: the dry-run replay and
   * the append it vouches for see the same world. One Host serves one
   * organization from one process (CORE-04), so this is the whole writer set.
   */
  let writes: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = writes.then(work, work);
    writes = run.catch(() => undefined);
    return run;
  }

  function audit(operator: EnterpriseOperatorPrincipal, operation: string, target: string, outcome: string): void {
    logger.info('enterprise.operator.control', { operatorId: operator.operatorId, organizationId, operation, target, status: outcome });
  }

  /** The write context, derived only after authorization and only from the authenticated operator and the served organization. */
  function operatorContext(operator: EnterpriseOperatorPrincipal): KernelAuthorityAccessContext {
    return Object.freeze({ system: true, organizationId, actorId: operator.actorRef });
  }

  function mapKernelAuthorityError(error: unknown): never {
    if (isKernelAuthorityError(error)) {
      switch (error.code) {
        case 'KERNEL_AUTHORITY_ENTITY_NOT_FOUND':
          throw notFound('No Kernel Authority entity of that kind and id is provisioned in this organization.');
        case 'KERNEL_AUTHORITY_VALIDATION_ERROR':
          throw EnterpriseHttpErrors.invalidRequest(error.message);
        case 'KERNEL_AUTHORITY_REFRESH_FAILED':
          throw committedRefreshFailed();
        case 'KERNEL_AUTHORITY_STORE_UNAVAILABLE':
          throw unavailable();
        case 'KERNEL_AUTHORITY_INTEGRITY_FAILED':
        case 'KERNEL_AUTHORITY_VERSION_UNSUPPORTED':
          throw integrityFailed(error.code);
        case 'KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT':
          throw new EnterpriseHttpError(409, 'OPERATOR_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for different authority. Nothing was written.', undefined, { recorded: false });
        default:
          throw refused(`The Kernel Authority refused the operation (${error.code}). Nothing was written.`, error.code);
      }
    }
    throw error;
  }

  function mapControlPlaneError(error: unknown): never {
    if (isControlPlaneStoreError(error)) {
      switch (error.code) {
        case 'CONTROL_PLANE_STORE_UNAVAILABLE':
          throw unavailable();
        case 'CONTROL_PLANE_INTEGRITY_FAILED':
        case 'CONTROL_PLANE_VERSION_UNSUPPORTED':
          throw integrityFailed(error.code);
        case 'CONTROL_PLANE_IDEMPOTENCY_CONFLICT':
          throw new EnterpriseHttpError(409, 'OPERATOR_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request. Nothing was written.', undefined, { recorded: false });
        case 'CONTROL_PLANE_NOT_FOUND':
          throw notFound(error.message);
        case 'CONTROL_PLANE_CONFLICT':
          throw refused(error.message, error.code);
      }
    }
    throw error;
  }

  async function records(): Promise<readonly KernelAuthorityRecord[]> {
    try {
      const all = await store.listRecords(readContext, { organizationId });
      // The served organization only, re-proven: a record of any other is corruption, never data.
      if (all.some((record) => record.organizationId !== organizationId)) throw integrityFailed('KERNEL_AUTHORITY_RECORD_MISMATCH');
      return all;
    } catch (error) {
      if (error instanceof EnterpriseHttpError) throw error;
      return mapKernelAuthorityError(error);
    }
  }

  async function recordOf(entityKind: KernelAuthorityEntityKind, entityId: string): Promise<KernelAuthorityRecord | null> {
    let record: KernelAuthorityRecord | null;
    try {
      record = await store.getRecord(readContext, organizationId, entityKind, entityId);
    } catch (error) {
      return mapKernelAuthorityError(error);
    }
    if (record !== null && (record.organizationId !== organizationId || record.entityKind !== entityKind || record.entityId !== entityId)) throw integrityFailed('KERNEL_AUTHORITY_RECORD_MISMATCH');
    return record;
  }

  /**
   * Replays the world as it would be after this write — every committed record
   * plus the candidate — through the real Recognition Runtime and Authority
   * Graph, the same `hydrateKernelAuthorityWorld` the Host boots with. A record
   * the engines would refuse (a passport for an actor that does not exist, a
   * delegation from a grant that does not) is refused **before** it is
   * appended: once committed it could never be removed, and every later boot
   * would refuse to hydrate.
   */
  function dryRun(existing: readonly KernelAuthorityRecord[], kind: KernelAuthorityEntityKind, entityId: string, payload: Readonly<Record<string, unknown>>, operator: EnterpriseOperatorPrincipal): void {
    const at = now();
    const trustDomainId = kind === 'trust-domain' ? entityId : typeof payload['trustDomainId'] === 'string' ? (payload['trustDomainId'] as string) : undefined;
    const candidate: KernelAuthorityRecord = {
      organizationId,
      entityKind: kind,
      entityId,
      status: 'active',
      payload,
      provisionedBy: operator.actorRef,
      provisionedAt: at,
      latestSequence: 1,
      latestEventDigest: 'dry-run',
      ...(trustDomainId !== undefined ? { trustDomainId } : {}),
    };
    let counter = 0;
    try {
      hydrateKernelAuthorityWorld([...existing, candidate].sort(compareKernelAuthorityRecords), { now: () => at, nextId: (prefix) => `${prefix}-dry-run-${(counter += 1)}` });
    } catch (error) {
      const code = isKernelAuthorityError(error) ? error.code : 'KERNEL_AUTHORITY_REFERENCE_INVALID';
      throw refused(
        `The decision engine could not replay this ${kind} with the authority already provisioned (${code}): a reference it names is missing or not acceptable. Nothing was written. Provision what it depends on first.`,
        code,
      );
    }
  }

  /**
   * Every party, domain and source a request names must already exist in this
   * organization and be live. The engines tolerate some dangling references
   * (an authority grant for an actor that does not exist replays and simply
   * never authorizes); an operator typing one has made a mistake, and standing
   * authority is never assigned to, from or under something that is not there
   * — or that was revoked.
   */
  function assertReferences(existing: readonly KernelAuthorityRecord[], request: OperatorProvisionRequest): void {
    const live = (kind: KernelAuthorityEntityKind | readonly KernelAuthorityEntityKind[], id: string): KernelAuthorityRecord | undefined =>
      existing.find((record) => (Array.isArray(kind) ? kind.includes(record.entityKind) : record.entityKind === kind) && record.entityId === id);
    const need = (kind: KernelAuthorityEntityKind | readonly KernelAuthorityEntityKind[], id: string | undefined, field: string): void => {
      if (id === undefined) return;
      const record = live(kind, id);
      if (record === undefined) throw refused(`${field} '${id}' names nothing provisioned in this organization. Nothing was written.`, 'KERNEL_AUTHORITY_REFERENCE_INVALID');
      if (record.status !== 'active') throw refused(`${field} '${id}' is revoked; authority is never assigned to, from or under revoked authority. Nothing was written.`, 'KERNEL_AUTHORITY_REFERENCE_REVOKED');
    };
    const input = request.input as unknown as Readonly<Record<string, unknown>>;
    const text = (field: string): string | undefined => (typeof input[field] === 'string' ? (input[field] as string) : undefined);
    for (const field of ['issuerId', 'issuerActorId', 'subjectActorId', 'principalActorId', 'delegatorActorId', 'delegateActorId']) need('actor', text(field), field);
    if (request.kind === 'root-issuer') need('actor', request.input.actorId, 'actorId');
    if (request.kind === 'trust-domain') for (const issuer of request.input.acceptedIssuerIds) need('actor', issuer, 'acceptedIssuerIds');
    else need('trust-domain', text('trustDomainId'), 'trustDomainId');
    need('authority-grant', text('parentGrantId'), 'parentGrantId');
    need(['authority-grant', 'delegation-grant'], text('sourceAuthorityGrantId'), 'sourceAuthorityGrantId');
  }

  /**
   * CTRL-02 — standing typed-parameter authority must be **effective and
   * attenuating**, or it is refused before anything is written.
   *
   * Effective: for every action × resource pair the record covers, the Host's
   * trusted governance must resolve a Governance Profile that governs that
   * dimension, the dimension must be declared with the bound's type, and the
   * bound's kind must suit the declaration (`exact` always; `maximum` only for a
   * dimension declared `maximum`). An inert bound — one no request in scope
   * could ever carry — is refused rather than recorded as if it constrained
   * something. (Conservative: under the operator-promoted lifecycle a profile
   * must be active for its pairs to resolve.)
   *
   * Attenuating: every bound on the upstream lineage (the source grant and its
   * parents, or the source delegation chain) must be restated by this record as
   * equal or narrower (`compareGovernedParameterBound`); a delegate may add new
   * bounds, never drop or widen one. (At decision every hop applies regardless —
   * this refuses the record that would merely read as wider.)
   */
  function assertParameterAuthority(existing: readonly KernelAuthorityRecord[], request: OperatorProvisionRequest): void {
    if (request.kind !== 'authority-grant' && request.kind !== 'delegation-grant') return;
    const own = request.input.parameterBounds ?? [];
    for (const bound of own) {
      const declared = governance.dimensions.get(bound.dimension);
      if (declared === undefined) throw refused(`parameterBounds names dimension '${bound.dimension}', which this Host's governance does not declare.`, 'PARAMETER_BOUND_DIMENSION_UNDECLARED');
      if (declared.type !== bound.type || (bound.kind === 'maximum' && declared.bound !== 'maximum')) {
        throw refused(`parameterBounds states a ${bound.kind} ${bound.type} bound on '${bound.dimension}', which is declared ${declared.bound} ${declared.type}.`, 'PARAMETER_BOUND_DECLARATION_MISMATCH');
      }
      for (const action of request.input.actions) {
        for (const resource of request.input.resourceScopes) {
          const resolution = governance.resolve(action, resource);
          if (resolution.kind !== 'resolved' || !resolution.profile.definition.parameters.some((parameter) => parameter.dimension === bound.dimension)) {
            throw refused(`parameterBounds bounds '${bound.dimension}', but no active Governance Profile governs it for ${action} × ${resource}: the bound could never constrain that pair. Narrow the scope or declare the dimension.`, 'PARAMETER_BOUND_UNVERIFIABLE');
          }
        }
      }
    }
    // The upstream lineage, by record: an authority grant's parents, or a delegation's source chain.
    const byRef = new Map(existing.map((record) => [`${record.entityKind}:${record.entityId}`, record]));
    const upstream: KernelAuthorityRecord[] = [];
    const visit = (ref: string | undefined, guard: number): void => {
      if (ref === undefined || guard > 50) return;
      const record = byRef.get(ref);
      if (record === undefined) return;
      upstream.push(record);
      if (record.entityKind === 'authority-grant') {
        const parent = record.payload['parentGrantId'];
        visit(typeof parent === 'string' ? `authority-grant:${parent}` : undefined, guard + 1);
      } else {
        const source = record.payload['sourceAuthorityGrantId'];
        if (typeof source === 'string') visit(byRef.has(`authority-grant:${source}`) ? `authority-grant:${source}` : `delegation-grant:${source}`, guard + 1);
      }
    };
    if (request.kind === 'authority-grant') visit(request.input.parentGrantId === undefined ? undefined : `authority-grant:${request.input.parentGrantId}`, 0);
    else visit(byRef.has(`authority-grant:${request.input.sourceAuthorityGrantId}`) ? `authority-grant:${request.input.sourceAuthorityGrantId}` : `delegation-grant:${request.input.sourceAuthorityGrantId}`, 0);
    for (const record of upstream) {
      for (const parent of readKernelAuthorityParameterBounds(record.payload)) {
        const child = own.find((bound) => bound.dimension === parent.dimension);
        if (child === undefined) {
          throw refused(`The source lineage bounds '${parent.dimension}' (${record.entityKind}:${record.entityId}); a delegate must restate it, equal or narrower — it is never dropped.`, 'PARAMETER_BOUND_REMOVED');
        }
        const { dimension: _p, ...parentBound } = parent;
        const { dimension: _c, ...childBound } = child;
        if (!governedParameterBoundComparisonPermits(compareGovernedParameterBound(parentBound, childBound))) {
          throw refused(`parameterBounds widens or changes '${parent.dimension}' beyond ${record.entityKind}:${record.entityId}; a delegate may only narrow.`, 'PARAMETER_BOUND_WIDENED');
        }
      }
    }
  }

  function provisionThrough(request: OperatorProvisionRequest, context: KernelAuthorityAccessContext, idempotencyKey: string | undefined): Promise<KernelAuthorityProvisioningResult> {
    const options = idempotencyKey !== undefined ? { idempotency: { idempotencyKey } } : undefined;
    switch (request.kind) {
      case 'actor':
        return provisioning.provisionActor(context, request.input, options);
      case 'trust-domain':
        return provisioning.provisionTrustDomain(context, request.input, options);
      case 'root-issuer':
        return provisioning.provisionRootIssuer(context, request.input, options);
      case 'passport':
        return provisioning.provisionPassport(context, request.input, options);
      case 'capability-token':
        return provisioning.provisionCapabilityToken(context, request.input, options);
      case 'authority-grant':
        return provisioning.provisionAuthorityGrant(context, request.input, options);
      case 'delegation-grant':
        return provisioning.provisionDelegationGrant(context, request.input, options);
    }
  }

  function controlPlane(): NonNullable<OperatorControlDependencies['controlPlane']> {
    if (dependencies.controlPlane === undefined) throw notComposed('Agent credentials and the profile lifecycle');
    return dependencies.controlPlane;
  }

  function referencesTo(all: readonly KernelAuthorityRecord[], actorId: string): AgentInventoryView['authority'] {
    const ref = (record: KernelAuthorityRecord): AuthorityReferenceView => ({ entityKind: record.entityKind, entityId: record.entityId, status: record.status });
    const of = (kind: KernelAuthorityEntityKind, field: string): readonly AuthorityReferenceView[] =>
      all.filter((record) => record.entityKind === kind && record.payload[field] === actorId).map(ref);
    return {
      passports: of('passport', 'subjectActorId'),
      capabilityTokens: of('capability-token', 'subjectActorId'),
      authorityGrants: of('authority-grant', 'subjectActorId'),
      delegationGrants: of('delegation-grant', 'delegateActorId'),
    };
  }

  async function agentView(actor: KernelAuthorityRecord, all: readonly KernelAuthorityRecord[]): Promise<AgentInventoryView> {
    const payload = actor.payload;
    const subject = readExternalSubject(payload);
    let principalId: string | null = null;
    let credentials: AgentInventoryView['credentials'] = [];
    if (dependencies.controlPlane !== undefined) {
      try {
        const principal = await dependencies.controlPlane.getAgentPrincipalByActor(organizationId, actor.entityId);
        if (principal !== undefined) {
          principalId = principal.principalId;
          credentials = (await dependencies.controlPlane.listAgentCredentials(organizationId, principal.principalId)).map(toAgentCredentialView);
        }
      } catch (error) {
        mapControlPlaneError(error);
      }
    }
    const authority = referencesTo(all, actor.entityId);
    const standing = [...authority.capabilityTokens, ...authority.authorityGrants, ...authority.delegationGrants].some((reference) => reference.status === 'active');
    return {
      actorId: actor.entityId,
      displayName: typeof payload['displayName'] === 'string' ? (payload['displayName'] as string) : actor.entityId,
      status: actor.status,
      externalSubject: subject === undefined ? null : { system: subject.system, subjectId: subject.subjectId },
      trustDomainId: actor.trustDomainId ?? null,
      provisionedBy: actor.provisionedBy,
      provisionedAt: actor.provisionedAt,
      revokedBy: actor.revokedBy ?? null,
      revokedAt: actor.revokedAt ?? null,
      revocationReason: actor.revocationReason ?? null,
      principalId,
      credentials,
      authority,
      onboarding: {
        actor: actor.status,
        credential: credentials.some((credential) => credential.status === 'active') ? 'active' : 'none',
        standingAuthority: standing ? 'assigned' : 'none',
      },
    };
  }

  const isAgent = (record: KernelAuthorityRecord): boolean => record.entityKind === 'actor' && record.payload['type'] === 'agent';

  async function agentRecord(actorId: string): Promise<KernelAuthorityRecord> {
    if (!isOperatorEntityId(actorId) && !isCanonicalEntityId(actorId)) throw EnterpriseHttpErrors.invalidRequest('actorId must be a non-empty identifier of at most 256 characters.');
    const record = await recordOf('actor', actorId);
    if (record === null || !isAgent(record)) throw notFound('No agent actor with that id is provisioned in this organization.');
    return record;
  }

  async function issue(operator: EnterpriseOperatorPrincipal, actorId: string, idempotencyKey: string, replaces: string | undefined): Promise<AgentCredentialIssueResponse> {
    const cp = controlPlane();
    const actor = await agentRecord(actorId);
    const subject = readExternalSubject(actor.payload);
    if (subject === undefined) throw refused('This agent has no external subject; customer admission resolves an agent only through one. Provision the agent with an externalSubject.', 'AGENT_EXTERNAL_SUBJECT_REQUIRED');
    if (actor.status !== 'active') throw refused('This agent is revoked. Revocation is terminal; onboard a new agent under a new identity.', 'KERNEL_AUTHORITY_ENTITY_REVOKED');
    if (staticSubjects.has(JSON.stringify([subject.system, subject.subjectId]))) {
      throw refused("This agent's external subject is bound to a configured customer principal; one external subject has one principal.", 'AGENT_SUBJECT_STATICALLY_CONFIGURED');
    }
    const principalId = agentPrincipalIdFor(actor.entityId);
    if (principalId.length > 256) throw refused('This agent id is too long for a customer principal.', 'AGENT_PRINCIPAL_ID_TOO_LONG');
    const credentialId = newAgentCredentialId();
    const secret = newAgentCredentialSecret();
    let result;
    try {
      result = await cp.issueAgentCredential({
        organizationId,
        principal: { principalId, actorId: actor.entityId, externalSubject: { system: subject.system, subjectId: subject.subjectId } },
        credentialId,
        verifier: agentCredentialVerifier(secret),
        operatorRef: operator.actorRef,
        at: now(),
        idempotencyKey,
        requestDigest: computeDigest({ operation: replaces === undefined ? 'agent-credential.issue' : 'agent-credential.rotate', actorId: actor.entityId, ...(replaces !== undefined ? { replaces } : {}) }),
        ...(replaces !== undefined ? { replaces } : {}),
      });
    } catch (error) {
      audit(operator, replaces === undefined ? 'agent-credential.issue' : 'agent-credential.rotate', actor.entityId, 'refused');
      mapControlPlaneError(error);
    }
    if (result.principal.actorId !== actor.entityId || result.credential.principalId !== principalId) throw integrityFailed('CONTROL_PLANE_RECORD_MISMATCH');
    const issued = result.outcome === 'issued';
    audit(operator, replaces === undefined ? 'agent-credential.issue' : 'agent-credential.rotate', `${actor.entityId}:${result.credential.credentialId}`, result.outcome);
    return {
      outcome: result.outcome,
      actorId: actor.entityId,
      principalId,
      credential: toAgentCredentialView(result.credential),
      // Revealed once. A replay never re-reveals: the secret was never stored.
      bearerCredential: issued && result.credential.credentialId === credentialId ? formatAgentCredential(credentialId, secret) : null,
      ...(result.replaced !== undefined ? { replaced: toAgentCredentialView(result.replaced) } : {}),
    };
  }

  async function lifecycleEvents(): Promise<readonly ProfileLifecycleEvent[]> {
    if (dependencies.profileLifecycle === undefined || dependencies.controlPlane === undefined) return [];
    try {
      const events = await dependencies.controlPlane.listProfileLifecycleEvents(organizationId);
      if (events.some((event) => event.organizationId !== organizationId)) throw integrityFailed('CONTROL_PLANE_RECORD_MISMATCH');
      return events;
    } catch (error) {
      if (error instanceof EnterpriseHttpError) throw error;
      return mapControlPlaneError(error);
    }
  }

  function profileView(profile: ResolvedGovernanceProfile, events: readonly ProfileLifecycleEvent[]): ProfileVersionView {
    const { definition, reference } = profile;
    const mine = events.filter((event) => event.profileId === reference.id && event.version === reference.version && event.digest === reference.digest);
    const activated = mine.find((event) => event.transition === 'activated');
    const retired = mine.find((event) => event.transition === 'retired');
    const state: ProfileVersionView['state'] = dependencies.profileLifecycle === undefined ? 'active' : retired !== undefined ? 'retired' : activated !== undefined ? 'active' : 'draft';
    return {
      profileId: reference.id,
      version: reference.version,
      digest: reference.digest,
      state,
      actionClass: definition.actionClass,
      resourceClass: definition.resourceClass,
      owner: definition.owner,
      provenance: { authoredBy: definition.provenance.authoredBy, approvedBy: definition.provenance.approvedBy },
      activatedBy: activated?.operatorRef ?? null,
      activatedAt: activated?.occurredAt ?? null,
      retiredBy: retired?.operatorRef ?? null,
      retiredAt: retired?.occurredAt ?? null,
      retirementReason: retired?.reason ?? null,
      definition,
    };
  }

  return Object.freeze({
    async describeOrganization(authorizationHeader: string | undefined, query: OperatorQuery): Promise<OrganizationView> {
      const operator = authenticator.authorize(authorizationHeader, 'organization.read');
      closedQuery(query, []);
      return {
        organization: {
          organizationId,
          trustDomainId: dependencies.trustDomainId ?? null,
          agentCredentials: dependencies.controlPlane !== undefined ? 'enabled' : 'not-composed',
          profileLifecycle: dependencies.profileLifecycle !== undefined ? 'operator-promoted' : 'static',
        },
        operator: { operatorId: operator.operatorId, role: operator.role, credentialClass: operator.credentialClass, permissions: permissionsOf(operator.role) },
      };
    },

    async listAgents(authorizationHeader: string | undefined, query: OperatorQuery) {
      authenticator.authorize(authorizationHeader, 'inventory.read');
      closedQuery(query, []);
      const all = await records();
      const agents: AgentInventoryView[] = [];
      for (const actor of all.filter(isAgent)) agents.push(await agentView(actor, all));
      return { agents };
    },

    async inspectAgent(authorizationHeader: string | undefined, actorId: string, query: OperatorQuery) {
      authenticator.authorize(authorizationHeader, 'inventory.read');
      closedQuery(query, []);
      const actor = await agentRecord(actorId);
      return agentView(actor, await records());
    },

    async issueAgentCredential(authorizationHeader: string | undefined, actorId: string, readBody: OperatorBodyReader) {
      const operator = authenticator.authorize(authorizationHeader, 'agent-credential.manage');
      const { idempotencyKey } = validateCredentialRequest(await readBody());
      return serialized(() => issue(operator, actorId, idempotencyKey, undefined));
    },

    async rotateAgentCredential(authorizationHeader: string | undefined, actorId: string, credentialId: string, readBody: OperatorBodyReader) {
      const operator = authenticator.authorize(authorizationHeader, 'agent-credential.manage');
      if (!isAgentCredentialId(credentialId)) throw EnterpriseHttpErrors.invalidRequest("credentialId must be 'agc-' followed by 32 lowercase hex digits.");
      const { idempotencyKey } = validateCredentialRequest(await readBody());
      return serialized(() => issue(operator, actorId, idempotencyKey, credentialId));
    },

    async revokeAgentCredential(authorizationHeader: string | undefined, actorId: string, credentialId: string, readBody: OperatorBodyReader) {
      const operator = authenticator.authorize(authorizationHeader, 'agent-credential.revoke');
      if (!isAgentCredentialId(credentialId)) throw EnterpriseHttpErrors.invalidRequest("credentialId must be 'agc-' followed by 32 lowercase hex digits.");
      const { reason } = validateReasonRequest(await readBody());
      const cp = controlPlane();
      return serialized(async () => {
        // Revocation of a credential needs no live actor: narrowing is always allowed.
        let principal;
        try {
          principal = await cp.getAgentPrincipalByActor(organizationId, actorId);
        } catch (error) {
          mapControlPlaneError(error);
        }
        if (principal === undefined) throw notFound('No credential with that id is held for this agent.');
        const held = await (async () => {
          try {
            return await cp.listAgentCredentials(organizationId, principal.principalId);
          } catch (error) {
            return mapControlPlaneError(error);
          }
        })();
        if (!held.some((credential) => credential.credentialId === credentialId)) throw notFound('No credential with that id is held for this agent.');
        let result;
        try {
          result = await cp.revokeAgentCredential({ organizationId, credentialId, operatorRef: operator.actorRef, at: now(), reason });
        } catch (error) {
          audit(operator, 'agent-credential.revoke', `${actorId}:${credentialId}`, 'refused');
          mapControlPlaneError(error);
        }
        if (result.credential.status !== 'revoked' || result.credential.credentialId !== credentialId) throw integrityFailed('CONTROL_PLANE_RECORD_MISMATCH');
        audit(operator, 'agent-credential.revoke', `${actorId}:${credentialId}`, result.outcome);
        return { outcome: result.outcome, actorId, credential: toAgentCredentialView(result.credential) };
      });
    },

    async listAuthorityEntities(authorizationHeader: string | undefined, query: OperatorQuery) {
      authenticator.authorize(authorizationHeader, 'inventory.read');
      const { kind, status } = closedQuery(query, ['kind', 'status']);
      if (kind !== undefined && !isKernelAuthorityEntityKind(kind)) throw EnterpriseHttpErrors.invalidRequest('kind is not a Kernel Authority entity kind.');
      if (status !== undefined && status !== 'active' && status !== 'revoked') throw EnterpriseHttpErrors.invalidRequest("status must be 'active' or 'revoked'.");
      const all = await records();
      return {
        entities: all.filter((record) => (kind === undefined || record.entityKind === kind) && (status === undefined || record.status === status)).map(toAdministeredAuthorityEntityView),
      };
    },

    async provisionAuthorityEntity(authorizationHeader: string | undefined, rawKind: string, readBody: OperatorBodyReader) {
      if (!isKernelAuthorityEntityKind(rawKind)) {
        // The kind is checked only after the caller is authenticated as an operator; a 400 must not tell an anonymous caller anything.
        authenticator.authorize(authorizationHeader, 'authority.provision');
        throw EnterpriseHttpErrors.invalidRequest('entityKind is not a provisionable Kernel Authority entity kind.');
      }
      let operator = authenticator.authorize(authorizationHeader, KIND_PERMISSION[rawKind]);
      const { request, idempotencyKey } = validateProvisionRequest(rawKind, await readBody());
      // An organization or system actor is an issuer — organization bootstrap,
      // not routine onboarding — and needs the bootstrap permission too.
      if (request.kind === 'actor' && BOOTSTRAP_ACTOR_TYPES.includes(request.input.type)) operator = authenticator.authorize(authorizationHeader, 'authority.bootstrap');
      const entityId = provisionedEntityId(request);
      const target = `${request.kind}:${entityId}`;
      // P10 shape first, with the Kernel Authority's own validator — the one
      // every append runs — so a malformed constraint is a 400, not a replay failure.
      try {
        validateKernelAuthorityMonetaryConstraints(request.kind, request.input as unknown as Readonly<Record<string, unknown>>, `${request.kind} '${entityId}'`);
      } catch (error) {
        mapKernelAuthorityError(error);
      }
      return serialized(async () => {
        const context = operatorContext(operator);
        const existing = await recordOf(request.kind, entityId);
        // A first write is replayed through the engines before it is appended.
        // A repeat (replay or conflict) is the store's own rule to decide.
        if (existing === null) {
          const world = await records();
          assertReferences(world, request);
          assertParameterAuthority(world, request);
          dryRun(world, request.kind, entityId, request.input as unknown as Readonly<Record<string, unknown>>, operator);
        }
        let result: KernelAuthorityProvisioningResult;
        try {
          result = await provisionThrough(request, context, idempotencyKey);
        } catch (error) {
          audit(operator, `authority-entity.provision`, target, isKernelAuthorityError(error) && error.code === 'KERNEL_AUTHORITY_REFRESH_FAILED' ? 'committed-refresh-failed' : 'refused');
          mapKernelAuthorityError(error);
        }
        if (result.record.organizationId !== organizationId || result.record.entityKind !== request.kind || result.record.entityId !== entityId) throw integrityFailed('KERNEL_AUTHORITY_RECORD_MISMATCH');
        const outcome: 'replayed' | 'provisioned' = result.replayed ? 'replayed' : 'provisioned';
        audit(operator, 'authority-entity.provision', target, outcome);
        return { outcome, entity: toAdministeredAuthorityEntityView(result.record) };
      });
    },

    async listGovernanceProfiles(authorizationHeader: string | undefined, query: OperatorQuery) {
      authenticator.authorize(authorizationHeader, 'inventory.read');
      closedQuery(query, []);
      const events = await lifecycleEvents();
      return {
        lifecycle: dependencies.profileLifecycle !== undefined ? ('operator-promoted' as const) : ('static' as const),
        profiles: governance.profiles.map((profile) => profileView(profile, events)),
      };
    },

    async transitionGovernanceProfile(authorizationHeader: string | undefined, profileId: string, rawVersion: string, transition: 'activate' | 'retire', readBody: OperatorBodyReader) {
      const operator = authenticator.authorize(authorizationHeader, transition === 'activate' ? 'profile.promote' : 'profile.retire');
      const version = profileVersionOf(rawVersion);
      const { digest, reason } = validateProfileTransitionRequest(await readBody());
      const lifecycle = dependencies.profileLifecycle;
      if (lifecycle === undefined || governance.lifecycle !== 'operator-promoted') {
        throw refused('This Host declares its Governance Profiles statically; there is no lifecycle to transition. Configure profileLifecycle: operator-promoted.', 'PROFILE_LIFECYCLE_STATIC');
      }
      const cp = controlPlane();
      // Only catalog content — validated and composed at boot — can be promoted.
      const profile = governance.profiles.find((candidate) => candidate.reference.id === profileId && candidate.reference.version === version);
      if (profile === undefined) throw notFound('No Governance Profile version with that id and version is in this Host’s catalog.');
      if (profile.reference.digest !== digest) {
        throw refused('The digest does not match the catalog content of this profile version; the transition is refused rather than applied to content other than the one reviewed.', 'PROFILE_DIGEST_MISMATCH');
      }
      return serialized(async () => {
        let result;
        try {
          result = await cp.transitionProfile({
            organizationId,
            profileId,
            version,
            digest,
            transition: transition === 'activate' ? 'activated' : 'retired',
            operatorRef: operator.actorRef,
            at: now(),
            ...(reason !== undefined ? { reason } : {}),
          });
        } catch (error) {
          audit(operator, `governance-profile.${transition}`, `${profileId}@${version}`, 'refused');
          mapControlPlaneError(error);
        }
        // The registry's view is reloaded from the durable record, never
        // patched — after every transition call, a replay included, so a
        // retry after a failed refresh refreshes. A failed reload leaves the
        // view failing closed (no version active) and is reported as what it
        // is: the transition is recorded.
        try {
          await lifecycle.reload();
        } catch {
          audit(operator, `governance-profile.${transition}`, `${profileId}@${version}`, 'committed-refresh-failed');
          throw committedRefreshFailed();
        }
        audit(operator, `governance-profile.${transition}`, `${profileId}@${version}`, result.outcome);
        const events = await lifecycleEvents();
        const supersededEvent = result.appended.find((event) => event.transition === 'retired' && event.version !== version);
        const superseded = supersededEvent === undefined ? undefined : governance.profiles.find((candidate) => candidate.reference.id === profileId && candidate.reference.version === supersededEvent.version);
        return { outcome: result.outcome, profile: profileView(profile, events), superseded: superseded === undefined ? null : profileView(superseded, events) };
      });
    },
  });
}
