import { createPublicKey } from 'node:crypto';

import { conformanceDigest } from './canonical.js';
import {
  DEPLOYMENT_ATTESTATION_OPERATION,
  MAX_COVERED_OPERATIONS,
  MAX_DECLARED_EXCLUSIONS,
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
import { quarantineLineage } from './evidence.js';
import { verifyTwoPersonAuthority, type SyntheticHumanDirectory } from './human-authority.js';
import { profileKey, sdkSupported, type ConformanceProfileDefinition, type ConformanceProfileRegistry } from './profile.js';
import type { ConformanceStore, ConsumedDecision, StoredTestingAuthorization } from './sqlite-conformance-store.js';
import { readTestingAuthorizationInput, testingAuthorizationDigest, type TestingAuthorizationRecord } from './testing-authorization.js';
import { ConformanceStoreError, operatorEligibleAt } from './sqlite-conformance-store.js';
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
  | 'APPROVAL_REFUSED'
  | 'OPERATOR_NOT_ELIGIBLE'
  | 'TRANSITION_NOT_ALLOWED'
  | 'UNKNOWN_INTEGRATION'
  | 'AUTHORIZATION_SCOPE'
  | 'UNKNOWN_AUTHORIZATION';

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
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_COVERED_OPERATIONS || !ops.every((o) => typeof o === 'string' && OPERATION.test(o)) || new Set(ops).size !== ops.length) throw new ConformanceRegistryError('MALFORMED_INPUT', 'coveredOperations');
  const exclusions = r['declaredExclusions'];
  // The bound is on distinct excluded operations — what a status states (Codex C-3); the raw list is bounded too, against padding.
  if (!Array.isArray(exclusions) || exclusions.length > 4 * MAX_DECLARED_EXCLUSIONS) throw new ConformanceRegistryError('MALFORMED_INPUT', 'declaredExclusions');
  for (const e of exclusions) {
    const x = readClosed(e, ['operation', 'reason']);
    if (!x.ok || typeof x.record['operation'] !== 'string' || !OPERATION.test(x.record['operation']) || typeof x.record['reason'] !== 'string' || (x.record['reason'] as string).length === 0) throw new ConformanceRegistryError('MALFORMED_INPUT', 'declaredExclusions');
    if ((ops as string[]).includes(x.record['operation'] as string)) throw new ConformanceRegistryError('MALFORMED_INPUT', 'an operation cannot be both covered and excluded');
  }
  if (new Set(exclusions.map((e) => (e as { operation: string }).operation)).size > MAX_DECLARED_EXCLUSIONS) throw new ConformanceRegistryError('MALFORMED_INPUT', 'declaredExclusions');
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
  /**
   * RN-CONFORM-05 (P2-5): authoritative operator status. A registered operator is NOT eligible until two humans approve
   * it; only an eligible operator can enroll validators or contribute observations (enforced by trigger as well).
   */
  prepareOperatorAction(operatorId: string, kind: 'approve' | 'reinstate'): { readonly action: 'operator.approve' | 'operator.reinstate'; readonly organizationId: string; readonly subjectRef: string; readonly actionBindingDigest: string };
  approveOperator(operatorId: string, decisions: readonly unknown[]): void;
  reinstateOperator(operatorId: string, decisions: readonly unknown[]): void;
  /** Protective, no approval. */
  quarantineOperator(operatorId: string, reason: string): void;
  /** Protective, no approval, terminal. */
  revokeOperator(operatorId: string, reason: string): void;
  operatorEligible(operatorId: string): boolean;
  /**
   * RN-CONFORM-07: the PROPOSED testing authorization (closed record, explicit scope) and the binding two humans of the
   * integration's own organization must approve. Nothing is stored.
   */
  prepareTestingAuthorization(input: unknown): { readonly record: TestingAuthorizationRecord; readonly authorizationDigest: string; readonly prepared: { readonly action: 'testing.authorize'; readonly organizationId: string; readonly subjectRef: string; readonly actionBindingDigest: string } };
  /** PROPOSED → ACTIVE: two-person `testing.authorize`, consumed in the store (trigger-checked). */
  authorizeTesting(record: TestingAuthorizationRecord, decisions: readonly unknown[]): StoredTestingAuthorization;
  /** Protective, terminal, idempotent: no new challenge or observation from the committed revocation onward. */
  revokeTestingAuthorization(organizationId: string, authorizationId: string, reason: string): void;
  getTestingAuthorization(authorizationId: string): StoredTestingAuthorization | undefined;
}

