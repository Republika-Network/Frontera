import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * TRADE-03 K1 — the one approved TRADE composition edge, held to exactly what
 * it was approved as: a CORE-04 trusted-context provider with an in-process
 * ingress.
 *
 * - it imports the trade vertical's barrel, CORE-04's port types and digest,
 *   the customer-identity contract and the policy-rule data types — nothing
 *   that decides, grants, executes, signs, submits or connects;
 * - it never reaches the XRPL rail of the trade vertical (that needs a
 *   reviewed transport, TRADE-04) nor any PAY module;
 * - nothing in production composes it: a deployment passes its provider to
 *   the Host as the existing `contextProvider` input;
 * - the simulation acknowledgement is referenced by no production file but
 *   its definition.
 *
 * Each scan is a predicate over (path, text) pairs, run against synthetic
 * violations below so a scan that matches nothing fails.
 */

const EDGE = 'src/enterprise/trade-risk-context';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.git', 'vendor', '__tests__', 'tests', 'fixtures']);

interface Source {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(full) && !full.endsWith('.d.ts') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const EDGE_SOURCES: readonly Source[] = walk(EDGE).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  '../../features/trade-runtime/index.js',
  '../../features/context-resolution-runtime/index.js',
  '../customer-identity/index.js',
  '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js',
  '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js',
]);

/**
 * R8 (TRADE-04C): the mandatory trade-policy factory compiles TRADE-03's own rules into the existing policy-pack
 * runtime for the Kernel to evaluate — and only it may reach the runtime, its Kernel integration and context,
 * the Kernel's provider type and `node:crypto` (identifiers). It evaluates and decides nothing itself.
 */
const PROVIDER_FILE = `${EDGE}/trade-risk-policy-provider.ts`;
const PROVIDER_IMPORTS: ReadonlySet<string> = new Set([
  'node:crypto',
  '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js',
  '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js',
  '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js',
  '../../kernel/index.js',
]);

type Scan = (sources: readonly Source[]) => readonly string[];

const unapprovedImports: Scan = (sources) =>
  sources.flatMap((source) =>
    importsOf(source.text)
      .filter((specifier) => !specifier.startsWith('./') && !ALLOWED_IMPORTS.has(specifier) && !(source.path === PROVIDER_FILE && PROVIDER_IMPORTS.has(specifier)))
      .map((specifier) => `${source.path} imports '${specifier}'`),
  );

