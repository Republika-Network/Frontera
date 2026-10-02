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
  conditionHolds,
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
  const marked = loadEnterpriseConfiguration(Object.fromEntries(STORE_DEFINITIONS.map((storeDef) => [storeDef.envVar, `/marked/${storeDef.name}.db`])));
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
  assert.equal(STORE_DEFINITIONS.length, 13);
  assert.throws(() => conditionHolds('some-new-condition', {}), /Unknown store condition/);
  // The three signed stores carry their head and their witness slot; nothing else claims one.
  assert.deepEqual(
    STORE_DEFINITIONS.filter((storeDef) => storeDef.signedHead !== undefined).map((storeDef) => [storeDef.name, storeDef.freshnessStateKind]),
    [
      ['bounded-grants', 'bounded-grant-revocation-state'],
      ['obligation-discharges', 'obligation-discharge-state'],
      ['approvals', 'approval-state'],
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
});
