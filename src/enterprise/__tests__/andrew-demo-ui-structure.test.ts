import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ANDREW-DEMO-UI-01 — the visual demo is tooling, not runtime, and its
 * browser side holds no governance and no secret.
 *
 * It lives in `tools/andrew-demo-ui`, outside `src/`, `packages/` and `apps/`,
 * is not a workspace, is not referenced by the root build, is not on any root
 * test glob, and runs only through the explicit `demo:andrew:ui*` /
 * `test:andrew-demo-ui` scripts. Its server binds to loopback only; its
 * rehearsal never reads the secrets file; its browser code talks to its own
 * backend only.
 */

const TOOL = 'tools/andrew-demo-ui';

function walk(dir: string, accept: (file: string) => boolean): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!['node_modules', 'dist', 'dist-test'].includes(name)) out.push(...walk(full, accept));
    } else if (accept(full)) out.push(full.split('\\').join('/'));
  }
  return out;
}
/** Source with comments removed, so prose never satisfies or violates a rule. */
const codeOf = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
const imports = (file: string): readonly string[] => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1] ?? '');
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly workspaces: readonly string[]; readonly scripts: Readonly<Record<string, string>> };

describe('ANDREW-DEMO-UI-01 — the visual demo stays outside the product', () => {
  it('exists where expected: backend, browser client and the opt-in entry script', () => {
    for (const file of ['src/controller.ts', 'src/dto.ts', 'src/execution-gate.ts', 'src/rehearsal-ledger.ts', 'src/server.ts', 'src/main.ts', 'web/app.ts', 'web/index.html', 'web/styles.css']) assert.ok(existsSync(join(TOOL, file)), file);
    assert.ok(existsSync('scripts/andrew-demo-ui.mjs'));
  });

  it('no product source (src, packages, apps) imports it', () => {
    const importers = [...walk('src', (f) => /\.tsx?$/.test(f)), ...walk('packages', (f) => /\.(tsx?|mjs)$/.test(f)), ...walk('apps', (f) => /\.(tsx?|mjs)$/.test(f))].filter((file) => imports(file).some((specifier) => /andrew-demo-ui/.test(specifier)));
    assert.deepEqual(importers, []);
  });

  it('is not built, tested or started by default; only its three explicit scripts invoke it', () => {
    assert.equal(manifest.workspaces.some((pattern) => pattern.startsWith('tools')), false);
    for (const config of ['tsconfig.json', 'tsconfig.src.json']) assert.equal(readFileSync(config, 'utf8').includes('tools/'), false, config);
    const invokers = Object.entries(manifest.scripts).filter(([, command]) => /andrew-demo-ui/.test(command)).map(([name]) => name).sort();
    assert.deepEqual(invokers, ['demo:andrew:ui', 'demo:andrew:ui:live', 'test:andrew-demo-ui']);
    assert.match(manifest.scripts['demo:andrew:ui:live'] ?? '', /--live$/);
    assert.equal(/--live/.test(manifest.scripts['demo:andrew:ui'] ?? ''), false, 'the default command is the rehearsal');
  });

  it('the server binds to 127.0.0.1 only, and every route is fixed (no generic command, no path parameter)', () => {
    const server = codeOf(join(TOOL, 'src', 'server.ts'));
    assert.match(server, /DEMO_UI_HOST = '127\.0\.0\.1'/);
    assert.equal(/0\.0\.0\.0|'::'|\blisten\([^)]*process\.env/.test(server), false);
    assert.match(server, /server\.listen\(options\.port \?\? DEMO_UI_DEFAULT_PORT, DEMO_UI_HOST/);
    assert.equal(/child_process|exec\(|spawn\(/.test(server), false);
  });

  it('the rehearsal never reads the secrets file or the environment, and the backend reads no process.env', () => {
    const rehearsal = codeOf(join(TOOL, 'src', 'rehearsal-ledger.ts'));
    assert.equal(/loadDemoConfiguration|testnet\.env|readFileSync|process\.env/.test(rehearsal), false);
    for (const file of walk(join(TOOL, 'src'), (f) => f.endsWith('.ts') && !f.includes('__tests__'))) assert.equal(/process\.env/.test(codeOf(file)), false, `${file} reads process.env`);
  });

  it('the browser client imports nothing, talks only to its own /api, and names no secret, network endpoint or storage', () => {
    const app = codeOf(join(TOOL, 'web', 'app.ts'));
    assert.deepEqual(imports(join(TOOL, 'web', 'app.ts')), []);
    for (const match of app.matchAll(/fetch\(\s*([^,)]+)/g)) assert.match(match[1] ?? '', /^(path|'\/api\/status')$/, `fetch(${match[1]})`);
    assert.equal(/wss?:\/\/|https?:\/\/|SEED|seed|\bsecret\b|privateKey|localStorage|sessionStorage|indexedDB|eval\(|new Function/.test(app), false);
    const html = readFileSync(join(TOOL, 'web', 'index.html'), 'utf8');
    assert.equal(/https?:\/\//.test(html), false, 'no external asset');
  });

  it('the entry script forwards only non-secret overrides and never logs a secret', () => {
    const script = readFileSync('scripts/andrew-demo-ui.mjs', 'utf8');
    assert.deepEqual([...new Set([...script.matchAll(/process\.env\.([A-Z_]+)/g)].map((match) => match[1]))].sort(), ['FRONTERA_ANDREW_LIVE_AMOUNT_USD', 'FRONTERA_ANDREW_SECRETS_FILE', 'FRONTERA_ANDREW_STATE_ROOT', 'FRONTERA_ANDREW_UI_PORT', 'FRONTERA_XRPL_TESTNET_ENDPOINT']);
    assert.equal(/console\.|SEED/.test(script), false);
  });

  it('holds no Mainnet endpoint, seed or key material', () => {
    for (const file of walk(TOOL, (f) => /\.(ts|json|md|html|css)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/\bs[1-9A-HJ-NP-Za-km-z]{28,30}\b/.test(text), false, `${file} holds a seed-shaped value`);
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), false, `${file} holds a private key`);
      // The UI tests name Mainnet endpoints on purpose: to prove they are refused.
      if (!file.includes('__tests__')) assert.equal(/wss?:\/\/(s1|s2)\.ripple\.com|xrplcluster\.com/.test(text), false, `${file} names a Mainnet endpoint`);
    }
  });
});
