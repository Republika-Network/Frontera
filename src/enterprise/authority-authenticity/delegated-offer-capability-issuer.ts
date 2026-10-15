import { randomBytes } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { AuthoritySignature } from './authority-signature.js';
import {
  DELEGATED_OFFER_CAPABILITY_FORMAT,
  DELEGATED_OFFER_CAPABILITY_LIMITS,
  DELEGATED_OFFER_CAPABILITY_OPERATION,
  assessDelegatedOfferCapabilityIssuance,
  isWellFormedDelegatedOfferCapability,
  serializeDelegatedOfferCapability,
  type DelegatedOfferCapability,
  type DelegatedOfferCapabilityIssuanceFailure,
  type DelegatedOfferCapabilityNetwork,
} from './delegated-offer-capability.js';
import type { AuthorityArtifactSigner } from './signer.js';
import type { AuthorityArtifactVerifier } from './verifier.js';

/**
 * TRADE-04C-S1 — the Host-side issuer of delegated-offer signing capabilities.
 *
 * It is not an authority of its own and it cannot mint one: it reads the grant
 * through the **authenticated durable grant store** (signature, digest,
 * revocation state and CORE-07 freshness verified on that read), refuses a
 * revoked, expired or absent grant, assembles the capability for the exact
 * prepared transaction the executor built, and asks the composed authority
 * signer — which applies the same issuance rule again inside its custody
 * boundary — to sign it. The returned signature is verified locally, under the
 * active key, before anything relies on it.
 *
 * Reached only by the governed trade executor, through the write-once slot
 * below, which the Host composition binds once the grant store and authority
 * signer exist (`composition-root.ts`). An unbound slot refuses: no capability,
 * no signature.
 */

/** What the governed executor asks for: every value fixed by the grant-bound action and the validated preflight. */
export interface DelegatedOfferCapabilityIssuanceInput {
  /** The deployment's configured trust-domain id. */
  readonly trustDomain: string;
  readonly executionId: string;
  readonly boundedGrantId: string;
  readonly organizationId: string;
  readonly proposalDigest: string;
  readonly network: DelegatedOfferCapabilityNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly signingPreimageDigest: string;
  readonly sequence: number;
  readonly fee: string;
  readonly lastLedgerSequence: number;
}

export interface IssuedDelegatedOfferCapability {
  readonly capability: DelegatedOfferCapability;
  /** The canonical serialization — exactly the bytes (after the domain prefix) the signature covers. What travels to the signer. */
  readonly canonical: string;
  readonly signature: AuthoritySignature;
}

export interface DelegatedOfferCapabilityIssuer {
  issue(input: DelegatedOfferCapabilityIssuanceInput): Promise<IssuedDelegatedOfferCapability>;
}

/** The authenticated read the issuer needs: the grant as filed, its revocation, its store id and its verified signature. */
export interface SignedGrantReader {
  readSigned(grantId: string): Promise<{ readonly storeId: string; readonly grant?: BoundedGrant; readonly revocation?: GrantRevocation; readonly signature?: AuthoritySignature }>;
}

export const DELEGATED_OFFER_CAPABILITY_ISSUER_FAILURES = [
  'CAPABILITY_ISSUER_UNBOUND',
  'CAPABILITY_ISSUER_UNSUPPORTED',
  'CAPABILITY_REQUEST_INVALID',
  'CAPABILITY_GRANT_UNAVAILABLE',
  'CAPABILITY_GRANT_NOT_FOUND',
  'CAPABILITY_GRANT_REVOKED',
  'CAPABILITY_REFUSED',
  'CAPABILITY_SIGNING_UNAVAILABLE',
  'CAPABILITY_SIGNATURE_INVALID',
] as const;
export type DelegatedOfferCapabilityIssuerFailure = (typeof DELEGATED_OFFER_CAPABILITY_ISSUER_FAILURES)[number];

