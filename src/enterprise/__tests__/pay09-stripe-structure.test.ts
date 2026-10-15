import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCoreSourceManifest } from './pay07-core-source-manifest.js';

/**
 * PAY-09 — structural qualification of the Stripe rail and its composition
 * edge: CORE purity, generic-port purity, the one money-moving call site, the
 * read-only authorities, the PCI and secret boundaries, and embedder-only
 * composition.
 */

const EDGE = 'src/enterprise/stripe-payment-rail';
const RAIL = 'src/features/payment-runtime/rails/stripe';
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
    } else if (/\.(?:ts|tsx|mjs|js)$/.test(full) && !full.endsWith('.d.ts') && (includeTests || !full.includes('.test.'))) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped, string literals kept. */
const codeOf = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)].map((match) => match[1] ?? match[2] ?? '');

const EDGE_PRODUCTION = walk(EDGE, false);
const RAIL_PRODUCTION = walk(RAIL, false);
const PAY09_PRODUCTION = [...EDGE_PRODUCTION, ...RAIL_PRODUCTION];
const SRC_PRODUCTION = walk('src', false);

describe('PAY-09 — CORE and generic-port purity', () => {
  it('no CORE source PAY-07 measures names Stripe, PaymentIntent API vocabulary, a client secret or imports Stripe code', () => {
    const paths = buildCoreSourceManifest().entries.map((entry) => entry.path);
    assert.ok(paths.length > 100, `${paths.length}`);
    for (const path of paths) {
      const code = codeOf(path);
      // `payment_intent` / `client_secret` are Stripe's lowercase API spellings; Frontera's own PAYMENT_INTENT_* constants are generic.
      assert.equal(/stripe|\bcus_|\bacct_/i.test(code) || /payment_intent|client_?secret/.test(code), false, path);
      assert.equal(importsOf(path).some((specifier) => /stripe/.test(specifier)), false, path);
    }
  });

  it('the generic payment contract, P11, P12, PAY-05, ASSURE-01 and CORE-07 name no Stripe concept', () => {
    const generic = [
      ...walk('src/features/payment-runtime/domain', false),
      ...walk('src/features/payment-runtime/services', false),
      'src/features/payment-runtime/index.ts',
      ...walk('src/enterprise/execution-outcome-store', false),
      ...walk('src/enterprise/execution-resolution-store', false),
      ...walk('src/enterprise/execution-reconciliation', false),
      ...walk('src/enterprise/payment-settlement', false),
      ...walk('src/enterprise/evidence', false),
      ...walk('src/enterprise/authority-state-freshness', false),
      ...walk('src/features/execution-runtime', false),
    ];
    assert.ok(generic.length > 50);
    for (const file of generic) assert.equal(/stripe|connected.account/i.test(codeOf(file)) || /payment_intent|client_?secret/.test(codeOf(file)), false, file);
  });

  it('CORE-07: PAY-09 adds no anchored state kind — the closed list is unchanged and names no rail word beyond the classified PAY-03 one', () => {
    const checkpoint = codeOf('src/enterprise/authority-state-freshness/checkpoint.ts');
    const kinds = /AUTHORITY_STATE_KINDS = \[\.\.\.AUTHORITY_STORE_KINDS, ([^\]]*)\]/.exec(checkpoint)?.[1];
    // TRADE-04C (G4) added exactly one kind since, the rail-neutral 'trade-sequence-reservations', before PAY-03's; PAY-09 added none.
    assert.equal(kinds, "'trade-sequence-reservations', 'xrpl-submission-reservations', 'payment-business-operation-state', 'payment-refund-state', 'payment-initiation-reservations'");
    assert.match(codeOf(`${EDGE}/sqlite-stripe-payment-interlock.ts`), /PAYMENT_INITIATION_STATE_KIND = 'payment-initiation-reservations'/);
  });

  it('the provider reference stays opaque: no generic layer parses or prefix-checks a PaymentIntent id', () => {
    for (const file of [...walk('src/features/payment-runtime/domain', false), ...walk('src/enterprise/execution-reconciliation', false), ...walk('src/enterprise/payment-settlement', false), ...walk('src/enterprise/evidence', false)]) {
      assert.equal(/['"]pi_['"]|startsWith\(\s*['"]pi_/.test(codeOf(file)), false, file);
    }
  });

  it('destination neutrality: the generic code never compares a destination kind with the Stripe kind', () => {
    for (const file of SRC_PRODUCTION.filter((path) => !path.startsWith(`${RAIL}/`) && !path.startsWith(`${EDGE}/`))) assert.equal(codeOf(file).includes('stripe-connected-account'), false, file);
  });
});

