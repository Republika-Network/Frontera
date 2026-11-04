import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-2A3A — FV operator credential revocation stays internal and non-operational: nothing in the Host, its
// scripts, its deployment, the dedicated executor or its supervisor invokes the ceremony; AUTH-03's FV revocation is
// written by it alone and decides the authority itself (current administrator, verified operator target, exact
// credential, no unfinished enrolment, one row); no Host administrator, enrolment token or G-02A capability is involved.

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(ROOT, 'src');
const MODULE = join(SRC, 'enterprise', 'sovereign-status-history');
const IDENTITY = join(SRC, 'enterprise', 'human-identity');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const CEREMONY = join(MODULE, 'identity-registration-revocation.ts');
const ROWS = join(IDENTITY, 'fv-revocation.ts');

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}
const productionSources = () => walk(SRC, (p) => p.endsWith('.ts') && !p.includes('__tests__'));

describe('FV-P4C-2B3C-2A3A structure — the revocation is internal, unique and decided by AUTH-03', () => {
  it('nothing outside the ceremony family reaches it or AUTH-03’s FV revocation; neither is exported; the executor is untouched', () => {
    const NAMES = /revokeFvOperatorCredential|resumeFvOperatorRevocation|identity-registration-revocation/;
    const outside = [...productionSources().filter((p) => !p.startsWith(join(MODULE, 'identity-registration'))), ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts|sh)$/.test(p)), ...walk(join(ROOT, 'deploy'), () => true), join(ROOT, 'Dockerfile'), join(ROOT, 'package.json')].filter((file) => existsSync(file) && NAMES.test(read(file)));
    assert.deepEqual(outside.map((f) => relative(ROOT, f)), []);
    const users = productionSources().filter((p) => p !== ROWS && /fv-revocation\.js'/.test(read(p)));
    assert.deepEqual(users.map((f) => relative(ROOT, f)), [relative(ROOT, CEREMONY)]);
    assert.equal(/fv-revocation/.test(read(join(IDENTITY, 'index.ts'))), false);
    assert.equal(/Revocation|identity-registration-revocation/.test(read(join(MODULE, 'index.ts'))), false);
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-main.ts', 'dedicated-executor-supervisor.ts', 'dedicated-executor-protocol.ts', 'protected-host-composition.ts']) {
      assert.equal(/fv-revocation|identity-registration-revocation|FvRevocation/.test(read(join(MODULE, name))), false, name);
    }
    assert.match(read(join(MODULE, 'dedicated-executor-main.ts')), /compose: undefined,/);
  });

  it('AUTH-03 decides: scope, exact prior head, no unfinished plan, the current administrator, a verified operator target and its exact credential, the assertion, then the window; one guarded row', () => {
    const rows = read(ROWS);
    const verify = rows.slice(rows.indexOf('export async function verifyFvRevocationEvidence('), rows.indexOf('export async function appendFvRevocation('));
    const order = ["return no('SCOPE_MISMATCH')", "!== authorization.priorHead.chainDigest) return no('STALE_HEAD')", "if (fvOperatorPlanUnfinished(prior)) return no('PLAN_INCOMPLETE')", "fvRolesOf(prior).get(administrator.operatorId) !== 'fv-administrator'", "adminCredential.state !== 'active') return no('ADMINISTRATOR_CREDENTIAL_UNUSABLE')", '(await verifyFvOperatorRoles(prior, store.organizationId, context.relyingParty)).has(target.operatorId)', "return no('TARGET_MISMATCH')", 'await verifyAssertion(response, adminChallenge,', "return no('COUNTER_REGRESSION')", "return no('CHALLENGE_CONSUMED')", "return no('ALREADY_REVOKED')", "return no('WINDOW_CLOSED')"].map((marker) => verify.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const append = rows.slice(rows.indexOf('export async function appendFvRevocation('), rows.indexOf('export async function verifyFvRevocations('));
    assert.equal((append.match(/store\.append\(/g) ?? []).length, 1, 'one row');
    assert.match(append, /if \(history\.length !== sequence \|\| chainDigestAt\(history, store\.storeId, store\.organizationId, sequence\) !== chainDigest \|\| fvOperatorPlanUnfinished\(history\)\) throw new FvRevocationRefusedError\('CONFLICT'\);/);
    assert.match(rows, /export const FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS = 300;/);
    assert.match(rows, /if \(target\.operatorId === administrator\.operatorId \|\|/, 'the administrator is never a target');
    for (const file of [ROWS, CEREMONY]) assert.equal(/identityAdministratorFor|IdentityAdministrator\b|createHumanIdentityService|revokeCredential\(|finishOwnerRevocation|execution-capability|ledger\.claim/.test(read(file)), false, relative(ROOT, file));
  });

  it('current authority: a revoked credential never counts; a revocation only removes authority (verifiers re-check the assertion from the store)', () => {
    const rows = read(ROWS);
    const current = rows.slice(rows.indexOf('export async function verifyFvCurrentOperators('));
    assert.match(current, /credential\.operatorId === operatorId && credential\.state === 'active'/);
    assert.match(current, /const verified = await verifyFvOperatorRoles\(history, organizationId, relyingParty\);/);
    const revocations = rows.slice(rows.indexOf('export async function verifyFvRevocations('), rows.indexOf('export async function verifyFvCurrentOperators('));
    assert.match(revocations, /authorization\.priorHead\.sequence === index &&/);
    // Review L2/L3: every credential_revoked row is judged; authorized only as the FV ceremony's, re-checked like AUTH-03 at write time.
    assert.match(revocations, /if \(row\.kind !== 'credential_revoked' \|\| row\.objectId === null\) continue;/);
    assert.match(revocations, /row\.recordedBy === FV_REVOCATION_RECORDER &&/);
    assert.match(revocations, /\(await verifyFvOperatorRoles\(prefix, organizationId, relyingParty\)\)\.has\(authorization\.target\.operatorId\)/);
    assert.match(revocations, /const verified = await verifyAssertion\(response, challenge,/);
    // AUDIT-HF01: parity with AUTH-03's scope and lifetime checks, against the caller's authenticated expectation; fail closed without one.
    assert.match(revocations, /expected: FvRevocationExpectation & \{ readonly storeId: string \},\n\): Promise</);
    assert.match(revocations, /if \(\n\s+scoped &&\n/);
    for (const field of ['storeId', 'deploymentId', 'stateKind', 'witnessId', 'witnessKeyDigest']) assert.match(revocations, new RegExp(`authorization\\.${field} === expected\\.${field} &&`), field);
    assert.match(revocations, /Date\.parse\(authorization\.notAfter\) - Date\.parse\(authorization\.notBefore\) <= FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS \* 1000 &&/);
    assert.match(revocations, /ok = verified\.counter === counter && row\.payload === rebuilt;/);
  });

  it('the ceremony: early refusals, the administrator’s proof, AUTH-03’s verification, progress, then the row; revoked only with the witness confirming the head', () => {
    const ceremony = read(CEREMONY);
    const revoke = ceremony.slice(ceremony.indexOf('export async function revokeFvOperatorCredential('), ceremony.indexOf('export async function resumeFvOperatorRevocation('));
    const order = ["if (fvOperatorPlanUnfinished(history)) return refused('ENROLLMENT_PENDING')", 'await administrator(fvRevocationAdministratorOptions(', 'await verifyFvRevocationEvidence(', 'record.appendEvent(isoOf(config), INTENT_EVENT', 'return complete('].map((marker) => revoke.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const complete = ceremony.slice(ceremony.indexOf('async function complete('), ceremony.indexOf('async function withRegisteredStore('));
    assert.match(complete, /witnessed\.pending === undefined && witnessed\.committed\.sequence === head\.sequence && witnessed\.committed\.stateDigest === head\.chainDigest/);
    assert.equal(/openSqliteHumanIdentityStore|create: true/.test(ceremony), false);
    assert.equal((ceremony.match(/config\.observer\?\.\(step\)/g) ?? []).length, 1);
  });
});
