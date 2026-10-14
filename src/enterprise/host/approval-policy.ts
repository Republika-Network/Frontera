import { randomUUID } from 'node:crypto';

import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { operatorMay, type OperatorRoleOrLegacy } from '../operator-control/roles.js';

/**
 * PROD-03 — the governed-action file's `approvalPolicy`: the one piece of
 * deterministic policy a pilot running the shipped launcher can declare
 * without writing code.
 *
 * A Governance Profile's `approval` (CORE-05) says **how** a decision is
 * approved; deterministic policy decides **whether** one must be. Until
 * PROD-03 that policy was in-process composition only
 * (`bootEnterpriseHost({ policyPackProvider })`), so the shipped launcher —
 * which passes none — could never send a decision to a human, and a pilot
 * that needed approval had to embed Frontera in code it wrote.
 *
 * `approvalPolicy` is deliberately the smallest closed form of that policy:
 *
 * ```json
 * "approvalPolicy": {
 *   "policyId": "pilot-approvals",
 *   "rules": [{ "ruleId": "release-review", "governanceProfile": "release-production", "reasonCode": "RELEASE_REVIEW_REQUIRED" }]
 * }
 * ```
 *
 * Each rule means exactly one thing: *a decision governed by this profile
 * requires human approval*. It is compiled, once, at boot, into
 * `require_approval` rules of the existing policy-pack runtime (the same
 * engine, writer attribution and Kernel mapping every embedder policy uses)
 * and the registry is then frozen. There is no `allow`, no `deny`, no
 * condition language and no other effect: a rule can only send an otherwise
 * allowed decision to the CORE-05 approval workflow, never allow, widen or
 * shape authority. It creates no approver standing (that stays Kernel
 * Authority provisioned over the operator plane) and no grant.
 */

export interface EnterpriseHostApprovalPolicyRule {
  readonly ruleId: string;
  /** The Governance Profile id (not a version): every decision governed by it requires approval. */
  readonly governanceProfile: string;
  readonly reasonCode: string;
}

export interface EnterpriseHostApprovalPolicy {
  readonly policyId: string;
  readonly rules: readonly EnterpriseHostApprovalPolicyRule[];
}

/** The NB-008 writer every compiled pack and version records: trusted configuration, never an operator or a caller. */
export const APPROVAL_POLICY_WRITER = Object.freeze({ system: true as const, actorId: 'configuration:governed-actions-file#approvalPolicy' });

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const MAX_APPROVAL_POLICY_RULES = 32;

/** A problem in the `approvalPolicy` section. The caller maps it to its own refusal. Messages name fields, never values beyond ids. */
export class ApprovalPolicyConfigurationProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalPolicyConfigurationProblem';
  }
}

function problem(message: string): never {
  throw new ApprovalPolicyConfigurationProblem(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problem(`${where} has unsupported field '${key}'. Allowed: ${allowed.join(', ')}.`);
  }
}

/** What the section is validated against: the file's profiles and the operator-plane roles it configures. */
export interface ApprovalPolicyParseContext {
  readonly governance: GovernanceConfiguration | undefined;
  /**
   * Every operator-plane role the file configures: each CTRL-02 operator's
   * role, and the CTRL-01 legacy administrator class when `administrators`
   * is declared. Judged by the canonical role policy (`operatorMay`), never a
   * role list of its own.
   */
  readonly operatorRoles: readonly OperatorRoleOrLegacy[];
}

/**
 * Validates the section against the profiles and operators the file declares,
 * so that nothing it sends to review is unresolvable from the start:
 *
 * - every rule names a declared profile, and EVERY declared version of that
 *   profile declares `approval` (CORE-05). One version per profile under the
 *   static lifecycle; under the operator-promoted lifecycle the catalog may
 *   hold several, any of which a steward can promote, and the rule matches
 *   the profile id — so a version without `approval` would turn "requires
 *   approval" into a review nothing can ever approve. Versions may declare
 *   different approval terms: CORE-05 binds each approval request to the
 *   effective version's own requirement (a request opened under one version
 *   is superseded, never reinterpreted, after another is promoted).
 * - at least one configured operator's role can reach `approval.approve`.
 *   Necessary, not sufficient: whether an approval COUNTS stays CORE-05's
 *   decision (Kernel-Authority standing for the approver action, quorum,
 *   segregation of duties). This check only refuses a deployment that is
 *   operationally deadlocked before its first request.
 */
