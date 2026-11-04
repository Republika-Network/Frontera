import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conformanceDigest } from '../conformance/canonical.js';
import { DEPLOYMENT_ATTESTATION_OPERATION, createChallengeCoordinator, newIdentifier, type RandomSource } from '../conformance/coordinator.js';
import type { ChallengeType, HumanAction, ObservationPayload, ObservedOutcome, SignedChallenge, SignedHumanDecision } from '../conformance/contracts.js';
import { HUMAN_DECISION_FORMAT, toMs, toTimestamp } from '../conformance/contracts.js';
import { classifyOutcome } from '../conformance/engine.js';
import { createEvidenceService, type SubmissionResult } from '../conformance/evidence.js';
import { createSyntheticHumanDirectory, type SyntheticHumanDirectory } from '../conformance/human-authority.js';
import { createCredentialLifecycle, type PreparedAction } from '../conformance/lifecycle.js';
import { RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, createConformanceProfileRegistry, type ConformanceProfileRegistry } from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, createConformanceRegistry, type ConformanceClock } from '../conformance/registry.js';
import { openConformanceStore, type ConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import { verifyCurrentConformance, type ConformanceExpectation } from '../conformance/verifier.js';

/**
 * RN-CONFORM-02 — SYNTHETIC FEDERATION TEST HARNESS. TEST CODE ONLY.
 *
 * Every key here is derived at run time from a public label, so it is a test
 * key by construction and no key material is committed. Every operator is a
 * synthetic label; three operator ids do not mean three independent parties,
 * and nothing here is evidence that independent validator operators exist.
 * The fixture platform's bypass switch lives only in this file.
 */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A deterministic Ed25519 test key for `label`. Never a real key: the seed is sha256 of a public string. */
export function testKey(label: string): KeyObject {
  const seed = createHash('sha256').update(`rn-conform-02:synthetic-test-key:${label}`).digest();
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Deterministic, test-only randomness: sha256(seed ‖ counter). Never used outside tests. */
export function deterministicRandom(seed: string): RandomSource {
  let counter = 0;
  return Object.freeze({
    bytes(length: number): Buffer {
      const out: Buffer[] = [];
      let total = 0;
      while (total < length) {
        const block = createHash('sha256').update(`${seed}:${counter++}`).digest();
        out.push(block);
        total += block.length;
      }
      return Buffer.concat(out).subarray(0, length);
    },
  });
}

export interface ManualClock extends ConformanceClock {
  set(iso: string): void;
  advance(seconds: number): string;
  ms(): number;
}

export function manualClock(start: string): ManualClock {
  let now = toMs(start);
  return {
    now: () => toTimestamp(now),
    ms: () => now,
    set: (iso: string) => {
      now = toMs(iso);
    },
    advance: (seconds: number) => {
      now += Math.round(seconds * 1000);
      return toTimestamp(now);
    },
  };
}

export const ORG_A = 'org-synthetic-alpha';
export const ORG_B = 'org-synthetic-beta';
export const T0 = '2026-11-02T09:00:00.000Z';
export const SDK = Object.freeze({ package: '@republika-synthetic/conformance-fixture-sdk', version: '1.2.0', lockDigest: `sha256:${'1'.repeat(64)}` });
export const ADAPTER = Object.freeze({ name: 'synthetic-document-pep', version: '0.1.0', digest: `sha256:${'2'.repeat(64)}` });
export const DEPLOYMENT_V1 = `sha256:${'3'.repeat(64)}`;
export const OPERATIONS = Object.freeze(['document.export', 'document.open']);

// ---------------------------------------------------------------------------
// The synthetic platform: a tiny policy enforcement point with test-only bypass switches.
// ---------------------------------------------------------------------------

export type SyntheticBypass = 'none' | 'unauthorized-operation' | 'ignore-revocation' | 'reuse-stale-decision' | 'ignore-tenant' | 'fail-open';

export interface SyntheticPlatform {
  /** TEST-ONLY bypass switch. Affects this fixture object and nothing else. */
  bypass: SyntheticBypass;
  deployedDigest: string;
  /** Runs the procedure a challenge type names against this fixture and reports what a validator would observe. */
  respond(challengeType: ChallengeType): { observedOutcome: ObservedOutcome; observedDeploymentDigest: string | null };
}

export function syntheticPlatform(deployedDigest: string = DEPLOYMENT_V1): SyntheticPlatform {
  // A minimal enforcement model: one valid principal of ORG_A, a revocation flag, a decision cache with a ceiling, and an authorization dependency.
  const authorize = (p: { principalOrg: string; resourceOrg: string; hasDecision: boolean; revoked: boolean; decisionAgeSeconds: number; dependencyUp: boolean }, bypass: SyntheticBypass): 'allowed' | 'denied' => {
    if (!p.dependencyUp) return bypass === 'fail-open' ? 'allowed' : 'denied';
    if (!p.hasDecision) return bypass === 'unauthorized-operation' ? 'allowed' : 'denied';
    if (p.revoked && bypass !== 'ignore-revocation') return 'denied';
    if (p.decisionAgeSeconds > 900 && bypass !== 'reuse-stale-decision') return 'denied';
    if (p.principalOrg !== p.resourceOrg && bypass !== 'ignore-tenant') return 'denied';
    return 'allowed';
  };
  const platform: SyntheticPlatform = {
    bypass: 'none',
    deployedDigest,
    respond(challengeType: ChallengeType) {
      const base = { principalOrg: ORG_A, resourceOrg: ORG_A, hasDecision: true, revoked: false, decisionAgeSeconds: 10, dependencyUp: true };
      const b = platform.bypass;
      switch (challengeType) {
        case 'G01':
          return { observedOutcome: authorize({ ...base, hasDecision: false }, b), observedDeploymentDigest: null };
        case 'G02':
          return { observedOutcome: authorize({ ...base, revoked: true }, b), observedDeploymentDigest: null };
        case 'G05':
          return { observedOutcome: authorize({ ...base, decisionAgeSeconds: 3_600 }, b), observedDeploymentDigest: null };
        case 'G06':
          return { observedOutcome: authorize({ ...base, principalOrg: ORG_B }, b), observedDeploymentDigest: null };
        case 'G07':
          return { observedOutcome: authorize({ ...base, dependencyUp: false }, b), observedDeploymentDigest: null };
        case 'G08':
          return { observedOutcome: 'digest_reported', observedDeploymentDigest: platform.deployedDigest };
        case 'G03':
        case 'G04':
          // This RN-CONFORM-02 fixture has no alternative interface or storage route, and its profile does not cover CR-03/CR-04,
          // so the coordinator never issues these here. Answered inconclusively rather than as a fabricated pass.
          return { observedOutcome: 'unreachable', observedDeploymentDigest: null };
      }
    },
  };
  return platform;
}

// ---------------------------------------------------------------------------
// Synthetic validators and approvers.
// ---------------------------------------------------------------------------

export interface SyntheticValidator {
  readonly validatorId: string;
  readonly operatorId: string;
  readonly key: KeyObject;
  readonly publicKeyPem: string;
}

export function syntheticValidator(validatorId: string, operatorId: string): SyntheticValidator {
  const key = testKey(`validator:${validatorId}`);
  return Object.freeze({ validatorId, operatorId, key, publicKeyPem: publicKeyPemOf(key) });
}

export interface SyntheticHuman {
  readonly principalId: string;
  readonly organizationId: string;
  readonly key: KeyObject;
  readonly publicKeyPem: string;
}

export function syntheticHuman(principalId: string, organizationId: string, keyLabel = principalId): SyntheticHuman {
  const key = testKey(`human:${keyLabel}`);
  return Object.freeze({ principalId, organizationId, key, publicKeyPem: publicKeyPemOf(key) });
}

let decisionCounter = 0;

export function decide(
  human: SyntheticHuman,
  role: 'attest' | 'approve',
  action: HumanAction,
  subjectRef: string,
  actionBindingDigest: string,
  issuedAt: string,
  overrides: Partial<SignedHumanDecision['decision']> = {},
  signingKey: KeyObject = human.key,
): SignedHumanDecision {
  decisionCounter += 1;
  const decision = Object.freeze({
    format: HUMAN_DECISION_FORMAT,
    decisionId: `dec-${human.principalId}-${decisionCounter}`,
    principalId: human.principalId,
    role,
    action,
    organizationId: human.organizationId,
    subjectRef,
    actionBindingDigest,
    issuedAt,
    expiresAt: toTimestamp(toMs(issuedAt) + 5 * 60 * 1000),
    synthetic: true as const,
    ...overrides,
  });
  return Object.freeze({ decision, signature: signConformancePayload('humanDecision', decision, signingKey) });
}

export const ALL_ACTIONS: Record<HumanAction, readonly ('attest' | 'approve')[]> = {
  'credential.issue': ['attest', 'approve'],
  'credential.reinstate': ['attest', 'approve'],
  'credential.revoke': ['attest', 'approve'],
  'validator.enroll': ['attest', 'approve'],
  'validator.reinstate': ['attest', 'approve'],
  'validator.revoke': ['attest', 'approve'],
  'operator.approve': ['attest', 'approve'],
  'operator.reinstate': ['attest', 'approve'],
  'operator.revoke': ['attest', 'approve'],
  'testing.authorize': ['attest', 'approve'],
};

// ---------------------------------------------------------------------------
// The assembled circuit.
// ---------------------------------------------------------------------------

export interface Circuit {
  readonly dir: string;
  readonly path: string;
  store: ConformanceStore;
  readonly clock: ManualClock;
  readonly random: RandomSource;
  readonly profiles: ConformanceProfileRegistry;
  readonly humansDirectory: SyntheticHumanDirectory;
  readonly coordinatorKey: KeyObject;
  readonly registryKey: KeyObject;
  readonly registryPublicKeyPem: string;
  readonly coordinatorPublicKeyPem: string;
  readonly humans: { readonly alice: SyntheticHuman; readonly bob: SyntheticHuman; readonly carol: SyntheticHuman; readonly netAlice: SyntheticHuman; readonly netBob: SyntheticHuman; readonly mallory: SyntheticHuman };
  readonly validators: { readonly A: SyntheticValidator; readonly B: SyntheticValidator; readonly C: SyntheticValidator; readonly A2: SyntheticValidator };
  readonly platform: SyntheticPlatform;
  readonly integration: { readonly integrationId: string; readonly integrationDigest: string; readonly platformId: string };
  services(): {
    registry: ReturnType<typeof createConformanceRegistry>;
    coordinator: ReturnType<typeof createChallengeCoordinator>;
    evidence: ReturnType<typeof createEvidenceService>;
    lifecycle: ReturnType<typeof createCredentialLifecycle>;
  };
  reopen(): void;
  cleanup(): void;
}

const tempDirs: string[] = [];
const openCircuits: Circuit[] = [];
export function cleanupAll(): void {
  for (const circuit of openCircuits.splice(0)) circuit.cleanup();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a temp directory still held by the OS is left to the OS.
    }
  }
}

