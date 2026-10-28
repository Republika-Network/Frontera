import type { SovereignAssetEligibilityDecision, SovereignAssetEligibilityInput, SovereignAssetEligibilityPolicy } from './contracts.js';

/**
 * RSDK-02B — a **demonstration** eligibility policy for the synthetic
 * operation. Not a production authorization policy, and not exported from
 * the module index.
 *
 * Test-only assumption: the stored bundle is the asset's current
 * representation. Nothing here, or in RSDK-01, observes freshness or
 * revocation, so a bundle that omits a newer withdrawal still reads `active`.
 *
 * Eligible only when every rule holds:
 *
 * - the action is one this policy declares;
 * - the current manifest's state is `active` (never `disputed`, `withdrawn`
 *   or anything else);
 * - the verified registrant is one this policy trusts, and every manifest
 *   version names that same registrant;
 * - every claim is of a type the operation declares it consumes, and is
 *   issued by the registrant or by an issuer this operation explicitly trusts;
 * - every claim type the operation requires is present among those claims.
 *
 * Unsigned standings are never consulted: they neither grant nor block.
 */

export interface DemonstrationOperationRule {
  /** Claim types the operation consumes. A claim of any other type makes the asset ineligible. */
  readonly claimTypes: readonly string[];
  /** Claim types that must be present (a subset of `claimTypes`). */
  readonly requiredClaimTypes: readonly string[];
  /** Issuers other than the registrant whose claims this operation deliberately accepts. */
  readonly trustedClaimIssuers?: readonly string[];
}

export interface DemonstrationAssetPolicyOptions {
  readonly trustedRegistrants: readonly string[];
  readonly operations: Readonly<Record<string, DemonstrationOperationRule>>;
}

const ineligible = (reason: string): SovereignAssetEligibilityDecision => Object.freeze({ decision: 'ineligible' as const, reason });

export function createDemonstrationAssetPolicy(options: DemonstrationAssetPolicyOptions): SovereignAssetEligibilityPolicy {
  const trustedRegistrants = Object.freeze([...options.trustedRegistrants]);
  const operations = new Map<string, { readonly claimTypes: readonly string[]; readonly requiredClaimTypes: readonly string[]; readonly trustedClaimIssuers: readonly string[] }>();
  for (const [action, rule] of Object.entries(options.operations)) {
    const claimTypes = Object.freeze([...rule.claimTypes]);
    const requiredClaimTypes = Object.freeze([...rule.requiredClaimTypes]);
    if (!requiredClaimTypes.every((type) => claimTypes.includes(type))) throw new Error(`Operation '${action}' requires a claim type it does not consume.`);
    operations.set(action, Object.freeze({ claimTypes, requiredClaimTypes, trustedClaimIssuers: Object.freeze([...(rule.trustedClaimIssuers ?? [])]) }));
  }

  return (input: SovereignAssetEligibilityInput): SovereignAssetEligibilityDecision => {
    const rule = operations.get(input.action);
    if (rule === undefined) return ineligible('OPERATION_NOT_COVERED');
    const { asset } = input;
    if (asset.sovereignAssetId !== input.resource) return ineligible('ASSET_IDENTITY_MISMATCH');
    if (asset.currentState !== 'active') return ineligible('STATE_NOT_ACTIVE');
    if (!trustedRegistrants.includes(asset.currentIssuer)) return ineligible('REGISTRANT_NOT_TRUSTED');
    if (!asset.manifests.every((manifest) => manifest.issuer === asset.currentIssuer)) return ineligible('REGISTRANT_DISCONTINUOUS');
    for (const claim of asset.claims) {
      if (!rule.claimTypes.includes(claim.claimType)) return ineligible('CLAIM_TYPE_NOT_CONSUMED');
      if (claim.issuer !== asset.currentIssuer && !rule.trustedClaimIssuers.includes(claim.issuer)) return ineligible('FOREIGN_CLAIM');
    }
    for (const required of rule.requiredClaimTypes) {
      if (!asset.claims.some((claim) => claim.claimType === required)) return ineligible('REQUIRED_CLAIM_MISSING');
    }
    return Object.freeze({ decision: 'eligible' as const });
  };
}
