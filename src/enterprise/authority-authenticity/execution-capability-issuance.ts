import { createHash } from 'node:crypto';

import { boundedGrantDigestMatches, isWellFormedBoundedGrantSemantics, type BoundedGrant } from '../../features/grant-runtime/index.js';
import {
  EXECUTION_CAPABILITY_LIMITS,
  isExecutionCapabilityIdentifier,
  isWellFormedExecutionCapability,
  parseExecutionCapability,
  serializeExecutionCapability,
  type ExecutionCapability,
} from '../execution-capability/capability.js';
import { computeDigest } from '../governance-store/digest.js';
import type { AuthoritySignatureVerification } from './signature-verification.js';

/**
 * G-02B — the **in-custody issuance rule** for `frontera.execution-capability.v1`.
 *
 * Every custody boundary runs it before it signs a capability: the software
 * signer in this process, the reference external service in its own. It is
 * the generic counterpart of TRADE-04C-S1's delegated-offer rule and follows
 * it point for point: the authority key signs a capability only for a grant
 * that the same key signed, and only for exactly what that grant names.
 *
 * ## What the custody boundary decides from its own state
 *
 * - **The grant.** It verifies the presented grant's signature under its own
 *   active key (never a registry the request could influence), the grant's own
 *   digest and semantic marker, and that the capability names that grant —
 *   through a reference it recomputes, so the grant's id, digest and store are
 *   all bound.
 * - **Its policy.** Issuer, organization, trust domain, lifetime and the closed
 *   audience registry come from the boundary's own frozen configuration
 *   (`createExecutionCapabilityIssuancePolicy`), never from the request. A Host
 *   cannot select another issuer, an unregistered audience, an action an
 *   audience is not registered for, or a binding format it does not accept.
 * - **The execution.** The execution id must be the one the governed path
 *   derives from the grant's own correlation (request and decision). A caller
 *   cannot attach a grant to an execution of its choosing.
 * - **Time.** The grant must be unexpired by the boundary's clock; the
 *   capability lives at most the configured lifetime (≤ 60 s), never past the
 *   grant, and starts neither before the grant nor away from the clock.
 *
 * ## What it does not decide
 *
 * **Current non-revocation.** The boundary sees the grant and its signature,
 * not the revocation state. Revocation is checked by the Host-side issuer
 * through the authenticated grant read (signed revocation state, and CORE-07
 * freshness where the deployment composes it) before it asks — as in S1. A
 * revocation committed after that read is bounded only by the capability
 * window; an offline executor never observes it.
 *
 * Nothing in the request is signed as given: the capability is re-read into a
 * frozen canonical record, every field is checked against an independent
 * source, and only `executionCapabilitySigningBytes` of that record is signed.
 */

/** The digest domain of the G-02B per-capability grant reference. Distinct from G-02A's per-grant domain (`…grant-reference.v1`), which stays as it was. */
export const EXECUTION_CAPABILITY_GRANT_REFERENCE_V2_DOMAIN = 'frontera.execution-capability.grant-reference.v2';

/** The governed-action execution-id derivation (`governed-action/identifiers.ts`), restated as data so this module imports nothing from the orchestration layer; a test pins the two equal. */
export const EXECUTION_CAPABILITY_EXECUTION_DERIVATION = Object.freeze({ tag: 'aoc.governed-action.execution.v1', prefix: 'aoc.exec:' });

const NONCE = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Whether `value` is a grant-reference nonce: 32 bytes, lowercase hex. */
export function isExecutionCapabilityGrantReferenceNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

/**
 * The capability-specific grant reference: `sha256:` over `aoc.canonical-json.v1`
 * of `{ domain, nonce, grantStoreId, boundedGrantId, grantDigest }`. The nonce
 * is 32 fresh random bytes per capability, kept by the Host in its issuance
 * record and sent to custody; it is never part of the capability.
 */
export function executionCapabilityGrantReferenceV2(input: { readonly nonce: string; readonly grantStoreId: string; readonly boundedGrantId: string; readonly grantDigest: string }): string {
  const { nonce, grantStoreId, boundedGrantId, grantDigest } = input;
  if (!isExecutionCapabilityGrantReferenceNonce(nonce) || !isExecutionCapabilityIdentifier(grantStoreId) || !isExecutionCapabilityIdentifier(boundedGrantId) || typeof grantDigest !== 'string' || !DIGEST.test(grantDigest)) {
    throw new TypeError('A grant reference needs a 32-byte hex nonce, a grant store id, a grant id and a sha256 grant digest.');
  }
  return computeDigest({ domain: EXECUTION_CAPABILITY_GRANT_REFERENCE_V2_DOMAIN, nonce, grantStoreId, boundedGrantId, grantDigest });
}