describe('PAY-09 — the edge boundary and the one money-moving request', () => {
  it('the edge imports only the Stripe rail, PAY-01’s barrel, P12’s authority contract, CORE-07, the stores’ shared validators and Node built-ins — never the Stripe SDK, never another rail', () => {
    const allowed = /^(?:\.\/[a-z0-9-]+\.js|\.\.\/\.\.\/features\/payment-runtime\/(?:index|rails\/stripe\/index)\.js|\.\.\/\.\.\/features\/execution-runtime\/index\.js|\.\.\/execution-reconciliation\/authority\.js|\.\.\/authority-state-freshness\/(?:checkpoint|errors|session)\.js|\.\.\/governance-store\/(?:canonical-json|digest)\.js|\.\.\/execution-outcome-store\/validation\.js|node:(?:crypto|fs|path|http|https|net)|better-sqlite3)$/;
    for (const file of EDGE_PRODUCTION) for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
  });

  it('exactly one edge file opens network connections, and it is the only one holding an Authorization header', () => {
    const network = EDGE_PRODUCTION.filter((file) => /from\s+'node:(?:https?|net)'/.test(codeOf(file)));
    assert.deepEqual(network, [`${EDGE}/stripe-https-client.ts`]);
    for (const file of PAY09_PRODUCTION.filter((path) => path !== `${EDGE}/stripe-https-client.ts`)) assert.equal(/authorization|bearer|sk_test|rk_test/i.test(codeOf(file)), false, file);
  });

  it('the HTTPS adapter: one request primitive, the confirmation route written once, the creation sends confirm=false, no retry, no redirect following, the pinned API version on every request', () => {
    const client = codeOf(`${EDGE}/stripe-https-client.ts`);
    assert.equal([...client.matchAll(/\bsend\s*\(/g)].length, 1, 'one request primitive');
    assert.equal([...client.matchAll(/\/confirm`/g)].length, 1, 'the one confirmation route, written once');
    assert.equal([...client.matchAll(/'confirm', 'false'/g)].length, 1, 'creation cannot charge');
    assert.equal(/'off_session'/.test(client.slice(client.indexOf('async createPaymentIntent('), client.indexOf('async confirmPaymentIntent('))), false, 'off_session (a confirmation parameter) is never sent at creation');
    assert.match(client, /'stripe-version': STRIPE_API_VERSION/);
    assert.equal(/\bretry|retries|maxNetworkRetries|followRedirect|maxRedirects/i.test(client), false);
    // What is SENT: every form field the adapter appends, and every path it calls. (It READS on_behalf_of and the fee to refuse objects carrying them.)
    const sent = [...client.matchAll(/form\.append\('([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(sent.filter((field) => /application_fee|on_behalf_of|transfer_data\[amount\]|capture$|payment_method_data|setup_future_usage/.test(field ?? '')), [], 'no fee, no settlement merchant, no transfer amount, no card data, no saved-instrument setup');
    assert.equal(/\/capture|\/cancel|\/refunds|\/transfers|\/payouts/.test(client), false, 'no capture, cancel, refund, transfer or payout route');
    assert.equal(/STRIPE_API_ORIGIN = 'https:\/\/api\.stripe\.com'/.test(client), true);
  });

  it('the P12, finality and webhook modules are read-only: they never reach a creation, a confirmation or a write', () => {
    for (const file of [`${EDGE}/stripe-resolution-authority.ts`, `${EDGE}/stripe-finality-authority.ts`, `${EDGE}/stripe-webhook-signals.ts`]) {
      const code = codeOf(file);
      assert.equal(/createPaymentIntent|confirmPaymentIntent|\.reserve\(|\.bind\(|createStripeApiClient|StripePaymentPort\b/.test(code), false, file);
    }
  });

  it('embedder-composed only: no production source outside the edge composes the HTTPS adapter, the interlock or the authorities; no package export or Host module reaches them', () => {
    for (const symbol of ['createStripeApiClient', 'createStripeApiReader', 'createSqliteStripePaymentInterlock', 'createStripeResolutionAuthority', 'createStripeFinalityAuthority', 'createStripeWebhookSignals', 'createStripeRail']) {
      const users = SRC_PRODUCTION.filter((file) => new RegExp(`\\b${symbol}\\b`).test(codeOf(file)) && !file.startsWith(`${EDGE}/`) && !file.startsWith(`${RAIL}/`));
      assert.deepEqual(users, [], symbol);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown };
    assert.equal(JSON.stringify(pkg.exports ?? {}).includes('stripe'), false);
    for (const root of ['src/enterprise/index.ts', 'src/enterprise/host', 'src/enterprise/composition', 'src/enterprise/configuration', 'src/enterprise/modules']) {
      const files = root.endsWith('.ts') ? [root] : walk(root, false);
      for (const file of files) assert.equal(/stripe-payment-rail|rails\/stripe/.test(codeOf(file)), false, file);
    }
  });
});

describe('PAY-09 — PCI and secret structural proofs', () => {
  it('no PAY-09 production source handles raw card or bank credentials', () => {
    const CARD = /card_?number|cardNumber|\bpan\b|\bcvc\b|\bcvv\b|exp_?month|exp_?year|expiry_?month|expiry_?year|routing_?number|account_?number|\biban\b|payment_method_data|\bsource\[/i;
    for (const file of PAY09_PRODUCTION) assert.equal(CARD.test(codeOf(file)), false, file);
  });

  it('no PAY-09 production source reads, stores or returns a client secret (comments aside)', () => {
    for (const file of PAY09_PRODUCTION) assert.equal(/client_?secret|clientSecret/i.test(codeOf(file).replace(/'_secret_'/g, '')), false, file);
  });

  it('no generic artifact type can carry a Stripe secret: the settlement, receipt, P11 and P12 records name no key, client secret or webhook secret field', () => {
    for (const file of [...walk('src/enterprise/payment-settlement', false), ...walk('src/enterprise/execution-outcome-store', false), ...walk('src/enterprise/execution-resolution-store', false), ...walk('src/enterprise/evidence', false)]) {
      assert.equal(/client_?secret|whsec|api_?key\s*:/i.test(codeOf(file)), false, file);
    }
  });

  it('the Stripe SDK is reached by no source under src/ or packages/ (the Agent Passport billing app keeps its own)', () => {
    const SDK = /(?:from|import|require)\s*\(?\s*['"]stripe['"]|new\s+Stripe\s*\(/;
    for (const file of [...SRC_PRODUCTION, ...walk('packages', false)]) assert.equal(SDK.test(codeOf(file)), false, file);
  });

  it('logged and persisted fields are bounded: the rail logs ids and tokens only; the interlock stores no key, secret or personal field', () => {
    const rail = codeOf(`${RAIL}/stripe-rail.ts`);
    for (const call of rail.match(/log\('(?:info|warn)', '[^']+', \{[^}]*\}/g) ?? []) assert.equal(/amount|customer|paymentMethod|apiKey|secret/i.test(call), false, call);
    const interlock = codeOf(`${EDGE}/sqlite-stripe-payment-interlock.ts`);
    assert.equal(/email|address|secret|apiKey|client/i.test(interlock), false);
  });
});