export function enrollmentDecisions(c: Pick<Circuit, 'humans'>, validatorId: string, bindingDigest: string, at: string): SignedHumanDecision[] {
  return [decide(c.humans.netAlice, 'attest', 'validator.enroll', validatorId, bindingDigest, at), decide(c.humans.netBob, 'approve', 'validator.enroll', validatorId, bindingDigest, at)];
}

/** Opens a fresh store and registers the synthetic profile, platform, integration v1, three synthetic operators and validators A, B, C (+ A2 under operator A). */
export function buildCircuit(options: { readonly enroll?: boolean; readonly seed?: string } = {}): Circuit {
  const dir = mkdtempSync(join(tmpdir(), 'rn-conform-02-'));
  tempDirs.push(dir);
  const path = join(dir, 'conformance.sqlite');
  const clock = manualClock(T0);
  const random = deterministicRandom(options.seed ?? 'rn-conform-02');
  const profiles = createConformanceProfileRegistry();
  const humans = {
    alice: syntheticHuman('human-alice', ORG_A),
    bob: syntheticHuman('human-bob', ORG_A),
    carol: syntheticHuman('human-carol', ORG_A),
    netAlice: syntheticHuman('net-alice', CONFORMANCE_NETWORK_ORGANIZATION),
    netBob: syntheticHuman('net-bob', CONFORMANCE_NETWORK_ORGANIZATION),
    mallory: syntheticHuman('human-mallory', ORG_B),
  };
  const humansDirectory = createSyntheticHumanDirectory(
    Object.values(humans).map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: ALL_ACTIONS })),
  );
  const coordinatorKey = testKey('coordinator');
  const registryKey = testKey('registry');
  const validators = {
    A: syntheticValidator('validator-a', 'op-synthetic-a'),
    B: syntheticValidator('validator-b', 'op-synthetic-b'),
    C: syntheticValidator('validator-c', 'op-synthetic-c'),
    A2: syntheticValidator('validator-a2', 'op-synthetic-a'),
  };
  const platform = syntheticPlatform();
  let store = openConformanceStore(path, { create: true });

  const services = () => ({
    registry: createConformanceRegistry({ store, profiles, clock, humans: humansDirectory }),
    coordinator: createChallengeCoordinator({ store, profiles, clock, random, coordinatorKey }),
    evidence: createEvidenceService({ store, profiles, clock, coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey) }),
    lifecycle: createCredentialLifecycle({ store, profiles, clock, random, registryKey, humans: humansDirectory, coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey) }),
  });

  const { registry } = services();
  registry.registerProfile(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1);
  const profile = profiles.resolve(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileVersion);
  if (!profile.ok) throw new Error('profile');
  registry.registerPlatform({ platformId: 'platform-synthetic-alpha', organizationId: ORG_A, displayName: 'Synthetic Alpha Platform (test fixture)' });
  registry.registerPlatform({ platformId: 'platform-synthetic-beta', organizationId: ORG_B, displayName: 'Synthetic Beta Platform (test fixture)' });
  const integration = registry.registerIntegrationVersion(integrationInput(profile.digest));
  for (const op of ['op-synthetic-a', 'op-synthetic-b', 'op-synthetic-c']) registry.registerSyntheticOperator(op);
  if (options.enroll !== false) {
    for (const v of Object.values(validators)) {
      const prepared = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: v.operatorId, publicKeyPem: v.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-11-02T09:00:00.000Z' });
      registry.enrollValidator(prepared.record, enrollmentDecisions({ humans }, v.validatorId, prepared.bindingDigest, clock.now()));
    }
  }

  const circuit: Circuit = {
    dir,
    path,
    get store() {
      return store;
    },
    set store(value: ConformanceStore) {
      store = value;
    },
    clock,
    random,
    profiles,
    humansDirectory,
    coordinatorKey,
    registryKey,
    registryPublicKeyPem: publicKeyPemOf(registryKey),
    coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey),
    humans,
    validators,
    platform,
    integration: { integrationId: integration.record.integrationId, integrationDigest: integration.integrationDigest, platformId: integration.record.platformId },
    services,
    reopen() {
      store.close();
      store = openConformanceStore(path);
    },
    cleanup() {
      try {
        store.close();
      } catch {
        // already closed
      }
    },
  };
  openCircuits.push(circuit);
  return circuit;
}

