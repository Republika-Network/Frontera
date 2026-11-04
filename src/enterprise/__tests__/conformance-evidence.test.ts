import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHALLENGE_NONCE_BYTES, ChallengeCoordinatorError, DEPLOYMENT_ATTESTATION_OPERATION, createChallengeCoordinator, secureRandomSource, verifyChallenge } from '../conformance/coordinator.js';
import { EVIDENCE_REJECTIONS, MAX_SUBMISSION_BYTES, type EvidenceRejection } from '../conformance/evidence.js';
import { canonicalizeConformance } from '../conformance/canonical.js';
import { publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import Database from 'better-sqlite3';
import { ORG_A, buildCircuit, cleanupAll, decide, issue, observe, submit, testKey, testingAuthorizationFor, type Circuit } from './conformance-support.js';

/**
 * RN-CONFORM-02 / WP-05, WP-06, WP-07 — signed challenges, signed
 * observations and the evidence acceptance boundary, with one test per
 * rejection reason. Every submission here is a synthetic validator's
 * observation of the synthetic fixture platform.
 */

after(cleanupAll);

const rejected = (c: Circuit, raw: string, reason: EvidenceRejection) => {
  const before = c.store.listObservations(ORG_A, c.integration.integrationDigest).length;
  const result = submit(c, raw);
  assert.deepEqual(result, { accepted: false, reason }, `expected ${reason}`);
  assert.equal(c.store.listObservations(ORG_A, c.integration.integrationDigest).length, before, 'a rejected submission never reaches evaluation');
};

const resign = (raw: string, mutate: (o: Record<string, unknown>) => void, sign: (o: Record<string, unknown>) => unknown): string => {
  const parsed = JSON.parse(raw) as { observation: Record<string, unknown> };
  mutate(parsed.observation);
  return JSON.stringify({ observation: parsed.observation, validatorSignature: sign(parsed.observation) });
};

describe('RN-CONFORM-02 challenge coordinator (WP-05)', () => {
  it('issues signed, bound challenges with 32 random nonce bytes', () => {
    const c = buildCircuit();
    const signed = issue(c, 'G01', [c.validators.A, c.validators.B]);
    const ch = signed.challenge;
    assert.equal(Buffer.from(ch.nonce, 'base64url').length, CHALLENGE_NONCE_BYTES);
    assert.match(ch.challengeId, /^chl_[0-9a-f]{32}$/);
    assert.equal(ch.integrationDigest, c.integration.integrationDigest);
    assert.equal(ch.controlId, 'CR-01');
    assert.equal(ch.expectedOutcome, 'denied');
    assert.equal(ch.profileId, 'rn.conformance.synthetic-circuit');
    assert.deepEqual(ch.assignedValidatorIds, ['validator-a', 'validator-b']);
    assert.equal(ch.synthetic, true);
    assert.ok(verifyChallenge(signed, publicKeyPemOf(c.coordinatorKey)));
    assert.ok(!verifyChallenge({ ...signed, challenge: { ...ch, controlId: 'CR-02' } }, publicKeyPemOf(c.coordinatorKey)));
    assert.ok(!verifyChallenge(signed, publicKeyPemOf(testKey('not-the-coordinator'))));
    c.cleanup();
  });

  it('is idempotent on re-dispatch and refuses a conflicting reuse of the key', () => {
    const c = buildCircuit();
    const first = issue(c, 'G02', [c.validators.A], { idempotencyKey: 'dispatch-1' });
    c.clock.advance(5);
    const again = issue(c, 'G02', [c.validators.A], { idempotencyKey: 'dispatch-1' });
    assert.deepEqual(again, first, 'same challenge, not a new one');
    assert.throws(() => issue(c, 'G02', [c.validators.B], { idempotencyKey: 'dispatch-1' }), (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === 'IDEMPOTENCY_CONFLICT');
    c.cleanup();
  });

  it('refuses unknown integrations, foreign tenants, ineligible validators, long deadlines and uncovered operations', () => {
    const c = buildCircuit();
    const code = (fn: () => unknown, expected: string) => assert.throws(fn, (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === expected, expected);
    code(() => issue(c, 'G01', [c.validators.A], { integrationDigest: `sha256:${'0'.repeat(64)}` }), 'UNKNOWN_INTEGRATION');
    code(() => issue(c, 'G01', [c.validators.A], { organizationId: 'org-synthetic-beta' }), 'UNKNOWN_INTEGRATION');
    code(() => issue(c, 'G01', [c.validators.A], { deadlineSeconds: 16 * 60 }), 'MALFORMED_REQUEST');
    // An unknown challenge type is malformed. G03/G04 exist since RN-CONFORM-04, but the synthetic-circuit profile declares
    // CR-03/CR-04 not covered, so they are still refused for this integration — now with the more specific code.
    code(() => issue(c, 'G09' as never, [c.validators.A]), 'MALFORMED_REQUEST');
    code(() => issue(c, 'G03', [c.validators.A]), 'CHALLENGE_NOT_IN_PROFILE');
    code(() => issue(c, 'G04', [c.validators.A]), 'CHALLENGE_NOT_IN_PROFILE');
    c.services().registry.quarantineValidator('validator-c', 'test');
    code(() => issue(c, 'G01', [c.validators.C]), 'VALIDATOR_NOT_ELIGIBLE');
    code(() => issue(c, 'G01', [{ ...c.validators.A, validatorId: 'validator-unknown' }]), 'VALIDATOR_NOT_ELIGIBLE');
    const coordinator = c.services().coordinator;
    code(() => coordinator.issue({ idempotencyKey: 'op-1', organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, challengeType: 'G01', operation: 'document.delete', fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: ['validator-a'], deadlineSeconds: 60, authorizationId: testingAuthorizationFor(c), purpose: 'CONFORMANCE' }), 'OPERATION_NOT_COVERED');
    code(() => coordinator.issue({ idempotencyKey: 'op-2', organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, challengeType: 'G08', operation: 'document.open', fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: ['validator-a'], deadlineSeconds: 60, authorizationId: testingAuthorizationFor(c), purpose: 'CONFORMANCE' }), 'OPERATION_NOT_COVERED');
    assert.ok(coordinator.issue({ idempotencyKey: 'op-3', organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, challengeType: 'G08', operation: DEPLOYMENT_ATTESTATION_OPERATION, fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: ['validator-a'], deadlineSeconds: 60, authorizationId: testingAuthorizationFor(c), purpose: 'CONFORMANCE' }));
    c.cleanup();
  });

  it('uses the operating-system CSPRNG by default: nonces never repeat', () => {
    const c = buildCircuit();
    const coordinator = createChallengeCoordinator({ store: c.store, profiles: c.profiles, clock: c.clock, random: secureRandomSource, coordinatorKey: c.coordinatorKey });
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      nonces.add(coordinator.issue({ idempotencyKey: `csprng-${i}`, organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, challengeType: 'G06', operation: 'document.open', fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: ['validator-a'], deadlineSeconds: 60, authorizationId: testingAuthorizationFor(c), purpose: 'CONFORMANCE' }).challenge.nonce);
    }
    assert.equal(nonces.size, 20);
    c.cleanup();
  });
});

describe('RN-CONFORM-02 evidence acceptance (WP-06, WP-07)', () => {
  it('accepts a correctly signed, bound observation and classifies it itself', () => {
    const c = buildCircuit();
    const challenge = issue(c, 'G01', [c.validators.A]);
    const result = submit(c, observe(c, c.validators.A, challenge));
    assert.equal(result.accepted, true);
    assert.ok(result.accepted && result.observation.outcomeClass === 'conformant' && result.observation.operatorId === 'op-synthetic-a');

    // The validator claims "conformant" while reporting that the operation was allowed: the engine records a violation.
    c.platform.bypass = 'unauthorized-operation';
    const second = issue(c, 'G01', [c.validators.B]);
    const lying = submit(c, observe(c, c.validators.B, second, { mutate: (o) => (o['outcomeClass'] = 'conformant') }));
    assert.ok(lying.accepted);
    assert.equal(lying.accepted && lying.observation.outcomeClass, 'violation');
    assert.equal(lying.accepted && lying.observation.validatorClaimMatches, false);
    c.cleanup();
  });

  it('implements every rejection category of VALIDATOR_PROTOCOL.md §3, each tested', () => {
    const c = buildCircuit();
    const A = c.validators.A;
    const ch = () => issue(c, 'G01', [A]);
    const seen = new Set<EvidenceRejection>();
    const expect = (raw: string, reason: EvidenceRejection) => {
      rejected(c, raw, reason);
      seen.add(reason);
    };

    // 1 — structure.
    expect('x'.repeat(MAX_SUBMISSION_BYTES + 1), 'SUBMISSION_TOO_LARGE');
    expect('{not json', 'MALFORMED_JSON');
    expect(JSON.stringify({ observation: { a: 0.5 }, validatorSignature: {} }), 'MALFORMED_JSON');
    expect(observe(c, A, ch(), { mutate: (o) => delete o['evidenceDigest'] }), 'MISSING_FIELD');
    // Untrusted public-key substitution: a key carried in the submission is an unknown field, never a trust root.
    expect(observe(c, A, ch(), { mutate: (o) => (o['publicKeyPem'] = publicKeyPemOf(testKey('attacker'))) }), 'UNKNOWN_FIELD');
    expect(observe(c, A, ch(), { mutate: (o) => (o['observedOutcome'] = 'maybe') }), 'MALFORMED_FIELD');
    expect(observe(c, A, ch(), { mutate: (o) => (o['observedAt'] = '2026-11-02 09:00') }), 'MALFORMED_FIELD');

    // 2 — validator.
    expect(observe(c, A, ch(), { mutate: (o) => (o['validatorId'] = 'validator-nobody') }), 'UNKNOWN_VALIDATOR');

    // 3 — key validity (claimed key id is not the enrolled one).
    expect(observe(c, A, ch(), { mutate: (o) => (o['validatorKeyId'] = signConformancePayload('observation', {}, c.validators.B.key).keyId) }), 'KEY_NOT_VALID');

    // 4 — signature: wrong key, wrong domain, modified after signing.
    expect(observe(c, A, ch(), { signWith: testKey('attacker') }), 'SIGNATURE_MISMATCH');
    expect(resign(observe(c, A, ch()), () => {}, (o) => signConformancePayload('challenge', o, A.key)), 'SIGNATURE_MISMATCH');
    expect(observe(c, A, ch(), { mutateAfterSigning: (o) => (o['observedOutcome'] = 'allowed') }), 'SIGNATURE_MISMATCH');

    // 5 — challenge.
    expect(observe(c, A, ch(), { mutate: (o) => (o['challengeId'] = 'chl_unknown') }), 'CHALLENGE_UNKNOWN');
    expect(observe(c, A, ch(), { mutate: (o) => (o['challengeNonce'] = Buffer.alloc(32, 7).toString('base64url')) }), 'CHALLENGE_BINDING_MISMATCH');
    expect(observe(c, A, issue(c, 'G01', [c.validators.B])), 'NOT_ASSIGNED');

    // 6 — subject binding: platform, integration digest, version, control, operation, expected outcome.
    for (const [field, value] of [
      ['platformId', 'platform-synthetic-beta'],
      ['integrationDigest', `sha256:${'8'.repeat(64)}`],
      ['integrationVersion', 2],
      ['controlId', 'CR-02'],
      ['operation', 'document.export'],
      ['expectedOutcome', 'fail_closed'],
      ['organizationId', 'org-synthetic-beta'],
    ] as const) {
      expect(observe(c, A, ch(), { mutate: (o) => (o[field] = value) }), 'SUBJECT_BINDING_MISMATCH');
    }

    // 7 — profile.
    expect(observe(c, A, ch(), { mutate: (o) => (o['profileVersion'] = '0.0.9') }), 'PROFILE_DOWNGRADE');
    expect(observe(c, A, ch(), { mutate: (o) => (o['profileVersion'] = '0.2.0') }), 'UNSUPPORTED_PROFILE');
    expect(observe(c, A, ch(), { mutate: (o) => (o['profileId'] = 'rn.conformance.integration') }), 'UNSUPPORTED_PROFILE');

    // 8 — time.
    expect(observe(c, A, ch(), { mutate: (o) => (o['observedAt'] = new Date(c.clock.ms() + 60_000).toISOString()) }), 'FUTURE_DATED');
    const short = issue(c, 'G01', [A], { deadlineSeconds: 30 });
    const late = observe(c, A, short);
    c.clock.advance(60);
    expect(late, 'CHALLENGE_EXPIRED');

    // 9 — replay and per-validator conflict.
    const forQuarantine = ch();
    const once = ch();
    const original = observe(c, A, once);
    assert.equal(submit(c, original).accepted, true);
    expect(original, 'REPLAYED');
    c.platform.bypass = 'unauthorized-operation';
    expect(observe(c, A, once), 'VALIDATOR_CONFLICT');
    c.platform.bypass = 'none';
    // The contradiction is retained as a conflict and quarantines the validator; its original observation is not overwritten.
    const conflict = c.store.listRejections().find((r) => r.reason === 'VALIDATOR_CONFLICT');
    assert.ok(conflict?.conflictsWithEventId);
    assert.equal(c.store.getObservation(conflict.conflictsWithEventId)?.outcomeClass, 'conformant');
    assert.ok(c.store.getValidator('validator-a')?.quarantinedAtMs !== null);
    expect(observe(c, A, forQuarantine), 'VALIDATOR_QUARANTINED');

    // 3 — revoked key (a fresh validator, so quarantine does not mask it).
    const B = c.validators.B;
    const bChallenge = issue(c, 'G01', [B]);
    const bRaw = observe(c, B, bChallenge);
    c.services().registry.revokeValidatorKey('validator-b', 'key compromised (test)');
    expect(bRaw, 'VALIDATOR_REVOKED');

    // 10 — evidence package not in custody.
    const C = c.validators.C;
    expect(observe(c, C, issue(c, 'G01', [C]), { deposit: false }), 'EVIDENCE_MISSING');

    // 3b — RN-CONFORM-05: an operator quarantined after the challenge was issued contributes no new observation.
    const cChallenge = issue(c, 'G01', [C]);
    const cRaw = observe(c, C, cChallenge);
    c.services().registry.quarantineOperator('op-synthetic-c', 'operator quarantined (test)');
    expect(cRaw, 'OPERATOR_NOT_ELIGIBLE');

    // 5b — RN-CONFORM-07: the challenge's committed testing authorization (a fresh circuit; validators above are spent).
    const d = buildCircuit();
    const DA = d.validators.A;
    const expectD = (raw: string, reason: EvidenceRejection) => {
      rejected(d, raw, reason);
      seen.add(reason);
    };
    // Revoked after issuance, before submission: the observation is refused.
    const beforeRevocation = observe(d, DA, issue(d, 'G01', [DA]));
    d.services().registry.revokeTestingAuthorization(testingAuthorizationFor(d), 'platform withdrew consent (test)');
    expectD(beforeRevocation, 'AUTHORIZATION_REVOKED');
    // Expired between issuance and a delayed submission (a short authorization of its own).
    const now = d.clock.ms();
    const short = d.services().registry.prepareTestingAuthorization({
      authorizationId: 'auth-short-window', supersedes: null, organizationId: ORG_A, integrationDigest: d.integration.integrationDigest, purpose: 'CONFORMANCE',
      fixtureRefs: ['fixture-synthetic-pep-v1'], operations: ['document.open'], challengeTypes: ['G01'], notBefore: d.clock.now(), notAfter: new Date(now + 120_000).toISOString(),
      maxChallengesPerHour: 10, maxConcurrentChallenges: 10, maxTotalChallenges: null,
    });
    d.services().registry.authorizeTesting(short.record, approvalsFor(d, short.prepared));
    const shortChallenge = d.services().coordinator.issue({ idempotencyKey: 'short-1', organizationId: ORG_A, integrationDigest: d.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: [DA.validatorId], deadlineSeconds: 60, authorizationId: 'auth-short-window', purpose: 'CONFORMANCE' });
    const lateRaw = observe(d, DA, shortChallenge);
    d.clock.advance(121);
    expectD(lateRaw, 'AUTHORIZATION_EXPIRED');
    // A coordinator-signed challenge planted by a raw database writer, with no authorization association at all.
    const template = issue(d, 'G01', [DA]).challenge;
    const planted = { ...template, challengeId: 'chl_planted_without_authorization', idempotencyKey: 'planted-1', nonce: 'p'.repeat(43) };
    const raw = new Database(d.path);
    try {
      const trigger = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'cc_challenges_authorized'").get() as { sql: string }).sql;
      raw.exec('DROP TRIGGER cc_challenges_authorized');
      raw.prepare('INSERT INTO cc_challenges (challenge_id, idempotency_key, nonce, organization_id, integration_digest, profile_id, profile_version, control_id, operation, issued_at_ms, deadline_ms, challenge_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        planted.challengeId, planted.idempotencyKey, planted.nonce, planted.organizationId, planted.integrationDigest, planted.profileId, planted.profileVersion, planted.controlId, planted.operation,
        Date.parse(planted.issuedAt), Date.parse(planted.deadline), canonicalizeConformance(planted), canonicalizeConformance(signConformancePayload('challenge', planted, d.coordinatorKey)),
      );
      raw.exec(trigger);
    } finally {
      raw.close();
    }
    expectD(observe(d, DA, d.store.getChallenge(planted.challengeId)!), 'AUTHORIZATION_INVALID');
    d.cleanup();

    for (const reason of EVIDENCE_REJECTIONS) assert.ok(seen.has(reason), `rejection ${reason} has a test`);

    // Rejections are retained with safe metadata only.
    for (const r of c.store.listRejections()) {
      assert.match(r.submissionDigest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(!Object.keys(r).some((k) => /payload|signature|content|json/i.test(k)));
    }
    c.cleanup();
  });

  it('accepts no free text or content in evidence packages', () => {
    const c = buildCircuit();
    const { evidence } = c.services();
    const base = { schema: 'rn.conformance.evidence-package/1' as const, challengeId: 'chl_x', validatorId: 'validator-a', requestDigest: `sha256:${'1'.repeat(64)}`, responseDigest: `sha256:${'2'.repeat(64)}`, statusCode: 403, latencyMs: 5, synthetic: true as const };
    assert.match(evidence.depositEvidencePackage(ORG_A, base), /^sha256:/);
    assert.throws(() => evidence.depositEvidencePackage(ORG_A, { ...base, responseBody: 'protected document content' } as never));
    assert.throws(() => evidence.depositEvidencePackage(ORG_A, { ...base, synthetic: false } as never));
    c.cleanup();
  });
});

function approvalsFor(c: Circuit, prepared: { readonly action: 'testing.authorize'; readonly subjectRef: string; readonly actionBindingDigest: string }) {
  const at = c.clock.now();
  return [decide(c.humans.alice, 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at), decide(c.humans.bob, 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at)];
}