/** The execution id the governed path derives for this grant's request and decision. */
export function executionIdForGrant(grant: Pick<BoundedGrant, 'correlation'>): string {
  const { requestId, decisionId } = grant.correlation;
  const digest = createHash('sha256').update(JSON.stringify([EXECUTION_CAPABILITY_EXECUTION_DERIVATION.tag, requestId, decisionId]), 'utf8').digest('hex').slice(0, 32);
  return `${EXECUTION_CAPABILITY_EXECUTION_DERIVATION.prefix}${digest}`;
}

// ── The custody policy ──────────────────────────────────────────────────────

export interface ExecutionCapabilityAudienceRegistration {
  /** Exactly one executor. Never a pattern. */
  readonly audience: string;
  /** The governed actions a capability for this executor may name. */
  readonly actions: readonly string[];
  /** The action-binding formats this executor recomputes. */
  readonly bindingFormats: readonly string[];
}

/** What a custody boundary is configured to issue, and nothing more. Frozen when built. */
export interface ExecutionCapabilityIssuancePolicy {
  /** The deployment's issuer identity. Not a key id. */
  readonly issuer: string;
  /** The one organization this deployment serves. */
  readonly organizationId: string;
  readonly trustDomain: string;
  /** How long a capability lives: 1 … 60 000 ms. */
  readonly lifetimeMs: number;
  readonly audiences: readonly ExecutionCapabilityAudienceRegistration[];
}

export class ExecutionCapabilityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionCapabilityPolicyError';
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every((key) => typeof key === 'string' && keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}

/** An identifier that cannot be read as a pattern. */
function literal(value: unknown): value is string {
  return isExecutionCapabilityIdentifier(value) && !value.includes('*');
}

function distinctLiterals(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExecutionCapabilityPolicyError(`${where} must be a non-empty list.`);
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (!literal(item)) throw new ExecutionCapabilityPolicyError(`${where}[${index}] must be an exact identifier: no wildcard, no pattern, no control character.`);
    if (items.includes(item)) throw new ExecutionCapabilityPolicyError(`${where} names '${item}' twice.`);
    items.push(item);
  }
  return Object.freeze(items);
}

/**
 * Validates a policy and returns a frozen copy, or throws
 * `ExecutionCapabilityPolicyError`. Closed records only; every identifier is
 * exact; there is no default issuer, audience, action or binding format.
 */
export function createExecutionCapabilityIssuancePolicy(input: unknown): ExecutionCapabilityIssuancePolicy {
  if (!exactRecord(input, ['issuer', 'organizationId', 'trustDomain', 'lifetimeMs', 'audiences'])) {
    throw new ExecutionCapabilityPolicyError('The execution capability issuance policy is exactly { issuer, organizationId, trustDomain, lifetimeMs, audiences }.');
  }
  const { issuer, organizationId, trustDomain, lifetimeMs, audiences } = input;
  if (!literal(issuer)) throw new ExecutionCapabilityPolicyError('The execution capability issuer must be an exact identifier.');
  if (!literal(organizationId)) throw new ExecutionCapabilityPolicyError('The execution capability organization must be an exact identifier.');
  if (!literal(trustDomain)) throw new ExecutionCapabilityPolicyError('The execution capability trust domain must be an exact identifier.');
  if (typeof lifetimeMs !== 'number' || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > EXECUTION_CAPABILITY_LIMITS.maximumLifetimeMs) {
    throw new ExecutionCapabilityPolicyError(`The execution capability lifetime must be an integer from 1 to ${EXECUTION_CAPABILITY_LIMITS.maximumLifetimeMs} ms.`);
  }
  if (!Array.isArray(audiences) || audiences.length === 0) throw new ExecutionCapabilityPolicyError('The execution capability policy registers at least one audience.');
  const registrations: ExecutionCapabilityAudienceRegistration[] = [];
  for (let index = 0; index < audiences.length; index += 1) {
    const entry: unknown = audiences[index];
    const where = `audiences[${index}]`;
    if (!exactRecord(entry, ['audience', 'actions', 'bindingFormats'])) throw new ExecutionCapabilityPolicyError(`${where} is exactly { audience, actions, bindingFormats }.`);
    if (!literal(entry['audience'])) throw new ExecutionCapabilityPolicyError(`${where}.audience must be an exact identifier: one executor, never a pattern.`);
    const audience = entry['audience'];
    if (registrations.some((registration) => registration.audience === audience)) throw new ExecutionCapabilityPolicyError(`${where} registers audience '${audience}' a second time.`);
    registrations.push(Object.freeze({ audience, actions: distinctLiterals(entry['actions'], `${where}.actions`), bindingFormats: distinctLiterals(entry['bindingFormats'], `${where}.bindingFormats`) }));
  }
  return Object.freeze({ issuer, organizationId, trustDomain, lifetimeMs, audiences: Object.freeze(registrations) });
}

