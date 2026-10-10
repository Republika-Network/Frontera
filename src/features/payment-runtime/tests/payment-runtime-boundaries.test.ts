import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the payment runtime is allowed to be, enforced structurally (PAY-01,
 * P15 — rail neutrality):
 *
 * - a vertical **over** the core: it imports only the generic feature
 *   primitives it composes, and nothing in Frontera's core imports it;
 * - rail-neutral: no rail, network, asset-issuance, custody or environment
 *   vocabulary in its production code;
 * - no custody: no key, signer or recovery-phrase handling, no crypto import;
 * - no I/O, no clock, no number conversion of money.
 *
 * The forbidden-word lists below are the one place those words appear in this
 * module, and they appear in order to be refused.
 */

const ROOT = 'src/features/payment-runtime';

function walk(dir: string, includeTests: boolean): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__' || name === 'fixtures')) continue;
      out.push(...walk(full, includeTests));
    } else if (full.endsWith('.ts') && (includeTests || !full.endsWith('.test.ts'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The PAY-01 contract: everything in the vertical except `rails/`. A rail is
 * the provider-specific code this contract exists to keep out of it, so a
 * rail directory is held to its own, stricter boundary test instead
 * (`rails/xrpl/tests/xrpl-rail-boundaries.test.ts`, PAY-02) — and the contract
 * is proven here never to import one.
 */
const RAILS = join(ROOT, 'rails');
const PRODUCTION_SOURCES = walk(ROOT, false).filter((file) => !file.startsWith(`${RAILS}/`));

function importsOf(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Comments stripped, string literals kept: a forbidden word in prose explaining the boundary is fine; one in code is not. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('Payment runtime boundaries (PAY-01)', () => {
  it('has production sources to check', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 9, `found ${PRODUCTION_SOURCES.length}`);
  });

  it('the contract never imports a rail: rails depend on the contract, never the reverse', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const specifier of importsOf(file)) assert.equal(/rails\//.test(specifier), false, `${file} imports '${specifier}'`);
    }
  });

  it('imports only itself and the generic primitives it composes — never the enterprise layer, the Kernel, a store or Node', () => {
    const allowed = /^(?:\.\/|\.\.\/domain\/|\.\.\/\.\.\/(?:execution-runtime|monetary-runtime|governed-parameter-runtime)\/index\.js$)/;
    for (const file of PRODUCTION_SOURCES) {
      for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
    }
  });

  it('nothing in Frontera core imports the payment runtime — except the PAY-03 composition edge', () => {
    // PAY-03: the shipped Host composes the XRPL rail from configuration. That
    // composition lives in one directory at the enterprise edge; the Kernel, the
    // runtimes, the stores and every other enterprise module stay payment-free.
    const COMPOSITION_EDGE = join('src/enterprise', 'xrpl-payment-rail');
    const roots = ['src/kernel', 'src/runtime', 'src/enterprise', 'src/kernel-host', 'src/control-plane-web'];
    const features = readdirSync('src/features').filter((name) => name !== 'payment-runtime').map((name) => join('src/features', name));
    const files = [...roots, ...features].flatMap((root) => walk(root, false));
    for (const file of files.filter((path) => !path.startsWith(COMPOSITION_EDGE))) {
      assert.equal(/payment-runtime/.test(readFileSync(file, 'utf8')), false, `${file} must not depend on the payment vertical`);
    }
    assert.ok(files.some((path) => path.startsWith(COMPOSITION_EDGE) && /payment-runtime/.test(readFileSync(path, 'utf8'))), 'the composition edge is where the Host composes the rail');
  });

  it('names no rail, network, asset-issuance, custody or environment — the contract is rail-neutral', () => {
    const forbidden = [
      /xrpl?\b/i,
      /rlusd/i,
      /lightning/i,
      /\blnd\b/i,
      /bolt11/i,
      /trust_?line/i,
      /\bissuer\b/i,
      /destination_?tag/i,
      /\bsequence\b/i,
      /\bledger\b/i,
      /tesSUCCESS/,
      /\bwallet\b/i,
      /\btestnet\b/i,
      /\bmainnet\b/i,
      /\bstripe\b/i,
      /\bmpp\b/i,
      /x402/i,
      /\bblockchain\b/i,
      /\bnonce\b/i,
      /\btx_?hash\b|transactionHash/i,
      /\blumx\b/i,
      /andrew/i,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('holds no custody: no crypto, no signing, no key or recovery-phrase handling', () => {
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/node:crypto|from 'crypto'/, /\bsign\s*\(/, /createSign|createPrivateKey|generateKeyPair/, /\bmnemonic\s*[:=(]/i, /\bprivateKey\s*[:=(]/, /\bseed\s*[:=(]/i]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('performs no I/O, reads no clock and never turns money into a number', () => {
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/\bfetch\s*\(/, /\bnode:/, /\bDate\.now\s*\(|new Date\s*\(/, /setTimeout|setInterval/, /parseFloat\s*\(/, /parseInt\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/, /toFixed\s*\(/, /\bNumber\s*\(/, /\beval\s*\(|new Function\s*\(/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('defines no second governance engine, grant, approval or resolution path', () => {
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/\bevaluate\s*\(/, /issueGrant|createBoundedGrant|KernelGrantCapability/, /\bapprove\s*\(|ApprovalRequirement/, /reconcile\s*\(|recordOperatorResolution|ExecutionResolution/, /\bretry\b/i]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('the rail is invoked from exactly one place, after preparation', () => {
    const invokers = PRODUCTION_SOURCES.filter((file) => /\binvoke\s*\(|\.execute\s*\(/.test(codeOf(file)) && !file.endsWith('index.ts'));
    assert.deepEqual(invokers, [join(ROOT, 'services', 'payment-rail-execution-adapter.ts')]);
    const bridge = codeOf(join(ROOT, 'services', 'payment-rail-execution-adapter.ts'));
    assert.ok(bridge.indexOf('preparePaymentExecution(action') < bridge.indexOf('await invoke('), 'preparation precedes the one rail invocation');
  });
});
