import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { authenticateStoredObservation } from '../conformance/evidence.js';
import { FederationError } from '../conformance/federation-registry.js';
import { CredentialLifecycleError, loadEngineInput, positivelyEligible } from '../conformance/lifecycle.js';
import { CONFORMANCE_NETWORK_ORGANIZATION } from '../conformance/registry.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ORG_A, activeCredential, approvals, buildCircuit, cleanupAll, issue, observe, runBaseline, submit, testingAuthorizationFor, type Circuit } from './conformance-support.js';
import { REFERENCE_FIXTURE_REF } from './conformance-reference-pep.js';
import { cleanupReferenceCircuits } from './conformance-reference-support.js';
import { FED_REQUALIFICATION_AUTHORIZATION, adoptGeneration, drain, enrollGeneration, standardFederation, type Federation } from './conformance-federation-support.js';

/**
 * RN-CONFORM-07A — post-revocation evidence eligibility (K-1) and validator reinstatement safety (K-2). Founder policy B:
 * historical authenticity is permanent; protective eligibility survives revocation under the unchanged engine rules;
 * positive eligibility (issuance, reinstatement, a positive determination for a non-ACTIVE credential) requires the
 * observation's own authorization to be unrevoked and unexpired at the decision. Real SQLite throughout.
 */

after(() => {
  cleanupAll();
  cleanupReferenceCircuits();
});

const refused = (code: string) => (e: unknown) => e instanceof CredentialLifecycleError && e.code === code;
const revoke = (c: Circuit) => c.services().registry.revokeTestingAuthorization(ORG_A, testingAuthorizationFor(c), 'consent withdrawn (test)');
const rows = (c: Circuit) => c.store.listObservations(ORG_A, c.integration.integrationDigest);
const confirmedViolations = (c: Circuit) => {
  const db = new Database(c.path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM cc_confirmed_violations').get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const candidateWithBaseline = (c: Circuit) => {
  const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
  runBaseline(c, [c.validators.A, c.validators.B]);
  c.clock.advance(1);
  return credential.credentialId;
};
const remediation = (c: Circuit) => ({ statement: 'Synthetic fixture enforcement restored.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() });

describe('RN-CONFORM-07A K-1 — positive eligibility after revocation (matrix 1–5, 9, 10, 14–16)', () => {
  it('1–3: conformant evidence accepted before revocation cannot issue a credential (prepare and commit-time recheck)', () => {
    const c = buildCircuit();
    const credentialId = candidateWithBaseline(c);
    const { lifecycle } = c.services();
    assert.equal(lifecycle.assess(ORG_A, credentialId)!.engine.proposal.kind, 'ELIGIBLE_FOR_ACTIVE', 'eligible while consent stands');
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId });
    revoke(c);
    // Prepared before the revocation, approved after it: refused at commit (re-evaluated inside the write transaction).
    assert.throws(() => lifecycle.commit(prepared, approvals(c, prepared)), refused('NO_LONGER_ELIGIBLE'));
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), refused('NOT_ELIGIBLE'));
    assert.equal(c.store.getHead(ORG_A, credentialId)!.state, 'CANDIDATE');
    c.cleanup();
  });

  it('4: a suspended credential cannot be reinstated on revalidation evidence whose authorization was revoked', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const { lifecycle } = c.services();
    c.platform.bypass = 'unauthorized-operation';
    const v = issue(c, 'G01', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, v));
    submit(c, observe(c, c.validators.B, v));
    lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(c.store.getHead(ORG_A, credentialId)!.state, 'SUSPENDED');
    c.platform.bypass = 'none';
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    assert.ok(lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) }), 'eligible before revocation');
    revoke(c);
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: remediation(c) }), refused('NOT_ELIGIBLE'));
    assert.equal(c.store.getHead(ORG_A, credentialId)!.state, 'SUSPENDED');
    c.cleanup();
  });

  it('5, 14, 15: no positive re-evaluation from that evidence — in the same millisecond, and after a restart', () => {
    const c = buildCircuit();
    const credentialId = candidateWithBaseline(c);
    const sameMs = c.clock.ms();
    revoke(c); // same millisecond as the evaluation below; ordering is by the durable revocation commit
    for (const phase of ['live', 'after-restart']) {
      if (phase === 'after-restart') c.reopen();
      const loaded = loadEngineInput(c.store, c.profiles, ORG_A, credentialId, c.clock.now(), c.coordinatorPublicKeyPem)!;
      assert.equal(loaded.unauthenticated.length, 0, `${phase}: revocation never makes evidence tampered`);
      assert.equal(loaded.input.observations.filter((o) => o.outcomeClass === 'conformant').length, 0, `${phase}: no conformant evidence reaches a positive evaluation`);
      assert.equal(loaded.positivelyIneligible.length, rows(c).filter((r) => r.outcomeClass === 'conformant').length);
      assert.ok(loaded.positivelyIneligible.length > 0);
      assert.equal(c.services().lifecycle.assess(ORG_A, credentialId)!.engine.proposal.kind, 'NONE');
      for (const row of rows(c)) {
        assert.equal(authenticateStoredObservation(c.store, c.profiles, row, c.coordinatorPublicKeyPem), null, `${phase}: historically authentic`);
        if (row.outcomeClass === 'conformant') assert.equal(positivelyEligible(c.store, row.eventId, sameMs), false);
      }
    }
    c.cleanup();
  });

  it('9: expiry restricts positive eligibility exactly at the authorization end, independent of evidence freshness', () => {
    const c = buildCircuit();
    candidateWithBaseline(c);
    const row = rows(c).find((r) => r.outcomeClass === 'conformant')!;
    const authorization = c.store.getTestingAuthorization(c.store.getObservationPurpose(row.eventId)!.authorizationId!)!;
    assert.equal(positivelyEligible(c.store, row.eventId, authorization.notAfterMs), true);
    assert.equal(positivelyEligible(c.store, row.eventId, authorization.notAfterMs + 1), false);
    c.cleanup();
  });

  it('10, 16: a replacement authorization does not re-qualify old evidence; new evidence needs two distinct operators', () => {
    const c = buildCircuit();
    const credentialId = candidateWithBaseline(c);
    const old = rows(c).map((r) => r.eventId);
    revoke(c);
    const replacement = testingAuthorizationFor(c); // supersedes the revoked one (version + 1)
    assert.equal(c.store.getTestingAuthorization(replacement)!.record.version, 2);
    for (const id of old) assert.equal(positivelyEligible(c.store, id, c.clock.ms()), false, 'evidence keeps the authorization it was accepted under');
    assert.equal(c.services().lifecycle.assess(ORG_A, credentialId)!.engine.proposal.kind, 'NONE');
    // Two validators of ONE operator are one operator: still not eligible.
    c.clock.advance(60);
    runBaseline(c, [c.validators.A, c.validators.A2]);
    c.clock.advance(1);
    assert.throws(() => c.services().lifecycle.prepare('issue', { organizationId: ORG_A, credentialId }), refused('NOT_ELIGIBLE'));
    // A second, distinct operator under the replacement authorization: eligible again, issuance succeeds.
    runBaseline(c, [c.validators.B]);
    c.clock.advance(1);
    const prepared = c.services().lifecycle.prepare('issue', { organizationId: ORG_A, credentialId });
    assert.equal(c.services().lifecycle.commit(prepared, approvals(c, prepared)).state, 'ACTIVE');
    c.cleanup();
  });
});

