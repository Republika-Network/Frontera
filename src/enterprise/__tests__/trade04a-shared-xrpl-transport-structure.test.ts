import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET, XRPL_RAIL_LIMITS, XRPL_RESTART_ANCHOR_SLACK_SECONDS, XRPL_RESTART_QUARANTINE_LEDGERS, XRPL_RESTART_QUARANTINE_MARGIN } from '../../features/payment-runtime/rails/xrpl/index.js';
import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, parsePreparedXrplPayment } from '../xrpl-payment-rail/signer-protocol.js';

/**
 * TRADE-04A — the security invariants of the shared XRPL transport milestone
 * (SEC-TRADE04A-01 … -20), enforced over the repository's current source.
 *
 * TRADE-local numbering (the repository allocates no global SEC-INV range in
 * this milestone; `docs/integrations/trade/TRADE-04A-SHARED-XRPL-TRANSPORT.md`
 * §17). Behavioral evidence lives beside it:
 * `src/features/xrpl-transport/tests/xrpl-transport.test.ts` (A, B, C, E),
 * `trade04a-sequence-safety.test.ts` (C on the real interlock and rail) and
 * `trade04a-payment-preservation.test.ts` (D). This file pins the structure
 * that makes those results hold for every future change: one submission site,
 * one interlock composition, one SDK-importer list, no submission API in the
 * shared transport, and Payment closure.
 *
 * Every scan is a pure predicate; the negative fixtures at the end run them
 * over synthetic violations.
 */

const TRANSPORT = 'src/features/xrpl-transport';
const RAIL = 'src/features/payment-runtime/rails/xrpl';
const EDGE = 'src/enterprise/xrpl-payment-rail';
const TRADE = 'src/features/trade-runtime';
/** TRADE-04B: the delegated OfferCreate signer edge and the G3 shared codec file (held to their own tests). */
const TRADE_EDGE = 'src/enterprise/xrpl-trade-rail';
const SHARED_SIGNATURE = `${TRANSPORT}/xrpl-signature.ts`;
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

