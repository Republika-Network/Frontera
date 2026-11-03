import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance, conformanceDigest } from '../conformance/canonical.js';
import { toMs, toTimestamp, type ObservationPayload, type TransitionRecord } from '../conformance/contracts.js';
import { classifyOutcome, MAX_SUPPORTING_OBSERVATIONS } from '../conformance/engine.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { verifyTwoPersonAuthority } from '../conformance/human-authority.js';
import { CredentialLifecycleError, createCredentialLifecycle, evaluationHorizonMs, loadEngineInput, signTransition, type PreparedAction } from '../conformance/lifecycle.js';
import { RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileDigest } from '../conformance/profile.js';
import { ConformanceStoreError, type ConsumedDecision, type StoredObservationRow } from '../conformance/sqlite-conformance-store.js';
import { verifyCredentialHistory, verifyCurrentConformance, verifyEvidenceHistory } from '../conformance/verifier.js';
import {
  BASELINE,
  OPERATIONS,
  ORG_A,
  activeCredential,
  approvals,
  baselineOperations,
  buildCircuit,
  cleanupAll,
  decide,
  enrollmentDecisions,
  expectation,
  integrationInput,
  issue,
  observe,
  runBaseline,
  submit,
  syntheticValidator,
  verdict,
  type Circuit,
} from './conformance-support.js';

/**
 * RN-CONFORM-02 — regressions for the five Codex review findings on PR #263
 * (RN_CONFORM_02_IMPLEMENTATION.md §14). Every scenario runs on real SQLite,
 * through the real services, and where the finding concerns the database
 * boundary, also through a raw second connection with foreign keys OFF.
 *
 * SYNTHETIC: operators are labels, humans are synthetic Ed25519 keys; nothing
 * here is a real validator, credential or approval.
 */

after(cleanupAll);

