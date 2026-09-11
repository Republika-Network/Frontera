/**
 * What a deployment declares must happen before an authorized action may be
 * exercised.
 *
 * The declaration is operator-provisioned configuration, exactly as
 * `ContextDeclaration` is and for the same reason: this phase deliberately
 * leaves the policy-authoring surface frozen. `TARGET_AUTHORITY_CONTROL_
 * ARCHITECTURE.md` §8 phase 6 owns `contextKey` predicates and per-rule
 * declarations; until then the shape is the same either way — an obligation
 * type, whether it blocks, and how long a discharge of it stays good — so
 * moving it onto a pack later is a relocation, not a redesign.
 *
 * There is no `REQUIRE` keyword, no expression string and no parser. There is
 * no obligation *catalogue* either: two representative types, chosen to prove
 * the architecture, and a third is a code change reviewed like any other rather
 * than a configuration string a deployment can invent.
 */

/**
 * The closed obligation vocabulary this phase implements.
 *
 * Two, on purpose. `finance.approval` is the brief's own worked example and the
 * one that exercises every state; `second.signer` exists so that "blocking" and
 * "non-blocking" can be shown on the same decision, and so nothing in the
 * implementation can quietly assume there is only ever one obligation. The
 * ADR's wider list — `require-mfa`, `record-usage`, `watermark-content`,
 * `require-acceptance` — is deliberately not built here: each is a real
 * integration, and building eight of them would be building the approval
 * catalogue the ADR spends a section refusing.
 */
export type ObligationType = 'finance.approval' | 'second.signer';

export const OBLIGATION_TYPES: readonly ObligationType[] = ['finance.approval', 'second.signer'];

export function isObligationType(value: string): value is ObligationType {
  return (OBLIGATION_TYPES as readonly string[]).includes(value);
}

export interface ObligationRequirement {
  readonly obligationType: ObligationType;
  /**
   * Whether this obligation gates exercise of the authority the decision
   * granted.
   *
   * `true` is the deployment saying that an action it has already authorized
   * must not proceed until this condition is met. It never changes what the
   * decision concluded — ADR §3: "a required, unverified obligation prevents
   * grant issuance. It does not rewrite the decision."
   *
   * `false` is declared-and-tracked-and-nothing-else: the obligation appears on
   * the decision with its full lifecycle state, and exercise proceeds. Declared
   * explicitly rather than defaulted, because "not stated" must never be read
   * as "not blocking".
   */
  readonly blocking: boolean;
  /**
   * How long a discharge of this obligation stays good, in seconds from the
   * instant it was observed.
   *
   * Absent means this deployment imposes no window. Present, a discharge older
   * than the window does not satisfy the obligation and drives it to `expired`
   * — ADR §6's "expiry is a state, not a background job … derived from the
   * clock at read time", applied to the obligation rather than to the grant.
   * Nothing sweeps; nothing has to have run.
   */
  readonly maxDischargeAgeSeconds?: number;
}

/**
 * Everything a deployment declares about obligations, in one
 * operator-provisioned object.
 *
 * A declaration with no requirements is the whole of the opt-out: the Kernel
 * then behaves exactly as it does with no obligation capability configured at
 * all, which is the equivalence `obligation-capability-absent.test.ts` pins.
 */
export interface ObligationDeclaration {
  readonly requirements: readonly ObligationRequirement[];
}

/** Structural violations of a whole declaration, reported together so an operator fixes one configuration rather than five. */
export function validateObligationDeclaration(declaration: ObligationDeclaration): readonly string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(declaration.requirements)) {
    return ['ObligationDeclaration.requirements is required and must be an array.'];
  }

  for (const requirement of declaration.requirements) {
    if (typeof requirement.obligationType !== 'string' || !isObligationType(requirement.obligationType)) {
      violations.push(`ObligationRequirement: obligationType '${String(requirement.obligationType)}' is not a declared obligation type.`);
      continue;
    }
    if (seen.has(requirement.obligationType)) violations.push(`ObligationRequirement '${requirement.obligationType}': declared more than once.`);
    seen.add(requirement.obligationType);
    if (typeof requirement.blocking !== 'boolean') {
      violations.push(`ObligationRequirement '${requirement.obligationType}': blocking must be declared explicitly — "not stated" must never be read as "not blocking".`);
    }
    if (requirement.maxDischargeAgeSeconds !== undefined && (!Number.isFinite(requirement.maxDischargeAgeSeconds) || requirement.maxDischargeAgeSeconds <= 0)) {
      violations.push(`ObligationRequirement '${requirement.obligationType}': maxDischargeAgeSeconds must be a positive, finite number of seconds.`);
    }
  }

  return violations;
}
