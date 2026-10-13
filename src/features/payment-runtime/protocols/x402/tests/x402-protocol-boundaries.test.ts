import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the x402 protocol adapter is allowed to be, enforced structurally
 * (PAY-08):
 *
 * - **a protocol, not a rail** — it imports only itself, PAY-01's domain and
 *   P9; never a rail, MPP, the enterprise layer, the Kernel, a store or Node;
 *   and neither a rail nor MPP imports it;
 * - **network-neutral** — it names no network, ledger, wallet or rail: a
 *   network is understood only through a trusted binding composed for it;
 * - **pure** — no I/O, no clock, no randomness, no crypto, no dependency;
 * - **not authority, not execution, not a facilitator** — no grant, decision,
 *   approval, ceiling, execution, submission, signing, verify / settle call or
 *   retry vocabulary in code;
 * - **no money as a number** — amounts stay text end to end;
 * - **off every published surface** — no package export; no Host or core
 *   module names it.
 */

const X402_DIR = 'src/features/payment-runtime/protocols/x402';
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

const PRODUCTION = walk(X402_DIR, false);

describe('PAY-08 — the x402 adapter is a protocol, not a rail', () => {
  it('has production sources to check', () => {
    assert.deepEqual(PRODUCTION.map((file) => file.slice(X402_DIR.length + 1)).sort(), ['index.ts', 'x402-codec.ts', 'x402-messages.ts', 'x402-payment-adapter.ts']);
  });

  it('imports only itself, PAY-01’s domain and P9 — never a rail, MPP, the enterprise layer, the Kernel, a store, Node or a dependency', () => {
    const allowed = /^(?:\.\/[a-z0-9-]+\.js|\.\.\/\.\.\/domain\/index\.js|\.\.\/\.\.\/\.\.\/monetary-runtime\/index\.js)$/;
    for (const file of PRODUCTION) {
      for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
    }
  });

  it('x402 does not import MPP and MPP does not import x402; no rail and no PAY-01 contract file imports x402', () => {
    // Import specifiers, not words: the boundary tests themselves name each protocol in order to refuse it.
    for (const file of walk(X402_DIR, true)) for (const specifier of importsOf(file)) assert.equal(/mpp/.test(specifier), false, `${file} imports '${specifier}'`);
    for (const file of walk(join(PAYMENT_ROOT, 'protocols', 'mpp'), true)) for (const specifier of importsOf(file)) assert.equal(/x402/.test(specifier), false, `${file} imports '${specifier}'`);
    const others = walk(PAYMENT_ROOT, true).filter((file) => !file.startsWith(`${PAYMENT_ROOT}/protocols/`));
    assert.ok(others.length > 10);
    for (const file of others) for (const specifier of importsOf(file)) assert.equal(/x402/.test(specifier), false, `${file} imports '${specifier}'`);
    for (const file of walk(join(PAYMENT_ROOT, 'rails'), false)) assert.equal(/x402/i.test(codeOf(file)), false, `${file}: a rail names no protocol`);
  });

  it('names no network, rail, ledger, wallet, signer or facilitator endpoint in its production code', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/xrpl?\b/i, /rlusd/i, /lightning/i, /bolt11/i, /lnbtc/i, /\beip155\b/i, /\bsolana\b/i, /\bbase\b/i, /\bethereum\b/i, /\bevm\b/i, /\bissuer\b/i, /\bledger\b/i, /\bwallet\b/i, /\bsigner\b/i, /\bmpp\b/i, /\bstripe\b/i, /\btestnet\b/i, /\bmainnet\b/i, /\/verify\b|\/settle\b/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });
});

describe('PAY-08 — the x402 adapter is pure', () => {
  it('performs no I/O, reads no clock, draws no randomness and holds no crypto', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/\bfetch\s*\(/, /\bnode:/, /\brequire\s*\(/, /\bDate\.now\s*\(|new Date\s*\(|Date\.parse\s*\(/, /performance\.now/, /Math\.random|randomUUID|randomBytes/, /setTimeout|setInterval|setImmediate/, /createHash|createHmac|createSign|subtle/, /\bprocess\./, /\beval\s*\(|new Function\s*\(/, /\bBuffer\b/, /XMLHttpRequest|WebSocket|http\.request|https\.request/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('never turns money into a number', () => {
    for (const file of PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/parseFloat\s*\(/, /parseInt\s*\(/, /\bNumber\s*\(/, /toFixed\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/, /\bBigInt\s*\(/, /JSON\.parse\s*\(/]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('PAY-08 — the x402 adapter is neither authority, execution nor a facilitator', () => {
  it('defines no grant, decision, approval, ceiling, execution, submission, signature, settlement or retry', () => {
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
        /\bsettle\w*\s*\(|\bverify\w*\s*\(/,
        /\bretry|retries|resubmit|resend/i,
        /\bceiling|spendingLimit|budget/i,
        /privateKey|secretKey|mnemonic|\bseed\b/i,
      ]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('is on no published surface: no package export, and no Host, core or non-edge enterprise module names it', () => {
    const packageJson = readFileSync('package.json', 'utf8');
    assert.equal(/protocols\/x402|x402/i.test(packageJson), false);
    const outside = ['src/kernel', 'src/runtime', 'src/kernel-host', 'src/control-plane-web', 'src/enterprise', 'src/index.ts']
      .flatMap((root) => (root.endsWith('.ts') ? [root] : walk(root, false)))
      .filter((file) => !file.startsWith('src/enterprise/x402-payment-protocol/'));
    for (const file of outside) assert.equal(/protocols\/x402|createX402PaymentProtocolAdapter/.test(readFileSync(file, 'utf8')), false, file);
  });
});
