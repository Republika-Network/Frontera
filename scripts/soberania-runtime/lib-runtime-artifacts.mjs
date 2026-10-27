// Shared helpers for the vendored Soberanía runtime artifacts (FRONTERA-SOBE-PILOT-01A).
// Pure checks plus thin wrappers around `tar`; used by check-runtime-lock.mjs and by
// tests/soberania-runtime-consumption.test.mjs. The approved and excluded package sets are
// fixed here, not read from the lock, so a lock edit cannot widen them.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS } from '../protocol/lib-protocol-artifact.mjs';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;

/** Every package Frontera may vendor from the Soberanía runtime, with its role. */
export const APPROVED_RUNTIME_PACKAGES = Object.freeze({
  '@aoc-runtime/authorization-runtime': 'runtime',
  '@aoc-runtime/governance-runtime': 'runtime',
  '@aoc-runtime/capability-runtime': 'runtime',
  '@aoc-runtime/consent-runtime': 'runtime',
  '@aoc-runtime/crypto': 'runtime',
  '@aoc-runtime/provider-interfaces': 'declarations',
  '@aoc-runtime/shared-types': 'declarations',
});

/** Packages that must never be vendored, listed, installed or loaded. */
export const EXCLUDED_RUNTIME_PACKAGES = Object.freeze([
  'aoc-runtime',
  '@aoc-runtime/trust-registry-runtime',
  '@aoc-runtime/audit-runtime',
  '@aoc/enterprise',
  '@aoc-runtime/portable-cognition',
  '@aoc-runtime/vault-runtime',
  '@aoc-runtime/pmfreak-adapter',
]);

/** The only modules outside its own package an approved artifact may require at runtime. */
export const ALLOWED_RUNTIME_REQUIRES = Object.freeze([
  ...Object.entries(APPROVED_RUNTIME_PACKAGES).filter(([, role]) => role === 'runtime').map(([name]) => name),
  ...INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS,
  'node:crypto',
]);

export const RUNTIME_VENDOR_DIR = 'vendor/soberania-runtime';

/** Errors (empty when none) for the shape and policy of soberania-runtime-consumer.lock.json. */
export function validateRuntimeLock(lock) {
  const errors = [];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return ['Runtime lock must be a JSON object.'];
  if (lock.contract !== 'frontera.soberania-runtime-consumption') errors.push(`"contract" must be "frontera.soberania-runtime-consumption".`);
  if (lock.sourceRepository !== 'Republika-Network/Soberania_Protocol') errors.push(`"sourceRepository" must be "Republika-Network/Soberania_Protocol".`);
  if (!FULL_SHA_RE.test(lock.sourceCommit ?? '')) errors.push('"sourceCommit" must be a full 40-character commit SHA.');
  if (!FULL_SHA_RE.test(lock.sourceTree ?? '')) errors.push('"sourceTree" must be a full 40-character tree SHA.');
  if (lock.packaging?.sourceModified !== false) errors.push('"packaging.sourceModified" must be false.');
  if (lock.packaging?.registryPublication !== 'none') errors.push('"packaging.registryPublication" must be "none".');

  const expectedAllowed = [...ALLOWED_RUNTIME_REQUIRES].sort();
  if (JSON.stringify([...(lock.allowedRuntimeRequires ?? [])].sort()) !== JSON.stringify(expectedAllowed)) {
    errors.push(`"allowedRuntimeRequires" must be exactly ${expectedAllowed.join(', ')}.`);
  }

  const protocol = lock.protocolDependency ?? {};
  if (protocol.lock !== 'protocol-consumer.lock.json' || protocol.package !== '@aoc/protocol') {
    errors.push('"protocolDependency" must reference protocol-consumer.lock.json and @aoc/protocol.');
  }
  if (!INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS.includes(protocol.internalDependencySubpath)) {
    errors.push('"protocolDependency.internalDependencySubpath" must be an approved internal-dependency subpath.');
  }

  if (!Array.isArray(lock.packages)) return [...errors, '"packages" must be an array.'];
  const names = lock.packages.map((entry) => entry?.name);
  const approved = Object.keys(APPROVED_RUNTIME_PACKAGES);
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...approved].sort())) {
    errors.push(`"packages" must list exactly the approved packages: ${approved.join(', ')}.`);
  }
  for (const entry of lock.packages) {
    const name = entry?.name;
    if (EXCLUDED_RUNTIME_PACKAGES.includes(name)) errors.push(`${name} is excluded and must not be listed.`);
    if (APPROVED_RUNTIME_PACKAGES[name] !== undefined && entry.role !== APPROVED_RUNTIME_PACKAGES[name]) {
      errors.push(`${name} must have role "${APPROVED_RUNTIME_PACKAGES[name]}".`);
    }
    const tarball = entry?.tarball ?? {};
    if (typeof tarball.filename !== 'string' || tarball.vendoredAt !== `${RUNTIME_VENDOR_DIR}/${tarball.filename}`) {
      errors.push(`${name}: "tarball.vendoredAt" must be ${RUNTIME_VENDOR_DIR}/<tarball.filename>.`);
    }
    if (!HEX64_RE.test(tarball.sha256 ?? '')) errors.push(`${name}: "tarball.sha256" must be 64 hex characters.`);
    if (!HEX128_RE.test(tarball.sha512 ?? '')) errors.push(`${name}: "tarball.sha512" must be 128 hex characters.`);
    if (typeof tarball.integrity !== 'string' || !tarball.integrity.startsWith('sha512-')) errors.push(`${name}: "tarball.integrity" must be an npm sha512 integrity.`);
    if (!Number.isInteger(tarball.sizeBytes) || !Number.isInteger(tarball.fileCount)) errors.push(`${name}: size and file count must be integers.`);
    if (!Array.isArray(entry?.files) || entry.files.length !== tarball.fileCount) errors.push(`${name}: "files" must list exactly tarball.fileCount entries.`);
    for (const required of entry?.runtimeRequires ?? []) {
      if (!ALLOWED_RUNTIME_REQUIRES.includes(required) || required === name) errors.push(`${name}: runtime require "${required}" is outside the approved closure.`);
    }
    if (entry?.role === 'declarations' && (entry.runtimeRequires ?? []).length > 0) errors.push(`${name}: a declarations package must require nothing at runtime.`);
  }
  const canonicalUsers = lock.packages.filter((entry) => (entry?.runtimeRequires ?? []).includes(protocol.internalDependencySubpath)).map((entry) => entry.name);
  if (JSON.stringify(canonicalUsers) !== JSON.stringify(protocol.requiredBy ?? [])) {
    errors.push('"protocolDependency.requiredBy" must name exactly the packages that require the internal Protocol subpath.');
  }
  return errors;
}

