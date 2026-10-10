#!/usr/bin/env node
// PAY-03 — production-artifact qualification of the XRPL payment rail.
//
// Proves that a production install — `npm ci --omit=dev`, exactly as the
// Dockerfile's runtime stage does it — contains everything the configured
// PAY-03 Host path loads, without developer node_modules, personal environment
// or any hidden signer key:
//
//   A1  clean export: the commit's tracked files (or, with --worktree, the
//       working tree's tracked + untracked-unignored files) copied to a scratch
//       directory; nothing else.
//   A2  full install + build in the export.
//   A3  production reinstall: node_modules removed, `npm ci --omit=dev
//       --include-workspace-root` for the root and packages/* (the Dockerfile's
//       command); `src/` and `tests/` deleted; devDependencies verified absent;
//       `xrpl` verified present.
//   A4  the reference XRPL signer starts FROM THE ARTIFACT as its own process,
//       with its own key file and its own environment.
//   A5  the Enterprise Host boots FROM THE ARTIFACT, with a clean environment
//       (no inherited variables but PATH), xrplPaymentRail configured: the SDK
//       client, the external signer, the interlock and the resolver all load;
//       the signer identity is proven; the Host holds no XRPL key; the XRPL
//       server is unreachable by design (wss on a closed loopback port) so the
//       rail is degraded, never contacted on any real network.
//   A6  the Host's environment carries no XRPL key variable, and no secret
//       appears in the Host's output.
//
// Usage: node scripts/payments/qualify-xrpl-production-artifact.mjs [--commit <ref>] [--worktree] [--keep]
// Prints one JSON evidence line last. Exit 0 only if every case passed.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const worktree = args.includes('--worktree');
const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : 'HEAD';
const results = [];
const log = (line) => process.stderr.write(`[xrpl-artifact] ${line}\n`);
const record = (id, title, ok, detail = '') => {
  results.push({ id, title, ok, ...(detail ? { detail } : {}) });
  log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
};
const run = (cmd, argv, cwd, env = process.env) => {
  const result = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${result.status}): ${(result.stderr ?? '').slice(-2000)}`);
  return result;
};

const scratch = mkdtempSync(join(tmpdir(), 'frontera-xrpl-artifact-'));
const app = join(scratch, 'app');
const state = join(scratch, 'state');
const signerHome = join(scratch, 'signer');
mkdirSync(app);
mkdirSync(state);
mkdirSync(signerHome, { mode: 0o700 });
const children = [];

async function main() {
  // A1 — clean export.
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
  record('A1', `clean export (${worktree ? 'working tree' : commit})`, existsSync(join(app, 'package.json')) && !existsSync(join(app, 'node_modules')));

  // A2 — full install + build.
  const buildEnv = { PATH: process.env.PATH, HOME: scratch, npm_config_cache: join(scratch, '.npm') };
  run('npm', ['ci', '--no-audit', '--no-fund'], app, buildEnv);
  run('npm', ['run', 'build'], app, buildEnv);
  record('A2', 'npm ci + build in the export', existsSync(join(app, 'dist/src/enterprise/xrpl-payment-rail/host-composition.js')));

  // A3 — the Dockerfile's production reinstall.
  rmSync(join(app, 'node_modules'), { recursive: true, force: true });
  const workspaces = readdirSync(join(app, 'packages')).map((name) => `--workspace=packages/${name}`);
  run('npm', ['ci', '--omit=dev', '--include-workspace-root', '--no-audit', '--no-fund', ...workspaces], app, buildEnv);
  for (const dir of ['src', 'tests']) rmSync(join(app, dir), { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  // Dev-only: declared in devDependencies and nowhere else (react / react-dom are also peerDependencies, which npm installs).
  const devOnly = Object.keys(pkg.devDependencies ?? {}).filter((name) => !name.startsWith('@aoc') && !(name in (pkg.peerDependencies ?? {})) && !(name in (pkg.dependencies ?? {})));
  const leakedDev = devOnly.filter((name) => existsSync(join(app, 'node_modules', name)));
  const xrplPresent = existsSync(join(app, 'node_modules/xrpl/package.json')) && JSON.parse(readFileSync(join(app, 'node_modules/xrpl/package.json'), 'utf8')).version === pkg.dependencies.xrpl;
  record('A3', 'production install: xrpl present at the pinned version, no devDependency installed, no src/ or tests/', xrplPresent && leakedDev.length === 0 && !existsSync(join(app, 'node_modules/typescript')), leakedDev.length > 0 ? `dev packages present: ${leakedDev.join(', ')}` : '');

  // A4 — the reference signer from the artifact, its own process and environment.
  const signerToken = randomBytes(24).toString('hex');
  const signerEnv = {
    PATH: process.env.PATH,
    FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE: join(signerHome, 'xrpl-key.json'),
    FRONTERA_REFERENCE_XRPL_SIGNER_ID: 'artifact-reference-signer',
    FRONTERA_REFERENCE_XRPL_SIGNER_TOKEN: signerToken,
    FRONTERA_REFERENCE_XRPL_SIGNER_PORT: '0',
  };
  const signer = spawn(process.execPath, ['scripts/run-reference-xrpl-signer.mjs'], { cwd: app, env: signerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(signer);
  const banner = await new Promise((resolveBanner, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('the reference signer did not start')), 20_000);
    signer.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('listening on')) {
        clearTimeout(timer);
        resolveBanner(out);
      }
    });
    signer.on('exit', (code) => reject(new Error(`the reference signer exited ${code}`)));
  });
  const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(banner)?.[1];
  const identity = JSON.parse(readFileSync(join(signerHome, 'xrpl-key.json.pub'), 'utf8'));
  record('A4', 'reference XRPL signer started from the artifact (separate process, own key file)', port !== undefined && typeof identity.signingPublicKey === 'string');

  // A5 — the Host from the artifact, xrplPaymentRail configured, a clean environment.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const governed = join(state, 'governed-actions.json');
  writeFileSync(
    governed,
    JSON.stringify({
      version: 1,
      trustDomainId: 'trust-domain-artifact',
      grantLifetimeSeconds: 300,
      customerPrincipals: [{ principalId: 'principal-artifact', externalSubject: { system: 'artifact', subjectId: 'agent' }, apiKeyEnv: 'FRONTERA_ARTIFACT_CUSTOMER_KEY' }],
      monetary: { assets: [{ assetId: 'stable:RLUSD/artifact', scale: 15 }], financialActions: ['payment.execute'] },
      routes: [{ action: 'payment.execute', adapterId: 'xrpl-rlusd' }],
      xrplPaymentRail: {
        paymentAction: 'payment.execute',
        network: 'testnet',
        // A closed loopback port: the rail is composed and degraded, and nothing reaches any real XRPL network.
        endpoint: 'wss://127.0.0.1:9',
        asset: { paymentAsset: 'stable:RLUSD/artifact', currency: '524C555344000000000000000000000000000000', issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
        sourceAccounts: [{ accountId: 'treasury-ops', address: identity.address, signingPublicKey: identity.signingPublicKey }],
        requestTimeoutMs: 1000,
        signer: { endpoint: `http://127.0.0.1:${port}`, signerId: 'artifact-reference-signer', credential: { kind: 'bearer', tokenEnv: 'FRONTERA_ARTIFACT_XRPL_SIGNER_TOKEN' }, timeoutMs: 2000 },
      },
    }),
  );
  const customerKey = randomBytes(24).toString('hex');
  const hostEnv = {
    PATH: process.env.PATH,
    AOC_ENTERPRISE_ENV: 'development',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-artifact',
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: governed,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: 'artifact-authority-key',
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([{ keyId: 'artifact-authority-key', algorithm: 'ed25519-v1', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]),
    FRONTERA_ARTIFACT_CUSTOMER_KEY: customerKey,
    FRONTERA_ARTIFACT_XRPL_SIGNER_TOKEN: signerToken,
  };
  for (const [name, file] of Object.entries({
    AOC_ENTERPRISE_SQLITE_PATH: 'enterprise-host.sqlite',
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: 'agent-passport.sqlite',
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: 'assurance.sqlite',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: 'kernel-authority.sqlite',
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: 'bounded-grants.sqlite',
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: 'emergency-controls.sqlite',
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: 'exercise-ledger.sqlite',
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: 'authority-event-stream.sqlite',
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: 'execution-outcomes.sqlite',
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: 'execution-resolutions.sqlite',
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: 'obligation-discharges.sqlite',
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: 'approvals.sqlite',
    AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH: 'control-plane.sqlite',
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: 'evidence-bundles.sqlite',
    AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH: 'xrpl-submission-interlock.sqlite',
  })) hostEnv[name] = join(state, file);
  const probe = `
    import { bootEnterpriseHost } from './dist/src/enterprise/index.js';
    const host = await bootEnterpriseHost({ logger: { debug() {}, info() {}, warn() {}, error(m, f) { process.stderr.write(JSON.stringify({ m, f }) + '\\n'); } } });
    const report = await host.enterprise.health();
    const modules = report.modules ?? {};
    const out = {
      status: report.status,
      rail: modules['aoc.enterprise.xrpl-payment-rail']?.health,
      interlock: modules['aoc.enterprise.xrpl-submission-interlock']?.health.status,
    };
    await host.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const booted = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: app, env: hostEnv, encoding: 'utf8', timeout: 60_000 });
  let report;
  try {
    report = JSON.parse(booted.stdout);
  } catch {
    report = undefined;
  }
  const composed = report !== undefined && report.interlock === 'healthy' && report.rail?.details?.signer === 'verified' && report.rail?.details?.ledger === 'xrpl-network-unavailable';
  record('A5', 'Host booted from the production artifact with xrplPaymentRail: SDK, signer, interlock and resolver composed; signer identity proven; ledger unreachable by design', composed, composed ? '' : (booted.stderr || booted.stdout).slice(-1500));
  record('A5b', 'the interlock file was created on the configured state path', existsSync(join(state, 'xrpl-submission-interlock.sqlite')));

  // A6 — no key variable in the Host, no secret in its output.
  const keyVars = Object.keys(hostEnv).filter((name) => /XRPL/.test(name) && /(SEED|SECRET|PRIVATE|MNEMONIC|WALLET)/.test(name));
  const seed = JSON.parse(readFileSync(join(signerHome, 'xrpl-key.json'), 'utf8')).seed;
  const output = `${booted.stdout}\n${booted.stderr}`;
  record('A6', 'the Host process held no XRPL key variable and printed no secret', keyVars.length === 0 && !output.includes(seed) && !output.includes(signerToken) && !output.includes(customerKey));
}

let failure;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  record('ERR', 'qualification aborted', false, failure);
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}
const ok = results.every((result) => result.ok) && results.some((result) => result.id === 'A6');
process.stdout.write(`${JSON.stringify({ qualification: 'pay03-xrpl-production-artifact', commit: worktree ? 'worktree' : commit, ok, results })}\n`);
process.exitCode = ok ? 0 : 1;
