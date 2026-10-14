import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import {
  CORE_SOURCE_CLASSIFICATION,
  CORE_SOURCE_MANIFEST_VERSION,
  CORE_SOURCE_ROOTS,
  buildCoreSourceManifest,
  listCoreSources,
  manifestOf,
  normalizeLineEndings,
} from './pay07-core-source-manifest.js';

/**
 * PAY-07 — structural qualification. The executable conformance run proves the
 * two rails behave the same; this file proves *why that is not an accident*:
 *
 * - the canonical suite and the shared world know no rail and branch on none;
 * - production code never depends on qualification code;
 * - the CORE manifest covers every generic file the shared path executes, no
 *   rail file, is classified against drift, and is portable across CRLF / LF;
 * - no CORE layer names a qualified rail (one classified finding excepted);
 * - the generic ports carry no rail-shaped field.
 *
 * Sources are read with comments stripped (prose may name a rail to say what
 * a layer does NOT do), from the repository root, as every structural test here.
 */

const SUITE = 'src/features/payment-runtime/tests/conformance/payment-rail-conformance-suite.ts';
const MANIFEST = 'src/enterprise/__tests__/pay07-core-source-manifest.ts';
const WORLD = 'src/enterprise/__tests__/pay07-governed-payment-world.ts';

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const codeOf = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1 ');
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)'([^']+)'/gm)].map((match) => match[1] ?? '');

/** XRPL words, as code. */
const XRPL_VOCABULARY = /xrpl|rlusd|\bxrp\b|ledger[_ -]?hash|ledgerHash|offer[_ -]?create|trust[_ -]?set|rippled|lastLedgerSequence|destinationTag/i;
/** Lightning words, as code (PAY-06's pattern, extended). */
const LIGHTNING_VOCABULARY = /lightning|bolt\s?11|\bbolt-11\b|preimage|payment[_ -]?hash|paymentHash|\bhtlcs?\b|routing[_ -]?fee|fee[_ -]?limit[_ -]?msat|\bmsat\b|millisatoshi|node[_ -]?pubkey|\blnd\b|\bcln\b|macaroon|payreq|lnbc|lntb/i;
/** Stripe words, as code (PAY-09). `PaymentIntent` alone is Frontera's own generic term and is not one. */
const STRIPE_VOCABULARY = /stripe|\bacct_|\bpi_[A-Za-z0-9]|client[_ -]?secret|connected[_ -]?account|destination[_ -]?charge|requires_(?:payment_method|confirmation|action|capture)|\bwhsec_|\b[sr]k_test_/i;

function walk(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'dist-test' || name === '.next') continue;
      if (!includeTests && (name === '__tests__' || name === 'tests' || name === 'fixtures')) continue;
      out.push(...walk(full, includeTests));
    } else if (full.endsWith('.ts') && (includeTests || !full.endsWith('.test.ts'))) {
      out.push(full);
    }
  }
  return out;
}

