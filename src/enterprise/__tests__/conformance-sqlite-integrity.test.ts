import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance, conformanceDigest } from '../conformance/canonical.js';
import type { EvaluationRecord, TransitionRecord } from '../conformance/contracts.js';
import { createCredentialLifecycle, signTransition } from '../conformance/lifecycle.js';
import { ConformanceStoreError, openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { verifyCredentialHistory, verifyCurrentConformance } from '../conformance/verifier.js';
import { ORG_A, activeCredential, buildCircuit, cleanupAll, expectation, issue, observe, submit, verdict, type Circuit } from './conformance-support.js';

/**
 * RN-CONFORM-02 §8 — the SQLite atomicity acceptance gate, against the real
 * SQLite layer (no mocked repository).
 *
 * Every "direct" attempt below uses a second, raw better-sqlite3 connection
 * with foreign keys explicitly OFF, i.e. without the store's code
 * and without its connection settings. The invariants hold because they are
 * enforced by triggers, which every connection runs.
 */

after(cleanupAll);

const raw = (c: Circuit) => {
  const db = new Database(c.path);
  db.pragma('busy_timeout = 2000');
  // better-sqlite3 turns foreign keys on by default; an arbitrary SQLite client need not. The invariants must not depend on it.
  db.pragma('foreign_keys = OFF');
  return db;
};

/** Accepted violation observations of G01 by validators A and B (two synthetic operators) after switching the fixture to the bypass. */
const corroboratedViolation = (c: Circuit) => {
  c.platform.bypass = 'unauthorized-operation';
  const challenge = issue(c, 'G01', [c.validators.A, c.validators.B]);
  assert.ok(submit(c, observe(c, c.validators.A, challenge)).accepted);
  c.clock.advance(60);
  assert.ok(submit(c, observe(c, c.validators.B, challenge)).accepted);
};

const counts = (c: Circuit) => {
  const db = raw(c);
  try {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { evaluations: n('cc_evaluations'), transitions: n('cc_transitions') };
  } finally {
    db.close();
  }
};

const insertEvaluationSql = `INSERT INTO cc_evaluations (evaluation_id, credential_id, evaluated_at_ms, credential_state_version, critical_failure, requires_suspension, eligible_for_active, evaluation_digest, record_json,
  pt_transition_id, pt_reason_code, pt_rule_id, pt_previous_digest, pt_transition_digest, pt_effective_at_ms, pt_record_json, pt_signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function forgedCriticalEvaluation(c: Circuit, credentialId: string, template: EvaluationRecord, id: string): { record: EvaluationRecord; json: string; digest: string } {
  const head = c.store.getHead(ORG_A, credentialId)!;
  const record: EvaluationRecord = { ...template, evaluationId: id, credentialStateVersion: head.stateVersion, criticalFailureConfirmed: true, proposal: { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' } };
  return { record, json: canonicalizeConformance(record), digest: conformanceDigest(record) };
}

describe('RN-CONFORM-02 SQLite atomicity gate (§8)', () => {
  it('1. refuses a direct INSERT of a confirmed critical failure without the suspension (raw connection and store path)', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    const monitor = lifecycle.evaluate(ORG_A, credentialId).evaluation;
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE');
    const before = counts(c);
    const forged = forgedCriticalEvaluation(c, credentialId, monitor, 'evl_forged_1');
    const db = raw(c);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 0, 'the attacker connection does not even enforce foreign keys');
    assert.throws(
      () => db.prepare(insertEvaluationSql).run(forged.record.evaluationId, credentialId, Date.parse(forged.record.evaluatedAt), forged.record.credentialStateVersion, 1, 1, 0, forged.digest, forged.json, null, null, null, null, null, null, null, null),
      /cc:critical failure without suspension/,
    );
    // Hiding the flag in the column but not the JSON is refused too.
    assert.throws(
      () => db.prepare(insertEvaluationSql).run('evl_forged_2', credentialId, Date.parse(forged.record.evaluatedAt), forged.record.credentialStateVersion, 0, 0, 0, conformanceDigest({ x: 2 }), forged.json.replace('evl_forged_1', 'evl_forged_2'), null, null, null, null, null, null, null, null),
      /cc:evaluation json mismatch/,
    );
    db.close();
    // The store's own write path refuses the same thing.
    assert.throws(() => c.store.commitEvaluation({ record: { ...forged.record, evaluationId: 'evl_forged_3' }, evaluationDigest: conformanceDigest({ ...forged.record, evaluationId: 'evl_forged_3' }), protectiveTransition: null }), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'INVARIANT_REFUSED');
    assert.deepEqual(counts(c), before);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE');
    c.cleanup();
  });

  it('2. commits the critical failure, the ACTIVE → SUSPENDED transition and the head in one unit', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    corroboratedViolation(c);
    const before = counts(c);
    const { evaluation, protectiveTransition } = c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(evaluation.criticalFailureConfirmed, true);
    assert.ok(protectiveTransition);
    assert.equal(protectiveTransition.record.evaluationId, evaluation.evaluationId);
    assert.deepEqual(counts(c), { evaluations: before.evaluations + 1, transitions: before.transitions + 1 });
    const head = c.store.getHead(ORG_A, credentialId)!;
    assert.deepEqual([head.state, head.stateVersion, head.reasonCode, head.headTransitionDigest], ['SUSPENDED', 3, 'CRITICAL_VIOLATION_CONFIRMED', protectiveTransition.transitionDigest]);
    c.cleanup();
  });

  it('3. rolls back the evaluation when anything fails before commit (fault after the insert; fault inside the transition chain)', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    corroboratedViolation(c);
    const before = counts(c);
    const { lifecycle } = c.services();
    assert.throws(() => lifecycle.evaluate(ORG_A, credentialId, { faultHook: () => { throw new Error('injected fault between evaluation and commit'); } }), /injected fault/);
    assert.deepEqual(counts(c), before);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE', 'no confirmed failure was committed, so ACTIVE is still consistent');

    // A real SQLite failure inside the cascade (head update), injected through a second connection.
    const db = raw(c);
    db.exec(`CREATE TRIGGER zz_injected_fault BEFORE UPDATE ON cc_heads BEGIN SELECT RAISE(ABORT, 'injected head failure'); END;`);
    assert.throws(() => lifecycle.evaluate(ORG_A, credentialId), /injected head failure/);
    assert.deepEqual(counts(c), before, 'evaluation and transition rolled back with the head update');
    db.exec('DROP TRIGGER zz_injected_fault');
    db.close();
    lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'SUSPENDED');
    c.cleanup();
  });

  it('4. serializes concurrent writers and refuses stale PASS and duplicate failure commits (no lost update)', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const passTemplate = c.services().lifecycle.evaluate(ORG_A, credentialId).evaluation;
    assert.equal(passTemplate.proposal.kind, 'NONE');
    corroboratedViolation(c);
    const second = openConformanceStore(c.path, { busyTimeoutMs: 0 });
    const lifecycleB = createCredentialLifecycle({ store: second, profiles: c.profiles, clock: c.clock, random: c.random, registryKey: c.registryKey, humans: c.humansDirectory });
    let duringWrite: { busy: boolean; committedState: string | undefined; verdictReason: string } = { busy: false, committedState: undefined, verdictReason: '' };

    const { protectiveTransition } = c.services().lifecycle.evaluate(ORG_A, credentialId, {
      faultHook: () => {
        // While A holds the write transaction: B cannot write, and B's reads see only committed state.
        try {
          lifecycleB.evaluate(ORG_A, credentialId);
        } catch (error) {
          duringWrite.busy = (error as { code?: string }).code === 'STORE_BUSY';
        }
        duringWrite = {
          ...duringWrite,
          committedState: second.getHead(ORG_A, credentialId)?.state,
          verdictReason: verifyCurrentConformance({ store: second, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem }, expectation(c, credentialId), c.clock.now()).reason,
        };
      },
    });
    assert.ok(protectiveTransition);
    assert.equal(duringWrite.busy, true, 'the second writer was refused while the first held the lock');
    assert.equal(duringWrite.committedState, 'ACTIVE', 'an uncommitted suspension is not visible');
    assert.equal(duringWrite.verdictReason, 'PROTECTIVE_ACTION_PENDING', 'but the fail-closed verifier already refuses to assert conformance');

    // A PASS computed against the old ACTIVE head (stateVersion 2) is refused: it cannot retain or restore ACTIVE.
    const stalePass: EvaluationRecord = { ...passTemplate, evaluationId: 'evl_stale_pass' };
    assert.throws(() => second.commitEvaluation({ record: stalePass, evaluationDigest: conformanceDigest(stalePass), protectiveTransition: null }), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'CAS_CONFLICT');

    // A second critical failure computed against the same old head, with its own protective transition, is refused too.
    const duplicateEval: EvaluationRecord = { ...stalePass, evaluationId: 'evl_dup_fail', criticalFailureConfirmed: true, proposal: { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' } };
    const duplicateTransition = signTransition({ ...protectiveTransition.record, transitionId: 'trn_dup', evaluationId: 'evl_dup_fail', evaluationDigest: conformanceDigest(duplicateEval) }, c.registryKey);
    assert.throws(() => second.commitEvaluation({ record: duplicateEval, evaluationDigest: conformanceDigest(duplicateEval), protectiveTransition: duplicateTransition }), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'CAS_CONFLICT');

    // Exactly one head; B, re-reading, records the failure against SUSPENDED without a second transition.
    lifecycleB.evaluate(ORG_A, credentialId);
    const head = second.getHead(ORG_A, credentialId)!;
    assert.deepEqual([head.state, head.stateVersion], ['SUSPENDED', 3]);
    assert.equal(second.listTransitions(ORG_A, credentialId).length, 3);
    second.close();
    c.cleanup();
  });

  it('5–6. the verifier reads only the committed head, before and after a reopen', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    assert.equal(verdict(c, credentialId).reason, 'CONFORMANT');
    corroboratedViolation(c);
    c.services().lifecycle.evaluate(ORG_A, credentialId);
    const v = verdict(c, credentialId);
    assert.deepEqual([v.conformant, v.reason, v.state, v.stateVersion], [false, 'NOT_ACTIVE', 'SUSPENDED', 3]);
    c.reopen();
    const reopened = verdict(c, credentialId);
    assert.deepEqual([reopened.conformant, reopened.reason, reopened.state, reopened.stateVersion], [false, 'NOT_ACTIVE', 'SUSPENDED', 3]);
    assert.equal(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid, true);
    c.cleanup();
  });

  it('7. refuses every bypass through raw SQL or alternate store methods', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    corroboratedViolation(c);
    c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(submit(c, '{not json').accepted, false, 'one retained rejection row');
    const db = raw(c);
    const head = c.store.getHead(ORG_A, credentialId)!;
    const refuse = (sql: string, params: unknown[], pattern: RegExp) => assert.throws(() => db.prepare(sql).run(...params), pattern, sql);

    // The head cannot be set back to ACTIVE, nor moved without a matching transition.
    refuse("UPDATE cc_heads SET state = 'ACTIVE' WHERE credential_id = ?", [credentialId], /cc:head must equal the latest transition/);
    refuse("UPDATE cc_heads SET state = 'ACTIVE', state_version = state_version + 1 WHERE credential_id = ?", [credentialId], /cc:head must equal the latest transition/);
    refuse('DELETE FROM cc_heads WHERE credential_id = ?', [credentialId], /cc:immutable cc_heads/);

    // Immutable rows: UPDATE and DELETE refused on every forward-only table.
    for (const table of ['cc_transitions', 'cc_evaluations', 'cc_observations', 'cc_consumed_decisions', 'cc_challenges', 'cc_validators', 'cc_credentials', 'cc_rejections', 'cc_integrations', 'cc_profiles', 'cc_evidence_packages']) {
      refuse(`UPDATE ${table} SET rowid = rowid`, [], new RegExp(`cc:immutable ${table}`));
      refuse(`DELETE FROM ${table}`, [], new RegExp(`cc:immutable ${table}`));
    }

    // A forged SUSPENDED → ACTIVE transition: no eligible evaluation, no humans.
    const last = JSON.parse(c.store.listTransitions(ORG_A, credentialId).at(-1)!.recordJson) as TransitionRecord;
    const forged: TransitionRecord = { ...last, transitionId: 'trn_forged', stateVersion: head.stateVersion + 1, previousTransitionDigest: head.headTransitionDigest, from: 'SUSPENDED', to: 'ACTIVE', transitionCode: 'T5', reasonCode: 'FORGED', ruleId: 'none', evaluationId: null, evaluationDigest: null };
    const signed = signTransition(forged, c.registryKey);
    const insertTransition = 'INSERT INTO cc_transitions (credential_id, state_version, transition_id, from_state, to_state, transition_code, reason_code, rule_id, evaluation_id, previous_transition_digest, transition_digest, action_binding_digest, effective_at_ms, record_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const row = (t: typeof signed, sv = t.record.stateVersion) => [credentialId, sv, t.record.transitionId, t.record.from, t.record.to, t.record.transitionCode, t.record.reasonCode, t.record.ruleId, t.record.evaluationId, t.record.previousTransitionDigest, t.transitionDigest, t.record.actionBindingDigest, Date.parse(t.record.effectiveAt), canonicalizeConformance(t.record), canonicalizeConformance(t.registrySignature)];
    refuse(insertTransition, row(signed), /cc:activation without eligible evaluation/);
    // The same through the store's alternate write method.
    assert.throws(() => c.store.commitTransition({ evaluation: null, decisions: [], transition: signed }), (e: unknown) => e instanceof ConformanceStoreError && /activation without eligible evaluation/.test(e.detail));

    // A state-version gap, and a stale/conflicting state version (the CAS).
    const gap = signTransition({ ...forged, transitionId: 'trn_gap', stateVersion: head.stateVersion + 2, to: 'REVOKED', transitionCode: 'T6', reasonCode: 'SUSPENSION_TIMEOUT' }, c.registryKey);
    refuse(insertTransition, row(gap), /cc:state version gap/);
    const stale = signTransition({ ...forged, transitionId: 'trn_stale', stateVersion: head.stateVersion, to: 'REVOKED', transitionCode: 'T6', reasonCode: 'SUSPENSION_TIMEOUT' }, c.registryKey);
    refuse(insertTransition, row(stale), /cc:stale head/);
    // An early automatic revocation (the timeout has not elapsed) and a revocation without humans.
    const early = signTransition({ ...forged, transitionId: 'trn_early', to: 'REVOKED', transitionCode: 'T6', reasonCode: 'SUSPENSION_TIMEOUT' }, c.registryKey);
    refuse(insertTransition, row(early), /cc:revocation requires two humans or the suspension timeout/);
    const noHumans = signTransition({ ...forged, transitionId: 'trn_nohumans', to: 'REVOKED', transitionCode: 'T6', reasonCode: 'PLATFORM_REQUEST', actionBindingDigest: conformanceDigest({ a: 1 }) }, c.registryKey);
    refuse(insertTransition, row(noHumans), /cc:revocation requires two humans/);
    // A transition outside the lifecycle (SUSPENDED → CANDIDATE).
    const backwards = signTransition({ ...forged, transitionId: 'trn_back', to: 'CANDIDATE', transitionCode: 'T1' }, c.registryKey);
    refuse(insertTransition, row(backwards), /cc:transition not allowed/);
    // A suspension that did not come from an evaluation.
    refuse(insertTransition, row(signTransition({ ...forged, transitionId: 'trn_sus', from: 'SUSPENDED', to: 'SUSPENDED', transitionCode: 'T4' }, c.registryKey)), /cc:transition not allowed|cc:suspension without evaluation/);
    db.close();

    assert.deepEqual([c.store.getHead(ORG_A, credentialId)?.state, c.store.getHead(ORG_A, credentialId)?.stateVersion], ['SUSPENDED', 3]);
    c.cleanup();
  });
});

describe('RN-CONFORM-02 history integrity (WP-08, WP-10, §9)', () => {
  it('detects transition-digest tampering, previous-digest mismatch and a dropped trigger set', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    corroboratedViolation(c);
    c.services().lifecycle.evaluate(ORG_A, credentialId);
    const opts = { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory };
    assert.equal(verifyCredentialHistory(c.store, ORG_A, credentialId, opts).valid, true);

    // Simulate a privileged writer: drop the immutability trigger on a raw connection (triggers do not stop this; detection must).
    const db = raw(c);
    db.exec('DROP TRIGGER cc_transitions_no_update');
    const rows = c.store.listTransitions(ORG_A, credentialId);
    const t3 = rows[2]!;
    db.prepare('UPDATE cc_transitions SET record_json = ? WHERE credential_id = ? AND state_version = 3').run(t3.recordJson.replace('CRITICAL_VIOLATION_CONFIRMED', 'EVIDENCE_STALE'), credentialId);
    const tampered = verifyCredentialHistory(c.store, ORG_A, credentialId, opts);
    assert.deepEqual(tampered, { valid: false, failure: 'TRANSITION_DIGEST_MISMATCH', atStateVersion: 3 });

    // Even with the registry key (worst case), a record whose previous digest does not chain is detected.
    const record = JSON.parse(t3.recordJson) as TransitionRecord;
    const rechained = signTransition({ ...record, previousTransitionDigest: `sha256:${'f'.repeat(64)}` }, c.registryKey);
    db.prepare('UPDATE cc_transitions SET record_json = ?, transition_digest = ?, signature_json = ?, previous_transition_digest = ? WHERE credential_id = ? AND state_version = 3').run(
      canonicalizeConformance(rechained.record), rechained.transitionDigest, canonicalizeConformance(rechained.registrySignature), rechained.record.previousTransitionDigest, credentialId,
    );
    const mismatch = verifyCredentialHistory(c.store, ORG_A, credentialId, opts);
    assert.equal(mismatch.valid, false);
    assert.ok(!mismatch.valid && ['PREVIOUS_DIGEST_MISMATCH', 'HEAD_MISMATCH'].includes(mismatch.failure));
    assert.equal(verdict(c, credentialId).reason, 'HISTORY_INVALID');
    db.close();

    // The store refuses to reopen a file whose trigger set is not exactly its own.
    c.store.close();
    assert.throws(() => openConformanceStore(c.path), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'CORRUPT');
  });

  it('detects a forged signature without the registry key, and an unknown registry key', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const db = raw(c);
    db.exec('DROP TRIGGER cc_transitions_no_update');
    const t2 = c.store.listTransitions(ORG_A, credentialId)[1]!;
    const record = JSON.parse(t2.recordJson) as TransitionRecord;
    const altered = { ...record, ruleId: 'altered' };
    // The attacker recomputes the digest but cannot sign.
    db.prepare('UPDATE cc_transitions SET record_json = ?, transition_digest = ? WHERE credential_id = ? AND state_version = 2').run(canonicalizeConformance(altered), conformanceDigest(altered), credentialId);
    db.close();
    const result = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem });
    assert.equal(result.valid, false);
    assert.ok(!result.valid && ['SIGNATURE_INVALID', 'HEAD_MISMATCH'].includes(result.failure));
    c.cleanup();
  });

  it('replays valid stored history deterministically after restart', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const first = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    c.reopen();
    const second = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    assert.deepEqual(second, first);
    assert.ok(first.valid && first.stateVersion === 2 && first.state === 'ACTIVE');
    c.cleanup();
  });

  it('scopes every read by organization', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    assert.equal(c.store.getCredential('org-synthetic-beta', credentialId), undefined);
    assert.equal(c.store.getHead('org-synthetic-beta', credentialId), undefined);
    assert.deepEqual(c.store.listTransitions('org-synthetic-beta', credentialId), []);
    assert.deepEqual(c.store.listEvaluations('org-synthetic-beta', credentialId), []);
    assert.equal(verifyCurrentConformance({ store: c.store, profiles: c.profiles, registryPublicKeyPem: c.registryPublicKeyPem }, { ...expectation(c, credentialId), organizationId: 'org-synthetic-beta' }, c.clock.now()).reason, 'CREDENTIAL_NOT_FOUND');
    c.cleanup();
  });
});
