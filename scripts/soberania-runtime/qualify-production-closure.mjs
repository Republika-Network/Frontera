#!/usr/bin/env node
// FRONTERA-SOBE-PILOT-01C0 — production-install qualification of the Soberanía runtime closure.
//
// Proves that the Host's production install — `npm ci --omit=dev --include-workspace-root` for the
// root and packages/*, exactly the Dockerfile's runtime-stage command — contains and can execute the
// approved runtime closure without development dependencies, vendored tarballs or a Soberanía
// source checkout:
//
//   P1  clean export: the commit's tracked files (or, with --worktree, the working tree's tracked +
//       untracked-unignored files) copied to a scratch directory; nothing else.
//   P2  production install with the Dockerfile's command; no build, no devDependencies.
//   P3  installed graph: the seven approved packages and @aoc/protocol are real directories at the
//       top level; each installed runtime file is byte-identical to the vendored, lock-verified
//       tarball's; no excluded package and no development tool (typescript) is installed.
//   P4  execution from the installed tree only: vendor/, src/ and tests/ are deleted, then the
//       01A plain-Node scenario runs from the closure workspace with a clean environment. The valid
//       case allows, every other case denies or rejects, and only the approved runtime closure and
//       the canonical Protocol module are loaded.
//
// Usage: node scripts/soberania-runtime/qualify-production-closure.mjs [--commit <ref>] [--worktree] [--keep]
// Prints one JSON evidence line last. Exit 0 only if every case passed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { APPROVED_RUNTIME_PACKAGES, CLOSURE_WORKSPACE_DIR, EXCLUDED_RUNTIME_PACKAGES, extractTarballAsModule } from './lib-runtime-artifacts.mjs';