describe('RN-CONFORM-07A K-1 — protective eligibility and no false suspension (matrix 6–8, 17, 18)', () => {
  it('6, 7: a genuine pre-revocation violation stays verifiable and still produces the protective SR-1 suspension', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    c.platform.bypass = 'unauthorized-operation';
    const v = issue(c, 'G01', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, v));
    submit(c, observe(c, c.validators.B, v));
    revoke(c);
    const violations = rows(c).filter((r) => r.outcomeClass === 'violation');
    assert.equal(violations.length, 2);
    for (const r of violations) assert.equal(authenticateStoredObservation(c.store, c.profiles, r, c.coordinatorPublicKeyPem), null);
    const out = c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.deepEqual(out.evaluation.proposal, { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' });
    assert.equal(c.store.getHead(ORG_A, credentialId)!.state, 'SUSPENDED');
    c.cleanup();
  });

  it('6b: a violation keeps its protective force for a non-ACTIVE credential too (never withheld)', () => {
    const c = buildCircuit();
    const credentialId = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest }).credentialId;
    c.platform.bypass = 'unauthorized-operation';
    const v = issue(c, 'G01', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, v));
    submit(c, observe(c, c.validators.B, v));
    revoke(c);
    const loaded = loadEngineInput(c.store, c.profiles, ORG_A, credentialId, c.clock.now(), c.coordinatorPublicKeyPem)!;
    assert.equal(loaded.input.observations.filter((o) => o.outcomeClass === 'violation').length, 2);
    assert.ok(c.services().lifecycle.assess(ORG_A, credentialId)!.engine.criticalFailureConfirmed);
    c.cleanup();
  });

  it('8, 17, 18: revocation alone fabricates no failure, no T4 suspension, and leaves signed history verifiable', () => {
    const c = buildCircuit();
    const credentialId = activeCredential(c);
    const violationsBefore = confirmedViolations(c);
    const historyBefore = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    revoke(c);
    for (const step of [0, 60, 600]) {
      c.clock.advance(step);
      const out = c.services().lifecycle.evaluate(ORG_A, credentialId);
      assert.notEqual(out.evaluation.proposal.kind, 'SUSPEND', `+${step}s: no suspension from withdrawn consent`);
      assert.ok(out.engine.requirementResults.every((r) => r.category !== 'VERIFIED_FAILURE'));
      assert.equal(out.protectiveTransition, null);
    }
    assert.equal(c.store.getHead(ORG_A, credentialId)!.state, 'ACTIVE');
    assert.equal(confirmedViolations(c), violationsBefore, 'no violation record fabricated');
    const history = verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
    assert.ok(history.valid && historyBefore.valid);
    assert.deepEqual([history.stateVersion, history.headTransitionDigest], [historyBefore.stateVersion, historyBefore.headTransitionDigest]);
    c.cleanup();
  });
});

