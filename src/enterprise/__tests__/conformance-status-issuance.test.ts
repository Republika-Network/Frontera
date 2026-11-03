import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { CredentialLifecycleError, createCredentialLifecycle } from '../conformance/lifecycle.js';
import { openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { toMs, toTimestamp } from '../conformance/contracts.js';
import { parseStatusArtifact, statusArtifactDigest } from '../conformance/status-contracts.js';
import { projectCredentialStatus } from '../conformance/status-projection.js';
import { authenticateStatusRequest } from '../conformance/status-signer.js';
import { ORG_A, activeCredential, cleanupAll, issue, observe, runBaseline, submit } from './conformance-support.js';
import { ISSUER, assertionText, buildStatusCircuit, freshNonce, requesterKey, type StatusCircuit } from './conformance-status-support.js';

/**
 * RN-CONFORM-03 / WP-03, WP-04, WP-06, WP-09, WP-10 — issuance from committed
 * state: the online nonce protocol, signed refusals, the linearization point
 * under deterministic barriers, the hash-linked sequence, rollback after a
 * database restore, availability failures and freshness semantics.
 */

after(cleanupAll);

const HOUR = 3600;
const raw = (path: string) => {
  const db = new Database(path);
  db.pragma('busy_timeout = 0');
  db.pragma('foreign_keys = OFF');
  return db;
};
const counts = (s: StatusCircuit) => {
  const db = raw(s.c.path);
  try {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { evaluations: n('cc_evaluations'), transitions: n('cc_transitions'), heads: n('cc_heads'), assertions: n('cc_status_assertions') };
  } finally {
    db.close();
  }
};
const corroborateBypass = (s: StatusCircuit) => {
  s.c.platform.bypass = 'unauthorized-operation';
  const challenge = issue(s.c, 'G01', [s.c.validators.A, s.c.validators.B]);
  assert.ok(submit(s.c, observe(s.c, s.c.validators.A, challenge)).accepted);
  assert.ok(submit(s.c, observe(s.c, s.c.validators.B, challenge)).accepted);
};
const stateOf = (text: string) => {
  const parsed = parseStatusArtifact(text);
  assert.ok(parsed.ok && parsed.kind === 'assertion');
  return parsed.artifact;
};

describe('RN-CONFORM-03 committed-state projection and online issuance (WP-03, WP-04)', () => {
  it('states exactly the committed head; a caller cannot supply state; issuance never changes a conformance decision (INV-08)', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    assert.deepEqual(s.registry.issueOnline({ ...s.onlineRequest(credentialId), state: 'ACTIVE' }), { kind: 'unavailable', reason: 'MALFORMED_REQUEST', detail: '' });
    const before = counts(s);
    const head = s.c.store.getHead(ORG_A, credentialId)!;
    for (let i = 0; i < 5; i += 1) assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    assertionText(s.registry.stapled(credentialId));
    const afterCounts = counts(s);
    assert.deepEqual({ ...afterCounts, assertions: 0 }, { ...before, assertions: 0 }, 'no evaluation, transition or head was written');
    assert.equal(afterCounts.assertions, before.assertions + 6);
    assert.deepEqual(s.c.store.getHead(ORG_A, credentialId), head);
    const a = stateOf(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId))));
    assert.deepEqual([a.state, a.stateVersion, a.reasonCode, a.effectiveAt, a.historyRef.latestTransitionDigest], [head.state, head.stateVersion, head.reasonCode, head.effectiveAt, head.headTransitionDigest]);
    s.cleanup();
  });

  it('echoes a fresh nonce; a different nonce, a reused nonce or a malformed nonce never yields a current answer', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const nonce = freshNonce();
    const text = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.equal(stateOf(text).requestNonce, nonce);
    assert.equal(s.verify(text, credentialId, { kind: 'online', nonce }).result, 'CONFORMANT');
    assert.equal(s.verify(text, credentialId, { kind: 'online', nonce: freshNonce() }).result, 'NONCE_MISMATCH');
    const reused = s.registry.issueOnline(s.onlineRequest(credentialId, nonce));
    assert.equal(reused.kind, 'refusal');
    assert.equal(reused.kind === 'refusal' && reused.refusal.result, 'NONCE_REUSED');
    assert.deepEqual([s.verify(reused.kind === 'refusal' ? reused.text : '', credentialId, { kind: 'online', nonce }).result], ['NOT_CONFORMANT']);
    for (const bad of ['short', `${'a'.repeat(87)}`, 'not base64url!!!!!!!!!!!!!!']) assert.equal(s.registry.issueOnline(s.onlineRequest(credentialId, bad)).kind, 'unavailable');
    s.cleanup();
  });

  it('answers a mismatched or unknown subject with a signed refusal that states nothing about the credential or another organization', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const credential = s.c.store.findCredential(credentialId)!;
    const cases: [Partial<ReturnType<StatusCircuit['onlineRequest']>['expect']>, string][] = [
      [{ platformId: 'platform-synthetic-beta' }, 'SUBJECT_MISMATCH'],
      [{ integrationId: 'integration-other' }, 'SUBJECT_MISMATCH'],
      [{ integrationVersion: 2 }, 'SUBJECT_MISMATCH'],
      [{ integrationDigest: `sha256:${'9'.repeat(64)}` }, 'SUBJECT_MISMATCH'],
      [{ profileId: 'rn.conformance.integration' }, 'PROFILE_MISMATCH'],
      [{ profileVersion: '0.2.0' }, 'PROFILE_MISMATCH'],
      [{ organizationId: 'org-synthetic-beta' }, 'UNKNOWN_CREDENTIAL'],
    ];
    for (const [override, expected] of cases) {
      const nonce = freshNonce();
      const out = s.registry.issueOnline(s.onlineRequest(credentialId, nonce, override));
      assert.equal(out.kind, 'refusal', expected);
      if (out.kind !== 'refusal') continue;
      assert.equal(out.refusal.result, expected);
      for (const secret of [credential.integrationDigest, credential.organizationId, credential.platformId, 'ACTIVE', 'coveredOperations']) assert.ok(!out.text.includes(secret), `${expected} leaks ${secret}`);
      const verdict = s.verify(out.text, credentialId, { kind: 'online', nonce });
      assert.equal(verdict.conformant, false);
      assert.ok(['SUBJECT_MISMATCH', 'PROFILE_MISMATCH', 'NOT_CONFORMANT'].includes(verdict.result));
    }
    const unknown = s.registry.issueOnline(s.onlineRequest('crd_nonexistent'));
    assert.equal(unknown.kind === 'refusal' && unknown.refusal.result, 'UNKNOWN_CREDENTIAL');
    s.cleanup();
  });
});

