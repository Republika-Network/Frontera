import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { ALLOWED_PROTOCOL_SUBPATHS } from '../scripts/protocol/lib-protocol-artifact.mjs';
import {
  APPROVED_RUNTIME_PACKAGES,
  CLOSURE_WORKSPACE_DIR,
  EXCLUDED_RUNTIME_PACKAGES,
  RUNTIME_VENDOR_DIR,
  closureManifestErrors,
  extractTarballAsModule,
  findRuntimeImports,
  foreignManifestErrors,
  installedGraphErrors,
  tarballIdentityErrors,
  validateRuntimeLock,
} from '../scripts/soberania-runtime/lib-runtime-artifacts.mjs';

// FRONTERA-SOBE-PILOT-01A: the vendored Soberanía runtime artifacts, qualified as packages.
// FRONTERA-SOBE-PILOT-01C0: the same artifacts installed as production dependencies through the closure
// workspace, and consumed by a strict TypeScript client. Nothing here wires the runtime into the Kernel
// or the Host; no Frontera source consumes it yet.
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
  assert.equal(lock.sourceCommit, 'e85cf1bbb76e844fee7ff6ad5dd5389d26a5f180');
  assert.equal(lock.sourceTree, '526df04132d0cb0b5dac293c298eae1a104223db');
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

// --- Installation (FRONTERA-SOBE-PILOT-01C0) ---------------------------------------

const rootPkg = readJson('package.json');
const closurePkg = readJson(`${CLOSURE_WORKSPACE_DIR}/package.json`);
const packageLock = readJson('package-lock.json');

test('only the closure workspace declares the runtime; the published root artifact neither depends on nor bundles it', () => {
  assert.deepEqual(closureManifestErrors(closurePkg, lock, rootPkg, root), []);
  assert.deepEqual(foreignManifestErrors(rootPkg, 'package.json'), []);
  // The root artifact keeps its ADR-FRONTERA-SELF-CONTAINED-PACKAGING shape: @aoc/protocol an external peer
  // (and the local development pin), never a runtime dependency or a bundled one.
  assert.equal(rootPkg.dependencies?.['@aoc/protocol'], undefined);
  assert.ok(rootPkg.peerDependencies?.['@aoc/protocol']);
  assert.ok(!(rootPkg.bundleDependencies ?? []).some((name) => name.startsWith('@aoc-runtime/') || name === '@aoc/protocol' || name === closurePkg.name));
  assert.equal(rootPkg.dependencies?.[closurePkg.name], undefined);
});

test('package-lock.json installs exactly the locked artifacts, and @aoc/protocol, as production dependencies', () => {
  assert.deepEqual(installedGraphErrors(packageLock, lock), []);
});

test('the installed node_modules holds the vendored artifacts byte for byte, as real directories', () => {
  withTempDir('frontera-runtime-installed-', (dir) => {
    for (const entry of lock.packages) {
      const installed = resolve(root, 'node_modules', ...entry.name.split('/'));
      assert.ok(!lstatSync(installed).isSymbolicLink(), `${entry.name} is a symlink`);
      const expected = extractTarballAsModule(resolve(root, entry.tarball.vendoredAt), join(dir, 'node_modules'), entry.name);
      for (const file of entry.files) {
        assert.ok(readFileSync(join(installed, file)).equals(readFileSync(join(expected, file))), `${entry.name}/${file}`);
      }
    }
  });
});

