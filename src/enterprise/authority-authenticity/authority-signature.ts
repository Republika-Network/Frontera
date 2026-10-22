import {
  serializeRevocationStateCommitment,
  serializeStoredGrantRecord,
  serializeStoredRevocationRecord,
  type RevocationStateCommitment,
} from '../bounded-grant-store/bounded-grant-record.js';
import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import { serializeApprovalStateCommitment, type ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import { serializeObligationDischargeStateCommitment, type ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import { serializeDelegatedOfferCapability, type DelegatedOfferCapability } from './delegated-offer-capability.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/capability.js';
import type { AuthoritySignatureAlgorithm } from './signature-envelope.js';

// The envelope's dependency-free primitives live in `signature-envelope.ts` (G-02A), so a standalone verifier can use them
// without this module's artifact serializers. Re-exported unchanged: every existing import of them keeps working.
export {
  AUTHORITY_ARTIFACT_VERSION,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  decodeAuthoritySignatureBytes,
  isSupportedAuthoritySignatureAlgorithm,
  isWellFormedAuthoritySignature,
} from './signature-envelope.js';
export type { AuthoritySignatureAlgorithm } from './signature-envelope.js';

/**
 * The signature envelope for an authority artifact, the closed algorithm
 * registry it may name, and the exact bytes a signature is taken over.
 *
 * ## The distinction this file exists to hold
 *
 * `bounded-grant-record.ts` produces an **unkeyed digest**: it proves that a
 * record's bytes are the bytes that were digested, and it proves nothing about
 * who wrote them, because anyone who can rewrite a record can recompute its
 * digest. This file produces a **digital signature**: a private key signs, a
 * public key verifies, and a party holding only the public key can check
 * authority it cannot mint.
 *
 * The two are kept side by side rather than one replacing the other. They
 * detect different things — a digest catches a partial write or a corrupted
 * page without any key being present, a signature catches a writer who
 * recomputed that digest — and collapsing them would lose the cheaper check
 * while pretending the expensive one had always been there.
 *
 * A third thing this is emphatically not: a **MAC**. An HMAC over the same
 * bytes would authenticate against a shared secret, which means every party
 * able to verify authority is also able to mint it — exactly the property the
 * bounded-grant read path must not have. The repository's existing Agent
 * Passport signer is HMAC-based (`packages/agent-governance/src/signing/`);
 * `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §10.4 records why it was
 * evaluated and deliberately not reused here.
 *
 * ## Why the signature is over the *record* envelope
 *
 * `serializeStoredGrantRecord` already binds five things at once: the record
 * format, the store and grant id the row is filed under, the store schema
 * version, and the grant's full canonical form (which itself carries `digest`,
 * computed with `digest` held empty, so there is no circularity). Signing that
 * string therefore covers every authority-relevant field *and* the identity the
 * row is filed under — a signature lifted onto a different row, or into a
 * different store, fails, not merely a signature over different field values.
 *
 * ## The third artifact: the revocation-state commitment (CORE-01)
 *
 * A grant signature and a revocation signature each prove that one record is
 * genuine. Neither proves that a genuine revocation has not been *removed*. The
 * revocation-state commitment is the artifact that does: a signed statement of
 * the whole revocation set, re-signed on every revocation and checked on every
 * read. It gets its own domain for the same reason the other two do.
 */

/**
 * Domain separation, as a literal byte prefix rather than as a property of the
 * JSON shape.
 *
 * The canonical record strings already differ — one carries `"kind":"grant"`,
 * the other `"kind":"revocation"` — so shape alone would *probably* stop a
 * grant's signature verifying as a revocation's. "Probably" is the problem: it
 * makes cross-artifact separation a consequence of two serializers happening to
 * disagree, which a later field rename could quietly remove. The prefix makes
 * it a property of the signing input itself, so the two domains cannot collide
 * even if their payloads were ever made identical.
 *
 * The trailing newline is part of the prefix: without a separator, a domain tag
 * and the payload that follows it could in principle be re-split, and a prefix
 * that can be re-split is not a domain separator.
 */
export const AUTHORITY_SIGNING_DOMAINS = {
  grant: 'frontera:authority-artifact:bounded-grant:v1\n',
  revocation: 'frontera:authority-artifact:grant-revocation:v1\n',
  revocationState: 'frontera:authority-artifact:revocation-state:v1\n',
  /** CORE-04: the signed head of an obligation discharge store — authority-material, because a verified discharge releases grant issuance. */
  obligationDischargeState: 'frontera:authority-artifact:obligation-discharge-state:v1\n',
  /** CORE-05: the signed head of an approval store — authority-material, because a completed approval resumes a withheld decision into a grant. */
  approvalState: 'frontera:authority-artifact:approval-state:v1\n',
  /** TRADE-04C-S1: a single-use authorization for one delegated XRPL OfferCreate signature, issued only for a grant this key signed (`delegated-offer-capability.ts`). */
  delegatedOfferCapability: 'frontera:authority-artifact:xrpl-delegated-offer-capability:v1\n',
  /** G-02A: a generic, single-use execution capability presented to an independent executor (`execution-capability/capability.ts`). Verified by the standalone execution-capability verifier; no signing operation exists for it before G-02B. */
  executionCapability: EXECUTION_CAPABILITY_SIGNING_DOMAIN,
} as const;

export type AuthorityArtifactKind = keyof typeof AUTHORITY_SIGNING_DOMAINS;

/**
 * The detached signature envelope.
 *
 * Four fields, all explicit, none optional, and no free-form metadata: a
 * verifier reads `algorithm` and `artifactVersion` to decide *how* to check,
 * and `keyId` to decide *what to check against*. Anything else here would be
 * input to verification that nobody had reasoned about.
 *
 * There is deliberately **no public key field**. An artifact that carried its
 * own verification key would be its own root of trust — "this is signed, by
 * whoever signed it" — which is not a security property. `keyId` is a *claim*;
 * the trusted registry decides what, if anything, that claim resolves to.
 */
export interface AuthoritySignature {
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** A claim, never a capability. Resolved against the composition-supplied registry; an id it does not hold fails closed. */
  readonly keyId: string;
  /** base64url, unpadded. */
  readonly signature: string;
  readonly artifactVersion: string;
}

/** The exact bytes a bounded grant's signature is computed and verified over. Domain-separated, and identical on both sides by construction — there is one function, not a signing copy and a verifying copy that could drift. */
export function grantSigningBytes(grant: BoundedGrant, storeId: string): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.grant}${serializeStoredGrantRecord(grant, storeId)}`, 'utf8');
}

/** The exact bytes a revocation's signature is computed and verified over. A different domain from `grantSigningBytes`, so neither artifact's signature can be replayed as the other's. */
export function revocationSigningBytes(revocation: GrantRevocation, storeId: string): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.revocation}${serializeStoredRevocationRecord(revocation, storeId)}`, 'utf8');
}

