import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance } from '../conformance/canonical.js';
import { toMs, toTimestamp } from '../conformance/contracts.js';
import { signConformancePayload } from '../conformance/signing.js';
import { parseStatusArtifact, type StatusAssertionPayload } from '../conformance/status-contracts.js';
import { openStatusVerifierStore, verifyConformanceStatus, type StatusExpectation } from '../conformance/status-verifier.js';
import { ORG_A, activeCredential, cleanupAll, issue, observe, submit } from './conformance-support.js';
import { ISSUER, assertionText, buildStatusCircuit, freshNonce, type StatusCircuit } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 / WP-05, WP-06, WP-07, WP-10 — the verifier library: validity
 * windows and clock behavior, exact binding, durable continuity (rollback,
 * conflict, gaps, latching, restart, concurrent verifiers) and never-throw
 * behavior.
 */

after(cleanupAll);

const payloadOf = (text: string): StatusAssertionPayload => {
  const parsed = parseStatusArtifact(text);
  assert.ok(parsed.ok && parsed.kind === 'assertion');
  return parsed.payload;
};
/** Re-signs a modified payload with the genuine issuer key — an equivocating or compromised issuer. */
const resign = (s: StatusCircuit, text: string, mutate: (p: Record<string, unknown>) => void): string => {
  const payload = { ...payloadOf(text) } as Record<string, unknown>;
  mutate(payload);
  return canonicalizeConformance({ ...payload, signature: signConformancePayload('status', payload, s.issuerKey) });
};
const setup = () => {
  const s = buildStatusCircuit();
  const credentialId = activeCredential(s.c);
  return { s, credentialId };
};
const result = (v: { result: string; detail: string | null }) => [v.result, v.detail];