const ROOT = resolve(process.cwd());
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const worktree = args.includes('--worktree');
const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : 'HEAD';
const results = [];
const log = (line) => process.stderr.write(`[soberania-closure] ${line}\n`);
const record = (id, title, ok, detail = '') => {
  results.push({ id, title, ok, ...(detail ? { detail } : {}) });
  log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
};
const run = (cmd, argv, cwd, env = process.env) => {
  const result = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${result.status}): ${(result.stderr ?? '').slice(-2000)}`);
  return result;
};

const scratch = mkdtempSync(join(tmpdir(), 'frontera-soberania-closure-'));
const app = join(scratch, 'app');
mkdirSync(app);

/** Every installed package directory name under node_modules, at any depth. */
function installedPackageNames(nodeModules) {
  const names = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(join(dir, entry.name))) {
          names.push(`${entry.name}/${scoped}`);
          visit(join(dir, entry.name, scoped, 'node_modules'));
        }
      } else {
        names.push(entry.name);
        visit(join(dir, entry.name, 'node_modules'));
      }
    }
  };
  visit(nodeModules);
  return names;
}

async function main() {
  // P1 — clean export.
  if (worktree) {
    const files = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], ROOT).stdout.split('\0').filter(Boolean);
    for (const file of files) {
      if (!existsSync(join(ROOT, file))) continue;
      mkdirSync(dirname(join(app, file)), { recursive: true });
      cpSync(join(ROOT, file), join(app, file));
    }
  } else {
    const archive = spawnSync('git', ['archive', '--format=tar', commit], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`git archive ${commit} failed`);
    const untar = spawnSync('tar', ['-x', '-C', app], { input: archive.stdout });
    if (untar.status !== 0) throw new Error('tar failed');
  }
  record('P1', `clean export (${worktree ? 'working tree' : commit})`, existsSync(join(app, 'package.json')) && !existsSync(join(app, 'node_modules')));

  // P2 — the Dockerfile's production install.
  const env = { PATH: process.env.PATH, HOME: scratch, npm_config_cache: join(scratch, '.npm') };
  const workspaces = readdirSync(join(app, 'packages')).map((name) => `--workspace=packages/${name}`);
  run('npm', ['ci', '--omit=dev', '--include-workspace-root', '--no-audit', '--no-fund', ...workspaces], app, env);
  record('P2', 'npm ci --omit=dev --include-workspace-root for the root and packages/* (the Dockerfile command)', existsSync(join(app, 'node_modules')));

  // P3 — the installed graph.
  const lock = JSON.parse(readFileSync(join(app, 'soberania-runtime-consumer.lock.json'), 'utf8'));
  const nodeModules = join(app, 'node_modules');
  const problems = [];
  const reference = join(scratch, 'reference', 'node_modules');
  for (const entry of lock.packages) {
    const installed = join(nodeModules, ...entry.name.split('/'));
    if (!existsSync(join(installed, 'package.json'))) {
      problems.push(`${entry.name} not installed`);
      continue;
    }
    if (lstatSync(installed).isSymbolicLink()) problems.push(`${entry.name} is a symlink`);
    const expected = extractTarballAsModule(join(app, entry.tarball.vendoredAt), reference, entry.name);
    for (const file of entry.files) {
      if (!existsSync(join(installed, file))) problems.push(`${entry.name}/${file} missing`);
      else if (!readFileSync(join(installed, file)).equals(readFileSync(join(expected, file)))) problems.push(`${entry.name}/${file} differs from the vendored artifact`);
    }
  }
  const protocolDir = join(nodeModules, '@aoc', 'protocol');
  if (!existsSync(join(protocolDir, 'package.json'))) problems.push('@aoc/protocol not installed');
  else if (JSON.parse(readFileSync(join(protocolDir, 'package.json'), 'utf8')).version !== lock.protocolDependency.expectedVersion) problems.push('@aoc/protocol is not the pinned candidate');
  const names = installedPackageNames(nodeModules);
  for (const excluded of EXCLUDED_RUNTIME_PACKAGES) if (names.includes(excluded)) problems.push(`excluded ${excluded} installed`);
  for (const name of names.filter((candidate) => candidate.startsWith('@aoc-runtime/'))) {
    if (!(name in APPROVED_RUNTIME_PACKAGES)) problems.push(`unapproved ${name} installed`);
  }
  if (names.includes('typescript')) problems.push('typescript (a development dependency) is installed');
  record('P3', 'installed graph: 7 approved packages byte-identical to the vendored artifacts, @aoc/protocol rc.3, nothing excluded, no devDependency', problems.length === 0, problems.join('; '));

  // P4 — execute from the installed tree only.
  for (const dir of ['vendor', 'src', 'tests']) rmSync(join(app, dir), { recursive: true, force: true });
  const workspace = join(app, ...CLOSURE_WORKSPACE_DIR.split('/'));
  copyFileSync(join(ROOT, 'tests/fixtures/soberania-runtime/consume-runtime.cjs'), join(workspace, 'consume-runtime.cjs'));
  const scenario = spawnSync(process.execPath, ['consume-runtime.cjs'], { cwd: workspace, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(scenario.stdout);
  } catch {
    report = undefined;
  }
  const executionProblems = [];
  if (scenario.status !== 0 || report === undefined) executionProblems.push(`scenario failed: ${(scenario.stderr ?? '').slice(-1000)}`);
  else {
    const allowed = Object.entries(report.cases).filter(([, outcome]) => outcome.allowed === true).map(([name]) => name);
    if (JSON.stringify(allowed) !== JSON.stringify(['A allowed'])) executionProblems.push(`allowed cases: ${allowed.join(', ') || 'none'}`);
    const loaded = report.loaded.map((file) => relative(app, file).split(sep).join('/')).filter((file) => !file.endsWith('consume-runtime.cjs'));
    const runtimeNames = Object.keys(APPROVED_RUNTIME_PACKAGES).filter((name) => APPROVED_RUNTIME_PACKAGES[name] === 'runtime');
    for (const file of loaded) {
      const ok = runtimeNames.some((name) => file.startsWith(`node_modules/${name}/`)) || file.startsWith('node_modules/@aoc/protocol/dist/canonical/') || file === 'node_modules/@aoc/protocol/package.json';
      if (!ok) executionProblems.push(`loaded ${file}`);
    }
  }
  record('P4', 'executes from the installed tree (vendor/, src/, tests/ deleted): only the valid case allows; only the approved closure is loaded', executionProblems.length === 0, executionProblems.join('; '));
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  record('FATAL', 'qualification aborted', false, error instanceof Error ? error.message : String(error));
} finally {
  if (results.some((result) => !result.ok)) exitCode = 1;
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
}
process.stdout.write(`${JSON.stringify({ qualification: 'soberania-runtime-production-closure', ok: exitCode === 0, results })}\n`);
process.exit(exitCode);
