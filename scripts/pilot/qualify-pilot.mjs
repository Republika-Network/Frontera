// `npm run qualify:pilot` — the PROD-03 pilot qualification, in one command.
//
// Runs, against the current build (`npm run build` first), the deterministic
// pilot qualification suites:
//   - the clean-room pilot drill (real processes: Host from a staged release,
//     reference witness, web console, reference target; phases A–K, restart,
//     stale restore, incidents, store failures, the second-operator handoff
//     executing docs/pilot/ONBOARDING_RUNBOOK.md as written);
//   - the external-custody signer drill;
//   - the readiness gate's own suite (every check's failure class, the record,
//     read-only proof);
//   - the pilot structure suite (founder-free, no-direct-database, boundary,
//     template secret scan, documentation);
//   - the in-process approvalPolicy and witness-outage revocation suites.
// Then prints a concise summary: PASS / FAIL, the release identity the drill
// qualified, the gate ids, the drill phases, every failed test and where its
// remediation is documented. `--json` prints it machine-readable;
// `--evidence <file>` keeps the drill's value-free evidence.
//
// It orchestrates tests in scratch directories it creates and removes. It
// starts no deployment of yours, reads no secret of yours and grants nothing.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHECKS } from './lib-pilot-readiness.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const json = args.includes('--json');
const evidenceIndex = args.indexOf('--evidence');
const evidenceOut = evidenceIndex >= 0 ? args[evidenceIndex + 1] : undefined;

export const QUALIFICATION_SUITES = Object.freeze([
  'tests/pilot/prod03-clean-room-drill.test.mjs',
  'tests/pilot/prod03-signer-outage-drill.test.mjs',
  'tests/pilot/prod03-readiness-gate.test.mjs',
  'tests/pilot/prod03-pilot-structure.test.mjs',
  'dist/src/enterprise/__tests__/prod03-approval-policy-host.test.js',
  'dist/src/enterprise/__tests__/prod03-witness-outage-revocation.test.js',
]);

const REMEDIATION = Object.freeze({
  'prod03-clean-room-drill': 'docs/pilot/ONBOARDING_RUNBOOK.md; docs/pilot/OPERATIONS_RUNBOOK.md',
  'prod03-signer-outage-drill': 'docs/pilot/SECURITY_POSTURE.md §4',
  'prod03-readiness-gate': 'docs/pilot/PILOT_READINESS.md §5',
  'prod03-pilot-structure': 'docs/security/PROD-03-PILOT-ONBOARDING-OPERATIONAL-QUALIFICATION.md',
  'prod03-approval-policy-host': 'docs/pilot/ONBOARDING_RUNBOOK.md §2.1',
  'prod03-witness-outage-revocation': 'docs/pilot/OPERATIONS_RUNBOOK.md §9',
});

async function main() {
  const missing = QUALIFICATION_SUITES.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    console.error(`qualify:pilot: missing ${missing.join(', ')} — run npm run build first`);
    process.exitCode = 2;
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'frontera-qualify-pilot-'));
  const drillEvidence = evidenceOut ?? join(scratch, 'drill-evidence.json');
  process.env.FRONTERA_PILOT_DRILL_EVIDENCE = drillEvidence;
  const passed = [];
  const failed = [];
  try {
    const stream = run({ files: QUALIFICATION_SUITES.map((file) => join(ROOT, file)), concurrency: 1, cwd: ROOT });
    for await (const event of stream) {
      if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
      if (event.data.details?.type === 'suite') continue;
      const file = (event.data.file ?? '').replace(/\\/g, '/');
      const suite = Object.keys(REMEDIATION).find((name) => file.includes(name)) ?? 'unknown';
      const entry = { suite, test: event.data.name };
      if (event.type === 'test:pass') passed.push(entry);
      else failed.push({ ...entry, remediation: REMEDIATION[suite] ?? 'docs/pilot/README.md', error: String(event.data.details?.error?.message ?? event.data.details?.error ?? '').split('\n')[0].slice(0, 300) });
    }
  } catch (error) {
    failed.push({ suite: 'runner', test: 'node:test run', remediation: 'docs/pilot/README.md', error: String(error?.message ?? error).slice(0, 300) });
  }
  let drill = null;
  try {
    drill = JSON.parse(readFileSync(drillEvidence, 'utf8'));
  } catch {
    drill = null;
  }
  rmSync(scratch, { recursive: true, force: true });
  const summary = {
    schema: 'frontera.pilot-qualification-summary.v1',
    result: failed.length === 0 && passed.length > 0 ? 'PASS' : 'FAIL',
    release: drill?.release ?? null,
    gate: CHECKS.map((check) => check.id),
    drillPhases: drill === null ? [] : Object.keys(drill.phases),
    tests: { passed: passed.length, failed: failed.length },
    failures: failed,
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Frontera pilot qualification (PROD-03): ${summary.result}`);
    if (summary.release !== null) console.log(`release qualified: commit ${summary.release.commit} (${summary.release.commitSource})`);
    console.log(`readiness gate: ${summary.gate.join(' ')}`);
    console.log(`drill phases: ${summary.drillPhases.join(', ') || 'none recorded'}`);
    console.log(`tests: ${summary.tests.passed} passed, ${summary.tests.failed} failed`);
    for (const failure of failed) console.log(`FAIL ${failure.suite} › ${failure.test} — ${failure.error} (see ${failure.remediation})`);
  }
  process.exitCode = summary.result === 'PASS' ? 0 : 1;
}

await main();
