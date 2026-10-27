import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import type { HumanIdentityStateCommitment } from '../human-identity/chain.js';
import { isWellFormedDelegatedOfferCapability, type DelegatedOfferCapability } from './delegated-offer-capability.js';
import {
  delegatedOfferCapabilitySigningBytes,
  grantSigningBytes,
  revocationSigningBytes,
  approvalStateSigningBytes,
  obligationDischargeStateSigningBytes,
  humanIdentityStateSigningBytes,
  revocationStateSigningBytes,
  type AuthoritySignature,
} from './authority-signature.js';
import { createAuthoritySignatureRegistry, type AuthoritySignatureVerification, type TrustedVerificationKey } from './signature-verification.js';
import { executionCapabilitySigningBytes, isWellFormedExecutionCapability, type ExecutionCapability } from '../execution-capability/capability.js';

export type { AuthoritySignatureVerification, TrustedVerificationKey } from './signature-verification.js';

/**
 * The verification half of the authority-authenticity boundary, and the trusted
 * key registry it decides against.
 *
 * ## Why this is a separate interface from the signer
 *
 * Because the capability to *check* authority and the capability to *mint* it
 * are different capabilities, and the whole point of choosing an asymmetric
 * signature over a MAC was to be able to hand out one without the other. An
 * interface carrying both would put them back together at the only place it
 * matters — the type a component is allowed to depend on. The read path takes
 * this; nothing on it can reach a signer.
 *
 * Everything here operates on **public material only**. There is no code path
 * in this file that accepts, derives, holds or returns a private key, and a
 * structural test pins that.
 *
 * ## Why verification is synchronous
 *
 * Signing is `async` so an external signing boundary (deferred KMS/HSM custody) can
 * drop in without changing a call site. Verification is deliberately *not*:
 * Ed25519 verification is local, fast and needs no network, and the
 * authoritative read it runs inside is one synchronous `better-sqlite3`
 * transaction. An `async` verifier could not be called there at all, and making
 * the read transaction accommodate one would mean either verifying outside the
 * transaction — after the read that decides — or holding a write transaction
 * open across an await. Both are worse than the asymmetry.
 *
 * ## Trust comes from the registry, never from the artifact
 *
 * An artifact says `keyId = X`. This asks the registry what public key, if any,
 * this deployment trusts for X. An artifact that supplied its own key would be
 * asserting its own authenticity, which is not a property. There is no network
 * lookup, no JWKS fetch and no discovery: the registry is built once, from
 * configuration, at the composition boundary, and frozen. The registry and the
 * one verification routine live in `signature-verification.ts` (G-02A), so the
 * standalone execution-capability verifier applies exactly these rules.
 */

export interface AuthorityArtifactVerifier {
  /** Whether this grant's signature was produced, for the store named by `storeId`, over *these* canonical bytes by a key this deployment trusts. */
  verifyGrant(grant: BoundedGrant, storeId: string, signature: unknown): AuthoritySignatureVerification;
  /** The same question for a revocation, under a different signing domain, so neither artifact's signature can stand in for the other's. */
  verifyRevocation(revocation: GrantRevocation, storeId: string, signature: unknown): AuthoritySignatureVerification;
  /** The same question for a store's revocation-state commitment (CORE-01), under its own domain. */
  verifyRevocationState(state: RevocationStateCommitment, signature: unknown): AuthoritySignatureVerification;
  /** CORE-04: verifies an obligation discharge store's signed state commitment. */
  verifyObligationDischargeState(state: ObligationDischargeStateCommitment, signature: unknown): AuthoritySignatureVerification;
  /** CORE-05: verifies an approval store's signed state commitment. */
  verifyApprovalState(state: ApprovalStateCommitment, signature: unknown): AuthoritySignatureVerification;
  /**
   * TRADE-04C-S1: verifies a delegated-offer signing capability under its own domain. A capability that is not well formed is
   * refused as malformed before any key is consulted. Says nothing about expiry, consumption or what it is presented with —
   * that is the delegated signer's to check.
   */
  verifyDelegatedOfferCapability(capability: DelegatedOfferCapability, signature: unknown): AuthoritySignatureVerification;
  /**
   * G-02B: verifies a generic execution capability's signature under its own domain, over its canonical text. A capability
   * that is not well formed is refused as malformed before any key is consulted. Signature only — audience, window, binding
   * and consumption are the standalone verifier's and the executor's (`execution-capability/verifier.ts`).
   */
  verifyExecutionCapability(capability: ExecutionCapability, signature: unknown): AuthoritySignatureVerification;
  /** AUTH-03: the human identity store's signed head. */
  verifyHumanIdentityState(state: HumanIdentityStateCommitment, signature: unknown): AuthoritySignatureVerification;
  /** The key ids this verifier trusts, for composition checks and diagnostics. Ids only — never key material. */
  readonly trustedKeyIds: readonly string[];
}

export function createAuthorityArtifactVerifier(keys: readonly TrustedVerificationKey[]): AuthorityArtifactVerifier {
  const registry = createAuthoritySignatureRegistry(keys);
  const trustedKeyIds = registry.keyIds;
  // The one verification routine (`signature-verification.ts`), parameterized only by the bytes each artifact kind produces.
  const verify = registry.verify;

  return Object.freeze({
    trustedKeyIds,
    verifyGrant(grant: BoundedGrant, storeId: string, signature: unknown): AuthoritySignatureVerification {
      return verify(grantSigningBytes(grant, storeId), signature);
    },
    verifyRevocation(revocation: GrantRevocation, storeId: string, signature: unknown): AuthoritySignatureVerification {
      return verify(revocationSigningBytes(revocation, storeId), signature);
    },
    verifyRevocationState(state: RevocationStateCommitment, signature: unknown): AuthoritySignatureVerification {
      return verify(revocationStateSigningBytes(state), signature);
    },
    verifyObligationDischargeState(state: ObligationDischargeStateCommitment, signature: unknown): AuthoritySignatureVerification {
      return verify(obligationDischargeStateSigningBytes(state), signature);
    },
    verifyApprovalState(state: ApprovalStateCommitment, signature: unknown): AuthoritySignatureVerification {
      return verify(approvalStateSigningBytes(state), signature);
    },
    verifyDelegatedOfferCapability(capability: DelegatedOfferCapability, signature: unknown): AuthoritySignatureVerification {
      if (!isWellFormedDelegatedOfferCapability(capability)) return { verified: false, failure: 'AUTHORITY_SIGNATURE_MALFORMED' };
      return verify(delegatedOfferCapabilitySigningBytes(capability), signature);
    },
    verifyExecutionCapability(capability: ExecutionCapability, signature: unknown): AuthoritySignatureVerification {
      if (!isWellFormedExecutionCapability(capability)) return { verified: false, failure: 'AUTHORITY_SIGNATURE_MALFORMED' };
      return verify(executionCapabilitySigningBytes(capability), signature);
    },
    verifyHumanIdentityState(state: HumanIdentityStateCommitment, signature: unknown): AuthoritySignatureVerification {
      return verify(humanIdentityStateSigningBytes(state), signature);
    },
  });
}

/** Re-exported so a caller that holds only the verifier can still name the envelope type it passes in. */
export type { AuthoritySignature };
