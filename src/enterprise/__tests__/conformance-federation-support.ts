import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';

import type { ChallengeType, ObservedOutcome, SignedHumanDecision } from '../conformance/contracts.js';
import { createChallengeCoordinator } from '../conformance/coordinator.js';
import { generationIdentity, type EnrollmentRequestKind, type JobAssignment, type ValidatorCapabilities } from '../conformance/federation-contracts.js';
import { createFederationHealth, type FederationHealth } from '../conformance/federation-health.js';
import { createFederationRegistry, type FederationRegistry, type PreparedFederationAction } from '../conformance/federation-registry.js';
import { createDispatchWorker, createFederationScheduler, type ChallengeTransport, type DispatchOutcome, type DispatchWorker, type FederationScheduler } from '../conformance/federation-scheduler.js';
import { openFederationStore, type FederationStore, type GenerationRow } from '../conformance/federation-store.js';
import {
  createValidatorRuntime,
  openValidatorOutbox,
  requestDigestOf,
  type ChallengeExecutor,
  type EvidenceSubmissionPort,
  type ObservationSigner,
  type RuntimeResult,
  type ValidatorOutbox,
  type ValidatorRuntime,
} from '../conformance/federation-validator-runtime.js';
import { RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1 } from '../conformance/profile.js';
import { deriveConformanceKeyId, publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import { ORG_A, decide, deterministicRandom, enrollmentDecisions, testKey } from './conformance-support.js';
import { REFERENCE_DEPLOYMENT_DIGEST, REFERENCE_FIXTURE_REF, runReferenceProbe, type ReferenceChallengeType } from './conformance-reference-pep.js';
import { REFERENCE_CHALLENGES, buildReferenceCircuit, referenceApprovals, type ReferenceCircuit } from './conformance-reference-support.js';

/**
 * RN-CONFORM-05 — the synthetic federation around the RN-CONFORM-04 reference circuit. TEST CODE ONLY.
 *
 * Operators, validators, keys and humans are synthetic. Validator keys are EPHEMERAL (generated per run, held only in
 * this process's memory behind the `ObservationSigner` port, never written anywhere); the coordinator never sees them.
 * Every challenge still goes through the RN-CONFORM-02 coordinator, evidence acceptance, engine and lifecycle, and
 * RN-CONFORM-03 status — unchanged. Nothing here contacts a network: the transport is an in-process port.
 */

export const FED_OPERATORS = Object.freeze({ A: 'op-fed-a', B: 'op-fed-b', C: 'op-fed-c', D: 'op-fed-d' });
export const FED_AUTHORIZATION = 'auth-reference-pep-synthetic-1';

export const fullCapabilities = (): ValidatorCapabilities => ({
  challengeTypes: [...REFERENCE_CHALLENGES].sort(),
  profiles: [{ profileId: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileId, profileVersion: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileVersion }],
});

/** An ephemeral Ed25519 key: generated in memory for this run only (never a committed or derived fixture key). */
export const ephemeralKey = (): KeyObject => generateKeyPairSync('ed25519').privateKey;

export function ephemeralSigner(key: KeyObject): ObservationSigner {
  return Object.freeze({ keyId: deriveConformanceKeyId(key), sign: (kind: 'observation' | 'validatorHeartbeat' | 'keyPossession', payload: unknown) => signConformancePayload(kind, payload, key) });
}

export interface FederatedValidator {
  readonly validatorId: string;
  readonly operatorId: string;
  generation: GenerationRow;
  key: KeyObject;
  runtime: ValidatorRuntime;
  outbox: ValidatorOutbox;
  sessionId: string | null;
}

export interface Federation {
  readonly c: ReferenceCircuit;
  fed: FederationStore;
  readonly fedPath: string;
  registry: FederationRegistry;
  health: FederationHealth;
  scheduler: FederationScheduler;
  readonly validators: Map<string, FederatedValidator>;
  /** Validators whose transport is "down" (synthetic partition). */
  readonly down: Set<string>;
  /** Every delivery the in-process transport made, with the runtime's answer. */
  readonly deliveries: { readonly validatorId: string; readonly challengeId: string; readonly result: RuntimeResult | 'UNREACHABLE' }[];
  readonly transport: ChallengeTransport;
  worker(id: string): DispatchWorker;
  /** Reopens the federation store (coordinator restart) and rebuilds every federation service over it. */
  restart(options?: { readonly expectedMinimumStateSeq?: number }): void;
}

/** The validator's executor over the reference PEP fixture. `forceOutcome` makes a MALICIOUS validator (it lies about what it saw). */
const executorFor = (f: { c: ReferenceCircuit }, cvid: () => string, forceOutcome?: ObservedOutcome): ChallengeExecutor => ({
  async execute(challenge) {
    const probe = await runReferenceProbe(f.c.deployment, challenge.challengeType as ReferenceChallengeType, challenge.operation);
    return {
      observedOutcome: forceOutcome ?? probe.observedOutcome,
      observedDeploymentDigest: probe.observedDeploymentDigest,
      requestDigest: requestDigestOf(challenge, cvid()),
      responseDigest: `sha256:${probe.responseDigest.slice(7)}`,
      statusCode: probe.statusCode,
      latencyMs: 7,
    };
  },
});

export function evidencePort(c: ReferenceCircuit, overrides: Partial<EvidenceSubmissionPort> = {}): EvidenceSubmissionPort {
  const { evidence } = c.services();
  return {
    depositEvidencePackage: (org, pkg) => evidence.depositEvidencePackage(org, pkg),
    submitObservation: (raw) => evidence.submitObservation(raw),
    isCommitted: (eventId, challengeId, validatorId) => {
      const o = c.store.getObservation(eventId);
      return o !== undefined && o.challengeId === challengeId && o.validatorId === validatorId;
    },
    ...overrides,
  };
}

/** Builds (or rebuilds) the runtime of one validator generation over its own outbox file. */
export function runtimeFor(f: Federation, v: { validatorId: string; operatorId: string; generation: GenerationRow; key: KeyObject }, options: { readonly create?: boolean; readonly evidence?: EvidenceSubmissionPort; readonly environment?: 'synthetic' | 'staging' | 'production'; readonly fixtureRefs?: readonly string[]; readonly forceOutcome?: ObservedOutcome } = {}): { runtime: ValidatorRuntime; outbox: ValidatorOutbox } {
  const cvid = v.generation.conformanceValidatorId;
  const outbox = openValidatorOutbox(join(f.c.dir, `outbox-${cvid}.sqlite`), cvid, { create: options.create ?? true });
  const runtime = createValidatorRuntime({
    identity: { validatorId: v.validatorId, operatorId: v.operatorId, generation: v.generation.generation, conformanceValidatorId: cvid, keyId: v.generation.keyId },
    signer: ephemeralSigner(v.key),
    executor: executorFor(f, () => cvid, options.forceOutcome),
    evidence: options.evidence ?? evidencePort(f.c),
    outbox,
    policy: {
      trustedCoordinatorPublicKeyPems: [f.c.coordinatorPublicKeyPem],
      authorizedTargets: [{ organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest, deploymentDigest: REFERENCE_DEPLOYMENT_DIGEST, fixtureRefs: options.fixtureRefs ?? [REFERENCE_FIXTURE_REF] }],
      capabilities: fullCapabilities(),
      environment: options.environment ?? 'synthetic',
      clockSkewMs: 5_000,
    },
    clock: f.c.clock,
    random: deterministicRandom(`runtime:${cvid}`),
  });
  return { runtime, outbox };
}

export function fedDecisions(f: Federation, prepared: PreparedFederationAction, attester = f.c.humans.netAlice, approver = f.c.humans.netBob): SignedHumanDecision[] {
  const at = f.c.clock.now();
  return [decide(attester, 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at), decide(approver, 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at)];
}

export function buildFederation(options: { readonly seed?: string; readonly operators?: readonly string[]; readonly faults?: { afterConformanceEnrollment?: () => void } } = {}): Federation {
  const c = buildReferenceCircuit({ seed: options.seed ?? 'rn-conform-05' });
  const fedPath = join(c.dir, 'federation.sqlite');
  const random = deterministicRandom(`${options.seed ?? 'rn-conform-05'}:federation`);
  const coordinator = createChallengeCoordinator({ store: c.store, profiles: c.profiles, clock: c.clock, random: c.random, coordinatorKey: testKey('coordinator') });
  const validators = new Map<string, FederatedValidator>();
  const down = new Set<string>();
  const deliveries: Federation['deliveries'] = [];
  const transport: ChallengeTransport = {
    async deliver(a: JobAssignment, signed) {
      const v = validators.get(a.validatorId);
      if (v === undefined || down.has(a.validatorId) || v.generation.conformanceValidatorId !== a.conformanceValidatorId) {
        deliveries.push({ validatorId: a.validatorId, challengeId: signed.challenge.challengeId, result: 'UNREACHABLE' });
        return 'UNREACHABLE';
      }
      const result = await v.runtime.receive(signed);
      deliveries.push({ validatorId: a.validatorId, challengeId: signed.challenge.challengeId, result });
      return 'DELIVERED';
    },
  };
  const f = { c, fedPath, validators, down, deliveries, transport } as unknown as Federation;
  const wire = (fed: FederationStore) => {
    const registry = createFederationRegistry({ fed, store: c.store, conformance: c.services().registry, profiles: c.profiles, humans: c.humansDirectory, clock: c.clock, random, ...(options.faults === undefined ? {} : { faults: options.faults }) });
    const health = createFederationHealth({ fed, store: c.store, registry, clock: c.clock, random });
    const scheduler = createFederationScheduler({ fed, store: c.store, registry, health, profiles: c.profiles, clock: c.clock, random });
    Object.assign(f, { fed, registry, health, scheduler });
  };
  wire(openFederationStore(fedPath, { create: true }));
  Object.assign(f, {
    worker: (id: string) => createDispatchWorker({ workerId: id, fed: f.fed, store: c.store, registry: f.registry, coordinator, transport, clock: c.clock, random }),
    restart(o: { expectedMinimumStateSeq?: number } = {}) {
      try {
        f.fed.close();
      } catch {
        // already closed
      }
      wire(openFederationStore(fedPath, o.expectedMinimumStateSeq === undefined ? {} : { expectedMinimumStateSeq: o.expectedMinimumStateSeq }));
    },
  });
  const prior = c.cleanup;
  (c as { cleanup: () => void }).cleanup = () => {
    for (const v of validators.values()) {
      try {
        v.outbox.close();
      } catch {
        // already closed
      }
    }
    try {
      f.fed.close();
    } catch {
      // already closed
    }
    prior();
  };
  for (const operatorId of options.operators ?? [FED_OPERATORS.A, FED_OPERATORS.B, FED_OPERATORS.C]) onboardOperator(f, operatorId);
  authorizeReferenceTesting(f);
  return f;
}

/** REGISTERED → APPROVED (two network humans) → ACTIVE. */
export function onboardOperator(f: Federation, operatorId: string): void {
  f.registry.registerOperator({ operatorId, operatorClass: operatorId === FED_OPERATORS.A ? 'REPUBLIKA' : 'CANDIDATE_EXTERNAL', administrativeOwnerRef: `owner-ref-${operatorId}` });
  f.registry.approveOperator(operatorId, fedDecisions(f, f.registry.prepareOperatorAction(operatorId, 'approve')));
  f.registry.activateOperator(operatorId);
}

/** Two humans of the platform's own organization authorize synthetic testing of the reference integration for 30 days. */
export function authorizeReferenceTesting(f: Federation, authorizationId = FED_AUTHORIZATION, days = 30): void {
  const now = f.c.clock.ms();
  const { record, prepared } = f.registry.prepareTestingAuthorization({
    authorizationId,
    organizationId: ORG_A,
    integrationDigest: f.c.integration.integrationDigest,
    fixtureRefs: [REFERENCE_FIXTURE_REF],
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + days * 86_400_000).toISOString(),
  });
  f.registry.authorizeTesting(record, fedDecisions(f, prepared, f.c.humans.alice, f.c.humans.bob));
}

