import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALLOWED_PROTOCOL_SUBPATHS,
  containsProtocolSiblingPath,
  declaresProtocolModule,
  extractProtocolImportSpecifiers,
  isAllowedProtocolImportSpecifier,
  isPackageScopedProtocolImport,
} from './protocol/lib-protocol-artifact.mjs';

const ROOT = process.cwd();
const scanRoots = ['src', 'packages', 'types', 'tests', 'scripts'];

const protectedSymbols = [
  'CapabilityToken',
  'ConsentGrant',
  'CapabilityGrant',
  'Delegation',
  'PolicyDecision',
  'AgentScope',
  'AuditEventEnvelope',
  'ScopedAccessRequest',
  'TrustDomainIdentifier',
];

// Files allowed to declare/re-export `@aoc/protocol` module contents outside of a
// real npm-resolved install. Every entry here is a *documented, non-canonical*
// exception -- canonical compatibility is proven only by
// scripts/protocol/validate-enterprise-against-protocol-tarball.mjs against the
// real tarball recorded in protocol-consumer.lock.json.
//
// As of the Protocol Contract Adoption sprint, Enterprise resolves
// `@aoc/protocol` exclusively through the real, vendored, checksummed
// tarball (see vendor/README.md, protocol-consumer.lock.json) -- there is no
// longer any ambient shim in the main tree or in the external-consumer
// fixture. The one remaining allowlisted stand-in
// (tests/fixtures/protocol-stub/index.d.ts) exists purely as a defensive
// fallback for scripts/validate-publishability.mjs when neither the vendored
// tarball nor a sibling checkout can be found on disk; it is never the
// canonical compatibility signal.
const allowFiles = new Set([
  'scripts/check-protocol-consumption.mjs',
  // Release-tooling stand-in used by validate-publishability.mjs only when
  // neither the vendored @aoc/protocol tarball nor a sibling checkout is
  // present; never shipped, never imported by runtime code (the
  // publishability check enforces both).
  'tests/fixtures/protocol-stub/index.d.ts',
  // Negative-test fixtures: these contain the forbidden patterns above as
  // string *data* passed to unit-tested detector functions
  // (extractProtocolImportSpecifiers/containsProtocolSiblingPath/
  // declaresProtocolModule in scripts/protocol/lib-protocol-artifact.mjs),
  // not as real imports or declarations. See tests/protocol-tarball-lock.test.mjs.
  'tests/protocol-tarball-lock.test.mjs',
]);

const violations = [];

// scripts/protocol/** is the tarball build/validation tooling itself: it
// legitimately contains the literal sibling-path string and `declare module
// '@aoc/protocol'` snippets it exists to detect/generate (in a throwaway
// temp copy, never the tracked tree), which would otherwise self-trigger the
// checks below. It is exempt from source scanning the same way this file
// exempts itself.
const EXCLUDED_DIR_NAMES = new Set(['dist', 'dist-test', 'node_modules']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (full === join(ROOT, 'scripts', 'protocol')) continue;
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|d\.ts|mts|cts|mjs|cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function walkAll(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkAll(full)));
    else out.push(full);
  }
  return out;
}

function relPath(file) {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/');
}

// --- 1. Peer dependency declared with an explicit, compatible range ---------
const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const peerSpec = packageJson.peerDependencies?.['@aoc/protocol'];
if (!peerSpec) {
  violations.push('package.json: @aoc/protocol must be declared under peerDependencies.');
} else if (peerSpec.startsWith('file:') || peerSpec === '*' || peerSpec.trim().length === 0) {
  violations.push(`package.json: peerDependencies["@aoc/protocol"] = "${peerSpec}" is not an explicit compatible semver range.`);
} else if (!/^[~^]?\d+\.\d+\.\d+|^>=\s*\d+\.\d+\.\d+/.test(peerSpec)) {
  violations.push(`package.json: peerDependencies["@aoc/protocol"] = "${peerSpec}" does not look like an explicit semver range.`);
}

