import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { toMs, type ObservationPayload } from '../conformance/contracts.js';
import { createChallengeCoordinator } from '../conformance/coordinator.js';
import { authenticateStoredObservation, createEvidenceService } from '../conformance/evidence.js';
import { createSyntheticHumanDirectory } from '../conformance/human-authority.js';
import { loadEngineInput } from '../conformance/lifecycle.js';
import { evaluateConformance } from '../conformance/engine.js';
import { createConformanceProfileRegistry } from '../conformance/profile.js';
import { CONFORMANCE_NETWORK_ORGANIZATION, ConformanceRegistryError, createConformanceRegistry } from '../conformance/registry.js';
import { CONFORMANCE_STORE_SCHEMA_VERSION, ConformanceStoreError, migrateConformanceStore, openConformanceStore, type ConformanceStore } from '../conformance/sqlite-conformance-store.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ALL_ACTIONS, ORG_A, ORG_B, decide, deterministicRandom, enrollmentDecisions, manualClock, syntheticHuman, syntheticValidator, testKey } from './conformance-support.js';

/**
 * RN-CONFORM-05 — historical migration regression. The fixture is a REAL rn.conformance.store/2 file produced by the
 * historical code (RN-CONFORM-04 merge e47582dd) through its own insertion paths, by
 * `scripts/conformance/rn-conform-05-v2-fixture.mjs` in the CI job `rn-conform-05-v2-migration`, which sets
 * FRONTERA_RN_CONFORM_05_V2_FIXTURE. Without that directory this suite is skipped (it is never faked from /3 code).
 */

const FIXTURE_DIR = process.env['FRONTERA_RN_CONFORM_05_V2_FIXTURE'];
const skip = FIXTURE_DIR === undefined || FIXTURE_DIR.length === 0 ? 'needs the historical v2 fixture (CI job rn-conform-05-v2-migration)' : false;

interface FixtureRecord {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly integrationDigest: string;
  readonly registryPublicKeyPem: string;
  readonly coordinatorPublicKeyPem: string;
  readonly fixtureNow: string;
  readonly revokedValidator: string;
  readonly operators: readonly string[];
  readonly observations: readonly { eventId: string; challengeId: string; validatorId: string; operatorId: string; observationDigest: string; acceptedAtMs: number; authenticated: string | null }[];
  readonly history: { valid: boolean; stateVersion?: number; state?: string; headTransitionDigest?: string };
  readonly transitions: readonly { stateVersion: number; transitionDigest: string }[];
  readonly evaluations: readonly string[];
  readonly provenance: { readonly commit: string; readonly schemaVersion: string };
}

const V2_TABLES = [
  'cc_profiles', 'cc_platforms', 'cc_integrations', 'cc_operators', 'cc_consumed_decisions', 'cc_validators', 'cc_validator_events', 'cc_challenges', 'cc_evidence_packages',
  'cc_observations', 'cc_confirmed_violations', 'cc_rejections', 'cc_credentials', 'cc_evaluations', 'cc_transitions', 'cc_heads', 'cc_status_assertions', 'cc_anchor_intents',
];
/** A digest of every row of every /2 table (and of cc_meta without its version), read raw. */
function tableDigests(path: string): Record<string, { rows: number; digest: string }> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, { rows: number; digest: string }> = {};
    for (const t of V2_TABLES) {
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

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const workCopy = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-conform-05-v2-'));
  dirs.push(dir);
  const path = join(dir, name);
  copyFileSync(join(FIXTURE_DIR as string, 'fixture.v2.sqlite'), path);
  return path;
};

