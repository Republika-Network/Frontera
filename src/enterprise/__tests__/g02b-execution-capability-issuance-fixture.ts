import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundedGrantDigest, boundedGrantId, type BoundedGrant, type GrantScope } from '../../features/grant-runtime/index.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  createExecutionCapabilityIssuancePolicy,
  createSoftwareAuthorityArtifactSigner,
  executionCapabilityGrantReferenceV2,
  executionIdForGrant,
  type AuthorityArtifactSigner,
  type AuthoritySignature,
  type ExecutionCapabilityIssuancePolicy,
  type ExecutionCapabilityIssuanceRequest,
} from '../authority-authenticity/index.js';
import { EXECUTION_CAPABILITY_FORMAT, executionCapabilityActionBindingDigest, executionCapabilitySigningBytes, type ExecutionCapability } from '../execution-capability/index.js';
import { openExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuanceLedger, type ExecutionCapabilitySignedGrantReader } from '../execution-capability-issuance/index.js';
import { AUTHORITY_KEY_A, testSigner, type TestAuthorityKey } from './authority-authenticity-fixture.js';

/**
 * G-02B fixtures — test-only, offline. Grants are real Ed25519-signed bounded
 * grants (`testSigner(key).signGrant`), shaped exactly as the governed path
 * issues them: correlation and scope agree on action, resource and
 * organization, and the execution id is derived from the correlation.
 * Capabilities are produced by the real issuance rule and signers; the one
 * helper that signs capability bytes directly (`signCapabilityBytes`) exists to
 * model a forger or a compromised custody boundary.
 */

export const G02B_ISSUER = 'frontera-deployment-g02b';
export const G02B_ORGANIZATION = 'org-g02b';
export const G02B_TRUST_DOMAIN = 'trust-domain-g02b';
export const G02B_AUDIENCE = 'executor-devops-gateway';
export const G02B_OTHER_AUDIENCE = 'executor-data-worker';
export const G02B_ACTION = 'deploy-release';
export const G02B_RESOURCE = 'production-cluster-eu';
export const G02B_BINDING_FORMAT = 'frontera.http-request-binding.v1';
export const G02B_STORE = 'grant-store-g02b';
export const G02B_SUBJECT = 'actor-release-bot';

export const NOW = Date.parse('2026-10-22T12:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export function policyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: G02B_ISSUER,
    organizationId: G02B_ORGANIZATION,
    trustDomain: G02B_TRUST_DOMAIN,
    lifetimeMs: 30_000,
    audiences: [
      { audience: G02B_AUDIENCE, actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] },
      { audience: G02B_OTHER_AUDIENCE, actions: [G02B_ACTION, 'export-records'], bindingFormats: [G02B_BINDING_FORMAT] },
    ],
    ...overrides,
  };
}

export const POLICY: ExecutionCapabilityIssuancePolicy = createExecutionCapabilityIssuancePolicy(policyInput());

/** A software custody boundary for `key`, configured with `policy` (and the fixed test clock unless one is given). */
export function custodySigner(key: TestAuthorityKey = AUTHORITY_KEY_A, policy: unknown = policyInput(), now: () => number = () => NOW): AuthorityArtifactSigner {
  return createSoftwareAuthorityArtifactSigner({ keyId: key.keyId, algorithm: key.algorithm, privateKeyPem: key.privateKeyPem, now, executionCapabilityIssuance: policy });
}

export const bindingDigest = (value: unknown = { method: 'PATCH', path: '/deployments/production-cluster-eu', body: { replicas: 4 } }): string =>
  executionCapabilityActionBindingDigest({ format: G02B_BINDING_FORMAT, value });

/** A governed-path-shaped bounded grant, with its own digest. */
export function grantFor(options: { readonly requestId?: string; readonly decisionId?: string; readonly action?: string; readonly resource?: string; readonly organizationId?: string | null; readonly subject?: string; readonly issuedAt?: number; readonly expiresAt?: number; readonly scope?: Partial<GrantScope> } = {}): BoundedGrant {
  const action = options.action ?? G02B_ACTION;
  const resource = options.resource ?? G02B_RESOURCE;
  const correlation = { requestId: options.requestId ?? `aoc.gar:${randomBytes(16).toString('hex')}`, decisionId: options.decisionId ?? `dec-${randomBytes(8).toString('hex')}`, action, resourceScope: resource };
  const scope: GrantScope = {
    action: { kind: 'identity', value: action },
    ...(options.organizationId === null ? {} : { organization: { kind: 'identity' as const, value: options.organizationId ?? G02B_ORGANIZATION } }),
    resources: { kind: 'set', values: [resource] },
    ...options.scope,
  };
  const subject = options.subject ?? G02B_SUBJECT;
  const issuedAt = iso(options.issuedAt ?? NOW - 60_000);
  const expiresAt = iso(options.expiresAt ?? NOW + 3_600_000);
  const draft = { id: boundedGrantId({ correlation, subject, scope, expiresAt }), correlation, subject, scope, issuedAt, expiresAt, sourceDigest: `sha256:${'e'.repeat(64)}` };
  return Object.freeze({ ...draft, digest: boundedGrantDigest(draft) });
}

export interface SignedGrant {
  readonly grant: BoundedGrant;
  readonly storeId: string;
  readonly signature: AuthoritySignature;
}

