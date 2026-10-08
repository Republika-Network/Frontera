// PROD-03-03 — the Enterprise Host deployment preflight
// (`npm run check:host-configuration`, and the launcher before boot).
// Run after `npm run build`.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPreflight, runHostPreflight } from '../scripts/deploy/host-preflight.mjs';
import { storeEnvironmentFor } from '../scripts/portability/store-registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const enterprise = await import(join(ROOT, 'dist/src/enterprise/index.js'));

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-preflight-'));
  dirs.push(dir);
  return dir;
}

/** A durable development Host: every store under `dataDir`. */
function durableEnv(dataDir, extra = {}) {
  return { AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite', AOC_ENTERPRISE_HTTP_PORT: '0', ...storeEnvironmentFor(dataDir), ...extra };
}

const failures = (result) => result.checks.filter((check) => check.status === 'fail').map((check) => check.code);
const outputOf = (result) => formatPreflight(result).join('\n');

describe('PROD-03-03 Host preflight', () => {
  it('passes a valid durable configuration and reports what it checked, without paths', async () => {
    const data = scratch();
    const result = await runHostPreflight(durableEnv(data));
    assert.equal(result.ok, true, outputOf(result));
    const output = outputOf(result);
    assert.match(output, /^PASS configuration +environment=development .*persistence=sqlite/m);
    assert.match(output, /^PASS storage +\d+ composed stores writable/m);
    assert.match(output, /^RESULT: PASS$/m);
    assert.equal(output.includes(data), false, 'no filesystem path in the report');
  });

  it('refuses the example placeholders, naming the variables and never a value', async () => {
    const secret = 'PREFLIGHTCANARY0123456789abcdef0123456789';
    const result = await runHostPreflight(durableEnv(scratch(), { AOC_ENTERPRISE_API_KEYS: secret, FRONTERA_PROVIDER_TOKEN: '<required-secret>', FRONTERA_SOME_OPERATOR_KEY: 'REPLACE_ME', DOCUMENTATION_STATUS: 'CHANGE_ME' }));
    assert.equal(result.ok, false);
    assert.deepEqual(failures(result), ['CONFIG_PLACEHOLDER_VALUE']);
    const output = outputOf(result);
    assert.match(output, /FRONTERA_PROVIDER_TOKEN, FRONTERA_SOME_OPERATOR_KEY$/m, 'only variables the Host reads; DOCUMENTATION_STATUS is not one');
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes('<required-secret>'), false);
  });

  it('refuses a lifecycle bound that is not a whole number instead of reading its prefix', async () => {
    const result = await runHostPreflight(durableEnv(scratch(), { AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS: '30s' }));
    assert.deepEqual(failures(result), ['HOST_ENVIRONMENT_INVALID']);
    assert.match(outputOf(result), /AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS must be a positive whole number/);
  });

  it('reports the Host configuration refusal with the Host’s own code', async () => {
    const result = await runHostPreflight({ AOC_ENTERPRISE_ENV: 'production', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite' });
    assert.equal(result.ok, false);
    assert.deepEqual(failures(result), ['HOST_AUTHENTICATION_REQUIRED']);
    assert.match(outputOf(result), /^SKIP storage +configuration did not parse$/m);
  });

  it('refuses two stores configured onto one file', async () => {
    const data = scratch();
    const env = durableEnv(data, { AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(data, 'enterprise-host.sqlite') });
    assert.deepEqual(failures(await runHostPreflight(env)), ['STORAGE_PATHS_COLLIDE']);
    const onSidecar = durableEnv(data, { AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(data, 'enterprise-host.sqlite-wal') });
    assert.deepEqual(failures(await runHostPreflight(onSidecar)), ['STORAGE_PATHS_COLLIDE'], "a store on another database's WAL file");
    // The other order: the store checked first sits on the WAL of one checked later.
    const reversed = durableEnv(data, { AOC_ENTERPRISE_SQLITE_PATH: join(data, 'assurance.sqlite-wal') });
    assert.deepEqual(failures(await runHostPreflight(reversed)), ['STORAGE_PATHS_COLLIDE'], 'governance on the assurance WAL');
  });

  it('refuses stores that alias one file through a symlinked directory or a hard link', async () => {
    const { linkSync, symlinkSync } = await import('node:fs');
    const data = scratch();
    symlinkSync(data, join(data, 'alias'));
    const viaSymlink = durableEnv(data, { AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(data, 'alias', 'enterprise-host.sqlite') });
    assert.deepEqual(failures(await runHostPreflight(viaSymlink)), ['STORAGE_PATHS_COLLIDE'], 'not yet created, reached through a symlink');

    const linked = scratch();
    const store = await enterprise.createSqliteGovernanceStore(join(linked, 'enterprise-host.sqlite'));
    await store.close();
    linkSync(join(linked, 'enterprise-host.sqlite'), join(linked, 'other-name.sqlite'));
    const viaHardLink = durableEnv(linked, { AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(linked, 'other-name.sqlite') });
    assert.ok(failures(await runHostPreflight(viaHardLink)).includes('STORAGE_PATHS_COLLIDE'), 'an existing file reached by another name');
  });

  it('judges a symlinked store file by where its target lives', { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false }, async () => {
    const { symlinkSync } = await import('node:fs');
    const data = scratch();
    const elsewhere = join(scratch(), 'locked');
    mkdirSync(elsewhere);
    const store = await enterprise.createSqliteGovernanceStore(join(elsewhere, 'enterprise-host.sqlite'));
    await store.close();
    chmodSync(elsewhere, 0o500);
    // The state directory itself is writable; the file is a link out of it.
    symlinkSync(join(elsewhere, 'enterprise-host.sqlite'), join(data, 'enterprise-host.sqlite'));
    try {
      assert.deepEqual(failures(await runHostPreflight(durableEnv(data))), ['STORAGE_NOT_WRITABLE']);
    } finally {
      chmodSync(elsewhere, 0o700);
    }
  });

  it('follows a store-file symlink to a target that does not exist yet', { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false }, async () => {
    const { symlinkSync } = await import('node:fs');
    const data = scratch();
    const elsewhere = join(scratch(), 'locked');
    mkdirSync(elsewhere, { mode: 0o500 });
    // Dangling: SQLite would create the database at the target, outside the state directory.
    symlinkSync(join(elsewhere, 'enterprise-host.sqlite'), join(data, 'enterprise-host.sqlite'));
    assert.deepEqual(failures(await runHostPreflight(durableEnv(data))), ['STORAGE_NOT_WRITABLE']);
    symlinkSync(join(data, 'loop-b'), join(data, 'loop-a'));
    symlinkSync(join(data, 'loop-a'), join(data, 'loop-b'));
    const loop = durableEnv(scratch(), { AOC_ENTERPRISE_SQLITE_PATH: join(data, 'loop-a') });
    assert.deepEqual(failures(await runHostPreflight(loop)), ['STORAGE_UNAVAILABLE']);
  });

  it('refuses a store beneath a symlinked directory whose target is missing, which the Host could not create', async () => {
    const { symlinkSync } = await import('node:fs');
    const data = scratch();
    symlinkSync(join(data, 'gone'), join(data, 'link'));
    const env = durableEnv(join(data, 'link', 'nested'));
    const result = await runHostPreflight(env);
    assert.ok(failures(result).length > 0 && failures(result).every((code) => code === 'STORAGE_UNAVAILABLE'), outputOf(result));
    await assert.rejects(enterprise.bootEnterpriseHost({ env: { ...env, AOC_ENTERPRISE_LOG_LEVEL: 'error' } }), 'the Host itself cannot start there either');
  });

  it('refuses a store-file link into a directory that does not exist, and ignores stale write probes', async () => {
    const { symlinkSync, writeFileSync } = await import('node:fs');
    const data = scratch();
    symlinkSync(join(scratch(), 'missing', 'nested', 'enterprise-host.sqlite'), join(data, 'enterprise-host.sqlite'));
    assert.deepEqual(failures(await runHostPreflight(durableEnv(data))), ['STORAGE_UNAVAILABLE']);
    // A probe left by a killed check (one-off containers all run as PID 1) changes nothing.
    const clean = scratch();
    writeFileSync(join(clean, '.frontera-preflight-1'), '');
    writeFileSync(join(clean, `.frontera-preflight-${process.pid}`), '');
    assert.equal((await runHostPreflight(durableEnv(clean))).ok, true);
  });

  it('refuses a SQLite companion file that is a symlink, dangling or not', async () => {
    const { symlinkSync } = await import('node:fs');
    const data = scratch();
    symlinkSync(join(scratch(), 'missing', 'wal'), join(data, 'enterprise-host.sqlite-wal'));
    const result = await runHostPreflight(durableEnv(data));
    assert.deepEqual(failures(result), ['STORAGE_UNAVAILABLE']);
    assert.match(outputOf(result), /its wal file is a symlink/);
  });

  it('reports an unreadable governed-action file by variable, never by its path', async () => {
    const missing = join(scratch(), 'customer-acme', 'governed-actions.json');
    const result = await runHostPreflight(durableEnv(scratch(), { AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: missing, AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true' }));
    assert.deepEqual(failures(result), ['HOST_GOVERNED_ACTIONS_FILE_UNREADABLE']);
    assert.equal(outputOf(result).includes('customer-acme'), false);
    assert.match(outputOf(result), /<AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE>/);
  });

  it('passes a store directory that does not exist yet — and the Host then creates it, as the preflight assumes', async () => {
    const nested = join(scratch(), 'not', 'yet', 'created');
    const env = durableEnv(nested, { AOC_ENTERPRISE_LOG_LEVEL: 'error' });
    assert.equal((await runHostPreflight(env)).ok, true);
    const host = await enterprise.bootEnterpriseHost({ env });
    await host.close();
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(nested, 'enterprise-host.sqlite')), 'every store creates its own parent directories');
  });

  it('refuses a state directory this process cannot write', { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false }, async () => {
    const data = scratch();
    const locked = join(data, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const result = await runHostPreflight(durableEnv(join(locked, 'state')));
    assert.ok(failures(result).every((code) => code === 'STORAGE_NOT_WRITABLE') && failures(result).length > 0, outputOf(result));
  });

  it('accepts every store at a supported schema version, whatever its own migration label, and refuses one at a version this build does not open', async () => {
    const data = scratch();
    const path = join(data, 'enterprise-host.sqlite');
    const store = await enterprise.createSqliteGovernanceStore(path);
    await store.close();
    const fresh = await runHostPreflight(durableEnv(data));
    assert.equal(fresh.ok, true, outputOf(fresh));

    const Database = (await import('better-sqlite3')).default;
    // The governance store labels a new file 'fresh'; an in-place upgrade appends 'migrated'. Both are the supported version.
    const migrated = new Database(path);
    migrated.prepare(`INSERT INTO governance_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'migrated', ?)`).run(enterprise.GOVERNANCE_STORE_SCHEMA_VERSION, new Date().toISOString());
    migrated.close();
    assert.equal((await runHostPreflight(durableEnv(data))).ok, true, 'migrated is a finished state');

    const db = new Database(path);
    db.prepare(`INSERT INTO governance_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.governance-store.schema.v999', 'current', ?)`).run(new Date().toISOString());
    db.close();
    const newer = await runHostPreflight(durableEnv(data));
    assert.deepEqual(failures(newer), ['SCHEMA_INCOMPATIBLE']);
  });

  it('refuses a store file that is not an intact SQLite database', async () => {
    const data = scratch();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(data, 'enterprise-host.sqlite'), 'this is not a database, it is a canary PREFLIGHTCORRUPT');
    const result = await runHostPreflight(durableEnv(data));
    assert.deepEqual(failures(result), ['STORAGE_UNAVAILABLE']);
    assert.equal(outputOf(result).includes('PREFLIGHTCORRUPT'), false);
  });

  it('the launcher runs the preflight first: a refusal exits 1 before anything is composed or bound', () => {
    const secret = 'LAUNCHERPREFLIGHTCANARY000000000000000000';
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/run-enterprise-host.mjs')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...durableEnv(scratch(), { AOC_ENTERPRISE_API_KEYS: secret, FRONTERA_PROVIDER_TOKEN: '<required-secret>' }) },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused to start \[CONFIG_PLACEHOLDER_VALUE\]/);
    const refused = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.message === 'enterprise.host.refused');
    assert.deepEqual({ phase: refused?.phase, errorCode: refused?.errorCode, level: refused?.level }, { phase: 'preflight', errorCode: 'CONFIG_PLACEHOLDER_VALUE', level: 'error' });
    assert.equal(result.stdout.includes('listening'), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  });

  it('npm run check:host-configuration is the same preflight, exiting 0 or 1', () => {
    const pkg = JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync("package.json","utf8"))'], { cwd: ROOT, encoding: 'utf8' }).stdout);
    assert.equal(pkg.scripts['check:host-configuration'], 'node scripts/check-host-configuration.mjs');
    const ok = spawnSync(process.execPath, [join(ROOT, 'scripts/check-host-configuration.mjs')], { cwd: ROOT, env: { PATH: process.env.PATH, ...durableEnv(scratch()) }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/check-host-configuration.mjs')], { cwd: ROOT, env: { PATH: process.env.PATH, AOC_ENTERPRISE_ENV: 'nonsense' }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^FAIL configuration +\[HOST_ENVIRONMENT_INVALID\]/m);
  });
});
