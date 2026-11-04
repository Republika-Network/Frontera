import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conformanceDigest } from '../conformance/canonical.js';
import { CHALLENGE_CATALOGUE, DEPLOYMENT_ATTESTATION_OPERATION, requiredOperations, type ChallengeType, type ObservationPayload, type ObservedOutcome, type ResultCategory, type SignedChallenge, type SignedHumanDecision } from '../conformance/contracts.js';
import { createChallengeCoordinator, type RandomSource } from '../conformance/coordinator.js';
import { classifyOutcome, evaluateConformance } from '../conformance/engine.js';
import { createEvidenceService, type SubmissionResult } from '../conformance/evidence.js';
import { createSyntheticHumanDirectory, type SyntheticHumanDirectory } from '../conformance/human-authority.js';
import { createCredentialLifecycle, loadEngineInput, type PreparedAction } from '../conformance/lifecycle.js';
import { RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1, createConformanceProfileRegistry, type ConformanceProfileRegistry } from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, createConformanceRegistry } from '../conformance/registry.js';
import { publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import { openConformanceStore, type ConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { projectCredentialStatus, type StatusProjectionDeps } from '../conformance/status-projection.js';
import { createStatusRegistry, type OnlineStatusRequest, type StatusRegistry } from '../conformance/status-registry.js';
import { createStatusIssuerKeyRegistry, createSyntheticStatusSigner, statusIssuerKeyRecord, type StatusIssuerKeyRegistry, type SyntheticStatusSigner } from '../conformance/status-signer.js';
import { openStatusVerifierStore, verifyConformanceStatus, type StatusExpectation, type StatusVerdict, type StatusVerifierStore } from '../conformance/status-verifier.js';
import { ALL_ACTIONS, ORG_A, ORG_B, T0, decide, deterministicRandom, enrollmentDecisions, manualClock, syntheticHuman, syntheticValidator, testKey, type ManualClock, type SyntheticHuman, type SyntheticValidator } from './conformance-support.js';
import {
  REFERENCE_ADAPTER,
  REFERENCE_ADAPTER_DIGEST,
  REFERENCE_DEPLOYMENT_DIGEST,
  REFERENCE_FIXTURE_REF,
  REFERENCE_OPERATIONS,
  REFERENCE_SDK,
  conformantDeployment,
  runReferenceProbe,
  type ProbeResult,
  type ReferenceChallengeType,
  type ReferenceDeployment,
} from './conformance-reference-pep.js';

/**
 * RN-CONFORM-04 — the conformance circuit around the synthetic reference PEP. TEST CODE ONLY.
 *
 * It reuses RN-CONFORM-02's engine, coordinator, evidence acceptance, corroboration and lifecycle and RN-CONFORM-03's
 * signed status unchanged; nothing here decides a classification. Validators run the challenge procedures of
 * `conformance-reference-pep.ts` against the deployment and submit signed observations through the real evidence path.
 * The validators and operators are synthetic labels under Republika's own control: corroboration here demonstrates the
 * mechanism, not organizational independence.
 */

export const REFERENCE_INTEGRATION_ID = 'integration-reference-document-pep';
export const REFERENCE_PLATFORM_ID = 'platform-synthetic-alpha';
export const REFERENCE_DECLARED_EXCLUSIONS = Object.freeze([
  Object.freeze({ operation: 'document.share', reason: 'No share concept exists in the document-use pipeline (FILEVERSE_COVERAGE §2).' }),
  Object.freeze({ operation: 'document.delete', reason: 'Not mediated by the document-use pipeline; declared exclusion.' }),
  Object.freeze({ operation: 'document.edit-content', reason: 'Not mediated by the document-use pipeline; declared exclusion.' }),
]);
/** Every challenge type the reference profile backs, in execution order. */
export const REFERENCE_CHALLENGES: readonly ChallengeType[] = Object.freeze(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08']);

export interface ExecutedChallenge {
  readonly challengeId: string;
  readonly challengeType: ChallengeType;
  readonly controlId: string;
  readonly operation: string;
  readonly expectedOutcome: string;
  readonly fixtureVariant: string;
  readonly observations: { readonly validatorId: string; readonly eventId: string; readonly observedOutcome: string; readonly accepted: boolean; readonly rejection: string | null; readonly leakedProtectedContent: boolean }[];
}

export interface ReferenceCircuit {
  readonly dir: string;
  readonly store: ConformanceStore;
  readonly clock: ManualClock;
  readonly random: RandomSource;
  readonly profiles: ConformanceProfileRegistry;
  readonly profileDigest: string;
  readonly humansDirectory: SyntheticHumanDirectory;
  readonly registryPublicKeyPem: string;
  readonly coordinatorPublicKeyPem: string;
  readonly humans: { readonly alice: SyntheticHuman; readonly bob: SyntheticHuman; readonly carol: SyntheticHuman; readonly netAlice: SyntheticHuman; readonly netBob: SyntheticHuman; readonly mallory: SyntheticHuman };
  readonly validators: { readonly A: SyntheticValidator; readonly B: SyntheticValidator; readonly C: SyntheticValidator; readonly A2: SyntheticValidator };
  /** TEST-ONLY fixture switches of the deployed reference integration. */
  readonly deployment: ReferenceDeployment;
  readonly integration: { readonly integrationId: string; readonly integrationDigest: string; readonly platformId: string; readonly integrationVersion: number };
  /** Every challenge the harness issued, with what each validator observed and whether evidence acceptance took it. */
  readonly executed: ExecutedChallenge[];
  services(): {
    registry: ReturnType<typeof createConformanceRegistry>;
    coordinator: ReturnType<typeof createChallengeCoordinator>;
    evidence: ReturnType<typeof createEvidenceService>;
    lifecycle: ReturnType<typeof createCredentialLifecycle>;
  };
  cleanup(): void;
}

const dirs: string[] = [];
const circuits: ReferenceCircuit[] = [];
export function cleanupReferenceCircuits(): void {
  for (const c of circuits.splice(0)) c.cleanup();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // left to the OS
    }
  }
}

export const referenceIntegrationInput = (profileDigest: string, overrides: Record<string, unknown> = {}) => ({
  integrationId: REFERENCE_INTEGRATION_ID,
  integrationVersion: 1,
  platformId: REFERENCE_PLATFORM_ID,
  organizationId: ORG_A,
  sdk: { ...REFERENCE_SDK },
  adapter: { name: REFERENCE_ADAPTER.name, version: REFERENCE_ADAPTER.version, digest: REFERENCE_ADAPTER_DIGEST },
  deploymentDigest: REFERENCE_DEPLOYMENT_DIGEST,
  profile: { id: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileId, version: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileVersion, digest: profileDigest },
  coveredOperations: [...REFERENCE_OPERATIONS],
  declaredExclusions: REFERENCE_DECLARED_EXCLUSIONS.map((e) => ({ ...e })),
  testEndpoints: [{ endpointId: 'endpoint-reference-pep', environment: 'synthetic' as const, fixtureRef: REFERENCE_FIXTURE_REF }],
  ...overrides,
});

/** A fresh store with the reference profile, two platforms, the reference integration (3 operations) and validators A, B, C, A2. */
export function buildReferenceCircuit(options: { readonly seed?: string } = {}): ReferenceCircuit {
  const dir = mkdtempSync(join(tmpdir(), 'rn-conform-04-'));
  dirs.push(dir);
  const clock = manualClock(T0);
  const random = deterministicRandom(options.seed ?? 'rn-conform-04');
  const profiles = createConformanceProfileRegistry();
  const humans = {
    alice: syntheticHuman('human-alice', ORG_A),
    bob: syntheticHuman('human-bob', ORG_A),
    carol: syntheticHuman('human-carol', ORG_A),
    netAlice: syntheticHuman('net-alice', CONFORMANCE_NETWORK_ORGANIZATION),
    netBob: syntheticHuman('net-bob', CONFORMANCE_NETWORK_ORGANIZATION),
    mallory: syntheticHuman('human-mallory', ORG_B),
  };
  const humansDirectory = createSyntheticHumanDirectory(Object.values(humans).map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: ALL_ACTIONS })));
  const coordinatorKey = testKey('coordinator');
  const registryKey = testKey('registry');
  const validators = {
    A: syntheticValidator('validator-a', 'op-synthetic-a'),
    B: syntheticValidator('validator-b', 'op-synthetic-b'),
    C: syntheticValidator('validator-c', 'op-synthetic-c'),
    A2: syntheticValidator('validator-a2', 'op-synthetic-a'),
  };
  const store = openConformanceStore(join(dir, 'conformance.sqlite'), { create: true });
  const services = () => ({
    registry: createConformanceRegistry({ store, profiles, clock, humans: humansDirectory }),
    coordinator: createChallengeCoordinator({ store, profiles, clock, random, coordinatorKey }),
    evidence: createEvidenceService({ store, profiles, clock, coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey) }),
    lifecycle: createCredentialLifecycle({ store, profiles, clock, random, registryKey, humans: humansDirectory, coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey) }),
  });
  const { registry } = services();
  const profileDigest = registry.registerProfile(RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1);
  registry.registerPlatform({ platformId: REFERENCE_PLATFORM_ID, organizationId: ORG_A, displayName: 'Synthetic Alpha Platform (reference PEP fixture)' });
  registry.registerPlatform({ platformId: 'platform-synthetic-beta', organizationId: ORG_B, displayName: 'Synthetic Beta Platform (test fixture)' });
  const integration = registry.registerIntegrationVersion(referenceIntegrationInput(profileDigest));
  for (const op of ['op-synthetic-a', 'op-synthetic-b', 'op-synthetic-c']) registry.registerSyntheticOperator(op);
  for (const v of Object.values(validators)) {
    const prepared = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: v.operatorId, publicKeyPem: v.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-11-02T09:00:00.000Z' });
    registry.enrollValidator(prepared.record, enrollmentDecisions({ humans }, v.validatorId, prepared.bindingDigest, clock.now()));
  }
  const circuit: ReferenceCircuit = {
    dir,
    store,
    clock,
    random,
    profiles,
    profileDigest,
    humansDirectory,
    registryPublicKeyPem: publicKeyPemOf(registryKey),
    coordinatorPublicKeyPem: publicKeyPemOf(coordinatorKey),
    humans,
    validators,
    deployment: conformantDeployment(),
    integration: { integrationId: integration.record.integrationId, integrationDigest: integration.integrationDigest, platformId: integration.record.platformId, integrationVersion: 1 },
    executed: [],
    services,
    cleanup() {
      try {
        store.close();
      } catch {
        // already closed
      }
    },
  };
  circuits.push(circuit);
  return circuit;
}

