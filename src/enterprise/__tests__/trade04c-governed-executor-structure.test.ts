import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRADE_NETWORKS } from '../../features/trade-runtime/index.js';
import { XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET, XRPL_RESTART_QUARANTINE_LEDGERS } from '../../features/payment-runtime/rails/xrpl/index.js';
import { XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET, XRPL_SHARED_RESTART_QUARANTINE_LEDGERS, assertXrplSequenceOwnership } from '../../features/xrpl-transport/index.js';
import { TRADE_EXECUTOR_LIMITS } from '../xrpl-trade-execution/index.js';

/**
 * TRADE-04C — the governed executor edge, enforced structurally (gates G2,
 * G4). Each scan is a pure predicate over source text; the negative fixtures
 * below prove each one detects what it guards.
 *
 * - the edge is reached only by the Host's boot (dynamic import, when the
 *   file configures `xrplTradeExecution`) — no route, no package export, no
 *   other composition;
 * - the signer client, the reserved submission client and the trade
 *   interlock are each built in exactly one place (the edge's Host
 *   composition), and the signer port and `submitReserved` each have exactly
 *   one caller (the executor);
 * - inside the executor, the order is fixed: bind → recorded → preflight →
 *   sign → verify → reserve → submit → finality; and every refusal before the
 *   submission leaves through `Refusal`, after it only `unconfirmed`;
 * - no retry vocabulary, no autofill, no SDK, no key material, no mainnet,
 *   no `not-submitted` release, no DELETE in the interlock;
 * - Payment and Trade sequence domains are asserted disjoint at boot before
 *   either interlock is opened (also pinned by TRADE-04A's tripwire).
 */

const EDGE = 'src/enterprise/xrpl-trade-execution';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

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
    } else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(full) && !full.endsWith('.d.ts') && !full.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

interface Source {
  readonly path: string;
  readonly text: string;
}
const read = (path: string): Source => ({ path, text: readFileSync(path, 'utf8') });
const EDGE_SOURCES = walk(EDGE).map(read);
const PRODUCTION = ['src', 'packages', 'scripts', 'apps'].flatMap(walk).map(read);
const code = (path: string): string => codeOf(readFileSync(path, 'utf8'));

/** What the edge may import: itself, the trade vertical and its rail, the shared transport (barrel), the Payment rail barrel (G2 client only), and the CORE seams it composes against. */
const ALLOWED = /^(?:\.\/[a-z-]+\.js|\.\.\/\.\.\/features\/(?:execution-runtime|trade-runtime|xrpl-transport)\/index\.js|\.\.\/\.\.\/features\/trade-runtime\/rails\/xrpl\/index\.js|\.\.\/\.\.\/features\/payment-runtime\/rails\/xrpl\/index\.js|\.\.\/(?:trade-risk-context|xrpl-trade-rail)\/index\.js|\.\.\/authority-state-freshness\/(?:checkpoint|errors|session)\.js|\.\.\/authority-authenticity\/delegated-offer-capability-issuer\.js|\.\.\/execution-reconciliation\/authority\.js|\.\.\/external-authority-signer\/http-transport\.js|\.\.\/governance-store\/digest\.js|\.\.\/modules\/enterprise-module\.js|\.\.\/version\.js|node:(?:crypto|fs|path)|better-sqlite3)$/;
const disallowedImports = (sources: readonly Source[]): readonly string[] => sources.flatMap((source) => importsOf(source.text).filter((specifier) => !ALLOWED.test(specifier)).map((specifier) => `${source.path} imports '${specifier}'`));
/** TRADE-04B's own signer benchmark composes the client against the loopback reference only (pinned by `trade04b-protected-signer-structure.test.ts`); it is not a Host path. */
const TRADE04B_BENCH = 'scripts/trade/bench-delegated-offer-signer.mjs';
const usersOf = (pattern: RegExp, exclude: (path: string) => boolean = () => false): readonly string[] =>
  PRODUCTION.filter((source) => pattern.test(codeOf(source.text)) && !exclude(source.path) && source.path !== TRADE04B_BENCH)
    .map((source) => source.path)
    .sort();

