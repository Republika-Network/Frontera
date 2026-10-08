import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * PROD-03-02 — structural guarantees of operator resolution.
 *
 * Measured over code with comments removed, so prose never satisfies or
 * violates a rule; every detector is first shown to match a real violation.
 *
 * 1. **No adapter call.** No resolution path holds, imports or calls an
 *    execution adapter, the exercise runtime, the orchestrator or a grant
 *    writer — by the import closure of every PROD-03-02 module and by the
 *    body of the one P12 method it adds.
 * 2. **Rail-neutral.** No PROD-03-02 module, or anything it reaches, names a
 *    rail, test network, wallet, signer, payment adapter, the demo or a model.
 * 3. **No retry / replay / resend surface.** No new route, console control
 *    or product string offers one.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

/** Specifiers whose code runs: every import and re-export but `import type` / `export type` (erased at compile time). */
const valueImportsOf = (file: string): readonly string[] =>
  [...codeOf(file).matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .filter((match) => match[2] === undefined)
    .map((match) => match[3] ?? match[4] ?? '');

/**
 * The transitive local import closure, stopping at the feature boundary: a
 * feature's public index is where the shared vocabulary lives, and what is
 * taken from it is checked by name (`FEATURE_NAMES_THAT_ACT`) instead.
 */
function closureOf(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith('src/features/')) continue;
    for (const specifier of valueImportsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const base = normalize(join(dirname(file), specifier)).replace(/\\/g, '/').replace(/\.js$/, '');
      const resolved = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => existsSync(candidate));
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return seen;
}

const RESOLUTION_COMMAND = 'src/enterprise/operations/resolution.ts';
const ATTESTATION = 'src/enterprise/execution-reconciliation/operator-attestation.ts';
const GUARD = 'src/enterprise/execution-reconciliation/activity-guard.ts';
const SERVICE = 'src/enterprise/execution-reconciliation/service.ts';
const CONSOLE_PAGES = 'src/control-plane-web/views/pages-operations.tsx';
const CONSOLE_APP = 'src/control-plane-web/app.tsx';
const NEW_MODULES = [RESOLUTION_COMMAND, ATTESTATION, GUARD];

