// PROD-02 structural guards for the portability registry
// (scripts/portability/store-registry.mjs).
//
// These fail when the Host gains a durable store the backup does not know
// about, when a second store list appears beside the registry, when the
// freshness witness's state drifts into the backup definitions, when a live
// database is copied by anything but SQLite's Online Backup API, when a secret
// variable is left unclassified, or when restore could open (and so create) a
// store it did not just verify. Each detector is self-tested against a planted
// violation so a broken detector cannot pass silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  STORE_DEFINITIONS,
  STORE_CONDITIONS,
  EXCLUDED_DURABLE_STATE,
  STATIC_SECRET_ENV_VARS,
  DEPLOYMENT_FLAGS,
  COVERAGE_MODEL,
  assessBackupCoverage,
  conditionHolds,
  requiredStoreDefinitions,
  storeEnvironmentFor,
} from '../scripts/portability/store-registry.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const CONFIG_SOURCE = 'src/enterprise/configuration/enterprise-configuration.ts';

/** Every `AOC_ENTERPRISE_..._SQLITE_PATH` the Host's configuration loader reads. */
function sqlitePathVariablesIn(source) {
  return [...new Set([...source.matchAll(/env\.(AOC_ENTERPRISE_[A-Z0-9_]*SQLITE_PATH)\b/g)].map((match) => match[1]))].sort();
}

/** The variables a loader reads that the registry neither declares nor excludes. */
function unclassified(variables) {
  const known = new Set([...STORE_DEFINITIONS.map((storeDef) => storeDef.envVar), ...EXCLUDED_DURABLE_STATE.map((entry) => entry.envVar).filter(Boolean)]);
  return variables.filter((variable) => !known.has(variable));
}

test('every durable SQLite path the Host configuration reads is classified by the registry (backed up or excluded with a reason)', () => {
  const variables = sqlitePathVariablesIn(read(CONFIG_SOURCE));
  assert.ok(variables.length >= 13, `the detector found the Host's store variables (${variables.length})`);
  assert.deepEqual(unclassified(variables), [], 'a new store variable must be added to STORE_DEFINITIONS or EXCLUDED_DURABLE_STATE');
  // And the converse: the registry names no variable the Host does not read.
  for (const storeDef of STORE_DEFINITIONS) assert.ok(variables.includes(storeDef.envVar), `${storeDef.name}: ${storeDef.envVar} is a Host variable`);
});

test('detector self-test: a planted store variable is flagged as unclassified', () => {
  const planted = `${read(CONFIG_SOURCE)}\n      sqlitePath: env.AOC_ENTERPRISE_PAYMENTS_LEDGER_SQLITE_PATH ?? '.data/payments-ledger.sqlite',\n`;
  assert.deepEqual(unclassified(sqlitePathVariablesIn(planted)), ['AOC_ENTERPRISE_PAYMENTS_LEDGER_SQLITE_PATH']);
});