export class DelegatedOfferCapabilityError extends Error {
  readonly code: DelegatedOfferCapabilityIssuerFailure;
  /** The issuance rule's own reason, when the rule refused. */
  readonly rule: DelegatedOfferCapabilityIssuanceFailure | undefined;

  constructor(code: DelegatedOfferCapabilityIssuerFailure, message: string, rule?: DelegatedOfferCapabilityIssuanceFailure) {
    super(message);
    this.name = 'DelegatedOfferCapabilityError';
    this.code = code;
    this.rule = rule;
  }
}

export interface DelegatedOfferCapabilityIssuerOptions {
  readonly grants: SignedGrantReader;
  readonly signer: AuthorityArtifactSigner;
  /** The deployment's trusted verifier — the same one its stores read with. */
  readonly verifier: AuthorityArtifactVerifier;
  /** 1 … `DELEGATED_OFFER_CAPABILITY_LIMITS.maximumLifetimeMs`; default `defaultLifetimeMs`. Never past the grant. */
  readonly lifetimeMs?: number;
  readonly now?: () => number;
  /** Injected for qualification; default 32 random bytes as lowercase hex. */
  readonly capabilityId?: () => string;
}

export function createDelegatedOfferCapabilityIssuer(options: DelegatedOfferCapabilityIssuerOptions): DelegatedOfferCapabilityIssuer {
  const { grants, signer, verifier } = options;
  if (typeof grants?.readSigned !== 'function' || typeof signer?.activeKeyId !== 'string' || typeof verifier?.verifyGrant !== 'function') {
    throw new DelegatedOfferCapabilityError('CAPABILITY_REQUEST_INVALID', 'The delegated-offer capability issuer needs an authenticated grant reader, the authority signer and the trusted verifier.');
  }
  const L = DELEGATED_OFFER_CAPABILITY_LIMITS;
  const lifetimeMs = options.lifetimeMs ?? L.defaultLifetimeMs;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > L.maximumLifetimeMs) {
    throw new DelegatedOfferCapabilityError('CAPABILITY_REQUEST_INVALID', `The delegated-offer capability lifetime must be an integer from 1 to ${L.maximumLifetimeMs} ms.`);
  }
  const now = options.now ?? Date.now;
  const nextCapabilityId = options.capabilityId ?? (() => randomBytes(32).toString('hex'));

  const fail = (code: DelegatedOfferCapabilityIssuerFailure, message: string, rule?: DelegatedOfferCapabilityIssuanceFailure): never => {
    throw new DelegatedOfferCapabilityError(code, message, rule);
  };

  return Object.freeze({
    async issue(input: DelegatedOfferCapabilityIssuanceInput): Promise<IssuedDelegatedOfferCapability> {
      const sign = signer.signDelegatedOfferCapability;
      if (typeof sign !== 'function') return fail('CAPABILITY_ISSUER_UNSUPPORTED', 'The composed authority signer offers no delegated-offer capability operation; nothing is signed.');
      let read: Awaited<ReturnType<SignedGrantReader['readSigned']>>;
      try {
        read = await grants.readSigned(input.boundedGrantId);
      } catch {
        return fail('CAPABILITY_GRANT_UNAVAILABLE', 'The bounded grant could not be read and verified from the authenticated store; no capability is issued.');
      }
      if (read.grant === undefined || read.signature === undefined) return fail('CAPABILITY_GRANT_NOT_FOUND', 'No authenticated bounded grant is filed under that id; no capability is issued.');
      if (read.revocation !== undefined) return fail('CAPABILITY_GRANT_REVOKED', 'The bounded grant is revoked; no capability is issued.');
      const issuedAtMs = now();
      const expiresAtMs = Math.min(issuedAtMs + lifetimeMs, Date.parse(read.grant.expiresAt));
      const candidate = {
        format: DELEGATED_OFFER_CAPABILITY_FORMAT,
        operation: DELEGATED_OFFER_CAPABILITY_OPERATION,
        capabilityId: nextCapabilityId(),
        issuerKeyId: signer.activeKeyId,
        organizationId: input.organizationId,
        trustDomain: input.trustDomain,
        grantStoreId: read.storeId,
        executionId: input.executionId,
        boundedGrantId: read.grant.id,
        grantDigest: read.grant.digest,
        proposalDigest: input.proposalDigest,
        signingPreimageDigest: input.signingPreimageDigest,
        network: input.network,
        ownerAccount: input.ownerAccount,
        delegateAccount: input.delegateAccount,
        sequence: input.sequence,
        fee: input.fee,
        lastLedgerSequence: input.lastLedgerSequence,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: Number.isFinite(expiresAtMs) && expiresAtMs > issuedAtMs ? new Date(expiresAtMs).toISOString() : '',
      };
      if (!isWellFormedDelegatedOfferCapability(candidate)) return fail('CAPABILITY_REQUEST_INVALID', 'The requested capability is not well formed (or its grant has no remaining lifetime); nothing is signed.');
      const capability: DelegatedOfferCapability = Object.freeze(candidate);
      const request = { capability, grant: read.grant, storeId: read.storeId, grantSignature: read.signature };
      // The same rule the custody boundary applies, here first: a refusal costs no signing call.
      const local = assessDelegatedOfferCapabilityIssuance(request, { verifyGrant: (grant, storeId, signature) => verifier.verifyGrant(grant, storeId, signature), activeKeyId: signer.activeKeyId, now: issuedAtMs });
      if (!local.issuable) return fail('CAPABILITY_REFUSED', `The bounded grant does not authorize this capability (${local.failure}); nothing is signed.`, local.failure);
      let signature: AuthoritySignature;
      try {
        signature = await sign.call(signer, request);
      } catch {
        return fail('CAPABILITY_SIGNING_UNAVAILABLE', 'The authority signer did not sign the delegated-offer capability; nothing is signed.');
      }
      const verification = verifier.verifyDelegatedOfferCapability(capability, signature);
      if (!verification.verified || verification.keyId !== signer.activeKeyId) return fail('CAPABILITY_SIGNATURE_INVALID', 'The delegated-offer capability signature does not verify under the active authority key; it is discarded.');
      return Object.freeze({ capability, canonical: serializeDelegatedOfferCapability(capability), signature });
    },
  });
}

