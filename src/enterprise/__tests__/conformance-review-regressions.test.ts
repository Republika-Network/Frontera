import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance, conformanceDigest } from '../conformance/canonical.js';
import type { EvaluationRecord, TransitionRecord } from '../conformance/contracts.js';
import { CredentialLifecycleError, signTransition } from '../conformance/lifecycle.js';
import { ConformanceStoreError, openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { ORG_A, activeCredential, approvals, buildCircuit, cleanupAll, issue, observe, runBaseline, submit, verdict, type Circuit } from './conformance-support.js';

/**
 * RN-CONFORM-02 — regressions for the findings of the independent review pass
 * (RN_CONFORM_02_IMPLEMENTATION.md §13). Each test reproduces the reported
 * exploit and asserts it now fails.
 */

after(cleanupAll);

const raw = (c: Circuit) => {
  const db = new Database(c.path);
  db.pragma('busy_timeout = 2000');
  db.pragma('foreign_keys = OFF');
  return db;
};

const corroboratedViolation = (c: Circuit, type: 'G01' | 'G02' = 'G01') => {
  c.platform.bypass = 'unauthorized-operation';
  const challenge = issue(c, type, [c.validators.A, c.validators.B]);
  assert.ok(submit(c, observe(c, c.validators.A, challenge)).accepted);
  assert.ok(submit(c, observe(c, c.validators.B, challenge)).accepted);
};

const EVAL_INSERT = (verb: string) => `${verb} INTO cc_evaluations (evaluation_id, credential_id, evaluated_at_ms, credential_state_version, critical_failure, requires_suspension, eligible_for_active, evaluation_digest, record_json,
  pt_transition_id, pt_reason_code, pt_rule_id, pt_previous_digest, pt_transition_digest, pt_effective_at_ms, pt_record_json, pt_signature_json) VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe('RN-CONFORM-02 review regressions', () => {
  it('P0-1: no conflict clause (OR IGNORE / OR REPLACE / OR FAIL / OR ROLLBACK) commits a critical failure next to an ACTIVE head', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const template = c.services().lifecycle.evaluate(ORG_A, credentialId).evaluation;
    const head = c.store.getHead(ORG_A, credentialId)!;
    const rows = c.store.listTransitions(ORG_A, credentialId);
    const genesisId = rows[0]!.columns.transitionId;
    const last = JSON.parse(rows.at(-1)!.recordJson) as TransitionRecord;
    const db = raw(c);
    for (const [verb, ptId] of [['INSERT OR IGNORE', genesisId], ['INSERT OR REPLACE', genesisId], ['INSERT OR FAIL', genesisId], ['INSERT OR ROLLBACK', genesisId], ['INSERT OR IGNORE', 'trn_new_1']] as const) {
      const id = `evl_${verb.replace(/\W/g, '_')}_${ptId}`;
      const record: EvaluationRecord = { ...template, evaluationId: id, credentialStateVersion: head.stateVersion, criticalFailureConfirmed: true, proposal: { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' } };
      const pt = signTransition({ ...last, transitionId: ptId, stateVersion: head.stateVersion + 1, previousTransitionDigest: head.headTransitionDigest, from: 'ACTIVE', to: 'SUSPENDED', transitionCode: 'T4', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED', ruleId: 'SR-1', evaluationId: id, evaluationDigest: conformanceDigest(record), humanDecisions: [], actionBindingDigest: null }, c.registryKey);
      const args = [id, credentialId, Date.parse(record.evaluatedAt), head.stateVersion, conformanceDigest(record), canonicalizeConformance(record), ptId, 'CRITICAL_VIOLATION_CONFIRMED', 'SR-1', head.headTransitionDigest, pt.transitionDigest, Date.parse(pt.record.effectiveAt), canonicalizeConformance(pt.record), canonicalizeConformance(pt.registrySignature)];
      if (ptId === genesisId) {
        assert.throws(() => db.prepare(EVAL_INSERT(verb)).run(...args), /cc:/, verb);
      } else {
        // A genuine new transition id: OR IGNORE must not hide anything either — it commits the suspension or nothing.
        const result = db.prepare(EVAL_INSERT(verb)).run(...args);
        assert.equal(result.changes, 1);
      }
      const now = c.store.getHead(ORG_A, credentialId)!;
      const committedCritical = c.store.listEvaluations(ORG_A, credentialId).filter((e) => e.record.criticalFailureConfirmed);
      assert.ok(committedCritical.length === 0 || now.state === 'SUSPENDED', `${verb}: ${committedCritical.length} critical evaluation(s) next to ${now.state}`);
    }
    db.close();
    c.cleanup();
  });

  it('P1-1: OR REPLACE / upsert cannot rewrite a head or an observation', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    corroboratedViolation(c);
    c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'SUSPENDED');
    const db = raw(c);
    const genesis = c.store.listTransitions(ORG_A, credentialId)[0]!;
    const genesisRecord = JSON.parse(genesis.recordJson) as TransitionRecord;
    assert.throws(
      () => db.prepare('INSERT OR REPLACE INTO cc_heads (credential_id, state, state_version, head_transition_digest, reason_code, effective_at_ms) VALUES (?, ?, 1, ?, ?, ?)').run(credentialId, 'CANDIDATE', genesis.transitionDigest, 'INTEGRATION_REGISTERED', Date.parse(genesisRecord.effectiveAt)),
      /cc:duplicate cc_heads/,
    );
    const violations = c.store.listObservations(ORG_A, c.integration.integrationDigest).filter((o) => o.outcomeClass === 'violation');
    assert.equal(violations.length, 2);
    const v = violations[0]!;
    const cols = 'event_id, challenge_id, validator_id, operator_id, organization_id, integration_digest, profile_id, profile_version, control_id, operation, evidence_digest, outcome_class, claim_matches, observed_at, observed_at_ms, accepted_at, accepted_at_ms, observation_digest, submission_json';
    const values = [v.eventId, v.challengeId, v.validatorId, v.operatorId, v.organizationId, v.integrationDigest, v.profileId, v.profileVersion, v.controlId, v.operation, v.evidenceDigest, 'conformant', 1, v.observedAt, v.observedAtMs, v.acceptedAt, v.acceptedAtMs, v.observationDigest, '{}'];
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO cc_observations (${cols}) VALUES (${cols.split(',').map(() => '?').join(', ')})`).run(...values), /cc:duplicate cc_observations/);
    assert.throws(() => db.prepare(`INSERT INTO cc_observations (${cols}) VALUES (${cols.split(',').map(() => '?').join(', ')}) ON CONFLICT (event_id) DO UPDATE SET outcome_class = 'conformant'`).run(...values), /cc:duplicate cc_observations/);
    assert.throws(() => db.prepare(`REPLACE INTO cc_consumed_decisions SELECT * FROM cc_consumed_decisions LIMIT 1`).run(), /cc:duplicate cc_consumed_decisions/);
    db.close();
    assert.equal(c.store.listObservations(ORG_A, c.integration.integrationDigest).filter((o) => o.outcomeClass === 'violation').length, 2);
    assert.deepEqual([c.store.getHead(ORG_A, credentialId)?.state, c.store.getHead(ORG_A, credentialId)?.stateVersion], ['SUSPENDED', 3]);
    c.cleanup();
  });

  it('P1-2: the verifier and the engine re-authenticate stored observations (rewritten or injected rows fail closed)', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    assert.equal(verdict(c, credentialId).reason, 'CONFORMANT');
    const db = raw(c);
    // Injected row: a coordinator-issued challenge for validator C, a real evidence package digest, no valid submission.
    const challenge = issue(c, 'G01', [c.validators.C]);
    const pkgDigest = c.store.listObservations(ORG_A, c.integration.integrationDigest)[0]!.evidenceDigest;
    db.prepare(
      'INSERT INTO cc_observations (event_id, challenge_id, validator_id, operator_id, organization_id, integration_digest, profile_id, profile_version, control_id, operation, evidence_digest, outcome_class, claim_matches, observed_at, observed_at_ms, accepted_at, accepted_at_ms, observation_digest, submission_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('evt-injected', challenge.challenge.challengeId, 'validator-c', 'op-synthetic-c', ORG_A, c.integration.integrationDigest, challenge.challenge.profileId, challenge.challenge.profileVersion, 'CR-01', challenge.challenge.operation, pkgDigest, 'conformant', 1, c.clock.now(), c.clock.ms(), c.clock.now(), c.clock.ms(), conformanceDigest({ forged: true }), '{}');
    const injected = verdict(c, credentialId);
    assert.deepEqual([injected.conformant, injected.reason, injected.detail], [false, 'EVIDENCE_TAMPERED', 'evt-injected']);
    // The lifecycle never evaluates it: the injected row is not in the evidence of a new evaluation.
    const evaluation = c.services().lifecycle.evaluate(ORG_A, credentialId).evaluation;
    assert.ok(!evaluation.evidenceIds.includes('evt-injected'));

    // Rewritten row (a privileged writer drops the immutability trigger first).
    const d = buildCircuit();
    const second = activeCredential(d);
    const ddb = raw(d);
    ddb.exec('DROP TRIGGER cc_observations_no_update');
    const target = d.store.listObservations(ORG_A, d.integration.integrationDigest)[0]!;
    ddb.prepare("UPDATE cc_observations SET outcome_class = 'violation' WHERE event_id = ?").run(target.eventId);
    assert.equal(verdict(d, second).reason, 'EVIDENCE_TAMPERED');
    ddb.close();
    db.close();
    c.cleanup();
    d.cleanup();
  });

  it('P1-3: a critical violation confirmed while suspended for another reason cannot be auto-reinstated, at the lifecycle or the database', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    // SR-4: a lone, uncorroborated report suspends as CORROBORATION_UNAVAILABLE.
    c.clock.advance(45 * 60);
    assert.ok(submit(c, observe(c, c.validators.C, issue(c, 'G02', [c.validators.C]), { outcome: 'allowed' })).accepted);
    c.clock.advance(31 * 60);
    lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.reasonCode, 'CORROBORATION_UNAVAILABLE');
    // While suspended, two operators confirm a real G01 bypass.
    corroboratedViolation(c);
    assert.equal(lifecycle.evaluate(ORG_A, credentialId).evaluation.criticalFailureConfirmed, true);
    // Remediation and full revalidation are not enough without the two-person path.
    c.platform.bypass = 'none';
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    assert.throws(() => lifecycle.reinstateAutomatically(ORG_A, credentialId), (e: unknown) => e instanceof CredentialLifecycleError && e.code === 'AUTOMATIC_PATH_NOT_APPLICABLE');
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId }), (e: unknown) => e instanceof CredentialLifecycleError && e.code === 'REMEDIATION_REQUIRED');
    const prepared = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: { statement: 'Synthetic bypass removed.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } });
    // The database refuses the same T5 without consumed human decisions.
    const last = JSON.parse(c.store.listTransitions(ORG_A, credentialId).at(-1)!.recordJson) as TransitionRecord;
    const b = prepared.binding;
    const noHumans = signTransition({ ...last, transitionId: b.transitionId, stateVersion: b.stateVersion, previousTransitionDigest: c.store.getHead(ORG_A, credentialId)!.headTransitionDigest, from: 'SUSPENDED', to: 'ACTIVE', transitionCode: 'T5', reasonCode: 'REVALIDATED_AUTOMATIC', ruleId: 'T5-AUTOMATIC', evaluationId: b.evaluationId, evaluationDigest: b.evaluationDigest, humanDecisions: [], actionBindingDigest: null, remediationDigest: null, effectiveAt: c.clock.now() }, c.registryKey);
    assert.throws(() => c.store.commitTransition({ evaluation: prepared.evaluation, decisions: [], transition: noHumans }), (e: unknown) => e instanceof ConformanceStoreError && /reinstatement requires two humans/.test(e.detail));
    assert.equal(lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    c.cleanup();
  });

  it('P2-1: a same-name trigger with a different body makes the store refuse to open', () => {
    const c = buildCircuit();
    activeCredential(c);
    c.store.close();
    const db = raw(c);
    db.exec('DROP TRIGGER cc_evaluations_guard; CREATE TRIGGER cc_evaluations_guard BEFORE INSERT ON cc_evaluations BEGIN SELECT 1; END;');
    db.close();
    assert.throws(() => openConformanceStore(c.path), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'CORRUPT');
  });

  it("P3-1: a validator cannot cite another validator's evidence package", () => {
    const c = buildCircuit();
    const challenge = issue(c, 'G01', [c.validators.A, c.validators.B]);
    const a = submit(c, observe(c, c.validators.A, challenge));
    assert.ok(a.accepted);
    const aPackage = c.store.getObservation(a.observation.eventId)!.evidenceDigest;
    assert.deepEqual(submit(c, observe(c, c.validators.B, challenge, { mutate: (o) => (o['evidenceDigest'] = aPackage) })), { accepted: false, reason: 'EVIDENCE_MISSING' });
    c.cleanup();
  });
});
