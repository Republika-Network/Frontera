#!/usr/bin/env node
// Validates Soberanía Enterprise against a real, packed @aoc/protocol tarball in an
// isolated temporary copy of the repository. This is the canonical proof that
// Enterprise does not require the `@aoc/protocol` sibling-path checkout: the
// temporary copy installs the tarball, resolves every documented-gap symbol
// through a narrow, non-shipped compatibility augmentation (see "Known gaps"
// in docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md), and runs the full
// validation battery against that isolated install.
//
// Usage:
//   node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs <path-to-tarball>
//   AOC_PROTOCOL_TARBALL=<path-to-tarball> node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs
//
// Never modifies the real repository's package.json or package-lock.json --
// all mutation happens inside a throwaway temporary copy that is deleted on exit.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPackageScopedProtocolImport } from './lib-protocol-artifact.mjs';

const REPO_ROOT = resolve(process.cwd());

// Symbols Enterprise imports from `@aoc/protocol` that are NOT exported by any
// public subpath of the real package as of the pinned commit. Each entry here
// must have a corresponding row in docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md
// ("Known gaps"). This augmentation is injected only inside the throwaway temp
// copy created by this script -- it is never written to the tracked repository.
//
// As of the Protocol Contract Adoption sprint, there are no known gaps:
// AocIdentityClaims was replaced everywhere by the Enterprise-owned
// VerifiedActorClaims (@aoc-enterprise/identity), ScopedAccessRequest usages
// were migrated to the real `requestedScope` field (with `action` moved to
// the Enterprise-owned EnterpriseScopedAccessRequest extension), and
// AuditEventEnvelope is now produced only via an explicit mapper from the
// legacy ControlPlaneAuditEvent -- every `@aoc/protocol` symbol Enterprise
// imports now resolves against the real installed package with no
// augmentation. Keep this object (rather than deleting the mechanism) so a
// future, real, evidenced gap has an established place to be recorded.
const KNOWN_EXPORT_GAPS = {};

const EXCLUDED_TOP_LEVEL = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'build',
  'coverage',
  '.next',
  'turbo',
  '.data',
  'backups',
  '.claude',
]);

function log(message) {
  process.stderr.write(`[tarball-validate] ${message}\n`);
}

