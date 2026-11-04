import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { ChallengeCoordinatorError, createChallengeCoordinator, type ChallengeRequest } from '../conformance/coordinator.js';
import { authenticateStoredObservation } from '../conformance/evidence.js';
import { CONFORMANCE_STORE_SCHEMA_VERSION, createConformanceStoreV2Fixture, migrateConformanceStore, openConformanceStore } from '../conformance/sqlite-conformance-store.js';
import type { TestingAuthorizationPurpose } from '../conformance/testing-authorization.js';
import { ORG_A, buildCircuit, cleanupAll, decide, observe, submit, type Circuit } from './conformance-support.js';

/**
 * RN-CONFORM-07 — WP-10 synthetic demonstration of authoritative testing authorization and evidence-purpose isolation,
 * scenarios A–H. Written as `rn.conformance.authorization-demo-report/1` only when `FRONTERA_RN_CONFORM_07_REPORT_OUT`
 * names a path (CI job `rn-conform-07-demo`). Synthetic fixtures only: no network, no real platform, no real operator,
 * no certification, no ledger transaction. The same test runs inside `validate` (npm test) without writing.
 */

after(cleanupAll);

const FIXTURE = 'fixture-synthetic-pep-v1';
let n = 0;
const authorize = (c: Circuit, o: { purpose?: TestingAuthorizationPurpose; seconds?: number; maxTotalChallenges?: number | null } = {}) => {
  n += 1;
  const now = c.clock.ms();
  const { record, prepared } = c.services().registry.prepareTestingAuthorization({
    authorizationId: `auth-demo-${n}`, supersedes: null, organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, purpose: o.purpose ?? 'CONFORMANCE',
    fixtureRefs: [FIXTURE], operations: ['document.open'], challengeTypes: ['G01'], notBefore: new Date(now).toISOString(), notAfter: new Date(now + (o.seconds ?? 3600) * 1000).toISOString(),
    maxChallengesPerHour: 100, maxConcurrentChallenges: 100, maxTotalChallenges: o.maxTotalChallenges === undefined ? null : o.maxTotalChallenges,
  });
  const at = c.clock.now();
  const stored = c.services().registry.authorizeTesting(record, [
    decide(c.humans.alice, 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at),
    decide(c.humans.bob, 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, at),
  ]);
  return stored;
};
const req = (c: Circuit, authorizationId: string, o: Partial<ChallengeRequest> = {}): ChallengeRequest => {
  n += 1;
  return { idempotencyKey: `demo-${n}`, organizationId: ORG_A, integrationDigest: c.integration.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: FIXTURE, assignedValidatorIds: [c.validators.A.validatorId], deadlineSeconds: 60, authorizationId, purpose: 'CONFORMANCE', ...o };
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return 'ISSUED';
  } catch (e) {
    return e instanceof ChallengeCoordinatorError ? e.code : `ERROR:${e instanceof Error ? e.message : String(e)}`;
  }
};

