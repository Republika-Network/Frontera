import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { conformanceDigest } from '../conformance/canonical.js';
import { DEPLOYMENT_ATTESTATION_OPERATION, toMs, toTimestamp, type AcceptedObservation, type CredentialState, type OutcomeClass } from '../conformance/contracts.js';
import { classifyOutcome, evaluateConformance, type EngineInput } from '../conformance/engine.js';
import { CredentialLifecycleError } from '../conformance/lifecycle.js';
import { RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileDigest } from '../conformance/profile.js';
import {
  BASELINE,
  ORG_A,
  SDK,
  activeCredential,
  approvals,
  buildCircuit,
  cleanupAll,
  decide,
  integrationInput,
  issue,
  observe,
  runBaseline,
  submit,
  verdict,
  type Circuit,
} from './conformance-support.js';

/**
 * RN-CONFORM-02 / WP-09, WP-10, CC-D-03, CC-D-04 — the pure evaluator's
 * corroboration, dispute, investigation and freshness rules, then the
 * credential state machine and its human-approval gates on real storage.
 */

after(cleanupAll);

const T = toMs('2026-11-02T09:00:00.000Z');
const at = (minutes: number) => toTimestamp(T + minutes * 60_000);
const DIGEST = `sha256:${'d'.repeat(64)}`;
let n = 0;
const o = (op: string, cls: OutcomeClass, minutes: number, control = 'CR-01', validatorId = `val-${op}`, operation = control === 'CR-08' ? DEPLOYMENT_ATTESTATION_OPERATION : 'document.open'): AcceptedObservation => {
  n += 1;
  return {
    eventId: `evt-${n}`,
    challengeId: `chl-${n}`,
    validatorId,
    operatorId: op,
    controlId: control,
    operation,
    integrationDigest: DIGEST,
    profileId: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId,
    profileVersion: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileVersion,
    outcomeClass: cls,
    validatorClaimMatches: true,
    observedAt: at(minutes),
    acceptedAt: at(minutes),
    observationDigest: conformanceDigest({ n }),
  };
};
/** Conformant observations from two operators for every covered control except `skip`. */
const otherControlsPass = (minutes: number, skip = 'CR-01') =>
  ['CR-01', 'CR-02', 'CR-05', 'CR-06', 'CR-07', 'CR-08'].filter((cr) => cr !== skip).flatMap((cr) => [o('op-a', 'conformant', minutes, cr), o('op-b', 'conformant', minutes, cr)]);

const engine = (observations: AcceptedObservation[], minutes: number, state: CredentialState = 'ACTIVE', extra: Partial<EngineInput> = {}) =>
  evaluateConformance({
    profile: RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1,
    integration: { integrationDigest: DIGEST, sdk: SDK },
    coveredOperations: ['document.open'],
    observations,
    excludedValidatorIds: [],
    evaluatedAt: at(minutes),
    credentialState: state,
    revalidationSince: null,
    ...extra,
  });
const cr01 = (out: ReturnType<typeof engine>) => out.requirementResults.find((r) => r.requirementId === 'CR-01')!;

describe('RN-CONFORM-02 engine: classification', () => {
  it('classifies outcomes itself, from the challenge expectation', () => {
    assert.equal(classifyOutcome('denied', 'denied', null, DIGEST), 'conformant');
    assert.equal(classifyOutcome('denied', 'allowed', null, DIGEST), 'violation');
    assert.equal(classifyOutcome('fail_closed', 'allowed', null, DIGEST), 'violation');
    assert.equal(classifyOutcome('revoked_within_interval', 'denied', null, DIGEST), 'conformant');
    for (const inconclusive of ['error', 'timeout', 'unreachable'] as const) assert.equal(classifyOutcome('denied', inconclusive, null, DIGEST), 'inconclusive');
    assert.equal(classifyOutcome('denied', 'digest_reported', DIGEST, DIGEST), 'inconclusive');
    assert.equal(classifyOutcome('deployment_digest_match', 'digest_reported', DIGEST, DIGEST), 'conformant');
    assert.equal(classifyOutcome('deployment_digest_match', 'digest_reported', `sha256:${'e'.repeat(64)}`, DIGEST), 'violation');
    assert.equal(classifyOutcome('deployment_digest_match', 'denied', null, DIGEST), 'inconclusive');
  });

  it('is deterministic', () => {
    const obs = [...otherControlsPass(0, 'none'), o('op-a', 'violation', 1)];
    assert.deepEqual(engine(obs, 5), engine([...obs].reverse(), 5));
  });
});