test('the installation policy rejects widened, substituted, dev-only or misplaced runtime dependencies', () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const manifest = (fn) => {
    const copy = clone(closurePkg);
    fn(copy);
    return closureManifestErrors(copy, lock, rootPkg, root);
  };
  assert.notDeepEqual(manifest((p) => { p.dependencies['@aoc-runtime/audit-runtime'] = 'file:../../vendor/x.tgz'; }), []);
  assert.notDeepEqual(manifest((p) => { p.dependencies['@aoc/enterprise'] = '1.0.0'; }), []);
  assert.notDeepEqual(manifest((p) => { delete p.dependencies['@aoc-runtime/crypto']; }), []);
  assert.notDeepEqual(manifest((p) => { p.dependencies['@aoc-runtime/crypto'] = '0.1.0'; }), []);
  assert.notDeepEqual(manifest((p) => { p.dependencies['@aoc/protocol'] = 'file:../../vendor/aoc-protocol-0.2.0-rc.1.tgz'; }), []);
  assert.notDeepEqual(manifest((p) => { delete p.dependencies['@aoc/protocol']; }), []);
  assert.notDeepEqual(manifest((p) => { p.main = './index.js'; }), []);
  assert.notDeepEqual(manifest((p) => { p.private = false; }), []);
  assert.notDeepEqual(manifest((p) => { p.devDependencies = { '@aoc-runtime/crypto': p.dependencies['@aoc-runtime/crypto'] }; }), []);
  assert.notDeepEqual(foreignManifestErrors({ dependencies: { '@aoc-runtime/crypto': '0.1.0' } }, 'x'), []);
  assert.notDeepEqual(foreignManifestErrors({ bundleDependencies: ['@aoc-runtime/crypto'] }, 'x'), []);
  assert.notDeepEqual(foreignManifestErrors({ devDependencies: { '@aoc-runtime/trust-registry-runtime': '0.1.0' } }, 'x'), []);
  const graph = (fn) => {
    const copy = clone(packageLock);
    fn(copy.packages);
    return installedGraphErrors(copy, lock);
  };
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc-runtime/crypto'].integrity = 'sha512-AAAA'; }), []);
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc-runtime/crypto'].dev = true; }), []);
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc-runtime/crypto'].resolved = 'https://registry.npmjs.org/@aoc-runtime/crypto/-/crypto-0.1.0.tgz'; }), []);
  assert.notDeepEqual(graph((p) => { delete p['node_modules/@aoc-runtime/consent-runtime']; }), []);
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc/protocol'].dev = true; }), []);
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc-runtime/audit-runtime'] = { version: '0.1.0' }; }), []);
  assert.notDeepEqual(graph((p) => { p['node_modules/@aoc/enterprise'] = { version: '1.0.0' }; }), []);
  assert.notDeepEqual(graph((p) => { p['packages/x/node_modules/@aoc-runtime/crypto'] = p['node_modules/@aoc-runtime/crypto']; }), []);
});

test('npm itself refuses a corrupted artifact at install time (integrity mismatch)', () => {
  withTempDir('frontera-runtime-npm-integrity-', (dir) => {
    const entry = lock.packages.find((candidate) => candidate.name === '@aoc-runtime/shared-types');
    const tarball = join(dir, entry.tarball.filename);
    copyFileSync(resolve(root, entry.tarball.vendoredAt), tarball);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'integrity-probe', version: '0.0.0', private: true, dependencies: { [entry.name]: `file:./${entry.tarball.filename}` } })}\n`);
    const env = { ...process.env, npm_config_cache: join(dir, '.npm'), npm_config_audit: 'false', npm_config_fund: 'false' };
    const npm = (argv) => spawnSync('npm', argv, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(npm(['install', '--offline', '--ignore-scripts']).status, 0);
    const installedLock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    assert.equal(installedLock.packages[`node_modules/${entry.name}`].integrity, entry.tarball.integrity);
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    rmSync(join(dir, '.npm'), { recursive: true, force: true });
    // Substitute other bytes under the same name: npm ci must refuse them against the recorded integrity.
    copyFileSync(resolve(root, lock.packages.find((candidate) => candidate.name === '@aoc-runtime/provider-interfaces').tarball.vendoredAt), tarball);
    const tampered = npm(['ci', '--offline', '--ignore-scripts']);
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stdout}${tampered.stderr}`, /EINTEGRITY|integrity/i);
  });
});

