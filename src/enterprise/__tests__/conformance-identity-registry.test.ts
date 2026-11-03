import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { conformanceDigest } from '../conformance/canonical.js';
import { SYNTHETIC_OPERATOR_STATEMENT, toMs, toTimestamp } from '../conformance/contracts.js';
import { createSyntheticHumanDirectory, verifyTwoPersonAuthority } from '../conformance/human-authority.js';
import {
  PINNED_PROFILE_DIGESTS,
  RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1,
  RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1,
  createConformanceProfileRegistry,
  profileDigest,
  type ConformanceProfileDefinition,
} from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, ConformanceRegistryError, createConformanceRegistry } from '../conformance/registry.js';
import { deriveConformanceKeyId, publicKeyPemOf } from '../conformance/signing.js';
import {
  ALL_ACTIONS,
  ORG_A,
  ORG_B,
  T0,
  buildCircuit,
  cleanupAll,
  decide,
  enrollmentDecisions,
  integrationInput,
  syntheticHuman,
  syntheticValidator,
  testKey,
} from './conformance-support.js';

/**
 * RN-CONFORM-02 / WP-03, WP-04, CC-D-04 — the pinned profiles, the
 * append-only integration registry, synthetic operators, two-person validator
 * enrollment, and the human authority adapter itself.
 */

after(cleanupAll);

const refusedWith = (code: string) => (error: unknown) => error instanceof ConformanceRegistryError && error.code === code;

describe('RN-CONFORM-02 profile definitions (WP-03)', () => {
  it('pins both profiles by golden digest', () => {
    assert.equal(profileDigest(RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1), 'sha256:c3fa6377c7482b10bb51b24f83a8f1e7491147b3562bb54eb3456e64e2ac3e43');
    assert.equal(profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1), 'sha256:89ff278a2b9c0061e6a3f509382570baa388dcd46b5422b7cd827c7076b1a432');
    assert.equal(PINNED_PROFILE_DIGESTS['rn.conformance.integration@0.1.0'], profileDigest(RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1));
  });

  it('declares itself non-normative, not commercially active, and accurately scoped', () => {
    for (const p of [RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1]) {
      assert.equal(p.normative, false);
      assert.equal(p.commercialActivation, false);
      assert.deepEqual(p.corroboration, { minDistinctOperators: 2, windowSeconds: 1800, disputeResolutionOperators: 3, investigationTimeoutSeconds: 1800 });
    }
    assert.equal(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.designation, 'synthetic-test-only');
    const covered = RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.requirements.map((r) => r.requirementId);
    const notCovered = RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.notCovered.map((r) => r.requirementId);
    assert.deepEqual(covered, ['CR-01', 'CR-02', 'CR-05', 'CR-06', 'CR-07', 'CR-08', 'CR-09', 'CR-12']);
    assert.deepEqual(notCovered, ['CR-03', 'CR-04', 'CR-10', 'CR-11']);
    // Every requirement of the draft is either covered or declared not covered — none silently passed.
    const all = RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1.requirements.map((r) => r.requirementId).sort();
    assert.deepEqual([...covered, ...notCovered].sort(), all);
    assert.equal(RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1.supportedSdk, null);
  });

  it('refuses unknown profiles and changed definitions under an existing version', () => {
    const registry = createConformanceProfileRegistry();
    assert.equal(registry.resolve('rn.conformance.unknown', '0.1.0').ok, false);
    const changed: ConformanceProfileDefinition = { ...RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, freshnessGraceSeconds: 1 };
    assert.deepEqual(registry.admit(changed), { ok: false, reason: 'PROFILE_DIGEST_MISMATCH' });
    const unpinned: ConformanceProfileDefinition = { ...RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileVersion: '0.9.0' };
    assert.deepEqual(registry.admit(unpinned), { ok: false, reason: 'UNKNOWN_PROFILE' });
    assert.throws(() => createConformanceProfileRegistry({ additionalDefinitions: [changed] }));
    assert.equal(registry.resolve(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, '0.1.0', `sha256:${'0'.repeat(64)}`).ok, false);
  });
});

