import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-2A2B — FV operator enrolment stays internal and non-operational, and Host administration never
// reaches an FV store: nothing in the Host, its scripts, its deployment, the dedicated executor or its supervisor
// invokes the ceremony; AUTH-03's FV operator rows are written by it alone and decide the authority themselves; AUTH-02's
// general administration refuses an FV store at every mutation; FV roles come from signed rows only.

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(ROOT, 'src');
const MODULE = join(SRC, 'enterprise', 'sovereign-status-history');
const IDENTITY = join(SRC, 'enterprise', 'human-identity');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const CEREMONY = join(MODULE, 'identity-registration-operator.ts');
const ROWS = join(IDENTITY, 'fv-operator.ts');
const DOMAIN = join(IDENTITY, 'fv-domain.ts');
const SERVICE = join(IDENTITY, 'service.ts');

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}
const productionSources = () => walk(SRC, (p) => p.endsWith('.ts') && !p.includes('__tests__'));

describe('FV-P4C-2B3C-2A2B structure — Host administration never reaches an FV store', () => {
  it('AUTH-02 refuses an FV store in its administrator check and again in the guard of every administrative append, token registration and owner revocation', () => {
    const service = read(SERVICE);
    assert.match(service, /function administrator\(value: IdentityAdministrator\): IdentityAdministrator \{\n\s+notFvOwned\(\);/);
    assert.match(service, /if \(store\.exclusiveOwner \|\| fvOwnedHistory\(history\)\) throw new HumanIdentityError\('HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED'/);
    for (const kind of ['principal_created', 'principal_revoked', 'enrolment_authorized', 'enrolment_revoked', 'credential_revoked']) {
      assert.match(service, new RegExp(`await guardedAppend\\(row\\('${kind}'[^\\n]*\\(history\\) => \\{\\n\\s+notFvOwned\\(history\\);`), kind);
    }
    const registration = service.slice(service.indexOf('    async finishRegistration('), service.indexOf('    beginAuthentication() {'));
    assert.match(registration, /^    async finishRegistration\(enrolmentToken, raw\) \{\n\s+notFvOwned\(\);/);
    assert.match(registration, /\(history\) => \{\n\s+notFvOwned\(history\);/);
    assert.match(service.slice(service.indexOf('    beginRegistration(enrolmentToken) {')), /^    beginRegistration\(enrolmentToken\) \{\n\s+const current = state\(\);\n\s+notFvOwned\(store\.history\(\)\);/);
    const owner = service.slice(service.indexOf('    beginOwnerRevocation(credentialId) {'), service.indexOf('    beginDecision(input) {'));
    assert.equal((owner.match(/notFvOwned\(/g) ?? []).length, 3, 'begin, finish and its guard');
    assert.match(read(join(IDENTITY, 'sqlite-human-identity-store.ts')), /\n\s+exclusiveOwner: exclusive !== undefined,\n/);
    // Fix-commit review F1: every write of the service goes through the guard that refuses while an FV plan is unfinished.
    assert.equal((service.match(/await store\.append\(/g) ?? []).length, 0, 'no unguarded service write');
    assert.match(service, /if \(\(store\.exclusiveOwner \|\| fvOwnedHistory\(history\)\) && fvOperatorPlanUnfinished\(history\)\) \{\n\s+throw new HumanIdentityError\('HUMAN_IDENTITY_FV_ENROLLMENT_PENDING'/);
  });

  it('FV roles come from signed rows only: the administrator is the first row, recorded by its ceremony; an operator, recorded by its own, right after the administrator’s authorizing row', () => {
    const domain = read(DOMAIN);
    assert.match(domain, /if \(role === FV_ADMINISTRATOR_ROLE && row\.recordedBy === FV_FIRST_ADMINISTRATOR_RECORDER && row\.sequence === 1\) return FV_ADMINISTRATOR_ROLE;/);
    // Review M1: an operator only directly after the administrator's authorizing row, whose stored contract names it.
    assert.match(domain, /if \(role === FV_OPERATOR_ROLE && row\.recordedBy === FV_OPERATOR_RECORDER && authorizedBy\(row, history\[index - 1\], roles\)\) return FV_OPERATOR_ROLE;/);
    assert.match(domain, /roles\.get\(previous\.operatorId\) === FV_ADMINISTRATOR_ROLE &&/);
    assert.equal(/import [^;]*from '\.\/service\.js'/.test(domain), false, 'a leaf');
    // The consumer rule: no production source decides on the structural operator role; only verifyFvOperatorRoles reads it.
    const consumers = productionSources().filter((p) => p !== DOMAIN && /fvRolesOf\(/.test(read(p)));
    assert.deepEqual(consumers.map((f) => relative(ROOT, f)).sort(), [CEREMONY, ROWS].map((f) => relative(ROOT, f)).sort());
    for (const file of consumers) {
      const uses = [...read(file).matchAll(/[^\n]*fvRolesOf\([^\n]*/g)].map((m) => m[0]).filter((line) => !/^\s*(\*|\/\/|import )/.test(line));
      for (const use of uses) assert.ok(/'fv-administrator'/.test(use) || /for \(const \[operatorId, role\] of fvRolesOf\(history\)\)/.test(use), `${relative(ROOT, file)}: ${use}`);
    }
    assert.match(read(ROWS), /for \(const \[operatorId, role\] of fvRolesOf\(history\)\) \{\n\s+if \(role !== FV_OPERATOR_ROLE\) continue;/, 'the one operator-role reader is the cryptographic verifier');
  });
});

describe('FV-P4C-2B3C-2A2B structure — the operator enrolment is internal, unique and decided by AUTH-03', () => {
  it('nothing outside the ceremony family reaches it or AUTH-03’s FV operator rows; neither is exported from an index', () => {
    const NAMES = /enrollFvOperator|resumeFvOperatorEnrollment|identity-registration-operator/;
    const outside = [...productionSources().filter((p) => !p.startsWith(join(MODULE, 'identity-registration'))), ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts|sh)$/.test(p)), ...walk(join(ROOT, 'deploy'), () => true), join(ROOT, 'Dockerfile'), join(ROOT, 'package.json')].filter((file) => existsSync(file) && NAMES.test(read(file)));
    assert.deepEqual(outside.map((f) => relative(ROOT, f)), []);
    const rowUsers = productionSources().filter((p) => p !== ROWS && /fv-operator\.js'/.test(read(p)));
    assert.deepEqual(rowUsers.map((f) => relative(ROOT, f)), [relative(ROOT, CEREMONY)], 'only the ceremony imports AUTH-03’s FV operator rows');
    assert.equal(/fv-operator|fv-domain/.test(read(join(IDENTITY, 'index.ts'))), false, 'not exported from the AUTH-03 index');
    assert.equal(/FvOperator|identity-registration-operator/.test(read(join(MODULE, 'index.ts'))), false, 'not exported from the module index');
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-main.ts', 'dedicated-executor-supervisor.ts', 'dedicated-executor-protocol.ts', 'protected-host-composition.ts']) {
      assert.equal(/FvOperator|fv-operator|identity-registration-operator/.test(read(join(MODULE, name))), false, name);
    }
    assert.match(read(join(MODULE, 'dedicated-executor-main.ts')), /compose: undefined,/, 'the production entry still composes nothing');
    const registeredAccess = productionSources().filter((p) => /fvRegisteredStoreAccess/.test(read(p)));
    assert.deepEqual(registeredAccess.map((f) => relative(MODULE, f)).sort(), ['identity-registration-first-administrator.ts', 'identity-registration-operator.ts']);
  });

  it('AUTH-03 decides: the administrator’s role from signed rows, its assertion over the commitment, the candidate’s proof, the prior head; each append guarded onto that exact head', () => {
    const rows = read(ROWS);
    const verify = rows.slice(rows.indexOf('export async function verifyFvOperatorEvidence('), rows.indexOf('const sameRow = '));
    const order = ["return no('SCOPE_MISMATCH')", "!== authorization.priorHead.chainDigest) return no('STALE_HEAD')", "fvRolesOf(prior).get(administrator.operatorId) !== 'fv-administrator'", 'await verifyAssertion(response, adminChallenge,', "return no('COUNTER_REGRESSION')", 'await verifyFvOperatorCandidate(', "return no('CANDIDATE_MISMATCH')", "return no('WINDOW_CLOSED')"].map((marker) => verify.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(rows, /if \(history\.length !== sequence \+ index \|\| chainDigestAt\(history, store\.storeId, store\.organizationId, sequence\) !== chainDigest \|\| progressOf\(history, sequence, rows\) !== index\) throw new FvOperatorRefusedError\('CONFLICT'\);/);
    assert.match(rows, /export const FV_OPERATOR_AUTHORIZATION_MAX_LIFETIME_SECONDS = 300;/);
    assert.match(rows, /role: FV_OPERATOR_ROLE, authorizationCommitment: commitment, authorizedBy: administrator\.operatorId/);
    assert.match(rows, /expiresAt: FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT/);
    for (const file of [ROWS, CEREMONY]) assert.equal(/identityAdministratorFor|IdentityAdministrator\b|createHumanIdentityService|authorizeEnrolment|finishRegistration|saveChallenge/.test(read(file)), false, relative(ROOT, file));
  });

  it('the ceremony: candidate proof, then the administrator’s, then AUTH-03’s verification, then progress, then the rows; enrolled only with the witness confirming the head; no G-02A capability', () => {
    const ceremony = read(CEREMONY);
    const enroll = ceremony.slice(ceremony.indexOf('export async function enrollFvOperator('), ceremony.indexOf('export async function resumeFvOperatorEnrollment('));
    const order = ['await candidate(issued.options)', 'await verifyFvOperatorCandidate(', 'await administrator(fvOperatorAdministratorOptions(', 'await verifyFvOperatorEvidence(', 'record.appendEvent(isoOf(config), INTENT_EVENT', 'return complete('].map((marker) => enroll.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const complete = ceremony.slice(ceremony.indexOf('async function complete('), ceremony.indexOf('async function withRegisteredStore('));
    assert.match(complete, /witnessed\.pending === undefined && witnessed\.committed\.sequence === head\.sequence && witnessed\.committed\.stateDigest === head\.chainDigest/);
    assert.equal(/createExecutionCapabilityVerifier|ledger\.claim|openLedger|settleOrphans|execution-capability/.test(ceremony), false, 'no G-02A capability or ledger claim');
    assert.equal(/openSqliteHumanIdentityStore|create: true/.test(ceremony), false, 'opens the store only through the registered-store access');
    assert.equal((ceremony.match(/config\.observer\?\.\(step\)/g) ?? []).length, 1);
  });
});
