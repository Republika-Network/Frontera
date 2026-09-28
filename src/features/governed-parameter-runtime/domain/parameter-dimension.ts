import { governedParameterBoundKindSupports, isGovernedParameterBoundKind, type GovernedParameterBoundKind } from './parameter-bound.js';
import { isGovernedParameterType, type GovernedParameter, type GovernedParameterType } from './parameter-value.js';
import { isSemanticIdentifier, semanticIdentifierFold } from './semantic-identifier.js';

/**
 * Parameter dimensions: the closed world authority is evaluated in.
 *
 * > Extensible for domains. Closed for authority.
 *
 * A domain (a deployment, a vertical pack) *declares* each dimension once — its
 * identity, its value type and how it bounds — and from then on the generic
 * authority system understands exactly those three things and nothing about
 * what the dimension means. `recordCount` is "an integer bounded by a maximum",
 * never "a number of customer records". A caller can state values for declared
 * dimensions; it can never declare one, rename one, retype one or change how
 * one bounds.
 */
export interface ParameterDimensionDeclaration {
  readonly id: string;
  readonly type: GovernedParameterType;
  readonly bound: GovernedParameterBoundKind;
}

/** A typed value together with how its declared dimension bounds. What the Kernel projects grant bounds from. */
export type DeclaredGovernedParameter = GovernedParameter & { readonly bound: GovernedParameterBoundKind };

export const PARAMETER_DIMENSION_REGISTRY_MAX_DIMENSIONS = 64;

export class ParameterDimensionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParameterDimensionConfigurationError';
  }
}

export interface ParameterDimensionRegistry {
  /** Every declaration, sorted by id. */
  readonly dimensions: readonly ParameterDimensionDeclaration[];
  /** Exact-match lookup. A differently-cased id is a different, undeclared name. Own entries only — never a prototype member. */
  get(id: string): ParameterDimensionDeclaration | undefined;
}

const DECLARATION_KEYS: ReadonlySet<string> = new Set(['id', 'type', 'bound']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds the registry, or throws `ParameterDimensionConfigurationError` on
 * configuration that cannot be believed. Closed schema, strict identifiers, no
 * duplicate (including a case-only duplicate), no unknown type or bound kind,
 * and no bound kind the type cannot support (`maximum` over a token).
 */
export function createParameterDimensionRegistry(declarations: unknown): ParameterDimensionRegistry {
  if (!Array.isArray(declarations)) throw new ParameterDimensionConfigurationError('parameterDimensions must be an array.');
  if (declarations.length > PARAMETER_DIMENSION_REGISTRY_MAX_DIMENSIONS) {
    throw new ParameterDimensionConfigurationError(`At most ${PARAMETER_DIMENSION_REGISTRY_MAX_DIMENSIONS} parameter dimensions may be declared.`);
  }
  const byId = new Map<string, ParameterDimensionDeclaration>();
  const folds = new Set<string>();
  for (const [index, raw] of (declarations as readonly unknown[]).entries()) {
    if (!isPlainRecord(raw)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}] must be an object.`);
    const extra = Object.keys(raw).filter((key) => !DECLARATION_KEYS.has(key));
    if (extra.length > 0) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}] carries undeclared properties: ${extra.join(', ')}.`);
    const { id, type, bound } = raw;
    if (!isSemanticIdentifier(id)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}].id is not a semantic identifier.`);
    if (!isGovernedParameterType(type)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}].type must be one of integer, token, boolean.`);
    if (!isGovernedParameterBoundKind(bound)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}].bound must be one of exact, maximum.`);
    if (!governedParameterBoundKindSupports(bound, type)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}] declares a '${bound}' bound, which a ${type} cannot support.`);
    const fold = semanticIdentifierFold(id);
    if (folds.has(fold)) throw new ParameterDimensionConfigurationError(`parameterDimensions[${index}].id '${id}' duplicates another dimension (identifiers are unique regardless of case).`);
    folds.add(fold);
    byId.set(id, Object.freeze({ id, type, bound }));
  }
  const dimensions = Object.freeze([...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
  return Object.freeze({
    dimensions,
    get(id: string): ParameterDimensionDeclaration | undefined {
      return typeof id === 'string' ? byId.get(id) : undefined;
    },
  });
}

/** Canonical order for parameter lists: by dimension id, code-unit order (never locale). */
export function compareDimensionIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
