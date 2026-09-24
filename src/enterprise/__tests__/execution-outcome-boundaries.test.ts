import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateGovernedActionIntent } from '../governed-action/index.js';
import { ALLOWED_INTENT, DRAFTING_IS_FINANCIAL } from './governed-action-support.js';

/**
 * P11 §94 — the durable execution outcome store records what happened, and
 * that is all it can do. Enforced structurally:
 *
 * 1. **It is not P8, P7, the grant store or the Kernel Authority Store**, and
 *    it reaches none of them: the store imports only the provider-neutral
 *    vocabularies it validates against and the Governance Store's
 *    canonicalization and digest primitives.
 * 2. **It cannot authorize.** Its port has no issue, revoke, allow, reserve,
 *    reconcile, resolve, poll or retry; no authority-bearing module imports it;
 *    provider adapters cannot reach it.
 * 3. **Only replay reads it**, and only after the write-ahead claim says the
 *    same execution identity was already attempted.
 * 4. **No caller can self-report**, and no adapter gains authority vocabulary.
 * 5. **P11 has no timers, retries, reconciliation, receipts, settlement or
 *    rail-specific code, and no monetary arithmetic through `number`.**
 */

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped: what is forbidden is code, not the prose that explains why. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function importsOf(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

const STORE = walk('src/enterprise/execution-outcome-store');
const P11_SOURCES = [
  ...STORE,
  'src/enterprise/modules/execution-outcome-module.ts',
  'src/features/execution-runtime/domain/provider-certainty.ts',
  'src/features/execution-runtime/domain/provider-reference.ts',
];

describe('P11 boundaries — the execution outcome store', () => {
  it('has real production sources to measure', () => {
    assert.ok(STORE.length >= 7, STORE.join(','));
  });

  it('imports only provider-neutral vocabularies, the monetary primitive, and the Governance Store canonicalization and digest primitives', () => {
    const allowed = new Set([
      '../../features/execution-runtime/index.js',
      '../../features/monetary-runtime/index.js',
      '../../features/emergency-control-runtime/index.js',
      '../../features/exercise-control-runtime/index.js',
      '../governance-store/canonical-json.js',
      '../governance-store/digest.js',
      '../governance-store/store-common.js',
      'node:fs',
      'node:path',
    ]);
    for (const file of STORE) {
      for (const specifier of importsOf(file)) assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports ${specifier}`);
      // better-sqlite3 is reached only through a dynamic import in the SQLite store.
      if (!file.endsWith('sqlite-execution-outcome-store.ts')) assert.equal(/import\(\s*'better-sqlite3'\s*\)/.test(code(file)), false, file);
    }
  });

  it('is not P8, P7, the grant store or the Kernel Authority Store, and reaches none of them', () => {
    for (const file of STORE) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of ['authority-event-stream', 'exercise-control-ledger', 'bounded-grant-store', 'kernel-authority', 'grant-runtime', 'execution-governance', 'governed-action/', 'governance-store/governance-store', 'sqlite-governance-store']) {
        assert.equal(text.includes(`/${forbidden}`), false, `${file} must not reach ${forbidden}`);
      }
    }
  });

  it('its port can record and read — it cannot issue, revoke, allow, reserve, settle, reconcile, resolve, poll, retry or delete', () => {
    const port = code('src/enterprise/execution-outcome-store/outcome-store.ts');
    const interfaces = [...port.matchAll(/export interface \w+[^{]*\{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');
    const members = [...interfaces.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]);
    assert.deepEqual([...new Set(members.filter((name) => name !== undefined))].sort(), ['close', 'health', 'prepareAttempt', 'read', 'recordTerminal'].sort());
    for (const file of STORE) {
      const text = code(file);
      for (const verb of [/\bissue\w*\(/, /\brevoke\w*\(/, /\bauthori[sz]e\w*\(/, /\breserve\w*\(/, /\bsettle\w*\(/, /\breconcil/i, /\bresolve(Unknown|Outcome|Execution|Uncertain|Attempt)\w*\(/, /\bpoll/i, /\bretry/i, /\bUPDATE\s+execution_/, /\bDELETE\s+FROM\s+execution_/]) {
        assert.equal(verb.test(text), false, `${file} must not contain ${String(verb)}`);
      }
    }
  });
});

describe('P11 boundaries — who may hold it', () => {
  const HOLDERS = new Set([
    // Composes it with governed actions, hands the orchestrator the narrow port and operators a read-only view.
    'src/enterprise/composition/composition-root.ts',
    // Types only: the prepare / record / read port.
    'src/enterprise/governed-action/orchestrator.ts',
    // Reports health; owns nothing.
    'src/enterprise/modules/execution-outcome-module.ts',
    // Type-only re-exports for a host that supplies its own store.
    'src/enterprise/index.ts',
    // P12: the pre-claim binder reads the prepared attempt record's type; the
    // reconciliation service reads the verified record through the read-only
    // reader it is handed and classifies its errors. Neither prepares or
    // records anything (`execution-reconciliation-boundaries.test.ts`).
    'src/enterprise/execution-reconciliation/binder.ts',
    'src/enterprise/execution-reconciliation/service.ts',
    // P12: the resolution store reuses P11's identifier and instant primitives verbatim.
    'src/enterprise/execution-resolution-store/validation.ts',
  ]);

  it('no other production module imports the execution outcome store', () => {
    for (const file of walk('src')) {
      if (file.startsWith(join('src', 'enterprise', 'execution-outcome-store'))) continue;
      if (!readFileSync(file, 'utf8').includes('execution-outcome-store/')) continue;
      assert.ok(HOLDERS.has(file.split('\\').join('/')), `${file} may not reach the execution outcome store`);
    }
  });

  it('the orchestrator imports it type-only', () => {
    const text = readFileSync('src/enterprise/governed-action/orchestrator.ts', 'utf8');
    for (const line of text.split('\n').filter((entry) => entry.includes('execution-outcome-store/'))) assert.match(line, /^import type /, line);
  });

  it('provider adapters and the execution runtime cannot reach outcome persistence', () => {
    for (const file of [...walk('src/features/execution-runtime'), ...walk('src/enterprise/execution-adapters')]) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/execution-outcome-store|ExecutionOutcomeStore|ExecutionOutcomePort|prepareAttempt|recordTerminal/.test(text), false, file);
    }
  });

  it('no authority-bearing module can read it to decide', () => {
    for (const file of [
      ...walk('src/kernel'),
      ...walk('src/features/grant-runtime'),
      ...walk('src/features/exercise-control-runtime'),
      ...walk('src/features/emergency-control-runtime'),
      ...walk('src/enterprise/execution-governance'),
      ...walk('src/enterprise/bounded-grant-store'),
      ...walk('src/enterprise/exercise-control-ledger'),
      ...walk('src/enterprise/emergency-control'),
      ...walk('src/enterprise/customer-identity'),
      ...walk('src/enterprise/kernel-authority'),
      ...walk('src/enterprise/authority-event-stream'),
    ]) {
      assert.equal(/execution-outcome-store|executionOutcomes/.test(readFileSync(file, 'utf8')), false, file);
    }
  });

  it('the composition root hands the store only to the orchestrator (as the narrow port), the health module and the read-only view', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    for (const construct of root.matchAll(/createAuthorityControlledExecution\(\{[\s\S]*?\}\)|createExecutionAdapterRegistry\(\{[\s\S]*?\}\)|createAocKernel\(\{[\s\S]*?\}\)/g)) {
      assert.equal(construct[0].includes('executionOutcome'), false, 'no Kernel, ACE or registry is handed the outcome store');
    }
    const handed = [...root.matchAll(/executionOutcomeStore\.(\w+)\(/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(handed)].sort(), ['close', 'prepareAttempt', 'read', 'recordTerminal'].sort());
  });
});

describe('P11 boundaries — only replay reads it, and only for an identity already attempted', () => {
  const orchestrator = code('src/enterprise/governed-action/orchestrator.ts');

  it('exactly one read, inside replayExecution', () => {
    const reads = [...orchestrator.matchAll(/executionOutcomes\.read\(/g)];
    assert.equal(reads.length, 1);
    const start = orchestrator.indexOf('async function replayExecution(');
    const end = orchestrator.indexOf('function observedExpiry(');
    assert.ok(start !== -1 && end > start);
    assert.ok((reads[0]?.index ?? -1) > start && (reads[0]?.index ?? -1) < end, 'the only read is the replay of an attempted execution');
  });

  it('replay is reached only from an execution identity the write-ahead claim already records', () => {
    const calls = [...orchestrator.matchAll(/return replayExecution\(/g)].map((match) => orchestrator.slice(Math.max(0, (match.index ?? 0) - 80), match.index));
    assert.equal(calls.length, 2);
    assert.ok(calls.some((context) => context.includes('if (known.attempted)')));
    assert.ok(calls.some((context) => context.includes("claim.kind === 'already-claimed'")));
  });

  it('preparation comes after the usable pre-assessment and before the claim; the observation after the exercise and before the summary and P8', () => {
    const order = [
      'const assessment = await execution.assessExercise(exercise)',
      'await executionOutcomes.prepareAttempt(',
      'claim = await ledger.claim(',
      'outcome = await execution.exercise(exercise)',
      'await executionOutcomes.recordTerminal(',
      'await ledger.recordOutcome(',
      'recorder.executionOutcomeObserved(',
    ].map((needle) => orchestrator.indexOf(needle));
    for (const index of order) assert.notEqual(index, -1);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('the terminal observation is built from the runtime outcome, never from the intent or the attempt', () => {
    const builder = orchestrator.slice(orchestrator.indexOf('function observationOf('), orchestrator.indexOf('function exerciseFor('));
    assert.ok(builder.length > 0);
    for (const forbidden of [/intent/, /rawIntent/, /assertedContext/, /\bdetail\b/, /amount/]) assert.equal(forbidden.test(builder), false, String(forbidden));
  });
});

describe('P11 boundaries — no self-reporting, no new adapter authority', () => {
  it('the intent contract has no field through which a caller could state a provider result', () => {
    for (const key of ['providerRef', 'providerStatus', 'executionOutcome', 'providerCertainty', 'certainty', 'outcomeRecorded', 'observation', 'terminal']) {
      const validation = validateGovernedActionIntent({ ...ALLOWED_INTENT, amount: { value: '1', currency: 'USD' }, [key]: 'confirmed-completed' }, DRAFTING_IS_FINANCIAL);
      assert.equal(validation.valid, false, key);
    }
  });

  it('an adapter result carries execution facts only — never authority vocabulary', () => {
    const port = code('src/features/execution-runtime/domain/execution-adapter-port.ts');
    const union = port.slice(port.indexOf('export type ExecutionAdapterResult'), port.indexOf('export function readExecutionAdapterResult'));
    assert.ok(union.length > 0);
    for (const word of ['allowed', 'authorized', 'grantValid', 'budgetRemaining', 'authoritySatisfied', 'decision', 'certainty']) assert.equal(union.includes(word), false, word);
  });
});

describe('P11 boundaries — nothing P12+ and no floating money', () => {
  it('P11 sources contain no timer, retry, reconciliation, receipt, settlement or rail-specific code', () => {
    for (const file of P11_SOURCES) {
      const text = code(file);
      for (const forbidden of [/setInterval|setTimeout|setImmediate/, /\bretry/i, /reconcil/i, /\bpoll/i, /receipt/i, /settlement|\bsettled\b|\bfinali[sz]ed\b|\brefund/i, /stripe|paymentintent|xrpl|ledger_index|txhash|wallet|seed/i, /Date\.now\(|new Date\(\)/]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
    }
  });

  it('no monetary value passes through a JavaScript number in P11 code', () => {
    for (const file of [...P11_SOURCES, 'src/enterprise/governed-action/orchestrator.ts']) {
      const text = code(file);
      for (const forbidden of [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /\.toFixed\(/, /Math\.(round|floor|ceil)\(/]) assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
    }
  });
});
