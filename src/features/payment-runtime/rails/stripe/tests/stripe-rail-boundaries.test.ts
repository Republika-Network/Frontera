import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the Stripe rail is allowed to be, enforced structurally (PAY-09):
 *
 * - it depends on PAY-01's contract and the generic runtimes it reads — never
 *   on the enterprise layer, the Kernel, a store, the XRPL or Lightning rail, a
 *   network module or a Stripe SDK; and they never depend on it;
 * - `stripe.confirmPaymentIntent` — the one money-moving request — is called
 *   from exactly one place, after the reservation, the creation and the
 *   binding; there is no retry, resend or replay vocabulary;
 * - it handles no card data and no client secret, and holds no credential;
 * - it never turns money into a floating-point number;
 * - it ships no endpoint and is off every published surface.
 */

const RAIL_DIR = 'src/features/payment-runtime/rails/stripe';
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
    } else if (/\.(?:ts|mjs|js)$/.test(full) && !full.endsWith('.d.ts') && (includeTests || !full.includes('.test.'))) {
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

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)].map((match) => match[1] ?? match[2] ?? '');

const RAIL_PRODUCTION = walk(RAIL_DIR, false);

describe('PAY-09 — Stripe rail dependency boundary', () => {
  it('has production sources to check', () => {
    assert.ok(RAIL_PRODUCTION.length >= 10, `found ${RAIL_PRODUCTION.length}`);
  });

  it('imports only itself, PAY-01’s domain, the generic runtimes and node:crypto — no Stripe SDK, no network module', () => {
    const allowed = /^(?:\.\/[a-z0-9-]+\.js|\.\.\/\.\.\/domain\/index\.js|\.\.\/\.\.\/\.\.\/(?:execution-runtime|monetary-runtime)\/index\.js|node:crypto)$/;
    for (const file of RAIL_PRODUCTION) for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
  });

  it('the Stripe, XRPL and Lightning rails never import each other', () => {
    for (const file of RAIL_PRODUCTION) assert.equal(importsOf(file).some((specifier) => /xrpl|lightning/.test(specifier)), false, file);
    for (const other of ['xrpl', 'lightning']) {
      for (const file of walk(join(PAYMENT_ROOT, 'rails', other), true)) assert.equal(importsOf(file).some((specifier) => /stripe/.test(specifier)), false, file);
    }
  });

  it('PAY-01’s contract (domain, services, barrel) neither imports the Stripe rail nor names Stripe', () => {
    const contract = walk(PAYMENT_ROOT, false).filter((file) => !file.startsWith(`${PAYMENT_ROOT}/rails/`) && !file.split('/').includes('protocols'));
    assert.ok(contract.length >= 9);
    for (const file of contract) assert.equal(/rails\/stripe|stripe/i.test(codeOf(file)) || /payment_intent|client_?secret/.test(codeOf(file)), false, `${file} names Stripe`);
    assert.equal(/stripe/i.test(readFileSync(`${PAYMENT_ROOT}/index.ts`, 'utf8')), false, 'the payment barrel does not export the rail');
  });
});

describe('PAY-09 — the one confirmation', () => {
  it('stripe.confirmPaymentIntent is called from exactly one place, after the reservation, the creation and the binding', () => {
    const callers = RAIL_PRODUCTION.filter((file) => /\.confirmPaymentIntent\s*\(/.test(codeOf(file)));
    assert.deepEqual(callers, [`${RAIL_DIR}/stripe-rail.ts`]);
    const rail = codeOf(`${RAIL_DIR}/stripe-rail.ts`);
    assert.equal([...rail.matchAll(/\bstripe\.confirmPaymentIntent\s*\(/g)].length, 1);
    assert.equal([...rail.matchAll(/\bstripe\.createPaymentIntent\s*\(/g)].length, 1);
    const ordered = (body: string, markers: readonly string[]): void => {
      const positions = markers.map((marker) => body.indexOf(marker));
      for (const [index, position] of positions.entries()) assert.notEqual(position, -1, String(markers[index]));
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, markers.join(' → '));
    };
    const execute = rail.slice(rail.indexOf('async function execute('), rail.indexOf('async function readiness('));
    ordered(execute, ['prepare(request)', 'interlock.recorded(request.executionId)', 'checkAccount()', 'interlock.reserve(record)', 'stripe.createPaymentIntent(', 'interlock.bind(request.executionId, paymentIntentId)', 'confirmOnce(request, record, paymentIntentId)']);
    const confirm = rail.slice(rail.indexOf('async function confirmOnce('), rail.indexOf('async function execute('));
    ordered(confirm, ['stripe.confirmPaymentIntent(', 'readStripePaymentIntentView(answer)', 'concludeStripePayment(view,']);
  });

  it('no retry, resend or replay vocabulary in the rail’s production code', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/\bretry|retries\b/i, /\bresubmit|\bre-submit|\bresend|\bre-send|\breplay/i, /\bfor\s*\([^)]*attempt/i, /maxNetworkRetries/]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('the rail opens no connection and ships no endpoint: no network module, no fetch, no URL literal', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      assert.equal(/from\s+['"]node:(?:https?|net|tls|dns|http2|dgram)['"]|\bfetch\s*\(/.test(code), false, file);
      assert.equal(/['"`](?:wss?|https?):\/\//.test(code), false, file);
      assert.equal(/from\s+['"]stripe['"]|require\(\s*['"]stripe['"]\s*\)|new\s+Stripe\s*\(/.test(code), false, `${file} must not reach the Stripe SDK`);
    }
  });
});

describe('PAY-09 — PCI and secret hygiene in the rail', () => {
  it('no raw card data vocabulary: no PAN, card number, expiry, CVC or bank credentials in production code', () => {
    const CARD = /card_?number|cardNumber|\bpan\b|\bcvc\b|\bcvv\b|exp_?month|exp_?year|expiry_?month|expiry_?year|expMonth|expYear|routing_?number|account_?number|iban\b/i;
    for (const file of RAIL_PRODUCTION) assert.equal(CARD.test(codeOf(file)), false, file);
  });

  it('no client secret is read, stored or returned: the identifier grammar refuses one, and no code names the field', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file).replace(/'_secret_'/g, '');
      assert.equal(/client_?secret|clientSecret/i.test(code), false, file);
    }
  });

  it('no credential vocabulary: API keys and webhook secrets live in the enterprise adapter only', () => {
    for (const file of RAIL_PRODUCTION) assert.equal(/sk_test|sk_live|rk_test|rk_live|whsec|apiKey|authorization|bearer/i.test(codeOf(file)), false, file);
  });

  it('never turns money into a float: no parseFloat, Number(), Math rounding, toFixed or arithmetic on Number amounts', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/parseFloat\s*\(/, /\bNumber\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/, /toFixed\s*\(/, /parseInt\s*\(/, /\*\s*100\b(?!n)/, /\/\s*100\b(?!n)/]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('PAY-09 — published surface', () => {
  it('no package entrypoint reaches the Stripe rail', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown; readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> };
    assert.equal(JSON.stringify(pkg.exports ?? {}).includes('stripe'), false);
    for (const root of ['src/index.ts', 'src/runtime/index.ts', 'src/enterprise/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(root)) assert.equal(/stripe/i.test(readFileSync(root, 'utf8')), false, root);
    }
  });

  it('the Stripe SDK is not a dependency of Frontera (the adapter is Node’s own https)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> };
    assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).includes('stripe'), false);
  });
});
