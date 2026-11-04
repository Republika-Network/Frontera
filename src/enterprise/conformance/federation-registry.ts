import { createPublicKey } from 'node:crypto';

import { conformanceDigest } from './canonical.js';
import { isIdentifier, isTimestamp, readClosed, toMs, toTimestamp, type HumanAction, type ValidatorEnrollmentRecord } from './contracts.js';
import type { RandomSource } from './coordinator.js';
import {
  EXECUTABLE_CHALLENGE_TYPES,
  FEDERATION_DESIGNATION,
  FEDERATION_TIMING,
  FEDERATION_OPERATOR_STATEMENT,
  INDEPENDENCE_VERIFICATION,
  OPERATOR_CLASSES,
  OPERATOR_TRANSITIONS,
  VALIDATOR_TRANSITIONS,
  generationIdentity,
  type EnrollmentRequestKind,
  type FederationOperatorRecord,
  type FederationValidatorRecord,
  type KeyPossessionStatement,
  type OperatorClass,
  type OperatorState,
  type TestingAuthorization,
  type ValidatorCapabilities,
  type ValidatorState,
} from './federation-contracts.js';
import { FederationStoreError, type FederationConsumedDecision, type FederationStore, type GenerationRow } from './federation-store.js';
import { verifyTwoPersonAuthority, type SyntheticHumanDirectory } from './human-authority.js';
import type { TestingAuthorizationInput } from './testing-authorization.js';
import type { ConformanceProfileRegistry } from './profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, ConformanceRegistryError, type ConformanceRegistry } from './registry.js';
import { deriveConformanceKeyId, verifyConformanceSignature } from './signing.js';
import { operatorEligibleAt, type ConformanceStore, type StoredTestingAuthorization } from './sqlite-conformance-store.js';

/**
 * RN-CONFORM-05 — operator identity, validator enrollment, key generations, quarantine and revocation.
 *
 * Identity is ADMINISTRATIVE. An operator id is bound once, by the coordinator-side registry, after two humans approve
 * it; a validator is pinned to that operator forever; a key generation is pinned to that validator. Nothing a validator
 * sends can name, change or add an operator: corroboration counts the operator recorded at enrollment in the RN-CONFORM-02
 * conformance store, which this module writes only through the existing `ConformanceRegistry` (two-person
 * `validator.enroll`, protective `quarantineValidator` / `revokeValidatorKey`).
 *
 * Every protective action writes the conformance store FIRST (where evidence acceptance and the engine read it), then
 * the federation store. A crash in between leaves the federation more permissive on paper but never in effect:
 * eligibility always re-reads the conformance store, and `syncFromConformance` repairs the federation view towards the
 * more restrictive state (never the other way).
 */

export const FEDERATION_REFUSALS = Object.freeze([
  'MALFORMED_INPUT',
  'NOT_SYNTHETIC',
  'DUPLICATE_OPERATOR',
  'UNKNOWN_OPERATOR',
  'OPERATOR_NOT_ELIGIBLE',
  'TRANSITION_NOT_ALLOWED',
  'DUPLICATE_VALIDATOR',
  'UNKNOWN_VALIDATOR',
  'VALIDATOR_NOT_ELIGIBLE',
  'KEY_NOT_PUBLIC',
  'KEY_REUSED',
  'POSSESSION_UNKNOWN',
  'POSSESSION_EXPIRED',
  'POSSESSION_ALREADY_USED',
  'POSSESSION_INVALID',
  'POSSESSION_NOT_VERIFIED',
  'ENROLLMENT_MISMATCH',
  'APPROVAL_REFUSED',
  'REQUALIFICATION_FAILED',
  'UNKNOWN_INTEGRATION',
  'AUTHORIZATION_INVALID',
] as const);
export type FederationRefusal = (typeof FEDERATION_REFUSALS)[number];