export function integrationInput(profileDigest: string, overrides: Record<string, unknown> = {}) {
  return {
    integrationId: 'integration-synthetic-alpha',
    integrationVersion: 1,
    platformId: 'platform-synthetic-alpha',
    organizationId: ORG_A,
    sdk: { ...SDK },
    adapter: { ...ADAPTER },
    deploymentDigest: DEPLOYMENT_V1,
    profile: { id: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, version: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileVersion, digest: profileDigest },
    coveredOperations: [...OPERATIONS],
    declaredExclusions: [{ operation: 'document.share', reason: 'No share operation exists in the synthetic fixture.' }],
    testEndpoints: [{ endpointId: 'endpoint-synthetic-alpha', environment: 'synthetic' as const, fixtureRef: 'fixture-synthetic-pep-v1' }],
    ...overrides,
  };
}

let idempotencyCounter = 0;

/** Issues one challenge of `type` to `validators`. */
export function issue(
  c: Circuit,
  type: ChallengeType,
  validators: readonly SyntheticValidator[],
  options: { idempotencyKey?: string; deadlineSeconds?: number; integrationDigest?: string; organizationId?: string; operation?: string } = {},
): SignedChallenge {
  idempotencyCounter += 1;
  return c.services().coordinator.issue({
    idempotencyKey: options.idempotencyKey ?? `idem-${type}-${idempotencyCounter}`,
    organizationId: options.organizationId ?? ORG_A,
    integrationDigest: options.integrationDigest ?? c.integration.integrationDigest,
    challengeType: type,
    operation: type === 'G08' ? DEPLOYMENT_ATTESTATION_OPERATION : (options.operation ?? 'document.open'),
    fixtureRef: 'fixture-synthetic-pep-v1',
    assignedValidatorIds: validators.map((v) => v.validatorId),
    deadlineSeconds: options.deadlineSeconds ?? 600,
  });
}

