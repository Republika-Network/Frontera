import {
  createParameterDimensionRegistry,
  isGovernanceProfileVersion,
  isGovernedParameterToken,
  isSemanticIdentifier,
  ParameterDimensionConfigurationError,
  semanticIdentifierFold,
  type GovernedActionSemantics,
  type ParameterDimensionRegistry,
} from '../../features/governed-parameter-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import { computeDigest } from '../governance-store/digest.js';
import {
  GOVERNANCE_PROFILE_REFUSALS,
  type GovernanceActionClassDeclaration,
  type GovernanceConfiguration,
  type GovernanceProfileDefinition,
  type GovernanceProfileParameter,
  type GovernanceProfileRegistry,
  type GovernanceProfileResolution,
  type GovernanceResourceClassDeclaration,
  type ResolvedGovernanceProfile,
} from './contracts.js';
import { GovernanceProfileConfigurationError } from './errors.js';

/**
 * Builds the trusted Governance Profile registry, or throws
 * `GovernanceProfileConfigurationError` on configuration that cannot be
 * believed. Composition-time only: called once, before any store opens, and
 * the result is frozen.
 *
 * Every check is structural and total — closed schemas, strict identifiers,
 * bounded sizes, no duplicates (including case-only duplicates), every
 * reference resolvable — because a profile that half-validates is a profile
 * whose meaning depends on which half a reader believed.
 */

/** Domain tag for a profile digest: a profile's identity is its content, under a format that can be versioned without colliding. */
export const GOVERNANCE_PROFILE_FORMAT = 'frontera.governance-profile.v1';

const LIMITS = {
  classes: 256,
  membersPerClass: 1024,
  profiles: 256,
  parametersPerProfile: 32,
  referencesPerProfile: 64,
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new GovernanceProfileConfigurationError(message);
}

function closed(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${where} must be an object.`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`${where} carries undeclared properties: ${extra.join(', ')}.`);
  return value;
}

function list(value: unknown, where: string, maximum: number): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where} must be an array.`);
  if (value.length > maximum) fail(`${where} may hold at most ${maximum} entries.`);
  return value as readonly unknown[];
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Declared class → its members, with each member in at most one class and no case-only duplicate class id. */
function buildClasses(entries: readonly unknown[], where: string, memberKey: 'actions' | 'resources'): { readonly classOf: ReadonlyMap<string, string>; readonly ids: ReadonlySet<string> } {
  const classOf = new Map<string, string>();
  const ids = new Set<string>();
  const folds = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const entry = closed(raw, ['id', memberKey], `${where}[${index}]`);
    const id = entry['id'];
    if (!isSemanticIdentifier(id)) fail(`${where}[${index}].id is not a semantic identifier.`);
    if (folds.has(semanticIdentifierFold(id))) fail(`${where}[${index}].id '${id}' is declared twice (identifiers are unique regardless of case).`);
    folds.add(semanticIdentifierFold(id));
    ids.add(id);
    const members = list(entry[memberKey], `${where}[${index}].${memberKey}`, LIMITS.membersPerClass);
    if (members.length === 0) fail(`${where}[${index}].${memberKey} must name at least one member.`);
    for (const member of members) {
      if (!isCanonicalCustomerIdentifier(member)) fail(`${where}[${index}].${memberKey} holds a non-canonical identifier.`);
      if (classOf.has(member)) fail(`${where}: '${member}' belongs to more than one class.`);
      classOf.set(member, id);
    }
  }
  return { classOf, ids };
}

function uniqueReferences(value: unknown, where: string, accepts: (entry: unknown) => entry is string): readonly string[] {
  const entries = list(value, where, LIMITS.referencesPerProfile);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!accepts(entry)) fail(`${where} holds a malformed reference.`);
    if (seen.has(entry)) fail(`${where} names '${entry}' twice.`);
    seen.add(entry);
  }
  return Object.freeze([...seen].sort(byId));
}

function validateProfile(
  raw: unknown,
  index: number,
  dimensions: ParameterDimensionRegistry,
  actionClasses: ReadonlySet<string>,
  resourceClasses: ReadonlySet<string>,
): GovernanceProfileDefinition {
  const where = `profiles[${index}]`;
  const entry = closed(raw, ['profileId', 'version', 'owner', 'provenance', 'actionClass', 'resourceClass', 'parameters', 'materialFacts', 'relevantPolicies'], where);
  const { profileId, version, owner, actionClass, resourceClass } = entry;
  if (!isSemanticIdentifier(profileId)) fail(`${where}.profileId is not a semantic identifier.`);
  if (!isGovernanceProfileVersion(version)) fail(`${where}.version must be a positive integer.`);
  if (!isGovernedParameterToken(owner)) fail(`${where}.owner must be an identifier.`);
  const provenance = closed(entry['provenance'], ['authoredBy', 'approvedBy'], `${where}.provenance`);
  if (!isGovernedParameterToken(provenance['authoredBy']) || !isGovernedParameterToken(provenance['approvedBy'])) fail(`${where}.provenance requires authoredBy and approvedBy identifiers.`);
  if (!isSemanticIdentifier(actionClass) || !actionClasses.has(actionClass)) fail(`${where}.actionClass is not a declared action class.`);
  if (!isSemanticIdentifier(resourceClass) || !resourceClasses.has(resourceClass)) fail(`${where}.resourceClass is not a declared resource class.`);

  const parameters: GovernanceProfileParameter[] = [];
  const seen = new Set<string>();
  for (const [parameterIndex, rawParameter] of list(entry['parameters'], `${where}.parameters`, LIMITS.parametersPerProfile).entries()) {
    const parameter = closed(rawParameter, ['dimension', 'required'], `${where}.parameters[${parameterIndex}]`);
    const { dimension, required } = parameter;
    if (typeof dimension !== 'string' || dimensions.get(dimension) === undefined) fail(`${where}.parameters[${parameterIndex}].dimension is not a declared parameter dimension.`);
    if (typeof required !== 'boolean') fail(`${where}.parameters[${parameterIndex}].required must be a boolean.`);
    if (seen.has(dimension)) fail(`${where}.parameters names dimension '${dimension}' twice.`);
    seen.add(dimension);
    parameters.push(Object.freeze({ dimension, required }));
  }
  parameters.sort((left, right) => byId(left.dimension, right.dimension));

  return Object.freeze({
    profileId,
    version,
    owner,
    provenance: Object.freeze({ authoredBy: provenance['authoredBy'] as string, approvedBy: provenance['approvedBy'] as string }),
    actionClass,
    resourceClass,
    parameters: Object.freeze(parameters),
    materialFacts: uniqueReferences(entry['materialFacts'], `${where}.materialFacts`, isSemanticIdentifier),
    relevantPolicies: uniqueReferences(entry['relevantPolicies'], `${where}.relevantPolicies`, isGovernedParameterToken),
  });
}