const PROFILE = RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1;
const DAY = 86_400;
const refused = (code: string) => (e: unknown) => e instanceof CredentialLifecycleError && e.code === code;
const storeRefused = (pattern: RegExp) => (e: unknown) => e instanceof ConformanceStoreError && pattern.test(e.detail);
const remediation = (c: Circuit) => ({ statement: 'Synthetic fixture enforcement restored.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() });

const raw = (c: Circuit) => {
  const db = new Database(c.path);
  db.pragma('busy_timeout = 2000');
  db.pragma('foreign_keys = OFF');
  return db;
};

/** Two synthetic operators (A, B) observe a G01 bypass of `operation`, one minute apart. */
const corroborateBypass = (c: Circuit, operation = 'document.open') => {
  c.platform.bypass = 'unauthorized-operation';
  const challenge = issue(c, 'G01', [c.validators.A, c.validators.B], { operation });
  assert.ok(submit(c, observe(c, c.validators.A, challenge)).accepted);
  c.clock.advance(60);
  assert.ok(submit(c, observe(c, c.validators.B, challenge)).accepted);
};

/** The two-person refs a correct `commit` would consume for `prepared`, built outside the lifecycle (for direct store attempts). */
const consumedFor = (c: Circuit, prepared: PreparedAction): ConsumedDecision[] => {
  const result = verifyTwoPersonAuthority(
    c.humansDirectory,
    approvals(c, prepared),
    { action: prepared.action, organizationId: prepared.organizationId, subjectRef: prepared.credentialId, actionBindingDigest: prepared.actionBindingDigest, now: c.clock.now() },
    () => false,
  );
  assert.ok(result.authorized);
  return result.refs.map((ref, index) => ({ ref, signed: result.signed[index]!, action: prepared.action, organizationId: prepared.organizationId, subjectRef: prepared.credentialId }));
};

/** A transition exactly like the lifecycle would sign for `prepared`, with `overrides`. */
const transitionFor = (c: Circuit, prepared: PreparedAction, overrides: Partial<TransitionRecord>) => {
  const b = prepared.binding;
  const genesis = JSON.parse(c.store.listTransitions(ORG_A, prepared.credentialId)[0]!.recordJson) as TransitionRecord;
  return signTransition(
    {
      ...genesis,
      transitionId: b.transitionId,
      stateVersion: b.stateVersion,
      previousTransitionDigest: c.store.getHead(ORG_A, prepared.credentialId)!.headTransitionDigest,
      from: b.fromState,
      to: b.toState,
      transitionCode: b.transitionCode,
      reasonCode: b.reasonCode,
      ruleId: `${b.transitionCode}-${b.action}`,
      evaluationId: b.evaluationId,
      evaluationDigest: b.evaluationDigest,
      evidenceIds: prepared.evaluation?.record.evidenceIds ?? [],
      humanDecisions: [],
      actionBindingDigest: prepared.actionBindingDigest,
      remediationDigest: b.remediationDigest,
      effectiveAt: c.clock.now(),
      ...overrides,
    },
    c.registryKey,
  );
};

const TRANSITION_INSERT =
  'INSERT INTO cc_transitions (credential_id, state_version, transition_id, from_state, to_state, transition_code, reason_code, rule_id, evaluation_id, previous_transition_digest, transition_digest, action_binding_digest, effective_at_ms, record_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const transitionRow = (t: ReturnType<typeof signTransition>) => {
  const r = t.record;
  return [r.credentialId, r.stateVersion, r.transitionId, r.from, r.to, r.transitionCode, r.reasonCode, r.ruleId, r.evaluationId, r.previousTransitionDigest, t.transitionDigest, r.actionBindingDigest, Date.parse(r.effectiveAt), canonicalizeConformance(r), canonicalizeConformance(t.registrySignature)];
};

/** The row the acceptance boundary would have stored for `submission`, with an arbitrary recorded acceptance time — what a raw writer inserts. */
const rawRow = (c: Circuit, submission: string, acceptedAt: string): StoredObservationRow => {
  const parsed = JSON.parse(submission) as { observation: ObservationPayload; validatorSignature: unknown };
  const o = parsed.observation;
  const challenge = c.store.getChallenge(o.challengeId)!.challenge;
  const integration = c.store.getIntegrationByDigest(challenge.organizationId, challenge.integrationDigest)!;
  const outcomeClass = classifyOutcome(challenge.expectedOutcome, o.observedOutcome, o.observedDeploymentDigest, integration.record.deploymentDigest);
  const signed = { observation: o, validatorSignature: parsed.validatorSignature };
  return Object.freeze({
    eventId: o.eventId,
    challengeId: o.challengeId,
    validatorId: o.validatorId,
    operatorId: c.store.getValidator(o.validatorId)!.record.operatorId,
    organizationId: o.organizationId,
    integrationDigest: o.integrationDigest,
    profileId: o.profileId,
    profileVersion: o.profileVersion,
    controlId: o.controlId,
    operation: o.operation,
    evidenceDigest: o.evidenceDigest,
    outcomeClass,
    claimMatches: outcomeClass === o.outcomeClass,
    observedAt: o.observedAt,
    observedAtMs: toMs(o.observedAt),
    acceptedAt,
    acceptedAtMs: toMs(acceptedAt),
    observationDigest: conformanceDigest(signed),
    submissionJson: canonicalizeConformance(signed),
  });
};

const reauth = (c: Circuit, eventId: string) => authenticateStoredObservation(c.store, c.profiles, c.store.getObservation(eventId)!, c.coordinatorPublicKeyPem);

// ---------------------------------------------------------------------------
// Finding 1 — lifecycle.ts:145: a violation confirmed while suspended, never evaluated, laundered by automatic reinstatement.
// ---------------------------------------------------------------------------

describe('Codex finding 1 — confirmed critical violation while SUSPENDED forces two humans (durable, store-enforced)', () => {
  it('A–I: stale suspension, unevaluated corroborated bypass, full revalidation → automatic path refused at every layer and after restart; one human refused; two humans reinstate', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();

    // A — ACTIVE → SUSPENDED for stale evidence (an automatically reinstatable reason).
    c.clock.advance(DAY + 6 * 3600 + 60);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    const suspension = c.store.getHead(ORG_A, credentialId)!;
    assert.deepEqual([suspension.state, suspension.reasonCode], ['SUSPENDED', 'EVIDENCE_STALE']);

    // B — while SUSPENDED, two distinct synthetic operators corroborate a critical bypass. Nobody calls evaluate().
    corroborateBypass(c);
    assert.equal(lifecycle.assess(ORG_A, credentialId)!.engine.criticalFailureConfirmed, true);

    // C — the confirmed violation is persisted at acceptance, without any evaluation or transition.
    const recorded = c.store.listRecordedViolations(ORG_A, c.integration.integrationDigest, PROFILE.profileId, PROFILE.profileVersion, 0).filter((v) => v.confirmed);
    assert.equal(recorded.length, 1);
    assert.deepEqual([recorded[0]!.controlId, recorded[0]!.operation, recorded[0]!.operatorCount, recorded[0]!.critical], ['CR-01', 'document.open', 2, true]);
    assert.ok(!c.store.listEvaluations(ORG_A, credentialId).some((e) => e.record.criticalFailureConfirmed), 'no evaluation ever recorded the failure (the precondition of the finding)');

    // D — remediation and complete revalidation: every control passes again, so the engine alone would now clear it.
    c.platform.bypass = 'none';
    c.clock.advance(60);
    assert.ok(runBaseline(c, [c.validators.A, c.validators.B]).every((r) => r.accepted));
    c.clock.advance(1);
    assert.equal(lifecycle.assess(ORG_A, credentialId)!.engine.criticalFailureConfirmed, false);
    assert.equal(lifecycle.assess(ORG_A, credentialId)!.engine.proposal.kind, 'ELIGIBLE_FOR_ACTIVE');
    // A re-evaluation (an "appeal") commits a clean, eligible evaluation — and cannot erase the requirement.
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).evaluation.proposal.kind, 'ELIGIBLE_FOR_ACTIVE');

    // E — automatic reinstatement is refused.
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('AUTOMATIC_PATH_NOT_APPLICABLE'));

    // I — a direct T5 without humans is refused by the store (store write path and raw connection).
    const forStore = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    const automatic = transitionFor(c, forStore, { reasonCode: 'REVALIDATED_AUTOMATIC', ruleId: 'T5-AUTOMATIC', actionBindingDigest: null, remediationDigest: null });
    assert.throws(() => c.store.commitTransition({ evaluation: forStore.evaluation, decisions: [], transition: automatic }), storeRefused(/reinstatement requires two humans/));
    const forRaw = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    c.store.commitEvaluation(forRaw.evaluation!);
    const db = raw(c);
    assert.throws(
      () => db.prepare(TRANSITION_INSERT).run(...transitionRow(transitionFor(c, forRaw, { reasonCode: 'REVALIDATED_AUTOMATIC', ruleId: 'T5-AUTOMATIC', actionBindingDigest: null, remediationDigest: null }))),
      /cc:reinstatement requires two humans/,
    );
    // The durable record cannot be removed or rewritten to lift the requirement.
    assert.throws(() => db.prepare('DELETE FROM cc_confirmed_violations').run(), /cc:immutable cc_confirmed_violations/);
    assert.throws(() => db.prepare('UPDATE cc_confirmed_violations SET operator_count = 1').run(), /cc:immutable cc_confirmed_violations/);
    db.close();

    // H — a restart does not lose the requirement.
    c.reopen();
    const restarted = c.services().lifecycle;
    assert.throws(() => restarted.reinstateAutomatically(ORG_A, credentialId), refused('AUTOMATIC_PATH_NOT_APPLICABLE'));
    assert.throws(() => c.store.commitTransition({ evaluation: forStore.evaluation, decisions: [], transition: automatic }), storeRefused(/reinstatement requires two humans/));

    // F — one approval, or one human twice, is insufficient.
    const prepared = restarted.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    const now = c.clock.now();
    assert.throws(() => restarted.commit(prepared, [decide(c.humans.alice, 'attest', 'credential.reinstate', credentialId, prepared.actionBindingDigest, now)]), refused('APPROVAL_REFUSED'));
    assert.throws(
      () => restarted.commit(prepared, [decide(c.humans.alice, 'attest', 'credential.reinstate', credentialId, prepared.actionBindingDigest, now), decide(c.humans.alice, 'approve', 'credential.reinstate', credentialId, prepared.actionBindingDigest, now)]),
      refused('APPROVAL_REFUSED'),
    );
    // Approvals bound to another proposal do not transfer.
    assert.throws(() => restarted.commit(prepared, approvals(c, forStore)), refused('APPROVAL_REFUSED'));
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'SUSPENDED');

    // G — two valid, distinct humans, after complete revalidation, reinstate.
    const head = restarted.commit(prepared, approvals(c, prepared, c.humans.carol, c.humans.bob));
    assert.deepEqual([head.state, head.reasonCode], ['ACTIVE', 'REMEDIATED_AND_REVALIDATED']);
    const history = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    assert.ok(history.valid);
    const t5 = history.transitions.at(-1)!;
    assert.deepEqual(t5.humanDecisions.map((d) => [d.principalId, d.role]), [['human-carol', 'attest'], ['human-bob', 'approve']]);
    assert.equal(t5.actionBindingDigest, prepared.actionBindingDigest);
    assert.equal(verdict(c, credentialId).reason, 'CONFORMANT');
    c.cleanup();
  });

  it('review P1-A: a violation confirmed while ACTIVE and healed before any evaluation still suspends (SR-1) and needs two humans; the store refuses a clean evaluation', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    const clean = lifecycle.evaluate(ORG_A, credentialId).evaluation;
    assert.deepEqual(clean.proposal, { kind: 'NONE', reasonCode: 'CONFORMANT' });
    // A transient bypass, corroborated while ACTIVE, healed and fully revalidated before anyone evaluates.
    corroborateBypass(c);
    c.platform.bypass = 'none';
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    // The fail-closed verifier already refuses; a "clean" evaluation of the ACTIVE head is refused by the store on any path.
    assert.equal(verdict(c, credentialId).reason, 'PROTECTIVE_ACTION_PENDING');
    const forged = { ...clean, evaluationId: 'evl_clean_after_violation', evaluatedAt: c.clock.now() };
    assert.throws(() => c.store.commitEvaluation({ record: forged, evaluationDigest: conformanceDigest(forged), protectiveTransition: null }), storeRefused(/recorded violation without suspension/));
    // The lifecycle suspends under SR-1 with the durable record as evidence.
    const { evaluation, protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    const cr01 = evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')!;
    assert.deepEqual([cr01.category, cr01.reasonCodes.includes('RECORDED_CONFIRMED_VIOLATION:document.open')], ['VERIFIED_FAILURE', true]);
    assert.equal(protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('AUTOMATIC_PATH_NOT_APPLICABLE'));
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) });
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    // After the human-approved activation the old record no longer stands, and a stale suspension recovers automatically again.
    assert.equal(verdict(c, credentialId).reason, 'CONFORMANT');
    c.clock.advance(DAY + 6 * 3600 + 120);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    runBaseline(c, [c.validators.A, c.validators.B]);
    assert.equal(lifecycle.reinstateAutomatically(ORG_A, credentialId).reasonCode, 'REVALIDATED_AUTOMATIC');
    assert.ok(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid);
    c.cleanup();
  });

  it('review P2-B: a raw writer cannot plant a violation record ahead of the honest observation to suppress it', () => {
    const c = buildCircuit();
    activeCredential(c);
    const db = raw(c);
    assert.throws(
      () =>
        db.prepare('INSERT INTO cc_confirmed_violations (event_id, organization_id, integration_digest, profile_id, profile_version, control_id, operation, critical, operator_count, min_operators, observed_at_ms, confirmed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 2, ?, ?)').run(
          'evt-validator-b-predicted', ORG_A, c.integration.integrationDigest, PROFILE.profileId, PROFILE.profileVersion, 'CR-01', 'document.open', c.clock.ms(), c.clock.ms(),
        ),
      /cc:violation record without its observation/,
    );
    db.close();
    corroborateBypass(c);
    assert.equal(c.store.listRecordedViolations(ORG_A, c.integration.integrationDigest, PROFILE.profileId, PROFILE.profileVersion, 0).filter((v) => v.confirmed).length, 1);
    c.cleanup();
  });

  it('review P2-C: a violation accepted in the same millisecond as, but after, an automatic reinstatement does not invalidate the history; it suspends the new period', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(DAY + 6 * 3600 + 60);
    lifecycle.evaluate(ORG_A, credentialId);
    runBaseline(c, [c.validators.A, c.validators.B]);
    assert.equal(lifecycle.reinstateAutomatically(ORG_A, credentialId).state, 'ACTIVE');
    // Same instant (frozen clock): a corroborated bypass is accepted after the T5 committed.
    c.platform.bypass = 'unauthorized-operation';
    const challenge = issue(c, 'G01', [c.validators.A, c.validators.B]);
    assert.ok(submit(c, observe(c, c.validators.A, challenge)).accepted);
    assert.ok(submit(c, observe(c, c.validators.B, challenge)).accepted);
    assert.ok(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    c.cleanup();
  });

  it('a single operator, or two validators of one operator, record a violation that is not a confirmation', () => {
    const c = buildCircuit();
    activeCredential(c);
    c.platform.bypass = 'unauthorized-operation';
    const challenge = issue(c, 'G01', [c.validators.A, c.validators.A2]);
    submit(c, observe(c, c.validators.A, challenge));
    submit(c, observe(c, c.validators.A2, challenge));
    const recorded = c.store.listRecordedViolations(ORG_A, c.integration.integrationDigest, PROFILE.profileId, PROFILE.profileVersion, 0);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((v) => v.operatorCount === 1 && !v.confirmed));
    c.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — engine.ts:117: history growth (≈ 2 172 observations) made evaluation throw TOO_MANY_NODES and blocked SR-1.
// ---------------------------------------------------------------------------

describe('Codex finding 2 — bounded evaluation: growing history never blocks a protective suspension', () => {
  it('A–D, F–G: > 2 200 accepted observations; evaluation stays bounded and deterministic; a fresh corroborated violation suspends; the full history still verifies', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    const small = lifecycle.evaluate(ORG_A, credentialId).evaluation;

    // A — continuous testing: 101 full baselines (22 observations each) within the evaluation horizon.
    for (let round = 0; round < 100; round += 1) {
      c.clock.advance(60);
      runBaseline(c, [c.validators.A, c.validators.B]);
    }
    const total = c.store.listObservations(ORG_A, c.integration.integrationDigest).length;
    assert.ok(total > 2_172, `${total} observations exceed the reported failure point`);

    // B — current valid evidence is still evaluated; the record does not grow with history.
    c.clock.advance(1);
    const large = lifecycle.evaluate(ORG_A, credentialId).evaluation;
    assert.deepEqual(large.proposal, { kind: 'NONE', reasonCode: 'CONFORMANT' });
    assert.equal(large.evidenceIds.length, small.evidenceIds.length, 'supporting evidence is bounded, not the whole history');
    for (const r of large.requirementResults) assert.ok(r.evidenceIds.length <= MAX_SUPPORTING_OBSERVATIONS * OPERATIONS.length, `${r.requirementId}: ${r.evidenceIds.length}`);
    assert.ok(canonicalizeConformance(large).length < 64 * 1024);
    // G — deterministic.
    assert.deepEqual(lifecycle.assess(ORG_A, credentialId)!.engine, lifecycle.assess(ORG_A, credentialId)!.engine);

    // C, D — a fresh, corroborated critical violation still commits ACTIVE → SUSPENDED atomically.
    corroborateBypass(c);
    const { evaluation, protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(evaluation.criticalFailureConfirmed, true);
    assert.equal(protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.deepEqual([c.store.getHead(ORG_A, credentialId)?.state, c.store.getHead(ORG_A, credentialId)?.reasonCode], ['SUSPENDED', 'CRITICAL_VIOLATION_CONFIRMED']);

    // F — nothing was discarded: every observation is retained and re-authenticates; the transition history verifies.
    const audit = verifyEvidenceHistory(c, ORG_A, c.integration.integrationDigest);
    assert.equal(audit.observations, total + 2);
    assert.deepEqual(audit.defects, []);
    assert.ok(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid);
    c.cleanup();
  });

  it('E: evidence older than the evaluation horizon is not read and cannot satisfy quorum', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    c.clock.advance(evaluationHorizonMs(PROFILE) / 1000 + 60);
    // Only operator A revalidates; the old A + B corroboration is outside the horizon.
    runBaseline(c, [c.validators.A]);
    const loaded = loadEngineInput(c.store, c.profiles, ORG_A, credentialId, c.clock.now(), c.coordinatorPublicKeyPem)!;
    const horizonStart = c.clock.ms() - evaluationHorizonMs(PROFILE);
    assert.ok(loaded.input.observations.every((o) => toMs(o.observedAt) >= horizonStart));
    assert.ok(loaded.input.observations.length > 0 && loaded.input.observations.every((o) => o.validatorId === 'validator-a'));
    const out = c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(out.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, 'INSUFFICIENT_EVIDENCE');
    assert.equal(out.protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    c.cleanup();
  });

  it('review P2-D: an unresolved dispute raised in the current period does not age out of the bounded read', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(DAY + 6 * 3600 + 60);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    // Operator A alone reports a bypass; only operator B is available besides A, so the dispute cannot be resolved (needs two others).
    assert.ok(submit(c, observe(c, c.validators.A, issue(c, 'G01', [c.validators.A]), { outcome: 'allowed' })).accepted);
    c.clock.advance(evaluationHorizonMs(PROFILE) / 1000 + 3600);
    runBaseline(c, [c.validators.A, c.validators.B]);
    const cr01 = lifecycle.assess(ORG_A, credentialId)!.engine.requirementResults.find((r) => r.requirementId === 'CR-01')!;
    assert.ok(cr01.category === 'CONFLICTING' || cr01.category === 'UNCONFIRMED_VIOLATION', cr01.category);
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), refused('NOT_ELIGIBLE'));
    c.cleanup();
  });

  it('review P2-E: a dispute on one operation is not masked by an earlier-expiring single report on another', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.clock.advance(3600);
    // document.export: C alone reports a bypass (a single, uncontradicted report).
    assert.ok(submit(c, observe(c, c.validators.C, issue(c, 'G01', [c.validators.C], { operation: 'document.export' }), { outcome: 'allowed' })).accepted);
    c.clock.advance(5 * 60);
    // document.open: C reports a bypass that B, contemporaneously, contradicts (a dispute).
    const open = issue(c, 'G01', [c.validators.B, c.validators.C], { operation: 'document.open' });
    assert.ok(submit(c, observe(c, c.validators.C, open, { outcome: 'allowed' })).accepted);
    assert.ok(submit(c, observe(c, c.validators.B, open)).accepted);
    c.clock.advance(40 * 60);
    const { protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(protectiveTransition?.record.reasonCode, 'CONFLICTING_EVIDENCE');
    c.cleanup();
  });

  it('capacity exhaustion is an explicit fail-closed condition: never a pass, and a fresh corroborated violation still suspends under SR-1', () => {
    const tight = (c: Circuit) => createCredentialLifecycle({ store: c.store, profiles: c.profiles, clock: c.clock, random: c.random, registryKey: c.registryKey, humans: c.humansDirectory, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, maxEvaluationObservations: 8 });

    // Over capacity with only conformant evidence: no success can be established → SR-2, with the explicit reason.
    const c = buildCircuit();
    const first = activeCredential(c);
    // The capped verifier refuses to assert conformance from a partial read.
    const capped = verifyCurrentConformance({ store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, maxEvaluationObservations: 8 }, expectation(c, first), c.clock.now());
    assert.deepEqual([capped.conformant, capped.reason], [false, 'PROTECTIVE_ACTION_PENDING']);
    assert.equal(verdict(c, first).reason, 'CONFORMANT', 'with the default capacity the same evidence is conformant');
    const stale = tight(c).evaluate(ORG_A, first);
    assert.equal(stale.protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    assert.ok(stale.evaluation.requirementResults.filter((r) => r.requirementId !== 'CR-12' && r.requirementId !== 'CR-09').every((r) => r.reasonCodes.includes('EVALUATION_CAPACITY_EXCEEDED') && r.category !== 'VERIFIED_SUCCESS'));

    // Over capacity with a fresh corroborated violation among the newest observations: SR-1, not SR-2.
    const d = buildCircuit();
    const second = activeCredential(d);
    corroborateBypass(d);
    const violated = tight(d).evaluate(ORG_A, second);
    assert.equal(violated.evaluation.criticalFailureConfirmed, true);
    assert.equal(violated.protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    c.cleanup();
    d.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — sqlite-conformance-store.ts:385: T2 issuance accepted after the 30-day candidate term.
// ---------------------------------------------------------------------------

describe('Codex finding 3 — the candidate deadline is enforced at the store boundary', () => {
  it('A, C: issuance strictly before candidateUntil succeeds (1 ms before the deadline)', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    c.clock.set(toTimestamp(toMs(candidate.candidateUntil) - 10 * 60_000));
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: candidate.credentialId });
    c.clock.set(toTimestamp(toMs(candidate.candidateUntil) - 1));
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    assert.ok(verifyCredentialHistory(c.store, ORG_A, candidate.credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid);
    c.cleanup();
  });

  it('B–F: at or after candidateUntil no approval, replayed preparation, store write or raw insert activates; restart preserves it; T3 still expires it', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const credentialId = candidate.credentialId;
    c.clock.set(toTimestamp(toMs(candidate.candidateUntil) - 10 * 60_000));
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    // A preparation made in time, replayed after the deadline.
    const early = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId });
    const spare = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId });

    // C — exactly at the deadline the candidate is expired (T3 applies from candidateUntil inclusive), so issuance is refused.
    c.clock.set(candidate.candidateUntil);
    // D — two otherwise valid approvals do not override the expiry; nor does a fresh preparation.
    assert.throws(() => lifecycle.commit(early, approvals(c, early)), refused('CANDIDATE_TERM_ENDED'));
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), refused('CANDIDATE_TERM_ENDED'));

    // F — after a restart …
    c.reopen();
    // E — … the store write path and a raw connection refuse a fully formed, two-human T2 at the deadline.
    const decisions = consumedFor(c, early);
    const signed = transitionFor(c, early, { humanDecisions: decisions.map((d) => d.ref) });
    assert.throws(() => c.store.commitTransition({ evaluation: early.evaluation, decisions, transition: signed }), storeRefused(/issuance after candidate term/));
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'CANDIDATE');
    c.store.commitEvaluation(spare.evaluation!);
    const spareDecisions = consumedFor(c, spare);
    const db = raw(c);
    for (const d of spareDecisions) {
      db.prepare('INSERT INTO cc_consumed_decisions (decision_id, principal_id, role, action, organization_id, subject_ref, action_binding_digest, decision_digest, decision_json, consumed_for, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        d.ref.decisionId, d.ref.principalId, d.ref.role, d.action, d.organizationId, d.subjectRef, d.ref.actionBindingDigest, d.ref.decisionDigest, canonicalizeConformance(d.signed), spare.binding.transitionId, c.clock.now(),
      );
    }
    const spareT2 = transitionFor(c, spare, { humanDecisions: spareDecisions.map((d) => d.ref) });
    assert.throws(() => db.prepare(TRANSITION_INSERT).run(...transitionRow(spareT2)), /cc:issuance after candidate term/);
    db.close();

    // T3 is preserved: the candidate expires, and EXPIRED is terminal.
    const expired = c.services().lifecycle.applyTimeRules(ORG_A, credentialId);
    assert.deepEqual([expired.state, expired.reasonCode], ['EXPIRED', 'CANDIDATE_TERM_ENDED']);
    assert.ok(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid);
    c.cleanup();
  });

  it('the history verifier independently refuses a late T2 written by an administrator who dropped the triggers', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    c.clock.set(toTimestamp(toMs(candidate.candidateUntil) - 10 * 60_000));
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: candidate.credentialId });
    c.clock.set(toTimestamp(toMs(candidate.candidateUntil) + 60_000));
    c.store.commitEvaluation(prepared.evaluation!);
    const decisions = consumedFor(c, prepared);
    const db = raw(c);
    db.exec('DROP TRIGGER cc_transitions_guard');
    db.prepare(TRANSITION_INSERT).run(...transitionRow(transitionFor(c, prepared, { humanDecisions: decisions.map((d) => d.ref) })));
    db.close();
    assert.equal(c.store.getHead(ORG_A, candidate.credentialId)?.state, 'ACTIVE', 'without its triggers the database accepted it');
    const history = verifyCredentialHistory(c.store, ORG_A, candidate.credentialId, { registryPublicKeyPem: c.registryPublicKeyPem });
    assert.deepEqual(history, { valid: false, failure: 'TERM_VIOLATION', atStateVersion: 2 });
    assert.equal(verdict(c, candidate.credentialId).reason, 'HISTORY_INVALID');
    c.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — engine.ts:205: evidence for one covered operation satisfied every covered operation.
