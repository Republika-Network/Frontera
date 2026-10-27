import { createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import type { HumanIdentityStateCommitment } from '../human-identity/chain.js';
import { registerAuthoritySignerCustody } from './custody.js';
import { assessDelegatedOfferCapabilityIssuance, type DelegatedOfferCapabilityIssuanceRequest } from './delegated-offer-capability.js';
import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError } from './errors.js';
import {
  ExecutionCapabilityPolicyError,
  assessExecutionCapabilityIssuance,
  createExecutionCapabilityIssuancePolicy,
  type ExecutionCapabilityIssuancePolicy,
  type ExecutionCapabilityIssuanceRequest,
} from './execution-capability-issuance.js';
import { executionCapabilitySigningBytes } from '../execution-capability/capability.js';
import { createAuthorityArtifactVerifier } from './verifier.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  delegatedOfferCapabilitySigningBytes,
  grantSigningBytes,
  isSupportedAuthoritySignatureAlgorithm,
  revocationSigningBytes,
  approvalStateSigningBytes,
  humanIdentityStateSigningBytes,
  obligationDischargeStateSigningBytes,
  revocationStateSigningBytes,
  type AuthoritySignature,
  type AuthoritySignatureAlgorithm,
} from './authority-signature.js';

/**
 * The signing half of the authority-authenticity boundary.
 *
 * ## The interface is the boundary
 *
 * Everything a deployment can do with the authority signing key, it does
 * through the five methods below, and all are **domain-aware**: they take an
 * artifact and produce that artifact's signature. There is deliberately no
 * `sign(bytes)`. A generic byte-signing capability would let any holder produce
 * a signature over bytes of its own choosing, which for a key whose whole
 * meaning is "this artifact is authoritative" is the ability to mint authority
 * in a shape this file has never seen. Least authority applies to a crypto API
 * exactly as it applies to a store port: the caller gets the operation it
 * needs, not the primitive underneath it.
 *
 * ## Asynchronous on purpose
 *
 * Nothing about Ed25519 in-process needs to be `async`. The signature is
 * `Promise`-returning anyway so that external key custody (CORE-02,
 * `src/enterprise/external-authority-signer/`) replaces the implementation
 * below with a call across a custody boundary without changing a single call site, and — more
 * importantly — so that every caller is *already written* to tolerate a signer
 * that takes time. That is what makes the ordering in the durable store safe to
 * keep: signing happens **before** the transaction opens, and the commit guard
 * re-checks eligibility **after** signing, immediately before the commit.
 * A caller that assumed signing was instant would have hidden that race.
 *
 * ## What this is not
 *
 * `createSoftwareAuthorityArtifactSigner` is named for what it is. It holds a
 * private key **in application process memory**, loaded from configuration.
 * That is not a hardware boundary, not a KMS, not an HSM, and nothing in this
 * repository may describe it as one. Anything that can read this process's
 * memory can read the key and mint authority that verifies perfectly — recorded
 * as **AA-001** in `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §21. It
 * remains an explicit, supported mode (development, embedding, tests, and any
 * deployment that chooses it); a deployment configured for external custody
 * never constructs it and never falls back to it (CORE-02, §29).
 *
 * What it *does* buy, today, is the property unkeyed digests alone could not: a writer
 * with access to the database file — a DBA, a backup, a restored snapshot, a
 * replica — can rewrite a record and recompute every unkeyed digest, and still
 * cannot produce authority the read path will accept.
 */

