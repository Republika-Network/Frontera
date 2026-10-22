import { createPrivateKey, randomBytes, sign } from 'node:crypto';

import { AUTHORITY_ARTIFACT_VERSION, AUTHORITY_SIGNING_DOMAINS, type AuthoritySignature } from '../authority-authenticity/index.js';
import {
  EXECUTION_CAPABILITY_FORMAT,
  createExecutionCapabilityVerifier,
  executionCapabilityActionBindingDigest,
  executionCapabilityGrantReference,
  executionCapabilitySigningBytes,
  serializeExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityTrustedIssuer,
  type ExecutionCapabilityVerifier,
  type ExecutionCapabilityVerifierOptions,
} from '../execution-capability/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';

/**
 * G-02A fixtures. Capabilities are signed here, in the test, with the key
 * fixture's private half: G-02A ships no signing operation for them (in-custody
 * issuance is G-02B), so the only signer of a capability is a test.
 */

export const G02A_ISSUER = 'frontera-deployment-eu-1';
export const G02A_OTHER_ISSUER = 'frontera-deployment-us-1';
export const G02A_ORGANIZATION = 'org-g02a';
export const G02A_TRUST_DOMAIN = 'trust-domain-g02a';
export const G02A_AUDIENCE = 'executor-devops-gateway';
export const G02A_ACTION = 'deploy-release';
export const G02A_RESOURCE = 'production-cluster-eu';
export const G02A_BINDING_FORMAT = 'frontera.http-request-binding.v1';

/** The fixed instant every fixture verifier reads, unless a test supplies its own clock. */
export const NOW = Date.parse('2026-10-22T12:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

/** The exact request the executor is about to perform — what its binding digest is computed from. */
export function bindingValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'PATCH',
    path: '/deployments/production-cluster-eu',
    query: { strategy: 'rolling' },
    headers: { 'x-replica-count': '4' },
    body: { strategy: 'rolling', replicas: 4, requestId: 'deploy-7' },
    ...overrides,
  };
}

export const GRANT_REFERENCE = executionCapabilityGrantReference({ grantStoreId: 'grant-store-g02a', boundedGrantId: 'aoc.grant:0123456789abcdef', grantDigest: `sha256:${'1'.repeat(64)}` });

export function capabilityFor(overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}, key: TestAuthorityKey = AUTHORITY_KEY_A): ExecutionCapability {
  return {
    format: EXECUTION_CAPABILITY_FORMAT,
    capabilityId: randomBytes(32).toString('hex'),
    issuer: G02A_ISSUER,
    issuerKeyId: key.keyId,
    organizationId: G02A_ORGANIZATION,
    trustDomain: G02A_TRUST_DOMAIN,
    audience: G02A_AUDIENCE,
    subjectActorId: 'agent:release-bot',
    onBehalfOfActorId: null,
    action: G02A_ACTION,
    resource: G02A_RESOURCE,
    actionBinding: { format: G02A_BINDING_FORMAT, digest: executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value: bindingValue() }) },
    executionId: `aoc.exec:${randomBytes(16).toString('hex')}`,
    grantReference: GRANT_REFERENCE,
    consumption: 'single-use',
    statusRequirement: 'offline-permitted',
    issuedAt: iso(NOW - 1_000),
    expiresAt: iso(NOW + 29_000),
    ...overrides,
  } as ExecutionCapability;
}

function envelope(bytes: Buffer, key: TestAuthorityKey, keyId: string = key.keyId): AuthoritySignature {
  return { algorithm: 'ed25519-v1', keyId, signature: sign(null, bytes, createPrivateKey(key.privateKeyPem)).toString('base64url'), artifactVersion: AUTHORITY_ARTIFACT_VERSION };
}

/** A CORE-02 envelope over the capability's real signing bytes (domain + canonical text). */
export function signCapability(capability: ExecutionCapability, key: TestAuthorityKey = AUTHORITY_KEY_A, keyId?: string): AuthoritySignature {
  return envelope(executionCapabilitySigningBytes(capability), key, keyId);
}

/** A CORE-02 envelope over the execution-capability domain followed by **arbitrary** text — how an attacker would sign a non-canonical spelling. */
export function signText(text: string, key: TestAuthorityKey = AUTHORITY_KEY_A, domain: string = AUTHORITY_SIGNING_DOMAINS.executionCapability): AuthoritySignature {
  return envelope(Buffer.from(`${domain}${text}`, 'utf8'), key);
}

/** The same canonical text with one space after its opening brace: the smallest non-canonical spelling of a capability. */
export function respaced(canonical: string): string {
  if (!canonical.startsWith('{')) throw new Error('a canonical capability starts with an opening brace');
  return `{ ${canonical.slice(1)}`;
}

export function present(capability: ExecutionCapability, key: TestAuthorityKey = AUTHORITY_KEY_A): { readonly capability: string; readonly signature: AuthoritySignature } {
  return { capability: serializeExecutionCapability(capability), signature: signCapability(capability, key) };
}

export function issuerPinning(keys: readonly TestAuthorityKey[] = [AUTHORITY_KEY_A, AUTHORITY_KEY_B], issuer: string = G02A_ISSUER): ExecutionCapabilityTrustedIssuer {
  return { issuer, keys: keys.map(trustedKeyOf) };
}

export function verifierFor(options: Partial<ExecutionCapabilityVerifierOptions> = {}): ExecutionCapabilityVerifier {
  return createExecutionCapabilityVerifier({
    trustedIssuers: [issuerPinning()],
    executor: { audience: G02A_AUDIENCE, organizationIds: [G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN },
    clock: () => NOW,
    ...options,
  });
}

/** The verification request an honest executor builds for the fixture deployment, with a presentation. */
export function requestFor(presentation: unknown, overrides: { readonly action?: string; readonly resource?: string; readonly format?: string; readonly value?: unknown } = {}) {
  return {
    presentation,
    action: overrides.action ?? G02A_ACTION,
    resource: overrides.resource ?? G02A_RESOURCE,
    actionBinding: { format: overrides.format ?? G02A_BINDING_FORMAT, value: 'value' in overrides ? overrides.value : bindingValue() },
  };
}
