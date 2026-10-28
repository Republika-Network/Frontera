// RSDK-01 (licensing added by FV-P2): the package-scoped @aoc/protocol allowance admits exactly five subpaths, only inside
// packages/sovereign-receiver-verification/, and cannot be used from any other Frontera path.
//
// Fixture sources below are assembled from template strings, so this file never contains a
// literal deep import itself (the consumption gate scans tests/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_PROTOCOL_SUBPATHS,
  INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS,
  PACKAGE_SCOPED_PROTOCOL_SUBPATHS,
  isAllowedProtocolImportSpecifier,
  isPackageScopedProtocolImport,
  validateCompatibilityLock,
} from '../scripts/protocol/lib-protocol-artifact.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = 'packages/sovereign-receiver-verification/';
const SCOPED = ['identity', 'manifest', 'portability', 'interoperability', 'licensing'].map((name) => `@aoc/protocol/${name}`);
const NOT_SCOPED = [
  '@aoc/protocol/canonical',
  '@aoc/protocol/governance-compatibility',
  '@aoc/protocol/sovereignty-capabilities',
  '@aoc/protocol/manifest/verify',
  '@aoc/protocol/dist/manifest/index.js',
  '@aoc/protocol/src/manifest',
];

// --- The allowance itself -----------------------------------------------------

test('the global allowlist is unchanged and disjoint from the package-scoped subpaths', () => {
  assert.deepEqual([...ALLOWED_PROTOCOL_SUBPATHS], [
    '@aoc/protocol',
    '@aoc/protocol/contracts',
    '@aoc/protocol/errors',
    '@aoc/protocol/claims',
    '@aoc/protocol/adapters',
    '@aoc/protocol/runtime-registry',
  ]);
  for (const subpath of SCOPED) {
    assert.equal(isAllowedProtocolImportSpecifier(subpath), false, `${subpath} must not be globally allowed`);
    assert.equal(INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS.includes(subpath), false);
  }
});

test('exactly one package holds an allowance, for exactly the five approved subpaths, and it is frozen', () => {
  assert.equal(PACKAGE_SCOPED_PROTOCOL_SUBPATHS.length, 1);
  const [entry] = PACKAGE_SCOPED_PROTOCOL_SUBPATHS;
  assert.equal(entry.package, '@aoc-enterprise/sovereign-receiver-verification');
  assert.equal(entry.directory, PKG_DIR);
  assert.deepEqual([...entry.subpaths], SCOPED);
  assert.ok(Object.isFrozen(PACKAGE_SCOPED_PROTOCOL_SUBPATHS) && Object.isFrozen(entry) && Object.isFrozen(entry.subpaths));
});

test('the allowance admits the approved subpaths inside the package only', () => {
  for (const subpath of SCOPED) {
    assert.equal(isPackageScopedProtocolImport(subpath, `${PKG_DIR}src/verify.ts`), true);
    assert.equal(isPackageScopedProtocolImport(subpath, `${PKG_DIR}__tests__/verify.test.ts`), true);
  }
});

test('the allowance cannot be used from unrelated Frontera paths', () => {
  const outside = [
    'src/index.ts',
    'src/enterprise/content-protection/sovereign-binding-port.ts',
    'src/kernel-host/index.ts',
    'packages/enterprise-host-sdk/src/client.ts',
    'packages/identity/src/index.ts',
    'tests/protocol-active-pin.test.mjs',
    'scripts/check-protocol-consumption.mjs',
    'apps/dashboard/src/page.ts',
    // Lookalike and traversal paths.
    'packages/sovereign-receiver-verification',
    'packages/sovereign-receiver-verification-evil/src/index.ts',
    'packages/sovereign-receiver-verificationx/src/index.ts',
    `${PKG_DIR}../enterprise-host-sdk/src/client.ts`,
    `${PKG_DIR}src/../../identity/src/index.ts`,
    `./${PKG_DIR}src/verify.ts`,
    `/${PKG_DIR}src/verify.ts`,
    `${PKG_DIR.replace(/\//g, '\\')}src\\verify.ts`,
    `src/${PKG_DIR}verify.ts`,
    '',
  ];
  for (const path of outside) {
    for (const subpath of SCOPED) {
      assert.equal(isPackageScopedProtocolImport(subpath, path), false, `${subpath} must not be admitted for "${path}"`);
    }
  }
  for (const bad of [undefined, null, 42, {}]) assert.equal(isPackageScopedProtocolImport(SCOPED[0], bad), false);
});

test('the allowance never admits other or deeper Protocol subpaths, even inside the package', () => {
  for (const subpath of [...NOT_SCOPED, '@aoc/protocol', '@aoc/protocol/claims']) {
    assert.equal(isPackageScopedProtocolImport(subpath, `${PKG_DIR}src/verify.ts`), false, subpath);
  }
});