let idem = 0;

/** Issues one signed challenge through the real coordinator. */
export function issueReference(c: ReferenceCircuit, type: ChallengeType, validators: readonly SyntheticValidator[], operation: string = 'document.open', deadlineSeconds = 600): SignedChallenge {
  idem += 1;
  const signed = c.services().coordinator.issue({
    idempotencyKey: `rn04-${type}-${idem}`,
    organizationId: ORG_A,
    integrationDigest: c.integration.integrationDigest,
    challengeType: type,
    operation: type === 'G08' ? DEPLOYMENT_ATTESTATION_OPERATION : operation,
    fixtureRef: REFERENCE_FIXTURE_REF,
    assignedValidatorIds: validators.map((v) => v.validatorId),
    deadlineSeconds,
  });
  c.executed.push({
    challengeId: signed.challenge.challengeId,
    challengeType: type,
    controlId: signed.challenge.controlId,
    operation: signed.challenge.operation,
    expectedOutcome: signed.challenge.expectedOutcome,
    fixtureVariant: describeVariant(c.deployment),
    observations: [],
  });
  return signed;
}

export const describeVariant = (d: ReferenceDeployment): string =>
  d.defects.size === 0 ? 'CONFORMANT' : `${[...d.defects].sort().join('+')}${d.defectOperations.size === 0 ? '' : `@${[...d.defectOperations].sort().join(',')}`}`;