describe('RN-CONFORM-07A K-2 — validator reinstatement needs the authoritative requalification authorization (matrix 11–13)', () => {
  const pending = async (seed: string, faults?: { beforeReinstatementCommit?: () => void }) => {
    const f = standardFederation(seed, faults);
    f.registry.quarantineValidator('vb1', 'PROTOCOL_VIOLATIONS');
    const { generation, key } = enrollGeneration(f, 'vb1', 'REINSTATE');
    adoptGeneration(f, 'vb1', generation, key);
    const r = f.scheduler.scheduleRequalification({ validatorId: 'vb1', generation: 2, authorizationId: FED_REQUALIFICATION_AUTHORIZATION, challengeType: 'G01', operation: 'document.open', fixtureRef: REFERENCE_FIXTURE_REF });
    if (!r.scheduled) throw new Error(r.reason);
    await drain(f);
    assert.equal(f.fed.getJob(r.job.jobId)?.state, 'COMPLETED');
    return { f, jobId: r.job.jobId };
  };
  const revokeRequalification = (f: Federation) => f.c.services().registry.revokeTestingAuthorization(CONFORMANCE_NETWORK_ORGANIZATION, FED_REQUALIFICATION_AUTHORIZATION, 'consent withdrawn (test)');
  const failedWith = (detail: string) => (e: unknown) => e instanceof FederationError && e.code === 'REQUALIFICATION_FAILED' && e.detail === detail;

  it('11: revoked after the requalification completed, before reinstatement: refused (the federation mirror is not enough)', async () => {
    const { f, jobId } = await pending('rn07a-k2-revoked');
    revokeRequalification(f);
    assert.ok(f.fed.getAuthorization(FED_REQUALIFICATION_AUTHORIZATION) !== undefined, 'the mirror still exists');
    assert.throws(() => f.registry.completeReinstatement('vb1', 2, jobId), failedWith('AUTHORIZATION_REVOKED'));
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
  });

  it('12: expired before reinstatement: refused', async () => {
    const { f, jobId } = await pending('rn07a-k2-expired');
    const authorization = f.c.store.getTestingAuthorization(FED_REQUALIFICATION_AUTHORIZATION)!;
    f.c.clock.advance(Math.ceil((authorization.notAfterMs - f.c.clock.ms()) / 1000) + 1);
    assert.throws(() => f.registry.completeReinstatement('vb1', 2, jobId), failedWith('AUTHORIZATION_EXPIRED'));
    assert.equal(f.registry.validatorState('vb1'), 'QUARANTINED');
  });

  it('13: a revocation landing between the checks and the commit fails closed; without it the reinstatement succeeds', async () => {
    let hook: (() => void) | undefined;
    const raced = await pending('rn07a-k2-race', { beforeReinstatementCommit: () => hook?.() });
    hook = () => revokeRequalification(raced.f);
    assert.throws(() => raced.f.registry.completeReinstatement('vb1', 2, raced.jobId), failedWith('AUTHORIZATION_REVOKED'));
    assert.equal(raced.f.registry.validatorState('vb1'), 'QUARANTINED');
    assert.notEqual(raced.f.c.store.getTestingAuthorization(FED_REQUALIFICATION_AUTHORIZATION)!.revokedSeq, null, 'the revocation itself committed');

    const control = await pending('rn07a-k2-control');
    control.f.registry.completeReinstatement('vb1', 2, control.jobId);
    assert.equal(control.f.registry.validatorState('vb1'), 'ACTIVE');
  });
});
