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
