import { randomUUID } from 'node:crypto';

import type { ContextResolverPort } from '../../features/context-resolution-runtime/index.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { TRADE_INTENT_BINDING_FACTS } from '../../features/trade-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { tradeRiskContextCompositionOf, type TradeAttestedProposalSource, type TradeRiskContext } from './trade-risk-context.js';
import { tradeRiskPolicyRules } from './trade-risk-policy.js';

/**
 * R8 — the one policy provider a Host that executes trades may compose
 * (TRADE-04C, after the PROD-03 integration).
 *
 * TRADE-03's controls that decide *whether* an assessed order may proceed —
 * human review when the assessment marks the order for it, the exact binding
 * of every governed field to the assessed proposal, the verified delegation,
 * the pinned profile and the presence of every material fact — are
 * policy-pack rules (`tradeRiskPolicyRules`). The Kernel's policy port is
 * opaque, so a Host cannot inspect an arbitrary provider for them; before
 * this file a trade Host accepted any provider (or a PROD-03 `approvalPolicy`
 * for another profile) and an order TRADE-03 marked for review executed with
 * no human approval.
 *
 * This factory is therefore the only source of a provider the Host accepts:
 *
 * - it binds to a **genuine** TRADE-03 edge (one `createTradeRiskContext`
 *   produced; recorded in that module's private registry) and reads the
 *   edge's pinned profile reference, action, network and owners from it —
 *   never from its caller;
 * - it compiles exactly `tradeRiskPolicyRules` (the existing TRADE-03
 *   definitions, no second interpretation) and checks the compiled set is
 *   the mandatory one — no rule can be added, dropped or replaced;
 * - the rules are frozen data captured at construction; each evaluation runs
 *   on a freshly compiled, frozen runtime (as PROD-03's provider does), so
 *   nothing can be mutated between evaluations;
 * - the provider is a frozen object, and its provenance is recorded in this
 *   module's private registry keyed by **that object**: a wrapper, a copy or
 *   a look-alike is a different object and carries no provenance.
 *
 * The Host verifies the provenance of the exact object it hands the Kernel,
 * and that it is bound to the same edge whose readings and attestations the
 * Host composes, for the configured action, trust domain and every
 * configured owner (`enterprise-host.ts`, `assertTradePolicyComposed`).
 * Additional rules are not accepted in this milestone.
 */

/** The mandatory TRADE-03 rule ids, stated independently of the rule builder. */
export const TRADE_RISK_MANDATORY_POLICY_RULE_IDS: readonly string[] = Object.freeze(
  [
    ...Object.keys(TRADE_INTENT_BINDING_FACTS).map((dimension) => `trade-binding-${dimension}`),
    'trade-binding-amount',
    'trade-binding-asset',
    'trade-delegation-verified',
    'trade-risk-profile-pinned',
    'trade-risk-facts-present',
    'trade-risk-review',
  ].sort(),
);

/** What each mandatory rule must do: the review rule sends the decision to CORE-05 approval; every other one denies. */
export const TRADE_RISK_MANDATORY_POLICY_EFFECTS: Readonly<Record<string, 'deny' | 'require_approval'>> = Object.freeze(
  Object.fromEntries(TRADE_RISK_MANDATORY_POLICY_RULE_IDS.map((id) => [id, id === 'trade-risk-review' ? ('require_approval' as const) : ('deny' as const)])),
);

export const TRADE_RISK_POLICY_PACK_ID = 'trade-risk-policy';

/** NB-008 writer of the compiled pack: trusted composition, never an operator or a caller. */
export const TRADE_RISK_POLICY_WRITER = Object.freeze({ system: true as const, actorId: 'composition:trade-risk-context#policy' });

const COMPILED_AT = '1970-01-01T00:00:00.000Z';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export interface TradeRiskPolicyProvenance {
  readonly edge: TradeRiskContext;
  readonly organizationId: string;
  readonly trustDomainId: string;
  readonly action: string;
  readonly profileReference: string;
  /** `<network>:<owner>` for every owner the edge's profile pins — the pack's resource scope. */
  readonly resourceScopes: readonly string[];
  /** The compiled rule ids, sorted: always `TRADE_RISK_MANDATORY_POLICY_RULE_IDS`. */
  readonly ruleIds: readonly string[];
  /** The edge's CORE-04 provider and attestation source: the Host composes exactly these. */
  readonly contextProvider: ContextResolverPort;
  readonly attested: TradeAttestedProposalSource;
}

export class TradeRiskPolicyProviderError extends Error {
  readonly code = 'TRADE_RISK_POLICY_PROVIDER_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TradeRiskPolicyProviderError';
  }
}

const PROVENANCE = new WeakMap<object, TradeRiskPolicyProvenance>();