describe('RN-CONFORM-03 linearization point under deterministic barriers (WP-03, INV-03)', () => {
  it('a suspension committed between snapshot and signing is detected; the retried attempt states SUSPENDED, never the older ACTIVE', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    corroborateBypass(s);
    let fired = 0;
    const racing = s.registryWith({
      hooks: {
        afterPrepare: () => {
          if (fired++ === 0) s.c.services().lifecycle.evaluate(ORG_A, credentialId);
        },
      },
    });
    const nonce = freshNonce();
    const text = assertionText(racing.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.equal(fired, 2, 'a second attempt was needed');
    assert.deepEqual([stateOf(text).state, stateOf(text).reasonCode], ['SUSPENDED', 'CRITICAL_VIOLATION_CONFIRMED']);
    assert.equal(s.verify(text, credentialId, { kind: 'online', nonce }).result, 'NOT_CONFORMANT');
    s.cleanup();
  });

  it('when every attempt sees the head move, nothing is signed and the answer is UNAVAILABLE (bounded retries)', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    corroborateBypass(s);
    const before = s.c.store.latestStatusAssertion(credentialId);
    const racing = s.registryWith({ maxAttempts: 1, hooks: { afterPrepare: () => s.c.services().lifecycle.evaluate(ORG_A, credentialId) } });
    assert.deepEqual(racing.issueOnline(s.onlineRequest(credentialId)), { kind: 'unavailable', reason: 'RETRY_EXHAUSTED', detail: '' });
    assert.equal(s.c.store.latestStatusAssertion(credentialId), before);
    s.cleanup();
  });

  it('while an assertion is being signed, no transition can commit; the transition commits afterwards and the next request states it', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    corroborateBypass(s);
    const second = openConformanceStore(s.c.path, { busyTimeoutMs: 0 });
    const lifecycleB = createCredentialLifecycle({ store: second, profiles: s.c.profiles, clock: s.c.clock, random: s.c.random, registryKey: s.c.registryKey, humans: s.c.humansDirectory, coordinatorPublicKeyPem: s.c.coordinatorPublicKeyPem });
    let busy = false;
    const signing = s.registryWith({
      hooks: {
        beforeSign: () => {
          try {
            lifecycleB.evaluate(ORG_A, credentialId);
          } catch (error) {
            busy = error instanceof CredentialLifecycleError && error.code === 'STORE_BUSY';
          }
        },
      },
    });
    const nonce = freshNonce();
    const during = assertionText(signing.issueOnline(s.onlineRequest(credentialId, nonce)));
    assert.equal(busy, true, 'the suspension could not interleave with issuance');
    // The assertion states the head committed at its linearization point — ACTIVE, but with the pending protective action.
    assert.deepEqual([stateOf(during).state, stateOf(during).evidenceFreshness.status], ['ACTIVE', 'PROTECTIVE_ACTION_PENDING']);
    assert.equal(s.verify(during, credentialId, { kind: 'online', nonce }).result, 'STALE_EVIDENCE');
    lifecycleB.evaluate(ORG_A, credentialId);
    const afterNonce = freshNonce();
    const next = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, afterNonce)));
    assert.deepEqual([stateOf(next).state, stateOf(next).sequence], ['SUSPENDED', stateOf(during).sequence + 1]);
    second.close();
    s.cleanup();
  });

  it('two simultaneous issuers on two connections never produce two assertions with one sequence', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const second = openConformanceStore(s.c.path, { busyTimeoutMs: 0 });
    const other = s.registryWith({ projection: { ...s.projection, store: second } });
    let concurrent: ReturnType<typeof other.issueOnline> | undefined;
    const first = s.registryWith({ hooks: { beforeSign: () => (concurrent = other.issueOnline(s.onlineRequest(credentialId))) } });
    const a = stateOf(assertionText(first.issueOnline(s.onlineRequest(credentialId))));
    assert.deepEqual(concurrent, { kind: 'unavailable', reason: 'RETRY_EXHAUSTED', detail: '' }, 'the second issuer could not take the write lock');
    const b = stateOf(assertionText(other.issueOnline(s.onlineRequest(credentialId))));
    assert.equal(b.sequence, a.sequence + 1);
    assert.ok(b.previousAssertionDigest !== null);
    second.close();
    s.cleanup();
  });
});