export class FederationError extends Error {
  readonly code: FederationRefusal;
  readonly detail: string;
  constructor(code: FederationRefusal, detail = '') {
    super(`Federation refused: ${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'FederationError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Evidence rejections reached only AFTER the observation's signature verified under the validator's enrolled key
 * (evidence.ts check order: 4 signature, then 5 challenge/assignment, 6 subject, 7 profile) — so they are attributable.
 */
export const ATTRIBUTABLE_REJECTIONS: readonly string[] = Object.freeze(['CHALLENGE_BINDING_MISMATCH', 'NOT_ASSIGNED', 'SUBJECT_BINDING_MISMATCH', 'UNSUPPORTED_PROFILE', 'PROFILE_DOWNGRADE']);

/** Proof-of-possession requests expire quickly: the nonce must be signed now, by whoever holds the key now. */
export const POSSESSION_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface PossessionChallenge {
  readonly requestId: string;
  readonly statement: KeyPossessionStatement;
  readonly expiresAt: string;
}

/** What two humans sign for a federation action: its kind, its subject and the exact state it moves from. */
export interface PreparedFederationAction {
  readonly action: HumanAction;
  readonly organizationId: string;
  readonly subjectRef: string;
  readonly actionBindingDigest: string;
}

export type GenerationEligibility =
  | { readonly eligible: true; readonly generation: GenerationRow; readonly operatorId: string }
  | {
      readonly eligible: false;
      readonly reason:
        | 'UNKNOWN_VALIDATOR'
        | 'VALIDATOR_NOT_ACTIVE'
        | 'OPERATOR_NOT_ACTIVE'
        | 'NO_ACTIVE_GENERATION'
        | 'CONFORMANCE_RECORD_MISSING'
        | 'REGISTRY_DIVERGENCE'
        | 'QUARANTINED'
        | 'KEY_REVOKED'
        | 'KEY_NOT_VALID';
    };

export interface FederationRegistry {
  registerOperator(input: { readonly operatorId: string; readonly operatorClass: OperatorClass; readonly administrativeOwnerRef: string }): FederationOperatorRecord;
  prepareOperatorAction(operatorId: string, kind: 'approve' | 'reinstate' | 'revoke'): PreparedFederationAction;
  /** REGISTERED → APPROVED (two humans, `operator.approve`); registers the operator in the conformance store. */
  approveOperator(operatorId: string, decisions: readonly unknown[]): void;
  /** APPROVED → ACTIVE. No humans: approval already happened; an unapproved operator can never be activated. */
  activateOperator(operatorId: string): void;
  /** Protective, no humans: ACTIVE → QUARANTINED, and every validator of the operator is quarantined with it. */
  quarantineOperator(operatorId: string, reason: string): void;
  /** QUARANTINED → ACTIVE (two humans). Its validators stay quarantined until each is reinstated on its own. */
  reinstateOperator(operatorId: string, decisions: readonly unknown[]): void;
  /** → REVOKED (two humans). Terminal; every validator and key generation of the operator is revoked. */
  revokeOperator(operatorId: string, decisions: readonly unknown[]): void;

  registerValidator(input: { readonly validatorId: string; readonly operatorId: string; readonly capabilities: ValidatorCapabilities }): FederationValidatorRecord;
  /** Step 1 of ENROLL / ROTATE / REINSTATE: the coordinator issues a nonce the candidate key must sign. */
  requestKeyPossession(input: { readonly validatorId: string; readonly kind: EnrollmentRequestKind; readonly publicKeyPem: string; readonly keyValidFrom: string; readonly keyValidUntil: string }): PossessionChallenge;
  /** Step 2: verifies the signature over the statement, consumes the nonce, and returns the conformance enrollment two humans must approve. */
  proveKeyPossession(requestId: string, signature: unknown): { readonly record: ValidatorEnrollmentRecord; readonly bindingDigest: string };
  /** Step 3: two humans `validator.enroll` (+ two humans `validator.reinstate` for a REINSTATE). */
  completeEnrollment(requestId: string, record: ValidatorEnrollmentRecord, enrollDecisions: readonly unknown[], reinstateDecisions?: readonly unknown[]): GenerationRow;
  /** ENROLLED → ACTIVE once the operator is ACTIVE and an ACTIVE generation exists. */
  activateValidator(validatorId: string): void;
  prepareValidatorAction(validatorId: string, kind: 'reinstate' | 'revoke'): PreparedFederationAction;
  /** Protective, no humans. Quarantines every non-revoked generation in the conformance store, then the validator. */
  quarantineValidator(validatorId: string, reason: string): void;
  /** Ends a REINSTATE once the generation's COMPLETED requalification job shows it agreeing with a reference operator (derived, never asserted). */
  completeReinstatement(validatorId: string, generation: number, requalificationJobId: string): void;
  /** Two humans, `validator.revoke`. Terminal; every generation's key is revoked in the conformance store. */
  revokeValidator(validatorId: string, decisions: readonly unknown[]): void;
  /** Protective, no humans: one generation's key is revoked (compromise). */
  revokeKeyGeneration(conformanceValidatorId: string, reason: string): void;

  /** Two humans of the integration's own organization, `testing.authorize`; synthetic fixtures only. */
  /** RN-CONFORM-07: delegated to the authoritative conformance registry (explicit scope, purpose, limits). */
  prepareTestingAuthorization(input: TestingAuthorizationInput): { readonly record: TestingAuthorization; readonly prepared: PreparedFederationAction };
  authorizeTesting(record: TestingAuthorization, decisions: readonly unknown[]): void;
  /** Protective: revokes the authoritative authorization; the scheduler and coordinator refuse it from now on. */
  revokeTesting(organizationId: string, authorizationId: string, reason: string): void;

  /** Whether `validatorId` may be assigned work now that must stay valid until `untilMs` — re-read from BOTH stores, fail closed. */
  eligibility(validatorId: string, nowMs: number, untilMs: number): GenerationEligibility;
  /** Moves the federation view towards the conformance store's protective events (quarantine / key revocation). */
  syncFromConformance(): readonly string[];
  /**
   * Automatic quarantine for persistent AUTHENTICATED protocol violations: evidence rejections that can only be produced
   * with the validator's own valid signature (binding, assignment, subject and profile defects), plus attributable
   * heartbeat violations, at or above the threshold inside the window. Signature failures are never attributed: anyone
   * can send bytes that claim a validator id, so counting them would let a stranger quarantine an honest validator.
   */
  enforceProtocolThreshold(): readonly string[];
  operatorState(operatorId: string): OperatorState | undefined;
  validatorState(validatorId: string): ValidatorState | undefined;
}

const CLASS_OK = (value: unknown): value is OperatorClass => typeof value === 'string' && (OPERATOR_CLASSES as readonly string[]).includes(value);

function readCapabilities(value: unknown, profiles: ConformanceProfileRegistry): ValidatorCapabilities {
  const read = readClosed(value, ['challengeTypes', 'profiles']);
  if (!read.ok) throw new FederationError('MALFORMED_INPUT', 'capabilities');
  const types = read.record['challengeTypes'];
  const supported = read.record['profiles'];
  if (!Array.isArray(types) || types.length === 0 || new Set(types).size !== types.length || !types.every((t) => (EXECUTABLE_CHALLENGE_TYPES as readonly unknown[]).includes(t))) {
    throw new FederationError('MALFORMED_INPUT', 'challenge types (G01–G08 only; G09/G10 are engine-derived)');
  }
  if (!Array.isArray(supported) || supported.length === 0) throw new FederationError('MALFORMED_INPUT', 'profiles');
  const list = supported.map((p: unknown) => {
    const r = readClosed(p, ['profileId', 'profileVersion']);
    if (!r.ok || !isIdentifier(r.record['profileId']) || typeof r.record['profileVersion'] !== 'string') throw new FederationError('MALFORMED_INPUT', 'profile');
    const profileId = r.record['profileId'] as string;
    const profileVersion = r.record['profileVersion'];
    if (!profiles.resolve(profileId, profileVersion).ok) throw new FederationError('MALFORMED_INPUT', `unknown profile ${profileId}@${profileVersion}`);
    return Object.freeze({ profileId, profileVersion });
  });
  return Object.freeze({ challengeTypes: Object.freeze([...types].sort()), profiles: Object.freeze(list) });
}

export function createFederationRegistry(deps: {
  readonly fed: FederationStore;
  readonly store: ConformanceStore;
  readonly conformance: ConformanceRegistry;
  readonly profiles: ConformanceProfileRegistry;
  readonly humans: SyntheticHumanDirectory;
  readonly clock: { now(): string };
  readonly random: RandomSource;
  /** TEST-ONLY fault injection: runs after the conformance-store enrollment commits and before the federation row (crash between stores). */
  readonly faults?: { readonly afterConformanceEnrollment?: () => void };
}): FederationRegistry {
  const { fed, store, conformance, profiles, humans, clock, random } = deps;
  const nowMs = () => {
    const ms = toMs(clock.now());
    fed.observeClock(ms);
    return ms;
  };
  const event = (kind: Parameters<FederationStore['appendEvent']>[0], atMs: number, subjectKind: 'operator' | 'validator' | 'job' | 'federation', subjectId: string, detail: Record<string, string | number | boolean | null> = {}) =>
    fed.appendEvent(kind, atMs, subjectKind, subjectId, detail);
  const isConsumed = (id: string) => fed.isDecisionConsumed(id) || store.isDecisionConsumed(id);

  const authorize = (prepared: PreparedFederationAction, decisions: readonly unknown[]): FederationConsumedDecision[] => {
    const result = verifyTwoPersonAuthority(humans, decisions, { ...prepared, now: clock.now() }, isConsumed);
    if (!result.authorized) throw new FederationError('APPROVAL_REFUSED', result.denial);
    return result.refs.map((ref) => Object.freeze({ decisionId: ref.decisionId, action: prepared.action, subjectRef: prepared.subjectRef, bindingDigest: prepared.actionBindingDigest }));
  };
  const translate = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof FederationStoreError && error.code === 'CONFLICT') throw new FederationError('APPROVAL_REFUSED', 'ALREADY_CONSUMED');
      throw error;
    }
  };

  const operatorStateOf = (operatorId: string): OperatorState | undefined => fed.operatorState(operatorId)?.state;
  const validatorStateOf = (validatorId: string): ValidatorState | undefined => fed.validatorState(validatorId)?.state;
  const requireOperatorTransition = (operatorId: string, to: OperatorState) => {
    const from = operatorStateOf(operatorId);
    if (from === undefined) throw new FederationError('UNKNOWN_OPERATOR', operatorId);
    if (!OPERATOR_TRANSITIONS[from].includes(to)) throw new FederationError('TRANSITION_NOT_ALLOWED', `${from} → ${to}`);
    return from;
  };
  const requireValidatorTransition = (validatorId: string, to: ValidatorState) => {
    const from = validatorStateOf(validatorId);
    if (from === undefined) throw new FederationError('UNKNOWN_VALIDATOR', validatorId);
    if (!VALIDATOR_TRANSITIONS[from].includes(to)) throw new FederationError('TRANSITION_NOT_ALLOWED', `${from} → ${to}`);
    return from;
  };

  const prepareOperatorAction = (operatorId: string, kind: 'approve' | 'reinstate' | 'revoke'): PreparedFederationAction => {
    const current = fed.operatorState(operatorId);
    if (current === undefined) throw new FederationError('UNKNOWN_OPERATOR', operatorId);
    // P2-5: approval and reinstatement are decided by the AUTHORITATIVE conformance store, so the humans sign its binding.
    if (kind !== 'revoke') return conformance.prepareOperatorAction(operatorId, kind);
    return Object.freeze({
      action: `operator.${kind}` as HumanAction,
      organizationId: CONFORMANCE_NETWORK_ORGANIZATION,
      subjectRef: `operator:${operatorId}`,
      actionBindingDigest: conformanceDigest({ schema: 'rn.conformance.federation-action/1', action: `operator.${kind}`, operatorId, fromState: current.state, fromVersion: current.version, synthetic: true }),
    });
  };
  const prepareValidatorAction = (validatorId: string, kind: 'reinstate' | 'revoke'): PreparedFederationAction => {
    const current = fed.validatorState(validatorId);
    const record = fed.getValidator(validatorId);
    if (current === undefined || record === undefined) throw new FederationError('UNKNOWN_VALIDATOR', validatorId);
    const generations = fed.listGenerations(validatorId).map((g) => g.generation);
    return Object.freeze({
      action: `validator.${kind}` as HumanAction,
      organizationId: CONFORMANCE_NETWORK_ORGANIZATION,
      subjectRef: `validator:${validatorId}`,
      actionBindingDigest: conformanceDigest({
        schema: 'rn.conformance.federation-action/1',
        action: `validator.${kind}`,
        validatorId,
        operatorId: record.operatorId,
        fromState: current.state,
        fromVersion: current.version,
        latestGeneration: generations.length === 0 ? 0 : Math.max(...generations),
        synthetic: true,
      }),
    });
  };

  /** Quarantine every non-revoked generation in the conformance store first, then the federation view. Idempotent. */
  const quarantineGenerations = (validatorId: string, reason: string, at: number) => {
    for (const g of fed.listGenerations(validatorId)) {
      const stored = store.getValidator(g.conformanceValidatorId);
      if (stored !== undefined && stored.quarantinedAtMs === null && stored.keyRevokedAtMs === null) conformance.quarantineValidator(g.conformanceValidatorId, reason);
      const state = fed.generationState(g.validatorId, g.generation)?.state;
      if (state === 'ACTIVE' || state === 'PENDING') fed.appendGenerationState(g.validatorId, g.generation, 'QUARANTINED', at, reason);
    }
  };
  const revokeGenerations = (validatorId: string, reason: string, at: number) => {
    for (const g of fed.listGenerations(validatorId)) {
      const stored = store.getValidator(g.conformanceValidatorId);
      if (stored !== undefined && stored.keyRevokedAtMs === null) conformance.revokeValidatorKey(g.conformanceValidatorId, reason);
      if (fed.generationState(g.validatorId, g.generation)?.state !== 'REVOKED') fed.appendGenerationState(g.validatorId, g.generation, 'REVOKED', at, reason);
      event('KEY_REVOKED', at, 'validator', validatorId, { generation: g.generation, reason });
    }
  };
  const quarantineValidatorInternal = (validatorId: string, reason: string, at: number) => {
    quarantineGenerations(validatorId, reason, at);
    const state = validatorStateOf(validatorId);
    if (state === 'ACTIVE' || state === 'ENROLLED') {
      fed.appendValidatorState(validatorId, 'QUARANTINED', at, reason, []);
      event('VALIDATOR_QUARANTINED', at, 'validator', validatorId, { reason });
    }
  };

  /** Generations not superseded by a later REINSTATE generation (those were resolved by the two-person release). */
  const currentGenerations = (validatorId: string): readonly GenerationRow[] => {
    const all = fed.listGenerations(validatorId);
    const floor = all.filter((g) => g.enrollmentKind === 'REINSTATE').reduce((m, g) => Math.max(m, g.generation), 0);
    return all.filter((g) => g.generation >= floor);
  };
  /** Review P1-1: a quarantine recorded in the conformance store for a current generation, whatever the federation says. */
  const quarantinedInConformance = (validatorId: string): boolean =>
    currentGenerations(validatorId).some((g) => {
      const stored = store.getValidator(g.conformanceValidatorId);
      return stored !== undefined && stored.quarantinedAtMs !== null;
    });
  /**
   * Moves one validator's federation view towards the conformance store, never the other way. Quarantine and key
   * revocation are evaluated independently, for every generation state (a RETIRED or REVOKED generation that was
   * quarantined still quarantines its validator — review P1-1).
   */
  const syncValidator = (validatorId: string, at: number): string[] => {
    const changed: string[] = [];
    for (const g of fed.listGenerations(validatorId)) {
      const stored = store.getValidator(g.conformanceValidatorId);
      if (stored === undefined) continue;
      if (stored.keyRevokedAtMs !== null && fed.generationState(g.validatorId, g.generation)?.state !== 'REVOKED') {
        fed.appendGenerationState(g.validatorId, g.generation, 'REVOKED', at, 'CONFORMANCE_STORE_KEY_REVOKED');
        event('REGISTRY_DIVERGENCE', at, 'validator', validatorId, { generation: g.generation, conformance: 'KEY_REVOKED' });
        changed.push(g.conformanceValidatorId);
      }
    }
    const state = validatorStateOf(validatorId);
    if ((state === 'ACTIVE' || state === 'ENROLLED') && quarantinedInConformance(validatorId)) {
      // Typically evidence acceptance's automatic VALIDATOR_CONFLICT quarantine: the whole validator follows it.
      const hit = currentGenerations(validatorId).filter((g) => (store.getValidator(g.conformanceValidatorId)?.quarantinedAtMs ?? null) !== null);
      for (const g of hit) event('REGISTRY_DIVERGENCE', at, 'validator', validatorId, { generation: g.generation, conformance: 'QUARANTINED' });
      quarantineValidatorInternal(validatorId, 'CONFORMANCE_STORE_QUARANTINE', at);
      for (const g of hit) if (!changed.includes(g.conformanceValidatorId)) changed.push(g.conformanceValidatorId);
    }
    return changed;
  };

  const latestOperatorKind = (operatorId: string) => store.listOperatorEvents(operatorId).at(-1)?.kind;
  const quarantineOperatorInternal = (operatorId: string, reason: string, at: number) => {
    for (const v of fed.listValidators().filter((x) => x.operatorId === operatorId)) quarantineValidatorInternal(v.validatorId, `OPERATOR_QUARANTINED:${reason}`, at);
    const state = operatorStateOf(operatorId);
    if (state === 'APPROVED' || state === 'ACTIVE') {
      fed.appendOperatorState(operatorId, 'QUARANTINED', at, reason, []);
      event('OPERATOR_QUARANTINED', at, 'operator', operatorId, { reason });
    }
  };
  /** P2-5 / S-13: the federation's operator view follows the authoritative conformance store towards restriction. */
  const syncOperator = (operatorId: string, at: number): boolean => {
    if (store.getOperator(operatorId) === undefined) return false;
    const latest = store.listOperatorEvents(operatorId).at(-1)?.kind;
    const state = operatorStateOf(operatorId);
    if (latest === 'REVOKED' && state !== 'REVOKED') {
      for (const v of fed.listValidators().filter((x) => x.operatorId === operatorId)) {
        revokeGenerations(v.validatorId, 'OPERATOR_REVOKED', at);
        if (validatorStateOf(v.validatorId) !== 'REVOKED') fed.appendValidatorState(v.validatorId, 'REVOKED', at, 'OPERATOR_REVOKED', []);
      }
      fed.appendOperatorState(operatorId, 'REVOKED', at, 'CONFORMANCE_STORE_REVOKED', []);
      event('REGISTRY_DIVERGENCE', at, 'operator', operatorId, { conformance: 'REVOKED' });
      return true;
    }
    if (latest === 'QUARANTINED' && (state === 'APPROVED' || state === 'ACTIVE')) {
      event('REGISTRY_DIVERGENCE', at, 'operator', operatorId, { conformance: 'QUARANTINED' });
      quarantineOperatorInternal(operatorId, 'CONFORMANCE_STORE_QUARANTINE', at);
      return true;
    }
    return false;
  };

  const registry: FederationRegistry = {
    registerOperator(input) {
      const read = readClosed(input, ['operatorId', 'operatorClass', 'administrativeOwnerRef']);
      if (!read.ok || !isIdentifier(input.operatorId) || !CLASS_OK(input.operatorClass) || !isIdentifier(input.administrativeOwnerRef)) throw new FederationError('MALFORMED_INPUT', 'operator');
      const at = nowMs();
      const existing = fed.getOperator(input.operatorId);
      if (existing !== undefined) throw new FederationError('DUPLICATE_OPERATOR', input.operatorId);
      // Review P2-5: an operator id that already exists in the conformance store (with validators enrolled outside the
      // federation) is never adopted: the federation would otherwise inherit votes it does not govern.
      if (store.getOperator(input.operatorId) !== undefined) throw new FederationError('DUPLICATE_OPERATOR', `${input.operatorId} already exists in the conformance store`);
      const record: FederationOperatorRecord = Object.freeze({
        schema: 'rn.conformance.federation-operator/1',
        operatorId: input.operatorId,
        operatorClass: input.operatorClass,
        administrativeOwnerRef: input.administrativeOwnerRef,
        designation: FEDERATION_DESIGNATION,
        independenceVerification: INDEPENDENCE_VERIFICATION,
        statement: FEDERATION_OPERATOR_STATEMENT,
        registeredAt: toTimestamp(at),
        synthetic: true,
      });
      try {
        fed.insertOperator(record, at);
      } catch (error) {
        // F-12: two concurrent registrations of one identity — exactly one row wins, the other is a duplicate.
        if (error instanceof FederationStoreError && error.code === 'CONFLICT') throw new FederationError('DUPLICATE_OPERATOR', input.operatorId);
        throw error;
      }
      event('OPERATOR_REGISTERED', at, 'operator', record.operatorId, { operatorClass: record.operatorClass });
      return record;
    },
    prepareOperatorAction,
    approveOperator(operatorId, decisions) {
      requireOperatorTransition(operatorId, 'APPROVED');
      if (operatorStateOf(operatorId) !== 'REGISTERED') throw new FederationError('TRANSITION_NOT_ALLOWED', 'only a REGISTERED operator is approved');
      // The conformance store is authoritative: its two-person APPROVED event (trigger-checked) is what makes the operator
      // eligible. A retry after a crash between the stores adopts an approval the conformance store already recorded.
      // Review C-3: decided on the latest event by SEQUENCE (never a clock-filtered view): adopt only a recorded APPROVED.
      if (latestOperatorKind(operatorId) !== 'APPROVED') {
        // Verified first (nothing is written for a refused approval), then re-verified and consumed by the store.
        authorize(prepareOperatorAction(operatorId, 'approve'), decisions);
        if (store.getOperator(operatorId) === undefined) conformance.registerSyntheticOperator(operatorId);
        try {
          conformance.approveOperator(operatorId, decisions);
        } catch (error) {
          if (error instanceof ConformanceRegistryError) throw new FederationError('APPROVAL_REFUSED', error.detail === '' ? error.code : error.detail);
          throw error;
        }
      }
      const at = nowMs();
      fed.appendOperatorState(operatorId, 'APPROVED', at, 'TWO_PERSON_APPROVAL_IN_CONFORMANCE_STORE', []);
      event('OPERATOR_APPROVED', at, 'operator', operatorId, { authoritative: 'conformance-store' });
    },
    activateOperator(operatorId) {
      const from = requireOperatorTransition(operatorId, 'ACTIVE');
      if (from !== 'APPROVED') throw new FederationError('TRANSITION_NOT_ALLOWED', `${from} → ACTIVE needs operator.reinstate`);
      const at = nowMs();
      fed.appendOperatorState(operatorId, 'ACTIVE', at, 'ACTIVATED', []);
      event('OPERATOR_ACTIVATED', at, 'operator', operatorId);
    },
    quarantineOperator(operatorId, reason) {
      requireOperatorTransition(operatorId, 'QUARANTINED');
      if (!isIdentifier(reason)) throw new FederationError('MALFORMED_INPUT', 'reason');
      // Authoritative store first: from this instant no validator of the operator enrolls or contributes evidence.
      // Review C-3: by sequence, so a slightly regressed clock can never skip the authoritative quarantine.
      const latest = latestOperatorKind(operatorId);
      if (latest === 'APPROVED' || latest === 'REINSTATED' || latest === 'LEGACY') conformance.quarantineOperator(operatorId, reason);
      quarantineOperatorInternal(operatorId, reason, nowMs());
    },
    reinstateOperator(operatorId, decisions) {
      requireOperatorTransition(operatorId, 'ACTIVE');
      if (operatorStateOf(operatorId) !== 'QUARANTINED') throw new FederationError('TRANSITION_NOT_ALLOWED', 'only a QUARANTINED operator is reinstated');
      // Review C-3: adopt only a REINSTATED recorded after the QUARANTINED this federation mirrors; otherwise the two
      // humans are verified (and refused if the authoritative store is not quarantined — fail closed).
      if (latestOperatorKind(operatorId) !== 'REINSTATED') {
        try {
          conformance.reinstateOperator(operatorId, decisions);
        } catch (error) {
          if (error instanceof ConformanceRegistryError) throw new FederationError('APPROVAL_REFUSED', error.detail === '' ? error.code : error.detail);
          throw error;
        }
      }
      const at = nowMs();
      fed.appendOperatorState(operatorId, 'ACTIVE', at, 'TWO_PERSON_REINSTATEMENT_IN_CONFORMANCE_STORE', []);
      event('OPERATOR_REINSTATED', at, 'operator', operatorId);
    },
    revokeOperator(operatorId, decisions) {
      requireOperatorTransition(operatorId, 'REVOKED');
      const consumed = authorize(prepareOperatorAction(operatorId, 'revoke'), decisions);
      // Authoritative, terminal revocation first (protective in the conformance store).
      if (store.getOperator(operatorId) !== undefined && store.listOperatorEvents(operatorId).at(-1)?.kind !== 'REVOKED') conformance.revokeOperator(operatorId, 'OPERATOR_REVOKED');
      const at = nowMs();
      for (const v of fed.listValidators().filter((x) => x.operatorId === operatorId)) {
        revokeGenerations(v.validatorId, 'OPERATOR_REVOKED', at);
        if (validatorStateOf(v.validatorId) !== 'REVOKED') {
          fed.appendValidatorState(v.validatorId, 'REVOKED', at, 'OPERATOR_REVOKED', []);
          event('VALIDATOR_REVOKED', at, 'validator', v.validatorId, { reason: 'OPERATOR_REVOKED' });
        }
      }
      translate(() => fed.appendOperatorState(operatorId, 'REVOKED', at, 'TWO_PERSON_REVOCATION', consumed));
      event('OPERATOR_REVOKED', at, 'operator', operatorId);
    },

    registerValidator(input) {
      const read = readClosed(input, ['validatorId', 'operatorId', 'capabilities']);
      // `.k<n>` is reserved for generation identities, so a validator id can never collide with one.
      if (!read.ok || !isIdentifier(input.validatorId) || /\.k\d+$/.test(input.validatorId) || input.validatorId.length > 100 || !isIdentifier(input.operatorId)) throw new FederationError('MALFORMED_INPUT', 'validator');
      const operator = fed.getOperator(input.operatorId);
      const opState = operatorStateOf(input.operatorId);
      if (operator === undefined) throw new FederationError('UNKNOWN_OPERATOR', input.operatorId);
      if (opState !== 'APPROVED' && opState !== 'ACTIVE') throw new FederationError('OPERATOR_NOT_ELIGIBLE', `${input.operatorId} is ${opState ?? 'unknown'}`);
      if (!conformance.operatorEligible(input.operatorId)) throw new FederationError('OPERATOR_NOT_ELIGIBLE', `${input.operatorId} is not eligible in the conformance store`);
      const capabilities = readCapabilities(input.capabilities, profiles);
      const at = nowMs();
      if (fed.getValidator(input.validatorId) !== undefined || store.getValidator(input.validatorId) !== undefined) throw new FederationError('DUPLICATE_VALIDATOR', input.validatorId);
      const record: FederationValidatorRecord = Object.freeze({ schema: 'rn.conformance.federation-validator/1', validatorId: input.validatorId, operatorId: input.operatorId, capabilities, registeredAt: toTimestamp(at), synthetic: true });
      try {
        fed.atomically(() => {
          fed.insertValidator(record);
          fed.appendValidatorState(record.validatorId, 'ENROLLED', at, 'REGISTERED', []);
        });
      } catch (error) {
        if (error instanceof FederationStoreError && error.code === 'CONFLICT') throw new FederationError('DUPLICATE_VALIDATOR', input.validatorId);
        throw error;
      }
      event('VALIDATOR_REGISTERED', at, 'validator', record.validatorId, { operatorId: record.operatorId });
      return record;
    },

    requestKeyPossession(input) {
      const read = readClosed(input, ['validatorId', 'kind', 'publicKeyPem', 'keyValidFrom', 'keyValidUntil']);
      if (!read.ok || !isIdentifier(input.validatorId) || !['ENROLL', 'ROTATE', 'REINSTATE'].includes(input.kind) || typeof input.publicKeyPem !== 'string' || !isTimestamp(input.keyValidFrom) || !isTimestamp(input.keyValidUntil) || toMs(input.keyValidUntil) <= toMs(input.keyValidFrom)) {
        throw new FederationError('MALFORMED_INPUT', 'possession request');
      }
      const validator = fed.getValidator(input.validatorId);
      if (validator === undefined) throw new FederationError('UNKNOWN_VALIDATOR', input.validatorId);
      if (/PRIVATE KEY/.test(input.publicKeyPem)) throw new FederationError('KEY_NOT_PUBLIC');
      let keyId: string;
      try {
        const key = createPublicKey(input.publicKeyPem);
        if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
        keyId = deriveConformanceKeyId(key);
      } catch {
        throw new FederationError('KEY_NOT_PUBLIC');
      }
      if (fed.getGenerationByKeyId(keyId) !== undefined || store.getValidatorByKeyId(keyId) !== undefined) throw new FederationError('KEY_REUSED');
      // Review P1-1: mirror the conformance store's protective events before deciding anything about this validator.
      syncValidator(input.validatorId, nowMs());
      if (input.kind !== 'REINSTATE' && quarantinedInConformance(input.validatorId)) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', 'a generation of this validator is quarantined');
      const vState = validatorStateOf(input.validatorId);
      const opState = operatorStateOf(validator.operatorId);
      const generations = fed.listGenerations(input.validatorId);
      // ENROLL: the first generation. ROTATE: an ACTIVE validator only — rotation never bypasses quarantine.
      // REINSTATE: a QUARANTINED validator; the compromised identity is never revived, a new generation replaces it.
      const allowed =
        (input.kind === 'ENROLL' && generations.length === 0 && vState === 'ENROLLED' && (opState === 'APPROVED' || opState === 'ACTIVE')) ||
        (input.kind === 'ROTATE' && generations.length > 0 && vState === 'ACTIVE' && opState === 'ACTIVE') ||
        (input.kind === 'REINSTATE' && generations.length > 0 && vState === 'QUARANTINED' && opState === 'ACTIVE');
      if (!allowed) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', `${input.kind} with validator ${vState ?? '?'} / operator ${opState ?? '?'}`);
      const at = nowMs();
      const generation = generations.length + 1;
      const requestId = `pop_${random.bytes(16).toString('hex')}`;
      const nonce = random.bytes(32).toString('base64url');
      const statement: KeyPossessionStatement = Object.freeze({
        schema: 'rn.conformance.validator-key-possession/1',
        requestId,
        validatorId: input.validatorId,
        operatorId: validator.operatorId,
        generation,
        keyId,
        nonce,
        synthetic: true,
      });
      fed.insertPossessionRequest({
        requestId,
        kind: input.kind,
        validatorId: input.validatorId,
        operatorId: validator.operatorId,
        generation,
        keyId,
        publicKeyPem: input.publicKeyPem,
        validFromMs: toMs(input.keyValidFrom),
        validUntilMs: toMs(input.keyValidUntil),
        nonce,
        issuedMs: at,
        expiresMs: at + POSSESSION_REQUEST_TTL_MS,
      });
      event('KEY_REGISTERED', at, 'validator', input.validatorId, { generation, kind: input.kind, keyId });
      if (input.kind === 'ROTATE') event('KEY_ROTATION_STARTED', at, 'validator', input.validatorId, { generation });
      return Object.freeze({ requestId, statement, expiresAt: toTimestamp(at + POSSESSION_REQUEST_TTL_MS) });
    },

    proveKeyPossession(requestId, signature) {
      const request = fed.getPossessionRequest(requestId);
      if (request === undefined) throw new FederationError('POSSESSION_UNKNOWN');
      const at = nowMs();
      if (fed.isPossessionConsumed(requestId)) throw new FederationError('POSSESSION_ALREADY_USED');
      if (at >= request.expiresMs) throw new FederationError('POSSESSION_EXPIRED');
      const statement: KeyPossessionStatement = {
        schema: 'rn.conformance.validator-key-possession/1',
        requestId,
        validatorId: request.validatorId,
        operatorId: request.operatorId,
        generation: request.generation,
        keyId: request.keyId,
        nonce: request.nonce,
        synthetic: true,
      };
      if (!verifyConformanceSignature('keyPossession', statement, signature, request.publicKeyPem).ok) {
        event('KEY_POSSESSION_REFUSED', at, 'validator', request.validatorId, { generation: request.generation });
        throw new FederationError('POSSESSION_INVALID');
      }
      try {
        fed.consumePossession(requestId, at);
      } catch (error) {
        if (error instanceof FederationStoreError && error.code === 'CONFLICT') throw new FederationError('POSSESSION_ALREADY_USED');
        throw error;
      }
      event('KEY_POSSESSION_VERIFIED', at, 'validator', request.validatorId, { generation: request.generation });
      return conformance.prepareValidatorEnrollment({
        validatorId: generationIdentity(request.validatorId, request.generation),
        operatorId: request.operatorId,
        publicKeyPem: request.publicKeyPem,
        keyValidFrom: toTimestamp(request.validFromMs),
        keyValidUntil: toTimestamp(request.validUntilMs),
      });
    },

    completeEnrollment(requestId, record, enrollDecisions, reinstateDecisions) {
      const request = fed.getPossessionRequest(requestId);
      if (request === undefined) throw new FederationError('POSSESSION_UNKNOWN');
      if (!fed.isPossessionConsumed(requestId)) throw new FederationError('POSSESSION_NOT_VERIFIED');
      const cvid = generationIdentity(request.validatorId, request.generation);
      // The enrollment must be exactly the one the possession proof covered: same identity, operator, key and window.
      if (
        record.validatorId !== cvid || record.operatorId !== request.operatorId || record.keyId !== request.keyId || record.publicKeyPem !== request.publicKeyPem ||
        toMs(record.keyValidFrom) !== request.validFromMs || toMs(record.keyValidUntil) !== request.validUntilMs
      ) {
        throw new FederationError('ENROLLMENT_MISMATCH');
      }
      const validator = fed.getValidator(request.validatorId);
      if (validator === undefined || validator.operatorId !== request.operatorId) throw new FederationError('ENROLLMENT_MISMATCH', 'operator binding');
      // Review P1-1: the conformance store's protective events are read first, so an automatic quarantine that the
      // federation has not mirrored yet still blocks a rotation (or any enrollment) of this validator.
      syncValidator(request.validatorId, nowMs());
      if (request.kind !== 'REINSTATE' && quarantinedInConformance(request.validatorId)) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', 'a generation of this validator is quarantined');
      const vState = validatorStateOf(request.validatorId);
      const opState = operatorStateOf(request.operatorId);
      const stillAllowed =
        (request.kind === 'ENROLL' && vState === 'ENROLLED' && (opState === 'APPROVED' || opState === 'ACTIVE')) ||
        (request.kind === 'ROTATE' && vState === 'ACTIVE' && opState === 'ACTIVE') ||
        (request.kind === 'REINSTATE' && vState === 'QUARANTINED' && opState === 'ACTIVE');
      let row = fed.listGenerations(request.validatorId).find((g) => g.generation === request.generation);
      if (row !== undefined) {
        // A retry: the intent row exists. Done or no longer pending → nothing to complete.
        if (row.keyId !== request.keyId) throw new FederationError('ENROLLMENT_MISMATCH', 'generation intent');
        if (fed.generationState(row.validatorId, row.generation)?.state !== 'PENDING' || (request.kind === 'REINSTATE' && store.getValidator(cvid) !== undefined)) return row;
        if (!stillAllowed) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', `${request.kind} with validator ${vState ?? '?'} / operator ${opState ?? '?'}`);
      } else {
        if (!stillAllowed) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', `${request.kind} with validator ${vState ?? '?'} / operator ${opState ?? '?'}`);
        const reinstateConsumed = request.kind === 'REINSTATE' ? authorize(prepareValidatorAction(request.validatorId, 'reinstate'), reinstateDecisions ?? []) : [];
        const intentAt = nowMs();
        const intent: GenerationRow = Object.freeze({
          validatorId: request.validatorId,
          generation: request.generation,
          conformanceValidatorId: cvid,
          operatorId: request.operatorId,
          keyId: request.keyId,
          publicKeyPem: request.publicKeyPem,
          validFromMs: request.validFromMs,
          validUntilMs: request.validUntilMs,
          enrollmentKind: request.kind,
          bindingDigest: conformanceDigest(record),
          createdMs: intentAt,
        });
        // Review P2-2: the federation INTENT (a PENDING generation) is durable BEFORE the conformance-store identity
        // exists, so a crash between the stores never leaves a conformance identity that quarantine or revocation
        // (which sweep the federation's generations) cannot reach.
        translate(() =>
          fed.atomically(() => {
            fed.insertGeneration(intent);
            if (reinstateConsumed.length > 0) fed.consumeDecisions(reinstateConsumed, `reinstate:${cvid}`, intentAt);
          }),
        );
        row = intent;
      }

      // Conformance store next (two humans validator.enroll, enforced there by trigger too). Idempotent on retry.
      try {
        conformance.enrollValidator(record, enrollDecisions);
      } catch (error) {
        if (error instanceof ConformanceRegistryError) throw new FederationError(error.code === 'KEY_REUSED' ? 'KEY_REUSED' : 'APPROVAL_REFUSED', error.code);
        throw error;
      }
      deps.faults?.afterConformanceEnrollment?.();
      const at = nowMs();
      const done = row;
      fed.atomically(() => {
        if (request.kind === 'ENROLL') {
          fed.appendGenerationState(done.validatorId, done.generation, 'ACTIVE', at, 'ENROLLED');
        } else if (request.kind === 'ROTATE') {
          for (const g of fed.listGenerations(done.validatorId)) {
            if (g.generation !== done.generation && fed.generationState(g.validatorId, g.generation)?.state === 'ACTIVE') fed.appendGenerationState(g.validatorId, g.generation, 'RETIRED', at, 'ROTATED');
          }
          fed.appendGenerationState(done.validatorId, done.generation, 'ACTIVE', at, 'ROTATED');
        }
        // REINSTATE stays PENDING until the requalification challenge passes.
      });
      event('VALIDATOR_ENROLLED', at, 'validator', done.validatorId, { generation: done.generation, kind: done.enrollmentKind });
      if (request.kind === 'ENROLL' || request.kind === 'ROTATE') event('KEY_ACTIVATED', at, 'validator', done.validatorId, { generation: done.generation });
      if (request.kind === 'ROTATE') event('KEY_ROTATION_COMPLETED', at, 'validator', done.validatorId, { generation: done.generation });
      return done;
    },

    activateValidator(validatorId) {
      const from = requireValidatorTransition(validatorId, 'ACTIVE');
      if (from !== 'ENROLLED') throw new FederationError('TRANSITION_NOT_ALLOWED', `${from} → ACTIVE needs reinstatement`);
      const record = fed.getValidator(validatorId) as FederationValidatorRecord;
      if (operatorStateOf(record.operatorId) !== 'ACTIVE') throw new FederationError('OPERATOR_NOT_ELIGIBLE', record.operatorId);
      const active = fed.listGenerations(validatorId).some((g) => fed.generationState(validatorId, g.generation)?.state === 'ACTIVE');
      if (!active) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', 'no ACTIVE key generation');
      const at = nowMs();
      fed.appendValidatorState(validatorId, 'ACTIVE', at, 'ACTIVATED', []);
      event('VALIDATOR_ACTIVATED', at, 'validator', validatorId);
    },
    prepareValidatorAction,
    quarantineValidator(validatorId, reason) {
      if (fed.getValidator(validatorId) === undefined) throw new FederationError('UNKNOWN_VALIDATOR', validatorId);
      if (!isIdentifier(reason)) throw new FederationError('MALFORMED_INPUT', 'reason');
      const state = validatorStateOf(validatorId);
      if (state === 'REVOKED') throw new FederationError('TRANSITION_NOT_ALLOWED', 'REVOKED → QUARANTINED');
      quarantineValidatorInternal(validatorId, reason, nowMs());
    },
    completeReinstatement(validatorId, generation, requalificationJobId) {
      if (validatorStateOf(validatorId) !== 'QUARANTINED') throw new FederationError('TRANSITION_NOT_ALLOWED', 'not quarantined');
      const row = fed.listGenerations(validatorId).find((g) => g.generation === generation);
      if (row === undefined || row.enrollmentKind !== 'REINSTATE' || fed.generationState(validatorId, generation)?.state !== 'PENDING') throw new FederationError('VALIDATOR_NOT_ELIGIBLE', 'no pending reinstatement generation');
      const record = fed.getValidator(validatorId) as FederationValidatorRecord;
      if (operatorStateOf(record.operatorId) !== 'ACTIVE') throw new FederationError('OPERATOR_NOT_ELIGIBLE', record.operatorId);
      const stored = store.getValidator(row.conformanceValidatorId);
      if (stored === undefined || stored.quarantinedAtMs !== null || stored.keyRevokedAtMs !== null) throw new FederationError('VALIDATOR_NOT_ELIGIBLE', 'the new generation is not eligible in the conformance store');
      const at = nowMs();
      // Review P2-1: the result is DERIVED here from the durable requalification job and the stored evidence — never
      // taken from the caller. The job must be a COMPLETED REQUALIFICATION job for exactly this generation, against a
      // REQUALIFICATION authorization, with a reference validator of another operator, and both observations must agree.
      const job = fed.getJob(requalificationJobId);
      const auth = job === undefined ? undefined : fed.getAuthorization(job.authorizationId);
      const candidate = job?.assignments.find((a) => a.conformanceValidatorId === row.conformanceValidatorId);
      const reference = job?.assignments.find((a) => a.operatorId !== record.operatorId);
      const candidateObs = job?.challengeId === null || job === undefined || candidate === undefined ? undefined : store.getObservationForChallengeValidator(job.challengeId, candidate.conformanceValidatorId);
      const referenceObs = job?.challengeId === null || job === undefined || reference === undefined ? undefined : store.getObservationForChallengeValidator(job.challengeId, reference.conformanceValidatorId);
      const passed =
        job !== undefined && job.purpose === 'REQUALIFICATION' && job.state === 'COMPLETED' && auth?.record.purpose === 'VALIDATOR_REQUALIFICATION' && candidate !== undefined && reference !== undefined &&
        // Codex P2 / S-08: the probation target must STILL have no credential at the decision point.
        !store.hasCredentialForIntegration(job.organizationId, job.integrationDigest) &&
        auth.record.integrationDigest === job.integrationDigest && auth.record.organizationId === job.organizationId &&
        candidateObs !== undefined && referenceObs !== undefined && candidateObs.outcomeClass === referenceObs.outcomeClass && candidateObs.outcomeClass !== 'inconclusive';
      if (!passed) {
        event('REQUALIFICATION_SCHEDULED', at, 'validator', validatorId, { generation, result: 'FAILED' });
        throw new FederationError('REQUALIFICATION_FAILED', job === undefined ? 'unknown requalification job' : `job ${job.state}`);
      }
      fed.atomically(() => {
        fed.appendGenerationState(validatorId, generation, 'ACTIVE', at, 'REQUALIFIED');
        fed.appendValidatorState(validatorId, 'ACTIVE', at, 'REINSTATED_AFTER_REQUALIFICATION', []);
      });
      event('REQUALIFICATION_PASSED', at, 'validator', validatorId, { generation, jobId: requalificationJobId });
      event('VALIDATOR_REINSTATED', at, 'validator', validatorId, { generation });
    },
    revokeValidator(validatorId, decisions) {
      requireValidatorTransition(validatorId, 'REVOKED');
      const consumed = authorize(prepareValidatorAction(validatorId, 'revoke'), decisions);
      const at = nowMs();
      revokeGenerations(validatorId, 'VALIDATOR_REVOKED', at);
      translate(() => fed.appendValidatorState(validatorId, 'REVOKED', at, 'TWO_PERSON_REVOCATION', consumed));
      event('VALIDATOR_REVOKED', at, 'validator', validatorId, { reason: 'TWO_PERSON_REVOCATION' });
    },
    revokeKeyGeneration(conformanceValidatorId, reason) {
      const g = fed.getGenerationByConformanceId(conformanceValidatorId);
      if (g === undefined) throw new FederationError('UNKNOWN_VALIDATOR', conformanceValidatorId);
      if (!isIdentifier(reason)) throw new FederationError('MALFORMED_INPUT', 'reason');
      const at = nowMs();
      const stored = store.getValidator(conformanceValidatorId);
      if (stored !== undefined && stored.keyRevokedAtMs === null) conformance.revokeValidatorKey(conformanceValidatorId, reason);
      if (fed.generationState(g.validatorId, g.generation)?.state !== 'REVOKED') fed.appendGenerationState(g.validatorId, g.generation, 'REVOKED', at, reason);
      event('KEY_REVOKED', at, 'validator', g.validatorId, { generation: g.generation, reason });
    },

    prepareTestingAuthorization(input) {
      // RN-CONFORM-07: delegated to the AUTHORITATIVE conformance registry (closed record, explicit scope, purpose).
      try {
        const prepared = conformance.prepareTestingAuthorization(input);
        return Object.freeze({ record: prepared.record, prepared: prepared.prepared });
      } catch (error) {
        if (error instanceof ConformanceRegistryError) throw new FederationError(error.code === 'UNKNOWN_INTEGRATION' ? 'UNKNOWN_INTEGRATION' : error.code === 'MALFORMED_INPUT' ? 'MALFORMED_INPUT' : 'AUTHORIZATION_INVALID', error.detail === '' ? error.code : error.detail);
        throw error;
      }
    },
    authorizeTesting(record, decisions) {
      // Approved and consumed in the conformance store (trigger-checked two humans); the federation keeps a mirror.
      let stored: StoredTestingAuthorization;
      try {
        stored = conformance.authorizeTesting(record, decisions);
      } catch (error) {
        if (error instanceof ConformanceRegistryError) throw new FederationError(error.code === 'APPROVAL_REFUSED' ? 'APPROVAL_REFUSED' : 'AUTHORIZATION_INVALID', error.detail === '' ? error.code : error.detail);
        throw error;
      }
      translate(() => fed.insertAuthorization(stored.record, [], nowMs()));
    },
    revokeTesting(organizationId, authorizationId, reason) {
      if (!isIdentifier(reason)) throw new FederationError('MALFORMED_INPUT', 'reason');
      try {
        conformance.revokeTestingAuthorization(organizationId, authorizationId, reason);
      } catch (error) {
        if (error instanceof ConformanceRegistryError) throw new FederationError('AUTHORIZATION_INVALID', error.code);
        throw error;
      }
      event('JOB_CANCELLED', nowMs(), 'federation', authorizationId, { reason: 'AUTHORIZATION_REVOKED' });
    },

    eligibility(validatorId, now, untilMs) {
      const record = fed.getValidator(validatorId);
      if (record === undefined) return { eligible: false, reason: 'UNKNOWN_VALIDATOR' };
      if (validatorStateOf(validatorId) !== 'ACTIVE') return { eligible: false, reason: 'VALIDATOR_NOT_ACTIVE' };
      if (operatorStateOf(record.operatorId) !== 'ACTIVE') return { eligible: false, reason: 'OPERATOR_NOT_ACTIVE' };
      // P2-5 / S-13: the authoritative operator status, not only the federation's view of it.
      if (!operatorEligibleAt(store.listOperatorEvents(record.operatorId), now)) return { eligible: false, reason: 'OPERATOR_NOT_ACTIVE' };
      // P1-1 / S-01: a protective quarantine on ANY current generation (including a retired one with an outstanding
      // challenge) makes the validator ineligible at once — before and independently of any federation sync.
      if (quarantinedInConformance(validatorId)) return { eligible: false, reason: 'QUARANTINED' };
      const active = fed.listGenerations(validatorId).filter((g) => fed.generationState(validatorId, g.generation)?.state === 'ACTIVE');
      // Exactly one ACTIVE generation: two would be an inconsistent rotation, refused rather than guessed at.
      if (active.length !== 1) return { eligible: false, reason: 'NO_ACTIVE_GENERATION' };
      const generation = active[0] as GenerationRow;
      const stored = store.getValidator(generation.conformanceValidatorId);
      if (stored === undefined) return { eligible: false, reason: 'CONFORMANCE_RECORD_MISSING' };
      if (stored.record.operatorId !== record.operatorId || stored.record.keyId !== generation.keyId || generation.operatorId !== record.operatorId) return { eligible: false, reason: 'REGISTRY_DIVERGENCE' };
      if (stored.quarantinedAtMs !== null && stored.quarantinedAtMs <= now) return { eligible: false, reason: 'QUARANTINED' };
      if (stored.keyRevokedAtMs !== null && stored.keyRevokedAtMs <= now) return { eligible: false, reason: 'KEY_REVOKED' };
      if (toMs(stored.record.keyValidFrom) > now || toMs(stored.record.keyValidUntil) < untilMs) return { eligible: false, reason: 'KEY_NOT_VALID' };
      return { eligible: true, generation, operatorId: record.operatorId };
    },
    syncFromConformance() {
      const at = nowMs();
      const operators = fed.listOperators().filter((o) => syncOperator(o.operatorId, at)).map((o) => o.operatorId);
      return Object.freeze([...operators, ...fed.listValidators().flatMap((v) => syncValidator(v.validatorId, at))]);
    },
    enforceProtocolThreshold() {
      const at = nowMs();
      const windowStart = at - FEDERATION_TIMING.protocolViolationWindowSeconds * 1000;
      for (const r of store.listRejections()) {
        if (r.validatorId === null || !ATTRIBUTABLE_REJECTIONS.includes(r.reason)) continue;
        if (fed.getGenerationByConformanceId(r.validatorId) === undefined) continue;
        // Review P3-3: one signed submission is one violation, however its bytes are re-encoded (ref = its event id).
        fed.recordViolation(r.validatorId, `EVIDENCE_${r.reason}`, r.eventId ?? r.submissionDigest, at);
      }
      const quarantined: string[] = [];
      for (const v of fed.listValidators()) {
        const state = validatorStateOf(v.validatorId);
        if (state !== 'ACTIVE' && state !== 'ENROLLED') continue;
        // Only the generations since the last reinstatement, and only violations since it: a released validator starts clean.
        const reinstatedAt = fed.validatorHistory(v.validatorId).filter((h) => h.reason === 'REINSTATED_AFTER_REQUALIFICATION').reduce((m, h) => Math.max(m, h.atMs), 0);
        const since = Math.max(windowStart, reinstatedAt);
        const count = currentGenerations(v.validatorId).reduce((n, g) => n + fed.countViolations(g.conformanceValidatorId, since), 0);
        if (count >= FEDERATION_TIMING.protocolViolationThreshold) {
          quarantineValidatorInternal(v.validatorId, 'PROTOCOL_VIOLATION_THRESHOLD', at);
          quarantined.push(v.validatorId);
        }
      }
      return Object.freeze(quarantined);
    },
    operatorState: operatorStateOf,
    validatorState: validatorStateOf,
  };
  return Object.freeze(registry);
}
