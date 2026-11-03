import { createPublicKey } from 'node:crypto';

import { conformanceDigest } from './canonical.js';
import {
  SYNTHETIC_OPERATOR_STATEMENT,
  compareSemver,
  isDigest,
  isIdentifier,
  isSemver,
  isTimestamp,
  readClosed,
  toMs,
  type IntegrationVersionRecord,
  type PlatformRecord,
  type ValidatorEnrollmentRecord,
  type ValidatorOperatorRecord,
} from './contracts.js';
import { verifyTwoPersonAuthority, type SyntheticHumanDirectory } from './human-authority.js';
import { profileKey, sdkSupported, type ConformanceProfileDefinition, type ConformanceProfileRegistry } from './profile.js';
import type { ConformanceStore, ConsumedDecision } from './sqlite-conformance-store.js';
import { ConformanceStoreError } from './sqlite-conformance-store.js';
import { deriveConformanceKeyId } from './signing.js';

/**
 * RN-CONFORM-02 / WP-03, WP-04 — append-only registration of synthetic
 * platforms, integration versions, validator operators and validators.
 *
 * Integration identity is immutable once accepted: a version is a new record
 * with a new digest, never an edit. A different integration version never
 * inherits another version's evidence, because every challenge, observation
 * and credential is keyed by the exact `integrationDigest`.
 */

export interface ConformanceClock {
  now(): string;
}

/** Validator enrollment is a network-level act; its approvers belong to this synthetic organization. */
export const CONFORMANCE_NETWORK_ORGANIZATION = 'rn-synthetic-validator-network';

export type RegistryRefusal =
  | 'MALFORMED_INPUT'
  | 'UNKNOWN_PLATFORM'
  | 'CROSS_TENANT'
  | 'UNKNOWN_PROFILE'
  | 'PROFILE_DIGEST_MISMATCH'
  | 'PROFILE_DOWNGRADE'
  | 'UNSUPPORTED_SDK'
  | 'SDK_DOWNGRADE'
  | 'VERSION_CONFLICT'
  | 'DUPLICATE_CONFLICT'
  | 'NOT_SYNTHETIC'
  | 'UNKNOWN_OPERATOR'
  | 'KEY_ID_MISMATCH'
  | 'KEY_NOT_PUBLIC'
  | 'KEY_REUSED'
  | 'VALIDATOR_CONFLICT'
  | 'APPROVAL_REFUSED';

