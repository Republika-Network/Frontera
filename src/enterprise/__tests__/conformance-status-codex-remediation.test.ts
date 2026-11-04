import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeConformance, conformanceDigest } from '../conformance/canonical.js';
import { MAX_DECLARED_EXCLUSIONS, toMs, toTimestamp, type IntegrationVersionRecord } from '../conformance/contracts.js';
import { RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1, profileDigest } from '../conformance/profile.js';
import { ConformanceRegistryError } from '../conformance/registry.js';
import { openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { parseStatusArtifact } from '../conformance/status-contracts.js';
import { openStatusVerifierStore } from '../conformance/status-verifier.js';
import { ORG_A, activeCredential, cleanupAll, integrationInput, issue, observe, runBaseline, submit, testKey } from './conformance-support.js';
import { KEY_VALID_UNTIL, assertionText, buildStatusCircuit, freshNonce, type StatusCircuit } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 — regressions for the Codex findings on PR #266 at 781f93ac
 * (C-1 same-millisecond freshness replay, C-2 stapled cache vs. key rotation,
 * C-3 declared-exclusions bound). Real SQLite, real services.
 */

after(cleanupAll);

const PROFILE = RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1;
const art = (text: string) => {
  const parsed = parseStatusArtifact(text);
  assert.ok(parsed.ok && parsed.kind === 'assertion');
  return parsed.artifact;
};
const keyIdOf = (text: string) => art(text).signature.keyId;
const suspend = (s: StatusCircuit, credentialId: string) => {
  s.c.platform.bypass = 'unauthorized-operation';
  const g01 = issue(s.c, 'G01', [s.c.validators.A, s.c.validators.B]);
  submit(s.c, observe(s.c, s.c.validators.A, g01));
  submit(s.c, observe(s.c, s.c.validators.B, g01));
  s.c.services().lifecycle.evaluate(ORG_A, credentialId);
  assert.equal(s.c.store.getHead(ORG_A, credentialId)?.state, 'SUSPENDED');
  s.c.platform.bypass = 'none';
};

describe('Codex C-1 — freshness degradation is ordered by issuer sequence, not by timestamp', () => {
  it('A–J: a FRESH and a degraded assertion in the same millisecond; the older FRESH never passes, also after restart; genuine recovery passes; no false latch; no rollback past SUSPENDED', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    // A–C — the first, FRESH view.
    const fresh = assertionText(s.registry.stapled(credentialId));
    // A, B, D — a lone report opens a dispute; a second view in the very same millisecond is degraded, with a higher sequence.
    assert.ok(submit(s.c, observe(s.c, s.c.validators.C, issue(s.c, 'G01', [s.c.validators.C]), { outcome: 'allowed' })).accepted);
    const nonce = freshNonce();
    const degraded = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.equal(art(degraded).issuedAt, art(fresh).issuedAt, 'the same issuedAt millisecond');
    assert.deepEqual([art(fresh).stateVersion, art(degraded).stateVersion], [2, 2]);
    assert.deepEqual([art(fresh).evidenceFreshness.status, art(degraded).evidenceFreshness.status], ['FRESH', 'UNDER_INVESTIGATION']);
    assert.ok(art(degraded).sequence > art(fresh).sequence);
    // E — the degraded view is verified first.
    const store = s.verifierStore('c1');
    assert.equal(s.verify(degraded, credentialId, { kind: 'online', nonce }, { store }).result, 'STALE_EVIDENCE');
    // F, G — the older FRESH view is refused.
    const replay = s.verify(fresh, credentialId, { kind: 'stapled' }, { store });
    assert.deepEqual([replay.conformant, replay.result], [false, 'ROLLBACK_DETECTED']);
    assert.match(replay.detail ?? '', /sequence 1\) older than a signed degradation \(sequence 2\)/);
    // H — after a restart, the degradation is still known.
    store.close();
    const reopened = openStatusVerifierStore(store.path);
    assert.equal(s.verify(fresh, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'ROLLBACK_DETECTED');
    // I — genuine recovery: two other operators re-validate; a newer FRESH view (higher sequence) is conformant again.
    s.c.clock.advance(60);
    runBaseline(s.c, [s.c.validators.A, s.c.validators.B]);
    const n3 = freshNonce();
    const recovered = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n3)));
    assert.equal(art(recovered).evidenceFreshness.status, 'FRESH');
    const ok = s.verify(recovered, credentialId, { kind: 'online', nonce: n3 }, { store: reopened });
    assert.deepEqual([ok.result, ok.continuity], ['CONFORMANT', 'NEXT']);
    assert.equal(s.verify(fresh, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'ROLLBACK_DETECTED', 'recovery did not erase what was learned');
    // J — normal same-state sequencing never latches.
    assert.equal(reopened.latch(credentialId), undefined);
    // And no rollback past a signed SUSPENDED.
    suspend(s, credentialId);
    const n4 = freshNonce();
    assert.equal(s.verify(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, n4))), credentialId, { kind: 'online', nonce: n4 }, { store: reopened }).result, 'NOT_CONFORMANT');
    assert.equal(s.verify(recovered, credentialId, { kind: 'stapled' }, { store: reopened }).result, 'ROLLBACK_DETECTED');
    assert.equal(reopened.latch(credentialId), undefined);
    reopened.close();
    s.cleanup();
  });
});

