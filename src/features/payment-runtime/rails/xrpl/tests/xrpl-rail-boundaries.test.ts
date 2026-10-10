import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the XRPL / RLUSD rail is allowed to be, enforced structurally (PAY-02,
 * X21, §43–§45):
 *
 * - the XRPL SDK is imported by three named rail files and the rail's own
 *   tests — nowhere else in the repository: not Frontera's core, not PAY-01's
 *   domain or services, not an app, a package or a script;
 * - exactly one production source opens an XRPL connection and issues the
 *   `submit` request, and exactly one place in the rail calls it;
 * - no software signing, wallet or key derivation in any production source;
 * - no retry, no resubmission, and no transaction type other than `Payment`;
 * - no endpoint shipped as a default;
 * - the rail is off every published surface.
 */

const RAIL_DIR = 'src/features/payment-runtime/rails/xrpl';
const PAYMENT_ROOT = 'src/features/payment-runtime';

const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

function walk(dir: string, filter: (file: string) => boolean, includeTests: boolean): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__' || name === 'fixtures')) continue;
      out.push(...walk(full, filter, includeTests));
    } else if (filter(full) && (includeTests || !full.includes('.test.'))) {
      out.push(full);
    }
  }
  return out;
}

const isCode = (file: string): boolean => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && !file.endsWith('.d.ts');

/** Comments stripped, string literals kept. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const RAIL_PRODUCTION = walk(RAIL_DIR, (file) => file.endsWith('.ts'), false);

/** The one SDK user outside the rail: the opt-in Testnet smoke test, which sets up its ledger fixtures (accounts, trust lines) with the SDK. A test, never composed. */
const SMOKE = 'src/enterprise/__tests__/pay02-xrpl-testnet-smoke.test.ts';
const isRailTestOrSmoke = (file: string): boolean => file.startsWith(`${RAIL_DIR}/tests/`) || file === SMOKE;
/**
 * PAY-03: the reference external XRPL signer — a separate custody process
 * (`scripts/run-reference-xrpl-signer.mjs`), never composed into the Host —
 * holds its own Testnet key. It is the one production source outside the rail
 * that imports the SDK, and the one that holds a key; nothing in the Host
 * imports it (`pay03-xrpl-production-structure.test.ts`).
 */
const REFERENCE_SIGNER = 'src/enterprise/xrpl-payment-rail/reference/reference-xrpl-signer-service.ts';
/** PAY-03 qualification tests that start the reference signer or build fixtures with the SDK. Tests, never composed. */
const isPay03Test = (file: string): boolean => /^src\/enterprise\/__tests__\/pay03-[a-z0-9-]+\.(?:test\.)?ts$/.test(file);
const REPOSITORY_CODE = ['src', 'packages', 'apps', 'scripts', 'tests'].flatMap((root) => walk(root, isCode, true));

/** A value or type import of the XRPL SDK or one of its codec / key libraries. */
const SDK_MODULE = String.raw`['"](?:xrpl|ripple-(?:binary-codec|keypairs|address-codec|lib)|@xrplf\/[^'"]+)(?:\/[^'"]*)?['"]`;
const XRPL_SDK_IMPORT = new RegExp(String.raw`^\s*(?:import|export)\b[^;\n]*\bfrom\s+${SDK_MODULE}|\brequire\s*\(\s*${SDK_MODULE}|\bimport\s*\(\s*${SDK_MODULE}`, 'm');

describe('PAY-02 — XRPL SDK import boundary (X21, §44)', () => {
  it('the detection pattern matches real imports and not prose', () => {
    for (const hit of ["import { Client } from 'xrpl';", 'import { Wallet } from "xrpl/dist/npm"', "const x = require('ripple-keypairs')", "await import('@xrplf/secret-numbers')"]) assert.equal(XRPL_SDK_IMPORT.test(hit), true, hit);
    for (const miss of ['the xrpl SDK', "'xrpl-rlusd'", "from './xrpl-config.js'", `assert.equal(RAIL.test("import { Client } from 'xrpl'"), true);`]) assert.equal(XRPL_SDK_IMPORT.test(miss), false, miss);
  });

  it('only three rail files, the reference signer and tests import the SDK, repository-wide', () => {
    const importers = REPOSITORY_CODE.filter((file) => XRPL_SDK_IMPORT.test(readFileSync(file, 'utf8')));
    const production = importers.filter((file) => !isRailTestOrSmoke(file) && !isPay03Test(file));
    assert.deepEqual(production.sort(), [`${RAIL_DIR}/xrpl-address.ts`, `${RAIL_DIR}/xrpl-codec.ts`, `${RAIL_DIR}/xrpl-sdk-client.ts`, REFERENCE_SIGNER].sort());
    for (const file of importers) assert.ok(file.startsWith(`${RAIL_DIR}/`) || file === SMOKE || file === REFERENCE_SIGNER || isPay03Test(file), `${file} imports the XRPL SDK outside the rail`);
  });

  it('PAY-01’s contract (domain, services, barrel) neither imports the rail nor names it', () => {
    const contract = walk(PAYMENT_ROOT, (file) => file.endsWith('.ts'), false).filter((file) => !file.startsWith(`${PAYMENT_ROOT}/rails/`));
    assert.ok(contract.length >= 9);
    for (const file of contract) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/rails\//.test(text), false, `${file} must not depend on a rail`);
      assert.equal(XRPL_SDK_IMPORT.test(text), false, file);
    }
  });

  it('the rail imports only itself, PAY-01’s domain and the generic runtimes it reads — never the enterprise layer, the Kernel or a store', () => {
    const allowed = /^(?:\.\/[a-z-]+\.js|\.\.\/\.\.\/domain\/index\.js|\.\.\/\.\.\/\.\.\/(?:execution-runtime|monetary-runtime)\/index\.js|xrpl)$/;
    for (const file of RAIL_PRODUCTION) {
      for (const match of codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)) assert.ok(allowed.test(match[1] ?? ''), `${file} imports '${match[1]}'`);
    }
  });
});

