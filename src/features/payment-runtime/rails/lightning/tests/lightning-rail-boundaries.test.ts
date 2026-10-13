import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the Lightning rail is allowed to be, enforced structurally (PAY-06):
 *
 * - it depends on PAY-01's contract and the generic runtimes it reads — never
 *   on the enterprise layer, the Kernel, a store, the XRPL rail, or a network
 *   module; the XRPL rail never depends on it either;
 * - `node.sendPayment` is called from exactly one place, after the durable
 *   reservation, and the rail has no retry, resend or replay vocabulary;
 * - it verifies signatures and never signs: no key generation or derivation in
 *   production; `@noble/curves` is reached from one production file only;
 * - it holds no credential vocabulary (macaroons, TLS keys live in the
 *   enterprise node adapter);
 * - it ships no endpoint and is off every published surface.
 */

const RAIL_DIR = 'src/features/payment-runtime/rails/lightning';
const XRPL_DIR = 'src/features/payment-runtime/rails/xrpl';
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
const REPOSITORY_CODE = ['src', 'packages', 'apps', 'scripts', 'tests'].flatMap((root) => walk(root, true));

describe('PAY-06 — Lightning rail dependency boundary', () => {
  it('has production sources to check', () => {
    assert.ok(RAIL_PRODUCTION.length >= 12, `found ${RAIL_PRODUCTION.length}`);
  });

  it('imports only itself, PAY-01’s domain, the generic runtimes, node:crypto and the pinned curve library', () => {
    const allowed = /^(?:\.\/[a-z0-9-]+\.js|\.\.\/\.\.\/domain\/index\.js|\.\.\/\.\.\/\.\.\/(?:execution-runtime|monetary-runtime)\/index\.js|node:crypto|@noble\/curves\/secp256k1\.js)$/;
    for (const file of RAIL_PRODUCTION) for (const specifier of importsOf(file)) assert.ok(allowed.test(specifier), `${file} imports '${specifier}'`);
  });

  it('the XRPL rail and the Lightning rail never import each other', () => {
    for (const file of RAIL_PRODUCTION) assert.equal(importsOf(file).some((specifier) => /xrpl/.test(specifier)), false, file);
    for (const file of walk(XRPL_DIR, true)) assert.equal(importsOf(file).some((specifier) => /lightning/.test(specifier)), false, file);
  });

  it('PAY-01’s contract (domain, services, barrel) neither imports the Lightning rail nor names Lightning', () => {
    const contract = walk(PAYMENT_ROOT, false).filter((file) => !file.startsWith(`${PAYMENT_ROOT}/rails/`) && !file.split('/').includes('protocols'));
    assert.ok(contract.length >= 9);
    for (const file of contract) {
      const code = codeOf(file);
      assert.equal(/rails\/lightning|lightning|bolt11|preimage|macaroon|\bhtlc\b/i.test(code), false, `${file} names Lightning`);
    }
    assert.equal(/lightning/i.test(readFileSync(`${PAYMENT_ROOT}/index.ts`, 'utf8')), false, 'the payment barrel does not export the rail');
  });

  it('@noble/curves is reached from exactly one production source, the signature verifier — and only to recover and verify', () => {
    const NOBLE = /['"]@noble\/curves(?:\/[^'"]*)?['"]/;
    const production = REPOSITORY_CODE.filter((file) => !/\/tests?\//.test(file) && !file.includes('__tests__') && NOBLE.test(codeOf(file)));
    assert.deepEqual(production, [`${RAIL_DIR}/lightning-signature.ts`]);
    const verifier = codeOf(`${RAIL_DIR}/lightning-signature.ts`);
    assert.equal(/\.sign\s*\(|getPublicKey|randomSecretKey|randomPrivateKey|utils\.|keygen|getSharedSecret/.test(verifier), false, 'the verifier never signs or generates keys');
  });
});

describe('PAY-06 — the one Lightning send', () => {
  it('node.sendPayment is called from exactly one place in the rail, after the durable reservation and the expiry re-check', () => {
    const callers = RAIL_PRODUCTION.filter((file) => /\.sendPayment\s*\(/.test(codeOf(file)));
    assert.deepEqual(callers, [`${RAIL_DIR}/lightning-rail.ts`]);
    const rail = codeOf(`${RAIL_DIR}/lightning-rail.ts`);
    assert.equal([...rail.matchAll(/\bnode\.sendPayment\s*\(/g)].length, 1);
    const ordered = (body: string, markers: readonly string[]): void => {
      const positions = markers.map((marker) => body.indexOf(marker));
      for (const [index, position] of positions.entries()) assert.notEqual(position, -1, String(markers[index]));
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, markers.join(' → '));
    };
    const execute = rail.slice(rail.indexOf('async function execute('), rail.indexOf('async function readiness('));
    ordered(execute, ['prepare(request)', 'interlock.recorded(request.executionId)', 'verifiedInvoice(request, prepared)', 'checkNode(invoice)', 'interlock.reserve(record)', 'checkTime(invoice)', 'sendOnce(request, record, invoice)']);
    const sendOnce = rail.slice(rail.indexOf('async function sendOnce('), rail.indexOf('async function execute('));
    ordered(sendOnce, ['node.sendPayment(', 'readLightningPaymentObservation(answer)', 'concludeLightningPayment(observation, record)']);
  });

  it('no retry, resend or replay vocabulary in the rail’s production code', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      for (const pattern of [/\bretry|retries\b/i, /\bresubmit|\bre-submit|\bresend|\bre-send|\breplay/i, /\bfor\s*\([^)]*attempt/i]) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('the rail opens no connection and ships no endpoint: no network module, no fetch, no URL literal', () => {
    for (const file of RAIL_PRODUCTION) {
      const code = codeOf(file);
      assert.equal(/from\s+['"]node:(?:https?|net|tls|dns|http2|dgram)['"]|\bfetch\s*\(/.test(code), false, file);
      assert.equal(/['"`](?:wss?|https?):\/\//.test(code), false, file);
    }
  });

  it('no credential vocabulary in the rail: macaroons, TLS material and runes stay in the enterprise node adapter', () => {
    for (const file of RAIL_PRODUCTION) assert.equal(/macaroon|tls\.?cert|private.?key|\brune\b|bearer/i.test(codeOf(file)), false, file);
  });

  it('no production source creates or signs an invoice: the Bech32 encoder is reached only by tests', () => {
    const users = REPOSITORY_CODE.filter((file) => /\bencodeBech32\s*\(/.test(codeOf(file)) && !file.endsWith('lightning-bech32.ts'));
    for (const file of users) assert.ok(file.startsWith(`${RAIL_DIR}/tests/`), `${file} encodes an invoice`);
  });
});

describe('PAY-06 — published surface and dependency pin', () => {
  it('no package entrypoint reaches the Lightning rail', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown };
    assert.equal(JSON.stringify(pkg.exports ?? {}).includes('lightning'), false);
    for (const root of ['src/index.ts', 'src/runtime/index.ts', 'src/enterprise/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(root)) assert.equal(/lightning/i.test(readFileSync(root, 'utf8')), false, root);
    }
  });

  it('@noble/curves is a runtime dependency pinned to the exact version the XRPL SDK already ships', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> };
    assert.match(pkg.dependencies?.['@noble/curves'] ?? '', /^\d+\.\d+\.\d+$/, 'exactly pinned');
    assert.equal(Object.keys(pkg.devDependencies ?? {}).includes('@noble/curves'), false);
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { readonly packages: Record<string, { readonly version?: string }> };
    assert.equal(lock.packages['node_modules/@noble/curves']?.version, pkg.dependencies?.['@noble/curves'], 'one copy, the locked one');
  });
});
