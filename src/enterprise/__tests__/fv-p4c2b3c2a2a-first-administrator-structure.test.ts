import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-2A2A — the first FV administrator's enrolment stays internal and non-operational: nothing in the
// Host, its scripts, its deployment, the dedicated executor or its supervisor invokes it; AUTH-03's
// first-administrator rows are written by that ceremony alone; no production source issues its capability; the
// capability is verified and the passkey's attestation checked before anything is consumed; no Host
// administrator, identity service or enrolment token is involved.

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(ROOT, 'src');
const MODULE = join(SRC, 'enterprise', 'sovereign-status-history');
const IDENTITY = join(SRC, 'enterprise', 'human-identity');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const CEREMONY = join(MODULE, 'identity-registration-first-administrator.ts');
const ROWS = join(IDENTITY, 'first-administrator.ts');

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}
const productionSources = () => walk(SRC, (p) => p.endsWith('.ts') && !p.includes('__tests__'));

describe('FV-P4C-2B3C-2A2A structure — the first-administrator enrolment is internal, unique and inert', () => {
  it('nothing outside the ceremony reaches it or AUTH-03’s first-administrator rows; neither is exported from an index', () => {
    const NAMES = /enrollFvFirstAdministrator|resumeFvFirstAdministratorEnrollment|readFvFirstAdministratorEnrollment|identity-registration-first-administrator/;
    // The ceremony family (the registrar, its record, this ceremony) may name it; nothing else may.
    const outside = [...productionSources().filter((p) => !p.startsWith(join(MODULE, 'identity-registration'))), ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts|sh)$/.test(p)), ...walk(join(ROOT, 'deploy'), () => true), join(ROOT, 'Dockerfile'), join(ROOT, 'package.json')].filter((file) => existsSync(file) && NAMES.test(read(file)));
    assert.deepEqual(outside.map((f) => relative(ROOT, f)), []);
    const rowUsers = productionSources().filter((p) => p !== ROWS && /first-administrator\.js'/.test(read(p)));
    assert.deepEqual(rowUsers.map((f) => relative(ROOT, f)), [relative(ROOT, CEREMONY)], 'only the ceremony imports AUTH-03’s first-administrator module');
    assert.equal(/first-administrator/.test(read(join(IDENTITY, 'index.ts'))), false, 'not exported from the AUTH-03 index');
    assert.equal(/first-administrator|FirstAdministrator/.test(read(join(MODULE, 'index.ts'))), false, 'not exported from the module index');
    const internals = productionSources().filter((p) => /fvRegistrarInternals/.test(read(p)));
    assert.deepEqual(internals.map((f) => relative(MODULE, f)).sort(), ['identity-registration-first-administrator.ts', 'identity-registration.ts'], 'the registrar’s helpers reach only the first-administrator ceremony');
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-main.ts', 'dedicated-executor-supervisor.ts', 'dedicated-executor-protocol.ts', 'protected-host-composition.ts']) {
      assert.equal(/FirstAdministrator|first-administrator/.test(read(join(MODULE, name))), false, name);
    }
    assert.match(read(join(MODULE, 'dedicated-executor-main.ts')), /compose: undefined,/, 'the production entry still composes nothing');
  });

  it('no production source issues the capability: its actions are named only by the ceremony; it verifies and never signs', () => {
    const naming = productionSources().filter((p) => /frontera\.fv-bootstrap-identity\.(enroll|resume)-first-administrator/.test(read(p)));
    assert.deepEqual(naming.map((f) => relative(ROOT, f)), [relative(ROOT, CEREMONY)]);
    const ceremony = read(CEREMONY);
    assert.equal(/\bsign\(|signExecutionCapability|createPrivateKey|privateKeyPem/.test(ceremony), false);
    assert.match(ceremony, /createExecutionCapabilityVerifier\(/);
  });

  it('no Host administrator, identity service, enrolment token or challenge row reaches the first administrator', () => {
    for (const file of [CEREMONY, ROWS]) {
      const text = read(file);
      assert.equal(/identityAdministratorFor|createHumanIdentityService|IdentityAdministrator|authorizeEnrolment|finishRegistration|saveChallenge|EnterpriseOperatorPrincipal/.test(text), false, relative(ROOT, file));
    }
    const rows = read(ROWS);
    // Born expired at the epoch (never a plan-chosen time), its verifier the digest of a discarded secret.
    assert.match(rows, /payload: canonicalJson\(\{ expiresAt: FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT, tokenVerifier: plan\.tokenVerifier \}\)/);
    assert.match(rows, /export const FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT = '1970-01-01T00:00:00\.000Z';/);
    // Review F1/F2: the first, signed and witnessed row commits the whole plan, so the record cannot change the rest.
    assert.match(rows, /authorizationIssuer: plan\.authorization\.issuer, planDigest \}\)/);
    assert.match(rows, /tokenVerifier: createHash\('sha256'\)\.update\(randomBytes\(32\)\)\.digest\('hex'\)/);
    assert.match(rows, /role: FV_ADMINISTRATOR_ROLE/);
  });

  it('AUTH-03’s rule: every row is appended only onto exactly this plan’s earlier rows, decided in the append’s guard', () => {
    const rows = read(ROWS);
    const append = rows.slice(rows.indexOf('export async function appendFirstAdministrator('));
    assert.match(append, /await store\.append\(rows\[index\]!, \(history\) => \{\n\s+if \(history\.length !== index \|\| firstAdministratorProgress\(history, checked\) !== index\) conflict\(\);\n\s+\}\);/);
    assert.equal((append.match(/store\.append\(/g) ?? []).length, 1, 'one append site');
    assert.match(rows, /requireUserVerification|verifyRegistration\(response, expected, input\.relyingParty\)/);
  });

  it('enrol: lock the registration, verify, refuse an earlier enrolment and a non-empty store, prove possession, re-verify, consume, record the plan, then write', () => {
    const ceremony = read(CEREMONY);
    const enroll = ceremony.slice(ceremony.indexOf('export async function enrollFvFirstAdministrator('), ceremony.indexOf('export async function resumeFvFirstAdministratorEnrollment('));
    const order = ['await registeredRecord(config)', 'const verification = verify()', "if (events.enrolled) return refused('ALREADY_ENROLLED')", "'STORE_NOT_EMPTY'", 'await authenticator(issued.options)', 'await verifyFirstAdministratorAttestation(', 'plan = newFirstAdministratorPlan(', 'const fresh = verify()', "claim(config, record, ledger, 'enroll-first-administrator', fresh)", 'record.appendEvent(iso(config), INTENT_EVENT', 'await complete('].map((marker) => enroll.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const resume = ceremony.slice(ceremony.indexOf('export async function resumeFvFirstAdministratorEnrollment('), ceremony.indexOf('export async function readFvFirstAdministratorEnrollment('));
    const resumeOrder = ['await registeredRecord(config)', 'matching = intentsInStore(history, events.intents)', "if (empty) return refused('NO_ENROLLMENT', 'STORE_EMPTY')", 'await intentAuthorized(config, current, candidate.intent)', 'verifierOf(config).verify(', "claim(config, record, ledger, 'resume-first-administrator', verification)", 'record.appendEvent(iso(config), RESUME_EVENT'].map((marker) => resume.indexOf(marker));
    assert.ok(resume.lastIndexOf('await complete(') > resumeOrder.at(-1)!, 'the rows are written only after the resume is consumed and recorded');
    assert.ok(resumeOrder.every((index) => index > 0), JSON.stringify(resumeOrder));
    assert.deepEqual([...resumeOrder].sort((a, b) => a - b), resumeOrder, 'a resume re-verifies the recorded intent and its own capability before it consumes or writes');
    // Enrolled only after the verified store holds the plan and the witness, read again, committed that head.
    const complete = ceremony.slice(ceremony.indexOf('async function complete('), ceremony.indexOf('export async function enrollFvFirstAdministrator('));
    assert.match(complete, /witnessed\.pending === undefined && witnessed\.committed\.sequence === head\.sequence && witnessed\.committed\.stateDigest === head\.chainDigest/);
    assert.equal((ceremony.match(/config\.observer\?\.\(step\)/g) ?? []).length, 1);
    // Re-review 2: the ceremony settles only claims it made in this call (HF01's rule covers the rest); never one an intent merely names.
    assert.equal(/for \(const superseded of/.test(ceremony), false);
  });

  it('the store is opened only as its exclusive, pinned, FV-domain owner under freshness: never created, never a baseline enrollment', () => {
    const ceremony = read(CEREMONY);
    assert.equal((ceremony.match(/openSqliteHumanIdentityStore\(/g) ?? []).length, 1);
    const open = ceremony.slice(ceremony.indexOf('openSqliteHumanIdentityStore(storePath'), ceremony.indexOf('} catch (error) {', ceremony.indexOf('openSqliteHumanIdentityStore(storePath')));
    assert.match(open, /freshness: Object\.freeze\(\{ boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND \}\)/);
    assert.match(open, /exclusive: \{ beforeWrite: fence, closer: exclusiveCloser, storeId \}/);
    assert.equal(/create|enrollment/.test(open), false);
  });
});
