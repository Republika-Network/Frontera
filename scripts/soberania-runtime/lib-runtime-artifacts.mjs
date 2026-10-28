// Shared helpers for the vendored Soberanía runtime artifacts (FRONTERA-SOBE-PILOT-01A).
// Pure checks plus thin wrappers around `tar`; used by check-runtime-lock.mjs and by
// tests/soberania-runtime-consumption.test.mjs. The approved and excluded package sets are
// fixed here, not read from the lock, so a lock edit cannot widen them.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

/**
 * The one workspace that installs the approved closure (FRONTERA-SOBE-PILOT-01C0). It holds no code;
 * its production dependencies put the closure, and the @aoc/protocol candidate crypto requires, into
 * the lockfile as non-dev, so the Host's `npm ci --omit=dev` installs them. The published
 * @aoc-enterprise/runtime artifact neither depends on nor carries it, and no other manifest may
 * declare a Soberanía runtime package.
 */
export const CLOSURE_WORKSPACE_DIR = 'packages/soberania-runtime-closure';
export const CLOSURE_WORKSPACE_NAME = '@aoc-enterprise/soberania-runtime-closure';

const isRuntimePackageName = (name) => name.startsWith('@aoc-runtime/') || EXCLUDED_RUNTIME_PACKAGES.includes(name);

/** The absolute path a `file:` specifier declared in the manifest at `manifestDir` points at, or undefined. */
function fileSpecTarget(spec, manifestDir) {
  return typeof spec === 'string' && spec.startsWith('file:') ? resolve(manifestDir, spec.slice('file:'.length)) : undefined;
}

/**
 * Errors (empty when none) for the closure workspace's package.json. It must declare exactly the seven
 * locked tarballs and @aoc/protocol, and its @aoc/protocol must be the very artifact the root pins
 * (`devDependencies["@aoc/protocol"]`, itself verified against protocol-consumer.lock.json), so the
 * runtime closure and Frontera always resolve one Protocol package.
 */
export function closureManifestErrors(pkg, lock, rootPkg, rootDir) {
  const errors = [];
  if (pkg?.name !== CLOSURE_WORKSPACE_NAME) errors.push(`closure workspace must be named ${CLOSURE_WORKSPACE_NAME}.`);
  if (pkg?.private !== true) errors.push('closure workspace must be private.');
  for (const field of ['main', 'types', 'exports', 'bin', 'scripts', 'bundleDependencies', 'bundledDependencies']) {
    if (pkg?.[field] !== undefined) errors.push(`closure workspace must not declare "${field}": it holds no code.`);
  }
  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (Object.keys(pkg?.[field] ?? {}).length > 0) errors.push(`closure workspace must not declare "${field}".`);
  }
  const declared = pkg?.dependencies ?? {};
  const pinned = new Map((lock.packages ?? []).map((entry) => [entry.name, `file:../../${entry.tarball.vendoredAt}`]));
  for (const [name, spec] of pinned) {
    if (declared[name] !== spec) errors.push(`closure workspace must depend on ${name} as "${spec}" (found ${JSON.stringify(declared[name])}).`);
  }
  const closureDir = resolve(rootDir, CLOSURE_WORKSPACE_DIR);
  const protocolTarget = fileSpecTarget(declared['@aoc/protocol'], closureDir);
  const rootProtocolTarget = fileSpecTarget(rootPkg?.devDependencies?.['@aoc/protocol'], rootDir);
  if (protocolTarget === undefined || rootProtocolTarget === undefined || protocolTarget !== rootProtocolTarget) {
    errors.push('closure workspace must depend on @aoc/protocol through a file: specifier naming the same artifact as the root devDependency.');
  }
  for (const name of Object.keys(declared)) {
    if (!pinned.has(name) && name !== '@aoc/protocol') errors.push(`closure workspace declares ${name}, which is outside the approved closure.`);
  }
  return errors;
}

/** Errors (empty when none) for any manifest other than the closure workspace's: it may declare no Soberanía runtime package. */
export function foreignManifestErrors(pkg, label) {
  const errors = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const names = Array.isArray(pkg?.[field]) ? pkg[field] : Object.keys(pkg?.[field] ?? {});
    for (const name of names) if (isRuntimePackageName(name)) errors.push(`${label} ${field}: ${name} may be declared only by ${CLOSURE_WORKSPACE_DIR}.`);
  }
  return errors;
}

/**
 * Errors (empty when none) for the installed graph package-lock.json records: exactly the seven approved
 * packages, each installed once at the top level from its vendored tarball with the locked integrity and
 * as a production (non-dev) package; @aoc/protocol installed as production too; nothing excluded anywhere.
 */
export function installedGraphErrors(packageLock, lock) {
  const errors = [];
  const byName = new Map((lock.packages ?? []).map((entry) => [entry.name, entry]));
  const seen = new Set();
  for (const [key, entry] of Object.entries(packageLock?.packages ?? {})) {
    const at = key.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const name = key.slice(at + 'node_modules/'.length);
    if (EXCLUDED_RUNTIME_PACKAGES.includes(name)) errors.push(`${key}: excluded package ${name} is installed.`);
    if (!name.startsWith('@aoc-runtime/')) continue;
    const pinned = byName.get(name);
    if (pinned === undefined) {
      errors.push(`${key}: ${name} is not an approved package.`);
      continue;
    }
    if (key !== `node_modules/${name}`) errors.push(`${key}: ${name} must be installed once, at the top level.`);
    seen.add(name);
    if (entry.resolved !== `file:${pinned.tarball.vendoredAt}`) errors.push(`${key}: resolved ${entry.resolved}, expected file:${pinned.tarball.vendoredAt}.`);
    if (entry.integrity !== pinned.tarball.integrity) errors.push(`${key}: integrity differs from the runtime lock.`);
    if (entry.version !== pinned.version) errors.push(`${key}: version ${entry.version}, expected ${pinned.version}.`);
    if (entry.dev === true || entry.devOptional === true || entry.optional === true) errors.push(`${key}: must be a production dependency.`);
    if (entry.link === true) errors.push(`${key}: must be installed from its tarball, not linked.`);
  }
  for (const name of byName.keys()) if (!seen.has(name)) errors.push(`${name} is not installed.`);
  const protocol = packageLock?.packages?.['node_modules/@aoc/protocol'];
  if (protocol === undefined) errors.push('@aoc/protocol is not installed.');
  else if (protocol.dev === true || protocol.devOptional === true) errors.push('@aoc/protocol must be a production dependency: @aoc-runtime/crypto requires it at run time.');
  return errors;
}

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
