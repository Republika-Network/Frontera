import { createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError } from './errors.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  grantSigningBytes,
  isSupportedAuthoritySignatureAlgorithm,
  revocationSigningBytes,
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
 * through the three methods below, and all are **domain-aware**: they take an
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
 * `Promise`-returning anyway so that deferred external key custody can replace
 * the implementation below with a KMS/HSM call without changing a single call site, and — more
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
 * as **AA-001** in `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §21, and
 * the exact residual risk that deferred external key custody must close.
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
}

export interface SoftwareAuthorityArtifactSignerOptions {
  readonly keyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** PKCS#8 PEM. Accepted **only** here: no other component in this module takes a private key, and none returns one. */
  readonly privateKeyPem: string;
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

  return Object.freeze({
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
  });
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