export function parseApprovalPolicySection(value: unknown, context: ApprovalPolicyParseContext): EnterpriseHostApprovalPolicy {
  if (!isRecord(value)) problem('approvalPolicy must be an object.');
  closed(value, ['policyId', 'rules'], 'approvalPolicy');
  const policyId = value['policyId'];
  if (typeof policyId !== 'string' || !TOKEN.test(policyId)) problem('approvalPolicy.policyId must be 1-64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.');
  const rules = value['rules'];
  if (!Array.isArray(rules) || rules.length === 0) problem('approvalPolicy.rules must be a non-empty array; omit approvalPolicy to declare no approval requirement.');
  if (rules.length > MAX_APPROVAL_POLICY_RULES) problem(`approvalPolicy.rules may hold at most ${MAX_APPROVAL_POLICY_RULES} rules.`);
  if (!context.operatorRoles.some((role) => operatorMay(role, 'approval.approve'))) {
    problem(
      'approvalPolicy requires an operator with approval.approve (role approver or organization-administrator): an approval is decided by an identified operator on the operator plane, and no configured operator can decide one, so no decision it sends to review could ever be approved.',
    );
  }

  // Per profile id, every declared version that does NOT declare how it is approved.
  const declaredProfiles = new Set<string>();
  const versionsWithoutApproval = new Map<string, number[]>();
  for (const profile of context.governance?.profiles ?? []) {
    declaredProfiles.add(profile.profileId);
    if (profile.approval === undefined) versionsWithoutApproval.set(profile.profileId, [...(versionsWithoutApproval.get(profile.profileId) ?? []), profile.version]);
  }

  const ruleIds = new Set<string>();
  const profiles = new Set<string>();
  const parsed = rules.map((entry, index): EnterpriseHostApprovalPolicyRule => {
    const where = `approvalPolicy.rules[${index}]`;
    if (!isRecord(entry)) problem(`${where} must be an object.`);
    closed(entry, ['ruleId', 'governanceProfile', 'reasonCode'], where);
    const { ruleId, governanceProfile, reasonCode } = entry;
    if (typeof ruleId !== 'string' || !TOKEN.test(ruleId)) problem(`${where}.ruleId must be 1-64 lowercase letters, digits, ".", "_" or "-".`);
    if (ruleIds.has(ruleId)) problem(`${where}.ruleId '${ruleId}' is declared twice.`);
    ruleIds.add(ruleId);
    if (typeof governanceProfile !== 'string' || governanceProfile.length === 0) problem(`${where}.governanceProfile must name a Governance Profile id.`);
    if (!declaredProfiles.has(governanceProfile)) problem(`${where}.governanceProfile '${governanceProfile}' is not a profile declared in governance.profiles.`);
    const unapprovable = versionsWithoutApproval.get(governanceProfile) ?? [];
    if (unapprovable.length > 0) {
      problem(
        `${where}.governanceProfile '${governanceProfile}' version ${unapprovable.join(', ')} declares no 'approval': a decision sent to review under it could never be approved. Every declared version of a profile this policy rules must declare how it is approved (CORE-05).`,
      );
    }
    if (profiles.has(governanceProfile)) problem(`${where}.governanceProfile '${governanceProfile}' is named by two rules; one rule per profile.`);
    profiles.add(governanceProfile);
    if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) problem(`${where}.reasonCode must be 3-64 uppercase letters, digits or underscores, starting with a letter.`);
    return Object.freeze({ ruleId, governanceProfile, reasonCode });
  });
  return Object.freeze({ policyId, rules: Object.freeze(parsed) });
}

/**
 * The compiled pack's version metadata instant: the pack is configuration,
 * effective from boot, and its version record must not depend on the wall
 * clock. Only `effectiveFrom` uses it — never an evaluation, decision, proof
 * or event, which carry the live clock below.
 */
const COMPILED_AT = '1970-01-01T00:00:00.000Z';

/**
 * The live runtime context every compiled runtime runs on: the wall clock
 * and `${prefix}-${randomUUID()}` identifiers — the Host's own convention
 * (the Kernel's real clock and id generator; the durable Kernel-Authority
 * providers). Identifiers are therefore never reissued after a restart. The
 * policy-pack runtime itself stays clock- and randomness-free by design (its
 * README §Determinism): the live context is injected here, by the Host that
 * composes it.
 */
