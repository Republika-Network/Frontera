import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance } from '../conformance/canonical.js';
import { toMs, toTimestamp } from '../conformance/contracts.js';
import { signConformancePayload } from '../conformance/signing.js';
import { parseStatusArtifact, type StatusAssertionPayload } from '../conformance/status-contracts.js';
import { openStatusVerifierStore, verifyConformanceStatus, type StatusExpectation } from '../conformance/status-verifier.js';
import { ORG_A, activeCredential, cleanupAll, issue, observe, submit } from './conformance-support.js';
import { assertionText, buildStatusCircuit, freshNonce, type StatusCircuit } from './conformance-status-support.js';

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

describe('RN-CONFORM-03 verifier: durable continuity (WP-06, INV-05)', () => {
  it('advances on the next link; re-delivery is idempotent; a lower sequence is a latched rollback, also after restart', () => {
    const { s, credentialId } = setup();
    const t1 = assertionText(s.registry.stapled(credentialId));
    const n2 = freshNonce();
    const t2 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n2)));
    const t3 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const store = s.verifierStore();
    assert.deepEqual([s.verify(t1, credentialId, { kind: 'stapled' }, { store }).result, s.verify(t1, credentialId, { kind: 'stapled' }, { store }).continuity], ['CONFORMANT', 'SAME']);
    const second = s.verify(t2, credentialId, { kind: 'online', nonce: n2 }, { store });
    assert.deepEqual([second.result, second.continuity, second.sequence], ['CONFORMANT', 'NEXT', 2]);
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store }).continuity, 'SAME');
    assert.deepEqual(result(s.verify(t1, credentialId, { kind: 'stapled' }, { store })), ['ROLLBACK_DETECTED', 'sequence 1 < 2']);
    // Latched: even the genuine next link is refused until an authorized recovery (there is no API that clears a latch).
    assert.equal(s.verify(t3, credentialId, { kind: 'stapled' }, { store }).result, 'ROLLBACK_DETECTED');
    store.close();
    const reopened = openStatusVerifierStore(store.path);
    assert.equal(s.verify(t3, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'ROLLBACK_DETECTED', 'the latch persists across a restart');
    assert.equal(reopened.latch(credentialId)?.kind, 'ROLLBACK_DETECTED');
    reopened.close();
    s.cleanup();
  });

  it('an older ACTIVE after a newer SUSPENDED observation is rejected', () => {
    const { s, credentialId } = setup();
    const active = assertionText(s.registry.stapled(credentialId));
    const store = s.verifierStore();
    assert.equal(s.verify(active, credentialId, { kind: 'stapled' }, { store }).result, 'CONFORMANT');
    s.c.platform.bypass = 'unauthorized-operation';
    const g01 = issue(s.c, 'G01', [s.c.validators.A, s.c.validators.B]);
    submit(s.c, observe(s.c, s.c.validators.A, g01));
    submit(s.c, observe(s.c, s.c.validators.B, g01));
    s.c.services().lifecycle.evaluate(ORG_A, credentialId);
    const nonce = freshNonce();
    const suspended = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.deepEqual([s.verify(suspended, credentialId, { kind: 'online', nonce }, { store }).result, payloadOf(suspended).state], ['NOT_CONFORMANT', 'SUSPENDED']);
    assert.equal(s.verify(active, credentialId, { kind: 'stapled' }, { store }).result, 'ROLLBACK_DETECTED', 'the stapled ACTIVE is still inside its validity window, and still refused');
    s.cleanup();
  });

  it('same sequence with another digest, or a link to the wrong predecessor, is a latched conflict; a gap is unproven offline and accepted online', () => {
    const { s, credentialId } = setup();
    const t1 = assertionText(s.registry.stapled(credentialId));
    const t2 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const t3 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    // Equivocation: a second, differently signed sequence 2.
    const fork = resign(s, t2, (o) => (o['issuedAt'] = toTimestamp(toMs(String(o['issuedAt'])) + 1)));
    const a = s.verifierStore();
    s.verify(t2, credentialId, { kind: 'stapled' }, { store: a });
    assert.deepEqual(result(s.verify(fork, credentialId, { kind: 'stapled' }, { store: a })), ['CONFLICT_DETECTED', 'sequence 2 with two digests']);
    assert.equal(s.verify(t3, credentialId, { kind: 'stapled' }, { store: a }).result, 'CONFLICT_DETECTED', 'latched');
    // A next sequence that does not link to what this verifier saw.
    const b = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store: b });
    const unlinked = resign(s, t2, (o) => (o['previousAssertionDigest'] = `sha256:${'f'.repeat(64)}`));
    assert.equal(s.verify(unlinked, credentialId, { kind: 'stapled' }, { store: b }).result, 'CONFLICT_DETECTED');
    // A gap: offline it is unproven (and recorded, so nothing older passes later); online the nonce proves currency.
    const c = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store: c });
    assert.deepEqual(result(s.verify(t3, credentialId, { kind: 'stapled' }, { store: c })), ['CONTINUITY_UNPROVEN', 'gap 1 → 3']);
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store: c }).result, 'ROLLBACK_DETECTED');
    const d = s.verifierStore();
    s.verify(t1, credentialId, { kind: 'stapled' }, { store: d });
    const n4 = freshNonce();
    s.registry.issueOnline(s.onlineRequest(credentialId));
    const t5 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n4)));
    const online = s.verify(t5, credentialId, { kind: 'online', nonce: n4 }, { store: d });
    assert.deepEqual([online.result, online.continuity], ['CONFORMANT', 'GAP_ACCEPTED_ONLINE']);
    // A stateless verifier cannot detect rollback, and says so.
    assert.equal(s.verify(t1, credentialId, { kind: 'stapled' }).continuity, 'NOT_TRACKED');
    s.cleanup();
  });

  it('concurrent verifiers sharing one store observe deliveries deterministically; the store refuses to move backwards or forget', () => {
    const { s, credentialId } = setup();
    const t1 = assertionText(s.registry.stapled(credentialId));
    const t2 = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const first = s.verifierStore('shared');
    const second = openStatusVerifierStore(first.path);
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store: first }).continuity, 'FIRST_OBSERVATION');
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store: second }).continuity, 'SAME');
    assert.equal(s.verify(t1, credentialId, { kind: 'stapled' }, { store: second }).result, 'ROLLBACK_DETECTED');
    assert.equal(s.verify(t2, credentialId, { kind: 'stapled' }, { store: first }).result, 'ROLLBACK_DETECTED', 'the latch is shared');
    second.close();
    const db = new Database(first.path);
    assert.throws(() => db.prepare('UPDATE vs_high_water SET sequence = 1').run(), /vs:high-water mark moved backwards/);
    assert.throws(() => db.prepare('DELETE FROM vs_high_water').run(), /vs:immutable/);
    assert.throws(() => db.prepare('DELETE FROM vs_latches').run(), /vs:immutable/);
    assert.throws(() => db.prepare('UPDATE vs_clock SET max_trusted_ms = 0').run(), /vs:clock moved backwards/);
    db.close();
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
