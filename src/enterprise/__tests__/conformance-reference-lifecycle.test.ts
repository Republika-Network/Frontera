import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import type { TransitionRecord } from '../conformance/contracts.js';
import { CredentialLifecycleError } from '../conformance/lifecycle.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ORG_A } from './conformance-support.js';
import {
  activeReferenceCredential,
  assertionOf,
  buildReferenceCircuit,
  cleanupReferenceCircuits,
  issueReference,
  observeReference,
  referenceApprovals,
  referenceStatus,
  runReferenceBaseline,
  type ReferenceCircuit,
} from './conformance-reference-support.js';

/**
 * RN-CONFORM-04 / WP-06, WP-09 — Scenarios A–E on the synthetic reference PEP, through the RN-CONFORM-02 lifecycle and the
 * RN-CONFORM-03 signed status, both unchanged. (Scenario F, operation scoping, is in conformance-reference-coverage.)
 */

after(() => cleanupReferenceCircuits());

const nonce = () => randomBytes(32).toString('base64url');
const head = (c: ReferenceCircuit, id: string) => c.store.getHead(ORG_A, id)!;
const lifecycleError = (code: string) => (e: unknown) => e instanceof CredentialLifecycleError && e.code === code;
/** The signature-verified transition history (RN-CONFORM-02 verifier), as `version:code:from→to:reason`. */
const history = (c: ReferenceCircuit, id: string) => {
  const verified = verifyCredentialHistory(c.store, ORG_A, id, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
  assert.ok(verified.valid, 'the history verifies');
  return verified.transitions.map((r: TransitionRecord) => `${r.stateVersion}:${r.transitionCode}:${r.from ?? '∅'}→${r.to}:${r.reasonCode}`);
};

/** Scenario B: validator A, then validator B of a distinct operator, observe the export bypass; returns both evaluations. */
async function corroborateExportBypass(c: ReferenceCircuit, id: string, advanceFirst = true) {
  const { lifecycle } = c.services();
  if (advanceFirst) c.clock.advance(2 * 3600);
  c.deployment.defects.add('BYPASS-01');
  c.deployment.defectOperations.add('document.export');
  const g01 = issueReference(c, 'G01', [c.validators.A, c.validators.B], 'document.export');
  assert.equal((await observeReference(c, c.validators.A, g01)).result.accepted, true);
  const first = lifecycle.evaluate(ORG_A, id);
  c.clock.advance(5 * 60);
  assert.equal((await observeReference(c, c.validators.B, g01)).result.accepted, true);
  const confirmed = lifecycle.evaluate(ORG_A, id);
  return { first, confirmed };
}

describe('RN-CONFORM-04 — Scenarios A–D: conformant → bypass → automatic suspension → remediation → reinstatement', () => {
  it('runs end to end with signed status at every stage', async () => {
    const c = buildReferenceCircuit();
    const s = referenceStatus(c);
    const { lifecycle } = c.services();
    const online = s.verifierStore('online-verifier');

    // Scenario A — the full matrix, two distinct operators, two humans: ACTIVE, and a CONFORMANT online assertion.
    const id = await activeReferenceCredential(c);
    assert.deepEqual([head(c, id).state, head(c, id).stateVersion], ['ACTIVE', 2]);
    const n1 = nonce();
    const a1 = assertionOf(s.registry.issueOnline(s.onlineRequest(id, n1)));
    const v1 = s.verify(a1, id, { kind: 'online', nonce: n1 }, { store: online });
    // `stateVersion` is the credential's; `sequence` is the status registry's own monotonic assertion counter.
    assert.deepEqual([v1.result, v1.state, v1.stateVersion], ['CONFORMANT', 'ACTIVE', 2]);
    for (const operation of ['document.export', 'document.modify-protected-terms']) {
      const n = nonce();
      assert.equal(s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, n, operation))), id, { kind: 'online', nonce: n }, { operation }).result, 'CONFORMANT', operation);
    }
    const ns = nonce();
    const excluded = s.registry.issueOnline(s.onlineRequest(id, ns, 'document.share'));
    assert.notEqual(excluded.kind === 'assertion' ? s.verify(excluded.text, id, { kind: 'online', nonce: ns }, { operation: 'document.share' }).result : 'REFUSED', 'CONFORMANT', 'an excluded operation is never conformant');
    // Scenario B — one validator's observation opens an investigation; it does not suspend and fabricates no quorum.
    c.clock.advance(2 * 3600);
    // A stapled ACTIVE assertion obtained just before the bypass is introduced (≤ 15 min validity).
    const stapledActive = assertionOf(s.registry.stapled(id));
    const { first, confirmed } = await corroborateExportBypass(c, id, false);
    assert.equal(first.protectiveTransition, null);
    assert.equal(first.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, 'UNCONFIRMED_VIOLATION');
    assert.deepEqual(first.evaluation.proposal, { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' });
    // The second, distinct operator corroborates within the window: automatic ACTIVE → SUSPENDED, committed atomically.
    assert.equal(confirmed.evaluation.criticalFailureConfirmed, true);
    assert.ok(confirmed.protectiveTransition, 'suspension needed no human');
    assert.deepEqual([head(c, id).state, head(c, id).stateVersion, head(c, id).reasonCode], ['SUSPENDED', 3, 'CRITICAL_VIOLATION_CONFIRMED']);
    assert.ok(confirmed.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.reasonCodes.some((code) => code.includes('document.export')));

    // Scenario C — a new online assertion says SUSPENDED and is not conformant; the old one cannot be replayed.
    const n2 = nonce();
    const a2 = assertionOf(s.registry.issueOnline(s.onlineRequest(id, n2)));
    const v2 = s.verify(a2, id, { kind: 'online', nonce: n2 }, { store: online });
    assert.deepEqual([v2.result, v2.state, v2.stateVersion, v2.conformant], ['NOT_CONFORMANT', 'SUSPENDED', 3, false]);
    assert.ok((v2.sequence ?? 0) > (v1.sequence ?? 0), 'the status sequence only moves forward');
    // The old online assertion is refused (it has expired), and a current assertion presented for another nonce is refused too.
    assert.equal(s.verify(a1, id, { kind: 'online', nonce: n1 }, { store: online }).result, 'EXPIRED_ASSERTION');
    assert.equal(s.verify(a2, id, { kind: 'online', nonce: n1 }).result, 'NONCE_MISMATCH');
    // The earlier stapled ACTIVE assertion: refused by a verifier that has seen the newer state; a stateless verifier still
    // accepts it until its own validUntil (≤ 15 min) — the documented bound of offline revocation, not instantaneous.
    assert.equal(s.verify(stapledActive, id, { kind: 'stapled' }, { store: online }).result, 'ROLLBACK_DETECTED');
    const stateless = s.verify(stapledActive, id, { kind: 'stapled' });
    assert.equal(stateless.result, 'CONFORMANT', 'a stateless offline verifier cannot know of the suspension yet');
    assert.ok(stateless.remainingValidityMs !== null && stateless.remainingValidityMs <= 15 * 60 * 1000, 'but only within the stapled bound');
    c.clock.advance(15 * 60 + 1);
    assert.equal(s.verify(stapledActive, id, { kind: 'stapled' }).result, 'EXPIRED_ASSERTION');

    // Scenario D — reinstatement needs a remediation statement, full critical revalidation and two distinct humans.
    c.clock.advance(3600);
    c.deployment.defects.clear();
    c.deployment.defectOperations.clear();
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation: { statement: 'Export now routes through the PEP.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } }), lifecycleError('NOT_ELIGIBLE'), 'no revalidation yet');
    await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    assert.throws(() => lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id }), lifecycleError('REMEDIATION_REQUIRED'));
    const reinstatement = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation: { statement: 'Export now routes through the PEP; full critical revalidation completed.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } });
    assert.throws(() => lifecycle.commit(reinstatement, referenceApprovals(c, reinstatement, c.humans.carol, c.humans.carol)), lifecycleError('APPROVAL_REFUSED'), 'one person cannot approve twice');
    const reinstated = lifecycle.commit(reinstatement, referenceApprovals(c, reinstatement, c.humans.carol, c.humans.bob));
    assert.deepEqual([reinstated.state, reinstated.stateVersion], ['ACTIVE', 4]);
    const n3 = nonce();
    const v3 = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, n3))), id, { kind: 'online', nonce: n3 }, { store: online });
    assert.deepEqual([v3.result, v3.state, v3.stateVersion], ['CONFORMANT', 'ACTIVE', 4]);
    assert.ok((v3.sequence ?? 0) > (v2.sequence ?? 0));

    assert.deepEqual(history(c, id), [
      '1:T1:∅→CANDIDATE:INTEGRATION_REGISTERED',
      '2:T2:CANDIDATE→ACTIVE:ALL_CRITICAL_VERIFIED',
      '3:T4:ACTIVE→SUSPENDED:CRITICAL_VIOLATION_CONFIRMED',
      '4:T5:SUSPENDED→ACTIVE:REMEDIATED_AND_REVALIDATED',
    ]);
    s.close();
  });
});

