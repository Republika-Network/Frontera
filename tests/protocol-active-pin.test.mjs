import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS } from '../scripts/protocol/lib-protocol-artifact.mjs';

// The active @aoc/protocol pin is one identity recorded in five places: the
// compatibility lock, package.json, package-lock.json, the vendored tarball's
// bytes, and the installed package. Every assertion here is derived from the
// lock, so it keeps holding across a future repin; the exact current identity
// is asserted in tests/protocol-canonicalization-regression.test.mjs.
const root = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const lock = readJson('protocol-consumer.lock.json');
const installedDir = resolve(root, 'node_modules/@aoc/protocol');

// Errors (empty when none) for one tarball file against every identity field the lock pins. A missing
// file is an error, never a pass.
function tarballIdentityErrors(path, pinned) {
  if (!existsSync(path)) return [`${path} does not exist`];
  const errors = [];
  const bytes = readFileSync(path);
  const sha512 = createHash('sha512').update(bytes).digest();
  if (basename(path) !== pinned.filename) errors.push(`file name ${basename(path)} is not ${pinned.filename}`);
  if (bytes.length !== pinned.sizeBytes) errors.push(`size ${bytes.length} is not ${pinned.sizeBytes}`);
  if (createHash('sha256').update(bytes).digest('hex') !== pinned.sha256) errors.push('sha256 differs');
  if (sha512.toString('hex') !== pinned.sha512) errors.push('sha512 differs');
  if (`sha512-${sha512.toString('base64')}` !== pinned.integrity) errors.push('npm integrity differs');
  return errors;
}

// Errors for the @aoc/protocol devDependency spec. Two forms exist and both get the full identity check:
// - relative: the repository form, which must be exactly file:./<lock.tarball.vendoredAt>, so the
//   vendored tarball is mandatory wherever the repository installs it;
// - absolute: scripts/protocol/validate-enterprise-against-protocol-tarball.mjs installs from an
//   external tarball by absolute path in a copy that contains no *.tgz.
function devDependencySpecErrors(spec, pinned, base) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return [`"${spec}" is not a file: spec`];
  const target = spec.slice('file:'.length);
  if (!isAbsolute(target) && target !== `./${pinned.vendoredAt}`) {
    return [`relative spec "${spec}" must be exactly "file:./${pinned.vendoredAt}"`];
  }
  return tarballIdentityErrors(resolve(base, target), pinned);
}

test('the pinned vendored path is vendor/<pinned file name>', () => {
  assert.equal(lock.tarball.vendoredAt, `vendor/${lock.tarball.filename}`);
});

test('package.json installs a tarball matching every pinned identity field', () => {
  const spec = readJson('package.json').devDependencies['@aoc/protocol'];
  assert.deepEqual(devDependencySpecErrors(spec, lock.tarball, root), []);
});

test('a vendored tarball that is present matches every pinned identity field', () => {
  // Mandatory in the repository through the relative spec above; checked here as well whenever present.
  const vendored = resolve(root, lock.tarball.vendoredAt);
  if (existsSync(vendored)) assert.deepEqual(tarballIdentityErrors(vendored, lock.tarball), []);
});

test('package-lock.json resolves @aoc/protocol to the pinned version, integrity and tarball', () => {
  const spec = readJson('package.json').devDependencies['@aoc/protocol'];
  const entry = readJson('package-lock.json').packages['node_modules/@aoc/protocol'];
  assert.equal(entry.version, lock.expectedVersion);
  assert.equal(entry.integrity, lock.tarball.integrity);
  if (!isAbsolute(spec.slice('file:'.length))) {
    assert.equal(entry.resolved, `file:${lock.tarball.vendoredAt}`);
  } else {
    assert.ok(entry.resolved.startsWith('file:') && entry.resolved.endsWith(`/${lock.tarball.filename}`), entry.resolved);
  }
});

// --- The identity rules themselves, on fixtures --------------------------------