test('every registry entry maps its variable to the configuration field the Host reads, and restores under the Host\'s own default filename', async () => {
  const { loadEnterpriseConfiguration } = await import(join(ROOT, 'dist/src/enterprise/index.js'));
  const defaults = loadEnterpriseConfiguration({});
  // AUTH-04A: the human identity path is read only with its authority enabled (its variable is refused otherwise).
  const marked = loadEnterpriseConfiguration({ ...Object.fromEntries(STORE_DEFINITIONS.map((storeDef) => [storeDef.envVar, `/marked/${storeDef.name}.db`])), AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled' });
  for (const storeDef of STORE_DEFINITIONS) {
    assert.equal(storeDef.configPathOf(marked), `/marked/${storeDef.name}.db`, `${storeDef.name}: configPathOf reads ${storeDef.envVar}`);
    assert.equal(basename(storeDef.configPathOf(defaults)), storeDef.targetFilename, `${storeDef.name}: restore writes the file the Host opens by default`);
  }
});

test('registry entries are complete, unique and closed', () => {
  const fields = ['name', 'filename', 'envVar', 'configKey', 'configPathOf', 'targetFilename', 'condition', 'purpose', 'version', 'supportedSchemaVersionsOf', 'recordTable', 'integrity', 'open', 'lossEffect'];
  for (const storeDef of STORE_DEFINITIONS) {
    for (const field of fields) assert.ok(storeDef[field] !== undefined, `${storeDef.name}.${field}`);
    assert.ok(STORE_CONDITIONS.includes(storeDef.condition), `${storeDef.name}: condition '${storeDef.condition}' is a known condition`);
    assert.ok(['versions-table', 'meta-row'].includes(storeDef.version.kind));
  }
  for (const field of ['name', 'filename', 'envVar', 'targetFilename']) {
    assert.equal(new Set(STORE_DEFINITIONS.map((storeDef) => storeDef[field])).size, STORE_DEFINITIONS.length, `${field} is unique`);
  }
  // PROD-02: thirteen; ASSURE-01 added the durable Evidence Bundle Store; TRADE-04C the trade sequence interlock (conditional);
  // AUTH-04D1 the signed human identity store (conditional), previously excluded.
  assert.equal(STORE_DEFINITIONS.length, 17);
  assert.throws(() => conditionHolds('some-new-condition', {}), /Unknown store condition/);
  // The four signed stores carry their head and their witness slot; nothing else claims one.
  assert.deepEqual(
    STORE_DEFINITIONS.filter((storeDef) => storeDef.signedHead !== undefined).map((storeDef) => [storeDef.name, storeDef.freshnessStateKind]),
    [
      ['bounded-grants', 'bounded-grant-revocation-state'],
      ['obligation-discharges', 'obligation-discharge-state'],
      ['approvals', 'approval-state'],
      ['human-identity', 'human-identity-state'],
    ],
  );
});

test('the CORE-07 freshness witness is never part of the backup definitions', () => {
  for (const storeDef of STORE_DEFINITIONS) {
    for (const field of ['name', 'filename', 'envVar', 'targetFilename']) assert.equal(/witness/i.test(storeDef[field]), false, `${storeDef.name}.${field}`);
  }
  const witness = EXCLUDED_DURABLE_STATE.find((entry) => entry.envVar === 'FRONTERA_REFERENCE_WITNESS_DB');
  assert.ok(witness !== undefined && /restore domain/.test(witness.reason), 'the witness database is explicitly excluded, with the CORE-07 reason');
  // The reference witness reads its database from exactly that variable.
  assert.match(read('scripts/run-reference-authority-state-witness.mjs'), /required\('FRONTERA_REFERENCE_WITNESS_DB'\)/);
  // No portability script mentions witness state except to exclude it.
  for (const file of ['backup-enterprise-v1.mjs', 'restore-enterprise-v1.mjs', 'lib-portability.mjs']) {
    const source = read(join('scripts/portability', file));
    assert.equal(/FRONTERA_REFERENCE_WITNESS_DB|witness_bindings|enroll(Existing)?AuthorityStores|genesisStoreId/.test(source), false, `${file} never touches witness state or enrollment`);
  }
});

/** String literals naming a `.sqlite` file in `source`. */
function storeFileLiterals(source) {
  return [...source.matchAll(/['"`]([A-Za-z0-9._-]+\.sqlite)['"`]/g)].map((match) => match[1]);
}

test('no second store list: the portability tooling names store files only through the registry', () => {
  const dir = join(ROOT, 'scripts/portability');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'store-registry.mjs')) {
    assert.deepEqual(storeFileLiterals(readFileSync(join(dir, file), 'utf8')), [], `${file} hard-codes a store filename`);
  }
  // Self-test: the historical hand-maintained map is exactly what this would catch.
  assert.deepEqual(storeFileLiterals(`return { governance: join(targetDir, 'enterprise-host.sqlite') };`), ['enterprise-host.sqlite']);
});

test('a live database is only ever copied with the SQLite Online Backup API', () => {
  const lib = read('scripts/portability/lib-portability.mjs');
  const copy = lib.slice(lib.indexOf('export async function safeSqliteCopy'), lib.indexOf('export function gitInfo'));
  assert.match(copy, /await source\.backup\(destPath\)/);
  const backup = read('scripts/portability/backup-enterprise-v1.mjs');
  assert.match(backup, /await safeSqliteCopy\(entry\.sourcePath, destPath\)/);
  assert.equal(/copyFileSync|cpSync|createReadStream|execSync|execFileSync|spawn/.test(backup), false, 'backup never byte-copies or shells out');
});

test('every secret-bearing Host variable is classified, and the backup never reads a secret field', () => {
  const config = read(CONFIG_SOURCE);
  // The fields the loader fills with secret values, and the variables that feed them.
  const secretFeeds = [
    ...[...config.matchAll(/credential: env\.(AOC_ENTERPRISE_[A-Z_]+)/g)].map((match) => match[1]),
    ...[...config.matchAll(/signingKeyPem: env\.(AOC_ENTERPRISE_[A-Z_]+)/g)].map((match) => match[1]),
    ...[...config.matchAll(/apiKeys: parseApiKeys\(env\.(AOC_ENTERPRISE_[A-Z_]+)\)/g)].map((match) => match[1]),
  ];
  assert.deepEqual([...new Set(secretFeeds)].sort(), [...STATIC_SECRET_ENV_VARS].sort(), 'STATIC_SECRET_ENV_VARS is exactly the set of secret-bearing variables');
  const backup = read('scripts/portability/backup-enterprise-v1.mjs');
  for (const field of ['signingKeyPem', '.credential', 'apiKeys', 'process.env[', 'witness.credential']) {
    assert.equal(backup.includes(field), false, `backup-enterprise-v1.mjs must not read '${field}'`);
  }
});

test('restore never opens (and so never creates) a store it did not just copy and verify', () => {
  const restore = read('scripts/portability/restore-enterprise-v1.mjs');
  const opens = [...restore.matchAll(/storeDef\.open\(modules, ([A-Za-z]+),/g)].map((match) => match[1]);
  assert.deepEqual(opens, ['scratchFile'], 'the only store open is on the scratch copy');
  const deep = restore.slice(restore.indexOf('async function deepVerify'), restore.indexOf('// -- 6. promotion'));
  assert.ok(deep.indexOf('copyFileSync(join(stagingDir, storeDef.targetFilename), scratchFile)') < deep.indexOf('storeDef.open('), 'the scratch copy is made from the verified staged file before it is opened');
  assert.equal(/createSqlite[A-Za-z]*\(/.test(restore), false, 'restore reaches store factories only through the registry');
  // Target files are only ever produced by renaming a verified staged file into place.
  const promotion = restore.slice(restore.indexOf('// 6. promotion. From here on'), restore.indexOf('const rollbackProblems'));
  assert.ok(promotion.length > 200, 'the promotion section was found');
  assert.equal(/copyFileSync|cpSync/.test(promotion), false, 'promotion only renames verified staged files into place');
  const writes = [...promotion.matchAll(/writeFileSync\(([A-Za-z]+),[^;]*;/g)];
  assert.deepEqual(writes.map((match) => match[1]), ['markerPath', 'reportPath'], 'the only files written are the in-progress marker and the report');
  for (const match of writes) assert.match(match[0], /flag: 'wx'/, `${match[1]} is created exclusively, never written through an existing file or link`);
  assert.ok(promotion.indexOf('promoted.push(reportPath)') < promotion.indexOf('writeFileSync(reportPath'), 'the report is registered for rollback before it is written');
  assert.match(restore, /if \(markerCreated\) rmSync\(markerPath/, 'a rollback removes only the marker this run created');
});

// PROD-03 × PAY-03/TRADE-04C: every flag a store condition reads must be type-checked in a
// coverage record. Otherwise a manifest that omits it quietly un-requires that store
// (found when integrating PROD-03 with TRADE-04C: xrplPaymentRail and xrplTradeExecution).
function flagsConditionsRead() {
  const read = new Set();
  const spy = new Proxy({}, { get: (_target, key) => (typeof key === 'string' && read.add(key), true) });
  for (const condition of STORE_CONDITIONS) conditionHolds(condition, spy);
  return read;
}

const TRADE_DEPLOYMENT = Object.freeze({ organizationId: 'org-a', kernelAuthorityEnabled: true, governedActions: true, obligationsDeclared: false, approvalsDeclared: false, operatorsConfigured: false, executionReconciliation: true, xrplPaymentRail: true, xrplTradeExecution: true, humanAuthorityEnabled: false });

function coverageManifest(deployment, { omit = [] } = {}) {
  const required = requiredStoreDefinitions({ ...TRADE_DEPLOYMENT, ...deployment });
  const included = required.filter((storeDef) => !omit.includes(storeDef.name));
  return {
    stores: included.map((storeDef) => ({ name: storeDef.name, filename: storeDef.filename, checksum: 'sha256:0', schemaVersion: 1 })),
    coverage: {
      coverageModel: COVERAGE_MODEL,
      complete: true,
      deployment,
      stores: STORE_DEFINITIONS.map((storeDef) => ({ name: storeDef.name, required: included.some((entry) => entry.name === storeDef.name), included: included.some((entry) => entry.name === storeDef.name) })),
    },
  };
}

test('DEPLOYMENT_FLAGS is exactly the set of flags the store conditions read', () => {
  assert.deepEqual([...DEPLOYMENT_FLAGS].sort(), [...flagsConditionsRead()].sort());
  assert.ok(Object.isFrozen(DEPLOYMENT_FLAGS));
});

test('a coverage record with every flag recorded is judged on them: an omitted Payment or Trade interlock is incomplete', () => {
  assert.equal(assessBackupCoverage(coverageManifest(TRADE_DEPLOYMENT)).complete, true);
  for (const store of ['xrpl-submission-interlock', 'xrpl-trade-sequence-interlock']) {
    assert.ok(STORE_DEFINITIONS.some((storeDef) => storeDef.name === store), store);
    const verdict = assessBackupCoverage(coverageManifest(TRADE_DEPLOYMENT, { omit: [store] }));
    assert.equal(verdict.complete, false, store);
    assert.deepEqual(verdict.missingForSource, [store]);
  }
});

test('a coverage record that drops or mistypes any deployment flag is malformed, never quietly un-required', () => {
  for (const flag of DEPLOYMENT_FLAGS) {
    const { [flag]: _dropped, ...withoutFlag } = TRADE_DEPLOYMENT;
    assert.throws(() => assessBackupCoverage(coverageManifest(withoutFlag)), new RegExp(`coverage\\.deployment\\.${flag} must be a boolean`), `dropped ${flag}`);
    assert.throws(() => assessBackupCoverage(coverageManifest({ ...TRADE_DEPLOYMENT, [flag]: 'true' })), new RegExp(`coverage\\.deployment\\.${flag} must be a boolean`), `string ${flag}`);
  }
});

test('the backup writes every deployment flag into its coverage record', () => {
  const writer = read('scripts/portability/backup-enterprise-v1.mjs');
  const block = writer.slice(writer.indexOf('deployment: {'), writer.indexOf('stores: coverageStores'));
  for (const flag of DEPLOYMENT_FLAGS) assert.ok(block.includes(`${flag}: requirements.${flag},`), flag);
});

test('AUTH-04D1: the human identity store is backed up exactly when the human-decision authority is composed, and its variable is named only then', () => {
  const identity = STORE_DEFINITIONS.find((storeDef) => storeDef.name === 'human-identity');
  assert.ok(identity !== undefined);
  assert.equal(EXCLUDED_DURABLE_STATE.some((entry) => entry.name === 'human-identity' || entry.envVar === identity.envVar), false, 'no longer excluded');
  assert.equal(identity.condition, 'human-authority-enabled');
  assert.equal(conditionHolds(identity.condition, { humanAuthorityEnabled: true }), true);
  assert.equal(conditionHolds(identity.condition, { humanAuthorityEnabled: false }), false);
  assert.deepEqual(STORE_DEFINITIONS.filter((storeDef) => storeDef.envVarOnlyWhenComposed === true).map((storeDef) => storeDef.name), ['human-identity']);
  // The Host refuses AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH without the authority, so the environment helper never names it for a deployment that does not compose it.
  assert.equal(identity.envVar in storeEnvironmentFor('/data'), false);
  assert.equal(identity.envVar in storeEnvironmentFor('/data', { ...TRADE_DEPLOYMENT, humanAuthorityEnabled: false }), false);
  assert.equal(storeEnvironmentFor('/data', { ...TRADE_DEPLOYMENT, humanAuthorityEnabled: true })[identity.envVar], resolve('/data', 'human-identity.sqlite'));
  assert.match(read(CONFIG_SOURCE), /is set but AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE is not 'enabled'/, 'the strict reading this helper respects is still in force');
  // A backup of a deployment with the authority must include it; one without it never needs it.
  const verdict = assessBackupCoverage(coverageManifest({ ...TRADE_DEPLOYMENT, humanAuthorityEnabled: true }, { omit: ['human-identity'] }));
  assert.equal(verdict.complete, false);
  assert.deepEqual(verdict.missingForSource, ['human-identity']);
  assert.equal(assessBackupCoverage(coverageManifest({ ...TRADE_DEPLOYMENT, humanAuthorityEnabled: true })).complete, true);
});
