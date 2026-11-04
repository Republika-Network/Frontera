// RN-CONFORM-07A — the HISTORICAL verifier (main 56a4dc62, before SR-6 existed) checks stores written by the current
// code. CI ONLY (job `rn-conform-07a-compat`). Proves, rather than claims, how existing verifiers treat the new reason:
//   - the signed history (with the SR-6 T4 and the automatic T5) verifies under the original signing contract;
//   - a SUSPENDED (AUTHORIZATION_WITHDRAWN) credential is never reported CONFORMANT (fails safe);
//   - after reinstatement on fresh authorized evidence the historical verifier reports it as the current one does.
//   HIST_ROOT  absolute path of the built historical checkout;  FIXTURE_DIR  output of rn-conform-07a-compat-fixture.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.HIST_ROOT;
const dir = process.env.FIXTURE_DIR;
if (!root || !dir) throw new Error('HIST_ROOT and FIXTURE_DIR are required');
const load = (rel) => import(pathToFileURL(join(root, 'dist', rel)).href);
const support = await load('src/enterprise/__tests__/conformance-support.js');
const { openConformanceStore } = await load('src/enterprise/conformance/sqlite-conformance-store.js');
const { verifyCredentialHistory, verifyCurrentConformance } = await load('src/enterprise/conformance/verifier.js');
const { createSyntheticHumanDirectory } = await load('src/enterprise/conformance/human-authority.js');
const { createConformanceProfileRegistry } = await load('src/enterprise/conformance/profile.js');
const { CONFORMANCE_NETWORK_ORGANIZATION } = await load('src/enterprise/conformance/registry.js');

const r = JSON.parse(readFileSync(join(dir, 'compat.json'), 'utf8'));
const humans = [
  support.syntheticHuman('human-alice', support.ORG_A), support.syntheticHuman('human-bob', support.ORG_A), support.syntheticHuman('human-carol', support.ORG_A),
  support.syntheticHuman('net-alice', CONFORMANCE_NETWORK_ORGANIZATION), support.syntheticHuman('net-bob', CONFORMANCE_NETWORK_ORGANIZATION), support.syntheticHuman('human-mallory', support.ORG_B),
];
const directory = createSyntheticHumanDirectory(humans.map((h) => ({ principalId: h.principalId, organizationId: h.organizationId, keys: [{ publicKeyPem: h.publicKeyPem }], permissions: support.ALL_ACTIONS })));
const results = {};
for (const [name, at, expectState] of [['suspended.sqlite', r.suspendedAt, 'SUSPENDED'], ['reinstated.sqlite', r.reinstatedAt, 'ACTIVE']]) {
  const store = openConformanceStore(join(dir, name));
  try {
    const history = verifyCredentialHistory(store, r.organizationId, r.credentialId, { registryPublicKeyPem: r.registryPublicKeyPem, humans: directory });
    if (!history.valid) throw new Error(`${name}: historical verifier rejects the history: ${history.failure}@${history.atStateVersion}`);
    if (history.state !== expectState) throw new Error(`${name}: state ${history.state}, expected ${expectState}`);
    const sr6 = history.transitions.find((t) => t.reasonCode === 'AUTHORIZATION_WITHDRAWN');
    if (sr6 === undefined || sr6.transitionCode !== 'T4' || sr6.ruleId !== 'SR-6') throw new Error(`${name}: SR-6 transition missing`);
    const verdict = verifyCurrentConformance({ store, profiles: createConformanceProfileRegistry(), registryPublicKeyPem: r.registryPublicKeyPem, coordinatorPublicKeyPem: r.coordinatorPublicKeyPem, humans: directory }, r.expectation, at);
    if (expectState === 'SUSPENDED' && verdict.reason === 'CONFORMANT') throw new Error('historical verifier reports a withdrawn credential CONFORMANT');
    results[name] = { historyValid: true, state: history.state, stateVersion: history.stateVersion, transitions: history.transitions.map((t) => `${t.transitionCode}:${t.reasonCode}`), historicalVerdict: verdict.reason };
  } finally {
    store.close();
  }
}
writeFileSync(join(dir, 'historical-verifier.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
