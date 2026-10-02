#!/usr/bin/env node
// Bounded portability smoke check, wired into `npm run validate:v1-release`
// (Phase 24). Deliberately NOT the full clean-room drill: that drill runs
// its own `npm ci` + build + test suite + `npm run validate:v1-release`
// inside a fresh checkout (see `validate-portability-v1.mjs`), so embedding
// it here would recurse. This check instead exercises the backup/restore/
// compare path directly, in-process, against the already-built `dist/` --
// seconds, not minutes -- to catch a broken backup or restore contract on
// every release validation, while the full `npm run validate:portability:v1`
// clean-room drill remains a separate, deliberately-run, pre-tag step (see
// docs/operations/AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md, "Why two commands").

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateFixture } from './generate-portability-fixture.mjs';
import { runBackup } from './backup-enterprise-v1.mjs';
import { runRestore } from './restore-enterprise-v1.mjs';
import { comparePortabilityState } from './compare-portability-state.mjs';
import { storeEnvironmentFor } from './store-registry.mjs';

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'aoc-portability-smoke-'));
  const preDir = join(workDir, 'pre');
  const backupDir = join(workDir, 'backup');
  const postDir = join(workDir, 'post');

  try {
    await generateFixture({ target: preDir });

    const backupEnv = {
      ...process.env,
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      ...storeEnvironmentFor(preDir),
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    };
    await runBackup({ output: backupDir, env: backupEnv });
    await runRestore({ backup: backupDir, target: postDir });

    const comparison = await comparePortabilityState({ pre: preDir, post: postDir, fixture: join(preDir, 'fixture-manifest.json') });
    if (!comparison.overallEquivalent) {
      throw new Error(`Portability smoke check: pre/post state not equivalent: ${JSON.stringify(comparison)}`);
    }
    console.log('Portability smoke check passed: fixture -> backup -> restore -> compare, logically equivalent.');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[check:portability-smoke] ${error.message}`);
  process.exitCode = 1;
});