describe('Codex C-2 — a cached stapled assertion is never served once its signing key is unusable', () => {
  const T0 = '2026-11-02T09:00:00.000Z';
  const at = (minutes: number) => toTimestamp(toMs(T0) + minutes * 60_000);

  for (const [label, keyA] of [
    ['expired', { privateKey: testKey('c2-key-a-expiring'), validFrom: '2026-10-01T00:00:00.000Z', validUntil: at(5) }],
    ['revoked (scheduled)', { privateKey: testKey('c2-key-a-revoked'), validFrom: '2026-10-01T00:00:00.000Z', validUntil: KEY_VALID_UNTIL, revokedAt: at(5) }],
  ] as const) {
    it(`A–I (${label}): rotation reissues under the current key; the old staple is rejected; with no signer, fail closed`, () => {
      const keyB = { privateKey: testKey(`c2-key-b-${label}`), validFrom: at(4), validUntil: KEY_VALID_UNTIL };
      const s = buildStatusCircuit({ signerKeys: [keyA, keyB] });
      const credentialId = activeCredential(s.c);
      const [recordA, recordB] = s.trusted.list();
      // A, B — a valid staple under key A (key B is not valid yet).
      const old = assertionText(s.registry.stapled(credentialId));
      assert.equal(keyIdOf(old), recordA!.keyId);
      assert.equal(s.verify(old, credentialId, { kind: 'stapled' }).result, 'CONFORMANT');
      // C, D — rotation: key A becomes unusable while the old staple's own validity has not ended.
      s.c.clock.set(at(6));
      assert.ok(toMs(art(old).validUntil) > s.c.clock.ms(), 'the cached staple is still inside its validity window');
      // H — under the current trust policy the old staple is rejected.
      assert.equal(s.verify(old, credentialId, { kind: 'stapled' }).result, 'UNTRUSTED_ISSUER');
      // E–G — the registry does not serve it; the replacement is signed by key B.
      const replacement = assertionText(s.registry.stapled(credentialId));
      assert.notEqual(replacement, old);
      assert.equal(keyIdOf(replacement), recordB!.keyId);
      assert.equal(art(replacement).sequence, art(old).sequence + 1);
      assert.equal(s.verify(replacement, credentialId, { kind: 'stapled' }).result, 'CONFORMANT');
      assert.equal(assertionText(s.registry.stapled(credentialId)), replacement, 'the replacement is cached while usable');
      // I — with no usable signer, nothing is served (not the old staple).
      s.c.clock.set(at(7));
      const fresh = buildStatusCircuit({ signerKeys: [keyA, keyB], seed: `c2-${label}` });
      const id2 = activeCredential(fresh.c);
      const staple2 = assertionText(fresh.registry.stapled(id2));
      fresh.c.clock.set(at(6));
      fresh.signer.setAvailable(false);
      assert.deepEqual(fresh.registry.stapled(id2), { kind: 'unavailable', reason: 'SIGNER_UNAVAILABLE', detail: '' });
      assert.equal(keyIdOf(staple2), recordA!.keyId);
      fresh.cleanup();
      s.cleanup();
    });
  }

  it('J: two issuers racing to replace a staple after rotation never produce conflicting sequences', () => {
    const keyA = { privateKey: testKey('c2-race-a'), validFrom: '2026-10-01T00:00:00.000Z', validUntil: at(5) };
    const keyB = { privateKey: testKey('c2-race-b'), validFrom: at(4), validUntil: KEY_VALID_UNTIL };
    const s = buildStatusCircuit({ signerKeys: [keyA, keyB] });
    const credentialId = activeCredential(s.c);
    const old = assertionText(s.registry.stapled(credentialId));
    s.c.clock.set(at(6));
    const second = openConformanceStore(s.c.path, { busyTimeoutMs: 0 });
    const other = s.registryWith({ projection: { ...s.projection, store: second } });
    let concurrent: ReturnType<typeof other.stapled> | undefined;
    const first = s.registryWith({ hooks: { beforeSign: () => (concurrent = other.stapled(credentialId)) } });
    const replacement = assertionText(first.stapled(credentialId));
    assert.equal(concurrent?.kind, 'unavailable', 'the racing issuer could not take the write lock');
    const afterwards = assertionText(other.stapled(credentialId));
    assert.equal(afterwards, replacement, 'the second issuer serves the same replacement — one sequence, one artifact');
    assert.equal(art(replacement).sequence, art(old).sequence + 1);
    assert.equal(s.c.store.latestStatusAssertion(credentialId)?.sequence, art(replacement).sequence);
    second.close();
    s.cleanup();
  });
});

