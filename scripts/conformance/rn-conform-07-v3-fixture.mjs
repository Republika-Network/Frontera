// RN-CONFORM-07 — historical rn.conformance.store/3 fixture generator. CI ONLY (job `rn-conform-07-v3-migration`).
//
// Runs the HISTORICAL code — main at 9ddd66bd (RN-CONFORM-05 /3 store + RN-CONFORM-06 docs), built in its own checkout —
// through its own original insertion paths (the test circuit: profile, platforms, integration, three synthetic operators
// approved by two network humans, validators enrolled by two humans, signed challenges, evidence packages, signed observations from two distinct
// operators, a committed evaluation, a two-person issuance, then a protective key revocation AFTER acceptance). It
// records what the historical code itself verifies, then copies the closed store file. Nothing here uses current code.
//
//   V3_ROOT  absolute path of the historical checkout (built: V3_ROOT/dist exists)
//   OUT_DIR  where fixture.v3.sqlite and fixture.v3.json are written
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.V3_ROOT;
const out = process.env.OUT_DIR;
if (!root || !out) throw new Error('V3_ROOT and OUT_DIR are required');
const load = (rel) => import(pathToFileURL(join(root, 'dist', rel)).href);

const support = await load('src/enterprise/__tests__/conformance-support.js');
const { CONFORMANCE_STORE_SCHEMA_VERSION } = await load('src/enterprise/conformance/sqlite-conformance-store.js');
const { verifyCredentialHistory } = await load('src/enterprise/conformance/verifier.js');
const { authenticateStoredObservation } = await load('src/enterprise/conformance/evidence.js');
if (CONFORMANCE_STORE_SCHEMA_VERSION !== 'rn.conformance.store/3') throw new Error(`historical code is ${CONFORMANCE_STORE_SCHEMA_VERSION}, not /3`);

const c = support.buildCircuit({ seed: 'rn-conform-07-v3-fixture' });
const credentialId = support.activeCredential(c); // two operators (A, B), signed challenges, evidence, two-person issuance
c.clock.advance(60);
const evaluated = c.services().lifecycle.evaluate(support.ORG_A, credentialId); // a further committed evaluation
c.clock.advance(60);
// Protective event AFTER acceptance: validator-b's key is revoked (its accepted evidence stays, history untouched).
c.services().registry.revokeValidatorKey('validator-b', 'post-acceptance protective event (v3 fixture)');

const observations = c.store.listObservations(support.ORG_A, c.integration.integrationDigest);
const history = verifyCredentialHistory(c.store, support.ORG_A, credentialId, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });
const record = {
  schema: 'rn.conformance.v3-migration-fixture/1',
  provenance: { commit: process.env.V3_COMMIT ?? 'unknown', schemaVersion: CONFORMANCE_STORE_SCHEMA_VERSION, generator: 'scripts/conformance/rn-conform-07-v3-fixture.mjs', harness: 'historical src/enterprise/__tests__/conformance-support.ts buildCircuit + activeCredential' },
  organizationId: support.ORG_A,
  credentialId,
  integrationDigest: c.integration.integrationDigest,
  registryPublicKeyPem: c.registryPublicKeyPem,
  coordinatorPublicKeyPem: c.coordinatorPublicKeyPem,
  fixtureNow: c.clock.now(),
  revokedValidator: 'validator-b',
  evaluationProposal: evaluated.evaluation.proposal,
  observations: observations.map((o) => ({
    eventId: o.eventId,
    challengeId: o.challengeId,
    validatorId: o.validatorId,
    operatorId: o.operatorId,
    observationDigest: o.observationDigest,
    acceptedAtMs: o.acceptedAtMs,
    outcomeClass: o.outcomeClass,
    authenticated: authenticateStoredObservation(c.store, c.profiles, o, c.coordinatorPublicKeyPem),
  })),
  operators: [...new Set(observations.map((o) => o.operatorId))].sort(),
  operatorEvents: Object.fromEntries([...new Set(observations.map((o) => o.operatorId))].sort().map((op) => [op, c.store.listOperatorEvents(op).map((e) => e.kind)])),
  challenges: [...new Set(observations.map((o) => o.challengeId))].sort(),
  history: history.valid ? { valid: true, stateVersion: history.stateVersion, state: history.state, headTransitionDigest: history.headTransitionDigest } : { valid: false, failure: history.failure },
  transitions: c.store.listTransitions(support.ORG_A, credentialId).map((t) => ({ stateVersion: t.stateVersion, transitionDigest: t.transitionDigest })),
  evaluations: c.store.listEvaluations(support.ORG_A, credentialId).map((e) => e.evaluationDigest),
};
if (record.operators.length < 2 || !record.history.valid || record.observations.some((o) => o.authenticated !== null)) throw new Error(`historical fixture is not valid under the historical code: ${JSON.stringify({ operators: record.operators, history: record.history })}`);
c.store.close();
mkdirSync(out, { recursive: true });
// The last connection closed, so SQLite has checkpointed the WAL into the main file; refuse to copy a half state.
if (existsSync(`${c.path}-wal`)) throw new Error('WAL still present after close; refusing to copy an incomplete fixture');
copyFileSync(c.path, join(out, 'fixture.v3.sqlite'));
writeFileSync(join(out, 'fixture.v3.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`v3 fixture: ${record.observations.length} observations from ${record.operators.join(', ')}, history v${record.history.stateVersion}, ${record.evaluations.length} evaluations`);