const keyWindow = (f: Federation, days = 365) => ({ keyValidFrom: f.c.clock.now(), keyValidUntil: new Date(f.c.clock.ms() + days * 86_400_000).toISOString() });

/** Proof of possession + two-person `validator.enroll` (+ two-person `validator.reinstate` for REINSTATE). Returns the new generation. */
export function enrollGeneration(f: Federation, validatorId: string, kind: EnrollmentRequestKind, key: KeyObject = ephemeralKey(), window = keyWindow(f)): { generation: GenerationRow; key: KeyObject } {
  const pop = f.registry.requestKeyPossession({ validatorId, kind, publicKeyPem: publicKeyPemOf(key), ...window });
  const prepared = f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key));
  const reinstate = kind === 'REINSTATE' ? fedDecisions(f, f.registry.prepareValidatorAction(validatorId, 'reinstate')) : undefined;
  const generation = f.registry.completeEnrollment(pop.requestId, prepared.record, enrollmentDecisions(f.c, prepared.record.validatorId, prepared.bindingDigest, f.c.clock.now()), reinstate);
  return { generation, key };
}

/** Registers, enrolls and activates one validator under `operatorId`, with its runtime, and opens a heartbeat session. */
export function addValidator(f: Federation, validatorId: string, operatorId: string): FederatedValidator {
  f.registry.registerValidator({ validatorId, operatorId, capabilities: fullCapabilities() });
  const { generation, key } = enrollGeneration(f, validatorId, 'ENROLL');
  f.registry.activateValidator(validatorId);
  const { runtime, outbox } = runtimeFor(f, { validatorId, operatorId, generation, key });
  const v: FederatedValidator = { validatorId, operatorId, generation, key, runtime, outbox, sessionId: null };
  f.validators.set(validatorId, v);
  return v;
}

