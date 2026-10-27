import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const script = join(ROOT, 'scripts/deploy/generate-pilot-secrets.mjs');

function run(...args) {
  return spawnSync(process.execPath, [script, '--secrets-only', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

describe('pilot secret-name safety', () => {
  it('accepts operator credential names in the generated-secret namespace', () => {
    const result = run('--secret', 'FRONTERA_OPERATOR_KEY_TEST');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\n# ---- generated[\s\S]*^FRONTERA_OPERATOR_KEY_TEST=/m);
  });

  it('refuses provider credentials so generated operator secrets cannot overwrite them', () => {
    const result = run('--secret', 'FRONTERA_PROVIDER_TOKEN');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not an allowed credential name/);
  });
});

describe('AUTH-04D2A — split initialization for a witness on its own machine', () => {
  const runWith = async (env, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const scratch = async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    return mkdtempSync(join(tmpdir(), 'frontera-split-init-'));
  };

  it('--witness-only persists the witness key and prints only the witness id, credential and PUBLIC key — never an authority key or operator secret', async () => {
    const { existsSync, readFileSync, rmSync } = await import('node:fs');
    const dir = await scratch();
    try {
      const keyFile = join(dir, 'receipt-key.pem');
      const result = await runWith({ FRONTERA_REFERENCE_WITNESS_KEY_FILE: keyFile }, '--witness-only');
      assert.equal(result.status, 0, result.stderr);
      const names = [...result.stdout.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
      assert.deepEqual(names, ['AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY']);
      assert.equal(/PRIVATE KEY|SIGNING_KEY/.test(result.stdout), false, 'no private key and no authority key is printed');
      assert.ok(existsSync(keyFile) && readFileSync(keyFile, 'utf8').includes('PRIVATE KEY'), 'the witness private key stays on the witness machine');
      assert.equal((await runWith({ FRONTERA_REFERENCE_WITNESS_KEY_FILE: keyFile }, '--witness-only')).status, 1, 'never a second witness key');
      assert.equal((await runWith({ FRONTERA_REFERENCE_WITNESS_KEY_FILE: join(dir, 'other.pem') }, '--witness-only', '--secret', 'FRONTERA_OPERATOR_KEY_ADMIN')).status, 1, 'operator secrets belong to the Host');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--authority-only prints the signing key, verification set and operator secrets, no witness material, and refuses a second run', async () => {
    const { existsSync, rmSync } = await import('node:fs');
    const dir = await scratch();
    try {
      const marker = join(dir, '.authority-initialized');
      const result = await runWith({ FRONTERA_AUTHORITY_INIT_MARKER: marker }, '--authority-only', '--secret', 'FRONTERA_OPERATOR_KEY_ADMIN');
      assert.equal(result.status, 0, result.stderr);
      const names = [...result.stdout.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
      assert.deepEqual(names, ['AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID', 'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM', 'AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS', 'FRONTERA_OPERATOR_KEY_ADMIN']);
      assert.equal(/FRESHNESS|WITNESS/.test(result.stdout), false, 'no witness material');
      assert.ok(existsSync(marker));
      const again = await runWith({ FRONTERA_AUTHORITY_INIT_MARKER: marker }, '--authority-only');
      assert.equal(again.status, 1);
      assert.equal(again.stdout, '');
      assert.equal((await runWith({}, '--authority-only')).status, 1, 'the marker is required');
      assert.equal((await runWith({ FRONTERA_AUTHORITY_INIT_MARKER: join(dir, 'm2') }, '--authority-only', '--witness-only')).status, 1, 'modes are exclusive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