let events = 0;

/**
 * Validator `v` runs the challenge procedure against the deployment, deposits a redacted evidence package (digests and a
 * status code — never content), signs the observation with its enrolled key and submits it through evidence acceptance.
 */
export async function observeReference(
  c: ReferenceCircuit,
  v: SyntheticValidator,
  signed: SignedChallenge,
  options: { readonly outcome?: ObservedOutcome; readonly mutate?: (o: Record<string, unknown>) => void; readonly signWith?: ReturnType<typeof testKey> } = {},
): Promise<{ readonly raw: string; readonly result: SubmissionResult; readonly probe: ProbeResult }> {
  const ch = signed.challenge;
  const probe = await runReferenceProbe(c.deployment, ch.challengeType as ReferenceChallengeType, ch.operation);
  const observedOutcome: ObservedOutcome = options.outcome ?? probe.observedOutcome;
  const now = c.clock.now();
  events += 1;
  const evidenceDigest = c.services().evidence.depositEvidencePackage(ch.organizationId, {
    schema: 'rn.conformance.evidence-package/1',
    challengeId: ch.challengeId,
    validatorId: v.validatorId,
    requestDigest: conformanceDigest({ challengeId: ch.challengeId, validatorId: v.validatorId, procedure: ch.challengeType, operation: ch.operation }),
    responseDigest: `sha256:${probe.responseDigest.slice(7)}`,
    statusCode: probe.statusCode,
    latencyMs: 7,
    synthetic: true,
  });
  const digest = ch.challengeType === 'G08' ? probe.observedDeploymentDigest : null;
  const observation: Record<string, unknown> = {
    schema: 'rn.conformance.observation/1',
    eventId: `rn04-evt-${v.validatorId}-${events}`,
    challengeId: ch.challengeId,
    challengeNonce: ch.nonce,
    validatorId: v.validatorId,
    validatorKeyId: signConformancePayload('observation', {}, v.key).keyId,
    organizationId: ch.organizationId,
    platformId: ch.platformId,
    integrationId: ch.integrationId,
    integrationVersion: ch.integrationVersion,
    integrationDigest: ch.integrationDigest,
    observedDeploymentDigest: digest,
    profileId: ch.profileId,
    profileVersion: ch.profileVersion,
    controlId: ch.controlId,
    operation: ch.operation,
    expectedOutcome: ch.expectedOutcome,
    observedOutcome,
    outcomeClass: classifyOutcome(ch.expectedOutcome, observedOutcome, digest, REFERENCE_DEPLOYMENT_DIGEST),
    evidenceDigest,
    observedAt: now,
    submittedAt: now,
  };
  options.mutate?.(observation);
  const raw = JSON.stringify({ observation, validatorSignature: signConformancePayload('observation', observation as unknown as ObservationPayload, options.signWith ?? v.key) });
  const result = c.services().evidence.submitObservation(raw);
  c.executed
    .find((e) => e.challengeId === ch.challengeId)
    ?.observations.push({ validatorId: v.validatorId, eventId: String(observation['eventId']), observedOutcome, accepted: result.accepted, rejection: result.accepted ? null : result.reason, leakedProtectedContent: probe.leakedProtectedContent });
  return { raw, result, probe };
}

