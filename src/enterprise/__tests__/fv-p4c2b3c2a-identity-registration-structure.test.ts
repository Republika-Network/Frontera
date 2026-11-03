import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-2A1 — the registration ceremony stays internal and non-operational: nothing in the Host, its
// scripts, its deployment, the dedicated executor or its supervisor invokes it; it is the only production
// source that creates an FV identity store; no production source issues a registration capability; its
// diagnostics observer cannot change its course; the executor only verifies, before it opens anything.

const ROOT = join(__dirname, '..', '..', '..', '..');
const MODULE = join(ROOT, 'src', 'enterprise', 'sovereign-status-history');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const source = (name: string) => read(join(MODULE, name));

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}

const productionSources = () => walk(join(ROOT, 'src'), (p) => p.endsWith('.ts') && !p.includes('__tests__'));

describe('FV-P4C-2B3C-2A1 structure — the registration ceremony is internal, unique and inert', () => {
  it('nothing outside the module names the ceremony: no Host source, script, deployment file, Dockerfile or package script; not exported', () => {
    const NAMES = /registerFvIdentity|resumeFvIdentityRegistration|identity-registration/;
    const outside = [
      ...productionSources().filter((p) => !p.startsWith(MODULE)),
      ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts|sh)$/.test(p)),
      ...walk(join(ROOT, 'deploy'), () => true),
      ...walk(join(ROOT, 'infrastructure'), () => true),
      join(ROOT, 'Dockerfile'),
      join(ROOT, 'package.json'),
    ].filter((file) => existsSync(file) && NAMES.test(read(file)));
    assert.deepEqual(outside.map((f) => relative(ROOT, f)), []);
    assert.equal(/identity-registration/.test(source('index.ts')), false, 'not exported from the module index');
  });

  it('inside the module, only the composition reaches it, and only to verify; the executor, its entry, supervisor and protocol never do', () => {
    const users = readdirSync(MODULE).filter((name) => name.endsWith('.ts') && !name.startsWith('identity-registration') && /identity-registration/.test(source(name)));
    assert.deepEqual(users, ['protected-host-composition.ts']);
    const composition = source('protected-host-composition.ts');
    assert.equal(/registerFvIdentity|resumeFvIdentityRegistration|openFvRegistrationRecord\b/.test(composition), false, 'the composition never registers, resumes or writes a record');
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-main.ts', 'dedicated-executor-supervisor.ts', 'dedicated-executor-protocol.ts']) {
      assert.equal(/identity-registration|registration/i.test(source(name)), false, name);
    }
    assert.match(source('dedicated-executor-main.ts'), /compose: undefined,/, 'the production entry still composes nothing');
  });

  it('the composition verifies the registration before it opens the protected store or the identity store, and never creates the identity store', () => {
    const composition = source('protected-host-composition.ts');
    const verified = composition.indexOf('await verifyFvIdentityRegistration(');
    assert.ok(verified > 0);
    assert.ok(verified < composition.indexOf('await openProtectedContinuityStore('), 'before the protected store');
    assert.ok(verified < composition.indexOf('await openSqliteHumanIdentityStore('), 'before the identity store');
    assert.match(composition, /fileIdentityOf\(identityPath\) !== registeredFile/, 'the held file is the one the registration reserved');
  });

  it('the ceremony is the only production source that creates an FV identity store; it opens the store only as its exclusive, pinned, FV-domain owner', () => {
    const creators = productionSources().filter((p) => {
      const text = read(p);
      return /openSqliteHumanIdentityStore\(/.test(text) && /FV_BOOTSTRAP_IDENTITY_STATE_KIND/.test(text) && /create: true/.test(text);
    });
    assert.deepEqual(creators.map((f) => relative(MODULE, f)), ['identity-registration.ts']);
    const ceremony = source('identity-registration.ts');
    const open = ceremony.slice(ceremony.indexOf('openSqliteHumanIdentityStore(storePath'), ceremony.indexOf('} catch (error) {', ceremony.indexOf('openSqliteHumanIdentityStore(storePath')));
    assert.match(open, /freshness: Object\.freeze\(\{ boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND \}\)/);
    assert.match(open, /exclusive: \{ beforeWrite: fence, closer: exclusiveCloser, storeId \}/);
    assert.equal(/enrollment/.test(open), false, 'never a baseline enrollment of an existing store');
  });

  it('no production source issues a registration capability: the action is named only by the ceremony, and the issuer fixture only by tests', () => {
    const naming = productionSources().filter((p) => /frontera\.fv-bootstrap-identity\.(register|resume-registration)/.test(read(p)));
    assert.deepEqual(naming.map((f) => relative(MODULE, f)), ['identity-registration.ts']);
    const fixtureUsers = [...productionSources(), ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts)$/.test(p))].filter((p) => /fv-identity-registration-issuer-fixture/.test(read(p)));
    assert.deepEqual(fixtureUsers, []);
    const ceremony = source('identity-registration.ts');
    assert.equal(/\bsign\(|signExecutionCapability|createPrivateKey|privateKeyPem/.test(ceremony), false, 'the ceremony verifies; it never signs a capability');
  });

  it('the authorization is verified by G-02A’s verifier and consumed in G-02A’s ledger before the intent; the observer is diagnostics only', () => {
    const ceremony = source('identity-registration.ts');
    assert.match(ceremony, /createExecutionCapabilityVerifier\(/);
    const register = ceremony.slice(ceremony.indexOf('export async function registerFvIdentity('), ceremony.indexOf('export async function resumeFvIdentityRegistration('));
    const order = ['verifier.verify(', 'openRecord(config, true)', 'WITNESS_ALREADY_BOUND', 'ledger.claim(verification)', 'record.recordIntent(', 'await advance('].map((marker) => register.indexOf(marker));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'verify, lock the record, refuse a bound slot, consume, record the intent, then proceed');
    const resume = ceremony.slice(ceremony.indexOf('export async function resumeFvIdentityRegistration('), ceremony.indexOf('export async function readFvIdentityRegistration('));
    assert.ok(resume.indexOf('verifier.verify(') < resume.indexOf('ledger.claim(verification)') && resume.indexOf('ledger.claim(verification)') < resume.indexOf('await advance('), 'a resume is authorized and consumed before it proceeds');
    assert.equal((ceremony.match(/config\.observer\?\.\(step\)/g) ?? []).length, 1);
    assert.match(ceremony, /try \{\n\s+config\.observer\?\.\(step\);\n\s+\} catch \{\n\s+\/\/ Diagnostics never change the ceremony\.\n\s+\}/);
  });

  it('the record is written only through fenced transactions of its exclusive owner, and its rules live in the database too', () => {
    const record = source('identity-registration-record.ts');
    assert.match(record, /db\.pragma\('locking_mode = EXCLUSIVE'\);\n\s+db\.pragma\('busy_timeout = 0'\);\n\s+db\.exec\('BEGIN EXCLUSIVE'\);/);
    assert.match(record, /const close = exclusiveCloser\(file, db\);/);
    assert.equal((record.match(/\.transaction\(\(\) => \{\n\s+fence\(\);/g) ?? []).length, 3, 'initialization, every state write and every event: fenced first');
    for (const trigger of ['fv_registration_never_deleted', 'fv_registration_forward_only', 'fv_registration_events_append_only_update', 'fv_registration_events_append_only_delete']) assert.match(record, new RegExp(`CREATE TRIGGER ${trigger}`));
    assert.match(record, /readonly: true, fileMustExist: true/, 'the executor reads it read-only');
  });
});
