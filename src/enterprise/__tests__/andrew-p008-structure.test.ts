import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createXrplExecutionAdapter, xrplIssuedValuesEqual } from '../execution-adapters/xrpl/index.js';
import { andrewXrplAdapterOptions } from '../andrew-demo/index.js';
import { createSpyXrplTransport, validatedAction, xrplKey, XRPL_DESTINATION } from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-08 structure — where the real XRPL client may live, what may
 * reach it, and the adapter's own refusal to call an inexact delivery done.
 */

const PACKAGE_DIR = 'packages/xrpl-testnet-transport';
const XRPL_DIR = 'src/enterprise/execution-adapters/xrpl';
const DEMO_DIR = 'src/enterprise/andrew-demo';

function walk(dir: string, include: (file: string) => boolean): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!['node_modules', 'dist', 'dist-test', '.git', '.next'].includes(name)) out.push(...walk(full, include));
    } else if (include(full)) out.push(full.split('\\').join('/'));
  }
  return out;
}

/** Source with comments removed, so prose never satisfies or violates a rule. */
const codeOf = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
const imports = (file: string): readonly string[] => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
const isProduction = (file: string) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes('/__tests__/') && !file.endsWith('.d.ts');

describe('ANDREW-P0-08 structure — the real XRPL client is a leaf', () => {
  it('the transport package imports nothing from the runtime: only xrpl, better-sqlite3, node built-ins and itself', () => {
    for (const file of walk(`${PACKAGE_DIR}/src`, isProduction)) {
      for (const specifier of imports(file)) {
        assert.ok(/^(xrpl|better-sqlite3|node:[a-z/]+)$|^\.\/[\w-]+\.js$/.test(specifier), `${file} imports ${specifier}`);
      }
    }
  });

  it('the XRPL adapter and the Andrew demo stay network-free: neither imports the transport package, xrpl, ws or a WebSocket', () => {
    for (const file of [...walk(XRPL_DIR, isProduction), ...walk(DEMO_DIR, isProduction)]) {
      for (const specifier of imports(file)) assert.equal(/xrpl-testnet-transport|^xrpl$|^ws$|ripple|@xrplf/.test(specifier), false, `${file} imports ${specifier}`);
      assert.equal(/\bWebSocket\b|\bnew\s+Client\s*\(|\bWallet\b/.test(codeOf(file)), false, file);
    }
  });

  it('no production module of the runtime imports the transport package — it is composed only where a caller injects it', () => {
    const importers = walk('src', isProduction).filter((file) => imports(file).some((specifier) => /xrpl-testnet-transport/.test(specifier)));
    assert.deepEqual(importers, []);
  });

  it('no seed, private key or signed blob is committed in anything the Andrew work (P0-06 … P0-08) touches', () => {
    const andrew = (f: string) => /\.(ts|tsx|mjs|json|md)$/.test(f);
    const files = [...walk(XRPL_DIR, andrew), ...walk(DEMO_DIR, andrew), ...walk('src/enterprise/__tests__', (f) => /(andrew-p00|xrpl-)[\w-]*\.ts$/.test(f)), ...walk('packages/xrpl-testnet-transport', (f) => /\.(ts|mjs|json|md)$/.test(f)), ...walk('docs/demo/andrew', (f) => f.endsWith('.md'))];
    const SEED = /\bs[1-9A-HJ-NP-Za-km-z]{28}\b|\bsEd[1-9A-HJ-NP-Za-km-z]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b1200[0-9A-F]{200,}\b/;
    for (const file of files) assert.equal(SEED.test(readFileSync(file, 'utf8')), false, file);
  });

  it('the package scripts never print a seed: secrets are written to a 0600 file and only addresses are logged', () => {
    const provision = readFileSync(`${PACKAGE_DIR}/scripts/provision-testnet-accounts.mjs`, 'utf8');
    assert.match(provision, /mode: 0o600/);
    assert.match(provision, /network_id/);
    for (const line of provision.split('\n').filter((l) => /console\.(log|error)/.test(l))) assert.equal(/seed/i.test(line.replace(/seeds? not shown/i, '')), false, line);
    const preflight = readFileSync(`${PACKAGE_DIR}/scripts/preflight.mjs`, 'utf8');
    assert.equal(/SEED/.test(preflight.replace(/never a seed/i, '')), false, 'the preflight reads only addresses');
  });
});

describe('ANDREW-P0-08 adapter — a validated report is completion only with the exact delivered amount', () => {
  const options = andrewXrplAdapterOptions('xrpl-testnet.treasury');
  const action = () => validatedAction({ counterparty: xrplKey(XRPL_DESTINATION, 'xrpl.testnet') });
  const RLUSD = { currency: '524C555344000000000000000000000000000000', issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' };
  const HASH = 'A1'.repeat(32);

  for (const [label, delivered, outcome] of [
    ['exact "75000"', { ...RLUSD, value: '75000' }, 'completed'],
    ['exponent form "7.5e4"', { ...RLUSD, value: '7.5e4' }, 'completed'],
    ['trailing zeros "75000.00"', { ...RLUSD, value: '75000.00' }, 'completed'],
    ['no delivered amount reported (P0-06 transports)', undefined, 'completed'],
    ['74999.99', { ...RLUSD, value: '74999.99' }, 'unconfirmed'],
    ['another issuer', { ...RLUSD, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '75000' }, 'unconfirmed'],
    ['another currency', { ...RLUSD, currency: 'USD', value: '75000' }, 'unconfirmed'],
    ['drops instead of a token', '75000000000', 'unconfirmed'],
    ['"unavailable"', 'unavailable', 'unconfirmed'],
  ] as const) {
    it(`delivered ${label} → ${outcome}`, async () => {
      const transport = createSpyXrplTransport(() => ({ kind: 'validated', transactionHash: HASH, ...(delivered !== undefined ? { deliveredAmount: delivered } : {}) }));
      const result = await createXrplExecutionAdapter(options, transport).execute(action());
      assert.equal(result.outcome, outcome);
      assert.equal((result as { readonly providerRef?: string }).providerRef, HASH, 'the hash is kept as the reconciliation handle either way');
    });
  }

  it('exact decimal equality, never a float', () => {
    assert.equal(xrplIssuedValuesEqual('75000', '7.5e4'), true);
    assert.equal(xrplIssuedValuesEqual('0.1', '1e-1'), true);
    assert.equal(xrplIssuedValuesEqual('75000', '75000.0000000000001'), false);
    assert.equal(xrplIssuedValuesEqual('9007199254740993', '9007199254740992'), false);
    assert.equal(xrplIssuedValuesEqual('-75000', '75000'), false);
    assert.equal(xrplIssuedValuesEqual(75000, '75000'), false);
  });
});