// ---------------------------------------------------------------------------

describe('Codex finding 4 — evidence is bound to the exact operation; every covered operation needs its own', () => {
  it('A–F: document.open evidence alone never activates document.export; a failure of document.export is not masked; full evidence activates', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    // A — the integration declares document.open and document.export.
    assert.deepEqual([...OPERATIONS].sort(), ['document.export', 'document.open']);
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const credentialId = candidate.credentialId;

    // B — both validators pass every control, but only for document.open.
    assert.ok(runBaseline(c, [c.validators.A, c.validators.B], ['document.open']).every((r) => r.accepted));
    c.clock.advance(1);
    // C, D — document.export remains unverified; the credential cannot activate.
    const assessed = lifecycle.assess(ORG_A, credentialId)!.engine;
    const cr01 = assessed.requirementResults.find((r) => r.requirementId === 'CR-01')!;
    assert.equal(cr01.category, 'INSUFFICIENT_EVIDENCE');
    assert.ok(cr01.reasonCodes.includes('OPERATION_INSUFFICIENT_EVIDENCE:document.export'));
    assert.ok(!cr01.reasonCodes.some((r) => r.endsWith(':document.open')), 'the verified operation is not reported as missing');
    for (const id of ['CR-01', 'CR-02', 'CR-05', 'CR-06', 'CR-07']) assert.equal(assessed.requirementResults.find((r) => r.requirementId === id)?.category, 'INSUFFICIENT_EVIDENCE', id);
    // G08 (deployment digest) is operation-independent and is not duplicated per operation.
    assert.equal(assessed.requirementResults.find((r) => r.requirementId === 'CR-08')?.category, 'VERIFIED_SUCCESS');
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), (e: unknown) => e instanceof CredentialLifecycleError && e.code === 'NOT_ELIGIBLE' && /CR-01:INSUFFICIENT_EVIDENCE/.test(e.detail));

    // F — evidence for the correct operation activates.
    assert.ok(runBaseline(c, [c.validators.A, c.validators.B], ['document.export']).every((r) => r.accepted));
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId });
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    assert.equal(verdict(c, credentialId, 'document.export').reason, 'CONFORMANT');
    assert.equal(verdict(c, credentialId, 'document.open').reason, 'CONFORMANT');

    // E — a corroborated bypass of document.export only, next to fresh conformant document.open evidence, suspends.
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B], ['document.open']);
    const exportChallenge = issue(c, 'G01', [c.validators.A, c.validators.B], { operation: 'document.export' });
    assert.ok(submit(c, observe(c, c.validators.A, exportChallenge, { outcome: 'allowed' })).accepted);
    assert.ok(submit(c, observe(c, c.validators.B, exportChallenge, { outcome: 'allowed' })).accepted);
    const { evaluation, protectiveTransition } = lifecycle.evaluate(ORG_A, credentialId);
    const failed = evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')!;
    assert.equal(failed.category, 'VERIFIED_FAILURE');
    assert.ok(failed.reasonCodes.includes('OPERATION_VERIFIED_FAILURE:document.export'));
    assert.equal(protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.equal(verdict(c, credentialId, 'document.open').reason, 'NOT_ACTIVE');
    c.cleanup();
  });

  it('G: a changed declared scope is a new integration version; old evidence is not reused and the new operation needs its own evidence', () => {
    const c = buildCircuit();
    const { registry, lifecycle } = c.services();
    activeCredential(c);
    const wider = [...OPERATIONS, 'document.print'];
    const v2 = registry.registerIntegrationVersion(integrationInput(profileDigest(PROFILE), { integrationVersion: 2, coveredOperations: wider }));
    assert.notEqual(v2.integrationDigest, c.integration.integrationDigest);
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: v2.integrationDigest });
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: candidate.credentialId }), refused('NOT_ELIGIBLE'));
    // v2 evidence for the old operations only: document.print is still unverified.
    const v2Baseline = (operations: readonly string[]) => {
      for (const type of BASELINE) {
        for (const operation of baselineOperations(type, operations)) {
          const challenge = issue(c, type, [c.validators.A, c.validators.B], { operation, integrationDigest: v2.integrationDigest });
          for (const v of [c.validators.A, c.validators.B]) assert.ok(submit(c, observe(c, v, challenge)).accepted);
        }
      }
    };
    v2Baseline(OPERATIONS);
    c.clock.advance(1);
    const cr01 = lifecycle.assess(ORG_A, candidate.credentialId)!.engine.requirementResults.find((r) => r.requirementId === 'CR-01')!;
    assert.equal(cr01.category, 'INSUFFICIENT_EVIDENCE');
    assert.ok(cr01.reasonCodes.includes('OPERATION_INSUFFICIENT_EVIDENCE:document.print'));
    v2Baseline(['document.print']);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: candidate.credentialId });
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    c.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — evidence.ts:319: stored rows were re-authenticated without the deadline and key-validity checks.
// ---------------------------------------------------------------------------

