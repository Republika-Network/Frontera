#!/usr/bin/env node
// AOC Enterprise v1 clean-room portability drill (`npm run validate:portability:v1`).
//
// Proves the mission's core claim end-to-end: a `git archive` of HEAD,
// extracted OUTSIDE this working tree, with no access to this tree's
// `node_modules`/`dist`/untracked files/env, can install, build, seed a
// synthetic fixture, back it up, have its source stores destroyed, restore
// from the backup alone, and reproduce logically-equivalent governed state
// -- then still pass the full v1 release gate. See
// docs/operations/AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md.
//
// Usage:
//   node scripts/portability/validate-portability-v1.mjs [--keep] [--skip-release-gate]

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

import { REPO_ROOT, stableJsonStringify } from './lib-portability.mjs';
import { STORE_DEFINITIONS, storeEnvironmentFor } from './store-registry.mjs';

/** The PROD-02 Host drills: real Hosts, every composable store, a separate-process witness, software and external custody. */
const PROD02_DRILLS = [
  'dist/src/enterprise/__tests__/prod02-disaster-recovery-host.test.js',
  'dist/src/enterprise/__tests__/prod02-stale-restore-host.test.js',
  'dist/src/enterprise/__tests__/prod02-backup-integrity-host.test.js',
];

function parseArgs(argv) {
  const args = { keep: false, skipReleaseGate: false };
  for (const arg of argv) {
    if (arg === '--keep') args.keep = true;
    else if (arg === '--skip-release-gate') args.skipReleaseGate = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function step(steps, name, fn) {
  const startedAt = Date.now();
  console.log(`\n=== [${name}] ===`);
  try {
    const detail = fn();
    steps.push({ name, status: 'pass', durationMs: Date.now() - startedAt, detail: detail ?? null });
    console.log(`--- [${name}] PASS (${Date.now() - startedAt}ms)`);
  } catch (error) {
    steps.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: error.message });
    console.error(`--- [${name}] FAIL: ${error.message}`);
    throw new DrillFailure(name, error, steps);
  }
}

class DrillFailure extends Error {
  constructor(stepName, cause, steps) {
    super(`Clean-room drill failed at step '${stepName}': ${cause.message}`);
    this.steps = steps;
  }
}

function run(cwd, command, args, envOverrides) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 64,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
  });
}