describe('RN-CONFORM-03 verifier: validity window, skew and clock rollback (WP-05, WP-10)', () => {
  it('accepts from issuedAt to just before validUntil; refuses at and after validUntil; tolerates only the supported skew', () => {
    const { s, credentialId } = setup();
    const text = assertionText(s.registry.stapled(credentialId));
    const p = payloadOf(text);
    const at = (ms: number) => {
      s.c.clock.set(toTimestamp(ms));
      return s.verify(text, credentialId, { kind: 'stapled' });
    };
    const issued = toMs(p.issuedAt);
    const until = toMs(p.validUntil);
    assert.equal(at(issued).result, 'CONFORMANT');
    assert.equal(at(until - 1).result, 'CONFORMANT');
    assert.equal(at(until - 1).remainingValidityMs, 1);
    assert.deepEqual(result(at(until)), ['EXPIRED_ASSERTION', 'EXPIRED']);
    assert.deepEqual(result(at(until + 60_000)), ['EXPIRED_ASSERTION', 'EXPIRED']);
    assert.equal(at(issued - 3_000).result, 'CONFORMANT', 'within the 5 s tolerance');
    assert.deepEqual(result(at(issued - 6_000)), ['EXPIRED_ASSERTION', 'NOT_YET_VALID']);
    s.cleanup();
  });

  it('refuses an invalid validity interval even when correctly signed, and missing freshness metadata', () => {
    const { s, credentialId } = setup();
    const text = assertionText(s.registry.stapled(credentialId));
    const p = payloadOf(text);
    const tooLong = resign(s, text, (o) => (o['validUntil'] = toTimestamp(toMs(p.issuedAt) + 15 * 60_000 + 1)));
    assert.deepEqual(result(s.verify(tooLong, credentialId, { kind: 'stapled' })), ['EXPIRED_ASSERTION', 'INVALID_VALIDITY_INTERVAL']);
    const inverted = resign(s, text, (o) => (o['validUntil'] = p.issuedAt));
    assert.deepEqual(result(s.verify(inverted, credentialId, { kind: 'stapled' })), ['EXPIRED_ASSERTION', 'INVALID_VALIDITY_INTERVAL']);
    const missing = resign(s, text, (o) => (o['evidenceFreshness'] = { status: 'FRESH', oldestRequiredEvidenceAt: null, freshUntil: null }));
    assert.deepEqual(result(s.verify(missing, credentialId, { kind: 'stapled' })), ['INVALID_SCHEMA', 'MALFORMED_FIELD:evidenceFreshness']);
    const expiredEvidence = resign(s, text, (o) => (o['evidenceFreshness'] = { ...(o['evidenceFreshness'] as object), freshUntil: toTimestamp(toMs(p.issuedAt) - 1) }));
    assert.equal(s.verify(expiredEvidence, credentialId, { kind: 'stapled' }).result, 'STALE_EVIDENCE');
    s.cleanup();
  });

  it('detects a trusted clock that ran backwards (persisted), without letting skew extend validity', () => {
    const { s, credentialId } = setup();
    const text = assertionText(s.registry.stapled(credentialId));
    const store = s.verifierStore();
    const p = payloadOf(text);
    s.c.clock.set(toTimestamp(toMs(p.issuedAt) + 10 * 60_000));
    assert.equal(s.verify(text, credentialId, { kind: 'stapled' }, { store }).result, 'CONFORMANT');
    s.c.clock.set(toTimestamp(toMs(p.issuedAt) + 60_000));
    assert.equal(s.verify(text, credentialId, { kind: 'stapled' }, { store }).result, 'CLOCK_ROLLBACK');
    store.close();
    const reopened = openStatusVerifierStore(store.path);
    assert.equal(s.verify(text, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'CLOCK_ROLLBACK', 'the trusted time survives a restart');
    reopened.close();
    s.cleanup();
  });
});

describe('RN-CONFORM-03 verifier: exact subject, profile and scope (INV-02)', () => {
  it('refuses every substitution of credential, platform, organization, integration, version, digest, profile, SDK, adapter and operation', () => {
    const { s, credentialId } = setup();
    const text = assertionText(s.registry.stapled(credentialId));
    const v = (expect: Record<string, unknown>, operation?: string) => s.verify(text, credentialId, { kind: 'stapled' }, { expect: expect as Partial<StatusExpectation>, ...(operation === undefined ? {} : { operation }) });
    assert.equal(v({}).result, 'CONFORMANT');
    for (const [field, value] of [
      ['credentialId', 'crd_substituted'], ['platformId', 'platform-synthetic-beta'], ['organizationId', 'org-synthetic-beta'], ['integrationId', 'integration-other'],
      ['integrationVersion', 2], ['integrationDigest', `sha256:${'7'.repeat(64)}`], ['sdkVersion', '1.3.0'], ['adapterVersion', '0.2.0'],
    ] as const) {
      assert.equal(v({ [field]: value }).result, 'SUBJECT_MISMATCH', field);
    }
    for (const [field, value] of [['profileId', 'rn.conformance.integration'], ['profileVersion', '0.2.0'], ['profileDigest', `sha256:${'6'.repeat(64)}`]] as const) assert.equal(v({ [field]: value }).result, 'PROFILE_MISMATCH', field);
    assert.deepEqual(result(v({}, 'document.delete')), ['SCOPE_MISMATCH', 'OPERATION_NOT_COVERED']);
    assert.deepEqual(result(v({}, 'document.share')), ['SCOPE_MISMATCH', 'OPERATION_EXCLUDED']);
    assert.equal(v({}, 'document.export').result, 'CONFORMANT');
    s.cleanup();
  });
});

const suspend = (s: StatusCircuit, credentialId: string) => {
  s.c.platform.bypass = 'unauthorized-operation';
  const g01 = issue(s.c, 'G01', [s.c.validators.A, s.c.validators.B]);
  submit(s.c, observe(s.c, s.c.validators.A, g01));
  submit(s.c, observe(s.c, s.c.validators.B, g01));
  s.c.services().lifecycle.evaluate(ORG_A, credentialId);
  assert.equal(s.c.store.getHead(ORG_A, credentialId)?.state, 'SUSPENDED');
};

describe('RN-CONFORM-03 verifier: durable continuity judged on committed state (WP-06, INV-05)', () => {
  it('review P1-A: online and stapled traffic share one chain without false rollbacks — older or non-adjacent sequences of the same state are accepted', () => {
    const { s, credentialId } = setup();
    const stapled = assertionText(s.registry.stapled(credentialId));
    const n2 = freshNonce();
    const online = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n2)));
    assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const later = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const store = s.verifierStore();
    assert.deepEqual([s.verify(stapled, credentialId, { kind: 'stapled' }, { store }).continuity], ['FIRST_OBSERVATION']);
    assert.equal(s.verify(stapled, credentialId, { kind: 'stapled' }, { store }).continuity, 'SAME');
    const next = s.verify(online, credentialId, { kind: 'online', nonce: n2 }, { store });
    assert.deepEqual([next.result, next.continuity, next.sequence], ['CONFORMANT', 'NEXT', 2]);
    assert.deepEqual([s.verify(later, credentialId, { kind: 'stapled' }, { store }).result, s.verify(later, credentialId, { kind: 'stapled' }, { store }).continuity], ['CONFORMANT', 'SAME'], 'a same-state gap is benign');
    // The platform's still-current stapled assertion, presented after newer online traffic: accepted, not a rollback, nothing latched.
    const older = s.verify(stapled, credentialId, { kind: 'stapled' }, { store });
    assert.deepEqual([older.result, older.continuity], ['CONFORMANT', 'OLDER_SAME_STATE']);
    assert.equal(store.latch(credentialId), undefined);
    s.cleanup();
  });

  it('an older ACTIVE after a newer SUSPENDED is refused as a rollback; review P2-B: such a replay never latches, and it survives a restart', () => {
    const { s, credentialId } = setup();
    const active = assertionText(s.registry.stapled(credentialId));
    const store = s.verifierStore();
    assert.equal(s.verify(active, credentialId, { kind: 'stapled' }, { store }).result, 'CONFORMANT');
    suspend(s, credentialId);
    const nonce = freshNonce();
    const suspended = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.deepEqual([s.verify(suspended, credentialId, { kind: 'online', nonce }, { store }).result, payloadOf(suspended).state], ['NOT_CONFORMANT', 'SUSPENDED']);
    assert.deepEqual(result(s.verify(active, credentialId, { kind: 'stapled' }, { store })), ['ROLLBACK_DETECTED', 'stateVersion 2 < 3'], 'still inside its validity window, and still refused');
    assert.equal(store.latch(credentialId), undefined, 'a genuine but stale artifact is not evidence of tampering');
    assert.equal(s.verify(suspended, credentialId, { kind: 'stapled' }, { store }).result, 'NOT_CONFORMANT', 'the newer status still verifies (no denial of service)');
    store.close();
    const reopened = openStatusVerifierStore(store.path);
    assert.equal(s.verify(active, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'ROLLBACK_DETECTED', 'the high-water mark persists');
    reopened.close();
    s.cleanup();
  });

  it('equivocation (same sequence, two digests), a broken link and a second history at one state version are latched conflicts, persisted across restart', () => {
    const { s, credentialId } = setup();
    const t1 = assertionText(s.registry.stapled(credentialId));
    const t2 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const t3 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const fork = resign(s, t2, (o) => (o['issuedAt'] = toTimestamp(toMs(String(o['issuedAt'])) + 1)));
    const a = s.verifierStore();
    s.verify(t2, credentialId, { kind: 'stapled' }, { store: a });
    assert.deepEqual(result(s.verify(fork, credentialId, { kind: 'stapled' }, { store: a })), ['CONFLICT_DETECTED', 'sequence 2 with two digests']);
    assert.equal(s.verify(t3, credentialId, { kind: 'stapled' }, { store: a }).result, 'CONFLICT_DETECTED', 'latched');
    a.close();
    const reopened = openStatusVerifierStore(a.path);
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'CONFLICT_DETECTED', 'the latch persists');
    assert.equal(reopened.latch(credentialId)?.kind, 'CONFLICT_DETECTED');
    reopened.close();
    const b = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store: b });
    const unlinked = resign(s, t2, (o) => (o['previousAssertionDigest'] = `sha256:${'f'.repeat(64)}`));
    assert.equal(s.verify(unlinked, credentialId, { kind: 'stapled' }, { store: b }).result, 'CONFLICT_DETECTED');
    const c = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store: c });
    const otherHistory = resign(s, t3, (o) => (o['historyRef'] = { ...(o['historyRef'] as object), latestTransitionDigest: `sha256:${'e'.repeat(64)}` }));
    assert.deepEqual(result(s.verify(otherHistory, credentialId, { kind: 'stapled' }, { store: c })), ['CONFLICT_DETECTED', 'stateVersion 2 names two transitions']);
    s.cleanup();
  });

  it('a newer state reached through a gap is unproven offline — review P2-A: also when presented again — until an online check re-anchors the mark', () => {
    const { s, credentialId } = setup();
    const t1 = assertionText(s.registry.stapled(credentialId));
    const store = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store });
    s.registry.issueOnline(s.onlineRequest(credentialId));
    suspend(s, credentialId);
    const stapledSuspended = assertionText(s.registry.stapled(credentialId));
    assert.ok(payloadOf(stapledSuspended).sequence >= 3);
    assert.equal(s.verify(stapledSuspended, credentialId, { kind: 'stapled' }, { store }).result, 'CONTINUITY_UNPROVEN');
    assert.equal(s.verify(stapledSuspended, credentialId, { kind: 'stapled' }, { store }).result, 'CONTINUITY_UNPROVEN', 'presenting it twice proves nothing');
    // Review N-2: the unproven SUSPENDED still raised the state floor — the pre-suspension ACTIVE (even the anchor itself) no longer passes.
    assert.equal(s.verify(t1, credentialId, { kind: 'stapled' }, { store }).result, 'ROLLBACK_DETECTED');
    const nonce = freshNonce();
    const online = s.verify(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce))), credentialId, { kind: 'online', nonce }, { store });
    assert.deepEqual([online.result, online.continuity], ['NOT_CONFORMANT', 'GAP_ACCEPTED_ONLINE']);
    assert.deepEqual([s.verify(stapledSuspended, credentialId, { kind: 'stapled' }, { store }).result, s.verify(stapledSuspended, credentialId, { kind: 'stapled' }, { store }).continuity], ['NOT_CONFORMANT', 'OLDER_SAME_STATE']);
    assert.equal(s.verify(t1, credentialId, { kind: 'stapled' }, { store }).result, 'ROLLBACK_DETECTED');
    assert.equal(s.verify(t1, credentialId, { kind: 'stapled' }).continuity, 'NOT_TRACKED', 'a stateless verifier cannot detect rollback, and says so');
    s.cleanup();
  });

  it('concurrent verifiers sharing one store are deterministic; review P2-C: no conflict clause or rewritten trigger can reset or forget the mark', () => {
    const { s, credentialId } = setup();
    const t2text = (() => {
      s.registry.stapled(credentialId);
      return assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    })();
    const first = s.verifierStore('shared');
    const second = openStatusVerifierStore(first.path);
    assert.equal(s.verify(t2text, credentialId, { kind: 'stapled' }, { store: first }).continuity, 'FIRST_OBSERVATION');
    assert.equal(s.verify(t2text, credentialId, { kind: 'stapled' }, { store: second }).continuity, 'SAME');
    const fork = resign(s, t2text, (o) => (o['issuedAt'] = toTimestamp(toMs(String(o['issuedAt'])) + 1)));
    assert.equal(s.verify(fork, credentialId, { kind: 'stapled' }, { store: second }).result, 'CONFLICT_DETECTED');
    assert.equal(s.verify(t2text, credentialId, { kind: 'stapled' }, { store: first }).result, 'CONFLICT_DETECTED', 'the latch is shared');
    second.close();
    const db = new Database(first.path);
    assert.throws(() => db.prepare('UPDATE vs_high_water SET sequence = 1').run(), /vs:high-water mark moved backwards/);
    assert.throws(() => db.prepare('DELETE FROM vs_high_water').run(), /vs:immutable/);
    assert.throws(() => db.prepare('DELETE FROM vs_latches').run(), /vs:immutable/);
    assert.throws(() => db.prepare('UPDATE vs_clock SET max_trusted_ms = 0').run(), /vs:clock moved backwards/);
    assert.throws(
      () =>
        db.prepare("INSERT OR REPLACE INTO vs_high_water (issuer, credential_id, sequence, assertion_digest, state_version, transition_digest, state, floor_state_version, floor_transition_digest, freshness_floor_ms, observed_at_ms) VALUES (?, ?, 0, 'x', 0, 'x', 'ACTIVE', 0, 'x', 0, 0)").run(ISSUER, credentialId),
      /vs:duplicate/,
    );
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO vs_clock (id, max_trusted_ms) VALUES (1, 0)').run(), /vs:duplicate/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO vs_latches (latch_seq, credential_id, kind, detail, at_ms) SELECT latch_seq, 'crd_other', kind, detail, at_ms FROM vs_latches").run(), /vs:duplicate/);
    assert.equal(first.latch(credentialId)?.kind, 'CONFLICT_DETECTED');
    first.close();
    db.exec("DROP TRIGGER vs_clock_forward; CREATE TRIGGER vs_clock_forward BEFORE UPDATE ON vs_clock BEGIN SELECT 1; END;");
    db.close();
    assert.throws(() => openStatusVerifierStore(first.path), /not intact/, 'a same-name trigger with another body is refused at open');
    s.cleanup();
  });
});

