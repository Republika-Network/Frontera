import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import { AuthorityAuthenticityConfigurationError, type AuthoritySignatureFailure } from './errors.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  decodeAuthoritySignatureBytes,
  grantSigningBytes,
  isSupportedAuthoritySignatureAlgorithm,
  isWellFormedAuthoritySignature,
  revocationSigningBytes,
  type AuthoritySignature,
  type AuthoritySignatureAlgorithm,
} from './authority-signature.js';

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
 * configuration, at the composition boundary, and frozen.
 */

/** One trusted verification key, as a deployment configures it. Public material only — there is no field here a private key could be placed in. */
export interface TrustedVerificationKey {
  readonly keyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** SPKI PEM. A public key; never a private key, and rejected at composition if it is one. */
  readonly publicKeyPem: string;
}

export type AuthoritySignatureVerification =
  | { readonly verified: true; readonly keyId: string; readonly algorithm: AuthoritySignatureAlgorithm }
  | { readonly verified: false; readonly failure: AuthoritySignatureFailure };

export interface AuthorityArtifactVerifier {
  /** Whether this grant's signature was produced over *these* canonical bytes by a key this deployment trusts. */
  verifyGrant(grant: BoundedGrant, signature: unknown): AuthoritySignatureVerification;
  /** The same question for a revocation, under a different signing domain, so neither artifact's signature can stand in for the other's. */
  verifyRevocation(revocation: GrantRevocation, signature: unknown): AuthoritySignatureVerification;
  /** The key ids this verifier trusts, for composition checks and diagnostics. Ids only — never key material. */
  readonly trustedKeyIds: readonly string[];
}

interface RegisteredKey {
  readonly algorithm: AuthoritySignatureAlgorithm;
  readonly key: KeyObject;
}

/**
 * Builds the trusted registry, refusing every shape that would make trust
 * ambiguous.
 *
 * A duplicate key id is refused rather than resolved by last-wins or
 * first-wins: two conflicting public keys under one id means an artifact's
 * `keyId` no longer names one key, and silently picking either would make which
 * one a matter of configuration order. An empty registry is refused too — a
 * verifier that trusts nothing would fail every read closed, which is safe, but
 * it is a misconfiguration and it is better found at startup than at the first
 * exercise.
 */
function buildRegistry(keys: readonly TrustedVerificationKey[]): ReadonlyMap<string, RegisteredKey> {
  if (keys.length === 0) {
    throw new AuthorityAuthenticityConfigurationError(
      'No trusted authority verification keys were configured. A durable authority store without a verification key would refuse every read; configure at least one key.',
    );
  }

  const registry = new Map<string, RegisteredKey>();
  for (const entry of keys) {
    if (typeof entry.keyId !== 'string' || entry.keyId.length === 0) {
      throw new AuthorityAuthenticityConfigurationError('A trusted authority verification key was configured without a key id.');
    }
    if (registry.has(entry.keyId)) {
      throw new AuthorityAuthenticityConfigurationError(
        `Duplicate trusted authority verification key id '${entry.keyId}'. A key id must name exactly one key; refusing to choose between conflicting entries.`,
      );
    }
    if (!isSupportedAuthoritySignatureAlgorithm(entry.algorithm)) {
      throw new AuthorityAuthenticityConfigurationError(
        `Trusted authority verification key '${entry.keyId}' names algorithm '${String(entry.algorithm)}', which is outside the supported registry.`,
      );
    }

    // Checked on the PEM text, before `createPublicKey` ever sees it.
    //
    // `createPublicKey` accepts a *private* key and silently derives the public
    // half from it, so a deployment that pasted the wrong half into the trusted
    // set would work perfectly and never be told. That matters more than it
    // looks: `verificationKeys` is public-by-construction and is exposed on
    // `PublicEnterpriseConfiguration`, so the successful case would publish a
    // private authority signing key on a surface designed to be safe to show.
    // The refusal is here rather than after parsing because after parsing the
    // evidence is gone — a derived public key is indistinguishable from one
    // that was configured directly.
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(entry.publicKeyPem)) {
      throw new AuthorityAuthenticityConfigurationError(
        `Trusted authority verification key '${entry.keyId}' was supplied as a private key. The verification registry holds public material only.`,
      );
    }

    let key: KeyObject;
    try {
      key = createPublicKey(entry.publicKeyPem);
    } catch {
      // The underlying error is not propagated: it can quote the material it
      // failed to parse, and a configuration error is not a place to echo key
      // bytes into a log.
      throw new AuthorityAuthenticityConfigurationError(`Trusted authority verification key '${entry.keyId}' could not be parsed as a public key.`);
    }
    if (key.type !== 'public') {
      throw new AuthorityAuthenticityConfigurationError(`Trusted authority verification key '${entry.keyId}' is not a public key.`);
    }
    if (key.asymmetricKeyType !== SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS[entry.algorithm].keyType) {
      throw new AuthorityAuthenticityConfigurationError(
        `Trusted authority verification key '${entry.keyId}' is registered under algorithm '${entry.algorithm}' but its material is '${String(key.asymmetricKeyType)}'.`,
      );
    }
    registry.set(entry.keyId, { algorithm: entry.algorithm, key });
  }
  return registry;
}

