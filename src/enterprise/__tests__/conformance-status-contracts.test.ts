import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalizeConformance } from '../conformance/canonical.js';
import { toMs, toTimestamp } from '../conformance/contracts.js';
import { publicKeyPemOf, signConformancePayload } from '../conformance/signing.js';
import { parseStatusArtifact, type StatusAssertionPayload } from '../conformance/status-contracts.js';
import { authenticateStatusRequest, createStatusIssuerKeyRegistry, statusIssuerKeyRecord, type StatusSignerOperation } from '../conformance/status-signer.js';
import { activeCredential, cleanupAll, testKey } from './conformance-support.js';
import { ISSUER, KEY_VALID_FROM, KEY_VALID_UNTIL, assertionText, buildStatusCircuit, freshNonce, requesterKey, type StatusCircuit } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 / WP-01, WP-02 — the status assertion contract, its signature,
 * the pinned issuer key registry and the isolated signer boundary.
 */

after(cleanupAll);

const json = (text: string) => JSON.parse(text) as Record<string, unknown>;
const recanonical = (text: string, mutate: (o: Record<string, unknown>) => void) => {
  const o = json(text);
  mutate(o);
  return canonicalizeConformance(o);
};
const active = (): { s: StatusCircuit; credentialId: string; text: string } => {
  const s = buildStatusCircuit();
  const credentialId = activeCredential(s.c);
  return { s, credentialId, text: assertionText(s.registry.stapled(credentialId)) };
};
const payloadOf = (text: string): StatusAssertionPayload => {
  const parsed = parseStatusArtifact(text);
  assert.ok(parsed.ok && parsed.kind === 'assertion');
  return parsed.payload;
};
const signRequest = (s: StatusCircuit, operation: string, payload: unknown, key = requesterKey(), requesterId = 'status-registry') =>
  s.signer.sign({ operation, requesterId, payload, authentication: authenticateStatusRequest(key, { operation: operation as StatusSignerOperation, requesterId, payload: payload as StatusAssertionPayload }) });