/**
 * A profile's identity is its canonical content. The digest covers every
 * field (sorted lists, canonical JSON, the format tag), so two different
 * profiles never share a reference, and an edit under an unchanged version
 * changes the reference anyway — it cannot silently keep its old identity.
 */
export function governanceProfileDigest(definition: GovernanceProfileDefinition): string {
  return computeDigest({ format: GOVERNANCE_PROFILE_FORMAT, profile: definition });
}

export function createGovernanceProfileRegistry(configuration: GovernanceConfiguration | undefined): GovernanceProfileRegistry {
  const config = closed(configuration ?? {}, ['parameterDimensions', 'actionClasses', 'resourceClasses', 'profiles'], 'governance');

  let dimensions: ParameterDimensionRegistry;
  try {
    dimensions = createParameterDimensionRegistry(config['parameterDimensions'] ?? []);
  } catch (error) {
    if (error instanceof ParameterDimensionConfigurationError) fail(error.message);
    throw error;
  }
  const actions = buildClasses(list(config['actionClasses'], 'actionClasses', LIMITS.classes), 'actionClasses', 'actions');
  const resources = buildClasses(list(config['resourceClasses'], 'resourceClasses', LIMITS.classes), 'resourceClasses', 'resources');

  const byCombination = new Map<string, ResolvedGovernanceProfile>();
  const profileFolds = new Set<string>();
  const profiles: ResolvedGovernanceProfile[] = [];
  for (const [index, raw] of list(config['profiles'], 'profiles', LIMITS.profiles).entries()) {
    const definition = validateProfile(raw, index, dimensions, actions.ids, resources.ids);
    const fold = semanticIdentifierFold(definition.profileId);
    // One version of a profile per registry: a lifecycle (draft → active →
    // retired) is future work, and two simultaneously active versions of one
    // profile would make "which version governed this?" ambiguous.
    if (profileFolds.has(fold)) fail(`profiles[${index}].profileId '${definition.profileId}' is declared twice (one active version per profile; identifiers are unique regardless of case).`);
    profileFolds.add(fold);
    const combination = `${definition.actionClass}\u0000${definition.resourceClass}`;
    if (byCombination.has(combination)) fail(`profiles[${index}] governs ${definition.actionClass} × ${definition.resourceClass}, which another profile already governs.`);
    const resolved: ResolvedGovernanceProfile = Object.freeze({
      definition,
      reference: Object.freeze({ id: definition.profileId, version: definition.version, digest: governanceProfileDigest(definition) }),
      source: 'host-configuration' as const,
    });
    byCombination.set(combination, resolved);
    profiles.push(resolved);
  }
  profiles.sort((left, right) => byId(left.definition.profileId, right.definition.profileId));

  const dimensionFolds = new Set(dimensions.dimensions.map((dimension) => semanticIdentifierFold(dimension.id)));
  const configured = actions.ids.size > 0 || resources.ids.size > 0 || profiles.length > 0;

  return Object.freeze({
    configured,
    dimensions,
    profiles: Object.freeze(profiles),
    resolve(action: string, resource: string): GovernanceProfileResolution {
      const actionClass = actions.classOf.get(action);
      const resourceClass = resources.classOf.get(resource);
      if (actionClass === undefined && resourceClass === undefined) return { kind: 'unclassified' };
      if (actionClass === undefined) return { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_ACTION_CLASS_UNKNOWN };
      if (resourceClass === undefined) return { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_RESOURCE_CLASS_UNKNOWN };
      const profile = byCombination.get(`${actionClass}\u0000${resourceClass}`);
      if (profile === undefined) return { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_PROFILE_UNKNOWN };
      const semantics: GovernedActionSemantics = Object.freeze({ actionClass, resourceClass, governanceProfile: profile.reference });
      return { kind: 'resolved', profile, semantics };
    },
    shadowsDeclaredDimension(key: string): boolean {
      return typeof key === 'string' && dimensionFolds.has(key.toLowerCase());
    },
  });
}

/** Re-exported for hosts that validate a declaration before composing. */
export type { GovernanceActionClassDeclaration, GovernanceResourceClassDeclaration };
