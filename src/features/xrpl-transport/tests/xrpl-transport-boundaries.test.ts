import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * TRADE-04A — what the shared XRPL transport is allowed to be, enforced
 * structurally:
 *
 * - **pure and leaf**: it imports only itself — no XRPL SDK or codec, no Node
 *   module, no other feature, no enterprise layer, no vertical. One file is
 *   the approved exception (TRADE-04B, approval gate G3): `xrpl-signature.ts`
 *   imports a pinned set of the SDK's **codec** functions (decode, encode,
 *   signing encoding, hash, signature verification) and nothing else, and is
 *   held below to every other rule — it signs nothing, holds no key, submits
 *   nothing and names no transaction type;
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
 *   reader, the PAY-03 interlock, and (TRADE-04B) the delegated OfferCreate
 *   protocol and verifier — and off every published surface.
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
/** TRADE-04B (G3): the one transport file that may import the SDK — its codec, never a wallet, signer or client. */
const SIGNATURE = `${ROOT}/xrpl-signature.ts`;
/** Exactly the SDK names it may import, and exactly the module. */
const SIGNATURE_SDK_IMPORT = "import { decode, encode, encodeForSigning, hashes, verifySignature, type Transaction } from 'xrpl';";
/** Exactly what it exports: total questions about bytes. Each may take a signed blob; none submits, signs or holds anything. */
const SIGNATURE_EXPORTS = ['decodeXrplSignedBlob', 'isCanonicalXrplSignedBlob', 'isXrplSignedBlob', 'signedByPinnedKey', 'xrplSignedBlobHash', 'xrplSingleSigningEncoding'];
const PURE = TRANSPORT.filter((source) => source.path !== SIGNATURE);

type Scan = (sources: readonly Source[]) => readonly string[];

/** Only `./x.js` siblings. */
const leafImports: Scan = (sources) => sources.flatMap((source) => importsOf(source.text).filter((specifier) => !/^\.\/[a-z-]+\.js$/.test(specifier)).map((specifier) => `${source.path} imports '${specifier}'`));
/** G3: the signature file's imports — its siblings, plus `xrpl` through exactly the one pinned import statement. */
const signatureImports: Scan = (sources) =>
  sources.flatMap((source) => {
    const code = codeOf(source.text);
    const statements = [...code.matchAll(/^\s*import\b[^;]*;/gm)].map((match) => match[0].trim().replace(/\s+/g, ' '));
    const sdk = statements.filter((statement) => /from\s+'xrpl'/.test(statement));
    return [
      ...importsOf(source.text).filter((specifier) => specifier !== 'xrpl' && !/^\.\/[a-z-]+\.js$/.test(specifier)).map((specifier) => `${source.path} imports '${specifier}'`),
      ...(sdk.length === 1 && sdk[0] === SIGNATURE_SDK_IMPORT ? [] : [`${source.path}: the SDK import is not exactly the pinned codec import`]),
    ];
  });

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
/**
 * G3: the signature file is held to every effect rule, with one narrowing — it
 * may *verify* (`encodeForSigning`, `verifySignature`), never sign: the third
 * rule, without its verification names.
 */