export interface AuthorityArtifactSigner {
  /** The key new artifacts are signed with. Historical artifacts keep whatever key id signed them; see the rotation model in §13 of the security document. */
  readonly activeKeyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** Signs a grant as filed in the store named by `storeId`. */
  signGrant(grant: BoundedGrant, storeId: string): Promise<AuthoritySignature>;
  /** Signs a revocation as filed in the store named by `storeId`. */
  signRevocation(revocation: GrantRevocation, storeId: string): Promise<AuthoritySignature>;
  /**
   * Signs a store's whole revocation state (CORE-01). This is the statement a
   * read relies on to know that no revocation has been removed, so it is signed
   * by the same authority key and under its own domain — and, like the other
   * two, it takes a structured artifact, never bytes.
   */
  signRevocationState(state: RevocationStateCommitment): Promise<AuthoritySignature>;
  /**
   * Signs an obligation discharge store's state commitment (CORE-04). A
   * verified discharge releases grant issuance, so the discharge log's head is
   * an authority artifact like a revocation state: same key, its own domain,
   * a structured artifact — never bytes.
   */
  signObligationDischargeState(state: ObligationDischargeStateCommitment): Promise<AuthoritySignature>;
  /**
   * Signs an approval store's state commitment (CORE-05). A completed approval
   * resumes a withheld decision into a grant, so the approval log's head is an
   * authority artifact: same key, its own domain, a structured artifact.
   */
  signApprovalState(state: ApprovalStateCommitment): Promise<AuthoritySignature>;
  /**
   * TRADE-04C-S1: signs a delegated-offer signing capability — **only** after
   * `assessDelegatedOfferCapabilityIssuance` accepts it inside this custody
   * boundary: the presented grant must verify under this signer's own key and
   * name exactly what the capability binds. Optional, because it is an
   * extension: a custody boundary that does not offer it leaves the delegated
   * signer unauthorizable, and the trade executor refuses before signing.
   * Rejects with `AuthoritySigningUnavailableError` (`EXTERNAL_SIGNER_REFUSED`)
   * when the assessment refuses.
   */
  signDelegatedOfferCapability?(request: DelegatedOfferCapabilityIssuanceRequest): Promise<AuthoritySignature>;
  /**
   * G-02B: signs a generic execution capability — **only** after
   * `assessExecutionCapabilityIssuance` accepts it inside this custody
   * boundary, against the boundary's **own** policy (issuer, organization,
   * trust domain, lifetime, audience registry): the presented grant must
   * verify under this signer's own key, the execution must be the one derived
   * from that grant, and the capability must name exactly what the grant and
   * the policy allow. Signs `executionCapabilitySigningBytes` of the frozen
   * canonical record the rule accepted — never text as presented. Optional:
   * present only on a signer configured with an issuance policy. Rejects with
   * `AuthoritySigningUnavailableError` (`EXTERNAL_SIGNER_REFUSED`) when the
   * rule refuses.
   */
  signExecutionCapability?(request: ExecutionCapabilityIssuanceRequest): Promise<AuthoritySignature>;
  /**
   * AUTH-03: signs the human identity store's state commitment
   * `{storeId, organizationId, sequence, chainDigest}` — the head of an
   * authority-material store (its registered passkeys can authorize CORE-05
   * verdicts), exactly as `signApprovalState` signs the approval log's head.
   * A store-state commitment only: never a passport, credential or identity
   * assertion (TD-5, narrowed by the founder for AUTH-03). Optional, because
   * it is an extension: a custody boundary that does not offer it (the
   * external signer, until its protocol carries it) leaves the human identity
   * store unopenable — it never falls back to an unsigned mode.
   */
  signHumanIdentityState?(state: HumanIdentityStateCommitment): Promise<AuthoritySignature>;
}

export interface SoftwareAuthorityArtifactSignerOptions {
  readonly keyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** PKCS#8 PEM. Accepted **only** here: no other component in this module takes a private key, and none returns one. */
  readonly privateKeyPem: string;
  /** The clock the capability issuance rule reads (ms since the epoch). Defaults to `Date.now`. For tests. */
  readonly now?: () => number;
  /**
   * G-02B: this custody boundary's own execution-capability issuance policy
   * (`createExecutionCapabilityIssuancePolicy`). Absent: the signer offers no
   * `signExecutionCapability`. Present: validated and frozen here, once.
   */
  readonly executionCapabilityIssuance?: unknown;
}

/**
 * A software signer holding a process-resident private key.
 *
 * The key is parsed once into a `KeyObject` held in this closure. It is never
 * returned, never placed on the object below, never serialized into a record,
 * never included in an error message and never logged — the failure paths here
 * deliberately discard the underlying error rather than propagate one that
 * could quote the material it failed to parse.
 */
