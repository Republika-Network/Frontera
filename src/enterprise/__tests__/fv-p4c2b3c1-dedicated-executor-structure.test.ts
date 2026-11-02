import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-1 — the dedicated executor and its supervisor stay isolated and unreachable: nothing in
// the Host, its scripts, its deployment or its package starts them; the supervisor reaches no file; the
// executor has no bootstrap or reconcile command; the production entry composes nothing.

const ROOT = join(__dirname, '..', '..', '..', '..');
const MODULE = join(ROOT, 'src', 'enterprise', 'sovereign-status-history');
const DIST = join(ROOT, 'dist', 'src', 'enterprise', 'sovereign-status-history');
const read = (path: string) => readFileSync(path, 'utf8');
const source = (name: string) => read(join(MODULE, name));

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}

/** Module specifiers a compiled CommonJS file loads at run time. */
const runtimeRequires = (file: string) => [...read(file).matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!).sort();

describe('FV-P4C-2B3C-1 structure — the dedicated executor is isolated and unreachable', () => {
  it('7. nothing outside the module and tests names the executor, its supervisor or its entry: no Host source, script, deployment file, Dockerfile or package script', () => {
    const NAMES = /dedicated-executor|runDedicatedFvExecutor|createFvExecutorSupervisor/;
    const outside = [
      ...walk(join(ROOT, 'src'), (p) => p.endsWith('.ts') && !p.startsWith(MODULE) && !p.includes('__tests__')),
      ...walk(join(ROOT, 'scripts'), (p) => /\.(m?js|ts|sh)$/.test(p)),
      ...walk(join(ROOT, 'deploy'), () => true),
      ...walk(join(ROOT, 'infrastructure'), () => true),
      join(ROOT, 'Dockerfile'),
      join(ROOT, 'package.json'),
    ].filter((file) => existsSync(file) && NAMES.test(read(file)));
    assert.deepEqual(outside.map((f) => relative(ROOT, f)), []);
    assert.equal(/dedicated-executor/.test(source('index.ts')), false, 'not even exported from the module index');
  });

  it('6/28. the supervisor loads nothing that touches a file: only child_process, path and the data-only protocol', () => {
    assert.deepEqual(runtimeRequires(join(DIST, 'dedicated-executor-supervisor.js')), ['./dedicated-executor-protocol.js', 'node:child_process', 'node:path']);
    assert.deepEqual(runtimeRequires(join(DIST, 'dedicated-executor-protocol.js')), [], 'the protocol is data only');
    const text = source('dedicated-executor-supervisor.ts');
    assert.equal(/from '[^']*(better-sqlite3|node:fs|executor-exclusivity|protected-continuity-store|sqlite-status-high-water-mark-store|protected-host-composition)'|openSync|readFileSync|statSync|Database\(/.test(text), false);
    // It starts exactly its configured entry, with no inherited flags or environment.
    assert.match(text, /execArgv: \['--disable-sigusr1'\],/, 'no inherited flags, and no inspector on SIGUSR1 (review M1)');
    assert.match(text, /env: \{\},/);
    assert.equal(/\bspawn\(|\bexec\(|execFile|shell:/.test(text), false, 'no shell, no other command');
  });

  it('41/36. the executor has no bootstrap, decision, reconcile or arbitrary command: its protocol is exactly status and stop', () => {
    const executor = source('dedicated-executor.ts');
    assert.equal(/\.bootstrap\(|beginBootstrapDecision|statusSource/.test(executor), false, 'the runtime never bootstraps and never supplies a status source');
    assert.equal((executor.match(/\.reconcile\(\)/g) ?? []).length, 1, 'one reconciliation, at startup, from evidence only');
    const protocol = source('dedicated-executor-protocol.ts');
    assert.match(protocol, /readonly type: 'status' \| 'stop'; readonly id: string/);
    assert.match(protocol, /if \(record\.type !== 'status' && record\.type !== 'stop'\) return/);
  });

  it('42/43. the production entry composes nothing and reads no environment; no FV executor file loads code by name or reaches a network', () => {
    const main = source('dedicated-executor-main.ts');
    assert.match(main, /compose: undefined,/);
    assert.equal(/process\.env|statusSource|composeFvProtectedHost|import\(|readFileSync/.test(main), false);
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-main.ts', 'dedicated-executor-supervisor.ts', 'dedicated-executor-protocol.ts', 'executor-persistence-contract.ts']) {
      const text = source(name);
      assert.equal(/import\(|require\(\s*[^'"]|node:(http|https|net|tls|dgram|dns|vm)|fetch\(|fileverse|eval\(|new Function/i.test(text), false, name);
    }
  });

  it('the runtime installs its termination contract: process.exit wrapped, a prepended fail-stop exit listener, SIGKILL on authority loss', () => {
    const executor = source('dedicated-executor.ts');
    assert.match(executor, /process\.exit = \(\(code\?: number\) => \{\n\s+if \(!exclusiveConnectionsSafe\(\)\) killNow\(\);/);
    assert.match(executor, /process\.prependListener\('exit', \(\) => \{\n\s+if \(!exclusiveConnectionsSafe\(\)\) killNow\(\);/);
    assert.match(executor, /process\.kill\(process\.pid, 'SIGKILL'\)/);
    assert.match(executor, /typeof process\.send !== 'function' \|\| process\.connected !== true/, 'never in its caller’s process');
  });

  it('PROD-02 (B3C-2 preparation): the portability registry names no FV store, and so opens none', () => {
    const registry = read(join(ROOT, 'scripts', 'portability', 'store-registry.mjs'));
    assert.equal(/sovereign-status-history|fv-protected|status-history|FV_/.test(registry), false);
  });
});