/** Errors (empty when none) for one tarball file against its lock entry. A missing file is an error. */
export function tarballIdentityErrors(path, entry) {
  if (!existsSync(path)) return [`${path} does not exist`];
  const tarball = entry.tarball;
  const bytes = readFileSync(path);
  const sha512 = createHash('sha512').update(bytes).digest();
  const errors = [];
  if (basename(path) !== tarball.filename) errors.push(`file name ${basename(path)} is not ${tarball.filename}`);
  if (bytes.length !== tarball.sizeBytes) errors.push(`size ${bytes.length} is not ${tarball.sizeBytes}`);
  if (createHash('sha256').update(bytes).digest('hex') !== tarball.sha256) errors.push('sha256 differs');
  if (sha512.toString('hex') !== tarball.sha512) errors.push('sha512 differs');
  if (`sha512-${sha512.toString('base64')}` !== tarball.integrity) errors.push('npm integrity differs');
  if (errors.length > 0) return errors;
  const listed = tarFileList(path);
  if (JSON.stringify(listed) !== JSON.stringify([...entry.files].sort())) errors.push('file inventory differs from the lock');
  return errors;
}

/** Sorted file paths inside an npm tarball, without the leading `package/`. */
export function tarFileList(path) {
  const result = spawnSync('tar', ['-tzf', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -tzf ${path} failed: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line && !line.endsWith('/')).map((line) => line.replace(/^package\//, '')).sort();
}

/** Extracts an npm tarball as node_modules/<name>, the way npm installs a package with no dependencies. */
export function extractTarballAsModule(path, nodeModulesDir, name) {
  const target = join(nodeModulesDir, ...name.split('/'));
  mkdirSync(target, { recursive: true });
  const result = spawnSync('tar', ['-xzf', path, '-C', target, '--strip-components=1'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -xzf ${path} failed: ${result.stderr}`);
  return target;
}

const RUNTIME_SPECIFIER_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]((?:@aoc-runtime\/|@aoc\/enterprise|aoc-runtime(?:\/|['"]))[^'"]*)/g;

/**
 * Soberanía runtime specifiers imported or required by a Frontera source text. No Frontera source
 * consumes the runtime in FRONTERA-SOBE-PILOT-01A, so any match is a violation.
 */
export function findRuntimeImports(text) {
  return [...text.matchAll(RUNTIME_SPECIFIER_RE)].map((match) => match[1].replace(/['"]$/, ''));
}
