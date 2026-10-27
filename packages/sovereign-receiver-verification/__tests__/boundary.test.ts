import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { validFixture, validOptions } from './fixtures.js';

// Compiled to dist-test/__tests__; the package root is two levels up.
const packageRoot = join(__dirname, '..', '..');
const APPROVED_PROTOCOL_SUBPATHS = ['@aoc/protocol/identity', '@aoc/protocol/interoperability', '@aoc/protocol/manifest', '@aoc/protocol/portability'];

test('an unexpected exception inside Protocol verification fails closed', async () => {
  const manifestPath = require.resolve('@aoc/protocol/manifest');
  const real = require(manifestPath) as Record<string, unknown>;
  const sdkModules = Object.keys(require.cache).filter((path) => path.startsWith(join(packageRoot, 'dist-test', 'src')));
  const saved = require.cache[manifestPath];
  try {
    const faulty = {
      ...real,
      verifySovereignManifest: async () => {
        throw new Error('unexpected verifier fault');
      },
    };
    require.cache[manifestPath] = { ...saved, exports: faulty } as NodeJS.Module;
    for (const path of sdkModules) delete require.cache[path];
    const fresh = require('../src/index.js') as typeof import('../src/index.js');
    const result = await fresh.verifyReceivedSovereignAsset(validFixture().text, validOptions());
    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(result.reasons, ['INTERNAL_VERIFICATION_ERROR']);
    assert.equal(result.authorization, 'not_evaluated');
  } finally {
    if (saved) require.cache[manifestPath] = saved;
    for (const path of sdkModules) delete require.cache[path];
  }
});

test('the public surface is exactly the verifier, its reasons and its profile', () => {
  const sdk = require('../src/index.js') as Record<string, unknown>;
  const exported = Object.keys(sdk).filter((name) => name !== '__esModule' && name !== 'default').sort();
  assert.deepEqual(exported, ['RECEIVER_VERIFICATION_REJECTION_REASONS', 'STRICT_RECEIVER_PROFILE', 'verifyReceivedSovereignAsset']);
});

test('no Protocol value is reachable through the package surface', () => {
  const sdk = require('../src/index.js') as Record<string, unknown>;
  const protocolValues = new Set<unknown>();
  for (const subpath of APPROVED_PROTOCOL_SUBPATHS) {
    for (const value of Object.values(require(subpath) as Record<string, unknown>)) protocolValues.add(value);
  }
  for (const [name, value] of Object.entries(sdk)) assert.equal(protocolValues.has(value), false, `${name} re-exports a Protocol value`);
});

test('the package stays private, Host-independent and free of runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg['private'], true);
  assert.equal(pkg['publishConfig'], undefined);
  // No dependency of any kind: in particular no registry spec for @aoc/protocol
  // that a lockfile-free install could satisfy from a public registry package.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
    assert.equal(pkg[field], undefined, `${field} must not be declared`);
  }
});

test('Protocol reaches the package only through the root, pinned to the approved tarball', () => {
  // Path-independent on purpose: the tarball validator points the root at its
  // own rebuilt copy of the same artifact. What must hold everywhere is a
  // file: tarball (never a registry range) whose integrity is the approved one.
  const repoRoot = join(packageRoot, '..', '..');
  const approved = (JSON.parse(readFileSync(join(repoRoot, 'protocol-consumer.lock.json'), 'utf8')) as {
    tarball: { filename: string; integrity: string };
  }).tarball;
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
  const spec = rootPkg.devDependencies?.['@aoc/protocol'] ?? '';
  assert.ok(spec.startsWith('file:') && spec.endsWith(`/${approved.filename}`), `root @aoc/protocol must be the ${approved.filename} tarball, got ${spec}`);
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
  const protocolEntries = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/@aoc/protocol'));
  assert.equal(protocolEntries.length, 1, `exactly one installed @aoc/protocol, got ${protocolEntries.map(([path]) => path).join(', ')}`);
  const [path, entry] = protocolEntries[0]!;
  assert.equal(path, 'node_modules/@aoc/protocol');
  const resolved = String(entry['resolved']);
  assert.ok(resolved.startsWith('file:') && resolved.endsWith(`/${approved.filename}`), `resolved from ${resolved}`);
  assert.equal(entry['integrity'], approved.integrity);
  assert.equal(entry['dev'], true);
  const self = lock.packages['packages/sovereign-receiver-verification'] ?? {};
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(self[field], undefined, `lockfile entry declares ${field}`);
  }
});

test('sources import only the approved Protocol subpaths and each other', () => {
  const srcDir = join(packageRoot, 'src');
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('./') || APPROVED_PROTOCOL_SUBPATHS.includes(specifier), `${file} imports ${specifier}`);
    }
    for (const forbidden of [/\bfetch\s*\(/, /node:(?:http|https|net|dgram|tls|child_process|fs)\b/, /\bprocess\.env\b/, /\bDate\.now\s*\(|new Date\s*\(/]) {
      assert.equal(forbidden.test(text), false, `${file} matches ${forbidden}`);
    }
  }
});