export async function signedGrant(options: Parameters<typeof grantFor>[0] & { readonly key?: TestAuthorityKey; readonly storeId?: string } = {}): Promise<SignedGrant> {
  const grant = grantFor(options);
  const storeId = options.storeId ?? G02B_STORE;
  return { grant, storeId, signature: await testSigner(options.key ?? AUTHORITY_KEY_A).signGrant(grant, storeId) };
}

/** The capability the issuer would assemble for `signed`, with `overrides` applied, and the nonce its reference was derived from. */
export function capabilityFor(signed: SignedGrant, overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}, options: { readonly key?: TestAuthorityKey; readonly nonce?: string; readonly now?: number; readonly lifetimeMs?: number } = {}): { readonly capability: ExecutionCapability; readonly nonce: string } {
  const nonce = options.nonce ?? randomBytes(32).toString('hex');
  const now = options.now ?? NOW;
  const capability = {
    format: EXECUTION_CAPABILITY_FORMAT,
    capabilityId: randomBytes(32).toString('hex'),
    issuer: G02B_ISSUER,
    issuerKeyId: (options.key ?? AUTHORITY_KEY_A).keyId,
    organizationId: G02B_ORGANIZATION,
    trustDomain: G02B_TRUST_DOMAIN,
    audience: G02B_AUDIENCE,
    subjectActorId: signed.grant.subject,
    onBehalfOfActorId: null,
    action: signed.grant.correlation.action,
    resource: signed.grant.correlation.resourceScope,
    actionBinding: { format: G02B_BINDING_FORMAT, digest: bindingDigest() },
    executionId: executionIdForGrant(signed.grant),
    grantReference: executionCapabilityGrantReferenceV2({ nonce, grantStoreId: signed.storeId, boundedGrantId: signed.grant.id, grantDigest: signed.grant.digest }),
    consumption: 'single-use',
    statusRequirement: 'offline-permitted',
    issuedAt: iso(now),
    expiresAt: iso(now + (options.lifetimeMs ?? 30_000)),
    ...overrides,
  } as ExecutionCapability;
  return { capability, nonce };
}

export function requestFor(signed: SignedGrant, overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}, options: Parameters<typeof capabilityFor>[2] = {}): ExecutionCapabilityIssuanceRequest {
  const { capability, nonce } = capabilityFor(signed, overrides, options);
  return { capability, grant: signed.grant, storeId: signed.storeId, grantSignature: signed.signature, grantReferenceNonce: nonce };
}

/** A CORE-02 envelope over a capability's real signing bytes, by `key` directly — a forger's (or a compromised custody boundary's) signature. */
export function signCapabilityBytes(capability: ExecutionCapability, key: TestAuthorityKey = AUTHORITY_KEY_A): AuthoritySignature {
  return { algorithm: 'ed25519-v1', keyId: key.keyId, signature: cryptoSign(null, executionCapabilitySigningBytes(capability), createPrivateKey(key.privateKeyPem)).toString('base64url'), artifactVersion: AUTHORITY_ARTIFACT_VERSION };
}

/** An authenticated-read double over a fixed set of signed grants (and revocations). The durable store's own read is qualified separately. */
export function readerOf(grants: readonly SignedGrant[], revoked: readonly string[] = []): ExecutionCapabilitySignedGrantReader & { reads: number } {
  const reader = {
    reads: 0,
    async readSigned(grantId: string) {
      reader.reads += 1;
      const found = grants.find((entry) => entry.grant.id === grantId);
      if (found === undefined) return { storeId: G02B_STORE };
      return {
        storeId: found.storeId,
        grant: found.grant,
        signature: found.signature,
        ...(revoked.includes(grantId) ? { revocation: { grantId, revokedAt: iso(NOW - 1), reason: 'administrator-revoked' as const, issuerRef: 'operator:g02b' } } : {}),
      };
    },
  };
  return reader;
}

export class LedgerDirectory {
  readonly dir = mkdtempSync(join(tmpdir(), 'aoc-g02b-issuance-'));
  private files = 0;
  private readonly open: ExecutionCapabilityIssuanceLedger[] = [];

  path(): string {
    this.files += 1;
    return join(this.dir, `issuance-${this.files}.sqlite`);
  }

  async create(path: string = this.path(), options: { readonly issuer?: string; readonly clock?: () => number } = {}): Promise<ExecutionCapabilityIssuanceLedger> {
    return this.track(await openExecutionCapabilityIssuanceLedger(path, { issuer: options.issuer ?? G02B_ISSUER, clock: options.clock ?? (() => NOW), create: true }));
  }

  async reopen(path: string, options: { readonly issuer?: string; readonly clock?: () => number } = {}): Promise<ExecutionCapabilityIssuanceLedger> {
    return this.track(await openExecutionCapabilityIssuanceLedger(path, { issuer: options.issuer ?? G02B_ISSUER, clock: options.clock ?? (() => NOW) }));
  }

  track(ledger: ExecutionCapabilityIssuanceLedger): ExecutionCapabilityIssuanceLedger {
    this.open.push(ledger);
    return ledger;
  }

  cleanup(): void {
    for (const ledger of this.open) ledger.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The issuance input an in-process G-02C caller would pass for `signed`. */
export function inputFor(signed: Pick<SignedGrant, 'grant'>, overrides: Record<string, unknown> = {}) {
  return {
    executionId: executionIdForGrant(signed.grant),
    boundedGrantId: signed.grant.id,
    audience: G02B_AUDIENCE,
    action: signed.grant.correlation.action,
    resource: signed.grant.correlation.resourceScope,
    actionBinding: { format: G02B_BINDING_FORMAT, digest: bindingDigest() },
    ...overrides,
  };
}
