import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { generationIdentity } from '../conformance/federation-contracts.js';
import { FederationError } from '../conformance/federation-registry.js';
import { FederationStoreError } from '../conformance/federation-store.js';
import { publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import { enrollmentDecisions } from './conformance-support.js';
import { cleanupReferenceCircuits } from './conformance-reference-support.js';
import {
  FED_OPERATORS,
  addValidator,
  adoptGeneration,
  beat,
  buildFederation,
  enrollGeneration,
  ephemeralKey,
  fedDecisions,
  fullCapabilities,
  onboardOperator,
  standardFederation,
} from './conformance-federation-support.js';

/**
 * RN-CONFORM-05 — WP-01/02/04/11/12: operator identity, validator enrollment with proof of possession, key generations
 * (rotation, revocation), quarantine and its two-person release, validator and operator revocation.
 */

after(() => cleanupReferenceCircuits());

const refusal = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => (e instanceof FederationError && e.code === code) || (e instanceof FederationStoreError && e.code === code), code);

describe('RN-CONFORM-05 — operator identity registry (WP-01)', () => {
  it('registers an operator once, immutably, labelled synthetic and NOT independence-verified', () => {
    const f = buildFederation({ operators: [] });
    const record = f.registry.registerOperator({ operatorId: 'op-x', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-x' });
    assert.equal(record.designation, 'SYNTHETIC-FEDERATION-NON-PRODUCTION');
    assert.equal(record.independenceVerification, 'NOT_VERIFIED');
    assert.match(record.statement, /not verified as independent of Republika/);
    assert.equal(f.registry.operatorState('op-x'), 'REGISTERED');
    // Duplicate registration, identical or not, is refused: an identity is created once.
    refusal(() => f.registry.registerOperator({ operatorId: 'op-x', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-x' }), 'DUPLICATE_OPERATOR');
    refusal(() => f.registry.registerOperator({ operatorId: 'op-x', operatorClass: 'REPUBLIKA', administrativeOwnerRef: 'owner-ref-other' }), 'DUPLICATE_OPERATOR');
    // The record and its history cannot be rewritten underneath the API.
    assert.throws(() => (f.fed as unknown as { insertOperator: (r: unknown, a: number) => void }).insertOperator({ ...record, administrativeOwnerRef: 'owner-forged' }, 0), FederationStoreError);
    assert.equal(f.fed.getOperator('op-x')?.administrativeOwnerRef, 'owner-ref-x');
  });

  it('refuses unknown fields, personal data shapes and bad classes', () => {
    const f = buildFederation({ operators: [] });
    refusal(() => f.registry.registerOperator({ operatorId: 'op-y', operatorClass: 'REPUBLIKA', administrativeOwnerRef: 'owner y@example.org' }), 'MALFORMED_INPUT');
    refusal(() => f.registry.registerOperator({ operatorId: 'op-y', operatorClass: 'INDEPENDENT' as never, administrativeOwnerRef: 'owner-ref-y' }), 'MALFORMED_INPUT');
    refusal(() => f.registry.registerOperator({ operatorId: 'op-y', operatorClass: 'REPUBLIKA', administrativeOwnerRef: 'owner-ref-y', independent: true } as never), 'MALFORMED_INPUT');
  });

  it('activation needs a two-person approval first; one human, a forged binding or a cross-tenant approver is refused', () => {
    const f = buildFederation({ operators: [] });
    f.registry.registerOperator({ operatorId: 'op-z', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-z' });
    refusal(() => f.registry.activateOperator('op-z'), 'TRANSITION_NOT_ALLOWED');
    const prepared = f.registry.prepareOperatorAction('op-z', 'approve');
    const [attest] = fedDecisions(f, prepared);
    refusal(() => f.registry.approveOperator('op-z', [attest]), 'APPROVAL_REFUSED');
    refusal(() => f.registry.approveOperator('op-z', fedDecisions(f, prepared, f.c.humans.netAlice, f.c.humans.netAlice)), 'APPROVAL_REFUSED');
    refusal(() => f.registry.approveOperator('op-z', fedDecisions(f, { ...prepared, actionBindingDigest: `sha256:${'9'.repeat(64)}` })), 'APPROVAL_REFUSED');
    // Humans of a platform organization cannot approve a network operator (organization binding).
    refusal(() => f.registry.approveOperator('op-z', fedDecisions(f, { ...prepared, organizationId: 'org-synthetic-alpha' }, f.c.humans.alice, f.c.humans.bob)), 'APPROVAL_REFUSED');
    // A decision for another action (validator.enroll) cannot approve an operator.
    refusal(() => f.registry.approveOperator('op-z', fedDecisions(f, { ...prepared, action: 'validator.enroll' })), 'APPROVAL_REFUSED');
    assert.equal(f.c.store.getOperator('op-z'), undefined, 'no conformance-store operator before approval');
    f.registry.approveOperator('op-z', fedDecisions(f, prepared));
    assert.ok(f.c.store.getOperator('op-z'));
    // The same approval cannot be replayed: decisions are single-use and the binding names the state moved from.
    refusal(() => f.registry.approveOperator('op-z', fedDecisions(f, prepared)), 'TRANSITION_NOT_ALLOWED');
    f.registry.activateOperator('op-z');
    assert.equal(f.registry.operatorState('op-z'), 'ACTIVE');
    assert.deepEqual(f.fed.operatorHistory('op-z').map((h) => h.state), ['REGISTERED', 'APPROVED', 'ACTIVE']);
  });

  it('F-12: two concurrent registrations of one immutable identity produce exactly one record', () => {
    const f = buildFederation({ operators: [] });
    const results = [0, 1].map(() => {
      try {
        f.registry.registerOperator({ operatorId: 'op-race', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-race' });
        return 'ok';
      } catch (e) {
        return e instanceof FederationError ? e.code : 'other';
      }
    });
    assert.deepEqual(results.sort(), ['DUPLICATE_OPERATOR', 'ok']);
    assert.equal(f.fed.listOperators().filter((o) => o.operatorId === 'op-race').length, 1);
    // Even below the API, the store refuses a second row for the identity.
    refusal(() => f.fed.insertOperator(f.fed.getOperator('op-race') as never, 0), 'CONFLICT');
  });

  it('revoked operators never return, and their validators are revoked with them', () => {
    const f = standardFederation();
    f.registry.revokeOperator(FED_OPERATORS.C, fedDecisions(f, f.registry.prepareOperatorAction(FED_OPERATORS.C, 'revoke')));
    assert.equal(f.registry.operatorState(FED_OPERATORS.C), 'REVOKED');
    assert.equal(f.registry.validatorState('vc1'), 'REVOKED');
    assert.ok(f.c.store.getValidator(generationIdentity('vc1', 1))?.keyRevokedAtMs !== null);
    refusal(() => f.registry.reinstateOperator(FED_OPERATORS.C, []), 'TRANSITION_NOT_ALLOWED');
    // Database-level: REVOKED is terminal even for a direct write.
    assert.throws(() => f.fed.appendOperatorState(FED_OPERATORS.C, 'ACTIVE', f.c.clock.ms(), 'forged', []), FederationStoreError);
    refusal(() => f.registry.registerOperator({ operatorId: FED_OPERATORS.C, operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-reuse' }), 'DUPLICATE_OPERATOR');
  });
});

describe('RN-CONFORM-05 — validator enrollment and identity binding (WP-02)', () => {
  it('enrolls only through proof of possession and two humans; the generation is pinned to the operator', () => {
    const f = buildFederation();
    f.registry.registerValidator({ validatorId: 'vx', operatorId: FED_OPERATORS.A, capabilities: fullCapabilities() });
    assert.equal(f.registry.validatorState('vx'), 'ENROLLED');
    const key = ephemeralKey();
    const window = { keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' };
    const pop = f.registry.requestKeyPossession({ validatorId: 'vx', kind: 'ENROLL', publicKeyPem: publicKeyPemOf(key), ...window });
    assert.equal(pop.statement.operatorId, FED_OPERATORS.A, 'the operator comes from the registry, never from the request');
    // Signed by a different key: no possession.
    refusal(() => f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, ephemeralKey())), 'POSSESSION_INVALID');
    // Signed in the wrong domain (an observation signature over the same bytes): refused.
    refusal(() => f.registry.proveKeyPossession(pop.requestId, signConformancePayload('observation', pop.statement, key)), 'POSSESSION_INVALID');
    const prepared = f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key));
    refusal(() => f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key)), 'POSSESSION_ALREADY_USED');
    assert.equal(prepared.record.validatorId, 'vx.k1');
    assert.equal(prepared.record.operatorId, FED_OPERATORS.A);
    // An enrollment that differs from what the possession proof covered (e.g. another operator) is refused.
    refusal(() => f.registry.completeEnrollment(pop.requestId, { ...prepared.record, operatorId: FED_OPERATORS.B }, []), 'ENROLLMENT_MISMATCH');
    // One human only: refused (two-person validator.enroll, also enforced by the conformance store trigger).
    const [attest] = enrollmentDecisions(f.c, 'vx.k1', prepared.bindingDigest, f.c.clock.now());
    refusal(() => f.registry.completeEnrollment(pop.requestId, prepared.record, [attest]), 'APPROVAL_REFUSED');
    const generation = f.registry.completeEnrollment(pop.requestId, prepared.record, enrollmentDecisions(f.c, 'vx.k1', prepared.bindingDigest, f.c.clock.now()));
    assert.equal(generation.operatorId, FED_OPERATORS.A);
    assert.equal(f.c.store.getValidator('vx.k1')?.record.operatorId, FED_OPERATORS.A);
    assert.ok(!JSON.stringify(f.fed.listGenerations('vx')).includes('PRIVATE KEY'), 'no private key material in the registry');
    f.registry.activateValidator('vx');
    assert.equal(f.registry.validatorState('vx'), 'ACTIVE');
  });

  it('expired possession nonces, private-key PEMs and reused keys are refused', () => {
    const f = buildFederation();
    f.registry.registerValidator({ validatorId: 'vy', operatorId: FED_OPERATORS.B, capabilities: fullCapabilities() });
    const key = ephemeralKey();
    const window = { keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' };
    const pop = f.registry.requestKeyPossession({ validatorId: 'vy', kind: 'ENROLL', publicKeyPem: publicKeyPemOf(key), ...window });
    f.c.clock.advance(11 * 60);
    refusal(() => f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key)), 'POSSESSION_EXPIRED');
    const pkcs8 = key.export({ type: 'pkcs8', format: 'pem' }).toString();
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'vy', kind: 'ENROLL', publicKeyPem: pkcs8, ...window }), 'KEY_NOT_PUBLIC');
    // A key already enrolled anywhere — under another validator or another operator — is refused.
    const a1 = addValidator(f, 'va1', FED_OPERATORS.A);
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'vy', kind: 'ENROLL', publicKeyPem: publicKeyPemOf(a1.key), ...window }), 'KEY_REUSED');
    // Also a key of the RN-CONFORM-04 circuit's pre-existing conformance-store validators.
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'vy', kind: 'ENROLL', publicKeyPem: f.c.validators.A.publicKeyPem, ...window }), 'KEY_REUSED');
  });

  it('a validator cannot enroll under an unapproved operator, cannot be re-registered, and cannot take a generation-shaped id', () => {
    const f = buildFederation();
    f.registry.registerOperator({ operatorId: 'op-pending', operatorClass: 'CANDIDATE_EXTERNAL', administrativeOwnerRef: 'owner-ref-pending' });
    refusal(() => f.registry.registerValidator({ validatorId: 'vp', operatorId: 'op-pending', capabilities: fullCapabilities() }), 'OPERATOR_NOT_ELIGIBLE');
    refusal(() => f.registry.registerValidator({ validatorId: 'vp', operatorId: 'op-unknown', capabilities: fullCapabilities() }), 'UNKNOWN_OPERATOR');
    addValidator(f, 'va1', FED_OPERATORS.A);
    // Reassignment: the same validator id under another operator is a duplicate, never a rebind.
    refusal(() => f.registry.registerValidator({ validatorId: 'va1', operatorId: FED_OPERATORS.B, capabilities: fullCapabilities() }), 'DUPLICATE_VALIDATOR');
    refusal(() => f.registry.registerValidator({ validatorId: 'vb1.k1', operatorId: FED_OPERATORS.B, capabilities: fullCapabilities() }), 'MALFORMED_INPUT');
    // A pre-existing conformance-store validator id cannot be claimed by the federation either.
    refusal(() => f.registry.registerValidator({ validatorId: 'validator-a', operatorId: FED_OPERATORS.B, capabilities: fullCapabilities() }), 'DUPLICATE_VALIDATOR');
    // G09/G10 are engine-derived conditions, never capabilities.
    refusal(() => f.registry.registerValidator({ validatorId: 'vq', operatorId: FED_OPERATORS.B, capabilities: { ...fullCapabilities(), challengeTypes: ['G01', 'G09' as never] } }), 'MALFORMED_INPUT');
    // The generation table refuses a generation pinned to another operator than its validator.
    assert.throws(
      () => f.fed.insertGeneration({ ...f.fed.listGenerations('va1')[0]!, generation: 2, conformanceValidatorId: 'va1.k2', operatorId: FED_OPERATORS.B, keyId: `sha256:${'7'.repeat(64)}` }),
      FederationStoreError,
    );
  });

  it('historical observations keep their operator after deactivation: attribution comes from the immutable enrollment', () => {
    const f = standardFederation();
    const before = f.c.store.getValidator(generationIdentity('vb1', 1))?.record.operatorId;
    f.registry.revokeValidator('vb1', fedDecisions(f, f.registry.prepareValidatorAction('vb1', 'revoke')));
    assert.equal(f.c.store.getValidator(generationIdentity('vb1', 1))?.record.operatorId, before);
    assert.equal(f.fed.getGenerationByConformanceId('vb1.k1')?.operatorId, FED_OPERATORS.B);
  });
});