export function createConformanceRegistry(deps: {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: ConformanceClock;
  readonly humans: SyntheticHumanDirectory;
}): ConformanceRegistry {
  const { store, profiles, clock, humans } = deps;
  const storeRefusal = (error: unknown): never => {
    if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') throw new ConformanceRegistryError('APPROVAL_REFUSED', 'ALREADY_CONSUMED');
    if (error instanceof ConformanceStoreError && error.code === 'INVARIANT_REFUSED') throw new ConformanceRegistryError('TRANSITION_NOT_ALLOWED', error.detail);
    throw error;
  };
  const operatorTransition = (operatorId: string, kind: 'approve' | 'reinstate', decisions: readonly unknown[]) => {
    if (store.getOperator(operatorId) === undefined) throw new ConformanceRegistryError('UNKNOWN_OPERATOR');
    const prepared = registry.prepareOperatorAction(operatorId, kind);
    const authority = verifyTwoPersonAuthority(humans, decisions, { ...prepared, now: clock.now() }, store.isDecisionConsumed);
    if (!authority.authorized) throw new ConformanceRegistryError('APPROVAL_REFUSED', authority.denial);
    const consumed: ConsumedDecision[] = authority.refs.map((ref, index) => ({ ref, signed: authority.signed[index]!, action: prepared.action, organizationId: prepared.organizationId, subjectRef: prepared.subjectRef }));
    try {
      store.appendOperatorEvent(operatorId, kind === 'approve' ? 'APPROVED' : 'REINSTATED', toMs(clock.now()), kind === 'approve' ? 'TWO_PERSON_APPROVAL' : 'TWO_PERSON_REINSTATEMENT', prepared.actionBindingDigest, consumed);
    } catch (error) {
      storeRefusal(error);
    }
  };
  const protectiveOperatorEvent = (operatorId: string, kind: 'QUARANTINED' | 'REVOKED', reason: string) => {
    if (store.getOperator(operatorId) === undefined) throw new ConformanceRegistryError('UNKNOWN_OPERATOR');
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) throw new ConformanceRegistryError('MALFORMED_INPUT', 'reason');
    try {
      // Review C-3: a protective event is never refused for a slightly regressed clock — it is stamped no earlier than
      // the latest event (status is decided by sequence), so it always lands and always restricts.
      const latestAt = store.listOperatorEvents(operatorId).reduce((m, e) => Math.max(m, e.atMs), 0);
      store.appendOperatorEvent(operatorId, kind, Math.max(toMs(clock.now()), latestAt), reason, null, []);
    } catch (error) {
      storeRefusal(error);
    }
  };
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

  const registry: ConformanceRegistry = Object.freeze<ConformanceRegistry>({
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
      // RN-CONFORM-05 (P2-5): a new validator identity never restores the vote of an operator that is not eligible.
      if (!operatorEligibleAt(store.listOperatorEvents(record.operatorId), toMs(clock.now()))) throw new ConformanceRegistryError('OPERATOR_NOT_ELIGIBLE', record.operatorId);
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

    prepareOperatorAction(operatorId: string, kind: 'approve' | 'reinstate') {
      if (!isIdentifier(operatorId)) throw new ConformanceRegistryError('MALFORMED_INPUT');
      const fromSeq = store.listOperatorEvents(operatorId).length;
      const action = kind === 'approve' ? ('operator.approve' as const) : ('operator.reinstate' as const);
      return Object.freeze({
        action,
        organizationId: CONFORMANCE_NETWORK_ORGANIZATION,
        subjectRef: `operator:${operatorId}`,
        actionBindingDigest: conformanceDigest({ schema: 'rn.conformance.operator-action/1', action, operatorId, fromSeq, synthetic: true }),
      });
    },
    approveOperator(operatorId: string, decisions: readonly unknown[]) {
      operatorTransition(operatorId, 'approve', decisions);
    },
    reinstateOperator(operatorId: string, decisions: readonly unknown[]) {
      operatorTransition(operatorId, 'reinstate', decisions);
    },
    quarantineOperator(operatorId: string, reason: string) {
      protectiveOperatorEvent(operatorId, 'QUARANTINED', reason);
    },
    revokeOperator(operatorId: string, reason: string) {
      protectiveOperatorEvent(operatorId, 'REVOKED', reason);
    },
    operatorEligible: (operatorId: string) => operatorEligibleAt(store.listOperatorEvents(operatorId), toMs(clock.now())),

    prepareTestingAuthorization(input: unknown) {
      const read = readTestingAuthorizationInput(input);
      if (read === null) throw new ConformanceRegistryError('MALFORMED_INPUT', 'testing authorization');
      const integration = store.getIntegrationByDigest(read.organizationId, read.integrationDigest);
      if (integration === undefined) throw new ConformanceRegistryError('UNKNOWN_INTEGRATION');
      const rec = integration.record;
      const profile = profiles.resolve(rec.profile.id, rec.profile.version, rec.profile.digest);
      if (!profile.ok) throw new ConformanceRegistryError('UNKNOWN_PROFILE');
      // Only what the integration itself registered: its synthetic fixtures, its covered operations, its profile's challenges.
      const fixtures = new Set(rec.testEndpoints.filter((e) => e.environment === 'synthetic').map((e) => e.fixtureRef));
      const operations = new Set([...rec.coveredOperations, DEPLOYMENT_ATTESTATION_OPERATION]);
      const types = new Set<string>(profile.definition.requirements.flatMap((r) => (r.challengeType === null ? [] : [r.challengeType])));
      if (!read.fixtureRefs.every((f) => fixtures.has(f)) || !read.operations.every((o) => operations.has(o)) || !read.challengeTypes.every((t) => types.has(t))) {
        throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', 'outside what the integration registered');
      }
      let version = 1;
      if (read.supersedes !== null) {
        const old = store.getTestingAuthorization(read.supersedes);
        if (old === undefined || old.record.organizationId !== read.organizationId || old.record.integrationId !== rec.integrationId || old.record.purpose !== read.purpose) {
          throw new ConformanceRegistryError('UNKNOWN_AUTHORIZATION', 'the superseded authorization does not match');
        }
        if (old.revokedSeq === null) throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', 'revoke the superseded authorization first');
        version = old.record.version + 1;
      }
      const record: TestingAuthorizationRecord = Object.freeze({
        schema: 'rn.conformance.testing-authorization/2',
        authorizationId: read.authorizationId,
        version,
        supersedes: read.supersedes,
        organizationId: read.organizationId,
        platformId: rec.platformId,
        integrationId: rec.integrationId,
        integrationVersion: rec.integrationVersion,
        integrationDigest: read.integrationDigest,
        profileId: rec.profile.id,
        profileVersion: rec.profile.version,
        purpose: read.purpose,
        environment: 'synthetic',
        fixtureRefs: read.fixtureRefs,
        operations: read.operations,
        challengeTypes: read.challengeTypes,
        notBefore: read.notBefore,
        notAfter: read.notAfter,
        maxChallengesPerHour: read.maxChallengesPerHour,
        maxConcurrentChallenges: read.maxConcurrentChallenges,
        maxTotalChallenges: read.maxTotalChallenges,
        synthetic: true,
      });
      const authorizationDigest = testingAuthorizationDigest(record);
      return Object.freeze({
        record,
        authorizationDigest,
        prepared: Object.freeze({ action: 'testing.authorize' as const, organizationId: record.organizationId, subjectRef: `authorization:${record.authorizationId}`, actionBindingDigest: authorizationDigest }),
      });
    },
    authorizeTesting(record: TestingAuthorizationRecord, decisions: readonly unknown[]) {
      // Rebuilt from its inputs: a record whose derived fields were altered (or widened) is refused before any approval.
      const again = registry.prepareTestingAuthorization({
        authorizationId: record.authorizationId,
        supersedes: record.supersedes,
        organizationId: record.organizationId,
        integrationDigest: record.integrationDigest,
        purpose: record.purpose,
        fixtureRefs: record.fixtureRefs,
        operations: record.operations,
        challengeTypes: record.challengeTypes,
        notBefore: record.notBefore,
        notAfter: record.notAfter,
        maxChallengesPerHour: record.maxChallengesPerHour,
        maxConcurrentChallenges: record.maxConcurrentChallenges,
        maxTotalChallenges: record.maxTotalChallenges,
      });
      if (again.authorizationDigest !== testingAuthorizationDigest(record)) throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', 'the record is not the prepared record');
      const authority = verifyTwoPersonAuthority(humans, decisions, { ...again.prepared, now: clock.now() }, store.isDecisionConsumed);
      if (!authority.authorized) throw new ConformanceRegistryError('APPROVAL_REFUSED', authority.denial);
      // Review #2: one live authorization per (organization, integration version, purpose); scope changes supersede.
      if (store.getTestingAuthorization(record.authorizationId) !== undefined) throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', 'authorization id already used');
      const live = store.liveTestingAuthorizationId(record.organizationId, record.integrationDigest, record.purpose, toMs(record.notBefore));
      if (live !== undefined) throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', `live authorization ${live} must be revoked and superseded`);
      if (record.supersedes !== null && store.isTestingAuthorizationSuperseded(record.supersedes)) throw new ConformanceRegistryError('AUTHORIZATION_SCOPE', 'the predecessor already has a successor');
      const consumed: ConsumedDecision[] = authority.refs.map((ref, index) => ({ ref, signed: authority.signed[index]!, action: 'testing.authorize', organizationId: again.prepared.organizationId, subjectRef: again.prepared.subjectRef }));
      try {
        store.insertTestingAuthorization(again.record, again.authorizationDigest, consumed, clock.now());
      } catch (error) {
        storeRefusal(error);
      }
      return store.getTestingAuthorization(record.authorizationId) as StoredTestingAuthorization;
    },
    revokeTestingAuthorization(organizationId: string, authorizationId: string, reason: string) {
      const current = store.getTestingAuthorization(authorizationId);
      // Review #5: tenant-scoped — another organization's authorization is indistinguishable from an unknown one.
      if (current === undefined || current.record.organizationId !== organizationId) throw new ConformanceRegistryError('UNKNOWN_AUTHORIZATION');
      if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) throw new ConformanceRegistryError('MALFORMED_INPUT', 'reason');
      if (current.revokedSeq !== null) return;
      try {
        store.revokeTestingAuthorization(authorizationId, toMs(clock.now()), reason);
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') return; // a concurrent revocation won
        storeRefusal(error);
      }
    },
    getTestingAuthorization: (authorizationId: string) => store.getTestingAuthorization(authorizationId),

    revokeValidatorKey(validatorId: string, reason: string) {
      if (store.getValidator(validatorId) === undefined) throw new ConformanceRegistryError('MALFORMED_INPUT', 'unknown validator');
      store.appendValidatorEvent(validatorId, 'KEY_REVOKED', toMs(clock.now()), reason);
    },

    quarantineValidator(validatorId: string, reason: string) {
      if (store.getValidator(validatorId) === undefined) throw new ConformanceRegistryError('MALFORMED_INPUT', 'unknown validator');
      // Review C-2: a behavioural quarantine applies to the whole logical validator (all earlier key generations).
      quarantineLineage(store, validatorId, toMs(clock.now()), reason);
    },
  });
  return registry;
}
