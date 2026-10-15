import { boundedGrantDigestMatches, isWellFormedBoundedGrantSemantics, type BoundedGrant } from '../../features/grant-runtime/index.js';
import type { AuthoritySignatureVerification } from './verifier.js';

/**
 * TRADE-04C-S1 — the **delegated-offer signing capability**: a CORE-02
 * authority artifact that authorizes exactly one delegated XRPL OfferCreate
 * signature, for one execution of one bounded grant.
 *
 * ## Why it exists
 *
 * Before it, the delegated signer (TRADE-04B) authenticated its caller with a
 * bearer credential and nothing else: whoever held the credential could have
 * any closed, in-bounds OfferCreate signed for a configured pair (TRADE-04C
 * residual risk R1). A bearer credential is transport authentication, not
 * governance authorization. This artifact moves the authorization check into
 * the signer's custody boundary: the signer refuses a request unless it carries
 * a capability signed by a key it pins, for exactly the transaction it is asked
 * to sign, not yet expired and never seen before.
 *
 * ## Who may issue one — and why that is not a new authority
 *
 * The **existing** authority key (CORE-02), under its existing custody
 * (software or external). Nothing new is trusted: the key that makes a bounded
 * grant authoritative is the key that vouches "this one signature is that
 * grant's". It is a sixth structured artifact, with its own signing domain
 * (`AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability`), and — like every
 * other one — there is no operation to sign bytes.
 *
 * ## What the custody boundary checks before signing one
 *
 * `assessDelegatedOfferCapabilityIssuance`, run by every signer implementation
 * **inside** its custody boundary (the software signer in-process, the
 * reference external service in its own process): the request carries the
 * grant as stored, its store id and its authority signature, and the custody
 * boundary refuses unless that grant verifies under **its own** key and names,
 * as exact CORE-03 tokens, the very proposal digest, network and delegate the
 * capability binds, for the owner resource and organization it binds, and
 * unless the capability lives at most `maximumLifetimeMs` and never past the
 * grant. So the authority key is not a free oracle for capabilities: it signs
 * one only for a grant it signed itself. It is still an oracle for grants —
 * a compromised Host can ask for a grant signature (AA-010), and nothing here
 * changes that.
 *
 * ## What it binds
 *
 * Every field below is part of the signed canonical bytes: the operation, the
 * organization and the configured trust domain, the execution, the grant, its
 * digest and the store it is filed in, the granted proposal digest, the exact single-signing
 * preimage digest of the unsigned transaction, owner, delegate, network,
 * `Sequence`, `Fee`, `LastLedgerSequence`, issuance and expiry instants, a
 * fresh 32-byte capability id and the issuer key id. Changing any of them
 * changes the bytes, and the signature no longer verifies.
 *
 * ## What it does not prove
 *
 * - **P11.** The execution id is the one the governed path claimed before the
 *   executor ran, but no signed artifact attests that claim: it is bound here,
 *   not proven.
 * - **Non-revocation after issuance.** The Host's authenticated grant read
 *   proves the grant unrevoked when the capability is issued; a revocation
 *   committed later is invisible to a remote verifier (no remote freshness
 *   proof of the revocation state exists). The capability's short lifetime is
 *   the stated bound on that window.
 * - **Anything about a compromised delegate key or signer process**, which can
 *   sign without asking for a capability at all.
 *
 * Domain-free of trading code: the three CORE-03 dimension ids it reads are
 * the TRADE-03 ids, named here as data (and pinned equal to TRADE-03's by
 * `trade04c-s1-capability.test.ts`), so the authority layer imports nothing
 * from the trade vertical.
 */

export const DELEGATED_OFFER_CAPABILITY_FORMAT = 'frontera.xrpl-delegated-offer-capability.v1';
/** The one operation a capability authorizes — the delegated signer protocol's operation name. */
export const DELEGATED_OFFER_CAPABILITY_OPERATION = 'sign-xrpl-delegated-offer';

export const DELEGATED_OFFER_CAPABILITY_LIMITS = Object.freeze({
  /** A capability lives at most this long. The issuer's default is shorter. */
  maximumLifetimeMs: 60_000,
  defaultLifetimeMs: 30_000,
  /** How far an issuance instant may sit from the custody boundary's (or the signer's) clock. */
  maximumClockSkewMs: 5_000,
});