describe('RN-CONFORM-03 verifier: re-review regressions (N-1, N-3)', () => {
  it('review N-1: after a signed degradation of freshness at the same state version, an older FRESH view is refused', () => {
    const { s, credentialId } = setup();
    const fresh = assertionText(s.registry.stapled(credentialId));
    s.c.clock.advance(60);
    assert.ok(submit(s.c, observe(s.c, s.c.validators.C, issue(s.c, 'G01', [s.c.validators.C]), { outcome: 'allowed' })).accepted);
    const nonce = freshNonce();
    const degraded = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.deepEqual([payloadOf(degraded).state, payloadOf(degraded).stateVersion, payloadOf(degraded).evidenceFreshness.status], ['ACTIVE', 2, 'UNDER_INVESTIGATION']);
    const store = s.verifierStore();
    assert.equal(s.verify(degraded, credentialId, { kind: 'online', nonce }, { store }).result, 'STALE_EVIDENCE');
    s.c.clock.set(toTimestamp(toMs(payloadOf(fresh).validUntil) - 1000));
    const older = s.verify(fresh, credentialId, { kind: 'stapled' }, { store });
    assert.equal(older.result, 'ROLLBACK_DETECTED');
    assert.match(older.detail ?? '', /fresh view issued before a signed degradation/);
    assert.equal(s.verify(fresh, credentialId, { kind: 'stapled' }).result, 'CONFORMANT', 'a stateless verifier has no such memory (bounded by the 15-minute window)');
    s.cleanup();
  });

  it('review N-3: a clock stepped back within the tolerance does not extend validity', () => {
    const { s, credentialId } = setup();
    const n1 = freshNonce();
    const a = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n1)));
    const until = toMs(payloadOf(a).validUntil);
    s.c.clock.set(toTimestamp(until + 2000));
    const n2 = freshNonce();
    const b = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n2)));
    const store = s.verifierStore();
    assert.equal(s.verify(b, credentialId, { kind: 'online', nonce: n2 }, { store }).result, 'CONFORMANT');
    s.c.clock.set(toTimestamp(until - 1000));
    assert.equal(s.verify(a, credentialId, { kind: 'stapled' }).result, 'CONFORMANT', 'by the presented clock alone it would still be valid');
    assert.deepEqual(result(s.verify(a, credentialId, { kind: 'stapled' }, { store })), ['EXPIRED_ASSERTION', 'EXPIRED']);
    s.cleanup();
  });
});

