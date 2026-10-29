import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { validFixture, validOptions } from './fixtures.js';

// Compiled to dist-test/__tests__; the package root is two levels up.
const packageRoot = join(__dirname, '..', '..');
const APPROVED_PROTOCOL_SUBPATHS = ['@aoc/protocol/identity', '@aoc/protocol/interoperability', '@aoc/protocol/licensing', '@aoc/protocol/manifest', '@aoc/protocol/portability'];
const repoRoot = join(packageRoot, '..', '..');
const RECEIVER_DIRECTORY = 'packages/sovereign-receiver-verification';
// FRONTERA-SOBE-PILOT-01C0: the only workspace approved to own a production dependency on
// @aoc/protocol. Its @aoc-runtime/crypto requires @aoc/protocol/canonical at run time.
const PROTOCOL_PRODUCTION_OWNERS = ['packages/soberania-runtime-closure'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies'] as const;

type Manifest = Record<string, unknown>;
type LockEntry = Record<string, unknown>;
interface ProtocolGraph {
  readonly approved: { readonly filename: string; readonly integrity: string };
  readonly rootManifest: Manifest;
  readonly lockPackages: Readonly<Record<string, LockEntry>>;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function protocolSpec(entry: Manifest | LockEntry | undefined, field: string): unknown {
  const value = entry?.[field];
  if (Array.isArray(value)) return value.includes('@aoc/protocol') ? true : undefined;
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)['@aoc/protocol'] : undefined;
}

// Path-independent on purpose: the tarball validator points the root and the closure workspace at its
// own rebuilt copy of the same artifact. What must hold everywhere is a file: tarball (never a
// registry range) whose integrity is the approved one.
function isApprovedTarball(spec: unknown, filename: string): boolean {
  return typeof spec === 'string' && spec.startsWith('file:') && spec.endsWith(`/${filename}`);
}

/**
 * Who installs @aoc/protocol and how. The root keeps its development dependency on the approved tarball
 * and its external peer range (never a production or bundled dependency); exactly the approved
 * workspaces own a production dependency, on the same tarball; no other workspace declares Protocol in
 * any field; exactly one top-level package is installed, from the approved tarball with the approved
 * integrity, and it is classified as production exactly when a production owner exists.
 */
function protocolGraphErrors({ approved, rootManifest, lockPackages }: ProtocolGraph): string[] {
  const errors: string[] = [];
  if (!isApprovedTarball(protocolSpec(rootManifest, 'devDependencies'), approved.filename)) errors.push(`root devDependency is not the ${approved.filename} tarball`);
  const peer = protocolSpec(rootManifest, 'peerDependencies');
  if (typeof peer !== 'string' || peer.startsWith('file:')) errors.push('root external peer range is missing or not a range');
  for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    if (protocolSpec(rootManifest, field) !== undefined) errors.push(`root declares @aoc/protocol in ${field}`);
  }
  const owners: string[] = [];
  for (const [path, entry] of Object.entries(lockPackages)) {
    if (path === '' || path.includes('node_modules/')) continue;
    const fields = DEPENDENCY_FIELDS.filter((field) => protocolSpec(entry, field) !== undefined);
    if (fields.length === 0) continue;
    if (PROTOCOL_PRODUCTION_OWNERS.includes(path) && fields.length === 1 && fields[0] === 'dependencies') {
      owners.push(path);
      if (!isApprovedTarball(protocolSpec(entry, 'dependencies'), approved.filename)) errors.push(`${path} does not depend on the ${approved.filename} tarball`);
    } else {
      errors.push(`${path} declares @aoc/protocol in ${fields.join(', ')} without approval`);
    }
  }
  if (owners.length !== PROTOCOL_PRODUCTION_OWNERS.length) errors.push(`production owners are [${owners.join(', ')}], expected [${PROTOCOL_PRODUCTION_OWNERS.join(', ')}]`);
  const installed = Object.keys(lockPackages).filter((path) => path.endsWith('node_modules/@aoc/protocol'));
  if (installed.length !== 1 || installed[0] !== 'node_modules/@aoc/protocol') {
    errors.push(`exactly one top-level @aoc/protocol must be installed, got [${installed.join(', ')}]`);
    return errors;
  }
  const entry = lockPackages['node_modules/@aoc/protocol']!;
  if (!isApprovedTarball(entry['resolved'], approved.filename)) errors.push(`@aoc/protocol is resolved from ${String(entry['resolved'])}`);
  if (entry['integrity'] !== approved.integrity) errors.push(`@aoc/protocol integrity ${String(entry['integrity'])} is not the approved one`);
  const production = entry['dev'] === undefined && entry['devOptional'] === undefined && entry['optional'] === undefined;
  if (production !== owners.length > 0) errors.push(`@aoc/protocol is classified ${production ? 'production' : 'development'} with production owners [${owners.join(', ')}]`);
  return errors;
}