describe('RN-CONFORM-02 integration registry (WP-03)', () => {
  it('registers a synthetic integration with a deterministic, immutable digest', () => {
    const a = buildCircuit({ enroll: false });
    const b = buildCircuit({ enroll: false });
    assert.equal(a.integration.integrationDigest, b.integration.integrationDigest, 'same inputs and clock give the same digest');
    const again = a.services().registry.registerIntegrationVersion(integrationInput(profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1)));
    assert.equal(again.integrationDigest, a.integration.integrationDigest, 'identical re-registration is idempotent');
    a.cleanup();
    b.cleanup();
  });

  it('refuses unknown profile, wrong profile digest, unsupported SDK, cross-tenant platform, conflicting duplicates, gaps and downgrades', () => {
    const c = buildCircuit({ enroll: false });
    const { registry } = c.services();
    const digest = profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1);
    const v2 = (o: Record<string, unknown>) => integrationInput(digest, { integrationVersion: 2, deploymentDigest: `sha256:${'4'.repeat(64)}`, ...o });
    assert.throws(() => registry.registerIntegrationVersion(v2({ profile: { id: 'rn.conformance.unknown', version: '0.1.0', digest } })), refusedWith('UNKNOWN_PROFILE'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ profile: { id: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, version: '0.1.0', digest: `sha256:${'9'.repeat(64)}` } })), refusedWith('PROFILE_DIGEST_MISMATCH'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ sdk: { package: '@republika-synthetic/conformance-fixture-sdk', version: '2.0.0', lockDigest: `sha256:${'1'.repeat(64)}` } })), refusedWith('UNSUPPORTED_SDK'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ sdk: { package: '@other/sdk', version: '1.5.0', lockDigest: `sha256:${'1'.repeat(64)}` } })), refusedWith('UNSUPPORTED_SDK'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ sdk: { package: '@republika-synthetic/conformance-fixture-sdk', version: '1.0.0', lockDigest: `sha256:${'1'.repeat(64)}` } })), refusedWith('SDK_DOWNGRADE'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ organizationId: ORG_B })), refusedWith('CROSS_TENANT'));
    assert.throws(() => registry.registerIntegrationVersion(integrationInput(digest, { deploymentDigest: `sha256:${'5'.repeat(64)}` })), refusedWith('DUPLICATE_CONFLICT'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ integrationVersion: 3 })), refusedWith('VERSION_CONFLICT'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ testEndpoints: [{ endpointId: 'e', environment: 'production', fixtureRef: 'f' }] })), refusedWith('NOT_SYNTHETIC'));
    assert.throws(() => registry.registerIntegrationVersion(v2({ unexpected: true })), refusedWith('MALFORMED_INPUT'));
    // A new version is a new record with its own digest; v1 is untouched.
    const second = registry.registerIntegrationVersion(v2({}));
    assert.notEqual(second.integrationDigest, c.integration.integrationDigest);
    assert.equal(c.store.getIntegrationVersions(ORG_A, 'integration-synthetic-alpha').length, 2);
    // Tenant scoping on reads: organization B cannot see organization A's integration.
    assert.equal(c.store.getIntegrationByDigest(ORG_B, c.integration.integrationDigest), undefined);
    c.cleanup();
  });

  it('refuses a profile downgrade across integration versions', () => {
    // A second, test-only pinned version of the synthetic profile, so downgrade can be exercised.
    const v020: ConformanceProfileDefinition = { ...RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileVersion: '0.2.0' };
    const c = buildCircuit({ enroll: false });
    const profiles = createConformanceProfileRegistry({ additionalPins: { 'rn.conformance.synthetic-circuit@0.2.0': profileDigest(v020) }, additionalDefinitions: [v020] });
    const registry = createConformanceRegistry({ store: c.store, profiles, clock: c.clock, humans: c.humansDirectory });
    registry.registerProfile(v020);
    registry.registerIntegrationVersion(integrationInput(profileDigest(v020), { integrationVersion: 2, deploymentDigest: `sha256:${'6'.repeat(64)}`, profile: { id: v020.profileId, version: '0.2.0', digest: profileDigest(v020) } }));
    assert.throws(
      () => registry.registerIntegrationVersion(integrationInput(profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1), { integrationVersion: 3, deploymentDigest: `sha256:${'7'.repeat(64)}` })),
      refusedWith('PROFILE_DOWNGRADE'),
    );
    c.cleanup();
  });

  it('labels every operator as synthetic and asserts nothing about independence', () => {
    const c = buildCircuit({ enroll: false });
    const op = c.store.getOperator('op-synthetic-a');
    assert.equal(op?.synthetic, true);
    assert.equal(op?.attestation.statement, SYNTHETIC_OPERATOR_STATEMENT);
    assert.match(SYNTHETIC_OPERATOR_STATEMENT, /not evidence that an independent validator operator exists/);
    c.cleanup();
  });
});