export class ConformanceRegistryError extends Error {
  readonly code: RegistryRefusal;
  readonly detail: string;
  constructor(code: RegistryRefusal, detail = '') {
    super(`Conformance registry refused: ${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'ConformanceRegistryError';
    this.code = code;
    this.detail = detail;
  }
}

export interface IntegrationVersionInput {
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly platformId: string;
  readonly organizationId: string;
  readonly sdk: { readonly package: string; readonly version: string; readonly lockDigest: string };
  readonly adapter: { readonly name: string; readonly version: string; readonly digest: string };
  readonly deploymentDigest: string;
  readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
  readonly coveredOperations: readonly string[];
  readonly declaredExclusions: readonly { readonly operation: string; readonly reason: string }[];
  readonly testEndpoints: readonly { readonly endpointId: string; readonly environment: 'synthetic'; readonly fixtureRef: string }[];
}

const OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;

function checkIntegrationInput(input: unknown): IntegrationVersionInput {
  const top = readClosed(input, ['integrationId', 'integrationVersion', 'platformId', 'organizationId', 'sdk', 'adapter', 'deploymentDigest', 'profile', 'coveredOperations', 'declaredExclusions', 'testEndpoints']);
  if (!top.ok) throw new ConformanceRegistryError('MALFORMED_INPUT', `${top.reason}:${top.field}`);
  const r = top.record;
  const sdk = readClosed(r['sdk'], ['package', 'version', 'lockDigest']);
  const adapter = readClosed(r['adapter'], ['name', 'version', 'digest']);
  const profile = readClosed(r['profile'], ['id', 'version', 'digest']);
  if (!sdk.ok || !adapter.ok || !profile.ok) throw new ConformanceRegistryError('MALFORMED_INPUT', 'nested record');
  const ok =
    isIdentifier(r['integrationId']) && Number.isSafeInteger(r['integrationVersion']) && (r['integrationVersion'] as number) >= 1 &&
    isIdentifier(r['platformId']) && isIdentifier(r['organizationId']) && isDigest(r['deploymentDigest']) &&
    typeof sdk.record['package'] === 'string' && isSemver(sdk.record['version']) && isDigest(sdk.record['lockDigest']) &&
    isIdentifier(adapter.record['name']) && isSemver(adapter.record['version']) && isDigest(adapter.record['digest']) &&
    isIdentifier(profile.record['id']) && isSemver(profile.record['version']) && isDigest(profile.record['digest']);
  if (!ok) throw new ConformanceRegistryError('MALFORMED_INPUT', 'field value');
  const ops = r['coveredOperations'];
  if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => typeof o === 'string' && OPERATION.test(o)) || new Set(ops).size !== ops.length) throw new ConformanceRegistryError('MALFORMED_INPUT', 'coveredOperations');
  const exclusions = r['declaredExclusions'];
  if (!Array.isArray(exclusions)) throw new ConformanceRegistryError('MALFORMED_INPUT', 'declaredExclusions');
  for (const e of exclusions) {
    const x = readClosed(e, ['operation', 'reason']);
    if (!x.ok || typeof x.record['operation'] !== 'string' || !OPERATION.test(x.record['operation']) || typeof x.record['reason'] !== 'string' || (x.record['reason'] as string).length === 0) throw new ConformanceRegistryError('MALFORMED_INPUT', 'declaredExclusions');
    if ((ops as string[]).includes(x.record['operation'] as string)) throw new ConformanceRegistryError('MALFORMED_INPUT', 'an operation cannot be both covered and excluded');
  }
  const endpoints = r['testEndpoints'];
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new ConformanceRegistryError('MALFORMED_INPUT', 'testEndpoints');
  for (const e of endpoints) {
    const x = readClosed(e, ['endpointId', 'environment', 'fixtureRef']);
    if (!x.ok || !isIdentifier(x.record['endpointId']) || !isIdentifier(x.record['fixtureRef'])) throw new ConformanceRegistryError('MALFORMED_INPUT', 'testEndpoints');
    // Synthetic endpoints only: there is no authorization path for staging or production in this mission (CC-D-12).
    if (x.record['environment'] !== 'synthetic') throw new ConformanceRegistryError('NOT_SYNTHETIC', 'only synthetic test endpoints may be registered');
  }
  return input as IntegrationVersionInput;
}

export interface ConformanceRegistry {
  registerProfile(definition: ConformanceProfileDefinition): string;
  registerPlatform(input: { readonly platformId: string; readonly organizationId: string; readonly displayName: string }): { record: PlatformRecord; digest: string };
  registerIntegrationVersion(input: IntegrationVersionInput): { record: IntegrationVersionRecord; integrationDigest: string };
  registerSyntheticOperator(operatorId: string): ValidatorOperatorRecord;
  /** The enrollment record and the digest two humans must sign. Nothing is stored. */
  prepareValidatorEnrollment(input: { readonly validatorId: string; readonly operatorId: string; readonly publicKeyPem: string; readonly keyValidFrom: string; readonly keyValidUntil: string }): { record: ValidatorEnrollmentRecord; bindingDigest: string };
  enrollValidator(record: ValidatorEnrollmentRecord, decisions: readonly unknown[]): { record: ValidatorEnrollmentRecord; bindingDigest: string };
  /** Protective, no approval: the key stops being accepted from `now`. */
  revokeValidatorKey(validatorId: string, reason: string): void;
  /** Protective, no approval. Release from quarantine is not implemented in RN-CONFORM-02. */
  quarantineValidator(validatorId: string, reason: string): void;
}

export function createConformanceRegistry(deps: {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: ConformanceClock;
  readonly humans: SyntheticHumanDirectory;
}): ConformanceRegistry {
  const { store, profiles, clock, humans } = deps;
  const translate = <T>(fn: () => T, conflict: RegistryRefusal): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ConformanceStoreError) {
        if (error.detail.includes('cross-tenant')) throw new ConformanceRegistryError('CROSS_TENANT', error.detail);
        if (error.code === 'CONFLICT' || error.detail.includes('version gap')) throw new ConformanceRegistryError(conflict, error.detail);
      }
      throw error;
    }
  };

  return Object.freeze<ConformanceRegistry>({
    registerProfile(definition: ConformanceProfileDefinition): string {
      const resolved = profiles.resolve(definition.profileId, definition.profileVersion);
      if (!resolved.ok) throw new ConformanceRegistryError('UNKNOWN_PROFILE', profileKey(definition.profileId, definition.profileVersion));
      const admitted = profiles.admit(definition);
      if (!admitted.ok) throw new ConformanceRegistryError(admitted.reason === 'UNKNOWN_PROFILE' ? 'UNKNOWN_PROFILE' : 'PROFILE_DIGEST_MISMATCH');
      translate(() => store.insertProfile(definition.profileId, definition.profileVersion, admitted.digest, JSON.stringify(definition)), 'PROFILE_DIGEST_MISMATCH');
      return admitted.digest;
    },

    registerPlatform(input) {
      const top = readClosed(input, ['platformId', 'organizationId', 'displayName']);
      if (!top.ok || !isIdentifier(input.platformId) || !isIdentifier(input.organizationId) || typeof input.displayName !== 'string' || input.displayName.length === 0 || input.displayName.length > 128) {
        throw new ConformanceRegistryError('MALFORMED_INPUT');
      }
      const existing = store.getPlatform(input.platformId);
      const record: PlatformRecord = Object.freeze({
        schema: 'rn.conformance.platform/1',
        platformId: input.platformId,
        organizationId: input.organizationId,
        displayName: input.displayName,
        synthetic: true,
        registeredAt: existing?.record.registeredAt ?? clock.now(),
      });
      const digest = conformanceDigest(record);
      if (existing !== undefined && existing.record.organizationId !== input.organizationId) throw new ConformanceRegistryError('CROSS_TENANT', 'platform belongs to another organization');
      translate(() => store.insertPlatform(record, digest), 'DUPLICATE_CONFLICT');
      return { record, digest };
    },

    registerIntegrationVersion(raw: IntegrationVersionInput) {
      const input = checkIntegrationInput(raw);
      const platform = store.getPlatform(input.platformId);
      if (platform === undefined) throw new ConformanceRegistryError('UNKNOWN_PLATFORM');
      if (platform.record.organizationId !== input.organizationId) throw new ConformanceRegistryError('CROSS_TENANT', 'platform belongs to another organization');
      const resolved = profiles.resolve(input.profile.id, input.profile.version);
      if (!resolved.ok) throw new ConformanceRegistryError('UNKNOWN_PROFILE');
      if (resolved.digest !== input.profile.digest || store.getProfileDigest(input.profile.id, input.profile.version) !== resolved.digest) throw new ConformanceRegistryError('PROFILE_DIGEST_MISMATCH');
      if (!sdkSupported(resolved.definition, input.sdk.package, input.sdk.version)) throw new ConformanceRegistryError('UNSUPPORTED_SDK');

      const record: IntegrationVersionRecord = Object.freeze({
        schema: 'rn.conformance.integration-version/1',
        integrationId: input.integrationId,
        integrationVersion: input.integrationVersion,
        platformId: input.platformId,
        organizationId: input.organizationId,
        sdk: Object.freeze({ ...input.sdk }),
        adapter: Object.freeze({ ...input.adapter }),
        deploymentDigest: input.deploymentDigest,
        profile: Object.freeze({ ...input.profile }),
        coveredOperations: Object.freeze([...input.coveredOperations].sort()),
        declaredExclusions: Object.freeze([...input.declaredExclusions].map((e) => Object.freeze({ ...e })).sort((a, b) => a.operation.localeCompare(b.operation))),
        testEndpoints: Object.freeze([...input.testEndpoints].map((e) => Object.freeze({ ...e })).sort((a, b) => a.endpointId.localeCompare(b.endpointId))),
        synthetic: true,
        registeredAt: '1970-01-01T00:00:00.000Z',
      });

      const prior = store.getIntegrationVersions(input.organizationId, input.integrationId);
      const same = prior.find((p) => p.record.integrationVersion === input.integrationVersion);
      if (same !== undefined) {
        // Idempotent only for the identical registration; anything else under this version is a conflict.
        const { registeredAt: _ignored, ...a } = same.record;
        const { registeredAt: _ignored2, ...b } = record;
        if (conformanceDigest(a) === conformanceDigest(b)) return { record: same.record, integrationDigest: same.integrationDigest };
        throw new ConformanceRegistryError('DUPLICATE_CONFLICT', 'a different integration is registered under this version');
      }
      const latest = prior[prior.length - 1];
      if (latest !== undefined) {
        if (latest.record.platformId !== input.platformId) throw new ConformanceRegistryError('DUPLICATE_CONFLICT', 'an integration id never changes platform');
        if (latest.record.profile.id === input.profile.id && compareSemver(input.profile.version, latest.record.profile.version) < 0) throw new ConformanceRegistryError('PROFILE_DOWNGRADE');
        if (latest.record.sdk.package === input.sdk.package && compareSemver(input.sdk.version, latest.record.sdk.version) < 0) throw new ConformanceRegistryError('SDK_DOWNGRADE');
      }
      if (input.integrationVersion !== (latest?.record.integrationVersion ?? 0) + 1) throw new ConformanceRegistryError('VERSION_CONFLICT');
      const stamped: IntegrationVersionRecord = Object.freeze({ ...record, registeredAt: clock.now() });
      const integrationDigest = conformanceDigest(stamped);
      translate(() => store.insertIntegration(stamped, integrationDigest), 'DUPLICATE_CONFLICT');
      return { record: stamped, integrationDigest };
    },

    registerSyntheticOperator(operatorId: string) {
      if (!isIdentifier(operatorId)) throw new ConformanceRegistryError('MALFORMED_INPUT');
      const existing = store.getOperator(operatorId);
      if (existing !== undefined) return existing;
      const now = clock.now();
      const record: ValidatorOperatorRecord = Object.freeze({
        schema: 'rn.conformance.validator-operator/1',
        operatorId,
        synthetic: true,
        attestation: Object.freeze({ statement: SYNTHETIC_OPERATOR_STATEMENT, attestedAt: now }),
        registeredAt: now,
      });
      translate(() => store.insertOperator(record), 'DUPLICATE_CONFLICT');
      return record;
    },

    prepareValidatorEnrollment(input) {
      const top = readClosed(input, ['validatorId', 'operatorId', 'publicKeyPem', 'keyValidFrom', 'keyValidUntil']);
      if (!top.ok || !isIdentifier(input.validatorId) || !isIdentifier(input.operatorId) || !isTimestamp(input.keyValidFrom) || !isTimestamp(input.keyValidUntil) || toMs(input.keyValidUntil) <= toMs(input.keyValidFrom)) {
        throw new ConformanceRegistryError('MALFORMED_INPUT');
      }
      if (typeof input.publicKeyPem !== 'string' || /PRIVATE KEY/.test(input.publicKeyPem)) throw new ConformanceRegistryError('KEY_NOT_PUBLIC');
      let keyId: string;
      try {
        if (createPublicKey(input.publicKeyPem).asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
        keyId = deriveConformanceKeyId(input.publicKeyPem);
      } catch {
        throw new ConformanceRegistryError('KEY_NOT_PUBLIC');
      }
      const record: ValidatorEnrollmentRecord = Object.freeze({
        schema: 'rn.conformance.validator-enrollment/1',
        validatorId: input.validatorId,
        operatorId: input.operatorId,
        keyId,
        publicKeyPem: input.publicKeyPem,
        keyValidFrom: input.keyValidFrom,
        keyValidUntil: input.keyValidUntil,
        synthetic: true,
        requestedAt: clock.now(),
      });
      return { record, bindingDigest: conformanceDigest(record) };
    },

    enrollValidator(record: ValidatorEnrollmentRecord, decisions: readonly unknown[]) {
      if (record.synthetic !== true) throw new ConformanceRegistryError('NOT_SYNTHETIC');
      if (deriveConformanceKeyId(record.publicKeyPem) !== record.keyId) throw new ConformanceRegistryError('KEY_ID_MISMATCH');
      const operator = store.getOperator(record.operatorId);
      if (operator === undefined || operator.synthetic !== true) throw new ConformanceRegistryError('UNKNOWN_OPERATOR');
      const bindingDigest = conformanceDigest(record);
      const existing = store.getValidator(record.validatorId);
      if (existing !== undefined) {
        // Never rebinds: a second enrollment under one id with another key or operator is a substitution attempt.
        if (existing.bindingDigest === bindingDigest) return { record: existing.record, bindingDigest };
        throw new ConformanceRegistryError('VALIDATOR_CONFLICT', 'validator id already enrolled with different material');
      }
      if (store.getValidatorByKeyId(record.keyId) !== undefined) throw new ConformanceRegistryError('KEY_REUSED');
      const authority = verifyTwoPersonAuthority(
        humans,
        decisions,
        { action: 'validator.enroll', organizationId: CONFORMANCE_NETWORK_ORGANIZATION, subjectRef: record.validatorId, actionBindingDigest: bindingDigest, now: clock.now() },
        store.isDecisionConsumed,
      );
      if (!authority.authorized) throw new ConformanceRegistryError('APPROVAL_REFUSED', authority.denial);
      const consumed: ConsumedDecision[] = authority.refs.map((ref, index) => ({
        ref,
        signed: authority.signed[index]!,
        action: 'validator.enroll',
        organizationId: CONFORMANCE_NETWORK_ORGANIZATION,
        subjectRef: record.validatorId,
      }));
      try {
        store.insertValidator(record, bindingDigest, consumed, clock.now());
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') throw new ConformanceRegistryError('APPROVAL_REFUSED', 'ALREADY_CONSUMED');
        throw error;
      }
      return { record, bindingDigest };
    },

    revokeValidatorKey(validatorId: string, reason: string) {
      if (store.getValidator(validatorId) === undefined) throw new ConformanceRegistryError('MALFORMED_INPUT', 'unknown validator');
      store.appendValidatorEvent(validatorId, 'KEY_REVOKED', toMs(clock.now()), reason);
    },

    quarantineValidator(validatorId: string, reason: string) {
      if (store.getValidator(validatorId) === undefined) throw new ConformanceRegistryError('MALFORMED_INPUT', 'unknown validator');
      store.appendValidatorEvent(validatorId, 'QUARANTINED', toMs(clock.now()), reason);
    },
  });
}