describe('PAY-02 — the one XRPL submission site (§43, X15)', () => {
  it('exactly one production source constructs an XRPL client and issues the submit request', () => {
    const constructs = REPOSITORY_CODE.filter((file) => !file.includes('/tests/') && !file.includes('__tests__') && /\bnew\s+Client\s*\(/.test(codeOf(file)) && XRPL_SDK_IMPORT.test(readFileSync(file, 'utf8')));
    assert.deepEqual(constructs, [`${RAIL_DIR}/xrpl-sdk-client.ts`]);
    const submitRequests = REPOSITORY_CODE.filter((file) => !file.includes('/tests/') && /command:\s*['"]submit(?:_multisigned)?['"]/.test(codeOf(file)));
    assert.deepEqual(submitRequests, [`${RAIL_DIR}/xrpl-sdk-client.ts`]);
    const client = codeOf(`${RAIL_DIR}/xrpl-sdk-client.ts`);
    assert.equal([...client.matchAll(/command:\s*'submit'/g)].length, 1, 'one submit request, written once');
    assert.equal(/submitAndWait|\.submit\s*\(|autofill.*submit|sign\s*\(/.test(client), false, 'the SDK client neither signs nor uses the SDK’s own submit helpers');
  });

  it('the rail calls client.submit from exactly one place, after preparation and signature verification', () => {
    const rail = codeOf(`${RAIL_DIR}/xrpl-rlusd-rail.ts`);
    assert.equal([...rail.matchAll(/\bclient\.submit\s*\(/g)].length, 1);
    const callers = RAIL_PRODUCTION.filter((file) => /\.submit\s*\(/.test(codeOf(file)));
    assert.deepEqual(callers, [`${RAIL_DIR}/xrpl-rlusd-rail.ts`]);
    const ordered = (body: string, markers: readonly string[]): void => {
      const order = markers.map((marker) => body.indexOf(marker));
      for (const [index, position] of order.entries()) assert.notEqual(position, -1, String(markers[index]));
      assert.deepEqual([...order].sort((a, b) => a - b), order, markers.join(' → '));
    };
    const prepare = rail.slice(rail.indexOf('async function prepareAndSign('), rail.indexOf('async function awaitFinality('));
    ordered(prepare, ['await ensureConnected()', 'client.validatedLedgerIndex()', 'client.autofill(', 'BigInt(configuration.maxFeeDrops)', 'await sign(prepared)', 'signedPaymentMatches(prepared']);
    const submit = rail.slice(rail.indexOf('async function submitOnceAndAwait('), rail.indexOf('async function execute('));
    ordered(submit, ['client.submit(signed.signedTransaction)', 'readSubmission(answer', 'awaitFinality(request']);
    const execute = rail.slice(rail.indexOf('async function execute('));
    // PAY-03: the durable reservation strictly between verification and the one submission.
    ordered(execute, ['buildXrplPayment(request', 'serialized(account', 'prepareAndSign(request', 'await reserve(request, signed)', 'submitOnceAndAwait(request', 'unresolved.set(account']);
  });

  it('no retry, resubmission or replay vocabulary exists in the rail’s production code', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/\bretry|retries\b/i, /resubmit|re-submit|resend|replay/i, /submitAndWait/, /\bfor\s*\([^)]*attempt/i]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('the rail constructs Payment only — no OfferCreate, AMM, TrustSet, Escrow, PaymentChannel, Check or NFToken', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      assert.equal(/OfferCreate|OfferCancel|AMM[A-Z][a-z]+|TrustSet|Escrow(?:Create|Finish|Cancel)|PaymentChannel|Check(?:Create|Cash|Cancel)|NFToken|AccountSet|SetRegularKey|SignerListSet|AccountDelete|Clawback/.test(code), false, file);
      for (const match of code.matchAll(/TransactionType:\s*'([A-Za-z]+)'/g)) assert.equal(match[1], 'Payment', file);
    }
  });

  it('no partial payments, paths or SendMax: the rail sets Flags 0 and nothing else', () => {
    const builder = codeOf(`${RAIL_DIR}/xrpl-payment-builder.ts`);
    assert.ok(builder.includes('Flags: 0'));
    for (const file of RAIL_PRODUCTION) assert.equal(/tfPartialPayment|131072|SendMax:|Paths:|Memos:/.test(codeOf(file)), false, file);
  });
});

describe('PAY-02 — signing and custody boundary (§17, §18, §45)', () => {
  it('no production source anywhere derives, holds or uses an XRPL key: Wallet, seeds, keypairs and mnemonics live only in the rail’s tests', () => {
    const custody = /\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|ripple-keypairs|secret-numbers/;
    const sites = REPOSITORY_CODE.filter((file) => XRPL_SDK_IMPORT.test(readFileSync(file, 'utf8')) && custody.test(codeOf(file)));
    for (const file of sites) assert.ok(isRailTestOrSmoke(file) || isPay03Test(file) || file === REFERENCE_SIGNER, `${file} holds XRPL key material outside the test fixtures and the reference signer process`);
    for (const file of RAIL_PRODUCTION) assert.equal(custody.test(codeOf(file)), false, file);
  });

  it('the payment contract files never import a signer: PaymentIntent, governance, execution and the bridge stay custody-free', () => {
    for (const file of ['payment-intent.ts', 'payment-governance.ts', 'payment-execution.ts', 'payment-rail.ts'].map((name) => `${PAYMENT_ROOT}/domain/${name}`).concat(`${PAYMENT_ROOT}/services/payment-rail-execution-adapter.ts`)) {
      const code = codeOf(file);
      assert.equal(/Signer|xrpl|\bsign\s*\(/i.test(code), false, file);
    }
  });

  it('only the rail invokes a signer, once per execution, and never reads anything but its address and sign function', () => {
    const rail = codeOf(`${RAIL_DIR}/xrpl-rlusd-rail.ts`);
    assert.equal([...rail.matchAll(/\bawait\s+sign\s*\(/g)].length, 1);
    // The port declares `sign(transaction)`; nothing but the rail calls it.
    for (const file of RAIL_PRODUCTION.filter((path) => !path.endsWith('xrpl-rlusd-rail.ts') && !path.endsWith('xrpl-client-port.ts'))) assert.equal(/\bsign\s*\(/.test(codeOf(file)), false, file);
    assert.equal(/signer\??\.(?!address\b|sign\b|signingPublicKey\b)[a-zA-Z]/.test(rail), false, 'the rail reads a signer’s address, pinned signing key and sign function only');
  });
});

describe('PAY-02 — network safety and published surface (X22, §60, NB-010)', () => {
  it('the rail ships no endpoint: no ws(s):// or http(s):// literal in its production code', () => {
    for (const file of RAIL_PRODUCTION) assert.equal(/['"`](?:wss?|https?):\/\//.test(codeOf(file)), false, file);
  });

  it('the payment vertical’s barrel does not export the rail, and no package entrypoint reaches it', () => {
    assert.equal(/rails/.test(readFileSync(`${PAYMENT_ROOT}/index.ts`, 'utf8')), false);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown; readonly dependencies?: Record<string, string>; readonly bundleDependencies?: readonly string[]; readonly devDependencies?: Record<string, string>; readonly peerDependencies?: Record<string, string> };
    assert.equal(JSON.stringify(pkg.exports ?? {}).includes('payment-runtime'), false);
    for (const root of ['src/index.ts', 'src/runtime/index.ts', 'src/enterprise/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(root)) assert.equal(/payment-runtime|rails\/xrpl/.test(readFileSync(root, 'utf8')), false, root);
    }
    // PAY-03: the shipped Host composes the rail from configuration, so the SDK is a runtime dependency — once, exactly pinned.
    assert.match(pkg.dependencies?.['xrpl'] ?? '', /^\d+\.\d+\.\d+$/, 'a runtime dependency, pinned to an exact version');
    assert.equal(Object.keys(pkg.devDependencies ?? {}).includes('xrpl'), false, 'not duplicated in devDependencies');
    assert.equal(Object.keys(pkg.peerDependencies ?? {}).includes('xrpl'), false);
    assert.equal((pkg.bundleDependencies ?? []).includes('xrpl'), false);
  });
});
