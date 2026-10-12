import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the MPP protocol adapter is allowed to be, enforced structurally
 * (PAY-04, M39, M40):
 *
 * - **a protocol, not a rail** — it imports only itself, PAY-01's domain and
 *   P9; never a rail, the enterprise layer, the Kernel, a store or Node; and no
 *   rail imports it;
 * - **pure** — no I/O, no clock, no randomness, no crypto, no dependency;
 * - **not authority and not execution** — no grant, decision, approval,
 *   ceiling, execution, submission, signing, credential construction or retry
 *   vocabulary in code;
 * - **no money as a number** — amounts stay text end to end;
 * - **off every published surface** — no package export, no Host or core
 *   module names it.
 */

const MPP_DIR = 'src/features/payment-runtime/protocols/mpp';
const PAYMENT_ROOT = 'src/features/payment-runtime';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

function walk(dir: string, includeTests: boolean): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__' || name === 'fixtures')) continue;
      out.push(...walk(full, includeTests));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(full) && !full.endsWith('.d.ts') && (includeTests || !full.includes('.test.'))) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped, string literals kept. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/\b(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1] ?? '');
}

const PRODUCTION = walk(MPP_DIR, false);

describe('PAY-04 — the MPP adapter is a protocol, not a rail (M40)', () => {
  it('has production sources to check', () => {
    assert.deepEqual(PRODUCTION.map((file) => file.slice(MPP_DIR.length + 1)).sort(), ['index.ts', 'mpp-challenge.ts', 'mpp-grammar.ts', 'mpp-payment-adapter.ts']);
  });

  it('imports only itself, PAY-01’s domain and P9 — never a rail, the enterprise layer, the Kernel, a store, Node or a dependency', () => {
    const allowed = /^(?:\.\/[a-z-]+\.js|\.\.\/\.\.\/domain\/index\.js|\.\.\/\.\.\/\.\.\/monetary-runtime\/index\.js)$/;
    for (const file of PRODUCTION) {
      for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
    }
  });

  it('no rail and no rail test imports a protocol adapter; the PAY-01 contract and services import none either', () => {
    const others = walk(PAYMENT_ROOT, true).filter((file) => !file.startsWith(`${PAYMENT_ROOT}/protocols/`));
    assert.ok(others.length > 10);
    for (const file of others) assert.equal(/protocols\//.test(codeOf(file)), false, `${file} must not depend on a protocol adapter`);
  });

  it('names no rail, network, issuer, signer, wallet or ledger in its production code — MPP → XRPL is not a law', () => {
    for (const file of PRODUCTION) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/xrpl?\b/i, /rlusd/i, /lightning/i, /bolt11/i, /\bissuer\b/i, /\bledger\b/i, /\bwallet\b/i, /\bsigner\b/i, /\bstripe\b/i, /\bevm\b/i, /x402/i, /\btestnet\b/i, /\bmainnet\b/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });
});

describe('PAY-04 — the MPP adapter is pure', () => {
  it('performs no I/O, reads no clock, draws no randomness and holds no crypto', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/\bfetch\s*\(/, /\bnode:/, /\brequire\s*\(/, /\bDate\.now\s*\(|new Date\s*\(|Date\.parse\s*\(/, /performance\.now/, /Math\.random|randomUUID|randomBytes/, /setTimeout|setInterval|setImmediate/, /createHash|createHmac|createSign|subtle/, /\bprocess\./, /\beval\s*\(|new Function\s*\(/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('never turns money into a number', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/parseFloat\s*\(/, /parseInt\s*\(/, /\bNumber\s*\(/, /toFixed\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('PAY-04 — the MPP adapter is neither authority nor execution (M37, M38)', () => {
  it('defines no grant, decision, approval, ceiling, execution, submission, signature, credential or retry', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [
        /\bevaluate\s*\(/,
        /issueGrant|createBoundedGrant|KernelGrantCapability/,
        /\bapprove\s*\(/,
        /\.execute\s*\(|\bexecute\s*:/,
        /\bsubmit\w*\s*\(/,
        /\bsign\s*\(/,
        /\bgovern\s*\(/,
        /buildCredential|createCredential|Authorization:\s/,
        /\bretry|retries|resubmit|resend/i,
        /\bceiling|spendingLimit|budget/i,
      ]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('is on no published surface: no package export, and no Host, core or enterprise module names it', () => {
    const packageJson = readFileSync('package.json', 'utf8');
    assert.equal(/protocols\/mpp|payment-runtime/.test(packageJson), false);
    const outside = ['src/kernel', 'src/runtime', 'src/kernel-host', 'src/control-plane-web', 'src/enterprise', 'src/index.ts'].flatMap((root) => (root.endsWith('.ts') ? [root] : walk(root, false)));
    for (const file of outside) assert.equal(/protocols\/mpp|createMppPaymentProtocolAdapter/.test(readFileSync(file, 'utf8')), false, file);
  });
});
