import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { canonicalizeConformance } from '../conformance/canonical.js';
import { ChallengeCoordinatorError, DEPLOYMENT_ATTESTATION_OPERATION, createChallengeCoordinator, type ChallengeRequest } from '../conformance/coordinator.js';
import type { SignedChallenge } from '../conformance/contracts.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { ConformanceRegistryError } from '../conformance/registry.js';
import { ConformanceStoreError, openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import type { TestingAuthorizationPurpose } from '../conformance/testing-authorization.js';
import { RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1 } from '../conformance/profile.js';
import { MAX_CONCURRENT_CHALLENGES_PER_INTEGRATION } from '../conformance/testing-authorization.js';
import { ORG_A, ORG_B, buildCircuit, cleanupAll, decide, integrationInput, issue, observe, submit, testingAuthorizationFor, type Circuit, type SyntheticHuman } from './conformance-support.js';

/**
 * RN-CONFORM-07 — WP-09 adversarial matrix on real SQLite: authoritative testing authorization (P2-3) and evidence
 * purpose isolation (S-1). Every refusal is asserted at the coordinator AND, where a caller could skip the coordinator,
 * at the store trigger.
 */

after(cleanupAll);

const FIXTURE = 'fixture-synthetic-pep-v1';
let seq = 0;

function authorize(
  c: Circuit,
  overrides: Partial<{ purpose: TestingAuthorizationPurpose; operations: string[]; challengeTypes: string[]; fixtureRefs: string[]; notBeforeOffset: number; seconds: number; maxChallengesPerHour: number; maxConcurrentChallenges: number; maxTotalChallenges: number | null; supersedes: string | null; authorizationId: string }> = {},
  approvers: readonly [SyntheticHuman, SyntheticHuman] = [c.humans.alice, c.humans.bob],
) {
  seq += 1;
  const now = c.clock.ms() + (overrides.notBeforeOffset ?? 0) * 1000;
  const { record, prepared, authorizationDigest } = c.services().registry.prepareTestingAuthorization({
    authorizationId: overrides.authorizationId ?? `auth-adv-${seq}`,
    supersedes: overrides.supersedes ?? null,
    organizationId: ORG_A,
    integrationDigest: c.integration.integrationDigest,
    purpose: overrides.purpose ?? 'CONFORMANCE',
    fixtureRefs: overrides.fixtureRefs ?? [FIXTURE],
    operations: overrides.operations ?? ['document.open'],
    challengeTypes: overrides.challengeTypes ?? ['G01'],
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + (overrides.seconds ?? 3600) * 1000).toISOString(),
    maxChallengesPerHour: overrides.maxChallengesPerHour ?? 100,
    maxConcurrentChallenges: overrides.maxConcurrentChallenges ?? 100,
    maxTotalChallenges: overrides.maxTotalChallenges === undefined ? null : overrides.maxTotalChallenges,
  });
  const at = c.clock.now();
  const decisions = [decide(approvers[0], 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at), decide(approvers[1], 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at)];
  return { record, prepared, authorizationDigest, decisions, commit: () => c.services().registry.authorizeTesting(record, decisions) };
}

