import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { CHALLENGE_CATALOGUE } from '../conformance/contracts.js';
import { ChallengeCoordinatorError } from '../conformance/coordinator.js';
import { CredentialLifecycleError } from '../conformance/lifecycle.js';
import { PINNED_PROFILE_DIGESTS, RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1, RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileDigest } from '../conformance/profile.js';
import { ConformanceRegistryError } from '../conformance/registry.js';
import { ORG_A, testKey } from './conformance-support.js';
import { BYPASS_IDS, BYPASS_VARIANTS, REFERENCE_OPERATIONS, type BypassId, type ReferenceOperation } from './conformance-reference-pep.js';
import {
  REFERENCE_CHALLENGES,
  buildReferenceCircuit,
  cleanupReferenceCircuits,
  issueReference,
  observeReference,
  referenceCoverage,
  referenceIntegrationInput,
  runReferenceBaseline,
} from './conformance-reference-support.js';

/**
 * RN-CONFORM-04 / WP-04, WP-05 — the executable coverage matrix. Every classification below is the RN-CONFORM-02 engine's,
 * computed from signed validator observations accepted through the real evidence path; no fixture self-reports a pass.
 */

after(() => cleanupReferenceCircuits());

const assessed = (c: ReturnType<typeof buildReferenceCircuit>, credentialId: string) => {
  const a = c.services().lifecycle.assess(ORG_A, credentialId);
  assert.ok(a);
  return new Map(a.engine.requirementResults.map((r) => [r.requirementId, r]));
};

