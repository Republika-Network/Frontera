import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, parsePreparedXrplPayment } from '../xrpl-payment-rail/signer-protocol.js';
import { CORE_SOURCE_CLASSIFICATION, CORE_SOURCE_ROOTS, listCoreSources } from './pay07-core-source-manifest.js';

/**
 * TRADE — the trade vertical's place in the architecture, enforced
 * structurally (TRADE-02 preflight):
 *
 * - TRADE is an independent governed-action vertical: not generic CORE, not a
 *   PAY rail, not a payment-protocol adapter. PAY-04's M39 scan classifies it
 *   out of CORE only so that it may name its venue; every other boundary is
 *   checked here, against TRADE itself;
 * - **independence both ways**: nothing in generic CORE, in PAY, in the
 *   packages, scripts or apps depends on TRADE (there is no approved TRADE
 *   composition edge yet), and TRADE depends on no PAY module;
 * - **no second governance engine**: TRADE compiles into the one
 *   governed-action envelope and decides nothing — no policy evaluation, no
 *   grant, no orchestrator, no execution adapter;
 * - **no effect**: TRADE imports no XRPL SDK or codec, signs nothing,
 *   submits nothing, opens no connection and holds no key material. The
 *   repository-wide SDK importer list (PAY-02, `xrpl-rail-boundaries`) and
 *   the one submit request stay exactly as they are;
 * - **PAY-03's signer stays Payment-only**: one operation, two paths, and a
 *   prepared OfferCreate is not a signable transaction.
 *
 * Each scan is a pure predicate over (path, text) pairs; the `negative
 * fixtures` block runs the same predicates over synthetic violations so a
 * scan that silently matches nothing fails here.
 */

const TRADE_ROOT = 'src/features/trade-runtime';
const PAY_ROOTS = ['src/features/payment-runtime', 'src/enterprise/xrpl-payment-rail', 'src/enterprise/payment-protocol-ingress', 'src/enterprise/payment-settlement'];
/**
 * Approved enterprise composition edges for TRADE. Exactly two, each added by
 * an explicit architectural approval and held to its own structure test:
 *
 * - TRADE-03 K1: the CORE-04 trusted-context provider and its in-process
 *   ingress (`trade03-risk-context-structure.test.ts`): no effect, no
 *   decision, no grant;
 * - TRADE-04B: the protected delegated OfferCreate signer edge — the closed
 *   signer protocol, Host-side signature verification, its HTTP transport
 *   (EP-073), the Host-side client, and the separate reference signer process
 *   (`trade04b-protected-signer-structure.test.ts`): it reads TRADE-01's
 *   grammar only, is composed nowhere, decides nothing and submits nothing.
 *
 * TRADE itself still signs, submits and holds nothing (below).
 */
/*
 * - TRADE-04C (gates G2, G4): the governed delegated OfferCreate executor edge — the execution adapter, its
 *   durable trade sequence interlock, the P12 trade resolution authority, evidence, and the Host configuration and
 *   composition (`trade04c-governed-executor-structure.test.ts`): reached only from the Host's boot, below the
 *   bounded grant, through the existing adapter registry.
 */
const TRADE_COMPOSITION_EDGES: readonly string[] = ['src/enterprise/trade-risk-context', 'src/enterprise/xrpl-trade-rail', 'src/enterprise/xrpl-trade-execution'];
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

interface Source {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === '__tests__' || name === 'fixtures') continue;
      out.push(...walk(full));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(full) && !full.endsWith('.d.ts') && !full.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const read = (path: string): Source => ({ path, text: readFileSync(path, 'utf8') });

/** Comments stripped, string literals kept. */
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const TRADE = walk(TRADE_ROOT).map(read);
const PAY = PAY_ROOTS.flatMap(walk).map(read);
/** Everything in the repository's production code that is not TRADE: generic CORE, PAY, packages, scripts, apps. */
const NOT_TRADE = ['src', 'packages', 'scripts', 'apps']
  .flatMap(walk)
  .filter((path) => !path.startsWith(`${TRADE_ROOT}/`) && !TRADE_COMPOSITION_EDGES.some((edge) => path.startsWith(`${edge}/`)))
  .map(read);