describe('RN-CONFORM-05 — migration of a REAL historical rn.conformance.store/2 database', { skip }, () => {
  const record = (): FixtureRecord => JSON.parse(readFileSync(join(FIXTURE_DIR as string, 'fixture.v2.json'), 'utf8')) as FixtureRecord;
  const humans = {
    alice: syntheticHuman('human-alice', ORG_A),
    bob: syntheticHuman('human-bob', ORG_A),
    carol: syntheticHuman('human-carol', ORG_A),
    netAlice: syntheticHuman('net-alice', CONFORMANCE_NETWORK_ORGANIZATION),
    netBob: syntheticHuman('net-bob', CONFORMANCE_NETWORK_ORGANIZATION),
    mallory: syntheticHuman('human-mallory', ORG_B),
  };
  const directory = createSyntheticHumanDirectory(Object.values(humans).map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: ALL_ACTIONS })));
  const profiles = createConformanceProfileRegistry();

  /** Every historical property, checked on a store opened by CURRENT code. */
  function verifyHistorical(store: ConformanceStore, r: FixtureRecord) {
    const rows = store.listObservations(r.organizationId, r.integrationDigest);
    assert.equal(rows.length, r.observations.length);
    for (const expected of r.observations) {
      const row = rows.find((o) => o.eventId === expected.eventId);
      assert.ok(row, expected.eventId);
      // Not rewritten, attribution unchanged, and NOT treated as tampered although its operator is now LEGACY.
      assert.deepEqual([row.observationDigest, row.operatorId, row.validatorId, row.challengeId, row.acceptedAtMs], [expected.observationDigest, expected.operatorId, expected.validatorId, expected.challengeId, expected.acceptedAtMs]);
      assert.equal(authenticateStoredObservation(store, profiles, row, r.coordinatorPublicKeyPem), null, `${expected.eventId} re-authenticates`);
    }
    const history = verifyCredentialHistory(store, r.organizationId, r.credentialId, { registryPublicKeyPem: r.registryPublicKeyPem, humans: directory });
    assert.ok(history.valid, 'previously signed credential history remains verifiable');
    assert.deepEqual([history.stateVersion, history.state, history.headTransitionDigest], [r.history.stateVersion, r.history.state, r.history.headTransitionDigest]);
    assert.deepEqual(store.listTransitions(r.organizationId, r.credentialId).map((t) => ({ stateVersion: t.stateVersion, transitionDigest: t.transitionDigest })), r.transitions);
    assert.deepEqual(store.listEvaluations(r.organizationId, r.credentialId).map((e) => e.evaluationDigest), r.evaluations);
    assert.notEqual(store.getValidator(r.revokedValidator)?.keyRevokedAtMs, null, 'the post-acceptance protective event is preserved');
  }

  it('records provenance and the pre-migration state the historical code verified', () => {
    const r = record();
    assert.equal(r.provenance.schemaVersion, 'rn.conformance.store/2');
    assert.ok(r.operators.length >= 2, 'observations from at least two distinct synthetic operators');
    assert.ok(r.history.valid && r.transitions.length >= 2 && r.evaluations.length >= 1);
    assert.ok(r.observations.every((o) => o.authenticated === null));
    assert.throws(() => openConformanceStore(workCopy('refused.sqlite')), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'SCHEMA_MIGRATION_REQUIRED');
  });

  it('an interrupted migration rolls back atomically: the file is byte-for-byte the same /2 store', () => {
    const path = workCopy('interrupted.sqlite');
    const before = { tables: tableDigests(path), master: masterOf(path) };
    assert.throws(() => migrateConformanceStore(path, { faultAfterSchema: () => { throw new Error('synthetic crash mid-migration'); } }), /synthetic crash/);
    assert.deepEqual({ tables: tableDigests(path), master: masterOf(path) }, before);
    assert.throws(() => openConformanceStore(path), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'SCHEMA_MIGRATION_REQUIRED');
  });

  it('migrates without rewriting any historical row; history verifies; LEGACY operators cannot add a new vote; survives restart', () => {
    const r = record();
    const path = workCopy('migrated.sqlite');
    const before = tableDigests(path);
    const masterBefore = masterOf(path);
    const migrationAt = toMs(r.fixtureNow) + 30_000;
    const result = migrateConformanceStore(path, { now: () => migrationAt });
    assert.equal(result.to, CONFORMANCE_STORE_SCHEMA_VERSION);
    assert.equal(result.legacyOperators, 3);
    assert.throws(() => migrateConformanceStore(path), (e: unknown) => e instanceof ConformanceStoreError && e.code === 'ALREADY_CURRENT');
    // Not one historical row changed (every /2 table, row for row).
    assert.deepEqual(tableDigests(path), before);
    // Only the two operator-gated triggers were replaced; every other /2 object is identical, and the operator log is new.
    const masterAfter = masterOf(path);
    const replaced = new Set(['trigger:cc_validators_enrolled', 'trigger:cc_observations_attributed']);
    const keep = (m: string) => !replaced.has(m.split(':').slice(0, 2).join(':'));
    assert.deepEqual(masterAfter.filter((m) => keep(m) && !m.includes('cc_operator_events')), masterBefore.filter(keep));
    assert.ok(masterAfter.some((m) => m.startsWith('table:cc_operator_events:')));

    const clock = manualClock(new Date(migrationAt + 60_000).toISOString());
    for (const attempt of ['first-open', 'after-restart']) {
      const store = openConformanceStore(path);
      try {
        verifyHistorical(store, r);
        for (const op of r.operators) assert.deepEqual(store.listOperatorEvents(op).map((e) => e.kind), ['LEGACY'], `${attempt}: ${op}`);
        const registry = createConformanceRegistry({ store, profiles, clock, humans: directory });
        // No NEW vote from a LEGACY operator: no new validator, no challenge, no accepted observation.
        const fresh = syntheticValidator(`validator-new-${attempt}`, r.operators[0] as string);
        const prep = registry.prepareValidatorEnrollment({ validatorId: fresh.validatorId, operatorId: fresh.operatorId, publicKeyPem: fresh.publicKeyPem, keyValidFrom: clock.now(), keyValidUntil: '2027-11-01T00:00:00.000Z' });
        assert.throws(() => registry.enrollValidator(prep.record, enrollmentDecisions({ humans }, fresh.validatorId, prep.bindingDigest, clock.now())), (e: unknown) => e instanceof ConformanceRegistryError && e.code === 'OPERATOR_NOT_ELIGIBLE');
        const coordinator = createChallengeCoordinator({ store, profiles, clock, random: deterministicRandom(`v2-${attempt}`), coordinatorKey: testKey('coordinator') });
        const historical = r.observations.find((o) => o.validatorId !== r.revokedValidator) as FixtureRecord['observations'][number];
        assert.throws(() => coordinator.issue({ idempotencyKey: `v2-new-${attempt}`, organizationId: r.organizationId, integrationDigest: r.integrationDigest, challengeType: 'G01', operation: 'document.open', fixtureRef: 'fixture-pep-v1', assignedValidatorIds: [historical.validatorId], deadlineSeconds: 300 }), (e: unknown) => e instanceof Error && /VALIDATOR_NOT_ELIGIBLE/.test(e.message));
        const evidence = createEvidenceService({ store, profiles, clock, coordinatorPublicKeyPem: r.coordinatorPublicKeyPem });
        const row = store.getObservation(historical.eventId)!;
        const replay = { ...(JSON.parse(row.submissionJson) as { observation: ObservationPayload; validatorSignature: unknown }) };
        const reissued = { ...replay.observation, eventId: `v2-new-vote-${attempt}` };
        assert.deepEqual(evidence.submitObservation(JSON.stringify({ observation: reissued, validatorSignature: replay.validatorSignature })), { accepted: false, reason: 'OPERATOR_NOT_ELIGIBLE' });
        // Historical evidence grants nothing NOW: every historical validator is excluded from a new evaluation.
        const loaded = loadEngineInput(store, profiles, r.organizationId, r.credentialId, clock.now(), r.coordinatorPublicKeyPem);
        assert.ok(loaded !== undefined);
        assert.deepEqual([...loaded.input.excludedValidatorIds].sort(), [...new Set(r.observations.map((o) => o.validatorId))].sort());
        assert.equal(loaded.unauthenticated.length, 0, 'nothing is reported as tampered');
        const engine = evaluateConformance(loaded.input);
        // (CR-12 is engine-derived from the integration record, not from validator evidence — as in conformance-remediation.test.ts.)
        assert.ok(engine.requirementResults.filter((x) => x.severity === 'critical' && x.requirementId !== 'CR-12').every((x) => x.category !== 'VERIFIED_SUCCESS'), 'no verified success from LEGACY evidence');
        assert.notEqual(engine.proposal.kind, 'ELIGIBLE_FOR_ACTIVE');
      } finally {
        store.close();
      }
    }
  });

  it('a later operator approval or quarantine never changes historical verification or attribution', () => {
    const r = record();
    const path = workCopy('re-approved.sqlite');
    const migrationAt = toMs(r.fixtureNow) + 30_000;
    migrateConformanceStore(path, { now: () => migrationAt });
    const store = openConformanceStore(path);
    try {
      const clock = manualClock(new Date(migrationAt + 60_000).toISOString());
      const registry = createConformanceRegistry({ store, profiles, clock, humans: directory });
      const op = r.operators[0] as string;
      const prepared = registry.prepareOperatorAction(op, 'approve');
      registry.approveOperator(op, [decide(humans.netAlice, 'attest', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, clock.now()), decide(humans.netBob, 'approve', prepared.action, prepared.subjectRef, prepared.actionBindingDigest, clock.now())]);
      verifyHistorical(store, r);
      clock.advance(60);
      registry.quarantineOperator(op, 'post-migration quarantine (test)');
      verifyHistorical(store, r);
      assert.deepEqual(store.listOperatorEvents(op).map((e) => e.kind), ['LEGACY', 'APPROVED', 'QUARANTINED']);
    } finally {
      store.close();
    }
  });
});
