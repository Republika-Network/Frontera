import type { GovernanceProfileReference, GovernedActionSemantics, ParameterDimensionDeclaration, ParameterDimensionRegistry } from '../../features/governed-parameter-runtime/index.js';

/**
 * Governance Profiles (CORE-03) — the declarative statement of *what matters*
 * for one Action × Resource combination.
 *
 * > A profile describes what matters. Policy decides what is allowed.
 *
 * A profile names the action class and resource class it governs, the typed
 * parameter dimensions such an action carries (and which are required), the
 * material fact classes that bear on it (bound to trusted sources by CORE-04,
 * not here) and the policies relevant to it — **by reference only**. It holds
 * no rule, no threshold, no expression and no code: every field is an
 * identifier, an integer or a boolean, and the schema is closed, so executable
 * content has nowhere to be written.
 *
 * ## Trust boundary
 *
 * Profiles come from trusted host configuration (`CreateEnterpriseOptions.
 * governance`, or the shipped Host's governed-action file) and from nowhere
 * else. A governed-action intent can *expect* a profile — `{id, version}` — and
 * is refused if the trusted resolver disagrees; it can never *choose* one,
 * supply one, or change what one declares.
 */

/** One parameter a profile governs: a declared dimension, and whether an action under this profile must state it. */
export interface GovernanceProfileParameter {
  readonly dimension: string;
  readonly required: boolean;
}

/** Who authored and who approved this version. Recorded, digested, never interpreted. Cryptographic profile signing is not part of CORE-03. */
export interface GovernanceProfileProvenance {
  readonly authoredBy: string;
  readonly approvedBy: string;
}

/** The declarative profile, exactly as configured — closed schema. */
export interface GovernanceProfileDefinition {
  readonly profileId: string;
  readonly version: number;
  /** The organization or domain pack that owns this profile's content. */
  readonly owner: string;
  readonly provenance: GovernanceProfileProvenance;
  readonly actionClass: string;
  readonly resourceClass: string;
  readonly parameters: readonly GovernanceProfileParameter[];
  /** Fact classes material to this combination. Declared here; admitted from trusted sources by CORE-04. */
  readonly materialFacts: readonly string[];
  /** References to the policy packs relevant to this combination — never inline rules. */
  readonly relevantPolicies: readonly string[];
}

/** Where a resolved profile came from. One source exists in CORE-03. */
export type GovernanceProfileSource = 'host-configuration';

/** A validated, frozen, digested profile: the definition plus its identity. */
export interface ResolvedGovernanceProfile {
  readonly definition: GovernanceProfileDefinition;
  readonly reference: GovernanceProfileReference;
  readonly source: GovernanceProfileSource;
}

/** A domain-declared class over concrete identifiers the envelope already carries. */
export interface GovernanceActionClassDeclaration {
  readonly id: string;
  /** Concrete `GovernedActionIntent.action` identifiers of this class. Each belongs to at most one class. */
  readonly actions: readonly string[];
}

export interface GovernanceResourceClassDeclaration {
  readonly id: string;
  /** Concrete `GovernedActionIntent.resource` references of this class. Each belongs to at most one class. Exact references; no pattern, prefix or wildcard. */
  readonly resources: readonly string[];
}

/** What a host states. Every array defaults to empty; an entirely empty configuration governs nothing and changes nothing. */
export interface GovernanceConfiguration {
  readonly parameterDimensions?: readonly ParameterDimensionDeclaration[];
  readonly actionClasses?: readonly GovernanceActionClassDeclaration[];
  readonly resourceClasses?: readonly GovernanceResourceClassDeclaration[];
  readonly profiles?: readonly GovernanceProfileDefinition[];
  /**
   * The reserved-key registry's trusted extensions: `assertedContext` keys a
   * deployment or vertical (e.g. a payment protocol pack, L-7) reserves beside
   * the built-in `GOVERNED_ACTION_RESERVED_CONTEXT_KEYS`, which always remain.
   * Matched regardless of case. Only configuration can add one; a request can
   * neither add nor remove a reserved key.
   */
  readonly reservedContextKeys?: readonly string[];
}

/**
 * The resolution of one `(action, resource)` pair.
 *
 * - `unclassified` — neither the action nor the resource belongs to any
 *   declared class. The action is governed exactly as before CORE-03, and may
 *   carry no typed parameters.
 * - `resolved` — both are classified and exactly one profile governs the pair.
 * - `refused` — the pair is half-classified, or classified with no profile
 *   governing it. Never a fallback to the unclassified path: a deployment that
 *   classified this action or resource has said it matters.
 */
export type GovernanceProfileResolution =
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'resolved'; readonly profile: ResolvedGovernanceProfile; readonly semantics: GovernedActionSemantics }
  | { readonly kind: 'refused'; readonly reason: GovernanceProfileRefusal };

export const GOVERNANCE_PROFILE_REFUSALS = {
  GOVERNANCE_ACTION_CLASS_UNKNOWN: 'GOVERNANCE_ACTION_CLASS_UNKNOWN',
  GOVERNANCE_RESOURCE_CLASS_UNKNOWN: 'GOVERNANCE_RESOURCE_CLASS_UNKNOWN',
  GOVERNANCE_PROFILE_UNKNOWN: 'GOVERNANCE_PROFILE_UNKNOWN',
} as const;

export type GovernanceProfileRefusal = (typeof GOVERNANCE_PROFILE_REFUSALS)[keyof typeof GOVERNANCE_PROFILE_REFUSALS];

/** Read-only by type. Built once from host configuration and frozen. */
export interface GovernanceProfileRegistry {
  /** Whether any class or profile is declared. `false` is the pre-CORE-03 world, exactly. */
  readonly configured: boolean;
  readonly dimensions: ParameterDimensionRegistry;
  /** Every profile, sorted by id. */
  readonly profiles: readonly ResolvedGovernanceProfile[];
  resolve(action: string, resource: string): GovernanceProfileResolution;
  /** Whether `key` names a declared dimension regardless of case — so a caller-asserted context key cannot shadow one. */
  shadowsDeclaredDimension(key: string): boolean;
  /** The configured reserved-key extensions, sorted. */
  readonly reservedContextKeys: readonly string[];
  /** Whether `key` is reserved by configuration: a registered extension or a declared dimension, regardless of case. The built-in list is checked by the envelope beside this. */
  reservesContextKey(key: string): boolean;
}