/** Turns validator `id` malicious: from now on it reports `outcome` whatever it observes (same identity, same outbox). */
export function makeMalicious(f: Federation, id: string, outcome: ObservedOutcome): void {
  const v = f.validators.get(id) as FederatedValidator;
  v.outbox.close();
  Object.assign(v, runtimeFor(f, v, { create: false, forceOutcome: outcome }));
}

/** Swaps a validator onto a newer generation (after rotation or reinstatement): new key, new runtime, new outbox. */
export function adoptGeneration(f: Federation, validatorId: string, generation: GenerationRow, key: KeyObject): FederatedValidator {
  const v = f.validators.get(validatorId) as FederatedValidator;
  v.outbox.close();
  const { runtime, outbox } = runtimeFor(f, { validatorId, operatorId: v.operatorId, generation, key });
  Object.assign(v, { generation, key, runtime, outbox, sessionId: null });
  return v;
}

/** Every listed validator (default: all, minus the down ones) delivers one signed heartbeat. */
export function beat(f: Federation, ids: readonly string[] = [...f.validators.keys()].filter((id) => !f.down.has(id))) {
  return ids.map((id) => {
    const v = f.validators.get(id) as FederatedValidator;
    if (v.sessionId === null) v.sessionId = f.health.openSession(id).sessionId;
    return f.health.acceptHeartbeat(v.runtime.heartbeat(v.sessionId));
  });
}

