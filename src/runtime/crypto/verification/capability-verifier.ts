/**
 * # This module performs NO cryptographic verification.
 *
 * It lives under a `crypto/` path and exports a `verify*` name, and neither is
 * a claim about what it does. What it actually checks is:
 *
 *   - token **shape** (`tokenId`, `expiresAt`, `proof` field presence);
 *   - **expiry**, against a caller-supplied instant;
 *   - **revocation-list membership**, against a caller-supplied `Set`;
 *   - proof **shape** — that `proofType` is a known string.
 *
 * It verifies no signature, and it cannot: the `@aoc/protocol` `CapabilityToken`
 * carries `ProofMetadata` (`proofType`/`proofRef`/`issuedAt`) with no signature
 * bytes and no verification key. `ctx.trustDomain` is accepted and deliberately
 * unused for the same reason — see the comment on that field.
 *
 * It also has **no production caller**. Do not mistake it for the same-named
 * `verifyCapabilityToken` in
 * `src/features/recognition-runtime/services/capability-token-service.ts`,
 * which takes a token *id*, resolves it against the recognition runtime's own
 * store, and *is* on the authorization path.
 *
 * Recorded as TB-003 in `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`.
 * The name is retained rather than corrected because this symbol is exported
 * from `src/index.ts`, whose emitted artifact is checksum-pinned in
 * `release/RELEASE_MANIFEST.json`; renaming is a consumer-breaking change with
 * no behavioural gain. `src/runtime/__tests__/naming-boundaries.test.ts` pins
 * the "no cryptographic primitive" property so this notice cannot go stale.
 */

import type { CapabilityToken } from '@aoc/protocol';

export interface CapabilityVerificationContext {
  /**
   * NOT CURRENTLY ENFORCED. The real @aoc/protocol `CapabilityToken` carries no
   * trust-domain-bearing claim (no `trust_domain`, and `issuer`/`resource.tenantId`
   * are not proven equivalents), so this function cannot positively verify it
   * without inventing a semantic mapping. Per the fail-closed policy for
   * unverifiable checks, this parameter is retained only to avoid a breaking
   * signature change; it is intentionally unused below. See CHANGELOG (SECURITY)
   * and the R004.A PR description for the open gap and the decision this blocks.
   */
  trustDomain: string;
  revokedJti: Set<string>;
  nowIso: string;
}

export interface VerificationResult {
  valid: boolean;
  reasonCodes: string[];
}

const KNOWN_PROOF_TYPES = new Set(['jwt', 'mTLS', 'detached-signature', 'custom']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates a CapabilityToken against the real @aoc/protocol contract fields
 * (tokenId, expiresAt, revocationRefs, proof) -- see dist/contracts/index.d.ts
 * in vendor/aoc-protocol-0.1.0.tgz. Default posture is deny -- every input
 * this function cannot positively verify returns invalid, never valid.
 */
export function verifyCapabilityToken(token: CapabilityToken, ctx: CapabilityVerificationContext): VerificationResult {
  const reasonCodes: string[] = [];

  if (!isRecord(token)) {
    return { valid: false, reasonCodes: ['token_malformed'] };
  }

  if (typeof token.tokenId !== 'string' || token.tokenId.length === 0) {
    reasonCodes.push('token_malformed');
  } else if (ctx.revokedJti.has(token.tokenId)) {
    reasonCodes.push('token_revoked');
  }

  // revocationRefs point at an out-of-band revocation source (the protocol's
  // RevocationLookup port), which Enterprise does not wire up anywhere. Refs
  // this function cannot resolve are indeterminate, not clear -- fail closed.
  if (Array.isArray(token.revocationRefs) && token.revocationRefs.length > 0) {
    const hasUnresolvedRef = token.revocationRefs.some(
      (ref) => typeof ref !== 'string' || !ctx.revokedJti.has(ref),
    );
    if (hasUnresolvedRef) reasonCodes.push('revocation_status_indeterminate');
  }

  const nowMs = Date.parse(ctx.nowIso);
  const expiresAtMs = typeof token.expiresAt === 'string' ? Date.parse(token.expiresAt) : Number.NaN;
  if (Number.isNaN(nowMs) || Number.isNaN(expiresAtMs)) {
    reasonCodes.push('token_malformed');
  } else if (nowMs >= expiresAtMs) {
    reasonCodes.push('token_expired');
  }

  // No cryptographic signature bytes or verification key exist on this
  // contract (ProofMetadata is proofType/proofRef/issuedAt only), so this can
  // only check proof *shape*, not cryptographic integrity -- see the open gap
  // recorded in the R004.A PR description.
  const proof = token.proof;
  if (!isRecord(proof) || typeof proof.proofType !== 'string' || !KNOWN_PROOF_TYPES.has(proof.proofType)) {
    reasonCodes.push('token_malformed');
  } else if (proof.proofType !== 'custom' && (typeof proof.proofRef !== 'string' || proof.proofRef.length === 0)) {
    reasonCodes.push('proof_unverifiable');
  }

  return { valid: reasonCodes.length === 0, reasonCodes };
}