/** The CORE-03 dimension ids of a trade grant the custody check reads (TRADE-03's `TRADE_PARAMETER_DIMENSION_IDS`). */
export const DELEGATED_OFFER_GRANT_DIMENSIONS = Object.freeze({
  proposalDigest: 'tradeProposalDigest',
  network: 'tradeNetwork',
  delegateAccount: 'tradeDelegateAccount',
});

/** The ledgers a capability may name. Mainnet is not representable. */
export const DELEGATED_OFFER_CAPABILITY_NETWORKS = Object.freeze(['xrp-ledger-testnet', 'xrp-ledger-devnet'] as const);
export type DelegatedOfferCapabilityNetwork = (typeof DELEGATED_OFFER_CAPABILITY_NETWORKS)[number];

export interface DelegatedOfferCapability {
  readonly format: typeof DELEGATED_OFFER_CAPABILITY_FORMAT;
  readonly operation: typeof DELEGATED_OFFER_CAPABILITY_OPERATION;
  /** 32 random bytes, lowercase hex: the single-use identity a signer consumes. */
  readonly capabilityId: string;
  /** The authority key id the issuer signs as. Also in the signature envelope; both must agree. */
  readonly issuerKeyId: string;
  readonly organizationId: string;
  /** The deployment's configured trust-domain id (`governedActions.trustDomainId`). Bound and pinned by the signer; stated by the Host, not derivable from the grant. */
  readonly trustDomain: string;
  /** The bounded-grant store the grant is filed under. Verified by the custody boundary: the grant's signature covers it. */
  readonly grantStoreId: string;
  readonly executionId: string;
  readonly boundedGrantId: string;
  /** The grant's own digest (`BoundedGrant.digest`). */
  readonly grantDigest: string;
  /** The TRADE-03 proposal digest the grant names exactly. */
  readonly proposalDigest: string;
  /** `sha256:` over the exact single-signing preimage (`STX\0` ‖ signing fields, `SigningPubKey` = the pinned delegate key). */
  readonly signingPreimageDigest: string;
  readonly network: DelegatedOfferCapabilityNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly sequence: number;
  readonly fee: string;
  readonly lastLedgerSequence: number;
  /** ISO-8601 UTC with milliseconds. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Canonical key order: lexicographic. One spelling per capability. */
const FIELDS = [
  'boundedGrantId',
  'capabilityId',
  'delegateAccount',
  'executionId',
  'expiresAt',
  'fee',
  'format',
  'grantDigest',
  'grantStoreId',
  'issuedAt',
  'issuerKeyId',
  'lastLedgerSequence',
  'network',
  'operation',
  'organizationId',
  'ownerAccount',
  'proposalDigest',
  'sequence',
  'signingPreimageDigest',
  'trustDomain',
] as const satisfies readonly (keyof DelegatedOfferCapability)[];

const CAPABILITY_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A classic XRPL address shape. The signer compares accounts exactly with its pins; this only refuses what cannot be one. */
const ACCOUNT = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const FEE = /^[1-9][0-9]{0,15}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UINT32_MAXIMUM = 0xffff_ffff;
const IDENTIFIER_MAXIMUM = 512;

function identifier(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTIFIER_MAXIMUM && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && new Date(Date.parse(value)).toISOString() === value;
}

const uint32 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAXIMUM;

/** The exact bytes a capability is signed over (after the domain prefix). Lexicographic keys, no whitespace, no omitted field. */
export function serializeDelegatedOfferCapability(capability: DelegatedOfferCapability): string {
  return `{${FIELDS.map((field) => `${JSON.stringify(field)}:${JSON.stringify(capability[field])}`).join(',')}}`;
}

/** Whether every field has its closed shape. Structural only: says nothing about who signed it. */
export function isWellFormedDelegatedOfferCapability(value: unknown): value is DelegatedOfferCapability {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || !keys.every((key) => typeof key === 'string' && (FIELDS as readonly string[]).includes(key))) return false;
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return false;
  }
  const c = value as Record<string, unknown>;
  return (
    c['format'] === DELEGATED_OFFER_CAPABILITY_FORMAT &&
    c['operation'] === DELEGATED_OFFER_CAPABILITY_OPERATION &&
    typeof c['capabilityId'] === 'string' &&
    CAPABILITY_ID.test(c['capabilityId']) &&
    identifier(c['issuerKeyId']) &&
    identifier(c['organizationId']) &&
    identifier(c['trustDomain']) &&
    identifier(c['grantStoreId']) &&
    identifier(c['executionId']) &&
    identifier(c['boundedGrantId']) &&
    typeof c['grantDigest'] === 'string' &&
    DIGEST.test(c['grantDigest']) &&
    typeof c['proposalDigest'] === 'string' &&
    DIGEST.test(c['proposalDigest']) &&
    typeof c['signingPreimageDigest'] === 'string' &&
    DIGEST.test(c['signingPreimageDigest']) &&
    (DELEGATED_OFFER_CAPABILITY_NETWORKS as readonly unknown[]).includes(c['network']) &&
    typeof c['ownerAccount'] === 'string' &&
    ACCOUNT.test(c['ownerAccount']) &&
    typeof c['delegateAccount'] === 'string' &&
    ACCOUNT.test(c['delegateAccount']) &&
    c['ownerAccount'] !== c['delegateAccount'] &&
    uint32(c['sequence']) &&
    typeof c['fee'] === 'string' &&
    FEE.test(c['fee']) &&
    uint32(c['lastLedgerSequence']) &&
    instant(c['issuedAt']) &&
    instant(c['expiresAt'])
  );
}

