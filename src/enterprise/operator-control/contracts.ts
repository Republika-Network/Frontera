import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { isSemanticIdentifier, isWellFormedGovernedParameterBound, semanticIdentifierFold, type GovernedParameterBound } from '../../features/governed-parameter-runtime/index.js';
import type { GovernanceProfileDefinition } from '../governance-profile/index.js';
import type {
  KernelAuthorityEntityKind,
  KernelAuthorityMonetaryConstraint,
  KernelAuthorityParameterBound,
  ProvisionActorInput,
  ProvisionAuthorityGrantInput,
  ProvisionCapabilityTokenInput,
  ProvisionDelegationGrantInput,
  ProvisionPassportInput,
  ProvisionRootIssuerInput,
  ProvisionTrustDomainInput,
} from '../kernel-authority/contracts.js';
import type { AgentCredentialRecord } from './control-plane-store.js';
import type { OperatorPermission, OperatorRoleOrLegacy } from './roles.js';

/**
 * CTRL-02 — the operator plane's wire contract.
 *
 * Requests are closed schemas, one per operation and per entity kind. A field
 * this file does not name is refused, not ignored — so `operatorId`, `role`,
 * `permissions`, `organizationId`, `actorRef`, `issuerRef`, `system`,
 * `provisionedBy`, `approvedBy`, `authenticated`, `authorityState`, `digest`
 * (except where it is the content the operator reviewed), `signature`,
 * `privateKey`, `apiKey` and `credentialHash` fail validation before anything
 * is read or written. Who acted, and for which organization, is never read
 * from a request.
 *
 * Each provisioning schema mirrors the existing `Provision*Input` of the
 * Kernel Authority — the same engine vocabulary, no second authority model —
 * and builds that input field by field. There is no schema for a bounded
 * grant: a BoundedGrant is minted only from a committed Kernel decision.
 *
 * Responses are DTOs built field by field: no store row, event digest,
 * credential verifier, secret (beyond the one reveal of a new credential),
 * signature or key material is serialized.
 */

export const OPERATOR_MAX_REASON_LENGTH = 512;
const MAX_TEXT_LENGTH = 256;
const MAX_LIST_LENGTH = 64;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * An entity id provisioned through the operator plane: 1–128 characters from a
 * closed set, starting with a letter or digit. Narrower than what the store
 * accepts, deliberately: an id an operator types is an id an auditor reads.
 */
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROFILE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function isOperatorEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Refuses a body that is not a JSON object or that carries any field outside `allowed`. Unknown fields are named, truncated; values are never echoed. */
function closedBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw EnterpriseHttpErrors.invalidRequest('The request body must be a JSON object.');
  const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest(
      `The request body has unsupported field(s). Accepted: ${allowed.join(', ')}. Operator identity, role and organization are derived from the operator credential, never from the request.`,
      unexpected.slice(0, 8).map((key) => key.slice(0, 64)),
    );
  }
  return raw;
}