describe('RN-CONFORM-04 — Scenario E: incomplete remediation is refused', () => {
  it('re-running only the failed challenge does not reinstate', async () => {
    const c = buildReferenceCircuit();
    const id = await activeReferenceCredential(c);
    await corroborateExportBypass(c, id);
    c.clock.advance(3600);
    c.deployment.defects.clear();
    c.deployment.defectOperations.clear();
    const g01 = issueReference(c, 'G01', [c.validators.A, c.validators.B], 'document.export');
    await observeReference(c, c.validators.A, g01);
    await observeReference(c, c.validators.B, g01);
    c.clock.advance(1);
    assert.throws(() => c.services().lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation: { statement: 'Fixed export only.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } }), lifecycleError('NOT_ELIGIBLE'));
    assert.equal(head(c, id).state, 'SUSPENDED');
  });

  it('fixing the export bypass while another critical control still fails does not reinstate', async () => {
    const c = buildReferenceCircuit();
    const id = await activeReferenceCredential(c);
    await corroborateExportBypass(c, id);
    c.clock.advance(3600);
    c.deployment.defects.clear();
    c.deployment.defectOperations.clear();
    c.deployment.defects.add('BYPASS-04');
    await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    assert.throws(() => c.services().lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation: { statement: 'Fixed export.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } }), lifecycleError('NOT_ELIGIBLE'));
    assert.equal(head(c, id).state, 'SUSPENDED');
  });
});

describe('RN-CONFORM-04 WP-11 — credential lifecycle adversarial cases', () => {
  it('a deployment drift (BYPASS-08) observed by two operators suspends the credential', async () => {
    const c = buildReferenceCircuit();
    const id = await activeReferenceCredential(c);
    c.clock.advance(3600);
    c.deployment.defects.add('BYPASS-08');
    const g08 = issueReference(c, 'G08', [c.validators.A, c.validators.B]);
    await observeReference(c, c.validators.A, g08);
    await observeReference(c, c.validators.B, g08);
    const result = c.services().lifecycle.evaluate(ORG_A, id);
    assert.ok(result.protectiveTransition);
    assert.deepEqual([head(c, id).state, head(c, id).reasonCode], ['SUSPENDED', 'CRITICAL_VIOLATION_CONFIRMED']);
    assert.equal(result.evaluation.requirementResults.find((r) => r.requirementId === 'CR-08')?.category, 'VERIFIED_FAILURE');
  });

  it('stale evidence suspends after the grace period, and fresh evidence reinstates automatically', async () => {
    const c = buildReferenceCircuit();
    const id = await activeReferenceCredential(c);
    c.clock.advance(24 * 3600 + 6 * 3600 + 60);
    const stale = c.services().lifecycle.evaluate(ORG_A, id);
    assert.ok(stale.protectiveTransition);
    assert.deepEqual([head(c, id).state, head(c, id).reasonCode], ['SUSPENDED', 'EVIDENCE_STALE']);
    await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const back = c.services().lifecycle.reinstateAutomatically(ORG_A, id);
    assert.equal(back.state, 'ACTIVE');
  });

  it('single-operator evidence never makes a credential eligible, and one human cannot issue alone', async () => {
    const c = buildReferenceCircuit();
    const { lifecycle } = c.services();
    const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    // One operator only: never corroborated, never eligible, however many of its validators report.
    await runReferenceBaseline(c, [c.validators.A, c.validators.A2]);
    c.clock.advance(1);
    assert.throws(() => lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId }), lifecycleError('NOT_ELIGIBLE'));
    await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const prepared = lifecycle.prepare('issue', { organizationId: ORG_A, credentialId: credential.credentialId });
    assert.throws(() => lifecycle.commit(prepared, referenceApprovals(c, prepared, c.humans.alice, c.humans.alice)), lifecycleError('APPROVAL_REFUSED'));
    assert.equal(lifecycle.commit(prepared, referenceApprovals(c, prepared)).state, 'ACTIVE');
  });
});