// --- 2. Production "dependencies" must never pin @aoc/protocol to file: -----
const prodSpec = packageJson.dependencies?.['@aoc/protocol'];
if (prodSpec?.startsWith('file:')) {
  violations.push(`package.json: dependencies["@aoc/protocol"] must not resolve via file: (found "${prodSpec}"); @aoc/protocol belongs under peerDependencies (and, for local dev convenience only, devDependencies).`);
}

// --- 3. Scan source for import specifiers, redefinitions, and sibling paths -
const defs = [];
for (const root of scanRoots) {
  const abs = join(ROOT, root);
  let files = [];
  try {
    files = await walk(abs);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relPath(file);
    if (allowFiles.has(rel)) continue;
    const text = await readFile(file, 'utf8');

    if (containsProtocolSiblingPath(text)) {
      violations.push(`${rel}: references the Soberanía Protocol sibling-repository path directly; imports must resolve through the '@aoc/protocol' package only.`);
    }

    for (const specifier of extractProtocolImportSpecifiers(text)) {
      // A package-scoped allowance admits its subpaths only inside its own package directory.
      if (!isAllowedProtocolImportSpecifier(specifier) && !isPackageScopedProtocolImport(specifier, rel)) {
        violations.push(`${rel}: imports forbidden/undeclared subpath '${specifier}'. Allowed: ${ALLOWED_PROTOCOL_SUBPATHS.join(', ')}.`);
      }
    }

    if (declaresProtocolModule(text)) {
      violations.push(`${rel}: declares/augments the '@aoc/protocol' module outside the documented allowlist in scripts/check-protocol-consumption.mjs.`);
    }

    for (const symbol of protectedSymbols) {
      const definitionPattern = new RegExp(`\\b(?:interface|type|class|enum)\\s+${symbol}\\b`);
      if (definitionPattern.test(text)) {
        defs.push(`${rel}: redefines ${symbol}`);
      }
    }
  }
}
violations.push(...defs);

// --- 3b. No package manifest resolves @aoc/protocol from a source tree -----
// containsProtocolSiblingPath() only matches a quote immediately followed by
// '../', which is the shape a TypeScript/JS *import* takes. A package.json
// dependency spec looks like "file:../Architects_of_Change_Protocol/..." --
// the quote is followed by 'file:', so the source-scan regex above never saw
// it. Manifests therefore get their own, explicit check: no dependency of any
// kind may resolve @aoc/protocol (or anything else) out of a Protocol source
// checkout. The canonical form is the vendored, checksummed tarball recorded
// in protocol-consumer.lock.json.
const manifestPaths = [join(ROOT, 'package.json')];
for (const root of scanRoots) {
  let files = [];
  try {
    files = await walkAll(join(ROOT, root));
  } catch {
    continue;
  }
  manifestPaths.push(...files.filter((file) => file.endsWith('package.json')));
}
for (const manifestPath of manifestPaths) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  const rel = relPath(manifestPath);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string') continue;
      if (spec.includes('Architects_of_Change_Protocol') || spec.includes('Soberania_Protocol')) {
        violations.push(`${rel}: ${field}["${name}"] = "${spec}" resolves out of a Soberanía Protocol source checkout; use the vendored, checksummed tarball pinned by protocol-consumer.lock.json.`);
      }
    }
  }
}

// --- 4. No shipped dist artifact leaks a local/sibling filesystem path ------
const distDir = join(ROOT, 'dist');
if (existsSync(distDir)) {
  const distFiles = await walk(distDir);
  for (const file of distFiles) {
    if (!/\.(js|cjs|mjs|d\.ts)$/.test(file)) continue;
    const rel = relPath(file);
    const text = await readFile(file, 'utf8');
    if (text.includes('Architects_of_Change_Protocol') || /\/(home|workspace|tmp)\//.test(text)) {
      violations.push(`${rel}: shipped artifact leaks a local/sibling filesystem path.`);
    }
    if (file.endsWith('.d.ts') && /from\s+['"]@aoc\/protocol\/(?!$)/.test(text)) {
      violations.push(`${rel}: shipped declaration file contains a deep '@aoc/protocol' import.`);
    }
  }
}

if (violations.length > 0) {
  console.error('Protocol consumption check failed:');
  for (const violation of violations) console.error(` - ${violation}`);
  process.exit(1);
}

console.log('Protocol consumption check passed.');