let eventCounter = 0;

/** What validator `v` honestly observes for `signed` on the synthetic platform, as a signed observation and its evidence package. */
export function observe(
  c: Circuit,
  v: SyntheticValidator,
  signed: SignedChallenge,
  options: { mutate?: (o: Record<string, unknown>) => void; signWith?: KeyObject; mutateAfterSigning?: (o: Record<string, unknown>) => void; outcome?: ObservedOutcome; eventId?: string; deposit?: boolean } = {},
): string {
  const ch = signed.challenge;
  const response = c.platform.respond(ch.challengeType);
  const observedOutcome = options.outcome ?? response.observedOutcome;
  const now = c.clock.now();
  eventCounter += 1;
  const pkg = {
    schema: 'rn.conformance.evidence-package/1' as const,
    challengeId: ch.challengeId,
    validatorId: v.validatorId,
    requestDigest: conformanceDigest({ challengeId: ch.challengeId, validatorId: v.validatorId, kind: 'request' }),
    responseDigest: conformanceDigest({ challengeId: ch.challengeId, outcome: observedOutcome, n: eventCounter }),
    statusCode: observedOutcome === 'allowed' ? 200 : 403,
    latencyMs: 12,
    synthetic: true as const,
  };
  const evidenceDigest = options.deposit === false ? conformanceDigest({ missing: eventCounter }) : c.services().evidence.depositEvidencePackage(ch.organizationId, pkg);
  const observation: Record<string, unknown> = {
    schema: 'rn.conformance.observation/1',
    eventId: options.eventId ?? `evt-${v.validatorId}-${eventCounter}`,
    challengeId: ch.challengeId,
    challengeNonce: ch.nonce,
    validatorId: v.validatorId,
    validatorKeyId: signConformancePayload('observation', {}, v.key).keyId,
    organizationId: ch.organizationId,
    platformId: ch.platformId,
    integrationId: ch.integrationId,
    integrationVersion: ch.integrationVersion,
    integrationDigest: ch.integrationDigest,
    observedDeploymentDigest: ch.challengeType === 'G08' ? response.observedDeploymentDigest : null,
    profileId: ch.profileId,
    profileVersion: ch.profileVersion,
    controlId: ch.controlId,
    operation: ch.operation,
    expectedOutcome: ch.expectedOutcome,
    observedOutcome,
    outcomeClass: classifyOutcome(ch.expectedOutcome, observedOutcome, ch.challengeType === 'G08' ? response.observedDeploymentDigest : null, DEPLOYMENT_V1),
    evidenceDigest,
    observedAt: now,
    submittedAt: now,
  };
  options.mutate?.(observation);
  const validatorSignature = signConformancePayload('observation', observation as unknown as ObservationPayload, options.signWith ?? v.key);
  options.mutateAfterSigning?.(observation);
  return JSON.stringify({ observation, validatorSignature });
}