describe('RN-CONFORM-03 sequence, chain and restore protection (WP-06)', () => {
  it('assigns contiguous sequences linked by digest; the database refuses gaps, broken links, non-head states and rewrites on any connection', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const texts = [assertionText(s.registry.stapled(credentialId)), ...[1, 2, 3].map(() => assertionText(s.registry.issueOnline(s.onlineRequest(credentialId))))];
    const chain = texts.map(stateOf);
    assert.deepEqual(chain.map((a) => a.sequence), [1, 2, 3, 4]);
    assert.equal(chain[0]!.previousAssertionDigest, null);
    for (let i = 1; i < chain.length; i += 1) assert.equal(chain[i]!.previousAssertionDigest, statusArtifactDigest(chain[i - 1]!), `link ${i}`);
    const db = raw(s.c.path);
    const latest = s.c.store.latestStatusAssertion(credentialId)!;
    const row = db.prepare('SELECT * FROM cc_status_assertions WHERE credential_id = ? AND sequence = ?').get(credentialId, 4) as Record<string, unknown>;
    const insert = (over: Record<string, unknown>) => {
      const r = { ...row, ...over };
      return db.prepare('INSERT INTO cc_status_assertions (credential_id, sequence, assertion_digest, previous_assertion_digest, state, state_version, transition_digest, request_nonce, issued_at_ms, valid_until_ms, key_id, assertion_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        r['credential_id'], r['sequence'], r['assertion_digest'], r['previous_assertion_digest'], r['state'], r['state_version'], r['transition_digest'], r['request_nonce'], r['issued_at_ms'], r['valid_until_ms'], r['key_id'], r['assertion_json'],
      );
    };
    const json = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(String(row['assertion_json'])), ...over });
    assert.throws(() => insert({ sequence: 6, assertion_digest: `sha256:${'1'.repeat(64)}`, request_nonce: null, assertion_json: json({ sequence: 6, requestNonce: null }) }), /cc:status sequence gap/);
    assert.throws(() => insert({ sequence: 5, assertion_digest: `sha256:${'2'.repeat(64)}`, previous_assertion_digest: `sha256:${'3'.repeat(64)}`, request_nonce: null, assertion_json: json({ sequence: 5, requestNonce: null, previousAssertionDigest: `sha256:${'3'.repeat(64)}` }) }), /cc:status chain mismatch/);
    assert.throws(
      () => insert({ sequence: 5, assertion_digest: `sha256:${'4'.repeat(64)}`, previous_assertion_digest: latest.assertionDigest, state: 'SUSPENDED', request_nonce: null, assertion_json: json({ sequence: 5, requestNonce: null, previousAssertionDigest: latest.assertionDigest, state: 'SUSPENDED' }) }),
      /cc:status not the committed head/,
    );
    assert.throws(() => insert({ sequence: 5, assertion_digest: `sha256:${'5'.repeat(64)}`, previous_assertion_digest: latest.assertionDigest, request_nonce: null }), /cc:status json mismatch/);
    // An exact copy, or a REPLACE of an existing link, is refused (by the duplicate guard or the chain guard, whichever fires first).
    assert.throws(() => insert({}), /cc:(duplicate cc_status_assertions|status sequence gap)/);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO cc_status_assertions SELECT * FROM cc_status_assertions WHERE sequence = 1').run(), /cc:/);
    assert.equal(s.c.store.latestStatusAssertion(credentialId)?.sequence, 4);
    assert.throws(() => db.prepare('UPDATE cc_status_assertions SET state = ?').run('ACTIVE'), /cc:immutable cc_status_assertions/);
    assert.throws(() => db.prepare('DELETE FROM cc_status_assertions').run(), /cc:immutable cc_status_assertions/);
    db.close();
    s.cleanup();
  });

  it('after the registry database is restored from an older backup, the signer (outside the restore domain) refuses to reuse a sequence', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    assertionText(s.registry.stapled(credentialId));
    s.c.store.close();
    const backup = join(s.c.dir, 'backup.sqlite');
    copyFileSync(s.c.path, backup);
    s.c.reopen();
    assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const nonce = freshNonce();
    const third = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
    const verifier = s.verifierStore();
    assert.equal(s.verify(third, credentialId, { kind: 'online', nonce }, { store: verifier }).result, 'CONFORMANT');
    s.c.store.close();
    copyFileSync(backup, s.c.path);
    s.c.reopen();
    assert.equal(s.c.store.latestStatusAssertion(credentialId)?.sequence, 1, 'the restored registry is behind');
    // A new sequence is never signed twice: the signer's own journal is ahead of the restored registry.
    assert.deepEqual(s.registry.issueOnline(s.onlineRequest(credentialId)), { kind: 'unavailable', reason: 'SIGNER_REFUSED', detail: 'SEQUENCE_DIVERGED' });
    // The restored registry can still hand out its old, unexpired stapled assertion. It states the same committed state the
    // verifier already saw, so it is accepted as an older view of that state — not a rollback (review P1-A).
    const stale = s.registry.stapled(credentialId);
    assert.equal(stale.kind === 'assertion' && stale.assertion.sequence, 1);
    const seen = s.verify(stale.kind === 'assertion' ? stale.text : '', credentialId, { kind: 'stapled' }, { store: verifier });
    assert.deepEqual([seen.result, seen.continuity], ['CONFORMANT', 'OLDER_SAME_STATE']);
    s.cleanup();
  });
});