// ── The rule ────────────────────────────────────────────────────────────────

export const EXECUTION_CAPABILITY_ISSUANCE_FAILURES = [
  'CAPABILITY_MALFORMED',
  'CAPABILITY_ISSUER_MISMATCH',
  'CAPABILITY_ORGANIZATION_MISMATCH',
  'CAPABILITY_TRUST_DOMAIN_MISMATCH',
  /** Not single-use, not offline-permitted, or naming an on-behalf-of actor: none is issuable in G-02B. */
  'CAPABILITY_TERMS_UNSUPPORTED',
  'AUDIENCE_NOT_REGISTERED',
  'AUDIENCE_ACTION_NOT_PERMITTED',
  'AUDIENCE_BINDING_FORMAT_NOT_PERMITTED',
  'GRANT_MALFORMED',
  'GRANT_SIGNATURE_INVALID',
  'GRANT_REFERENCE_MISMATCH',
  'GRANT_ORGANIZATION_MISMATCH',
  'GRANT_SUBJECT_MISMATCH',
  'GRANT_ACTION_MISMATCH',
  'GRANT_RESOURCE_MISMATCH',
  'EXECUTION_DERIVATION_MISMATCH',
  'GRANT_EXPIRED',
  'CAPABILITY_TIME_INVALID',
] as const;
export type ExecutionCapabilityIssuanceFailure = (typeof EXECUTION_CAPABILITY_ISSUANCE_FAILURES)[number];

export interface ExecutionCapabilityIssuanceRequest {
  /** The capability to sign. Re-read into a frozen canonical record before anything is checked. */
  readonly capability: ExecutionCapability;
  /** The grant as filed in the store named by `storeId`, and the authority signature it is filed with. */
  readonly grant: BoundedGrant;
  readonly storeId: string;
  readonly grantSignature: unknown;
  /** The capability's grant-reference nonce. Never part of the capability. */
  readonly grantReferenceNonce: string;
}

export interface ExecutionCapabilityIssuanceContext {
  /** Verifies the grant under the custody boundary's **own** key — never a registry the request could influence. */
  readonly verifyGrant: (grant: BoundedGrant, storeId: string, signature: unknown) => AuthoritySignatureVerification;
  /** The key id this custody boundary signs as. */
  readonly activeKeyId: string;
  /** The custody boundary's own policy. */
  readonly policy: ExecutionCapabilityIssuancePolicy;
  /** The custody boundary's clock, ms since the epoch. */
  readonly now: number;
}

export type ExecutionCapabilityIssuanceAssessment =
  | { readonly issuable: true; readonly capability: ExecutionCapability; readonly canonical: string }
  | { readonly issuable: false; readonly failure: ExecutionCapabilityIssuanceFailure };

function boundIncludes(bound: BoundedGrant['scope']['resources'], value: string): boolean {
  if (bound === undefined) return true;
  if (bound.kind === 'identity') return bound.value === value;
  if (bound.kind === 'set') return bound.values.includes(value);
  return false;
}

/** A frozen canonical copy of `value`, or `undefined` when it has no canonical form. What is checked is what is signed. */
function canonicalCopy(value: unknown): { readonly capability: ExecutionCapability; readonly canonical: string } | undefined {
  if (!isWellFormedExecutionCapability(value)) return undefined;
  const canonical = serializeExecutionCapability(value);
  const parsed = parseExecutionCapability(canonical);
  return parsed.ok ? { capability: parsed.capability, canonical } : undefined;
}

