// RN-CONFORM-07A — compatibility fixture. CI ONLY (job `rn-conform-07a-compat`).
//
// Uses the CURRENT build (./dist) to produce two synthetic conformance stores containing the new SR-6 suspension:
//   suspended.sqlite   ACTIVE → SUSPENDED (T4, ruleId SR-6, reasonCode AUTHORIZATION_WITHDRAWN) after a revocation
//   reinstated.sqlite  … → ACTIVE again through the existing automatic T5 path on fresh, authorized evidence
// The HISTORICAL verifier (rn-conform-07a-compat-verify.mjs, run against main 56a4dc62) then checks them.
//   OUT_DIR  where the stores and compat.json are written
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.env.OUT_DIR;
if (!out) throw new Error('OUT_DIR is required');
const load = (rel) => import(pathToFileURL(join(process.cwd(), 'dist', rel)).href);
const support = await load('src/enterprise/__tests__/conformance-support.js');
const { openConformanceStore } = await load('src/enterprise/conformance/sqlite-conformance-store.js');

const c = support.buildCircuit({ seed: 'rn-conform-07a-compat' });
const credentialId = support.activeCredential(c);
const { ORG_A } = support;
c.services().registry.revokeTestingAuthorization(ORG_A, support.testingAuthorizationFor(c), 'consent withdrawn (compat fixture)');
const evaluated = c.services().lifecycle.evaluate(ORG_A, credentialId);
if (evaluated.evaluation.proposal.ruleId !== 'SR-6' || c.store.getHead(ORG_A, credentialId).reasonCode !== 'AUTHORIZATION_WITHDRAWN') throw new Error('fixture: SR-6 did not fire');
mkdirSync(out, { recursive: true });
const snapshot = (name) => {
  c.store.close();
  copyFileSync(c.path, join(out, name));
  c.store = openConformanceStore(c.path);
};
const suspendedAt = c.clock.now();
snapshot('suspended.sqlite');
c.clock.advance(60);
support.runBaseline(c, [c.validators.A, c.validators.B]);
c.clock.advance(1);
const head = c.services().lifecycle.reinstateAutomatically(ORG_A, credentialId);
if (head.state !== 'ACTIVE') throw new Error('fixture: not reinstated');
const reinstatedAt = c.clock.now();
snapshot('reinstated.sqlite');
const expectation = support.expectation(c, credentialId);
writeFileSync(
  join(out, 'compat.json'),
  `${JSON.stringify({ schema: 'rn.conformance.07a-compat-fixture/1', credentialId, organizationId: ORG_A, registryPublicKeyPem: c.registryPublicKeyPem, coordinatorPublicKeyPem: c.coordinatorPublicKeyPem, expectation, suspendedAt, reinstatedAt }, null, 2)}\n`,
);
c.store.close();
console.log(`compat fixture: ${credentialId} suspended (SR-6 AUTHORIZATION_WITHDRAWN) at ${suspendedAt}, reinstated at ${reinstatedAt}`);