/** Decision, grant, orchestration and execution — the governance engine the edge must never be. */
const ENGINE = [/\bevaluate\s*\(|\bdecide\s*\(|policy-condition-evaluator|createPolicyPackRuntime/, /issueFromDecision|createGrantIssuanceService|BoundedGrant|\.exercise\s*\(/, /GovernedActionOrchestrator|\.govern\s*\(|governAction/, /ExecutionAdapter|executionAdapter|\.execute\s*\(/];
/** Effects: signing, submission, network, custody, the trade rail, PAY. */
const EFFECTS = [
  /\bsign\s*\(|signTransaction|createSign\b|external-xrpl-signer/,
  /\.submit\s*\(|submitAndWait|\bautofill\s*\(/,
  /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bconnect\s*\(|\bnew\s+Client\s*\(/,
  /\bWallet\b|fromSeed|fromSecret|fromMnemonic|deriveKeypair|generateKeyPair|createPrivateKey|\bprivateKey\s*[:=(]|\bseed\s*[:=(]/i,
  /rails\/|xrpl-delegation-reader|payment-runtime|xrpl-payment-rail|payment-protocol-ingress|payment-settlement|lightning-payment-rail/,
  /from\s+['"](?:node:)?(?:http|https|net|tls|dgram|dns|child_process|fs|worker_threads)['"]|from\s+['"](?:xrpl|ripple-[a-z-]+|@xrplf\/[a-z-]+)['"]/,
];

const forbidden = (patterns: readonly RegExp[]): Scan => (sources) => sources.flatMap((source) => patterns.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`));
/** The engine scan, with the factory's one allowance: compiling a policy-pack runtime (never evaluating or deciding). */
const engineOf: Scan = (sources) =>
  sources.flatMap((source) => forbidden(source.path === PROVIDER_FILE ? [/\bevaluate\s*\(|\bdecide\s*\(|policy-condition-evaluator/, ...ENGINE.slice(1)] : ENGINE)([source]));

const PRODUCTION: readonly Source[] = ['src', 'packages', 'scripts', 'apps'].flatMap(walk).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('TRADE-03 K1 — the trade-risk-context edge is a CORE-04 provider and nothing more', () => {
  it('has the four sources it was approved as (R8 added the mandatory trade-policy factory)', () => {
    assert.deepEqual(EDGE_SOURCES.map((source) => source.path.slice(EDGE.length + 1)).sort(), ['index.ts', 'trade-risk-context.ts', 'trade-risk-policy-provider.ts', 'trade-risk-policy.ts']);
    assert.ok(PRODUCTION.length > 500);
  });

  it('imports only the trade barrel, CORE-04, the customer-identity contract and policy-rule data types (the factory alone: the policy-pack runtime it compiles into)', () => {
    assert.deepEqual(unapprovedImports(EDGE_SOURCES), []);
  });

  it('decides, grants, orchestrates and executes nothing', () => {
    assert.deepEqual(engineOf(EDGE_SOURCES), []);
  });

  it('signs, submits, connects and holds keys never; reaches neither the trade rail nor PAY', () => {
    assert.deepEqual(forbidden(EFFECTS)(EDGE_SOURCES), []);
  });

  it('is composed by no production module: a deployment hands its provider to the Host as `contextProvider`', () => {
    const importers = PRODUCTION.filter((source) => !source.path.startsWith(`${EDGE}/`) && /trade-risk-context/.test(source.text)).map((source) => source.path);
    // TRADE-04C: the governed executor edge names the attested-proposal *types* only — it never constructs the edge.
    // R8: the Host reads, at boot, the provenance of the policy provider it was handed — one import(), two names.
    assert.deepEqual(importers.sort(), ['src/enterprise/host/enterprise-host.ts', 'src/enterprise/xrpl-trade-execution/host-composition.ts', 'src/enterprise/xrpl-trade-execution/trade-offer-executor.ts']);
    const host = codeOf(PRODUCTION.find((source) => source.path === 'src/enterprise/host/enterprise-host.ts')!.text);
    assert.deepEqual(
      host.split('\n').filter((line) => /trade-risk-context/.test(line)).map((line) => line.trim()),
      ["const { TRADE_RISK_MANDATORY_POLICY_RULE_IDS, tradeRiskPolicyProvenanceOf } = await import('../trade-risk-context/index.js');"],
    );
    assert.equal(/\b(?:createTradeRiskContext|createTradeRiskPolicyPackProvider)\s*\(/.test(host), false, 'the Host constructs neither an edge nor a provider (its refusal message only names the factory)');
    for (const path of importers.filter((entry) => entry !== 'src/enterprise/host/enterprise-host.ts')) {
      const text = PRODUCTION.find((source) => source.path === path)!.text;
      for (const line of text.split('\n').filter((entry) => /trade-risk-context/.test(entry) && /\bfrom\b/.test(entry))) assert.match(line, /^import type \{/, `${path}: ${line}`);
      assert.equal(/createTradeRiskContext/.test(text), false, path);
    }
  });

  it('the simulation acknowledgement is used by no production file but its definition', () => {
    const users = PRODUCTION.filter((source) => /TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT|simulated-sources-not-for-production/.test(codeOf(source.text))).map((source) => source.path).sort();
    assert.deepEqual(users, [`${EDGE}/index.ts`, `${EDGE}/trade-risk-context.ts`]);
  });
});

describe('TRADE-03 K1 — negative fixtures: every edge scan fails on a synthetic violation', () => {
  const fixture = (text: string): readonly Source[] => [{ path: `${EDGE}/x.ts`, text }];

  it('an unapproved import is caught; an approved one is not', () => {
    for (const text of ["import { x } from '../governed-action/index.js';", "import { k } from '../../kernel/index.js';", "import { r } from '../../features/trade-runtime/rails/xrpl/index.js';", "import { g } from '../../features/grant-runtime/index.js';"]) {
      assert.equal(unapprovedImports(fixture(text)).length, 1, text);
    }
    assert.deepEqual(unapprovedImports(fixture("import { assessTradingRisk } from '../../features/trade-runtime/index.js';")), []);
  });

  it('the factory’s allowances are the factory’s alone', () => {
    const elsewhere = (text: string): readonly Source[] => [{ path: `${EDGE}/trade-risk-context.ts`, text }];
    assert.equal(unapprovedImports(elsewhere("import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';")).length, 1);
    assert.equal(unapprovedImports([{ path: PROVIDER_FILE, text: "import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';" }]).length, 0);
    assert.equal(unapprovedImports([{ path: PROVIDER_FILE, text: "import { g } from '../../features/grant-runtime/index.js';" }]).length, 1);
    assert.ok(engineOf(elsewhere('const r = createPolicyPackRuntime(context);')).length > 0);
    assert.deepEqual(engineOf([{ path: PROVIDER_FILE, text: 'const r = createPolicyPackRuntime(context);' }]), []);
    assert.ok(engineOf([{ path: PROVIDER_FILE, text: 'const d = kernel.evaluate(request);' }]).length > 0);
  });

  it('a decision, grant, orchestration or execution is caught', () => {
    for (const text of ['const d = kernel.evaluate(request);', 'await orchestrator.govern(identity, intent);', 'issueFromDecision(decision);', 'await adapter.execute(action);', 'const a: ExecutionAdapter = x;']) {
      assert.ok(forbidden(ENGINE)(fixture(text)).length > 0, text);
    }
  });

  // Assembled at runtime: repository-wide scanners read test files textually.
  it('a signature, submission, connection, key, rail or PAY reach is caught', () => {
    for (const text of ['wallet.sign(tx);', ['await client.sub', 'mit(blob);'].join(''), ['await fe', 'tch(url);'].join(''), 'const seed = load();', "import { r } from '../../features/trade-runtime/rails/xrpl/index.js';", "import { p } from '../payment-settlement/index.js';", ['import { request } from', "'node:" + "https';"].join(' ')]) {
      assert.ok(forbidden(EFFECTS)(fixture(text)).length > 0, text);
    }
  });
});