describe('Codex C-3 — one declared-exclusions bound, enforced at admission and at status presentation', () => {
  const exclusions = (n: number) => Array.from({ length: n }, (_, i) => ({ operation: `excluded.op-${String(i).padStart(3, '0')}`, reason: 'Synthetic exclusion.' }));

  it('A–D, F–I: 0, 16, 17 and 64 exclusions are stated completely, sorted, untruncated; 65 is refused at admission; parser and issuer agree', () => {
    assert.equal(MAX_DECLARED_EXCLUSIONS, 64);
    const s = buildStatusCircuit();
    const { registry, lifecycle } = s.c.services();
    // H — existing RN-CONFORM-02 digests are unchanged: the fixture's integration digest is the digest of its stored record.
    assert.equal(conformanceDigest(s.c.store.getIntegrationByDigest(ORG_A, s.c.integration.integrationDigest)!.record), s.c.integration.integrationDigest);
    let version = 1;
    const texts = new Map<number, { text: string; credentialId: string; digest: string }>();
    for (const n of [0, 16, 17, 64]) {
      version += 1;
      const v = registry.registerIntegrationVersion(integrationInput(profileDigest(PROFILE), { integrationVersion: version, declaredExclusions: exclusions(n) }));
      const credential = lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: v.integrationDigest });
      const text = assertionText(s.registry.stapled(credential.credentialId));
      const stated = art(text).scope.declaredExclusions;
      assert.equal(stated.length, n, `${n} exclusions stated`);
      assert.deepEqual([...stated], exclusions(n).map((e) => e.operation).sort(), 'complete and sorted, no truncation');
      assert.ok(Buffer.byteLength(text) < 32 * 1024, 'inside the artifact size limit');
      texts.set(n, { text, credentialId: credential.credentialId, digest: v.integrationDigest });
    }
    // E — above the bound: refused where integrations are admitted.
    assert.throws(() => registry.registerIntegrationVersion(integrationInput(profileDigest(PROFILE), { integrationVersion: version + 1, declaredExclusions: exclusions(65) })), (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'MALFORMED_INPUT');
    // I — the parser enforces the same bound: one more exclusion than the maximum is a schema error.
    const max = texts.get(64)!;
    const over = JSON.parse(max.text) as { scope: { declaredExclusions: string[] } };
    over.scope.declaredExclusions = [...over.scope.declaredExclusions, 'excluded.op-zzz'].sort();
    assert.deepEqual([s.verify(canonicalizeConformance(over), max.credentialId, { kind: 'stapled' }).result, s.verify(canonicalizeConformance(over), max.credentialId, { kind: 'stapled' }).detail], ['INVALID_SCHEMA', 'MALFORMED_FIELD:scope']);
    // G — no cross-integration scope substitution: an assertion for one integration version is no proof for another.
    const sixteen = texts.get(16)!;
    assert.equal(s.verify(sixteen.text, sixteen.credentialId, { kind: 'stapled' }, { expect: { integrationDigest: texts.get(17)!.digest } }).result, 'SUBJECT_MISMATCH');
    s.cleanup();
  });

  it('E, F: a stored integration beyond the bound (written below the registry) is never stated partially — fail closed with a documented reason', () => {
    const s = buildStatusCircuit();
    const base = s.c.store.getIntegrationByDigest(ORG_A, s.c.integration.integrationDigest)!.record;
    const record: IntegrationVersionRecord = { ...base, integrationVersion: 2, declaredExclusions: exclusions(65), registeredAt: s.c.clock.now() };
    const digest = conformanceDigest(record);
    s.c.store.insertIntegration(record, digest);
    const credential = s.c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: digest });
    assert.deepEqual(s.registry.stapled(credential.credentialId), { kind: 'unavailable', reason: 'REGISTRY_UNAVAILABLE', detail: 'SCOPE_NOT_REPRESENTABLE' });
    assert.equal(s.registry.issueOnline(s.onlineRequest(credential.credentialId)).kind, 'unavailable');
    assert.equal(s.c.store.latestStatusAssertion(credential.credentialId), undefined, 'nothing was signed');
    s.cleanup();
  });
});