describe('Codex finding 5 — stored evidence is re-validated under the acceptance contract', () => {
  it('A, F, G: observations past the challenge deadline, inserted through the store, are rejected on reload, never count, and stay rejected after reopen', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    // Baseline challenges issued but never answered in time.
    const unused = BASELINE.flatMap((type) => baselineOperations(type).map((operation) => issue(c, type, [c.validators.A, c.validators.B], { operation })));
    c.clock.advance(2 * DAY);
    assert.equal(verdict(c, credentialId).reason, 'PROTECTIVE_ACTION_PENDING');
    // The rejection each raw row must get on reload: past the deadline when stored with its true acceptance time;
    // a recorded acceptance time backdated into the challenge window cannot launder it (the signed observation then lies in that row's future).
    const expected = new Map<string, string>();
    for (const challenge of unused) {
      for (const v of [c.validators.A, c.validators.B]) {
        const late = observe(c, v, challenge);
        assert.deepEqual(submit(c, late), { accepted: false, reason: 'CHALLENGE_EXPIRED' });
        const backdated = v === c.validators.B;
        const row = rawRow(c, late, backdated ? toTimestamp(toMs(challenge.challenge.issuedAt) + 1_000) : c.clock.now());
        c.store.insertObservation(row);
        expected.set(row.eventId, backdated ? 'FUTURE_DATED' : 'CHALLENGE_EXPIRED');
      }
    }
    const insertedIds = [...expected.keys()];
    for (const [id, reason] of expected) assert.equal(reauth(c, id), reason, id);
    const v = verdict(c, credentialId);
    assert.deepEqual([v.conformant, v.reason], [false, 'EVIDENCE_TAMPERED']);
    // F — none of them counts: the evaluation still finds stale evidence and suspends.
    const { evaluation, protectiveTransition } = c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.ok(!evaluation.evidenceIds.some((id) => insertedIds.includes(id)));
    assert.equal(protectiveTransition?.record.reasonCode, 'EVIDENCE_STALE');
    // G — the same verdicts after a reopen.
    c.reopen();
    for (const [id, reason] of expected) assert.equal(reauth(c, id), reason, id);
    assert.equal(verifyEvidenceHistory(c, ORG_A, c.integration.integrationDigest).defects.length, insertedIds.length);
    c.cleanup();
  });

  it('F: an invalid stored observation never completes quorum for activation', () => {
    const c = buildCircuit();
    const { lifecycle } = c.services();
    const candidate = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const challenges = BASELINE.flatMap((type) => baselineOperations(type).map((operation) => issue(c, type, [c.validators.A, c.validators.B], { operation })));
    for (const challenge of challenges) assert.ok(submit(c, observe(c, c.validators.A, challenge)).accepted);
    c.clock.advance(20 * 60);
    for (const challenge of challenges) c.store.insertObservation(rawRow(c, observe(c, c.validators.B, challenge), c.clock.now()));
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: candidate.credentialId }), refused('NOT_ELIGIBLE'));
    const loaded = loadEngineInput(c.store, c.profiles, ORG_A, candidate.credentialId, c.clock.now(), c.coordinatorPublicKeyPem)!;
    assert.equal(loaded.unauthenticated.length, challenges.length);
    assert.ok(loaded.input.observations.every((o) => o.validatorId === 'validator-a'));
    c.cleanup();
  });

  it('B, D: a key invalid at observation time is rejected on reload; correct evidence stays valid after the key and the challenge have expired', () => {
    const c = buildCircuit();
    const { registry } = c.services();
    const D = syntheticValidator('validator-d', 'op-synthetic-c');
    const keyValidUntil = toTimestamp(c.clock.ms() + 20 * 60_000);
    const prepared = registry.prepareValidatorEnrollment({ validatorId: D.validatorId, operatorId: D.operatorId, publicKeyPem: D.publicKeyPem, keyValidFrom: c.clock.now(), keyValidUntil });
    registry.enrollValidator(prepared.record, enrollmentDecisions(c, D.validatorId, prepared.bindingDigest, c.clock.now()));

    // D — an honest observation inside the key's validity …
    const honest = submit(c, observe(c, D, issue(c, 'G01', [D])));
    assert.ok(honest.accepted);
    // B — … and one made 2 s after the key expired, on a challenge whose deadline is the key's last instant (within clock skew).
    c.clock.set(toTimestamp(toMs(keyValidUntil) - 10 * 60_000));
    const edge = issue(c, 'G02', [D], { deadlineSeconds: 600 });
    assert.equal(edge.challenge.deadline, keyValidUntil);
    c.clock.set(toTimestamp(toMs(keyValidUntil) + 2_000));
    const afterKey = observe(c, D, edge);
    assert.deepEqual(submit(c, afterKey), { accepted: false, reason: 'KEY_NOT_VALID' });
    const row = rawRow(c, afterKey, toTimestamp(toMs(keyValidUntil) - 1_000));
    c.store.insertObservation(row);
    assert.equal(reauth(c, row.eventId), 'KEY_NOT_VALID');

    // D — retrospective policy: the honest row remains valid after its challenge deadline and the key's validity have passed.
    c.clock.advance(30 * DAY);
    assert.equal(reauth(c, honest.accepted ? honest.observation.eventId : ''), null);
    c.cleanup();
  });

  it('C, E: tampered stored challenge metadata is detected; a later key revocation withdraws evidence without reporting tampering', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    assert.equal(verdict(c, credentialId).reason, 'CONFORMANT');

    // E — explicit policy: revoking B's key now excludes B's evidence from every later evaluation (no tampering is reported).
    const d = buildCircuit();
    const second = activeCredential(d);
    d.services().registry.revokeValidatorKey('validator-b', 'key compromised (test)');
    const bRows = d.store.listObservations(ORG_A, d.integration.integrationDigest).filter((o) => o.validatorId === 'validator-b');
    assert.ok(bRows.length > 0 && bRows.every((r) => authenticateStoredObservation(d.store, d.profiles, r, d.coordinatorPublicKeyPem) === null), 'evidence accepted before the revocation is not forged');
    const afterRevocation = verdict(d, second);
    assert.equal(afterRevocation.conformant, false);
    assert.notEqual(afterRevocation.reason, 'EVIDENCE_TAMPERED');
    assert.ok(d.services().lifecycle.assess(ORG_A, second)!.engine.requirementResults.filter((r) => r.severity === 'critical' && r.requirementId !== 'CR-12').every((r) => r.category !== 'VERIFIED_SUCCESS'));

    // C — a privileged writer extends a stored challenge's deadline: the coordinator signature no longer verifies.
    const target = c.store.listObservations(ORG_A, c.integration.integrationDigest)[0]!;
    const challenge = c.store.getChallenge(target.challengeId)!.challenge;
    const db = raw(c);
    db.exec('DROP TRIGGER cc_challenges_no_update');
    db.prepare('UPDATE cc_challenges SET challenge_json = ? WHERE challenge_id = ?').run(canonicalizeConformance({ ...challenge, deadline: toTimestamp(toMs(challenge.deadline) + 30 * DAY * 1000) }), target.challengeId);
    db.close();
    assert.equal(reauth(c, target.eventId), 'CHALLENGE_UNKNOWN');
    assert.equal(verdict(c, credentialId).reason, 'EVIDENCE_TAMPERED');
    c.cleanup();
    d.cleanup();
  });
});