/** Runs `types` for every covered operation (G08 once) with each validator and submits every observation. */
export async function runReferenceBaseline(c: ReferenceCircuit, validators: readonly SyntheticValidator[], options: { readonly operations?: readonly string[]; readonly types?: readonly ChallengeType[] } = {}): Promise<SubmissionResult[]> {
  const results: SubmissionResult[] = [];
  for (const type of options.types ?? REFERENCE_CHALLENGES) {
    for (const operation of type === 'G08' ? [DEPLOYMENT_ATTESTATION_OPERATION] : (options.operations ?? REFERENCE_OPERATIONS)) {
      const signed = issueReference(c, type, validators, operation);
      for (const v of validators) results.push((await observeReference(c, v, signed)).result);
    }
  }
  return results;
}

export function referenceApprovals(c: ReferenceCircuit, prepared: PreparedAction, requester: SyntheticHuman = c.humans.alice, approver: SyntheticHuman = c.humans.bob): SignedHumanDecision[] {
  const at = c.clock.now();
  return [decide(requester, 'attest', prepared.action, prepared.credentialId, prepared.actionBindingDigest, at), decide(approver, 'approve', prepared.action, prepared.credentialId, prepared.actionBindingDigest, at)];
}

/** Scenario A: a candidate, the full challenge matrix with two distinct operators, issuance by two humans. */
export async function activeReferenceCredential(c: ReferenceCircuit): Promise<string> {
  const { lifecycle } = c.services();
  const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
  await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
  c.clock.advance(1);
  const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
  lifecycle.commit(prepared, referenceApprovals(c, prepared));
  return credential.credentialId;
}

// ---------------------------------------------------------------------------
// Executable coverage records.
// ---------------------------------------------------------------------------

export type CoverageStatus = 'COVERED' | 'UNCOVERED' | 'INCONCLUSIVE' | 'STALE' | 'ENGINE_DERIVED' | 'NOT_COVERED';
export type CoverageClassification = 'ACCEPTED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_EXECUTED' | 'NOT_APPLICABLE';

