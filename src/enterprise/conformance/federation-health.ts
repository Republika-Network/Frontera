import { canonicalizeConformance, conformanceDigest } from './canonical.js';
import { isDigest, isIdentifier, isTimestamp, readClosed, toMs, toTimestamp } from './contracts.js';
import type { RandomSource } from './coordinator.js';
import { FEDERATION_TIMING, type HealthState, type HeartbeatRefusal, type ValidatorHeartbeat } from './federation-contracts.js';
import type { FederationRegistry } from './federation-registry.js';
import type { FederationStore } from './federation-store.js';
import { verifyConformanceSignature } from './signing.js';
import type { ConformanceStore } from './sqlite-conformance-store.js';

/**
 * RN-CONFORM-05 — signed validator heartbeats and validator health.
 *
 * Health is LIVENESS, not trustworthiness: a validator can be reachable and wrong, or unreachable and honest. Health
 * only decides whether the scheduler may assign work; it never touches evidence, corroboration or a credential, and a
 * heartbeat can never lift a quarantine (QUARANTINED / REVOKED are read from the lifecycle, not from the heartbeat).
 *
 * A heartbeat is signed under the validator's ACTIVE key generation in its own domain
 * (`frontera:conformance-validator-heartbeat:v1`), bound to a coordinator-issued session, and carries a strictly
 * increasing sequence. Freshness is measured on the COORDINATOR's clock at receipt (`receivedMs`), never on the
 * validator's own timestamp alone; the validator's `emittedAt` must still sit inside a narrow window and may never go
 * backwards. The same sequence with different content is equivocation — an attributable protocol violation.
 */

export interface SignedHeartbeat {
  readonly heartbeat: ValidatorHeartbeat;
  readonly signature: unknown;
}

export type HeartbeatResult =
  | { readonly accepted: true; readonly duplicate: boolean }
  | { readonly accepted: false; readonly reason: HeartbeatRefusal };

export interface HeartbeatSession {
  readonly sessionId: string;
  readonly validatorId: string;
  readonly generation: number;
  readonly conformanceValidatorId: string;
  readonly issuedAt: string;
}

export interface FederationHealth {
  /** Issued by the coordinator to an ELIGIBLE validator; heartbeats outside a session are refused. */
  openSession(validatorId: string): HeartbeatSession;
  acceptHeartbeat(signed: unknown): HeartbeatResult;
  health(validatorId: string): HealthState;
  /** Emits HEARTBEAT_MISSED once per gap for every ACTIVE validator that has become UNREACHABLE. Returns those validators. */
  sweep(): readonly string[];
}

const HEARTBEAT_FIELDS = ['schema', 'validatorId', 'operatorId', 'generation', 'keyId', 'sessionId', 'sequence', 'emittedAt', 'operationalState', 'capabilities', 'synthetic'] as const;

function readHeartbeat(value: unknown): ValidatorHeartbeat | null {
  const read = readClosed(value, HEARTBEAT_FIELDS);
  if (!read.ok) return null;
  const h = read.record;
  const ok =
    h['schema'] === 'rn.conformance.validator-heartbeat/1' && isIdentifier(h['validatorId']) && isIdentifier(h['operatorId']) && Number.isSafeInteger(h['generation']) && (h['generation'] as number) >= 1 &&
    isDigest(h['keyId']) && isIdentifier(h['sessionId']) && Number.isSafeInteger(h['sequence']) && (h['sequence'] as number) >= 1 && isTimestamp(h['emittedAt']) &&
    (h['operationalState'] === 'READY' || h['operationalState'] === 'DRAINING') && typeof h['capabilities'] === 'object' && h['capabilities'] !== null && h['synthetic'] === true;
  return ok ? (h as unknown as ValidatorHeartbeat) : null;
}