/** The PAY-02 SDK-import pattern (`xrpl-rail-boundaries.test.ts`), verbatim: a value or type import of the XRPL SDK or one of its codec / key libraries. */
const SDK_MODULE = String.raw`['"](?:xrpl|ripple-(?:binary-codec|keypairs|address-codec|lib)|@xrplf\/[^'"]+)(?:\/[^'"]*)?['"]`;
const XRPL_SDK_IMPORT = new RegExp(String.raw`^\s*(?:import|export)\b[^;\n]*\bfrom\s+${SDK_MODULE}|\brequire\s*\(\s*${SDK_MODULE}|\bimport\s*\(\s*${SDK_MODULE}`, 'm');

type Scan = (sources: readonly Source[]) => readonly string[];

/** (1, 2) Any reference to the trade vertical, by path or by name. */
const dependsOnTrade: Scan = (sources) => sources.filter((source) => /trade-runtime/.test(source.text)).map((source) => source.path);

/** TRADE reaching any PAY module — the payment vertical, a rail, its signer, its ingress or its settlement. */
const dependsOnPay: Scan = (sources) =>
  sources.flatMap((source) =>
    importsOf(source.text)
      .filter((specifier) => /payment-runtime|xrpl-payment-rail|payment-protocol-ingress|payment-settlement|rails\/|protocols\//.test(specifier))
      .map((specifier) => `${source.path} imports '${specifier}'`),
  );

/** (3) TRADE may import itself, three generic primitives through their barrels, and the hash function. Nothing that decides. */
const TRADE_IMPORTS = /^(?:\.\/|\.\.\/domain\/|\.\.\/\.\.\/(?:execution-runtime|monetary-runtime|governed-parameter-runtime)\/index\.js$|node:crypto$)/;
const GOVERNANCE_ENGINE = [/\bevaluate\s*\(|\bdecide\s*\(|PolicyPack|policy-condition-evaluator/, /issueFromDecision|createGrantIssuanceService|BoundedGrant|\.exercise\s*\(/, /GovernedActionOrchestrator|createGovernedActionOrchestrator|\.govern\s*\(/, /ExecutionAdapter|executionAdapter/];
const secondGovernanceEngine: Scan = (sources) =>
  sources.flatMap((source) => [
    ...importsOf(source.text)
      .filter((specifier) => !TRADE_IMPORTS.test(specifier) && !(source.path.startsWith(`${TRADE_ROOT}/rails/xrpl/`) && specifier === '../../domain/index.js'))
      .map((specifier) => `${source.path} imports '${specifier}'`),
    ...GOVERNANCE_ENGINE.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`),
  ]);

/** (4) Signing. */
const SIGNING = [/\bsign\s*\(|\bmultisign\s*\(|signTransaction|signPayment|createSign\b/, /external-xrpl-signer|signer-protocol|signer-http-transport|sign-xrpl-/];
/** (5) Submission and network. */
const SUBMISSION = [/\.submit\s*\(|submitAndWait|\bautofill\s*\(/, /command:\s*['"]submit(?:_multisigned)?['"]/, /\bnew\s+Client\s*\(/, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bconnect\s*\(/, /^(?:node:)?(?:http|https|net|tls|dgram|dns|child_process|worker_threads)$/];
/** (6) Custody: seeds, keys, wallets. */
const CUSTODY = [/\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|generateKeyPair|createPrivateKey/, /\bprivateKey\s*[:=(]|\bseed\s*[:=(]|\bmnemonic\s*[:=(]|\bsecret\s*[:=(]/i, /ripple-keypairs|secret-numbers/];

const effects: Scan = (sources) =>
  sources.flatMap((source) => {
    const code = codeOf(source.text);
    const specifiers = importsOf(source.text);
    return [
      ...(XRPL_SDK_IMPORT.test(source.text) ? [`${source.path}: XRPL SDK import`] : []),
      ...[...SIGNING, ...CUSTODY].filter((pattern) => pattern.test(code)).map((pattern) => `${source.path}: ${String(pattern)}`),
      ...SUBMISSION.filter((pattern) => pattern.test(code) || specifiers.some((specifier) => pattern.test(specifier))).map((pattern) => `${source.path}: ${String(pattern)}`),
    ];
  });

describe('TRADE vertical — classification and independence', () => {
  it('scans non-trivial sets', () => {
    assert.ok(TRADE.length >= 7, `found ${TRADE.length} trade sources`);
    assert.ok(PAY.length >= 30, `found ${PAY.length} pay sources`);
    assert.ok(NOT_TRADE.length > 500, `found ${NOT_TRADE.length} other sources`);
    assert.ok(NOT_TRADE.some((source) => source.path === 'src/enterprise/governed-action/orchestrator.ts'));
    assert.ok(NOT_TRADE.some((source) => source.path === 'src/kernel/index.ts'));
  });

  it('(1) generic CORE — and the packages, scripts and apps — never depend on TRADE; the approved composition edges are the TRADE-03 trusted-context provider, the TRADE-04B delegated signer edge and the TRADE-04C governed executor edge', () => {
    assert.deepEqual(TRADE_COMPOSITION_EDGES, ['src/enterprise/trade-risk-context', 'src/enterprise/xrpl-trade-rail', 'src/enterprise/xrpl-trade-execution']);
    assert.deepEqual(dependsOnTrade(NOT_TRADE), []);
  });

  it('(2) PAY never depends on TRADE: the payment vertical, the XRPL rail edge, the protocol ingress and settlement', () => {
    assert.deepEqual(dependsOnTrade(PAY), []);
  });

  it('TRADE never depends on PAY: no payment vertical, rail, protocol adapter, signer, ingress or settlement', () => {
    assert.deepEqual(dependsOnPay(TRADE), []);
  });

  it('(3) TRADE is no second governance engine: it imports only generic primitives and decides, grants, orchestrates and executes nothing', () => {
    assert.deepEqual(secondGovernanceEngine(TRADE), []);
  });
});

describe('TRADE vertical — PAY-07 classifies it outside the qualified CORE, deliberately', () => {
  const features = CORE_SOURCE_CLASSIFICATION['src/features'];
  /** PAY-07's drift rule, applied to a listing: what is neither in scope nor outside with a reason. */
  const unclassified = (present: readonly string[]): readonly string[] => present.filter((name) => !(features?.scope.includes(name) ?? false) && !Object.hasOwn(features?.outside ?? {}, name));

  it('trade-runtime is classified outside, by name and with a reason — not in scope, and under no CORE root', () => {
    assert.ok(features !== undefined);
    assert.equal(features.scope.includes('trade-runtime'), false);
    assert.match(features.outside['trade-runtime'] ?? '', /governed-action vertical/);
    assert.equal(CORE_SOURCE_ROOTS.some((root) => root.root === TRADE_ROOT || root.root.startsWith(`${TRADE_ROOT}/`)), false);
    assert.deepEqual(listCoreSources().filter((file) => file.startsWith(`${TRADE_ROOT}/`)), [], 'no TRADE source is in the qualified CORE manifest');
  });

  it('the classification is exact, not a wildcard: every real feature directory is classified, and an unknown one still fails the drift rule', () => {
    assert.deepEqual(unclassified(readdirSync('src/features')), []);
    assert.deepEqual(unclassified(['trade-runtime', 'trade-runtime-next', 'some-new-feature']), ['trade-runtime-next', 'some-new-feature']);
    for (const name of Object.keys(features?.outside ?? {})) assert.equal(/[*?]/.test(name), false, name);
  });
});

describe('TRADE vertical — no signing, no submission, no custody', () => {
  it('(4, 5, 6) TRADE imports no XRPL SDK or codec, signs nothing, submits nothing, opens no connection and holds no key material', () => {
    assert.deepEqual(effects(TRADE), []);
  });

  it('(7) no new XRPL SDK importer: no TRADE file — production or test — imports the SDK; PAY-02 keeps the repository-wide list exact', () => {
    const everything = (dir: string): readonly string[] => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? everything(full) : /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(full) ? [full] : [];
      });
    };
    assert.deepEqual(everything(TRADE_ROOT).filter((path) => XRPL_SDK_IMPORT.test(readFileSync(path, 'utf8'))), []);
  });
});

describe('TRADE vertical — PAY-03 and PAY-04 unchanged', () => {
  it('(8) PAY-03’s signer is still Payment-only: one operation, two paths, and an OfferCreate — delegated or not — is not signable', () => {
    assert.equal(EXTERNAL_XRPL_SIGNER_OPERATION, 'sign-xrpl-payment');
    assert.deepEqual(Object.values(EXTERNAL_XRPL_SIGNER_PATHS).sort(), ['/v1/identity', '/v1/sign/xrpl-payment']);
    const payment = {
      TransactionType: 'Payment',
      Account: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn',
      Destination: 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX',
      Amount: { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '10' },
      Flags: 0,
      LastLedgerSequence: 100,
      Sequence: 7,
      Fee: '12',
    };
    assert.notEqual(parsePreparedXrplPayment(payment), undefined, 'control: the Payment itself is accepted');
    assert.equal(parsePreparedXrplPayment({ ...payment, TransactionType: 'OfferCreate' }), undefined);
    assert.equal(parsePreparedXrplPayment({ ...payment, Delegate: 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX' }), undefined);
    const { Destination: _destination, Amount: _amount, ...rest } = payment;
    assert.equal(parsePreparedXrplPayment({ ...rest, TransactionType: 'OfferCreate', TakerGets: '1000000', TakerPays: payment.Amount }), undefined);
    for (const file of walk('src/enterprise/xrpl-payment-rail')) assert.equal(/OfferCreate|trade-runtime/.test(readFileSync(file, 'utf8')), false, file);
  });

  it('(9) PAY-04’s ingress is untouched by TRADE: it names no trade vertical and no venue', () => {
    for (const file of walk('src/enterprise/payment-protocol-ingress')) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/trade-runtime/, /\btrade\b/i, /OfferCreate/, /xrpl/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('TRADE vertical — negative fixtures: every scan fails on a synthetic violation', () => {
  const fixture = (path: string, text: string): readonly Source[] => [{ path, text }];

  it('(10) a dependency on TRADE from CORE or PAY is caught', () => {
    assert.equal(dependsOnTrade(fixture('src/kernel/x.ts', "import { compileTradeProposal } from '../features/trade-runtime/index.js';")).length, 1);
    assert.equal(dependsOnTrade(fixture('src/features/payment-runtime/x.ts', "export * from '../trade-runtime/index.js';")).length, 1);
    assert.equal(dependsOnTrade(fixture('src/kernel/x.ts', 'export const trading = 1;')).length, 0);
  });

  it('(10) a dependency on PAY from TRADE is caught', () => {
    for (const specifier of ['../../payment-runtime/index.js', '../../payment-runtime/rails/xrpl/index.js', '../../../enterprise/xrpl-payment-rail/signer-protocol.js', '../../../enterprise/payment-settlement/index.js']) {
      assert.equal(dependsOnPay(fixture(`${TRADE_ROOT}/x.ts`, `import { x } from '${specifier}';`)).length, 1, specifier);
    }
  });

  it('(10) a second governance engine in TRADE is caught', () => {
    for (const text of [
      "import { evaluate } from '../../../kernel/index.js';",
      "import { x } from '../../grant-runtime/index.js';",
      'const decision = engine.evaluate(intent);',
      'const result = await orchestrator.govern(identity, intent);',
      'const adapter: ExecutionAdapter = build();',
      'const grant = issueFromDecision(decision);',
    ]) {
      assert.ok(secondGovernanceEngine(fixture(`${TRADE_ROOT}/x.ts`, text)).length > 0, text);
    }
  });

  // The samples below are assembled at runtime, not written out: sibling
  // repository-wide scanners (PAY-02's submit-site and SDK-importer lists, the
  // NO_BYPASS network inventory) read every file, tests included, textually,
  // and a literal sample here would count as a real site to them.
  it('(10) an XRPL SDK import, a signature, a submission, a connection or key material in TRADE is caught', () => {
    for (const text of [
      ['import { Client } from', "'xrpl';"].join(' '),
      ['import type { Wallet } from', '"xrpl/dist/npm";'].join(' '),
      ['const codec = require(', "'ripple-binary-codec');"].join(''),
      ['const m = await import(', "'@xrplf/secret-numbers');"].join(''),
      'const signed = wallet.sign(tx);',
      'await client.submit(blob);',
      'await client.submitAndWait(tx);',
      ['await client.request({ command:', "'sub" + "mit',", 'tx_blob });'].join(' '),
      ['const client = new', 'Client(url);'].join(' '),
      ['await', 'fetch(url);'].join(' '),
      ['import { request } from', "'node:" + "https';"].join(' '),
      ['const w = Wallet.', 'fromSeed(value);'].join(''),
      'const privateKey = load();',
    ]) {
      assert.ok(effects(fixture(`${TRADE_ROOT}/x.ts`, text)).length > 0, text);
    }
    assert.deepEqual(effects(fixture(`${TRADE_ROOT}/x.ts`, "export const VENUE = 'XRPL'; // the venue is named, not reached")), []);
  });
});