/** The receiver stays private, unpublishable and free of any dependency declaration, in its manifest and its lockfile entry. */
function receiverManifestErrors(manifest: Manifest, lockEntry: LockEntry | undefined): string[] {
  const errors: string[] = [];
  if (manifest['private'] !== true) errors.push('the package is not private');
  if (manifest['publishConfig'] !== undefined) errors.push('the package declares publishConfig');
  for (const field of [...DEPENDENCY_FIELDS, 'bundledDependencies']) {
    // No dependency of any kind: in particular no registry spec for @aoc/protocol that a
    // lockfile-free install could satisfy from a public registry package.
    if (manifest[field] !== undefined) errors.push(`package.json declares ${field}`);
    if (lockEntry?.[field] !== undefined) errors.push(`lockfile entry declares ${field}`);
  }
  return errors;
}

/** Imports other than the approved Protocol subpaths and the package's own modules, and ambient I/O or clock use. */
function sourceViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  const specifiers = [...text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  for (const specifier of specifiers) {
    if (!specifier.startsWith('./') && !APPROVED_PROTOCOL_SUBPATHS.includes(specifier)) violations.push(`${file} imports ${specifier}`);
  }
  for (const forbidden of [/\bfetch\s*\(/, /node:(?:http|https|net|dgram|tls|child_process|fs)\b/, /\bprocess\.env\b/, /\bDate\.now\s*\(|new Date\s*\(/]) {
    if (forbidden.test(text)) violations.push(`${file} matches ${forbidden}`);
  }
  return violations;
}

/** Names on the package surface whose value is a Protocol value. */
function reexportedProtocolValues(surface: Record<string, unknown>, protocolValues: ReadonlySet<unknown>): string[] {
  return Object.entries(surface).filter(([, value]) => protocolValues.has(value)).map(([name]) => name);
}

function approvedProtocolValues(): Set<unknown> {
  const values = new Set<unknown>();
  for (const subpath of APPROVED_PROTOCOL_SUBPATHS) {
    for (const value of Object.values(require(subpath) as Record<string, unknown>)) values.add(value);
  }
  return values;
}

function realGraph(): ProtocolGraph {
  const approved = (readJson(join(repoRoot, 'protocol-consumer.lock.json')) as { tarball: { filename: string; integrity: string } }).tarball;
  const lockPackages = (readJson(join(repoRoot, 'package-lock.json')) as { packages: Record<string, LockEntry> }).packages;
  return { approved, rootManifest: readJson(join(repoRoot, 'package.json')), lockPackages };
}

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

test('the public surface is exactly the three verifiers, the policy evaluator, the freshness gate, their reasons and their profiles', () => {
  const sdk = require('../src/index.js') as Record<string, unknown>;
  const exported = Object.keys(sdk).filter((name) => name !== '__esModule' && name !== 'default').sort();
  assert.deepEqual(exported, [
    'DOCUMENT_USE_ACTIONS',
    'DOCUMENT_USE_FRESHNESS_CEILINGS',
    'DOCUMENT_USE_FRESHNESS_GATE',
    'DOCUMENT_USE_FRESHNESS_VERDICTS',
    'DOCUMENT_USE_INELIGIBILITY_REASONS',
    'DOCUMENT_USE_POLICY_EVALUATOR',
    'DOCUMENT_USE_POLICY_REASONS',
    'DOCUMENT_USE_PROFILE',
    'DOCUMENT_USE_RECEIVER_PROFILE',
    'RECEIVER_VERIFICATION_REJECTION_REASONS',
    'SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS',
    'SOVEREIGN_STATUS_PROFILE',
    'SOVEREIGN_STATUS_PURPOSE',
    'SOVEREIGN_STATUS_REJECTION_REASONS',
    'SOVEREIGN_STATUS_VERIFIER',
    'STATUS_HISTORY_BOOTSTRAP_REASONS',
    'STRICT_RECEIVER_PROFILE',
    'checkDocumentUseFreshness',
    'createInMemoryStatusHighWaterMarkStore',
    'establishStatusHistory',
    'evaluateDocumentUsePolicy',
    'verifyDocumentUseEligibility',
    'verifyReceivedSovereignAsset',
    'verifySovereignStatus',
  ]);
});

test('no Protocol value is reachable through the package surface', () => {
  const sdk = require('../src/index.js') as Record<string, unknown>;
  assert.deepEqual(reexportedProtocolValues(sdk, approvedProtocolValues()), []);
});

test('the package stays private, Host-independent and free of runtime dependencies', () => {
  const lockPackages = realGraph().lockPackages;
  assert.deepEqual(receiverManifestErrors(readJson(join(packageRoot, 'package.json')), lockPackages[RECEIVER_DIRECTORY]), []);
});

test('Protocol is installed once, from the approved tarball, and owned for production only by the approved closure', () => {
  // Since FRONTERA-SOBE-PILOT-01C0 the private runtime closure workspace installs @aoc/protocol as a
  // production dependency, so the lockfile no longer marks it dev-only. Ownership, not the global
  // classification, is the boundary: this package declares nothing, and only the closure may own it.
  assert.deepEqual(protocolGraphErrors(realGraph()), []);
});

test('the approved Protocol subpaths are exactly the package-scoped allowance recorded in the compatibility lock', () => {
  const scoped = (readJson(join(repoRoot, 'protocol-consumer.lock.json')) as { packageScopedPublicExports?: { directory: string; subpaths: string[] }[] }).packageScopedPublicExports ?? [];
  const own = scoped.filter((allowance) => allowance.directory === `${RECEIVER_DIRECTORY}/`);
  assert.equal(own.length, 1);
  assert.deepEqual([...own[0]!.subpaths].sort(), [...APPROVED_PROTOCOL_SUBPATHS].sort());
});

test('sources import only the approved Protocol subpaths and each other', () => {
  const srcDir = join(packageRoot, 'src');
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
    assert.deepEqual(sourceViolations(file, readFileSync(join(srcDir, file), 'utf8')), []);
  }
});

// Negative controls: every mutation is applied to an in-memory copy of the real inputs; no manifest,
// lockfile or source file is touched.
function mutatedGraph(mutate: (graph: { approved: { filename: string; integrity: string }; rootManifest: Manifest; lockPackages: Record<string, LockEntry> }) => void): ProtocolGraph {
  const graph = JSON.parse(JSON.stringify(realGraph())) as { approved: { filename: string; integrity: string }; rootManifest: Manifest; lockPackages: Record<string, LockEntry> };
  mutate(graph);
  return graph;
}

test('negative controls: the Protocol ownership policy refuses each violation', () => {
  const closure = PROTOCOL_PRODUCTION_OWNERS[0]!;
  const cases: [string, ProtocolGraph][] = [
    ['receiver declares a direct Protocol dependency', mutatedGraph((g) => { g.lockPackages[RECEIVER_DIRECTORY] = { ...g.lockPackages[RECEIVER_DIRECTORY], dependencies: { '@aoc/protocol': 'file:../../vendor/aoc-protocol-0.2.0-rc.3.tgz' } }; })],
    ['closure takes Protocol from the registry', mutatedGraph((g) => { (g.lockPackages[closure]!['dependencies'] as Record<string, string>)['@aoc/protocol'] = '0.2.0-rc.3'; })],
    ['installed Protocol resolved from the registry', mutatedGraph((g) => { g.lockPackages['node_modules/@aoc/protocol']!['resolved'] = 'https://registry.npmjs.org/@aoc/protocol/-/protocol-0.2.0-rc.3.tgz'; })],
    ['changed Protocol integrity', mutatedGraph((g) => { g.lockPackages['node_modules/@aoc/protocol']!['integrity'] = 'sha512-AAAA'; })],
    ['an additional production owner', mutatedGraph((g) => { g.lockPackages['packages/usage-event'] = { ...g.lockPackages['packages/usage-event'], dependencies: { '@aoc/protocol': 'file:../../vendor/aoc-protocol-0.2.0-rc.3.tgz' } }; })],
    ['another workspace declares a Protocol peer', mutatedGraph((g) => { g.lockPackages['packages/usage-event'] = { ...g.lockPackages['packages/usage-event'], peerDependencies: { '@aoc/protocol': '>=0.2.0-rc.0' } }; })],
    ['the closure no longer owns Protocol', mutatedGraph((g) => { delete (g.lockPackages[closure]!['dependencies'] as Record<string, string>)['@aoc/protocol']; })],
    ['a nested duplicate Protocol', mutatedGraph((g) => { g.lockPackages['node_modules/@aoc-runtime/crypto/node_modules/@aoc/protocol'] = { ...g.lockPackages['node_modules/@aoc/protocol'] }; })],
    ['Protocol classified dev-only despite a production owner', mutatedGraph((g) => { g.lockPackages['node_modules/@aoc/protocol']!['dev'] = true; })],
    ['root moves Protocol into production dependencies', mutatedGraph((g) => { g.rootManifest['dependencies'] = { ...(g.rootManifest['dependencies'] as Record<string, string>), '@aoc/protocol': 'file:./vendor/aoc-protocol-0.2.0-rc.3.tgz' }; })],
    ['root bundles Protocol', mutatedGraph((g) => { g.rootManifest['bundleDependencies'] = [...(g.rootManifest['bundleDependencies'] as string[]), '@aoc/protocol']; })],
    ['root drops the external peer', mutatedGraph((g) => { delete (g.rootManifest['peerDependencies'] as Record<string, string>)['@aoc/protocol']; })],
  ];
  for (const [name, graph] of cases) assert.notDeepEqual(protocolGraphErrors(graph), [], name);
});

test('negative controls: the receiver manifest, import and surface checks refuse each violation', () => {
  const manifest = readJson(join(packageRoot, 'package.json'));
  assert.notDeepEqual(receiverManifestErrors({ ...manifest, dependencies: { '@aoc/protocol': 'file:../../vendor/aoc-protocol-0.2.0-rc.3.tgz' } }, undefined), [], 'direct Protocol dependency');
  assert.notDeepEqual(receiverManifestErrors({ ...manifest, private: false }, undefined), [], 'publishable package');
  assert.notDeepEqual(receiverManifestErrors({ ...manifest, publishConfig: { access: 'public' } }, undefined), [], 'publishConfig');
  assert.notDeepEqual(receiverManifestErrors(manifest, { peerDependencies: { '@aoc/protocol': '>=0.2.0-rc.0' } }), [], 'lockfile peer');
  // Assembled at run time so this file itself holds no forbidden specifier for the repository's import gates.
  const forbiddenSubpath = ['@aoc/protocol', 'canonical'].join('/');
  assert.notDeepEqual(sourceViolations('x.ts', `import { canonicalize } from '${forbiddenSubpath}';`), [], 'forbidden subpath');
  assert.notDeepEqual(sourceViolations('x.ts', "import { x } from '@aoc/protocol';"), [], 'Protocol root import');
  const protocolValues = approvedProtocolValues();
  const [protocolValue] = [...protocolValues];
  const sdk = require('../src/index.js') as Record<string, unknown>;
  assert.deepEqual(reexportedProtocolValues({ ...sdk, leaked: protocolValue }, protocolValues), ['leaked'], 'Protocol value re-exported');
});