describe('RN-CONFORM-02 validator enrollment (WP-04, CC-D-04)', () => {
  const enrollWith = (decisionsFor: (c: ReturnType<typeof buildCircuit>, validatorId: string, binding: string) => unknown[], code: string) => {
    const c = buildCircuit({ enroll: false });
    const { registry } = c.services();
    const v = syntheticValidator('validator-x', 'op-synthetic-a');
    const prepared = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: v.operatorId, publicKeyPem: v.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    assert.throws(() => registry.enrollValidator(prepared.record, decisionsFor(c, v.validatorId, prepared.bindingDigest)), (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'APPROVAL_REFUSED' && e.detail === code, code);
    assert.equal(c.store.getValidator(v.validatorId), undefined, 'nothing was enrolled');
    c.cleanup();
  };

  it('enrolls only with two valid decisions from two distinct humans', () => {
    const c = buildCircuit();
    for (const v of Object.values(c.validators)) {
      const stored = c.store.getValidator(v.validatorId);
      assert.ok(stored);
      assert.equal(stored.decisions.length, 2);
      assert.notEqual(stored.decisions[0]!.principalId, stored.decisions[1]!.principalId);
    }
    c.cleanup();
  });

  it('refuses missing, single, same-human, wrong-subject, wrong-digest, expired, revoked-key and replayed approvals', () => {
    enrollWith(() => [], 'DECISIONS_MISSING');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'validator.enroll', id, b, c.clock.now())], 'DECISIONS_MISSING');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'validator.enroll', id, b, c.clock.now()), decide(c.humans.netAlice, 'approve', 'validator.enroll', id, b, c.clock.now())], 'SAME_PRINCIPAL');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'validator.enroll', id, b, c.clock.now()), decide(c.humans.netBob, 'attest', 'validator.enroll', id, b, c.clock.now())], 'ROLE_MISMATCH');
    enrollWith((c, _id, b) => enrollmentDecisions(c, 'validator-other', b, c.clock.now()), 'SUBJECT_MISMATCH');
    enrollWith((c, id) => enrollmentDecisions(c, id, conformanceDigest({ other: true }), c.clock.now()), 'BINDING_DIGEST_MISMATCH');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'credential.issue', id, b, c.clock.now()), decide(c.humans.netBob, 'approve', 'credential.issue', id, b, c.clock.now())], 'ACTION_MISMATCH');
    enrollWith((c, id, b) => enrollmentDecisions(c, id, b, toTimestamp(c.clock.ms() - 10 * 60 * 1000)), 'EXPIRED');
    enrollWith((c, id, b) => {
      c.humansDirectory.revokeKey(deriveConformanceKeyId(c.humans.netBob.publicKeyPem), toTimestamp(c.clock.ms() - 1));
      return enrollmentDecisions(c, id, b, c.clock.now());
    }, 'APPROVAL_KEY_REVOKED');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'validator.enroll', id, b, c.clock.now()), decide(c.humans.netBob, 'approve', 'validator.enroll', id, b, c.clock.now(), {}, testKey('forged'))], 'UNKNOWN_APPROVAL_KEY');
    enrollWith((c, id, b) => [decide(c.humans.netAlice, 'attest', 'validator.enroll', id, b, c.clock.now()), decide(c.humans.netBob, 'approve', 'validator.enroll', id, b, c.clock.now(), {}, c.humans.netAlice.key)], 'PRINCIPAL_KEY_MISMATCH');
    enrollWith((c, id, b) => [decide(c.humans.alice, 'attest', 'validator.enroll', id, b, c.clock.now()), decide(c.humans.bob, 'approve', 'validator.enroll', id, b, c.clock.now())], 'ORGANIZATION_MISMATCH');

    // Replay: decisions consumed by one enrollment cannot enroll another validator, even for the same digest.
    const c = buildCircuit({ enroll: false });
    const { registry } = c.services();
    const v = syntheticValidator('validator-y', 'op-synthetic-b');
    const prepared = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: v.operatorId, publicKeyPem: v.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    const decisions = enrollmentDecisions(c, v.validatorId, prepared.bindingDigest, c.clock.now());
    registry.enrollValidator(prepared.record, decisions);
    const verdict = verifyTwoPersonAuthority(c.humansDirectory, decisions, { action: 'validator.enroll', organizationId: CONFORMANCE_NETWORK_ORGANIZATION, subjectRef: v.validatorId, actionBindingDigest: prepared.bindingDigest, now: c.clock.now() }, c.store.isDecisionConsumed);
    assert.deepEqual(verdict, { authorized: false, denial: 'ALREADY_CONSUMED' });
    c.cleanup();
  });

  it('refuses key substitution, key reuse, conflicting re-enrollment and private key material', () => {
    const c = buildCircuit();
    const { registry } = c.services();
    const A = c.validators.A;
    const substitute = registry.prepareValidatorEnrollment({ validatorId: A.validatorId, operatorId: A.operatorId, publicKeyPem: publicKeyPemOf(testKey('substitute')), keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    assert.throws(() => registry.enrollValidator(substitute.record, enrollmentDecisions(c, A.validatorId, substitute.bindingDigest, c.clock.now())), refusedWith('VALIDATOR_CONFLICT'));
    const reuse = registry.prepareValidatorEnrollment({ validatorId: 'validator-z', operatorId: 'op-synthetic-c', publicKeyPem: A.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    assert.throws(() => registry.enrollValidator(reuse.record, enrollmentDecisions(c, 'validator-z', reuse.bindingDigest, c.clock.now())), refusedWith('KEY_REUSED'));
    const forgedId = { ...reuse.record, validatorId: 'validator-w', keyId: `sha256:${'a'.repeat(64)}` };
    assert.throws(() => registry.enrollValidator(forgedId, []), refusedWith('KEY_ID_MISMATCH'));
    const pkcs8 = testKey('private').export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => registry.prepareValidatorEnrollment({ validatorId: 'validator-p', operatorId: 'op-synthetic-a', publicKeyPem: pkcs8, keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' }), refusedWith('KEY_NOT_PUBLIC'));
    const unknownOp = registry.prepareValidatorEnrollment({ validatorId: 'validator-q', operatorId: 'op-unregistered', publicKeyPem: publicKeyPemOf(testKey('q')), keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    assert.throws(() => registry.enrollValidator(unknownOp.record, []), refusedWith('UNKNOWN_OPERATOR'));
    c.cleanup();
  });

  it('refuses enrollment written directly to the database without two consumed decisions', () => {
    const c = buildCircuit({ enroll: false });
    const { registry } = c.services();
    const v = syntheticValidator('validator-direct', 'op-synthetic-a');
    const prepared = registry.prepareValidatorEnrollment({ validatorId: v.validatorId, operatorId: v.operatorId, publicKeyPem: v.publicKeyPem, keyValidFrom: T0, keyValidUntil: '2027-01-01T00:00:00.000Z' });
    assert.throws(() => c.store.insertValidator(prepared.record, prepared.bindingDigest, [], c.clock.now()), /enrollment requires two humans/);
    c.cleanup();
  });
});

describe('RN-CONFORM-02 human authority adapter (CC-D-04)', () => {
  const alice = syntheticHuman('h-alice', ORG_A);
  const bob = syntheticHuman('h-bob', ORG_A);
  const now = '2026-11-02T10:00:00.000Z';
  const binding = conformanceDigest({ action: 'x' });
  const request = { action: 'credential.issue' as const, organizationId: ORG_A, subjectRef: 'crd_1', actionBindingDigest: binding, now };

  it('refuses one key registered to two humans, and two keys of one human are still one human', () => {
    assert.throws(() => createSyntheticHumanDirectory([
      { principalId: 'p1', organizationId: ORG_A, keys: [{ publicKeyPem: alice.publicKeyPem }], permissions: ALL_ACTIONS },
      { principalId: 'p2', organizationId: ORG_A, keys: [{ publicKeyPem: alice.publicKeyPem }], permissions: ALL_ACTIONS },
    ]));
    const secondKey = testKey('h-alice-second');
    const directory = createSyntheticHumanDirectory([{ principalId: alice.principalId, organizationId: ORG_A, keys: [{ publicKeyPem: alice.publicKeyPem }, { publicKeyPem: publicKeyPemOf(secondKey) }], permissions: ALL_ACTIONS }]);
    const decisions = [decide(alice, 'attest', 'credential.issue', 'crd_1', binding, now), decide(alice, 'approve', 'credential.issue', 'crd_1', binding, now, {}, secondKey)];
    assert.deepEqual(verifyTwoPersonAuthority(directory, decisions, request, () => false), { authorized: false, denial: 'SAME_PRINCIPAL' });
  });

  it('refuses a missing permission, a not-yet-valid decision, an over-long lifetime and a non-synthetic decision', () => {
    const directory = createSyntheticHumanDirectory([
      { principalId: alice.principalId, organizationId: ORG_A, keys: [{ publicKeyPem: alice.publicKeyPem }], permissions: ALL_ACTIONS },
      { principalId: bob.principalId, organizationId: ORG_A, keys: [{ publicKeyPem: bob.publicKeyPem }], permissions: { 'credential.issue': ['attest'] } },
    ]);
    const ok = (o: Record<string, unknown> = {}) => [decide(alice, 'attest', 'credential.issue', 'crd_1', binding, now), decide(bob, 'approve', 'credential.issue', 'crd_1', binding, now, o)];
    assert.deepEqual(verifyTwoPersonAuthority(directory, ok(), request, () => false), { authorized: false, denial: 'NOT_PERMITTED' });
    const later = toTimestamp(toMs(now) + 60_000);
    assert.equal((verifyTwoPersonAuthority(directory, ok({ issuedAt: later, expiresAt: toTimestamp(toMs(later) + 60_000) }), request, () => false) as { denial: string }).denial, 'NOT_YET_VALID');
    assert.equal((verifyTwoPersonAuthority(directory, ok({ expiresAt: toTimestamp(toMs(now) + 3_600_000) }), request, () => false) as { denial: string }).denial, 'LIFETIME_TOO_LONG');
    assert.equal((verifyTwoPersonAuthority(directory, ok({ synthetic: false as unknown as true }), request, () => false) as { denial: string }).denial, 'NOT_SYNTHETIC');
    // Modifying a signed decision after signing breaks its signature.
    const tampered = ok();
    const mutated = { ...tampered[1]!, decision: { ...tampered[1]!.decision, subjectRef: 'crd_1' } };
    (mutated.decision as { issuedAt: string }).issuedAt = toTimestamp(toMs(now) - 1000);
    assert.equal((verifyTwoPersonAuthority(directory, [tampered[0]!, mutated], request, () => false) as { denial: string }).denial, 'SIGNATURE_INVALID');
  });
});