/** The standard federation: A1, A2, A3 under operator A; B1 under B; C1 under C. All healthy. */
export function standardFederation(seed = 'rn-conform-05'): Federation {
  const f = buildFederation({ seed });
  addValidator(f, 'va1', FED_OPERATORS.A);
  addValidator(f, 'va2', FED_OPERATORS.A);
  addValidator(f, 'va3', FED_OPERATORS.A);
  addValidator(f, 'vb1', FED_OPERATORS.B);
  addValidator(f, 'vc1', FED_OPERATORS.C);
  beat(f);
  return f;
}

/** Runs the dispatch worker until no job is due (bounded). */
export async function drain(f: Federation, workerId = 'worker-1', rounds = 8) {
  const all: DispatchOutcome[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const out = await f.worker(workerId).runOnce();
    all.push(...out);
    if (out.length === 0) break;
  }
  return all;
}

/** Schedules one job directly (fixed key) for `type`/`operation` needing `operators` distinct operators. */
export function scheduleOne(f: Federation, type: ChallengeType, operation: string, operators = 2, extra: { readonly purpose?: 'ROUTINE' | 'INVESTIGATION' | 'DISPUTE'; readonly exclude?: readonly string[]; readonly key?: string } = {}) {
  return f.scheduler.schedule({
    purpose: extra.purpose ?? 'ROUTINE',
    authorizationId: FED_AUTHORIZATION,
    challengeType: type,
    operation,
    fixtureRef: REFERENCE_FIXTURE_REF,
    requiredOperators: operators,
    ...(extra.exclude === undefined ? {} : { excludeOperators: extra.exclude }),
    jobKey: extra.key ?? `test|${type}|${operation}|${operators}|${f.c.clock.ms()}`,
  });
}

/** Scenario baseline: every routine job of the reference matrix with two operators, then two-person issuance. */
export async function activeFederatedCredential(f: Federation): Promise<string> {
  const { lifecycle } = f.c.services();
  const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: f.c.integration.integrationDigest });
  const planned = f.scheduler.planRoutine(FED_AUTHORIZATION, REFERENCE_FIXTURE_REF);
  if (!planned.every((p) => p.scheduled)) throw new Error(`routine planning failed: ${JSON.stringify(planned.filter((p) => !p.scheduled))}`);
  await drain(f);
  f.c.clock.advance(1);
  const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
  lifecycle.commit(prepared, referenceApprovals(f.c, prepared));
  return credential.credentialId;
}

export { generationIdentity };
