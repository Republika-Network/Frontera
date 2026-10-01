import { createHash } from 'node:crypto';

import {
  governedParameterBoundAdmits,
  isSemanticIdentifier,
  isWellFormedGovernedParameterBound,
  serializeGovernedParameterBound,
  type GovernedParameter,
  type GovernedParameterBound,
} from '../../features/governed-parameter-runtime/index.js';

/**
 * CTRL-02 — standing authority over typed governed parameters.
 *
 * The parameter counterpart of P10's monetary authority, built the same way:
 *
 * ```
 * Kernel Authority record parameterBounds          durable, operator-provisioned
 *   -> the decision's own Authority Graph lineage  (proof-matched at issuance)
 *   -> every bound on every hop applies            narrowest wins; nothing upstream is skipped
 *   -> issuance: the request must be inside all    else no grant (withheld, authority-binding)
 *   -> grant provenance commits to the lineage     exercise re-resolves it; any change → unverifiable
 * ```
 *
 * One parameter model: a bound is the canonical CORE-03 `GovernedParameterBound`
 * on a declared dimension, a requested value is the canonical
 * `GovernedParameter`, and containment is `governedParameterBoundAdmits` —
 * exact equality for `exact`, `value <= limit` for `maximum`, no coercion.
 *
 * The relationship a granted action stands in:
 *
 * ```
 * standing authority bound  ⊇  permitted request value  =  decision / signed BoundedGrant scope.parameters  ⊇  exercise value
 * ```
 *
 * The signed grant may be narrower than the standing authority; it is never
 * wider, because no grant is issued for a request outside it.
 */

export const PARAMETER_AUTHORITY_REASON_CODES = {
  /** No trusted resolver, no lineage for this decision, a lineage that no longer matches its proof, or a resolver that threw — while parameter authority is in force. Unknown authority is never unlimited authority. */
  PARAMETER_AUTHORITY_UNRESOLVED: 'PARAMETER_AUTHORITY_UNRESOLVED',
  /** A hop of the lineage is revoked, suspended or expired. */
  PARAMETER_AUTHORITY_INACTIVE: 'PARAMETER_AUTHORITY_INACTIVE',
  /** A parameter bound on the lineage is malformed. */
  PARAMETER_AUTHORITY_MALFORMED: 'PARAMETER_AUTHORITY_MALFORMED',
  /** The lineage bounds a dimension the request does not state: an unstated value is not a value inside the bound. */
  PARAMETER_AUTHORITY_VALUE_REQUIRED: 'PARAMETER_AUTHORITY_VALUE_REQUIRED',
  /** A requested value is outside a standing bound (above a maximum, other than an exact value, or of another type). No grant is issued. */
  PARAMETER_AUTHORITY_EXCEEDED: 'PARAMETER_AUTHORITY_EXCEEDED',
} as const;

export type ParameterAuthorityReasonCode = (typeof PARAMETER_AUTHORITY_REASON_CODES)[keyof typeof PARAMETER_AUTHORITY_REASON_CODES];

export const PARAMETER_AUTHORITY_REASON_CODE_VALUES: readonly ParameterAuthorityReasonCode[] = Object.values(PARAMETER_AUTHORITY_REASON_CODES);

/** One standing bound, attributed to the lineage hop that states it. */
export interface ParameterAuthorityBound {
  /** `authority-grant:<id>` or `delegation-grant:<id>`. */
  readonly ref: string;
  readonly dimension: string;
  readonly bound: GovernedParameterBound;
}

/** The parameter authority behind one action: the lineage and every bound on it. */
export interface ParameterAuthority {
  readonly organizationId: string;
  readonly trustDomainId: string;
  readonly subject: string;
  /** The lineage, delegations first then grants, in chain order. Order is identity. */
  readonly lineage: readonly string[];
  /** Every bound on every hop, in `(dimension, ref)` order. Never empty: a lineage with none is `unbounded`. */
  readonly bounds: readonly ParameterAuthorityBound[];
}

export type ParameterAuthorityResolution =
  /** The lineage states no parameter bound: the record's other scope is the whole authority (the historical meaning). */
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'bounded'; readonly authority: ParameterAuthority }
  | { readonly kind: 'unresolved'; readonly reasonCode: ParameterAuthorityReasonCode };

export interface ParameterAuthorityQuery {
  readonly phase: 'issuance' | 'exercise';
  readonly subject: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly organizationId?: string;
  readonly at: string;
  /** Issuance only: the Authority Graph decision the recognition layer reported, whose proof the lineage must match. */
  readonly authorityDecisionId?: string;
}

/** Trusted and synchronous: read inside composition from the hydrated authority world. Never a host option. */
export type ParameterAuthorityResolver = (query: ParameterAuthorityQuery) => ParameterAuthorityResolution;

const UNRESOLVED: ParameterAuthorityResolution = Object.freeze({ kind: 'unresolved', reasonCode: PARAMETER_AUTHORITY_REASON_CODES.PARAMETER_AUTHORITY_UNRESOLVED });