function walk(dir: string, includeTests = false): readonly string[] {
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

interface Source {
  readonly path: string;
  readonly text: string;
}
const read = (path: string): Source => ({ path, text: readFileSync(path, 'utf8') });
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const PRODUCTION = ['src', 'packages', 'scripts', 'apps'].flatMap((root) => walk(root)).map(read);
const DOC = readFileSync('docs/integrations/trade/TRADE-04A-SHARED-XRPL-TRANSPORT.md', 'utf8');
const ADR = readFileSync('docs/architecture/ADR-XRPL-SHARED-TRANSPORT.md', 'utf8');
const NO_BYPASS = readFileSync('docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md', 'utf8');

/** The PAY-02 SDK-import pattern, verbatim. */
const SDK_MODULE = String.raw`['"](?:xrpl|ripple-(?:binary-codec|keypairs|address-codec|lib)|@xrplf\/[^'"]+)(?:\/[^'"]*)?['"]`;
const XRPL_SDK_IMPORT = new RegExp(String.raw`^\s*(?:import|export)\b[^;\n]*\bfrom\s+${SDK_MODULE}|\brequire\s*\(\s*${SDK_MODULE}|\bimport\s*\(\s*${SDK_MODULE}`, 'm');

type Scan = (sources: readonly Source[]) => readonly string[];

/** Sources that issue an XRPL submit request. */
const submitRequests: Scan = (sources) => sources.filter((source) => /command:\s*['"]submit(?:_multisigned)?['"]/.test(codeOf(source.text))).map((source) => source.path);
/** Sources that call `.submit(` on an XRPL client. */
const clientSubmitCalls: Scan = (sources) => sources.filter((source) => /\bclient\.submit\s*\(/.test(codeOf(source.text))).map((source) => source.path);
/** Sources that open a durable XRPL submission interlock, or compose an XRPL rail that consumes sequences. */
const interlockCompositions: Scan = (sources) => sources.filter((source) => /createSqliteXrplSubmissionInterlock\s*\(/.test(codeOf(source.text)) && !source.path.endsWith('sqlite-xrpl-submission-interlock.ts')).map((source) => source.path);
const railCompositions: Scan = (sources) => sources.filter((source) => /createXrplRlusdRail\s*\(/.test(codeOf(source.text)) && !source.path.endsWith('xrpl-rlusd-rail.ts')).map((source) => source.path);
const sdkImporters: Scan = (sources) => sources.filter((source) => XRPL_SDK_IMPORT.test(source.text)).map((source) => source.path);

describe('TRADE-04A — no new execution or submission path (SEC-TRADE04A-01, -05, -14)', () => {
  it('SEC-TRADE04A-01: the shared transport is no execution path — no adapter, no orchestrator, no grant; and TRADE is still none', () => {
    for (const source of walk(TRANSPORT).map(read)) {
      for (const pattern of [/ExecutionAdapter|executionAdapter/, /GovernedActionOrchestrator|\.govern\s*\(/, /issueFromDecision|BoundedGrant|\.exercise\s*\(/, /\.execute\s*\(/]) assert.equal(pattern.test(codeOf(source.text)), false, `${source.path}: ${String(pattern)}`);
    }
    for (const source of walk(TRADE).map(read)) assert.equal(/ExecutionAdapter|\.submit\s*\(|createXrplValidatedLedgerReader/.test(codeOf(source.text)), false, source.path);
  });

  it('SEC-TRADE04A-05: one XRPL submit request and one client.submit call, repository-wide — the shared transport adds neither', () => {
    assert.deepEqual(submitRequests(PRODUCTION), [`${RAIL}/xrpl-sdk-client.ts`]);
    assert.deepEqual(clientSubmitCalls(PRODUCTION), [`${RAIL}/xrpl-rlusd-rail.ts`]);
    const port = codeOf(readFileSync(`${RAIL}/xrpl-client-port.ts`, 'utf8'));
    assert.equal([...port.matchAll(/^\s*submit\(signedTransaction: string\): Promise<unknown>;/gm)].length, 1, 'the one submit method is the PAY-02 client port’s');
  });

  it('SEC-TRADE04A-14: the NO_BYPASS inventory still enumerates every effect path — TRADE-04A adds none and says so', () => {
    // TRADE-04B later added EP-073 (a signing request, denominator only); TRADE-04A's own record of adding none stands.
    assert.match(NO_BYPASS, /Seventy-four production-capable effect paths/);
    assert.match(NO_BYPASS, /\*TRADE-04A changed neither number: eleven of seventy-two\.\*/);
    const transport = walk(TRANSPORT).map(read);
    for (const source of transport) assert.equal(/from\s+['"](?:node:)?(?:https?|net|tls|dns|dgram|http2)['"]|\bfetch\s*\(|WebSocket|\bnew\s+Client\s*\(/.test(codeOf(source.text)), false, source.path);
  });
});

describe('TRADE-04A — Payment closure and boundaries (SEC-TRADE04A-02, -12, -13)', () => {
  it('SEC-TRADE04A-02: the Payment signer protocol, parser and signed-field closure are unchanged and Payment-only', () => {
    assert.equal(EXTERNAL_XRPL_SIGNER_OPERATION, 'sign-xrpl-payment');
    assert.deepEqual(Object.values(EXTERNAL_XRPL_SIGNER_PATHS).sort(), ['/v1/identity', '/v1/sign/xrpl-payment']);
    const payment = { TransactionType: 'Payment', Account: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn', Destination: 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX', Amount: { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '10' }, Flags: 0, LastLedgerSequence: 100, Sequence: 7, Fee: '12' };
    assert.notEqual(parsePreparedXrplPayment(payment), undefined);
    for (const variant of [{ ...payment, TransactionType: 'OfferCreate' }, { ...payment, Delegate: 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX' }, { ...payment, TakerGets: '1' }]) assert.equal(parsePreparedXrplPayment(variant), undefined, JSON.stringify(variant));
    const codec = codeOf(readFileSync(`${RAIL}/xrpl-codec.ts`, 'utf8'));
    assert.match(codec, /const allowed = new Set\(\[\.\.\.Object\.keys\(prepared\), 'SigningPubKey', 'TxnSignature'\]\);/, 'exactly the prepared fields plus the two signature fields');
    assert.match(codec, /export function signedPaymentMatches\(prepared: XrplPreparedPayment,/);
    const port = codeOf(readFileSync(`${RAIL}/xrpl-client-port.ts`, 'utf8'));
    assert.match(port, /readonly TransactionType: 'Payment';/);
    assert.match(port, /sign\(transaction: XrplPreparedPayment\): Promise</, 'the signer signs a prepared Payment, never an arbitrary transaction');
  });

  it('SEC-TRADE04A-13: the rail reaches the shared transport only through its barrel, from the codec and the result reader — nothing else of the rail changed its imports', () => {
    for (const file of walk(RAIL)) {
      const transportImports = importsOf(readFileSync(file, 'utf8')).filter((specifier) => /xrpl-transport/.test(specifier));
      // TRADE-04B (G3): the codec also reaches the shared codec file, by path, for the SDK calls it no longer makes itself.
      // TRADE-04C (G2): and the SDK client, for the reserved submission client's claim (hash and binding fields read from the blob) — the same two modules.
      const expected = file.endsWith('/xrpl-codec.ts') || file.endsWith('/xrpl-sdk-client.ts') ? ['../../../xrpl-transport/index.js', '../../../xrpl-transport/xrpl-signature.js'] : file.endsWith('/xrpl-result-normalizer.ts') ? ['../../../xrpl-transport/index.js'] : [];
      assert.deepEqual(transportImports, expected, file);
    }
    assert.deepEqual(sdkImporters(walk(TRANSPORT).map(read)), [SHARED_SIGNATURE], 'the shared transport imports the SDK in exactly one file, its G3 codec file');
    assert.deepEqual(
      [...sdkImporters(PRODUCTION)].sort(),
      [`${RAIL}/xrpl-address.ts`, SHARED_SIGNATURE, `${RAIL}/xrpl-sdk-client.ts`, `${EDGE}/reference/reference-xrpl-signer-service.ts`, `${TRADE_EDGE}/reference/reference-delegated-offer-signer.ts`].sort(),
      'the PAY-02 SDK-importer list, changed only by TRADE-04B: the codec swapped for the shared codec file (G3), and the reference delegated offer signer process',
    );
  });

  it('SEC-TRADE04A-12: the rail’s own source is untouched by the extraction: its ordering, interlock and finality code read as before', () => {
    const rail = codeOf(readFileSync(`${RAIL}/xrpl-rlusd-rail.ts`, 'utf8'));
    assert.equal(/xrpl-transport/.test(rail), false, 'the rail itself imports nothing new');
    for (const marker of ['await reserve(request, signed)', 'submitOnceAndAwait(request', 'readSubmission(answer', 'readLookup(await client.lookupTransaction(', 'unresolved.set(account']) assert.ok(rail.includes(marker), marker);
  });
});

describe('TRADE-04A — custody, signing, live writes (SEC-TRADE04A-04, -16, -19)', () => {
  it('SEC-TRADE04A-04: no new signer, wallet or key material anywhere in production source', () => {
    const custody = /\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|ripple-keypairs|secret-numbers/;
    const holders = PRODUCTION.filter((source) => XRPL_SDK_IMPORT.test(source.text) && custody.test(codeOf(source.text))).map((source) => source.path);
    assert.deepEqual(holders.sort(), [`${EDGE}/reference/reference-xrpl-signer-service.ts`, `${TRADE_EDGE}/reference/reference-delegated-offer-signer.ts`].sort(), 'the two reference signer processes remain the only key holders');
    // TRADE-04B built the TRADE signer edge this tripwire was waiting for: it is exactly these files, held to trade04b-protected-signer-structure.test.ts.
    assert.deepEqual(
      walk('src/enterprise').filter((path) => /xrpl-trade-rail|delegated-signer|offer-signer/.test(path)).sort(),
      ['delegated-offer-protocol.ts', 'delegated-offer-signer-transport.ts', 'delegated-offer-signer.ts', 'delegated-offer-verification.ts', 'index.ts', 'reference/reference-delegated-offer-signer.ts'].map((name) => `${TRADE_EDGE}/${name}`).sort(),
      'the TRADE signer edge is exactly the TRADE-04B files: no host composition, interlock or submission adapter',
    );
  });

  it('SEC-TRADE04A-16: TRADE-04A tests open no network: no endpoint, no live-ledger flag, no SDK client', () => {
    // This file is excluded: its own patterns name what they refuse.
    const self = 'src/enterprise/__tests__/trade04a-shared-xrpl-transport-structure.test.ts';
    const files = [...walk(TRANSPORT, true).filter((path) => path.includes('/tests/')), ...walk('src/enterprise/__tests__', true).filter((path) => /\/trade04a-/.test(path) && path !== self)];
    assert.ok(files.length >= 5, `found ${files.length}`);
    for (const file of files) {
      const code = codeOf(readFileSync(file, 'utf8'));
      assert.equal(/['"`]wss?:\/\/(?!user:)|TESTNET|createXrplSdkClient\s*\(|\bnew\s+Client\s*\(/.test(code), false, file);
    }
  });

  it('SEC-TRADE04A-19: the documentation claims no production readiness and says what is not built', () => {
    for (const text of [DOC, ADR]) {
      assert.equal(/production[- ]ready(?! )|ready for production/i.test(text.replace(/not (?:\w+ )?production[- ]ready|no production[- ]readiness/gi, '')), false);
    }
    assert.match(DOC, /No OfferCreate is built, signed or submitted/);
    assert.match(DOC, /## 25\. Final readiness verdict/);
  });
});

describe('TRADE-04A — owner-Sequence safety is structural (SEC-TRADE04A-08, -09, -10, -11, -17)', () => {
  it('SEC-TRADE04A-08/17: exactly one sequence-consuming XRPL domain is composed — the Payment rail, over one interlock, in one place', () => {
    const message =
      'A second XRPL submission domain (or a second interlock) is being composed. ADR-XRPL-SHARED-TRANSPORT §8–§9: it must be declared through assertXrplSequenceOwnership together with every other domain before anything is opened, or share the one account-scoped sequence authority (a reviewed migration). Update this list only with that composition.';
    // The portability tooling opens the store for verification only: no scope, so it adopts the file's recorded scope, creates nothing and is never a rail's interlock.
    const VERIFIER = 'scripts/portability/store-registry.mjs';
    assert.deepEqual(interlockCompositions(PRODUCTION), [`${EDGE}/host-composition.ts`, VERIFIER], message);
    const verifierCall = /createSqliteXrplSubmissionInterlock\(([^\n]*)\)/.exec(codeOf(readFileSync(VERIFIER, 'utf8')))?.[1] ?? '';
    assert.ok(verifierCall.length > 0 && !/scope/.test(verifierCall), 'the verification open passes no scope');
    assert.deepEqual(railCompositions(PRODUCTION), [`${EDGE}/host-composition.ts`], message);
    // TRADE-04C (G4): the second domain exists — the governed trade executor, over its own interlock, composed in one place — and the Host
    // declares every domain through assertXrplSequenceOwnership, from configuration, before either interlock is opened.
    assert.deepEqual(PRODUCTION.filter((source) => /assertXrplSequenceOwnership\s*\(/.test(codeOf(source.text)) && !source.path.startsWith(`${TRANSPORT}/`)).map((source) => source.path), ['src/enterprise/host/enterprise-host.ts'], message);
    const tradeInterlocks = PRODUCTION.filter((source) => /createSqliteTradeSequenceInterlock\s*\(/.test(codeOf(source.text)) && !source.path.endsWith('/sqlite-trade-sequence-interlock.ts')).map((source) => source.path);
    assert.deepEqual(tradeInterlocks.sort(), ['scripts/portability/store-registry.mjs', 'src/enterprise/xrpl-trade-execution/host-composition.ts'], message);
    const host = codeOf(readFileSync('src/enterprise/host/enterprise-host.ts', 'utf8'));
    const boot = host.slice(host.indexOf('export async function bootEnterpriseHost('));
    const order = ['assertXrplDomainsDisjoint(host)', "import('../xrpl-payment-rail/host-composition.js')", "import('../xrpl-trade-execution/host-composition.js')"].map((marker) => boot.indexOf(marker));
    assert.ok(order.every((position) => position !== -1), 'the ownership check and both compositions are in the boot');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'ownership is asserted over every domain before either interlock is opened');
  });

  it('SEC-TRADE04A-09: the durable reservation stays strictly between verification and the one submission', () => {
    const rail = codeOf(readFileSync(`${RAIL}/xrpl-rlusd-rail.ts`, 'utf8'));
    const execute = rail.slice(rail.indexOf('async function execute('));
    const order = ['prepareAndSign(request', 'await reserve(request, signed)', 'submitOnceAndAwait(request'].map((marker) => execute.indexOf(marker));
    assert.ok(order.every((position) => position !== -1));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('SEC-TRADE04A-10: restart safety constants are unchanged, the historical window never shrinks, and the interlock never deletes', () => {
    assert.equal(XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET, 200);
    assert.ok(XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET >= XRPL_RAIL_LIMITS.lastLedgerOffset.maximum);
    assert.equal(XRPL_RESTART_QUARANTINE_MARGIN, 4);
    assert.equal(XRPL_RESTART_QUARANTINE_LEDGERS, 204);
    assert.equal(XRPL_RESTART_ANCHOR_SLACK_SECONDS, 180);
    const store = codeOf(readFileSync(`${EDGE}/sqlite-xrpl-submission-interlock.ts`, 'utf8'));
    assert.equal(/DELETE\s+FROM|DROP\s+TABLE|DROP\s+TRIGGER/i.test(store), false);
    assert.match(store, /XRPL_INTERLOCK_STORE_SCHEMA_VERSION = 'aoc\.xrpl-submission-interlock\.schema\.v1'/, 'no schema migration in TRADE-04A');
  });

  it('SEC-TRADE04A-11: the store decides with the shared rule, and a failed lookup cannot release: there is no release operation', () => {
    const store = codeOf(readFileSync(`${EDGE}/sqlite-xrpl-submission-interlock.ts`, 'utf8'));
    assert.match(store, /live\.some\(\(record\) => xrplSequenceWindowBlocks\(\{ sequence: record\.sequence, lastLedgerSequence: record\.lastLedgerSequence, open: record\.state !== 'settled' \}, sequence, validatedLedgerIndex\)\)/);
    const port = codeOf(readFileSync(`${RAIL}/xrpl-submission-interlock.ts`, 'utf8'));
    const methods = [...(/export interface XrplSubmissionInterlock \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? '').matchAll(/^\s*(\w+)\(/gm)].map((match) => match[1]);
    assert.deepEqual(methods, ['recorded', 'blocking', 'reserve', 'markUnconfirmed', 'settle']);
  });
});

describe('TRADE-04A — network and freshness (SEC-TRADE04A-06, -07, -15, -18)', () => {
  it('SEC-TRADE04A-06/15: every XRPL read path refuses a server on another network — the rail, the shared reader and the interlock scope', () => {
    const rail = codeOf(readFileSync(`${RAIL}/xrpl-rlusd-rail.ts`, 'utf8'));
    assert.match(rail, /if \(readNetworkId\(info\) !== configuration\.networkId\) return \{ status: 'unavailable', detail: D\.NETWORK_MISMATCH \};/);
    const reader = codeOf(readFileSync(`${TRANSPORT}/xrpl-validated-ledger-reader.ts`, 'utf8'));
    assert.equal([...reader.matchAll(/await currentValidatedLedger\(\)/g)].length, 3, 'each of the three reads re-proves the network first');
    const store = codeOf(readFileSync(`${EDGE}/sqlite-xrpl-submission-interlock.ts`, 'utf8'));
    assert.match(store, /bound\.network_id !== scope\.networkId/);
  });

  it('SEC-TRADE04A-07: validated-only — the shared reader never asks for a current or closed ledger', () => {
    const reader = codeOf(readFileSync(`${TRANSPORT}/xrpl-validated-ledger-reader.ts`, 'utf8'));
    assert.equal(/'current'|'closed'/.test(reader), false);
    assert.match(reader, /ledger_index: 'validated' as const/);
  });

  it('SEC-TRADE04A-18: CORE-07 is not bypassed — the Host still refuses an interlock without its witness, the store still probes before every signing, and the transport touches no freshness state', () => {
    const composition = codeOf(readFileSync(`${EDGE}/host-composition.ts`, 'utf8'));
    const guard = composition.indexOf('if (!isAuthorityStateFreshnessBoundary(boundary))');
    const open = composition.indexOf('createSqliteXrplSubmissionInterlock(');
    assert.ok(guard !== -1 && open !== -1 && guard < open);
    assert.match(composition, /freshness: \{ boundary \},/);
    const store = codeOf(readFileSync(`${EDGE}/sqlite-xrpl-submission-interlock.ts`, 'utf8'));
    const blocking = store.slice(store.indexOf('async blocking(query)'), store.indexOf('async reserve(record, validatedLedgerIndex)'));
    assert.ok(blocking.indexOf('await session.probe()') !== -1 && blocking.indexOf('await session.probe()') < blocking.indexOf('openBlocking('));
    for (const source of walk(TRANSPORT).map(read)) assert.equal(/authority-state-freshness|checkpoint|witness/i.test(codeOf(source.text)), false, source.path);
  });
});

describe('TRADE-04A — the other rails are untouched (SEC-TRADE04A-20)', () => {
  it('PAY-06 Lightning and PAY-08 x402 neither import the shared transport nor anything XRPL', () => {
    for (const dir of ['src/features/payment-runtime/rails/lightning', 'src/enterprise/lightning-payment-rail', 'src/features/payment-runtime/protocols/x402', 'src/enterprise/x402-payment-protocol']) {
      const files = walk(dir);
      assert.ok(files.length > 0, dir);
      for (const file of files) assert.equal(importsOf(readFileSync(file, 'utf8')).some((specifier) => /xrpl/.test(specifier)), false, file);
    }
  });
});

describe('TRADE-04A — negative fixtures: every scan fails on a synthetic violation', () => {
  const fixture = (path: string, text: string): readonly Source[] => [{ path, text }];

  // Assembled at runtime so sibling repository-wide scanners do not count these samples as real sites.
  it('a second submit request, client.submit call, interlock or rail composition, or SDK importer is caught', () => {
    assert.equal(submitRequests(fixture(`${TRANSPORT}/x.ts`, ['await c.request({ command:', "'sub" + "mit', tx_blob });"].join(' '))).length, 1);
    assert.equal(clientSubmitCalls(fixture(`${TRADE}/rails/xrpl/x.ts`, 'await client.' + 'submit(blob);')).length, 1);
    assert.equal(interlockCompositions(fixture('src/enterprise/xrpl-trade-rail/host-composition.ts', 'await createSqliteXrplSubmissionInterlock' + "(path, { scope: { railId: 'xrpl-offer', networkId: 1 } });")).length, 1);
    assert.equal(railCompositions(fixture('src/enterprise/other/x.ts', 'const r = createXrplRlusdRail' + '(options);')).length, 1);
    assert.equal(sdkImporters(fixture(`${TRANSPORT}/x.ts`, ['import { decode } from', "'xrpl';"].join(' '))).length, 1);
  });
});