export function createFederationHealth(deps: {
  readonly fed: FederationStore;
  readonly store: ConformanceStore;
  readonly registry: FederationRegistry;
  readonly clock: { now(): string };
  readonly random: RandomSource;
}): FederationHealth {
  const { fed, store, registry, clock, random } = deps;
  const T = FEDERATION_TIMING;
  const nowMs = () => {
    const ms = toMs(clock.now());
    fed.observeClock(ms);
    return ms;
  };

  const activeGeneration = (validatorId: string) => fed.listGenerations(validatorId).find((g) => fed.generationState(validatorId, g.generation)?.state === 'ACTIVE');

  const service: FederationHealth = {
    openSession(validatorId) {
      const at = nowMs();
      const eligible = registry.eligibility(validatorId, at, at);
      if (!eligible.eligible) throw new TypeError(`No heartbeat session for an ineligible validator (${eligible.reason}).`);
      const sessionId = `hbs_${random.bytes(16).toString('hex')}`;
      fed.insertSession(sessionId, eligible.generation.conformanceValidatorId, at);
      return Object.freeze({ sessionId, validatorId, generation: eligible.generation.generation, conformanceValidatorId: eligible.generation.conformanceValidatorId, issuedAt: toTimestamp(at) });
    },

    acceptHeartbeat(signed) {
      let at: number;
      try {
        at = nowMs();
      } catch {
        return { accepted: false, reason: 'CLOCK_ROLLBACK' };
      }
      const refuse = (reason: HeartbeatRefusal, subject = 'unknown', violationOf: string | null = null, ref = ''): HeartbeatResult => {
        fed.appendEvent('HEARTBEAT_REFUSED', at, subject === 'unknown' ? 'federation' : 'validator', subject, { reason });
        if (violationOf !== null) fed.recordViolation(violationOf, `HEARTBEAT_${reason}`, ref, at);
        return { accepted: false, reason };
      };
      const outer = readClosed(signed, ['heartbeat', 'signature']);
      if (!outer.ok) return refuse('MALFORMED_HEARTBEAT');
      // Snapshot once: everything below reads the copy, never the caller's object again.
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(JSON.stringify(outer.record));
      } catch {
        return refuse('MALFORMED_HEARTBEAT');
      }
      const { heartbeat: rawHeartbeat, signature } = snapshot as { heartbeat: unknown; signature: unknown };
      const heartbeat = readHeartbeat(rawHeartbeat);
      if (heartbeat === null) return refuse('MALFORMED_HEARTBEAT');
      const record = fed.getValidator(heartbeat.validatorId);
      if (record === undefined) return refuse('UNKNOWN_VALIDATOR');
      const generation = fed.listGenerations(heartbeat.validatorId).find((g) => g.generation === heartbeat.generation);
      if (generation === undefined) return refuse('GENERATION_NOT_ACTIVE', heartbeat.validatorId);
      if (heartbeat.keyId !== generation.keyId) return refuse('KEY_MISMATCH', heartbeat.validatorId);
      // Signature before any state: an unauthenticated heartbeat can never be attributed to (or hurt) a validator.
      if (!verifyConformanceSignature('validatorHeartbeat', heartbeat, signature, generation.publicKeyPem).ok) return refuse('SIGNATURE_INVALID', heartbeat.validatorId);
      const cvid = generation.conformanceValidatorId;
      if (heartbeat.operatorId !== record.operatorId) return refuse('OPERATOR_MISMATCH', heartbeat.validatorId, cvid, `${heartbeat.sessionId}:${heartbeat.sequence}`);
      const vState = fed.validatorState(heartbeat.validatorId)?.state;
      if (vState === 'REVOKED') return refuse('VALIDATOR_REVOKED', heartbeat.validatorId);
      if (vState === 'QUARANTINED') return refuse('VALIDATOR_QUARANTINED', heartbeat.validatorId);
      if (fed.operatorState(record.operatorId)?.state !== 'ACTIVE') return refuse('OPERATOR_NOT_ACTIVE', heartbeat.validatorId);
      const gState = fed.generationState(heartbeat.validatorId, heartbeat.generation)?.state;
      if (gState === 'REVOKED') return refuse('KEY_NOT_ELIGIBLE', heartbeat.validatorId);
      if (gState !== 'ACTIVE') return refuse('GENERATION_NOT_ACTIVE', heartbeat.validatorId);
      const stored = store.getValidator(cvid);
      if (stored === undefined || (stored.quarantinedAtMs !== null && stored.quarantinedAtMs <= at)) return refuse('VALIDATOR_QUARANTINED', heartbeat.validatorId);
      if ((stored.keyRevokedAtMs !== null && stored.keyRevokedAtMs <= at) || toMs(stored.record.keyValidFrom) > at || toMs(stored.record.keyValidUntil) < at) return refuse('KEY_NOT_ELIGIBLE', heartbeat.validatorId);
      const session = fed.getSession(heartbeat.sessionId);
      if (session === undefined || session.conformanceValidatorId !== cvid) return refuse('SESSION_MISMATCH', heartbeat.validatorId);
      // Self-reported capabilities must be exactly the registered ones: a heartbeat cannot advertise new powers.
      if (canonicalizeConformance(heartbeat.capabilities) !== canonicalizeConformance(record.capabilities)) return refuse('CAPABILITY_MISMATCH', heartbeat.validatorId, cvid, `${heartbeat.sessionId}:${heartbeat.sequence}`);
      const emitted = toMs(heartbeat.emittedAt);
      if (emitted > at + T.clockSkewSeconds * 1000) return refuse('FUTURE_DATED', heartbeat.validatorId);
      if (emitted < at - T.heartbeatMaxAgeSeconds * 1000) return refuse('STALE_HEARTBEAT', heartbeat.validatorId);
      const digest = conformanceDigest(heartbeat);
      const head = fed.heartbeatHead(cvid);
      if (head !== undefined) {
        if (heartbeat.sequence === head.sequence) {
          if (digest === head.heartbeatDigest && heartbeat.sessionId === head.sessionId) return { accepted: true, duplicate: true };
          return refuse('EQUIVOCATION', heartbeat.validatorId, cvid, `${heartbeat.sequence}`);
        }
        if (heartbeat.sequence < head.sequence) return refuse('SEQUENCE_REPLAYED', heartbeat.validatorId);
        if (emitted < head.emittedMs) return refuse('CLOCK_ROLLBACK', heartbeat.validatorId);
      }
      try {
        fed.writeHeartbeatHead({ conformanceValidatorId: cvid, sessionId: heartbeat.sessionId, sequence: heartbeat.sequence, emittedMs: emitted, receivedMs: at, heartbeatDigest: digest, operationalState: heartbeat.operationalState });
      } catch {
        // A concurrent head moved first: the trigger refused a non-increasing sequence.
        return refuse('SEQUENCE_REPLAYED', heartbeat.validatorId);
      }
      fed.appendEvent('HEARTBEAT_ACCEPTED', at, 'validator', heartbeat.validatorId, { generation: heartbeat.generation, sequence: heartbeat.sequence });
      return { accepted: true, duplicate: false };
    },

    health(validatorId) {
      const at = nowMs();
      const state = fed.validatorState(validatorId)?.state;
      if (state === undefined || state === 'REVOKED') return 'REVOKED';
      if (state === 'QUARANTINED') return 'QUARANTINED';
      const generation = activeGeneration(validatorId);
      if (generation === undefined) return 'UNREACHABLE';
      const head = fed.heartbeatHead(generation.conformanceValidatorId);
      if (head === undefined) return 'UNREACHABLE';
      const age = at - head.receivedMs;
      if (age > T.heartbeatUnreachableAfterSeconds * 1000) return 'UNREACHABLE';
      if (age > T.heartbeatDegradedAfterSeconds * 1000 || head.operationalState === 'DRAINING') return 'DEGRADED';
      return 'HEALTHY';
    },

    sweep() {
      const at = nowMs();
      const missed: string[] = [];
      const events = fed.listEvents();
      for (const v of fed.listValidators()) {
        if (fed.validatorState(v.validatorId)?.state !== 'ACTIVE') continue;
        if (service.health(v.validatorId) !== 'UNREACHABLE') continue;
        const generation = activeGeneration(v.validatorId);
        const head = generation === undefined ? undefined : fed.heartbeatHead(generation.conformanceValidatorId);
        const since = head?.receivedMs ?? 0;
        const already = events.some((e) => e.kind === 'HEARTBEAT_MISSED' && e.subjectId === v.validatorId && e.atMs >= since);
        if (!already) {
          // Missing heartbeats make a validator unassignable; they never quarantine or revoke it on their own.
          fed.appendEvent('HEARTBEAT_MISSED', at, 'validator', v.validatorId, { lastReceivedAt: head === undefined ? null : toTimestamp(head.receivedMs) });
          missed.push(v.validatorId);
        }
      }
      return Object.freeze(missed);
    },
  };
  return Object.freeze(service);
}