export function submit(c: Circuit, raw: string): SubmissionResult {
  return c.services().evidence.submitObservation(raw);
}

export const BASELINE: readonly ChallengeType[] = Object.freeze(['G01', 'G02', 'G05', 'G06', 'G07', 'G08']);

/** The operations one baseline challenge type is run for: each covered operation for enforcement challenges, the attestation operation for G08 (finding 4). */
export function baselineOperations(type: ChallengeType, operations: readonly string[] = OPERATIONS): readonly string[] {
  return type === 'G08' ? [DEPLOYMENT_ATTESTATION_OPERATION] : operations;
}

/** Challenges in one full baseline over `operations`. */
export function baselineChallengeCount(operations: readonly string[] = OPERATIONS): number {
  return BASELINE.reduce((n, type) => n + baselineOperations(type, operations).length, 0);
}

/**
 * Runs every baseline challenge, for every covered operation (`operations`, default all of the fixture's), against `validators`
 * and submits their honest observations. Returns submission results.
 */
export function runBaseline(c: Circuit, validators: readonly SyntheticValidator[], operations: readonly string[] = OPERATIONS): SubmissionResult[] {
  const results: SubmissionResult[] = [];
  for (const type of BASELINE) {
    for (const operation of baselineOperations(type, operations)) {
      const challenge = issue(c, type, validators, { operation });
      for (const v of validators) results.push(submit(c, observe(c, v, challenge)));
    }
  }
  return results;
}

