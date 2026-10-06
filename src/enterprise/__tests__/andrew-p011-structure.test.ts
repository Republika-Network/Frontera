import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ANDREW-P0-11 — the demo harness is tooling, not runtime.
 *
 * It lives in `tools/andrew-demo-harness`, outside `src/`, `packages/` and
 * `apps/` (so the P0-07 rule "no production source outside the demo imports the
 * Andrew demo" holds unchanged), is not a workspace, is not referenced by the
 * root build, is not on any test glob, and runs only through the explicit
 * `demo:andrew*` / `test:andrew-demo` scripts. Its core receives the XRPL
 * transport by injection; only `live-wiring.ts` binds the real one.
 */

const TOOL = 'tools/andrew-demo-harness';

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

describe('ANDREW-P0-11 — the demo harness stays outside the product', () => {
  it('exists where expected, with its core, its live wiring and the opt-in entry script', () => {
    for (const file of ['contracts.ts', 'configuration.ts', 'preflight.ts', 'run-infrastructure.ts', 'scenarios.ts', 'presentation.ts', 'report.ts', 'secret-guard.ts', 'demo.ts', 'live-wiring.ts']) assert.ok(existsSync(join(TOOL, 'src', file)), file);
    assert.ok(existsSync('scripts/run-andrew-demo.mjs'));
  });

  it('no product source (src, packages, apps) imports the harness', () => {
    const importers = [...walk('src', (f) => /\.tsx?$/.test(f)), ...walk('packages', (f) => /\.(tsx?|mjs)$/.test(f)), ...walk('apps', (f) => /\.(tsx?|mjs)$/.test(f))].filter((file) => imports(file).some((specifier) => /andrew-demo-harness|run-andrew-demo/.test(specifier)));
    assert.deepEqual(importers, []);
  });

  it('is not built, tested or started by default: no workspace, no build reference, no root test glob', () => {
    assert.equal(manifest.workspaces.some((pattern) => pattern.startsWith('tools')), false);
    for (const config of ['tsconfig.json', 'tsconfig.src.json']) assert.equal(readFileSync(config, 'utf8').includes('tools/'), false, config);
    const invokers = Object.entries(manifest.scripts).filter(([, command]) => /andrew-demo-harness|run-andrew-demo/.test(command)).map(([name]) => name).sort();
    assert.deepEqual(invokers, ['demo:andrew', 'demo:andrew:preflight', 'test:andrew-demo']);
    for (const name of ['test', 'test:root', 'build', 'typecheck', 'start:enterprise', 'validate:publishability']) assert.equal(/andrew/.test(manifest.scripts[name] ?? ''), false, name);
  });

  it('its core never imports the transport package, xrpl or a test fixture — only live-wiring binds the real Testnet', () => {
    const core = walk(join(TOOL, 'src'), (f) => f.endsWith('.ts') && !f.includes('__tests__'));
    for (const file of core) {
      for (const specifier of imports(file)) {
        assert.equal(/__tests__|fixture/.test(specifier), false, `${file} imports ${specifier}`);
        if (!file.endsWith('/live-wiring.ts')) assert.equal(/xrpl-testnet-transport|^xrpl$/.test(specifier), false, `${file} imports ${specifier}`);
      }
      assert.equal(/process\.env/.test(codeOf(file)), false, `${file} reads process.env`);
    }
  });

  it('the entry script forwards only the four non-secret overrides and never logs a secret', () => {
    const script = readFileSync('scripts/run-andrew-demo.mjs', 'utf8');
    assert.deepEqual([...new Set([...script.matchAll(/process\.env\.([A-Z_]+)/g)].map((match) => match[1]))].sort(), ['FRONTERA_ANDREW_LIVE_AMOUNT_USD', 'FRONTERA_ANDREW_SECRETS_FILE', 'FRONTERA_ANDREW_STATE_ROOT', 'FRONTERA_XRPL_TESTNET_ENDPOINT']);
    assert.equal(/console\.|SEED/.test(script), false);
    assert.equal(/\b(intercept|observer)\s*:/.test(script), false, 'the live command never sets a test seam');
  });

  it('defaults to the XRPL Testnet endpoint and holds no Mainnet endpoint, seed or key material', () => {
    const configuration = readFileSync(join(TOOL, 'src', 'configuration.ts'), 'utf8');
    assert.match(configuration, /XRPL_TESTNET_ENDPOINT = 'wss:\/\/s\.altnet\.rippletest\.net:51233\/'/);
    for (const file of walk(TOOL, (f) => /\.(ts|json|md)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/\bs[1-9A-HJ-NP-Za-km-z]{28,30}\b/.test(text), false, `${file} holds a seed-shaped value`);
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), false, `${file} holds a private key`);
      // The harness tests name a Mainnet endpoint on purpose: to prove it is refused.
      if (!file.includes('__tests__')) assert.equal(/wss?:\/\/(s1|s2)\.ripple\.com|xrplcluster\.com/.test(text.replace(/MAINNET_HOSTS = \[[^\]]*\]/, '')), false, `${file} names a Mainnet endpoint`);
    }
  });
});
