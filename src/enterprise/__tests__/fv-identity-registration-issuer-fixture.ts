import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/signature-envelope.js';
import { EXECUTION_CAPABILITY_FORMAT, executionCapabilityActionBindingDigest, executionCapabilitySigningBytes, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/index.js';
import { FV_IDENTITY_REGISTRATION_ACTIONS, fvIdentityRegistrationBinding, fvIdentityRegistrationResource, type FvIdentityRegistrationBindingValue, type FvIdentityRegistrationOperation } from '../sovereign-status-history/identity-registration.js';
import { FV_FIRST_ADMINISTRATOR_ACTIONS, fvFirstAdministratorBinding, type FvFirstAdministratorBindingValue, type FvFirstAdministratorOperation } from '../sovereign-status-history/identity-registration-first-administrator.js';

/**
 * FV-P4C-2B3C-2A1 — a **TEST-ONLY** registration authority. It signs G-02A capabilities for the FV identity
 * registration ceremony with a key generated per process, never checked in, never trusted by any production
 * path (nothing outside the tests imports this file; a structure test pins it). No production issuer exists:
 * a deployment's issuance would go through G-02B's in-custody rule, from a governed grant, which no FV
 * registration action is registered for.
 */

function generate(keyId: string): { readonly keyId: string; readonly algorithm: 'ed25519-v1'; readonly privateKeyPem: string; readonly publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { keyId, algorithm: 'ed25519-v1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export type TestIssuerKey = ReturnType<typeof generate>;

export const TEST_REGISTRATION_ISSUER = 'issuer:test-only-fv-registration-authority';
export const TEST_REGISTRATION_ISSUER_KEY = generate('test-only-fv-registration-key-1');
/** Never pinned anywhere: the attacker's key. */
export const UNTRUSTED_REGISTRATION_KEY = generate('test-only-fv-registration-key-1');
export const OTHER_ISSUER = 'issuer:test-only-other-authority';
export const OTHER_ISSUER_KEY = generate('test-only-other-authority-key');

export function trustedRegistrationIssuers(entries: readonly { readonly issuer: string; readonly key: TestIssuerKey }[] = [{ issuer: TEST_REGISTRATION_ISSUER, key: TEST_REGISTRATION_ISSUER_KEY }]) {
  return entries.map(({ issuer, key }) => ({ issuer, keys: [{ keyId: key.keyId, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem }] }));
}

export const newRegistrationId = (): string => `fvreg-${randomBytes(16).toString('hex')}`;
export const newStoreId = (): string => `human-identity-store:${randomUUID()}`;

export interface IssueOptions {
  readonly operation: FvIdentityRegistrationOperation;
  readonly binding: Omit<FvIdentityRegistrationBindingValue, 'operation'>;
  readonly audience: string;
  readonly trustDomain: string;
  readonly organizationId?: string;
  readonly issuer?: string;
  readonly key?: TestIssuerKey;
  readonly issuedAtMs?: number;
  readonly lifetimeMs?: number;
  readonly executionId?: string;
  /** Applied to the capability record before it is signed (a mis-issued capability). */
  readonly overrides?: Partial<Record<keyof ExecutionCapability, unknown>>;
}

/** Signs one capability exactly as a G-02A issuer would: canonical text, CORE-02 envelope over the domain-separated bytes. */
export function issueRegistrationCapability(options: IssueOptions): { readonly presentation: { readonly capability: string; readonly signature: unknown }; readonly capability: ExecutionCapability } {
  const issuedAt = options.issuedAtMs ?? Date.now();
  const key = options.key ?? TEST_REGISTRATION_ISSUER_KEY;
  const binding = fvIdentityRegistrationBinding({ operation: options.operation, ...options.binding });
  const organizationId = options.organizationId ?? options.binding.organizationId;
  const capability = {
    format: EXECUTION_CAPABILITY_FORMAT,
    capabilityId: randomBytes(32).toString('hex'),
    issuer: options.issuer ?? TEST_REGISTRATION_ISSUER,
    issuerKeyId: key.keyId,
    organizationId,
    trustDomain: options.trustDomain,
    audience: options.audience,
    subjectActorId: 'operator:test-registration-officer',
    onBehalfOfActorId: null,
    action: FV_IDENTITY_REGISTRATION_ACTIONS[options.operation],
    resource: fvIdentityRegistrationResource(organizationId),
    actionBinding: { format: binding.format, digest: executionCapabilityActionBindingDigest(binding) },
    executionId: options.executionId ?? (options.operation === 'register' ? options.binding.registrationId : `${options.binding.registrationId}:resume:${randomBytes(8).toString('hex')}`),
    grantReference: `sha256:${randomBytes(32).toString('hex')}`,
    consumption: 'single-use',
    statusRequirement: 'offline-permitted',
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + (options.lifetimeMs ?? 30_000)).toISOString(),
    ...(options.overrides ?? {}),
  } as ExecutionCapability;
  const text = serializeExecutionCapability(capability);
  const signature = sign(null, executionCapabilitySigningBytes(capability), createPrivateKey(key.privateKeyPem)).toString('base64url');
  return { presentation: { capability: text, signature: { algorithm: key.algorithm, keyId: key.keyId, signature, artifactVersion: AUTHORITY_ARTIFACT_VERSION } }, capability };
}

export const newEnrollmentId = (): string => `fvadm-${randomBytes(16).toString('hex')}`;

export interface FirstAdministratorIssueOptions extends Omit<IssueOptions, 'operation' | 'binding'> {
  readonly operation: FvFirstAdministratorOperation;
  readonly binding: Omit<FvFirstAdministratorBindingValue, 'operation'>;
}

/**
 * FV-P4C-2B3C-2A2A — TEST-ONLY: signs a first-administrator capability (enrol or resume) as the same test-only
 * registration authority would. The enrol capability's execution id is the enrolment id; a resume's is its own.
 */
export function issueFirstAdministratorCapability(options: FirstAdministratorIssueOptions): { readonly presentation: { readonly capability: string; readonly signature: unknown }; readonly capability: ExecutionCapability } {
  const issuedAt = options.issuedAtMs ?? Date.now();
  const key = options.key ?? TEST_REGISTRATION_ISSUER_KEY;
  const binding = fvFirstAdministratorBinding({ operation: options.operation, ...options.binding });
  const organizationId = options.organizationId ?? options.binding.organizationId;
  const capability = {
    format: EXECUTION_CAPABILITY_FORMAT,
    capabilityId: randomBytes(32).toString('hex'),
    issuer: options.issuer ?? TEST_REGISTRATION_ISSUER,
    issuerKeyId: key.keyId,
    organizationId,
    trustDomain: options.trustDomain,
    audience: options.audience,
    subjectActorId: 'operator:test-registration-officer',
    onBehalfOfActorId: null,
    action: FV_FIRST_ADMINISTRATOR_ACTIONS[options.operation],
    resource: fvIdentityRegistrationResource(organizationId),
    actionBinding: { format: binding.format, digest: executionCapabilityActionBindingDigest(binding) },
    executionId: options.executionId ?? (options.operation === 'enroll' ? options.binding.enrollmentId : `${options.binding.enrollmentId}:resume:${randomBytes(8).toString('hex')}`),
    grantReference: `sha256:${randomBytes(32).toString('hex')}`,
    consumption: 'single-use',
    statusRequirement: 'offline-permitted',
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + (options.lifetimeMs ?? 30_000)).toISOString(),
    ...(options.overrides ?? {}),
  } as ExecutionCapability;
  const text = serializeExecutionCapability(capability);
  const signature = sign(null, executionCapabilitySigningBytes(capability), createPrivateKey(key.privateKeyPem)).toString('base64url');
  return { presentation: { capability: text, signature: { algorithm: key.algorithm, keyId: key.keyId, signature, artifactVersion: AUTHORITY_ARTIFACT_VERSION } }, capability };
}