export function createSoftwareAuthorityArtifactSigner(options: SoftwareAuthorityArtifactSignerOptions): AuthorityArtifactSigner {
  const { keyId, algorithm } = options;

  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new AuthorityAuthenticityConfigurationError('The authority signing key was configured without a key id.');
  }
  if (!isSupportedAuthoritySignatureAlgorithm(algorithm)) {
    throw new AuthorityAuthenticityConfigurationError(
      `The authority signing key '${keyId}' names algorithm '${String(algorithm)}', which is outside the supported registry.`,
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(options.privateKeyPem);
  } catch {
    throw new AuthorityAuthenticityConfigurationError(`The authority signing key '${keyId}' could not be parsed as a private key.`);
  }
  if (privateKey.type !== 'private') {
    throw new AuthorityAuthenticityConfigurationError(`The authority signing key '${keyId}' is not a private key.`);
  }
  if (privateKey.asymmetricKeyType !== SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS[algorithm].keyType) {
    throw new AuthorityAuthenticityConfigurationError(
      `The authority signing key '${keyId}' is configured under algorithm '${algorithm}' but its material is '${String(privateKey.asymmetricKeyType)}'.`,
    );
  }

  function signBytes(signingBytes: Buffer): AuthoritySignature {
    let signature: Buffer;
    try {
      signature = cryptoSign(null, signingBytes, privateKey);
    } catch {
      // Deliberately opaque. A signing failure is an availability event, and an
      // error that quoted the payload would hand a caller the canonical bytes a
      // forgery would need to be produced over.
      throw new AuthoritySigningUnavailableError(`The authority signing key '${keyId}' could not produce a signature.`);
    }
    return { algorithm, keyId, signature: signature.toString('base64url'), artifactVersion: AUTHORITY_ARTIFACT_VERSION };
  }

  // The issuance rule verifies a presented grant under this key alone: never a registry the request could influence.
  const ownVerifier = createAuthorityArtifactVerifier([{ keyId, algorithm, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() }]);
  const now = options.now ?? Date.now;
  let executionPolicy: ExecutionCapabilityIssuancePolicy | undefined;
  if (options.executionCapabilityIssuance !== undefined) {
    try {
      executionPolicy = createExecutionCapabilityIssuancePolicy(options.executionCapabilityIssuance);
    } catch (error) {
      throw new AuthorityAuthenticityConfigurationError(`The authority signing key '${keyId}' was given an invalid execution capability issuance policy: ${error instanceof ExecutionCapabilityPolicyError ? error.message : 'not a policy'}`);
    }
  }

  const signer: AuthorityArtifactSigner = Object.freeze({
    activeKeyId: keyId,
    algorithm,
    async signGrant(grant: BoundedGrant, storeId: string): Promise<AuthoritySignature> {
      return signBytes(grantSigningBytes(grant, storeId));
    },
    async signRevocation(revocation: GrantRevocation, storeId: string): Promise<AuthoritySignature> {
      return signBytes(revocationSigningBytes(revocation, storeId));
    },
    async signRevocationState(state: RevocationStateCommitment): Promise<AuthoritySignature> {
      return signBytes(revocationStateSigningBytes(state));
    },
    async signObligationDischargeState(state: ObligationDischargeStateCommitment): Promise<AuthoritySignature> {
      return signBytes(obligationDischargeStateSigningBytes(state));
    },
    async signApprovalState(state: ApprovalStateCommitment): Promise<AuthoritySignature> {
      return signBytes(approvalStateSigningBytes(state));
    },
    async signHumanIdentityState(state: HumanIdentityStateCommitment): Promise<AuthoritySignature> {
      return signBytes(humanIdentityStateSigningBytes(state));
    },
    async signDelegatedOfferCapability(request: DelegatedOfferCapabilityIssuanceRequest): Promise<AuthoritySignature> {
      const assessment = assessDelegatedOfferCapabilityIssuance(request, { verifyGrant: (grant, storeId, signature) => ownVerifier.verifyGrant(grant, storeId, signature), activeKeyId: keyId, now: now() });
      if (!assessment.issuable) throw new AuthoritySigningUnavailableError(`The authority signing key '${keyId}' refused the delegated-offer capability (${assessment.failure}).`, 'EXTERNAL_SIGNER_REFUSED');
      return signBytes(delegatedOfferCapabilitySigningBytes(request.capability));
    },
    // G-02B: present only when this boundary was configured with its own issuance policy.
    ...(executionPolicy !== undefined
      ? {
          async signExecutionCapability(request: ExecutionCapabilityIssuanceRequest): Promise<AuthoritySignature> {
            const policy = executionPolicy as ExecutionCapabilityIssuancePolicy;
            const ruling = assessExecutionCapabilityIssuance(request, { verifyGrant: (grant, storeId, signature) => ownVerifier.verifyGrant(grant, storeId, signature), activeKeyId: keyId, policy, now: now() });
            if (!ruling.issuable) throw new AuthoritySigningUnavailableError(`The authority signing key '${keyId}' refused the execution capability (${ruling.failure}).`, 'EXTERNAL_SIGNER_REFUSED');
            // The frozen canonical record the rule accepted, under the G-02A domain: never the text as presented.
            return signBytes(executionCapabilitySigningBytes(ruling.capability));
          },
        }
      : {}),
  });
  registerAuthoritySignerCustody(signer, 'software');
  return signer;
}

/**
 * The public verification material for a software signing key, so a deployment
 * can derive what belongs in the trusted registry from what it configured as
 * the signing key.
 *
 * Takes the private key and returns **only** the public half. It exists so that
 * "the active signing key must be in the verification registry" is checkable
 * without a deployment having to hand-maintain two halves of one key pair and
 * get them to match; it is not a way to move private material anywhere.
 */
export function authorityVerificationKeyFromPrivateKey(privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new AuthorityAuthenticityConfigurationError('The authority signing key could not be parsed as a private key.');
  }
  return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}