describe('RN-CONFORM-07 — synthetic testing-authorization demonstration (A–H)', () => {
  it('runs scenarios A–H and reports what each proves', () => {
    const c = buildCircuit();

    // A — two-person authorization, then authorized issuance and acceptance.
    const a = authorize(c);
    const signedA = c.services().coordinator.issue(req(c, a.record.authorizationId));
    const acceptedA = submit(c, observe(c, c.validators.A, signedA));
    assert.ok(acceptedA.accepted);
    const A = { authorizationId: a.record.authorizationId, version: a.record.version, activatedSeq: a.activatedSeq, challengeId: signedA.challenge.challengeId, observationAccepted: acceptedA.accepted, purpose: c.store.getObservationPurpose(acceptedA.accepted ? acceptedA.observation.eventId : '')?.purpose };

    // B — no authorization: refused, nothing consumed.
    const B = { unknownAuthorization: refusal(() => c.services().coordinator.issue(req(c, 'auth-never-approved'))) };
    assert.equal(B.unknownAuthorization, 'AUTHORIZATION_INVALID');

    // C — outside scope (operation, challenge type, purpose).
    const C = {
      operation: refusal(() => c.services().coordinator.issue(req(c, a.record.authorizationId, { operation: 'document.export' }))),
      challengeType: refusal(() => c.services().coordinator.issue(req(c, a.record.authorizationId, { challengeType: 'G02' }))),
      purpose: refusal(() => c.services().coordinator.issue(req(c, a.record.authorizationId, { purpose: 'VALIDATOR_REQUALIFICATION' }))),
    };
    assert.deepEqual(Object.values(C), ['AUTHORIZATION_INVALID', 'AUTHORIZATION_INVALID', 'AUTHORIZATION_INVALID']);

    // D — revocation in the same millisecond as an acceptance: ordered by the durable sequence.
    const pending = observe(c, c.validators.B, c.services().coordinator.issue(req(c, a.record.authorizationId, { assignedValidatorIds: [c.validators.B.validatorId] })));
    c.services().registry.revokeTestingAuthorization(ORG_A, a.record.authorizationId, 'demo revocation');
    const revoked = c.services().registry.getTestingAuthorization(a.record.authorizationId)!;
    const late = submit(c, pending);
    const historicalRow = c.store.getObservation(acceptedA.accepted ? acceptedA.observation.eventId : '')!;
    const D = {
      revokedSeq: revoked.revokedSeq,
      acceptedSeq: c.store.getObservationPurpose(historicalRow.eventId)?.acceptedSeq,
      sameMillisecond: revoked.revokedAtMs === historicalRow.acceptedAtMs,
      newChallenge: refusal(() => c.services().coordinator.issue(req(c, a.record.authorizationId))),
      lateObservation: late.accepted ? 'ACCEPTED' : late.reason,
      historicalStillAuthentic: authenticateStoredObservation(c.store, c.profiles, historicalRow, c.coordinatorPublicKeyPem) === null,
    };
    assert.deepEqual([D.newChallenge, D.lateObservation, D.historicalStillAuthentic], ['AUTHORIZATION_REVOKED', 'AUTHORIZATION_REVOKED', true]);

    // E — expiry.
    const e = authorize(c, { seconds: 90 });
    const signedE = c.services().coordinator.issue(req(c, e.record.authorizationId));
    const rawE = observe(c, c.validators.A, signedE);
    c.clock.advance(91);
    const lateE = submit(c, rawE);
    const E = { newChallenge: refusal(() => c.services().coordinator.issue(req(c, e.record.authorizationId, { deadlineSeconds: 1 }))), observationAfterExpiry: lateE.accepted ? 'ACCEPTED' : lateE.reason };
    assert.deepEqual(Object.values(E), ['AUTHORIZATION_WINDOW', 'AUTHORIZATION_EXPIRED']);

    // F — quota exhaustion across two coordinators on one store; idempotent redispatch consumes nothing.
    const f = authorize(c, { maxTotalChallenges: 1 });
    const firstF = req(c, f.record.authorizationId);
    c.services().coordinator.issue(firstF);
    c.services().coordinator.issue(firstF);
    const second = openConformanceStore(c.path);
    let F: Record<string, unknown>;
    try {
      const coordinator2 = createChallengeCoordinator({ store: second, profiles: c.profiles, clock: c.clock, random: c.random, coordinatorKey: c.coordinatorKey });
      F = { usedAfterRedispatch: c.store.authorizationUsage(f.record.authorizationId, c.clock.ms()).total, secondCoordinator: refusal(() => coordinator2.issue(req(c, f.record.authorizationId))) };
    } finally {
      second.close();
    }
    assert.deepEqual(Object.values(F), [1, 'QUOTA_EXHAUSTED']);

    // G — requalification evidence never becomes conformance evidence; its integration can never be credentialed.
    const g = authorize(c, { purpose: 'VALIDATOR_REQUALIFICATION' });
    c.platform.bypass = 'unauthorized-operation';
    const rq = submit(c, observe(c, c.validators.A, c.services().coordinator.issue(req(c, g.record.authorizationId, { purpose: 'VALIDATOR_REQUALIFICATION' }))));
    c.platform.bypass = 'none';
    const db = new Database(c.path, { readonly: true });
    let violationRecords: number;
    try {
      violationRecords = (db.prepare('SELECT COUNT(*) AS n FROM cc_confirmed_violations WHERE event_id = ?').get(rq.accepted ? rq.observation.eventId : '') as { n: number }).n;
    } finally {
      db.close();
    }
    let credentialRefused = false;
    try {
      c.services().lifecycle.registerCandidate({ organizationId: ORG_A, integrationDigest: c.integration.integrationDigest });
    } catch {
      credentialRefused = true;
    }
    const G = { accepted: rq.accepted, outcome: rq.accepted ? rq.observation.outcomeClass : null, purpose: c.store.getObservationPurpose(rq.accepted ? rq.observation.eventId : '')?.purpose, violationRecords, credentialRefused };
    assert.deepEqual([G.purpose, G.violationRecords, G.credentialRefused], ['VALIDATOR_REQUALIFICATION', 0, true]);

    // H — legacy migration (a /2 store created by the current helper, chained /2 → /3 → /4): no authorization granted.
    const legacyPath = join(c.dir, 'legacy-demo.sqlite');
    createConformanceStoreV2Fixture(legacyPath);
    const migration = migrateConformanceStore(legacyPath, { now: () => c.clock.ms() });
    const legacy = openConformanceStore(legacyPath);
    let H: Record<string, unknown>;
    try {
      const ldb = new Database(legacyPath, { readonly: true });
      try {
        H = { from: migration.from, to: migration.to, steps: migration.steps, authorizationsGranted: (ldb.prepare('SELECT COUNT(*) AS n FROM cc_testing_authorizations').get() as { n: number }).n };
      } finally {
        ldb.close();
      }
    } finally {
      legacy.close();
    }
    assert.deepEqual([H['to'], H['authorizationsGranted']], [CONFORMANCE_STORE_SCHEMA_VERSION, 0]);

    const report = {
      schema: 'rn.conformance.authorization-demo-report/1',
      designation: 'SYNTHETIC DEMONSTRATION — synthetic fixtures and Republika-controlled synthetic operators only; no real platform tested; not a certification; no ledger transaction; AI-reviewed only.',
      storeSchema: CONFORMANCE_STORE_SCHEMA_VERSION,
      A_authorizedIssuance: A,
      B_unauthorizedRefused: B,
      C_scopeViolations: C,
      D_revocationDurableOrder: D,
      E_expiry: E,
      F_quotaAcrossCoordinators: F,
      G_requalificationIsolation: G,
      H_legacyMigration: H,
    };
    const text = JSON.stringify(report);
    for (const needle of ['PRIVATE KEY', 'BEGIN PUBLIC KEY']) assert.ok(!text.includes(needle), needle);
    const out = process.env['FRONTERA_RN_CONFORM_07_REPORT_OUT'];
    if (out !== undefined && out.length > 0) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      const summary = [
        '# RN-CONFORM-07 synthetic testing-authorization demonstration',
        '',
        report.designation,
        '',
        `- A: two-person authorization ${A.authorizationId} v${A.version} → challenge issued, observation accepted (${A.purpose})`,
        `- B: unknown authorization → ${B.unknownAuthorization}`,
        `- C: operation / challenge type / purpose outside scope → ${Object.values(C).join(' / ')}`,
        `- D: revocation seq ${D.revokedSeq} after acceptance seq ${D.acceptedSeq} (same ms: ${D.sameMillisecond}) → new challenge ${D.newChallenge}, late observation ${D.lateObservation}, historical evidence authentic: ${D.historicalStillAuthentic}`,
        `- E: after expiry → new challenge ${E.newChallenge}, delayed observation ${E.observationAfterExpiry}`,
        `- F: total quota 1, redispatch used ${String(F['usedAfterRedispatch'])}; second coordinator → ${String(F['secondCoordinator'])}`,
        `- G: requalification observation ${G.outcome} recorded as ${G.purpose}, ${G.violationRecords} violation records, credential refused: ${G.credentialRefused}`,
        `- H: ${String(H['from'])} → ${String(H['to'])}, ${String(H['authorizationsGranted'])} authorizations granted to legacy data`,
        '',
      ].join('\n');
      writeFileSync(`${out.replace(/\.json$/, '')}.summary.md`, summary);
    }
    c.cleanup();
  });
});
