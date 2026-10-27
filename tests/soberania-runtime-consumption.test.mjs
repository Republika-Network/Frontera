import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { ALLOWED_PROTOCOL_SUBPATHS } from '../scripts/protocol/lib-protocol-artifact.mjs';
import {
  APPROVED_RUNTIME_PACKAGES,
  EXCLUDED_RUNTIME_PACKAGES,
  RUNTIME_VENDOR_DIR,
  extractTarballAsModule,
  findRuntimeImports,
  tarballIdentityErrors,
  validateRuntimeLock,
} from '../scripts/soberania-runtime/lib-runtime-artifacts.mjs';

// FRONTERA-SOBE-PILOT-01A: the vendored Soberanía runtime artifacts, qualified as packages.
// Nothing here wires the runtime into Frontera; no Frontera source consumes it yet.
const root = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const lock = readJson('soberania-runtime-consumer.lock.json');
const protocolLock = readJson('protocol-consumer.lock.json');
const RUNTIME = Object.keys(APPROVED_RUNTIME_PACKAGES).filter((name) => APPROVED_RUNTIME_PACKAGES[name] === 'runtime');
const DECLARATIONS = Object.keys(APPROVED_RUNTIME_PACKAGES).filter((name) => APPROVED_RUNTIME_PACKAGES[name] === 'declarations');

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Lock and artifacts --------------------------------------------------------

test('the runtime lock is valid and lists exactly the approved packages', () => {
  assert.deepEqual(validateRuntimeLock(lock), []);
  assert.deepEqual(lock.packages.map((entry) => entry.name).sort(), Object.keys(APPROVED_RUNTIME_PACKAGES).sort());
  assert.equal(lock.sourceCommit, '1112c63d93875400aeae8e01d85f3c8543be51d4');
  assert.equal(lock.protocolDependency.expectedVersion, protocolLock.expectedVersion);
});

test('every vendored artifact matches its lock entry: bytes, checksums, size and file inventory', () => {
  for (const entry of lock.packages) {
    assert.deepEqual(tarballIdentityErrors(resolve(root, entry.tarball.vendoredAt), entry), [], entry.name);
  }
});

test('the vendor directory holds only pinned artifacts and nothing excluded', () => {
  const pinned = new Set(lock.packages.map((entry) => entry.tarball.filename));
  for (const file of readdirSync(resolve(root, RUNTIME_VENDOR_DIR))) {
    if (file.endsWith('.tgz')) assert.ok(pinned.has(file), `${file} is not pinned`);
  }
  // npm pack names a tarball <scope>-<name>-<version>.tgz; the version must follow the stem directly,
  // or the root package `aoc-runtime` would match every @aoc-runtime/* artifact.
  for (const excluded of EXCLUDED_RUNTIME_PACKAGES) {
    const pattern = new RegExp(`^${excluded.replace(/^@/, '').replace('/', '-')}-\\d+\\.\\d+\\.\\d+.*\\.tgz$`);
    assert.ok(!readdirSync(resolve(root, RUNTIME_VENDOR_DIR)).some((file) => pattern.test(file)), `${excluded} vendored`);
  }
});

