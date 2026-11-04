import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { toMs, type ObservationPayload } from '../conformance/contracts.js';
import { ChallengeCoordinatorError, createChallengeCoordinator } from '../conformance/coordinator.js';
import { authenticateStoredObservation, createEvidenceService } from '../conformance/evidence.js';
import { createSyntheticHumanDirectory } from '../conformance/human-authority.js';
import { loadEngineInput } from '../conformance/lifecycle.js';
import { createConformanceProfileRegistry } from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION } from '../conformance/registry.js';
import { CONFORMANCE_STORE_SCHEMA_VERSION, ConformanceStoreError, migrateConformanceStore, openConformanceStore, type ConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ALL_ACTIONS, ORG_A, ORG_B, deterministicRandom, manualClock, syntheticHuman, testKey } from './conformance-support.js';

/**
 * RN-CONFORM-07 — historical migration regression /3 → /4. The fixture is a REAL rn.conformance.store/3 file produced by
 * the historical code (main 9ddd66bd: RN-CONFORM-05 store /3 + RN-CONFORM-06 docs) through its own insertion paths, by
 * `scripts/conformance/rn-conform-07-v3-fixture.mjs` in the CI job `rn-conform-07-v3-migration`, which sets
 * FRONTERA_RN_CONFORM_07_V3_FIXTURE. Without that directory this suite is skipped (it is never faked from /4 code).
 */

const FIXTURE_DIR = process.env['FRONTERA_RN_CONFORM_07_V3_FIXTURE'];
const skip = FIXTURE_DIR === undefined || FIXTURE_DIR.length === 0 ? 'needs the historical v3 fixture (CI job rn-conform-07-v3-migration)' : false;

interface FixtureRecord {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly integrationDigest: string;
  readonly registryPublicKeyPem: string;
  readonly coordinatorPublicKeyPem: string;
  readonly fixtureNow: string;
  readonly revokedValidator: string;
  readonly operators: readonly string[];
  readonly operatorEvents: Readonly<Record<string, readonly string[]>>;
  readonly challenges: readonly string[];
  readonly observations: readonly { eventId: string; challengeId: string; validatorId: string; operatorId: string; observationDigest: string; acceptedAtMs: number; authenticated: string | null }[];
  readonly history: { valid: boolean; stateVersion?: number; state?: string; headTransitionDigest?: string };
  readonly transitions: readonly { stateVersion: number; transitionDigest: string }[];
  readonly evaluations: readonly string[];
  readonly provenance: { readonly commit: string; readonly schemaVersion: string };
}

const V3_TABLES = [
  'cc_profiles', 'cc_platforms', 'cc_integrations', 'cc_operators', 'cc_consumed_decisions', 'cc_validators', 'cc_validator_events', 'cc_challenges', 'cc_evidence_packages',
  'cc_observations', 'cc_confirmed_violations', 'cc_rejections', 'cc_credentials', 'cc_evaluations', 'cc_transitions', 'cc_heads', 'cc_status_assertions', 'cc_anchor_intents',
  'cc_operator_events',
];
function tableDigests(path: string): Record<string, { rows: number; digest: string }> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, { rows: number; digest: string }> = {};
    for (const t of V3_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
      out[t] = { rows: rows.length, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    const meta = db.prepare('SELECT id, synthetic FROM cc_meta').all();
    out['cc_meta(id,synthetic)'] = { rows: meta.length, digest: createHash('sha256').update(JSON.stringify(meta)).digest('hex') };
    return out;
  } finally {
    db.close();
  }
}
const masterOf = (path: string): string[] => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[]).map((r) => `${r.type}:${r.name}:${r.sql ?? ''}`);
  } finally {
    db.close();
  }
};
const count = (path: string, sql: string): number => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const workCopy = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-conform-07-v3-'));
  dirs.push(dir);
  const path = join(dir, name);
  copyFileSync(join(FIXTURE_DIR as string, 'fixture.v3.sqlite'), path);
  return path;
};
const refused = (code: string) => (e: unknown) => e instanceof ConformanceStoreError && e.code === code;