describe('RN-CONFORM-03 verifier: never throws, fails closed (WP-07, INV-09)', () => {
  it('returns a structured refusal for adversarial input and for a broken clock', () => {
    const { s, credentialId } = setup();
    const text = assertionText(s.registry.stapled(credentialId));
    for (const input of [undefined, null, 42, {}, [], 'null', '"x"', '[]', '{}', '\u0000', '{"schema":"rn.conformance.status/1"}']) {
      const v = s.verify(input, credentialId, { kind: 'stapled' });
      assert.equal(v.conformant, false);
      assert.equal(v.result, 'INVALID_SCHEMA');
    }
    const getter = { get schema() { throw new Error('boom'); } };
    assert.equal(s.verify(getter, credentialId, { kind: 'stapled' }).conformant, false);
    const broken = verifyConformanceStatus({ artifact: text, expect: s.expectation(credentialId), mode: { kind: 'stapled' }, trustedKeys: s.trusted, clock: { now: () => { throw new Error('clock'); } } });
    assert.deepEqual([broken.conformant, broken.result], [false, 'UNAVAILABLE']);
    const nan = verifyConformanceStatus({ artifact: text, expect: s.expectation(credentialId), mode: { kind: 'stapled' }, trustedKeys: s.trusted, clock: { now: () => 'not a time' } });
    assert.deepEqual([nan.conformant, nan.result], [false, 'UNAVAILABLE']);
    // The unsigned infrastructure answer is never mistaken for a status.
    assert.equal(s.verify(JSON.stringify({ error: 'UNAVAILABLE', signed: false }), credentialId, { kind: 'stapled' }).result, 'INVALID_SCHEMA');
    assert.equal(s.verify(JSON.stringify({ status: 'ACTIVE' }), credentialId, { kind: 'stapled' }).result, 'INVALID_SCHEMA');
    s.cleanup();
  });
});
