import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * TRADE-02 — the XRPL delegation reader is read-only, enforced structurally:
 *
 * - the rail is exactly the reader and its barrel;
 * - the port it reaches the ledger through has exactly two methods,
 *   `serverInfo` and `ledgerEntryDelegate`, and the reader calls each once;
 * - every `ledger_entry` it asks is at the `validated` ledger;
 * - it builds no transaction, signs nothing, submits nothing, holds no key,
 *   imports no SDK, opens no connection and retries nothing;
 * - nothing composes it yet: no TRADE barrel, enterprise module, script or
 *   app imports the rail (a composition edge is TRADE-04's, under review).
 */

const RAIL = 'src/features/trade-runtime/rails/xrpl';
const READER = `${RAIL}/xrpl-delegation-reader.ts`;

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'tests' || name === 'node_modules' || name === 'dist' ? [] : walk(full);
    return /\.(?:ts|mts|cts|js|mjs|cjs|tsx)$/.test(full) && !full.endsWith('.d.ts') && !full.includes('.test.') ? [full] : [];
  });
}

/** Comments stripped, string literals kept. */
const codeOf = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

describe('TRADE-02 — the XRPL delegation reader is read-only', () => {
  it('the rail is exactly the reader and its barrel', () => {
    assert.deepEqual(walk(RAIL).map((file) => file.slice(RAIL.length + 1)).sort(), ['index.ts', 'xrpl-delegation-reader.ts']);
  });

  it('the port has exactly two read methods: server_info and a validated Delegate ledger_entry', () => {
    const code = codeOf(READER);
    const port = /export interface XrplDelegationLedgerPort \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.deepEqual([...port.matchAll(/^\s*(\w+)\s*\(/gm)].map((match) => match[1]), ['serverInfo', 'ledgerEntryDelegate']);
    const request = /export interface XrplDelegateLedgerEntryRequest \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.match(request, /readonly ledger_index: 'validated';/, 'the request type admits only the validated ledger');
  });

  it('the reader calls each port method exactly once and touches nothing else on the port', () => {
    const code = codeOf(READER);
    assert.equal([...code.matchAll(/\bport\.serverInfo\(\)/g)].length, 1);
    assert.equal([...code.matchAll(/\bport\.ledgerEntryDelegate\(/g)].length, 1);
    const members = new Set([...code.matchAll(/\bport\.(\w+)/g)].map((match) => match[1]));
    assert.deepEqual([...members].sort(), ['ledgerEntryDelegate', 'serverInfo']);
    assert.match(code, /ledger_index: 'validated' as const/);
    assert.equal(/'current'|'closed'|ledger_index:\s*\d|ledger_hash:\s*['"]/.test(code), false, 'never an open, closed or caller-chosen ledger');
  });

  it('builds no transaction, signs nothing, submits nothing, holds no key and retries nothing', () => {
    for (const file of walk(RAIL)) {
      const code = codeOf(file);
      for (const pattern of [
        /TransactionType|DelegateSet|OfferCreate\s*[:=]|tx_json|tx_blob|txJson/,
        /\bsubmit\w*\s*\(|['"]submit['"]|autofill|\bsign\w*\s*\(|multisign/i,
        /\bWallet\b|fromSeed|fromSecret|privateKey|\bseed\b|mnemonic|keypair/i,
        /\bfetch\s*\(|WebSocket|\bnew\s+Client\b|\bconnect\s*\(|node:(?:http|https|net|tls|dgram)/,
        /\bretry|retries|attempts?\b|backoff|setTimeout|setInterval/i,
        /from\s+['"](?:xrpl|ripple-[a-z-]+|@xrplf\/[^'"]+)['"]/,
      ]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('every transport failure is caught into "unavailable": no exception, and no message, crosses the reader', () => {
    const code = codeOf(READER);
    const awaited = [...code.matchAll(/await port\.\w+\(/g)].length;
    const guarded = [...code.matchAll(/try \{\s*\w+ = await port\.\w+\([\s\S]*?\} catch \{\s*return unavailable\(XRPL_DELEGATION_READ_FAILURES\.LEDGER_UNREACHABLE\);/g)].length;
    assert.equal(awaited, 2);
    assert.equal(guarded, 2);
    assert.equal(/catch\s*\(\s*\w+\s*\)/.test(code), false, 'no caught error value is inspected or forwarded');
  });

  it('nothing composes the rail yet: the TRADE barrel does not export it, and no production module outside the rail imports it', () => {
    assert.equal(/rails\//.test(codeOf('src/features/trade-runtime/index.ts')), false);
    assert.equal(/rails\//.test(codeOf('src/features/trade-runtime/domain/index.ts')), false);
    const production = (dir: string): readonly string[] => walk(dir);
    for (const file of ['src', 'packages', 'scripts', 'apps'].flatMap(production)) {
      if (file.startsWith(`${RAIL}/`)) continue;
      assert.equal(/trade-runtime\/rails|xrpl-delegation-reader/.test(readFileSync(file, 'utf8')), false, file);
    }
  });
});