/**
 * The write-once seam between the trade executor (composed first, at Host
 * boot) and the authority boundary (composed afterwards, with the grant
 * store). The Host creates it with the executor, hands it to the composition,
 * which binds the issuer exactly once; the Host refuses to serve if it was
 * never bound. Until then, and on any second bind, it refuses.
 */
export interface DelegatedOfferCapabilityIssuerSlot extends DelegatedOfferCapabilityIssuer {
  bind(issuer: DelegatedOfferCapabilityIssuer): void;
  bound(): boolean;
}

export function createDelegatedOfferCapabilityIssuerSlot(): DelegatedOfferCapabilityIssuerSlot {
  let target: DelegatedOfferCapabilityIssuer | undefined;
  return Object.freeze({
    bind(issuer: DelegatedOfferCapabilityIssuer): void {
      if (target !== undefined) throw new DelegatedOfferCapabilityError('CAPABILITY_REQUEST_INVALID', 'The delegated-offer capability issuer is bound exactly once.');
      if (typeof issuer?.issue !== 'function') throw new DelegatedOfferCapabilityError('CAPABILITY_REQUEST_INVALID', 'The delegated-offer capability issuer must implement issue.');
      target = issuer;
    },
    bound: () => target !== undefined,
    async issue(input: DelegatedOfferCapabilityIssuanceInput): Promise<IssuedDelegatedOfferCapability> {
      if (target === undefined) throw new DelegatedOfferCapabilityError('CAPABILITY_ISSUER_UNBOUND', 'No delegated-offer capability issuer is composed; nothing is signed.');
      return target.issue(input);
    },
  });
}