const request = (c: Circuit, authorizationId: string, overrides: Partial<ChallengeRequest> = {}): ChallengeRequest => {
  seq += 1;
  return {
    idempotencyKey: `adv-${seq}`,
    organizationId: ORG_A,
    integrationDigest: c.integration.integrationDigest,
    challengeType: 'G01',
    operation: 'document.open',
    fixtureRef: FIXTURE,
    assignedValidatorIds: [c.validators.A.validatorId],
    deadlineSeconds: 60,
    authorizationId,
    purpose: 'CONFORMANCE',
    ...overrides,
  };
};
const refusedWith = (code: string) => (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === code;
const storeRefused = (pattern: RegExp) => (e: unknown) => e instanceof ConformanceStoreError && pattern.test(e.detail);
const registryRefused = (code: string) => (e: unknown) => e instanceof ConformanceRegistryError && e.code === code;
const challengeCount = (c: Circuit) => {
  const db = new Database(c.path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM cc_challenges').get() as { n: number }).n;
  } finally {
    db.close();
  }
};
/** A coordinator-signed challenge cloned under fresh ids — used to drive the store directly, as a second coordinator would. */
const clone = (signed: SignedChallenge, suffix: string): SignedChallenge => ({
  challenge: { ...signed.challenge, challengeId: `${signed.challenge.challengeId}_${suffix}`, idempotencyKey: `${signed.challenge.idempotencyKey}-${suffix}`, nonce: `${suffix}`.padEnd(43, 'n') },
  coordinatorSignature: signed.coordinatorSignature,
});

describe('RN-CONFORM-07 — AUTH-01..05: no challenge without an explicit, covering authorization', () => {
  it('AUTH-01: an unknown authorization is refused and consumes nothing', () => {
    const c = buildCircuit();
    const before = challengeCount(c);
    assert.throws(() => c.services().coordinator.issue(request(c, 'auth-does-not-exist')), refusedWith('AUTHORIZATION_INVALID'));
    assert.equal(challengeCount(c), before);
    c.cleanup();
  });

  it('AUTH-02: purpose, operation, challenge type, fixture and integration must each be covered exactly (no wildcard)', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    const id = a.record.authorizationId;
    const coordinator = c.services().coordinator;
    assert.throws(() => coordinator.issue(request(c, id, { purpose: 'VALIDATOR_REQUALIFICATION' })), refusedWith('AUTHORIZATION_INVALID'));
    assert.throws(() => coordinator.issue(request(c, id, { operation: 'document.export' })), refusedWith('AUTHORIZATION_INVALID'));
    assert.throws(() => coordinator.issue(request(c, id, { challengeType: 'G02' })), refusedWith('AUTHORIZATION_INVALID'));
    assert.throws(() => coordinator.issue(request(c, id, { challengeType: 'G08', operation: DEPLOYMENT_ATTESTATION_OPERATION })), refusedWith('AUTHORIZATION_INVALID'));
    assert.ok(coordinator.issue(request(c, id)));
    // A wildcard or an unregistered fixture cannot even be prepared.
    assert.throws(() => authorize(c, { operations: ['*'] }), registryRefused('MALFORMED_INPUT'));
    assert.throws(() => authorize(c, { fixtureRefs: ['fixture-not-registered'] }), registryRefused('AUTHORIZATION_SCOPE'));
    assert.throws(() => authorize(c, { operations: ['document.delete'] }), registryRefused('AUTHORIZATION_SCOPE'));
    c.cleanup();
  });

  it('AUTH-03: tenant isolation — another organization cannot use, approve or target the authorization', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    // ORG_B's request against ORG_A's integration is refused before any authorization lookup could help it.
    assert.throws(() => c.services().coordinator.issue(request(c, a.record.authorizationId, { organizationId: ORG_B })));
    // Mallory (ORG_B) cannot co-approve an ORG_A authorization.
    const foreign = authorize(c, {}, [c.humans.alice, c.humans.mallory]);
    assert.throws(() => foreign.commit(), registryRefused('APPROVAL_REFUSED'));
    c.cleanup();
  });

  it('AUTH-04: the validity window is enforced (not yet valid, deadline beyond expiry, expired)', () => {
    const c = buildCircuit();
    const future = authorize(c, { notBeforeOffset: 600 });
    future.commit();
    assert.throws(() => c.services().coordinator.issue(request(c, future.record.authorizationId)), refusedWith('AUTHORIZATION_WINDOW'));
    c.services().registry.revokeTestingAuthorization(ORG_A, future.record.authorizationId, 'make room (test)');
    const short = authorize(c, { seconds: 30 });
    short.commit();
    assert.throws(() => c.services().coordinator.issue(request(c, short.record.authorizationId, { deadlineSeconds: 60 })), refusedWith('AUTHORIZATION_WINDOW'));
    assert.ok(c.services().coordinator.issue(request(c, short.record.authorizationId, { deadlineSeconds: 20 })));
    c.clock.advance(31);
    assert.throws(() => c.services().coordinator.issue(request(c, short.record.authorizationId, { deadlineSeconds: 1 })), refusedWith('AUTHORIZATION_WINDOW'));
    c.cleanup();
  });

  it('AUTH-05: a raw database writer cannot insert a challenge without, or outside, an authorization', () => {
    const c = buildCircuit();
    const signed = issue(c, 'G01', [c.validators.A]);
    const db = new Database(c.path);
    try {
      const x = { ...signed.challenge, challengeId: 'chl_raw_unauthorized', idempotencyKey: 'raw-1', nonce: 'r'.repeat(43) };
      assert.throws(
        () =>
          db.prepare('INSERT INTO cc_challenges (challenge_id, idempotency_key, nonce, organization_id, integration_digest, profile_id, profile_version, control_id, operation, issued_at_ms, deadline_ms, challenge_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            x.challengeId, x.idempotencyKey, x.nonce, x.organizationId, x.integrationDigest, x.profileId, x.profileVersion, x.controlId, x.operation, Date.parse(x.issuedAt), Date.parse(x.deadline), canonicalizeConformance(x), canonicalizeConformance(signed.coordinatorSignature),
          ),
        /cc:challenge outside its authorization/,
      );
      // A LEGACY association can only be written by the migration (for an already-existing challenge).
      assert.throws(() => db.prepare("INSERT INTO cc_challenge_authorizations (challenge_id, authorization_id, authorization_digest, purpose, issued_seq) VALUES ('chl_new', NULL, NULL, 'LEGACY', (SELECT value FROM cc_order))").run(), /cc:legacy association outside migration/);
      // Authorizations are immutable and need two consumed humans.
      assert.throws(() => db.prepare('UPDATE cc_testing_authorizations SET not_after_ms = not_after_ms + 1').run(), /cc:immutable/);
      assert.throws(() => db.prepare('UPDATE cc_order SET value = value + 2').run(), /cc:order only advances by one/);
    } finally {
      db.close();
    }
    c.cleanup();
  });
});