export function createAuthorityArtifactVerifier(keys: readonly TrustedVerificationKey[]): AuthorityArtifactVerifier {
  const registry = buildRegistry(keys);
  const trustedKeyIds = Object.freeze([...registry.keys()]);

  /**
   * The one verification routine, parameterized only by the bytes the caller's
   * artifact kind produced.
   *
   * Order matters and is fixed: envelope shape, then artifact version, then the
   * algorithm, then the key the registry trusts, then the algorithm the
   * registry trusts that key *for*, and only then the cryptographic check.
   * Each step refuses outright; none falls through to a weaker one.
   */
  function verify(signingBytes: Buffer, signature: unknown): AuthoritySignatureVerification {
    if (signature === undefined || signature === null) {
      return { verified: false, failure: 'AUTHORITY_SIGNATURE_MISSING' };
    }
    if (typeof signature === 'object' && !Array.isArray(signature)) {
      const candidate = signature as Record<string, unknown>;
      // Separated from the general malformed case so that an envelope naming an
      // algorithm outside the registry is reported as exactly that, rather than
      // as a shape problem. It is the algorithm-confusion probe, and an
      // operator should be able to see it by name.
      if (typeof candidate.algorithm === 'string' && !isSupportedAuthoritySignatureAlgorithm(candidate.algorithm)) {
        return { verified: false, failure: 'AUTHORITY_SIGNATURE_ALGORITHM_UNSUPPORTED' };
      }
    }
    if (!isWellFormedAuthoritySignature(signature)) {
      return { verified: false, failure: 'AUTHORITY_SIGNATURE_MALFORMED' };
    }
    if (signature.artifactVersion !== AUTHORITY_ARTIFACT_VERSION) {
      return { verified: false, failure: 'AUTHORITY_ARTIFACT_VERSION_UNSUPPORTED' };
    }

    const registered = registry.get(signature.keyId);
    if (registered === undefined) {
      return { verified: false, failure: 'AUTHORITY_SIGNING_KEY_UNKNOWN' };
    }
    // A key is trusted for one algorithm. An envelope that names a different
    // one is refused rather than verified under the registry's — otherwise the
    // envelope's algorithm field would be decorative, and a future second
    // algorithm could be requested against a key registered for the first.
    if (registered.algorithm !== signature.algorithm) {
      return { verified: false, failure: 'AUTHORITY_SIGNATURE_KEY_ALGORITHM_MISMATCH' };
    }

    const bytes = decodeAuthoritySignatureBytes(signature.signature, signature.algorithm);
    if (bytes === undefined) {
      return { verified: false, failure: 'AUTHORITY_SIGNATURE_MALFORMED' };
    }

    let ok: boolean;
    try {
      ok = cryptoVerify(null, signingBytes, registered.key, bytes);
    } catch {
      // A throw from the primitive is a refusal, never an escape: anything the
      // library declines to process is something this must not accept.
      return { verified: false, failure: 'AUTHORITY_SIGNATURE_INVALID' };
    }
    return ok
      ? { verified: true, keyId: signature.keyId, algorithm: signature.algorithm }
      : { verified: false, failure: 'AUTHORITY_SIGNATURE_INVALID' };
  }

  return Object.freeze({
    trustedKeyIds,
    verifyGrant(grant: BoundedGrant, signature: unknown): AuthoritySignatureVerification {
      return verify(grantSigningBytes(grant), signature);
    },
    verifyRevocation(revocation: GrantRevocation, signature: unknown): AuthoritySignatureVerification {
      return verify(revocationSigningBytes(revocation), signature);
    },
  });
}

/** Re-exported so a caller that holds only the verifier can still name the envelope type it passes in. */
export type { AuthoritySignature };