test('the identity rules reject a missing, corrupted, renamed or misplaced tarball in either spec form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-protocol-pin-'));
  try {
    // The installed tarball (verified above) is the source of known-good bytes in either environment.
    const good = readFileSync(resolve(root, readJson('package.json').devDependencies['@aoc/protocol'].slice('file:'.length)));
    mkdirSync(join(dir, 'vendor'));
    writeFileSync(join(dir, lock.tarball.vendoredAt), good);
    const external = join(dir, 'external', lock.tarball.filename);
    mkdirSync(join(dir, 'external'));
    writeFileSync(external, good);
    const relativeSpec = `file:./${lock.tarball.vendoredAt}`;

    // Accepted: both forms, when the bytes are the pinned artifact.
    assert.deepEqual(devDependencySpecErrors(relativeSpec, lock.tarball, dir), []);
    assert.deepEqual(devDependencySpecErrors(`file:${external}`, lock.tarball, dir), []);

    // Missing: the vendored tarball for the relative form, the external one for the absolute form.
    assert.notDeepEqual(devDependencySpecErrors(relativeSpec, lock.tarball, join(dir, 'external')), []);
    assert.notDeepEqual(devDependencySpecErrors(`file:${join(dir, 'nowhere', lock.tarball.filename)}`, lock.tarball, dir), []);

    // Corrupted: one flipped byte, and a truncated copy.
    const flipped = Buffer.from(good);
    flipped[flipped.length - 1] ^= 0xff;
    writeFileSync(external, flipped);
    assert.ok(devDependencySpecErrors(`file:${external}`, lock.tarball, dir).includes('sha256 differs'));
    writeFileSync(external, good.subarray(0, good.length - 1));
    assert.ok(devDependencySpecErrors(`file:${external}`, lock.tarball, dir).some((e) => e.startsWith('size')));

    // Renamed: the pinned bytes under another file name.
    const renamed = join(dir, 'external', 'aoc-protocol-other.tgz');
    writeFileSync(renamed, good);
    assert.ok(devDependencySpecErrors(`file:${renamed}`, lock.tarball, dir).some((e) => e.startsWith('file name')));

    // Misplaced relative spec, and specs that are not file: specs at all.
    assert.notDeepEqual(devDependencySpecErrors(`file:./external/${lock.tarball.filename}`, lock.tarball, dir), []);
    assert.notDeepEqual(devDependencySpecErrors(lock.expectedVersion, lock.tarball, dir), []);
    assert.notDeepEqual(devDependencySpecErrors(undefined, lock.tarball, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the installed package is the pinned version, export map and integration contract', () => {
  const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, lock.expectedVersion);

  const keys = Object.keys(installed.exports).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify(keys.map((key) => [key, installed.exports[key]]))).digest('hex');
  assert.equal(fingerprint, lock.exportsFingerprint);

  const contract = JSON.parse(readFileSync(join(installedDir, 'integration-contract.json'), 'utf8'));
  assert.equal(contract.contract, lock.integrationContract.contract);
  assert.equal(contract.contractVersion, lock.integrationContract.contractVersion);
  assert.equal(contract.status, lock.integrationContract.status);
});

test('the lock names exactly the approved internal-dependency subpaths, and the installed package declares them', () => {
  assert.deepEqual(lock.internalDependencySubpaths, [...INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS]);
  const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  for (const subpath of lock.internalDependencySubpaths) {
    assert.ok(!lock.verifiedPublicExports.includes(subpath), `${subpath} must not be a verified public export`);
    const key = `.${subpath.slice('@aoc/protocol'.length)}`;
    assert.ok(installed.exports[key], `installed @aoc/protocol must declare ${key}`);
  }
});

// --- The source boundary is unchanged: the gate itself, run on fixtures -------

function runConsumptionGate(files) {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-protocol-gate-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', peerDependencies: { '@aoc/protocol': '>=0.1.0 || >=0.2.0-rc.0' } }));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return spawnSync('node', [resolve(root, 'scripts/check-protocol-consumption.mjs')], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the consumption gate still rejects a Frontera source import of an internal-dependency subpath', () => {
  for (const subpath of INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS) {
    for (const where of ['src/enterprise/x.ts', 'src/integrations/soberania/x.ts', 'packages/p/src/x.ts']) {
      const result = runConsumptionGate({ [where]: `import { canonicalizeJSON } from '${subpath}';\n` });
      assert.equal(result.status, 1, `${where}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`imports forbidden/undeclared subpath '${subpath}'`));
    }
  }
});

// Undeclared subpaths are assembled rather than written as quoted literals, so this file does not
// itself trip the forbidden deep-import scans that cover tests/.
const PROTOCOL = '@aoc/protocol';

test('the consumption gate still accepts the public root import and rejects other undeclared subpaths', () => {
  assert.equal(runConsumptionGate({ 'src/x.ts': `import type { CanonicalId } from '${PROTOCOL}';\n` }).status, 0);
  for (const subpath of ['manifest', 'identity', 'dist/canonical/index'].map((rest) => `${PROTOCOL}/${rest}`)) {
    assert.equal(runConsumptionGate({ 'src/x.ts': `import { x } from '${subpath}';\n` }).status, 1, subpath);
  }
});
