import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance, conformanceDigest } from '../conformance/canonical.js';
import { toMs, toTimestamp } from '../conformance/contracts.js';
import { AnchorIntentError, anchorPayload, prepareAnchorIntent } from '../conformance/anchor-intent.js';
import { parseStatusArtifact } from '../conformance/status-contracts.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ORG_A, activeCredential, approvals, cleanupAll, issue, observe, runBaseline, submit } from './conformance-support.js';
import { assertionText, buildStatusCircuit, freshNonce } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 §16 — the complete verification scenario, Steps 1–10, in one
 * deterministic run, over the RN-CONFORM-02 synthetic circuit.
 *
 * SYNTHETIC: the issuer, its keys, the validators, operators and humans are
 * synthetic. Nothing here is a real credential, a certification, or a ledger
 * record.
 */

after(cleanupAll);

const stateOf = (text: string) => {
  const parsed = parseStatusArtifact(text);
  assert.ok(parsed.ok && parsed.kind === 'assertion');
  return parsed.artifact;
};

describe('RN-CONFORM-03 signed credential status — end to end (§16)', () => {
  it('ACTIVE → online CONFORMANT → stapled CONFORMANT → SUSPENDED → replay refused → expiry → recovery → updated status → prepared anchor', (t) => {
    const s = buildStatusCircuit();
    const { c, registry } = s;
    const online = s.verifierStore('online-verifier');

    // Step 1 — activate (RN-CONFORM-02: corroborated baseline, two humans).
    const credentialId = activeCredential(c);
    assert.equal(c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE');

    // Step 2 — online verification: fresh nonce, signed ACTIVE, pinned keys, exact subject/profile/operation.
    const n1 = freshNonce();
    const a1 = assertionText(registry.issueOnline(s.onlineRequest(credentialId, n1)));
    const v1 = s.verify(a1, credentialId, { kind: 'online', nonce: n1 }, { store: online });
    assert.deepEqual([v1.conformant, v1.result, v1.state, v1.stateVersion, v1.continuity], [true, 'CONFORMANT', 'ACTIVE', 2, 'FIRST_OBSERVATION']);

    // Step 3 — stapled: ≤ 15 min lifetime, verified offline by a verifier that never contacts the issuer.
    const stapledActive = assertionText(registry.stapled(credentialId));
    const sa = stateOf(stapledActive);
    assert.ok(toMs(sa.validUntil) - toMs(sa.issuedAt) <= 15 * 60_000);
    assert.equal(sa.requestNonce, null);
    assert.equal(s.verify(stapledActive, credentialId, { kind: 'stapled' }).result, 'CONFORMANT');
    assert.equal(assertionText(registry.stapled(credentialId)), stapledActive, 'reused while current');

    // Step 4 — critical violation corroborated by two distinct synthetic operators within 30 minutes → atomic suspension.
    // (Kept within the 5-minute online lifetime of a1, so Step 6 exercises the nonce, not expiry.)
    c.clock.advance(30);
    c.platform.bypass = 'unauthorized-operation';
    const g01 = issue(c, 'G01', [c.validators.A, c.validators.B]);
    assert.ok(submit(c, observe(c, c.validators.A, g01)).accepted);
    c.clock.advance(60);
    assert.ok(submit(c, observe(c, c.validators.B, g01)).accepted);
    const { protectiveTransition } = c.services().lifecycle.evaluate(ORG_A, credentialId);
    assert.equal(protectiveTransition?.record.reasonCode, 'CRITICAL_VIOLATION_CONFIRMED');
    assert.deepEqual([c.store.getHead(ORG_A, credentialId)?.state, c.store.getHead(ORG_A, credentialId)?.stateVersion], ['SUSPENDED', 3]);

    // Step 5 — a new nonce-bound request receives the committed SUSPENDED state.
    const n2 = freshNonce();
    const a2 = assertionText(registry.issueOnline(s.onlineRequest(credentialId, n2)));
    const v2 = s.verify(a2, credentialId, { kind: 'online', nonce: n2 }, { store: online });
    assert.deepEqual([v2.conformant, v2.result, v2.state, v2.stateVersion], [false, 'NOT_CONFORMANT', 'SUSPENDED', 3]);
    assert.notEqual(assertionText(registry.stapled(credentialId)), stapledActive, 'the stapled ACTIVE is no longer served');

    // Step 6 — replay of the earlier ACTIVE.
    assert.equal(s.verify(a1, credentialId, { kind: 'online', nonce: n2 }).result, 'NONCE_MISMATCH', 'online: the nonce does not match');
    const watcher = s.verifierStore('replay-verifier');
    s.verify(a2, credentialId, { kind: 'stapled' }, { store: watcher });
    assert.equal(s.verify(stapledActive, credentialId, { kind: 'stapled' }, { store: watcher }).result, 'ROLLBACK_DETECTED', 'a verifier that saw the newer sequence');
    // A fresh, stateless verifier applies the validity-window policy: offline is not instant revocation.
    const fresh = s.verify(stapledActive, credentialId, { kind: 'stapled' });
    assert.equal(fresh.result, 'CONFORMANT');
    assert.ok(fresh.remainingValidityMs !== null && fresh.remainingValidityMs > 0 && fresh.remainingValidityMs <= 15 * 60_000);
    t.diagnostic(`offline staleness bound: the replayed ACTIVE stays valid for ${fresh.remainingValidityMs} ms at most`);

    // Step 7 — expiry: once past validUntil, the old ACTIVE cannot establish conformance anywhere.
    c.clock.set(toTimestamp(toMs(sa.validUntil)));
    assert.equal(s.verify(stapledActive, credentialId, { kind: 'stapled' }).result, 'EXPIRED_ASSERTION');
    assert.equal(s.verify(a1, credentialId, { kind: 'online', nonce: n1 }).result, 'EXPIRED_ASSERTION');

    // Step 8 — recovery: remediate, revalidate every critical requirement, two-person reinstatement.
    c.platform.bypass = 'none';
    c.clock.advance(60);
    assert.ok(runBaseline(c, [c.validators.A, c.validators.B]).every((r) => r.accepted));
    c.clock.advance(1);
    const { lifecycle } = c.services();
    const prepared = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId, remediation: { statement: 'Synthetic bypass removed.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() } });
    assert.deepEqual([lifecycle.commit(prepared, approvals(c, prepared, c.humans.carol, c.humans.bob)).state], ['ACTIVE']);

    // Step 9 — updated status: monotonic sequence and stateVersion, history continuity.
    const n3 = freshNonce();
    const a3 = assertionText(registry.issueOnline(s.onlineRequest(credentialId, n3)));
    const v3 = s.verify(a3, credentialId, { kind: 'online', nonce: n3 }, { store: online });
    assert.deepEqual([v3.result, v3.state, v3.stateVersion], ['CONFORMANT', 'ACTIVE', 4]);
    assert.ok(v3.continuity === 'NEXT' || v3.continuity === 'GAP_ACCEPTED_ONLINE');
    const s3 = stateOf(a3);
    assert.ok(s3.sequence > stateOf(a2).sequence && stateOf(a2).sequence > stateOf(a1).sequence);
    const transitions = registry.transitions(credentialId, 0, 50)!;
    assert.deepEqual(transitions.map((tr) => `${tr.stateVersion}:${tr.transitionCode}:${tr.to}`), ['1:T1:CANDIDATE', '2:T2:ACTIVE', '3:T4:SUSPENDED', '4:T5:ACTIVE']);
    for (let i = 1; i < transitions.length; i += 1) assert.equal(transitions[i]!.previousTransitionDigest, transitions[i - 1]!.transitionDigest);
    assert.equal(s3.historyRef.latestTransitionDigest, transitions.at(-1)!.transitionDigest);
    assert.deepEqual(transitions.map((tr) => tr.humanApprovals), [0, 2, 0, 2]);
    assert.ok(!JSON.stringify(transitions).includes('human-'), 'who approved is not disclosed');
    assert.ok(verifyCredentialHistory(c.store, ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory }).valid, 'INV-10');

    // Step 10 — a simulated ledger anchor intent for the reinstatement transition. Prepared, never confirmed.
    const t5 = c.store.listTransitions(ORG_A, credentialId).at(-1)!;
    const intent = prepareAnchorIntent(c.store, { credentialId, transitionId: t5.columns.transitionId, expectedTransitionDigest: t5.transitionDigest, now: c.clock.now() });
    assert.deepEqual([intent.networkIntent, intent.confirmationState, intent.transitionDigest], ['XRPL_TESTNET', 'prepared', t5.transitionDigest]);
    assert.equal(intent.canonicalPayloadDigest, conformanceDigest(anchorPayload(credentialId, JSON.parse(t5.recordJson), t5.transitionDigest)));
    assert.deepEqual(Object.keys(intent).sort(), ['anchorSchemaVersion', 'canonicalPayloadDigest', 'confirmationState', 'credentialId', 'networkIntent', 'preparedAt', 'profileVersion', 'synthetic', 'transitionDigest', 'transitionId']);
    assert.ok(!/txHash|ledgerIndex|validated|evidence|validator/i.test(canonicalizeConformance(intent)), 'no ledger result is invented; no evidence or validator data');
    assert.equal(stateOf(a3).anchors.length, 0, 'a prepared intent is never listed as an anchor');
    t.diagnostic(`state sequence: ${transitions.map((tr) => `${tr.stateVersion}:${tr.to}`).join(' → ')}; status sequences ${stateOf(a1).sequence} → ${stateOf(a2).sequence} → ${s3.sequence}`);
    s.cleanup();
  });
});

describe('RN-CONFORM-03 simulated anchor intents (WP-11, INV-11)', () => {
  it('are deterministic, bound to an existing transition digest, refuse a wrong digest at the API and the database, and never block a suspension', () => {
    const s = buildStatusCircuit();
    const { c } = s;
    const credentialId = activeCredential(c);
    const t2 = c.store.listTransitions(ORG_A, credentialId)[1]!;
    const first = prepareAnchorIntent(c.store, { credentialId, transitionId: t2.columns.transitionId, now: c.clock.now() });
    c.clock.advance(60);
    assert.deepEqual(prepareAnchorIntent(c.store, { credentialId, transitionId: t2.columns.transitionId, now: c.clock.now() }), first, 'idempotent and deterministic');
    assert.throws(() => prepareAnchorIntent(c.store, { credentialId, transitionId: t2.columns.transitionId, expectedTransitionDigest: `sha256:${'0'.repeat(64)}`, now: c.clock.now() }), (e: unknown) => e instanceof AnchorIntentError && e.code === 'TRANSITION_DIGEST_MISMATCH');
    assert.throws(() => prepareAnchorIntent(c.store, { credentialId, transitionId: 'trn_unknown', now: c.clock.now() }), (e: unknown) => e instanceof AnchorIntentError && e.code === 'UNKNOWN_TRANSITION');
    const db = new Database(c.path);
    const insert = (digest: string, state = 'prepared', network = 'XRPL_TESTNET') =>
      db.prepare('INSERT INTO cc_anchor_intents (intent_id, credential_id, transition_id, transition_digest, profile_version, payload_digest, network_intent, confirmation_state, prepared_at_ms, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        `anc_${state}_${network}`, credentialId, c.store.listTransitions(ORG_A, credentialId)[0]!.columns.transitionId, digest, '0.1.0', `sha256:${'1'.repeat(64)}`, network, state, 0, JSON.stringify({ transitionDigest: digest, confirmationState: state, networkIntent: network, canonicalPayloadDigest: `sha256:${'1'.repeat(64)}` }),
      );
    assert.throws(() => insert(`sha256:${'2'.repeat(64)}`), /cc:anchor intent for an unknown transition/);
    assert.throws(() => insert(c.store.listTransitions(ORG_A, credentialId)[0]!.transitionDigest, 'validated'), /CHECK constraint failed|cc:/);
    assert.throws(() => insert(c.store.listTransitions(ORG_A, credentialId)[0]!.transitionDigest, 'prepared', 'XRPL_MAINNET'), /CHECK constraint failed|cc:/);
    assert.throws(() => db.prepare("UPDATE cc_anchor_intents SET confirmation_state = 'validated'").run(), /cc:immutable cc_anchor_intents/);
    db.close();

    // INV-11: anchoring is not on the suspension path — a failing anchor preparation does not delay a protective transition.
    c.platform.bypass = 'unauthorized-operation';
    const g01 = issue(c, 'G01', [c.validators.A, c.validators.B]);
    submit(c, observe(c, c.validators.A, g01));
    submit(c, observe(c, c.validators.B, g01));
    assert.throws(() => prepareAnchorIntent(c.store, { credentialId, transitionId: 'trn_not_yet', now: c.clock.now() }));
    assert.equal(c.services().lifecycle.evaluate(ORG_A, credentialId).protectiveTransition?.record.to, 'SUSPENDED');
    const nonce = freshNonce();
    assert.equal(s.verify(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce))), credentialId, { kind: 'online', nonce }).result, 'NOT_CONFORMANT', 'status verification needs no anchor');
    s.cleanup();
  });
});