describe('RN-CONFORM-04 — the reference profile', () => {
  it('is pinned, synthetic-only, backs CR-03/CR-04 with G03/G04, and declares CR-10/CR-11 not covered', () => {
    const p = RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1;
    assert.equal(PINNED_PROFILE_DIGESTS['rn.conformance.document-use-reference@0.1.0'], profileDigest(p));
    assert.deepEqual([p.designation, p.normative, p.commercialActivation], ['synthetic-test-only', false, false]);
    assert.deepEqual(p.requirements.map((r) => `${r.requirementId}:${r.challengeType}:${r.evaluation}`), [
      'CR-01:G01:validator-corroborated', 'CR-02:G02:validator-corroborated', 'CR-03:G03:validator-corroborated', 'CR-04:G04:validator-corroborated',
      'CR-05:G05:validator-corroborated', 'CR-06:G06:validator-corroborated', 'CR-07:G07:validator-corroborated', 'CR-08:G08:validator-corroborated',
      'CR-09:G09:deterministic-freshness', 'CR-12:G08:deterministic-sdk',
    ]);
    assert.deepEqual(p.notCovered.map((n) => n.requirementId), ['CR-10', 'CR-11']);
    assert.equal(p.supportedSdk?.package, '@republika-synthetic/document-use-reference-adapter', 'a synthetic adapter contract; CC-D-10 stays open');
    // The earlier pins are unchanged: CR-03/CR-04 remain unimplemented in the draft profile, absent from the circuit profile.
    assert.equal(PINNED_PROFILE_DIGESTS['rn.conformance.integration@0.1.0'], profileDigest(RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1));
    assert.equal(PINNED_PROFILE_DIGESTS['rn.conformance.synthetic-circuit@0.1.0'], profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1));
    assert.equal(RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1.requirements.find((r) => r.requirementId === 'CR-03')?.evaluation, 'unimplemented-challenge');
    assert.deepEqual([CHALLENGE_CATALOGUE.G03, CHALLENGE_CATALOGUE.G04].map((g) => `${g.controlId}:${g.expectedOutcome}`), ['CR-03:denied', 'CR-04:denied']);
  });

  it('refuses an SDK outside the synthetic adapter contract range and an operation outside coverage', () => {
    const c = buildReferenceCircuit();
    const { registry } = c.services();
    assert.throws(
      () => registry.registerIntegrationVersion(referenceIntegrationInput(c.profileDigest, { integrationVersion: 2, sdk: { package: '@republika-synthetic/document-use-reference-adapter', version: '2.0.0', lockDigest: `sha256:${'5'.repeat(64)}` } })),
      (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'UNSUPPORTED_SDK',
    );
    assert.throws(() => issueReference(c, 'G01', [c.validators.A], 'document.share'), (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === 'OPERATION_NOT_COVERED');
  });
});

describe('RN-CONFORM-04 WP-04 — the executable matrix on the conformant reference PEP', () => {
  it('G01–G08 for every covered operation, corroborated by two distinct operators, verify every critical requirement', async () => {
    const c = buildReferenceCircuit();
    const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const results = await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    assert.equal(results.length, 2 * (7 * REFERENCE_OPERATIONS.length + 1), '22 challenges, 2 observations each');
    assert.ok(results.every((r) => r.accepted));
    assert.ok(c.executed.every((e) => e.observations.every((o) => !o.leakedProtectedContent)));
    const byId = assessed(c, credential.credentialId);
    for (const id of ['CR-01', 'CR-02', 'CR-03', 'CR-04', 'CR-05', 'CR-06', 'CR-07', 'CR-08', 'CR-09', 'CR-12']) assert.equal(byId.get(id)?.category, 'VERIFIED_SUCCESS', id);
    assert.ok(!byId.has('CR-10') && !byId.has('CR-11'), 'not-covered requirements are never reported as passed');

    const coverage = referenceCoverage(c, credential.credentialId);
    const validatorBacked = coverage.filter((r) => r.challengeType !== null);
    assert.equal(validatorBacked.length, 7 * 3 + 1);
    for (const record of validatorBacked) {
      assert.deepEqual([record.coverageStatus, record.classification, record.engineCategory, record.fixtureVariant], ['COVERED', 'ACCEPTED', 'VERIFIED_SUCCESS', 'CONFORMANT'], `${record.requirementId} ${record.operation}`);
      assert.equal(record.expectedOutcome, CHALLENGE_CATALOGUE[record.challengeType as 'G01'].expectedOutcome);
      assert.ok(record.evidenceRefs.length >= 2, 'two accepted observations back each record');
    }
    assert.deepEqual(coverage.filter((r) => r.coverageStatus === 'ENGINE_DERIVED').map((r) => r.requirementId), ['CR-09', 'CR-12']);
    assert.deepEqual(coverage.filter((r) => r.coverageStatus === 'NOT_COVERED').map((r) => `${r.requirementId}@${r.operation}`), ['CR-10@*', 'CR-11@*', '*@document.share', '*@document.delete', '*@document.edit-content']);
    assert.ok(!coverage.some((r) => r.requirementId === 'CR-11' && r.classification === 'ACCEPTED'), 'CR-11 has no automated pass');
  });

  it('a required challenge that never ran is UNCOVERED, never a pass — and blocks issuance', async () => {
    const c = buildReferenceCircuit();
    const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    await runReferenceBaseline(c, [c.validators.A, c.validators.B], { types: REFERENCE_CHALLENGES.filter((t) => t !== 'G04') });
    const g04 = referenceCoverage(c, credential.credentialId).filter((r) => r.requirementId === 'CR-04');
    assert.equal(g04.length, 3);
    assert.ok(g04.every((r) => r.coverageStatus === 'UNCOVERED' && r.classification === 'NOT_EXECUTED'));
    c.clock.advance(1);
    assert.throws(() => c.services().lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId }), (e: unknown) => e instanceof CredentialLifecycleError && e.code === 'NOT_ELIGIBLE');
  });

  it('Scenario F — evidence is never borrowed across operations: open-only evidence leaves export and modify uncovered', async () => {
    const c = buildReferenceCircuit();
    const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    await runReferenceBaseline(c, [c.validators.A, c.validators.B], { operations: ['document.open'] });
    const coverage = referenceCoverage(c, credential.credentialId).filter((r) => r.challengeType !== null && r.challengeType !== 'G08');
    for (const r of coverage) assert.equal(r.coverageStatus, r.operation === 'document.open' ? 'COVERED' : 'UNCOVERED', `${r.requirementId} ${r.operation}`);
    const byId = assessed(c, credential.credentialId);
    assert.equal(byId.get('CR-01')?.category, 'INSUFFICIENT_EVIDENCE');
    assert.ok(byId.get('CR-01')?.reasonCodes.some((code) => code.includes('document.export')));
    assert.ok(byId.get('CR-01')?.reasonCodes.some((code) => code.includes('document.modify-protected-terms')));
  });
});