function run(cmd, args, cwd, { allowFailure = true } = {}) {
  log(`$ ${cmd} ${args.join(' ')} (cwd=${cwd})`);
  // node's spawnSync default maxBuffer is 1 MiB; the full validation battery
  // (in particular `npm run test`, which runs the entire root + workspace
  // test suites with verbose TAP output) can legitimately exceed that,
  // which kills the child with ENOBUFS/SIGTERM (status: null) -- a tooling
  // limitation, not a real command failure. 64 MiB comfortably covers this.
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}\n${combined}`);
  }
  return { ok, status: result.status, output: combined };
}

async function copyRepoExcluding(sourceDir, destDir) {
  await cp(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(sourceDir.length + 1);
      if (rel === '') return true;
      const topLevel = rel.split('/')[0];
      if (EXCLUDED_TOP_LEVEL.has(topLevel)) return false;
      // Protocol tarballs stay out so the copy can only install the tarball under validation. The
      // pinned Soberanía runtime artifacts are not Protocol artifacts: tests in the battery verify
      // them against soberania-runtime-consumer.lock.json, so they are copied.
      if (rel.endsWith('.tgz') && !rel.startsWith('vendor/soberania-runtime/')) return false;
      if (rel.endsWith('.tsbuildinfo')) return false;
      return true;
    },
  });
}

// Every quoted `@aoc/protocol/...` string, with its opening and (if any)
// closing quote. A deep specifier is admitted only when it is exactly one of a
// package-scoped allowance's subpaths, properly quoted, inside that package
// (see isPackageScopedProtocolImport); anything else is a violation.
const DEEP_PROTOCOL_SPECIFIER_RE = /(['"`])(@aoc\/protocol\/[^'"`\s]*)(['"`]?)/g;

function forbiddenDeepProtocolSpecifiers(text, relPath) {
  const forbidden = [];
  for (const [, open, specifier, close] of text.matchAll(DEEP_PROTOCOL_SPECIFIER_RE)) {
    const admitted = open !== '`' && close === open && isPackageScopedProtocolImport(specifier, relPath);
    if (!admitted) forbidden.push(specifier);
  }
  return forbidden;
}

export async function forbiddenImportScan(tempDir) {
  const violations = [];
  const forbiddenPatterns = [
    { name: 'protocol source import', re: /['"](?:\.\.\/)+Architects_of_Change_Protocol\b/ },
    { name: 'protocol dist deep import', re: /['"]@aoc\/protocol\/dist\// },
  ];
  const roots = ['src', 'packages', 'tests', 'scripts', 'types'].map((r) => join(tempDir, r));
  // scripts/protocol is this validator's own tooling: it legitimately contains
  // the literal sibling-path string it exists to detect (see siblingPathScan),
  // so it is excluded here the same way check-protocol-consumption.mjs
  // allowlists itself.
  const excludedDirs = new Set([join(tempDir, 'scripts', 'protocol')]);
  // Negative-test fixtures contain these forbidden patterns as string *data*
  // passed to unit-tested detector functions, not as real imports -- same
  // allowlist rationale as scripts/check-protocol-consumption.mjs.
  //
  // scripts/release/check-clean-room-consumer.mjs is the same class: it carries
  // '@aoc/protocol/src/index' and '@aoc/protocol/dist/contracts/index.js' in a
  // list of specifiers it asserts must FAIL to resolve from a clean external
  // install. They are assertions that deep imports stay unavailable, not imports.
  //
  // tests/protocol-package-scoped-consumption.test.mjs is the same class: it
  // feeds approved and forbidden deep specifiers to all three gates as data.
  const excludedFiles = new Set([
    join(tempDir, 'tests', 'protocol-tarball-lock.test.mjs'),
    join(tempDir, 'tests', 'protocol-package-scoped-consumption.test.mjs'),
    join(tempDir, 'scripts', 'release', 'check-clean-room-consumer.mjs'),
  ]);

  async function walk(dir) {
    if (excludedDirs.has(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (excludedFiles.has(full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        const relPath = full.slice(tempDir.length + 1);
        if (forbiddenDeepProtocolSpecifiers(text, relPath).length > 0) violations.push(`${relPath}: forbidden deep protocol import`);
        for (const { name, re } of forbiddenPatterns) {
          if (re.test(text)) violations.push(`${relPath}: forbidden ${name}`);
        }
      }
    }
  }

  for (const root of roots) await walk(root);
  return violations;
}

export async function siblingPathScan(tempDir) {
  const violations = [];
  const lockPath = join(tempDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lockText = await readFile(lockPath, 'utf8');
    if (lockText.includes('../Architects_of_Change_Protocol')) {
      violations.push('package-lock.json: still references the ../Architects_of_Change_Protocol sibling path after tarball install.');
    }
  }
  const protocolNodeModulesPath = join(tempDir, 'node_modules', '@aoc', 'protocol');
  if (existsSync(protocolNodeModulesPath)) {
    const { lstatSync, realpathSync } = await import('node:fs');
    const stat = lstatSync(protocolNodeModulesPath);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(protocolNodeModulesPath);
      violations.push(`node_modules/@aoc/protocol is a symlink to ${target} (expected a real extracted tarball install, not a sibling-path link).`);
    }
  } else {
    violations.push('node_modules/@aoc/protocol was not installed at all.');
  }
  return violations;
}

async function resolveProtocolExports(tempDir, installedProtocolPkg) {
  const specifiers = Object.keys(installedProtocolPkg.exports ?? {})
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? '@aoc/protocol' : `@aoc/protocol/${key.slice(2)}`));
  const scriptPath = join(tempDir, '__resolve-protocol-exports.mjs');
  await writeFile(scriptPath, specifiers.map((s) => `import.meta.resolve(${JSON.stringify(s)});`).join('\n'));
  const result = run('node', ['__resolve-protocol-exports.mjs'], tempDir);
  await rm(scriptPath, { force: true }).catch(() => {});
  return { specifiers, ok: result.ok, notes: result.ok ? specifiers.join(', ') : result.output.slice(-2000) };
}

export async function declarationLeakScan(tempDir) {
  const distDir = join(tempDir, 'dist');
  if (!existsSync(distDir)) return [];
  const violations = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.d.ts')) {
        const text = await readFile(full, 'utf8');
        if (text.includes(tempDir) || /\/tmp\//.test(text) || text.includes('Architects_of_Change_Protocol')) {
          violations.push(`${full.slice(tempDir.length + 1)}: leaks a local/temporary filesystem path into a shipped declaration file.`);
        }
      }
    }
  }
  await walk(distDir);
  return violations;
}

async function main() {
  const tarballArg = process.argv[2] ?? process.env.AOC_PROTOCOL_TARBALL;
  if (!tarballArg) {
    throw new Error('Usage: node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs <path-to-tarball> (or set AOC_PROTOCOL_TARBALL)');
  }
  const tarballPath = resolve(tarballArg);
  if (!existsSync(tarballPath)) {
    throw new Error(`Tarball not found at "${tarballPath}". Build it first with scripts/protocol/build-protocol-tarball.mjs.`);
  }
  if (!tarballPath.endsWith('.tgz')) {
    throw new Error(`"${tarballPath}" does not look like an npm tarball (expected a .tgz file).`);
  }

  const tarballBuffer = await readFile(tarballPath);
  const tarballSha256 = createHash('sha256').update(tarballBuffer).digest('hex');
  log(`Validating against tarball ${tarballPath} (sha256=${tarballSha256}, ${tarballBuffer.length} bytes).`);

  const tempDir = await mkdtemp(join(tmpdir(), 'aoc-enterprise-tarball-validate-'));
  const stepResults = [];
  let exitCode = 0;
  let verifiedPublicExports = [];

  try {
    log(`Copying Enterprise repository into isolated temp copy: ${tempDir}`);
    await copyRepoExcluding(REPO_ROOT, tempDir);

    // --- Swap the @aoc/protocol resolution from the dev sibling path to the tarball ---
    const pkgJsonPath = join(tempDir, 'package.json');
    const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
    if (!pkgJson.devDependencies?.['@aoc/protocol']) {
      throw new Error('Root package.json does not declare a devDependency on @aoc/protocol; nothing to swap.');
    }
    pkgJson.devDependencies['@aoc/protocol'] = `file:${tarballPath}`;
    await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    // The Soberanía runtime closure workspace declares @aoc/protocol as a production dependency
    // (@aoc-runtime/crypto requires it at run time) through the same artifact as the root. It is
    // swapped to the tarball under validation too, so the copy resolves exactly one Protocol package.
    const closurePkgPath = join(tempDir, 'packages', 'soberania-runtime-closure', 'package.json');
    if (existsSync(closurePkgPath)) {
      const closurePkg = JSON.parse(await readFile(closurePkgPath, 'utf8'));
      if (!closurePkg.dependencies?.['@aoc/protocol']) {
        throw new Error('The Soberanía runtime closure workspace does not declare @aoc/protocol; nothing to swap.');
      }
      closurePkg.dependencies['@aoc/protocol'] = `file:${tarballPath}`;
      await writeFile(closurePkgPath, `${JSON.stringify(closurePkg, null, 2)}\n`);
    }
    await rm(join(tempDir, 'package-lock.json'), { force: true });
    log('Rewrote isolated copy\'s @aoc/protocol dependencies (root devDependency, runtime closure workspace) to point at the tarball and removed its lockfile so npm resolves fresh.');

    // --- Narrow the local ambient shim to only the documented, ungated export gap ---
    const tsconfigBasePath = join(tempDir, 'tsconfig.base.json');
    const tsconfigBase = JSON.parse(await readFile(tsconfigBasePath, 'utf8'));
    delete tsconfigBase.compilerOptions.paths?.['@aoc/protocol'];
    await writeFile(tsconfigBasePath, `${JSON.stringify(tsconfigBase, null, 2)}\n`);

    if (Object.keys(KNOWN_EXPORT_GAPS).length === 0) {
      log('No known export gaps recorded -- every @aoc/protocol symbol resolves from the installed tarball with no ambient augmentation.');
    } else {
      const gapAugmentationLines = Object.entries(KNOWN_EXPORT_GAPS)
        .map(([symbol, type]) => `  export type ${symbol} = ${type};`)
        .join('\n');
      const shimPath = join(tempDir, 'types', 'aoc-protocol', 'index.d.ts');
      await writeFile(
        shimPath,
        `/**\n * TEMPORARY compatibility augmentation, generated only inside the isolated\n` +
          ` * tarball-validation copy by scripts/protocol/validate-enterprise-against-protocol-tarball.mjs.\n` +
          ` * It exists only for symbols documented as export gaps in\n` +
          ` * docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md (\"Known gaps\") --\n` +
          ` * every other symbol below resolves against the real installed tarball.\n` +
          ` * Never present in the tracked repository or in any shipped artifact.\n *\n` +
          ` * The self-import below is required for TypeScript to treat this as a\n` +
          ` * module *augmentation* of the real installed '@aoc/protocol' package\n` +
          ` * rather than a from-scratch ambient module declaration that would\n` +
          ` * shadow/replace its real exports.\n */\n` +
          `import '@aoc/protocol';\n\n` +
          `declare module '@aoc/protocol' {\n${gapAugmentationLines}\n}\n`,
      );
      log(`Narrowed the ambient shim to only the documented export gap(s): ${Object.keys(KNOWN_EXPORT_GAPS).join(', ')}. All other @aoc/protocol symbols now resolve from the installed tarball.`);
    }

    // --- Install ---
    const install = run('npm', ['install', '--no-audit', '--no-fund'], tempDir);
    stepResults.push({ step: 'npm install (tarball-backed)', ok: install.ok, notes: install.ok ? 'installed' : install.output.slice(-2000) });
    if (!install.ok) throw new Error('npm install failed against the tarball-backed package.json; aborting remaining checks.');

    // --- Verify the resulting lockfile/node_modules resolve to the tarball, not a sibling path ---
    const siblingViolations = await siblingPathScan(tempDir);
    stepResults.push({ step: 'no sibling-path resolution', ok: siblingViolations.length === 0, notes: siblingViolations.join('; ') || 'clean' });

    const installedProtocolPkgPath = join(tempDir, 'node_modules', '@aoc', 'protocol', 'package.json');
    const installedProtocolPkg = existsSync(installedProtocolPkgPath) ? JSON.parse(await readFile(installedProtocolPkgPath, 'utf8')) : null;
    const installedOk = installedProtocolPkg?.name === '@aoc/protocol';
    stepResults.push({
      step: 'installed @aoc/protocol identity',
      ok: installedOk,
      notes: installedOk ? `${installedProtocolPkg.name}@${installedProtocolPkg.version}` : 'not installed or wrong package',
    });

    if (installedOk) {
      const exportsCheck = await resolveProtocolExports(tempDir, installedProtocolPkg);
      stepResults.push({ step: 'resolve all declared @aoc/protocol export subpaths', ok: exportsCheck.ok, notes: exportsCheck.notes });
      if (exportsCheck.ok) verifiedPublicExports = exportsCheck.specifiers;
      else exitCode = 1;
    }

    // --- Validation battery ---
    const battery = [
      ['typecheck', ['run', 'typecheck']],
      ['build', ['run', 'build']],
      ['lint', ['run', 'lint']],
      ['test', ['run', 'test']],
      ['check:protocol-consumption', ['run', 'check:protocol-consumption']],
      ['check:aoc-boundaries', ['run', 'check:aoc-boundaries']],
      ['validate:publishability', ['run', 'validate:publishability']],
      ['check:release-integrity', ['run', 'check:release-integrity']],
    ];
    for (const [label, npmArgs] of battery) {
      const result = run('npm', npmArgs, tempDir);
      stepResults.push({ step: label, ok: result.ok, notes: result.ok ? 'passed' : result.output.slice(-3000) });
      if (!result.ok) exitCode = 1;
    }

    // --- Forbidden import / declaration-leak scans ---
    const importViolations = await forbiddenImportScan(tempDir);
    stepResults.push({ step: 'forbidden import scan', ok: importViolations.length === 0, notes: importViolations.join('; ') || 'clean' });

    const leakViolations = await declarationLeakScan(tempDir);
    stepResults.push({ step: 'declaration path leak scan', ok: leakViolations.length === 0, notes: leakViolations.join('; ') || 'clean' });

    if (siblingViolations.length > 0 || !installedOk || importViolations.length > 0 || leakViolations.length > 0) {
      exitCode = 1;
    }
  } catch (error) {
    stepResults.push({ step: 'fatal error', ok: false, notes: error.message });
    exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  log('== Validation summary ==');
  for (const { step, ok, notes } of stepResults) {
    log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : `\n${notes}`}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        tarball: tarballPath,
        tarballSha256,
        verifiedPublicExports,
        results: stepResults.map(({ step, ok }) => ({ step, ok })),
        exitCode,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = exitCode;
}

// Run only when executed directly, so tests can import the scan functions.
// Real paths on both sides, so a symlinked checkout still runs the battery
// (tests/protocol-package-scoped-consumption.test.mjs asserts a direct run does).
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[tarball-validate] FATAL: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