/**
 * Parses a capability from its **canonical** serialization, or `undefined`.
 * The text must be exactly what `serializeDelegatedOfferCapability` produces
 * for the record it parses to — a re-ordered, re-spaced or re-spelled record
 * is refused, never normalized, so the bytes a verifier checks are the bytes
 * that were signed.
 */
export function parseDelegatedOfferCapability(canonical: unknown): DelegatedOfferCapability | undefined {
  if (typeof canonical !== 'string' || canonical.length > 8_192) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return undefined;
  }
  if (!isWellFormedDelegatedOfferCapability(parsed)) return undefined;
  const capability = Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, parsed[field]])) as unknown as DelegatedOfferCapability);
  return serializeDelegatedOfferCapability(capability) === canonical ? capability : undefined;
}

// ── Issuance: the rule every custody boundary applies before signing ──────

export const DELEGATED_OFFER_CAPABILITY_ISSUANCE_FAILURES = [
  'CAPABILITY_MALFORMED',
  'CAPABILITY_ISSUER_MISMATCH',
  'GRANT_MALFORMED',
  'GRANT_SIGNATURE_INVALID',
  'GRANT_IDENTITY_MISMATCH',
  'GRANT_STORE_MISMATCH',
  'GRANT_ORGANIZATION_MISMATCH',
  'GRANT_RESOURCE_MISMATCH',
  'GRANT_TERMS_MISMATCH',
  'GRANT_EXPIRED',
  'CAPABILITY_TIME_INVALID',
] as const;
export type DelegatedOfferCapabilityIssuanceFailure = (typeof DELEGATED_OFFER_CAPABILITY_ISSUANCE_FAILURES)[number];

export interface DelegatedOfferCapabilityIssuanceRequest {
  readonly capability: DelegatedOfferCapability;
  /** The grant as filed in the store named by `storeId`, and the authority signature it is filed with. */
  readonly grant: BoundedGrant;
  readonly storeId: string;
  readonly grantSignature: unknown;
}

export interface DelegatedOfferCapabilityIssuanceContext {
  /** Verifies the grant under the custody boundary's **own** key — never a registry the request could influence. */
  readonly verifyGrant: (grant: BoundedGrant, storeId: string, signature: unknown) => AuthoritySignatureVerification;
  /** The key id this custody boundary signs as. */
  readonly activeKeyId: string;
  /** The custody boundary's clock, ms since the epoch. */
  readonly now: number;
}

