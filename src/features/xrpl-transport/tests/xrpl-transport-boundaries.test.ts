import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * TRADE-04A — what the shared XRPL transport is allowed to be, enforced
 * structurally:
 *
 * - **pure and leaf**: it imports only itself — no XRPL SDK or codec, no Node
 *   module, no other feature, no enterprise layer, no vertical;
 * - **transaction-neutral**: it constructs no transaction and names no
 *   transaction type's business fields — no payment intent, no trading
 *   strategy, no policy, approval or grant (SEC-TRADE04A-03);
 * - **no effect**: it opens no connection, makes no request of its own (it
 *   reads only through a port an embedder supplies), signs nothing, submits
 *   nothing, holds no key and retries nothing (SEC-TRADE04A-04, -05);
 * - **no arbitrary submission API**: no exported function or port method
 *   accepts a signed blob (SEC-TRADE04A-05);
 * - **read-only port**: exactly three read requests, the entry request admits
 *   only the validated ledger;
 * - **reached only by its approved importers**: the PAY-02 codec and result
 *   reader, and the PAY-03 interlock — and off every published surface.
 *
 * Each scan is a pure predicate over (path, text); the negative fixtures run
 * the same predicates over synthetic violations, so a scan that silently
 * matches nothing fails here.
 */

const ROOT = 'src/features/xrpl-transport';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

interface Source {
  readonly path: string;
  readonly text: string;
}

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
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
const read = (path: string): Source => ({ path, text: readFileSync(path, 'utf8') });

const TRANSPORT = walk(ROOT, false).map(read);

type Scan = (sources: readonly Source[]) => readonly string[];

/** Only `./x.js` siblings. */
const leafImports: Scan = (sources) => sources.flatMap((source) => importsOf(source.text).filter((specifier) => !/^\.\/[a-z-]+\.js$/.test(specifier)).map((specifier) => `${source.path} imports '${specifier}'`));