// --- Compatibility lock -----------------------------------------------------------

const lock = JSON.parse(await readFile(join(ROOT, 'protocol-consumer.lock.json'), 'utf8'));

test('the compatibility lock records the allowance exactly and stays valid', () => {
  assert.deepEqual(lock.packageScopedPublicExports, [{ package: '@aoc-enterprise/sovereign-receiver-verification', directory: PKG_DIR, subpaths: SCOPED }]);
  assert.deepEqual(lock.verifiedPublicExports, [...ALLOWED_PROTOCOL_SUBPATHS]);
  assert.deepEqual(validateCompatibilityLock(lock), { valid: true, errors: [] });
});

test('the lock cannot widen or move the allowance', () => {
  const variants = [
    [{ ...lock.packageScopedPublicExports[0], subpaths: [...SCOPED, '@aoc/protocol/canonical'] }],
    [{ ...lock.packageScopedPublicExports[0], subpaths: SCOPED.slice(1) }],
    [{ ...lock.packageScopedPublicExports[0], directory: 'packages/' }],
    [{ ...lock.packageScopedPublicExports[0], directory: 'src/' }],
    [{ ...lock.packageScopedPublicExports[0], package: '@aoc-enterprise/runtime' }],
    [...lock.packageScopedPublicExports, { package: '@aoc-enterprise/identity', directory: 'packages/identity/', subpaths: SCOPED }],
    [],
    'packages/sovereign-receiver-verification/',
  ];
  for (const packageScopedPublicExports of variants) {
    const result = validateCompatibilityLock({ ...lock, packageScopedPublicExports });
    assert.equal(result.valid, false, JSON.stringify(packageScopedPublicExports));
  }
});

test('a package-scoped subpath may not also be listed as a verified public export', () => {
  const result = validateCompatibilityLock({ ...lock, verifiedPublicExports: [...lock.verifiedPublicExports, '@aoc/protocol/manifest'] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('package-scoped')));
});

test('the lock checker refuses a lock that omits the allowance the gates grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsdk01-lock-'));
  try {
    const { packageScopedPublicExports, ...withoutField } = lock;
    assert.ok(packageScopedPublicExports);
    await writeFile(join(dir, 'protocol-consumer.lock.json'), JSON.stringify(withoutField));
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/protocol/check-compatibility-lock.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /packageScopedPublicExports/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the installed, locked Protocol artifact declares every package-scoped subpath', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'node_modules/@aoc/protocol/package.json'), 'utf8'));
  assert.equal(pkg.version, lock.expectedVersion);
  for (const subpath of SCOPED) assert.ok(pkg.exports[`.${subpath.slice('@aoc/protocol'.length)}`], `${subpath} is not declared by the artifact`);
});

// --- Both gates, end to end -----------------------------------------------------------