/** What can make an effect happen: adapters, the runtime that drives them, the orchestrator, grant writers, provider clients. */
const EFFECT_MODULE = /execution-adapters|adapters\/node-http|provider-adapter|features\/execution-runtime\/(?!index)|grant-execution|governed-action\/orchestrator|bounded-grant-store|kernel-grant|grant-adapter|http-execution|generic-http/;
/** Calling one. */
const EFFECT_CALL = /\.execute\(|\.exercise\(|\bexecuteAction\(|\bsubmit\(|\bresubmit|\bretry\w*\(|\breplay\w*\(|\bresend\w*\(|\bfetch\(|\.issue\(|\bclaim\(/;
/** Names taken from a feature index that could make an effect happen: services, gates, registries, executors, adapters, grant issuance. */
const FEATURE_NAMES_THAT_ACT = /Service$|Gate$|Registry$|Executor$|^create|^execute|^issue|GrantExecution|ExecutionAdapter$|^(Generic)?Http/;

/** `{ names } from '<feature index>'` in one file. */
function featureNames(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.\.\/)+features\/[^']+'/g)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((name) => name.replace(/\btype\b/, '').trim().split(/\s+as\s+/)[0] ?? '')
      .filter((name) => name.length > 0),
  );
}

/** Rails, test networks, the demo, wallet and signer code, payment adapters, models. */
const FORBIDDEN = /xrpl|ripple|rlusd|testnet|devnet|faucet|andrew|lumx|wallet|seed\b|private[-_ ]?key|signer|signing|commercial-demo|aoc-enterprise-demo|payment|\bpay[-_/]|stripe|lightning|x402|openai|anthropic|\bllm\b/i;

/** The body of `recordOperatorResolution` in the P12 service. */
function attestationMethod(): string {
  const code = codeOf(SERVICE);
  const start = code.indexOf('async recordOperatorResolution(');
  const end = code.indexOf('async adoptResolutionAuthority(', start);
  assert.ok(start > 0 && end > start, 'the method is found');
  return code.slice(start, end);
}

describe('PROD-03-02 structure — the detectors match real violations', () => {
  it('each detector fires on what it must forbid and not on what PROD-03-02 does', () => {
    for (const bad of ['adapter.execute(action)', 'execution.exercise(exercise)', 'ledger.claim(evaluationId, executionId)', 'retryExecution(id)', 'replayExecution(scope)', 'resendPayment(x)', 'fetch(url)']) assert.equal(EFFECT_CALL.test(bad), true, bad);
    for (const bad of ['../execution-adapters/registry.js', '../governed-action/orchestrator.js', '../../features/execution-runtime/application/grant-execution-service.js']) assert.equal(EFFECT_MODULE.test(bad), true, bad);
    assert.equal(EFFECT_MODULE.test('../../features/execution-runtime/index.js'), false, 'the closed vocabulary index is not an effect module');
    for (const bad of ["import { Client } from 'xrpl'", 'createWalletSigner', 'lumx.client', 'rlusd-issuer']) assert.equal(FORBIDDEN.test(bad), true, bad);
    assert.equal(EFFECT_CALL.test('await record({ organizationId, executionId })'), false);
  });
});

describe('PROD-03-02 structure — no resolution path can call an adapter', () => {
  it('the attestation method holds no adapter, runtime, claim or grant writer, and calls none', () => {
    const method = attestationMethod();
    assert.equal(EFFECT_CALL.test(method), false);
    assert.equal(/adapter|exerciseGate|grantStore|governAction|orchestrator/i.test(method), false);
    // What it does call: the P11 read (via eligibility), the P12 read, bind and record, and finish (P7, P8, Governance evidence).
    assert.match(method, /await resolutions\.recordResolution\(scope, input\)/);
  });

  it('the service options name no adapter, exercise gate or grant writer — only reads, the P12 port, P7’s reconciliation, evidence and the guard', () => {
    const code = codeOf(SERVICE);
    const options = /export interface ExecutionReconciliationServiceOptions \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    const fields = [...options.matchAll(/^\s+readonly (\w+)\??:/gm)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ['activity', 'capacity', 'claimed', 'composition', 'evidence', 'governanceEvidence', 'now', 'outcomes', 'resolutions'].sort());
  });

  it('the import closure of every PROD-03-02 module reaches no effect module and makes no effect call', () => {
    const closure = closureOf(NEW_MODULES);
    assert.ok(closure.has('src/enterprise/api/enterprise-http-errors.ts') && closure.has('src/enterprise/execution-reconciliation/operator-attestation.ts'), 'the closure is really walked');
    for (const file of closure) {
      assert.equal(EFFECT_MODULE.test(file), false, `the closure reaches ${file}`);
      if (NEW_MODULES.includes(file)) assert.equal(EFFECT_CALL.test(codeOf(file)), false, `${file} calls an effect`);
      if (!file.startsWith('src/features/')) for (const name of featureNames(file)) assert.equal(FEATURE_NAMES_THAT_ACT.test(name), false, `${file} takes '${name}' from a feature`);
    }
    // The same over the P12 service the attestation runs in.
    for (const file of closureOf([SERVICE])) {
      assert.equal(EFFECT_MODULE.test(file), false, `the service closure reaches ${file}`);
      if (!file.startsWith('src/features/')) for (const name of featureNames(file)) assert.equal(FEATURE_NAMES_THAT_ACT.test(name), false, `${file} takes '${name}' from a feature`);
    }
    assert.equal(FEATURE_NAMES_THAT_ACT.test('GrantExecutionService'), true, 'the name detector matches a real effect service');
    assert.equal(FEATURE_NAMES_THAT_ACT.test('EXECUTION_FAILURE_REASON_VALUES'), false);
  });

  it('the resolution command is handed exactly one port, `record`, and the composition root binds it to recordOperatorResolution and nothing else', () => {
    const command = codeOf(RESOLUTION_COMMAND);
    const deps = /export interface OperatorResolutionCommandDependencies \{([\s\S]*?)\n\}/.exec(command)?.[1] ?? '';
    assert.deepEqual([...deps.matchAll(/^\s+readonly (\w+)\??:/gm)].map((match) => match[1]).sort(), ['authenticator', 'log', 'organizationId', 'record'].sort());
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.match(root, /record: \(request\) => executionReconciliation\.recordOperatorResolution\(request\),/);
    const block = /createOperatorResolutionCommand\(\{[\s\S]*?\}\)/.exec(root)?.[0] ?? '';
    assert.equal(/reconcile\(|adoptResolutionAuthority|execut(e|ion)Adapter|governAction/.test(block), false);
  });

  it('operator attestation never answers: its resolve is `unresolved`, always', () => {
    const attestation = codeOf(ATTESTATION);
    assert.match(attestation, /resolve: async \(\) => Object\.freeze\(\{ outcome: 'unresolved' as const \}\)/);
    assert.equal(/confirmed-completed|confirmed-not-completed/.test(attestation), false);
  });

  it('the orchestrator holds the guard around its claim and observation — and nothing else of PROD-03-02', () => {
    const orchestrator = codeOf('src/enterprise/governed-action/orchestrator.ts');
    const enter = orchestrator.indexOf('executionResolution.activity.enter(executionId)');
    const prepare = orchestrator.indexOf('await executionOutcomes.prepareAttempt(');
    const claim = orchestrator.indexOf('claim = await ledger.claim(');
    const terminal = orchestrator.indexOf('await executionOutcomes.recordTerminal(');
    const leave = orchestrator.indexOf('leave?.();');
    assert.ok(enter > 0 && enter < prepare && prepare < claim && claim < terminal && terminal < leave, 'enter → prepare → claim → observation → leave');
    assert.match(orchestrator, /\} finally \{\s*leave\?\.\(\);\s*\}/);
    assert.equal(/recordOperatorResolution|tryExclusive|operator-attestation/.test(orchestrator), false);
  });
});

describe('PROD-03-02 structure — rail-neutral', () => {
  it('no PROD-03-02 module, console page or anything they import names a rail, test network, wallet, signer, payment adapter, the demo or a model', () => {
    for (const file of [...NEW_MODULES, CONSOLE_PAGES]) {
      assert.equal(FORBIDDEN.test(codeOf(file)), false, file);
      for (const specifier of importsOf(file)) assert.equal(FORBIDDEN.test(specifier), false, `${file} imports '${specifier}'`);
    }
    for (const file of closureOf([...NEW_MODULES, SERVICE])) assert.equal(FORBIDDEN.test(file), false, `the closure reaches ${file}`);
  });
});

describe('PROD-03-02 structure — no retry, replay, resend or re-execute surface', () => {
  const PRODUCT_ACTION = /\b(Retry|Replay|Resend|Re-execute|Reexecute)\b|Retry payment|Retry transaction|Mark successful|Complete execution/;

  it('the detector matches a real control', () => {
    assert.equal(PRODUCT_ACTION.test('<button>Retry</button>'), true);
    assert.equal(PRODUCT_ACTION.test('Mark successful'), true);
    assert.equal(PRODUCT_ACTION.test('Record resolution'), false);
  });

  it('no console page, console handler or resolution message names one; the one control is "Record resolution"', () => {
    const pages = codeOf(CONSOLE_PAGES);
    assert.equal(PRODUCT_ACTION.test(pages), false);
    assert.match(pages, />\s*Record resolution\s*</);
    assert.match(pages, /Confirm this execution was completed/);
    assert.match(pages, /Confirm this execution was not completed/);
    const app = codeOf(CONSOLE_APP);
    const handlers = app.slice(app.indexOf('async function resolutionPage('), app.indexOf('async function hostHealthPage('));
    assert.ok(handlers.length > 200 && handlers.length < 6000, `the resolution handlers are measured (${handlers.length})`);
    // `replayed` is the idempotent result ("already recorded, unchanged"), never an action.
    const NO_ACTION = /retry|replay(?!ed\b)|resend|re-execute/i;
    assert.equal(PRODUCT_ACTION.test(handlers) || NO_ACTION.test(handlers), false);
    assert.equal(NO_ACTION.test(codeOf(RESOLUTION_COMMAND)), false);
  });

  it('the operator plane adds exactly one route, a POST to …/executions/{id}/resolution', () => {
    const surface = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { endpointCount: number; routePatterns: string[] };
    // 64 at PROD-03-02; PROD-03-03 then added the always-mounted `GET /version` (a literal, not an operator pattern): 65.
    assert.equal(surface.endpointCount, 65);
    const added = surface.routePatterns.filter((pattern) => /resolution|retry|replay|resend|reconcile|execute/i.test(pattern));
    assert.deepEqual(added, ['^\\/api\\/admin\\/operations\\/executions\\/([^/]+)\\/resolution$']);
  });
});
