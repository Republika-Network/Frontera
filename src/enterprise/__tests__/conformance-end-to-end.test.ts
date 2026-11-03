import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { conformanceDigest } from '../conformance/canonical.js';
import type { IntegrationVersionRecord, TransitionRecord } from '../conformance/contracts.js';
import { RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileDigest } from '../conformance/profile.js';
import { ConformanceRegistryError } from '../conformance/registry.js';
import { createHighWaterMark, verifyCredentialHistory, verifyCurrentConformance } from '../conformance/verifier.js';
import { BASELINE, ORG_A, approvals, baselineChallengeCount, buildCircuit, cleanupAll, expectation, integrationInput, issue, observe, runBaseline, submit, verdict } from './conformance-support.js';

/**
 * RN-CONFORM-02 §6 — the required end-to-end scenario, Stages A–N, in one
 * reproducible run.
 *
 * SYNTHETIC FEDERATION: validators A and B are two synthetic validator
 * identities with distinct keys under two synthetic operator labels. This
 * exercises the two-operator algorithm; it does not establish that two real,
 * independent operators exist, and nothing here is a real credential.
 */

after(cleanupAll);

describe('RN-CONFORM-02 synthetic continuous conformance circuit — end to end', () => {
  it('CANDIDATE → ACTIVE → SUSPENDED → ACTIVE on a corroborated critical bypass, with remediation and two-person reinstatement', (t) => {
    const c = buildCircuit();
    const { registry, lifecycle } = c.services();
    const hwm = createHighWaterMark();
    const check = (credentialId: string, operation?: string) =>
      verifyCurrentConformance({ store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, humans: c.humansDirectory, highWaterMark: hwm }, expectation(c, credentialId, operation), c.clock.now());

    // Stage A — registration: deterministic integration digest.
    const stored = c.store.getIntegrationByDigest(ORG_A, c.integration.integrationDigest);
    assert.ok(stored);
    assert.equal(conformanceDigest(stored.record as IntegrationVersionRecord), c.integration.integrationDigest);
    assert.equal(stored.record.synthetic, true);

    // Stage B — profile binding: the exact synthetic profile and its pinned digest; unknown or changed profiles fail.
    assert.equal(stored.record.profile.digest, profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1));
    assert.throws(() => registry.registerProfile({ ...RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, freshnessGraceSeconds: 0 }), (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'PROFILE_DIGEST_MISMATCH');
    assert.throws(() => registry.registerProfile({ ...RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileId: 'rn.conformance.unknown' }), (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'UNKNOWN_PROFILE');

    // Stage C — validators A and B enrolled with separate keys, separate synthetic operators, two human approvals each.
    const A = c.store.getValidator('validator-a')!;
    const B = c.store.getValidator('validator-b')!;
    assert.notEqual(A.record.keyId, B.record.keyId);
    assert.deepEqual([A.record.operatorId, B.record.operatorId], ['op-synthetic-a', 'op-synthetic-b']);
    for (const v of [A, B]) assert.deepEqual(v.decisions.map((d) => d.role).sort(), ['approve', 'attest']);

    // Stage D/E — baseline challenges; correctly signed observations accepted.
    const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const results = runBaseline(c, [c.validators.A, c.validators.B]);
    // Every enforcement challenge for each covered operation (document.export, document.open), G08 once (finding 4).
    assert.equal(results.length, baselineChallengeCount() * 2);
    assert.equal(baselineChallengeCount(), BASELINE.length * 2 - 1);
    assert.ok(results.every((r) => r.accepted));
    // …and invalid, replayed or mismatched evidence rejected.
    const extra = issue(c, 'G06', [c.validators.A]);
    const honest = observe(c, c.validators.A, extra);
    assert.deepEqual(submit(c, observe(c, c.validators.A, extra, { mutateAfterSigning: (o) => (o['observedOutcome'] = 'allowed') })), { accepted: false, reason: 'SIGNATURE_MISMATCH' });
    assert.deepEqual(submit(c, observe(c, c.validators.A, extra, { mutate: (o) => (o['integrationDigest'] = `sha256:${'0'.repeat(64)}`) })), { accepted: false, reason: 'SUBJECT_BINDING_MISMATCH' });
    assert.equal(submit(c, honest).accepted, true);
    assert.deepEqual(submit(c, honest), { accepted: false, reason: 'REPLAYED' });

    // Stage F — initial activation: every critical requirement of the synthetic profile actually verified; two humans.
    c.clock.advance(1);
    const issuance = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
    const results0 = issuance.evaluation!.record.requirementResults;
    assert.deepEqual(results0.filter((r) => r.severity === 'critical').map((r) => [r.requirementId, r.category]), [
      ['CR-01', 'VERIFIED_SUCCESS'], ['CR-02', 'VERIFIED_SUCCESS'], ['CR-05', 'VERIFIED_SUCCESS'], ['CR-06', 'VERIFIED_SUCCESS'],
      ['CR-07', 'VERIFIED_SUCCESS'], ['CR-08', 'VERIFIED_SUCCESS'], ['CR-09', 'VERIFIED_SUCCESS'], ['CR-12', 'VERIFIED_SUCCESS'],
    ]);
    assert.ok(!results0.some((r) => ['CR-03', 'CR-04', 'CR-10', 'CR-11'].includes(r.requirementId)), 'uncovered requirements are never reported as passed');
    const active = lifecycle.commit(issuance, approvals(c, issuance));
    assert.deepEqual([active.state, active.stateVersion], ['ACTIVE', 2]);

    // Stage G — the verifier returns conformant for the exact subject, profile and scope; anything else fails closed.
    const g = check(credential.credentialId);
    assert.deepEqual([g.conformant, g.reason, g.state, g.stateVersion, g.designation], [true, 'CONFORMANT', 'ACTIVE', 2, 'SYNTHETIC-NON-PRODUCTION']);
    assert.equal(check(credential.credentialId, 'document.delete').reason, 'OPERATION_NOT_IN_SCOPE');
    assert.equal(check(credential.credentialId, 'document.share').reason, 'OPERATION_EXCLUDED');
    const base = { store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem };
    assert.equal(verifyCurrentConformance(base, { ...expectation(c, credential.credentialId), integrationDigest: `sha256:${'0'.repeat(64)}` }, c.clock.now()).reason, 'SUBJECT_MISMATCH');
    assert.equal(verifyCurrentConformance(base, { ...expectation(c, credential.credentialId), profileVersion: '0.2.0' }, c.clock.now()).reason, 'PROFILE_MISMATCH');
    assert.equal(verifyCurrentConformance(base, { ...expectation(c, credential.credentialId), credentialId: 'crd_missing' }, c.clock.now()).reason, 'CREDENTIAL_NOT_FOUND');

    // Stage H — inject the bypass, in the synthetic fixture only.
    c.clock.advance(2 * 3600);
    c.platform.bypass = 'unauthorized-operation';

    // Stage I — validator A observes the critical failure: an unconfirmed violation, not a corroboration.
    const g01 = issue(c, 'G01', [c.validators.A, c.validators.B]);
    assert.equal(submit(c, observe(c, c.validators.A, g01)).accepted, true);
    const first = lifecycle.evaluate(ORG_A, credential.credentialId);
    assert.equal(first.protectiveTransition, null);
    assert.equal(first.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, 'UNCONFIRMED_VIOLATION');
    assert.deepEqual(first.evaluation.proposal, { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' });
    assert.equal(c.store.getHead(ORG_A, credential.credentialId)?.state, 'ACTIVE');
    // Validator B, of a second synthetic operator, independently observes it within 30 minutes.
    c.clock.advance(5 * 60);
    assert.equal(submit(c, observe(c, c.validators.B, g01)).accepted, true);

    // Stage J — corroborated: the evaluation, ACTIVE → SUSPENDED and the head commit atomically.
    const confirmed = lifecycle.evaluate(ORG_A, credential.credentialId);
    assert.equal(confirmed.evaluation.criticalFailureConfirmed, true);
    assert.equal(confirmed.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, 'VERIFIED_FAILURE');
    assert.ok(confirmed.protectiveTransition);
    assert.equal(confirmed.protectiveTransition.record.evaluationId, confirmed.evaluation.evaluationId);
    const suspendedHead = c.store.getHead(ORG_A, credential.credentialId)!;
    assert.deepEqual([suspendedHead.state, suspendedHead.stateVersion, suspendedHead.reasonCode], ['SUSPENDED', 3, 'CRITICAL_VIOLATION_CONFIRMED']);
    const j = check(credential.credentialId);
    assert.deepEqual([j.conformant, j.reason, j.state, j.stateVersion], [false, 'NOT_ACTIVE', 'SUSPENDED', 3]);

    // Stage K — history: digests, signatures, chain, state versions.
    const historyK = verifyCredentialHistory(c.store, ORG_A, credential.credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    assert.ok(historyK.valid);
    assert.deepEqual(historyK.transitions.map((r) => r.stateVersion), [1, 2, 3]);

    // Stage L — remediation of the synthetic enforcement.
    c.clock.advance(3600);
    c.platform.bypass = 'none';

    // Stage M — full revalidation of every critical check, and two fresh approvals.
    assert.ok(runBaseline(c, [c.validators.A, c.validators.B]).every((r) => r.accepted));
    c.clock.advance(1);
    const reinstatement = lifecycle.prepare('reinstate', {
      organizationId: ORG_A,
      credentialId: credential.credentialId,
      remediation: { statement: 'Synthetic fixture: authorization check restored on the covered operation.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() },
    });
    const freshApprovals = approvals(c, reinstatement, c.humans.carol, c.humans.bob);

    // Stage N — reinstatement, complete history, approval binding and latest status.
    const reinstated = lifecycle.commit(reinstatement, freshApprovals);
    assert.deepEqual([reinstated.state, reinstated.stateVersion], ['ACTIVE', 4]);
    const history = verifyCredentialHistory(c.store, ORG_A, credential.credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    assert.ok(history.valid);
    const sequence = history.transitions.map((r: TransitionRecord) => `${r.stateVersion}:${r.transitionCode}:${r.from ?? '∅'}→${r.to}:${r.reasonCode}`);
    assert.deepEqual(sequence, [
      '1:T1:∅→CANDIDATE:INTEGRATION_REGISTERED',
      '2:T2:CANDIDATE→ACTIVE:ALL_CRITICAL_VERIFIED',
      '3:T4:ACTIVE→SUSPENDED:CRITICAL_VIOLATION_CONFIRMED',
      '4:T5:SUSPENDED→ACTIVE:REMEDIATED_AND_REVALIDATED',
    ]);
    const t5 = history.transitions[3]!;
    assert.equal(t5.actionBindingDigest, reinstatement.actionBindingDigest);
    assert.deepEqual(t5.humanDecisions.map((d) => [d.principalId, d.role]), [['human-carol', 'attest'], ['human-bob', 'approve']]);
    assert.ok(t5.remediationDigest !== null);
    const issuedBy = history.transitions[1]!.humanDecisions.map((d) => d.decisionId);
    assert.ok(t5.humanDecisions.every((d) => !issuedBy.includes(d.decisionId)), 'reinstatement used new decisions');
    const n = check(credential.credentialId);
    assert.deepEqual([n.conformant, n.reason, n.state, n.stateVersion], [true, 'CONFORMANT', 'ACTIVE', 4]);

    // Persistence across restart, and verifier-side rollback detection.
    c.reopen();
    const afterRestart = { store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem };
    assert.deepEqual(verdict(c, credential.credentialId).reason, 'CONFORMANT');
    assert.equal(hwm.observe(credential.credentialId, 3, suspendedHead.headTransitionDigest), 'ROLLBACK');

    // A different integration version does not inherit this credential or its evidence.
    const v2 = c.services().registry.registerIntegrationVersion(integrationInput(profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1), { integrationVersion: 2, deploymentDigest: `sha256:${'4'.repeat(64)}` }));
    assert.equal(verifyCurrentConformance(afterRestart, { ...expectation(c, credential.credentialId), integrationVersion: 2, integrationDigest: v2.integrationDigest }, c.clock.now()).reason, 'SUBJECT_MISMATCH');

    t.diagnostic(`state sequence: ${sequence.join(' | ')}`);
    t.diagnostic(`credential ${credential.credentialId} (synthetic, ${n.designation}); head ${n.headTransitionDigest}`);
    c.cleanup();
  });
});