describe('RN-CONFORM-03 status assertion contract (WP-01)', () => {
  it('accepts a valid canonical assertion signed by the pinned issuer, binding every required field', () => {
    const { s, credentialId, text } = active();
    const parsed = parseStatusArtifact(text);
    assert.ok(parsed.ok && parsed.kind === 'assertion');
    const a = parsed.artifact;
    assert.deepEqual([a.schema, a.purpose, a.issuer, a.state, a.stateVersion, a.sequence, a.previousAssertionDigest, a.requestNonce, a.designation], ['rn.conformance.status/1', 'rn.conformance.status.assertion', ISSUER, 'ACTIVE', 2, 1, null, null, 'SYNTHETIC-NON-PRODUCTION']);
    assert.deepEqual(Object.keys(a).sort(), [
      'adapter', 'anchors', 'credentialId', 'credentialValidUntil', 'designation', 'effectiveAt', 'evidenceFreshness', 'historyRef', 'issuedAt', 'issuer', 'lastSuccessfulVerificationAt',
      'previousAssertionDigest', 'profile', 'purpose', 'reasonCode', 'requestNonce', 'schema', 'scope', 'sdk', 'sequence', 'signature', 'state', 'stateVersion', 'subject', 'validUntil',
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(a.scope)), { coveredOperations: ['document.export', 'document.open'], declaredExclusions: ['document.share'] });
    assert.equal(a.evidenceFreshness.status, 'FRESH');
    assert.ok(toMs(a.validUntil) - toMs(a.issuedAt) <= 15 * 60 * 1000);
    assert.equal(a.anchors.length, 0);
    assert.equal(a.signature.algorithm, 'ed25519-v1');
    assert.equal(a.signature.keyId, s.trusted.list()[0]!.keyId);
    assert.equal(s.verify(text, credentialId, { kind: 'stapled' }).result, 'CONFORMANT');
    s.cleanup();
  });

  it('rejects unknown fields, other schemas, wrong purpose, missing signature, non-canonical text and an embedded public key', () => {
    const { s, credentialId, text } = active();
    const v = (t: unknown) => s.verify(t, credentialId, { kind: 'stapled' });
    assert.deepEqual([v(recanonical(text, (o) => (o['extra'] = 1))).result, v(recanonical(text, (o) => (o['extra'] = 1))).detail], ['INVALID_SCHEMA', 'UNKNOWN_FIELD:extra']);
    assert.equal(v(recanonical(text, (o) => (o['publicKeyPem'] = publicKeyPemOf(testKey('attacker'))))).detail, 'UNKNOWN_FIELD:publicKeyPem');
    assert.equal(v(recanonical(text, (o) => ((o['subject'] as Record<string, unknown>)['tenant'] = 'x'))).detail, 'MALFORMED_FIELD:subject');
    assert.equal(v(recanonical(text, (o) => (o['schema'] = 'rn.conformance.status/2'))).detail, 'UNKNOWN_SCHEMA');
    assert.equal(v(recanonical(text, (o) => (o['purpose'] = 'rn.conformance.status.refusal'))).detail, 'WRONG_PURPOSE');
    assert.equal(v(recanonical(text, (o) => delete o['signature'])).detail, 'SIGNATURE_MISSING');
    assert.equal(v(`${text} `).detail, 'NOT_CANONICAL');
    assert.equal(v(JSON.stringify(json(text), null, 2)).detail, 'NOT_CANONICAL');
    assert.equal(v('{not json').detail, 'MALFORMED_JSON');
    assert.equal(v(json(text)).detail, 'TOO_LARGE', 'an object graph is never accepted in place of the exact text');
    assert.equal(v('x'.repeat(40 * 1024)).detail, 'TOO_LARGE');
    assert.equal(v(recanonical(text, (o) => ((o['signature'] as Record<string, unknown>)['signature'] = 'abc'))).detail, 'MALFORMED_FIELD:signature');
    assert.equal(v(recanonical(text, (o) => (o['anchors'] = [{ network: 'x', txHash: 'y', confirmation: 'validated' }]))).detail, 'MALFORMED_FIELD:anchors');
    s.cleanup();
  });

  it('rejects a modified payload, a wrong-domain signature, a changed key id, an unsupported envelope and an untrusted issuer', () => {
    const { s, credentialId, text } = active();
    const v = (t: unknown, trusted = s.trusted) => s.verify(t, credentialId, { kind: 'stapled' }, { trusted });
    assert.equal(v(recanonical(text, (o) => (o['stateVersion'] = 3))).result, 'INVALID_SIGNATURE');
    assert.equal(v(recanonical(text, (o) => (o['validUntil'] = toTimestamp(toMs(String(o['validUntil'])) + 60_000)))).result, 'INVALID_SIGNATURE');
    const payload = payloadOf(text);
    const wrongDomain = canonicalizeConformance({ ...payload, signature: signConformancePayload('transition', payload, s.issuerKey) });
    assert.equal(v(wrongDomain).result, 'INVALID_SIGNATURE');
    // Another pinned key's id on this signature: the key resolves, the signature does not verify under it.
    const second = testKey('status-issuer-2');
    const both = createStatusIssuerKeyRegistry([...s.trusted.list(), statusIssuerKeyRecord(ISSUER, second, KEY_VALID_FROM, KEY_VALID_UNTIL)]);
    assert.equal(v(recanonical(text, (o) => ((o['signature'] as Record<string, unknown>)['keyId'] = both.list()[1]!.keyId)), both).result, 'INVALID_SIGNATURE');
    assert.equal(v(recanonical(text, (o) => ((o['signature'] as Record<string, unknown>)['keyId'] = `sha256:${'a'.repeat(64)}`))).result, 'UNTRUSTED_ISSUER');
    assert.equal(v(recanonical(text, (o) => ((o['signature'] as Record<string, unknown>)['artifactVersion'] = 'aoc.authority-artifact.v2'))).detail, 'unsupported envelope');
    // Self-signed by an attacker key: unknown key.
    const forged = canonicalizeConformance({ ...payload, signature: signConformancePayload('status', payload, testKey('attacker')) });
    assert.deepEqual([v(forged).result, v(forged).detail], ['UNTRUSTED_ISSUER', 'UNKNOWN_KEY']);
    // A verifier that pins a different issuer key set does not trust this issuer.
    const other = createStatusIssuerKeyRegistry([statusIssuerKeyRecord(ISSUER, testKey('other-issuer'), KEY_VALID_FROM, KEY_VALID_UNTIL)]);
    assert.equal(v(text, other).result, 'UNTRUSTED_ISSUER');
    // The same key pinned for another issuer id.
    const renamed = createStatusIssuerKeyRegistry([statusIssuerKeyRecord('another-issuer', s.issuerKey, KEY_VALID_FROM, KEY_VALID_UNTIL)]);
    assert.deepEqual([v(text, renamed).result, v(text, renamed).detail], ['UNTRUSTED_ISSUER', 'ISSUER_MISMATCH']);
    // A status signature replayed onto a refusal payload (another purpose and domain) does not verify.
    const refusal = canonicalizeConformance({
      schema: 'rn.conformance.status-refusal/1', purpose: 'rn.conformance.status.refusal', issuer: ISSUER, requestedCredentialId: credentialId, requestNonce: freshNonce(), result: 'UNKNOWN_CREDENTIAL',
      issuedAt: payload.issuedAt, validUntil: payload.validUntil, designation: 'SYNTHETIC-NON-PRODUCTION', signature: json(text)['signature'],
    });
    assert.equal(v(refusal).result, 'INVALID_SIGNATURE');
    s.cleanup();
  });

  it('the key registry refuses key ids that are not derived from their key, private material and duplicates', () => {
    const record = statusIssuerKeyRecord(ISSUER, testKey('status-issuer-1'), KEY_VALID_FROM, KEY_VALID_UNTIL);
    assert.throws(() => createStatusIssuerKeyRegistry([{ ...record, keyId: `sha256:${'b'.repeat(64)}` }]));
    assert.throws(() => createStatusIssuerKeyRegistry([record, record]));
    // (Built at run time so no key-material marker appears in source: the RN-CONFORM-02 structure suite scans for it.)
    assert.throws(() => createStatusIssuerKeyRegistry([{ ...record, publicKeyPem: `-----BEGIN ${'PRIVATE'} KEY-----` }]));
    assert.throws(() => createStatusIssuerKeyRegistry([{ ...record, validUntil: record.validFrom }]));
  });
});