const SDK_MODULE = String.raw`['"](?:xrpl|ripple-(?:binary-codec|keypairs|address-codec|lib)|@xrplf\/[^'"]+)(?:\/[^'"]*)?['"]`;
const SDK = new RegExp(String.raw`\bfrom\s+${SDK_MODULE}|\brequire\s*\(\s*${SDK_MODULE}|\bimport\s*\(\s*${SDK_MODULE}`);
const FORBIDDEN: readonly RegExp[] = [
  /\.submit\s*\(|submitAndWait|\bautofill\b|command:\s*['"]submit/,
  /\bnew\s+Client\s*\(|\bfetch\s*\(|\bWebSocket\b/,
  /\bretry|retries\b|resubmit|re-submit|resend|replay\(/i,
  /\bWallet\b|fromSeed|fromSecret|fromMnemonic|deriveKeypair|createPrivateKey|\bprivateKey\s*[:=(]|\bseed\s*[:=(]/i,
  /xrp-ledger-mainnet|allowMainnet:\s*true|networkId:\s*0\b/,
  /'not-submitted'/,
];
const effects = (sources: readonly Source[]): readonly string[] =>
  sources.flatMap((source) => {
    // The Host environment guard names key-variable *words* in order to refuse them; it is the one exempt expression.
    const text = codeOf(source.text).replace('/(SEED|SECRET|PRIVATE|MNEMONIC|WALLET)/', '');
    return [...(SDK.test(source.text) ? [`${source.path}: XRPL SDK import`] : []), ...FORBIDDEN.filter((pattern) => pattern.test(text)).map((pattern) => `${source.path}: ${String(pattern)}`)];
  });

describe('TRADE-04C structure — the edge and who reaches it', () => {
  it('has exactly the TRADE-04C files', () => {
    assert.deepEqual(EDGE_SOURCES.map((source) => source.path.slice(EDGE.length + 1)).sort(), [
      'host-composition.ts',
      'host-configuration.ts',
      'index.ts',
      'sqlite-trade-sequence-interlock.ts',
      'trade-execution-details.ts',
      'trade-execution-evidence.ts',
      // TRADE-04D: the read-only recovery and validated-ledger reconciliation modules.
      'trade-ledger-evidence.ts',
      'trade-offer-executor.ts',
      'trade-offer-state.ts',
      'trade-recovery-assessment.ts',
      'trade-recovery-coordinator.ts',
      'trade-resolution-authority.ts',
      // TRADE-04D D-1: the read-only owner-Sequence evidence for an intent with no reservation.
      'trade-sequence-evidence.ts',
    ]);
  });

  it('imports only its allowlist', () => {
    assert.deepEqual(disallowedImports(EDGE_SOURCES), []);
  });

  it('nothing outside reaches it but the Host’s configuration (pure section parser), the Host boot (dynamic composition, type and env guard) and the portability registry (verification open)', () => {
    const importers = PRODUCTION.filter((source) => !source.path.startsWith(`${EDGE}/`) && importsOf(source.text).some((specifier) => /xrpl-trade-execution\//.test(specifier))).map((source) => source.path).sort();
    // The portability registry loads the interlock module by its dist path through its own loader (verification only); it is pinned by the next suite.
    assert.deepEqual(importers, ['src/enterprise/host/enterprise-host.ts', 'src/enterprise/host/host-configuration.ts']);
    const host = code('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /if \(tradeConfiguration !== undefined\) \{[\s\S]*?await import\('\.\.\/xrpl-trade-execution\/host-composition\.js'\)/, 'composed only when configured, by dynamic import');
    assert.equal(/from '\.\.\/xrpl-trade-execution\/host-composition\.js'/.test(host.replace(/import type \{[^}]*\} from '\.\.\/xrpl-trade-execution\/host-composition\.js';/, '')), false, 'the Host imports the composition statically only as types');
    for (const entry of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) if (existsSync(entry)) assert.equal(/xrpl-trade-execution/.test(readFileSync(entry, 'utf8')), false, entry);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown };
    assert.equal(/xrpl-trade-execution|trade-execution/.test(JSON.stringify(pkg.exports ?? {})), false);
  });

  it('no route: no HTTP handler, server or API module names the executor, its interlock or its submission client', () => {
    for (const source of PRODUCTION.filter((entry) => /src\/enterprise\/(?:api|adapters|operator-control|host\/enterprise-server)/.test(entry.path) || entry.path.startsWith('src/control-plane-web/'))) {
      assert.equal(/xrpl-trade-execution|submitReserved|createTradeOfferExecutionAdapter|DelegatedOfferSigningPort/.test(source.text), false, source.path);
    }
  });
});

describe('TRADE-04C structure — one place builds each capability; one caller uses it', () => {
  it('the delegated offer signer client, the reserved submission client and the trade interlock are built only by the edge’s Host composition (plus the verification open)', () => {
    assert.deepEqual(usersOf(/\bcreate(?:DelegatedOfferSigner|HttpDelegatedOfferSignerTransport)\s*\(/, (path) => path.startsWith('src/enterprise/xrpl-trade-rail/')), [`${EDGE}/host-composition.ts`]);
    assert.deepEqual(usersOf(/\bcreateXrplReservedSubmissionClient\s*\(/, (path) => path.endsWith('/rails/xrpl/xrpl-sdk-client.ts')), [`${EDGE}/host-composition.ts`]);
    assert.deepEqual(usersOf(/\bcreateSqliteTradeSequenceInterlock\s*\(/, (path) => path === `${EDGE}/sqlite-trade-sequence-interlock.ts`), ['scripts/portability/store-registry.mjs', `${EDGE}/host-composition.ts`]);
    assert.deepEqual(usersOf(/\bcreateTradeOfferExecutionAdapter\s*\(/, (path) => path === `${EDGE}/trade-offer-executor.ts`), [`${EDGE}/host-composition.ts`]);
  });

  it('the signing port and submitReserved each have exactly one call site, in the executor', () => {
    assert.deepEqual(usersOf(/\.signDelegatedOffer\s*\(/, (path) => path.startsWith('src/enterprise/xrpl-trade-rail/')), [`${EDGE}/trade-offer-executor.ts`]);
    assert.deepEqual(usersOf(/\.submitReserved\s*\(/), [`${EDGE}/trade-offer-executor.ts`]);
    const executor = code(`${EDGE}/trade-offer-executor.ts`);
    assert.equal([...executor.matchAll(/signer\.signDelegatedOffer\(/g)].length, 1);
    assert.equal([...executor.matchAll(/ledger\.submitReserved\(/g)].length, 1);
  });

  it('the resolver holds no write: the read-only ledger view has exactly four reads', () => {
    const resolver = code(`${EDGE}/trade-resolution-authority.ts`);
    const view = resolver.slice(resolver.indexOf('export function readOnlyTradeLedger('), resolver.indexOf('export interface TradeResolutionInterlockAccess'));
    assert.deepEqual([...view.matchAll(/^\s+(\w+): \(/gm)].map((match) => match[1]), ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction']);
    assert.equal(/submit|claimSubmission|reserve\(|signDelegatedOffer/.test(resolver), false);
  });
});

describe('TRADE-04C structure — the executor’s order, and no effect it may not have', () => {
  it('bind → recorded → preflight → sign → independent check → reserve → submitReserved → finality, in that order, inside one owner queue', () => {
    const executor = code(`${EDGE}/trade-offer-executor.ts`);
    const body = executor.slice(executor.indexOf('async function execute('));
    // TRADE-04C-S1: the per-order capability is issued after the preflight and before the one signing call.
    const markers = ['bind(action, attested, binding)', 'serialized(pair.ownerAccount', 'interlock.recorded(executionId)', 'interlock.readIntent(executionId)', 'preflight(action, bound, pair, timings)', 'interlock.recordIntent(', 'authorization.issuer.issue(', 'interlock.markSigning(executionId, issued.capability.capabilityId)', 'signer.signDelegatedOffer(', 'canonicalTradeJson(signature.transaction) !== canonicalTradeJson(prepared.offer)', 'interlock.reserve(', 'ledger.submitReserved(executionId, signature.signedTransaction)', 'awaitFinality(executionId'];
    const order = markers.map((marker) => body.indexOf(marker));
    for (const [index, position] of order.entries()) assert.notEqual(position, -1, markers[index] ?? "");
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const preflight = executor.slice(executor.indexOf('async function preflight('), executor.indexOf('async function awaitFinality('));
    const steps = ['reader.validatedLedger()', 'quarantine.quarantined(V', 'verifier.verify(request.request, { minimumValidatedLedgerIndex: V })', 'assessXrplDelegateSigningKey(', 'readXrplOwnerSequence(', 'index < V || index > V + span', 'interlock.blocking('];
    const positions = steps.map((marker) => preflight.indexOf(marker));
    for (const [index, position] of positions.entries()) assert.notEqual(position, -1, steps[index] ?? "");
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  });

  it('after the one submission nothing is definitive but a ledger fact: every catch after it is unconfirmed', () => {
    const executor = code(`${EDGE}/trade-offer-executor.ts`);
    const after = executor.slice(executor.indexOf('ledger.submitReserved(executionId'), executor.indexOf('} catch (error) {\n      // Reached only before anything was submitted.'));
    for (const match of after.matchAll(/catch(?: \([a-z]+\))? \{([\s\S]*?)\n\s{8,10}\}/g)) assert.equal(/outcome: 'failed'|Refusal/.test(match[1] ?? ''), false, match[0]);
    assert.equal(/'completed'/.test(executor.slice(executor.indexOf('async function awaitFinality('), executor.indexOf('async function settleQuietly('))), true, 'completion only from a validated tesSUCCESS read');
    assert.match(executor, /if \(reading\.engineResult === 'tesSUCCESS'\)/);
  });

  it('no SDK, connection, autofill, retry, key material, mainnet or not-submitted release anywhere in the edge', () => {
    assert.deepEqual(effects(EDGE_SOURCES), []);
    assert.equal(/DELETE\s+FROM|DROP\s+TABLE|DROP\s+TRIGGER/i.test(code(`${EDGE}/sqlite-trade-sequence-interlock.ts`).replace(/BEFORE DELETE ON/g, '')), false, 'the interlock never deletes');
  });

  it('the fee is configured, never read from the ledger; Sequence is the owner’s; LastLedgerSequence is the reference + the bounded offset', () => {
    const executor = code(`${EDGE}/trade-offer-executor.ts`);
    assert.match(executor, /fee: configuration\.feeDrops, lastLedgerSequence: V \+ lastLedgerOffset/);
    assert.match(executor, /readXrplOwnerSequence\(ownerRoot\.value\.entry\.node, pair\.ownerAccount\)/);
    assert.equal(/delegateRoot[\s\S]{0,80}Sequence/.test(executor.replace(/readXrplOwnerSequence\(ownerRoot/g, '')), false, 'the delegate’s Sequence is never used');
  });

  it('the trade offset bound is the shared historical bound every XRPL restart quarantine assumes (equal to PAY-03’s), and mainnet is not a trade network', () => {
    assert.equal(TRADE_EXECUTOR_LIMITS.lastLedgerOffset.maximum, XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET);
    assert.equal(XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET, XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET);
    assert.equal(XRPL_SHARED_RESTART_QUARANTINE_LEDGERS, XRPL_RESTART_QUARANTINE_LEDGERS);
    assert.deepEqual(Object.values(TRADE_NETWORKS).map((network) => network.networkId).sort(), [1, 2]);
    const host = code('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /const TRADE_NETWORK_IDS: Readonly<Record<string, number>> = Object\.freeze\(\{ 'xrp-ledger-testnet': 1, 'xrp-ledger-devnet': 2 \}\);/, 'the Host’s restatement equals TRADE_NETWORKS');
  });

  it('the Host declares every XRPL domain through assertXrplSequenceOwnership, from configuration, before any interlock or signer', () => {
    const host = code('src/enterprise/host/enterprise-host.ts');
    const fn = host.slice(host.indexOf('function assertXrplDomainsDisjoint('), host.indexOf('const TRADE_NETWORK_IDS'));
    assert.match(fn, /sequenceAccounts: payment\.rail\.sourceAccounts\.map\(\(mapping\) => mapping\.address\)/, 'Payment: source accounts');
    assert.match(fn, /sequenceAccounts: trade\.executor\.pairs\.map\(\(pair\) => pair\.ownerAccount\)/, 'Trade: owner accounts, never delegates');
    assert.equal(/delegateAccount/.test(fn), false);
  });
});

describe('TRADE-04C — the ownership rule the Host applies, over Payment- and Trade-shaped domains', () => {
  const account = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
  const delegate = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
  const payment = (networkId: number, accounts: readonly string[] = [account]) => ({ domainId: 'xrpl-rlusd', networkId, sequenceAccounts: accounts });
  const trade = (networkId: number, owners: readonly string[] = [account]) => ({ domainId: 'xrpl-trade-offer-executor', networkId, sequenceAccounts: owners });

  it('same owner on the same network: refused; on different networks: allowed (separate Sequence spaces); distinct owners: allowed', () => {
    assert.throws(() => assertXrplSequenceOwnership([payment(1), trade(1)]), { code: 'XRPL_SEQUENCE_ACCOUNT_SHARED' });
    assert.doesNotThrow(() => assertXrplSequenceOwnership([payment(1), trade(2)]));
    assert.doesNotThrow(() => assertXrplSequenceOwnership([payment(1, [delegate]), trade(1)]));
  });

  it('a delegate is never a sequence account: a Payment source equal to a trade delegate does not conflict, by construction of the trade domain', () => {
    // The Host builds the trade domain from owners only (pinned above); a delegate shared with a Payment source is not an overlap.
    assert.doesNotThrow(() => assertXrplSequenceOwnership([payment(1, [delegate]), trade(1, [account])]));
  });

  it('empty, malformed or duplicate domains are refused', () => {
    assert.throws(() => assertXrplSequenceOwnership([trade(1, [])]), { code: 'XRPL_SEQUENCE_DOMAIN_INVALID' });
    assert.throws(() => assertXrplSequenceOwnership([trade(1, ['not-an-address'])]), { code: 'XRPL_SEQUENCE_DOMAIN_INVALID' });
    assert.throws(() => assertXrplSequenceOwnership([trade(1), trade(2)]), { code: 'XRPL_SEQUENCE_DOMAIN_DUPLICATE' });
    assert.throws(() => assertXrplSequenceOwnership([trade(0)]), { code: 'XRPL_SEQUENCE_DOMAIN_INVALID' }, 'mainnet only with allowMainnet, which the trade domain never has');
  });
});

describe('TRADE-04C structure — negative fixtures: every scan fails on a synthetic violation', () => {
  const fixture = (path: string, text: string): readonly Source[] => [{ path, text }];
  it('a disallowed import, an SDK import, a submit, a retry, a key, mainnet or a not-submitted release is caught', () => {
    assert.equal(disallowedImports(fixture(`${EDGE}/x.ts`, "import { x } from '../xrpl-payment-rail/host-composition.js';")).length, 1);
    assert.equal(disallowedImports(fixture(`${EDGE}/x.ts`, "import { x } from './trade-offer-executor.js';")).length, 0);
    for (const text of [
      ['import { Client } from', "'xrpl';"].join(' '),
      'await client.' + 'submit(blob);',
      'const filled = await client.' + 'autofill(tx);',
      'for (let attempt = 0; attempt < 3; attempt++) retry();',
      'const w = Wallet.' + 'fromSeed(value);',
      "const network = 'xrp-ledger-" + "mainnet';",
      "await interlock.settle(id, hash, 'not-" + "submitted');",
    ]) {
      assert.ok(effects(fixture(`${EDGE}/x.ts`, text)).length > 0, text);
    }
  });
});