export interface CoverageRecord {
  readonly requirementId: string;
  readonly challengeType: string | null;
  readonly operation: string;
  readonly fixtureVariant: string | null;
  readonly expectedOutcome: string | null;
  readonly observedOutcomes: readonly string[];
  readonly evidenceRefs: readonly string[];
  /** What the ENGINE concluded for this requirement and operation alone (never a fixture's self-report). */
  readonly engineCategory: ResultCategory | null;
  readonly classification: CoverageClassification;
  readonly coverageStatus: CoverageStatus;
  readonly note: string;
}

const statusOf = (category: ResultCategory, executed: boolean): { classification: CoverageClassification; coverageStatus: CoverageStatus } => {
  switch (category) {
    case 'VERIFIED_SUCCESS':
      return { classification: 'ACCEPTED', coverageStatus: 'COVERED' };
    case 'VERIFIED_FAILURE':
      return { classification: 'FAILED', coverageStatus: 'COVERED' };
    case 'STALE_EVIDENCE':
      return { classification: 'INCONCLUSIVE', coverageStatus: 'STALE' };
    case 'INSUFFICIENT_EVIDENCE':
      return executed ? { classification: 'INCONCLUSIVE', coverageStatus: 'INCONCLUSIVE' } : { classification: 'NOT_EXECUTED', coverageStatus: 'UNCOVERED' };
    case 'CONFLICTING':
    case 'UNCONFIRMED_VIOLATION':
      return { classification: 'INCONCLUSIVE', coverageStatus: 'INCONCLUSIVE' };
  }
};

/**
 * The executable coverage matrix for one credential: one record per (requirement, covered operation), plus the
 * engine-derived requirements, the not-covered requirements and the declared exclusions. Each validator-backed record's
 * category comes from running the real engine over the stored, authenticated evidence for **that operation alone**.
 */
export function referenceCoverage(c: ReferenceCircuit, credentialId: string): readonly CoverageRecord[] {
  const loaded = loadEngineInput(c.store, c.profiles, ORG_A, credentialId, c.clock.now(), c.coordinatorPublicKeyPem);
  if (loaded === undefined) throw new Error('credential not found');
  const profile = loaded.input.profile;
  const records: CoverageRecord[] = [];
  for (const requirement of profile.requirements) {
    if (requirement.evaluation !== 'validator-corroborated') {
      const whole = evaluateConformance(loaded.input).requirementResults.find((r) => r.requirementId === requirement.requirementId);
      records.push({ requirementId: requirement.requirementId, challengeType: null, operation: '*', fixtureVariant: null, expectedOutcome: null, observedOutcomes: [], evidenceRefs: [], engineCategory: whole?.category ?? null, classification: 'NOT_APPLICABLE', coverageStatus: 'ENGINE_DERIVED', note: `${requirement.evaluation}: computed by the engine from other results; no validator challenge` });
      continue;
    }
    for (const operation of requiredOperations(requirement.challengeType, loaded.input.coveredOperations)) {
      const perOperation = evaluateConformance({ ...loaded.input, coveredOperations: operation === DEPLOYMENT_ATTESTATION_OPERATION ? loaded.input.coveredOperations : [operation] });
      const result = perOperation.requirementResults.find((r) => r.requirementId === requirement.requirementId);
      const ran = c.executed.filter((e) => e.controlId === requirement.requirementId && e.operation === operation);
      const latest = ran[ran.length - 1];
      const category = result?.category ?? 'INSUFFICIENT_EVIDENCE';
      records.push({
        requirementId: requirement.requirementId,
        challengeType: requirement.challengeType,
        operation,
        fixtureVariant: latest?.fixtureVariant ?? null,
        expectedOutcome: requirement.challengeType === null ? null : CHALLENGE_CATALOGUE[requirement.challengeType as ChallengeType].expectedOutcome,
        observedOutcomes: latest === undefined ? [] : latest.observations.map((o) => `${o.validatorId}:${o.observedOutcome}`),
        evidenceRefs: result?.evidenceIds ?? [],
        engineCategory: category,
        ...statusOf(category, ran.length > 0),
        note: ran.length === 0 ? 'required challenge never executed for this operation' : `${ran.length} challenge(s) executed`,
      });
    }
  }
  for (const n of profile.notCovered) {
    records.push({ requirementId: n.requirementId, challengeType: null, operation: '*', fixtureVariant: null, expectedOutcome: null, observedOutcomes: [], evidenceRefs: [], engineCategory: null, classification: 'NOT_APPLICABLE', coverageStatus: 'NOT_COVERED', note: n.reason });
  }
  for (const e of REFERENCE_DECLARED_EXCLUSIONS) {
    records.push({ requirementId: '*', challengeType: null, operation: e.operation, fixtureVariant: null, expectedOutcome: null, observedOutcomes: [], evidenceRefs: [], engineCategory: null, classification: 'NOT_APPLICABLE', coverageStatus: 'NOT_COVERED', note: `declared exclusion: ${e.reason}` });
  }
  return Object.freeze(records);
}