describe('RN-CONFORM-02 engine: corroboration (CC-D-03)', () => {
  it('two distinct operators within 30 minutes verify success', () => {
    const out = engine(otherControlsPass(0, 'none'), 5);
    assert.ok(out.requirementResults.filter((r) => r.severity === 'critical').every((r) => r.category === 'VERIFIED_SUCCESS'));
    assert.deepEqual(out.proposal, { kind: 'NONE', reasonCode: 'CONFORMANT' });
  });

  it('two validators of one operator, or repeated submissions, never meet quorum', () => {
    const sameOperator = [o('op-a', 'conformant', 0, 'CR-01', 'val-a1'), o('op-a', 'conformant', 1, 'CR-01', 'val-a2'), o('op-a', 'conformant', 2, 'CR-01', 'val-a1')];
    assert.equal(cr01(engine([...otherControlsPass(0), ...sameOperator], 5)).category, 'INSUFFICIENT_EVIDENCE');
    const sameOperatorViolations = [o('op-a', 'violation', 0, 'CR-01', 'val-a1'), o('op-a', 'violation', 1, 'CR-01', 'val-a2')];
    const out = engine([...otherControlsPass(0), ...sameOperatorViolations], 5);
    assert.equal(cr01(out).category, 'UNCONFIRMED_VIOLATION');
    assert.equal(out.criticalFailureConfirmed, false);
  });

  it('two distinct operators confirming a violation within 30 minutes suspend under SR-1', () => {
    const out = engine([...otherControlsPass(0), o('op-a', 'violation', 10), o('op-b', 'violation', 39)], 40);
    assert.equal(cr01(out).category, 'VERIFIED_FAILURE');
    assert.equal(out.criticalFailureConfirmed, true);
    assert.deepEqual(out.proposal, { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' });
  });

  it('violations outside the 30-minute window do not corroborate each other', () => {
    const out = engine([...otherControlsPass(0), o('op-a', 'violation', 10), o('op-b', 'violation', 45)], 46);
    assert.notEqual(cr01(out).category, 'VERIFIED_FAILURE');
    assert.equal(out.criticalFailureConfirmed, false);
    // The first report's investigation expired at minute 40 → fail closed, never a confirmed violation.
    assert.deepEqual(out.proposal, { kind: 'SUSPEND', ruleId: 'SR-4', reasonCode: 'CORROBORATION_UNAVAILABLE' });
  });

  it('a single report opens an investigation and neither suspends nor revokes; its timeout suspends (SR-3/SR-4)', () => {
    const obs = [...otherControlsPass(0, 'none'), o('op-a', 'violation', 5)];
    const open = engine(obs, 20);
    assert.equal(cr01(open).category, 'CONFLICTING', 'earlier conformant observations by other operators make it a dispute');
    assert.deepEqual(open.proposal, { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' });
    assert.equal(cr01(open).investigationDeadline, at(35));
    const lone = engine([...otherControlsPass(0), o('op-c', 'violation', 5)], 20);
    assert.equal(cr01(lone).category, 'UNCONFIRMED_VIOLATION');
    assert.deepEqual(lone.proposal, { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' });
    const expired = engine([...otherControlsPass(0), o('op-c', 'violation', 5)], 36);
    assert.deepEqual(expired.proposal, { kind: 'SUSPEND', ruleId: 'SR-4', reasonCode: 'CORROBORATION_UNAVAILABLE' });
    assert.equal(expired.criticalFailureConfirmed, false);
  });
});

describe('RN-CONFORM-02 engine: disputes (CC-D-03, ≥ 3 operators)', () => {
  const split = () => [...otherControlsPass(0), o('op-a', 'violation', 0), o('op-b', 'conformant', 1)];

  it('two conflicting operators are never a clean pass, and the most recent observation does not decide', () => {
    const out = engine(split(), 2);
    assert.equal(cr01(out).category, 'CONFLICTING');
    assert.notEqual(out.proposal.kind, 'ELIGIBLE_FOR_ACTIVE');
    assert.deepEqual(engine(split(), 2, 'CANDIDATE').proposal, { kind: 'NONE', reasonCode: 'NOT_ELIGIBLE' });
    assert.deepEqual(engine(split(), 31).proposal, { kind: 'SUSPEND', ruleId: 'SR-4', reasonCode: 'CONFLICTING_EVIDENCE' });
  });

  it('a third operator resolves it: conformance with ≥ 2 other operators clears, a second violation confirms', () => {
    const cleared = engine([...split(), o('op-c', 'conformant', 2)], 3);
    assert.equal(cr01(cleared).category, 'VERIFIED_SUCCESS');
    assert.ok(cr01(cleared).reasonCodes.includes('DISPUTE_RESOLVED_BY_ADDITIONAL_OPERATORS'));
    const confirmed = engine([...split(), o('op-c', 'violation', 2)], 3);
    assert.equal(cr01(confirmed).category, 'VERIFIED_FAILURE');
    // The violating operator re-reporting conformance does not count as an independent resolution.
    const selfCleared = engine([...split(), o('op-a', 'conformant', 2)], 3);
    assert.equal(cr01(selfCleared).category, 'CONFLICTING');
  });
});

describe('RN-CONFORM-02 engine: freshness and scope', () => {
  it('expires evidence, holds a grace period, then suspends under SR-2', () => {
    const obs = otherControlsPass(0, 'none');
    const day = 24 * 60;
    assert.equal(cr01(engine(obs, day + 1)).category, 'STALE_EVIDENCE');
    assert.deepEqual(engine(obs, day + 1).proposal, { kind: 'NONE', reasonCode: 'EVIDENCE_IN_GRACE' });
    assert.deepEqual(engine(obs, day + 6 * 60 + 1).proposal, { kind: 'SUSPEND', ruleId: 'SR-2', reasonCode: 'EVIDENCE_STALE' });
    assert.equal(engine(obs, day + 1).requirementResults.find((r) => r.requirementId === 'CR-09')?.category, 'STALE_EVIDENCE');
  });

  it('ignores inconclusive outcomes, excluded validators and other integration versions', () => {
    const inconclusive = [...otherControlsPass(0), o('op-a', 'inconclusive', 0), o('op-b', 'inconclusive', 0)];
    assert.equal(cr01(engine(inconclusive, 1)).category, 'INSUFFICIENT_EVIDENCE');
    const excluded = engine([...otherControlsPass(0), o('op-a', 'conformant', 0), o('op-b', 'conformant', 0, 'CR-01', 'val-revoked')], 1, 'ACTIVE', { excludedValidatorIds: ['val-revoked'] });
    assert.equal(cr01(excluded).category, 'INSUFFICIENT_EVIDENCE');
    const otherVersion = otherControlsPass(0, 'none').map((x) => ({ ...x, integrationDigest: `sha256:${'f'.repeat(64)}` }));
    const foreign = engine(otherVersion, 1, 'CANDIDATE');
    const corroborated = foreign.requirementResults.filter((r) => ['CR-01', 'CR-02', 'CR-05', 'CR-06', 'CR-07', 'CR-08'].includes(r.requirementId));
    assert.ok(corroborated.every((r) => r.category === 'INSUFFICIENT_EVIDENCE'));
    assert.deepEqual(foreign.proposal, { kind: 'NONE', reasonCode: 'NOT_ELIGIBLE' });
  });

  it('counts only post-suspension evidence towards revalidation', () => {
    const out = engine(otherControlsPass(0, 'none'), 60, 'SUSPENDED', { revalidationSince: at(30) });
    assert.equal(cr01(out).category, 'INSUFFICIENT_EVIDENCE');
    assert.ok(cr01(out).reasonCodes.includes('PRE_SUSPENSION_EVIDENCE_NOT_COUNTED'));
    assert.deepEqual(engine(otherControlsPass(31, 'none'), 60, 'SUSPENDED', { revalidationSince: at(30) }).proposal, { kind: 'ELIGIBLE_FOR_ACTIVE', reasonCode: 'ALL_CRITICAL_VERIFIED' });
  });

  it('cannot activate the full rn.conformance.integration@0.1.0 profile from this narrow fixture', () => {
    const out = evaluateConformance({
      profile: RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1,
      integration: { integrationDigest: DIGEST, sdk: SDK },
      coveredOperations: ['document.open'],
      observations: otherControlsPass(0, 'none').map((x) => ({ ...x, profileId: 'rn.conformance.integration' })),
      excludedValidatorIds: [],
      evaluatedAt: at(1),
      credentialState: 'CANDIDATE',
      revalidationSince: null,
    });
    const byId = Object.fromEntries(out.requirementResults.map((r) => [r.requirementId, r]));
    assert.equal(byId['CR-03']?.category, 'INSUFFICIENT_EVIDENCE');
    assert.deepEqual(byId['CR-03']?.reasonCodes, ['CHALLENGE_NOT_IMPLEMENTED']);
    assert.equal(byId['CR-04']?.category, 'INSUFFICIENT_EVIDENCE');
    assert.deepEqual(byId['CR-11']?.reasonCodes, ['HUMAN_REVIEW_NOT_IMPLEMENTED']);
    assert.deepEqual(byId['CR-12']?.reasonCodes, ['SDK_UNDEFINED_CC_D_10']);
    assert.deepEqual(out.proposal, { kind: 'NONE', reasonCode: 'NOT_ELIGIBLE' });
  });

  it('fails CR-12 deterministically for an SDK outside the range', () => {
    const out = engine(otherControlsPass(0, 'none'), 1, 'ACTIVE', { integration: { integrationDigest: DIGEST, sdk: { package: SDK.package, version: '2.0.0' } } });
    assert.equal(out.requirementResults.find((r) => r.requirementId === 'CR-12')?.category, 'VERIFIED_FAILURE');
    assert.deepEqual(out.proposal, { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle on real storage.
// ---------------------------------------------------------------------------

const refused = (code: string, detail?: string) => (e: unknown) => e instanceof CredentialLifecycleError && e.code === code && (detail === undefined || e.detail === detail);

const suspendForViolation = (c: Circuit, credentialId: string) => {
  c.platform.bypass = 'unauthorized-operation';
  const challenge = issue(c, 'G01', [c.validators.A, c.validators.B]);
  submit(c, observe(c, c.validators.A, challenge));
  submit(c, observe(c, c.validators.B, challenge));
  c.services().lifecycle.evaluate(ORG_A, credentialId);
  assert.equal(c.store.getHead(ORG_A, credentialId)?.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
};

const remediation = (c: Circuit) => ({ statement: 'Synthetic fixture enforcement restored.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() });

describe('RN-CONFORM-02 lifecycle: issuance (T2) and human approval (CC-D-04)', () => {
  it('refuses activation without, with one, or with two same-human approvals; or approvals for another subject, organization or binding', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
    const now = c.clock.now();
    const { alice, bob, mallory } = c.humans;
    assert.throws(() => lifecycle.commit(prepared, []), refused('APPROVAL_REFUSED', 'DECISIONS_MISSING'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.issue', credential.credentialId, prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED', 'DECISIONS_MISSING'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.issue', credential.credentialId, prepared.actionBindingDigest, now), decide(alice, 'approve', 'credential.issue', credential.credentialId, prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED', 'SAME_PRINCIPAL'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.issue', 'crd_other', prepared.actionBindingDigest, now), decide(bob, 'approve', 'credential.issue', 'crd_other', prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED', 'SUBJECT_MISMATCH'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.issue', credential.credentialId, prepared.actionBindingDigest, now), decide(mallory, 'approve', 'credential.issue', credential.credentialId, prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED', 'ORGANIZATION_MISMATCH'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.issue', credential.credentialId, conformanceDigest({ other: 1 }), now), decide(bob, 'approve', 'credential.issue', credential.credentialId, conformanceDigest({ other: 1 }), now)]), refused('APPROVAL_REFUSED', 'BINDING_DIGEST_MISMATCH'));
    assert.throws(() => lifecycle.commit(prepared, [decide(alice, 'attest', 'credential.revoke', credential.credentialId, prepared.actionBindingDigest, now), decide(bob, 'approve', 'credential.revoke', credential.credentialId, prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED', 'ACTION_MISMATCH'));
    // A modified action (different target state) no longer matches the digest the humans signed.
    const modified = { ...prepared, binding: { ...prepared.binding, toState: 'SUSPENDED' as const } };
    assert.throws(() => lifecycle.commit(modified, approvals(c, prepared)), refused('PREPARED_ACTION_TAMPERED'));
    assert.equal(c.store.getHead(ORG_A, credential.credentialId)?.state, 'CANDIDATE');

    // Correct approvals activate; their reuse for any later action is refused.
    const good = approvals(c, prepared);
    const head = lifecycle.commit(prepared, good);
    assert.deepEqual([head.state, head.stateVersion], ['ACTIVE', 2]);
    const transition = JSON.parse(c.store.listTransitions(ORG_A, credential.credentialId)[1]!.recordJson) as { humanDecisions: { principalId: string; role: string }[]; actionBindingDigest: string };
    assert.deepEqual(transition.humanDecisions.map((d) => [d.principalId, d.role]), [['human-alice', 'attest'], ['human-bob', 'approve']]);
    assert.equal(transition.actionBindingDigest, prepared.actionBindingDigest);
    const revoke = lifecycle.prepare('revoke', { organizationId: ORG_A, credentialId: credential.credentialId, reasonCode: 'PLATFORM_REQUEST' });
    assert.throws(() => lifecycle.commit(revoke, good), refused('APPROVAL_REFUSED'));
    c.cleanup();
  });

  it('refuses activation without corroborated evidence for every critical requirement', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    runBaseline(c, [c.validators.A, c.validators.A2]);
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId }), refused('NOT_ELIGIBLE'));
    c.cleanup();
  });

  it('refuses a prepared action after the head moved or after it expired, and a second credential for the same integration', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    assert.throws(() => lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest }), refused('CREDENTIAL_EXISTS'));
    runBaseline(c, [c.validators.A, c.validators.B]);
    const first = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
    const second = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
    lifecycle.commit(first, approvals(c, first));
    assert.throws(() => lifecycle.commit(second, approvals(c, second)), refused('CAS_CONFLICT'));
    const revoke = lifecycle.prepare('revoke', { organizationId: ORG_A, credentialId: credential.credentialId, reasonCode: 'PLATFORM_REQUEST' });
    c.clock.advance(16 * 60);
    assert.throws(() => lifecycle.commit(revoke, approvals(c, revoke)), refused('PREPARED_ACTION_EXPIRED'));
    c.cleanup();
  });
});

describe('RN-CONFORM-02 lifecycle: suspension and reinstatement (T4, T5)', () => {
  it('reinstatement after a confirmed violation needs remediation, full revalidation, no unresolved failure and two new humans', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    suspendForViolation(c, credentialId);
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('AUTOMATIC_PATH_NOT_APPLICABLE'));
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId }), refused('REMEDIATION_REQUIRED'));

    // Unresolved: the bypass is still on — re-running every check still shows the violation.
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) }), refused('NOT_ELIGIBLE'));

    // Remediated and every critical requirement re-validated after the suspension.
    c.platform.bypass = 'none';
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    // Old approvals (from issuance) cannot be replayed.
    const issuanceDecisions = c.store.listConsumedDecisions(JSON.parse(c.store.listTransitions(ORG_A, credentialId)[1]!.recordJson).transitionId).map((d) => JSON.parse(d.decisionJson) as unknown);
    assert.throws(() => lifecycle.commit(prepared, issuanceDecisions), refused('APPROVAL_REFUSED'));
    const head = lifecycle.commit(prepared, approvals(c, prepared, c.humans.carol, c.humans.alice));
    assert.deepEqual([head.state, head.stateVersion, head.reasonCode], ['ACTIVE', 4, 'REMEDIATED_AND_REVALIDATED']);
    c.cleanup();
  });

  it('refuses reinstatement when only the failed requirement was re-validated', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    suspendForViolation(c, credentialId);
    c.platform.bypass = 'none';
    c.clock.advance(60);
    const g01 = issue(c, 'G01', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, g01));
    submit(c, observe(c, c.validators.B, g01));
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) }), (e: unknown) => e instanceof CredentialLifecycleError && e.code === 'NOT_ELIGIBLE' && /CR-02:INSUFFICIENT_EVIDENCE/.test(e.detail));
    c.cleanup();
  });

  it('a single malicious report does not suspend or revoke; an unanswered investigation suspends (never revokes); automatic recovery needs ≥ 3 operators', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(60);
    const g01 = issue(c, 'G01', [c.validators.C]);
    // Validator C falsely reports a violation (the fixture actually denies).
    assert.ok(submit(c, observe(c, c.validators.C, g01, { outcome: 'allowed' })).accepted);
    const result = lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(result.protectiveTransition, null);
    assert.deepEqual(result.evaluation.proposal, { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' });
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE');
    assert.equal(verdict(c, credentialId).reason, 'UNDER_INVESTIGATION');

    c.clock.advance(31 * 60);
    lifecycle.evaluate(ORG_A, credentialId);
    const head = c.store.getHead(ORG_A, credentialId)!;
    assert.deepEqual([head.state, head.reasonCode], ['SUSPENDED', 'CONFLICTING_EVIDENCE']);

    // CONFLICTING_EVIDENCE is not auto-reinstatable; it needs remediation statement, ≥ 3 operators and two humans.
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('AUTOMATIC_PATH_NOT_APPLICABLE'));
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    c.cleanup();
  });

  it('an uncorroborated report suspends as CORROBORATION_UNAVAILABLE and recovers automatically after independent revalidation', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    // More than one window after the baseline, validator C alone reports a G02 violation; no other operator observes G02 near it.
    c.clock.advance(45 * 60);
    const g02 = issue(c, 'G02', [c.validators.C]);
    assert.ok(submit(c, observe(c, c.validators.C, g02, { outcome: 'allowed' })).accepted);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).evaluation.proposal.kind, 'NONE');
    c.clock.advance(31 * 60);
    lifecycle.evaluate(ORG_A, credentialId);
    const head = c.store.getHead(ORG_A, credentialId)!;
    assert.deepEqual([head.state, head.reasonCode], ['SUSPENDED', 'CORROBORATION_UNAVAILABLE']);
    // Revalidation by two operators other than C resolves the report; recovery from a non-violation suspension is automatic.
    runBaseline(c, [c.validators.A, c.validators.B]);
    const recovered = lifecycle.reinstateAutomatically(ORG_A, credentialId);
    assert.deepEqual([recovered.state, recovered.reasonCode], ['ACTIVE', 'REVALIDATED_AUTOMATIC']);
    c.cleanup();
  });

  it('expired evidence suspends under SR-2 and recovers automatically once revalidated', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(24 * 3600 + 6 * 3600 + 60);
    const { protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    assert.equal(verdict(c, credentialId).reason, 'NOT_ACTIVE');
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('NOT_ELIGIBLE'));
    runBaseline(c, [c.validators.A, c.validators.B]);
    const head = lifecycle.reinstateAutomatically(ORG_A, credentialId);
    assert.deepEqual([head.state, head.stateVersion, head.reasonCode], ['ACTIVE', 4, 'REVALIDATED_AUTOMATIC']);
    c.cleanup();
  });
});