/** Business vocabulary of either vertical, and of governance. */
const BUSINESS = [
  /\bPayment\b|PaymentIntent|PaymentRail|delivered_amount|DeliverMax|Destination(?:Tag)?\b|\bAmount\b|SendMax|\bissuer\b/,
  /OfferCreate|OfferCancel|TakerGets|TakerPays|tfSell|tfPassive|ImmediateOrCancel|FillOrKill|\bfill\b|\bstrategy\b|limitPrice|notional/i,
  /\bpolicy\b|PolicyPack|\bapproval\b|BoundedGrant|\bgrant\b|issueFromDecision|\bdecide\s*\(|\bevaluate\s*\(|GovernedActionOrchestrator|ExecutionAdapter/i,
];
const businessLogic: Scan = (sources) => sources.flatMap((source) => BUSINESS.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`));

const EFFECTS = [
  /\bnew\s+Client\s*\(|WebSocket|\bfetch\s*\(|XMLHttpRequest|EventSource|\bconnect\s*\(|\.request\s*\(/,
  /command:\s*['"](?:submit|submit_multisigned|sign|sign_for)['"]|\.submit\s*\(|submitAndWait|\bautofill\s*\(|tx_blob|signedTransaction\s*[:(]/,
  /\bsign\s*\(|multisign|signTransaction|encodeForSigning|verifySignature|createSign\b/,
  /\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|privateKey|\bseed\b|mnemonic|keypair/i,
  /\bretry|retries\b|resubmit|resend|replay|backoff|setInterval|\bwhile\s*\(|\bfor\s*\(;;\)/i,
  /TransactionType\s*:/,
];
const effects: Scan = (sources) => sources.flatMap((source) => EFFECTS.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`));

describe('TRADE-04A shared XRPL transport — boundaries', () => {
  it('has the expected production sources', () => {
    assert.deepEqual(TRANSPORT.map((source) => source.path.slice(ROOT.length + 1)).sort(), [
      'index.ts',
      'xrpl-ledger-grammar.ts',
      'xrpl-network-identity.ts',
      'xrpl-sequence-safety.ts',
      'xrpl-submission-reading.ts',
      'xrpl-validated-ledger-reader.ts',
      'xrpl-validated-ledger.ts',
    ]);
  });

  it('is a leaf: imports only itself — no SDK, no Node module, no feature, no enterprise layer, no vertical', () => {
    assert.deepEqual(leafImports(TRANSPORT), []);
  });

  it('SEC-TRADE04A-03: knows no payment intent, trading strategy, policy, approval or grant', () => {
    assert.deepEqual(businessLogic(TRANSPORT), []);
  });

  it('SEC-TRADE04A-04/05: opens no connection, signs nothing, submits nothing, holds no key, retries nothing, builds no transaction', () => {
    assert.deepEqual(effects(TRANSPORT), []);
  });

  it('SEC-TRADE04A-05: no exported function or port method accepts a signed blob — the public surface is pinned', () => {
    const index = codeOf(readFileSync(`${ROOT}/index.ts`, 'utf8'));
    const values = [...index.matchAll(/^export \{([^}]*)\} from/gm)].flatMap((match) => (match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)).sort();
    assert.deepEqual(values, [
      'XRPL_LEDGER_INDEX_MAXIMUM',
      'XRPL_MAINNET_NETWORK_ID',
      'XRPL_NETWORK_IDENTITIES',
      'XRPL_VALIDATED_READER_LIMITS',
      'XRPL_VALIDATED_READ_FAILURES',
      'XrplSequenceOwnershipError',
      'XrplValidatedReaderConfigurationError',
      'assertXrplSequenceOwnership',
      'bindXrplValidatedAnswer',
      'checkXrplNetworkIdentity',
      'createXrplValidatedLedgerReader',
      'isPermittedXrplNetworkId',
      'isXrplEngineResult',
      'isXrplLedgerHash',
      'isXrplLedgerIndex',
      'isXrplNodePublicKey',
      'isXrplSigningPublicKey',
      'isXrplTransactionHash',
      'readXrplInclusion',
      'readXrplLedgerHeader',
      'readXrplLedgerIndex',
      'readXrplNetworkId',
      'readXrplServerValidatedLedger',
      'readXrplSubmission',
      'readXrplValidatedLedgerHeader',
      'xrplNonInclusionProven',
      'xrplSequenceWindowBlocks',
      'xrplWindowClosed',
    ]);
    for (const source of TRANSPORT) {
      for (const match of codeOf(source.text).matchAll(/export function (\w+)\(([^)]*)\)/g)) assert.equal(/blob|signed/i.test(match[2] ?? ''), false, `${source.path}: ${match[1]} takes a signed transaction`);
    }
  });

  it('the read port has exactly three read requests, and the entry request admits only the validated ledger', () => {
    const code = codeOf(readFileSync(`${ROOT}/xrpl-validated-ledger-reader.ts`, 'utf8'));
    const port = /export interface XrplValidatedLedgerReadPort \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.deepEqual([...port.matchAll(/^\s*(\w+)\s*\(/gm)].map((match) => match[1]), ['serverInfo', 'ledgerHeader', 'ledgerEntry']);
    assert.match(code, /export type XrplValidatedLedgerEntryRequest = XrplLedgerEntrySelector & \{ readonly ledger_index: 'validated' \};/);
    assert.equal(/'current'|'closed'/.test(code), false, 'never an open or closed ledger');
    const members = new Set([...code.matchAll(/\bport\.(\w+)/g)].map((match) => match[1]));
    assert.deepEqual([...members].sort(), ['ledgerEntry', 'ledgerHeader', 'serverInfo']);
    for (const method of ['serverInfo', 'ledgerHeader', 'ledgerEntry']) assert.equal([...code.matchAll(new RegExp(String.raw`ask\(\(\) => port\.${method}\(`, 'g'))].length, 1, `${method}: one bounded call site`);
  });

  it('every caught port failure becomes a closed code: no caught error value is inspected or forwarded', () => {
    for (const source of TRANSPORT) assert.equal(/catch\s*\(\s*\w+\s*\)/.test(codeOf(source.text)), false, source.path);
  });

  it('only the approved importers reach it: the PAY-02 codec and result reader and the PAY-03 interlock; nothing else yet', () => {
    const production = ['src', 'packages', 'scripts', 'apps'].flatMap((root) => walk(root, false)).filter((path) => !path.startsWith(`${ROOT}/`));
    const importers = production.filter((path) => importsOf(readFileSync(path, 'utf8')).some((specifier) => /xrpl-transport\//.test(specifier)));
    assert.deepEqual(importers.sort(), [
      'src/enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.ts',
      'src/features/payment-runtime/rails/xrpl/xrpl-codec.ts',
      'src/features/payment-runtime/rails/xrpl/xrpl-result-normalizer.ts',
    ]);
  });

  it('is off every published surface: no package export or entrypoint reaches it', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown };
    assert.equal(JSON.stringify(pkg.exports ?? {}).includes('xrpl-transport'), false);
    for (const entry of ['src/index.ts', 'src/runtime/index.ts', 'src/enterprise/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(entry)) assert.equal(/xrpl-transport/.test(readFileSync(entry, 'utf8')), false, entry);
    }
  });
});

describe('TRADE-04A shared XRPL transport — negative fixtures: every scan fails on a synthetic violation', () => {
  const fixture = (text: string): readonly Source[] => [{ path: `${ROOT}/x.ts`, text }];

  // Assembled at runtime: repository-wide scanners (PAY-02's SDK-importer and submit-site lists, NO_BYPASS's
  // network inventory) read every file textually, tests included, and a literal sample would count as a real site.
  it('a non-leaf import is caught', () => {
    for (const specifier of ['xrpl', '../payment-runtime/index.js', 'node:' + 'https', '../../enterprise/x.js', '../execution-runtime/index.js']) {
      assert.equal(leafImports(fixture(`import { x } from '${specifier}';`)).length, 1, specifier);
    }
    assert.deepEqual(leafImports(fixture("import { x } from './xrpl-ledger-grammar.js';")), []);
  });

  it('business vocabulary is caught', () => {
    for (const text of ["const t = { TransactionType: 'Payment' };", 'const x = tx.TakerGets;', 'if (policy.allows) {}', 'const g: BoundedGrant = y;', 'read(meta.delivered_amount);']) {
      assert.ok(businessLogic(fixture(text)).length > 0, text);
    }
  });

  it('effects are caught', () => {
    for (const text of [
      ['const c = new', 'Client(url);'].join(' '),
      ['await c.request({ command:', "'sub" + "mit' });"].join(' '),
      'await client.submit(blob);',
      'const s = wallet.sign(tx);',
      ['const w = Wallet.', 'fromSeed(v);'].join(''),
      'for (let i = 0; i < 3; i++) retry();',
      "const tx = { TransactionType: 'AccountSet' };",
    ]) {
      assert.ok(effects(fixture(text)).length > 0, text);
    }
  });
});