describe('RN-CONFORM-03 independent review regressions (signer state high-water mark, no burned sequences)', () => {
  it('review P1-C: after a restore to before a suspension, the signer refuses to vouch for the superseded ACTIVE head under any sequence', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    assertionText(s.registry.stapled(credentialId));
    s.c.store.close();
    const backup = join(s.c.dir, 'before-suspension.sqlite');
    copyFileSync(s.c.path, backup);
    s.c.reopen();
    corroborateBypass(s);
    s.c.services().lifecycle.evaluate(ORG_A, credentialId);
    const suspended = assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    assert.equal(stateOf(suspended).state, 'SUSPENDED');
    s.c.store.close();
    copyFileSync(backup, s.c.path);
    s.c.reopen();
    assert.equal(s.c.store.getHead(ORG_A, credentialId)?.state, 'ACTIVE', 'the restored database shows the superseded head');
    // Even a requester that knows the signer's last digest and asks for exactly the next sequence gets nothing for the old state.
    const projection = projectCredentialStatus(s.projection, credentialId, s.c.clock.now());
    assert.ok(projection.ok);
    const at = s.c.clock.now();
    const payload = {
      schema: 'rn.conformance.status/1', purpose: 'rn.conformance.status.assertion', issuer: ISSUER, ...projection.projection, anchors: [],
      sequence: stateOf(suspended).sequence + 1, previousAssertionDigest: statusArtifactDigest(stateOf(suspended)), requestNonce: null,
      issuedAt: at, validUntil: toTimestamp(toMs(at) + 60_000), designation: 'SYNTHETIC-NON-PRODUCTION',
    };
    const request = { operation: 'signStatusAssertion' as const, requesterId: 'status-registry', payload: payload as never };
    assert.deepEqual(s.signer.sign({ ...request, authentication: authenticateStatusRequest(requesterKey(), request) }), { ok: false, refusal: 'STATE_ROLLBACK' });
    assert.equal(s.registry.issueOnline(s.onlineRequest(credentialId)).kind, 'unavailable');
    s.cleanup();
  });

  it('review P1-B: an issuer clock stepped back is refused before signing, so no sequence is burned; issuance resumes when the clock catches up', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    s.c.clock.advance(60);
    assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)));
    const now = s.c.clock.ms();
    s.c.clock.set(toTimestamp(now - 10_000));
    assert.deepEqual(s.registry.issueOnline(s.onlineRequest(credentialId)), { kind: 'unavailable', reason: 'CLOCK_BEHIND', detail: 'the issuer clock is behind the last issued assertion' });
    s.c.clock.set(toTimestamp(now + 1_000));
    assert.equal(stateOf(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)))).sequence, 2, 'the refused attempt consumed no sequence');
    s.cleanup();
  });

  it('review P1-B: a nonce used by a concurrent issuer meanwhile is detected under the lock, before signing; no sequence is burned', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const nonce = freshNonce();
    let fired = false;
    const racing = s.registryWith({
      hooks: {
        afterPrepare: () => {
          if (fired) return;
          fired = true;
          assertionText(s.registry.issueOnline(s.onlineRequest(credentialId, nonce)));
        },
      },
    });
    const out = racing.issueOnline(s.onlineRequest(credentialId, nonce));
    assert.equal(out.kind === 'refusal' && out.refusal.result, 'NONCE_REUSED');
    assert.equal(stateOf(assertionText(s.registry.issueOnline(s.onlineRequest(credentialId)))).sequence, 2, 'issuance continues');
    s.cleanup();
  });
});