test('each artifact declares the pinned name and version, exports only its root, and requires only what the lock records', () => {
  withTempDir('frontera-runtime-manifest-', (dir) => {
    for (const entry of lock.packages) {
      const pkgDir = extractTarballAsModule(resolve(root, entry.tarball.vendoredAt), join(dir, 'node_modules'), entry.name);
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      assert.equal(pkg.name, entry.name);
      assert.equal(pkg.version, entry.version);
      assert.deepEqual(Object.keys(pkg.exports), ['.'], entry.name);
      assert.ok(entry.files.includes(pkg.main.replace(/^\.\//, '')), `${entry.name} main is packed`);
      assert.ok(entry.files.includes(pkg.types.replace(/^\.\//, '')), `${entry.name} types are packed`);
      const required = new Set();
      for (const file of entry.files.filter((path) => path.startsWith('dist/') && path.endsWith('.js'))) {
        for (const match of readFileSync(join(pkgDir, file), 'utf8').matchAll(/require\("([^"]+)"\)/g)) {
          if (!match[1].startsWith('.')) required.add(match[1]);
        }
      }
      assert.deepEqual([...required].sort(), entry.runtimeRequires, entry.name);
    }
  });
});

// --- Plain-Node consumption ----------------------------------------------------

function runConsumptionScenario() {
  return withTempDir('frontera-runtime-consume-', (dir) => {
    const nodeModules = join(dir, 'node_modules');
    for (const entry of lock.packages) extractTarballAsModule(resolve(root, entry.tarball.vendoredAt), nodeModules, entry.name);
    // @aoc/protocol is the installed package: the vendored rc.3 here (its bytes are verified by
    // tests/protocol-active-pin.test.mjs), the tarball under validation in the isolated validator.
    const installedProtocol = resolve(root, 'node_modules/@aoc/protocol');
    assert.equal(JSON.parse(readFileSync(join(installedProtocol, 'package.json'), 'utf8')).version, lock.protocolDependency.expectedVersion);
    mkdirSync(join(nodeModules, '@aoc'), { recursive: true });
    cpSync(installedProtocol, join(nodeModules, '@aoc', 'protocol'), { recursive: true, dereference: true });
    copyFileSync(resolve(root, 'tests/fixtures/soberania-runtime/consume-runtime.cjs'), join(dir, 'consume-runtime.cjs'));

    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['consume-runtime.cjs'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    return { ...report, loaded: report.loaded.map((file) => relative(dir, file).split(sep).join('/')) };
  });
}

const scenario = runConsumptionScenario();
const decided = (name, failedStage) => {
  const outcome = scenario.cases[name];
  assert.ok(outcome, `case ${name} missing`);
  assert.equal(outcome.outcome, 'decided', `${name}: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.allowed, false, `${name} allowed`);
  assert.equal(outcome.failedStage, failedStage, `${name}: ${JSON.stringify(outcome)}`);
};

test('A: a valid capability, owner-signed delegated consent, confirmed ownership and an allow policy authorize', () => {
  assert.deepEqual(scenario.cases['A allowed'], { outcome: 'decided', allowed: true, decision: 'allow', failedStage: null });
});

test('B: a correctly signed consent from a non-owner is denied at the consent stage', () => {
  decided('B correctly signed by a non-owner', 'consent');
});

test('C: unsigned, mis-signed, altered and un-countersigned consents are denied', () => {
  decided('C unsigned grant', 'consent');
  decided('C owner grant signed with another trusted key', 'consent');
  decided('C grant altered after signing', 'consent');
  decided('C delegated grant without the delegate countersignature', 'consent');
});

test('D: expired capabilities and expired or revoked consents are denied', () => {
  decided('D expired capability', 'capability');
  decided('D expired consent', 'consent');
  decided('D revoked consent', 'consent');
});

test('E: provider failures and invalid timestamps never authorize', () => {
  decided('E ownership provider throws', 'consent');
  decided('E ownership unknown', 'consent');
  // These three providers' exceptions propagate: evaluate() rejects instead of returning a deny.
  // That is fail-closed only if the caller treats a rejection as a denial (a FRONTERA-SOBE-PILOT-01B
  // requirement for the deny-only Kernel port).
  for (const name of ['E policy provider throws', 'E capability provider throws', 'E consent provider throws']) {
    assert.equal(scenario.cases[name].outcome, 'rejected', name);
    assert.equal(scenario.cases[name].allowed, false, name);
  }
  decided('E evaluation time `at` is a Date object', 'consent');
  decided('E evaluation time `now` is malformed', 'capability');
  decided('E grant issuedAt is an epoch number', 'consent');
  decided('E capability expiresAt is a Date object', 'capability');
});

test('governance is deny-by-default, namespaces are canonical, and federation is not enabled', () => {
  decided('F no governance rule matches', 'governance');
  decided('F governance deny rule', 'governance');
  decided('G sibling namespace', 'capability');
  decided('G traversal namespace', 'capability');
  decided('H federated authority without a verifier', 'governance');
});

test('the scenario loads only the approved runtime closure, from the extracted artifacts', () => {
  const packages = new Set();
  for (const file of scenario.loaded) {
    if (file === 'consume-runtime.cjs') continue;
    assert.ok(file.startsWith('node_modules/'), `${file} loaded from outside the extracted artifacts`);
    const parts = file.split('/');
    packages.add(parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]);
  }
  assert.deepEqual([...packages].sort(), [...RUNTIME, '@aoc/protocol'].sort());
  for (const name of [...DECLARATIONS, ...EXCLUDED_RUNTIME_PACKAGES]) assert.ok(!packages.has(name), `${name} was loaded`);
  // From @aoc/protocol, only the canonical module (the approved internal dependency) is loaded.
  for (const file of scenario.loaded.filter((path) => path.startsWith('node_modules/@aoc/protocol/'))) {
    assert.ok(file.startsWith('node_modules/@aoc/protocol/dist/canonical/') || file === 'node_modules/@aoc/protocol/package.json', file);
  }
});

// --- Integrity and policy negatives --------------------------------------------

test('a missing, corrupted, truncated or substituted artifact is rejected', () => {
  withTempDir('frontera-runtime-identity-', (dir) => {
    const entry = lock.packages.find((candidate) => candidate.name === '@aoc-runtime/consent-runtime');
    const good = readFileSync(resolve(root, entry.tarball.vendoredAt));
    const path = join(dir, entry.tarball.filename);
    writeFileSync(path, good);
    assert.deepEqual(tarballIdentityErrors(path, entry), []);

    assert.notDeepEqual(tarballIdentityErrors(join(dir, 'missing', entry.tarball.filename), entry), []);
    const flipped = Buffer.from(good);
    flipped[flipped.length - 1] ^= 0xff;
    writeFileSync(path, flipped);
    assert.ok(tarballIdentityErrors(path, entry).includes('sha256 differs'));
    writeFileSync(path, good.subarray(0, good.length - 1));
    assert.ok(tarballIdentityErrors(path, entry).some((error) => error.startsWith('size')));
    const other = lock.packages.find((candidate) => candidate.name === '@aoc-runtime/capability-runtime');
    writeFileSync(path, readFileSync(resolve(root, other.tarball.vendoredAt)));
    assert.notDeepEqual(tarballIdentityErrors(path, entry), []);
  });
});

test('the lock policy rejects excluded, missing, re-roled or widened packages', () => {
  const clone = () => JSON.parse(JSON.stringify(lock));
  const mutate = (fn) => {
    const copy = clone();
    fn(copy);
    return validateRuntimeLock(copy);
  };
  assert.notDeepEqual(mutate((l) => l.packages.push({ ...l.packages[0], name: '@aoc-runtime/trust-registry-runtime' })), []);
  assert.notDeepEqual(mutate((l) => l.packages.push({ ...l.packages[0], name: '@aoc/enterprise' })), []);
  assert.notDeepEqual(mutate((l) => l.packages.pop()), []);
  assert.notDeepEqual(mutate((l) => { l.packages.find((e) => e.name === '@aoc-runtime/shared-types').role = 'runtime'; }), []);
  assert.notDeepEqual(mutate((l) => { l.packages.find((e) => e.name === '@aoc-runtime/consent-runtime').runtimeRequires.push('@aoc-runtime/audit-runtime'); }), []);
  assert.notDeepEqual(mutate((l) => { l.packages.find((e) => e.name === '@aoc-runtime/shared-types').runtimeRequires.push('node:crypto'); }), []);
  assert.notDeepEqual(mutate((l) => { l.allowedRuntimeRequires.push('node:child_process'); }), []);
  assert.notDeepEqual(mutate((l) => { l.protocolDependency.requiredBy = []; }), []);
  assert.notDeepEqual(mutate((l) => { l.packaging.sourceModified = true; }), []);
});

// --- Boundaries ------------------------------------------------------------------

test('the canonical Protocol subpath stays internal: required only by crypto, never a source import', () => {
  const subpath = lock.protocolDependency.internalDependencySubpath;
  assert.ok(protocolLock.internalDependencySubpaths.includes(subpath));
  assert.ok(!ALLOWED_PROTOCOL_SUBPATHS.includes(subpath));
  assert.deepEqual(lock.packages.filter((entry) => entry.runtimeRequires.includes(subpath)).map((entry) => entry.name), ['@aoc-runtime/crypto']);
});

test('runtime imports are detected in every form, and no Frontera source imports the runtime', () => {
  for (const text of [
    "import { AuthorizationRuntime } from '@aoc-runtime/authorization-runtime';",
    "const x = require('@aoc-runtime/crypto');",
    "await import('@aoc-runtime/consent-runtime');",
    "import { AuditRuntime } from '@aoc/enterprise/assurance/audit';",
    "import x from 'aoc-runtime';",
  ]) {
    assert.equal(findRuntimeImports(text).length, 1, text);
  }
  assert.deepEqual(findRuntimeImports("import type { CanonicalId } from '@aoc/protocol';"), []);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/soberania-runtime/check-runtime-lock.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the runtime is not part of Frontera\'s dependency graph: no manifest or lockfile entry, no path dependency', () => {
  const pkg = readJson('package.json');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      assert.ok(!name.startsWith('@aoc-runtime/') && name !== '@aoc/enterprise' && name !== 'aoc-runtime', `${field}: ${name}`);
    }
  }
  const lockfile = readJson('package-lock.json');
  for (const key of Object.keys(lockfile.packages)) {
    assert.ok(!key.includes('node_modules/@aoc-runtime/') && !key.endsWith('node_modules/@aoc/enterprise'), key);
  }
});