/** The provenance of a provider `createTradeRiskPolicyPackProvider` produced — of that exact object — or `undefined`. */
export function tradeRiskPolicyProvenanceOf(provider: unknown): TradeRiskPolicyProvenance | undefined {
  return typeof provider === 'object' && provider !== null ? PROVENANCE.get(provider) : undefined;
}

function liveContext(): PolicyPackRuntimeContext {
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: (prefix: string) => `${prefix}-${randomUUID()}` },
  };
}

function compile(rules: readonly PolicyPackRule[], versionId: string, scope: { readonly trustDomainId: string; readonly action: string; readonly resourceScopes: readonly string[] }, profileReference: string): PolicyPackRuntime {
  const runtime = createPolicyPackRuntime(liveContext());
  runtime.registerPolicyPack(TRADE_RISK_POLICY_WRITER, {
    id: TRADE_RISK_POLICY_PACK_ID,
    name: 'TRADE-03 trading-risk policy',
    description: 'The mandatory TRADE-03 controls: review when marked, exact proposal binding, verified delegation, pinned profile, every material fact.',
    kind: 'risk',
    domain: 'financial_approval',
  });
  runtime.registerPolicyPackVersion(TRADE_RISK_POLICY_WRITER, {
    id: versionId,
    policyPackId: TRADE_RISK_POLICY_PACK_ID,
    version: '1.0.0',
    scope: { trustDomainIds: [scope.trustDomainId], actions: [scope.action], resourceScopes: [...scope.resourceScopes] },
    rules,
    sources: [{ id: 'trade-risk-profile', type: 'internal_control', title: `Trading-risk profile ${profileReference}`, description: 'The pinned TRADE-03 trading-risk profile.', authority: 'customer_provided' }],
    effectiveFrom: COMPILED_AT,
    demoOnly: false,
    legalCompleteness: 'customer_provided_policy',
  });
  runtime.activatePolicyPackVersion(TRADE_RISK_POLICY_WRITER, versionId);
  runtime.freeze(TRADE_RISK_POLICY_WRITER);
  return runtime;
}

/**
 * The trade Host's policy provider, bound to `edge`. Refuses an edge it did not see composed, an invalid trust
 * domain, or a compiled rule set that is not exactly the mandatory one.
 */
export function createTradeRiskPolicyPackProvider(edge: TradeRiskContext, options: { readonly trustDomainId: string }): PolicyPackProvider {
  const composition = tradeRiskContextCompositionOf(edge);
  if (composition === undefined) throw new TradeRiskPolicyProviderError('The trade policy binds only to a trade risk context createTradeRiskContext composed.');
  const trustDomainId = options?.trustDomainId;
  if (typeof trustDomainId !== 'string' || !IDENTIFIER.test(trustDomainId)) throw new TradeRiskPolicyProviderError('trustDomainId must be an identifier.');
  const versionId = `${TRADE_RISK_POLICY_PACK_ID}@${composition.profileReference}`;
  const rules = Object.freeze(tradeRiskPolicyRules({ policyPackVersionId: versionId, profileReference: composition.profileReference, sourceIds: ['trade-risk-profile'] }).map((rule) => Object.freeze({ ...rule })));
  const ruleIds = Object.freeze(rules.map((rule) => rule.id).sort());
  if (JSON.stringify(ruleIds) !== JSON.stringify(TRADE_RISK_MANDATORY_POLICY_RULE_IDS)) throw new TradeRiskPolicyProviderError('The compiled trade policy is not exactly the mandatory TRADE-03 rule set.');
  for (const rule of rules) {
    if (rule.status !== 'active' || rule.effect.type !== TRADE_RISK_MANDATORY_POLICY_EFFECTS[rule.id]) throw new TradeRiskPolicyProviderError(`The compiled trade policy rule ${rule.id} does not have its mandatory effect.`);
  }
  const resourceScopes = Object.freeze([...new Set(composition.ownerAccounts.map((owner) => `${composition.network}:${owner}`))].sort());
  const scope = Object.freeze({ trustDomainId, action: composition.action, resourceScopes });
  // Compiled once here so a pack the runtime would refuse stops composition; then once per evaluation (nothing retained).
  compile(rules, versionId, scope, composition.profileReference);
  const provider: PolicyPackProvider = Object.freeze({
    evaluatePolicyForEnforcement: (input: Parameters<PolicyPackProvider['evaluatePolicyForEnforcement']>[0]) =>
      createActionEnforcementPolicyPackIntegration(compile(rules, versionId, scope, composition.profileReference)).evaluatePolicyForEnforcement(input),
  });
  PROVENANCE.set(
    provider,
    Object.freeze({
      edge,
      organizationId: composition.organizationId,
      trustDomainId,
      action: composition.action,
      profileReference: composition.profileReference,
      resourceScopes,
      ruleIds,
      contextProvider: composition.provider,
      attested: composition.attested,
    }),
  );
  return provider;
}