describe('RN-CONFORM-07 — migration of a REAL historical rn.conformance.store/3 database to /4', { skip }, () => {
  const record = (): FixtureRecord => JSON.parse(readFileSync(join(FIXTURE_DIR as string, 'fixture.v3.json'), 'utf8')) as FixtureRecord;
  const humans = [
    syntheticHuman('human-alice', ORG_A), syntheticHuman('human-bob', ORG_A), syntheticHuman('human-carol', ORG_A),
    syntheticHuman('net-alice', CONFORMANCE_NETWORK_ORGANIZATION), syntheticHuman('net-bob', CONFORMANCE_NETWORK_ORGANIZATION), syntheticHuman('human-mallory', ORG_B),
  ];
  const directory = createSyntheticHumanDirectory(humans.map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: ALL_ACTIONS })));
  const profiles = createConformanceProfileRegistry();

  function verifyHistorical(store: ConformanceStore, r: FixtureRecord) {
    const rows = store.listObservations(r.organizationId, r.integrationDigest);
    assert.equal(rows.length, r.observations.length);
    for (const expected of r.observations) {
      const row = rows.find((o) => o.eventId === expected.eventId);
      assert.ok(row, expected.eventId);
      assert.deepEqual([row.observationDigest, row.operatorId, row.validatorId, row.challengeId, row.acceptedAtMs], [expected.observationDigest, expected.operatorId, expected.validatorId, expected.challengeId, expected.acceptedAtMs]);
      assert.equal(authenticateStoredObservation(store, profiles, row, r.coordinatorPublicKeyPem), null, `${expected.eventId} re-authenticates`);
      assert.equal(store.getObservationPurpose(row.eventId)?.purpose, 'LEGACY');
      assert.equal(store.getChallengeAuthorization(row.challengeId)?.purpose, 'LEGACY');
    }
    const history = verifyCredentialHistory(store, r.organizationId, r.credentialId, { registryPublicKeyPem: r.registryPublicKeyPem, humans: directory });
    assert.ok(history.valid, 'previously signed credential history remains verifiable');
    assert.deepEqual([history.stateVersion, history.state, history.headTransitionDigest], [r.history.stateVersion, r.history.state, r.history.headTransitionDigest]);
    assert.deepEqual(store.listTransitions(r.organizationId, r.credentialId).map((t) => ({ stateVersion: t.stateVersion, transitionDigest: t.transitionDigest })), r.transitions);
    assert.deepEqual(store.listEvaluations(r.organizationId, r.credentialId).map((e) => e.evaluationDigest), r.evaluations);
    // RN-CONFORM-05 operator history is preserved exactly.
    for (const op of r.operators) assert.deepEqual(store.listOperatorEvents(op).map((e) => e.kind), r.operatorEvents[op]);
  }

  it('records provenance; the historical code verified its own /3 state; current code refuses to open it unmigrated', () => {
    const r = record();
    assert.equal(r.provenance.schemaVersion, 'rn.conformance.store/3');
    assert.ok(r.operators.length >= 2 && r.history.valid && r.observations.every((o) => o.authenticated === null));
    assert.ok(r.operators.every((op) => (r.operatorEvents[op] ?? []).includes('APPROVED')), 'a genuine /3 store: operators carry RN-05 approval events');
    assert.throws(() => openConformanceStore(workCopy('refused.sqlite')), refused('SCHEMA_MIGRATION_REQUIRED'));
  });

  it('an interrupted migration rolls back atomically: every table and schema object is unchanged', () => {
    const path = workCopy('interrupted.sqlite');
    const before = { tables: tableDigests(path), master: masterOf(path) };
    assert.throws(() => migrateConformanceStore(path, { faultAfterSchema: () => { throw new Error('synthetic crash mid-migration'); } }), /synthetic crash/);
    assert.deepEqual({ tables: tableDigests(path), master: masterOf(path) }, before);
    assert.throws(() => openConformanceStore(path), refused('SCHEMA_MIGRATION_REQUIRED'));
  });

  it('tampered or partial /3 state is refused, never repaired', () => {
    const tampered = workCopy('tampered.sqlite');
    let db = new Database(tampered);
    db.exec('DROP TRIGGER cc_operator_events_valid');
    db.close();
    assert.throws(() => migrateConformanceStore(tampered), refused('CORRUPT'));
    const partial = workCopy('partial.sqlite');
    db = new Database(partial);
    db.exec('CREATE TABLE cc_order (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL CHECK (value >= 0))');
    db.close();
    assert.throws(() => migrateConformanceStore(partial), refused('CORRUPT'));
  });

  it('migrates /3 → /4 without rewriting a row; every historical challenge and observation is LEGACY; no authorization is granted; survives restart', () => {
    const r = record();
    const path = workCopy('migrated.sqlite');
    const before = tableDigests(path);
    const masterBefore = masterOf(path);
    const migrationAt = toMs(r.fixtureNow) + 30_000;
    const challenges = count(path, 'SELECT COUNT(*) AS n FROM cc_challenges');
    const observations = count(path, 'SELECT COUNT(*) AS n FROM cc_observations');
    const result = migrateConformanceStore(path, { now: () => migrationAt });
    assert.deepEqual([result.from, result.to, result.legacyChallenges, result.legacyObservations], ['rn.conformance.store/3', CONFORMANCE_STORE_SCHEMA_VERSION, challenges, observations]);
    assert.throws(() => migrateConformanceStore(path), refused('ALREADY_CURRENT'));
    assert.deepEqual(tableDigests(path), before, 'not one historical row changed');
    const replaced = new Set(['trigger:cc_observations_attributed', 'trigger:cc_observations_record_violation']);
    const nameOf = (m: string) => m.split(':').slice(0, 2).join(':');
    for (const m of masterBefore) if (!replaced.has(nameOf(m))) assert.ok(masterAfterIncludes(path, m), `${nameOf(m)} unchanged`);
    assert.equal(count(path, 'SELECT COUNT(*) AS n FROM cc_testing_authorizations'), 0, 'legacy integrations receive NO authorization');
    assert.equal(count(path, "SELECT COUNT(*) AS n FROM cc_challenge_authorizations WHERE purpose = 'LEGACY'"), challenges);
    assert.equal(count(path, "SELECT COUNT(*) AS n FROM cc_observation_purposes WHERE purpose = 'LEGACY'"), observations);

    const clock = manualClock(new Date(migrationAt + 60_000).toISOString());
    for (const attempt of ['first-open', 'after-restart']) {
      const store = openConformanceStore(path);
      try {
        verifyHistorical(store, r);
        // No new challenge without an explicit authorization (the historical validators are still eligible).
        const coordinator = createChallengeCoordinator({ store, profiles, clock, random: deterministicRandom(`v3-${attempt}`), coordinatorKey: testKey('coordinator') });
        const historical = r.observations.find((o) => o.validatorId !== r.revokedValidator) as FixtureRecord['observations'][number];
        assert.throws(
          () => coordinator.issue({ idempotencyKey: `v3-new-${attempt}`, organizationId: r.organizationId, integrationDigest: r.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: 'fixture-synthetic-pep-v1', assignedValidatorIds: [historical.validatorId], deadlineSeconds: 300, authorizationId: 'auth-legacy-none', purpose: 'CONFORMANCE' }),
          (e: unknown) => e instanceof ChallengeCoordinatorError && e.code === 'AUTHORIZATION_INVALID',
        );
        // A LEGACY challenge never accepts a new observation.
        const evidence = createEvidenceService({ store, profiles, clock, coordinatorPublicKeyPem: r.coordinatorPublicKeyPem });
        const row = store.getObservation(historical.eventId)!;
        const replay = JSON.parse(row.submissionJson) as { observation: ObservationPayload; validatorSignature: unknown };
        const reissued = { ...replay.observation, eventId: `v3-new-vote-${attempt}` };
        assert.equal(evidence.submitObservation(JSON.stringify({ observation: reissued, validatorSignature: replay.validatorSignature })).accepted, false);
        // LEGACY evidence stays authentic but never reaches the engine for a new evaluation.
        const loaded = loadEngineInput(store, profiles, r.organizationId, r.credentialId, clock.now(), r.coordinatorPublicKeyPem);
        assert.ok(loaded !== undefined);
        assert.equal(loaded.unauthenticated.length, 0, 'nothing is reported as tampered');
        assert.equal(loaded.input.observations.length, 0, 'no LEGACY observation is conformance evidence for a new evaluation');
      } finally {
        store.close();
      }
    }
  });
});

function masterAfterIncludes(path: string, m: string): boolean {
  return masterOf(path).includes(m);
}