async function withFixtureTree(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rsdk01-gates-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, peerDependencies: { '@aoc/protocol': '>=0.1.0' } }));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runGate(script, cwd) {
  const run = spawnSync(process.execPath, [join(ROOT, script)], { cwd, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const importOf = (specifier) => `import { value } from '${specifier}';\nexport const used = value;\n`;
const requireOf = (specifier) => `const loaded = require('${specifier}');\nexport const used = loaded;\n`;
const dynamicImportOf = (specifier) => `export const used = import('${specifier}');\n`;
const GATES = ['scripts/check-protocol-consumption.mjs', 'scripts/check-node16-imports.mjs'];

test('both gates accept the approved subpaths inside the package', async () => {
  const files = Object.fromEntries(SCOPED.map((subpath, index) => [`${PKG_DIR}src/use-${index}.ts`, importOf(subpath)]));
  await withFixtureTree(files, async (dir) => {
    for (const gate of GATES) {
      const run = runGate(gate, dir);
      assert.equal(run.status, 0, `${gate}: ${run.output}`);
    }
  });
});

test('both gates reject the approved subpaths from any other Frontera path', async () => {
  const paths = [
    'src/receiver.ts',
    'src/enterprise/content-protection/receiver.ts',
    'packages/enterprise-host-sdk/src/receiver.ts',
    'packages/sovereign-receiver-verification-evil/src/receiver.ts',
    'tests/receiver.test.ts',
  ];
  for (const path of paths) {
    for (const subpath of SCOPED) {
      await withFixtureTree({ [path]: importOf(subpath) }, async (dir) => {
        for (const gate of GATES) {
          const run = runGate(gate, dir);
          assert.notEqual(run.status, 0, `${gate} accepted ${subpath} from ${path}`);
          assert.ok(run.output.includes(path), `${gate} did not name ${path}: ${run.output}`);
        }
      });
    }
  }
});

test('both gates reject unapproved subpaths inside the package', async () => {
  for (const subpath of NOT_SCOPED) {
    await withFixtureTree({ [`${PKG_DIR}src/leak.ts`]: importOf(subpath) }, async (dir) => {
      for (const gate of GATES) {
        assert.notEqual(runGate(gate, dir).status, 0, `${gate} accepted ${subpath} inside the package`);
      }
    });
  }
});

test('require() and dynamic import() of an unapproved subpath are rejected inside the package', async () => {
  for (const form of [requireOf, dynamicImportOf]) {
    await withFixtureTree({ [`${PKG_DIR}src/leak.ts`]: form('@aoc/protocol/canonical') }, async (dir) => {
      assert.notEqual(runGate('scripts/check-node16-imports.mjs', dir).status, 0);
    });
    await withFixtureTree({ ['src/leak.ts']: form('@aoc/protocol/manifest') }, async (dir) => {
      assert.notEqual(runGate('scripts/check-node16-imports.mjs', dir).status, 0);
    });
  }
});

// --- The tarball validator's forbidden import scan (the third gate) -------------

const { forbiddenImportScan } = await import('../scripts/protocol/validate-enterprise-against-protocol-tarball.mjs');
const scan = (files) => withFixtureTree(files, (dir) => forbiddenImportScan(dir));

test('the tarball scan accepts the approved subpaths inside the package, in every source form', async () => {
  const files = {};
  SCOPED.forEach((subpath, index) => {
    files[`${PKG_DIR}src/use-${index}.ts`] = importOf(subpath);
    files[`${PKG_DIR}__tests__/use-${index}.test.ts`] = `${requireOf(subpath)}${dynamicImportOf(subpath).replace('used', 'later')}`;
  });
  assert.deepEqual(await scan(files), []);
});

test('the tarball scan rejects the approved subpaths from any other Frontera path', async () => {
  const paths = [
    'src/receiver.ts',
    'packages/enterprise-host-sdk/src/receiver.ts',
    'packages/sovereign-receiver-verification-evil/src/receiver.ts',
    'packages/evil/packages/sovereign-receiver-verification/src/receiver.ts',
    'tests/receiver.test.mjs',
    'scripts/receiver.mjs',
    'types/receiver.d.ts',
  ];
  for (const path of paths) {
    for (const subpath of SCOPED) {
      assert.deepEqual(await scan({ [path]: importOf(subpath) }), [`${path}: forbidden deep protocol import`], `${subpath} from ${path}`);
    }
  }
});

test('the tarball scan rejects unapproved and deeper subpaths inside the package, in every source form', async () => {
  const deeper = ['@aoc/protocol/identity/', '@aoc/protocol/identity/../manifest', '@aoc/protocol/manifest/verify.js', '@aoc/protocol/'];
  for (const subpath of [...NOT_SCOPED, ...deeper]) {
    for (const form of [importOf, requireOf, dynamicImportOf]) {
      const violations = await scan({ [`${PKG_DIR}src/leak.ts`]: form(subpath) });
      assert.ok(violations.includes(`${PKG_DIR}src/leak.ts: forbidden deep protocol import`), `accepted ${subpath}: ${violations}`);
    }
  }
});

test('the tarball scan fails closed on mismatched quotes, template literals and mixed files', async () => {
  const leak = `${PKG_DIR}src/leak.ts`;
  const sources = [
    `import { value } from '${SCOPED[0]}";\n`,
    `import { value } from '${SCOPED[0]}\n`,
    `export const used = import(\`${SCOPED[0]}\`);\n`,
    `${importOf(SCOPED[0])}${importOf('@aoc/protocol/canonical').replace('value', 'other').replace('used', 'leaked')}`,
  ];
  for (const source of sources) {
    assert.deepEqual(await scan({ [leak]: source }), [`${leak}: forbidden deep protocol import`], JSON.stringify(source));
  }
});

test('the tarball scan keeps its sibling-path and dist checks inside the package', async () => {
  const leak = `${PKG_DIR}src/leak.ts`;
  // Assembled at runtime: the consumption gate scans tests/ for the literal sibling path.
  const siblingSource = ['..', '..', '..', ['Architects', 'of', 'Change', 'Protocol'].join('_'), 'src', 'index'].join('/');
  assert.deepEqual(await scan({ [leak]: importOf(siblingSource) }), [`${leak}: forbidden protocol source import`]);
  assert.deepEqual(await scan({ [leak]: importOf('@aoc/protocol/dist/manifest/index.js') }), [
    `${leak}: forbidden deep protocol import`,
    `${leak}: forbidden protocol dist deep import`,
  ]);
});

test('the tarball validator still runs its battery when executed directly', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/protocol/validate-enterprise-against-protocol-tarball.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AOC_PROTOCOL_TARBALL: '' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /FATAL: .*Usage: node scripts\/protocol\/validate-enterprise-against-protocol-tarball\.mjs/);
});