/** The exact bytes a revocation-state commitment's signature is computed and verified over. Its own domain, so no grant or revocation signature can stand in for it. */
export function revocationStateSigningBytes(state: RevocationStateCommitment): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.revocationState}${serializeRevocationStateCommitment(state)}`, 'utf8');
}

/** The exact bytes an obligation discharge store's state commitment is signed and verified over (CORE-04). Its own domain, so no grant, revocation or revocation-state signature can stand in for it. */
export function obligationDischargeStateSigningBytes(state: ObligationDischargeStateCommitment): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.obligationDischargeState}${serializeObligationDischargeStateCommitment(state)}`, 'utf8');
}

/** The exact bytes an approval store's state commitment is signed and verified over (CORE-05). Its own domain, so no other authority artifact's signature can stand in for it. */
export function approvalStateSigningBytes(state: ApprovalStateCommitment): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.approvalState}${serializeApprovalStateCommitment(state)}`, 'utf8');
}

/** The exact bytes a delegated-offer signing capability is signed and verified over (TRADE-04C-S1). Its own domain, so no grant or state signature can stand in for one, nor one for them. */
export function delegatedOfferCapabilitySigningBytes(capability: DelegatedOfferCapability): Buffer {
  return Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability}${serializeDelegatedOfferCapability(capability)}`, 'utf8');
}

/** Dispatches to the one signing-bytes function for a kind. Exhaustive by type, so a new artifact kind cannot be added without being given a domain. The execution capability (G-02A) has no Host signing path yet; its bytes are `executionCapabilitySigningBytes` (`execution-capability/capability.ts`), and it joins this dispatcher with its signing operation in G-02B. */
export function authoritySigningBytes(
  artifact:
    | { readonly kind: 'grant'; readonly grant: BoundedGrant; readonly storeId: string }
    | { readonly kind: 'revocation'; readonly revocation: GrantRevocation; readonly storeId: string }
    | { readonly kind: 'revocationState'; readonly state: RevocationStateCommitment }
    | { readonly kind: 'obligationDischargeState'; readonly state: ObligationDischargeStateCommitment }
    | { readonly kind: 'approvalState'; readonly state: ApprovalStateCommitment }
    | { readonly kind: 'delegatedOfferCapability'; readonly capability: DelegatedOfferCapability },
): Buffer {
  switch (artifact.kind) {
    case 'grant':
      return grantSigningBytes(artifact.grant, artifact.storeId);
    case 'revocation':
      return revocationSigningBytes(artifact.revocation, artifact.storeId);
    case 'revocationState':
      return revocationStateSigningBytes(artifact.state);
    case 'obligationDischargeState':
      return obligationDischargeStateSigningBytes(artifact.state);
    case 'approvalState':
      return approvalStateSigningBytes(artifact.state);
    case 'delegatedOfferCapability':
      return delegatedOfferCapabilitySigningBytes(artifact.capability);
  }
}
