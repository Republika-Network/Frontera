import type { PolicyCondition, PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { DESTINATION_CONTEXT_FACT_CLASSES as F } from './destination-context.js';

/**
 * ANDREW-P0-05 — destination approval policy.
 *
 * > **An action of the governed class may move toward a destination only when
 * > that destination is known and actively approved for this organization.**
 *
 * This is policy as data: ordinary `PolicyPackRule`s over the generic
 * `actionClass` and `contextFact` predicates, read by the unchanged policy
 * engine. It reads the trusted destination facts P0-04 admits, and nothing
 * else — no store, no registry, no approval history, no request field. It is
 * opt-in: a deployment composes these rules into its own policy pack for the
 * action class it wants governed, and declares the destination fact classes
 * as material facts of that class's Governance Profile
 * (`DESTINATION_POLICY_MATERIAL_FACTS`). Nothing changes for any action class,
 * or any deployment, that does not.
 *
 * ## No amount threshold
 *
 * No rule reads `amount` or `currency`. An unapproved destination is refused
 * at every amount; monetary ceilings remain the financial-authority layer's,
 * untouched.
 *
 * ## Refusal, not a pending state
 *
 * Every rule's effect is `deny`, which the Kernel commits as `denied`
 * (`DOMAIN_POLICY_DENIED`) — terminal, before any grant can be minted. Not
 * `require_approval`: on the governed path that is an *action* approval a
 * reviewer can grant to resume this very decision, and approving one request
 * must never stand in for approving the destination. A destination is
 * approved through destination approval, and a new request is then evaluated
 * against the new state.
 *
 * ## Exhaustive and fail-closed
 *
 * The rules are mutually exclusive, so the decision names exactly one cause.
 * Whenever any destination fact was admitted, they refuse every combination
 * except `known = true ∧ approvalState = approved ∧ approved = true`; admitted
 * facts that are incomplete or disagree are refused
 * (`DESTINATION_APPROVAL_UNVERIFIED`), never read as approval.
 *
 * When no destination fact was admitted — a store unavailable, a corrupt or
 * inconsistent state, an undetermined destination — no rule matches, on
 * purpose: P0-04 withholds every fact, and the facts are material, so the
 * Kernel's required-context step denies with its own code
 * (`CONTEXT_REQUIRED_FACT_UNRESOLVED`). Unavailability is reported as
 * unavailability, never relabelled as a destination verdict.
 *
 * That relies on the facts being declared material for the governed class;
 * `assertDestinationPolicyGovernance` refuses a configuration that does not,
 * so composing the rules without the facts fails at startup rather than open.
 */

/** Stable, machine-readable causes. Each appears in the committed decision as the policy outcome's reason code. */
export const DESTINATION_POLICY_REASON_CODES = Object.freeze({
  /** The registry verifiably does not know the destination. */
  unknown: 'DESTINATION_UNKNOWN',
  /** Known, and this organization has never approved it. */
  notApproved: 'DESTINATION_NOT_APPROVED',
  /** Known, and this organization's approval was revoked or has expired. */
  approvalInactive: 'DESTINATION_APPROVAL_INACTIVE',
  /** Destination facts were admitted but do not establish an active approval: incomplete, unrecognized, or inconsistent with each other. */
  unverified: 'DESTINATION_APPROVAL_UNVERIFIED',
} as const);

/** The fact classes a Governance Profile governed by these rules declares as material facts — sorted, as profiles list them. */
export const DESTINATION_POLICY_MATERIAL_FACTS: readonly string[] = Object.freeze([F.approvalState, F.approved, F.key, F.known].sort());

export interface DestinationApprovalPolicyOptions {
  /** The trusted CORE-03 action class the rules govern. No other action class is affected. */
  readonly actionClass: string;
  /** The policy pack version the rules are registered under. */
  readonly policyPackVersionId: string;
  /** Source ids of that version the rules cite. At least one. */
  readonly sourceIds: readonly string[];
  /** Prefix of the rule ids. Defaults to `destination-approval`. */
  readonly ruleIdPrefix?: string;
  /** Rule priority (lower evaluates first). Defaults to 10. */
  readonly priority?: number;
}

const fact = (factClass: string, operator: 'equals' | 'in', value: unknown): PolicyCondition => ({ type: 'predicate', field: 'contextFact', factClass, operator, value });
const all = (...conditions: PolicyCondition[]): PolicyCondition => ({ type: 'group', operator: 'all', conditions });
const none = (...conditions: PolicyCondition[]): PolicyCondition => ({ type: 'group', operator: 'not', conditions });
const anyPresent = (...factClasses: string[]): PolicyCondition => ({
  type: 'group',
  operator: 'any',
  conditions: factClasses.map((factClass): PolicyCondition => ({ type: 'predicate', field: 'contextFact', factClass, operator: 'exists' })),
});

const INACTIVE_STATES = ['revoked', 'expired'] as const;
const REFUSED_STATES = ['never-approved', ...INACTIVE_STATES] as const;

/**
 * The destination approval rules for one action class, as data to compose
 * into a policy pack version. Pure: the same options always yield the same
 * rules.
 */
export function destinationApprovalPolicyRules(options: DestinationApprovalPolicyOptions): readonly PolicyPackRule[] {
  const { actionClass, policyPackVersionId } = options;
  if (typeof actionClass !== 'string' || actionClass.length === 0) throw new TypeError('Destination approval policy needs the action class it governs.');
  if (typeof policyPackVersionId !== 'string' || policyPackVersionId.length === 0) throw new TypeError('Destination approval policy needs a policy pack version id.');
  if (!Array.isArray(options.sourceIds) || options.sourceIds.length === 0 || options.sourceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError('Destination approval policy needs at least one source id.');
  }
  const prefix = options.ruleIdPrefix ?? 'destination-approval';
  const priority = options.priority ?? 10;
  const sourceIds = Object.freeze([...options.sourceIds]);
  const governed: PolicyCondition = { type: 'predicate', field: 'actionClass', operator: 'equals', value: actionClass };
  const known = fact(F.known, 'equals', true);

  const rule = (suffix: string, condition: PolicyCondition, reasonCode: string, reason: string): PolicyPackRule =>
    Object.freeze({
      id: `${prefix}-${suffix}`,
      policyPackVersionId,
      name: `${prefix}-${suffix}`,
      description: reason,
      status: 'active',
      priority,
      condition: all(governed, condition),
      effect: Object.freeze({ type: 'deny', reasonCode, reason }),
      obligations: [],
      evidenceRequirements: [],
      approvalRequirements: [],
      severity: 'error',
      sourceIds,
    });

  const R = DESTINATION_POLICY_REASON_CODES;
  return Object.freeze([
    rule('unknown', fact(F.known, 'equals', false), R.unknown, `The destination is not known to the destination registry. Required: ${F.known} = true; observed: false.`),
    rule(
      'never-approved',
      all(known, fact(F.approvalState, 'equals', 'never-approved')),
      R.notApproved,
      `The destination is not approved for this organization. Required: ${F.approvalState} = approved; observed: never-approved.`,
    ),
    rule(
      'revoked',
      all(known, fact(F.approvalState, 'equals', 'revoked')),
      R.approvalInactive,
      `The destination's approval for this organization was revoked. Required: ${F.approvalState} = approved; observed: revoked.`,
    ),
    rule(
      'expired',
      all(known, fact(F.approvalState, 'equals', 'expired')),
      R.approvalInactive,
      `The destination's approval for this organization has expired. Required: ${F.approvalState} = approved; observed: expired.`,
    ),
    // Facts were produced, but neither the rules above name them nor do they
    // establish a consistent active approval: one fact missing beside the
    // others, an unrecognized value, or facts that disagree. When *no*
    // destination fact was admitted, no rule matches: that is unavailability,
    // and the Kernel's required-context step denies it as such.
    rule(
      'unverified',
      all(
        anyPresent(F.key, F.known, F.approvalState, F.approved),
        none(
          fact(F.known, 'equals', false),
          all(known, fact(F.approvalState, 'in', [...REFUSED_STATES])),
          all(known, fact(F.approvalState, 'equals', 'approved'), fact(F.approved, 'equals', true)),
        ),
      ),
      R.unverified,
      `Active destination approval is not established by admitted trusted context. Required: ${F.known} = true, ${F.approvalState} = approved, ${F.approved} = true.`,
    ),
  ]);
}

/**
 * Refuses a governance configuration under which the destination rules for
 * `actionClass` could be skipped: no Governance Profile governs the class, or
 * one that does omits a destination fact class from its material facts. With
 * every fact material, an unresolved fact denies at the Trusted Context
 * Boundary; without, it would simply be absent and no rule would match.
 *
 * Pure; for the composition that registers the rules, at startup.
 */
export function assertDestinationPolicyGovernance(governance: GovernanceConfiguration, actionClass: string): void {
  const profiles = (governance.profiles ?? []).filter((profile) => profile.actionClass === actionClass);
  if (profiles.length === 0) throw new TypeError(`Destination approval policy governs action class '${actionClass}', but no Governance Profile declares it.`);
  for (const profile of profiles) {
    const missing = DESTINATION_POLICY_MATERIAL_FACTS.filter((factClass) => !profile.materialFacts.includes(factClass));
    if (missing.length > 0) {
      throw new TypeError(`Governance Profile '${profile.profileId}' (action class '${actionClass}') must declare ${missing.join(', ')} as material facts for destination approval policy to fail closed.`);
    }
  }
}