function snapshot(raw: unknown, query: ParameterAuthorityQuery): ParameterAuthorityResolution {
  if (raw === null || typeof raw !== 'object' || raw instanceof Promise) return UNRESOLVED;
  const resolution = raw as ParameterAuthorityResolution;
  if (resolution.kind === 'unbounded') return Object.freeze({ kind: 'unbounded' });
  if (resolution.kind === 'unresolved') {
    return (PARAMETER_AUTHORITY_REASON_CODE_VALUES as readonly string[]).includes(resolution.reasonCode) ? Object.freeze({ kind: 'unresolved', reasonCode: resolution.reasonCode }) : UNRESOLVED;
  }
  if (resolution.kind !== 'bounded') return UNRESOLVED;
  const authority = resolution.authority;
  if (authority === null || typeof authority !== 'object' || authority.subject !== query.subject) return UNRESOLVED;
  if (!Array.isArray(authority.lineage) || authority.lineage.length === 0 || !authority.lineage.every((step) => typeof step === 'string')) return UNRESOLVED;
  if (!Array.isArray(authority.bounds) || authority.bounds.length === 0) return UNRESOLVED;
  const bounds: ParameterAuthorityBound[] = [];
  for (const entry of authority.bounds as readonly ParameterAuthorityBound[]) {
    if (entry === null || typeof entry !== 'object' || typeof entry.ref !== 'string' || !authority.lineage.includes(entry.ref) || !isSemanticIdentifier(entry.dimension)) return UNRESOLVED;
    if (!isWellFormedGovernedParameterBound(entry.bound)) return { kind: 'unresolved', reasonCode: PARAMETER_AUTHORITY_REASON_CODES.PARAMETER_AUTHORITY_MALFORMED };
    bounds.push(Object.freeze({ ref: entry.ref, dimension: entry.dimension, bound: Object.freeze({ ...entry.bound }) }));
  }
  bounds.sort((left, right) => (left.dimension < right.dimension ? -1 : left.dimension > right.dimension ? 1 : left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  return Object.freeze({
    kind: 'bounded',
    authority: Object.freeze({
      organizationId: authority.organizationId,
      trustDomainId: authority.trustDomainId,
      subject: authority.subject,
      lineage: Object.freeze([...authority.lineage]),
      bounds: Object.freeze(bounds),
    }),
  });
}

/** Asks the trusted resolver and believes nothing it cannot validate. A throw, a promise or a malformed answer is unresolved. Absent resolver: `unbounded` only when the caller has proven none is needed — so the caller decides; here it is unresolved. */
export function resolveParameterAuthority(resolver: ParameterAuthorityResolver | undefined, query: ParameterAuthorityQuery): ParameterAuthorityResolution {
  if (resolver === undefined) return UNRESOLVED;
  try {
    return snapshot(resolver(Object.freeze({ ...query })), query);
  } catch {
    return UNRESOLVED;
  }
}

/**
 * Whether the requested parameters are inside every standing bound: each
 * bounded dimension must be stated, and its value admitted by each bound on it
 * (`governedParameterBoundAdmits`). `undefined` when contained, else the reason.
 */
export function parameterAuthorityViolation(authority: ParameterAuthority, parameters: readonly GovernedParameter[] | undefined): ParameterAuthorityReasonCode | undefined {
  for (const entry of authority.bounds) {
    const stated = (parameters ?? []).filter((parameter) => parameter.dimension === entry.dimension);
    if (stated.length === 0) return PARAMETER_AUTHORITY_REASON_CODES.PARAMETER_AUTHORITY_VALUE_REQUIRED;
    // A duplicated dimension never reaches here (refused at the envelope); if one did, every copy must be inside.
    for (const parameter of stated) {
      if (!governedParameterBoundAdmits(entry.bound, parameter)) return PARAMETER_AUTHORITY_REASON_CODES.PARAMETER_AUTHORITY_EXCEEDED;
    }
  }
  return undefined;
}

export const PARAMETER_AUTHORITY_FORMAT = 'frontera.parameter-authority.v1';

/** Canonical bytes: fixed key order, lineage in chain order, bounds in `(dimension, ref)` order, each bound in CORE-03's canonical serialization. */
export function serializeParameterAuthority(authority: ParameterAuthority): string {
  const bounds = authority.bounds.map((entry) => `{"bound":${serializeGovernedParameterBound(entry.bound)},"dimension":${JSON.stringify(entry.dimension)},"ref":${JSON.stringify(entry.ref)}}`).join(',');
  return `{"bounds":[${bounds}],"format":${JSON.stringify(PARAMETER_AUTHORITY_FORMAT)},"lineage":[${authority.lineage.map((step) => JSON.stringify(step)).join(',')}],"organizationId":${JSON.stringify(authority.organizationId)},"subject":${JSON.stringify(authority.subject)},"trustDomainId":${JSON.stringify(authority.trustDomainId)}}`;
}

export function parameterAuthorityDigest(authority: ParameterAuthority): string {
  return `sha256:${createHash('sha256').update(serializeParameterAuthority(authority)).digest('hex')}`;
}