export function approvals(c: Circuit, prepared: PreparedAction, requester: SyntheticHuman = c.humans.alice, approver: SyntheticHuman = c.humans.bob): SignedHumanDecision[] {
  const at = c.clock.now();
  return [decide(requester, 'attest', prepared.action, prepared.credentialId, prepared.actionBindingDigest, at), decide(approver, 'approve', prepared.action, prepared.credentialId, prepared.actionBindingDigest, at)];
}

/** Registers a candidate, runs the baseline with A and B, and issues it with two humans. */
export function activeCredential(c: Circuit): string {
  const { lifecycle } = c.services();
  const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
  runBaseline(c, [c.validators.A, c.validators.B]);
  c.clock.advance(1);
  const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
  lifecycle.commit(prepared, approvals(c, prepared));
  return credential.credentialId;
}

export function expectation(c: Circuit, credentialId: string, operation = 'document.open'): ConformanceExpectation {
  const profile = c.profiles.resolve(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileVersion);
  if (!profile.ok) throw new Error('profile');
  return {
    organizationId: ORG_A,
    credentialId,
    platformId: c.integration.platformId,
    integrationId: c.integration.integrationId,
    integrationVersion: 1,
    integrationDigest: c.integration.integrationDigest,
    profileId: profile.definition.profileId,
    profileVersion: profile.definition.profileVersion,
    profileDigest: profile.digest,
    operation,
  };
}

export function verdict(c: Circuit, credentialId: string, operation?: string) {
  return verifyCurrentConformance({ store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, humans: c.humansDirectory }, expectation(c, credentialId, operation), c.clock.now());
}

export { newIdentifier };