describe('RN-CONFORM-07 — AUTH-06..09: revocation and versioning, ordered durably', () => {
  it('AUTH-06: revocation stops new challenges and new evidence; evidence accepted before it stays authentic (durable sequence, same millisecond)', () => {
    const c = buildCircuit();
    const authorizationId = testingAuthorizationFor(c);
    const accepted = submit(c, observe(c, c.validators.A, issue(c, 'G01', [c.validators.A])));
    assert.ok(accepted.accepted);
    const pending = observe(c, c.validators.B, issue(c, 'G01', [c.validators.B]));
    // Revocation lands in the SAME millisecond as the acceptance above: ordering is by commit sequence, not by time.
    c.services().registry.revokeTestingAuthorization(ORG_A, authorizationId, 'consent withdrawn (test)');
    const stored = c.services().registry.getTestingAuthorization(authorizationId)!;
    assert.ok(stored.revokedSeq !== null && stored.revokedAtMs === c.clock.ms());
    const purpose = c.store.getObservationPurpose(accepted.accepted ? accepted.observation.eventId : '')!;
    assert.ok(purpose.acceptedSeq < stored.revokedSeq);
    const late = submit(c, pending);
    assert.equal(late.accepted, false);
    assert.equal(!late.accepted && late.reason, 'AUTHORIZATION_REVOKED');
    const row = c.store.getObservation(accepted.accepted ? accepted.observation.eventId : '')!;
    assert.equal(authenticateStoredObservation(c.store, c.profiles, row, c.coordinatorPublicKeyPem), null, 'historical evidence stays auditable');
    assert.throws(() => c.services().coordinator.issue(request(c, authorizationId)), refusedWith('AUTHORIZATION_REVOKED'));
    // Idempotent, terminal: a second revocation changes nothing; there is no reactivation path.
    c.services().registry.revokeTestingAuthorization(ORG_A, authorizationId, 'again (test)');
    assert.equal(c.services().registry.getTestingAuthorization(authorizationId)!.revokedSeq, stored.revokedSeq);
    c.cleanup();
  });

  it('AUTH-07: a raw writer cannot backdate a revocation or forge an observation purpose', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    const db = new Database(c.path);
    try {
      assert.throws(() => db.prepare("INSERT INTO cc_authorization_events (authorization_id, seq, kind, at_ms, reason) VALUES (?, 0, 'REVOKED', 0, 'backdated')").run(a.record.authorizationId), /cc:revocation order/);
      assert.throws(() => db.prepare("INSERT INTO cc_observation_purposes (event_id, challenge_id, authorization_id, purpose, accepted_seq) VALUES ('evt-x', 'chl-x', NULL, 'CONFORMANCE', 1)").run(), /cc:observation purpose (order|forged)/);
    } finally {
      db.close();
    }
    c.cleanup();
  });

  it('AUTH-08: scope changes only through a new version that supersedes a revoked authorization, with fresh approval', () => {
    const c = buildCircuit();
    const v1 = authorize(c);
    v1.commit();
    assert.throws(() => authorize(c, { supersedes: v1.record.authorizationId, operations: ['document.export', 'document.open'] }), registryRefused('AUTHORIZATION_SCOPE'), 'the old one must be revoked first');
    c.services().registry.revokeTestingAuthorization(ORG_A, v1.record.authorizationId, 'scope change (test)');
    const v2 = authorize(c, { supersedes: v1.record.authorizationId, operations: ['document.export', 'document.open'] });
    assert.equal(v2.record.version, 2);
    // The approval binds the exact record: a widened copy fails approval, a record with altered derived fields is refused.
    const widened = { ...v2.record, challengeTypes: ['G01', 'G02'] as const };
    assert.throws(() => c.services().registry.authorizeTesting(widened as never, v2.decisions), registryRefused('APPROVAL_REFUSED'));
    assert.throws(() => c.services().registry.authorizeTesting({ ...v2.record, version: 7 }, v2.decisions), registryRefused('AUTHORIZATION_SCOPE'));
    assert.equal(c.services().registry.getTestingAuthorization(v2.record.authorizationId), undefined);
    // Approvals are single-use: the same decisions cannot approve a second authorization.
    v2.commit();
    assert.ok(c.services().coordinator.issue(request(c, v2.record.authorizationId, { operation: 'document.export' })));
    assert.throws(() => v2.commit());
    c.cleanup();
  });

  it('AUTH-09: two-person approval — one human, a repeated human or a missing decision is refused', () => {
    const c = buildCircuit();
    const same = authorize(c, {}, [c.humans.alice, c.humans.alice]);
    assert.throws(() => same.commit(), registryRefused('APPROVAL_REFUSED'));
    const one = authorize(c);
    assert.throws(() => c.services().registry.authorizeTesting(one.record, one.decisions.slice(0, 1)), registryRefused('APPROVAL_REFUSED'));
    assert.equal(c.services().registry.getTestingAuthorization(one.record.authorizationId), undefined);
    c.cleanup();
  });
});

