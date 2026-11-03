import { randomBytes, type KeyObject } from 'node:crypto';

import { canonicalizeConformance } from './canonical.js';
import {
  CHALLENGE_CATALOGUE,
  CHALLENGE_TYPES,
  DEPLOYMENT_ATTESTATION_OPERATION,
  isIdentifier,
  toMs,
  toTimestamp,
  type ChallengePayload,
  type ChallengeType,
  type SignedChallenge,
} from './contracts.js';
import type { ConformanceProfileRegistry } from './profile.js';
import type { ConformanceClock } from './registry.js';
import { ConformanceStoreError, type ConformanceStore } from './sqlite-conformance-store.js';
import { signConformancePayload, verifyConformanceSignature } from './signing.js';

/**
 * RN-CONFORM-02 / WP-05 — the in-process challenge coordinator.
 *
 * Issues signed challenges bound to one exact integration version and
 * profile, for one control, to an explicit list of enrolled validators. No
 * networking: a challenge is a record in the store that a (synthetic)
 * validator reads in-process.
 */

export interface RandomSource {
  bytes(length: number): Buffer;
}

/** Operating-system CSPRNG. The default; the deterministic provider exists only in the synthetic test harness. */
export const secureRandomSource: RandomSource = Object.freeze({ bytes: (length: number) => randomBytes(length) });

export const CHALLENGE_NONCE_BYTES = 32;
export const MAX_CHALLENGE_DEADLINE_SECONDS = 15 * 60;
/** Re-exported: defined in `contracts.ts` so the pure engine can use it without importing the coordinator. */
export { DEPLOYMENT_ATTESTATION_OPERATION };

export function newIdentifier(random: RandomSource, prefix: string): string {
  return `${prefix}_${random.bytes(16).toString('hex')}`;
}

export type ChallengeRefusal =
  | 'MALFORMED_REQUEST'
  | 'UNKNOWN_INTEGRATION'
  | 'UNKNOWN_PROFILE'
  | 'CHALLENGE_NOT_IN_PROFILE'
  | 'OPERATION_NOT_COVERED'
  | 'VALIDATOR_NOT_ELIGIBLE'
  | 'IDEMPOTENCY_CONFLICT';