export async function runCleanRoomDrill({ keep = false, skipReleaseGate = false } = {}) {
  const steps = [];
  const drillStartedAt = Date.now();

  const gitStatus = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const worktreeClean = gitStatus.length === 0;
  console.log(worktreeClean ? 'Source worktree is clean.' : `Source worktree has local changes (recorded, not blocking):\n${gitStatus}`);

  const commit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const cleanRoomRoot = mkdtempSync(join(tmpdir(), 'aoc-enterprise-clean-room-'));
  // Not pre-created: `git clone` requires its destination to not already
  // exist (or to be empty) and creates it itself.
  const checkoutDir = join(cleanRoomRoot, 'checkout');
  const drillDataDir = join(cleanRoomRoot, 'drill-data');
  mkdirSync(drillDataDir, { recursive: true });

  try {
    step(steps, 'clean-source-extraction', () => {
      // A local `git clone` followed by an explicit checkout of `commit`
      // gives exactly the tracked tree at that commit -- no node_modules/
      // dist, no untracked or ignored files, no ambient Codespace state --
      // while (unlike `git archive`, tried first and rejected here) still
      // preserving a real `.git`, which the existing release-manifest
      // tooling (`scripts/lib-release-manifest.mjs`) shells out to
      // (`git rev-parse HEAD`) and therefore requires to run the full
      // release gate inside the clean room (Phase 15 step 17). `git clone`
      // is explicitly one of the mission's acceptable clean-source
      // mechanisms (Phase 16).
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, checkoutDir]);
      execFileSync('git', ['checkout', '--quiet', commit], { cwd: checkoutDir });
      const forbidden = ['node_modules', 'dist', '.data'].filter((entry) => existsSync(join(checkoutDir, entry)));
      if (forbidden.length > 0) throw new Error(`Clean-room checkout unexpectedly contains: ${forbidden.join(', ')} -- these must come from the build, not the source tree.`);
      return { commit, checkoutDir };
    });

    step(steps, 'npm-ci', () => {
      const output = run(checkoutDir, 'npm', ['ci']);
      return { outputTail: output.split('\n').slice(-5).join('\n') };
    });

    step(steps, 'build', () => run(checkoutDir, 'npm', ['run', 'build']));
    step(steps, 'typecheck', () => run(checkoutDir, 'npm', ['run', 'typecheck']));
    step(steps, 'lint', () => run(checkoutDir, 'npm', ['run', 'lint']));

    const testOutput = { value: '' };
    step(steps, 'compiled-tests', () => {
      testOutput.value = run(checkoutDir, 'npm', ['run', 'test:root']);
      return { summary: testOutput.value.split('\n').filter((line) => line.startsWith('# ')).join(' | ') };
    });

    const preDir = join(drillDataDir, 'pre');
    const preReferenceDir = join(drillDataDir, 'pre-reference');
    const backupDir = join(drillDataDir, 'backup');
    const postDir = join(drillDataDir, 'post');
    const comparisonPath = join(drillDataDir, 'portability-comparison.json');

    step(steps, 'synthetic-fixture-generation', () => {
      run(checkoutDir, 'node', ['scripts/portability/generate-portability-fixture.mjs', '--target', preDir]);
      return { preDir };
    });

    const backupEnv = {
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
      ...storeEnvironmentFor(preDir),
    };
    step(steps, 'full-backup', () => {
      const output = run(checkoutDir, 'node', ['scripts/portability/backup-enterprise-v1.mjs', '--output', backupDir], backupEnv);
      return JSON.parse(output.slice(output.indexOf('{')));
    });

    step(steps, 'pre-reference-capture', () => {
      // A drill needs a known-good reference to compare the restore
      // against, captured before the simulated disaster. This is
      // deliberately separate from the backup under test: the backup is
      // what gets restored; this reference is only ever read by the
      // comparison step, never by restore.
      cpSync(preDir, preReferenceDir, { recursive: true });
      return { preReferenceDir };
    });

    step(steps, 'source-store-destruction', () => {
      for (const storeDef of STORE_DEFINITIONS) {
        rmSync(join(preDir, storeDef.targetFilename), { force: true });
      }
      return { destroyed: preDir };
    });

    // Restored with the restoring deployment's environment, so coverage is checked against it.
    step(steps, 'full-restore', () =>
      run(checkoutDir, 'node', ['scripts/portability/restore-enterprise-v1.mjs', '--backup', backupDir, '--target', postDir], {
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        ...storeEnvironmentFor(postDir),
      }),
    );

    step(steps, 'logical-comparison', () => {
      const output = run(checkoutDir, 'node', [
        'scripts/portability/compare-portability-state.mjs',
        '--pre', preReferenceDir,
        '--post', postDir,
        '--fixture', join(preReferenceDir, 'fixture-manifest.json'),
        '--output', comparisonPath,
      ]);
      const parsed = JSON.parse(output.slice(output.indexOf('{')));
      if (!parsed.overallEquivalent) throw new Error(`Pre/post logical state is NOT equivalent: ${JSON.stringify(parsed)}`);
      return parsed;
    });

    // PROD-02: the authoritative disaster-recovery qualification, run inside
    // the clean room against its own build -- the clean-room secure-Host drill
    // (software and external custody), the stale-backup drill against a
    // surviving witness, and the tamper/rollback matrix.
    step(steps, 'prod02-host-drills', () => {
      const output = run(checkoutDir, 'node', ['--test', ...PROD02_DRILLS]);
      const summary = output.split('\n').filter((line) => /^# (tests|pass|fail)/.test(line));
      if (!summary.includes('# fail 0')) throw new Error(`PROD-02 drills failed: ${summary.join(' | ')}`);
      return { summary: summary.join(' | ') };
    });

    if (!skipReleaseGate) {
      step(steps, 'clean-room-release-gate', () => run(checkoutDir, 'npm', ['run', 'validate:v1-release']));
    }

    const report = {
      drillVersion: 'aoc.enterprise.portability-drill.v1',
      runAt: new Date(drillStartedAt).toISOString(),
      sourceCommit: commit,
      sourceWorktreeClean: worktreeClean,
      cleanRoomRoot,
      steps,
      totalDurationMs: Date.now() - drillStartedAt,
      result: 'PASS',
    };
    writeFileSync(join(cleanRoomRoot, 'clean-room-drill-report.json'), stableJsonStringify(report));
    console.log(`\nClean-room drill PASSED in ${report.totalDurationMs}ms. Report: ${join(cleanRoomRoot, 'clean-room-drill-report.json')}`);
    if (keep) {
      console.log(`--keep set: clean-room directory retained at ${cleanRoomRoot}`);
    } else {
      rmSync(cleanRoomRoot, { recursive: true, force: true });
    }
    return report;
  } catch (error) {
    const report = {
      drillVersion: 'aoc.enterprise.portability-drill.v1',
      runAt: new Date(drillStartedAt).toISOString(),
      sourceCommit: commit,
      sourceWorktreeClean: worktreeClean,
      cleanRoomRoot,
      steps: error instanceof DrillFailure ? error.steps : steps,
      totalDurationMs: Date.now() - drillStartedAt,
      result: 'FAIL',
      failure: error.message,
    };
    try {
      writeFileSync(join(cleanRoomRoot, 'clean-room-drill-report.json'), stableJsonStringify(report));
    } catch {
      // best-effort
    }
    console.error(`\nClean-room drill FAILED. Report and artifacts retained at ${cleanRoomRoot} for inspection.`);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCleanRoomDrill(args);
  console.log(JSON.stringify({ result: report.result, steps: report.steps.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs })) }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