// --- Strict TypeScript consumption (FRONTERA-SOBE-PILOT-01C0) ---------------------------

const STRICT_FIXTURE = resolve(root, 'tests/fixtures/soberania-runtime/strict-consumer');
const TSC = resolve(root, 'node_modules/typescript/bin/tsc');

function runStrictConsumer() {
  return withTempDir('frontera-runtime-strict-', (dir) => {
    // Installed packages only: the lock-verified artifacts and the installed @aoc/protocol. No Soberanía
    // checkout, no Frontera source, no path alias.
    cpSync(STRICT_FIXTURE, dir, { recursive: true });
    const nodeModules = join(dir, 'node_modules');
    for (const entry of lock.packages) {
      assert.deepEqual(tarballIdentityErrors(resolve(root, entry.tarball.vendoredAt), entry), [], entry.name);
      extractTarballAsModule(resolve(root, entry.tarball.vendoredAt), nodeModules, entry.name);
    }
    mkdirSync(join(nodeModules, '@aoc'), { recursive: true });
    cpSync(resolve(root, 'node_modules/@aoc/protocol'), join(nodeModules, '@aoc', 'protocol'), { recursive: true, dereference: true });

    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const compile = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: dir, env, encoding: 'utf8' });
    const negative = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.negative.json'], { cwd: dir, env, encoding: 'utf8' });
    const run = compile.status === 0 ? spawnSync(process.execPath, ['run.cjs'], { cwd: dir, env, encoding: 'utf8' }) : undefined;
    const report = run?.status === 0 ? JSON.parse(run.stdout) : undefined;
    return {
      compile: { status: compile.status, output: `${compile.stdout}${compile.stderr}` },
      negativeErrorLines: [...`${negative.stdout}`.matchAll(/^src\/negative\.ts\((\d+),\d+\): error TS\d+/gm)].map((match) => Number(match[1])),
      run: run === undefined ? undefined : { status: run.status, stderr: run.stderr },
      report: report === undefined ? undefined : { ...report, loaded: report.loaded.map((file) => relative(dir, file).split(sep).join('/')) },
    };
  });
}

const strict = runStrictConsumer();

test('the strict consumer compiles against the installed declarations: strict, skipLibCheck false, exact optional types, unchecked index access', () => {
  const config = JSON.parse(readFileSync(join(STRICT_FIXTURE, 'tsconfig.json'), 'utf8')).compilerOptions;
  assert.equal(config.strict, true);
  assert.equal(config.skipLibCheck, false);
  assert.equal(config.exactOptionalPropertyTypes, true);
  assert.equal(config.noUncheckedIndexedAccess, true);
  assert.equal(config.paths, undefined);
  assert.equal(config.baseUrl, undefined);
  assert.equal(strict.compile.status, 0, strict.compile.output);
});