export class ChallengeCoordinatorError extends Error {
  readonly code: ChallengeRefusal;
  constructor(code: ChallengeRefusal, detail = '') {
    super(`Challenge refused: ${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'ChallengeCoordinatorError';
    this.code = code;
  }
}

export interface ChallengeRequest {
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly integrationDigest: string;
  readonly challengeType: ChallengeType;
  readonly operation: string;
  readonly fixtureRef: string;
  readonly assignedValidatorIds: readonly string[];
  readonly deadlineSeconds: number;
}

export interface ChallengeCoordinator {
  issue(request: ChallengeRequest): SignedChallenge;
}

/** Whether a stored challenge carries a valid coordinator signature. */
export function verifyChallenge(signed: SignedChallenge, coordinatorPublicKeyPem: string): boolean {
  return verifyConformanceSignature('challenge', signed.challenge, signed.coordinatorSignature, coordinatorPublicKeyPem).ok;
}

export function createChallengeCoordinator(deps: {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: ConformanceClock;
  readonly random: RandomSource;
  readonly coordinatorKey: KeyObject;
}): ChallengeCoordinator {
  const { store, profiles, clock, random, coordinatorKey } = deps;

  const sameRequest = (existing: ChallengePayload, request: ChallengeRequest, deadlineSeconds: number) =>
    existing.organizationId === request.organizationId &&
    existing.integrationDigest === request.integrationDigest &&
    existing.challengeType === request.challengeType &&
    existing.operation === request.operation &&
    existing.fixtureRef === request.fixtureRef &&
    canonicalizeConformance([...existing.assignedValidatorIds]) === canonicalizeConformance([...request.assignedValidatorIds].sort()) &&
    toMs(existing.deadline) - toMs(existing.issuedAt) === deadlineSeconds * 1000;

  return Object.freeze({
    issue(request: ChallengeRequest): SignedChallenge {
      if (
        typeof request !== 'object' || request === null || !isIdentifier(request.idempotencyKey) || !isIdentifier(request.organizationId) ||
        typeof request.integrationDigest !== 'string' || !(CHALLENGE_TYPES as readonly string[]).includes(request.challengeType) ||
        typeof request.operation !== 'string' || !isIdentifier(request.fixtureRef) || !Array.isArray(request.assignedValidatorIds) ||
        request.assignedValidatorIds.length === 0 || !request.assignedValidatorIds.every(isIdentifier) || new Set(request.assignedValidatorIds).size !== request.assignedValidatorIds.length ||
        !Number.isSafeInteger(request.deadlineSeconds) || request.deadlineSeconds < 1 || request.deadlineSeconds > MAX_CHALLENGE_DEADLINE_SECONDS
      ) {
        throw new ChallengeCoordinatorError('MALFORMED_REQUEST');
      }
      // Idempotent re-dispatch: the same key returns the same challenge, never a new one.
      const existing = store.getChallengeByIdempotencyKey(request.idempotencyKey);
      if (existing !== undefined) {
        if (sameRequest(existing.challenge, request, request.deadlineSeconds)) return existing;
        throw new ChallengeCoordinatorError('IDEMPOTENCY_CONFLICT');
      }

      const integration = store.getIntegrationByDigest(request.organizationId, request.integrationDigest);
      if (integration === undefined) throw new ChallengeCoordinatorError('UNKNOWN_INTEGRATION');
      const profile = profiles.resolve(integration.record.profile.id, integration.record.profile.version, integration.record.profile.digest);
      if (!profile.ok) throw new ChallengeCoordinatorError('UNKNOWN_PROFILE');
      const catalogue = CHALLENGE_CATALOGUE[request.challengeType];
      const requirement = profile.definition.requirements.find((r) => r.requirementId === catalogue.controlId && r.challengeType === request.challengeType);
      if (requirement === undefined) throw new ChallengeCoordinatorError('CHALLENGE_NOT_IN_PROFILE');
      const operationOk = request.challengeType === 'G08' ? request.operation === DEPLOYMENT_ATTESTATION_OPERATION : integration.record.coveredOperations.includes(request.operation);
      if (!operationOk) throw new ChallengeCoordinatorError('OPERATION_NOT_COVERED');

      const now = clock.now();
      const nowMs = toMs(now);
      const deadlineMs = nowMs + request.deadlineSeconds * 1000;
      for (const validatorId of request.assignedValidatorIds) {
        const validator = store.getValidator(validatorId);
        const usable =
          validator !== undefined &&
          (validator.quarantinedAtMs === null || validator.quarantinedAtMs > nowMs) &&
          (validator.keyRevokedAtMs === null || validator.keyRevokedAtMs > nowMs) &&
          toMs(validator.record.keyValidFrom) <= nowMs &&
          toMs(validator.record.keyValidUntil) >= deadlineMs;
        if (!usable) throw new ChallengeCoordinatorError('VALIDATOR_NOT_ELIGIBLE', validatorId);
      }

      const challenge: ChallengePayload = Object.freeze({
        schema: 'rn.conformance.challenge/1',
        challengeId: newIdentifier(random, 'chl'),
        idempotencyKey: request.idempotencyKey,
        nonce: random.bytes(CHALLENGE_NONCE_BYTES).toString('base64url'),
        organizationId: request.organizationId,
        platformId: integration.record.platformId,
        integrationId: integration.record.integrationId,
        integrationVersion: integration.record.integrationVersion,
        integrationDigest: integration.integrationDigest,
        profileId: profile.definition.profileId,
        profileVersion: profile.definition.profileVersion,
        profileDigest: profile.digest,
        controlId: catalogue.controlId,
        challengeType: request.challengeType,
        operation: request.operation,
        expectedOutcome: catalogue.expectedOutcome,
        fixtureRef: request.fixtureRef,
        issuedAt: now,
        deadline: toTimestamp(deadlineMs),
        assignedValidatorIds: Object.freeze([...request.assignedValidatorIds].sort()),
        synthetic: true,
      });
      const signed: SignedChallenge = Object.freeze({ challenge, coordinatorSignature: signConformancePayload('challenge', challenge, coordinatorKey) });
      try {
        store.insertChallenge(signed);
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') {
          const raced = store.getChallengeByIdempotencyKey(request.idempotencyKey);
          if (raced !== undefined && sameRequest(raced.challenge, request, request.deadlineSeconds)) return raced;
          throw new ChallengeCoordinatorError('IDEMPOTENCY_CONFLICT');
        }
        throw error;
      }
      return signed;
    },
  });
}
