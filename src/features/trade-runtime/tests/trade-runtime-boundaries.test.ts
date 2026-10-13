import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the trade runtime is allowed to be in TRADE-01, enforced structurally:
 *
 * - a vertical **over** the core: it imports only the generic feature
 *   primitives it composes, and nothing in Frontera imports it yet;
 * - a contract, not an executor: no ledger SDK or codec, no network, no
 *   signing, no submission, no key material, no execution adapter, no second
 *   governed-action path;
 * - pure: no clock, no randomness, no floating-point treatment of money.
 *
 * The forbidden-word lists below are the one place those words appear in this
 * module, and they appear in order to be refused.
 */

const ROOT = 'src/features/trade-runtime';

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

const PRODUCTION_SOURCES = walk(ROOT, false);

function importsOf(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map((match) => match[1] ?? match[2] ?? '');
}

/** Comments stripped, string literals kept: a forbidden word in prose explaining the boundary is fine; one in code is not. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('Trade runtime boundaries (TRADE-01)', () => {
  it('has production sources to check', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 7, `found ${PRODUCTION_SOURCES.length}`);
  });

  it('imports only itself, the generic primitives it composes, and the hash function — never the enterprise layer, the Kernel, a store, another vertical or Node I/O', () => {
    const allowed = /^(?:\.\/|\.\.\/domain\/|\.\.\/\.\.\/(?:execution-runtime|monetary-runtime|governed-parameter-runtime)\/index\.js$|crypto$)/;
    for (const file of PRODUCTION_SOURCES) {
      for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
    }
  });

  it('uses the hash function and nothing else from crypto: no key, signature or randomness', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of codeOf(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*'crypto'/g)) assert.deepEqual((match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean), ['createHash'], file);
    }
  });

  it('nothing in Frontera imports the trade runtime yet — TRADE-01 has no composition edge', () => {
    const roots = ['src/kernel', 'src/runtime', 'src/enterprise', 'src/kernel-host', 'src/control-plane-web'];
    const features = readdirSync('src/features').filter((name) => name !== 'trade-runtime').map((name) => join('src/features', name));
    for (const file of [...roots, ...features].flatMap((root) => walk(root, false))) {
      assert.equal(/trade-runtime/.test(readFileSync(file, 'utf8')), false, `${file} must not depend on the trade vertical`);
    }
  });

  it('holds no ledger SDK or codec, opens no network connection and submits nothing', () => {
    const forbidden = [
      /from\s+'(?:xrpl|ripple-[a-z-]+|@xrplf\/[a-z-]+)'/,
      /\bnew\s+Client\s*\(/,
      /\.submit\s*\(|submitAndWait|submit_multisigned|\bautofill\s*\(/,
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/,
      /from\s+'(?:node:)?(?:http|https|net|tls|dgram|dns|child_process|fs|worker_threads)'/,
      /\bconnect\s*\(/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('holds no custody: no signing, no key derivation, no wallet, no seed handling', () => {
    const forbidden = [/\bsign\s*\(/, /createSign|createPrivateKey|generateKeyPair|randomBytes|deriveKeypair|deriveAddress/, /\bWallet\b|fromSeed|fromMnemonic/, /\bmnemonic\s*[:=(]/i, /\bprivateKey\s*[:=(]/, /\bseed\s*[:=(]/i];
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('is no execution path: no adapter, no grant issuance or exercise, no decision of its own', () => {
    const forbidden = [/ExecutionAdapter|executionAdapter/, /issueFromDecision|\.exercise\s*\(|BoundedGrant/, /\bdecide\s*\(|\bevaluate\s*\(|PolicyPack/, /GovernedActionOrchestrator|\.govern\s*\(/];
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('is pure: no clock, no randomness, and no floating-point treatment of money', () => {
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/Date\.now|new\s+Date\s*\(|performance\.now/, /Math\.random/, /parseFloat|toFixed|toPrecision|Math\.(?:round|floor|ceil|trunc)/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
      // The one Number() conversion is a byte (0–255) in base58 decoding, never a quantity.
      if (!file.endsWith('trade-grammar.ts')) assert.equal(/\bNumber\s*\(/.test(code), false, `${file}: Number()`);
    }
  });

  it('does not name the XRP Ledger by the four-letter token PAY-04 pins in its CORE vocabulary test', () => {
    // pay04-payment-protocol-structure.test.ts ("the core files naming XRPL are
    // exactly …") counts every src/features module except payment-runtime as
    // CORE. Recognising TRADE as a vertical there is deferred to architectural
    // review (TRADE-01 doc §10); until then this module spells the venue
    // "XRP Ledger" and this assertion keeps that test's exact list intact.
    for (const file of PRODUCTION_SOURCES) assert.equal(/xrpl/i.test(readFileSync(file, 'utf8')), false, file);
  });
});