/**
 * Whether the authority may sign `request.capability`. Pure; refuses with one
 * closed reason, or accepts with the frozen canonical record to sign. Run by
 * every `AuthorityArtifactSigner` implementation before it signs a capability,
 * and by the Host-side issuer before it asks.
 */
export function assessExecutionCapabilityIssuance(request: ExecutionCapabilityIssuanceRequest, context: ExecutionCapabilityIssuanceContext): ExecutionCapabilityIssuanceAssessment {
  const refuse = (failure: ExecutionCapabilityIssuanceFailure): ExecutionCapabilityIssuanceAssessment => ({ issuable: false, failure });
  const { policy } = context;
  const copy = canonicalCopy(request?.capability);
  if (copy === undefined) return refuse('CAPABILITY_MALFORMED');
  const capability = copy.capability;
  if (capability.issuerKeyId !== context.activeKeyId || capability.issuer !== policy.issuer) return refuse('CAPABILITY_ISSUER_MISMATCH');
  if (capability.organizationId !== policy.organizationId) return refuse('CAPABILITY_ORGANIZATION_MISMATCH');
  if (capability.trustDomain !== policy.trustDomain) return refuse('CAPABILITY_TRUST_DOMAIN_MISMATCH');
  if (capability.consumption !== 'single-use' || capability.statusRequirement !== 'offline-permitted' || capability.onBehalfOfActorId !== null) return refuse('CAPABILITY_TERMS_UNSUPPORTED');
  const registration = policy.audiences.find((entry) => entry.audience === capability.audience);
  if (registration === undefined) return refuse('AUDIENCE_NOT_REGISTERED');
  if (!registration.actions.includes(capability.action)) return refuse('AUDIENCE_ACTION_NOT_PERMITTED');
  if (!registration.bindingFormats.includes(capability.actionBinding.format)) return refuse('AUDIENCE_BINDING_FORMAT_NOT_PERMITTED');

  const { grant, storeId } = request;
  if (grant === null || typeof grant !== 'object' || typeof grant.id !== 'string' || grant.scope === null || typeof grant.scope !== 'object' || grant.correlation === null || typeof grant.correlation !== 'object') return refuse('GRANT_MALFORMED');
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
  let reference: string;
  try {
    reference = executionCapabilityGrantReferenceV2({ nonce: request.grantReferenceNonce, grantStoreId: storeId, boundedGrantId: grant.id, grantDigest: grant.digest });
  } catch {
    return refuse('GRANT_REFERENCE_MISMATCH');
  }
  if (capability.grantReference !== reference) return refuse('GRANT_REFERENCE_MISMATCH');
  const organization = grant.scope.organization;
  if (organization?.kind !== 'identity' || organization.value !== policy.organizationId) return refuse('GRANT_ORGANIZATION_MISMATCH');
  if (capability.subjectActorId !== grant.subject) return refuse('GRANT_SUBJECT_MISMATCH');
  const action = grant.scope.action;
  if (capability.action !== grant.correlation.action || (action !== undefined && (action.kind !== 'identity' || action.value !== capability.action))) return refuse('GRANT_ACTION_MISMATCH');
  if (capability.resource !== grant.correlation.resourceScope || !boundIncludes(grant.scope.resources, capability.resource)) return refuse('GRANT_RESOURCE_MISMATCH');
  if (capability.executionId !== executionIdForGrant(grant)) return refuse('EXECUTION_DERIVATION_MISMATCH');

  const grantIssuedAt = Date.parse(grant.issuedAt);
  const grantExpiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(context.now) || !Number.isFinite(grantIssuedAt) || !Number.isFinite(grantExpiresAt) || !(context.now < grantExpiresAt)) return refuse('GRANT_EXPIRED');
  const issuedAt = Date.parse(capability.issuedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  if (Math.abs(issuedAt - context.now) > EXECUTION_CAPABILITY_LIMITS.maximumClockSkewMs) return refuse('CAPABILITY_TIME_INVALID');
  if (!(expiresAt > issuedAt) || expiresAt - issuedAt > Math.min(policy.lifetimeMs, EXECUTION_CAPABILITY_LIMITS.maximumLifetimeMs)) return refuse('CAPABILITY_TIME_INVALID');
  if (expiresAt > grantExpiresAt || issuedAt < grantIssuedAt) return refuse('CAPABILITY_TIME_INVALID');
  return { issuable: true, capability, canonical: copy.canonical };
}
