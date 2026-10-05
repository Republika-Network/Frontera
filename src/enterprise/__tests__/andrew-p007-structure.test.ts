import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { RLUSD_XRPL_MAINNET_ISSUER, RLUSD_XRPL_TESTNET_ISSUER } from '../andrew-demo/index.js';

/**
 * ANDREW-P0-07 structure — the demo composition is opt-in, holds no key or
 * endpoint, reaches no network, derives no approval from XRPL state, and the
 * Testnet RLUSD issuer lives in exactly one production file.
 */

const DEMO_DIR = 'src/enterprise/andrew-demo';
const XRPL_DIR = 'src/enterprise/execution-adapters/xrpl';

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__' && name !== 'tests' && name !== 'fixtures' && name !== 'node_modules') out.push(...walk(full));
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) && !full.endsWith('.d.ts')) out.push(full.split('\\').join('/'));
  }
  return out;
}

/** Source with comments removed, so prose never satisfies or violates a rule. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const imports = (file: string): readonly string[] => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
const DEMO = walk(DEMO_DIR);
const PRODUCTION = [...walk('src'), ...walk('packages'), ...walk('apps')];

describe('ANDREW-P0-07 structure — the demo composition module', () => {
  it('has the expected production sources', () => {
    assert.deepEqual([...DEMO].sort(), [
      `${DEMO_DIR}/andrew-demo-composition.ts`,
      `${DEMO_DIR}/index.ts`,
      `${DEMO_DIR}/recording-xrpl-transport.ts`,
      `${DEMO_DIR}/rlusd-testnet-settlement.ts`,
    ]);
  });

  it('opens no network client and adds no XRPL library: no http/https/net/tls/dns/dgram, ws, undici, axios, xrpl or ripple import; no fetch or WebSocket', () => {
    for (const file of DEMO) {
      for (const specifier of imports(file)) assert.equal(/^(node:)?(http|https|net|tls|dns|dgram|http2)$|^(ws|undici|axios|node-fetch|xrpl|ripple-.*|@xrplf\/.*)$/.test(specifier), false, `${file} imports ${specifier}`);
      assert.equal(/\bfetch\s*\(|\bWebSocket\b|\.connect\s*\(/.test(codeOf(file)), false, file);
    }
  });

  it('holds no endpoint and no key material: no URL, no seed, secret, mnemonic, private key, signing call, wallet or process.env', () => {
    // The one URL allowed is the local Host listener the composition just bound (loopback, its own port).
    const LOCAL_LISTENER = 'http://127.0.0.1:${port}';
    for (const file of DEMO) {
      const code = codeOf(file);
      assert.equal(/[a-z][a-z0-9+.-]*:\/\//i.test(code.split(LOCAL_LISTENER).join('')), false, `${file} must hold no URL or endpoint`);
      assert.equal(/\bseed\b|mnemonic|private[_-]?key|\bsign(Transaction)?\s*\(|\bWallet\b|keypair|\bprocess\.env\b/i.test(code), false, `${file} must hold no key`);
      assert.equal(/\bsecret\s*[:=]/i.test(code), false, `${file} must hold no secret value`);
    }
  });

  it('never converts money through a number', () => {
    for (const file of [...DEMO, ...walk(XRPL_DIR)]) {
      assert.equal(/\bNumber\s*\(|\bNumber\.|parseFloat|parseInt|toFixed|toPrecision|\bMath\./.test(codeOf(file)), false, file);
    }
  });

  it('derives no destination approval from XRPL state: no trust line, account or ledger query vocabulary', () => {
    for (const file of [...DEMO, ...walk(XRPL_DIR)]) {
      assert.equal(/TrustSet|trust_?line|account_lines|account_info|RippleState|ledger_entry|\bbalance\b/i.test(codeOf(file)), false, file);
    }
  });

  it('never invokes an execution adapter; it only hands one to the Host', () => {
    for (const file of DEMO) assert.equal(/\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/.test(codeOf(file)), false, file);
    const composition = codeOf(`${DEMO_DIR}/andrew-demo-composition.ts`);
    assert.match(composition, /bootEnterpriseHost\(\{ env: environment, executionAdapters: \[xrplAdapter\]/);
  });
});

describe('ANDREW-P0-07 structure — where the RLUSD issuers may appear', () => {
  it('the Testnet and Mainnet RLUSD issuers appear in exactly one production source, the Andrew settlement module', () => {
    for (const issuer of [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER]) {
      const holders = PRODUCTION.filter((file) => readFileSync(file, 'utf8').includes(issuer));
      assert.deepEqual(holders, [`${DEMO_DIR}/rlusd-testnet-settlement.ts`], issuer);
    }
  });

  it('the XRPL adapter names no issuer, no network and no Testnet: all of it is configuration', () => {
    for (const file of walk(XRPL_DIR)) {
      const code = codeOf(file);
      assert.equal(/testnet|mainnet|devnet|altnet/i.test(code), false, file);
      assert.equal(/r[1-9A-HJ-NP-Za-km-z]{24,34}/.test(code.replace(/'[^']*'/g, (literal) => (/^'r[1-9A-HJ-NP-Za-km-z]{24,34}'$/.test(literal) ? literal : "''"))), false, `${file} must hold no address literal`);
      assert.equal(/524C555344/.test(code), false, `${file} must not hardcode the RLUSD code`);
    }
  });
});

describe('ANDREW-P0-07 structure — the default Host does not become XRPL-specific', () => {
  it('no production source outside the demo imports the Andrew demo', () => {
    const importers = PRODUCTION.filter((file) => !file.startsWith(`${DEMO_DIR}/`) && imports(file).some((specifier) => /andrew-demo/.test(specifier)));
    assert.deepEqual(importers, []);
  });

  it('outside the adapter itself, only the Andrew demo imports the XRPL adapter — no Host, composition, governed-action or generic module', () => {
    const importers = PRODUCTION.filter((file) => !file.startsWith(`${XRPL_DIR}/`) && imports(file).some((specifier) => /execution-adapters\/xrpl/.test(specifier)));
    assert.deepEqual(importers.sort(), [`${DEMO_DIR}/andrew-demo-composition.ts`, `${DEMO_DIR}/recording-xrpl-transport.ts`, `${DEMO_DIR}/rlusd-testnet-settlement.ts`]);
  });

  it('is not on the Enterprise barrel or the frozen API surface', () => {
    assert.equal(/andrew|xrpl|rlusd/i.test(readFileSync('src/enterprise/index.ts', 'utf8')), false);
    assert.equal(/andrew|rlusd/i.test(readFileSync('release/api-surface.v1.json', 'utf8')), false);
  });

  it('adds no runtime dependency: the root manifest names no xrpl, ripple or ws package, and only the P0-08 transport package declares one', () => {
    assert.equal(/"(xrpl|ripple-[a-z-]+|@xrplf\/[a-z-]+|ws)"\s*:/.test(readFileSync('package.json', 'utf8')), false);
    // ANDREW-P0-08: the XRPL library lives in one leaf workspace. The root manifest and the
    // root lockfile entry declare none; the only workspace declaring one is the transport package.
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { readonly packages: Record<string, { readonly dependencies?: Record<string, string> }> };
    const declaring = Object.entries(lock.packages).filter(([path, entry]) => !path.includes('node_modules/') && Object.keys(entry.dependencies ?? {}).some((name) => /^(xrpl|ripple-[\w-]+|@xrplf\/[\w-]+|ws)$/.test(name)));
    assert.deepEqual(declaring.map(([path]) => path), ['packages/xrpl-testnet-transport']);
    assert.deepEqual(Object.keys(lock.packages['packages/xrpl-testnet-transport']?.dependencies ?? {}).filter((name) => /xrpl|ripple|^ws$/.test(name)), ['xrpl']);
  });
});