describe('RN-CONFORM-03 availability failures fail closed (WP-09, INV-09)', () => {
  it('signer outage, registry failure and a locked database all give UNAVAILABLE with nothing signed or stored', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    s.signer.setAvailable(false);
    assert.deepEqual(s.registry.issueOnline(s.onlineRequest(credentialId)), { kind: 'unavailable', reason: 'SIGNER_UNAVAILABLE', detail: '' });
    assert.deepEqual(s.registry.issueOnline(s.onlineRequest(credentialId, freshNonce(), { platformId: 'platform-synthetic-beta' })), { kind: 'unavailable', reason: 'SIGNER_UNAVAILABLE', detail: '' }, 'no refusal is fabricated without a signature');
    s.signer.setAvailable(true);
    assert.equal(s.c.store.latestStatusAssertion(credentialId), undefined);

    // SQLite locked by another writer: bounded retries, then UNAVAILABLE.
    const holder = raw(s.c.path);
    holder.exec('BEGIN IMMEDIATE');
    const second = openConformanceStore(s.c.path, { busyTimeoutMs: 0 });
    const blocked = s.registryWith({ projection: { ...s.projection, store: second } });
    assert.deepEqual(blocked.issueOnline(s.onlineRequest(credentialId)), { kind: 'unavailable', reason: 'RETRY_EXHAUSTED', detail: '' });
    holder.exec('ROLLBACK');
    holder.close();
    second.close();

    // Registry storage unavailable (closed connection).
    const third = openConformanceStore(s.c.path);
    const broken = s.registryWith({ projection: { ...s.projection, store: third } });
    third.close();
    assert.equal(broken.issueOnline(s.onlineRequest(credentialId)).kind, 'unavailable');
    assert.equal(broken.stapled(credentialId).kind, 'unavailable');
    s.cleanup();
  });

  it('a transition history that does not verify is never stated (registry integrity failure → UNAVAILABLE)', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const db = raw(s.c.path);
    db.exec('DROP TRIGGER cc_transitions_no_update');
    db.prepare("UPDATE cc_transitions SET record_json = replace(record_json, 'ALL_CRITICAL_VERIFIED', 'ALL_CRITICAL_VERIFIEX') WHERE state_version = 2").run();
    db.close();
    const out = s.registry.issueOnline(s.onlineRequest(credentialId));
    assert.equal(out.kind, 'unavailable');
    assert.equal(out.kind === 'unavailable' && out.reason, 'HISTORY_INVALID');
    s.cleanup();
  });
});