describe('RN-CONFORM-04 WP-03/WP-05 — every bypass variant is detected by its challenge, on the defective operation only', () => {
  // BYPASS-01 skips decision acquisition and verification altogether, so it is (correctly) also observed by the
  // alternative-interface, stale-decision and fail-closed procedures: an operation that never asks is bypassable everywhere.
  const DETECTED_BY: Record<BypassId, readonly string[]> = {
    'BYPASS-01': ['CR-01', 'CR-03', 'CR-05', 'CR-07'],
    'BYPASS-02': ['CR-02'],
    'BYPASS-03': ['CR-03'],
    'BYPASS-04': ['CR-04'],
    'BYPASS-05': ['CR-05'],
    'BYPASS-06': ['CR-06'],
    'BYPASS-07': ['CR-07'],
    'BYPASS-08': ['CR-08'],
  };
  const DEFECTIVE: ReferenceOperation = 'document.export';
  for (const id of BYPASS_IDS) {
    it(`${id} (${BYPASS_VARIANTS[id].title}) → ${DETECTED_BY[id].join(', ')} VERIFIED_FAILURE`, async () => {
      const c = buildReferenceCircuit();
      const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
      c.deployment.defects.add(id);
      c.deployment.defectOperations.add(DEFECTIVE);
      const results = await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
      assert.ok(results.every((r) => r.accepted), 'violations are accepted evidence too');
      const byId = assessed(c, credential.credentialId);
      const failing = [...byId.values()].filter((r) => r.category === 'VERIFIED_FAILURE').map((r) => r.requirementId).sort();
      assert.deepEqual(failing, [...DETECTED_BY[id]].sort());
      assert.ok(DETECTED_BY[id].includes(BYPASS_VARIANTS[id].controlId), 'the variant\'s own control is among them');
      const coverage = referenceCoverage(c, credential.credentialId);
      for (const control of DETECTED_BY[id]) {
        for (const r of coverage.filter((x) => x.requirementId === control)) {
          const expected = control === 'CR-08' || r.operation === DEFECTIVE ? 'FAILED' : 'ACCEPTED';
          assert.equal(r.classification, expected, `${control} ${r.operation}`);
        }
      }
    });
  }
});

describe('RN-CONFORM-04 WP-11 — conformance evidence adversarial cases', () => {
  it('rejects forged, rebound, replayed, expired and revoked-key observations; the engine recomputes a lying claim', async () => {
    const c = buildReferenceCircuit();
    const g01 = issueReference(c, 'G01', [c.validators.A, c.validators.B], 'document.export');
    assert.deepEqual((await observeReference(c, c.validators.A, g01, { signWith: testKey('validator:intruder') })).result, { accepted: false, reason: 'SIGNATURE_MISMATCH' });
    assert.deepEqual((await observeReference(c, c.validators.A, g01, { mutate: (o) => (o['integrationDigest'] = `sha256:${'0'.repeat(64)}`) })).result, { accepted: false, reason: 'SUBJECT_BINDING_MISMATCH' });
    assert.deepEqual((await observeReference(c, c.validators.A, g01, { mutate: (o) => (o['operation'] = 'document.open') })).result, { accepted: false, reason: 'SUBJECT_BINDING_MISMATCH' }, 'evidence for another operation');
    assert.deepEqual((await observeReference(c, c.validators.A, g01, { mutate: (o) => (o['challengeNonce'] = 'A'.repeat(43)) })).result, { accepted: false, reason: 'CHALLENGE_BINDING_MISMATCH' }, 'nonce replay');
    // A validator claiming "conformant" for an allowed operation: the engine classifies from the observed outcome.
    c.deployment.defects.add('BYPASS-01');
    const lying = await observeReference(c, c.validators.A, g01, { mutate: (o) => (o['outcomeClass'] = 'conformant') });
    assert.equal(lying.result.accepted, true);
    if (lying.result.accepted) assert.deepEqual([lying.result.observation.outcomeClass, lying.result.observation.validatorClaimMatches], ['violation', false]);
    const replay = c.services().evidence.submitObservation(lying.raw);
    assert.deepEqual(replay, { accepted: false, reason: 'REPLAYED' });
    c.clock.advance(700);
    assert.deepEqual((await observeReference(c, c.validators.B, g01)).result, { accepted: false, reason: 'CHALLENGE_EXPIRED' });
    c.services().registry.revokeValidatorKey('validator-c', 'compromised (test)');
    assert.throws(() => issueReference(c, 'G01', [c.validators.C], 'document.export'), (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === 'VALIDATOR_NOT_ELIGIBLE');
  });

  it('one operator cannot corroborate itself: two validators of one operator leave a violation unconfirmed', async () => {
    const c = buildReferenceCircuit();
    const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    c.deployment.defects.add('BYPASS-06');
    const g06 = issueReference(c, 'G06', [c.validators.A, c.validators.A2], 'document.open');
    await observeReference(c, c.validators.A, g06);
    await observeReference(c, c.validators.A2, g06);
    assert.equal(assessed(c, credential.credentialId).get('CR-06')?.category, 'UNCONFIRMED_VIOLATION');
  });
});