function entityId(value: unknown, field: string): string {
  if (!isOperatorEntityId(value)) throw EnterpriseHttpErrors.invalidRequest(`${field} must be 1-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH || value.trim() !== value || CONTROL.test(value)) {
    throw EnterpriseHttpErrors.invalidRequest(`${field} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters, without surrounding whitespace or control characters.`);
  }
  return value;
}

function optional<T>(body: Record<string, unknown>, key: string, read: (value: unknown, field: string) => T): T | undefined {
  return body[key] === undefined ? undefined : read(body[key], key);
}

function textList(value: unknown, field: string, minimum = 1): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_LIST_LENGTH) {
    throw EnterpriseHttpErrors.invalidRequest(`${field} must be an array of ${minimum} to ${MAX_LIST_LENGTH} identifiers.`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const item = text(entry, `${field}[${index}]`);
    if (seen.has(item)) throw EnterpriseHttpErrors.invalidRequest(`${field} names '${item.slice(0, 64)}' twice.`);
    seen.add(item);
  }
  return Object.freeze([...seen]);
}

function oneOf<T extends string>(values: readonly T[]): (value: unknown, field: string) => T {
  return (value, field) => {
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw EnterpriseHttpErrors.invalidRequest(`${field} must be one of: ${values.join(', ')}.`);
    return value as T;
  };
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw EnterpriseHttpErrors.invalidRequest(`${field} must be a boolean.`);
  return value;
}

function depth(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8) throw EnterpriseHttpErrors.invalidRequest(`${field} must be an integer from 0 to 8.`);
  return value;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw EnterpriseHttpErrors.invalidRequest(`${field} must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS[.mmm]Z).`);
  return value;
}

function externalSubject(value: unknown, field: string): { readonly system: string; readonly subjectId: string } {
  // `system` here is the external identity provider's opaque label — client
  // input by contract — never the privileged `system` operator flag.
  const subject = isRecord(value) ? value : undefined;
  if (subject === undefined) throw EnterpriseHttpErrors.invalidRequest(`${field} must be an object { system, subjectId }.`);
  const unexpected = Object.keys(subject).filter((key) => key !== 'system' && key !== 'subjectId');
  if (unexpected.length > 0) throw EnterpriseHttpErrors.invalidRequest(`${field} accepts only system and subjectId.`);
  return Object.freeze({ system: text(subject['system'], `${field}.system`), subjectId: text(subject['subjectId'], `${field}.subjectId`) });
}

/**
 * P10 monetary constraints, copied element by element into fresh plain objects.
 * Their exact grammar (closed keys, canonical decimals, canonical asset ids,
 * windows) is the Kernel Authority's own validator's to judge, and the trusted
 * asset registry's after it — never re-stated here, so the two can never
 * disagree.
 */
function constraints(value: unknown, field: string): readonly KernelAuthorityMonetaryConstraint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw EnterpriseHttpErrors.invalidRequest(`${field} must be an array of 1 to 16 monetary constraints.`);
  return Object.freeze(
    value.map((entry: unknown, index) => {
      if (!isRecord(entry)) throw EnterpriseHttpErrors.invalidRequest(`${field}[${index}] must be an object.`);
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(entry)) {
        if (key === 'window') {
          if (!isRecord(item)) throw EnterpriseHttpErrors.invalidRequest(`${field}[${index}].window must be an object.`);
          copy[key] = Object.freeze({ ...item });
        } else {
          copy[key] = item;
        }
      }
      return Object.freeze(copy) as unknown as KernelAuthorityMonetaryConstraint;
    }),
  );
}

/**
 * CTRL-02 — standing typed-parameter authority: each entry is the canonical
 * CORE-03 bound on a declared dimension, rebuilt field by field into a fresh
 * plain object. Well-formedness is CORE-03's own `isWellFormedGovernedParameterBound`
 * (no coercion: `"3"` is not 3, `-0` and unsafe integers are refused, tokens
 * keep their grammar, `maximum` only over integers). One bound per dimension,
 * regardless of case; returned in canonical (dimension id) order.
 */
function parameterBounds(value: unknown, field: string): readonly KernelAuthorityParameterBound[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw EnterpriseHttpErrors.invalidRequest(`${field} must be an array of 1 to 32 parameter bounds.`);
  const folds = new Set<string>();
  const bounds = value.map((entry: unknown, index): KernelAuthorityParameterBound => {
    const where = `${field}[${index}]`;
    if (!isRecord(entry)) throw EnterpriseHttpErrors.invalidRequest(`${where} must be an object.`);
    const kind = entry['kind'];
    const keys = kind === 'maximum' ? ['dimension', 'kind', 'type', 'limit'] : ['dimension', 'kind', 'type', 'value'];
    const unexpected = Object.keys(entry).filter((key) => !keys.includes(key));
    if (unexpected.length > 0 || keys.some((key) => !Object.prototype.hasOwnProperty.call(entry, key))) {
      throw EnterpriseHttpErrors.invalidRequest(`${where} must carry exactly ${keys.join(', ')}.`);
    }
    const dimension = entry['dimension'];
    if (!isSemanticIdentifier(dimension)) throw EnterpriseHttpErrors.invalidRequest(`${where}.dimension is not a canonical dimension id.`);
    const bound = (kind === 'maximum' ? { kind, type: entry['type'], limit: entry['limit'] } : { kind, type: entry['type'], value: entry['value'] }) as unknown as GovernedParameterBound;
    if (!isWellFormedGovernedParameterBound(bound)) {
      throw EnterpriseHttpErrors.invalidRequest(`${where} is not a well-formed governed parameter bound: exact integer, token or boolean, or maximum integer; safe integers only, no coercion.`);
    }
    const fold = semanticIdentifierFold(dimension);
    if (folds.has(fold)) throw EnterpriseHttpErrors.invalidRequest(`${field} bounds dimension '${dimension}' twice; one bound per dimension.`);
    folds.add(fold);
    return Object.freeze({ dimension, ...bound }) as KernelAuthorityParameterBound;
  });
  return Object.freeze([...bounds].sort((left, right) => (left.dimension < right.dimension ? -1 : left.dimension > right.dimension ? 1 : 0)));
}

export function idempotencyKeyOf(value: unknown, field = 'idempotencyKey'): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw EnterpriseHttpErrors.invalidRequest(`${field} must be 8-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.`);
  return value;
}

export function reasonOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > OPERATOR_MAX_REASON_LENGTH || CONTROL.test(value)) {
    throw EnterpriseHttpErrors.invalidRequest(`reason must be a non-empty string of at most ${OPERATOR_MAX_REASON_LENGTH} characters without control characters.`);
  }
  return value;
}

/** Keeps only the keys whose value is defined, so the payload digest matches the provisioning service's own normalization. */
function defined<T>(input: Readonly<Record<string, unknown>>): T {
  return Object.freeze(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))) as T;
}

// -- provisioning requests --------------------------------------------------------

/** Actor types the operator plane provisions. `external` and `unknown` are recognition outcomes, not provisionable identities. */
export const OPERATOR_ACTOR_TYPES = ['human', 'agent', 'organization', 'system'] as const;
/** Actor types that are organization bootstrap (issuers), not routine onboarding. */
export const BOOTSTRAP_ACTOR_TYPES: readonly string[] = ['organization', 'system'];
const PASSPORT_TYPES = ['human_passport', 'organization_passport', 'agent_passport', 'system_passport'] as const;
const DELEGATE_ACTOR_TYPES = ['human', 'organization', 'agent', 'system'] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'critical', 'prohibited'] as const;

export type OperatorProvisionRequest =
  | { readonly kind: 'actor'; readonly input: ProvisionActorInput }
  | { readonly kind: 'trust-domain'; readonly input: ProvisionTrustDomainInput }
  | { readonly kind: 'root-issuer'; readonly input: ProvisionRootIssuerInput }
  | { readonly kind: 'passport'; readonly input: ProvisionPassportInput }
  | { readonly kind: 'capability-token'; readonly input: ProvisionCapabilityTokenInput }
  | { readonly kind: 'authority-grant'; readonly input: ProvisionAuthorityGrantInput }
  | { readonly kind: 'delegation-grant'; readonly input: ProvisionDelegationGrantInput };

export interface ValidatedProvisionRequest {
  readonly request: OperatorProvisionRequest;
  readonly idempotencyKey?: string;
}

const FIELDS: Readonly<Record<KernelAuthorityEntityKind, readonly string[]>> = {
  actor: ['actorId', 'type', 'displayName', 'issuerId', 'trustDomainId', 'jurisdiction', 'externalSubject'],
  'trust-domain': ['trustDomainId', 'name', 'issuerActorId', 'acceptedIssuerIds', 'acceptedActorTypes', 'jurisdiction', 'policyPackIds'],
  'root-issuer': ['trustDomainId', 'actorId'],
  passport: ['passportId', 'type', 'subjectActorId', 'issuerActorId', 'trustDomainId', 'expiresAt'],
  'capability-token': [
    'capabilityTokenId',
    'subjectActorId',
    'principalActorId',
    'issuerActorId',
    'trustDomainId',
    'capability',
    'actions',
    'resourceScopes',
    'riskLevel',
    'prohibitedActions',
    'delegable',
    'maxDelegationDepth',
    'jurisdiction',
    'expiresAt',
  ],
  'authority-grant': [
    'authorityGrantId',
    'issuerActorId',
    'subjectActorId',
    'trustDomainId',
    'capability',
    'actions',
    'resourceScopes',
    'roleId',
    'canDelegate',
    'allowedDelegateActorTypes',
    'maxDelegationDepth',
    'nonDelegableActions',
    'expiresAt',
    'parentGrantId',
    'constraints',
    'parameterBounds',
  ],
  'delegation-grant': [
    'delegationGrantId',
    'delegatorActorId',
    'delegateActorId',
    'delegateActorType',
    'trustDomainId',
    'sourceAuthorityGrantId',
    'capability',
    'actions',
    'resourceScopes',
    'principalActorId',
    'canRedelegate',
    'nonDelegableActions',
    'expiresAt',
    'constraints',
    'parameterBounds',
  ],
};

/**
 * `POST /api/admin/authority/entities/{kind}` — one closed schema per kind,
 * plus an optional `idempotencyKey`. Builds the Kernel Authority's own
 * provisioning input field by field.
 */
export function validateProvisionRequest(kind: KernelAuthorityEntityKind, raw: unknown): ValidatedProvisionRequest {
  const body = closedBody(raw, [...FIELDS[kind], 'idempotencyKey']);
  const idempotencyKey = optional(body, 'idempotencyKey', idempotencyKeyOf);
  const withKey = (request: OperatorProvisionRequest): ValidatedProvisionRequest => (idempotencyKey !== undefined ? { request, idempotencyKey } : { request });
  switch (kind) {
    case 'actor':
      return withKey({
        kind,
        input: defined<ProvisionActorInput>({
          actorId: entityId(body['actorId'], 'actorId'),
          type: oneOf(OPERATOR_ACTOR_TYPES)(body['type'], 'type'),
          displayName: text(body['displayName'], 'displayName'),
          issuerId: optional(body, 'issuerId', entityId),
          trustDomainId: optional(body, 'trustDomainId', entityId),
          jurisdiction: optional(body, 'jurisdiction', text),
          externalSubject: optional(body, 'externalSubject', externalSubject),
        }),
      });
    case 'trust-domain':
      return withKey({
        kind,
        input: defined<ProvisionTrustDomainInput>({
          trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'),
          name: text(body['name'], 'name'),
          issuerActorId: entityId(body['issuerActorId'], 'issuerActorId'),
          acceptedIssuerIds: textList(body['acceptedIssuerIds'], 'acceptedIssuerIds').map((id, index) => entityId(id, `acceptedIssuerIds[${index}]`)),
          acceptedActorTypes: textList(body['acceptedActorTypes'], 'acceptedActorTypes').map((type, index) => oneOf(OPERATOR_ACTOR_TYPES)(type, `acceptedActorTypes[${index}]`)),
          jurisdiction: optional(body, 'jurisdiction', text),
          policyPackIds: optional(body, 'policyPackIds', (value, field) => textList(value, field)),
        }),
      });
    case 'root-issuer':
      return withKey({ kind, input: defined<ProvisionRootIssuerInput>({ trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'), actorId: entityId(body['actorId'], 'actorId') }) });
    case 'passport':
      return withKey({
        kind,
        input: defined<ProvisionPassportInput>({
          passportId: entityId(body['passportId'], 'passportId'),
          type: oneOf(PASSPORT_TYPES)(body['type'], 'type'),
          subjectActorId: entityId(body['subjectActorId'], 'subjectActorId'),
          issuerActorId: entityId(body['issuerActorId'], 'issuerActorId'),
          trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'),
          expiresAt: optional(body, 'expiresAt', instant),
        }),
      });
    case 'capability-token':
      return withKey({
        kind,
        input: defined<ProvisionCapabilityTokenInput>({
          capabilityTokenId: entityId(body['capabilityTokenId'], 'capabilityTokenId'),
          subjectActorId: entityId(body['subjectActorId'], 'subjectActorId'),
          principalActorId: entityId(body['principalActorId'], 'principalActorId'),
          issuerActorId: entityId(body['issuerActorId'], 'issuerActorId'),
          trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'),
          capability: text(body['capability'], 'capability'),
          actions: textList(body['actions'], 'actions'),
          resourceScopes: textList(body['resourceScopes'], 'resourceScopes'),
          riskLevel: oneOf(RISK_LEVELS)(body['riskLevel'], 'riskLevel'),
          prohibitedActions: optional(body, 'prohibitedActions', (value, field) => textList(value, field)),
          delegable: optional(body, 'delegable', bool),
          maxDelegationDepth: optional(body, 'maxDelegationDepth', depth),
          jurisdiction: optional(body, 'jurisdiction', text),
          expiresAt: optional(body, 'expiresAt', instant),
        }),
      });
    case 'authority-grant':
      return withKey({
        kind,
        input: defined<ProvisionAuthorityGrantInput>({
          authorityGrantId: entityId(body['authorityGrantId'], 'authorityGrantId'),
          issuerActorId: entityId(body['issuerActorId'], 'issuerActorId'),
          subjectActorId: entityId(body['subjectActorId'], 'subjectActorId'),
          trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'),
          capability: text(body['capability'], 'capability'),
          actions: textList(body['actions'], 'actions'),
          resourceScopes: textList(body['resourceScopes'], 'resourceScopes'),
          roleId: optional(body, 'roleId', entityId),
          canDelegate: optional(body, 'canDelegate', bool),
          allowedDelegateActorTypes: optional(body, 'allowedDelegateActorTypes', (value, field) => textList(value, field).map((type, index) => oneOf(DELEGATE_ACTOR_TYPES)(type, `${field}[${index}]`))),
          maxDelegationDepth: optional(body, 'maxDelegationDepth', depth),
          nonDelegableActions: optional(body, 'nonDelegableActions', (value, field) => textList(value, field)),
          expiresAt: optional(body, 'expiresAt', instant),
          parentGrantId: optional(body, 'parentGrantId', entityId),
          constraints: optional(body, 'constraints', constraints),
          parameterBounds: optional(body, 'parameterBounds', parameterBounds),
        }),
      });
    case 'delegation-grant':
      return withKey({
        kind,
        input: defined<ProvisionDelegationGrantInput>({
          delegationGrantId: entityId(body['delegationGrantId'], 'delegationGrantId'),
          delegatorActorId: entityId(body['delegatorActorId'], 'delegatorActorId'),
          delegateActorId: entityId(body['delegateActorId'], 'delegateActorId'),
          delegateActorType: oneOf(DELEGATE_ACTOR_TYPES)(body['delegateActorType'], 'delegateActorType'),
          trustDomainId: entityId(body['trustDomainId'], 'trustDomainId'),
          sourceAuthorityGrantId: entityId(body['sourceAuthorityGrantId'], 'sourceAuthorityGrantId'),
          capability: text(body['capability'], 'capability'),
          actions: textList(body['actions'], 'actions'),
          resourceScopes: textList(body['resourceScopes'], 'resourceScopes'),
          principalActorId: optional(body, 'principalActorId', entityId),
          canRedelegate: optional(body, 'canRedelegate', bool),
          nonDelegableActions: optional(body, 'nonDelegableActions', (value, field) => textList(value, field)),
          expiresAt: optional(body, 'expiresAt', instant),
          constraints: optional(body, 'constraints', constraints),
          parameterBounds: optional(body, 'parameterBounds', parameterBounds),
        }),
      });
  }
}

/** The entity id a provisioning request writes. A root issuer is keyed by its domain and actor, as the provisioning service keys it. */
export function provisionedEntityId(request: OperatorProvisionRequest): string {
  switch (request.kind) {
    case 'actor':
      return request.input.actorId;
    case 'trust-domain':
      return request.input.trustDomainId;
    case 'root-issuer':
      return `${request.input.trustDomainId}::${request.input.actorId}`;
    case 'passport':
      return request.input.passportId;
    case 'capability-token':
      return request.input.capabilityTokenId;
    case 'authority-grant':
      return request.input.authorityGrantId;
    case 'delegation-grant':
      return request.input.delegationGrantId;
  }
}

// -- credential and profile requests ---------------------------------------------

/** `POST /api/admin/agents/{actorId}/credentials` and `.../{credentialId}/rotate`: `{ idempotencyKey }`. */
export function validateCredentialRequest(raw: unknown): { readonly idempotencyKey: string } {
  const body = closedBody(raw, ['idempotencyKey']);
  return { idempotencyKey: idempotencyKeyOf(body['idempotencyKey']) };
}

/** `POST .../revoke`: `{ reason }`. */
export function validateReasonRequest(raw: unknown): { readonly reason: string } {
  const body = closedBody(raw, ['reason']);
  return { reason: reasonOf(body['reason']) };
}

/**
 * `POST /api/admin/governance-profiles/{profileId}/versions/{version}/{activate|retire}`:
 * `{ digest, reason? }`. `digest` is the content the operator reviewed — a
 * compare-and-set: a transition of any other content is refused. It is never
 * provenance: who acted is the authenticated operator.
 */
export function validateProfileTransitionRequest(raw: unknown): { readonly digest: string; readonly reason?: string } {
  const body = closedBody(raw, ['digest', 'reason']);
  if (typeof body['digest'] !== 'string' || !PROFILE_DIGEST.test(body['digest'])) throw EnterpriseHttpErrors.invalidRequest("digest must be the content digest ('sha256:' and 64 hex digits) of the profile version being transitioned.");
  const reason = body['reason'] === undefined ? undefined : reasonOf(body['reason']);
  return reason !== undefined ? { digest: body['digest'], reason } : { digest: body['digest'] };
}

export function profileVersionOf(raw: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw EnterpriseHttpErrors.invalidRequest('version must be a positive integer.');
  return Number(raw);
}

/** Query parameters a list route accepts; any other key is refused — an organization cannot be named in a query. */
export function closedQuery(query: Readonly<Record<string, string>>, allowed: readonly string[]): Readonly<Record<string, string>> {
  const unexpected = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest(`Unsupported query parameter(s). Accepted: ${allowed.length > 0 ? allowed.join(', ') : 'none'}.`, unexpected.slice(0, 8).map((key) => key.slice(0, 64)));
  }
  return query;
}

// -- responses ---------------------------------------------------------------------

export interface OperatorIdentityView {
  readonly operatorId: string;
  readonly role: OperatorRoleOrLegacy;
  readonly credentialClass: 'operator' | 'legacy-administrator';
  readonly permissions: readonly OperatorPermission[];
}

export interface OrganizationView {
  readonly organization: {
    readonly organizationId: string;
    /** The trust domain governed actions are decided in, when governed actions are composed. */
    readonly trustDomainId: string | null;
    readonly agentCredentials: 'enabled' | 'not-composed';
    readonly profileLifecycle: 'operator-promoted' | 'static';
  };
  readonly operator: OperatorIdentityView;
}

/** One credential's metadata. There is no secret and no verifier on this type. */
export interface AgentCredentialView {
  readonly credentialId: string;
  readonly status: AgentCredentialRecord['status'];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly replacesCredentialId: string | null;
}

export function toAgentCredentialView(record: AgentCredentialRecord): AgentCredentialView {
  return {
    credentialId: record.credentialId,
    status: record.status,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    revokedBy: record.revokedBy ?? null,
    revokedAt: record.revokedAt ?? null,
    revocationReason: record.revocationReason ?? null,
    replacesCredentialId: record.replacesCredentialId ?? null,
  };
}

export interface AuthorityReferenceView {
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly status: 'active' | 'revoked';
}

/**
 * One agent as the inventory shows it. `status`, the authority references and
 * their statuses come from the Kernel Authority — the only authority source;
 * the credentials come from the control-plane store and say only who may
 * authenticate as this agent. `onboarding` restates those facts, it decides
 * nothing.
 */
export interface AgentInventoryView {
  readonly actorId: string;
  readonly displayName: string;
  readonly status: 'active' | 'revoked';
  readonly externalSubject: { readonly system: string; readonly subjectId: string } | null;
  readonly trustDomainId: string | null;
  readonly provisionedBy: string;
  readonly provisionedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly principalId: string | null;
  readonly credentials: readonly AgentCredentialView[];
  readonly authority: {
    readonly passports: readonly AuthorityReferenceView[];
    readonly capabilityTokens: readonly AuthorityReferenceView[];
    readonly authorityGrants: readonly AuthorityReferenceView[];
    readonly delegationGrants: readonly AuthorityReferenceView[];
  };
  readonly onboarding: {
    readonly actor: 'active' | 'revoked';
    readonly credential: 'active' | 'none';
    readonly standingAuthority: 'assigned' | 'none';
  };
}

export interface AgentCredentialIssueResponse {
  readonly outcome: 'issued' | 'replayed';
  readonly actorId: string;
  readonly principalId: string;
  readonly credential: AgentCredentialView;
  /**
   * The bearer credential, revealed exactly once — in the response that
   * created it. `null` on an idempotent replay: the secret was never stored,
   * so a lost one is replaced by rotation, never re-read.
   */
  readonly bearerCredential: string | null;
  /** Rotation: the credential this one replaced, now revoked. */
  readonly replaced?: AgentCredentialView;
}

export interface ProfileVersionView {
  readonly profileId: string;
  readonly version: number;
  readonly digest: string;
  readonly state: 'draft' | 'active' | 'retired';
  readonly actionClass: string;
  readonly resourceClass: string;
  readonly owner: string;
  /** The catalog content's own authorship claim (trusted configuration, digested). Not the promotion record: that is `activatedBy`. */
  readonly provenance: { readonly authoredBy: string; readonly approvedBy: string };
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly retiredBy: string | null;
  readonly retiredAt: string | null;
  readonly retirementReason: string | null;
  readonly definition: GovernanceProfileDefinition;
}

// -- CTRL-03: decision activity and evidence reads ----------------------------------

/**
 * The Kernel's decision vocabulary, restated (`KernelDecisionStatus`). A filter
 * value outside it is refused, never matched loosely.
 */
export const DECISION_ACTIVITY_STATUSES = ['allowed', 'denied', 'approval_required', 'indeterminate'] as const;
export const DECISION_ACTIVITY_MAX_LIMIT = 100;
const DECISION_ACTIVITY_DEFAULT_LIMIT = 25;
const CURSOR = /^[A-Za-z0-9._:=-]{1,512}$/;

export interface DecisionActivityQuery {
  readonly actorId?: string;
  readonly decisionId?: string;
  readonly requestId?: string;
  readonly status?: (typeof DECISION_ACTIVITY_STATUSES)[number];
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * `GET /api/admin/activity/decisions?actorId=&decisionId=&requestId=&status=&limit=&cursor=` — closed:
 * any other key (an organization above all) is refused. Values are checked
 * here so a malformed one is a 400 before the store is asked anything.
 */
export function validateDecisionActivityQuery(query: Readonly<Record<string, string>>): DecisionActivityQuery {
  const { actorId, status, limit, cursor, decisionId, requestId } = closedQuery(query, ['actorId', 'status', 'limit', 'cursor', 'decisionId', 'requestId']);
  if (actorId !== undefined && !isOperatorEntityId(actorId)) throw EnterpriseHttpErrors.invalidRequest('actorId must be 1-128 letters, digits, \'.\', \'_\', \':\' or \'-\', starting with a letter or digit.');
  for (const [field, value] of [['decisionId', decisionId], ['requestId', requestId]] as const) {
    if (value !== undefined && (value.length === 0 || value.length > MAX_TEXT_LENGTH || value.trim() !== value || CONTROL.test(value))) {
      throw EnterpriseHttpErrors.invalidRequest(`${field} must be a non-empty identifier of at most ${MAX_TEXT_LENGTH} characters.`);
    }
  }
  if (status !== undefined && !(DECISION_ACTIVITY_STATUSES as readonly string[]).includes(status)) throw EnterpriseHttpErrors.invalidRequest(`status must be one of: ${DECISION_ACTIVITY_STATUSES.join(', ')}.`);
  let pageSize = DECISION_ACTIVITY_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > DECISION_ACTIVITY_MAX_LIMIT) throw EnterpriseHttpErrors.invalidRequest(`limit must be an integer from 1 to ${DECISION_ACTIVITY_MAX_LIMIT}.`);
    pageSize = Number(limit);
  }
  if (cursor !== undefined && !CURSOR.test(cursor)) throw EnterpriseHttpErrors.invalidRequest('cursor must be the opaque value a previous page returned.');
  return {
    limit: pageSize,
    ...(actorId !== undefined ? { actorId } : {}),
    ...(decisionId !== undefined ? { decisionId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(status !== undefined ? { status: status as DecisionActivityQuery['status'] & string } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/**
 * One committed Kernel decision as the Governance Store recorded it — a
 * summary, restated field by field. `status` is the **Kernel decision**, not
 * what happened afterwards: whether a bounded grant was issued and whether an
 * execution was attempted are recorded as references on the decision record
 * (`DecisionEvidenceView`), and a request withheld after an `allowed`
 * decision (for example by standing parameter authority) records no grant.
 */
export interface DecisionActivityView {
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

export interface DecisionActivityPage {
  /** Newest committed first (the store's chain order). */
  readonly decisions: readonly DecisionActivityView[];
  /** Opaque; absent on the last page. */
  readonly nextCursor: string | null;
  /** What this list is — and is not. Stated by the server so no client can overstate it. */
  readonly coverage: 'governance-store-decisions';
}

/** One reference row on a decision record: a grant (authorization artifact), an execution attempt, an outcome, a resolution, … — exactly as recorded. */
export interface DecisionReferenceView {
  readonly referenceId: string;
  readonly referenceType: string;
  readonly externalId: string;
  readonly externalVersion: string | null;
  readonly digest: string | null;
  readonly createdAt: string;
  /** Position in the decision's protected reference chain; `null` on a legacy-unprotected row. */
  readonly sequence: number | null;
}

/**
 * `GET /api/admin/evidence/decisions/{evaluationId}` — one decision record and
 * the Governance Store's own deterministic verification of it. The record and
 * the verification are two reads; `verification.verifiedAt` says when the
 * second ran. Integrity is digest-based (unkeyed SHA-256): it detects
 * modification, it is not a signature (ASSURE-02).
 */
export interface DecisionEvidenceView {
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
  readonly integrity: {
    readonly algorithm: string;
    readonly chainPosition: number;
    readonly aggregateDigest: string;
    readonly previousAggregateDigest: string | null;
  };
  readonly references: readonly DecisionReferenceView[];
  readonly verification: {
    readonly valid: boolean;
    readonly verifiedAt: string;
    readonly checks: Readonly<Record<string, boolean>>;
    readonly failures: readonly { readonly check: string; readonly message: string }[];
    readonly referenceIntegrity: { readonly legacyUnprotected: number; readonly protectedValid: number; readonly protectedCorrupted: number; readonly protectedUnsupportedVersion: number };
  };
  readonly coverage: 'governance-store-decision-record';
}
