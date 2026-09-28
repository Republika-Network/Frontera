import type { BoundedGrant, GrantBound, GrantBoundKey, GrantExerciseAssessment, GrantParameterBound, GrantRevocation, GrantRevocationReason } from '../../features/grant-runtime/index.js';
import { GRANT_BOUND_KEYS, GRANT_REVOCATION_REASONS, isGrantRevocationReason } from '../../features/grant-runtime/index.js';
import { EMERGENCY_CONTROL_SCOPES, type EmergencyControlScope, type EmergencyControlScopeMatch } from '../../features/emergency-control-runtime/index.js';
import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { KERNEL_AUTHORITY_ENTITY_KINDS, type KernelAuthorityEntityKind, type KernelAuthorityRecord } from '../kernel-authority/contracts.js';

/**
 * CTRL-01 — the wire contract of the authority administration API.
 *
 * Two halves, both closed:
 *
 * - **Requests.** Every body is a closed schema. A field this file does not
 *   name is refused, not ignored, so `admin`, `role`, `operator`, `issuerRef`,
 *   `actor`, `organizationId` and every other attempt to state trusted context
 *   in the body fails validation before anything is read or written. The only
 *   client-controlled inputs are the target (in the path) and the reason or
 *   control scope (in the body). Who performed the operation, and for which
 *   organization, is never read from a request.
 * - **Responses.** Explicit DTOs built field by field from domain objects. No
 *   store row, digest, signature, key id or internal class is serialized.
 */

/** Administration request bodies are small. A body over this is refused before it is parsed. */
export const ADMIN_MAX_BODY_BYTES = 16 * 1024;
export const ADMIN_MAX_REASON_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** The canonical bounded-grant identity (`boundedGrantId`): `aoc.grant:` and 32 lowercase hex digits. Nothing else names a grant. */
const GRANT_ID = /^aoc\.grant:[0-9a-f]{32}$/;

export function isCanonicalGrantId(value: string): boolean {
  return GRANT_ID.test(value);
}

/** A Kernel Authority entity id: non-empty, bounded, no surrounding whitespace, no control characters. */
export function isCanonicalEntityId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && value === value.trim() && !CONTROL.test(value);
}

export function isKernelAuthorityEntityKind(value: string): value is KernelAuthorityEntityKind {
  return (KERNEL_AUTHORITY_ENTITY_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses a body that is not a JSON object or that carries any field outside `allowed`. Unknown fields are named, truncated; values are never echoed. */
function closedBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw EnterpriseHttpErrors.invalidRequest('The request body must be a JSON object.');
  const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest(
      `The request body has unsupported field(s). Accepted: ${allowed.join(', ')}. Operator identity and organization are derived from the administrator credential, never from the request.`,
      unexpected.slice(0, 8).map((key) => key.slice(0, 64)),
    );
  }
  return raw;
}

function reasonText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > ADMIN_MAX_REASON_LENGTH || CONTROL.test(value)) {
    throw EnterpriseHttpErrors.invalidRequest(`reason must be a non-empty string of at most ${ADMIN_MAX_REASON_LENGTH} characters without control characters.`);
  }
  return value;
}

// -- requests -------------------------------------------------------------------

export interface GrantRevocationRequest {
  readonly reason: GrantRevocationReason;
}

/** `POST /api/admin/authority/grants/{grantId}/revoke`: `{ reason }`, from the closed revocation vocabulary. */
export function validateGrantRevocationRequest(raw: unknown): GrantRevocationRequest {
  const body = closedBody(raw, ['reason']);
  if (typeof body.reason !== 'string' || !isGrantRevocationReason(body.reason)) {
    throw EnterpriseHttpErrors.invalidRequest(`reason must be one of: ${GRANT_REVOCATION_REASONS.join(', ')}.`);
  }
  return { reason: body.reason };
}

export interface AuthorityEntityRevocationRequest {
  readonly reason: string;
}

/** `POST /api/admin/authority/entities/{kind}/{id}/revoke`: `{ reason }`, free text, bounded. */
export function validateAuthorityEntityRevocationRequest(raw: unknown): AuthorityEntityRevocationRequest {
  const body = closedBody(raw, ['reason']);
  return { reason: reasonText(body.reason) };
}

export interface EmergencyControlTarget {
  readonly scope: EmergencyControlScope;
  readonly value?: string;
}