describe('RN-CONFORM-07 — AUTH-12..15: durable quotas', () => {
  it('AUTH-12: max total is enforced; an idempotent redispatch and an unauthorized request consume nothing', () => {
    const c = buildCircuit();
    const a = authorize(c, { maxTotalChallenges: 2 });
    a.commit();
    const id = a.record.authorizationId;
    const coordinator = c.services().coordinator;
    const first = request(c, id);
    const one = coordinator.issue(first);
    assert.deepEqual(coordinator.issue(first), one, 'redispatch returns the stored challenge');
    assert.equal(c.store.authorizationUsage(id, c.clock.ms()).total, 1, 'redispatch consumed no quota');
    assert.throws(() => coordinator.issue(request(c, id, { operation: 'document.export' })), refusedWith('AUTHORIZATION_INVALID'));
    assert.equal(c.store.authorizationUsage(id, c.clock.ms()).total, 1, 'a refused request consumed no quota');
    // Same idempotency key under a different authorization or purpose is a conflict, never a silent reuse.
    assert.throws(() => coordinator.issue({ ...first, authorizationId: 'auth-some-other' }), refusedWith('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => coordinator.issue({ ...first, purpose: 'VALIDATOR_REQUALIFICATION' }), refusedWith('IDEMPOTENCY_CONFLICT'));
    assert.ok(coordinator.issue(request(c, id)));
    assert.throws(() => coordinator.issue(request(c, id)), refusedWith('QUOTA_EXHAUSTED'));
    c.cleanup();
  });

  it('AUTH-13: per-hour and concurrent limits are enforced and release as time passes', () => {
    const c = buildCircuit();
    const concurrent = authorize(c, { maxConcurrentChallenges: 1, seconds: 7200 });
    concurrent.commit();
    const coordinator = c.services().coordinator;
    assert.ok(coordinator.issue(request(c, concurrent.record.authorizationId)));
    assert.throws(() => coordinator.issue(request(c, concurrent.record.authorizationId)), refusedWith('QUOTA_EXHAUSTED'));
    c.clock.advance(61);
    assert.ok(coordinator.issue(request(c, concurrent.record.authorizationId)), 'the first deadline passed');
    c.services().registry.revokeTestingAuthorization(ORG_A, concurrent.record.authorizationId, 'make room (test)');
    const hourly = authorize(c, { maxChallengesPerHour: 2, seconds: 7200 });
    hourly.commit();
    assert.ok(coordinator.issue(request(c, hourly.record.authorizationId)));
    assert.ok(coordinator.issue(request(c, hourly.record.authorizationId)));
    assert.throws(() => coordinator.issue(request(c, hourly.record.authorizationId)), refusedWith('QUOTA_EXHAUSTED'));
    c.clock.advance(3601);
    assert.ok(coordinator.issue(request(c, hourly.record.authorizationId, { deadlineSeconds: 30 })));
    c.cleanup();
  });

  it('AUTH-14: two coordinators on one store file cannot over-issue (the trigger re-checks inside the write transaction)', () => {
    const c = buildCircuit();
    const a = authorize(c, { maxTotalChallenges: 1 });
    a.commit();
    const second = openConformanceStore(c.path);
    try {
      const coordinator2 = createChallengeCoordinator({ store: second, profiles: c.profiles, clock: c.clock, random: c.random, coordinatorKey: c.coordinatorKey });
      const won = c.services().coordinator.issue(request(c, a.record.authorizationId));
      assert.throws(() => coordinator2.issue(request(c, a.record.authorizationId)), refusedWith('QUOTA_EXHAUSTED'));
      // Skipping both coordinators' pre-checks (a stale second instance racing the first) still cannot exceed the quota.
      const binding = { authorizationId: a.record.authorizationId, authorizationDigest: a.authorizationDigest, purpose: 'CONFORMANCE' as const };
      assert.throws(() => second.insertChallenge(clone(won, 'race'), binding), storeRefused(/quota exhausted/));
      // ...nor bind a challenge to a different purpose, digest or a revoked authorization.
      assert.throws(() => second.insertChallenge(clone(won, 'purpose'), { ...binding, purpose: 'VALIDATOR_REQUALIFICATION' }), storeRefused(/association authorization mismatch/));
      assert.throws(() => second.insertChallenge(clone(won, 'digest'), { ...binding, authorizationDigest: 'sha256:' + '0'.repeat(64) }), storeRefused(/association authorization mismatch/));
    } finally {
      second.close();
    }
    c.reopen();
    assert.equal(c.store.authorizationUsage(a.record.authorizationId, c.clock.ms()).total, 1, 'quota state survives restart');
    c.cleanup();
  });

  it('AUTH-15: limits beyond the synthetic bounds cannot be granted', () => {
    const c = buildCircuit();
    assert.throws(() => authorize(c, { maxChallengesPerHour: 10_001 }), registryRefused('MALFORMED_INPUT'));
    assert.throws(() => authorize(c, { maxConcurrentChallenges: 0 }), registryRefused('MALFORMED_INPUT'));
    assert.throws(() => authorize(c, { seconds: 91 * 86_400 }), registryRefused('MALFORMED_INPUT'));
    c.cleanup();
  });
});

describe('RN-CONFORM-07 — AUTH-10/11/16/17: purpose isolation (S-1)', () => {
  it('AUTH-10/11: requalification evidence is accepted, auditable, never recorded as a violation, never engine input, and its integration can never be credentialed', () => {
    const c = buildCircuit();
    const rq = authorize(c, { purpose: 'VALIDATOR_REQUALIFICATION' });
    rq.commit();
    c.platform.bypass = 'unauthorized-operation';
    const signed = c.services().coordinator.issue(request(c, rq.record.authorizationId, { purpose: 'VALIDATOR_REQUALIFICATION' }));
    const result = submit(c, observe(c, c.validators.A, signed));
    assert.ok(result.accepted && result.observation.outcomeClass === 'violation');
    const eventId = result.accepted ? result.observation.eventId : '';
    assert.equal(c.store.getObservationPurpose(eventId)!.purpose, 'VALIDATOR_REQUALIFICATION');
    const db = new Database(c.path, { readonly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cc_confirmed_violations WHERE event_id = ?').get(eventId) as { n: number }).n, 0, 'not a violation record');
    } finally {
      db.close();
    }
    assert.throws(() => c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest }));
    assert.equal(c.store.hasCredentialForIntegration(ORG_A, c.integration.integrationDigest), false);
    c.cleanup();
  });

  it('AUTH-16: a requalification authorization is refused on an integration that already has a credential', () => {
    const c = buildCircuit();
    c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const rq = authorize(c, { purpose: 'VALIDATOR_REQUALIFICATION' });
    assert.throws(() => rq.commit(), registryRefused('TRANSITION_NOT_ALLOWED'));
    c.cleanup();
  });

  it('AUTH-17: conformance engine input contains only CONFORMANCE-purpose evidence', () => {
    const c = buildCircuit();
    const credential = c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    const ok = submit(c, observe(c, c.validators.A, issue(c, 'G01', [c.validators.A])));
    assert.ok(ok.accepted);
    const assessed = c.services().lifecycle.assess(ORG_A, credential.credentialId)!;
    assert.ok(assessed.engine);
    for (const row of c.store.listObservations(ORG_A, c.integration.integrationDigest)) assert.equal(c.store.getObservationPurpose(row.eventId)!.purpose, 'CONFORMANCE');
    c.cleanup();
  });
});

describe('RN-CONFORM-07 — AUTH-18: no bypass', () => {
  it('there is no unauthorized issuance path: the request type requires an authorization and a purpose', () => {
    const c = buildCircuit();
    const { authorizationId: _a, purpose: _p, ...legacy } = request(c, 'x');
    assert.throws(() => c.services().coordinator.issue(legacy as never), refusedWith('MALFORMED_REQUEST'));
    assert.throws(() => c.services().coordinator.issue({ ...request(c, testingAuthorizationFor(c)), purpose: 'LEGACY' as never }), refusedWith('MALFORMED_REQUEST'));
    c.cleanup();
  });
});

describe('RN-CONFORM-07 — independent review regressions', () => {
  it('#2: no parallel live authorization for the same integration version and purpose; no forked successor', () => {
    const c = buildCircuit();
    const v1 = authorize(c);
    v1.commit();
    const parallel = authorize(c, { operations: ['document.export', 'document.open'] });
    assert.throws(() => parallel.commit(), registryRefused('AUTHORIZATION_SCOPE'));
    c.services().registry.revokeTestingAuthorization(ORG_A, v1.record.authorizationId, 'scope change (test)');
    const v2 = authorize(c, { supersedes: v1.record.authorizationId });
    const fork = authorize(c, { supersedes: v1.record.authorizationId, operations: ['document.export', 'document.open'] });
    v2.commit();
    c.services().registry.revokeTestingAuthorization(ORG_A, v2.record.authorizationId, 'again (test)');
    assert.throws(() => fork.commit(), registryRefused('AUTHORIZATION_SCOPE'), 'a second successor of v1 is refused');
    // The store refuses the same at the trigger, for a caller that skips the registry.
    const db = new Database(c.path, { readonly: true });
    try {
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cc_testing_authorizations_valid'").get() as { sql: string }).sql;
      assert.match(sql, /overlaps a live authorization/);
      assert.match(sql, /already superseded/);
    } finally {
      db.close();
    }
    c.cleanup();
  });

  it('#3: the integration-wide concurrency ceiling spans versions and authorizations (by integration id)', () => {
    const c = buildCircuit();
    const a = authorize(c, { maxConcurrentChallenges: 1000, maxChallengesPerHour: 10_000, seconds: 7200 });
    a.commit();
    const first = c.services().coordinator.issue(request(c, a.record.authorizationId));
    const binding = { authorizationId: a.record.authorizationId, authorizationDigest: a.authorizationDigest, purpose: 'CONFORMANCE' as const };
    for (let i = 1; i < MAX_CONCURRENT_CHALLENGES_PER_INTEGRATION; i += 1) c.store.insertChallenge(clone(first, `fill${i}`), binding);
    // Version 2 of the same integration, its own fresh authorization: still refused at the integration ceiling.
    const profile = c.profiles.resolve(RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileId, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1.profileVersion);
    assert.ok(profile.ok);
    const v2 = c.services().registry.registerIntegrationVersion(integrationInput(profile.digest, { integrationVersion: 2, deploymentDigest: `sha256:${'4'.repeat(64)}` }));
    const now = c.clock.ms();
    const { record, prepared } = c.services().registry.prepareTestingAuthorization({
      authorizationId: 'auth-v2', supersedes: null, organizationId: ORG_A, integrationDigest: v2.integrationDigest, purpose: 'CONFORMANCE', fixtureRefs: [FIXTURE], operations: ['document.open'], challengeTypes: ['G01'],
      notBefore: new Date(now).toISOString(), notAfter: new Date(now + 3_600_000).toISOString(), maxChallengesPerHour: 100, maxConcurrentChallenges: 100, maxTotalChallenges: null,
    });
    c.services().registry.authorizeTesting(record, [decide(c.humans.alice, 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, c.clock.now()), decide(c.humans.bob, 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, c.clock.now())]);
    assert.throws(() => c.services().coordinator.issue(request(c, 'auth-v2', { integrationDigest: v2.integrationDigest })), refusedWith('QUOTA_EXHAUSTED'));
    c.clock.advance(61);
    assert.ok(c.services().coordinator.issue(request(c, 'auth-v2', { integrationDigest: v2.integrationDigest })), 'released once the open challenges close');
    c.cleanup();
  });

  it('#4: a row whose columns or pinned digest differ from its record is CORRUPT on read', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    const db = new Database(c.path);
    try {
      db.exec('DROP TRIGGER cc_testing_authorizations_no_update');
      db.prepare('UPDATE cc_testing_authorizations SET max_concurrent = 999 WHERE authorization_id = ?').run(a.record.authorizationId);
    } finally {
      db.close();
    }
    assert.throws(() => c.store.getTestingAuthorization(a.record.authorizationId), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'CORRUPT');
    c.cleanup();
  });

  it('#5: revocation is tenant-scoped', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    assert.throws(() => c.services().registry.revokeTestingAuthorization(ORG_B, a.record.authorizationId, 'cross-tenant (test)'), registryRefused('UNKNOWN_AUTHORIZATION'));
    assert.equal(c.services().registry.getTestingAuthorization(a.record.authorizationId)!.revokedSeq, null);
    c.cleanup();
  });

  it('#8: a raw revocation cannot reuse the latest sequence (it must exceed every sequence already used)', () => {
    const c = buildCircuit();
    const a = authorize(c);
    a.commit();
    assert.ok(submit(c, observe(c, c.validators.A, c.services().coordinator.issue(request(c, a.record.authorizationId)))).accepted);
    const db = new Database(c.path);
    try {
      assert.throws(() => db.prepare("INSERT INTO cc_authorization_events (authorization_id, seq, kind, at_ms, reason) VALUES (?, (SELECT value FROM cc_order), 'REVOKED', 0, 'reused seq')").run(a.record.authorizationId), /cc:revocation order/);
    } finally {
      db.close();
    }
    c.cleanup();
  });
});
