import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as exerciseControlRuntime from '../index.js';
import { EXERCISE_CONTROL_REASON_CODE_VALUES } from '../index.js';
import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../emergency-control-runtime/index.js';
import { EXECUTION_FAILURE_REASON_VALUES, GRANT_EXERCISE_REASON_CODE_VALUES } from '../../execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES } from '../../grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../../kernel/reason-codes/reason-codes.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES } from '../../../kernel/reason-codes/exercise-reason-codes.js';

/**
 * What the exercise-control module is allowed to be, enforced structurally.
 *
 * It narrows repeated use of an already-sufficient grant. Every rule below is a
 * thing an "aggregate limit" module could plausibly grow into and must not: a
 * second decision producer, a network client, a reader of Governance Store
 * evidence, a float accumulator, a sweeper that frees capacity on a timer, or
 * a surface a caller could reach.
 */

const ROOT = 'src/features/exercise-control-runtime';

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const PRODUCTION_SOURCES = sourceFiles(ROOT);

/** Comments stripped: what is forbidden is a call or an import, not a word the prose explains. */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const previous = index > 0 ? line[index - 1] : '';
        if (quote !== undefined) {
          if (char === quote && previous !== '\\') quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

describe('Exercise control boundaries — §5 / §57 what it imports', () => {
  it('has real production sources to measure, and the stripper keeps code while dropping prose', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 8, `found ${PRODUCTION_SOURCES.length}`);
    const gate = codeOf(`${ROOT}/services/exercise-control-gate.ts`);
    assert.ok(gate.includes('await ledger.reserve(request)'));
    assert.equal(gate.includes('Everything a caller could influence'), false);
  });

  it('imports nothing outside itself except Node crypto — no Kernel, Governance Store, customer identity, Generic HTTP, provider or grant runtime', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.ok(specifier === 'crypto' || specifier.startsWith('./') || specifier.startsWith('../domain/') || specifier.startsWith('../services/') || specifier.startsWith('./domain/') || specifier.startsWith('./services/'), `${file} imports '${specifier}'`);
      }
    }
  });

  it('performs no I/O: no network, no DNS, no TLS, no filesystem, no process, no database client', () => {
    const forbidden = [/node:(http|https|net|dns|tls|dgram|fs|child_process|worker_threads)/, /\bfetch\s*\(/, /better-sqlite3/, /\brequire\s*\(/, /\bimport\s*\(/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('names no Kernel, Governance Store, execution adapter, provider or evidence ledger', () => {
    const forbidden = [/AocKernel/, /KernelEvaluation/, /GovernanceStore/, /GovernanceRecord/, /ExecutionAdapter\b/, /appendReference/, /createExecutionLedger/, /\bPinata\b/i, /\bStripe\b/i, /GenericHttp/, /assertedContext/, /CustomerIdentity/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('Exercise control boundaries — nothing ambient, nothing that frees capacity on its own', () => {
  it('reads no ambient clock — every instant is injected', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /performance\.now/, /process\.hrtime/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('§20. has no timer, sweeper, TTL, auto-release or stale-reservation cleanup', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/setTimeout\s*\(/, /setInterval\s*\(/, /setImmediate\s*\(/, /\bsweep/i, /\bttl\b/i, /autoRelease/i, /stale/i, /cleanup/i, /expireReservation|reservationExpir|releaseExpired/i, /\bcron\b/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('generates no identifier and no randomness — reservation identity is derived', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/randomUUID/, /Math\.random/, /randomBytes/, /\buuid\b/i, /nextId\s*\(/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('§10 / §32. aggregates amounts with no float arithmetic and no SQL aggregate', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/parseFloat\s*\(/, /Math\.round\s*\(/, /toFixed\s*\(/, /\bSUM\s*\(/i, /\bTOTAL\s*\(/i, /\bREAL\b/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
    const decimal = codeOf(`${ROOT}/domain/exercise-decimal.ts`);
    assert.ok(/BigInt\(/.test(decimal), 'exact arithmetic is BigInt coefficient/scale arithmetic');
  });

  it('is fully synchronous where the policy and the binding resolver are concerned: neither is ever awaited', () => {
    const gate = codeOf(`${ROOT}/services/exercise-control-gate.ts`);
    assert.equal(/await\s+policy\s*\(/.test(gate), false);
    assert.equal(/await\s+authorityBinding\s*\(/.test(gate), false);
    assert.equal(/await\s+verifyExerciseAuthorityBinding/.test(gate), false);
  });

  it('the gate reserves before it returns admitted, and re-verifies the binding after the reservation', () => {
    const gate = codeOf(`${ROOT}/services/exercise-control-gate.ts`);
    const first = gate.indexOf('verifyExerciseAuthorityBinding(input.grant.authorityBindingDigest');
    const policy = gate.indexOf('snapshotExerciseControlLimits(policy(query))');
    const reserve = gate.indexOf('await ledger.reserve(request)');
    const second = gate.indexOf('verifyExerciseAuthorityBinding(authorityBindingDigest');
    const admitted = gate.indexOf("return { kind: 'admitted'");
    for (const index of [first, policy, reserve, second, admitted]) assert.notEqual(index, -1);
    assert.ok(first < policy && policy < reserve && reserve < second && second < admitted, 'binding #1 → policy → reserve → binding #2 → admitted');
    assert.equal([...gate.matchAll(/ledger\.reserve\s*\(/g)].length, 1, 'reserve is the one admission write');
  });
});

describe('Exercise control boundaries — it cannot authorize, and nothing a caller holds can reach it', () => {
  it('constructs no decision shape', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\ballowed\s*:/, /\bdenied\s*:/, /KernelDecisionStatus/, /'approval_required'/, /'indeterminate'/, /PolicyDecision/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('never revokes, issues or mutates a grant', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\brevoke\s*\(/, /\bissue\s*\(/, /issueGrant/, /BoundedGrantStorePort/, /usesRemaining|amountRemaining|usageCount/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('exports no HTTP handler, route, admin, quota or reservation API surface', () => {
    const surface = Object.keys(exerciseControlRuntime).filter((name) => /handler|route|controller|endpoint|http|admin|quotaApi|listReservations|manualRelease|reconcile/i.test(name));
    assert.deepEqual(surface, []);
  });

  it('the policy query and the reservation request declare no caller-controlled field', () => {
    const limits = readFileSync(`${ROOT}/domain/exercise-control-limits.ts`, 'utf8');
    const query = /export interface ExerciseControlQuery \{([\s\S]*?)\n\}/.exec(limits)?.[1] ?? '';
    const fields = [...query.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ['action', 'amount', 'at', 'boundedGrantId', 'correlation', 'counterparty', 'grantExpiresAt', 'grantIssuedAt', 'organization', 'resource', 'subject']);
    for (const forbidden of ['assertedContext', 'intent', 'headers', 'url', 'credential', 'adapter', 'store', 'kernel']) assert.equal(query.includes(forbidden), false, forbidden);
  });

  it('the limit contract names no provider, adapter or destination', () => {
    const limits = codeOf(`${ROOT}/domain/exercise-control-limits.ts`);
    const union = /export type ExerciseControlLimit =([\s\S]*?);\n/.exec(limits)?.[1] ?? '';
    for (const forbidden of ['adapter', 'provider', 'url', 'origin', 'destination', 'grant']) assert.equal(new RegExp(`\\b${forbidden}`, 'i').test(union), false, forbidden);
  });
});

describe('Exercise control boundaries — §11 the vocabulary is its own', () => {
  const exercise: readonly string[] = EXERCISE_CONTROL_REASON_CODE_VALUES;

  it('every code carries the EXERCISE_CONTROL_ prefix, and there are exactly the nine the design names', () => {
    for (const code of exercise) assert.ok(code.startsWith('EXERCISE_CONTROL_'), code);
    assert.equal(exercise.length, 9);
    assert.equal(new Set(exercise).size, exercise.length);
  });

  it('is disjoint from the Kernel, obligation, grant issuance, grant exercise, provider-failure and emergency-control vocabularies', () => {
    for (const other of [
      Object.values(AOC_KERNEL_REASON_CODES) as readonly string[],
      Object.values(AOC_KERNEL_EXERCISE_REASON_CODES) as readonly string[],
      GRANT_REASON_CODE_VALUES,
      GRANT_EXERCISE_REASON_CODE_VALUES,
      EXECUTION_FAILURE_REASON_VALUES,
      EMERGENCY_CONTROL_REASON_CODE_VALUES,
    ]) {
      assert.ok(other.length > 0, 'not vacuous');
      for (const code of exercise) assert.equal(other.includes(code), false, `${code} overlaps another vocabulary`);
    }
  });
});
