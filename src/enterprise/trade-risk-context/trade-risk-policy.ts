import type { PolicyCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { TRADE_INTENT_BINDING_FACTS, TRADE_PARAMETER_DIMENSION_IDS as D, TRADE_RISK_FACT_CLASSES as F } from '../../features/trade-runtime/index.js';
import { TRADE_RISK_MATERIAL_FACTS } from './trade-risk-context.js';

/**
 * The deployment data the trade edge needs (TRADE-03 K1): the policy rules
 * that bind every reading to the request, and the CORE-04 source
 * declarations the readings are attributed to. Data only — evaluated by the
 * one policy-pack runtime, admitted by the one Trusted Context Boundary.
 *
 * Layering (see the TRADE-03 doc §5): the material facts are the gate (the
 * Kernel denies on a missing, stale, conflicting or untrusted reading before
 * policy runs). These rules then deny unless each admitted reading equals the
 * request field it attests, and the absence rule denies again if any reading
 * is missing — defence in depth, never the only gate.
 */

/** Reason codes, one per bound field, so a committed decision says exactly which field did not match. */
const PARAMETER_REASON: Readonly<Record<string, string>> = Object.freeze({
  [D.proposalDigest]: 'TRADE_RISK_PROPOSAL_NOT_ASSESSED',
  [D.network]: 'TRADE_INTENT_NETWORK_NOT_ASSESSED',
  [D.delegateAccount]: 'TRADE_INTENT_DELEGATE_NOT_ASSESSED',
  [D.baseAsset]: 'TRADE_INTENT_BASE_ASSET_NOT_ASSESSED',
  [D.quoteAsset]: 'TRADE_INTENT_QUOTE_ASSET_NOT_ASSESSED',
  [D.side]: 'TRADE_INTENT_SIDE_NOT_ASSESSED',
  [D.quantity]: 'TRADE_INTENT_QUANTITY_NOT_ASSESSED',
});

export interface TradeRiskPolicyOptions {
  readonly policyPackVersionId: string;
  /** The trading-risk profile reference in force, `<profileId>@<version>`. */
  readonly profileReference: string;
  readonly sourceIds: readonly string[];
}

const notEqualToFact = (field: Record<string, unknown>, factClass: string): PolicyCondition => ({ type: 'predicate', ...field, operator: 'not_equals', valueFrom: { field: 'contextFact', factClass } }) as PolicyCondition;

export function tradeRiskPolicyRules(options: TradeRiskPolicyOptions): readonly PolicyPackRule[] {
  const rule = (id: string, condition: PolicyCondition, effect: PolicyPackRule['effect']): PolicyPackRule => ({
    id,
    policyPackVersionId: options.policyPackVersionId,
    name: id,
    description: effect.reason,
    status: 'active',
    priority: 100,
    condition,
    effect,
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: [...options.sourceIds],
  });
  const deny = (reasonCode: string, reason: string): PolicyPackRule['effect'] => ({ type: 'deny', reasonCode, reason });
  return Object.freeze([
    ...Object.entries(TRADE_INTENT_BINDING_FACTS).map(([dimension, factClass]) =>
      rule(`trade-binding-${dimension}`, notEqualToFact({ field: 'parameter', parameterId: dimension }, factClass), deny(PARAMETER_REASON[dimension] as string, `The request's ${dimension} differs from the assessed proposal.`)),
    ),
    rule('trade-binding-amount', notEqualToFact({ field: 'amount' }, F.assessedAmount), deny('TRADE_RISK_AMOUNT_NOT_ASSESSED', 'The governed amount differs from the assessed proposal.')),
    rule('trade-binding-asset', notEqualToFact({ field: 'currency' }, F.assessedAsset), deny('TRADE_RISK_ASSET_NOT_ASSESSED', 'The governed asset differs from the assessed proposal.')),
    rule('trade-delegation-verified', notEqualToFact({ field: 'parameter', parameterId: D.proposalDigest }, F.delegation), deny('TRADE_DELEGATION_NOT_VERIFIED', 'No reliable XLS-75 delegation for this proposal.')),
    rule('trade-risk-profile-pinned', { type: 'predicate', field: 'contextFact', factClass: F.profile, operator: 'not_equals', value: options.profileReference }, deny('TRADE_RISK_PROFILE_MISMATCH', 'The assessment relied on another risk profile version.')),
    rule('trade-risk-facts-present', { type: 'group', operator: 'any', conditions: TRADE_RISK_MATERIAL_FACTS.map((factClass) => ({ type: 'predicate', field: 'contextFact', factClass, operator: 'not_exists' }) as PolicyCondition) }, deny('TRADE_RISK_FACT_MISSING', 'A trading-risk fact is missing.')),
    rule('trade-risk-review', { type: 'predicate', field: 'contextFact', factClass: F.approvalRequired, operator: 'equals', value: true }, { type: 'require_approval', reasonCode: 'TRADE_RISK_REVIEW_REQUIRED', reason: 'The order is marked for human review.' }),
  ]);
}

/** Rules that also deny on an absent reading (`not_exists`, and `not_equals` against a literal, true on absence). */
export const TRADE_RISK_ABSENCE_SENSITIVE_RULES: ReadonlySet<string> = new Set(['trade-risk-facts-present', 'trade-risk-profile-pinned']);

export interface TradeRiskSourceDeclarationOptions {
  readonly organizationId: string;
  readonly sourceIds: { readonly risk: string; readonly delegation: string };
  /** CORE-04 bound for the risk readings (each reading also states its own, never longer than its evidence). */
  readonly riskMaxAgeSeconds: number;
  /** CORE-04 bound for the delegation reading — at most the delegation policy's `maxAgeSeconds`. */
  readonly delegationMaxAgeSeconds: number;
}

/** The two CORE-04 source declarations for the Host's `trustedContext.sources`: authoritative, organization-scoped, each attesting only its own classes. */
export function tradeRiskTrustedContextSources(options: TradeRiskSourceDeclarationOptions): readonly Record<string, unknown>[] {
  return Object.freeze([
    {
      sourceId: options.sourceIds.risk,
      kind: 'risk_engine',
      name: 'Frontera trading-risk assessment (TRADE-03)',
      trustClass: 'authoritative',
      organizationId: options.organizationId,
      attests: TRADE_RISK_MATERIAL_FACTS.filter((factClass) => factClass !== F.delegation).map((factClass) => ({ factClass, maxAgeSeconds: options.riskMaxAgeSeconds })),
    },
    {
      sourceId: options.sourceIds.delegation,
      kind: 'ledger',
      name: 'XLS-75 delegation reliance (TRADE-02)',
      trustClass: 'authoritative',
      organizationId: options.organizationId,
      attests: [{ factClass: F.delegation, maxAgeSeconds: options.delegationMaxAgeSeconds }],
    },
  ]);
}