test('the strict consumer source uses no escape hatch: no any, no assertion, no ambient module, no suppression', () => {
  const source = readFileSync(join(STRICT_FIXTURE, 'src/consumer.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /:\s*any\b|<any>|\bas\s+(?!const\b)[A-Za-z{[(]/);
  assert.doesNotMatch(source, /declare\s+module|@ts-ignore|@ts-expect-error|@ts-nocheck/);
  assert.equal(readdirSync(join(STRICT_FIXTURE, 'src')).filter((file) => file.endsWith('.d.ts')).length, 0);
});

test('incompatible finalizers and verifiers are rejected by the type checker, line for line', () => {
  const expected = readFileSync(join(STRICT_FIXTURE, 'src/negative.ts'), 'utf8')
    .split('\n')
    .map((line, index) => (line.trimEnd().endsWith('// expect-error') ? index + 1 : 0))
    .filter(Boolean);
  assert.equal(expected.length, 7);
  assert.deepEqual([...new Set(strict.negativeErrorLines)].sort((a, b) => a - b), expected);
});

test('typed AuthorizationRuntime: one valid signed case allows; invalid, missing, expired, revoked and governance or capability denials deny; provider failures reject', () => {
  assert.ok(strict.report, strict.run?.stderr ?? strict.compile.output);
  const cases = strict.report.cases;
  const allowed = Object.entries(cases).filter(([, outcome]) => outcome.allowed).map(([name]) => name);
  assert.deepEqual(allowed, ['allow: valid capability, owner-signed delegated consent, allow policy']);
  assert.equal(cases['allow: valid capability, owner-signed delegated consent, allow policy'].decision, 'allow');
  const denied = (name, stage) => assert.deepEqual([cases[name].outcome, cases[name].allowed, cases[name].failedStage], ['decided', false, stage], name);
  denied('deny: consent signed with another trusted key', 'consent');
  denied('deny: delegated consent without the delegate countersignature', 'consent');
  denied('deny: no consent', 'consent');
  denied('deny: expired consent', 'consent');
  denied('deny: revoked consent', 'consent');
  denied('deny: consent runtime configured with an empty trusted key set', 'consent');
  denied('deny: no capability for the actor', 'capability');
  denied('deny: expired capability', 'capability');
  denied('deny: malformed evaluation time', 'capability');
  denied('deny: no governance rule matches', 'governance');
  denied('deny: governance deny rule', 'governance');
  // Provider exceptions surface as rejections, never as a decision and never as an allow.
  for (const name of ['rejected: policy provider throws', 'rejected: capability provider throws', 'rejected: consent provider throws']) {
    assert.deepEqual([cases[name].outcome, cases[name].allowed, cases[name].error], ['rejected', false, 'provider unavailable'], name);
  }
});

test('the strict consumer loads only the approved runtime closure from installed packages', () => {
  const packages = new Set();
  for (const file of strict.report.loaded) {
    if (file === 'run.cjs' || file === 'dist/consumer.js') continue;
    assert.ok(file.startsWith('node_modules/'), `${file} loaded from outside the installed packages`);
    const parts = file.split('/');
    packages.add(parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]);
  }
  assert.deepEqual([...packages].sort(), [...RUNTIME, '@aoc/protocol'].sort());
  for (const name of [...DECLARATIONS, ...EXCLUDED_RUNTIME_PACKAGES]) assert.ok(!packages.has(name), `${name} was loaded`);
});

test('the pass-through finalizer is a frozen, explicitly non-production test fixture that nothing ships', () => {
  const source = readFileSync(join(STRICT_FIXTURE, 'src/consumer.ts'), 'utf8');
  assert.match(source, /TEST FIXTURE ONLY — NOT A PRODUCTION AUDIT FINALIZER\./);
  assert.match(source, /export const NON_PRODUCTION_PASS_THROUGH_FINALIZER: AuthorizationDecisionFinalizer = Object\.freeze\(/);
  assert.equal(strict.report.finalizerIsFrozen, true);
  // The closure workspace ships no code, so no finalizer, pass-through or otherwise, reaches the Host.
  assert.equal(closurePkg.main, undefined);
  assert.equal(closurePkg.exports, undefined);
  assert.deepEqual(readdirSync(resolve(root, CLOSURE_WORKSPACE_DIR)).sort(), ['README.md', 'package.json']);
});

// --- Kernel port stays optional and unwired -------------------------------------------

test('the deny-only Kernel external authorization port is configured nowhere outside the Kernel', () => {
  const allowed = new Set([
    'src/kernel/AocKernel.ts',
    'src/kernel/orchestration/external-authorization-adapter.ts',
    'src/kernel/contracts/kernel-result.ts',
    'src/kernel/__tests__/kernel-external-authorization.test.ts',
  ]);
  const offenders = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
        const rel = relative(root, full).split(sep).join('/');
        if (!allowed.has(rel) && /externalAuthorization/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  for (const dir of ['src', 'packages', 'apps', 'scripts', 'deploy']) visit(resolve(root, dir));
  assert.deepEqual(offenders, []);
});
