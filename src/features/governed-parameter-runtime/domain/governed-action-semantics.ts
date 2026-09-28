import { governedParameterBoundKindSupports, isGovernedParameterBoundKind } from './parameter-bound.js';
import { compareDimensionIds, type DeclaredGovernedParameter } from './parameter-dimension.js';
import { isWellFormedGovernedParameter } from './parameter-value.js';
import { isSemanticIdentifier } from './semantic-identifier.js';

/**
 * The semantic classification of one governed action, as trusted
 * configuration resolved it (CORE-03).
 *
 * `action` and `resource` on the envelope stay what they always were — the
 * concrete action identifier and the concrete resource reference, both bound
 * into every grant. This adds *what kind* of action and *what kind* of
 * resource they are, and which versioned Governance Profile said so:
 *
 * ```
 * action        = export-customer-records     resource      = customers-prod
 * actionClass   = export                      resourceClass = customer_dataset
 * governanceProfile = customer-data-export@1#sha256:…
 * ```
 *
 * Opaque, domain-declared identifiers — never a CORE enum. The generic
 * authority system compares them for equality and records them; it never
 * branches on what one of them *is*.
 */
export interface GovernanceProfileReference {
  readonly id: string;
  /** A positive integer. Versions are compared for exact equality, never ordered into "newer is fine". */
  readonly version: number;
  /** `sha256:<64 hex>` over the profile's canonical content, so a silently edited profile cannot keep its old identity. */
  readonly digest: string;
}

export interface GovernedActionSemantics {
  readonly actionClass: string;
  readonly resourceClass: string;
  readonly governanceProfile: GovernanceProfileReference;
}

export const GOVERNANCE_PROFILE_VERSION_MAX = 2_147_483_647;
export const GOVERNED_PARAMETERS_MAX = 32;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isGovernanceProfileVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= GOVERNANCE_PROFILE_VERSION_MAX;
}

export function isWellFormedGovernanceProfileReference(reference: GovernanceProfileReference): boolean {
  return (
    reference !== null &&
    typeof reference === 'object' &&
    isSemanticIdentifier(reference.id) &&
    isGovernanceProfileVersion(reference.version) &&
    typeof reference.digest === 'string' &&
    DIGEST.test(reference.digest)
  );
}

/**
 * The one string form of a profile reference — `<id>@<version>#<digest>` —
 * used wherever a reference has to be a single exact value: the grant's
 * `governanceProfile` identity bound, and the exercise request that must match
 * it. Unambiguous by grammar: an id cannot contain `@` or `#`.
 */
export function formatGovernanceProfileReference(reference: GovernanceProfileReference): string {
  return `${reference.id}@${String(reference.version)}#${reference.digest}`;
}

export function isWellFormedGovernedActionSemantics(semantics: GovernedActionSemantics): boolean {
  return (
    semantics !== null &&
    typeof semantics === 'object' &&
    isSemanticIdentifier(semantics.actionClass) &&
    isSemanticIdentifier(semantics.resourceClass) &&
    isWellFormedGovernanceProfileReference(semantics.governanceProfile)
  );
}

/**
 * Whether a declared parameter list is well formed: non-empty, at most
 * `GOVERNED_PARAMETERS_MAX`, strictly ascending by dimension (sorted, no
 * duplicate), every value well formed for its type, and every bound kind one
 * its type supports.
 */
export function isWellFormedDeclaredGovernedParameters(parameters: readonly DeclaredGovernedParameter[]): boolean {
  if (!Array.isArray(parameters) || parameters.length === 0 || parameters.length > GOVERNED_PARAMETERS_MAX) return false;
  return parameters.every(
    (parameter, index) =>
      isWellFormedGovernedParameter(parameter) &&
      isGovernedParameterBoundKind(parameter.bound) &&
      governedParameterBoundKindSupports(parameter.bound, parameter.type) &&
      (index === 0 || compareDimensionIds((parameters[index - 1] as DeclaredGovernedParameter).dimension, parameter.dimension) < 0),
  );
}