/**
 * Scopes an operator may set over HTTP: every scope of the existing model
 * except `workflow`, which no governed-action path can match today (no trusted
 * workflow identity exists), so a workflow stop would stop nothing while
 * reading as a stop.
 */
export const ADMIN_EMERGENCY_CONTROL_SCOPES: readonly EmergencyControlScope[] = EMERGENCY_CONTROL_SCOPES.filter((scope) => scope !== 'workflow');

/** `POST /api/admin/emergency-controls/{activate|release}`: `{ scope, value? }`. `value` is required for every scope but `global`, and forbidden for it. */
export function validateEmergencyControlTarget(raw: unknown): EmergencyControlTarget {
  const body = closedBody(raw, ['scope', 'value']);
  const scope = body.scope;
  if (typeof scope !== 'string' || !(ADMIN_EMERGENCY_CONTROL_SCOPES as readonly string[]).includes(scope)) {
    throw EnterpriseHttpErrors.invalidRequest(`scope must be one of: ${ADMIN_EMERGENCY_CONTROL_SCOPES.join(', ')}.`);
  }
  if (scope === 'global') {
    if (body.value !== undefined) throw EnterpriseHttpErrors.invalidRequest("A 'global' control takes no value.");
    return { scope };
  }
  if (typeof body.value !== 'string' || !isCanonicalEntityId(body.value)) {
    throw EnterpriseHttpErrors.invalidRequest(`A '${scope}' control requires a value: a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
  return { scope: scope as EmergencyControlScope, value: body.value };
}

// -- responses ------------------------------------------------------------------

export type AdministeredGrantBound =
  | { readonly kind: 'identity'; readonly value: string }
  | { readonly kind: 'set'; readonly values: readonly string[] }
  | { readonly kind: 'ceiling'; readonly limit: string; readonly unit: string }
  | { readonly kind: 'window'; readonly notAfter: string };

/** CORE-03 — one typed parameter bound, as an operator sees it: the declared dimension, its type, and the exact value or inclusive maximum. */
export type AdministeredParameterBound =
  | { readonly dimension: string; readonly kind: 'exact'; readonly type: 'integer' | 'token' | 'boolean'; readonly value: number | string | boolean }
  | { readonly dimension: string; readonly kind: 'maximum'; readonly type: 'integer'; readonly limit: number };

/**
 * Every bound a grant carries: one entry per stated axis (including the
 * CORE-03 `governanceProfile` identity), and the typed `parameters` list when
 * the grant bounds any. Derived from the grant runtime's own key list, so an
 * axis the runtime enforces can never be missing from what an operator sees.
 */
export type AdministeredGrantBounds = Readonly<Partial<Record<GrantBoundKey, AdministeredGrantBound>>> & { readonly parameters?: readonly AdministeredParameterBound[] };

export interface AdministeredGrantRevocation {
  readonly revokedAt: string;
  readonly reason: GrantRevocationReason;
  /** The operator or system the signed revocation records. */
  readonly revokedBy: string;
}

/** One bounded grant, as an operator sees it. */
export interface AdministeredGrantView {
  readonly grantId: string;
  /** The Frontera actor that may exercise it. */
  readonly subject: string;
  /** What it was derived from: the committed governance request and decision, and the act they covered. */
  readonly provenance: { readonly requestId: string; readonly decisionId: string; readonly action: string; readonly resourceScope: string };
  readonly bounds: AdministeredGrantBounds;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /**
   * The grant-runtime's own exercise assessment (`assessGrantExercise`) at
   * `assessedAt`, restated: `exercisable`, or `unusable` with its reason codes
   * (`GRANT_REVOKED`, `GRANT_EXPIRED`). The HTTP layer computes no status.
   */
  readonly status: { readonly eligibility: GrantExerciseAssessment['eligibility']; readonly reasonCodes: readonly string[]; readonly assessedAt: string };
  readonly revocation: AdministeredGrantRevocation | null;
}

function toBound(bound: GrantBound): AdministeredGrantBound {
  switch (bound.kind) {
    case 'identity':
      return { kind: 'identity', value: bound.value };
    case 'set':
      return { kind: 'set', values: [...bound.values] };
    case 'ceiling':
      return { kind: 'ceiling', limit: bound.limit, unit: bound.unit };
    case 'window':
      return { kind: 'window', notAfter: bound.notAfter };
  }
}

function toParameterBound(bound: GrantParameterBound): AdministeredParameterBound {
  return bound.kind === 'maximum'
    ? { dimension: bound.dimension, kind: 'maximum', type: 'integer', limit: bound.limit }
    : { dimension: bound.dimension, kind: 'exact', type: bound.type, value: bound.value };
}

export function toAdministeredGrantRevocation(revocation: GrantRevocation): AdministeredGrantRevocation {
  return { revokedAt: revocation.revokedAt, reason: revocation.reason, revokedBy: revocation.issuerRef };
}

export function toAdministeredGrantView(grant: BoundedGrant, revocation: GrantRevocation | undefined, assessment: GrantExerciseAssessment, assessedAt: string): AdministeredGrantView {
  const bounds: Partial<Record<GrantBoundKey, AdministeredGrantBound>> & { parameters?: readonly AdministeredParameterBound[] } = {};
  for (const key of GRANT_BOUND_KEYS) {
    const bound = grant.scope[key];
    if (bound !== undefined) bounds[key] = toBound(bound);
  }
  if (grant.scope.parameters !== undefined) bounds.parameters = grant.scope.parameters.map(toParameterBound);
  return {
    grantId: grant.id,
    subject: grant.subject,
    provenance: {
      requestId: grant.correlation.requestId,
      decisionId: grant.correlation.decisionId,
      action: grant.correlation.action,
      resourceScope: grant.correlation.resourceScope,
    },
    bounds,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    status: { eligibility: assessment.eligibility, reasonCodes: [...assessment.reasonCodes], assessedAt },
    revocation: revocation === undefined ? null : toAdministeredGrantRevocation(revocation),
  };
}

/**
 * Which bounded grant one governed-action execution ran under. The route an
 * operator uses to go from a governed-action response (which carries
 * `executionId` and `requestId`, never a grant) to the grant to inspect or
 * revoke. From the verified execution outcome record; nothing is derived here.
 */
export interface AdministeredExecutionGrantView {
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly grantId: string;
  readonly action: string;
  readonly preparedAt: string;
}

export type AdministrativeRevocationOutcome = 'revoked' | 'already-revoked';

export interface GrantRevocationResponse {
  readonly outcome: AdministrativeRevocationOutcome;
  readonly grantId: string;
  /** The revocation the store holds — on a repeat, the first one, unchanged. */
  readonly revocation: AdministeredGrantRevocation;
}

/** One Kernel Authority entity, as an operator sees it. `terms` are the provisioned authority terms (actions, resource scopes, constraints, parties); they carry no secret by construction of the provisioning contracts. */
export interface AdministeredAuthorityEntityView {
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly organizationId: string;
  readonly trustDomainId: string | null;
  readonly status: KernelAuthorityRecord['status'];
  readonly terms: Readonly<Record<string, unknown>>;
  readonly provisionedBy: string;
  readonly provisionedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  /** How many events the entity's audit chain holds. */
  readonly sequence: number;
}

export function toAdministeredAuthorityEntityView(record: KernelAuthorityRecord): AdministeredAuthorityEntityView {
  return {
    entityKind: record.entityKind,
    entityId: record.entityId,
    organizationId: record.organizationId,
    trustDomainId: record.trustDomainId ?? null,
    status: record.status,
    terms: record.payload,
    provisionedBy: record.provisionedBy,
    provisionedAt: record.provisionedAt,
    revokedBy: record.revokedBy ?? null,
    revokedAt: record.revokedAt ?? null,
    revocationReason: record.revocationReason ?? null,
    sequence: record.latestSequence,
  };
}

export interface AuthorityEntityRevocationResponse {
  readonly outcome: AdministrativeRevocationOutcome;
  readonly entity: AdministeredAuthorityEntityView;
}

export interface EmergencyControlsView {
  /** Every control currently active, in the store's order. Diagnostics: who declared each is in the store's own history, not here. */
  readonly active: readonly EmergencyControlTarget[];
}

export interface EmergencyControlTransitionResponse extends EmergencyControlsView {
  readonly outcome: 'activated' | 'released';
  readonly control: EmergencyControlTarget;
}

export function toEmergencyControlTargets(matches: readonly EmergencyControlScopeMatch[]): readonly EmergencyControlTarget[] {
  return matches.map((match) => (match.value === undefined ? { scope: match.scope } : { scope: match.scope, value: match.value }));
}
