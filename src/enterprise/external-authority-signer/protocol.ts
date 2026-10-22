import { serializeBoundedGrant, isGrantRevocationReason, type BoundedGrant, type GrantRevocation } from '../../features/grant-runtime/index.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import { parseDelegatedOfferCapability, serializeDelegatedOfferCapability, type DelegatedOfferCapability } from '../authority-authenticity/delegated-offer-capability.js';
import { isWellFormedAuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { isExecutionCapabilityGrantReferenceNonce } from '../authority-authenticity/execution-capability-issuance.js';
import { parseExecutionCapability, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/capability.js';

/**
 * The Frontera external authority-signer protocol, v1 (CORE-02).
 *
 * A **structured** protocol, and deliberately not a signing API. There is no
 * operation whose contract is "sign these bytes": every request names one of
 * the five authority operations `AuthorityArtifactSigner` exposes and carries
 * the structured artifact it is about, and the custody boundary on the other
 * side reconstructs the domain-separated signing bytes itself
 * (`authority-signature.ts`). A holder of this protocol can ask for a grant
 * signature over a grant, a revocation signature over a revocation, and so on
 * — never for a signature over bytes of its own choosing, which for a key whose
 * meaning is "this artifact is authoritative" would be the ability to mint
 * authority in a shape no Frontera code has seen.
 *
 * Vendor-neutral by construction: no provider resource names, no SDK types, no
 * KMS vocabulary. A deployment whose custody service is a cloud KMS or an HSM
 * that *does* expose generic signing puts that primitive behind a server that
 * speaks this protocol — the generic primitive then stays contained inside that
 * server, and Frontera's side keeps the structured boundary.
 *
 * Nothing in this protocol can carry a private key in either direction: the
 * identity answer carries **public** material only, used solely to *check* the
 * trust this deployment already configured (never to establish it).
 */

export const EXTERNAL_AUTHORITY_SIGNER_PROTOCOL = 'frontera.external-authority-signer.v1';

/** The five structured authority operations, by their `AuthorityArtifactSigner` names. A custody service must offer every one; a deployment refuses one that offers fewer, or offers any other. */
export const EXTERNAL_AUTHORITY_SIGNER_OPERATIONS = ['signGrant', 'signRevocation', 'signRevocationState', 'signObligationDischargeState', 'signApprovalState'] as const;

export type ExternalAuthoritySignerOperation = (typeof EXTERNAL_AUTHORITY_SIGNER_OPERATIONS)[number];

/** One path per operation. Structured endpoints, never a generic `/sign`. */
export const EXTERNAL_AUTHORITY_SIGNER_PATHS: Readonly<Record<ExternalAuthoritySignerOperation | 'identity', string>> = Object.freeze({
  identity: '/v1/identity',
  signGrant: '/v1/sign/grant',
  signRevocation: '/v1/sign/revocation',
  signRevocationState: '/v1/sign/revocation-state',
  signObligationDischargeState: '/v1/sign/obligation-discharge-state',
  signApprovalState: '/v1/sign/approval-state',
});

/**
 * TRADE-04C-S1 — structured **extension** operations. Not part of the five
 * every custody service must offer: a deployment requires an extension only
 * when it composes the feature that needs it (`signDelegatedOfferCapability`:
 * a Host composing the governed trade executor), and then requires the
 * service to offer exactly the five plus that extension. A deployment that
 * requires none still requires exactly the five — an extension it did not ask
 * for is refused like any other unknown operation.
 *
 * G-02B adds `signExecutionCapability`: a generic execution capability, signed
 * by the custody service only after the issuance rule accepts it against the
 * service's **own** policy (`execution-capability-issuance.ts`). Required only
 * by a Host that composes execution-capability issuance.
 */
export const EXTERNAL_AUTHORITY_SIGNER_EXTENSION_OPERATIONS = ['signDelegatedOfferCapability', 'signExecutionCapability'] as const;

export type ExternalAuthoritySignerExtensionOperation = (typeof EXTERNAL_AUTHORITY_SIGNER_EXTENSION_OPERATIONS)[number];

/** One structured path per extension. Never a generic `/sign`. */
export const EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS: Readonly<Record<ExternalAuthoritySignerExtensionOperation, string>> = Object.freeze({
  signDelegatedOfferCapability: '/v1/sign/xrpl-delegated-offer-capability',
  signExecutionCapability: '/v1/sign/execution-capability',
});

/** The path of a core or extension operation. */
export function externalAuthoritySignerPath(operation: ExternalAuthoritySignerOperation | ExternalAuthoritySignerExtensionOperation): string {
  return isExternalAuthoritySignerExtensionOperation(operation) ? EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS[operation] : EXTERNAL_AUTHORITY_SIGNER_PATHS[operation];
}

export function isExternalAuthoritySignerExtensionOperation(value: unknown): value is ExternalAuthoritySignerExtensionOperation {
  return typeof value === 'string' && (EXTERNAL_AUTHORITY_SIGNER_EXTENSION_OPERATIONS as readonly string[]).includes(value);
}

/**
 * The custody service's statement of what it is. Public material only. The
 * requesting side compares every field against what its own configuration
 * pinned; nothing here is ever added to a trust registry.
 */
export interface ExternalAuthoritySignerIdentity {
  readonly protocol: typeof EXTERNAL_AUTHORITY_SIGNER_PROTOCOL;
  readonly keyId: string;
  readonly algorithm: string;
  /** SPKI PEM. Compared against the locally trusted key for `keyId`; a mismatch refuses the deployment. */
  readonly publicKeyPem: string;
  readonly artifactVersion: string;
  readonly operations: readonly string[];
}

/** A structured signing request: one operation and the artifact it signs. */
export type ExternalAuthoritySigningRequest =
  | { readonly operation: 'signGrant'; readonly grant: BoundedGrant; readonly storeId: string }
  | { readonly operation: 'signRevocation'; readonly revocation: GrantRevocation; readonly storeId: string }
  | { readonly operation: 'signRevocationState'; readonly state: RevocationStateCommitment }
  | { readonly operation: 'signObligationDischargeState'; readonly state: ObligationDischargeStateCommitment }
  | { readonly operation: 'signApprovalState'; readonly state: ApprovalStateCommitment }
  /** TRADE-04C-S1 extension: the capability, and the grant it is issued under as filed — so the custody service can re-verify that grant under its own key before signing. */
  | { readonly operation: 'signDelegatedOfferCapability'; readonly capability: DelegatedOfferCapability; readonly grant: BoundedGrant; readonly storeId: string; readonly grantSignature: unknown }
  /** G-02B extension: the capability, the grant it is derived from as filed, and the grant-reference nonce — so the custody service can re-verify the grant under its own key and recompute the reference before signing. */
  | { readonly operation: 'signExecutionCapability'; readonly capability: ExecutionCapability; readonly grant: BoundedGrant; readonly storeId: string; readonly grantSignature: unknown; readonly grantReferenceNonce: string };

/**
 * The request body for an operation. A grant travels as its **canonical**
 * serialization — the exact string both sides sign over — so the custody
 * service parses it strictly and can refuse anything that does not round-trip,
 * rather than re-serializing a JSON object whose key order or number format a
 * transport could have changed.
 */
export function externalSigningRequestBody(request: ExternalAuthoritySigningRequest): Record<string, unknown> {
  switch (request.operation) {
    case 'signGrant':
      return { protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL, grant: serializeBoundedGrant(request.grant), storeId: request.storeId };
    case 'signRevocation':
      return {
        protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
        revocation: { grantId: request.revocation.grantId, revokedAt: request.revocation.revokedAt, reason: request.revocation.reason, issuerRef: request.revocation.issuerRef },
        storeId: request.storeId,
      };
    case 'signRevocationState':
      return { protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL, state: { storeId: request.state.storeId, sequence: request.state.sequence, revocationSetDigest: request.state.revocationSetDigest } };
    case 'signObligationDischargeState':
    case 'signApprovalState':
      return {
        protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
        state: { storeId: request.state.storeId, organizationId: request.state.organizationId, sequence: request.state.sequence, chainDigest: request.state.chainDigest },
      };
    case 'signDelegatedOfferCapability':
      // Both artifacts travel canonical, for the same reason a grant does: the service parses the exact bytes it will reason about.
      return { protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL, capability: serializeDelegatedOfferCapability(request.capability), grant: serializeBoundedGrant(request.grant), storeId: request.storeId, grantSignature: request.grantSignature };
    case 'signExecutionCapability':
      return {
        protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
        capability: serializeExecutionCapability(request.capability),
        grant: serializeBoundedGrant(request.grant),
        storeId: request.storeId,
        grantSignature: request.grantSignature,
        grantReferenceNonce: request.grantReferenceNonce,
      };
  }
}

// ── Strict parsing, shared by the custody service (requests) and the client (answers) ──

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Exactly these own keys, no more and no fewer. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const IDENTIFIER_MAX = 512;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTIFIER_MAX && value.trim() === value;
}

function sequenceOf(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses a request body for `operation` into the structured artifact it names,
 * or `undefined`. Used by a custody service before it signs anything: a body
 * that is not exactly one well-formed artifact of that operation's kind is
 * refused, never coerced. `parseGrant` is the strict canonical grant parser
 * (round-trip exact), injected so this module stays free of store code.
 */
export function parseExternalSigningRequest(
  operation: ExternalAuthoritySignerOperation | ExternalAuthoritySignerExtensionOperation,
  body: unknown,
  parseGrant: (canonical: string) => BoundedGrant | undefined,
): ExternalAuthoritySigningRequest | undefined {
  switch (operation) {
    case 'signGrant': {
      if (!hasExactKeys(body, ['protocol', 'grant', 'storeId']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) return undefined;
      if (typeof body.grant !== 'string' || !boundedText(body.storeId)) return undefined;
      const grant = parseGrant(body.grant);
      return grant === undefined ? undefined : { operation, grant, storeId: body.storeId };
    }
    case 'signRevocation': {
      if (!hasExactKeys(body, ['protocol', 'revocation', 'storeId']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL || !boundedText(body.storeId)) return undefined;
      const revocation = body.revocation;
      if (!hasExactKeys(revocation, ['grantId', 'revokedAt', 'reason', 'issuerRef'])) return undefined;
      if (!boundedText(revocation.grantId) || !boundedText(revocation.revokedAt) || !boundedText(revocation.issuerRef)) return undefined;
      if (typeof revocation.reason !== 'string' || !isGrantRevocationReason(revocation.reason)) return undefined;
      return { operation, revocation: { grantId: revocation.grantId, revokedAt: revocation.revokedAt, reason: revocation.reason, issuerRef: revocation.issuerRef }, storeId: body.storeId };
    }
    case 'signRevocationState': {
      if (!hasExactKeys(body, ['protocol', 'state']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) return undefined;
      const state = body.state;
      if (!hasExactKeys(state, ['storeId', 'sequence', 'revocationSetDigest'])) return undefined;
      if (!boundedText(state.storeId) || !sequenceOf(state.sequence) || typeof state.revocationSetDigest !== 'string' || !DIGEST.test(state.revocationSetDigest)) return undefined;
      return { operation, state: { storeId: state.storeId, sequence: state.sequence, revocationSetDigest: state.revocationSetDigest } };
    }
    case 'signObligationDischargeState':
    case 'signApprovalState': {
      if (!hasExactKeys(body, ['protocol', 'state']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) return undefined;
      const state = body.state;
      if (!hasExactKeys(state, ['storeId', 'organizationId', 'sequence', 'chainDigest'])) return undefined;
      if (!boundedText(state.storeId) || !boundedText(state.organizationId) || !sequenceOf(state.sequence) || typeof state.chainDigest !== 'string' || !DIGEST.test(state.chainDigest)) return undefined;
      const parsed = { storeId: state.storeId, organizationId: state.organizationId, sequence: state.sequence, chainDigest: state.chainDigest };
      return operation === 'signApprovalState' ? { operation, state: parsed } : { operation, state: parsed };
    }
    case 'signDelegatedOfferCapability': {
      if (!hasExactKeys(body, ['protocol', 'capability', 'grant', 'storeId', 'grantSignature']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) return undefined;
      if (typeof body.grant !== 'string' || !boundedText(body.storeId)) return undefined;
      const envelope = body.grantSignature;
      if (!hasExactKeys(envelope, ['algorithm', 'keyId', 'signature', 'artifactVersion']) || !isWellFormedAuthoritySignature(envelope)) return undefined;
      const capability = parseDelegatedOfferCapability(body.capability);
      const grant = parseGrant(body.grant);
      if (capability === undefined || grant === undefined) return undefined;
      return { operation, capability, grant, storeId: body.storeId, grantSignature: { algorithm: envelope.algorithm, keyId: envelope.keyId, signature: envelope.signature, artifactVersion: envelope.artifactVersion } };
    }
    case 'signExecutionCapability': {
      if (!hasExactKeys(body, ['protocol', 'capability', 'grant', 'storeId', 'grantSignature', 'grantReferenceNonce']) || body.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) return undefined;
      if (typeof body.grant !== 'string' || !boundedText(body.storeId) || !isExecutionCapabilityGrantReferenceNonce(body.grantReferenceNonce)) return undefined;
      const envelope = body.grantSignature;
      if (!hasExactKeys(envelope, ['algorithm', 'keyId', 'signature', 'artifactVersion']) || !isWellFormedAuthoritySignature(envelope)) return undefined;
      // Canonical text only: a re-ordered, re-spaced or extended capability is refused here, never normalized.
      const parsed = parseExecutionCapability(body.capability);
      const grant = parseGrant(body.grant);
      if (!parsed.ok || grant === undefined) return undefined;
      return {
        operation,
        capability: parsed.capability,
        grant,
        storeId: body.storeId,
        grantSignature: { algorithm: envelope.algorithm, keyId: envelope.keyId, signature: envelope.signature, artifactVersion: envelope.artifactVersion },
        grantReferenceNonce: body.grantReferenceNonce,
      };
    }
  }
}
