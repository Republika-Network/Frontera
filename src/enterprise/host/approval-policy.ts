import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';

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

/**
 * Validates the section against the profiles the file declares. Every rule
 * names a declared profile that declares `approval` (otherwise the decision
 * would wait for an approval nothing can give), and the Host must have
 * operators (otherwise no human can act on it).
 */
export function parseApprovalPolicySection(value: unknown, context: { readonly governance: GovernanceConfiguration | undefined; readonly operatorCount: number }): EnterpriseHostApprovalPolicy {
  if (!isRecord(value)) problem('approvalPolicy must be an object.');
  closed(value, ['policyId', 'rules'], 'approvalPolicy');
  const policyId = value['policyId'];
  if (typeof policyId !== 'string' || !TOKEN.test(policyId)) problem('approvalPolicy.policyId must be 1-64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.');
  const rules = value['rules'];
  if (!Array.isArray(rules) || rules.length === 0) problem('approvalPolicy.rules must be a non-empty array; omit approvalPolicy to declare no approval requirement.');
  if (rules.length > MAX_APPROVAL_POLICY_RULES) problem(`approvalPolicy.rules may hold at most ${MAX_APPROVAL_POLICY_RULES} rules.`);
  if (context.operatorCount === 0) problem('approvalPolicy needs operators: an approval is decided by an identified operator on the operator plane, and without one no decision it sends to review could ever be approved.');

  const approvalProfiles = new Set<string>();
  const declaredProfiles = new Set<string>();
  for (const profile of context.governance?.profiles ?? []) {
    declaredProfiles.add(profile.profileId);
    if (profile.approval !== undefined) approvalProfiles.add(profile.profileId);
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
    if (!approvalProfiles.has(governanceProfile)) {
      problem(`${where}.governanceProfile '${governanceProfile}' declares no 'approval': a decision sent to review under it could never be approved. Declare how it is approved on the profile (CORE-05) first.`);
    }
    if (profiles.has(governanceProfile)) problem(`${where}.governanceProfile '${governanceProfile}' is named by two rules; one rule per profile.`);
    profiles.add(governanceProfile);
    if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) problem(`${where}.reasonCode must be 3-64 uppercase letters, digits or underscores, starting with a letter.`);
    return Object.freeze({ ruleId, governanceProfile, reasonCode });
  });
  return Object.freeze({ policyId, rules: Object.freeze(parsed) });
}

/** A fixed instant: the compiled pack is configuration, effective from boot, and its records must not depend on the wall clock. */
const COMPILED_AT = '1970-01-01T00:00:00.000Z';

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
 * Compiles the section into a frozen policy-pack runtime, scoped to the
 * Host's trust domain, and returns it as the Kernel's policy provider.
 */
export function createApprovalPolicyPackProvider(policy: EnterpriseHostApprovalPolicy, trustDomainId: string): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(COMPILED_AT));
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
  return createActionEnforcementPolicyPackIntegration(runtime);
}