// ---------------------------------------------------------------------------
// RN-CONFORM-03 signed status, unchanged, over the reference circuit.
// ---------------------------------------------------------------------------

export const STATUS_ISSUER = 'republika-synthetic-status-issuer';

export interface ReferenceStatus {
  readonly registry: StatusRegistry;
  readonly signer: SyntheticStatusSigner;
  readonly trusted: StatusIssuerKeyRegistry;
  verifierStore(name: string): StatusVerifierStore;
  expectation(credentialId: string, operation?: string): StatusExpectation;
  onlineRequest(credentialId: string, nonce: string, operation?: string): OnlineStatusRequest;
  verify(artifact: unknown, credentialId: string, mode: { kind: 'online'; nonce: string } | { kind: 'stapled' }, options?: { store?: StatusVerifierStore; operation?: string }): StatusVerdict;
  close(): void;
}

export function referenceStatus(c: ReferenceCircuit): ReferenceStatus {
  const issuerKey = testKey('status-issuer-1');
  const requesterKey = testKey('status-requester:status-registry');
  const projection: StatusProjectionDeps = { store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, humans: c.humansDirectory };
  const validUntil = '2027-11-02T09:00:00.000Z';
  const signer = createSyntheticStatusSigner({
    issuer: STATUS_ISSUER,
    keys: [{ privateKey: issuerKey, validFrom: T0, validUntil }],
    requesters: [{ id: 'status-registry', publicKeyPem: publicKeyPemOf(requesterKey) }],
    clock: c.clock,
    journalPath: join(c.dir, 'status-signer-journal.sqlite'),
    source: (credentialId, at) => projectCredentialStatus(projection, credentialId, at),
  });
  const registry = createStatusRegistry({ projection, clock: c.clock, signer, requester: { id: 'status-registry', key: requesterKey }, issuer: STATUS_ISSUER });
  const trusted = createStatusIssuerKeyRegistry([statusIssuerKeyRecord(STATUS_ISSUER, issuerKey, T0, validUntil, null)]);
  const opened: StatusVerifierStore[] = [];
  const expectation = (credentialId: string, operation = 'document.open'): StatusExpectation => ({
    credentialId,
    platformId: c.integration.platformId,
    organizationId: ORG_A,
    integrationId: c.integration.integrationId,
    integrationVersion: c.integration.integrationVersion,
    integrationDigest: c.integration.integrationDigest,
    profileId: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileId,
    profileVersion: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileVersion,
    operation,
  });
  return {
    registry,
    signer,
    trusted,
    verifierStore(name) {
      const s = openStatusVerifierStore(join(c.dir, `${name}.sqlite`), { create: true });
      opened.push(s);
      return s;
    },
    expectation,
    onlineRequest(credentialId, nonce, operation = 'document.open') {
      return {
        credentialId,
        nonce,
        expect: {
          platformId: c.integration.platformId,
          organizationId: ORG_A,
          integrationId: c.integration.integrationId,
          integrationVersion: c.integration.integrationVersion,
          integrationDigest: c.integration.integrationDigest,
          profileId: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileId,
          profileVersion: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileVersion,
        },
        operation,
      };
    },
    verify(artifact, credentialId, mode, o = {}) {
      return verifyConformanceStatus({ artifact, expect: expectation(credentialId, o.operation), mode, trustedKeys: trusted, clock: c.clock, ...(o.store === undefined ? {} : { highWaterMark: o.store }) });
    },
    close() {
      for (const s of opened.splice(0)) {
        try {
          s.close();
        } catch {
          // already closed
        }
      }
      signer.close();
    },
  };
}

export function assertionOf(outcome: ReturnType<StatusRegistry['issueOnline']>): string {
  if (outcome.kind !== 'assertion') throw new Error(`expected an assertion, got ${outcome.kind}${outcome.kind === 'unavailable' ? `: ${outcome.reason} ${outcome.detail}` : ''}`);
  return outcome.text;
}