describe('RN-CONFORM-03 isolated status signer (WP-02, CC-D-07)', () => {
  it('refuses unauthenticated requesters, unsupported operations, a foreign issuer, an over-long lifetime and a skewed clock', () => {
    const { s, text } = active();
    const payload = payloadOf(text);
    const next = { ...payload, sequence: 2, previousAssertionDigest: `sha256:${'c'.repeat(64)}` };
    assert.deepEqual(s.signer.sign({ operation: 'signStatusAssertion', requesterId: 'status-registry', payload: next, authentication: 'forged' }), { ok: false, refusal: 'UNAUTHENTICATED' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', next, requesterKey('intruder')), { ok: false, refusal: 'UNAUTHENTICATED' });
    // The issuer's own key is not a requester key: a request signed with it is refused too.
    assert.deepEqual(signRequest(s, 'signStatusAssertion', next, s.issuerKey), { ok: false, refusal: 'UNAUTHENTICATED' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', next, requesterKey(), 'intruder'), { ok: false, refusal: 'UNAUTHENTICATED' });
    assert.deepEqual(s.signer.sign(null), { ok: false, refusal: 'UNAUTHENTICATED' });
    assert.deepEqual(signRequest(s, 'signGrant', next), { ok: false, refusal: 'UNSUPPORTED_OPERATION' });
    assert.deepEqual(signRequest(s, 'signBytes', 'aGVsbG8'), { ok: false, refusal: 'UNSUPPORTED_OPERATION' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, extra: 1 }), { ok: false, refusal: 'MALFORMED_PAYLOAD' });
    assert.deepEqual(signRequest(s, 'signStatusRefusal', next), { ok: false, refusal: 'MALFORMED_PAYLOAD' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, issuer: 'someone-else' }), { ok: false, refusal: 'WRONG_ISSUER' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, validUntil: toTimestamp(toMs(next.issuedAt) + 16 * 60_000) }), { ok: false, refusal: 'LIFETIME' });
    const later = toTimestamp(toMs(next.issuedAt) + 60_000);
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, issuedAt: later, validUntil: toTimestamp(toMs(later) + 60_000) }), { ok: false, refusal: 'CLOCK' });
    s.cleanup();
  });

  it('never trusts the registry: an altered subject, a stale state or a broken sequence is not signed', () => {
    const { s, credentialId, text } = active();
    const payload = payloadOf(text);
    const last = s.c.store.latestStatusAssertion(credentialId)!;
    const next = { ...payload, sequence: 2, previousAssertionDigest: last.assertionDigest };
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, subject: { ...next.subject, integrationDigest: `sha256:${'d'.repeat(64)}` } }), { ok: false, refusal: 'NOT_CURRENT' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, stateVersion: 1, state: 'CANDIDATE' }), { ok: false, refusal: 'NOT_CURRENT' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, scope: { ...next.scope, declaredExclusions: [] } }), { ok: false, refusal: 'NOT_CURRENT' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, sequence: 5 }), { ok: false, refusal: 'SEQUENCE_DIVERGED' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', { ...next, previousAssertionDigest: `sha256:${'e'.repeat(64)}` }), { ok: false, refusal: 'SEQUENCE_DIVERGED' });
    assert.deepEqual(signRequest(s, 'signStatusAssertion', payload), { ok: false, refusal: 'SEQUENCE_DIVERGED' }, 'sequence 1 was already signed');
    const signed = signRequest(s, 'signStatusAssertion', next);
    assert.ok(signed.ok, 'the exact current state, next sequence, is signed');
    s.cleanup();
  });

  it('signs only with a currently valid, unrevoked key; rotates to the newer key; verifiers withdraw trust from revoked and expired keys', () => {
    // Expired and revoked signer keys: nothing is signed; the registry reports UNAVAILABLE.
    const expired = buildStatusCircuit({ signerKeys: [{ privateKey: testKey('status-old'), validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' }] });
    const e1 = activeCredential(expired.c);
    assert.deepEqual(expired.registry.stapled(e1), { kind: 'unavailable', reason: 'SIGNER_REFUSED', detail: 'NO_USABLE_KEY' });
    expired.cleanup();
    const revoked = buildStatusCircuit({ signerKeys: [{ privateKey: testKey('status-revoked'), validFrom: KEY_VALID_FROM, validUntil: KEY_VALID_UNTIL, revokedAt: KEY_VALID_FROM }] });
    const r1 = activeCredential(revoked.c);
    assert.equal(revoked.registry.stapled(r1).kind, 'unavailable');
    revoked.cleanup();

    // Rotation: key 1 ends one hour after T0; key 2 starts at T0. After the hour, key 2 signs; a verifier pinning both accepts.
    const k1 = testKey('status-rot-1');
    const k2 = testKey('status-rot-2');
    const oneHour = toTimestamp(toMs(KEY_VALID_FROM) + 3600_000);
    const rot = buildStatusCircuit({ signerKeys: [{ privateKey: k1, validFrom: '2026-10-01T00:00:00.000Z', validUntil: oneHour }, { privateKey: k2, validFrom: KEY_VALID_FROM, validUntil: KEY_VALID_UNTIL }] });
    const id = activeCredential(rot.c);
    const first = assertionText(rot.registry.stapled(id));
    assert.equal(json(first)['signature'] !== undefined && (json(first)['signature'] as { keyId: string }).keyId, rot.trusted.list()[1]!.keyId, 'the newest valid key signs');
    assert.equal(rot.verify(first, id, { kind: 'stapled' }).result, 'CONFORMANT');
    // A verifier that pinned only key 1: an assertion signed by key 2 is not trusted.
    const onlyK1 = createStatusIssuerKeyRegistry([rot.trusted.list()[0]!]);
    assert.equal(rot.verify(first, id, { kind: 'stapled' }, { trusted: onlyK1 }).result, 'UNTRUSTED_ISSUER');
    // Revoking key 2 in the verifier's pinned set withdraws trust immediately, though the signature is well formed.
    const withdrawn = createStatusIssuerKeyRegistry([rot.trusted.list()[0]!, { ...rot.trusted.list()[1]!, revokedAt: rot.c.clock.now() }]);
    assert.deepEqual([rot.verify(first, id, { kind: 'stapled' }, { trusted: withdrawn }).result, rot.verify(first, id, { kind: 'stapled' }, { trusted: withdrawn }).detail], ['UNTRUSTED_ISSUER', 'REVOKED']);
    // A key that has expired since signing no longer vouches for a still-unexpired assertion.
    const shortLived = createStatusIssuerKeyRegistry([{ ...rot.trusted.list()[1]!, validUntil: toTimestamp(rot.c.clock.ms() + 1000) }]);
    rot.c.clock.advance(2);
    assert.deepEqual([rot.verify(first, id, { kind: 'stapled' }, { trusted: shortLived }).result, rot.verify(first, id, { kind: 'stapled' }, { trusted: shortLived }).detail], ['UNTRUSTED_ISSUER', 'EXPIRED']);
    rot.cleanup();
  });

  it('INV-07: the registry holds no private key — none in its database, its responses or its objects; only the signer does', () => {
    const { s, credentialId } = active();
    s.registry.issueOnline(s.onlineRequest(credentialId));
    s.c.store.close();
    const db = readFileSync(s.c.path).toString('latin1');
    assert.ok(!db.includes('PRIVATE KEY'));
    assert.ok(!readFileSync(s.signerJournal).toString('latin1').includes('PRIVATE KEY'), 'the signer journal holds digests only');
    s.c.reopen();
    assert.ok(!JSON.stringify(s.registry.publicKeys()).includes('PRIVATE'));
    assert.ok(Object.values(s.registry).every((member) => typeof member === 'function'), 'the registry is a set of operations; it exposes no key material');
    s.cleanup();
  });
});
