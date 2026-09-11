import { validateContextDerivation, type ContextDerivation } from './context-derivation.js';
import { TERMINAL_CONTEXT_TRUST_CLASSES, type TerminalContextTrustClass } from './context-trust.js';

/**
 * The deployment's migration posture for facts the requester supplied.
 *
 * ADR §7, verbatim in intent: a deployment moves `permit → report →
 * require-declaration` on its own schedule, and `report` exists "because no
 * operator should discover their exposure by taking an outage; it turns the
 * migration into a list."
 *
 * ```
 * permit               asserted facts satisfy a requirement that asked for no more
 * report               the same, and every requirement that turned on one is named
 * require-declaration  an asserted fact satisfies a requirement only for a key the
 *                      deployment declared assertable
 * ```
 *
 * This posture governs *one* question — whether an asserted fact may satisfy a
 * requirement whose declared minimum is already `asserted`. It never relaxes a
 * higher minimum: a requirement asking for `authoritative` is unsatisfiable by
 * an asserted fact under every posture, which is the guarantee ADR §5 makes
 * unconditional.
 */
export type ContextAssertedFactPolicy = 'permit' | 'report' | 'require-declaration';

export const CONTEXT_ASSERTED_FACT_POLICIES: readonly ContextAssertedFactPolicy[] = ['permit', 'report', 'require-declaration'];

export const DEFAULT_CONTEXT_ASSERTED_FACT_POLICY: ContextAssertedFactPolicy = 'permit';

/**
 * One key the deployment needs resolved, at what minimum trust, within what
 * freshness — ADR §4: "the Kernel resolves exactly the declared keys before
 * evaluation begins, and nothing else. No speculative resolution, no 'fetch
 * everything about the vendor'."
 */
export interface ContextRequirement {
  readonly key: string;
  readonly minimumTrustClass: TerminalContextTrustClass;
  /** Freshness tolerance. Absent means this requirement imposes none; the source's own bound, if it declares one, still applies. */
  readonly maxAgeSeconds?: number;
  /**
   * Whether an unsatisfied requirement stops the request.
   *
   * `false` — the default posture of every requirement a deployment does not
   * mark — means the fact is resolved and reported and nothing else happens:
   * the deployment's own policy decides what an unresolved vendor status means,
   * exactly as ADR §5 requires ("Frontera ships no rule about what an unresolved
   * fact means").
   *
   * `true` is the deployment saying, in its own configuration, that it does not
   * want the action evaluated at all without this fact. The denial that follows
   * is the Kernel acting on that declaration — hard invariant 6: a required
   * fact's resolution failure "denies **because the rule said required**, not
   * because the resolver decided."
   */
  readonly required: boolean;
}

/**
 * Everything a deployment declares about context, in one operator-provisioned
 * object.
 *
 * The requirement set lives here rather than on a policy pack rule because this
 * phase deliberately leaves the policy-authoring surface frozen (see
 * `README.md`, "What this phase does not do"). The shape is the same either
 * way — a declared key, a minimum class, a freshness bound — so moving it onto
 * a pack later is a relocation, not a redesign.
 */
export interface ContextDeclaration {
  readonly requirements: readonly ContextRequirement[];
  readonly derivations?: readonly ContextDerivation[];
  /** Defaults to `permit`, which is today's behaviour exactly. */
  readonly assertedFactPolicy?: ContextAssertedFactPolicy;
  /** The keys this deployment has reviewed and accepted as assertable. Read only under `require-declaration`. Never requester-supplied. */
  readonly assertableKeys?: readonly string[];
}

export function contextDeclarationAssertedFactPolicy(declaration: ContextDeclaration): ContextAssertedFactPolicy {
  return declaration.assertedFactPolicy ?? DEFAULT_CONTEXT_ASSERTED_FACT_POLICY;
}

/** Structural violations of a whole declaration, reported together so an operator fixes one configuration rather than five. */
export function validateContextDeclaration(declaration: ContextDeclaration): readonly string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const requirement of declaration.requirements) {
    if (typeof requirement.key !== 'string' || requirement.key.trim().length === 0) {
      violations.push('ContextRequirement.key is required and must be non-empty.');
      continue;
    }
    if (seen.has(requirement.key)) violations.push(`ContextRequirement '${requirement.key}': declared more than once.`);
    seen.add(requirement.key);
    if (!TERMINAL_CONTEXT_TRUST_CLASSES.includes(requirement.minimumTrustClass)) {
      violations.push(`ContextRequirement '${requirement.key}': minimumTrustClass '${String(requirement.minimumTrustClass)}' is not a comparable trust class.`);
    }
    if (requirement.maxAgeSeconds !== undefined && (!Number.isFinite(requirement.maxAgeSeconds) || requirement.maxAgeSeconds <= 0)) {
      violations.push(`ContextRequirement '${requirement.key}': maxAgeSeconds must be a positive, finite number of seconds.`);
    }
    if (typeof requirement.required !== 'boolean') {
      violations.push(`ContextRequirement '${requirement.key}': required must be declared explicitly — "not stated" must never be read as "not needed".`);
    }
  }

  const derivedKeys = new Set<string>();
  for (const derivation of declaration.derivations ?? []) {
    violations.push(...validateContextDerivation(derivation));
    if (derivedKeys.has(derivation.key)) violations.push(`ContextDerivation '${derivation.key}': declared more than once.`);
    derivedKeys.add(derivation.key);
    for (const operandKey of derivation.operandKeys) {
      if (!seen.has(operandKey)) {
        violations.push(`ContextDerivation '${derivation.key}': operand key '${operandKey}' is not a declared context requirement.`);
      }
    }
  }

  for (const assertableKey of declaration.assertableKeys ?? []) {
    if (!seen.has(assertableKey)) violations.push(`ContextDeclaration.assertableKeys names '${assertableKey}', which is not a declared context requirement.`);
  }

  const policy = declaration.assertedFactPolicy;
  if (policy !== undefined && !CONTEXT_ASSERTED_FACT_POLICIES.includes(policy)) {
    violations.push(`ContextDeclaration.assertedFactPolicy '${String(policy)}' is not a declared migration posture.`);
  }

  return violations;
}