describe('PAY-07 structure — the canonical suite is rail-neutral (Q1, Q2, Q12; M11, M12)', () => {
  it('the suite imports nothing at all, and the manifest only Node built-ins: no rail, no SDK, no production module', () => {
    assert.deepEqual(importsOf(SUITE), []);
    assert.deepEqual([...importsOf(MANIFEST)].sort(), ['node:crypto', 'node:fs', 'node:path']);
  });

  it('no XRPL, Lightning or Stripe word, rail id or rail asset appears in the suite’s code', () => {
    const code = codeOf(SUITE);
    assert.equal(XRPL_VOCABULARY.test(code), false, 'XRPL vocabulary in the suite');
    assert.equal(LIGHTNING_VOCABULARY.test(code), false, 'Lightning vocabulary in the suite');
    assert.equal(STRIPE_VOCABULARY.test(code), false, 'Stripe vocabulary in the suite');
    assert.equal(/xrpl-rlusd|lightning-btc|stripe-usd|stable:RLUSD|net:BTC|\bBTC\b|\bUSD\b|RLUSD/.test(code), false, 'a rail id or asset in the suite');
  });

  it('no branch on the implementation: `implementationId` is only declared and copied, never compared, switched on or indexed by', () => {
    const code = codeOf(SUITE);
    const uses = [...code.matchAll(/[^\n]*implementationId[^\n]*/g)].map((match) => match[0].trim());
    assert.ok(uses.length > 0);
    for (const use of uses) {
      assert.equal(/implementationId\s*(===|!==|==|!=|<|>|\?|\.\w|\[)|(===|!==|==|!=)\s*[\w.]*implementationId|switch\s*\([^)]*implementationId|implementationId\s*\)\s*\{|in\s+[\w.]*implementationId/.test(use), false, use);
      assert.match(use, /^(readonly implementationId: string;|implementationId: harness\.implementationId,|implementationId: [\w.]+\.implementationId,|c\.check\('harness', TOKEN\.test\(c\.harness\.implementationId\), 'implementation-id-not-a-token'\);)$/, use);
    }
  });

  it('one harness shape for every rail: no discriminant, no union of rail shapes', () => {
    const code = codeOf(SUITE);
    const harness = /export interface PaymentRailConformanceHarness \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.ok(harness.length > 0);
    assert.equal(/\bkind\b|\btype\b\s*:|\brail\b\s*:/.test(harness), false, 'a discriminant on the harness');
    assert.equal(/export type PaymentRailConformanceHarness\s*=/.test(code), false, 'the harness is a union');
  });

  it('the same closed case list for every rail: the runner iterates the constant, never a harness-provided list', () => {
    const code = codeOf(SUITE);
    assert.match(code, /for \(const \{ caseId \} of PAYMENT_RAIL_CONFORMANCE_CASES\) cases\.push\(await runCase\(harness, caseId\)\);/);
    assert.equal(/harness\.(cases|skip|only|optional)/.test(code), false);
    assert.equal(/\bskip\b|\.only\b|optional case/i.test(code), false);
  });

  it('the harness never certifies itself: no `passed` / `ok` / verdict field crosses the harness contract', () => {
    const code = codeOf(SUITE);
    for (const name of ['ConformanceWorld', 'PaymentRailConformanceHarness', 'ConformanceGoverned', 'ConformanceSettlement', 'ConformanceTrace', 'ConformanceReconciliation', 'ConformanceIngress']) {
      const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(code)?.[1] ?? '';
      assert.ok(body.length > 0, name);
      assert.equal(/\b(passed|ok|conformant|qualified)\s*[?:]/.test(body), false, `${name} carries a self-certification`);
    }
  });

  it('the shared world composes no rail: it imports no rail module and names no rail word in code', () => {
    for (const specifier of importsOf(WORLD)) assert.equal(/xrpl|lightning|rails\//.test(specifier), false, specifier);
    const code = codeOf(WORLD);
    assert.equal(XRPL_VOCABULARY.test(code), false);
    assert.equal(LIGHTNING_VOCABULARY.test(code), false);
  });

  it('M9 / Q10: the trace verdict is ASSURE-01’s own — the existing builder and verifier over the composition root’s six reads, never a value the world asserts', () => {
    const code = codeOf(WORLD);
    assert.equal([...code.matchAll(/buildAuthorityTrace\(/g)].length, 1);
    assert.match(code, /const verification = authorityTraceVerificationOf\(build, NOW\);/);
    assert.match(code, /verified: verification\.verified,/);
    assert.match(code, /failedChecks: verification\.checks\.filter\(\(check\) => check\.status === 'fail'\)/);
    assert.match(code, /finalState: trace\.finalState,/);
    assert.equal(/verified:\s*(true|false)\b/.test(code.replace(/verified: false, failedChecks: \[\], presence: \{\}/, '')), false, 'a hard-coded verdict');
    const sources = /async function traceSources\(\)[\s\S]*?return \{([\s\S]*?)\n {4}\};/.exec(code)?.[1] ?? '';
    for (const read of ['governance:', 'grants:', 'reservations:', 'outcomes:', 'resolutions:', 'events:']) assert.ok(sources.includes(read), `trace source ${read} not composed`);
  });

  it('M1 / M2 / Q3 / Q4: every representative flow enters through the PAY-04 MPP ingress — the world never calls a rail or the orchestrator directly', () => {
    const code = codeOf(WORLD);
    assert.equal([...code.matchAll(/\.prepareAndGovern\(/g)].length, 1, 'one protocol entry point, used by present and replay');
    assert.match(code, /presentRequirement: present,\s*replayRequirement: present,/);
    assert.equal(/world\.orchestrator\.govern\(\s*(IDENTITY|identity)/.test(code), false, 'a direct orchestrator call bypassing MPP');
    assert.equal(/\brail\.execute\(/.test(code.replace(/return rail\.execute\(request\);/, '')), false, 'a direct rail call');
    assert.equal([...code.matchAll(/createPaymentRailExecutionAdapter\(/g)].length, 1, 'the rail is reached only through the PAY-01 bridge');
  });
});

describe('PAY-07 structure — production never depends on qualification code (Q5; §61, §62)', () => {
  it('no production source imports the conformance suite, the manifest or a PAY-07 harness', () => {
    const production = ['src', 'packages', 'apps'].flatMap((root) => walk(root)).filter((file) => !file.includes('/tests/') && !file.includes('/__tests__/'));
    assert.ok(production.length > 500);
    for (const file of production) for (const specifier of importsOf(file)) assert.equal(/tests\/conformance|pay07-|payment-rail-conformance/.test(specifier), false, `${file} imports '${specifier}'`);
  });

  it('every PAY-07 file is test-only: under a tests/ or __tests__/ directory, nothing exported from a package entry point', () => {
    for (const file of [SUITE, MANIFEST, WORLD, 'src/enterprise/__tests__/pay07-xrpl-edge.ts', 'src/enterprise/__tests__/pay07-lightning-edge.ts']) {
      assert.ok(existsSync(file), file);
      assert.match(file, /\/(tests|__tests__)\//);
    }
    const pkg = JSON.parse(read('package.json')) as { readonly exports?: unknown; readonly files?: unknown };
    assert.equal(/conformance|pay07/.test(JSON.stringify(pkg.exports)), false);
    for (const entry of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts', 'src/features/payment-runtime/index.ts']) {
      if (existsSync(entry)) assert.equal(/conformance|pay07/i.test(codeOf(entry)), false, entry);
    }
  });
});

describe('PAY-07 structure — the CORE source manifest (criterion 2; CORE-1 … CORE-8; Q5, Q6; M7, M8)', () => {
  const manifest = buildCoreSourceManifest();
  const paths = manifest.entries.map((entry) => entry.path);

  it('CORE-7 / CORE-8: canonical form — versioned, lexicographic, relative posix paths, no timestamp, no absolute path', () => {
    assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/);
    const lines = manifest.text.split('\n');
    assert.equal(lines[0], CORE_SOURCE_MANIFEST_VERSION);
    assert.equal(lines.at(-1), '', 'LF-terminated');
    assert.deepEqual(paths, [...paths].sort());
    for (const line of lines.slice(1, -1)) assert.match(line, /^(src|packages)\/[A-Za-z0-9._/-]+\.tsx? [0-9a-f]{64}$/, line);
    assert.equal(/\\|^\/|[A-Z]:|\d{4}-\d{2}-\d{2}T/m.test(manifest.text.split('\n').slice(1).join('\n').replace(/ [0-9a-f]{64}$/gm, '')), false);
    assert.equal(manifestOf([...manifest.entries].reverse()).digest, manifest.digest, 'order-independent input, canonical output');
    assert.equal(buildCoreSourceManifest().digest, manifest.digest, 'deterministic');
  });

  it('CORE-6 / Q6: a CRLF working copy (core.autocrlf=true) measures the same digest; a lone CR or any other byte does not', () => {
    const crlf = buildCoreSourceManifest('.', { read: (path) => Buffer.from(read(path).replace(/\n/g, '\r\n'), 'utf8') });
    assert.equal(crlf.digest, manifest.digest);
    assert.deepEqual(normalizeLineEndings(Buffer.from('a\r\nb\rc\n')), Buffer.from('a\nb\rc\n'), 'only CRLF pairs are normalized');
    const target = 'src/enterprise/governed-action/orchestrator.ts';
    const loneCr = buildCoreSourceManifest('.', { read: (path) => (path === target ? Buffer.concat([readFileSync(path), Buffer.from('\r')]) : readFileSync(path)) });
    assert.notEqual(loneCr.digest, manifest.digest);
  });

  it('CORE-4: a one-byte change to a protected generic source (the orchestrator, P12, the trace builder, the PAY-01 port) changes the digest', () => {
    for (const target of ['src/enterprise/governed-action/orchestrator.ts', 'src/enterprise/execution-reconciliation/service.ts', 'src/enterprise/evidence/trace-builder.ts', 'src/features/payment-runtime/domain/payment-rail.ts', 'src/kernel/index.ts']) {
      assert.ok(paths.includes(target), target);
      const changed = buildCoreSourceManifest('.', { read: (path) => (path === target ? Buffer.concat([readFileSync(path), Buffer.from(' ')]) : readFileSync(path)) });
      assert.notEqual(changed.digest, manifest.digest, target);
    }
  });

  it('CORE-5: rail sources are outside CORE — changing one cannot change the CORE digest', () => {
    const rails = [...walk('src/features/payment-runtime/rails', true), ...walk('src/enterprise/xrpl-payment-rail', true), ...walk('src/enterprise/lightning-payment-rail', true), ...walk('src/enterprise/stripe-payment-rail', true)];
    assert.ok(rails.length > 20);
    for (const file of rails) assert.equal(paths.includes(file), false, file);
    const touched = buildCoreSourceManifest('.', { read: (path) => (/rails\/|payment-rail\//.test(path) ? Buffer.from('mutated') : readFileSync(path)) });
    assert.equal(touched.digest, manifest.digest);
    for (const path of paths) assert.equal(/\/rails\/|xrpl|lightning|stripe|\/tests\/|__tests__|\.test\.ts$|\/fixtures\//.test(path), false, path);
  });

  it('M7 / Q5: every file the shared governed payment path executes is in the manifest — the runtime import closure is covered, and dropping the orchestrator’s root is detected', () => {
    const entries = [
      'src/enterprise/governed-action/index.ts',
      'src/enterprise/governed-action/execution-ledger.ts',
      'src/enterprise/execution-governance/index.ts',
      'src/enterprise/execution-governance/issuance-core.ts',
      'src/enterprise/kernel-authority/financial-authority-resolver.ts',
      'src/kernel/index.ts',
      'src/features/grant-runtime/index.ts',
      'src/features/exercise-control-runtime/index.ts',
      'src/enterprise/execution-outcome-store/sqlite-execution-outcome-store.ts',
      'src/enterprise/execution-resolution-store/sqlite-execution-resolution-store.ts',
      'src/enterprise/execution-reconciliation/service.ts',
      'src/enterprise/execution-reconciliation/authority.ts',
      'src/enterprise/governance-store/in-memory-governance-store.ts',
      'src/enterprise/governance-profile/index.ts',
      'src/enterprise/authority-event-stream/index.ts',
      'src/enterprise/authority-state-freshness/index.ts',
      'src/enterprise/evidence/trace-builder.ts',
      'src/enterprise/payment-settlement/index.ts',
      'src/enterprise/payment-protocol-ingress/index.ts',
      'src/features/payment-runtime/index.ts',
      'src/features/payment-runtime/protocols/mpp/index.ts',
    ];
    const seen = new Set<string>();
    const bare = new Set<string>();
    const stack = [...entries];
    while (stack.length > 0) {
      const file = stack.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      // Runtime imports only: a type-only import executes nothing.
      const code = codeOf(file).replace(/(?:import|export)\s+type\s+[^;]*?from\s+'[^']+'/g, '');
      for (const match of code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('.')) {
          bare.add(specifier);
          continue;
        }
        const target = normalize(join(dirname(file), specifier)).replace(/\.js$/, '.ts');
        if (existsSync(target)) stack.push(target);
      }
    }
    assert.ok(seen.size > 200, `closure of ${seen.size}`);
    const missing = [...seen].filter((file) => !paths.includes(file));
    assert.deepEqual(missing, [], 'a generic file the shared path executes is outside the manifest');
    for (const file of seen) assert.equal(/xrpl|lightning|\/rails\//.test(file), false, `the shared path reaches ${file}`);
    const workspace = [...bare].filter((specifier) => specifier.startsWith('@aoc-enterprise/'));
    for (const specifier of workspace) assert.ok(CORE_SOURCE_ROOTS.some((root) => root.root === `packages/${specifier.slice('@aoc-enterprise/'.length)}/src`), `${specifier} is a CORE dependency outside the manifest`);
    for (const specifier of bare) assert.equal(/xrpl|bolt|lnd|lightning|@noble/.test(specifier), false, specifier);

    // Mutation M7: the same closure against a manifest that omits the orchestrator's root is caught.
    const without = listCoreSources('.', CORE_SOURCE_ROOTS.filter((root) => root.root !== 'src/enterprise/governed-action'));
    assert.ok([...seen].some((file) => !without.includes(file)), 'omitting the orchestrator would go unnoticed');
  });

  it('drift: every directory beside a CORE root is classified — in scope, or outside with a reason; a new one fails here until classified', () => {
    for (const [parent, { scope, outside }] of Object.entries(CORE_SOURCE_CLASSIFICATION)) {
      const present = readdirSync(parent).sort();
      const classified = new Set([...scope, ...Object.keys(outside)]);
      const unclassified = present.filter((name) => !classified.has(name));
      assert.deepEqual(unclassified, [], `${parent}: classify these as CORE or outside`);
      for (const name of scope) {
        const path = `${parent}/${name}`;
        assert.ok(existsSync(path), path);
        assert.ok(CORE_SOURCE_ROOTS.some((root) => root.root === path || root.root.startsWith(`${path}/`)), `${path} is in scope but no CORE root covers it`);
      }
      for (const [name, why] of Object.entries(outside)) assert.ok(why.length > 10, `${parent}/${name} needs a reason`);
    }
    for (const root of CORE_SOURCE_ROOTS) assert.ok(root.why.length > 10 && root.layer.length > 0, root.root);
  });
});

describe('PAY-07 structure — CORE names no qualified rail (criterion 2: rail-specific logic lives only in PAY adapters)', () => {
  /**
   * The one classified finding. CORE-07's closed list of freshness slots names
   * PAY-03's interlock `'xrpl-submission-reservations'` — vocabulary left by the
   * XRPL rail being delivered first (PAY-06 added the rail-neutral
   * `'payment-initiation-reservations'` for the same purpose). CORE-07 treats
   * the slot as an opaque identifier and runs no XRPL logic; renaming it is a
   * migration of state persisted at deployed witnesses, which PAY-07 does not
   * perform. It is documented as a residual
   * (`docs/payments/PAY-07-MULTI-RAIL-QUALIFICATION.md` §13) and pinned here:
   * any other rail word in CORE fails.
   */
  const CLASSIFIED = new Map([['src/enterprise/authority-state-freshness/checkpoint.ts', /'xrpl-submission-reservations'/g]]);

  it('no CORE source names an XRPL or a Lightning concept in code, nor imports rail code — except the one classified CORE-07 slot identifier', () => {
    const files = listCoreSources();
    assert.ok(files.length > 400);
    for (const file of files) {
      const code = codeOf(file).replace(CLASSIFIED.get(file) ?? /(?!)/g, "'<classified-slot>'");
      assert.equal(XRPL_VOCABULARY.test(code), false, `${file} names an XRPL concept`);
      assert.equal(LIGHTNING_VOCABULARY.test(code), false, `${file} names a Lightning concept`);
      for (const specifier of importsOf(file)) assert.equal(/xrpl|lightning|\/rails\/|bolt11|@noble/.test(specifier), false, `${file} imports '${specifier}'`);
    }
    for (const [file, pattern] of CLASSIFIED) assert.equal([...codeOf(file).matchAll(pattern)].length, 1, `${file}: the classified identifier occurs exactly once`);
  });

  it('the vocabulary patterns detect rail words and not generic ones', () => {
    for (const hit of ['createXrplRlusdRail', 'rlusd', 'ledger_hash', 'OfferCreate', 'TrustSet', 'xrp']) assert.equal(XRPL_VOCABULARY.test(hit), true, hit);
    for (const hit of ['bolt11', 'preimage', 'payment_hash', 'paymentHash', 'htlc', 'lnd', 'macaroon']) assert.equal(LIGHTNING_VOCABULARY.test(hit), true, hit);
    for (const miss of ['ledger', 'providerRef', 'destination', 'settlement', 'finality', 'invoice', 'hash', 'payment', 'reservation']) {
      assert.equal(XRPL_VOCABULARY.test(miss) || LIGHTNING_VOCABULARY.test(miss), false, miss);
    }
  });

  it('ASSURE-01 is rail-neutral: the trace builder, verifier and disclosure import no rail and name none (§63)', () => {
    for (const file of walk('src/enterprise/evidence')) {
      for (const specifier of importsOf(file)) assert.equal(/xrpl|lightning|rails\/|payment-rail/.test(specifier), false, `${file} imports '${specifier}'`);
      assert.equal(XRPL_VOCABULARY.test(codeOf(file)) || LIGHTNING_VOCABULARY.test(codeOf(file)), false, file);
    }
  });

  it('PAY-04: MPP and the protocol ingress name no rail — the two representative flows differ only in trusted composition', () => {
    for (const file of [...walk('src/features/payment-runtime/protocols'), ...walk('src/enterprise/payment-protocol-ingress')]) assert.equal(/xrpl|lightning|rlusd|bolt11/i.test(codeOf(file)), false, file);
  });
});

describe('PAY-07 structure — the generic ports carry no rail-shaped field (§17, §33, §34; did XRPL shape the port?)', () => {
  const field = (file: string, name: string): readonly string[] => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(codeOf(file))?.[1] ?? '';
    return [...body.matchAll(/^\s*readonly (\w+)\??:/gm)].map((match) => match[1] ?? '');
  };

  it('PaymentExecutionRequest is exactly the PAY-01 shape: identities, an opaque destination, exact money, governed parameters — no account, ledger, invoice or hash field', () => {
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-execution.ts', 'PaymentExecutionRequest'), ['executionId', 'requestId', 'decisionId', 'grantId', 'notAfter', 'source', 'destination', 'amount', 'purpose', 'reference', 'rail']);
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-intent.ts', 'PaymentDestination'), ['kind', 'reference']);
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-intent.ts', 'PaymentSourceRef'), ['accountId']);
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-rail.ts', 'PaymentRail'), ['railId']);
  });

  it('PaymentRailResult has three outcomes and one opaque handle; P12 and finality queries carry the opaque providerRef only', () => {
    const rail = codeOf('src/features/payment-runtime/domain/payment-rail.ts');
    assert.match(rail, /\{ readonly status: 'completed'; readonly externalReference\?: string \}/);
    assert.match(rail, /\{ readonly status: 'unconfirmed'; readonly externalReference\?: string; readonly detail\?: string \}/);
    assert.deepEqual(field('src/enterprise/execution-reconciliation/authority.ts', 'ExecutionResolutionQuery'), ['organizationId', 'executionId', 'evaluationId', 'requestId', 'decisionId', 'boundedGrantId', 'action', 'amount', 'providerRef', 'basis']);
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-settlement.ts', 'PaymentFinalityQuery'), ['organizationId', 'executionId', 'requestId', 'decisionId', 'basis', 'railId', 'providerRef', 'payment']);
    assert.deepEqual(field('src/features/payment-runtime/domain/payment-settlement.ts', 'PaymentFinalityEvidence'), ['executionId', 'method', 'providerRef', 'amount', 'source', 'destination', 'finalizedAt', 'facts']);
  });

  it('§33: no generic layer interprets a provider reference — it is compared and bound, never split, sliced, matched or case-folded', () => {
    const generic = listCoreSources();
    for (const file of generic) {
      const code = codeOf(file);
      assert.equal(/providerRef[A-Za-z]*\??\.(split|slice|match|substring|startsWith|endsWith|toUpperCase|toLowerCase|replace|charAt|indexOf)\(|\b(test|match|exec)\(\s*[\w.?]*providerRef/.test(code), false, file);
    }
    const grammar = codeOf('src/features/execution-runtime/domain/provider-reference.ts');
    assert.equal(/\[0-9a-f\]\{64\}|\[0-9A-F\]\{64\}|\{64\}/.test(grammar), false, 'the provider-reference grammar knows no hash format');
  });

  it('§34: no generic layer enumerates or branches on a destination kind — the grammar is opaque', () => {
    for (const file of listCoreSources().filter((path) => /payment/.test(path))) {
      const code = codeOf(file);
      // Comparing two destinations' kinds for equality is binding, and allowed; comparing one with a literal kind is interpretation.
      assert.equal(/destination\??\.kind\s*(===|!==|==|!=)\s*['"`]|['"`]\s*(===|!==|==|!=)\s*[\w.?]*destination\??\.kind|switch\s*\(\s*[\w.?]*destination\??\.kind|DESTINATION_KINDS|destinationKinds/.test(code), false, file);
      assert.equal(/'(xrpl|lightning)[a-z-]*'/.test(code), false, file);
    }
  });

  it('§27: the PAY-05 finality port is unchanged — a closed answer of final / not-final / contradicted with bounded generic evidence', () => {
    const settlement = codeOf('src/features/payment-runtime/domain/payment-settlement.ts');
    assert.match(settlement, /verifyFinality\(query: PaymentFinalityQuery\): Promise<PaymentFinalityAnswer>;/);
    assert.match(settlement, /const EVIDENCE_KEYS = \['executionId', 'method', 'providerRef', 'amount', 'source', 'destination', 'finalizedAt', 'facts'\];/);
  });
});