const SIGNATURE_EFFECTS = [...EFFECTS.slice(0, 2), /\bsign\s*\(|multisign|signTransaction|createSign\b|computeSignature|\.sign\b/, ...EFFECTS.slice(3)];
const signatureEffects: Scan = (sources) => sources.flatMap((source) => SIGNATURE_EFFECTS.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`));

describe('TRADE-04A shared XRPL transport — boundaries', () => {
  it('has the expected production sources', () => {
    assert.deepEqual(TRANSPORT.map((source) => source.path.slice(ROOT.length + 1)).sort(), [
      'index.ts',
      'xrpl-ledger-grammar.ts',
      'xrpl-network-identity.ts',
      'xrpl-sequence-safety.ts',
      'xrpl-signature.ts',
      'xrpl-submission-reading.ts',
      'xrpl-validated-ledger-reader.ts',
      'xrpl-validated-ledger.ts',
    ]);
  });

  it('is a leaf: imports only itself — no SDK, no Node module, no feature, no enterprise layer, no vertical (G3: one pinned codec import, in one file)', () => {
    assert.deepEqual(leafImports(PURE), []);
    assert.ok(TRANSPORT.some((source) => source.path === SIGNATURE), 'the G3 signature file exists');
    assert.deepEqual(signatureImports(TRANSPORT.filter((source) => source.path === SIGNATURE)), []);
  });

  it('SEC-TRADE04A-03: knows no payment intent, trading strategy, policy, approval or grant', () => {
    assert.deepEqual(businessLogic(TRANSPORT), []);
  });

  it('SEC-TRADE04A-04/05: opens no connection, signs nothing, submits nothing, holds no key, retries nothing, builds no transaction', () => {
    assert.deepEqual(effects(PURE), []);
    assert.deepEqual(signatureEffects(TRANSPORT.filter((source) => source.path === SIGNATURE)), [], 'G3: the signature file verifies, never signs');
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
    for (const source of PURE) {
      for (const match of codeOf(source.text).matchAll(/export function (\w+)\(([^)]*)\)/g)) assert.equal(/blob|signed/i.test(match[2] ?? ''), false, `${source.path}: ${match[1]} takes a signed transaction`);
    }
    // G3: the signature file is not reached through the barrel, and takes blobs only to answer about them — its exports are pinned, and none returns a promise or takes a client.
    assert.equal(/xrpl-signature/.test(index), false, 'the barrel does not re-export the SDK-backed file');
    const signature = codeOf(readFileSync(SIGNATURE, 'utf8'));
    assert.deepEqual([...signature.matchAll(/^export (?:async )?function (\w+)\(/gm)].map((match) => match[1]).sort(), SIGNATURE_EXPORTS);
    assert.equal(/^export (?:const|let|class|default|\{)/m.test(signature), false, 'nothing else is exported');
    assert.equal(/\basync\b|Promise|\bawait\b|client|port\./i.test(signature), false, 'synchronous byte questions only: no client, no port, no promise');
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

  it('only the approved importers reach it: the PAY-02 codec and result reader, the PAY-03 interlock, and the TRADE-04B delegated OfferCreate protocol and verifier', () => {
    const production = ['src', 'packages', 'scripts', 'apps'].flatMap((root) => walk(root, false)).filter((path) => !path.startsWith(`${ROOT}/`));
    const importers = production.filter((path) => importsOf(readFileSync(path, 'utf8')).some((specifier) => /xrpl-transport\//.test(specifier)));
    assert.deepEqual(importers.sort(), [
      'src/enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.ts',
      'src/enterprise/xrpl-trade-rail/delegated-offer-protocol.ts',
      'src/enterprise/xrpl-trade-rail/delegated-offer-verification.ts',
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

  it('G3: the signature file\'s exception is exact — another SDK name, another SDK module, a second SDK import or a sign call is caught', () => {
    const at = (text: string): readonly Source[] => [{ path: SIGNATURE, text }];
    assert.deepEqual(signatureImports(at(SIGNATURE_SDK_IMPORT)), [], 'control: the pinned import passes');
    for (const text of [
      SIGNATURE_SDK_IMPORT.replace('decode,', 'decode, Wallet,'),
      SIGNATURE_SDK_IMPORT.replace("'xrpl'", "'ripple-" + "keypairs'"),
      `${SIGNATURE_SDK_IMPORT}\nimport { Client } from 'xrpl';`,
      ['import { x } from', "'node:" + "https';"].join(' '),
    ]) {
      assert.ok(signatureImports(at(text)).length > 0, text);
    }
    for (const text of ['const s = wallet.sign(tx);', 'computeSignature(tx, key);', ['const w = Wallet.', 'fromSeed(v);'].join(''), 'await client.submit(blob);']) {
      assert.ok(signatureEffects(at(text)).length > 0, text);
    }
    assert.deepEqual(signatureEffects(at('return verifySignature(blob, key) && encodeForSigning(tx) !== undefined;')), [], 'control: verification is the exception');
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