describe('RN-CONFORM-03 freshness and expiry semantics (WP-10, INV-06)', () => {
  it('ACTIVE is not conformant with stale evidence, missing evidence for a covered operation, an open dispute, or an expired credential; SUSPENDED is not conformant with fresh evidence', () => {
    // Stale (in grace): state ACTIVE, evidence lapsed.
    const stale = buildStatusCircuit();
    const a = activeCredential(stale.c);
    stale.c.clock.advance(25 * HOUR);
    const staleText = assertionText(stale.registry.stapled(a));
    assert.deepEqual([stateOf(staleText).state, stateOf(staleText).evidenceFreshness.status], ['ACTIVE', 'STALE']);
    assert.equal(stale.verify(staleText, a, { kind: 'stapled' }).result, 'STALE_EVIDENCE');
    stale.cleanup();

    // Missing for one operation: document.open re-validated, document.export lapsed — not conformant even for document.open.
    const partial = buildStatusCircuit();
    const b = activeCredential(partial.c);
    partial.c.clock.advance(23 * HOUR);
    runBaseline(partial.c, [partial.c.validators.A, partial.c.validators.B], ['document.open']);
    partial.c.clock.advance(2 * HOUR);
    const partialText = assertionText(partial.registry.stapled(b));
    assert.equal(partial.verify(partialText, b, { kind: 'stapled' }).result, 'STALE_EVIDENCE');
    partial.cleanup();

    // Open critical dispute.
    const disputed = buildStatusCircuit();
    const d = activeCredential(disputed.c);
    disputed.c.clock.advance(HOUR);
    assert.ok(submit(disputed.c, observe(disputed.c, disputed.c.validators.C, issue(disputed.c, 'G01', [disputed.c.validators.C]), { outcome: 'allowed' })).accepted);
    const disputedText = assertionText(disputed.registry.stapled(d));
    assert.deepEqual([stateOf(disputedText).state, stateOf(disputedText).evidenceFreshness.status], ['ACTIVE', 'UNDER_INVESTIGATION']);
    assert.deepEqual([disputed.verify(disputedText, d, { kind: 'stapled' }).result, disputed.verify(disputedText, d, { kind: 'stapled' }).detail], ['STALE_EVIDENCE', 'UNDER_INVESTIGATION']);
    disputed.cleanup();

    // SUSPENDED with freshly revalidated evidence.
    const suspended = buildStatusCircuit();
    const e = activeCredential(suspended.c);
    suspended.c.clock.advance(31 * HOUR);
    suspended.c.services().lifecycle.evaluate(ORG_A, e);
    runBaseline(suspended.c, [suspended.c.validators.A, suspended.c.validators.B]);
    const suspendedText = assertionText(suspended.registry.stapled(e));
    assert.deepEqual([stateOf(suspendedText).state, stateOf(suspendedText).evidenceFreshness.status], ['SUSPENDED', 'FRESH']);
    assert.equal(suspended.verify(suspendedText, e, { kind: 'stapled' }).result, 'NOT_CONFORMANT');
    suspended.cleanup();

    // Expired credential: a freshly signed ACTIVE assertion does not extend it.
    const expired = buildStatusCircuit();
    const f = activeCredential(expired.c);
    expired.c.clock.advance(90 * 24 * HOUR + 60);
    runBaseline(expired.c, [expired.c.validators.A, expired.c.validators.B]);
    const expiredText = assertionText(expired.registry.stapled(f));
    assert.equal(stateOf(expiredText).state, 'ACTIVE', 'the head is still ACTIVE: the time rule has not run');
    assert.equal(expired.verify(expiredText, f, { kind: 'stapled' }).result, 'EXPIRED_CREDENTIAL');
    expired.cleanup();
  });

  it('an assertion never outlives its credential: validUntil is capped at the credential term', () => {
    const s = buildStatusCircuit();
    const credentialId = activeCredential(s.c);
    const credential = s.c.store.findCredential(credentialId)!;
    s.c.clock.set(new Date(Date.parse(credential.validUntil) - 5 * 60_000).toISOString());
    runBaseline(s.c, [s.c.validators.A, s.c.validators.B]);
    const text = assertionText(s.registry.stapled(credentialId));
    assert.equal(stateOf(text).validUntil, credential.validUntil);
    s.cleanup();
  });
});