describe('RN-CONFORM-05 — key rotation and revocation (WP-04)', () => {
  it('1/2/7: planned rotation creates a new generation under the same operator; the old one retires and stays attributable', () => {
    const f = standardFederation();
    const old = f.validators.get('vb1')!;
    const { generation, key } = enrollGeneration(f, 'vb1', 'ROTATE');
    assert.equal(generation.generation, 2);
    assert.equal(generation.operatorId, FED_OPERATORS.B, 'rotation adds no operator and no vote');
    assert.equal(f.fed.generationState('vb1', 1)?.state, 'RETIRED');
    assert.equal(f.fed.generationState('vb1', 2)?.state, 'ACTIVE');
    // The retired generation's conformance-store identity is untouched: its historical signatures still verify.
    const k1 = f.c.store.getValidator('vb1.k1');
    assert.equal(k1?.keyRevokedAtMs, null);
    assert.equal(k1?.quarantinedAtMs, null);
    assert.equal(k1?.record.keyId, old.generation.keyId);
    const e = f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms());
    assert.ok(e.eligible && e.generation.generation === 2, 'new work is assigned only to the new key');
    adoptGeneration(f, 'vb1', generation, key);
    const kinds = f.fed.listEvents().filter((ev) => ev.subjectId === 'vb1').map((ev) => ev.kind);
    assert.ok(kinds.includes('KEY_ROTATION_STARTED') && kinds.includes('KEY_ROTATION_COMPLETED'));
  });

  it('3/4: an expired or revoked generation is never eligible; revocation is protective and needs no humans', () => {
    const f = standardFederation();
    const shortKey = ephemeralKey();
    f.registry.registerValidator({ validatorId: 'vshort', operatorId: FED_OPERATORS.C, capabilities: fullCapabilities() });
    enrollGeneration(f, 'vshort', 'ENROLL', shortKey, { keyValidFrom: f.c.clock.now(), keyValidUntil: new Date(f.c.clock.ms() + 60_000).toISOString() });
    f.registry.activateValidator('vshort');
    f.c.clock.advance(120);
    const expired = f.registry.eligibility('vshort', f.c.clock.ms(), f.c.clock.ms());
    assert.deepEqual(expired, { eligible: false, reason: 'KEY_NOT_VALID' });
    f.registry.revokeKeyGeneration('vc1.k1', 'KEY_COMPROMISE');
    assert.equal(f.fed.generationState('vc1', 1)?.state, 'REVOKED');
    assert.notEqual(f.c.store.getValidator('vc1.k1')?.keyRevokedAtMs, null);
    assert.equal(f.registry.eligibility('vc1', f.c.clock.ms(), f.c.clock.ms()).eligible, false);
    // A revoked generation never returns, even by a direct write.
    assert.throws(() => f.fed.appendGenerationState('vc1', 1, 'ACTIVE', f.c.clock.ms(), 'forged'), FederationStoreError);
  });

  it('5/6: the same key cannot be enrolled for another validator or another operator; rotation reuses no key', () => {
    const f = standardFederation();
    const a1 = f.validators.get('va1')!;
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'vb1', kind: 'ROTATE', publicKeyPem: publicKeyPemOf(a1.key), keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' }), 'KEY_REUSED');
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'va2', kind: 'ROTATE', publicKeyPem: publicKeyPemOf(a1.key), keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' }), 'KEY_REUSED');
    refusal(() => f.registry.requestKeyPossession({ validatorId: 'va1', kind: 'ROTATE', publicKeyPem: publicKeyPemOf(a1.key), keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' }), 'KEY_REUSED');
  });

  it('10: rotation cannot bypass quarantine; a quarantined validator needs the two-person REINSTATE path', () => {
    const f = standardFederation();
    f.registry.quarantineValidator('vb1', 'VALIDATOR_CONFLICT');
    refusal(() => enrollGeneration(f, 'vb1', 'ROTATE'), 'VALIDATOR_NOT_ELIGIBLE');
    refusal(() => enrollGeneration(f, 'vb1', 'ENROLL'), 'VALIDATOR_NOT_ELIGIBLE');
    // Without the reinstate decisions the REINSTATE path is refused at completion.
    const key = ephemeralKey();
    const pop = f.registry.requestKeyPossession({ validatorId: 'vb1', kind: 'REINSTATE', publicKeyPem: publicKeyPemOf(key), keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
    const prepared = f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key));
    refusal(() => f.registry.completeEnrollment(pop.requestId, prepared.record, enrollmentDecisions(f.c, prepared.record.validatorId, prepared.bindingDigest, f.c.clock.now())), 'APPROVAL_REFUSED');
    const [one] = fedDecisions(f, f.registry.prepareValidatorAction('vb1', 'reinstate'));
    refusal(() => f.registry.completeEnrollment(pop.requestId, prepared.record, enrollmentDecisions(f.c, prepared.record.validatorId, prepared.bindingDigest, f.c.clock.now()), [one]), 'APPROVAL_REFUSED');
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
  });

  it('12: a rotation interrupted between the two stores is completed on retry, with no extra identity and no second approval', () => {
    let crash = true;
    const f = buildFederation({
      faults: {
        afterConformanceEnrollment: () => {
          if (crash) {
            crash = false;
            throw new Error('synthetic crash between stores');
          }
        },
      },
    });
    crash = false;
    addValidator(f, 'vb1', FED_OPERATORS.B);
    const key = ephemeralKey();
    const pop = f.registry.requestKeyPossession({ validatorId: 'vb1', kind: 'ROTATE', publicKeyPem: publicKeyPemOf(key), keyValidFrom: f.c.clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
    const prepared = f.registry.proveKeyPossession(pop.requestId, signConformancePayload('keyPossession', pop.statement, key));
    const decisions = enrollmentDecisions(f.c, prepared.record.validatorId, prepared.bindingDigest, f.c.clock.now());
    crash = true;
    assert.throws(() => f.registry.completeEnrollment(pop.requestId, prepared.record, decisions), /synthetic crash/);
    // Partial state: the conformance store has k2, the federation does not — and k2 is NOT eligible (fail closed).
    assert.ok(f.c.store.getValidator('vb1.k2'));
    assert.equal(f.fed.listGenerations('vb1').length, 1);
    const during = f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms());
    assert.ok(during.eligible && during.generation.generation === 1, 'the old generation keeps serving until the rotation completes');
    // Retry with the SAME (already consumed) decisions: the conformance enrollment is idempotent, the federation row lands.
    const generation = f.registry.completeEnrollment(pop.requestId, prepared.record, decisions);
    assert.equal(generation.generation, 2);
    assert.equal(f.fed.generationState('vb1', 1)?.state, 'RETIRED');
    assert.equal(f.fed.listGenerations('vb1').length, 2);
  });
});

describe('RN-CONFORM-05 — quarantine, release and revocation (WP-11/12)', () => {
  it('quarantine is protective and immediate: every generation in the conformance store, then the federation', () => {
    const f = standardFederation();
    f.registry.quarantineValidator('va1', 'CONTRADICTORY_OBSERVATIONS');
    assert.equal(f.registry.validatorState('va1'), 'QUARANTINED');
    assert.notEqual(f.c.store.getValidator('va1.k1')?.quarantinedAtMs, null);
    assert.equal(f.health.health('va1'), 'QUARANTINED');
    assert.deepEqual(f.registry.eligibility('va1', f.c.clock.ms(), f.c.clock.ms()), { eligible: false, reason: 'VALIDATOR_NOT_ACTIVE' });
    // A heartbeat never lifts it.
    assert.deepEqual(beat(f, ['va1']), [{ accepted: false, reason: 'VALIDATOR_QUARANTINED' }]);
    assert.equal(f.registry.validatorState('va1'), 'QUARANTINED');
    // Activation is not a release path.
    refusal(() => f.registry.activateValidator('va1'), 'TRANSITION_NOT_ALLOWED');
  });

  it('evidence acceptance\'s automatic VALIDATOR_CONFLICT quarantine is mirrored into the federation (sync never loosens)', () => {
    const f = standardFederation();
    f.c.services().registry.quarantineValidator('vb1.k1', 'VALIDATOR_CONFLICT');
    assert.equal(f.registry.validatorState('vb1'), 'ACTIVE');
    assert.equal(f.registry.eligibility('vb1', f.c.clock.ms(), f.c.clock.ms()).eligible, false, 'eligibility re-reads the conformance store regardless');
    assert.deepEqual(f.registry.syncFromConformance(), ['vb1.k1']);
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
    assert.ok(f.fed.listEvents().some((e) => e.kind === 'REGISTRY_DIVERGENCE' && e.subjectId === 'vb1'));
    assert.deepEqual(f.registry.syncFromConformance(), []);
  });

  it('revocation needs two humans, is terminal, prevents identity reuse and is distinct from quarantine and key revocation', () => {
    const f = standardFederation();
    refusal(() => f.registry.revokeValidator('vb1', []), 'APPROVAL_REFUSED');
    f.registry.revokeValidator('vb1', fedDecisions(f, f.registry.prepareValidatorAction('vb1', 'revoke')));
    assert.equal(f.registry.validatorState('vb1'), 'REVOKED');
    assert.equal(f.health.health('vb1'), 'REVOKED');
    refusal(() => f.registry.quarantineValidator('vb1', 'AFTER_REVOCATION'), 'TRANSITION_NOT_ALLOWED');
    refusal(() => enrollGeneration(f, 'vb1', 'REINSTATE'), 'VALIDATOR_NOT_ELIGIBLE');
    refusal(() => f.registry.registerValidator({ validatorId: 'vb1', operatorId: FED_OPERATORS.B, capabilities: fullCapabilities() }), 'DUPLICATE_VALIDATOR');
    assert.throws(() => f.fed.appendValidatorState('vb1', 'ACTIVE', f.c.clock.ms(), 'forged', []), FederationStoreError);
    // Revocation while quarantined is allowed (two humans), and still terminal.
    f.registry.quarantineValidator('vc1', 'PROTOCOL_VIOLATIONS');
    f.registry.revokeValidator('vc1', fedDecisions(f, f.registry.prepareValidatorAction('vc1', 'revoke')));
    assert.equal(f.registry.validatorState('vc1'), 'REVOKED');
    // A key-only revocation leaves the validator itself ACTIVE (and unassignable until it rotates).
    f.registry.revokeKeyGeneration('va2.k1', 'KEY_COMPROMISE');
    assert.equal(f.registry.validatorState('va2'), 'ACTIVE');
    assert.equal(f.registry.eligibility('va2', f.c.clock.ms(), f.c.clock.ms()).eligible, false);
  });

  it('a quarantined operator\'s validators are all quarantined; reinstating the operator does not release them', () => {
    const f = standardFederation();
    f.registry.quarantineOperator(FED_OPERATORS.A, 'OPERATOR_COMPROMISE');
    for (const id of ['va1', 'va2', 'va3']) assert.equal(f.registry.validatorState(id), 'QUARANTINED', id);
    f.registry.reinstateOperator(FED_OPERATORS.A, fedDecisions(f, f.registry.prepareOperatorAction(FED_OPERATORS.A, 'reinstate')));
    assert.equal(f.registry.operatorState(FED_OPERATORS.A), 'ACTIVE');
    for (const id of ['va1', 'va2', 'va3']) assert.equal(f.registry.validatorState(id), 'QUARANTINED', `${id} still needs its own reinstatement`);
  });

  it('onboarding a fourth operator works the same way and adds exactly one operator identity', () => {
    const f = standardFederation();
    onboardOperator(f, FED_OPERATORS.D);
    addValidator(f, 'vd1', FED_OPERATORS.D);
    assert.equal(new Set(f.fed.listValidators().map((v) => v.operatorId)).size, 4);
  });
});