export function liveApprovalPolicyContext(): PolicyPackRuntimeContext {
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: (prefix: string) => `${prefix}-${randomUUID()}` },
  };
}

/** The pack's compiled rules: one `require_approval` per declared rule, matched on the effective profile's id. */
export function approvalPolicyRules(policy: EnterpriseHostApprovalPolicy, policyPackVersionId: string): readonly PolicyPackRule[] {
  return Object.freeze(
    policy.rules.map(
      (rule): PolicyPackRule =>
        Object.freeze<PolicyPackRule>({
          id: rule.ruleId,
          policyPackVersionId,
          name: rule.ruleId,
          description: `Decisions governed by profile '${rule.governanceProfile}' require human approval (governed-action file approvalPolicy).`,
          status: 'active',
          priority: 100,
          condition: { type: 'predicate', field: 'governanceProfile', operator: 'equals', value: rule.governanceProfile },
          effect: { type: 'require_approval', reasonCode: rule.reasonCode, reason: `Profile '${rule.governanceProfile}' requires human approval.` },
          obligations: [],
          evidenceRequirements: [],
          approvalRequirements: [],
          severity: 'error',
          sourceIds: ['governed-actions-file'],
        }),
    ),
  );
}

/**
 * One frozen policy-pack runtime holding exactly the compiled pack, scoped to
 * the Host's trust domain: registered, activated and frozen by the
 * configuration writer (NB-008), on `context`.
 */
export function compileApprovalPolicyRuntime(policy: EnterpriseHostApprovalPolicy, trustDomainId: string, context: PolicyPackRuntimeContext): PolicyPackRuntime {
  const runtime = createPolicyPackRuntime(context);
  const versionId = `${policy.policyId}@1`;
  runtime.registerPolicyPack(APPROVAL_POLICY_WRITER, {
    id: policy.policyId,
    name: policy.policyId,
    description: 'Approval requirements declared in the governed-action file (PROD-03 approvalPolicy). require_approval only.',
    kind: 'customer',
    domain: 'general_enterprise',
  });
  runtime.registerPolicyPackVersion(APPROVAL_POLICY_WRITER, {
    id: versionId,
    policyPackId: policy.policyId,
    version: '1.0.0',
    scope: { trustDomainIds: [trustDomainId] },
    rules: approvalPolicyRules(policy, versionId),
    sources: [{ id: 'governed-actions-file', type: 'customer_policy', title: 'Governed-action file approvalPolicy', authority: 'customer_provided' }],
    effectiveFrom: COMPILED_AT,
    demoOnly: false,
    legalCompleteness: 'customer_provided_policy',
  });
  runtime.activatePolicyPackVersion(APPROVAL_POLICY_WRITER, versionId);
  runtime.freeze(APPROVAL_POLICY_WRITER);
  return runtime;
}

/**
 * The Kernel's policy provider for the section.
 *
 * The Kernel needs one thing from a provider: `evaluatePolicyForEnforcement`
 * (`PolicyPackProvider`). A policy-pack runtime, however, keeps every
 * evaluation, decision, proof and ledger event it produces in memory, for
 * its lifetime — an audit trail for an embedder that reads it, and an
 * unbounded heap for a Host that never does (its durable record of every
 * decision is the governance store and ASSURE evidence). So each evaluation
 * runs on its own freshly compiled, frozen runtime — the same engine, rules,
 * writer and Kernel mapping — which is dropped with everything it recorded
 * once the result is returned. Nothing is retained between evaluations.
 * The section is compiled once here, at boot, so a pack the runtime would
 * refuse stops the Host before it serves anything.
 */
export function createApprovalPolicyPackProvider(policy: EnterpriseHostApprovalPolicy, trustDomainId: string, context: PolicyPackRuntimeContext = liveApprovalPolicyContext()): PolicyPackProvider {
  compileApprovalPolicyRuntime(policy, trustDomainId, context);
  return Object.freeze({
    evaluatePolicyForEnforcement: (input: Parameters<PolicyPackProvider['evaluatePolicyForEnforcement']>[0]) =>
      createActionEnforcementPolicyPackIntegration(compileApprovalPolicyRuntime(policy, trustDomainId, context)).evaluatePolicyForEnforcement(input),
  });
}
