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
  /**
   * CORE-04 — restrict-only fact classes (the admitted form of a RiskSignal):
   * facts whose *presence* policy may use only to restrict. Their absence is
   * the baseline and never fails a request; an ambiguous reading denies. A
   * class is either material or restrict-only, never both. Present only when
   * non-empty, so a profile without any keeps its CORE-03 digest.
   */
  readonly restrictiveFacts?: readonly string[];
  /**
   * CORE-04 — the obligations a decision under this profile stands under, in
   * the obligation runtime's own vocabulary (declared kind, blocking or not).
   * A blocking obligation withholds grant issuance — never the decision —
   * until it is satisfied (`verified` or `waived`). Present only when
   * non-empty.
   */
  readonly obligations?: readonly GovernanceProfileObligation[];
  /**
   * CORE-05 — how a decision under this profile that awaits a human approval
   * can be approved: who (by durable Kernel-Authority), how many, and for how
   * long. It never decides *whether* approval is required — deterministic
   * policy does — and a profile without it leaves an approval-required
   * decision withheld, exactly as before CORE-05. Present only when declared,
   * so every earlier profile keeps its digest.
   */
  readonly approval?: GovernanceProfileApproval;
}

/** CORE-04 — one obligation a profile declares. */
export interface GovernanceProfileObligation {
  readonly obligationType: string;
  readonly blocking: boolean;
}

/**
 * CORE-05 — a profile's approval requirement: organization-controlled trusted
 * configuration, never request data. It maps onto approval-runtime's own
 * `ApprovalRequirement` (a `quorum_approval` with segregation of duties always
 * required), whose policies judge every verdict.
 */
export interface GovernanceProfileApproval {
  /**
   * The Kernel-Authority action an approver must hold live authority for —
   * over the approved request's resource — when approving and again when the
   * approval is used (approval-runtime's `requiredAuthorityCapability`).
   * **Never a governed action** (the registry refuses one): authority to
   * approve is not authority to act, and an actor able to take the action
   * gains no standing to approve it.
   */
  readonly approverAction: string;
  /** Distinct approvers required. The same approver never counts twice. */
  readonly minimumApprovals: number;
  /** Seconds after the decision was made within which an approval counts. After it, the request has expired and no approval resumes it. */
  readonly requestTtlSeconds: number;
  /** Seconds a completed approval stays usable. A resumed grant never outlives it. */
  readonly approvalValiditySeconds: number;
  /**
   * The evidence types (approval-runtime's `ApprovalEvidenceType`) every
   * approving verdict must cite as reviewed, each by a `sha256:` content hash.
   * Present only when non-empty.
   */
  readonly requiredEvidence?: readonly string[];
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
  /**
   * Whether `key` is reserved by configuration: a registered extension, a
   * declared dimension, or (CORE-04) a fact class any profile declares or a
   * key in a reserved internal namespace (`aoc.context`, `aoc.obligations`,
   * `aoc.grant`) — all regardless of case. The built-in list is checked by the
   * envelope beside this.
   */
  reservesContextKey(key: string): boolean;
  /** CORE-04 — every fact class any profile declares (material and restrict-only), sorted. */
  readonly factClasses: readonly string[];
}
