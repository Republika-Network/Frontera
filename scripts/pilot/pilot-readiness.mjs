// `npm run pilot:readiness` — the PROD-03 pilot readiness gate (and, with
// `--diagnose`, the operator's read-only diagnostic).
//
//   node scripts/pilot/pilot-readiness.mjs [--host URL] [--credential-env NAME] [--operator-env NAME]...
//        [--preflight] [--backup DIR] [--restore-report FILE] [--acknowledgement FILE]
//        [--record FILE] [--write-record FILE] [--record-validity-days N]
//        [--require deployment|organization|pilot] [--diagnose] [--json]
//        [--expect-commit SHA] [--expect-organization ID] [--require-profile ID]...
//        [--require-approvals] [--require-external-custody] [--accept-degraded MODULE]... [--backup-max-age-hours N]
//
// In the pilot kit it runs as the `pilot-readiness` tool, in the Host's own
// image, environment and network namespace:
//   docker compose run --rm pilot-readiness [options]
//
// Read-only: HTTP GET to routes the Host already serves, the existing
// deployment preflight (`--preflight`), and the files it is given. Credentials
// are read from the environment variables it is told to use and never printed.
// Exit 0 when the required level is reached, 1 when it is not, 2 on a usage
// error. See docs/pilot/PILOT_READINESS.md §5.
import { readFileSync, writeFileSync } from 'node:fs';

import { formatPreflight, runHostPreflight } from '../deploy/host-preflight.mjs';
import { LEVELS, buildQualificationRecord, evaluatePilotReadiness, formatReport, governedActionsFileDigest, lastRestoreFinishedAt } from './lib-pilot-readiness.mjs';

function usage(message) {
  console.error(`pilot-readiness: ${message}`);
  process.exitCode = 2;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const single = new Set(['--host', '--credential-env', '--backup', '--restore-report', '--acknowledgement', '--record', '--write-record', '--record-validity-days', '--require', '--expect-commit', '--expect-organization', '--backup-max-age-hours']);
const repeated = new Set(['--operator-env', '--require-profile', '--accept-degraded']);
const flags = new Set(['--preflight', '--diagnose', '--json', '--require-approvals', '--require-external-custody']);

function parse(argv) {
  const args = { repeated: {}, flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) args.flags.add(arg);
    else if (single.has(arg) || repeated.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      index += 1;
      if (single.has(arg)) {
        if (args[arg] !== undefined) return { error: `${arg} given twice` };
        args[arg] = value;
      } else (args.repeated[arg] ??= []).push(value);
    } else return { error: `unknown argument '${arg}'` };
  }
  return args;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.error !== undefined) return usage(args.error);
  const required = args['--require'] ?? (args.flags.has('--diagnose') ? 'deployment' : 'pilot');
  if (!LEVELS.includes(required)) return usage(`--require must be one of ${LEVELS.join(', ')}`);
  const credentialEnv = args['--credential-env'] ?? 'FRONTERA_OPERATOR_KEY_OBSERVER';
  const operatorEnvs = args.repeated['--operator-env'] ?? [];
  for (const name of [credentialEnv, ...operatorEnvs]) {
    if (!ENV_NAME.test(name)) return usage(`'${name}' is not an environment variable name`);
    if ((process.env[name] ?? '') === '') return usage(`environment variable ${name} is not set (it must hold an operator credential; the value is never printed)`);
  }
  const number = (flag, fallback) => {
    if (args[flag] === undefined) return fallback;
    const value = Number(args[flag]);
    return Number.isInteger(value) && value > 0 ? value : Number.NaN;
  };
  const backupMaxAgeHours = number('--backup-max-age-hours', undefined);
  const validityDays = number('--record-validity-days', undefined);
  if (Number.isNaN(backupMaxAgeHours) || Number.isNaN(validityDays)) return usage('--backup-max-age-hours and --record-validity-days take a positive integer');

  let record;
  if (args['--record'] !== undefined) {
    try {
      record = JSON.parse(readFileSync(args['--record'], 'utf8'));
    } catch {
      record = { unreadable: true };
    }
  }

  const preflightRequested = args.flags.has('--preflight');
  let preflightResult;
  const report = await evaluatePilotReadiness({
    hostUrl: args['--host'] ?? process.env.FRONTERA_HOST_URL ?? 'http://127.0.0.1:8787',
    credential: process.env[credentialEnv],
    operatorCredentials: operatorEnvs.map((name) => process.env[name]),
    ...(preflightRequested
      ? {
          preflight: async () => (preflightResult = await runHostPreflight(process.env)),
          governedActionsFileDigest: governedActionsFileDigest(process.env),
          lastRestoreFinishedAt: lastRestoreFinishedAt(process.env),
        }
      : {}),
    ...(args['--backup'] !== undefined ? { backupPath: args['--backup'] } : {}),
    ...(args['--restore-report'] !== undefined ? { restoreReportPath: args['--restore-report'] } : {}),
    ...(args['--acknowledgement'] !== undefined ? { acknowledgementPath: args['--acknowledgement'] } : {}),
    ...(record !== undefined ? { record } : {}),
    ...(args['--expect-commit'] !== undefined ? { expectCommit: args['--expect-commit'] } : {}),
    ...(args['--expect-organization'] !== undefined ? { expectOrganization: args['--expect-organization'] } : {}),
    requireProfiles: args.repeated['--require-profile'] ?? [],
    requireApprovals: args.flags.has('--require-approvals'),
    requireExternalCustody: args.flags.has('--require-external-custody'),
    acceptDegradedModules: args.repeated['--accept-degraded'] ?? [],
    ...(backupMaxAgeHours !== undefined ? { backupMaxAgeHours } : {}),
  });

  if (args.flags.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    if (preflightResult !== undefined && preflightResult.ok !== true) for (const line of formatPreflight(preflightResult)) console.log(line);
    for (const line of formatReport(report)) console.log(line);
  }

  if (args['--write-record'] !== undefined) {
    const qualification = buildQualificationRecord(report, { ...(validityDays !== undefined ? { validityDays } : {}) });
    try {
      writeFileSync(args['--write-record'], `${JSON.stringify(qualification, null, 2)}\n`, { mode: 0o600 });
      console.error(`qualification record written (result ${qualification.result}, valid until ${qualification.validUntil})`);
    } catch {
      console.error('pilot-readiness: the qualification record could not be written');
      process.exitCode = 1;
      return;
    }
  }
  const reached = LEVELS.indexOf(report.result.replace(/-ready$/, ''));
  process.exitCode = reached >= LEVELS.indexOf(required) ? 0 : 1;
}

await main();