describe('RN-CONFORM-02 lifecycle: revocation, expiry and terminal states (T3, T6, T7, T8)', () => {
  it('revokes with two humans only, and REVOKED never reactivates', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    const revoke = lifecycle.prepare('revoke', { organizationId: ORG_A, credentialId, reasonCode: 'CONTRACT_TERMINATION' });
    assert.throws(() => lifecycle.commit(revoke, []), refused('APPROVAL_REFUSED'));
    assert.throws(() => lifecycle.prepare('revoke', { organizationId: ORG_A, credentialId, reasonCode: 'SUSPENSION_TIMEOUT' }), refused('MALFORMED_INPUT'));
    assert.equal(lifecycle.commit(revoke, approvals(c, revoke)).state, 'REVOKED');
    runBaseline(c, [c.validators.A, c.validators.B]);
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), refused('WRONG_STATE'));
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId }), refused('WRONG_STATE'));
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('WRONG_STATE'));
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).evaluation.proposal.kind, 'NONE');
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'REVOKED');
    c.cleanup();
  });

  it('revokes automatically only after the suspension timeout (T6), never earlier', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    suspendForViolation(c, credentialId);
    c.clock.advance(29 * 86_400);
    assert.equal(lifecycle.applyTimeRules(ORG_A, credentialId).state, 'SUSPENDED');
    c.clock.advance(1 * 86_400 + 1);
    const head = lifecycle.applyTimeRules(ORG_A, credentialId);
    assert.deepEqual([head.state, head.reasonCode], ['REVOKED', 'SUSPENSION_TIMEOUT']);
    c.cleanup();
  });

  it('expires at the end of the term (T8) and the candidate term (T3); EXPIRED never reactivates', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(90 * 86_400);
    assert.equal(lifecycle.applyTimeRules(ORG_A, credentialId).state, 'EXPIRED');
    runBaseline(c, [c.validators.A, c.validators.B]);
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), refused('WRONG_STATE'));
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('WRONG_STATE'));

    const d = buildCircuit();
    const candidate = d.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: d.integration.integrationDigest });
    d.clock.advance(30 * 86_400);
    assert.equal(d.services().lifecycle.applyTimeRules(ORG_A, candidate.credentialId).state, 'EXPIRED');
    c.cleanup();
    d.cleanup();
  });

  it('never lets a new integration version inherit another version’s evidence or credential', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { registry, lifecycle } = c.services();
    const v2 = registry.registerIntegrationVersion(integrationInput(profileDigest(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1), { integrationVersion: 2, deploymentDigest: `sha256:${'4'.repeat(64)}` }));
    const second = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: v2.integrationDigest });
    assert.notEqual(second.credentialId, credentialId);
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: second.credentialId }), refused('NOT_ELIGIBLE'));
    // G08 against v1 observes the v2 deployment digest: CR-08 violation for v1, confirmed by two operators.
    c.platform.deployedDigest = `sha256:${'4'.repeat(64)}`;
    const g08 = issue(c, 'G08', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, g08));
    submit(c, observe(c, c.validators.B, g08));
    const { protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.ok(BASELINE.includes('G08'));
    c.cleanup();
  });
});