function exactToken(grant: BoundedGrant, dimension: string): string | undefined {
  const bound = grant.scope.parameters?.find((entry) => entry.dimension === dimension);
  return bound !== undefined && bound.kind === 'exact' && bound.type === 'token' ? bound.value : undefined;
}

function boundIncludes(bound: BoundedGrant['scope']['resources'], value: string): boolean {
  if (bound === undefined) return false;
  if (bound.kind === 'identity') return bound.value === value;
  if (bound.kind === 'set') return bound.values.includes(value);
  return false;
}

/**
 * Whether the authority may sign `request.capability`. Pure; refuses with one
 * closed reason. Run by every `AuthorityArtifactSigner` implementation before
 * it signs a capability, and by the Host-side issuer before it asks.
 */
export function assessDelegatedOfferCapabilityIssuance(
  request: DelegatedOfferCapabilityIssuanceRequest,
  context: DelegatedOfferCapabilityIssuanceContext,
): { readonly issuable: true } | { readonly issuable: false; readonly failure: DelegatedOfferCapabilityIssuanceFailure } {
  const refuse = (failure: DelegatedOfferCapabilityIssuanceFailure) => ({ issuable: false as const, failure });
  const { capability, grant, storeId } = request;
  if (!isWellFormedDelegatedOfferCapability(capability)) return refuse('CAPABILITY_MALFORMED');
  if (capability.issuerKeyId !== context.activeKeyId) return refuse('CAPABILITY_ISSUER_MISMATCH');
  if (grant === null || typeof grant !== 'object' || typeof grant.id !== 'string' || grant.scope === null || typeof grant.scope !== 'object') return refuse('GRANT_MALFORMED');
  let wellFormed: boolean;
  try {
    // The same checks a store's read path makes before it trusts a grant: its own digest, and its CORE-03 marker and axes agree.
    wellFormed = boundedGrantDigestMatches(grant) && isWellFormedBoundedGrantSemantics(grant);
  } catch {
    wellFormed = false;
  }
  if (!wellFormed) return refuse('GRANT_MALFORMED');
  const verification = context.verifyGrant(grant, storeId, request.grantSignature);
  if (!verification.verified || verification.keyId !== context.activeKeyId) return refuse('GRANT_SIGNATURE_INVALID');
  if (capability.boundedGrantId !== grant.id || capability.grantDigest !== grant.digest) return refuse('GRANT_IDENTITY_MISMATCH');
  if (capability.grantStoreId !== storeId) return refuse('GRANT_STORE_MISMATCH');
  const organization = grant.scope.organization;
  if (organization?.kind !== 'identity' || organization.value !== capability.organizationId) return refuse('GRANT_ORGANIZATION_MISMATCH');
  if (!boundIncludes(grant.scope.resources, `${capability.network}:${capability.ownerAccount}`)) return refuse('GRANT_RESOURCE_MISMATCH');
  if (
    exactToken(grant, DELEGATED_OFFER_GRANT_DIMENSIONS.proposalDigest) !== capability.proposalDigest ||
    exactToken(grant, DELEGATED_OFFER_GRANT_DIMENSIONS.network) !== capability.network ||
    exactToken(grant, DELEGATED_OFFER_GRANT_DIMENSIONS.delegateAccount) !== capability.delegateAccount
  ) {
    return refuse('GRANT_TERMS_MISMATCH');
  }
  const grantIssuedAt = Date.parse(grant.issuedAt);
  const grantExpiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(grantIssuedAt) || !Number.isFinite(grantExpiresAt) || !(context.now < grantExpiresAt)) return refuse('GRANT_EXPIRED');
  const issuedAt = Date.parse(capability.issuedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  const L = DELEGATED_OFFER_CAPABILITY_LIMITS;
  if (
    Math.abs(issuedAt - context.now) > L.maximumClockSkewMs ||
    !(expiresAt > issuedAt) ||
    expiresAt - issuedAt > L.maximumLifetimeMs ||
    expiresAt > grantExpiresAt ||
    issuedAt < grantIssuedAt
  ) {
    return refuse('CAPABILITY_TIME_INVALID');
  }
  return { issuable: true };
}
